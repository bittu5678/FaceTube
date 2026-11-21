import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { handleApiRequest } from "./api-handler";
import { resetPersistentPremiumState } from "./payments";

describe("Task 2 - Phase 2D: My Subscriptions & Payment History Tests", () => {
  const secret = "test_razorpay_secret_my_sub_123456";
  const keyId = "rzp_test_my_sub_key_123456";
  const testEnv = {
    RAZORPAY_KEY_ID: keyId,
    RAZORPAY_KEY_SECRET: secret,
    RAZORPAY_SKIP_REMOTE_CHECK: "true",
  };

  let userToken = "";
  let otherUserToken = "";
  const standardUserId = "FT483921"; // Alex Rivera
  const otherUserId = "FT900431"; // Maya Patel

  before(async () => {
    // 1. Reset state
    await resetPersistentPremiumState(10, [], []);

    // 2. Authenticate standard user (Alex Rivera)
    const loginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
    });
    const loginRes = await handleApiRequest(loginReq);
    assert.ok(loginRes);
    const loginData = await loginRes.json();
    assert.ok(loginData.token);
    userToken = loginData.token;

    // 3. Authenticate second user (Maya Patel)
    const otherLoginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "maya@facetube.com", password: "password123" }),
    });
    const otherLoginRes = await handleApiRequest(otherLoginReq);
    assert.ok(otherLoginRes);
    const otherLoginData = await otherLoginRes.json();
    assert.ok(otherLoginData.token);
    otherUserToken = otherLoginData.token;
  });

  // Suite 1: Authentication & HTTP Method Verification
  describe("1. Authentication & HTTP Method Verification (/api/subscriptions/my)", () => {
    it("rejects unauthenticated requests to /api/subscriptions/my with HTTP 401", async () => {
      const req = new Request("http://localhost:3000/api/subscriptions/my", {
        method: "GET",
      });
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /authentication required/i);
    });

    it("rejects unauthenticated requests to /api/subscriptions/active with HTTP 401", async () => {
      const req = new Request("http://localhost:3000/api/subscriptions/active", {
        method: "GET",
      });
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /authentication required/i);
    });

    it("rejects non-GET HTTP methods with HTTP 405 Method Not Allowed", async () => {
      for (const method of ["POST", "PUT", "DELETE"]) {
        const req = new Request("http://localhost:3000/api/subscriptions/my", {
          method,
          headers: { Authorization: `Bearer ${userToken}` },
        });
        const res = await handleApiRequest(req, testEnv);
        assert.ok(res);
        assert.equal(res.status, 405);
        const data = await res.json();
        assert.equal(data.success, false);
        assert.match(data.error, /method not allowed/i);
      }
    });
  });

  // Suite 2: Empty State
  describe("2. Empty State Handling", () => {
    it("returns hasActiveSubscription: false, null subscription, and empty history for new user", async () => {
      await resetPersistentPremiumState(10, [], []);

      const req = new Request("http://localhost:3000/api/subscriptions/my", {
        method: "GET",
        headers: { Authorization: `Bearer ${userToken}` },
      });
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.hasActiveSubscription, false);
      assert.equal(data.subscription, null);
      assert.equal(data.activeSubscription, null);
      assert.ok(Array.isArray(data.history));
      assert.equal(data.history.length, 0);
      assert.ok(Array.isArray(data.subscriptions));
      assert.equal(data.subscriptions.length, 0);
    });
  });

  // Suite 3: User Ownership Enforcement
  describe("3. Strict User Ownership Enforcement", () => {
    it("never returns another user's subscriptions even when queried with spoofed user_id parameter", async () => {
      const now = Date.now();
      // Setup subscription for user B (John Doe)
      const subUserB = {
        subscriptionId: "sub_b_111",
        userId: otherUserId,
        planId: "member-vip-monthly",
        orderId: "order_b_111",
        paymentId: "pay_b_111",
        amount: 149.0,
        currency: "INR",
        status: "active" as const,
        startsAt: new Date(now - 86400000).toISOString(),
        expiresAt: new Date(now + 29 * 86400000).toISOString(),
        durationDays: 30,
      };

      await resetPersistentPremiumState(10, [], [subUserB]);

      // Standard user A attempts to query spoofed user_id in query string
      const spoofReq = new Request(
        `http://localhost:3000/api/subscriptions/my?user_id=${otherUserId}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${userToken}` }, // Session is user A
        },
      );
      const res = await handleApiRequest(spoofReq, testEnv);
      assert.ok(res);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.success, true);
      // User A must NOT see User B's active subscription
      assert.equal(data.hasActiveSubscription, false);
      assert.equal(data.subscription, null);
      assert.equal(data.subscriptions.length, 0);

      // Meanwhile, User B querying their own endpoint sees their active subscription
      const userBReq = new Request("http://localhost:3000/api/subscriptions/my", {
        method: "GET",
        headers: { Authorization: `Bearer ${otherUserToken}` },
      });
      const userBRes = await handleApiRequest(userBReq, testEnv);
      assert.ok(userBRes);
      assert.equal(userBRes.status, 200);
      const userBData = await userBRes.json();
      assert.equal(userBData.success, true);
      assert.equal(userBData.hasActiveSubscription, true);
      assert.equal(userBData.subscription.userId, otherUserId);
      assert.equal(userBData.subscription.planId, "member-vip-monthly");
    });
  });

  // Suite 4: Active Subscription Details & Remaining Days
  describe("4. Active Subscription Attributes & Remaining Days Calculation", () => {
    it("returns active subscription with resolved plan name, remaining days, and valid payment info", async () => {
      const now = Date.now();
      const activeSub = {
        subscriptionId: "sub_alex_active_123",
        userId: standardUserId,
        planId: "member-vip-monthly",
        orderId: "order_alex_act_456",
        paymentId: "pay_alex_act_789",
        amount: 149.0,
        currency: "INR",
        status: "active" as const,
        startsAt: new Date(now - 2 * 86400000).toISOString(),
        expiresAt: new Date(now + 28 * 86400000).toISOString(),
        durationDays: 30,
      };

      await resetPersistentPremiumState(10, [], [activeSub]);

      const req = new Request("http://localhost:3000/api/subscriptions/my", {
        method: "GET",
        headers: { Authorization: `Bearer ${userToken}` },
      });
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.hasActiveSubscription, true);
      assert.ok(data.subscription);

      const sub = data.subscription;
      assert.equal(sub.subscriptionId, "sub_alex_active_123");
      assert.equal(sub.userId, standardUserId);
      assert.equal(sub.planId, "member-vip-monthly");
      assert.equal(sub.planName, "VIP Supporter");
      assert.equal(sub.amount, 149.0);
      assert.equal(sub.currency, "INR");
      assert.equal(sub.status, "active");
      assert.equal(sub.isExpired, false);
      assert.ok(sub.remainingDays >= 27 && sub.remainingDays <= 29);
      assert.equal(sub.paymentId, "pay_alex_act_789");
      assert.equal(sub.orderId, "order_alex_act_456");
      assert.ok(sub.startsAt);
      assert.ok(sub.expiresAt);
    });
  });

  // Suite 5: Expired Subscriptions History Separation
  describe("5. Separate Previous/Expired Subscriptions History", () => {
    it("correctly separates active subscription and past expired subscriptions in history", async () => {
      const now = Date.now();
      // 1 expired sub from last month
      const pastExpiredSub = {
        subscriptionId: "sub_alex_past_001",
        userId: standardUserId,
        planId: "member-monthly",
        orderId: "order_alex_past_001",
        paymentId: "pay_alex_past_001",
        amount: 49.0,
        currency: "INR",
        status: "active" as const,
        startsAt: new Date(now - 60 * 86400000).toISOString(),
        expiresAt: new Date(now - 30 * 86400000).toISOString(), // Expired 30 days ago
        durationDays: 30,
      };

      // 1 current active sub
      const currentActiveSub = {
        subscriptionId: "sub_alex_curr_002",
        userId: standardUserId,
        planId: "member-annual",
        orderId: "order_alex_curr_002",
        paymentId: "pay_alex_curr_002",
        amount: 999.0,
        currency: "INR",
        status: "active" as const,
        startsAt: new Date(now - 5 * 86400000).toISOString(),
        expiresAt: new Date(now + 360 * 86400000).toISOString(), // Valid for 360 more days
        durationDays: 365,
      };

      await resetPersistentPremiumState(10, [], [currentActiveSub, pastExpiredSub]);

      const req = new Request("http://localhost:3000/api/subscriptions/my", {
        method: "GET",
        headers: { Authorization: `Bearer ${userToken}` },
      });
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.hasActiveSubscription, true);

      // Active subscription check
      assert.equal(data.subscription.subscriptionId, "sub_alex_curr_002");
      assert.equal(data.subscription.planName, "All-Access Annual");
      assert.equal(data.subscription.isExpired, false);
      assert.ok(data.subscription.remainingDays > 300);

      // History check
      assert.ok(Array.isArray(data.history));
      assert.equal(data.history.length, 1);
      const histItem = data.history[0];
      assert.equal(histItem.subscriptionId, "sub_alex_past_001");
      assert.equal(histItem.planId, "member-monthly");
      assert.equal(histItem.planName, "Creator Member");
      assert.equal(histItem.amount, 49.0);
      assert.equal(histItem.isExpired, true);
      assert.equal(histItem.remainingDays, 0);
      assert.equal(histItem.status, "expired");
      assert.equal(histItem.paymentId, "pay_alex_past_001");
    });
  });

  // Suite 6: End-to-End Integration Flow (Order -> Verify -> /my reflection)
  describe("6. End-to-End Payment Verification to /my Endpoint Reflection", () => {
    it("activates subscription via payment verification and confirms immediate reflection in /api/subscriptions/my", async () => {
      await resetPersistentPremiumState(10, [], []);

      // 1. Create order
      const orderReq = new Request("http://localhost:3000/api/payments/create-order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          purpose: "paid_subscription",
          userId: standardUserId,
          planId: "member-monthly",
        }),
      });
      const orderRes = await handleApiRequest(orderReq, testEnv);
      assert.ok(orderRes);
      assert.equal(orderRes.status, 200);
      const orderData = await orderRes.json();
      assert.ok(orderData.orderId);

      // 2. Verify payment
      const paymentId = `pay_sub_e2e_${Date.now()}`;
      const crypto = await import("node:crypto");
      const signature = crypto
        .createHmac("sha256", secret)
        .update(`${orderData.orderId}|${paymentId}`)
        .digest("hex");

      const verifyReq = new Request("http://localhost:3000/api/payments/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          orderId: orderData.orderId,
          paymentId,
          signature,
          userId: standardUserId,
          purpose: "paid_subscription",
          planId: "member-monthly",
        }),
      });
      const verifyRes = await handleApiRequest(verifyReq, testEnv);
      assert.ok(verifyRes);
      assert.equal(verifyRes.status, 200);
      const verifyData = await verifyRes.json();
      assert.equal(verifyData.verified, true);
      assert.ok(verifyData.subscription);

      // 3. Query /api/subscriptions/my and assert active membership
      const myReq = new Request("http://localhost:3000/api/subscriptions/my", {
        method: "GET",
        headers: { Authorization: `Bearer ${userToken}` },
      });
      const myRes = await handleApiRequest(myReq, testEnv);
      assert.ok(myRes);
      assert.equal(myRes.status, 200);
      const myData = await myRes.json();

      assert.equal(myData.success, true);
      assert.equal(myData.hasActiveSubscription, true);
      assert.ok(myData.subscription);
      assert.equal(myData.subscription.paymentId, paymentId);
      assert.equal(myData.subscription.planId, "member-monthly");
      assert.equal(myData.subscription.planName, "Creator Member");
      assert.equal(myData.subscription.amount, 49.0);
      assert.equal(myData.subscription.isExpired, false);
      assert.ok(myData.subscription.remainingDays >= 29);
    });
  });
});

describe("Task 5J-V4-P: PHP Subscription Status API Fail-Closed Tests (api/subscriptions/my.php)", () => {
  const myPhpPath = path.resolve(process.cwd(), "api/subscriptions/my.php");
  const responsePhpPath = path.resolve(process.cwd(), "api/response.php");

  function loadPhpSources() {
    return {
      myPhp: fs.readFileSync(myPhpPath, "utf-8"),
      responsePhp: fs.readFileSync(responsePhpPath, "utf-8"),
    };
  }

  interface SubRow {
    subscription_id: string;
    user_id: string;
    plan_id: string;
    order_id: string;
    payment_id: string;
    amount: number;
    currency: string;
    status: string;
    starts_at: string;
    expires_at: string;
    created_at: string;
  }

  interface SubItem {
    subscriptionId: string;
    userId: string;
    planId: string;
    planName: string;
    orderId: string;
    paymentId: string;
    amount: number;
    currency: string;
    status: string;
    isExpired: boolean;
    remainingDays: number;
    startsAt: string;
    expiresAt: string;
    createdAt: string;
  }

  interface MySubApiResponse {
    success: boolean;
    error?: string;
    hasActiveSubscription?: boolean;
    subscription?: SubItem | null;
    activeSubscription?: SubItem | null;
    history?: SubItem[];
    subscriptions?: SubItem[];
  }

  function createMySubscriptionsHarness(options: {
    method?: string;
    bearerToken: string | null;
    authBehavior:
      | { kind: "none" }
      | { kind: "invalid" }
      | { kind: "user"; user_id: string }
      | {
          kind: "db_error";
          sqlState: string;
          driverCode: number;
          message: string;
          isRuntime?: boolean;
        };
    plansBehavior?:
      | { kind: "rows"; plans: Array<{ plan_id: string; name: string }> }
      | {
          kind: "db_error";
          sqlState: string;
          driverCode: number;
          message: string;
          isRuntime?: boolean;
        };
    subscriptionsBehavior?:
      | { kind: "rows"; rows: SubRow[] }
      | {
          kind: "db_error";
          sqlState: string;
          driverCode: number;
          message: string;
          isRuntime?: boolean;
        };
    inTransaction?: boolean;
    rollbackThrows?: boolean;
    nowSeconds?: number;
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

    const isMissingOptionalTable = (err: {
      sqlState?: string;
      driverCode?: number;
      isRuntime?: boolean;
    }) => !err.isRuntime && (err.sqlState === "42S02" || err.driverCode === 1146);

    let inTx = Boolean(options.inTransaction);
    let rollbackAttempts = 0;
    let subscriptionQueryExecuted = false;
    let queriedUserId: string | null = null;
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
      } catch (rbErr: unknown) {
        const msg = rbErr instanceof Error ? rbErr.message : String(rbErr);
        serverLogs.push(`[subscriptions/my.php][ROLLBACK] Rollback failed: ${msg}`);
      }
    };

    const method = options.method ?? "GET";
    if (method !== "GET") {
      return {
        status: 405,
        body: { success: false, error: "Method Not Allowed" } as MySubApiResponse,
        subscriptionQueryExecuted,
        queriedUserId,
        rollbackAttempts,
        serverLogs,
      };
    }

    let authUser: { user_id: string } | null = null;
    try {
      if (options.bearerToken !== null) {
        if (options.authBehavior.kind === "user") {
          authUser = { user_id: options.authBehavior.user_id };
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
      safeRollback();
      serverLogs.push(`[subscriptions/my.php][AUTH] Database error: ${err.message ?? ""}`);
      if (
        !err.isRuntime &&
        isConnUnavailable(err.sqlState ?? "", err.driverCode ?? 0, err.message ?? "")
      ) {
        return {
          status: 503,
          body: {
            success: false,
            error: "Database connection unavailable during authentication check.",
          } as MySubApiResponse,
          subscriptionQueryExecuted,
          queriedUserId,
          rollbackAttempts,
          serverLogs,
        };
      }
      return {
        status: 500,
        body: {
          success: false,
          error: "Database error during authentication check.",
        } as MySubApiResponse,
        subscriptionQueryExecuted,
        queriedUserId,
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
        } as MySubApiResponse,
        subscriptionQueryExecuted,
        queriedUserId,
        rollbackAttempts,
        serverLogs,
      };
    }

    const userId = authUser.user_id;
    const planNames: Record<string, string> = {
      "member-monthly": "Creator Member",
      "member-vip-monthly": "VIP Supporter",
      "member-annual": "All-Access Annual",
    };

    try {
      const plans = options.plansBehavior ?? { kind: "rows", plans: [] };
      if (plans.kind === "db_error") {
        throw plans;
      }
      for (const p of plans.plans) {
        if (p.plan_id && p.name) {
          planNames[p.plan_id] = p.name;
        }
      }
    } catch (e: unknown) {
      const err = e as {
        sqlState?: string;
        driverCode?: number;
        message?: string;
        isRuntime?: boolean;
      };
      if (!isMissingOptionalTable(err)) {
        safeRollback();
        serverLogs.push(`[subscriptions/my.php][PLANS] Database error: ${err.message ?? ""}`);
        if (
          !err.isRuntime &&
          isConnUnavailable(err.sqlState ?? "", err.driverCode ?? 0, err.message ?? "")
        ) {
          return {
            status: 503,
            body: {
              success: false,
              error: "Database connection unavailable while loading subscription plans.",
            } as MySubApiResponse,
            subscriptionQueryExecuted,
            queriedUserId,
            rollbackAttempts,
            serverLogs,
          };
        }
        return {
          status: 500,
          body: {
            success: false,
            error: "Failed to load subscription status due to a server error.",
          } as MySubApiResponse,
          subscriptionQueryExecuted,
          queriedUserId,
          rollbackAttempts,
          serverLogs,
        };
      }
    }

    let activeSubscription: SubItem | null = null;
    const history: SubItem[] = [];
    const allSubscriptions: SubItem[] = [];
    const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);

    try {
      subscriptionQueryExecuted = true;
      queriedUserId = userId;
      const subBehavior = options.subscriptionsBehavior ?? { kind: "rows", rows: [] };
      if (subBehavior.kind === "db_error") {
        throw subBehavior;
      }
      const userRows = subBehavior.rows.filter(
        (r) => r.user_id.toUpperCase() === userId.toUpperCase(),
      );
      for (const row of userRows) {
        const expiresTime = Math.floor(Date.parse(row.expires_at) / 1000);
        const isExpired =
          row.status !== "active" || Number.isNaN(expiresTime) || expiresTime <= now;
        const remainingDays = isExpired ? 0 : Math.max(0, Math.ceil((expiresTime - now) / 86400));
        const effectiveStatus = isExpired && row.status === "active" ? "expired" : row.status;
        const planName = planNames[row.plan_id] ?? row.plan_id;

        const item: SubItem = {
          subscriptionId: row.subscription_id,
          userId: row.user_id,
          planId: row.plan_id,
          planName,
          orderId: row.order_id,
          paymentId: row.payment_id,
          amount: Number(row.amount),
          currency: row.currency || "INR",
          status: effectiveStatus,
          isExpired,
          remainingDays,
          startsAt: row.starts_at,
          expiresAt: row.expires_at,
          createdAt: row.created_at,
        };

        allSubscriptions.push(item);
        if (!isExpired && row.status === "active" && activeSubscription === null) {
          activeSubscription = item;
        } else {
          history.push(item);
        }
      }
    } catch (e: unknown) {
      const err = e as {
        sqlState?: string;
        driverCode?: number;
        message?: string;
        isRuntime?: boolean;
      };
      safeRollback();
      serverLogs.push(`[subscriptions/my.php] Database error: ${err.message ?? ""}`);
      if (
        !err.isRuntime &&
        isConnUnavailable(err.sqlState ?? "", err.driverCode ?? 0, err.message ?? "")
      ) {
        return {
          status: 503,
          body: {
            success: false,
            error: "Database connection unavailable while loading subscription status.",
          } as MySubApiResponse,
          subscriptionQueryExecuted,
          queriedUserId,
          rollbackAttempts,
          serverLogs,
        };
      }
      return {
        status: 500,
        body: {
          success: false,
          error: "Failed to load subscription status due to a server error.",
        } as MySubApiResponse,
        subscriptionQueryExecuted,
        queriedUserId,
        rollbackAttempts,
        serverLogs,
      };
    }

    return {
      status: 200,
      body: {
        success: true,
        hasActiveSubscription: activeSubscription !== null,
        subscription: activeSubscription,
        activeSubscription,
        history,
        subscriptions: allSubscriptions,
      } as MySubApiResponse,
      subscriptionQueryExecuted,
      queriedUserId,
      rollbackAttempts,
      serverLogs,
    };
  }

  it("1. Preserves HTTP 401 on missing/invalid sessions and HTTP 405 on non-GET requests", () => {
    const { myPhp } = loadPhpSources();
    assert.match(myPhp, /\$authUser\s*=\s*getAuthUser\(\$pdo,\s*true\);/);
    assert.match(myPhp, /if\s*\(\s*!\$authUser\s*\|\|\s*empty\(\$authUser\['user_id'\]\)\s*\)/);
    assert.match(myPhp, /jsonResponse\([\s\S]*?401\s*\);/);
    assert.match(myPhp, /\$userId\s*=\s*\(string\)\$authUser\['user_id'\];/);

    const noToken = createMySubscriptionsHarness({
      bearerToken: null,
      authBehavior: { kind: "none" },
    });
    assert.equal(noToken.status, 401);
    assert.equal(noToken.subscriptionQueryExecuted, false);

    const invalidToken = createMySubscriptionsHarness({
      bearerToken: "expired_or_invalid_tok",
      authBehavior: { kind: "invalid" },
    });
    assert.equal(invalidToken.status, 401);
    assert.equal(invalidToken.subscriptionQueryExecuted, false);

    const postRes = createMySubscriptionsHarness({
      method: "POST",
      bearerToken: "valid_tok",
      authBehavior: { kind: "user", user_id: "FT483921" },
    });
    assert.equal(postRes.status, 405);
  });

  it("2. Preserves empty, active, expired, and cancelled subscription states and optional subscriber_plans handling", () => {
    const nowSec = Math.floor(Date.UTC(2026, 10, 21, 10, 0, 0) / 1000);
    const iso = (offsetDays: number) =>
      new Date((nowSec + offsetDays * 86400) * 1000).toISOString();

    // No subscription -> HTTP 200 empty response
    const noneRes = createMySubscriptionsHarness({
      bearerToken: "tok_user",
      authBehavior: { kind: "user", user_id: "FT483921" },
      subscriptionsBehavior: { kind: "rows", rows: [] },
      nowSeconds: nowSec,
    });
    assert.equal(noneRes.status, 200);
    assert.equal(noneRes.body.success, true);
    assert.equal(noneRes.body.hasActiveSubscription, false);
    assert.equal(noneRes.body.subscription, null);
    assert.equal(noneRes.body.activeSubscription, null);
    assert.deepEqual(noneRes.body.history, []);
    assert.deepEqual(noneRes.body.subscriptions, []);

    // Missing optional subscriber_plans (42S02/1146) falls back to hardcoded plan names;
    // Active + Expired + Cancelled rows preserve exact effective statuses and separation
    const mixedRes = createMySubscriptionsHarness({
      bearerToken: "tok_user",
      authBehavior: { kind: "user", user_id: "FT483921" },
      plansBehavior: {
        kind: "db_error",
        sqlState: "42S02",
        driverCode: 1146,
        message: "Table 'db.subscriber_plans' doesn't exist",
      },
      subscriptionsBehavior: {
        kind: "rows",
        rows: [
          {
            subscription_id: "sub_active_1",
            user_id: "FT483921",
            plan_id: "member-vip-monthly",
            order_id: "ord_1",
            payment_id: "pay_1",
            amount: 149,
            currency: "INR",
            status: "active",
            starts_at: iso(-5),
            expires_at: iso(25),
            created_at: iso(-5),
          },
          {
            subscription_id: "sub_expired_2",
            user_id: "FT483921",
            plan_id: "member-monthly",
            order_id: "ord_2",
            payment_id: "pay_2",
            amount: 49,
            currency: "INR",
            status: "active",
            starts_at: iso(-40),
            expires_at: iso(-10),
            created_at: iso(-40),
          },
          {
            subscription_id: "sub_cancelled_3",
            user_id: "FT483921",
            plan_id: "member-annual",
            order_id: "ord_3",
            payment_id: "pay_3",
            amount: 999,
            currency: "INR",
            status: "cancelled",
            starts_at: iso(-100),
            expires_at: iso(265),
            created_at: iso(-100),
          },
          {
            subscription_id: "sub_other_user",
            user_id: "FT900431",
            plan_id: "member-annual",
            order_id: "ord_9",
            payment_id: "pay_9",
            amount: 999,
            currency: "INR",
            status: "active",
            starts_at: iso(-1),
            expires_at: iso(364),
            created_at: iso(-1),
          },
        ],
      },
      nowSeconds: nowSec,
    });

    assert.equal(mixedRes.status, 200);
    assert.equal(mixedRes.queriedUserId, "FT483921");
    assert.equal(mixedRes.body.success, true);
    assert.equal(mixedRes.body.hasActiveSubscription, true);
    const active = mixedRes.body.subscription!;
    assert.deepEqual(mixedRes.body.activeSubscription, active);
    assert.equal(active.subscriptionId, "sub_active_1");
    assert.equal(active.planName, "VIP Supporter");
    assert.equal(active.status, "active");
    assert.equal(active.isExpired, false);
    assert.equal(active.remainingDays, 25);

    const hist = mixedRes.body.history!;
    assert.equal(hist.length, 2);
    assert.equal(hist[0]!.subscriptionId, "sub_expired_2");
    assert.equal(hist[0]!.status, "expired");
    assert.equal(hist[0]!.isExpired, true);
    assert.equal(hist[0]!.remainingDays, 0);
    assert.equal(hist[1]!.subscriptionId, "sub_cancelled_3");
    assert.equal(hist[1]!.status, "cancelled");
    assert.equal(hist[1]!.isExpired, true);
    assert.equal(hist[1]!.remainingDays, 0);

    const all = mixedRes.body.subscriptions!;
    assert.equal(all.length, 3);
    assert.equal(
      all.some((s) => s.userId === "FT900431"),
      false,
    );
  });

  it("3. Fails closed with HTTP 503 on connection loss and sanitized HTTP 500 on query errors (never returning false no-subscription)", () => {
    const { myPhp } = loadPhpSources();
    assert.match(myPhp, /\$safeRollback\(\$pdo\);/);
    assert.match(myPhp, /isDatabaseConnectionUnavailableError\(\$e\)/);
    assert.match(
      myPhp,
      /\} catch \(Throwable \$e\) \{[\s\S]*FROM user_subscriptions[\s\S]*\} catch \(Throwable \$e\) \{/,
    );
    assert.doesNotMatch(
      myPhp,
      /If user_subscriptions table unmigrated, gracefully return empty arrays/,
    );
    assert.doesNotMatch(myPhp, /jsonResponse\([^\n]*\$e->getMessage\(\)/);

    // Auth DB connection error -> HTTP 503 (never 401), triggers safeRollback + server log
    const authConnErr = createMySubscriptionsHarness({
      bearerToken: "tok_user",
      authBehavior: {
        kind: "db_error",
        sqlState: "42000",
        driverCode: 1203,
        message: "User already has more than 'max_user_connections' active connections",
      },
      inTransaction: true,
      rollbackThrows: true,
    });
    assert.equal(authConnErr.status, 503);
    assert.equal(authConnErr.body.success, false);
    assert.equal(authConnErr.rollbackAttempts, 1);
    assert.ok(authConnErr.serverLogs.some((l) => l.includes("[ROLLBACK]")));
    assert.equal(String(authConnErr.body.error).includes("max_user_connections"), false);

    // subscriber_plans connection error -> HTTP 503 (not swallowed)
    const plansConnErr = createMySubscriptionsHarness({
      bearerToken: "tok_user",
      authBehavior: { kind: "user", user_id: "FT483921" },
      plansBehavior: {
        kind: "db_error",
        sqlState: "HY000",
        driverCode: 2002,
        message: "Connection refused to 127.0.0.1",
      },
    });
    assert.equal(plansConnErr.status, 503);
    assert.equal(plansConnErr.body.success, false);
    assert.equal("hasActiveSubscription" in plansConnErr.body, false);

    // user_subscriptions connection error -> HTTP 503 (never { hasActiveSubscription: false })
    const subConnErr = createMySubscriptionsHarness({
      bearerToken: "tok_user",
      authBehavior: { kind: "user", user_id: "FT483921" },
      subscriptionsBehavior: {
        kind: "db_error",
        sqlState: "HY000",
        driverCode: 2006,
        message: "MySQL server has gone away",
      },
    });
    assert.equal(subConnErr.status, 503);
    assert.equal(subConnErr.body.success, false);
    assert.equal("hasActiveSubscription" in subConnErr.body, false);
    assert.equal("subscription" in subConnErr.body, false);
    assert.equal(String(subConnErr.body.error).includes("gone away"), false);

    // user_subscriptions missing/broken table (42S02 / 1146) or runtime error -> sanitized HTTP 500
    const subTableMissing = createMySubscriptionsHarness({
      bearerToken: "tok_user",
      authBehavior: { kind: "user", user_id: "FT483921" },
      subscriptionsBehavior: {
        kind: "db_error",
        sqlState: "42S02",
        driverCode: 1146,
        message: "Table 'prod_db.user_subscriptions' doesn't exist",
      },
    });
    assert.equal(subTableMissing.status, 500);
    assert.equal(subTableMissing.body.success, false);
    assert.equal("hasActiveSubscription" in subTableMissing.body, false);
    assert.equal(String(subTableMissing.body.error).includes("user_subscriptions"), false);

    // RuntimeException during prepare/execute -> sanitized HTTP 500 + safeRollback
    const runtimeErr = createMySubscriptionsHarness({
      bearerToken: "tok_user",
      authBehavior: { kind: "user", user_id: "FT483921" },
      subscriptionsBehavior: {
        kind: "db_error",
        sqlState: "",
        driverCode: 0,
        message: "Failed to prepare subscription status query.",
        isRuntime: true,
      },
      inTransaction: true,
    });
    assert.equal(runtimeErr.status, 500);
    assert.equal(runtimeErr.body.success, false);
    assert.equal(runtimeErr.rollbackAttempts, 1);
    assert.equal("hasActiveSubscription" in runtimeErr.body, false);
    assert.equal(String(runtimeErr.body.error).includes("Failed to prepare"), false);
  });
});
