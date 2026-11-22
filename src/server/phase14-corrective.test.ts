import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveRazorpayRemotePolicy,
  resetPersistentPremiumState,
  verifyServerPayment,
} from "./payments";
import { handleApiRequest, resetInMemoryStore } from "./api-handler";
import { setMysqlPoolForTesting } from "./mysql";

const RAZORPAY_SECRET = "test_phase14_secret_key_abcdef123456";
const RAZORPAY_KEY_ID = "rzp_test_phase14";

function signOrderPayment(orderId: string, paymentId: string): string {
  return crypto
    .createHmac("sha256", RAZORPAY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
}

function makeMysqlError(message: string, code: string, errno: number, sqlState = "23000") {
  const err: any = new Error(message);
  err.code = code;
  err.errno = errno;
  err.sqlState = sqlState;
  return err;
}

async function expectApiResponse(
  req: Request,
  env: Record<string, string | undefined>,
): Promise<Response> {
  const resp = await handleApiRequest(req, env);
  assert.ok(resp, "Expected handleApiRequest to return a Response");
  return resp;
}

describe("Phase 1.4 Corrective Fixes — Payment Security, Atomic Integrity & Migration Safety", () => {
  let tmpDataDir = "";
  let prevFacetubeDataDir: string | undefined;
  let prevDbEnv: Record<string, string | undefined> = {};
  const originalFetch = globalThis.fetch;

  function enableMockMysqlEnv() {
    process.env["DB_HOST"] = "127.0.0.1";
    process.env["DB_NAME"] = "facetube_phase14_test";
    process.env["DB_USER"] = "facetube_test_user";
    process.env["DB_PASSWORD"] = "facetube_test_pass";
  }

  function restoreMockMysqlEnv() {
    for (const k of ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"]) {
      if (prevDbEnv[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = prevDbEnv[k];
      }
    }
  }

  before(() => {
    prevFacetubeDataDir = process.env["FACETUBE_DATA_DIR"];
    prevDbEnv = {
      DB_HOST: process.env["DB_HOST"],
      DB_NAME: process.env["DB_NAME"],
      DB_USER: process.env["DB_USER"],
      DB_PASSWORD: process.env["DB_PASSWORD"],
    };
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-p14-test-"));
    process.env["FACETUBE_DATA_DIR"] = tmpDataDir;
    resetInMemoryStore();
  });

  after(() => {
    globalThis.fetch = originalFetch;
    setMysqlPoolForTesting(null);
    restoreMockMysqlEnv();
    resetInMemoryStore();
    if (prevFacetubeDataDir === undefined) {
      delete process.env["FACETUBE_DATA_DIR"];
    } else {
      process.env["FACETUBE_DATA_DIR"] = prevFacetubeDataDir;
    }
    if (tmpDataDir && fs.existsSync(tmpDataDir)) {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    globalThis.fetch = originalFetch;
    setMysqlPoolForTesting(null);
    restoreMockMysqlEnv();
    resetInMemoryStore();
    await resetPersistentPremiumState(0, []);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setMysqlPoolForTesting(null);
    restoreMockMysqlEnv();
  });

  function createPhase14MysqlHarness(options: {
    existingOrder?: {
      order_id: string;
      user_id: string;
      user_name?: string;
      video_id?: string | null;
      purpose?: string;
      plan_id?: string | null;
      amount?: number;
      currency?: string;
      status?: string;
      payment_id?: string | null;
    };
    existingTx?: any;
    subscriberPlansError?: Error;
    subscriberPlanRow?: { price: number; duration_days: number; is_active?: number } | null;
    premiumTxInsertError?: Error;
    updatePaymentOrdersError?: Error;
    eligibleVideos?: Array<{
      video_id: string;
      user_id: string;
      ad_earnings?: number;
      is_blocked?: number;
    }>;
  }) {
    const executedQueries: Array<{ sql: string; params: any[] }> = [];
    const walletCredits: Array<{ userId: string; params: any[] }> = [];
    let began = false;
    let committed = false;
    let rolledBack = false;
    let released = false;

    const handleQuery = async (sql: string, params: any[] = []) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      executedQueries.push({ sql: normalized, params });

      if (normalized.includes("FROM INFORMATION_SCHEMA.COLUMNS")) {
        return [
          [
            { TABLE_NAME: "uploaded_videos", COLUMN_NAME: "ad_earnings" },
            { TABLE_NAME: "uploaded_videos", COLUMN_NAME: "is_blocked" },
            { TABLE_NAME: "payment_transactions", COLUMN_NAME: "gst_amount" },
            { TABLE_NAME: "payment_transactions", COLUMN_NAME: "pg_fee" },
            { TABLE_NAME: "payment_transactions", COLUMN_NAME: "referral_status" },
            { TABLE_NAME: "payment_transactions", COLUMN_NAME: "global_pool_distributed" },
            { TABLE_NAME: "payment_transactions", COLUMN_NAME: "global_pool_reserve" },
            { TABLE_NAME: "payment_transactions", COLUMN_NAME: "global_pool_status" },
            { TABLE_NAME: "premium_transactions", COLUMN_NAME: "gst_amount" },
            { TABLE_NAME: "premium_transactions", COLUMN_NAME: "pg_fee" },
            { TABLE_NAME: "premium_transactions", COLUMN_NAME: "referral_status" },
            { TABLE_NAME: "premium_transactions", COLUMN_NAME: "global_pool_distributed" },
            { TABLE_NAME: "premium_transactions", COLUMN_NAME: "global_pool_reserve" },
            { TABLE_NAME: "premium_transactions", COLUMN_NAME: "global_pool_status" },
            {
              TABLE_NAME: "global_pool_reserves",
              COLUMN_NAME: "reserve_reason",
              COLUMN_TYPE: "enum('no_eligible_videos','rounding_residual')",
            },
          ],
        ];
      }

      if (normalized.includes("FROM INFORMATION_SCHEMA.TABLES")) {
        return [
          [{ TABLE_NAME: "global_pool_reserves" }, { TABLE_NAME: "global_pool_settlements" }],
        ];
      }

      if (normalized.includes("FROM sessions s") && normalized.includes("JOIN users u")) {
        return [
          [
            {
              id: "u-alex",
              user_id: "FT483921",
              name: "Alex Rivera",
              mobile: "9999999999",
              email: "alex@facetube.com",
              role: "user",
              referral_code: null,
              avatar_url: null,
              channel_logo_url: null,
              channel_name: "Channel",
              channel_description: null,
              created_at: "2026-01-01T00:00:00.000Z",
            },
          ],
        ];
      }

      if (normalized.includes("FROM payment_orders WHERE order_id = ?")) {
        const ord = options.existingOrder ?? {
          order_id: params[0],
          user_id: "FT483921",
          user_name: "Alex Rivera",
          video_id: "vid_p14_1",
          purpose: "premium_video_upload",
          plan_id: null,
          amount: 6.0,
          currency: "INR",
          status: "created",
          payment_id: null,
        };
        return [[ord]];
      }

      if (normalized.includes("FROM subscriber_plans WHERE plan_id = ?")) {
        if (options.subscriberPlansError) {
          throw options.subscriberPlansError;
        }
        return [options.subscriberPlanRow ? [options.subscriberPlanRow] : []];
      }

      if (normalized.includes("FROM payment_transactions WHERE payment_id = ?")) {
        return [options.existingTx ? [options.existingTx] : []];
      }

      if (normalized.includes("SELECT referrer_id FROM premium_transactions")) {
        return [[]];
      }

      if (normalized.includes("FROM income_ledger WHERE transaction_id = ?")) {
        return [[]];
      }

      if (normalized.includes("FROM user_subscriptions WHERE payment_id = ?")) {
        return [[]];
      }

      if (normalized.includes("FROM uploaded_videos WHERE id = ?")) {
        return [
          [
            {
              id: params[0],
              user_id: "FT483921",
              video_type: "premium",
              payment_status: "pending",
              payment_id: null,
            },
          ],
        ];
      }

      if (normalized.includes("FROM uploaded_videos WHERE payment_id = ? AND id != ?")) {
        return [[]];
      }

      if (normalized.includes("SELECT user_id FROM users WHERE role = 'admin'")) {
        return [[{ user_id: "FT102857" }]];
      }

      if (normalized.includes("SELECT COUNT(*) as total FROM payment_transactions")) {
        return [[{ total: 0 }]];
      }

      if (normalized.includes("SELECT id, user_id, referral_code FROM users")) {
        return [[{ id: "u-alex", user_id: "FT483921", referral_code: null }]];
      }

      if (normalized.includes("FROM uploaded_videos WHERE (video_type = 'premium'")) {
        return [options.eligibleVideos ?? []];
      }

      if (normalized.startsWith("INSERT INTO payment_transactions")) {
        return [{ affectedRows: 1 }];
      }

      if (normalized.startsWith("INSERT INTO premium_transactions")) {
        if (options.premiumTxInsertError) {
          throw options.premiumTxInsertError;
        }
        return [{ affectedRows: 1 }];
      }

      if (normalized.startsWith("INSERT INTO user_subscriptions")) {
        return [{ affectedRows: 1 }];
      }

      if (normalized.startsWith("INSERT INTO income_ledger")) {
        return [{ affectedRows: 1 }];
      }

      if (normalized.startsWith("INSERT INTO global_pool_reserves")) {
        return [{ affectedRows: 1 }];
      }

      if (normalized.startsWith("INSERT INTO wallet_balances")) {
        walletCredits.push({ userId: String(params[0]), params });
        return [{ affectedRows: 1 }];
      }

      if (normalized.startsWith("UPDATE uploaded_videos")) {
        return [{ affectedRows: 1 }];
      }

      if (normalized.startsWith("UPDATE payment_orders")) {
        if (options.updatePaymentOrdersError) {
          throw options.updatePaymentOrdersError;
        }
        return [{ affectedRows: 1 }];
      }

      return [[]];
    };

    const conn = {
      query: handleQuery,
      execute: handleQuery,
      beginTransaction: async () => {
        began = true;
      },
      commit: async () => {
        committed = true;
      },
      rollback: async () => {
        rolledBack = true;
      },
      release: () => {
        released = true;
      },
    };

    const pool: any = {
      query: handleQuery,
      execute: handleQuery,
      getConnection: async () => conn,
    };

    return {
      pool,
      getState: () => ({ began, committed, rolledBack, released, executedQueries, walletCredits }),
    };
  }

  describe("FIX 1 — PHP locked paid-order fallback requires payment_transactions proof", () => {
    it("verifies api/payments/verify.php locked status===paid path never returns 200 without payment_transactions proof", () => {
      const phpPath = path.resolve(process.cwd(), "api/payments/verify.php");
      const phpSource = fs.readFileSync(phpPath, "utf8");

      const lockedStart = phpSource.indexOf("if ($orderRecord['status'] === 'paid')");
      assert.notEqual(lockedStart, -1, "Locked paid-order branch must exist in verify.php");
      const lockedBlock = phpSource.slice(lockedStart, lockedStart + 1800);

      assert.ok(
        lockedBlock.includes("SELECT * FROM payment_transactions WHERE payment_id = ? FOR UPDATE"),
        "Locked paid-order branch must lock payment_transactions FOR UPDATE",
      );
      assert.ok(
        !lockedBlock.includes("catch ("),
        "Locked paid-order branch must not swallow SQL errors from payment_transactions lookup",
      );
      assert.ok(
        lockedBlock.includes("409") &&
          lockedBlock.includes(
            "marked paid without a matching verified payment transaction record",
          ),
        "Missing payment_transactions proof under paid order must rollback and return 409",
      );
      assert.ok(
        !lockedBlock.includes("verified' => true") && !lockedBlock.includes("'verified' => true"),
        "Locked paid-order branch must never blindly return verified:true from order status alone",
      );
    });
  });

  describe("FIX 2 — Node Razorpay remote verification policy & fail-closed credentials", () => {
    it("never interprets Boolean('false') or Boolean('0') as truthy and only skips in permitted non-prod when === 'true'", () => {
      assert.deepEqual(
        resolveRazorpayRemotePolicy({
          NODE_ENV: "development",
          RAZORPAY_SKIP_REMOTE_CHECK: "false",
        }),
        { isProduction: false, skipRemote: false },
      );
      assert.deepEqual(
        resolveRazorpayRemotePolicy({ NODE_ENV: "test", RAZORPAY_SKIP_REMOTE_CHECK: "0" }),
        { isProduction: false, skipRemote: false },
      );
      assert.deepEqual(
        resolveRazorpayRemotePolicy({ NODE_ENV: "production", RAZORPAY_SKIP_REMOTE_CHECK: "true" }),
        { isProduction: true, skipRemote: false },
      );
      assert.deepEqual(
        resolveRazorpayRemotePolicy({
          APP_ENV: "production",
          NODE_ENV: "development",
          RAZORPAY_SKIP_REMOTE_CHECK: "true",
        }),
        { isProduction: true, skipRemote: false },
      );
      assert.deepEqual(
        resolveRazorpayRemotePolicy({
          NODE_ENV: "",
          APP_ENV: "",
          RAZORPAY_SKIP_REMOTE_CHECK: "true",
        }),
        { isProduction: true, skipRemote: false },
      );
      assert.deepEqual(
        resolveRazorpayRemotePolicy({ NODE_ENV: "staging", RAZORPAY_SKIP_REMOTE_CHECK: "true" }),
        { isProduction: true, skipRemote: false },
      );
      assert.deepEqual(
        resolveRazorpayRemotePolicy({ NODE_ENV: "test", RAZORPAY_SKIP_REMOTE_CHECK: "true" }),
        { isProduction: false, skipRemote: true },
      );
    });

    it("does NOT skip remote fetch when RAZORPAY_SKIP_REMOTE_CHECK='false' or '0' or in production", async () => {
      for (const testCase of [
        { label: "false in test", env: { NODE_ENV: "test", RAZORPAY_SKIP_REMOTE_CHECK: "false" } },
        {
          label: "0 in development",
          env: { NODE_ENV: "development", RAZORPAY_SKIP_REMOTE_CHECK: "0" },
        },
        {
          label: "true in production",
          env: { NODE_ENV: "production", RAZORPAY_SKIP_REMOTE_CHECK: "true" },
        },
      ]) {
        let fetchCalls = 0;
        globalThis.fetch = (async () => {
          fetchCalls++;
          return new Response(
            JSON.stringify({
              id: "pay_p14_remote_1",
              order_id: "order_p14_remote_1",
              status: "captured",
              amount: 600,
              currency: "INR",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }) as typeof fetch;

        const res = await verifyServerPayment(
          {
            orderId: "order_p14_remote_1",
            paymentId: "pay_p14_remote_1",
            signature: signOrderPayment("order_p14_remote_1", "pay_p14_remote_1"),
            userId: "FT483921",
            videoId: "vid_remote_1",
            purpose: "premium_video_upload",
          },
          [],
          null,
          {
            RAZORPAY_KEY_ID,
            RAZORPAY_KEY_SECRET: RAZORPAY_SECRET,
            ...testCase.env,
          },
        );

        assert.equal(res.verified, true, `${testCase.label} should verify when remote matches`);
        assert.equal(fetchCalls, 1, `${testCase.label} MUST call Razorpay remote API`);
        await resetPersistentPremiumState(0, []);
      }
    });

    it("fails closed with 500 if RAZORPAY_KEY_ID is missing in production even when order status is paid", async () => {
      enableMockMysqlEnv();
      const orderId = "order_p14_missing_keyid";
      const paymentId = "pay_p14_missing_keyid";
      const harness = createPhase14MysqlHarness({
        existingOrder: {
          order_id: orderId,
          user_id: "FT483921",
          video_id: "vid_p14_1",
          purpose: "premium_video_upload",
          amount: 6.0,
          currency: "INR",
          status: "paid",
          payment_id: paymentId,
        },
        existingTx: {
          order_id: orderId,
          payment_id: paymentId,
          user_id: "FT483921",
          video_id: "vid_p14_1",
          purpose: "premium_video_upload",
          amount: 6.0,
          tx_number: 1,
          referral_commission: 1.0,
          admin_allocation: 1.0,
          global_pool_allocation: 3.0,
        },
      });
      setMysqlPoolForTesting(harness.pool);

      const req = new Request("http://localhost:3000/api/payments/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tok_user",
        },
        body: JSON.stringify({
          orderId,
          paymentId,
          signature: signOrderPayment(orderId, paymentId),
          purpose: "premium_video_upload",
          videoId: "vid_p14_1",
        }),
      });

      const resp = await expectApiResponse(req, {
        NODE_ENV: "production",
        RAZORPAY_KEY_SECRET: RAZORPAY_SECRET,
        RAZORPAY_SKIP_REMOTE_CHECK: "true",
      });
      const data = await resp.json();
      assert.equal(resp.status, 500);
      assert.equal(data.verified, false);
    });

    it("rejects remote gateway payload mismatches (id, order_id, amount, currency) with 400 and writes nothing", async () => {
      enableMockMysqlEnv();
      const orderId = "order_p14_mismatch";
      const paymentId = "pay_p14_mismatch";

      const badPayloads = [
        { id: "pay_other", order_id: orderId, status: "captured", amount: 600, currency: "INR" },
        {
          id: paymentId,
          order_id: "order_other",
          status: "captured",
          amount: 600,
          currency: "INR",
        },
        { id: paymentId, order_id: orderId, status: "captured", amount: 500, currency: "INR" },
        { id: paymentId, order_id: orderId, status: "captured", amount: 600, currency: "USD" },
      ];

      for (const bad of badPayloads) {
        const harness = createPhase14MysqlHarness({
          existingOrder: {
            order_id: orderId,
            user_id: "FT483921",
            video_id: "vid_p14_1",
            purpose: "premium_video_upload",
            amount: 6.0,
            currency: "INR",
            status: "created",
            payment_id: null,
          },
        });
        setMysqlPoolForTesting(harness.pool);

        globalThis.fetch = (async () =>
          new Response(JSON.stringify(bad), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })) as typeof fetch;

        const req = new Request("http://localhost:3000/api/payments/verify", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer tok_user",
          },
          body: JSON.stringify({
            orderId,
            paymentId,
            signature: signOrderPayment(orderId, paymentId),
            purpose: "premium_video_upload",
            videoId: "vid_p14_1",
          }),
        });

        const resp = await expectApiResponse(req, {
          NODE_ENV: "production",
          RAZORPAY_KEY_ID,
          RAZORPAY_KEY_SECRET: RAZORPAY_SECRET,
        });
        const data = await resp.json();
        assert.equal(resp.status, 400);
        assert.equal(data.verified, false);
        assert.equal(
          harness.getState().began,
          false,
          "Failed gateway check must reject before DB tx",
        );
        assert.equal(harness.getState().walletCredits.length, 0);
      }
    });
  });

  describe("FIX 3 — PHP Razorpay gateway amount parity before DB transaction", () => {
    it("verifies api/payments/verify.php checks pData amount in paise, id, order_id, and INR before beginTransaction", () => {
      const phpSource = fs.readFileSync(
        path.resolve(process.cwd(), "api/payments/verify.php"),
        "utf8",
      );
      const curlIdx = phpSource.indexOf(
        'curl_init("https://api.razorpay.com/v1/payments/{$paymentId}")',
      );
      const beginTxIdx = phpSource.indexOf("$pdo->beginTransaction();");
      assert.notEqual(curlIdx, -1);
      assert.notEqual(beginTxIdx, -1);
      assert.ok(curlIdx < beginTxIdx);

      const preTxSection = phpSource.slice(curlIdx, beginTxIdx);
      assert.ok(preTxSection.includes("(string)$pData['id'] !== $paymentId"));
      assert.ok(preTxSection.includes("(string)$pData['order_id'] !== $orderId"));
      assert.ok(preTxSection.includes("$preExpectedSubunits = (int)round($preOrderAmount * 100);"));
      assert.ok(preTxSection.includes("if ($gatewayAmountSubunits !== $preExpectedSubunits)"));
      assert.ok(preTxSection.includes("!== 'INR'"));
      assert.ok(preTxSection.includes("$capAmount = $preExpectedSubunits;"));
    });
  });

  describe("FIX 4 — Atomic DB error handling (no silent swallowing)", () => {
    it("allows missing optional premium_transactions (1146), but rolls back non-1146 errors on premium_transactions", async () => {
      enableMockMysqlEnv();

      // 1) ER_NO_SUCH_TABLE (1146) should proceed gracefully and commit
      {
        const orderId = "order_p14_pt_1146";
        const paymentId = "pay_p14_pt_1146";
        const harness = createPhase14MysqlHarness({
          premiumTxInsertError: makeMysqlError(
            "Table 'facetube.premium_transactions' doesn't exist",
            "ER_NO_SUCH_TABLE",
            1146,
            "42S02",
          ),
        });
        setMysqlPoolForTesting(harness.pool);

        const req = new Request("http://localhost:3000/api/payments/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer tok_user" },
          body: JSON.stringify({
            orderId,
            paymentId,
            signature: signOrderPayment(orderId, paymentId),
            purpose: "premium_video_upload",
            videoId: "vid_p14_1",
          }),
        });
        const resp = await expectApiResponse(req, {
          NODE_ENV: "test",
          RAZORPAY_KEY_ID,
          RAZORPAY_KEY_SECRET: RAZORPAY_SECRET,
          RAZORPAY_SKIP_REMOTE_CHECK: "true",
        });
        const data = await resp.json();
        assert.equal(resp.status, 200);
        assert.equal(data.verified, true);
        assert.equal(harness.getState().committed, true);
        assert.equal(harness.getState().rolledBack, false);
        // Uniform ₹6 breakdown invariant
        assert.equal(data.distribution.directReferralAmount, 1);
        assert.equal(data.distribution.adminAmount, 1);
        assert.equal(data.distribution.gstAmount, 0.9);
        assert.equal(data.distribution.pgFeeAmount, 0.1);
        assert.equal(data.distribution.globalPoolAmount, 3);
        assert.equal(data.distribution.totalAmount, 6);
      }

      // 2) ER_DATA_TOO_LONG (1406) on premium_transactions MUST roll back cleanly (never 200)
      {
        const orderId = "order_p14_pt_1406";
        const paymentId = "pay_p14_pt_1406";
        const harness = createPhase14MysqlHarness({
          premiumTxInsertError: makeMysqlError(
            "Data too long for column 'special_tag'",
            "ER_DATA_TOO_LONG",
            1406,
            "22001",
          ),
        });
        setMysqlPoolForTesting(harness.pool);

        const req = new Request("http://localhost:3000/api/payments/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer tok_user" },
          body: JSON.stringify({
            orderId,
            paymentId,
            signature: signOrderPayment(orderId, paymentId),
            purpose: "premium_video_upload",
            videoId: "vid_p14_1",
          }),
        });
        const resp = await expectApiResponse(req, {
          NODE_ENV: "test",
          RAZORPAY_KEY_ID,
          RAZORPAY_KEY_SECRET: RAZORPAY_SECRET,
          RAZORPAY_SKIP_REMOTE_CHECK: "true",
        });
        assert.notEqual(resp.status, 200);
        assert.equal(harness.getState().rolledBack, true);
        assert.equal(harness.getState().committed, false);
      }
    });

    it("allows missing optional subscriber_plans (1146), but fails closed on non-1146 SQL errors", async () => {
      enableMockMysqlEnv();
      const orderId = "order_p14_sub_sqlerr";
      const paymentId = "pay_p14_sub_sqlerr";
      const harness = createPhase14MysqlHarness({
        existingOrder: {
          order_id: orderId,
          user_id: "FT483921",
          video_id: null,
          purpose: "paid_subscription",
          plan_id: "member-monthly",
          amount: 49.0,
          currency: "INR",
          status: "created",
          payment_id: null,
        },
        subscriberPlansError: makeMysqlError(
          "Unknown column 'duration_days' in 'field list'",
          "ER_BAD_FIELD_ERROR",
          1054,
          "42S22",
        ),
      });
      setMysqlPoolForTesting(harness.pool);

      const req = new Request("http://localhost:3000/api/payments/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tok_user" },
        body: JSON.stringify({
          orderId,
          paymentId,
          signature: signOrderPayment(orderId, paymentId),
          purpose: "paid_subscription",
        }),
      });
      const resp = await expectApiResponse(req, {
        NODE_ENV: "test",
        RAZORPAY_KEY_ID,
        RAZORPAY_KEY_SECRET: RAZORPAY_SECRET,
        RAZORPAY_SKIP_REMOTE_CHECK: "true",
      });
      assert.equal(resp.status, 500);
      assert.equal(harness.getState().began, false);
    });

    it("rolls back the full transaction if UPDATE payment_orders fails (premium_video_upload & paid_subscription)", async () => {
      enableMockMysqlEnv();

      for (const purpose of ["premium_video_upload", "paid_subscription"] as const) {
        const orderId = `order_p14_upd_fail_${purpose}`;
        const paymentId = `pay_p14_upd_fail_${purpose}`;
        const harness = createPhase14MysqlHarness({
          existingOrder: {
            order_id: orderId,
            user_id: "FT483921",
            video_id: purpose === "premium_video_upload" ? "vid_p14_1" : null,
            purpose,
            plan_id: purpose === "paid_subscription" ? "member-monthly" : null,
            amount: purpose === "paid_subscription" ? 49.0 : 6.0,
            currency: "INR",
            status: "created",
            payment_id: null,
          },
          updatePaymentOrdersError: makeMysqlError(
            "Lock wait timeout exceeded",
            "ER_LOCK_WAIT_TIMEOUT",
            1205,
            "HY000",
          ),
        });
        setMysqlPoolForTesting(harness.pool);

        const req = new Request("http://localhost:3000/api/payments/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer tok_user" },
          body: JSON.stringify({
            orderId,
            paymentId,
            signature: signOrderPayment(orderId, paymentId),
            purpose,
            ...(purpose === "premium_video_upload" ? { videoId: "vid_p14_1" } : {}),
          }),
        });
        const resp = await expectApiResponse(req, {
          NODE_ENV: "test",
          RAZORPAY_KEY_ID,
          RAZORPAY_KEY_SECRET: RAZORPAY_SECRET,
          RAZORPAY_SKIP_REMOTE_CHECK: "true",
        });
        assert.notEqual(resp.status, 200, `${purpose} must fail when UPDATE payment_orders throws`);
        assert.equal(harness.getState().rolledBack, true);
        assert.equal(harness.getState().committed, false);
      }
    });

    it("verifies PHP verify.php only ignores missing optional tables and does not swallow UPDATE payment_orders", () => {
      const phpSource = fs.readFileSync(
        path.resolve(process.cwd(), "api/payments/verify.php"),
        "utf8",
      );
      assert.ok(phpSource.includes("$isMissingOptionalTable = static function"));
      assert.ok(
        phpSource.includes("if (!$isMissingOptionalTable($ePt)) {\n                throw $ePt;"),
      );
      assert.ok(
        phpSource.includes(
          "if (!$isMissingOptionalTable($ePlan)) {\n                throw $ePlan;",
        ),
      );
      assert.ok(
        phpSource.includes("if (!$isMissingOptionalTable($eCol)) {\n                throw $eCol;"),
      );

      const updateOrderIdx = phpSource.lastIndexOf("UPDATE payment_orders");
      assert.notEqual(updateOrderIdx, -1);
      const aroundUpdate = phpSource.slice(updateOrderIdx - 250, updateOrderIdx + 350);
      assert.ok(!aroundUpdate.includes("try {") && !aroundUpdate.includes("catch ("));
    });
  });

  describe("FIX 5 — Empty videoId duplicate identity protection", () => {
    it("allows retry omitting videoId when server order carries the matching video_id, returning 200 duplicate:true", async () => {
      enableMockMysqlEnv();
      const orderId = "order_p14_vid_from_order";
      const paymentId = "pay_p14_vid_from_order";
      const harness = createPhase14MysqlHarness({
        existingOrder: {
          order_id: orderId,
          user_id: "FT483921",
          video_id: "vid_authoritative_1",
          purpose: "premium_video_upload",
          amount: 6.0,
          currency: "INR",
          status: "paid",
          payment_id: paymentId,
        },
        existingTx: {
          order_id: orderId,
          payment_id: paymentId,
          user_id: "FT483921",
          video_id: "vid_authoritative_1",
          purpose: "premium_video_upload",
          amount: 6.0,
          tx_number: 1,
          referral_commission: 1.0,
          admin_allocation: 1.0,
          global_pool_allocation: 3.0,
          gst_amount: 0.9,
          pg_fee: 0.1,
          referral_status: "unassigned_pending",
        },
      });
      setMysqlPoolForTesting(harness.pool);

      const req = new Request("http://localhost:3000/api/payments/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tok_user" },
        body: JSON.stringify({
          orderId,
          paymentId,
          signature: signOrderPayment(orderId, paymentId),
          purpose: "premium_video_upload",
        }),
      });
      const resp = await expectApiResponse(req, {
        NODE_ENV: "test",
        RAZORPAY_KEY_ID,
        RAZORPAY_KEY_SECRET: RAZORPAY_SECRET,
        RAZORPAY_SKIP_REMOTE_CHECK: "true",
      });
      const data = await resp.json();
      assert.equal(resp.status, 200);
      assert.equal(data.verified, true);
      assert.equal(data.duplicate, true);
    });

    it("rejects empty videoId retry with 409 when existingTx has non-empty video_id and order video_id is null", async () => {
      enableMockMysqlEnv();
      const orderId = "order_p14_vid_missing";
      const paymentId = "pay_p14_vid_missing";
      const harness = createPhase14MysqlHarness({
        existingOrder: {
          order_id: orderId,
          user_id: "FT483921",
          video_id: null,
          purpose: "premium_video_upload",
          amount: 6.0,
          currency: "INR",
          status: "paid",
          payment_id: paymentId,
        },
        existingTx: {
          order_id: orderId,
          payment_id: paymentId,
          user_id: "FT483921",
          video_id: "vid_original_owner",
          purpose: "premium_video_upload",
          amount: 6.0,
          tx_number: 1,
          referral_commission: 1.0,
          admin_allocation: 1.0,
          global_pool_allocation: 3.0,
        },
      });
      setMysqlPoolForTesting(harness.pool);

      const req = new Request("http://localhost:3000/api/payments/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tok_user" },
        body: JSON.stringify({
          orderId,
          paymentId,
          signature: signOrderPayment(orderId, paymentId),
          purpose: "premium_video_upload",
        }),
      });
      const resp = await expectApiResponse(req, {
        NODE_ENV: "test",
        RAZORPAY_KEY_ID,
        RAZORPAY_KEY_SECRET: RAZORPAY_SECRET,
        RAZORPAY_SKIP_REMOTE_CHECK: "true",
      });
      const data = await resp.json();
      assert.equal(resp.status, 409);
      assert.equal(data.verified, false);
    });

    it("rejects empty videoId retry in verifyServerPayment when existingTx had non-empty videoId", async () => {
      const orderId = "order_p14_direct_empty_vid";
      const paymentId = "pay_p14_direct_empty_vid";
      const sig = signOrderPayment(orderId, paymentId);
      const env = {
        NODE_ENV: "test",
        RAZORPAY_KEY_ID,
        RAZORPAY_KEY_SECRET: RAZORPAY_SECRET,
        RAZORPAY_SKIP_REMOTE_CHECK: "true",
      };

      const first = await verifyServerPayment(
        {
          orderId,
          paymentId,
          signature: sig,
          userId: "FT483921",
          videoId: "vid_direct_1",
          purpose: "premium_video_upload",
        },
        [],
        null,
        env,
      );
      assert.equal(first.verified, true);

      const retryEmpty = await verifyServerPayment(
        {
          orderId,
          paymentId,
          signature: sig,
          userId: "FT483921",
          purpose: "premium_video_upload",
        },
        [],
        null,
        env,
      );
      assert.equal(retryEmpty.verified, false);
      assert.match(retryEmpty.error || "", /Conflict/i);
    });

    it("verifies PHP verify.php enforces existingTxVideoId !== '' && existingTxVideoId !== resolvedVideoId", () => {
      const phpSource = fs.readFileSync(
        path.resolve(process.cwd(), "api/payments/verify.php"),
        "utf8",
      );
      assert.ok(
        phpSource.includes(
          "$txVideoMismatch = $existingTxVideoId !== '' && $existingTxVideoId !== $resolvedVideoId;",
        ),
      );
    });
  });

  describe("FIX 6 — Read-only migration inspection checks", () => {
    it("confirms 20261010/20261027 quirks and 20261123/20261124/20261125 portability without modifying files", () => {
      const migDir = path.resolve(process.cwd(), "database/migrations");
      const m20261010 = fs.readFileSync(
        path.join(migDir, "20261010_payment_transactions_unique_payment_id.sql"),
        "utf8",
      );
      const m20261027 = fs.readFileSync(
        path.join(migDir, "20261027_company_audit_updates.sql"),
        "utf8",
      );
      const m20261123 = fs.readFileSync(
        path.join(migDir, "20261123_admob_report_staging.sql"),
        "utf8",
      );
      const m20261124 = fs.readFileSync(
        path.join(migDir, "20261124_uniform_premium_six_accounting.sql"),
        "utf8",
      );
      const m20261125 = fs.readFileSync(
        path.join(migDir, "20261125_global_pool_reserve_and_settlement.sql"),
        "utf8",
      );

      assert.ok(
        m20261010.startsWith("<?php"),
        "20261010 has <?php header requiring manual strip before SQL import",
      );
      assert.ok(
        m20261010.includes("HAVING `cnt` > 1"),
        "20261010 contains mid-file diagnostic SELECT",
      );
      assert.ok(
        m20261027.includes("ADD COLUMN IF NOT EXISTS") &&
          m20261027.includes("CREATE INDEX IF NOT EXISTS"),
        "20261027 uses MariaDB-only IF NOT EXISTS DDL on lines 13-25",
      );
      for (const portableSql of [m20261123, m20261124, m20261125]) {
        assert.ok(!portableSql.includes("ADD COLUMN IF NOT EXISTS"));
        assert.ok(!portableSql.includes("CREATE INDEX IF NOT EXISTS"));
        assert.ok(portableSql.includes("INFORMATION_SCHEMA"));
      }
    });
  });
});
