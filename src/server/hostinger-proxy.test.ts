import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HOSTINGER_API_ORIGIN,
  stripApiPrefix,
  buildHostingerProxyTargetUrl,
  isRemotePhpApiEnabled,
  isAiApiPath,
  shouldProxyToHostingerPhp,
  proxyHostingerApiRequest,
} from "./hostinger-proxy.ts";
import { routeServerApiRequest } from "../server.ts";
import { setMysqlPoolForTesting } from "./mysql.ts";

describe("Phase 1C: Hostinger API Reverse Proxy Tests", () => {
  describe("1. Path prefix stripping (stripApiPrefix)", () => {
    it("strips single leading /api prefix from endpoint paths", () => {
      assert.equal(stripApiPrefix("/api/auth/me.php"), "/auth/me.php");
      assert.equal(stripApiPrefix("/api/videos/list.php"), "/videos/list.php");
      assert.equal(stripApiPrefix("/api/payments/create-order.php"), "/payments/create-order.php");
      assert.equal(stripApiPrefix("/api/kyc/personal.php"), "/kyc/personal.php");
    });

    it("handles root /api and /api/ cleanly", () => {
      assert.equal(stripApiPrefix("/api"), "/");
      assert.equal(stripApiPrefix("/api/"), "/");
    });

    it("strips exactly ONE leading /api prefix and preserves downstream /api in path", () => {
      assert.equal(stripApiPrefix("/api/nested/api/test.php"), "/nested/api/test.php");
    });

    it("leaves non-/api paths unchanged", () => {
      assert.equal(stripApiPrefix("/auth/me.php"), "/auth/me.php");
      assert.equal(stripApiPrefix("/uploads/video.mp4"), "/uploads/video.mp4");
    });
  });

  describe("2. Destination URL Construction (buildHostingerProxyTargetUrl)", () => {
    it("targets fixed Hostinger API origin with stripped path", () => {
      const url = buildHostingerProxyTargetUrl("http://localhost:3000/api/auth/me.php");
      assert.equal(url, `${HOSTINGER_API_ORIGIN}/auth/me.php`);
    });

    it("preserves query strings exactly", () => {
      const url = buildHostingerProxyTargetUrl(
        "http://localhost:3000/api/videos/list.php?page=1&limit=10&category=Coding",
      );
      assert.equal(url, `${HOSTINGER_API_ORIGIN}/videos/list.php?page=1&limit=10&category=Coding`);
    });

    it("works with WHATWG URL instance input", () => {
      const parsed = new URL("https://ais-dev-preview.run.app/api/auth/login.php?source=header");
      const url = buildHostingerProxyTargetUrl(parsed);
      assert.equal(url, `${HOSTINGER_API_ORIGIN}/auth/login.php?source=header`);
    });

    it("strictly locks destination origin to https://api.facetube.online", () => {
      const target = buildHostingerProxyTargetUrl("http://attacker.example.com/api/test.php");
      assert.equal(new URL(target).origin, HOSTINGER_API_ORIGIN);
    });
  });

  describe("3. Explicit Enablement Requirement (isRemotePhpApiEnabled)", () => {
    it("remains disabled by default when flag is not set", () => {
      const prev = process.env["USE_REMOTE_PHP_API"];
      try {
        delete process.env["USE_REMOTE_PHP_API"];
        assert.equal(isRemotePhpApiEnabled(), false);
        assert.equal(isRemotePhpApiEnabled({}), false);
        assert.equal(isRemotePhpApiEnabled({ USE_REMOTE_PHP_API: "false" }), false);
        assert.equal(isRemotePhpApiEnabled({ USE_REMOTE_PHP_API: "" }), false);
      } finally {
        if (prev !== undefined) process.env["USE_REMOTE_PHP_API"] = prev;
      }
    });

    it("enables ONLY when USE_REMOTE_PHP_API is explicitly 'true'", () => {
      assert.equal(isRemotePhpApiEnabled({ USE_REMOTE_PHP_API: "true" }), true);
      const prev = process.env["USE_REMOTE_PHP_API"];
      try {
        process.env["USE_REMOTE_PHP_API"] = "true";
        assert.equal(isRemotePhpApiEnabled(), true);
      } finally {
        if (prev !== undefined) process.env["USE_REMOTE_PHP_API"] = prev;
        else delete process.env["USE_REMOTE_PHP_API"];
      }
    });
  });

  describe("4. Proxy Execution with Mocked Upstream (proxyHostingerApiRequest)", () => {
    it("forwards GET request method, query, and headers, omitting hop-by-hop headers", async () => {
      let capturedUrl = "";
      let capturedInit: RequestInit | undefined;

      const mockFetch: typeof fetch = async (url, init) => {
        capturedUrl = String(url);
        capturedInit = init;
        return new Response(JSON.stringify({ success: true, authenticated: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const req = new Request("http://localhost:3000/api/auth/me.php?verify=1", {
        method: "GET",
        headers: {
          Host: "localhost:3000",
          Authorization: "Bearer mock_test_token_12345",
          Accept: "application/json",
          Connection: "keep-alive",
          "X-Custom-Client": "FaceTubeApp",
        },
      });

      const response = await proxyHostingerApiRequest(req, mockFetch);

      assert.equal(capturedUrl, "https://api.facetube.online/auth/me.php?verify=1");
      assert.equal(capturedInit?.method, "GET");

      const fHeaders = capturedInit?.headers as Headers;
      assert.equal(fHeaders.get("authorization"), "Bearer mock_test_token_12345");
      assert.equal(fHeaders.get("x-custom-client"), "FaceTubeApp");
      // Hop-by-hop headers must NOT be forwarded
      assert.equal(fHeaders.get("host"), null);
      assert.equal(fHeaders.get("connection"), null);

      assert.equal(response.status, 200);
      const data = (await response.json()) as { success: boolean; authenticated: boolean };
      assert.equal(data.success, true);
      assert.equal(data.authenticated, false);
    });

    it("preserves POST method, request body, and headers without logging secrets", async () => {
      let capturedUrl = "";
      let capturedInit: RequestInit | undefined;

      const mockFetch: typeof fetch = async (url, init) => {
        capturedUrl = String(url);
        capturedInit = init;
        return new Response(JSON.stringify({ success: true, message: "Mock login response" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const requestPayload = JSON.stringify({ identifier: "FT483921", password: "mockPassword" });
      const req = new Request("http://localhost:3000/api/auth/login.php", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: requestPayload,
      });

      const response = await proxyHostingerApiRequest(req, mockFetch);

      assert.equal(capturedUrl, "https://api.facetube.online/auth/login.php");
      assert.equal(capturedInit?.method, "POST");

      const bodyBuffer = capturedInit?.body as ArrayBuffer;
      const forwardedBody = Buffer.from(bodyBuffer).toString("utf-8");
      assert.equal(forwardedBody, requestPayload);

      assert.equal(response.status, 200);
      const resData = (await response.json()) as { success: boolean; message: string };
      assert.equal(resData.success, true);
    });

    it("safely returns 502 Bad Gateway when upstream fetch fails without silent local fallback", async () => {
      const mockFailingFetch: typeof fetch = async () => {
        throw new Error("getaddrinfo ENOTFOUND api.facetube.online");
      };

      const req = new Request("http://localhost:3000/api/videos/list.php", {
        method: "GET",
      });

      const response = await proxyHostingerApiRequest(req, mockFailingFetch);

      assert.equal(response.status, 502);
      const errData = (await response.json()) as {
        success: boolean;
        error: string;
        details: string;
      };
      assert.equal(errData.success, false);
      assert.match(errData.error, /Upstream Hostinger API connection failed/i);
      assert.match(errData.details, /ENOTFOUND/i);
    });

    it("preserves upstream error statuses (e.g. 401, 404, 500) from Hostinger", async () => {
      const mock401Fetch: typeof fetch = async () => {
        return new Response(JSON.stringify({ success: false, error: "Authentication required" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      };

      const req = new Request("http://localhost:3000/api/admin/stats.php", {
        method: "GET",
      });

      const response = await proxyHostingerApiRequest(req, mock401Fetch);
      assert.equal(response.status, 401);
      const data = (await response.json()) as { success: boolean; error: string };
      assert.equal(data.success, false);
      assert.equal(data.error, "Authentication required");
    });
  });

  describe("5. AI API Routing Protection (/api/ai/* never proxied to Hostinger PHP)", () => {
    it("identifies /api/ai/* routes accurately without matching unrelated /api/air* paths", () => {
      assert.equal(isAiApiPath("/api/ai"), true);
      assert.equal(isAiApiPath("/api/ai/"), true);
      assert.equal(isAiApiPath("/api/ai/chat"), true);
      assert.equal(isAiApiPath("/api/ai/video-metadata"), true);
      assert.equal(isAiApiPath("/api/ai/video-summary"), true);
      assert.equal(isAiApiPath("/api/ai/recommendations"), true);
      assert.equal(isAiApiPath("/api//ai/chat.php"), true);
      assert.equal(isAiApiPath("/api/AI/Chat"), true);

      assert.equal(isAiApiPath("/api/videos/list.php"), false);
      assert.equal(isAiApiPath("/api/air/check.php"), false);
      assert.equal(isAiApiPath("/api/auth/me.php"), false);
    });

    it("never marks /api/ai/* for PHP proxying even when USE_REMOTE_PHP_API=true", () => {
      const envProxyOn = { USE_REMOTE_PHP_API: "true" };
      const envProxyOff = { USE_REMOTE_PHP_API: "false" };

      assert.equal(shouldProxyToHostingerPhp("/api/ai/chat", envProxyOn), false);
      assert.equal(shouldProxyToHostingerPhp("/api/ai/video-metadata", envProxyOn), false);
      assert.equal(shouldProxyToHostingerPhp("/api/ai/video-summary", envProxyOn), false);
      assert.equal(shouldProxyToHostingerPhp("/api/ai/recommendations", envProxyOn), false);
      assert.equal(shouldProxyToHostingerPhp("/api/videos/list.php", envProxyOn), true);

      assert.equal(shouldProxyToHostingerPhp("/api/ai/chat", envProxyOff), false);
      assert.equal(shouldProxyToHostingerPhp("/api/videos/list.php", envProxyOff), false);
    });

    it("proxyHostingerApiRequest refuses /api/ai/* directly without invoking upstream fetch", async () => {
      let fetchCalled = false;
      const neverFetch: typeof fetch = async () => {
        fetchCalled = true;
        return new Response("unexpected", { status: 200 });
      };

      const res = await proxyHostingerApiRequest(
        new Request("https://facetube.online/api/ai/chat", { method: "POST" }),
        neverFetch,
      );
      assert.equal(fetchCalled, false);
      assert.equal(res.status, 500);
      const body = (await res.json()) as { success: boolean; code: string };
      assert.equal(body.success, false);
      assert.equal(body.code, "AI_PROXY_FORBIDDEN");
    });

    it("routeServerApiRequest routes /api/ai/* to Nitro handler and non-AI to proxy when USE_REMOTE_PHP_API=true", async () => {
      const aiPaths = [
        "/api/ai/video-metadata",
        "/api/ai/video-summary",
        "/api/ai/chat",
        "/api/ai/recommendations",
      ];

      for (const aiPath of aiPaths) {
        let proxyCalls = 0;
        let nitroCalls = 0;

        const res = await routeServerApiRequest(
          new Request(`https://facetube.online${aiPath}`, { method: "POST" }),
          { USE_REMOTE_PHP_API: "true" },
          undefined,
          {
            proxyFn: async () => {
              proxyCalls++;
              return new Response("proxied", { status: 200 });
            },
            apiHandlerFn: async (req) => {
              nitroCalls++;
              return Response.json({ routedTo: "nitro", path: new URL(req.url).pathname });
            },
          },
        );

        assert.equal(proxyCalls, 0, `${aiPath} must never call proxyFn`);
        assert.equal(nitroCalls, 1, `${aiPath} must invoke Nitro apiHandlerFn`);
        assert.ok(res);
        assert.equal(res.status, 200);
      }

      // Verify non-AI API still proxies to Hostinger PHP when USE_REMOTE_PHP_API=true
      let phpProxyCalls = 0;
      let phpNitroCalls = 0;
      const nonAiRes = await routeServerApiRequest(
        new Request("https://facetube.online/api/videos/list.php?page=1", { method: "GET" }),
        { USE_REMOTE_PHP_API: "true" },
        undefined,
        {
          proxyFn: async () => {
            phpProxyCalls++;
            return Response.json({ routedTo: "php-proxy" });
          },
          apiHandlerFn: async () => {
            phpNitroCalls++;
            return Response.json({ routedTo: "nitro" });
          },
        },
      );
      assert.equal(phpProxyCalls, 1);
      assert.equal(phpNitroCalls, 0);
      assert.deepEqual(await nonAiRes?.json(), { routedTo: "php-proxy" });
    });

    it("routeServerApiRequest routes both AI and non-AI endpoints to Nitro handler when USE_REMOTE_PHP_API=false", async () => {
      let proxyCalls = 0;
      let nitroCalls = 0;

      const deps = {
        proxyFn: async () => {
          proxyCalls++;
          return Response.json({ routedTo: "php-proxy" });
        },
        apiHandlerFn: async (req: Request) => {
          nitroCalls++;
          return Response.json({ routedTo: "nitro", path: new URL(req.url).pathname });
        },
      };

      const aiRes = await routeServerApiRequest(
        new Request("http://localhost:3000/api/ai/recommendations", { method: "GET" }),
        { USE_REMOTE_PHP_API: "false" },
        undefined,
        deps,
      );
      const videoRes = await routeServerApiRequest(
        new Request("http://localhost:3000/api/videos/list.php", { method: "GET" }),
        { USE_REMOTE_PHP_API: "false" },
        undefined,
        deps,
      );

      assert.equal(proxyCalls, 0);
      assert.equal(nitroCalls, 2);
      assert.deepEqual(await aiRes?.json(), {
        routedTo: "nitro",
        path: "/api/ai/recommendations",
      });
      assert.deepEqual(await videoRes?.json(), {
        routedTo: "nitro",
        path: "/api/videos/list.php",
      });
    });

    it("routeServerApiRequest end-to-end reaches real handleApiRequest for /api/ai/chat even when USE_REMOTE_PHP_API=true", async () => {
      const prevHost = process.env["DB_HOST"];
      const prevName = process.env["DB_NAME"];
      const prevUser = process.env["DB_USER"];
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "facetube_test";

      // Minimal mock MySQL pool so real handleApiRequest executes without touching persistent JSON
      setMysqlPoolForTesting({
        async query(sql: string) {
          const normalized = sql.toLowerCase();
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
          return [[], []];
        },
        async execute() {
          return [[], []];
        },
      } as any);

      let proxyCalled = false;
      try {
        const res = await routeServerApiRequest(
          new Request("https://facetube.online/api/ai/chat", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer mock-session-token",
            },
            body: JSON.stringify({ message: "hello" }),
          }),
          {
            USE_REMOTE_PHP_API: "true",
            APP_ENV: "production",
            NODE_ENV: "production",
          },
          undefined,
          {
            proxyFn: async () => {
              proxyCalled = true;
              return new Response("should-not-proxy", { status: 500 });
            },
          },
        );

        assert.equal(proxyCalled, false);
        assert.ok(res);
        // Reaches handleApiRequest's AI_NOT_CONFIGURED guard rather than Hostinger PHP proxy
        assert.equal(res.status, 503);
        const body = (await res.json()) as { success: boolean; code: string };
        assert.equal(body.success, false);
        assert.equal(body.code, "AI_NOT_CONFIGURED");
      } finally {
        setMysqlPoolForTesting(null);
        if (prevHost === undefined) delete process.env["DB_HOST"];
        else process.env["DB_HOST"] = prevHost;
        if (prevName === undefined) delete process.env["DB_NAME"];
        else process.env["DB_NAME"] = prevName;
        if (prevUser === undefined) delete process.env["DB_USER"];
        else process.env["DB_USER"] = prevUser;
      }
    });
  });
});
