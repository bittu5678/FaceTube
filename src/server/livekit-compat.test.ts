import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { handleApiRequest, base64UrlEncode } from "./api-handler.ts";
import { setMysqlPoolForTesting } from "./mysql.ts";

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), "utf-8");
}

function createSignedWebhookJwt(rawBody: string, secret: string): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const sha256 = crypto.createHash("sha256").update(rawBody).digest("base64");
  const payload = base64UrlEncode(
    JSON.stringify({
      iss: "lk_api_key_test",
      nbf: now - 5,
      exp: now + 300,
      sha256,
    }),
  );
  const sig = base64UrlEncode(
    crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${sig}`;
}

describe("LiveKit Phase 2: PHP & Node Backend Compatibility Verification", () => {
  const storePath = path.resolve(process.cwd(), "data/facetube_store.json");
  const initialStoreHash = fs.existsSync(storePath)
    ? crypto.createHash("sha256").update(fs.readFileSync(storePath)).digest("hex")
    : null;

  afterEach(() => {
    setMysqlPoolForTesting(null);
    if (initialStoreHash !== null && fs.existsSync(storePath)) {
      const currentHash = crypto
        .createHash("sha256")
        .update(fs.readFileSync(storePath))
        .digest("hex");
      assert.equal(currentHash, initialStoreHash, "Persistent JSON store must never be modified");
    }
  });

  describe("Task 1 & Task 4: PHP Bootstrap, CORS, Auth Forwarding & PHP 8.0+ Documentation", () => {
    it("loads .env files before requiring response.php (handleCors) and documents PHP 8.0+ requirement", () => {
      const dbPhp = readRepoFile("api/config/database.php");
      const lastLoadEnvPos = dbPhp.lastIndexOf("loadEnvFile(");
      const requireResponsePos = dbPhp.indexOf("require_once __DIR__ . '/../response.php';");
      assert.ok(lastLoadEnvPos > 0, "database.php must invoke loadEnvFile()");
      assert.ok(requireResponsePos > 0, "database.php must require response.php");
      assert.ok(
        requireResponsePos > lastLoadEnvPos,
        "response.php (which executes handleCors) must be required strictly after all loadEnvFile() calls",
      );
      assert.match(dbPhp, /PHP 8\.0\+/);
    });

    it("prevents duplicate CORS initialization, preserves strict origin policy, and handles REDIRECT_ X-Authorization variants", () => {
      const responsePhp = readRepoFile("api/response.php");
      const htaccess = readRepoFile("api/.htaccess");

      assert.match(responsePhp, /static \$corsHandled = false;/);
      assert.match(responsePhp, /'https:\/\/facetube\.online'/);
      assert.match(responsePhp, /'https:\/\/www\.facetube\.online'/);
      assert.doesNotMatch(responsePhp, /Access-Control-Allow-Origin:\s*\*/);
      assert.match(responsePhp, /REDIRECT_REDIRECT_HTTP_X_AUTHORIZATION/);
      assert.match(responsePhp, /JSON_INVALID_UTF8_SUBSTITUTE/);
      assert.match(htaccess, /RewriteCond %\{HTTP:X-Authorization\} \./);
      assert.match(htaccess, /E=HTTP_X_AUTHORIZATION:%\{HTTP:X-Authorization\}/);
    });
  });

  describe("Task 2: PHP LiveKit Schema Compatibility & Response Contracts", () => {
    it("streams.php supports VARCHAR(64) string IDs, single-quoted SQL literals, optional-column fallback, and sanitized logging", () => {
      const streamsPhp = readRepoFile("api/live/streams.php");

      assert.doesNotMatch(streamsPhp, /lastInsertId\s*\(/);
      assert.doesNotMatch(streamsPhp, /IN\s*\(\s*"live"/);
      assert.doesNotMatch(streamsPhp, /jsonResponse\([^\n]*\$e->getMessage\(\)/);
      assert.match(streamsPhp, /\$streamId\s*=\s*'live_'/);
      assert.match(streamsPhp, /WHERE s\.status IN \('live', 'upcoming'\)/);
      assert.match(streamsPhp, /\bchannel_name\|channel_logo_url\|playback_url\|updated_at\b/);
      assert.match(streamsPhp, /error_log\(/);
    });

    it("webhook.php uses string VARCHAR(64) stream IDs without CAST(? AS UNSIGNED) and uses single-quoted SQL literals", () => {
      const webhookPhp = readRepoFile("api/live/webhook.php");

      assert.doesNotMatch(webhookPhp, /CAST\(\?\s+AS\s+UNSIGNED\)/i);
      assert.doesNotMatch(webhookPhp, /"ended"/);
      assert.match(webhookPhp, /WHERE id = \?/);
      assert.match(webhookPhp, /status <> 'ended'/);
      assert.match(webhookPhp, /SET status = 'ended'/);
      assert.match(webhookPhp, /REDIRECT_REDIRECT_HTTP_AUTHORIZATION/);
      assert.match(webhookPhp, /error_log\(/);
    });

    it("token.php, heartbeat.php, and end-stream.php align SQL literals, screen_share, active_viewers, and sanitized errors", () => {
      const tokenPhp = readRepoFile("api/live/token.php");
      const heartbeatPhp = readRepoFile("api/live/heartbeat.php");
      const endStreamPhp = readRepoFile("api/live/end-stream.php");

      assert.doesNotMatch(tokenPhp, /CONCAT\("room_"/);
      assert.match(tokenPhp, /CONCAT\('room_', id\)/);
      assert.match(
        tokenPhp,
        /'canPublishSources'\s*=>\s*\['camera', 'microphone', 'screen_share'\]/,
      );
      assert.match(tokenPhp, /'expires_at'\s*=>/);
      assert.match(tokenPhp, /'server_configured'\s*=>\s*true/);

      assert.match(heartbeatPhp, /'active_viewers'\s*=>\s*intval\(\$stream\['viewers_count'\]\)/);
      assert.match(heartbeatPhp, /REDIRECT_REDIRECT_HTTP_X_AUTHORIZATION/);

      assert.doesNotMatch(endStreamPhp, /"ended"/);
      assert.doesNotMatch(endStreamPhp, /jsonResponse\([^\n]*\$e->getMessage\(\)/);
      assert.match(endStreamPhp, /SET status = 'ended'/);
      assert.match(endStreamPhp, /error_log\(/);
    });
  });

  describe("Task 3: Node LiveKit MySQL Schema Alignment, CORS & JSON Handling", () => {
    const prodSecret = "phase2-compat-webhook-secret-999";
    const prodEnv = {
      APP_ENV: "production",
      LIVEKIT_API_SECRET: prodSecret,
    };

    const savedDbHost = process.env["DB_HOST"];
    const savedDbName = process.env["DB_NAME"];
    const savedDbUser = process.env["DB_USER"];

    const enableMockDb = (mockPool: any) => {
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";
      setMysqlPoolForTesting(mockPool);
    };

    afterEach(() => {
      if (savedDbHost === undefined) delete process.env["DB_HOST"];
      else process.env["DB_HOST"] = savedDbHost;
      if (savedDbName === undefined) delete process.env["DB_NAME"];
      else process.env["DB_NAME"] = savedDbName;
      if (savedDbUser === undefined) delete process.env["DB_USER"];
      else process.env["DB_USER"] = savedDbUser;
    });

    const mockAuthRow = {
      id: "u-uuid-creator-1",
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
    };

    it("includes X-Authorization in Node OPTIONS and JSON CORS headers", async () => {
      const optRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/token", { method: "OPTIONS" }),
        prodEnv,
      );
      assert.equal(optRes?.status, 204);
      assert.match(
        optRes?.headers.get("Access-Control-Allow-Headers") || "",
        /\bX-Authorization\b/,
      );

      enableMockDb({
        query: async () => [[], []],
      } as any);

      const errRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/token", { method: "POST" }),
        prodEnv,
      );
      assert.equal(errRes?.status, 401);
      assert.match(
        errRes?.headers.get("Access-Control-Allow-Headers") || "",
        /\bX-Authorization\b/,
      );
    });

    it("handles malformed JSON safely with 400 and omits fake oceans.mp4 default playback_url in POST /api/live/streams", async () => {
      const executed: Array<{ sql: string; params: unknown[] }> = [];
      enableMockDb({
        query: async (sql: string, params: unknown[] = []) => {
          executed.push({ sql, params });
          if (/FROM\s+sessions/i.test(sql)) {
            return [[mockAuthRow], []];
          }
          if (/INSERT\s+INTO\s+live_streams/i.test(sql)) {
            return [{ affectedRows: 1 }, []];
          }
          return [[], []];
        },
      } as any);

      const malformedRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/streams", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Authorization": "Bearer valid_creator_tok",
          },
          body: "{broken-json",
        }),
        prodEnv,
      );
      assert.equal(malformedRes?.status, 400);
      const malformedData = (await malformedRes!.json()) as any;
      assert.equal(malformedData.success, false);

      const createRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/streams", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer valid_creator_tok",
          },
          body: JSON.stringify({ title: "Phase 2 Clean Stream" }),
        }),
        prodEnv,
      );
      assert.equal(createRes?.status, 201);
      const createData = (await createRes!.json()) as any;
      assert.equal(createData.stream.playback_url, "");
      assert.doesNotMatch(String(createData.stream.playback_url), /oceans\.mp4/);
    });

    it("uses migration-exact live_stream_viewers columns in live/heartbeat", async () => {
      const queries: Array<{ sql: string; params: unknown[] }> = [];
      enableMockDb({
        query: async (sql: string, params: unknown[] = []) => {
          queries.push({ sql, params });
          if (/FROM\s+sessions/i.test(sql)) {
            return [[{ ...mockAuthRow, user_id: "FT900431", name: "Maya Lin" }], []];
          }
          if (/FROM\s+live_streams/i.test(sql)) {
            return [
              [
                {
                  id: "live_1730000000_abc123",
                  user_id: "FT483921",
                  status: "live",
                  viewers_count: 3,
                },
              ],
              [],
            ];
          }
          return [{ affectedRows: 1 }, []];
        },
      } as any);

      const hbRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/heartbeat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer valid_viewer_tok",
          },
          body: JSON.stringify({ streamId: "live_1730000000_abc123", role: "viewer" }),
        }),
        prodEnv,
      );
      assert.equal(hbRes?.status, 200);

      const viewerInsert = queries.find((q) => /INSERT\s+INTO\s+live_stream_viewers/i.test(q.sql));
      assert.ok(viewerInsert, "Expected INSERT INTO live_stream_viewers query");
      assert.match(
        viewerInsert.sql,
        /\(id,\s*stream_id,\s*viewer_identifier,\s*user_id,\s*joined_at,\s*last_ping_at\)/i,
      );
      assert.match(viewerInsert.sql, /ON DUPLICATE KEY UPDATE last_ping_at = NOW\(\)/i);
      assert.doesNotMatch(viewerInsert.sql, /last_heartbeat_at/i);
      assert.equal(viewerInsert.params.length, 4);
      assert.match(String(viewerInsert.params[0]), /^vw_[a-f0-9]{32}$/);
      assert.equal(viewerInsert.params[1], "live_1730000000_abc123");
      assert.equal(viewerInsert.params[2], "FT900431");
      assert.equal(viewerInsert.params[3], "FT900431");
    });

    it("uses migration-exact livekit_webhook_events columns in live/webhook while preserving signature & idempotency", async () => {
      const queries: Array<{ sql: string; params: unknown[] }> = [];
      let seenEvent = false;
      enableMockDb({
        query: async (sql: string, params: unknown[] = []) => {
          queries.push({ sql, params });
          if (/SELECT event_id FROM livekit_webhook_events/i.test(sql)) {
            return [seenEvent ? [{ event_id: params[0] }] : [], []];
          }
          if (/INSERT INTO livekit_webhook_events/i.test(sql)) {
            seenEvent = true;
            return [{ affectedRows: 1 }, []];
          }
          if (/FROM\s+live_streams/i.test(sql)) {
            return [
              [
                {
                  id: "live_1730000000_abc123",
                  user_id: "FT483921",
                  status: "live",
                  viewers_count: 1,
                  livekit_room_name: "room_live_1730000000_abc123",
                },
              ],
              [],
            ];
          }
          return [{ affectedRows: 1 }, []];
        },
      } as any);

      const rawBody = JSON.stringify({
        id: "EV_COMPAT_001",
        event: "participant_joined",
        room: { name: "room_live_1730000000_abc123", numParticipants: 4 },
      });

      const res1 = await handleApiRequest(
        new Request("http://localhost:3000/api/live/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${createSignedWebhookJwt(rawBody, prodSecret)}`,
          },
          body: rawBody,
        }),
        prodEnv,
      );
      assert.equal(res1?.status, 200);

      const selectEvt = queries.find((q) => /FROM livekit_webhook_events/i.test(q.sql));
      assert.ok(selectEvt);
      assert.match(selectEvt.sql, /SELECT event_id FROM livekit_webhook_events/i);

      const insertEvt = queries.find((q) => /INSERT INTO livekit_webhook_events/i.test(q.sql));
      assert.ok(insertEvt);
      assert.match(
        insertEvt.sql,
        /\(event_id,\s*event_type,\s*room_name,\s*payload_hash,\s*created_at\)/i,
      );
      assert.doesNotMatch(insertEvt.sql, /raw_payload|processed_at/i);
      assert.equal(insertEvt.params[3], crypto.createHash("sha256").update(rawBody).digest("hex"));

      // Duplicate delivery must return idempotent 200 without re-updating live_streams
      const countBeforeDup = queries.length;
      const res2 = await handleApiRequest(
        new Request("http://localhost:3000/api/live/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${createSignedWebhookJwt(rawBody, prodSecret)}`,
          },
          body: rawBody,
        }),
        prodEnv,
      );
      assert.equal(res2?.status, 200);
      const dupData = (await res2!.json()) as any;
      assert.equal(dupData.duplicate, true);
      assert.equal(dupData.idempotent, true);
      assert.equal(
        queries.slice(countBeforeDup).some((q) => /UPDATE live_streams/i.test(q.sql)),
        false,
      );
    });
  });
});
