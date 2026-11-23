import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type http from "node:http";
import type https from "node:https";
import { handleApiRequest } from "./api-handler.ts";
import { setMysqlPoolForTesting } from "./mysql.ts";
import {
  GeminiServiceError,
  isBlockedPrivateIp,
  loadAccessibleVideoBytes,
  resetAiRateLimitsForTesting,
  setGeminiClientForTesting,
  setRemoteVideoNetworkForTesting,
  validateSafeRemoteVideoUrl,
  type RemoteVideoHttpRequestFn,
} from "./gemini-service.ts";

class MockIncomingResponse extends EventEmitter {
  statusCode: number;
  headers: Record<string, string | string[]>;
  destroyed = false;
  resumed = false;

  constructor(statusCode: number, headers: Record<string, string | string[]> = {}) {
    super();
    this.statusCode = statusCode;
    this.headers = headers;
  }

  resume() {
    this.resumed = true;
    return this;
  }

  destroy() {
    this.destroyed = true;
    return this;
  }
}

class MockClientRequest extends EventEmitter {
  aborted = false;
  destroyedWith: unknown = undefined;
  private readonly trigger: () => void;

  constructor(trigger: () => void) {
    super();
    this.trigger = trigger;
  }

  end() {
    queueMicrotask(() => this.trigger());
    return this;
  }

  destroy(err?: Error) {
    this.aborted = true;
    this.destroyedWith = err;
    if (err) {
      queueMicrotask(() => this.emit("error", err));
    }
    return this;
  }
}

function makeHttpMock(
  handler: (
    url: URL,
    options: https.RequestOptions,
    res: MockIncomingResponse,
    req: MockClientRequest,
    onResponse: (incoming: http.IncomingMessage) => void,
  ) => void,
): RemoteVideoHttpRequestFn {
  return (url, options, onResponse) => {
    const res = new MockIncomingResponse(200, {});
    const req = new MockClientRequest(() => {
      handler(url, options, res, req, onResponse);
    });
    return req as unknown as http.ClientRequest;
  };
}

function installMockPool(pool: any): () => void {
  const prevHost = process.env["DB_HOST"];
  const prevName = process.env["DB_NAME"];
  const prevUser = process.env["DB_USER"];
  process.env["DB_HOST"] = "127.0.0.1";
  process.env["DB_NAME"] = "facetube_test";
  process.env["DB_USER"] = "facetube_test";
  setMysqlPoolForTesting(pool);

  return () => {
    setMysqlPoolForTesting(null);
    if (prevHost === undefined) delete process.env["DB_HOST"];
    else process.env["DB_HOST"] = prevHost;
    if (prevName === undefined) delete process.env["DB_NAME"];
    else process.env["DB_NAME"] = prevName;
    if (prevUser === undefined) delete process.env["DB_USER"];
    else process.env["DB_USER"] = prevUser;
  };
}

test("Phase 2.1 Security 1: Blocks private IPv4, private IPv6, IPv4-mapped IPv6, unsafe protocols & ports", async () => {
  const blockedIps = [
    "127.0.0.1",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd00:ec2::254",
    "ff02::1",
    "2001:db8::1",
    "64:ff9b::127.0.0.1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:169.254.169.254",
    "::ffff:10.0.0.1",
    "fe80::1%eth0",
  ];

  for (const ip of blockedIps) {
    assert.equal(isBlockedPrivateIp(ip), true, `Expected IP ${ip} to be blocked`);
  }

  assert.equal(isBlockedPrivateIp("93.184.216.34"), false);
  assert.equal(isBlockedPrivateIp("::ffff:93.184.216.34"), false);
  assert.equal(isBlockedPrivateIp("2606:4700:4700::1111"), false);

  const blockedUrls = [
    "http://127.0.0.1/video.mp4",
    "http://10.0.0.5/video.mp4",
    "http://172.16.0.1/video.mp4",
    "http://192.168.1.1/video.mp4",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/video.mp4",
    "http://[fe80::1]/video.mp4",
    "http://[fd00:ec2::254]/video.mp4",
    "http://[::ffff:127.0.0.1]/video.mp4",
    "http://[::ffff:7f00:1]/video.mp4",
    "http://[0:0:0:0:0:ffff:169.254.169.254]/latest/meta-data",
    "http://[::ffff:10.0.0.1]/video.mp4",
    "file:///etc/passwd",
    "ftp://cdn.example.com/video.mp4",
    "https://cdn.example.com:22/video.mp4",
    "http://cdn.example.com:3306/video.mp4",
    "https://cdn.example.com:8080/video.mp4",
    "https://user:pass@cdn.example.com/video.mp4",
    "http://metadata.google.internal/computeMetadata/v1/",
  ];

  let networkCalled = false;
  setRemoteVideoNetworkForTesting({
    dnsLookup: async () => {
      networkCalled = true;
      return [{ address: "93.184.216.34", family: 4 }];
    },
    httpRequest: makeHttpMock(() => {
      networkCalled = true;
    }),
  });

  try {
    for (const url of blockedUrls) {
      assert.equal(validateSafeRemoteVideoUrl(url), null, `URL should be rejected: ${url}`);
      await assert.rejects(
        () => loadAccessibleVideoBytes({ videoUrl: url, maxBytes: 1024 * 1024 }),
        (err: unknown) => err instanceof GeminiServiceError && err.code === "VIDEO_UNAVAILABLE",
      );
    }
    assert.equal(networkCalled, false, "No DNS lookup or HTTP connection should be attempted");
  } finally {
    setRemoteVideoNetworkForTesting(null);
  }
});

test("Phase 2.1 Security 2: Rejects hostnames whose DNS A/AAAA results include any private or mapped IP", async () => {
  let httpCalls = 0;
  setRemoteVideoNetworkForTesting({
    dnsLookup: async (hostname) => {
      if (hostname === "private-dns.example.com") {
        return [{ address: "10.0.0.2", family: 4 }];
      }
      if (hostname === "mixed-dns.example.com") {
        return [
          { address: "93.184.216.34", family: 4 },
          { address: "::ffff:127.0.0.1", family: 6 },
        ];
      }
      return [];
    },
    httpRequest: makeHttpMock((_url, _opts, res, _req, onResponse) => {
      httpCalls++;
      onResponse(res as unknown as http.IncomingMessage);
    }),
  });

  try {
    for (const target of [
      "https://private-dns.example.com/v.mp4",
      "https://mixed-dns.example.com/v.mp4",
      "https://empty-dns.example.com/v.mp4",
    ]) {
      await assert.rejects(
        () => loadAccessibleVideoBytes({ videoUrl: target, maxBytes: 1024 * 1024 }),
        (err: unknown) => err instanceof GeminiServiceError && err.code === "VIDEO_UNAVAILABLE",
      );
    }
    assert.equal(httpCalls, 0);
  } finally {
    setRemoteVideoNetworkForTesting(null);
  }
});

test("Phase 2.1 Security 3: Blocks redirects to private/mapped IPs, enforces redirect limit, and allows valid public redirect", async () => {
  let hopTargets: string[] = [];

  setRemoteVideoNetworkForTesting({
    dnsLookup: async (hostname) => {
      if (hostname === "cdn.example.com" || hostname === "media.example.com") {
        return [{ address: "93.184.216.34", family: 4 }];
      }
      if (hostname === "rebind-target.example.com") {
        return [{ address: "::ffff:127.0.0.1", family: 6 }];
      }
      return [{ address: "151.101.1.69", family: 4 }];
    },
    httpRequest: makeHttpMock((url, _options, res, _req, onResponse) => {
      hopTargets.push(url.toString());

      if (url.hostname === "cdn.example.com" && url.pathname === "/to-metadata.mp4") {
        res.statusCode = 302;
        res.headers = { location: "http://169.254.169.254/latest/meta-data" };
        onResponse(res as unknown as http.IncomingMessage);
        return;
      }

      if (url.hostname === "cdn.example.com" && url.pathname === "/to-rebind-dns.mp4") {
        res.statusCode = 302;
        res.headers = { location: "https://rebind-target.example.com/secret.mp4" };
        onResponse(res as unknown as http.IncomingMessage);
        return;
      }

      if (url.hostname === "cdn.example.com" && url.pathname.startsWith("/loop")) {
        const step = Number(url.searchParams.get("step") || "0");
        res.statusCode = 302;
        res.headers = { location: `https://cdn.example.com/loop?step=${step + 1}` };
        onResponse(res as unknown as http.IncomingMessage);
        return;
      }

      if (url.hostname === "cdn.example.com" && url.pathname === "/valid-redirect.mp4") {
        res.statusCode = 302;
        res.headers = { location: "https://media.example.com/final.mp4" };
        onResponse(res as unknown as http.IncomingMessage);
        return;
      }

      if (url.hostname === "media.example.com" && url.pathname === "/final.mp4") {
        res.statusCode = 200;
        res.headers = { "content-type": "video/mp4" };
        onResponse(res as unknown as http.IncomingMessage);
        res.emit("data", Buffer.from("valid-video-bytes"));
        res.emit("end");
        return;
      }
    }),
  });

  try {
    // 1. Redirect directly to metadata IP is rejected before second hop
    hopTargets = [];
    await assert.rejects(
      () =>
        loadAccessibleVideoBytes({
          videoUrl: "https://cdn.example.com/to-metadata.mp4",
          maxBytes: 1024 * 1024,
        }),
      (err: unknown) => err instanceof GeminiServiceError && err.code === "VIDEO_UNAVAILABLE",
    );
    assert.deepEqual(hopTargets, ["https://cdn.example.com/to-metadata.mp4"]);

    // 2. Redirect to hostname resolving to IPv4-mapped loopback is rejected before second hop
    hopTargets = [];
    await assert.rejects(
      () =>
        loadAccessibleVideoBytes({
          videoUrl: "https://cdn.example.com/to-rebind-dns.mp4",
          maxBytes: 1024 * 1024,
        }),
      (err: unknown) => err instanceof GeminiServiceError && err.code === "VIDEO_UNAVAILABLE",
    );
    assert.deepEqual(hopTargets, ["https://cdn.example.com/to-rebind-dns.mp4"]);

    // 3. Exceeding max redirect count (3) is rejected
    hopTargets = [];
    await assert.rejects(
      () =>
        loadAccessibleVideoBytes({
          videoUrl: "https://cdn.example.com/loop?step=0",
          maxBytes: 1024 * 1024,
        }),
      (err: unknown) => err instanceof GeminiServiceError && err.code === "VIDEO_UNAVAILABLE",
    );
    assert.equal(hopTargets.length, 4); // initial hop + 3 allowed redirects; 4th redirect rejected

    // 4. Valid redirect to safe public destination succeeds
    hopTargets = [];
    const loaded = await loadAccessibleVideoBytes({
      videoUrl: "https://cdn.example.com/valid-redirect.mp4",
      maxBytes: 1024 * 1024,
    });
    assert.equal(loaded.source, "remote_url");
    assert.equal(loaded.mimeType, "video/mp4");
    assert.equal(Buffer.from(loaded.base64, "base64").toString("utf-8"), "valid-video-bytes");
    assert.deepEqual(hopTargets, [
      "https://cdn.example.com/valid-redirect.mp4",
      "https://media.example.com/final.mp4",
    ]);
  } finally {
    setRemoteVideoNetworkForTesting(null);
  }
});

test("Phase 2.1 Security 4: Prevents DNS rebinding via pinned lookup & socket remoteAddress validation", async () => {
  let dnsLookupCount = 0;
  let lookupResultInSocket: { err: unknown; addr?: string; family?: number | undefined } | null =
    null;
  let capturedOptions: https.RequestOptions | undefined;

  setRemoteVideoNetworkForTesting({
    dnsLookup: async () => {
      dnsLookupCount++;
      // If a second resolution ever happened at connect time, attacker flips to loopback
      if (dnsLookupCount > 1) {
        return [{ address: "127.0.0.1", family: 4 }];
      }
      return [{ address: "93.184.216.34", family: 4 }];
    },
    httpRequest: makeHttpMock((_url, options, res, _req, onResponse) => {
      capturedOptions = options;
      // Invoke the custom lookup attached to Node http/https RequestOptions just like net.Socket.connect does
      options.lookup?.("rebind.example.com", {} as any, (err, addr, family) => {
        lookupResultInSocket = { err, addr: String(addr), family };
        res.statusCode = 200;
        res.headers = { "content-type": "video/mp4" };
        onResponse(res as unknown as http.IncomingMessage);
        res.emit("data", Buffer.from("pinned-ok"));
        res.emit("end");
      });
    }),
  });

  try {
    const result = await loadAccessibleVideoBytes({
      videoUrl: "https://rebind.example.com/video.mp4",
      maxBytes: 1024 * 1024,
    });
    assert.equal(dnsLookupCount, 1, "DNS must only be resolved once per hop");
    assert.equal(capturedOptions?.agent, false, "Socket agent pooling must be disabled");
    assert.equal(capturedOptions?.servername, "rebind.example.com");
    assert.deepEqual(lookupResultInSocket, {
      err: null,
      addr: "93.184.216.34",
      family: 4,
    });
    assert.equal(Buffer.from(result.base64, "base64").toString("utf-8"), "pinned-ok");
  } finally {
    setRemoteVideoNetworkForTesting(null);
  }

  // Also verify defense-in-depth socket connect guard if a socket ever connects to a private IP
  setRemoteVideoNetworkForTesting({
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    httpRequest: (_url, _options, _onResponse) => {
      const fakeSocket = new EventEmitter() as EventEmitter & { remoteAddress?: string };
      fakeSocket.remoteAddress = "127.0.0.1";
      const req = new MockClientRequest(() => {
        req.emit("socket", fakeSocket);
        fakeSocket.emit("connect");
      });
      return req as unknown as http.ClientRequest;
    },
  });

  try {
    await assert.rejects(
      () =>
        loadAccessibleVideoBytes({
          videoUrl: "https://rebind.example.com/video.mp4",
          maxBytes: 1024 * 1024,
        }),
      (err: unknown) => err instanceof GeminiServiceError && err.code === "VIDEO_UNAVAILABLE",
    );
  } finally {
    setRemoteVideoNetworkForTesting(null);
  }
});

test("Phase 2.1 Security 5: Secures local uploads against malformed encoding, path traversal, and symlink escapes", async () => {
  const tempBase = await fs.promises.mkdtemp(path.join(os.tmpdir(), "facetube-upload-sec-"));
  const uploadsDir = path.join(tempBase, "uploads");
  const videosDir = path.join(uploadsDir, "videos");
  const outsideDir = path.join(tempBase, "outside");
  const outsideSecret = path.join(outsideDir, "secret.mp4");
  const validVideo = path.join(videosDir, "ok.mp4");
  const symlinkEscape = path.join(videosDir, "escape.mp4");
  const symlinkBroken = path.join(videosDir, "dangling.mp4");

  await fs.promises.mkdir(videosDir, { recursive: true });
  await fs.promises.mkdir(outsideDir, { recursive: true });
  await fs.promises.writeFile(outsideSecret, Buffer.from("SECRET_OUTSIDE_FILE"));
  await fs.promises.writeFile(validVideo, Buffer.from("VALID_LOCAL_VIDEO"));

  let symlinksSupported = true;
  try {
    await fs.promises.symlink(outsideSecret, symlinkEscape);
    await fs.promises.symlink(path.join(outsideDir, "does-not-exist.mp4"), symlinkBroken);
  } catch {
    symlinksSupported = false;
  }

  try {
    // 1. Malformed URI encoding returns clean 400 INVALID_VIDEO_PATH instead of raw URIError
    await assert.rejects(
      () =>
        loadAccessibleVideoBytes({
          videoUrl: "/uploads/videos/%E0%A4%A.mp4",
          maxBytes: 1024 * 1024,
          uploadsRootDir: uploadsDir,
        }),
      (err: unknown) =>
        err instanceof GeminiServiceError &&
        err.status === 400 &&
        err.code === "INVALID_VIDEO_PATH",
    );

    // 2. Traversal outside uploads returns 403 VIDEO_PATH_FORBIDDEN
    await assert.rejects(
      () =>
        loadAccessibleVideoBytes({
          videoUrl: "/uploads/videos/%2e%2e/%2e%2e/outside/secret.mp4",
          maxBytes: 1024 * 1024,
          uploadsRootDir: uploadsDir,
        }),
      (err: unknown) =>
        err instanceof GeminiServiceError &&
        err.status === 403 &&
        err.code === "VIDEO_PATH_FORBIDDEN",
    );

    // 3. Symlink escape & dangling symlink are both rejected safely
    if (symlinksSupported) {
      await assert.rejects(
        () =>
          loadAccessibleVideoBytes({
            videoUrl: "/uploads/videos/escape.mp4",
            maxBytes: 1024 * 1024,
            uploadsRootDir: uploadsDir,
          }),
        (err: unknown) =>
          err instanceof GeminiServiceError &&
          err.status === 403 &&
          err.code === "VIDEO_PATH_FORBIDDEN",
      );

      await assert.rejects(
        () =>
          loadAccessibleVideoBytes({
            videoUrl: "/uploads/videos/dangling.mp4",
            maxBytes: 1024 * 1024,
            uploadsRootDir: uploadsDir,
          }),
        (err: unknown) =>
          err instanceof GeminiServiceError &&
          err.status === 403 &&
          err.code === "VIDEO_PATH_FORBIDDEN",
      );
    }

    // 4. Valid regular file inside uploadsRoot succeeds
    const loaded = await loadAccessibleVideoBytes({
      videoUrl: "/uploads/videos/ok.mp4",
      maxBytes: 1024 * 1024,
      uploadsRootDir: uploadsDir,
    });
    assert.equal(loaded.source, "local_disk");
    assert.equal(loaded.mimeType, "video/mp4");
    assert.equal(Buffer.from(loaded.base64, "base64").toString("utf-8"), "VALID_LOCAL_VIDEO");
  } finally {
    await fs.promises.rm(tempBase, { recursive: true, force: true });
  }
});

test("Phase 2.1 Security 6: handleAiError hides internal SQL details, paths, secrets & stack traces behind generic 500", async () => {
  resetAiRateLimitsForTesting();
  setGeminiClientForTesting({
    interactions: {
      async create() {
        return { output_text: "{}" };
      },
    },
  });

  const secretKey = "AIzaSyMockInternalLeakTestKey99887766";
  const cleanupPool = installMockPool({
    async query(sql: string) {
      const normalized = sql.toLowerCase();
      if (normalized.includes("from information_schema.tables")) {
        return [[{ TABLE_NAME: "uploaded_videos" }, { TABLE_NAME: "video_likes" }], []];
      }
      if (normalized.includes("from information_schema.columns")) {
        return [
          [
            { TABLE_NAME: "uploaded_videos", COLUMN_NAME: "is_blocked" },
            { TABLE_NAME: "uploaded_videos", COLUMN_NAME: "visibility" },
            { TABLE_NAME: "uploaded_videos", COLUMN_NAME: "likes" },
            { TABLE_NAME: "uploaded_videos", COLUMN_NAME: "views" },
          ],
          [],
        ];
      }
      if (normalized.includes("from sessions")) {
        return [
          [
            {
              user_id: "FT100001",
              role: "user",
              expires_at: "2099-01-01T00:00:00.000Z",
            },
          ],
          [],
        ];
      }
      if (normalized.includes("from users")) {
        return [[{ id: "FT100001", name: "Test User", role: "user" }], []];
      }
      const err = new Error(
        `ER_BAD_FIELD_ERROR: Unknown column 'secret_col' in /var/www/facetube/src/server/api-handler.ts using key=${secretKey}`,
      );
      err.stack = "Error: leaked stack\n at /var/www/facetube/src/server/api-handler.ts:999:1";
      throw err;
    },
    async execute() {
      return [[], []];
    },
  });

  const loggedMessages: string[] = [];
  const origConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    loggedMessages.push(args.map(String).join(" "));
  };

  try {
    const res = await handleApiRequest(
      new Request("https://facetube.online/api/ai/recommendations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer mock-session-token",
        },
        body: JSON.stringify({ currentVideoId: "vid-1" }),
      }),
      {
        APP_ENV: "production",
        NODE_ENV: "production",
        GEMINI_API_KEY: secretKey,
      },
    );

    assert.ok(res);
    assert.equal(res.status, 500);
    const bodyText = await res.text();
    const parsed = JSON.parse(bodyText) as { success: boolean; code: string; error: string };
    assert.deepEqual(parsed, {
      success: false,
      code: "AI_INTERNAL_ERROR",
      error: "Internal AI service error",
    });
    assert.equal(bodyText.includes("ER_BAD_FIELD_ERROR"), false);
    assert.equal(bodyText.includes("/var/www/"), false);
    assert.equal(bodyText.includes(secretKey), false);
    assert.equal(bodyText.includes("secret_col"), false);

    // Server log must retain sanitized diagnostic details without raw API key
    const joinedLog = loggedMessages.join("\n");
    assert.match(joinedLog, /\[FaceTube AI Internal Error\]/);
    assert.match(joinedLog, /ER_BAD_FIELD_ERROR/);
    assert.equal(joinedLog.includes(secretKey), false);
  } finally {
    console.error = origConsoleError;
    cleanupPool();
    setGeminiClientForTesting(null);
    resetAiRateLimitsForTesting();
  }
});
