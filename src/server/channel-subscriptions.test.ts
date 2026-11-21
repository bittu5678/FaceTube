import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { handleApiRequest } from "./api-handler";
import { getMysqlPool } from "./mysql";

describe("FaceTube Phase 3: Creator Channel Subscriptions Tests", () => {
  let adminToken = "";
  let userTokenAlex = "";
  let userTokenMaya = "";

  const alexUserId = "FT483921";
  const mayaUserId = "FT900431";
  const adminUserId = "FT102857";

  before(async () => {
    // 1. Authenticate as Admin (admin@facetube.com / FT102857)
    const adminLoginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "admin@facetube.com", password: "password" }),
      }),
    );
    assert.ok(adminLoginRes);
    const adminData = await adminLoginRes.json();
    assert.ok(adminData.token, "Admin login must provide token");
    adminToken = adminData.token;

    // 2. Authenticate as Standard User Alex Rivera (alex@facetube.com / FT483921)
    const alexLoginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
      }),
    );
    assert.ok(alexLoginRes);
    const alexData = await alexLoginRes.json();
    assert.ok(alexData.token, "Alex login must provide token");
    userTokenAlex = alexData.token;

    // 3. Authenticate as Standard User Maya Lin (maya@facetube.com / FT900431)
    const mayaLoginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "maya@facetube.com", password: "password123" }),
      }),
    );
    assert.ok(mayaLoginRes);
    const mayaData = await mayaLoginRes.json();
    assert.ok(mayaData.token, "Maya login must provide token");
    userTokenMaya = mayaData.token;
  });

  beforeEach(async () => {
    // Reset subscriptions in store
    const storePath = path.resolve(process.cwd(), "data/facetube_store.json");
    if (fs.existsSync(storePath)) {
      try {
        const store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
        store.channelSubscriptions = [];
        fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
      } catch (_e) {
        // Ignore file read/parse errors
      }
    }

    // Reset subscriptions in MySQL database if configured
    const pool = getMysqlPool();
    if (pool) {
      try {
        await pool.query("DELETE FROM channel_subscriptions");
      } catch (_e) {
        // Table may not exist yet in local testing environment
      }
    }
  });

  // ---------------------------------------------------------------------------
  // 1. Unauthenticated Requests (HTTP 401)
  // ---------------------------------------------------------------------------
  describe("1. Unauthenticated 401 Rejections", () => {
    it("rejects unauthenticated subscribe request with HTTP 401", async () => {
      const req = new Request("http://localhost:3000/api/channel/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creator_user_id: alexUserId }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /authentication required/i);
    });

    it("rejects unauthenticated unsubscribe request with HTTP 401", async () => {
      const req = new Request("http://localhost:3000/api/channel/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creator_user_id: alexUserId }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /authentication required/i);
    });

    it("rejects unauthenticated creator subscriber count query with HTTP 401", async () => {
      const req = new Request("http://localhost:3000/api/channel/subscribers", {
        method: "GET",
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /authentication required/i);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Public Status & Zero Count Baseline
  // ---------------------------------------------------------------------------
  describe("2. Public Channel Status & Zero Count Baseline", () => {
    it("returns HTTP 200 with zero subscriber count for a channel with no subscribers", async () => {
      const req = new Request(
        `http://localhost:3000/api/channel/status?creator_user_id=${alexUserId}`,
        { method: "GET" },
      );
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.authenticated, false);
      assert.equal(data.subscribed, false);
      assert.equal(data.subscriber_count, 0);
      assert.equal(data.is_self, false);
    });

    it("rejects status check when creator_user_id parameter is missing with HTTP 400", async () => {
      const req = new Request("http://localhost:3000/api/channel/status", {
        method: "GET",
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /creator user id is required/i);
    });

    it("detects is_self: true when creator checks their own channel status", async () => {
      const req = new Request(
        `http://localhost:3000/api/channel/status?creator_user_id=${alexUserId}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${userTokenAlex}` },
        },
      );
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.authenticated, true);
      assert.equal(data.is_self, true);
      assert.equal(data.subscribed, false);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Self-Subscription Prevention (HTTP 400)
  // ---------------------------------------------------------------------------
  describe("3. Self-Subscription Prevention", () => {
    it("rejects a creator subscribing to their own channel with HTTP 400", async () => {
      const req = new Request("http://localhost:3000/api/channel/subscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userTokenAlex}`,
        },
        body: JSON.stringify({ creator_user_id: alexUserId }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /cannot subscribe to your own channel/i);
    });

    it("rejects self-subscription case-insensitively", async () => {
      const req = new Request("http://localhost:3000/api/channel/subscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userTokenAlex}`,
        },
        body: JSON.stringify({ creator_user_id: alexUserId.toLowerCase() }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /cannot subscribe to your own channel/i);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Successful Subscription & Duplicate Prevention (Idempotency)
  // ---------------------------------------------------------------------------
  describe("4. Subscription Flow & Duplicate Prevention", () => {
    it("allows Maya to subscribe to Alex's channel with HTTP 200 and count = 1", async () => {
      const req = new Request("http://localhost:3000/api/channel/subscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userTokenMaya}`,
        },
        body: JSON.stringify({ creator_user_id: alexUserId }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.subscribed, true);
      assert.equal(data.subscriber_count, 1);

      // Verify status endpoint reflects subscription
      const statusReq = new Request(
        `http://localhost:3000/api/channel/status?creator_user_id=${alexUserId}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${userTokenMaya}` },
        },
      );
      const statusRes = await handleApiRequest(statusReq);
      assert.ok(statusRes);
      const statusData = await statusRes.json();
      assert.equal(statusData.subscribed, true);
      assert.equal(statusData.is_self, false);
      assert.equal(statusData.subscriber_count, 1);
    });

    it("prevents duplicate subscriptions and does not inflate subscriber count", async () => {
      // First subscription
      const req1 = new Request("http://localhost:3000/api/channel/subscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userTokenMaya}`,
        },
        body: JSON.stringify({ creator_user_id: alexUserId }),
      });
      const res1 = await handleApiRequest(req1);
      assert.ok(res1);
      const data1 = await res1.json();
      assert.equal(data1.subscriber_count, 1);

      // Duplicate subscription by same user
      const req2 = new Request("http://localhost:3000/api/channel/subscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userTokenMaya}`,
        },
        body: JSON.stringify({ creator_user_id: alexUserId }),
      });
      const res2 = await handleApiRequest(req2);
      assert.ok(res2);
      assert.equal(res2.status, 200);
      const data2 = await res2.json();
      assert.equal(data2.success, true);
      assert.equal(data2.subscribed, true);
      assert.equal(data2.subscriber_count, 1, "Duplicate subscription must not increment count");
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Creator Isolation on /api/channel/subscribers (HTTP 403 vs HTTP 200)
  // ---------------------------------------------------------------------------
  describe("5. Creator Isolation Enforcement", () => {
    it("allows a creator to inspect their own subscriber count", async () => {
      // Maya subscribes to Alex
      await handleApiRequest(
        new Request("http://localhost:3000/api/channel/subscribe", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userTokenMaya}`,
          },
          body: JSON.stringify({ creator_user_id: alexUserId }),
        }),
      );

      // Alex queries their own count
      const req = new Request("http://localhost:3000/api/channel/subscribers", {
        method: "GET",
        headers: { Authorization: `Bearer ${userTokenAlex}` },
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.creator_user_id, alexUserId);
      assert.equal(data.subscriber_count, 1);
    });

    it("rejects non-admin user querying another creator's subscriber count with HTTP 403", async () => {
      // Maya attempts to query Alex's subscriber count via /api/channel/subscribers
      const req = new Request(
        `http://localhost:3000/api/channel/subscribers?creator_user_id=${alexUserId}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${userTokenMaya}` },
        },
      );
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /forbidden.*only view your own creator subscriber count/i);
    });

    it("allows an admin user to inspect any creator's subscriber count with HTTP 200", async () => {
      // Admin queries Alex's subscriber count
      const req = new Request(
        `http://localhost:3000/api/channel/subscribers?creator_user_id=${alexUserId}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${adminToken}` },
        },
      );
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.creator_user_id, alexUserId);
      assert.equal(typeof data.subscriber_count, "number");
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Unsubscribe Flow & State Synchronization
  // ---------------------------------------------------------------------------
  describe("6. Unsubscribe Flow & State Synchronization", () => {
    it("allows Maya to unsubscribe from Alex with count decrementing to 0", async () => {
      // 1. Subscribe
      await handleApiRequest(
        new Request("http://localhost:3000/api/channel/subscribe", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userTokenMaya}`,
          },
          body: JSON.stringify({ creator_user_id: alexUserId }),
        }),
      );

      // 2. Unsubscribe
      const unsubReq = new Request("http://localhost:3000/api/channel/unsubscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userTokenMaya}`,
        },
        body: JSON.stringify({ creator_user_id: alexUserId }),
      });
      const unsubRes = await handleApiRequest(unsubReq);
      assert.ok(unsubRes);
      assert.equal(unsubRes.status, 200);
      const unsubData = await unsubRes.json();
      assert.equal(unsubData.success, true);
      assert.equal(unsubData.subscribed, false);
      assert.equal(unsubData.subscriber_count, 0);

      // 3. Status check confirms unsubscribed state
      const statusReq = new Request(
        `http://localhost:3000/api/channel/status?creator_user_id=${alexUserId}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${userTokenMaya}` },
        },
      );
      const statusRes = await handleApiRequest(statusReq);
      assert.ok(statusRes);
      const statusData = await statusRes.json();
      assert.equal(statusData.subscribed, false);
      assert.equal(statusData.subscriber_count, 0);

      // 4. Alex's creator subscriber count is 0
      const alexCountRes = await handleApiRequest(
        new Request("http://localhost:3000/api/channel/subscribers", {
          method: "GET",
          headers: { Authorization: `Bearer ${userTokenAlex}` },
        }),
      );
      assert.ok(alexCountRes);
      const alexCountData = await alexCountRes.json();
      assert.equal(alexCountData.subscriber_count, 0);
    });

    it("handles unsubscribing when not subscribed gracefully without error", async () => {
      const unsubReq = new Request("http://localhost:3000/api/channel/unsubscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userTokenMaya}`,
        },
        body: JSON.stringify({ creator_user_id: alexUserId }),
      });
      const unsubRes = await handleApiRequest(unsubReq);
      assert.ok(unsubRes);
      assert.equal(unsubRes.status, 200);
      const unsubData = await unsubRes.json();
      assert.equal(unsubData.success, true);
      assert.equal(unsubData.subscribed, false);
      assert.equal(unsubData.subscriber_count, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Task 5J-V4-W: PHP api/channel/status.php Auth & DB Fail-Closed Tests
  // ---------------------------------------------------------------------------
  describe("7. Task 5J-V4-W: PHP api/channel/status.php Auth & DB Fail-Closed Tests (Static + TS Simulation)", () => {
    interface SimUser {
      id: string;
      user_id: string;
      role: string;
    }

    interface SimSubscription {
      id: number;
      creator_user_id: string;
      subscriber_user_id: string;
    }

    function loadChannelStatusPhpSources() {
      const statusPhp = fs.readFileSync(
        path.resolve(process.cwd(), "api/channel/status.php"),
        "utf-8",
      );
      const responsePhp = fs.readFileSync(path.resolve(process.cwd(), "api/response.php"), "utf-8");
      return { statusPhp, responsePhp };
    }

    // TypeScript simulation harness mirroring api/channel/status.php control flow
    // (static/simulation coverage only — PHP CLI is unavailable in this environment).
    function createChannelStatusHarness(options: {
      method?: string;
      query?: Record<string, unknown>;
      bearerToken?: string | null;
      inTransaction?: boolean;
      dbConnectError?: { status: 500 | 503; error: string };
      authBehavior?:
        | { kind: "none" }
        | { kind: "invalid" }
        | { kind: "user"; user: SimUser }
        | {
            kind: "db_error";
            sqlState: string;
            driverCode: number;
            message: string;
            isRuntime?: boolean;
          };
      users?: SimUser[];
      subscriptions?: SimSubscription[];
      creatorQueryError?: {
        sqlState: string;
        driverCode: number;
        message: string;
        isRuntime?: boolean;
      };
      countQueryError?: {
        sqlState: string;
        driverCode: number;
        message: string;
        isRuntime?: boolean;
      };
      subCheckQueryError?: {
        sqlState: string;
        driverCode: number;
        message: string;
        isRuntime?: boolean;
      };
    }) {
      const { responsePhp } = loadChannelStatusPhpSources();
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

      const readStringField = (val: unknown, fallback = "") => {
        if (typeof val === "string" || typeof val === "number") {
          return String(val).trim();
        }
        return fallback;
      };

      const serverLogs: string[] = [];
      let dbConnected = false;
      let queriesExecuted = 0;
      let rollbackExecuted = false;
      const inTransaction = options.inTransaction ?? false;

      const safeRollback = () => {
        if (inTransaction) {
          rollbackExecuted = true;
        }
      };

      const method = options.method ?? "GET";
      if (method !== "GET") {
        return {
          status: 405,
          body: { success: false, error: "Method Not Allowed" },
          dbConnected,
          queriesExecuted,
          rollbackExecuted,
          serverLogs,
        };
      }

      const q = options.query ?? {};
      const rawCreator = q["creator_user_id"] ?? q["creatorId"] ?? q["creator_id"] ?? "";
      let creatorUserId = readStringField(rawCreator);
      if (creatorUserId === "") {
        return {
          status: 400,
          body: { success: false, error: "Creator user ID is required." },
          dbConnected,
          queriesExecuted,
          rollbackExecuted,
          serverLogs,
        };
      }

      dbConnected = true;
      if (options.dbConnectError) {
        return {
          status: options.dbConnectError.status,
          body: { success: false, error: options.dbConnectError.error },
          dbConnected,
          queriesExecuted,
          rollbackExecuted,
          serverLogs,
        };
      }

      const suppliedBearerToken = options.bearerToken ?? null;
      let authUser: SimUser | null = null;
      const authBehavior = options.authBehavior ?? { kind: "none" };
      try {
        if (suppliedBearerToken !== null && suppliedBearerToken.trim() !== "") {
          if (authBehavior.kind === "user") {
            authUser = authBehavior.user;
          } else if (authBehavior.kind === "db_error") {
            throw authBehavior;
          } else {
            authUser = null;
          }
        }
      } catch (e: unknown) {
        safeRollback();
        const err = e as {
          sqlState?: string;
          driverCode?: number;
          message?: string;
          isRuntime?: boolean;
        };
        serverLogs.push(`[channel/status.php][AUTH] Database error: ${err.message || ""}`);
        if (
          !err.isRuntime &&
          isConnUnavailable(err.sqlState || "", err.driverCode || 0, err.message || "")
        ) {
          return {
            status: 503,
            body: {
              success: false,
              error: "Database connection unavailable during authentication check.",
            },
            dbConnected,
            queriesExecuted,
            rollbackExecuted,
            serverLogs,
          };
        }
        return {
          status: 500,
          body: {
            success: false,
            error: "Database error during authentication check.",
          },
          dbConnected,
          queriesExecuted,
          rollbackExecuted,
          serverLogs,
        };
      }

      if (
        suppliedBearerToken !== null &&
        suppliedBearerToken.trim() !== "" &&
        (!authUser || !authUser.user_id)
      ) {
        return {
          status: 401,
          body: {
            success: false,
            error: "Invalid or expired authentication session. Please log in again.",
          },
          dbConnected,
          queriesExecuted,
          rollbackExecuted,
          serverLogs,
        };
      }

      try {
        queriesExecuted += 1;
        if (options.creatorQueryError) {
          throw options.creatorQueryError;
        }
        const matchedCreator = (options.users ?? []).find(
          (u) =>
            u.user_id.toUpperCase() === creatorUserId.toUpperCase() ||
            u.id.toUpperCase() === creatorUserId.toUpperCase(),
        );
        if (matchedCreator && matchedCreator.user_id) {
          creatorUserId = matchedCreator.user_id.trim();
        }

        queriesExecuted += 1;
        if (options.countQueryError) {
          throw options.countQueryError;
        }
        const subs = options.subscriptions ?? [];
        const subscriberCount = new Set(
          subs
            .filter((s) => s.creator_user_id.toUpperCase() === creatorUserId.toUpperCase())
            .map((s) => s.subscriber_user_id.toUpperCase()),
        ).size;

        if (!authUser) {
          return {
            status: 200,
            body: {
              success: true,
              authenticated: false,
              subscribed: false,
              creator_user_id: creatorUserId,
              subscriber_count: subscriberCount,
              is_self: false,
            },
            dbConnected,
            queriesExecuted,
            rollbackExecuted,
            serverLogs,
          };
        }

        const subscriberUserId = authUser.user_id.trim();
        if (subscriberUserId === "") {
          return {
            status: 401,
            body: {
              success: false,
              error: "Invalid or expired authentication session. Please log in again.",
            },
            dbConnected,
            queriesExecuted,
            rollbackExecuted,
            serverLogs,
          };
        }

        const isSelf = subscriberUserId.toLowerCase() === creatorUserId.toLowerCase();

        queriesExecuted += 1;
        if (options.subCheckQueryError) {
          throw options.subCheckQueryError;
        }
        const isSubscribed = subs.some(
          (s) =>
            s.creator_user_id.toUpperCase() === creatorUserId.toUpperCase() &&
            s.subscriber_user_id.toUpperCase() === subscriberUserId.toUpperCase(),
        );

        return {
          status: 200,
          body: {
            success: true,
            authenticated: true,
            subscribed: isSubscribed,
            creator_user_id: creatorUserId,
            subscriber_count: subscriberCount,
            is_self: isSelf,
          },
          dbConnected,
          queriesExecuted,
          rollbackExecuted,
          serverLogs,
        };
      } catch (e: unknown) {
        safeRollback();
        const err = e as {
          sqlState?: string;
          driverCode?: number;
          message?: string;
          isRuntime?: boolean;
        };
        serverLogs.push(`[channel/status.php] Database error: ${err.message || ""}`);
        if (
          !err.isRuntime &&
          isConnUnavailable(err.sqlState || "", err.driverCode || 0, err.message || "")
        ) {
          return {
            status: 503,
            body: {
              success: false,
              error: "Database connection unavailable while checking channel status.",
            },
            dbConnected,
            queriesExecuted,
            rollbackExecuted,
            serverLogs,
          };
        }
        return {
          status: 500,
          body: {
            success: false,
            error: "Failed to check channel status due to a server error.",
          },
          dbConnected,
          queriesExecuted,
          rollbackExecuted,
          serverLogs,
        };
      }
    }

    const simAlex: SimUser = { id: "uuid-alex", user_id: "FT483921", role: "user" };
    const simMaya: SimUser = { id: "uuid-maya", user_id: "FT900431", role: "user" };
    const simAdmin: SimUser = { id: "uuid-admin", user_id: "FT102857", role: "admin" };
    const simSubs: SimSubscription[] = [
      { id: 1, creator_user_id: "FT483921", subscriber_user_id: "FT900431" },
    ];

    it("[Static] 1. api/channel/status.php enforces GET-only 405, scalar validation, fail-closed getAuthUser($pdo, true), 401 token check, prepare/execute checks, and sanitized 503/500 handling", () => {
      const { statusPhp } = loadChannelStatusPhpSources();

      // Method guard and creator_user_id validation precede getDatabaseConnection()
      const methodIdx = statusPhp.indexOf("$method = $_SERVER['REQUEST_METHOD']");
      const inputIdx = statusPhp.indexOf("$creatorUserId = $readStringField(");
      const dbIdx = statusPhp.indexOf("$pdo = getDatabaseConnection()");
      assert.ok(methodIdx !== -1 && inputIdx !== -1 && dbIdx !== -1);
      assert.ok(methodIdx < inputIdx && inputIdx < dbIdx);

      // Enforces 405 and 400 and avoids unguarded trim($_GET[...])
      assert.match(statusPhp, /if\s*\(\s*\$method\s*!==\s*'GET'\s*\)/);
      assert.match(statusPhp, /405/);
      assert.match(statusPhp, /400/);
      assert.doesNotMatch(statusPhp, /trim\s*\(\s*\$_GET/);
      assert.match(
        statusPhp,
        /is_string\(\$val\)\s*\|\|\s*is_int\(\$val\)\s*\|\|\s*is_float\(\$val\)/,
      );

      // Fail-closed auth with getAuthUser($pdo, true) and 401 non-downgrade
      assert.match(statusPhp, /\$suppliedBearerToken\s*=\s*getBearerToken\(\)/);
      assert.match(statusPhp, /getAuthUser\s*\(\s*\$pdo\s*,\s*true\s*\)/);
      assert.doesNotMatch(statusPhp, /getAuthUser\s*\(\s*\$pdo\s*\)/);
      assert.match(statusPhp, /401/);

      const tokenRejectIdx = statusPhp.indexOf("Invalid or expired authentication session");
      const anonBlockIdx = statusPhp.indexOf("if (!$authUser)");
      assert.ok(tokenRejectIdx !== -1 && anonBlockIdx !== -1 && tokenRejectIdx < anonBlockIdx);

      // Checks prepare/execute/FETCH_ASSOC on all 3 queries
      assert.match(statusPhp, /\$stmtCreator\s*===\s*false/);
      assert.match(statusPhp, /\$stmtCreator->execute\([^)]*\)\s*===\s*false/);
      assert.match(statusPhp, /\$stmtCount\s*===\s*false/);
      assert.match(statusPhp, /\$stmtCount->execute\([^)]*\)\s*===\s*false/);
      assert.match(statusPhp, /\$stmtCheck\s*===\s*false/);
      assert.match(statusPhp, /\$stmtCheck->execute\([^)]*\)\s*===\s*false/);
      assert.match(statusPhp, /PDO::FETCH_ASSOC/);

      // Throwable + conditional rollback + error_log + 503/500 without $e->getMessage() leakage
      assert.match(statusPhp, /catch\s*\(\s*Throwable\s+\$e\s*\)/);
      assert.doesNotMatch(statusPhp, /catch\s*\(\s*PDOException\s+\$e\s*\)/);
      assert.match(
        statusPhp,
        /if\s*\(\s*\$conn->inTransaction\(\)\s*\)\s*\{\s*\$conn->rollBack\(\)/,
      );
      assert.match(statusPhp, /\$safeRollback\s*\(\s*\$pdo\s*\)/);
      assert.match(statusPhp, /error_log\s*\(/);
      assert.match(statusPhp, /503/);
      assert.match(statusPhp, /500/);
      assert.doesNotMatch(statusPhp, /jsonResponse\([^;]*\$e->getMessage\(\)/);
      assert.doesNotMatch(
        statusPhp,
        /\$_(?:GET|POST|REQUEST)\s*\[\s*['"](?:subscriber_user_id|user_id)['"]\s*\]/,
      );
    });

    it("[TS Simulation] 2. Preserves anonymous public status, authenticated subscriber status, and self/admin status", () => {
      // Anonymous public access using creator UUID alias resolves canonical FT ID and count
      const pubRes = createChannelStatusHarness({
        query: { creatorId: "UUID-ALEX" },
        bearerToken: null,
        users: [simAlex, simMaya],
        subscriptions: simSubs,
      });
      assert.equal(pubRes.status, 200);
      assert.deepEqual(pubRes.body, {
        success: true,
        authenticated: false,
        subscribed: false,
        creator_user_id: "FT483921",
        subscriber_count: 1,
        is_self: false,
      });

      // Authenticated subscribed user Maya
      const subRes = createChannelStatusHarness({
        query: { creator_user_id: "ft483921" },
        bearerToken: "tok-maya",
        authBehavior: { kind: "user", user: simMaya },
        users: [simAlex, simMaya],
        subscriptions: simSubs,
      });
      assert.equal(subRes.status, 200);
      assert.deepEqual(subRes.body, {
        success: true,
        authenticated: true,
        subscribed: true,
        creator_user_id: "FT483921",
        subscriber_count: 1,
        is_self: false,
      });

      // Self channel check (Alex checking Alex)
      const selfRes = createChannelStatusHarness({
        query: { creator_id: "FT483921" },
        bearerToken: "tok-alex",
        authBehavior: { kind: "user", user: simAlex },
        users: [simAlex, simMaya],
        subscriptions: simSubs,
      });
      assert.equal(selfRes.status, 200);
      assert.deepEqual(selfRes.body, {
        success: true,
        authenticated: true,
        subscribed: false,
        creator_user_id: "FT483921",
        subscriber_count: 1,
        is_self: true,
      });

      // Admin checking Alex's channel (is_self: false, authenticated as admin)
      const adminRes = createChannelStatusHarness({
        query: { creator_user_id: "FT483921" },
        bearerToken: "tok-admin",
        authBehavior: { kind: "user", user: simAdmin },
        users: [simAlex, simMaya, simAdmin],
        subscriptions: simSubs,
      });
      assert.equal(adminRes.status, 200);
      assert.deepEqual(adminRes.body, {
        success: true,
        authenticated: true,
        subscribed: false,
        creator_user_id: "FT483921",
        subscriber_count: 1,
        is_self: false,
      });
    });

    it("[TS Simulation] 3. Rejects non-GET methods (405) and missing/empty/array creator IDs (400) before DB connection", () => {
      for (const method of ["POST", "PUT", "DELETE"]) {
        const mRes = createChannelStatusHarness({
          method,
          query: { creator_user_id: "FT483921" },
        });
        assert.equal(mRes.status, 405);
        assert.equal(mRes.dbConnected, false);
      }

      for (const query of [
        {},
        { creator_user_id: "" },
        { creator_user_id: "   " },
        { creator_user_id: ["FT483921"] },
        { creatorId: { nested: "FT483921" } },
      ]) {
        const qRes = createChannelStatusHarness({ query });
        assert.equal(qRes.status, 400);
        assert.equal(qRes.dbConnected, false);
      }
    });

    it("[TS Simulation] 4. Rejects invalid or expired supplied Bearer token with HTTP 401 without downgrading to anonymous public access", () => {
      const expiredRes = createChannelStatusHarness({
        query: { creator_user_id: "FT483921" },
        bearerToken: "expired-or-tampered-tok",
        authBehavior: { kind: "invalid" },
        users: [simAlex, simMaya],
        subscriptions: simSubs,
      });
      assert.equal(expiredRes.status, 401);
      assert.equal(expiredRes.queriesExecuted, 0);
      assert.equal((expiredRes.body as { authenticated?: unknown }).authenticated, undefined);

      // Edge case: session row missing user_id also fails closed with 401
      const emptyUserIdRes = createChannelStatusHarness({
        query: { creator_user_id: "FT483921" },
        bearerToken: "tok-corrupt",
        authBehavior: { kind: "user", user: { id: "uuid-x", user_id: "", role: "user" } },
        users: [simAlex],
        subscriptions: simSubs,
      });
      assert.equal(emptyUserIdRes.status, 401);
      assert.equal(emptyUserIdRes.queriesExecuted, 0);
    });

    it("[TS Simulation] 5. Fails closed on auth and query DB connection failures (503) and unexpected runtime/query errors (sanitized 500) without leaking details", () => {
      // Auth DB connection error -> 503 (never downgraded to 200 authenticated: false)
      const auth503 = createChannelStatusHarness({
        query: { creator_user_id: "FT483921" },
        bearerToken: "tok-maya",
        inTransaction: false,
        authBehavior: {
          kind: "db_error",
          sqlState: "HY000",
          driverCode: 1203,
          message: "SQLSTATE[HY000] [1203] max_user_connections exceeded for u123",
        },
        users: [simAlex],
        subscriptions: simSubs,
      });
      assert.equal(auth503.status, 503);
      assert.equal(auth503.queriesExecuted, 0);
      assert.equal(auth503.rollbackExecuted, false);
      assert.equal(auth503.serverLogs.length, 1);
      assert.doesNotMatch(JSON.stringify(auth503.body), /max_user_connections|u123|1203|SQLSTATE/i);

      // Unexpected auth query error -> sanitized 500
      const auth500 = createChannelStatusHarness({
        query: { creator_user_id: "FT483921" },
        bearerToken: "secret-status-token",
        authBehavior: {
          kind: "db_error",
          sqlState: "42S02",
          driverCode: 1146,
          message: "SQLSTATE[42S02]: Table 'u999.sessions' doesn't exist",
        },
      });
      assert.equal(auth500.status, 500);
      assert.equal(auth500.queriesExecuted, 0);
      assert.doesNotMatch(
        JSON.stringify(auth500.body),
        /SQLSTATE|u999|sessions|1146|secret-status-token/i,
      );

      // Creator lookup connection error -> 503
      const creator503 = createChannelStatusHarness({
        query: { creator_user_id: "FT483921" },
        bearerToken: null,
        creatorQueryError: {
          sqlState: "08S01",
          driverCode: 2006,
          message: "MySQL server has gone away",
        },
      });
      assert.equal(creator503.status, 503);
      assert.equal(creator503.serverLogs.length, 1);

      // Count query failure -> sanitized 500 (never returns subscriber_count: 0 with 200)
      const count500 = createChannelStatusHarness({
        query: { creator_user_id: "FT483921" },
        bearerToken: null,
        inTransaction: true,
        countQueryError: {
          sqlState: "42S02",
          driverCode: 1146,
          message: "Table 'facetube.channel_subscriptions' doesn't exist",
        },
      });
      assert.equal(count500.status, 500);
      assert.equal(count500.rollbackExecuted, true);
      assert.equal((count500.body as { subscriber_count?: unknown }).subscriber_count, undefined);
      assert.doesNotMatch(JSON.stringify(count500.body), /channel_subscriptions|facetube|1146/i);

      // Subscription check runtime error -> sanitized 500 (never returns subscribed: false with 200)
      const subCheck500 = createChannelStatusHarness({
        query: { creator_user_id: "FT483921" },
        bearerToken: "tok-maya",
        authBehavior: { kind: "user", user: simMaya },
        users: [simAlex, simMaya],
        subscriptions: simSubs,
        subCheckQueryError: {
          sqlState: "HY000",
          driverCode: 0,
          message: "Failed to prepare subscription check query on db-internal.",
          isRuntime: true,
        },
      });
      assert.equal(subCheck500.status, 500);
      assert.equal((subCheck500.body as { subscribed?: unknown }).subscribed, undefined);
      assert.doesNotMatch(JSON.stringify(subCheck500.body), /db-internal|prepare subscription/i);
    });

    it("[TS Simulation] 6. Ignores client-supplied subscriber_user_id and user_id query parameters (prevents spoofing)", () => {
      // Anonymous request attempting to query Maya's subscription status via query params
      const anonSpoof = createChannelStatusHarness({
        query: {
          creator_user_id: "FT483921",
          subscriber_user_id: "FT900431",
          user_id: "FT900431",
        },
        bearerToken: null,
        users: [simAlex, simMaya],
        subscriptions: simSubs,
      });
      assert.equal(anonSpoof.status, 200);
      assert.equal((anonSpoof.body as { authenticated: boolean }).authenticated, false);
      assert.equal((anonSpoof.body as { subscribed: boolean }).subscribed, false);

      // Authenticated unsubscribed admin passing Maya's subscriber_user_id still only checks admin's own session
      const adminSpoof = createChannelStatusHarness({
        query: {
          creator_user_id: "FT483921",
          subscriber_user_id: "FT900431",
          user_id: "FT900431",
        },
        bearerToken: "tok-admin",
        authBehavior: { kind: "user", user: simAdmin },
        users: [simAlex, simMaya, simAdmin],
        subscriptions: simSubs,
      });
      assert.equal(adminSpoof.status, 200);
      assert.equal((adminSpoof.body as { authenticated: boolean }).authenticated, true);
      assert.equal((adminSpoof.body as { subscribed: boolean }).subscribed, false);
    });
  });
});
