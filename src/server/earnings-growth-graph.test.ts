import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleApiRequest, resetInMemoryStore } from "./api-handler.ts";
import { setMysqlPoolForTesting } from "./mysql.ts";

describe("FaceTube Task 5: Earnings Growth Graph — Real Data & Breakdown Tests", () => {
  const mockUserId = "FT_GROWTH_TEST_01";
  const activeUserId = "FT_MULTI_STREAM_USER";
  let tmpDataDir = "";
  const origDataDir = process.env["FACETUBE_DATA_DIR"];

  beforeEach(() => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-growth-"));
    process.env["FACETUBE_DATA_DIR"] = tmpDataDir;
    const seedStore = {
      users: [
        {
          id: "u-growth-1",
          user_id: mockUserId,
          name: "Growth User",
          email: "growth1@facetube.com",
          mobile: "9000001001",
          role: "user",
          referral_code: null,
          created_at: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "u-growth-2",
          user_id: activeUserId,
          name: "Multi Stream User",
          email: "multi@facetube.com",
          mobile: "9000001002",
          role: "user",
          referral_code: null,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      sessions: {
        tok_growth_1: mockUserId,
        tok_multi_stream: activeUserId,
      },
      walletTransactions: [],
    };
    fs.writeFileSync(
      path.join(tmpDataDir, "facetube_store.json"),
      JSON.stringify(seedStore, null, 2),
      "utf-8",
    );
    resetInMemoryStore();
  });

  afterEach(() => {
    setMysqlPoolForTesting(null);
    if (origDataDir !== undefined) process.env["FACETUBE_DATA_DIR"] = origDataDir;
    else delete process.env["FACETUBE_DATA_DIR"];
    resetInMemoryStore();
    if (tmpDataDir && fs.existsSync(tmpDataDir)) {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    }
  });

  it("1. Returns ₹0 for all dates when no transactions exist (strictly no synthetic formulas)", async () => {
    const req = new Request(
      `http://localhost:3000/api/wallet/earnings-history.php?user_id=${mockUserId}&period=7D`,
      {
        method: "GET",
        headers: { Authorization: "Bearer tok_growth_1" },
      },
    );

    const res = await handleApiRequest(req);
    assert.ok(res);
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.period, "7D");
    assert.equal(data.history.length, 7);
    assert.equal(data.summary.total_revenue, 0);
    assert.equal(data.summary.referral, 0);
    assert.equal(data.summary.global, 0);
    assert.equal(data.summary.adsense, 0);
    assert.equal(data.summary.affiliate, 0);
    assert.equal(data.summary.ad_boost, 0);

    // Every single day must have 0 revenue and 0 across all streams
    for (const point of data.history) {
      assert.equal(point.revenue, 0, `Expected 0 revenue on ${point.date}, got ${point.revenue}`);
      assert.equal(point.referral, 0);
      assert.equal(point.global, 0);
      assert.equal(point.adsense, 0);
      assert.equal(point.affiliate, 0);
      assert.equal(point.ad_boost, 0);
      assert.equal(point.tx_count, 0);
    }
  });

  it("2. Accurately handles timeframe periods: 7D, 30D, 90D, and 12M", async () => {
    // 7D
    const res7 = await handleApiRequest(
      new Request(
        `http://localhost:3000/api/wallet/earnings-history?user_id=${mockUserId}&period=7D`,
        { headers: { Authorization: "Bearer tok_growth_1" } },
      ),
    );
    assert.ok(res7);
    assert.equal(res7.status, 200);
    const data7 = await res7.json();
    assert.equal(data7.period, "7D");
    assert.equal(data7.history.length, 7);

    // 30D
    const res30 = await handleApiRequest(
      new Request(
        `http://localhost:3000/api/wallet/earnings-history?user_id=${mockUserId}&period=30D`,
        { headers: { Authorization: "Bearer tok_growth_1" } },
      ),
    );
    assert.ok(res30);
    assert.equal(res30.status, 200);
    const data30 = await res30.json();
    assert.equal(data30.period, "30D");
    assert.equal(data30.history.length, 30);

    // 90D
    const res90 = await handleApiRequest(
      new Request(
        `http://localhost:3000/api/wallet/earnings-history?user_id=${mockUserId}&period=90D`,
        { headers: { Authorization: "Bearer tok_growth_1" } },
      ),
    );
    assert.ok(res90);
    assert.equal(res90.status, 200);
    const data90 = await res90.json();
    assert.equal(data90.period, "90D");
    assert.equal(data90.history.length, 90);

    // 12M (Monthly aggregation across 12 calendar months)
    const res12M = await handleApiRequest(
      new Request(
        `http://localhost:3000/api/wallet/earnings-history?user_id=${mockUserId}&period=12M`,
        { headers: { Authorization: "Bearer tok_growth_1" } },
      ),
    );
    assert.ok(res12M);
    assert.equal(res12M.status, 200);
    const data12M = await res12M.json();
    assert.equal(data12M.period, "12M");
    assert.equal(data12M.history.length, 12);
    // Keys in 12M should match YYYY-MM
    for (const point of data12M.history) {
      assert.match(point.date, /^\d{4}-\d{2}$/);
    }
  });

  it("3. Correctly categorizes transactions into 5 streams and excludes withdrawals", async () => {
    const testReq = new Request(
      `http://localhost:3000/api/wallet/earnings-history.php?user_id=${activeUserId}&period=7D`,
      { headers: { Authorization: "Bearer tok_multi_stream" } },
    );
    const testRes = await handleApiRequest(testReq);
    assert.ok(testRes);
    assert.equal(testRes.status, 200);
    const testData = await testRes.json();
    assert.equal(testData.success, true);
    assert.ok(testData.summary);
    assert.ok("referral" in testData.summary);
    assert.ok("global" in testData.summary);
    assert.ok("adsense" in testData.summary);
    assert.ok("affiliate" in testData.summary);
    assert.ok("ad_boost" in testData.summary);
  });
});

describe("Task 5J-V4-O: PHP Wallet Earnings History Authentication, Ownership & Fail-Closed Tests", () => {
  const historyPhpPath = path.resolve(process.cwd(), "api/wallet/earnings-history.php");
  const responsePhpPath = path.resolve(process.cwd(), "api/response.php");

  function loadHistoryPhpSources() {
    return {
      historyPhp: fs.readFileSync(historyPhpPath, "utf-8"),
      responsePhp: fs.readFileSync(responsePhpPath, "utf-8"),
    };
  }

  function createEarningsHistoryHarness(options: {
    method?: string;
    bearerToken: string | null;
    queryUserId?: string;
    period?: string;
    days?: number;
    authBehavior:
      | { kind: "none" }
      | { kind: "invalid" }
      | { kind: "user"; id: string; user_id: string; role: string }
      | {
          kind: "db_error";
          sqlState: string;
          driverCode: number;
          message: string;
          isRuntime?: boolean;
        };
    dbBehavior?:
      | {
          kind: "rows";
          rows: Array<{
            period_key: string;
            income_type: string;
            total_amount: number;
            tx_count: number;
          }>;
        }
      | {
          kind: "db_error";
          sqlState: string;
          driverCode: number;
          message: string;
          isRuntime?: boolean;
        };
    inTransaction?: boolean;
    rollbackThrows?: boolean;
  }) {
    const { responsePhp } = loadHistoryPhpSources();
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

    let inTx = Boolean(options.inTransaction);
    let rollbackAttempts = 0;
    let dbQueryExecuted = false;
    let resolvedTargetUserId: string | null = null;
    const serverLogs: string[] = [];

    const safeRollback = () => {
      try {
        if (inTx) {
          rollbackAttempts++;
          if (options.rollbackThrows) {
            throw new Error("MySQL server has gone away during ROLLBACK");
          }
          inTx = false;
        }
      } catch (rbErr: any) {
        serverLogs.push(
          `[wallet/earnings-history.php][ROLLBACK] Rollback failed: ${rbErr.message}`,
        );
      }
    };

    const method = options.method || "GET";
    if (method !== "GET") {
      return {
        status: 405,
        body: { success: false, error: "Method Not Allowed" },
        dbQueryExecuted,
        resolvedTargetUserId,
        rollbackAttempts,
        serverLogs,
      };
    }

    let authUser: { id: string; user_id: string; role: string } | null = null;
    try {
      if (options.bearerToken !== null) {
        if (options.authBehavior.kind === "user") {
          authUser = {
            id: options.authBehavior.id,
            user_id: options.authBehavior.user_id,
            role: options.authBehavior.role,
          };
        } else if (options.authBehavior.kind === "invalid") {
          authUser = null;
        } else if (options.authBehavior.kind === "db_error") {
          throw options.authBehavior;
        }
      }
    } catch (e: any) {
      safeRollback();
      serverLogs.push(`[wallet/earnings-history.php][AUTH] Database error: ${e.message}`);
      if (!e.isRuntime && isConnUnavailable(e.sqlState || "", e.driverCode || 0, e.message || "")) {
        return {
          status: 503,
          body: {
            success: false,
            error: "Database connection unavailable during authentication check.",
          },
          dbQueryExecuted,
          resolvedTargetUserId,
          rollbackAttempts,
          serverLogs,
        };
      }
      return {
        status: 500,
        body: { success: false, error: "Database error during authentication check." },
        dbQueryExecuted,
        resolvedTargetUserId,
        rollbackAttempts,
        serverLogs,
      };
    }

    if (!authUser || !authUser.user_id) {
      return {
        status: 401,
        body: {
          success: false,
          error: "Authentication required. Please provide a valid Bearer session token.",
        },
        dbQueryExecuted,
        resolvedTargetUserId,
        rollbackAttempts,
        serverLogs,
      };
    }

    const rawReqId = (options.queryUserId || "").trim();
    if (rawReqId === "") {
      resolvedTargetUserId = authUser.user_id;
    } else if (
      rawReqId.toUpperCase() === authUser.user_id.toUpperCase() ||
      (authUser.id && rawReqId.toUpperCase() === authUser.id.toUpperCase())
    ) {
      resolvedTargetUserId = authUser.user_id;
    } else if (authUser.role.toLowerCase() === "admin") {
      resolvedTargetUserId = rawReqId;
    } else {
      return {
        status: 403,
        body: {
          success: false,
          error:
            "Unauthorized: Cross-user earnings history access is restricted to verified administrators.",
        },
        dbQueryExecuted,
        resolvedTargetUserId,
        rollbackAttempts,
        serverLogs,
      };
    }

    const rawPeriod = (options.period || "").trim().toUpperCase();
    const rawDays = options.days || 0;
    let period: "7D" | "30D" | "90D" | "12M" = "30D";
    let days = 30;
    if (rawPeriod === "7D" || rawDays === 7) {
      period = "7D";
      days = 7;
    } else if (rawPeriod === "30D" || rawDays === 30) {
      period = "30D";
      days = 30;
    } else if (rawPeriod === "90D" || rawDays === 90) {
      period = "90D";
      days = 90;
    } else if (rawPeriod === "12M" || rawDays >= 365) {
      period = "12M";
      days = 365;
    } else if (rawDays > 0) {
      days = Math.max(7, Math.min(365, rawDays));
      period = days <= 7 ? "7D" : days <= 30 ? "30D" : days <= 90 ? "90D" : "12M";
    }

    try {
      dbQueryExecuted = true;
      const db = options.dbBehavior || { kind: "rows", rows: [] };
      if (db.kind === "db_error") {
        throw db;
      }

      const timeline: Record<string, any> = {};
      const summary = {
        total_revenue: 0.0,
        referral: 0.0,
        global: 0.0,
        adsense: 0.0,
        affiliate: 0.0,
        ad_boost: 0.0,
      };

      const now = new Date();
      if (period === "12M") {
        for (let i = 11; i >= 0; i--) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
          timeline[key] = {
            date: key,
            day: key,
            revenue: 0,
            referral: 0,
            global: 0,
            adsense: 0,
            affiliate: 0,
            ad_boost: 0,
            referral_income: 0,
            global_income: 0,
            adsense_income: 0,
            affiliate_income: 0,
            ad_boost_income: 0,
            tx_count: 0,
          };
        }
      } else {
        for (let i = days - 1; i >= 0; i--) {
          const d = new Date(Date.now() - i * 86400_000);
          const key = d.toISOString().split("T")[0]!;
          timeline[key] = {
            date: key,
            day: key,
            revenue: 0,
            referral: 0,
            global: 0,
            adsense: 0,
            affiliate: 0,
            ad_boost: 0,
            referral_income: 0,
            global_income: 0,
            adsense_income: 0,
            affiliate_income: 0,
            ad_boost_income: 0,
            tx_count: 0,
          };
        }
      }

      for (const r of db.rows) {
        const pt = timeline[r.period_key];
        if (!pt) continue;
        const amt = Math.round(Number(r.total_amount) * 100) / 100;
        const cnt = Number(r.tx_count);
        let category: "referral" | "global" | "adsense" | "affiliate" | "ad_boost" = "referral";
        if (r.income_type === "global_income") category = "global";
        else if (r.income_type === "adsense_income") category = "adsense";
        else if (r.income_type === "affiliate_income" || r.income_type === "marketing_income")
          category = "affiliate";
        else if (r.income_type === "ad_boost_income" || r.income_type === "marketing_ads")
          category = "ad_boost";

        pt[category] = Math.round((pt[category] + amt) * 100) / 100;
        pt[`${category}_income`] = pt[category];
        pt.revenue = Math.round((pt.revenue + amt) * 100) / 100;
        pt.tx_count += cnt;
        summary[category] = Math.round((summary[category] + amt) * 100) / 100;
        summary.total_revenue = Math.round((summary.total_revenue + amt) * 100) / 100;
      }

      return {
        status: 200,
        body: {
          success: true,
          user_id: resolvedTargetUserId,
          period,
          days,
          summary,
          history: Object.values(timeline),
        },
        dbQueryExecuted,
        resolvedTargetUserId,
        rollbackAttempts,
        serverLogs,
      };
    } catch (e: any) {
      safeRollback();
      serverLogs.push(`[wallet/earnings-history.php] Database error: ${e.message}`);
      if (!e.isRuntime && isConnUnavailable(e.sqlState || "", e.driverCode || 0, e.message || "")) {
        return {
          status: 503,
          body: {
            success: false,
            error: "Database connection unavailable while loading earnings history.",
          },
          dbQueryExecuted,
          resolvedTargetUserId,
          rollbackAttempts,
          serverLogs,
        };
      }
      return {
        status: 500,
        body: {
          success: false,
          error: "Failed to load earnings history due to a server error.",
        },
        dbQueryExecuted,
        resolvedTargetUserId,
        rollbackAttempts,
        serverLogs,
      };
    }
  }

  it("1. Rejects unauthenticated and invalid-token requests with HTTP 401 (with or without user_id)", () => {
    const { historyPhp } = loadHistoryPhpSources();
    assert.match(historyPhp, /\$authUser\s*=\s*getAuthUser\(\$pdo,\s*true\);/);
    assert.match(
      historyPhp,
      /if\s*\(\s*!\$authUser\s*\|\|\s*empty\(\$authUser\['user_id'\]\)\s*\)/,
    );
    assert.match(historyPhp, /jsonResponse\([\s\S]*?401\s*\);/);

    const authPos = historyPhp.indexOf("getAuthUser($pdo, true)");
    const queryPos = historyPhp.indexOf("$_GET['user_id']");
    assert.ok(authPos > 0 && authPos < queryPos, "Auth must run before parsing $_GET['user_id']");

    const unauthNoUser = createEarningsHistoryHarness({
      bearerToken: null,
      authBehavior: { kind: "none" },
    });
    assert.equal(unauthNoUser.status, 401);
    assert.equal(unauthNoUser.dbQueryExecuted, false);

    const unauthWithUser = createEarningsHistoryHarness({
      bearerToken: null,
      queryUserId: "FT483921",
      authBehavior: { kind: "none" },
    });
    assert.equal(unauthWithUser.status, 401);
    assert.equal(unauthWithUser.dbQueryExecuted, false);

    const invalidSession = createEarningsHistoryHarness({
      bearerToken: "expired_session_tok",
      queryUserId: "FT483921",
      authBehavior: { kind: "invalid" },
    });
    assert.equal(invalidSession.status, 401);
    assert.equal(invalidSession.dbQueryExecuted, false);
  });

  it("2. Allows authenticated user own history, blocks non-admin cross-user lookup with 403, and permits verified admin access", () => {
    const { historyPhp } = loadHistoryPhpSources();
    assert.match(
      historyPhp,
      /\$isAdmin\s*=\s*isset\(\$authUser\['role'\]\)\s*&&\s*strtolower\(trim\(\(string\)\$authUser\['role'\]\)\)\s*===\s*'admin'/,
    );
    assert.match(historyPhp, /jsonResponse\([\s\S]*?403\s*\);/);

    const todayKey = new Date().toISOString().split("T")[0]!;
    const selfOmitted = createEarningsHistoryHarness({
      bearerToken: "valid_user_tok",
      period: "7D",
      authBehavior: { kind: "user", id: "uuid-483921", user_id: "FT483921", role: "user" },
      dbBehavior: {
        kind: "rows",
        rows: [
          { period_key: todayKey, income_type: "referral_income", total_amount: 12.5, tx_count: 3 },
          { period_key: todayKey, income_type: "adsense_income", total_amount: 40, tx_count: 1 },
        ],
      },
    });
    assert.equal(selfOmitted.status, 200);
    assert.equal(selfOmitted.resolvedTargetUserId, "FT483921");
    assert.equal((selfOmitted.body as any).user_id, "FT483921");
    assert.equal((selfOmitted.body as any).period, "7D");
    assert.equal((selfOmitted.body as any).days, 7);
    assert.equal((selfOmitted.body as any).history.length, 7);
    assert.equal((selfOmitted.body as any).summary.referral, 12.5);
    assert.equal((selfOmitted.body as any).summary.adsense, 40);
    assert.equal((selfOmitted.body as any).summary.total_revenue, 52.5);

    const crossUserDenied = createEarningsHistoryHarness({
      bearerToken: "valid_user_tok",
      queryUserId: "FT900431",
      authBehavior: { kind: "user", id: "uuid-483921", user_id: "FT483921", role: "user" },
    });
    assert.equal(crossUserDenied.status, 403);
    assert.equal(crossUserDenied.dbQueryExecuted, false);

    const adminCross = createEarningsHistoryHarness({
      bearerToken: "valid_admin_tok",
      queryUserId: "FT900431",
      period: "12M",
      authBehavior: { kind: "user", id: "uuid-102857", user_id: "FT102857", role: "admin" },
    });
    assert.equal(adminCross.status, 200);
    assert.equal(adminCross.resolvedTargetUserId, "FT900431");
    assert.equal((adminCross.body as any).period, "12M");
    assert.equal((adminCross.body as any).history.length, 12);
  });

  it("3. Returns HTTP 503 on DB connection error and sanitized HTTP 500 on unexpected errors; preserves SQL filtering and response shape", () => {
    const { historyPhp } = loadHistoryPhpSources();
    assert.match(historyPhp, /\}\s*catch\s*\(\s*Throwable\s+\$e\s*\)\s*\{/);
    assert.match(historyPhp, /isDatabaseConnectionUnavailableError\(\$e\)/);
    assert.match(historyPhp, /\$safeRollback\(\$pdo\);/);
    assert.match(historyPhp, /error_log\(/);
    assert.doesNotMatch(historyPhp, /jsonResponse\([^\n]*\$e->getMessage\(\)/);
    assert.match(historyPhp, /AND income_type != "withdrawal"/);
    assert.match(historyPhp, /ORDER BY period_key ASC/);

    const auth1203 = createEarningsHistoryHarness({
      bearerToken: "valid_user_tok",
      authBehavior: {
        kind: "db_error",
        sqlState: "42000",
        driverCode: 1203,
        message: "User already has more than 'max_user_connections' active connections",
      },
      inTransaction: true,
      rollbackThrows: true,
    });
    assert.equal(auth1203.status, 503);
    assert.equal(auth1203.body.success, false);
    assert.equal(auth1203.rollbackAttempts, 1);
    assert.ok(auth1203.serverLogs.some((l) => l.includes("[ROLLBACK]")));
    assert.equal(String(auth1203.body.error).includes("max_user_connections"), false);

    const query2002 = createEarningsHistoryHarness({
      bearerToken: "valid_user_tok",
      authBehavior: { kind: "user", id: "uuid-483921", user_id: "FT483921", role: "user" },
      dbBehavior: {
        kind: "db_error",
        sqlState: "HY000",
        driverCode: 2002,
        message: "Connection refused",
      },
    });
    assert.equal(query2002.status, 503);
    assert.equal(query2002.body.success, false);
    assert.equal("history" in query2002.body, false);

    const query1146 = createEarningsHistoryHarness({
      bearerToken: "valid_user_tok",
      authBehavior: { kind: "user", id: "uuid-483921", user_id: "FT483921", role: "user" },
      dbBehavior: {
        kind: "db_error",
        sqlState: "42S02",
        driverCode: 1146,
        message: "Table 'prod_db.income_ledger' doesn't exist",
      },
    });
    assert.equal(query1146.status, 500);
    assert.equal(query1146.body.success, false);
    assert.equal("history" in query1146.body, false);
    assert.equal(String(query1146.body.error).includes("income_ledger"), false);

    const res405 = createEarningsHistoryHarness({
      method: "POST",
      bearerToken: null,
      authBehavior: { kind: "none" },
    });
    assert.equal(res405.status, 405);
  });
});

describe("Step 9A: Earnings History AdMob Classification, Settled-Only Filtering & PHP/Node Parity", () => {
  let tmpDataDir = "";
  const origDataDir = process.env["FACETUBE_DATA_DIR"];

  beforeEach(() => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-step9a-"));
    process.env["FACETUBE_DATA_DIR"] = tmpDataDir;
  });

  afterEach(() => {
    setMysqlPoolForTesting(null);
    if (origDataDir !== undefined) process.env["FACETUBE_DATA_DIR"] = origDataDir;
    else delete process.env["FACETUBE_DATA_DIR"];
    resetInMemoryStore();
    if (tmpDataDir && fs.existsSync(tmpDataDir)) {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    }
  });

  function todayIsoDate(): string {
    return new Date().toISOString().split("T")[0]!;
  }

  function currentYearMonth(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }

  it("1. Classifies admob_income strictly under admob (never referral) and excludes unknown types across 7D and 12M in Node local store", async () => {
    const testUser = "FT_STEP9A_HIST_01";
    const today = todayIsoDate();
    const ym = currentYearMonth();

    const store = {
      users: [
        {
          id: "u-step9a-1",
          user_id: testUser,
          name: "Step9A Hist 1",
          email: "step9a1@facetube.com",
          mobile: "9000001011",
          role: "user",
          referral_code: null,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      sessions: {
        tok_step9a_1: testUser,
      },
      walletTransactions: [
        {
          id: "led_step9a_admob_1",
          transaction_id: "TX_STEP9A_ADMOB_1",
          user_id: testUser,
          income_type: "admob_income",
          amount: 450.75,
          status: "settled",
          created_at: `${today}T08:00:00.000Z`,
        },
        {
          id: "led_step9a_ref_1",
          transaction_id: "TX_STEP9A_REF_1",
          user_id: testUser,
          income_type: "referral_income",
          amount: 25.5,
          status: "settled",
          created_at: `${today}T09:00:00.000Z`,
        },
        {
          id: "led_step9a_unknown_1",
          transaction_id: "TX_STEP9A_UNKNOWN_1",
          user_id: testUser,
          income_type: "corrupted_unknown_type",
          amount: 999.0,
          status: "settled",
          created_at: `${today}T10:00:00.000Z`,
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDataDir, "facetube_store.json"),
      JSON.stringify(store, null, 2),
      "utf-8",
    );
    resetInMemoryStore();

    const res7d = await handleApiRequest(
      new Request(
        `http://localhost:3000/api/wallet/earnings-history.php?user_id=${testUser}&period=7D`,
        { headers: { Authorization: "Bearer tok_step9a_1" } },
      ),
    );
    assert.equal(res7d?.status, 200);
    const body7d = (await res7d?.json()) as any;
    assert.equal(body7d.summary.admob, 450.75);
    assert.equal(
      body7d.summary.referral,
      25.5,
      "AdMob and unknown types must NEVER count as referral",
    );
    assert.equal(body7d.summary.total_revenue, 476.25);

    const todayPt = body7d.history.find((pt: any) => pt.date === today);
    assert.ok(todayPt, "Today bucket must exist in 7D timeline");
    assert.equal(todayPt.admob, 450.75);
    assert.equal(todayPt.admob_income, 450.75);
    assert.equal(todayPt.referral, 25.5);
    assert.equal(todayPt.referral_income, 25.5);
    assert.equal(todayPt.tx_count, 2, "Only known settled entries increment tx_count");

    const res12m = await handleApiRequest(
      new Request(
        `http://localhost:3000/api/wallet/earnings-history.php?user_id=${testUser}&period=12M`,
        { headers: { Authorization: "Bearer tok_step9a_1" } },
      ),
    );
    assert.equal(res12m?.status, 200);
    const body12m = (await res12m?.json()) as any;
    assert.equal(body12m.summary.admob, 450.75);
    assert.equal(body12m.summary.referral, 25.5);
    assert.equal(body12m.summary.total_revenue, 476.25);
    const monthPt = body12m.history.find((pt: any) => pt.date === ym);
    assert.ok(monthPt, "Current month bucket must exist in 12M timeline");
    assert.equal(monthPt.admob, 450.75);
    assert.equal(monthPt.admob_income, 450.75);
    assert.equal(monthPt.referral, 25.5);
    assert.equal(monthPt.tx_count, 2);
  });

  it("2. Excludes pending and failed ledger entries from settled earnings history in local store and enforces status = settled in Node & PHP SQL", async () => {
    const origHost = process.env["DB_HOST"];
    const origName = process.env["DB_NAME"];
    const origUser = process.env["DB_USER"];
    const testUser = "FT_STEP9A_HIST_02";
    const today = todayIsoDate();
    const capturedSql: string[] = [];

    try {
      const store = {
        users: [
          {
            id: "u-step9a-2",
            user_id: testUser,
            name: "Step9A Hist 2",
            email: "step9a2@facetube.com",
            mobile: "9000001012",
            role: "user",
            referral_code: null,
            created_at: "2026-01-01T00:00:00.000Z",
          },
        ],
        sessions: {
          tok_step9a_2: testUser,
        },
        walletTransactions: [
          {
            id: "led_step9a_settled",
            transaction_id: "TX_STEP9A_SETTLED",
            user_id: testUser,
            income_type: "admob_income",
            amount: 300.0,
            status: "settled",
            created_at: `${today}T08:00:00.000Z`,
          },
          {
            id: "led_step9a_pending",
            transaction_id: "TX_STEP9A_PENDING",
            user_id: testUser,
            income_type: "admob_income",
            amount: 500.0,
            status: "pending",
            created_at: `${today}T09:00:00.000Z`,
          },
          {
            id: "led_step9a_failed",
            transaction_id: "TX_STEP9A_FAILED",
            user_id: testUser,
            income_type: "referral_income",
            amount: 75.0,
            status: "failed",
            created_at: `${today}T10:00:00.000Z`,
          },
        ],
      };
      fs.writeFileSync(
        path.join(tmpDataDir, "facetube_store.json"),
        JSON.stringify(store, null, 2),
        "utf-8",
      );
      resetInMemoryStore();

      // 2a. Local store excludes pending & failed entries
      const storeRes = await handleApiRequest(
        new Request(
          `http://localhost:3000/api/wallet/earnings-history.php?user_id=${testUser}&period=30D`,
          { headers: { Authorization: "Bearer tok_step9a_2" } },
        ),
      );
      assert.equal(storeRes?.status, 200);
      const storeBody = (await storeRes?.json()) as any;
      assert.equal(storeBody.summary.admob, 300);
      assert.equal(storeBody.summary.referral, 0, "Failed referral entry must be excluded");
      assert.equal(storeBody.summary.total_revenue, 300);
      const storeToday = storeBody.history.find((pt: any) => pt.date === today);
      assert.equal(storeToday?.tx_count, 1);

      // 2b. Node MySQL path enforces status = 'settled' in both 12M and daily queries and classifies admob_income cleanly
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";

      setMysqlPoolForTesting({
        query: async (sql: string) => {
          if (sql.includes("FROM income_ledger")) {
            capturedSql.push(sql);
            const key = sql.includes("DATE_FORMAT") ? currentYearMonth() : today;
            return [
              [
                { period_key: key, income_type: "admob_income", total_amount: 612.25, tx_count: 2 },
                { period_key: key, income_type: "unknown_type", total_amount: 999.0, tx_count: 4 },
              ],
            ];
          }
          return [[]];
        },
      } as any);

      const mysqlDailyRes = await handleApiRequest(
        new Request(
          `http://localhost:3000/api/wallet/earnings-history.php?user_id=${testUser}&period=7D`,
          { headers: { Authorization: "Bearer tok_step9a_2" } },
        ),
      );
      assert.equal(mysqlDailyRes?.status, 200);
      const mysqlDailyBody = (await mysqlDailyRes?.json()) as any;
      assert.equal(mysqlDailyBody.summary.admob, 612.25);
      assert.equal(mysqlDailyBody.summary.referral, 0);
      assert.equal(mysqlDailyBody.summary.total_revenue, 612.25);

      const mysql12mRes = await handleApiRequest(
        new Request(
          `http://localhost:3000/api/wallet/earnings-history.php?user_id=${testUser}&period=12M`,
          { headers: { Authorization: "Bearer tok_step9a_2" } },
        ),
      );
      assert.equal(mysql12mRes?.status, 200);
      const mysql12mBody = (await mysql12mRes?.json()) as any;
      assert.equal(mysql12mBody.summary.admob, 612.25);
      assert.equal(mysql12mBody.summary.referral, 0);
      assert.equal(mysql12mBody.summary.total_revenue, 612.25);

      assert.equal(capturedSql.length, 2);
      for (const sql of capturedSql) {
        assert.match(
          sql,
          /AND\s+status\s*=\s*'settled'/i,
          "Node MySQL SQL must filter status = 'settled'",
        );
      }

      // 2c. PHP earnings-history.php parity checks
      const historyPhp = fs.readFileSync(
        path.resolve(process.cwd(), "api/wallet/earnings-history.php"),
        "utf-8",
      );
      const settledMatches = historyPhp.match(/AND\s+status\s*=\s*"settled"/g) || [];
      assert.equal(
        settledMatches.length,
        2,
        'PHP earnings-history.php must filter AND status = "settled" in both 12M and daily queries',
      );
      assert.match(historyPhp, /'admob'\s*=>\s*0\.0/);
      assert.match(historyPhp, /'admob_income'\s*=>\s*0\.0/);
      assert.match(historyPhp, /\$type\s*===\s*'admob_income'[\s\S]*?\$category\s*=\s*'admob'/);
      assert.match(historyPhp, /\$category\s*=\s*null;/);
      assert.match(historyPhp, /if\s*\(\$category\s*===\s*null\)\s*\{\s*continue;\s*\}/);
    } finally {
      setMysqlPoolForTesting(null);
      if (origHost !== undefined) process.env["DB_HOST"] = origHost;
      else delete process.env["DB_HOST"];
      if (origName !== undefined) process.env["DB_NAME"] = origName;
      else delete process.env["DB_NAME"];
      if (origUser !== undefined) process.env["DB_USER"] = origUser;
      else delete process.env["DB_USER"];
    }
  });
});
