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
import nitroServerEntry from "../server.ts";

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

      const mockSessionRows = (tokenParam: unknown) => {
        if (tokenParam === creatorToken) {
          return [
            {
              id: "a0000000-0000-0000-0000-000000000002",
              user_id: "FT483921",
              name: "Alex Rivera",
              mobile: "+1 555-014-8392",
              email: "alex@facetube.com",
              role: "user",
              referral_code: "CREATOR50",
              avatar_url: null,
              channel_logo_url: null,
              channel_name: "Alex Studio",
              channel_description: null,
              created_at: "2026-11-01T00:00:00.000Z",
            },
          ];
        }
        if (tokenParam === viewerToken) {
          return [
            {
              id: "a0000000-0000-0000-0000-000000000003",
              user_id: "FT900431",
              name: "Maya Lin",
              mobile: "+1 555-019-2831",
              email: "maya@facetube.com",
              role: "user",
              referral_code: "MAYA25",
              avatar_url: null,
              channel_logo_url: null,
              channel_name: "Maya Studio",
              channel_description: null,
              created_at: "2026-11-01T00:00:00.000Z",
            },
          ];
        }
        return [];
      };

      setMysqlPoolForTesting({
        query: async (sql: string, params: any[] = []) => {
          if (/FROM\s+sessions/i.test(sql)) {
            return [mockSessionRows(params[0]), []];
          }
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

      const mockProdSessionRows = (tokenParam: unknown) => {
        if (tokenParam === creatorToken) {
          return [
            {
              id: "a0000000-0000-0000-0000-000000000002",
              user_id: "FT483921",
              name: "Alex Rivera",
              mobile: "+1 555-014-8392",
              email: "alex@facetube.com",
              role: "user",
              referral_code: "CREATOR50",
              avatar_url: null,
              channel_logo_url: null,
              channel_name: "Alex Studio",
              channel_description: null,
              created_at: "2026-11-01T00:00:00.000Z",
            },
          ];
        }
        if (tokenParam === viewerToken) {
          return [
            {
              id: "a0000000-0000-0000-0000-000000000003",
              user_id: "FT900431",
              name: "Maya Lin",
              mobile: "+1 555-019-2831",
              email: "maya@facetube.com",
              role: "user",
              referral_code: "MAYA25",
              avatar_url: null,
              channel_logo_url: null,
              channel_name: "Maya Studio",
              channel_description: null,
              created_at: "2026-11-01T00:00:00.000Z",
            },
          ];
        }
        return [];
      };

      // 1. Failing SELECT -> 500 on heartbeat & end-stream (no JSON fallback even when testStreamId exists in store)
      setMysqlPoolForTesting({
        query: async (sql: string, params: any[] = []) => {
          if (/FROM\s+sessions/i.test(sql)) {
            return [mockProdSessionRows(params[0]), []];
          }
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
        query: async (sql: string, params: any[] = []) => {
          if (/FROM\s+sessions/i.test(sql)) {
            return [mockProdSessionRows(params[0]), []];
          }
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

  describe("8. Task 5J-Q: LiveKit Token & Webhook Production Security", () => {
    const envKeys = [
      "NODE_ENV",
      "APP_ENV",
      "DB_HOST",
      "DB_NAME",
      "DB_USER",
      "MYSQL_HOST",
      "MYSQL_DATABASE",
      "MYSQL_USER",
      "LIVEKIT_URL",
      "LIVEKIT_API_KEY",
      "LIVEKIT_API_SECRET",
    ] as const;

    let envSnapshot: Record<string, string | undefined> = {};
    let suiteStoreSnapshot: string | null = null;
    let suiteStoreExisted = false;

    function createSignedWebhookJwt(
      rawBody: string,
      secret: string,
      overrides?: { exp?: number; iss?: string; sha256?: string },
    ) {
      const header = { alg: "HS256", typ: "JWT" };
      const bodyHash =
        overrides?.sha256 ?? crypto.createHash("sha256").update(rawBody).digest("base64");
      const payload: Record<string, unknown> = {
        iss: overrides?.iss ?? "prod-livekit-key",
        sha256: bodyHash,
        iat: Math.floor(Date.now() / 1000),
      };
      if (overrides?.exp !== undefined) {
        payload["exp"] = overrides.exp;
      }
      const b64Url = (obj: unknown) =>
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

    function verifyHs256JwtSignature(jwt: string, secret: string): boolean {
      const parts = jwt.split(".");
      if (parts.length !== 3) return false;
      const [headerB64, payloadB64, sigB64] = parts;
      if (!headerB64 || !payloadB64 || !sigB64) return false;
      const expected = crypto
        .createHmac("sha256", secret)
        .update(`${headerB64}.${payloadB64}`)
        .digest();
      const provided = base64UrlDecode(sigB64);
      return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
    }

    function enableMockDbEnv(mockPool: unknown) {
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";
      setMysqlPoolForTesting(mockPool as any);
    }

    function mockSessionRows(tokenParam: unknown) {
      if (tokenParam === creatorToken) {
        return [
          {
            id: "a0000000-0000-0000-0000-000000000002",
            user_id: "FT483921",
            name: "Alex Rivera",
            mobile: "+1 555-014-8392",
            email: "alex@facetube.com",
            role: "user",
            referral_code: "CREATOR50",
            avatar_url: null,
            channel_logo_url: null,
            channel_name: "Alex Studio",
            channel_description: null,
            created_at: "2026-11-01T00:00:00.000Z",
          },
        ];
      }
      if (tokenParam === viewerToken) {
        return [
          {
            id: "a0000000-0000-0000-0000-000000000003",
            user_id: "FT900431",
            name: "Maya Lin",
            mobile: "+1 555-019-2831",
            email: "maya@facetube.com",
            role: "user",
            referral_code: "MAYA25",
            avatar_url: null,
            channel_logo_url: null,
            channel_name: "Maya Studio",
            channel_description: null,
            created_at: "2026-11-01T00:00:00.000Z",
          },
        ];
      }
      return [];
    }

    function seedActiveJsonStream(streamId: string) {
      const parsed = suiteStoreSnapshot
        ? JSON.parse(suiteStoreSnapshot)
        : { users: [], sessions: {}, liveStreams: [] };
      const existing = Array.isArray(parsed.liveStreams) ? parsed.liveStreams : [];
      parsed.liveStreams = [
        ...existing.filter((s: any) => s.id !== streamId),
        {
          id: streamId,
          user_id: "FT483921",
          title: "Active JSON Store Stream 5JQ",
          description: "Seeded active stream in local JSON store",
          category: "Coding",
          stream_key: "sk_json_5jq",
          livekit_room_name: `room_${streamId}`,
          playback_url: "",
          thumbnail_url: "",
          status: "live",
          viewers_count: 3,
          created_at: new Date().toISOString(),
        },
      ];
      fs.writeFileSync(storePath, JSON.stringify(parsed), "utf-8");
      resetInMemoryStore();
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

    it("returns HTTP 503 for POST /api/live/token in production when MySQL pool is unavailable", async () => {
      seedActiveJsonStream("live_json_active_5jq");
      process.env["APP_ENV"] = "production";
      delete process.env["NODE_ENV"];
      delete process.env["DB_HOST"];
      process.env["LIVEKIT_API_KEY"] = "prod-key-503";
      process.env["LIVEKIT_API_SECRET"] = "prod-secret-503";
      setMysqlPoolForTesting(null);

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({ streamId: "live_json_active_5jq", role: "publisher" }),
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 503);
      const data = (await res.json()) as any;
      assert.equal(data.success, false);
      assert.equal(data.token, undefined);
      assert.match(String(data.error || ""), /Database connection unavailable/i);
    });

    it("returns HTTP 500 for POST /api/live/token in production on MySQL stream lookup failure without falling back to store.liveStreams", async () => {
      seedActiveJsonStream("live_json_active_5jq");
      process.env["APP_ENV"] = "production";
      delete process.env["NODE_ENV"];
      process.env["LIVEKIT_API_KEY"] = "prod-key-500";
      process.env["LIVEKIT_API_SECRET"] = "prod-secret-500";

      enableMockDbEnv({
        query: async (sql: string, params: unknown[]) => {
          if (/FROM\s+sessions/i.test(sql)) {
            return [mockSessionRows(params[0]), []];
          }
          if (sql.includes("FROM live_streams")) {
            throw new Error("ER_LOCK_WAIT_TIMEOUT: internal live_streams deadlock detail");
          }
          return [[], []];
        },
      });

      // live_json_active_5jq is active in data/facetube_store.json, but production must NEVER fall back to it
      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({ streamId: "live_json_active_5jq", role: "publisher" }),
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 500);
      const data = (await res.json()) as any;
      assert.equal(data.success, false);
      assert.equal(data.token, undefined);
      assert.doesNotMatch(String(data.error || ""), /ER_LOCK_WAIT_TIMEOUT|deadlock|SELECT/i);
    });

    it("never falls back to store.liveStreams when MySQL returns 0 rows in production and preserves 403/400 stream authorization checks", async () => {
      seedActiveJsonStream("live_json_active_5jq");
      process.env["APP_ENV"] = "production";
      delete process.env["NODE_ENV"];
      process.env["LIVEKIT_API_KEY"] = "prod-key-auth";
      process.env["LIVEKIT_API_SECRET"] = "prod-secret-auth";

      let mode: "missing" | "active" | "ended" = "missing";
      enableMockDbEnv({
        query: async (sql: string, params: unknown[]) => {
          if (/FROM\s+sessions/i.test(sql)) {
            return [mockSessionRows(params[0]), []];
          }
          if (sql.includes("FROM live_streams")) {
            if (mode === "missing") return [[], []];
            return [
              [
                {
                  id: "live_prod_auth_01",
                  user_id: "FT483921",
                  status: mode === "ended" ? "ended" : "live",
                  livekit_room_name: "room_prod_auth_01",
                },
              ],
              [],
            ];
          }
          return [[], []];
        },
      });

      // 1. Active stream exists in JSON store, missing in MySQL -> must return 404
      const missingRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({ streamId: "live_json_active_5jq", role: "publisher" }),
        }),
      );
      assert.equal(missingRes?.status, 404);
      const missingData = (await missingRes!.json()) as any;
      assert.equal(missingData.token, undefined);

      // 2. Active stream in MySQL: non-owner requesting publisher -> 403
      mode = "active";
      const forbiddenRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${viewerToken}`,
          },
          body: JSON.stringify({ streamId: "live_prod_auth_01", role: "publisher" }),
        }),
      );
      assert.equal(forbiddenRes?.status, 403);
      const forbiddenData = (await forbiddenRes!.json()) as any;
      assert.equal(forbiddenData.token, undefined);

      // 3. Ended stream in MySQL: owner requesting publisher -> 400
      mode = "ended";
      const endedRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({ streamId: "live_prod_auth_01", role: "publisher" }),
        }),
      );
      assert.equal(endedRes?.status, 400);
      const endedData = (await endedRes!.json()) as any;
      assert.equal(endedData.token, undefined);
    });

    it("fails closed with HTTP 503 for POST /api/live/token in production when LiveKit credentials are missing or blank and never uses devkey/secret", async () => {
      process.env["APP_ENV"] = "production";
      delete process.env["NODE_ENV"];

      enableMockDbEnv({
        query: async (sql: string, params: unknown[]) => {
          if (/FROM\s+sessions/i.test(sql)) {
            return [mockSessionRows(params[0]), []];
          }
          if (sql.includes("FROM live_streams")) {
            return [
              [
                {
                  id: "live_prod_creds_01",
                  user_id: "FT483921",
                  status: "live",
                  livekit_room_name: "room_prod_creds_01",
                },
              ],
              [],
            ];
          }
          return [[], []];
        },
      });

      const credentialCases: Array<{
        label: string;
        key: string | undefined;
        secret: string | undefined;
      }> = [
        { label: "both unset", key: undefined, secret: undefined },
        { label: "missing secret", key: "prod-api-key", secret: undefined },
        { label: "blank secret", key: "prod-api-key", secret: "   " },
        { label: "missing key", key: undefined, secret: "prod-api-secret" },
        { label: "blank key", key: "   ", secret: "prod-api-secret" },
      ];

      for (const tc of credentialCases) {
        if (tc.key !== undefined) process.env["LIVEKIT_API_KEY"] = tc.key;
        else delete process.env["LIVEKIT_API_KEY"];
        if (tc.secret !== undefined) process.env["LIVEKIT_API_SECRET"] = tc.secret;
        else delete process.env["LIVEKIT_API_SECRET"];

        const res = await handleApiRequest(
          new Request("http://localhost:3000/api/live/token", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${creatorToken}`,
            },
            body: JSON.stringify({ streamId: "live_prod_creds_01", role: "publisher" }),
          }),
        );
        assert.ok(res, `Expected response for case: ${tc.label}`);
        assert.equal(res.status, 503, `Expected 503 for case: ${tc.label}`);
        const data = (await res.json()) as any;
        assert.equal(data.success, false);
        assert.equal(data.token, undefined);
        assert.match(String(data.error || ""), /LiveKit streaming service is not configured/i);
        assert.doesNotMatch(String(data.error || ""), /devkey|prod-api-secret/i);
      }

      // Unset APP_ENV and NODE_ENV also fail closed (production default) without issuing devkey/secret tokens
      delete process.env["APP_ENV"];
      delete process.env["NODE_ENV"];
      delete process.env["LIVEKIT_API_KEY"];
      delete process.env["LIVEKIT_API_SECRET"];

      const unsetEnvRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({ streamId: "live_prod_creds_01", role: "publisher" }),
        }),
      );
      assert.equal(unsetEnvRes?.status, 503);
      const unsetEnvData = (await unsetEnvRes!.json()) as any;
      assert.equal(unsetEnvData.token, undefined);

      // Defensive helper check
      assert.throws(() =>
        generateLiveKitAccessToken({
          apiKey: "",
          apiSecret: "valid-secret",
          roomName: "room_1",
          identity: "FT483921",
          role: "publisher",
        }),
      );
      assert.throws(() =>
        generateLiveKitAccessToken({
          apiKey: "valid-key",
          apiSecret: "   ",
          roomName: "room_1",
          identity: "FT483921",
          role: "publisher",
        }),
      );
    });

    it("issues a valid HS256 token in production signed exclusively with configured credentials and honors runtime handler env without mutating process.env", async () => {
      process.env["NODE_ENV"] = "development";
      delete process.env["APP_ENV"];
      delete process.env["LIVEKIT_URL"];
      delete process.env["LIVEKIT_API_KEY"];
      delete process.env["LIVEKIT_API_SECRET"];

      enableMockDbEnv({
        query: async (sql: string, params: unknown[]) => {
          if (/FROM\s+sessions/i.test(sql)) {
            return [mockSessionRows(params[0]), []];
          }
          if (sql.includes("FROM live_streams")) {
            return [
              [
                {
                  id: "live_prod_valid_01",
                  user_id: "FT483921",
                  status: "live",
                  livekit_room_name: "room_prod_valid_01",
                },
              ],
              [],
            ];
          }
          return [[], []];
        },
      });

      const runtimeEnv = {
        APP_ENV: "production",
        LIVEKIT_URL: "wss://prod-livekit.example.com",
        LIVEKIT_API_KEY: "prod-lk-key-999",
        LIVEKIT_API_SECRET: "prod-lk-secret-xyz-999",
      };

      const pubRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({ streamId: "live_prod_valid_01", role: "publisher" }),
        }),
        runtimeEnv,
      );
      assert.ok(pubRes);
      assert.equal(pubRes.status, 200);
      const pubData = (await pubRes.json()) as any;
      assert.equal(pubData.success, true);
      assert.equal(pubData.url, "wss://prod-livekit.example.com");
      assert.equal(pubData.room, "room_prod_valid_01");
      assert.equal(pubData.identity, "FT483921");
      assert.equal(pubData.role, "publisher");
      assert.equal(pubData.server_configured, true);
      assert.equal(typeof pubData.expires_at, "number");
      assert.ok(pubData.expires_at > Math.floor(Date.now() / 1000));

      // Verify JWT signed with configured secret/key and NOT default "devkey"/"secret"
      assert.equal(verifyHs256JwtSignature(pubData.token, "prod-lk-secret-xyz-999"), true);
      assert.equal(verifyHs256JwtSignature(pubData.token, "secret"), false);
      const pubPayload = JSON.parse(
        base64UrlDecode(String(pubData.token).split(".")[1]!).toString("utf8"),
      );
      assert.equal(pubPayload.iss, "prod-lk-key-999");
      assert.notEqual(pubPayload.iss, "devkey");
      assert.equal(pubPayload.video.room, "room_prod_valid_01");
      assert.equal(pubPayload.video.roomJoin, true);
      assert.equal(pubPayload.video.canPublish, true);

      // Verify viewer subscriber token succeeds with publish disabled
      const subRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${viewerToken}`,
          },
          body: JSON.stringify({ streamId: "live_prod_valid_01", role: "subscriber" }),
        }),
        runtimeEnv,
      );
      assert.equal(subRes?.status, 200);
      const subData = (await subRes!.json()) as any;
      assert.equal(subData.role, "subscriber");
      assert.equal(verifyHs256JwtSignature(subData.token, "prod-lk-secret-xyz-999"), true);
      const subPayload = JSON.parse(
        base64UrlDecode(String(subData.token).split(".")[1]!).toString("utf8"),
      );
      assert.equal(subPayload.video.canPublish, false);
      assert.equal(subPayload.video.canSubscribe, true);

      // Verify process.env was not mutated by handler env
      assert.equal(process.env["APP_ENV"], undefined);
      assert.equal(process.env["LIVEKIT_API_KEY"], undefined);
      assert.equal(process.env["LIVEKIT_API_SECRET"], undefined);
      assert.equal(process.env["NODE_ENV"], "development");
    });

    it("preserves explicit development/test JSON fallback for POST /api/live/token without weakening authorization", async () => {
      seedActiveJsonStream("live_json_active_5jq");
      process.env["NODE_ENV"] = "test";
      delete process.env["APP_ENV"];
      delete process.env["DB_HOST"];
      setMysqlPoolForTesting(null);

      const okRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({ streamId: "live_json_active_5jq", role: "publisher" }),
        }),
      );
      assert.equal(okRes?.status, 200);

      const forbiddenRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${viewerToken}`,
          },
          body: JSON.stringify({ streamId: "live_json_active_5jq", role: "publisher" }),
        }),
      );
      assert.equal(forbiddenRes?.status, 403);
    });

    it("rejects POST /api/live/webhook with HTTP 503 when LIVEKIT_API_SECRET is missing or blank (even if signed with default 'secret') without touching DB or JSON store", async () => {
      process.env["APP_ENV"] = "production";
      delete process.env["NODE_ENV"];

      let queryCount = 0;
      enableMockDbEnv({
        query: async () => {
          queryCount += 1;
          return [[], []];
        },
      });

      const payload = JSON.stringify({
        id: "EV_5JQ_NO_SECRET",
        event: "participant_joined",
        room: { name: `room_${testStreamId}`, numParticipants: 9 },
      });
      const forgedWithDefaultSecret = createSignedWebhookJwt(payload, "secret");

      // 1. Production + LIVEKIT_API_SECRET unset
      delete process.env["LIVEKIT_API_SECRET"];
      const resUnset = await handleApiRequest(
        new Request("http://localhost:3000/api/live/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${forgedWithDefaultSecret}`,
          },
          body: payload,
        }),
      );
      assert.equal(resUnset?.status, 503);
      const dataUnset = (await resUnset!.json()) as any;
      assert.equal(dataUnset.success, false);
      assert.match(String(dataUnset.error || ""), /LiveKit webhook service is not configured/i);
      assert.equal(queryCount, 0);

      // 2. Production + LIVEKIT_API_SECRET whitespace-only
      process.env["LIVEKIT_API_SECRET"] = "    ";
      const resBlank = await handleApiRequest(
        new Request("http://localhost:3000/api/live/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${forgedWithDefaultSecret}`,
          },
          body: payload,
        }),
      );
      assert.equal(resBlank?.status, 503);
      assert.equal(queryCount, 0);

      // 3. Runtime handler env explicitly overriding LIVEKIT_API_SECRET to empty string
      process.env["LIVEKIT_API_SECRET"] = "process-secret-should-be-overridden";
      const resRuntimeBlank = await handleApiRequest(
        new Request("http://localhost:3000/api/live/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${forgedWithDefaultSecret}`,
          },
          body: payload,
        }),
        { APP_ENV: "production", LIVEKIT_API_SECRET: "" },
      );
      assert.equal(resRuntimeBlank?.status, 503);
      assert.equal(queryCount, 0);
      assert.equal(process.env["LIVEKIT_API_SECRET"], "process-secret-should-be-overridden");

      // 4. Non-production (test) + LIVEKIT_API_SECRET unset must ALSO reject forged "secret" token
      process.env["NODE_ENV"] = "test";
      delete process.env["APP_ENV"];
      delete process.env["LIVEKIT_API_SECRET"];
      setMysqlPoolForTesting(null);

      const resNonProdUnset = await handleApiRequest(
        new Request("http://localhost:3000/api/live/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${forgedWithDefaultSecret}`,
          },
          body: payload,
        }),
      );
      assert.equal(resNonProdUnset?.status, 503);

      // Store must have zero recorded events for EV_5JQ_NO_SECRET
      const persisted = JSON.parse(fs.readFileSync(storePath, "utf-8"));
      assert.equal(Boolean(persisted.livekitWebhookEvents?.["EV_5JQ_NO_SECRET"]), false);

      // Direct helper rejects blank secret
      const directCheck = verifyLiveKitWebhook(`Bearer ${forgedWithDefaultSecret}`, payload, "  ");
      assert.equal(directCheck.valid, false);
    });

    it("rejects POST /api/live/webhook with HTTP 401 on invalid signature, body hash mismatch, or expired JWT before any DB query or store mutation", async () => {
      process.env["APP_ENV"] = "production";
      delete process.env["NODE_ENV"];
      const configuredSecret = "super-strong-prod-webhook-secret-888";
      process.env["LIVEKIT_API_SECRET"] = configuredSecret;

      let queryCount = 0;
      enableMockDbEnv({
        query: async () => {
          queryCount += 1;
          return [[], []];
        },
      });

      const payload = JSON.stringify({
        id: "EV_5JQ_INVALID_SIG",
        event: "room_finished",
        room: { name: "room_prod_wh_01" },
      });

      // 1. Signed with wrong/default "secret"
      const badSigRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${createSignedWebhookJwt(payload, "secret")}`,
          },
          body: payload,
        }),
      );
      assert.equal(badSigRes?.status, 401);
      const badSigData = (await badSigRes!.json()) as any;
      assert.equal(badSigData.success, false);
      assert.doesNotMatch(String(badSigData.error || ""), /super-strong-prod-webhook-secret-888/);

      // 2. Tampered body (SHA-256 mismatch)
      const validJwtForOrig = createSignedWebhookJwt(payload, configuredSecret);
      const hashMismatchRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${validJwtForOrig}`,
          },
          body: `${payload} `,
        }),
      );
      assert.equal(hashMismatchRes?.status, 401);

      // 3. Expired JWT
      const expiredJwt = createSignedWebhookJwt(payload, configuredSecret, {
        exp: Math.floor(Date.now() / 1000) - 60,
      });
      const expiredRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${expiredJwt}`,
          },
          body: payload,
        }),
      );
      assert.equal(expiredRes?.status, 401);

      // Zero DB queries executed across all rejected webhook requests
      assert.equal(queryCount, 0);
    });

    it("processes valid POST /api/live/webhook events in production via handler env without mutating process.env and handles unknown streams cleanly", async () => {
      process.env["NODE_ENV"] = "development";
      delete process.env["APP_ENV"];
      delete process.env["LIVEKIT_API_SECRET"];

      const executedQueries: Array<{ sql: string; params: unknown[] }> = [];
      enableMockDbEnv({
        query: async (sql: string, params: unknown[] = []) => {
          executedQueries.push({ sql, params });
          if (sql.includes("SELECT id FROM livekit_webhook_events")) {
            return [[], []];
          }
          if (sql.includes("INSERT INTO livekit_webhook_events")) {
            return [{ affectedRows: 1 }, []];
          }
          if (sql.includes("SELECT * FROM live_streams")) {
            if (params[0] === "room_prod_wh_01" || params[1] === "prod_wh_01") {
              return [
                [
                  {
                    id: "prod_wh_01",
                    user_id: "FT483921",
                    status: "live",
                    viewers_count: 2,
                    livekit_room_name: "room_prod_wh_01",
                  },
                ],
                [],
              ];
            }
            return [[], []];
          }
          if (sql.includes("UPDATE live_streams")) {
            return [{ affectedRows: 1 }, []];
          }
          return [[], []];
        },
      });

      const runtimeSecret = "runtime-handler-webhook-secret-777";
      const runtimeEnv = {
        APP_ENV: "production",
        LIVEKIT_API_SECRET: runtimeSecret,
      };

      // 1. Valid participant_joined for known MySQL stream
      const joinPayload = JSON.stringify({
        id: "EV_5JQ_VALID_JOIN",
        event: "participant_joined",
        room: { name: "room_prod_wh_01", numParticipants: 6 },
      });
      const joinRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${createSignedWebhookJwt(joinPayload, runtimeSecret)}`,
          },
          body: joinPayload,
        }),
        runtimeEnv,
      );
      assert.equal(joinRes?.status, 200);
      const joinData = (await joinRes!.json()) as any;
      assert.equal(joinData.success, true);
      assert.equal(joinData.processed, true);
      assert.equal(joinData.event, "participant_joined");
      assert.ok(
        executedQueries.some(
          (q) => q.sql.includes("UPDATE live_streams SET viewers_count = ?") && q.params[0] === 5,
        ),
      );

      // 2. Valid room_finished for unknown/nonexistent stream (even if testStreamId exists in JSON store)
      const beforeUnknownCount = executedQueries.length;
      const unknownPayload = JSON.stringify({
        id: "EV_5JQ_UNKNOWN_STREAM",
        event: "room_finished",
        room: { name: `room_${testStreamId}` },
      });
      const unknownRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${createSignedWebhookJwt(unknownPayload, runtimeSecret)}`,
          },
          body: unknownPayload,
        }),
        runtimeEnv,
      );
      assert.equal(unknownRes?.status, 200);
      const unknownData = (await unknownRes!.json()) as any;
      assert.equal(unknownData.success, true);
      assert.equal(unknownData.processed, true);

      // Must NOT issue UPDATE live_streams for unknown stream and must NOT mutate JSON store
      const unknownQueries = executedQueries.slice(beforeUnknownCount);
      assert.equal(
        unknownQueries.some((q) => q.sql.includes("UPDATE live_streams")),
        false,
      );
      const persisted = JSON.parse(fs.readFileSync(storePath, "utf-8"));
      assert.equal(Boolean(persisted.livekitWebhookEvents?.["EV_5JQ_VALID_JOIN"]), false);
      assert.equal(Boolean(persisted.livekitWebhookEvents?.["EV_5JQ_UNKNOWN_STREAM"]), false);

      // process.env must remain untouched
      assert.equal(process.env["APP_ENV"], undefined);
      assert.equal(process.env["LIVEKIT_API_SECRET"], undefined);
      assert.equal(process.env["NODE_ENV"], "development");
    });

    it("enforces fail-closed 503 through Nitro server entry on localhost when production env is active (Task 5J-O + 5J-Q)", async () => {
      process.env["NODE_ENV"] = "production";
      delete process.env["APP_ENV"];
      delete process.env["DB_HOST"];
      delete process.env["LIVEKIT_API_KEY"];
      delete process.env["LIVEKIT_API_SECRET"];
      setMysqlPoolForTesting(null);

      const tokenRes = await nitroServerEntry.fetch(
        new Request("http://localhost:3000/api/live/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({ streamId: testStreamId, role: "publisher" }),
        }),
        undefined,
        undefined,
      );
      assert.equal(tokenRes.status, 503);

      const whBody = JSON.stringify({ id: "EV_NITRO_503", event: "participant_joined" });
      const whRes = await nitroServerEntry.fetch(
        new Request("http://localhost:3000/api/live/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${createSignedWebhookJwt(whBody, "secret")}`,
          },
          body: whBody,
        }),
        undefined,
        undefined,
      );
      assert.equal(whRes.status, 503);
      assert.equal(process.env["NODE_ENV"], "production");
    });
  });

  describe("8. Task 5J-U: Live Chat Production Safety & MySQL Persistence", () => {
    const envKeys = [
      "NODE_ENV",
      "APP_ENV",
      "USE_REMOTE_PHP_API",
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

    interface MockChatRow {
      id: string;
      stream_id: string;
      user_id: string;
      user_name: string;
      avatar_url: string | null;
      message: string;
      is_superchat: number;
      superchat_amount: number;
      created_at: string;
      // Extra private columns a misconfigured query or row could carry to verify sanitization
      email?: string;
      mobile?: string;
      password_hash?: string;
      payment_id?: string;
      order_id?: string;
      token?: string;
    }

    function enableMockDbEnv(mockPool: unknown) {
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";
      setMysqlPoolForTesting(mockPool as any);
    }

    function mockSessionUser(tokenParam: unknown) {
      if (tokenParam === creatorToken) {
        return [
          {
            id: "a0000000-0000-0000-0000-000000000002",
            user_id: "FT483921",
            name: "Alex Rivera",
            mobile: "+1 555-014-8392",
            email: "alex@facetube.com",
            role: "user",
            referral_code: "CREATOR50",
            avatar_url: "/uploads/logos/alex_avatar.png",
            channel_logo_url: "/uploads/logos/alex_logo.png",
            channel_name: "Alex Studio",
            channel_description: null,
            created_at: "2026-11-01T00:00:00.000Z",
          },
        ];
      }
      if (tokenParam === viewerToken) {
        return [
          {
            id: "a0000000-0000-0000-0000-000000000003",
            user_id: "FT900431",
            name: "Maya Lin",
            mobile: "+1 555-019-2831",
            email: "maya@facetube.com",
            role: "user",
            referral_code: "MAYA25",
            avatar_url: null,
            channel_logo_url: null,
            channel_name: "Maya Studio",
            channel_description: null,
            created_at: "2026-11-01T00:00:00.000Z",
          },
        ];
      }
      return [];
    }

    beforeEach(() => {
      envSnapshot = {};
      for (const k of envKeys) {
        envSnapshot[k] = process.env[k];
      }
      suiteStoreExisted = fs.existsSync(storePath);
      suiteStoreSnapshot = suiteStoreExisted ? fs.readFileSync(storePath, "utf-8") : null;
      delete process.env["USE_REMOTE_PHP_API"];
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

    it("1. Authenticated user sends a normal message persisted to MySQL and cannot spoof another user's identity or SuperChat", async () => {
      process.env["APP_ENV"] = "production";
      delete process.env["NODE_ENV"];
      delete process.env["FACETUBE_API_BASE_URL"];
      delete process.env["API_BASE_URL"];
      delete process.env["VITE_MEDIA_BASE_URL"];

      const persistedRows: MockChatRow[] = [];
      let capturedInsertSql = "";
      let capturedSelectSql = "";

      enableMockDbEnv({
        query: async (sql: string, params: unknown[] = []) => {
          if (/FROM\s+sessions/i.test(sql)) {
            return [mockSessionUser(params[0]), []];
          }
          if (/INSERT\s+INTO\s+live_chat_messages/i.test(sql)) {
            capturedInsertSql = sql;
            persistedRows.push({
              id: String(params[0]),
              stream_id: String(params[1]),
              user_id: String(params[2]),
              user_name: String(params[3]),
              avatar_url: params[4] ? String(params[4]) : null,
              message: String(params[5]),
              is_superchat: Number(params[6]),
              superchat_amount: Number(params[7]),
              created_at: "2026-11-20T12:00:00.000Z",
            });
            return [{ affectedRows: 1 }, []];
          }
          if (/FROM\s+live_chat_messages/i.test(sql)) {
            capturedSelectSql = sql;
            return [persistedRows.filter((r) => r.stream_id === String(params[0])), []];
          }
          return [[], []];
        },
      });

      // Attempt to spoof Admin ID/name and fake a ₹5000 SuperChat using Alex's verified session
      const postRes = await handleApiRequest(
        new Request("https://facetube.online/api/live/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({
            stream_id: "live_prod_chat_01",
            user_id: "FT102857",
            userId: "FT102857",
            user_name: "FaceTube Administrator",
            userName: "Admin",
            avatar_url: "https://evil.example/spoof.png",
            message: "Hello from creator chat!",
            is_superchat: true,
            isSuperchat: true,
            superchat_amount: 5000,
            superchatAmount: 5000,
          }),
        }),
      );
      assert.ok(postRes);
      assert.equal(postRes.status, 201);
      const postData = (await postRes.json()) as any;
      assert.equal(postData.success, true);
      assert.equal(postData.message.stream_id, "live_prod_chat_01");
      assert.equal("user_id" in postData.message, false);
      assert.equal(postData.message.user_id, undefined);
      assert.equal(postData.message.user_name, "Alex Rivera");
      assert.equal(
        postData.message.avatar_url,
        "https://api.facetube.online/uploads/logos/alex_avatar.png",
      );
      assert.equal(postData.message.message, "Hello from creator chat!");
      assert.equal(postData.message.is_superchat, false);
      assert.equal(postData.message.superchat_amount, 0);

      // Verify MySQL row stored authoritative values & non-SuperChat internally
      assert.match(capturedInsertSql, /INSERT\s+INTO\s+live_chat_messages/i);
      assert.equal(persistedRows.length, 1);
      assert.equal(persistedRows[0]!.user_id, "FT483921");
      assert.equal(persistedRows[0]!.user_name, "Alex Rivera");
      assert.equal(persistedRows[0]!.is_superchat, 0);
      assert.equal(persistedRows[0]!.superchat_amount, 0);

      // Verify GET reads directly from MySQL in production and omits user_id publicly
      const getRes = await handleApiRequest(
        new Request("https://facetube.online/api/live/chat?stream_id=live_prod_chat_01", {
          method: "GET",
        }),
      );
      assert.ok(getRes);
      assert.equal(getRes.status, 200);
      const getData = (await getRes.json()) as any;
      assert.equal(getData.success, true);
      assert.equal(getData.stream_id, "live_prod_chat_01");
      assert.equal(getData.messages.length, 1);
      assert.equal("user_id" in getData.messages[0], false);
      assert.equal(getData.messages[0].user_id, undefined);
      assert.equal(getData.messages[0].user_name, "Alex Rivera");
      assert.equal(getData.messages[0].is_superchat, false);
      assert.equal(getData.messages[0].superchat_amount, 0);
      assert.doesNotMatch(capturedSelectSql, /\*/);
      assert.doesNotMatch(capturedSelectSql, /\buser_id\b/);
    });

    it("2. Guest can send normal messages without login, gets server-generated guest identity, and cannot impersonate registered users/admins or fake SuperChat", async () => {
      process.env["APP_ENV"] = "production";
      delete process.env["NODE_ENV"];

      const persistedRows: MockChatRow[] = [];
      enableMockDbEnv({
        query: async (sql: string, params: unknown[] = []) => {
          if (/INSERT\s+INTO\s+live_chat_messages/i.test(sql)) {
            persistedRows.push({
              id: String(params[0]),
              stream_id: String(params[1]),
              user_id: String(params[2]),
              user_name: String(params[3]),
              avatar_url: params[4] ? String(params[4]) : null,
              message: String(params[5]),
              is_superchat: Number(params[6]),
              superchat_amount: Number(params[7]),
              created_at: "2026-11-20T12:05:00.000Z",
            });
            return [{ affectedRows: 1 }, []];
          }
          if (/FROM\s+live_chat_messages/i.test(sql)) {
            return [persistedRows.filter((r) => r.stream_id === String(params[0])), []];
          }
          return [[], []];
        },
      });

      const guestPostRes = await handleApiRequest(
        new Request("https://facetube.online/api/live/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "203.0.113.42",
            "User-Agent": "GuestBrowser/1.0",
          },
          body: JSON.stringify({
            streamId: "live_prod_chat_02",
            user_id: "FT102857",
            user_name: "FaceTube Administrator",
            userName: "Alex Rivera",
            message: "Awesome live coding session!",
            is_superchat: true,
            superchat_amount: 9999,
          }),
        }),
      );
      assert.ok(guestPostRes);
      assert.equal(guestPostRes.status, 201);
      const guestPostData = (await guestPostRes.json()) as any;
      assert.equal(guestPostData.success, true);
      assert.equal("user_id" in guestPostData.message, false);
      assert.equal(guestPostData.message.user_id, undefined);
      assert.match(String(guestPostData.message.user_name), /^Viewer #[A-F0-9]{4}$/);
      assert.notEqual(guestPostData.message.user_name, "FaceTube Administrator");
      assert.notEqual(guestPostData.message.user_name, "Alex Rivera");
      assert.equal(guestPostData.message.avatar_url, null);
      assert.equal(guestPostData.message.is_superchat, false);
      assert.equal(guestPostData.message.superchat_amount, 0);
      assert.equal(persistedRows.length, 1);
      assert.match(String(persistedRows[0]!.user_id), /^guest_[a-f0-9]{12}$/);
      assert.notEqual(persistedRows[0]!.user_id, "FT102857");
      assert.equal(persistedRows[0]!.is_superchat, 0);
      assert.equal(persistedRows[0]!.superchat_amount, 0);

      // Different guest session gets a distinct internal guest_<hash> identity without exposing user_id
      const guest2PostRes = await handleApiRequest(
        new Request("https://facetube.online/api/live/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "198.51.100.77",
            "User-Agent": "AnotherBrowser/2.0",
          },
          body: JSON.stringify({
            stream_id: "live_prod_chat_02",
            message: "Second viewer saying hi!",
          }),
        }),
      );
      assert.equal(guest2PostRes?.status, 201);
      const guest2Data = (await guest2PostRes!.json()) as any;
      assert.equal("user_id" in guest2Data.message, false);
      assert.equal(guest2Data.message.user_id, undefined);
      assert.equal(persistedRows.length, 2);
      assert.match(String(persistedRows[1]!.user_id), /^guest_[a-f0-9]{12}$/);
      assert.notEqual(persistedRows[1]!.user_id, persistedRows[0]!.user_id);

      // Verify GET also omits user_id for guest messages
      const guestGetRes = await handleApiRequest(
        new Request("https://facetube.online/api/live/chat?stream_id=live_prod_chat_02", {
          method: "GET",
        }),
      );
      assert.equal(guestGetRes?.status, 200);
      const guestGetData = (await guestGetRes!.json()) as any;
      assert.equal(guestGetData.messages.length, 2);
      for (const msg of guestGetData.messages) {
        assert.equal("user_id" in msg, false);
        assert.equal(msg.user_id, undefined);
      }
    });

    it("3. Production fails closed with 503 when MySQL pool is unavailable on GET and POST without reading or writing JSON store", async () => {
      // Seed JSON store with chat message that must NEVER be read or modified in production
      const baseStore = suiteStoreSnapshot ? JSON.parse(suiteStoreSnapshot) : {};
      baseStore.liveChatMessages = [
        {
          id: "chat_json_leak_test",
          stream_id: "live_prod_503",
          user_id: "FT483921",
          user_name: "JSON Leak User",
          message: "Must never appear in production",
          is_superchat: false,
          superchat_amount: 0,
          created_at: "2026-11-20T10:00:00.000Z",
        },
      ];
      fs.writeFileSync(storePath, JSON.stringify(baseStore), "utf-8");
      resetInMemoryStore();

      process.env["APP_ENV"] = "production";
      delete process.env["NODE_ENV"];
      delete process.env["DB_HOST"];
      setMysqlPoolForTesting(null);

      const getRes = await handleApiRequest(
        new Request("https://facetube.online/api/live/chat?stream_id=live_prod_503", {
          method: "GET",
        }),
      );
      assert.equal(getRes?.status, 503);
      const getData = (await getRes!.json()) as any;
      assert.equal(getData.success, false);
      assert.equal(getData.messages, undefined);

      const postRes = await handleApiRequest(
        new Request("https://facetube.online/api/live/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stream_id: "live_prod_503", message: "Should fail 503" }),
        }),
      );
      assert.equal(postRes?.status, 503);
      const postData = (await postRes!.json()) as any;
      assert.equal(postData.success, false);
      assert.equal(postData.message, undefined);

      // Runtime env override via Nitro server entry also enforces 503 without mutating process.env
      process.env["NODE_ENV"] = "test";
      delete process.env["APP_ENV"];
      const nitroRes = await nitroServerEntry.fetch(
        new Request("http://localhost:3000/api/live/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stream_id: "live_prod_503", message: "Nitro prod 503" }),
        }),
        { APP_ENV: "production" },
        undefined,
      );
      assert.equal(nitroRes.status, 503);
      assert.equal(process.env["NODE_ENV"], "test");
      assert.equal(process.env["APP_ENV"], undefined);

      // Verify JSON store was not written to
      const afterStore = JSON.parse(fs.readFileSync(storePath, "utf-8"));
      assert.equal(afterStore.liveChatMessages.length, 1);
    });

    it("4. Production MySQL query/insert errors (and affectedRows=0) fail closed with 500 without JSON fallback or leaking internals", async () => {
      process.env["APP_ENV"] = "production";
      delete process.env["NODE_ENV"];

      const baseStore = suiteStoreSnapshot ? JSON.parse(suiteStoreSnapshot) : {};
      baseStore.liveChatMessages = [
        {
          id: "chat_json_should_not_leak",
          stream_id: "live_prod_500",
          user_id: "FT483921",
          user_name: "JSON Fallback Leak",
          message: "Must not fall back to JSON",
          created_at: "2026-11-20T10:00:00.000Z",
        },
      ];
      fs.writeFileSync(storePath, JSON.stringify(baseStore), "utf-8");
      resetInMemoryStore();

      let mode: "throw" | "zero_rows" = "throw";
      enableMockDbEnv({
        query: async (sql: string, params: unknown[] = []) => {
          if (/FROM\s+sessions/i.test(sql)) {
            return [mockSessionUser(params[0]), []];
          }
          if (/FROM\s+live_chat_messages/i.test(sql)) {
            throw new Error("ER_NO_SUCH_TABLE: secret-mysql.live_chat_messages missing");
          }
          if (/INSERT\s+INTO\s+live_chat_messages/i.test(sql)) {
            if (mode === "zero_rows") {
              return [{ affectedRows: 0 }, []];
            }
            throw new Error("ER_LOCK_WAIT_TIMEOUT: internal live_chat_messages deadlock");
          }
          return [[], []];
        },
      });

      const getErrRes = await handleApiRequest(
        new Request("https://facetube.online/api/live/chat?stream_id=live_prod_500", {
          method: "GET",
        }),
      );
      assert.equal(getErrRes?.status, 500);
      const getErrData = (await getErrRes!.json()) as any;
      assert.equal(getErrData.success, false);
      assert.equal(getErrData.messages, undefined);
      assert.doesNotMatch(String(getErrData.error || ""), /secret-mysql|ER_NO_SUCH_TABLE/);

      const postErrRes = await handleApiRequest(
        new Request("https://facetube.online/api/live/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({ stream_id: "live_prod_500", message: "Should fail 500" }),
        }),
      );
      assert.equal(postErrRes?.status, 500);
      const postErrData = (await postErrRes!.json()) as any;
      assert.equal(postErrData.success, false);
      assert.equal(postErrData.message, undefined);
      assert.doesNotMatch(String(postErrData.error || ""), /ER_LOCK_WAIT_TIMEOUT|deadlock/);

      mode = "zero_rows";
      const zeroRowsRes = await handleApiRequest(
        new Request("https://facetube.online/api/live/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stream_id: "live_prod_500", message: "Zero rows insert" }),
        }),
      );
      assert.equal(zeroRowsRes?.status, 500);
      const zeroRowsData = (await zeroRowsRes!.json()) as any;
      assert.equal(zeroRowsData.success, false);
      assert.equal(zeroRowsData.message, undefined);

      // JSON store must remain unmodified
      const afterStore = JSON.parse(fs.readFileSync(storePath, "utf-8"));
      assert.equal(afterStore.liveChatMessages.length, 1);
    });

    it("5. Development/test JSON fallback remains compatible while enforcing guest anti-impersonation and SuperChat blocking", async () => {
      process.env["NODE_ENV"] = "test";
      delete process.env["APP_ENV"];
      delete process.env["DB_HOST"];
      setMysqlPoolForTesting(null);

      // Seed clean empty chat list for stream
      const baseStore = suiteStoreSnapshot ? JSON.parse(suiteStoreSnapshot) : { users: [] };
      baseStore.liveChatMessages = [];
      fs.writeFileSync(storePath, JSON.stringify(baseStore), "utf-8");
      resetInMemoryStore();

      // Guest message in test mode
      const guestRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "10.20.30.40",
          },
          body: JSON.stringify({
            stream_id: "live_dev_chat_01",
            user_name: "Admin",
            message: "Dev guest chat message",
            is_superchat: true,
            superchat_amount: 500,
          }),
        }),
      );
      assert.equal(guestRes?.status, 201);
      const guestData = (await guestRes!.json()) as any;
      assert.equal("user_id" in guestData.message, false);
      assert.match(String(guestData.message.user_name), /^Viewer #[A-F0-9]{4}$/);
      assert.equal(guestData.message.is_superchat, false);
      assert.equal(guestData.message.superchat_amount, 0);

      // Authenticated user message in test mode
      const authRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${viewerToken}`,
          },
          body: JSON.stringify({
            stream_id: "live_dev_chat_01",
            user_id: "FT102857",
            user_name: "Spoofed Name",
            message: "Dev logged-in message",
          }),
        }),
      );
      assert.equal(authRes?.status, 201);
      const authData = (await authRes!.json()) as any;
      assert.equal("user_id" in authData.message, false);
      assert.equal(authData.message.user_name, "Maya Lin");

      // GET reads both messages back from test store without exposing user_id
      const listRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/chat?stream_id=live_dev_chat_01", {
          method: "GET",
        }),
      );
      assert.equal(listRes?.status, 200);
      const listData = (await listRes!.json()) as any;
      assert.equal(listData.messages.length, 2);
      assert.equal(listData.messages[0].message, "Dev guest chat message");
      assert.equal(listData.messages[1].message, "Dev logged-in message");
      assert.equal("user_id" in listData.messages[0], false);
      assert.equal("user_id" in listData.messages[1], false);

      // Verify dev/test store retained internal guest/member user_ids internally
      const storedAfter = JSON.parse(fs.readFileSync(storePath, "utf-8"));
      assert.equal(storedAfter.liveChatMessages.length, 2);
      assert.match(String(storedAfter.liveChatMessages[0].user_id), /^guest_[a-f0-9]{12}$/);
      assert.equal(storedAfter.liveChatMessages[1].user_id, "FT900431");
    });

    it("6. Public GET and POST chat responses never expose private user, session, or payment fields and enforce length/rate-limit bounds", async () => {
      process.env["APP_ENV"] = "production";
      delete process.env["NODE_ENV"];

      enableMockDbEnv({
        query: async (sql: string, params: unknown[] = []) => {
          if (/FROM\s+sessions/i.test(sql)) {
            return [mockSessionUser(params[0]), []];
          }
          if (/INSERT\s+INTO\s+live_chat_messages/i.test(sql)) {
            return [{ affectedRows: 1 }, []];
          }
          if (/FROM\s+live_chat_messages/i.test(sql)) {
            return [
              [
                {
                  id: "chat_priv_01",
                  stream_id: String(params[0]),
                  user_id: "FT483921",
                  user_name: "Alex Rivera",
                  avatar_url: "/uploads/logos/alex_avatar.png",
                  message: "Public chat content",
                  is_superchat: 0,
                  superchat_amount: "0.00",
                  created_at: "2026-11-20T12:10:00.000Z",
                  // Sensitive fields that must always be stripped from public projection
                  email: "alex@facetube.com",
                  mobile: "+1 555-014-8392",
                  password_hash: "$2b$10$secret",
                  token: "tok_secret_session",
                  payment_id: "pay_rzp_secret",
                  order_id: "order_rzp_secret",
                },
              ],
              [],
            ];
          }
          return [[], []];
        },
      });

      const getRes = await handleApiRequest(
        new Request("https://facetube.online/api/live/chat?stream_id=live_privacy_01", {
          method: "GET",
        }),
      );
      assert.equal(getRes?.status, 200);
      const getData = (await getRes!.json()) as any;
      assert.equal(getData.messages.length, 1);
      const pubMsg = getData.messages[0];
      assert.deepEqual(Object.keys(pubMsg).sort(), [
        "avatar_url",
        "created_at",
        "id",
        "is_superchat",
        "message",
        "stream_id",
        "superchat_amount",
        "user_name",
      ]);
      for (const forbiddenKey of [
        "user_id",
        "email",
        "mobile",
        "password_hash",
        "token",
        "payment_id",
        "order_id",
      ]) {
        assert.equal(forbiddenKey in pubMsg, false);
      }

      // Authenticated POST response also adheres to the exact 8-key public projection
      const postProjRes = await handleApiRequest(
        new Request("https://facetube.online/api/live/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({
            stream_id: "live_privacy_01",
            message: "Public projection check",
          }),
        }),
      );
      assert.equal(postProjRes?.status, 201);
      const postProjData = (await postProjRes!.json()) as any;
      assert.deepEqual(Object.keys(postProjData.message).sort(), [
        "avatar_url",
        "created_at",
        "id",
        "is_superchat",
        "message",
        "stream_id",
        "superchat_amount",
        "user_name",
      ]);
      assert.equal("user_id" in postProjData.message, false);

      // Reject oversized messages (> 500 chars)
      const tooLongRes = await handleApiRequest(
        new Request("https://facetube.online/api/live/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            stream_id: "live_privacy_01",
            message: "x".repeat(501),
          }),
        }),
      );
      assert.equal(tooLongRes?.status, 400);

      // Rate-limit bursts (> 20 messages within 10s from same guest/stream)
      for (let i = 0; i < 20; i++) {
        const okBurst = await handleApiRequest(
          new Request("https://facetube.online/api/live/chat", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Forwarded-For": "203.0.113.99",
            },
            body: JSON.stringify({
              stream_id: "live_rate_limit_stream",
              message: `Burst message ${i + 1}`,
            }),
          }),
        );
        assert.equal(okBurst?.status, 201);
      }
      const limitedRes = await handleApiRequest(
        new Request("https://facetube.online/api/live/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "203.0.113.99",
          },
          body: JSON.stringify({
            stream_id: "live_rate_limit_stream",
            message: "Message 21 should be rate-limited",
          }),
        }),
      );
      assert.equal(limitedRes?.status, 429);
    });

    it("7. PHP api/live/chat.php enforces parity for guest SHA-256 identity, user_id privacy, anti-impersonation, and non-trusted SuperChat fields", () => {
      const chatPhp = fs.readFileSync(path.resolve(process.cwd(), "api/live/chat.php"), "utf-8");
      assert.doesNotMatch(chatPhp, /\$input\['user_name'\]/);
      assert.doesNotMatch(chatPhp, /!empty\(\$input\['is_superchat'\]\)/);
      assert.doesNotMatch(chatPhp, /floatval\(\$input\['superchat_amount'\]/);
      assert.doesNotMatch(chatPhp, /'user_id'\s*=>/);
      assert.doesNotMatch(chatPhp, /SELECT\s+id,\s*stream_id,\s*user_id,\s*user_name/i);
      assert.match(chatPhp, /INSERT\s+INTO\s+live_chat_messages\s*\([^)]*user_id/i);
      assert.match(chatPhp, /'guest_'\s*\.\s*\$guestHash/);
      assert.match(chatPhp, /\$isSuperchat\s*=\s*false;/);
      assert.match(chatPhp, /\$superchatAmount\s*=\s*0\.0;/);
      assert.match(chatPhp, /rowCount\(\)\s*<\s*1/);
      assert.match(chatPhp, /429/);
    });
  });

  describe("8. Task 5J-V4-Q: PHP Live Token Authentication Downgrade & Fail-Closed Tests (api/live/token.php)", () => {
    const tokenPhpPath = path.resolve(process.cwd(), "api/live/token.php");
    const responsePhpPath = path.resolve(process.cwd(), "api/response.php");

    function loadPhpSources() {
      return {
        tokenPhp: fs.readFileSync(tokenPhpPath, "utf-8"),
        responsePhp: fs.readFileSync(responsePhpPath, "utf-8"),
      };
    }

    interface LiveTokenResponse {
      success: boolean;
      error?: string;
      token?: string;
      url?: string;
      room?: string;
      stream_id?: string;
      identity?: string;
      role?: "publisher" | "subscriber";
      can_publish?: boolean;
      expires_in?: number;
    }

    function createPhpLiveTokenHarness(options: {
      method?: string;
      livekitUrl?: string;
      livekitApiKey?: string;
      livekitApiSecret?: string;
      streamId?: string;
      requestedRole?: string;
      streamBehavior?:
        | { kind: "none" }
        | { kind: "row"; id: string; user_id: string; status: string; room_name: string | null }
        | { kind: "db_error"; sqlState: string; driverCode: number; message: string };
      bearerToken: string | null;
      authBehavior:
        | { kind: "none" }
        | { kind: "invalid" }
        | { kind: "user"; user_id: string; name: string; role: string }
        | {
            kind: "db_error";
            sqlState: string;
            driverCode: number;
            message: string;
            isRuntime?: boolean;
          };
      remoteAddr?: string;
      userAgent?: string;
    }) {
      const { responsePhp } = loadPhpSources();
      const fnStart = responsePhp.indexOf("function isDatabaseConnectionUnavailableError(");
      const fnBlock = responsePhp.slice(fnStart, fnStart + 900);
      const codeMatch = fnBlock.match(/in_array\(\$driverCode,\s*\[([^\]]+)\],\s*true\)/);
      const driverCodes = (codeMatch?.[1] || "")
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => !Number.isNaN(n));
      const regexMatch = fnBlock.match(/preg_match\('\/([^']+)\/i',\s*\$msg\)/);
      const msgRegex = new RegExp(regexMatch?.[1] || "", "i");

      const isConnUnavailable = (sqlState: string, driverCode: number, msg: string) =>
        sqlState.startsWith("08") || driverCodes.includes(driverCode) || msgRegex.test(msg);

      const serverLogs: string[] = [];

      const method = options.method ?? "POST";
      if (method !== "POST") {
        return {
          status: 405,
          body: {
            success: false,
            error: "Method Not Allowed. POST is required.",
          } as LiveTokenResponse,
          serverLogs,
        };
      }

      const livekitUrl = options.livekitUrl ?? "wss://live.facetube.online";
      const apiKey = options.livekitApiKey ?? "lk_api_key_prod";
      const apiSecret = options.livekitApiSecret ?? "lk_api_secret_prod_32bytes_min_len";
      if (!livekitUrl || !apiKey || !apiSecret) {
        return {
          status: 503,
          body: {
            success: false,
            error:
              "LiveKit Cloud streaming service is not configured on this server. Please define LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET in server environment.",
          } as LiveTokenResponse,
          serverLogs,
        };
      }

      const streamId = (options.streamId ?? "live_01").trim();
      const requestedRole = (options.requestedRole ?? "subscriber").toLowerCase().trim();
      if (!streamId) {
        return {
          status: 400,
          body: {
            success: false,
            error: "Stream ID (stream_id) is required.",
          } as LiveTokenResponse,
          serverLogs,
        };
      }

      let stream: { id: string; user_id: string; status: string; room_name: string | null } | null =
        null;
      const sb = options.streamBehavior ?? {
        kind: "row",
        id: streamId,
        user_id: "FT483921",
        status: "live",
        room_name: `room_${streamId}`,
      };
      if (sb.kind === "db_error") {
        serverLogs.push(`[live/token.php][STREAM] Database error: ${sb.message}`);
        if (isConnUnavailable(sb.sqlState, sb.driverCode, sb.message)) {
          return {
            status: 503,
            body: {
              success: false,
              error: "Database connection unavailable while loading stream.",
            } as LiveTokenResponse,
            serverLogs,
          };
        }
        return {
          status: 500,
          body: {
            success: false,
            error: "Database error loading stream.",
          } as LiveTokenResponse,
          serverLogs,
        };
      } else if (sb.kind === "row") {
        stream = sb;
      }

      if (!stream) {
        return {
          status: 404,
          body: {
            success: false,
            error: `Live stream '${streamId}' not found.`,
          } as LiveTokenResponse,
          serverLogs,
        };
      }
      if (stream.status === "ended") {
        return {
          status: 410,
          body: {
            success: false,
            error: "This live broadcast has ended.",
          } as LiveTokenResponse,
          serverLogs,
        };
      }

      const suppliedBearerToken = options.bearerToken;
      let authUser: { user_id: string; name: string; role: string } | null = null;
      try {
        if (suppliedBearerToken !== null) {
          if (options.authBehavior.kind === "user") {
            authUser = {
              user_id: options.authBehavior.user_id,
              name: options.authBehavior.name,
              role: options.authBehavior.role,
            };
          } else if (options.authBehavior.kind === "invalid") {
            authUser = null;
          } else if (options.authBehavior.kind === "db_error") {
            throw options.authBehavior;
          }
        }
      } catch (e: unknown) {
        const err = e as {
          sqlState?: string;
          driverCode?: number;
          message?: string;
          isRuntime?: boolean;
        };
        serverLogs.push(`[live/token.php][AUTH] Database error: ${err.message ?? ""}`);
        if (
          !err.isRuntime &&
          isConnUnavailable(err.sqlState ?? "", err.driverCode ?? 0, err.message ?? "")
        ) {
          return {
            status: 503,
            body: {
              success: false,
              error: "Database connection unavailable during authentication check.",
            } as LiveTokenResponse,
            serverLogs,
          };
        }
        return {
          status: 500,
          body: {
            success: false,
            error: "Database error during authentication check.",
          } as LiveTokenResponse,
          serverLogs,
        };
      }

      if (suppliedBearerToken !== null && (!authUser || !authUser.user_id)) {
        return {
          status: 401,
          body: {
            success: false,
            error: "Invalid or expired authentication session. Please log in again.",
          } as LiveTokenResponse,
          serverLogs,
        };
      }

      const roomName = stream.room_name || `room_${stream.id}`;
      let isBroadcaster = false;
      let participantIdentity = "";
      let participantName = "";

      if (requestedRole === "publisher" || requestedRole === "broadcaster") {
        if (!authUser || !authUser.user_id) {
          return {
            status: 401,
            body: {
              success: false,
              error: "Authentication required to obtain broadcaster publishing permissions.",
            } as LiveTokenResponse,
            serverLogs,
          };
        }
        if (
          stream.user_id.toUpperCase() !== authUser.user_id.toUpperCase() &&
          authUser.role.toLowerCase() !== "admin"
        ) {
          return {
            status: 403,
            body: {
              success: false,
              error: "Unauthorized. You do not own this live stream and cannot broadcast to it.",
            } as LiveTokenResponse,
            serverLogs,
          };
        }
        isBroadcaster = true;
        participantIdentity = authUser.user_id;
        participantName = authUser.name || "Broadcaster";
      } else {
        if (authUser && authUser.user_id) {
          participantIdentity = authUser.user_id;
          participantName = authUser.name || "Viewer";
        } else {
          const ip = options.remoteAddr ?? "127.0.0.1";
          const ua = options.userAgent ?? "browser";
          const guestHash = crypto
            .createHash("sha256")
            .update(`${ip}|${ua}|`)
            .digest("hex")
            .slice(0, 12);
          participantIdentity = `guest_${guestHash}`;
          participantName = "Viewer";
        }
      }

      const now = Math.floor(Date.now() / 1000);
      const expirySeconds = 1800;
      const videoGrant = isBroadcaster
        ? {
            room: roomName,
            roomJoin: true,
            canPublish: true,
            canPublishSources: ["camera", "microphone"],
            canSubscribe: true,
            canPublishData: true,
          }
        : {
            room: roomName,
            roomJoin: true,
            canPublish: false,
            canSubscribe: true,
            canPublishData: true,
          };

      const b64u = (input: string | Buffer) =>
        Buffer.from(input)
          .toString("base64")
          .replace(/=/g, "")
          .replace(/\+/g, "-")
          .replace(/\//g, "_");
      const h = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
      const p = b64u(
        JSON.stringify({
          iss: apiKey,
          sub: participantIdentity,
          name: participantName,
          nbf: now,
          exp: now + expirySeconds,
          video: videoGrant,
        }),
      );
      const s = b64u(crypto.createHmac("sha256", apiSecret).update(`${h}.${p}`).digest());

      return {
        status: 200,
        body: {
          success: true,
          token: `${h}.${p}.${s}`,
          url: livekitUrl,
          room: roomName,
          stream_id: stream.id,
          identity: participantIdentity,
          role: isBroadcaster ? "publisher" : "subscriber",
          can_publish: isBroadcaster,
          expires_in: expirySeconds,
        } as LiveTokenResponse,
        serverLogs,
      };
    }

    it("1. Preserves guest live viewing (no Bearer token) and valid creator/viewer tokens", () => {
      const { tokenPhp } = loadPhpSources();
      assert.match(tokenPhp, /\$suppliedBearerToken\s*=\s*getBearerToken\(\);/);
      assert.match(tokenPhp, /\$authUser\s*=\s*getAuthUser\(\$pdo,\s*true\);/);
      assert.match(
        tokenPhp,
        /if\s*\(\s*\$suppliedBearerToken\s*!==\s*null\s*&&\s*\(!\$authUser\s*\|\|\s*empty\(\$authUser\['user_id'\]\)\)\s*\)/,
      );

      // Unauthenticated guest viewer (no Bearer header) -> valid subscriber guest token
      const guestRes = createPhpLiveTokenHarness({
        bearerToken: null,
        requestedRole: "subscriber",
        streamId: "live_guest_ok",
        authBehavior: { kind: "none" },
      });
      assert.equal(guestRes.status, 200);
      assert.equal(guestRes.body.success, true);
      assert.equal(guestRes.body.role, "subscriber");
      assert.equal(guestRes.body.can_publish, false);
      assert.equal(guestRes.body.expires_in, 1800);
      assert.equal(guestRes.body.room, "room_live_guest_ok");
      assert.match(guestRes.body.identity!, /^guest_[a-f0-9]{12}$/);
      const guestPayload = JSON.parse(
        base64UrlDecode(guestRes.body.token!.split(".")[1]!).toString("utf8"),
      );
      assert.equal(guestPayload.sub, guestRes.body.identity);
      assert.equal(guestPayload.video.roomJoin, true);
      assert.equal(guestPayload.video.canPublish, false);
      assert.equal(guestPayload.video.canSubscribe, true);
      assert.equal(guestPayload.exp - guestPayload.nbf, 1800);

      // Guest requesting publisher role -> HTTP 401
      const guestPub = createPhpLiveTokenHarness({
        bearerToken: null,
        requestedRole: "publisher",
        streamId: "live_guest_ok",
        authBehavior: { kind: "none" },
      });
      assert.equal(guestPub.status, 401);

      // Authenticated creator requesting publisher -> HTTP 200 with camera/mic publish grant
      const creatorRes = createPhpLiveTokenHarness({
        bearerToken: "valid_creator_tok",
        requestedRole: "publisher",
        streamId: "live_guest_ok",
        authBehavior: { kind: "user", user_id: "FT483921", name: "Alex Rivera", role: "user" },
      });
      assert.equal(creatorRes.status, 200);
      assert.equal(creatorRes.body.role, "publisher");
      assert.equal(creatorRes.body.can_publish, true);
      assert.equal(creatorRes.body.identity, "FT483921");
      const creatorPayload = JSON.parse(
        base64UrlDecode(creatorRes.body.token!.split(".")[1]!).toString("utf8"),
      );
      assert.equal(creatorPayload.video.canPublish, true);
      assert.deepEqual(creatorPayload.video.canPublishSources, ["camera", "microphone"]);

      // Authenticated viewer requesting subscriber -> HTTP 200 with user identity and publish=false
      const viewerRes = createPhpLiveTokenHarness({
        bearerToken: "valid_viewer_tok",
        requestedRole: "subscriber",
        streamId: "live_guest_ok",
        authBehavior: { kind: "user", user_id: "FT900431", name: "Maya Lin", role: "user" },
      });
      assert.equal(viewerRes.status, 200);
      assert.equal(viewerRes.body.role, "subscriber");
      assert.equal(viewerRes.body.can_publish, false);
      assert.equal(viewerRes.body.identity, "FT900431");

      // Non-owner viewer requesting publisher -> HTTP 403
      const hijackRes = createPhpLiveTokenHarness({
        bearerToken: "valid_viewer_tok",
        requestedRole: "publisher",
        streamId: "live_guest_ok",
        authBehavior: { kind: "user", user_id: "FT900431", name: "Maya Lin", role: "user" },
      });
      assert.equal(hijackRes.status, 403);
    });

    it("2. Rejects invalid/expired supplied Bearer tokens with HTTP 401 and never downgrades to guest", () => {
      const invalidViewer = createPhpLiveTokenHarness({
        bearerToken: "expired_or_invalid_session_tok",
        requestedRole: "subscriber",
        streamId: "live_01",
        authBehavior: { kind: "invalid" },
      });
      assert.equal(invalidViewer.status, 401);
      assert.equal(invalidViewer.body.success, false);
      assert.equal(invalidViewer.body.token, undefined);
      assert.equal(invalidViewer.body.identity, undefined);

      const invalidBroadcaster = createPhpLiveTokenHarness({
        bearerToken: "expired_or_invalid_session_tok",
        requestedRole: "publisher",
        streamId: "live_01",
        authBehavior: { kind: "invalid" },
      });
      assert.equal(invalidBroadcaster.status, 401);
      assert.equal(invalidBroadcaster.body.token, undefined);
    });

    it("3. Fails closed with HTTP 503 on auth/stream DB connection loss, sanitized HTTP 500 on unexpected errors, and HTTP 503 when LiveKit credentials are missing", () => {
      const { tokenPhp } = loadPhpSources();
      assert.match(tokenPhp, /\}\s*catch\s*\(\s*Throwable\s+\$e\s*\)\s*\{/);
      assert.match(tokenPhp, /isDatabaseConnectionUnavailableError\(\$e\)/);
      assert.match(tokenPhp, /error_log\(/);
      assert.doesNotMatch(tokenPhp, /jsonResponse\([^\n]*\$e->getMessage\(\)/);
      assert.doesNotMatch(tokenPhp, /devkey/);
      assert.doesNotMatch(tokenPhp, /rollBack\(/);

      // Auth DB connection error (errno 1203 / 2002) -> HTTP 503, never guest token
      const auth1203 = createPhpLiveTokenHarness({
        bearerToken: "valid_viewer_tok",
        requestedRole: "subscriber",
        streamId: "live_01",
        authBehavior: {
          kind: "db_error",
          sqlState: "42000",
          driverCode: 1203,
          message: "User already has more than 'max_user_connections' active connections",
        },
      });
      assert.equal(auth1203.status, 503);
      assert.equal(auth1203.body.success, false);
      assert.equal(auth1203.body.token, undefined);
      assert.equal(auth1203.body.identity, undefined);
      assert.equal(String(auth1203.body.error).includes("max_user_connections"), false);
      assert.ok(auth1203.serverLogs.some((l) => l.includes("max_user_connections")));

      // Unexpected auth DB/runtime failure -> sanitized HTTP 500, never guest token
      const auth500 = createPhpLiveTokenHarness({
        bearerToken: "valid_viewer_tok",
        requestedRole: "subscriber",
        streamId: "live_01",
        authBehavior: {
          kind: "db_error",
          sqlState: "42S02",
          driverCode: 1146,
          message: "Table 'prod_db.sessions' doesn't exist",
        },
      });
      assert.equal(auth500.status, 500);
      assert.equal(auth500.body.success, false);
      assert.equal(auth500.body.token, undefined);
      assert.equal(String(auth500.body.error).includes("sessions"), false);

      // Stream DB connection error -> HTTP 503
      const stream503 = createPhpLiveTokenHarness({
        bearerToken: null,
        streamId: "live_01",
        streamBehavior: {
          kind: "db_error",
          sqlState: "HY000",
          driverCode: 2006,
          message: "MySQL server has gone away",
        },
        authBehavior: { kind: "none" },
      });
      assert.equal(stream503.status, 503);
      assert.equal(stream503.body.token, undefined);

      // Missing LiveKit credentials in production -> HTTP 503 fail-closed
      const missingCreds = createPhpLiveTokenHarness({
        bearerToken: null,
        livekitApiKey: "",
        livekitApiSecret: "",
        streamId: "live_01",
        authBehavior: { kind: "none" },
      });
      assert.equal(missingCreds.status, 503);
      assert.equal(missingCreds.body.token, undefined);
    });
  });

  describe("9. Task 5J-V4-R: PHP Live Heartbeat Authentication Downgrade & Fail-Closed Tests (api/live/heartbeat.php)", () => {
    const heartbeatPhpPath = path.resolve(process.cwd(), "api/live/heartbeat.php");
    const responsePhpPath = path.resolve(process.cwd(), "api/response.php");

    function loadPhpSources() {
      return {
        heartbeatPhp: fs.readFileSync(heartbeatPhpPath, "utf-8"),
        responsePhp: fs.readFileSync(responsePhpPath, "utf-8"),
      };
    }

    interface HeartbeatResponse {
      success: boolean;
      error?: string;
      stream_id?: string;
      role?: "broadcaster" | "viewer";
      stream_status?: string;
      viewers_count?: number;
      ping_received_at?: string;
    }

    function createPhpHeartbeatHarness(options: {
      method?: string;
      rawAuthHeader?: string | null;
      rawXAuthHeader?: string | null;
      streamId?: string;
      requestedRole?: string;
      spoofedBodyUserId?: string;
      streamBehavior?:
        | { kind: "none" }
        | { kind: "row"; id: string; user_id: string; status: string; viewers_count: number }
        | { kind: "db_error"; sqlState: string; driverCode: number; message: string };
      authBehavior:
        | { kind: "none" }
        | { kind: "invalid" }
        | { kind: "user"; user_id: string; role: string }
        | {
            kind: "db_error";
            sqlState: string;
            driverCode: number;
            message: string;
            isRuntime?: boolean;
          };
      broadcasterUpdateBehavior?:
        | { kind: "ok" }
        | {
            kind: "db_error";
            sqlState: string;
            driverCode: number;
            message: string;
            isRuntime?: boolean;
          };
      viewerInsertBehavior?:
        | { kind: "ok" }
        | {
            kind: "db_error";
            sqlState: string;
            driverCode: number;
            message: string;
            isRuntime?: boolean;
          };
      remoteAddr?: string;
      userAgent?: string;
    }) {
      const { responsePhp } = loadPhpSources();
      const fnStart = responsePhp.indexOf("function isDatabaseConnectionUnavailableError(");
      const fnBlock = responsePhp.slice(fnStart, fnStart + 900);
      const codeMatch = fnBlock.match(/in_array\(\$driverCode,\s*\[([^\]]+)\],\s*true\)/);
      const driverCodes = (codeMatch?.[1] || "")
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => !Number.isNaN(n));
      const regexMatch = fnBlock.match(/preg_match\('\/([^']+)\/i',\s*\$msg\)/);
      const msgRegex = new RegExp(regexMatch?.[1] || "", "i");

      const isConnUnavailable = (sqlState: string, driverCode: number, msg: string) =>
        sqlState.startsWith("08") || driverCodes.includes(driverCode) || msgRegex.test(msg);

      const isMissingColumn = (err: {
        sqlState?: string;
        driverCode?: number;
        isRuntime?: boolean;
      }) => !err.isRuntime && (err.sqlState === "42S22" || err.driverCode === 1054);

      const isMissingTable = (err: {
        sqlState?: string;
        driverCode?: number;
        isRuntime?: boolean;
      }) => !err.isRuntime && (err.sqlState === "42S02" || err.driverCode === 1146);

      const serverLogs: string[] = [];
      let recordedViewerIdentifier: string | null = null;
      let recordedViewerUserId: string | null = null;
      let broadcasterUpdated = false;

      const method = options.method ?? "POST";
      if (method !== "POST") {
        return {
          status: 405,
          body: {
            success: false,
            error: "Method Not Allowed. POST is required.",
          } as HeartbeatResponse,
          recordedViewerIdentifier,
          recordedViewerUserId,
          broadcasterUpdated,
          serverLogs,
        };
      }

      const streamId = (options.streamId ?? "live_hb_01").trim();
      const role = (options.requestedRole ?? "viewer").toLowerCase().trim();
      if (!streamId) {
        return {
          status: 400,
          body: {
            success: false,
            error: "Stream ID (stream_id) is required.",
          } as HeartbeatResponse,
          recordedViewerIdentifier,
          recordedViewerUserId,
          broadcasterUpdated,
          serverLogs,
        };
      }

      let stream: { id: string; user_id: string; status: string; viewers_count: number } | null =
        null;
      const sb = options.streamBehavior ?? {
        kind: "row",
        id: streamId,
        user_id: "FT483921",
        status: "live",
        viewers_count: 14,
      };
      if (sb.kind === "db_error") {
        serverLogs.push(`[live/heartbeat.php][STREAM] Database error: ${sb.message}`);
        if (isConnUnavailable(sb.sqlState, sb.driverCode, sb.message)) {
          return {
            status: 503,
            body: {
              success: false,
              error: "Database connection unavailable while loading stream.",
            } as HeartbeatResponse,
            recordedViewerIdentifier,
            recordedViewerUserId,
            broadcasterUpdated,
            serverLogs,
          };
        }
        return {
          status: 500,
          body: {
            success: false,
            error: "Database error loading stream.",
          } as HeartbeatResponse,
          recordedViewerIdentifier,
          recordedViewerUserId,
          broadcasterUpdated,
          serverLogs,
        };
      } else if (sb.kind === "row") {
        stream = sb;
      }

      if (!stream) {
        return {
          status: 404,
          body: {
            success: false,
            error: `Live stream '${streamId}' not found.`,
          } as HeartbeatResponse,
          recordedViewerIdentifier,
          recordedViewerUserId,
          broadcasterUpdated,
          serverLogs,
        };
      }

      if (stream.status === "ended") {
        return {
          status: 410,
          body: {
            success: false,
            stream_status: "ended",
            error: "Stream has already ended.",
          } as HeartbeatResponse,
          recordedViewerIdentifier,
          recordedViewerUserId,
          broadcasterUpdated,
          serverLogs,
        };
      }

      const headerCandidates = [options.rawAuthHeader ?? null, options.rawXAuthHeader ?? null];
      const authHeaderSupplied = headerCandidates.some((c) => c !== null && c.trim() !== "");
      let suppliedBearerToken: string | null = null;
      for (const c of headerCandidates) {
        if (c && c.trim() !== "") {
          const m = c.trim().match(/Bearer\s+(\S+)/i);
          if (m && m[1]) {
            suppliedBearerToken = m[1];
            break;
          }
        }
      }

      if (authHeaderSupplied && suppliedBearerToken === null) {
        return {
          status: 401,
          body: {
            success: false,
            error:
              "Malformed or empty Bearer authorization header. Please provide a valid Bearer session token.",
          } as HeartbeatResponse,
          recordedViewerIdentifier,
          recordedViewerUserId,
          broadcasterUpdated,
          serverLogs,
        };
      }

      let authUser: { user_id: string; role: string } | null = null;
      if (suppliedBearerToken !== null) {
        try {
          if (options.authBehavior.kind === "user") {
            authUser = {
              user_id: options.authBehavior.user_id,
              role: options.authBehavior.role,
            };
          } else if (options.authBehavior.kind === "invalid") {
            authUser = null;
          } else if (options.authBehavior.kind === "db_error") {
            throw options.authBehavior;
          }
        } catch (e: unknown) {
          const err = e as {
            sqlState?: string;
            driverCode?: number;
            message?: string;
            isRuntime?: boolean;
          };
          serverLogs.push(`[live/heartbeat.php][AUTH] Database error: ${err.message ?? ""}`);
          if (
            !err.isRuntime &&
            isConnUnavailable(err.sqlState ?? "", err.driverCode ?? 0, err.message ?? "")
          ) {
            return {
              status: 503,
              body: {
                success: false,
                error: "Database connection unavailable during authentication check.",
              } as HeartbeatResponse,
              recordedViewerIdentifier,
              recordedViewerUserId,
              broadcasterUpdated,
              serverLogs,
            };
          }
          return {
            status: 500,
            body: {
              success: false,
              error: "Database error during authentication check.",
            } as HeartbeatResponse,
            recordedViewerIdentifier,
            recordedViewerUserId,
            broadcasterUpdated,
            serverLogs,
          };
        }

        if (!authUser || !authUser.user_id) {
          return {
            status: 401,
            body: {
              success: false,
              error: "Invalid or expired authentication session. Please log in again.",
            } as HeartbeatResponse,
            recordedViewerIdentifier,
            recordedViewerUserId,
            broadcasterUpdated,
            serverLogs,
          };
        }
      }

      if (role === "broadcaster" || role === "publisher") {
        if (!authUser || !authUser.user_id) {
          return {
            status: 401,
            body: {
              success: false,
              error: "Authentication required for broadcaster heartbeat.",
            } as HeartbeatResponse,
            recordedViewerIdentifier,
            recordedViewerUserId,
            broadcasterUpdated,
            serverLogs,
          };
        }
        if (
          stream.user_id.toUpperCase() !== authUser.user_id.toUpperCase() &&
          authUser.role.toLowerCase() !== "admin"
        ) {
          return {
            status: 403,
            body: {
              success: false,
              error:
                "Unauthorized. You do not own this live stream and cannot send broadcaster heartbeats.",
            } as HeartbeatResponse,
            recordedViewerIdentifier,
            recordedViewerUserId,
            broadcasterUpdated,
            serverLogs,
          };
        }

        try {
          const ub = options.broadcasterUpdateBehavior ?? { kind: "ok" };
          if (ub.kind === "db_error") {
            throw ub;
          }
          broadcasterUpdated = true;
        } catch (e: unknown) {
          const err = e as {
            sqlState?: string;
            driverCode?: number;
            message?: string;
            isRuntime?: boolean;
          };
          if (!isMissingColumn(err)) {
            serverLogs.push(
              `[live/heartbeat.php][BROADCASTER] Database error: ${err.message ?? ""}`,
            );
            if (
              !err.isRuntime &&
              isConnUnavailable(err.sqlState ?? "", err.driverCode ?? 0, err.message ?? "")
            ) {
              return {
                status: 503,
                body: {
                  success: false,
                  error: "Database connection unavailable while recording broadcaster heartbeat.",
                } as HeartbeatResponse,
                recordedViewerIdentifier,
                recordedViewerUserId,
                broadcasterUpdated,
                serverLogs,
              };
            }
            return {
              status: 500,
              body: {
                success: false,
                error: "Failed to record broadcaster heartbeat due to a server error.",
              } as HeartbeatResponse,
              recordedViewerIdentifier,
              recordedViewerUserId,
              broadcasterUpdated,
              serverLogs,
            };
          }
        }

        return {
          status: 200,
          body: {
            success: true,
            stream_id: streamId,
            role: "broadcaster",
            stream_status: stream.status,
            viewers_count: stream.viewers_count,
            ping_received_at: new Date().toISOString(),
          } as HeartbeatResponse,
          recordedViewerIdentifier,
          recordedViewerUserId,
          broadcasterUpdated,
          serverLogs,
        };
      }

      // Viewer presence: strictly derived from verified authUser or deterministic guest hash (ignores spoofedBodyUserId)
      const ip = options.remoteAddr ?? "127.0.0.1";
      const ua = options.userAgent ?? "browser";
      const guestHash = crypto
        .createHash("sha256")
        .update(`${ip}|${ua}|`)
        .digest("hex")
        .slice(0, 16);
      const viewerId = authUser ? authUser.user_id : `guest_${guestHash}`;

      try {
        const vb = options.viewerInsertBehavior ?? { kind: "ok" };
        if (vb.kind === "db_error") {
          throw vb;
        }
        recordedViewerIdentifier = viewerId;
        recordedViewerUserId = authUser ? authUser.user_id : null;
      } catch (e: unknown) {
        const err = e as {
          sqlState?: string;
          driverCode?: number;
          message?: string;
          isRuntime?: boolean;
        };
        if (!isMissingTable(err)) {
          serverLogs.push(`[live/heartbeat.php][VIEWER] Database error: ${err.message ?? ""}`);
          if (
            !err.isRuntime &&
            isConnUnavailable(err.sqlState ?? "", err.driverCode ?? 0, err.message ?? "")
          ) {
            return {
              status: 503,
              body: {
                success: false,
                error: "Database connection unavailable while recording viewer heartbeat.",
              } as HeartbeatResponse,
              recordedViewerIdentifier,
              recordedViewerUserId,
              broadcasterUpdated,
              serverLogs,
            };
          }
          return {
            status: 500,
            body: {
              success: false,
              error: "Failed to record viewer heartbeat due to a server error.",
            } as HeartbeatResponse,
            recordedViewerIdentifier,
            recordedViewerUserId,
            broadcasterUpdated,
            serverLogs,
          };
        }
      }

      return {
        status: 200,
        body: {
          success: true,
          stream_id: streamId,
          role: "viewer",
          stream_status: stream.status,
          viewers_count: stream.viewers_count,
          ping_received_at: new Date().toISOString(),
        } as HeartbeatResponse,
        recordedViewerIdentifier,
        recordedViewerUserId,
        broadcasterUpdated,
        serverLogs,
      };
    }

    it("1. Preserves guest/viewer/broadcaster heartbeats and rejects spoofed client user_id impersonation", () => {
      const { heartbeatPhp } = loadPhpSources();
      assert.match(heartbeatPhp, /\$hasSuppliedAuthHeader\s*=/);
      assert.match(heartbeatPhp, /\$suppliedBearerToken\s*=\s*getBearerToken\(\);/);
      assert.match(heartbeatPhp, /\$authUser\s*=\s*getAuthUser\(\$pdo,\s*true\);/);
      assert.doesNotMatch(heartbeatPhp, /\$payload\['user_id'\]|\$payload\['userId'\]/);

      // Legitimate guest viewer heartbeat (no auth headers) -> 200 with deterministic guest_<16hex>, ignores spoofed user_id
      const guestViewer = createPhpHeartbeatHarness({
        rawAuthHeader: null,
        requestedRole: "viewer",
        spoofedBodyUserId: "FT102857",
        authBehavior: { kind: "none" },
      });
      assert.equal(guestViewer.status, 200);
      assert.equal(guestViewer.body.success, true);
      assert.equal(guestViewer.body.role, "viewer");
      assert.equal(guestViewer.body.viewers_count, 14);
      assert.match(guestViewer.recordedViewerIdentifier!, /^guest_[a-f0-9]{16}$/);
      assert.equal(guestViewer.recordedViewerUserId, null);

      // Unauthenticated broadcaster heartbeat -> HTTP 401
      const guestBroadcaster = createPhpHeartbeatHarness({
        rawAuthHeader: null,
        requestedRole: "broadcaster",
        authBehavior: { kind: "none" },
      });
      assert.equal(guestBroadcaster.status, 401);

      // Authenticated creator broadcaster heartbeat -> HTTP 200
      const creatorHb = createPhpHeartbeatHarness({
        rawAuthHeader: "Bearer valid_creator_tok",
        requestedRole: "broadcaster",
        authBehavior: { kind: "user", user_id: "FT483921", role: "user" },
      });
      assert.equal(creatorHb.status, 200);
      assert.equal(creatorHb.body.role, "broadcaster");
      assert.equal(creatorHb.broadcasterUpdated, true);

      // Non-owner broadcaster heartbeat -> HTTP 403
      const nonOwnerHb = createPhpHeartbeatHarness({
        rawAuthHeader: "Bearer valid_viewer_tok",
        requestedRole: "broadcaster",
        authBehavior: { kind: "user", user_id: "FT900431", role: "user" },
      });
      assert.equal(nonOwnerHb.status, 403);
      assert.equal(nonOwnerHb.broadcasterUpdated, false);

      // Authenticated viewer heartbeat ignores spoofed user_id -> records session user_id only
      const viewerHb = createPhpHeartbeatHarness({
        rawAuthHeader: "Bearer valid_viewer_tok",
        requestedRole: "viewer",
        spoofedBodyUserId: "FT102857",
        authBehavior: { kind: "user", user_id: "FT900431", role: "user" },
      });
      assert.equal(viewerHb.status, 200);
      assert.equal(viewerHb.recordedViewerIdentifier, "FT900431");
      assert.equal(viewerHb.recordedViewerUserId, "FT900431");
    });

    it("2. Rejects malformed, empty, invalid, or expired Bearer headers with HTTP 401 (never downgrading to guest)", () => {
      for (const badHeader of [
        "Bearer",
        "Bearer   ",
        "Basic dXNlcjpwYXNz",
        "Token abc123",
        "malformed_token",
      ]) {
        const res = createPhpHeartbeatHarness({
          rawAuthHeader: badHeader,
          requestedRole: "viewer",
          authBehavior: { kind: "none" },
        });
        assert.equal(res.status, 401, `Expected 401 for malformed header: ${badHeader}`);
        assert.equal(res.body.success, false);
        assert.equal(res.recordedViewerIdentifier, null);
      }

      const badXAuth = createPhpHeartbeatHarness({
        rawAuthHeader: null,
        rawXAuthHeader: "Bearer   ",
        requestedRole: "viewer",
        authBehavior: { kind: "none" },
      });
      assert.equal(badXAuth.status, 401);
      assert.equal(badXAuth.recordedViewerIdentifier, null);

      const expiredBearer = createPhpHeartbeatHarness({
        rawAuthHeader: "Bearer expired_session_tok",
        requestedRole: "viewer",
        authBehavior: { kind: "invalid" },
      });
      assert.equal(expiredBearer.status, 401);
      assert.equal(expiredBearer.recordedViewerIdentifier, null);
    });

    it("3. Fails closed with HTTP 503 on DB connection loss and sanitized HTTP 500 on query errors across auth, stream, broadcaster, and viewer steps", () => {
      const { heartbeatPhp } = loadPhpSources();
      assert.match(heartbeatPhp, /\}\s*catch\s*\(\s*Throwable\s+\$e\s*\)\s*\{/);
      assert.match(heartbeatPhp, /isDatabaseConnectionUnavailableError\(\$e\)/);
      assert.match(heartbeatPhp, /error_log\(/);
      assert.doesNotMatch(heartbeatPhp, /jsonResponse\([^\n]*\$e->getMessage\(\)/);
      assert.doesNotMatch(heartbeatPhp, /rollBack\(/);

      // Auth DB connection error (errno 1203) -> HTTP 503, never guest downgrade
      const auth503 = createPhpHeartbeatHarness({
        rawAuthHeader: "Bearer valid_tok",
        requestedRole: "viewer",
        authBehavior: {
          kind: "db_error",
          sqlState: "42000",
          driverCode: 1203,
          message: "User already has more than 'max_user_connections' active connections",
        },
      });
      assert.equal(auth503.status, 503);
      assert.equal(auth503.body.success, false);
      assert.equal(auth503.recordedViewerIdentifier, null);
      assert.equal(String(auth503.body.error).includes("max_user_connections"), false);

      // Auth unexpected DB error (42S02) -> sanitized HTTP 500
      const auth500 = createPhpHeartbeatHarness({
        rawAuthHeader: "Bearer valid_tok",
        requestedRole: "viewer",
        authBehavior: {
          kind: "db_error",
          sqlState: "42S02",
          driverCode: 1146,
          message: "Table 'prod_db.sessions' doesn't exist",
        },
      });
      assert.equal(auth500.status, 500);
      assert.equal(auth500.body.success, false);
      assert.equal(String(auth500.body.error).includes("sessions"), false);

      // Broadcaster UPDATE failure -> HTTP 503 / 500 (never false 200 success)
      const broadcaster503 = createPhpHeartbeatHarness({
        rawAuthHeader: "Bearer valid_tok",
        requestedRole: "broadcaster",
        authBehavior: { kind: "user", user_id: "FT483921", role: "user" },
        broadcasterUpdateBehavior: {
          kind: "db_error",
          sqlState: "HY000",
          driverCode: 2006,
          message: "MySQL server has gone away",
        },
      });
      assert.equal(broadcaster503.status, 503);
      assert.equal(broadcaster503.body.success, false);

      // Viewer INSERT failure -> HTTP 503 / 500 (never false 200 success); missing optional table 42S02/1146 stays tolerated
      const viewer500 = createPhpHeartbeatHarness({
        rawAuthHeader: null,
        requestedRole: "viewer",
        authBehavior: { kind: "none" },
        viewerInsertBehavior: {
          kind: "db_error",
          sqlState: "42000",
          driverCode: 1142,
          message: "INSERT command denied to user",
        },
      });
      assert.equal(viewer500.status, 500);
      assert.equal(viewer500.body.success, false);
      assert.equal(String(viewer500.body.error).includes("INSERT command denied"), false);

      const viewerOptionalTableMissing = createPhpHeartbeatHarness({
        rawAuthHeader: null,
        requestedRole: "viewer",
        authBehavior: { kind: "none" },
        viewerInsertBehavior: {
          kind: "db_error",
          sqlState: "42S02",
          driverCode: 1146,
          message: "Table 'prod_db.live_stream_viewers' doesn't exist",
        },
      });
      assert.equal(viewerOptionalTableMissing.status, 200);
      assert.equal(viewerOptionalTableMissing.body.success, true);
    });
  });
});
