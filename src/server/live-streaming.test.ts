import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  handleApiRequest,
  generateLiveKitAccessToken,
  verifyLiveKitWebhook,
  base64UrlDecode,
  resetInMemoryStore,
} from "./api-handler.ts";
import { setMysqlPoolForTesting } from "./mysql.ts";

describe("LiveKit WebRTC Live Streaming Backend Foundation Tests (Stage 1)", () => {
  let adminToken = "";
  let creatorToken = "";
  let viewerToken = "";
  let testStreamId = "";
  let storeBackup = "";
  const storePath = path.resolve(process.cwd(), "data/facetube_store.json");
  const testApiSecret = "test-livekit-secret-key-12345";
  const originalSecret = process.env["LIVEKIT_API_SECRET"];

  before(async () => {
    process.env["LIVEKIT_API_SECRET"] = testApiSecret;

    if (fs.existsSync(storePath)) {
      storeBackup = fs.readFileSync(storePath, "utf-8");
    }
    resetInMemoryStore();

    // 1. Authenticate Admin (FT102857)
    const adminRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "admin@facetube.com", password: "password123" }),
      }),
    );
    assert.ok(adminRes);
    const adminData = await adminRes.json();
    adminToken = adminData.token;

    // 2. Authenticate Creator (Alex - FT483921)
    const creatorRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
      }),
    );
    assert.ok(creatorRes);
    const creatorData = await creatorRes.json();
    creatorToken = creatorData.token;

    // 3. Authenticate Viewer (Maya - FT900431)
    const viewerRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "maya@facetube.com", password: "password123" }),
      }),
    );
    assert.ok(viewerRes);
    const viewerData = await viewerRes.json();
    assert.ok(viewerData.token, "Maya login must succeed and return token");
    viewerToken = viewerData.token;

    // 4. Create a test stream owned by Creator (Alex - FT483921)
    const createStreamRes = await handleApiRequest(
      new Request("http://localhost:3000/api/live/streams", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${creatorToken}`,
        },
        body: JSON.stringify({
          title: "Alex's Live Dev Stream",
          description: "Building LiveKit integration live",
          category: "Coding & Tech",
        }),
      }),
    );
    assert.ok(createStreamRes);
    const createStreamData = await createStreamRes.json();
    assert.equal(createStreamRes.status, 201);
    assert.ok(createStreamData.stream);
    assert.ok(createStreamData.stream.id);
    assert.ok(createStreamData.stream.livekit_room_name);
    testStreamId = createStreamData.stream.id;
  });

  after(() => {
    if (originalSecret !== undefined) {
      process.env["LIVEKIT_API_SECRET"] = originalSecret;
    } else {
      delete process.env["LIVEKIT_API_SECRET"];
    }

    if (storeBackup && fs.existsSync(storePath)) {
      fs.writeFileSync(storePath, storeBackup, "utf-8");
    }
  });

  describe("1. LiveKit Token Generation & Permission Isolation", () => {
    it("mints an authoritative publisher token for the stream creator with publishing permissions", async () => {
      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({
            streamId: testStreamId,
            role: "publisher",
          }),
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.role, "publisher");
      assert.equal(data.identity, "FT483921");
      assert.ok(data.token);
      assert.ok(data.room.startsWith("room_"));

      // Decode token payload
      const parts = data.token.split(".");
      assert.equal(parts.length, 3);
      const payload = JSON.parse(base64UrlDecode(parts[1]).toString("utf8"));
      assert.equal(payload.sub, "FT483921");
      assert.equal(payload.video.room, data.room);
      assert.equal(payload.video.roomJoin, true);
      assert.equal(payload.video.canPublish, true);
      assert.equal(payload.video.canSubscribe, true);
      assert.deepEqual(payload.video.canPublishSources, ["camera", "microphone", "screen_share"]);
      assert.ok(payload.exp > payload.iat);
    });

    it("mints a subscriber token for a regular viewer with publish disabled", async () => {
      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${viewerToken}`,
          },
          body: JSON.stringify({
            streamId: testStreamId,
            role: "subscriber",
          }),
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.role, "subscriber");
      assert.equal(data.identity, "FT900431");

      // Verify claims: subscriber cannot publish
      const parts = data.token.split(".");
      const payload = JSON.parse(base64UrlDecode(parts[1]).toString("utf8"));
      assert.equal(payload.video.canPublish, false);
      assert.equal(payload.video.canSubscribe, true);
      assert.equal(payload.video.canPublishSources, undefined);
    });

    it("strictly rejects non-owner viewer requesting a publisher token with 403 Forbidden", async () => {
      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${viewerToken}`,
          },
          body: JSON.stringify({
            streamId: testStreamId,
            role: "publisher", // Non-owner attempting to hijack broadcaster role
          }),
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /Only the stream creator can publish/);
    });

    it("rejects unauthenticated token request with 401 Unauthorized", async () => {
      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ streamId: testStreamId }),
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 401);
    });

    it("returns 404 if stream does not exist", async () => {
      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${viewerToken}`,
          },
          body: JSON.stringify({ streamId: "live_non_existent_9999" }),
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 404);
    });

    it("returns all required Stage 2 frontend contract fields in token payload", async () => {
      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({
            streamId: testStreamId,
            role: "publisher",
          }),
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(typeof data.token, "string");
      assert.equal(typeof data.url, "string");
      assert.equal(typeof data.room, "string");
      assert.equal(typeof data.identity, "string");
      assert.equal(typeof data.role, "string");
      assert.equal(typeof data.expires_at, "number");
      assert.equal(typeof data.server_configured, "boolean");
    });
  });

  describe("2. Authenticated Heartbeat & Ownership Validation", () => {
    it("allows the stream owner to send broadcaster heartbeats", async () => {
      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/heartbeat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({
            streamId: testStreamId,
            role: "broadcaster",
            stats: { bitrate: 2500, fps: 30 },
          }),
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.role, "broadcaster");
    });

    it("rejects non-owner trying to send a broadcaster heartbeat with 403 Forbidden", async () => {
      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/heartbeat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${viewerToken}`,
          },
          body: JSON.stringify({
            streamId: testStreamId,
            role: "broadcaster",
          }),
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /Only the broadcaster can send broadcaster heartbeats/);
    });

    it("allows authenticated viewers to register presence heartbeats", async () => {
      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/heartbeat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${viewerToken}`,
          },
          body: JSON.stringify({
            streamId: testStreamId,
            role: "viewer",
          }),
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.role, "viewer");
    });
  });

  describe("3. End-Stream Ownership & History Preservation", () => {
    it("rejects unauthorized viewer attempting to terminate a stream with 403 Forbidden", async () => {
      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/end-stream", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${viewerToken}`,
          },
          body: JSON.stringify({ streamId: testStreamId }),
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /Only the stream owner or an administrator can end this stream/);
    });

    it("allows the stream creator to successfully end their stream", async () => {
      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/end-stream", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({ streamId: testStreamId }),
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.stream.status, "ended");
      assert.equal(data.stream.viewers_count, 0);
      assert.ok(data.stream.ended_at);
    });

    it("handles repeated end-stream requests idempotently", async () => {
      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/end-stream", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({ streamId: testStreamId }),
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.match(data.message, /already ended/);
      assert.equal(data.stream.status, "ended");
    });
  });

  describe("4. Official LiveKit Webhook Signature Verification & Ingestion", () => {
    // Helper to generate a valid LiveKit webhook token matching official specs
    function createValidLiveKitWebhookToken(rawBody: string, secret: string) {
      const header = { alg: "HS256", typ: "JWT" };
      const bodyHash = crypto.createHash("sha256").update(rawBody).digest("base64");
      const payload = {
        iss: "test-api-key",
        sha256: bodyHash,
        iat: Math.floor(Date.now() / 1000),
      };

      const b64Url = (obj: any) =>
        Buffer.from(JSON.stringify(obj))
          .toString("base64")
          .replace(/=/g, "")
          .replace(/\+/g, "-")
          .replace(/\//g, "_");

      const headerB64 = b64Url(header);
      const payloadB64 = b64Url(payload);
      const sigInput = `${headerB64}.${payloadB64}`;
      const sig = crypto
        .createHmac("sha256", secret)
        .update(sigInput)
        .digest("base64")
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");

      return `${sigInput}.${sig}`;
    }

    it("accepts a cryptographically valid LiveKit webhook request", async () => {
      const webhookPayload = JSON.stringify({
        id: "EV_TEST_JOIN_001",
        event: "participant_joined",
        createdAt: Math.floor(Date.now() / 1000),
        room: {
          name: `room_${testStreamId}`,
          numParticipants: 5,
        },
        participant: {
          identity: "FT729104",
          name: "Priya",
        },
      });

      const validToken = createValidLiveKitWebhookToken(webhookPayload, testApiSecret);

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${validToken}`,
          },
          body: webhookPayload,
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.event, "participant_joined");
      assert.equal(data.processed, true);
    });

    it("rejects webhook request with an invalid/tampered signature with 401 Unauthorized", async () => {
      const webhookPayload = JSON.stringify({
        id: "EV_TEST_JOIN_002",
        event: "participant_joined",
      });

      // Sign with wrong secret
      const invalidToken = createValidLiveKitWebhookToken(webhookPayload, "wrong-fake-secret");

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${invalidToken}`,
          },
          body: webhookPayload,
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /signature verification failed/);
    });

    it("rejects webhook request when raw body does not match sha256 claim with 401 Unauthorized", async () => {
      const originalPayload = JSON.stringify({
        id: "EV_TEST_JOIN_003",
        event: "participant_joined",
      });
      const validToken = createValidLiveKitWebhookToken(originalPayload, testApiSecret);

      // Tamper the body after generating the token
      const tamperedPayload = JSON.stringify({
        id: "EV_TEST_JOIN_003",
        event: "participant_joined",
        tampered_field: "injected",
      });

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${validToken}`,
          },
          body: tamperedPayload,
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /hash mismatch/);
    });

    it("rejects webhook request with missing Authorization header with 401 Unauthorized", async () => {
      const payload = JSON.stringify({ id: "EV_NO_AUTH", event: "participant_joined" });
      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/webhook", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 401);
    });

    it("processes duplicate webhook events idempotently without double processing", async () => {
      const duplicatePayload = JSON.stringify({
        id: "EV_TEST_DUPLICATE_999",
        event: "participant_joined",
        room: { name: `room_${testStreamId}`, numParticipants: 8 },
      });
      const token = createValidLiveKitWebhookToken(duplicatePayload, testApiSecret);

      // First delivery
      const res1 = await handleApiRequest(
        new Request("http://localhost:3000/api/live/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: duplicatePayload,
        }),
      );
      assert.ok(res1);
      assert.equal(res1.status, 200);

      // Second delivery (duplicate retry)
      const res2 = await handleApiRequest(
        new Request("http://localhost:3000/api/live/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: duplicatePayload,
        }),
      );
      assert.ok(res2);
      assert.equal(res2.status, 200);
      const data2 = await res2.json();
      assert.equal(data2.success, true);
      assert.equal(data2.idempotent, true);
      assert.equal(data2.duplicate, true);
    });
  });

  describe("5. Production Isolation & Fail-Closed Guard", () => {
    it("fails closed with 503 when NODE_ENV is production and database connection is unavailable", async () => {
      const origEnv = process.env["NODE_ENV"];
      process.env["NODE_ENV"] = "production";

      try {
        const res = await handleApiRequest(
          new Request("http://localhost:3000/api/live/token", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${creatorToken}`,
            },
            body: JSON.stringify({ streamId: testStreamId }),
          }),
        );
        assert.ok(res);
        assert.equal(res.status, 503);
        const data = await res.json();
        assert.equal(data.success, false);
        assert.match(data.error, /Database connection unavailable in production environment/);
      } finally {
        process.env["NODE_ENV"] = origEnv;
      }
    });
  });

  describe("6. Task 5J-I: GET /api/live/streams MySQL Parity & Public Secret Protection", () => {
    const envKeys = [
      "NODE_ENV",
      "APP_ENV",
      "DB_HOST",
      "DB_NAME",
      "DB_USER",
      "FACETUBE_API_BASE_URL",
      "API_BASE_URL",
      "VITE_MEDIA_BASE_URL",
    ] as const;

    let envSnapshot: Record<string, string | undefined> = {};
    let suiteStoreSnapshot: string | null = null;
    let suiteStoreExisted = false;

    function enableMockDbEnv(mockPool: any) {
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";
      setMysqlPoolForTesting(mockPool);
    }

    beforeEach(() => {
      envSnapshot = {};
      for (const k of envKeys) {
        envSnapshot[k] = process.env[k];
      }
      suiteStoreExisted = fs.existsSync(storePath);
      suiteStoreSnapshot = suiteStoreExisted ? fs.readFileSync(storePath, "utf-8") : null;
      setMysqlPoolForTesting(null);
      resetInMemoryStore();
    });

    afterEach(() => {
      setMysqlPoolForTesting(null);
      for (const k of envKeys) {
        if (envSnapshot[k] !== undefined) {
          process.env[k] = envSnapshot[k];
        } else {
          delete process.env[k];
        }
      }
      if (suiteStoreExisted && suiteStoreSnapshot !== null) {
        fs.writeFileSync(storePath, suiteStoreSnapshot, "utf-8");
      } else if (!suiteStoreExisted && fs.existsSync(storePath)) {
        fs.unlinkSync(storePath);
      }
      resetInMemoryStore();
    });

    it("queries MySQL with explicit public columns, filters active statuses, orders parity-first, joins branding case-insensitively, normalizes URLs, and never exposes stream_key or PII", async () => {
      process.env["NODE_ENV"] = "production";
      delete process.env["APP_ENV"];
      delete process.env["FACETUBE_API_BASE_URL"];
      delete process.env["API_BASE_URL"];
      delete process.env["VITE_MEDIA_BASE_URL"];

      let capturedSql = "";
      const mockRows = [
        {
          id: "live_ended_01",
          user_id: "ft102857",
          title: "Ended Broadcast",
          description: "Should be filtered out",
          category: "General",
          stream_key: "sk_live_secret_ended",
          playback_url: "/uploads/videos/ended.m3u8",
          thumbnail_url: "/uploads/images/ended.jpg",
          status: "ended",
          viewers_count: 9999,
          started_at: "2026-11-19T10:00:00.000Z",
          ended_at: "2026-11-19T12:00:00.000Z",
          created_at: "2026-11-19T10:00:00.000Z",
          updated_at: "2026-11-19T12:00:00.000Z",
          streamer_name: "Admin Studio",
          channel_name: "Admin Studio",
          avatar_url: "/uploads/logos/admin_avatar.png",
          channel_logo_url: "/uploads/logos/admin_logo.png",
          email: "admin@facetube.com",
        },
        {
          id: "live_up_high",
          user_id: "ft900431",
          title: "Upcoming High Viewers",
          description: "Upcoming stream",
          category: "Business",
          stream_key: "sk_live_secret_up",
          playback_url: "",
          thumbnail_url: "null",
          status: "upcoming",
          viewers_count: 500,
          started_at: null,
          ended_at: null,
          created_at: "2026-11-20T09:00:00.000Z",
          updated_at: "2026-11-20T09:00:00.000Z",
          streamer_name: "Maya Lin",
          channel_name: "undefined",
          avatar_url: "/uploads/logos/maya_avatar.png",
          channel_logo_url: "null",
          mobile: "+1 555-019-0043",
        },
        {
          id: "live_active_low_newer",
          user_id: "FT483921",
          title: "Live Newer Fewer Viewers",
          description: "Desc 1",
          category: "Coding",
          stream_key: "sk_live_secret_1",
          playback_url: "https://cdn.example.com/hls/1.m3u8",
          thumbnail_url: "/uploads/images/thumb1.jpg",
          status: "live",
          viewers_count: 120,
          started_at: "2026-11-20T08:00:00.000Z",
          ended_at: null,
          created_at: "2026-11-20T08:00:00.000Z",
          updated_at: "2026-11-20T08:05:00.000Z",
          streamer_name: "Alex Tech",
          channel_name: "Alex Tech",
          avatar_url: "/uploads/logos/alex_avatar.png",
          channel_logo_url:
            "https://api.facetube.onlinehttps://api.facetube.online/uploads/logos/alex_logo.png",
          referral_code: "CREATOR50",
        },
        {
          id: "live_active_tie_older",
          user_id: "ft483921",
          title: "Live Tie Older",
          description: "Desc 2",
          category: "Coding",
          stream_key: "sk_live_secret_2",
          playback_url: "",
          thumbnail_url: "",
          status: "live",
          viewers_count: 120,
          started_at: "2026-11-20T06:00:00.000Z",
          ended_at: null,
          created_at: "2026-11-20T06:00:00.000Z",
          updated_at: "2026-11-20T06:00:00.000Z",
          streamer_name: "Alex Tech",
          channel_name: "Alex Tech",
          avatar_url: "https://images.unsplash.com/photo-1.jpg",
          channel_logo_url: "/uploads/logos/alex_tie.png",
        },
        {
          id: "live_active_top",
          user_id: "ft102857",
          title: "Live Top Viewers",
          description: "Most watched",
          category: "Education",
          stream_key: "sk_live_secret_top",
          playback_url: "/uploads/videos/top.mp4",
          thumbnail_url: "/uploads/images/top.jpg",
          status: "live",
          viewers_count: 850,
          started_at: "2026-11-20T05:00:00.000Z",
          ended_at: null,
          created_at: "2026-11-20T05:00:00.000Z",
          updated_at: "2026-11-20T05:30:00.000Z",
          streamer_name: "FaceTube Official",
          channel_name: "FaceTube Official",
          avatar_url: "/uploads/logos/ft_avatar.png",
          channel_logo_url: "/uploads/logos/ft_logo.png",
          password_hash: "should_never_leak",
        },
      ];

      enableMockDbEnv({
        query: async (sql: string) => {
          capturedSql = sql;
          return [mockRows, []];
        },
      });

      const res = await handleApiRequest(
        new Request("https://facetube.online/api/live/streams", { method: "GET" }),
      );
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.success, true);

      // SQL parity checks
      assert.doesNotMatch(capturedSql, /\bSELECT\s+s\.\*/i);
      assert.doesNotMatch(capturedSql, /\bstream_key\b/i);
      assert.doesNotMatch(
        capturedSql,
        /\blivekit_room_name\b|\bbroadcaster_last_ping_at\b|\btotal_unique_viewers\b/i,
      );
      assert.match(
        capturedSql,
        /LEFT\s+JOIN\s+users\s+u\s+ON\s+UPPER\(s\.user_id\)\s*=\s*UPPER\(u\.user_id\)/i,
      );
      assert.match(capturedSql, /WHERE\s+s\.status\s+IN\s*\(\s*'live'\s*,\s*'upcoming'\s*\)/i);
      assert.match(
        capturedSql,
        /ORDER\s+BY\s*\(s\.status\s*=\s*'live'\)\s+DESC\s*,\s*s\.viewers_count\s+DESC\s*,\s*s\.created_at\s+DESC/i,
      );

      // Ended stream filtered out; ordering: live (850) -> live (120 newer) -> live (120 older) -> upcoming (500)
      assert.deepEqual(
        data.streams.map((s: any) => s.id),
        ["live_active_top", "live_active_low_newer", "live_active_tie_older", "live_up_high"],
      );

      const top = data.streams[0];
      assert.equal(top.streamer_name, "FaceTube Official");
      assert.equal(top.channel_name, "FaceTube Official");
      assert.equal(top.avatar_url, "https://api.facetube.online/uploads/logos/ft_avatar.png");
      assert.equal(top.channel_logo_url, "https://api.facetube.online/uploads/logos/ft_logo.png");
      assert.equal(top.thumbnail_url, "https://api.facetube.online/uploads/images/top.jpg");
      assert.equal(top.playback_url, "https://api.facetube.online/uploads/videos/top.mp4");

      const unnested = data.streams[1];
      assert.equal(
        unnested.channel_logo_url,
        "https://api.facetube.online/uploads/logos/alex_logo.png",
      );

      // Invalid "undefined" / "null" strings sanitized and channel_logo_url falls back to avatar_url
      const upcoming = data.streams[3];
      assert.equal(upcoming.channel_name, "Maya Lin");
      assert.equal(upcoming.streamer_name, "Maya Lin");
      assert.equal(upcoming.thumbnail_url, "");
      assert.equal(
        upcoming.avatar_url,
        "https://api.facetube.online/uploads/logos/maya_avatar.png",
      );
      assert.equal(
        upcoming.channel_logo_url,
        "https://api.facetube.online/uploads/logos/maya_avatar.png",
      );

      // Secrets and PII must never appear
      for (const s of data.streams) {
        assert.equal("stream_key" in s, false);
        assert.equal("email" in s, false);
        assert.equal("mobile" in s, false);
        assert.equal("password_hash" in s, false);
        assert.equal("referral_code" in s, false);
        assert.equal("token" in s, false);
      }
    });

    it("falls back safely when optional migration-dependent channel columns are missing in MySQL (ER_BAD_FIELD_ERROR / 1054)", async () => {
      process.env["NODE_ENV"] = "production";
      delete process.env["APP_ENV"];

      const executedQueries: string[] = [];
      enableMockDbEnv({
        query: async (sql: string) => {
          executedQueries.push(sql);
          if (executedQueries.length === 1) {
            const err: any = new Error("Unknown column 'u.channel_logo_url' in 'field list'");
            err.code = "ER_BAD_FIELD_ERROR";
            err.errno = 1054;
            err.sqlState = "42S22";
            throw err;
          }
          return [
            [
              {
                id: "live_compat_01",
                user_id: "FT483921",
                title: "Compat Live Stream",
                description: "Works without optional columns",
                category: "Coding",
                playback_url: "",
                thumbnail_url: "/uploads/images/compat.jpg",
                status: "live",
                viewers_count: 42,
                started_at: "2026-11-20T07:00:00.000Z",
                ended_at: null,
                created_at: "2026-11-20T07:00:00.000Z",
                updated_at: "2026-11-20T07:00:00.000Z",
                streamer_name: "Alex Rivera",
                channel_name: "Alex Rivera",
                avatar_url: "/uploads/logos/alex_compat.png",
                channel_logo_url: "/uploads/logos/alex_compat.png",
              },
            ],
            [],
          ];
        },
      });

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/streams", { method: "GET" }),
      );
      assert.ok(res);
      assert.equal(res.status, 200);
      assert.equal(executedQueries.length, 2);
      assert.doesNotMatch(executedQueries[1] || "", /u\.channel_name|u\.channel_logo_url/i);
      const data = (await res.json()) as any;
      assert.equal(data.streams.length, 1);
      assert.equal(data.streams[0].channel_name, "Alex Rivera");
      assert.equal(
        data.streams[0].channel_logo_url,
        "https://api.facetube.online/uploads/logos/alex_compat.png",
      );
      assert.equal("stream_key" in data.streams[0], false);
    });

    it("fails closed with 503 in production when no MySQL pool is available", async () => {
      process.env["NODE_ENV"] = "production";
      delete process.env["APP_ENV"];
      setMysqlPoolForTesting(null);

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/streams", { method: "GET" }),
      );
      assert.ok(res);
      assert.equal(res.status, 503);
      const data = (await res.json()) as any;
      assert.equal(data.success, false);
      assert.match(data.error, /Database connection unavailable in production environment/i);
    });

    it("fails closed with 500 in production on MySQL query failure without falling back to JSON store", async () => {
      process.env["NODE_ENV"] = "production";
      delete process.env["APP_ENV"];

      // Ensure JSON store has a stream that must NEVER be leaked on production DB failure
      fs.writeFileSync(
        storePath,
        JSON.stringify({
          liveStreams: [
            {
              id: "live_json_should_not_leak",
              user_id: "FT483921",
              title: "JSON Fallback Must Not Be Used In Prod",
              description: "",
              category: "Coding",
              stream_key: "sk_live_json",
              playback_url: "",
              thumbnail_url: "",
              status: "live",
              viewers_count: 10,
              created_at: "2026-11-20T08:00:00.000Z",
            },
          ],
          users: [],
          sessions: {},
          videos: [],
        }),
        "utf-8",
      );
      resetInMemoryStore();

      enableMockDbEnv({
        query: async () => {
          throw new Error("ECONNREFUSED MySQL query failure");
        },
      });

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/streams", { method: "GET" }),
      );
      assert.ok(res);
      assert.equal(res.status, 500);
      const data = (await res.json()) as any;
      assert.equal(data.success, false);
      assert.equal(data.streams, undefined);
      assert.doesNotMatch(String(data.error || ""), /ECONNREFUSED/);
    });

    it("uses non-production JSON fallback without auto-seeding live_seed_001, filters ended streams, orders identically, enriches branding case-insensitively, and strips stream_key", async () => {
      process.env["NODE_ENV"] = "test";
      delete process.env["APP_ENV"];
      setMysqlPoolForTesting(null);

      // 1. Empty store returns [] without auto-seeding live_seed_001
      const baseStore = suiteStoreSnapshot ? JSON.parse(suiteStoreSnapshot) : { users: [] };
      baseStore.liveStreams = [];
      fs.writeFileSync(storePath, JSON.stringify(baseStore), "utf-8");
      resetInMemoryStore();

      const emptyRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/streams", { method: "GET" }),
      );
      assert.ok(emptyRes);
      assert.equal(emptyRes.status, 200);
      const emptyData = (await emptyRes.json()) as any;
      assert.equal(emptyData.success, true);
      assert.deepEqual(emptyData.streams, []);

      // Verify store was not mutated with live_seed_001
      const persistedAfterEmpty = JSON.parse(fs.readFileSync(storePath, "utf-8"));
      assert.deepEqual(persistedAfterEmpty.liveStreams, []);

      // 2. Populated store filters ended, orders parity-first, joins users case-insensitively, strips secrets
      const populatedStore = {
        ...baseStore,
        users: [
          {
            id: "u-alex",
            user_id: "FT483921",
            name: "Alex Rivera",
            channel_name: "Alex Studio",
            channel_logo_url: "/uploads/logos/alex_studio.png",
            avatar_url: "https://images.unsplash.com/alex.jpg",
            email: "alex@facetube.com",
            mobile: "+1 555-014-8392",
            password_hash: "secret_hash",
            role: "user",
            referral_code: "CREATOR50",
            created_at: "2026-10-01T00:00:00.000Z",
          },
          {
            id: "u-maya",
            user_id: "FT900431",
            name: "Maya Lin",
            channel_name: "null",
            channel_logo_url: "undefined",
            avatar_url: "/uploads/logos/maya_fallback.png",
            email: "maya@facetube.com",
            mobile: "+1 555-019-0043",
            password_hash: "secret_hash_2",
            role: "user",
            referral_code: null,
            created_at: "2026-10-02T00:00:00.000Z",
          },
        ],
        liveStreams: [
          {
            id: "json_ended",
            user_id: "ft483921",
            title: "Ended JSON Stream",
            description: "",
            category: "Coding",
            stream_key: "sk_live_json_ended",
            playback_url: "",
            thumbnail_url: "",
            status: "ended",
            viewers_count: 5000,
            created_at: "2026-11-20T10:00:00.000Z",
          },
          {
            id: "json_upcoming",
            user_id: "ft900431",
            title: "Upcoming JSON Stream",
            description: "Scheduled",
            category: "Business",
            stream_key: "sk_live_json_upcoming",
            playback_url: "",
            thumbnail_url: "/uploads/images/up.jpg",
            status: "upcoming",
            viewers_count: 900,
            created_at: "2026-11-20T11:00:00.000Z",
          },
          {
            id: "json_live_low",
            user_id: "ft483921",
            title: "Live JSON Low",
            description: "",
            category: "Coding",
            stream_key: "sk_live_json_low",
            playback_url: "",
            thumbnail_url: "",
            status: "live",
            viewers_count: 25,
            created_at: "2026-11-20T09:00:00.000Z",
          },
          {
            id: "json_live_high",
            user_id: "ft900431",
            title: "Live JSON High",
            description: "",
            category: "Business",
            stream_key: "sk_live_json_high",
            playback_url: "",
            thumbnail_url: "",
            status: "live",
            viewers_count: 300,
            created_at: "2026-11-20T08:00:00.000Z",
          },
        ],
      };
      fs.writeFileSync(storePath, JSON.stringify(populatedStore), "utf-8");
      resetInMemoryStore();

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/streams", { method: "GET" }),
      );
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.success, true);
      assert.deepEqual(
        data.streams.map((s: any) => s.id),
        ["json_live_high", "json_live_low", "json_upcoming"],
      );

      assert.equal(data.streams[0].channel_name, "Maya Lin");
      assert.equal(data.streams[0].streamer_name, "Maya Lin");
      assert.equal(data.streams[0].avatar_url, "/uploads/logos/maya_fallback.png");
      assert.equal(data.streams[0].channel_logo_url, "/uploads/logos/maya_fallback.png");

      assert.equal(data.streams[1].channel_name, "Alex Studio");
      assert.equal(data.streams[1].channel_logo_url, "/uploads/logos/alex_studio.png");

      for (const s of data.streams) {
        assert.equal("stream_key" in s, false);
        assert.equal("email" in s, false);
        assert.equal("mobile" in s, false);
        assert.equal("password_hash" in s, false);
        assert.equal("referral_code" in s, false);
      }
    });

    it("activates fail-closed 503 guard for POST /api/live/streams and POST /api/live/token when APP_ENV=production and NODE_ENV is unset", async () => {
      process.env["APP_ENV"] = "production";
      delete process.env["NODE_ENV"];
      delete process.env["DB_HOST"];
      setMysqlPoolForTesting(null);

      const createRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/streams", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({ title: "Should Fail Closed 503" }),
        }),
      );
      assert.ok(createRes);
      assert.equal(createRes.status, 503);

      const tokenRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({ streamId: testStreamId, role: "publisher" }),
        }),
      );
      assert.ok(tokenRes);
      assert.equal(tokenRes.status, 503);
    });

    it("maps channel_name as creator display-name fallback on src/routes/live.tsx while preserving streamer_name and creator_name priority", () => {
      const liveRouteSrc = fs.readFileSync(
        path.resolve(process.cwd(), "src/routes/live.tsx"),
        "utf-8",
      );

      assert.match(liveRouteSrc, /s\.streamer_name[\s\S]*?s\.creator_name[\s\S]*?s\.channel_name/);
      assert.match(
        liveRouteSrc,
        /streamer:\s*primaryCreatorName\s*\|\|\s*pickName\(s\.streamer\)\s*\|\|\s*"FaceTube Creator"/,
      );
      assert.match(
        liveRouteSrc,
        /streamerHandle:\s*`@\$\{\(primaryCreatorName\s*\|\|\s*"creator"\)/,
      );
      assert.match(liveRouteSrc, /initials:\s*\(primaryCreatorName\s*\|\|\s*"FT"\)/);
    });
  });

  describe("7. Task 5J-N: Live POST/Heartbeat/End-Stream/Webhook Production Fail-Closed Guards", () => {
    const envKeys = ["NODE_ENV", "APP_ENV", "DB_HOST", "DB_NAME", "DB_USER"] as const;
    let envSnapshot: Record<string, string | undefined> = {};
    let suiteStoreSnapshot: string | null = null;
    let suiteStoreExisted = false;

    function createValidWebhookJwt(rawBody: string, secret: string) {
      const header = { alg: "HS256", typ: "JWT" };
      const bodyHash = crypto.createHash("sha256").update(rawBody).digest("base64");
      const payload = {
        iss: "test-api-key",
        sha256: bodyHash,
        iat: Math.floor(Date.now() / 1000),
      };
      const b64Url = (obj: any) =>
        Buffer.from(JSON.stringify(obj))
          .toString("base64")
          .replace(/=/g, "")
          .replace(/\+/g, "-")
          .replace(/\//g, "_");
      const headerB64 = b64Url(header);
      const payloadB64 = b64Url(payload);
      const sigInput = `${headerB64}.${payloadB64}`;
      const sig = crypto
        .createHmac("sha256", secret)
        .update(sigInput)
        .digest("base64")
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
      return `${sigInput}.${sig}`;
    }

    beforeEach(() => {
      envSnapshot = {};
      for (const k of envKeys) {
        envSnapshot[k] = process.env[k];
      }
      suiteStoreExisted = fs.existsSync(storePath);
      suiteStoreSnapshot = suiteStoreExisted ? fs.readFileSync(storePath, "utf-8") : null;
      setMysqlPoolForTesting(null);
      resetInMemoryStore();
    });

    afterEach(() => {
      setMysqlPoolForTesting(null);
      for (const k of envKeys) {
        if (envSnapshot[k] !== undefined) {
          process.env[k] = envSnapshot[k];
        } else {
          delete process.env[k];
        }
      }
      if (suiteStoreExisted && suiteStoreSnapshot !== null) {
        fs.writeFileSync(storePath, suiteStoreSnapshot, "utf-8");
      } else if (!suiteStoreExisted && fs.existsSync(storePath)) {
        fs.unlinkSync(storePath);
      }
      resetInMemoryStore();
    });

    it("returns HTTP 503 for live/heartbeat, live/end-stream, and live/webhook when APP_ENV=production and NODE_ENV is unset without MySQL pool", async () => {
      process.env["APP_ENV"] = "production";
      delete process.env["NODE_ENV"];
      delete process.env["DB_HOST"];
      setMysqlPoolForTesting(null);

      const hbRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/heartbeat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({ streamId: testStreamId, role: "broadcaster" }),
        }),
      );
      assert.equal(hbRes?.status, 503);

      const endRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/end-stream", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({ streamId: testStreamId }),
        }),
      );
      assert.equal(endRes?.status, 503);

      const whBody = JSON.stringify({ id: "EV_503", event: "participant_joined" });
      const whRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${createValidWebhookJwt(whBody, testApiSecret)}`,
          },
          body: whBody,
        }),
      );
      assert.equal(whRes?.status, 503);
    });

    it("returns HTTP 500 on production MySQL INSERT failure for POST /api/live/streams without persisting to store.liveStreams", async () => {
      process.env["APP_ENV"] = "production";
      delete process.env["NODE_ENV"];
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";

      const beforeStore = suiteStoreSnapshot ? JSON.parse(suiteStoreSnapshot) : {};
      const initialCount = Array.isArray(beforeStore.liveStreams)
        ? beforeStore.liveStreams.length
        : 0;

      setMysqlPoolForTesting({
        query: async (sql: string) => {
          if (/INSERT\s+INTO\s+live_streams/i.test(sql)) {
            throw new Error("Simulated MySQL INSERT failure");
          }
          return [[], []];
        },
      } as any);

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/streams", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({ title: "Should Fail 500 In Prod" }),
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 500);
      const data = (await res.json()) as any;
      assert.equal(data.success, false);
      assert.equal(data.stream, undefined);

      const afterStore = JSON.parse(fs.readFileSync(storePath, "utf-8"));
      assert.equal(afterStore.liveStreams?.length ?? 0, initialCount);
      assert.equal(
        (afterStore.liveStreams || []).some((s: any) => s.title === "Should Fail 500 In Prod"),
        false,
      );
    });

    it("returns HTTP 500 in production on MySQL failures for heartbeat, end-stream, and webhook while preserving webhook signature & ownership checks", async () => {
      process.env["APP_ENV"] = "production";
      delete process.env["NODE_ENV"];
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";

      const prodStreamRow = {
        id: "live_prod_01",
        user_id: "FT483921",
        title: "Prod Live Stream",
        status: "live",
        viewers_count: 5,
        livekit_room_name: "room_live_prod_01",
      };

      // 1. Failing SELECT -> 500 on heartbeat & end-stream (no JSON fallback even when testStreamId exists in store)
      setMysqlPoolForTesting({
        query: async (sql: string) => {
          if (/FROM\s+live_streams/i.test(sql)) {
            throw new Error("Simulated MySQL SELECT error");
          }
          return [[], []];
        },
      } as any);

      const hbSelectErr = await handleApiRequest(
        new Request("http://localhost:3000/api/live/heartbeat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({ streamId: testStreamId, role: "broadcaster" }),
        }),
      );
      assert.equal(hbSelectErr?.status, 500);

      const endSelectErr = await handleApiRequest(
        new Request("http://localhost:3000/api/live/end-stream", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({ streamId: testStreamId }),
        }),
      );
      assert.equal(endSelectErr?.status, 500);

      // 2. Failing UPDATE -> 500 on heartbeat & end-stream, while non-owner still gets 403
      setMysqlPoolForTesting({
        query: async (sql: string) => {
          if (/FROM\s+live_streams/i.test(sql)) {
            return [[prodStreamRow], []];
          }
          if (/UPDATE\s+live_streams/i.test(sql)) {
            throw new Error("Simulated MySQL UPDATE error");
          }
          return [[], []];
        },
      } as any);

      const hbForbidden = await handleApiRequest(
        new Request("http://localhost:3000/api/live/heartbeat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${viewerToken}`,
          },
          body: JSON.stringify({ streamId: "live_prod_01", role: "broadcaster" }),
        }),
      );
      assert.equal(hbForbidden?.status, 403);

      const hbUpdateErr = await handleApiRequest(
        new Request("http://localhost:3000/api/live/heartbeat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({ streamId: "live_prod_01", role: "broadcaster" }),
        }),
      );
      assert.equal(hbUpdateErr?.status, 500);

      const endUpdateErr = await handleApiRequest(
        new Request("http://localhost:3000/api/live/end-stream", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({ streamId: "live_prod_01" }),
        }),
      );
      assert.equal(endUpdateErr?.status, 500);

      // 3. Webhook preserves 401 on invalid signature in production and returns 500 on MySQL error without writing store
      const whPayload = JSON.stringify({
        id: "EV_PROD_FAIL_01",
        event: "participant_joined",
        room: { name: "room_live_prod_01", numParticipants: 3 },
      });
      const invalidSigRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${createValidWebhookJwt(whPayload, "wrong-secret")}`,
          },
          body: whPayload,
        }),
      );
      assert.equal(invalidSigRes?.status, 401);

      const validWhRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${createValidWebhookJwt(whPayload, testApiSecret)}`,
          },
          body: whPayload,
        }),
      );
      assert.equal(validWhRes?.status, 500);

      const afterStore = JSON.parse(fs.readFileSync(storePath, "utf-8"));
      assert.equal(Boolean(afterStore.livekitWebhookEvents?.["EV_PROD_FAIL_01"]), false);
    });

    it("preserves non-production JSON fallback for live/streams POST, heartbeat, end-stream, and webhook", async () => {
      process.env["NODE_ENV"] = "test";
      delete process.env["APP_ENV"];
      delete process.env["DB_HOST"];
      setMysqlPoolForTesting(null);

      const createRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/streams", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({ title: "Non-Prod Fallback Stream" }),
        }),
      );
      assert.equal(createRes?.status, 201);
      const created = (await createRes!.json()) as any;
      const newId = created.stream.id;

      const hbRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/heartbeat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({ streamId: newId, role: "broadcaster" }),
        }),
      );
      assert.equal(hbRes?.status, 200);

      const whBody = JSON.stringify({
        id: `EV_NONPROD_${newId}`,
        event: "participant_joined",
        room: { name: `room_${newId}`, numParticipants: 4 },
      });
      const whRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${createValidWebhookJwt(whBody, testApiSecret)}`,
          },
          body: whBody,
        }),
      );
      assert.equal(whRes?.status, 200);

      const endRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/end-stream", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({ streamId: newId }),
        }),
      );
      assert.equal(endRes?.status, 200);
      const endData = (await endRes!.json()) as any;
      assert.equal(endData.stream.status, "ended");
    });
  });
});
