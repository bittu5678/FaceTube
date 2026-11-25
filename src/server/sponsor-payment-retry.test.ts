import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleApiRequest, resetInMemoryStore } from "./api-handler";
import { resetPersistentPremiumState } from "./payments";
import { setMysqlPoolForTesting } from "./mysql";
import { api } from "../lib/api";
import {
  initiatePremiumVideoPayment,
  resetRazorpayClientStateForTests,
  shouldClearPendingPremiumPaymentOnFailure,
  type PendingPremiumPaymentProof,
} from "../lib/razorpay-service";

const RAZORPAY_KEY_ID = "rzp_test_sponsor_retry_key";
const RAZORPAY_SECRET = "rzp_test_sponsor_retry_secret_123456";

function signOrderPayment(orderId: string, paymentId: string): string {
  return crypto
    .createHmac("sha256", RAZORPAY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
}

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? (store.get(key) ?? null) : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
}

function createSponsorRetryMysqlHarness(options?: {
  hasGlobalPoolReservesTable?: boolean;
  metadataQueryError?: Error | null;
  eligibleVideos?: Array<{
    video_id: string;
    user_id: string;
    ad_earnings?: number;
    is_blocked?: number;
  }>;
}) {
  let hasGlobalPoolReservesTable = options?.hasGlobalPoolReservesTable ?? true;
  let metadataQueryError: Error | null = options?.metadataQueryError ?? null;

  const orders = new Map<string, any>();
  const paymentTransactions = new Map<string, any>();
  const premiumTransactions: any[] = [];
  const reserves: any[] = [];
  const ledgerEntries: any[] = [];
  const walletBalances = new Map<string, { total: number; referral: number; global: number }>();
  const videos = new Map<string, any>();

  let committedCount = 0;
  let rolledBackCount = 0;

  const handleQuery = async (sql: string, params: any[] = []) => {
    const norm = sql.replace(/\s+/g, " ").trim();

    if (norm.includes("FROM INFORMATION_SCHEMA.TABLES")) {
      if (metadataQueryError) {
        throw metadataQueryError;
      }
      if (!hasGlobalPoolReservesTable) {
        return [[]];
      }
      if (norm.includes("global_pool_settlements")) {
        return [
          [{ TABLE_NAME: "global_pool_reserves" }, { TABLE_NAME: "global_pool_settlements" }],
        ];
      }
      return [[{ TABLE_NAME: "global_pool_reserves" }]];
    }

    if (norm.includes("FROM INFORMATION_SCHEMA.COLUMNS")) {
      return [
        [
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
          { TABLE_NAME: "uploaded_videos", COLUMN_NAME: "ad_earnings" },
          { TABLE_NAME: "uploaded_videos", COLUMN_NAME: "is_blocked" },
          {
            TABLE_NAME: "global_pool_reserves",
            COLUMN_NAME: "reserve_reason",
            COLUMN_TYPE:
              "enum('no_eligible_videos','insufficient_distributable_paise','rounding_residual')",
          },
        ],
      ];
    }

    if (norm.includes("FROM sessions s") && norm.includes("JOIN users u")) {
      return [
        [
          {
            id: "u-alex",
            user_id: "FT483921",
            name: "Alex Rivera",
            mobile: "9999999999",
            email: "alex@facetube.com",
            role: "user",
            referral_code: "FT900431",
            avatar_url: null,
            channel_logo_url: null,
            channel_name: "Alex Channel",
            channel_description: null,
            created_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      ];
    }

    if (norm.startsWith("INSERT INTO payment_orders")) {
      orders.set(String(params[0]), {
        order_id: String(params[0]),
        user_id: String(params[1]),
        user_name: String(params[2]),
        video_id: params[3] ? String(params[3]) : null,
        purpose: String(params[4]),
        plan_id: params[5] ? String(params[5]) : null,
        content_type: params[6] ? String(params[6]) : null,
        amount: Number(params[7]),
        currency: "INR",
        status: "created",
        payment_id: null,
      });
      return [{ affectedRows: 1 }];
    }

    if (norm.includes("FROM payment_orders WHERE order_id = ?")) {
      const ord = orders.get(String(params[0]));
      return [ord ? [ord] : []];
    }

    if (norm.includes("FROM payment_orders WHERE payment_id = ?")) {
      const targetPayId = String(params[0]);
      const match = Array.from(orders.values()).find((o) => o.payment_id === targetPayId);
      return [match ? [match] : []];
    }

    if (norm.includes("FROM payment_transactions WHERE payment_id = ?")) {
      const tx = paymentTransactions.get(String(params[0]));
      return [tx ? [tx] : []];
    }

    if (norm.includes("FROM uploaded_videos WHERE payment_id = ? AND id != ?")) {
      const payId = String(params[0]);
      const vidId = String(params[1]);
      const match = Array.from(videos.values()).find(
        (v) => v.payment_id === payId && v.id !== vidId,
      );
      return [match ? [match] : []];
    }

    if (norm.includes("FROM uploaded_videos WHERE id = ?")) {
      const vid = videos.get(String(params[0]));
      return [vid ? [vid] : []];
    }

    if (
      norm.includes(
        "SELECT id, user_id, video_type, payment_status FROM uploaded_videos WHERE id = ?",
      )
    ) {
      const vid = videos.get(String(params[0]));
      return [vid ? [vid] : []];
    }

    if (norm.includes("SELECT user_id FROM users WHERE role = 'admin'")) {
      return [[{ user_id: "FT102857" }]];
    }

    if (
      norm.includes(
        "SELECT COUNT(*) as total FROM payment_transactions WHERE purpose = 'premium_video_upload'",
      )
    ) {
      return [[{ total: paymentTransactions.size }]];
    }

    if (norm.includes("SELECT id, user_id, referral_code FROM users")) {
      return [[{ id: "u-alex", user_id: "FT483921", referral_code: "FT900431" }]];
    }

    if (
      norm.includes("SELECT user_id FROM users WHERE (UPPER(user_id)") ||
      (norm.includes("SELECT user_id, referral_code, name FROM users") &&
        norm.includes("UPPER(user_id) != UPPER(?)"))
    ) {
      return [[{ user_id: "FT900431", referral_code: null, name: "Sponsor User" }]];
    }

    if (norm.includes("FROM uploaded_videos WHERE (video_type = 'premium'")) {
      const list = options?.eligibleVideos ?? [];
      if (norm.includes("UPPER(user_id) != UPPER(?)")) {
        const excl = String(params[0] || "").toUpperCase();
        return [list.filter((v) => v.user_id.toUpperCase() !== excl)];
      }
      return [list];
    }

    if (norm.startsWith("INSERT INTO payment_transactions")) {
      const paymentId = String(params[1]);
      if (paymentTransactions.has(paymentId)) {
        const dupErr: any = new Error(`Duplicate entry '${paymentId}'`);
        dupErr.code = "ER_DUP_ENTRY";
        dupErr.errno = 1062;
        throw dupErr;
      }
      paymentTransactions.set(paymentId, {
        order_id: params[0],
        payment_id: paymentId,
        user_id: params[2],
        user_name: params[3],
        video_id: params[4],
        purpose: params[5],
        amount: Number(params[6]),
        tx_number: Number(params[7]),
        is_special: 0,
        special_tag: params[8],
        referral_commission: Number(params[9]),
        admin_allocation: Number(params[10]),
        global_pool_allocation: Number(params[11]),
        global_pool_distributed: Number(params[12]),
        global_pool_reserve: Number(params[13]),
        global_pool_status: params[14],
        gst_amount: Number(params[15]),
        pg_fee: Number(params[16]),
        referral_status: params[17],
      });
      return [{ affectedRows: 1 }];
    }

    if (norm.startsWith("INSERT INTO premium_transactions")) {
      premiumTransactions.push({ payment_id: params[0], order_id: params[1], params });
      return [{ affectedRows: 1 }];
    }

    if (norm.startsWith("INSERT INTO global_pool_reserves")) {
      reserves.push({
        id: String(params[0]),
        payment_id: String(params[1]),
        order_id: String(params[2]),
        tx_number: Number(params[3]),
        source_user_id: String(params[4]),
        source_video_id: params[5] ? String(params[5]) : null,
        reserve_amount: Number(params[6]),
        reserve_paise: Number(params[7]),
        reserve_reason: String(params[8]),
        status: "pending",
      });
      return [{ affectedRows: 1 }];
    }

    if (norm.startsWith("INSERT INTO income_ledger")) {
      ledgerEntries.push({
        user_id: params[0],
        transaction_id: params[1],
        source_type: params[2],
        amount: params[3],
        status: norm.includes("'pending'") ? "pending" : "credited",
      });
      return [{ affectedRows: 1 }];
    }

    if (norm.startsWith("INSERT INTO wallet_balances")) {
      const uid = String(params[0]);
      const existing = walletBalances.get(uid) || { total: 0, referral: 0, global: 0 };
      if (norm.includes("referral_income, global_income, adsense_income")) {
        existing.total += 1.0;
        existing.referral += 1.0;
      } else if (params.length === 4) {
        existing.total += Number(params[1]);
        existing.global += Number(params[3]);
      } else {
        existing.total += Number(params[1]);
      }
      walletBalances.set(uid, existing);
      return [{ affectedRows: 1 }];
    }

    if (norm.startsWith("UPDATE payment_orders SET status = 'paid'")) {
      const payId = String(params[0]);
      const ordId = String(params[1]);
      const ord = orders.get(ordId);
      if (ord) {
        ord.status = "paid";
        ord.payment_id = payId;
      }
      return [{ affectedRows: 1 }];
    }

    if (norm.startsWith("INSERT INTO uploaded_videos")) {
      const vidId = String(params[0]);
      videos.set(vidId, {
        id: vidId,
        user_id: String(params[1]),
        creator_name: String(params[2]),
        title: String(params[3]),
        description: String(params[4]),
        video_url: String(params[5]),
        thumbnail_url: String(params[6]),
        video_type: String(params[7]),
        content_type: String(params[8]),
        category: String(params[9]),
        duration: String(params[10]),
        payment_status: String(params[11]),
        payment_id: String(params[12]),
        payment_amount: Number(params[13]),
        visibility: String(params[14]),
        is_promoted: 0,
        views: 0,
        likes: 0,
        created_at: new Date().toISOString(),
      });
      return [{ affectedRows: 1 }];
    }

    if (norm.startsWith("UPDATE uploaded_videos")) {
      return [{ affectedRows: 1 }];
    }

    return [[]];
  };

  const mockPool = {
    query: handleQuery,
    getConnection: async () => ({
      query: handleQuery,
      beginTransaction: async () => {},
      commit: async () => {
        committedCount++;
      },
      rollback: async () => {
        rolledBackCount++;
      },
      release: () => {},
    }),
  };

  return {
    mockPool,
    orders,
    paymentTransactions,
    premiumTransactions,
    reserves,
    ledgerEntries,
    walletBalances,
    videos,
    setHasGlobalPoolReservesTable: (v: boolean) => {
      hasGlobalPoolReservesTable = v;
    },
    setMetadataQueryError: (err: Error | null) => {
      metadataQueryError = err;
    },
    getTxCounts: () => ({ committedCount, rolledBackCount }),
  };
}

describe("Sponsor Video Payment Failure & Safe Retry Safeguards", () => {
  let tmpDataDir = "";
  let prevFacetubeDataDir: string | undefined;
  let prevDbEnv: Record<string, string | undefined> = {};
  const originalFetch = globalThis.fetch;

  function enableMockMysqlEnv() {
    process.env["DB_HOST"] = "127.0.0.1";
    process.env["DB_NAME"] = "facetube_sponsor_retry_test";
    process.env["DB_USER"] = "facetube_test_user";
    process.env["DB_PASSWORD"] = "facetube_test_pass";
  }

  function restoreMockMysqlEnv() {
    for (const k of ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"]) {
      if (prevDbEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevDbEnv[k];
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
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-sponsor-retry-"));
    process.env["FACETUBE_DATA_DIR"] = tmpDataDir;
    resetInMemoryStore();
  });

  after(() => {
    globalThis.fetch = originalFetch;
    setMysqlPoolForTesting(null);
    restoreMockMysqlEnv();
    resetInMemoryStore();
    if (prevFacetubeDataDir === undefined) delete process.env["FACETUBE_DATA_DIR"];
    else process.env["FACETUBE_DATA_DIR"] = prevFacetubeDataDir;
    if (tmpDataDir && fs.existsSync(tmpDataDir)) {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    globalThis.fetch = originalFetch;
    setMysqlPoolForTesting(null);
    restoreMockMysqlEnv();
    resetInMemoryStore();
    resetRazorpayClientStateForTests();
    await resetPersistentPremiumState(0, []);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setMysqlPoolForTesting(null);
    restoreMockMysqlEnv();
    resetRazorpayClientStateForTests();
  });

  it("1. create-order fails closed with 503 for premium_video_upload when global_pool_reserves is missing or metadata check fails, without calling Razorpay or affecting other purposes", async () => {
    enableMockMysqlEnv();
    const harness = createSponsorRetryMysqlHarness({
      hasGlobalPoolReservesTable: false,
    });
    harness.videos.set("vid_ads_owned_1", {
      id: "vid_ads_owned_1",
      user_id: "FT483921",
      video_type: "free",
      payment_status: "paid",
    });
    setMysqlPoolForTesting(harness.mockPool as any);

    const razorpayRequests: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      razorpayRequests.push(String(url));
      return new Response(
        JSON.stringify({ id: `order_ok_${razorpayRequests.length}`, amount: 30000 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const env = {
      RAZORPAY_KEY_ID,
      RAZORPAY_KEY_SECRET: RAZORPAY_SECRET,
    };

    // 1a. Missing global_pool_reserves blocks premium_video_upload with 503 BEFORE calling Razorpay
    const premMissingRes = await handleApiRequest(
      new Request("http://localhost:3000/api/payments/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tok_1" },
        body: JSON.stringify({
          purpose: "premium_video_upload",
          userId: "FT483921",
          videoId: "vid_sponsor_new_1",
        }),
      }),
      env,
    );
    assert.equal(premMissingRes?.status, 503);
    const premMissingBody = await premMissingRes?.json();
    assert.equal(premMissingBody.success, false);
    assert.match(premMissingBody.error, /Global Pool reserve/i);
    assert.equal(razorpayRequests.length, 0, "Razorpay must NOT be called when table is missing");

    // 1b. Metadata query error fails closed with 503 BEFORE calling Razorpay (distinguished from missing table)
    harness.setMetadataQueryError(new Error("INFORMATION_SCHEMA access denied"));
    const premMetaErrRes = await handleApiRequest(
      new Request("http://localhost:3000/api/payments/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tok_1" },
        body: JSON.stringify({
          purpose: "premium_video_upload",
          userId: "FT483921",
          videoId: "vid_sponsor_new_2",
        }),
      }),
      env,
    );
    assert.equal(premMetaErrRes?.status, 503);
    const premMetaErrBody = await premMetaErrRes?.json();
    assert.equal(premMetaErrBody.success, false);
    assert.match(premMetaErrBody.error, /Unable to verify Global Pool reserve schema readiness/i);
    assert.doesNotMatch(premMetaErrBody.error, /access denied/i);
    assert.equal(razorpayRequests.length, 0);

    // 1c. Other purposes (ads_promotion & paid_subscription) continue to work even when global_pool_reserves is missing
    harness.setMetadataQueryError(null);
    const adsRes = await handleApiRequest(
      new Request("http://localhost:3000/api/payments/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tok_1" },
        body: JSON.stringify({
          purpose: "ads_promotion",
          userId: "FT483921",
          videoId: "vid_ads_owned_1",
          planId: "plan-monthly",
        }),
      }),
      env,
    );
    assert.equal(adsRes?.status, 200);

    const subRes = await handleApiRequest(
      new Request("http://localhost:3000/api/payments/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tok_1" },
        body: JSON.stringify({
          purpose: "paid_subscription",
          userId: "FT483921",
          planId: "member-monthly",
        }),
      }),
      env,
    );
    assert.equal(subRes?.status, 200);
    assert.equal(razorpayRequests.length, 2);
  });

  it("2. verify fails closed with 503 BEFORE any Razorpay GET/capture when global_pool_reserves is missing or metadata check fails, while preserving HMAC & ownership checks", async () => {
    enableMockMysqlEnv();
    const harness = createSponsorRetryMysqlHarness({
      hasGlobalPoolReservesTable: false,
    });
    const orderId = "ord_pre_cap_guard_1";
    const paymentId = "pay_pre_cap_guard_1";
    harness.orders.set(orderId, {
      order_id: orderId,
      user_id: "FT483921",
      user_name: "Alex Rivera",
      video_id: "vid_pre_cap_1",
      purpose: "premium_video_upload",
      plan_id: null,
      amount: 6.0,
      currency: "INR",
      status: "created",
      payment_id: null,
    });
    setMysqlPoolForTesting(harness.mockPool as any);

    const gatewayCalls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      gatewayCalls.push(String(url));
      return new Response(
        JSON.stringify({
          id: paymentId,
          order_id: orderId,
          status: "authorized",
          amount: 600,
          currency: "INR",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const env = { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET: RAZORPAY_SECRET };

    // 2a. Invalid HMAC signature still returns 400 first
    const badSigRes = await handleApiRequest(
      new Request("http://localhost:3000/api/payments/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tok_1" },
        body: JSON.stringify({
          orderId,
          paymentId,
          signature: "bad_sig",
          userId: "FT483921",
          videoId: "vid_pre_cap_1",
          purpose: "premium_video_upload",
        }),
      }),
      env,
    );
    assert.equal(badSigRes?.status, 400);
    assert.equal(gatewayCalls.length, 0);

    // 2b. Missing global_pool_reserves returns 503 BEFORE Razorpay GET / capture
    const missingTblRes = await handleApiRequest(
      new Request("http://localhost:3000/api/payments/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tok_1" },
        body: JSON.stringify({
          orderId,
          paymentId,
          signature: signOrderPayment(orderId, paymentId),
          userId: "FT483921",
          videoId: "vid_pre_cap_1",
          purpose: "premium_video_upload",
        }),
      }),
      env,
    );
    assert.equal(missingTblRes?.status, 503);
    const missingTblBody = await missingTblRes?.json();
    assert.equal(missingTblBody.verified, false);
    assert.match(missingTblBody.error, /not been applied yet.*not captured/i);
    assert.equal(gatewayCalls.length, 0, "Razorpay GET/capture MUST NOT be called");
    assert.equal(harness.paymentTransactions.size, 0);
    assert.equal(harness.reserves.length, 0);

    // 2c. Metadata query error distinguishes error and fails closed with 503 BEFORE Razorpay GET / capture
    harness.setMetadataQueryError(new Error("Metadata lock error"));
    const metaErrRes = await handleApiRequest(
      new Request("http://localhost:3000/api/payments/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tok_1" },
        body: JSON.stringify({
          orderId,
          paymentId,
          signature: signOrderPayment(orderId, paymentId),
          userId: "FT483921",
          videoId: "vid_pre_cap_1",
          purpose: "premium_video_upload",
        }),
      }),
      env,
    );
    assert.equal(metaErrRes?.status, 503);
    const metaErrBody = await metaErrRes?.json();
    assert.equal(metaErrBody.verified, false);
    assert.match(metaErrBody.error, /Unable to verify Global Pool reserve schema readiness/i);
    assert.doesNotMatch(metaErrBody.error, /Metadata lock error/i);
    assert.equal(gatewayCalls.length, 0);
  });

  it("3. Already-captured Razorpay payment that previously failed verify with 503 recovers cleanly once schema is ready, skips re-capture, and replay is idempotent with zero duplicates", async () => {
    enableMockMysqlEnv();
    const harness = createSponsorRetryMysqlHarness({
      hasGlobalPoolReservesTable: false,
      eligibleVideos: [], // triggers reserve creation (₹3.00 -> reservePaise = 300)
    });
    const orderId = "ord_captured_recover_1";
    const paymentId = "pay_captured_recover_1";
    const videoId = "vid_captured_recover_1";
    harness.orders.set(orderId, {
      order_id: orderId,
      user_id: "FT483921",
      user_name: "Alex Rivera",
      video_id: videoId,
      purpose: "premium_video_upload",
      plan_id: null,
      amount: 6.0,
      currency: "INR",
      status: "created",
      payment_id: null,
    });
    setMysqlPoolForTesting(harness.mockPool as any);

    const gatewayRequests: Array<{ method: string; url: string }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      gatewayRequests.push({ method: init?.method || "GET", url: u });
      // Payment is ALREADY captured in Razorpay from earlier pre-fix incident
      return new Response(
        JSON.stringify({
          id: paymentId,
          order_id: orderId,
          status: "captured",
          amount: 600,
          currency: "INR",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const env = { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET: RAZORPAY_SECRET };

    // Attempt 1 (pre-migration): fails closed 503 without calling gateway
    const firstVerifyRes = await handleApiRequest(
      new Request("http://localhost:3000/api/payments/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tok_1" },
        body: JSON.stringify({
          orderId,
          paymentId,
          signature: signOrderPayment(orderId, paymentId),
          userId: "FT483921",
          videoId,
          purpose: "premium_video_upload",
        }),
      }),
      env,
    );
    assert.equal(firstVerifyRes?.status, 503);
    assert.equal(gatewayRequests.length, 0);

    // Apply migration (schema now ready)
    harness.setHasGlobalPoolReservesTable(true);

    // Attempt 2 (retry with same payment): verifies cleanly WITHOUT calling /capture
    const retryVerifyRes = await handleApiRequest(
      new Request("http://localhost:3000/api/payments/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tok_1" },
        body: JSON.stringify({
          orderId,
          paymentId,
          signature: signOrderPayment(orderId, paymentId),
          userId: "FT483921",
          videoId,
          purpose: "premium_video_upload",
        }),
      }),
      env,
    );
    assert.equal(retryVerifyRes?.status, 200);
    const retryBody = await retryVerifyRes?.json();
    assert.equal(retryBody.verified, true);
    assert.equal(retryBody.distribution.directReferralAmount, 1.0);
    assert.equal(retryBody.distribution.adminAmount, 1.0);
    assert.equal(retryBody.distribution.globalPoolAmount, 3.0);
    assert.equal(retryBody.distribution.globalPoolReserveAmount, 3.0);
    assert.equal(retryBody.distribution.gstAmount, 0.9);
    assert.equal(retryBody.distribution.pgFeeAmount, 0.1);
    assert.equal(gatewayRequests.length, 1);
    assert.equal(
      gatewayRequests.some((r) => r.url.includes("/capture")),
      false,
      "Already-captured payment must NOT call /capture",
    );

    // Create video with original videoId and paymentId
    const createVidRes1 = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tok_1" },
        body: JSON.stringify({
          id: videoId,
          userId: "FT483921",
          title: "Recovered Sponsor Upload",
          videoUrl: "/uploads/videos/recovered.mp4",
          videoType: "premium",
          contentType: "short",
          visibility: "public",
          paymentId,
        }),
      }),
      env,
    );
    assert.equal(createVidRes1?.status, 201);

    // Snapshot ledger/wallet/reserve counts before idempotent replays
    const txCountBeforeReplay = harness.paymentTransactions.size;
    const reserveCountBeforeReplay = harness.reserves.length;
    const ledgerCountBeforeReplay = harness.ledgerEntries.length;
    const walletSnapshotBeforeReplay = JSON.stringify(Array.from(harness.walletBalances.entries()));
    const videoCountBeforeReplay = harness.videos.size;

    // Replay verify & video create again
    const replayVerifyRes = await handleApiRequest(
      new Request("http://localhost:3000/api/payments/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tok_1" },
        body: JSON.stringify({
          orderId,
          paymentId,
          signature: signOrderPayment(orderId, paymentId),
          userId: "FT483921",
          videoId,
          purpose: "premium_video_upload",
        }),
      }),
      env,
    );
    assert.equal(replayVerifyRes?.status, 200);
    const replayVerifyBody = await replayVerifyRes?.json();
    assert.equal(replayVerifyBody.verified, true);
    assert.equal(replayVerifyBody.duplicate, true);
    assert.equal(gatewayRequests.length, 1, "Idempotent fast-path must not hit Razorpay again");

    const replayVidRes = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tok_1" },
        body: JSON.stringify({
          id: videoId,
          userId: "FT483921",
          title: "Recovered Sponsor Upload",
          videoUrl: "/uploads/videos/recovered.mp4",
          videoType: "premium",
          contentType: "short",
          visibility: "public",
          paymentId,
        }),
      }),
      env,
    );
    assert.equal(replayVidRes?.status, 201);

    assert.equal(harness.paymentTransactions.size, txCountBeforeReplay);
    assert.equal(harness.reserves.length, reserveCountBeforeReplay);
    assert.equal(harness.ledgerEntries.length, ledgerCountBeforeReplay);
    assert.equal(
      JSON.stringify(Array.from(harness.walletBalances.entries())),
      walletSnapshotBeforeReplay,
    );
    assert.equal(harness.videos.size, videoCountBeforeReplay);
  });

  it("4. Frontend initiatePremiumVideoPayment retains captured proof on verify 503 and video_create failure, and resumes without createOrder or reopening Razorpay", async () => {
    const origWindow = (globalThis as any).window;
    const origLocalStorage = (globalThis as any).localStorage;
    const origCreateOrder = api.payments.createOrder;
    const origVerify = api.payments.verify;
    const origVideosCreate = api.videos.create;

    (globalThis as any).localStorage = createMemoryStorage();

    let createOrderCalls = 0;
    let razorpayOpenCalls = 0;
    const verifyCalls: any[] = [];
    const videoCreateCalls: any[] = [];
    let verifyShouldFail503 = true;
    let videoCreateShouldFail500 = true;

    (globalThis as any).window = {
      location: { hostname: "localhost" },
      Razorpay: class MockRazorpay {
        private opts: any;
        constructor(opts: any) {
          this.opts = opts;
        }
        on() {}
        open() {
          razorpayOpenCalls++;
          void this.opts.handler({
            razorpay_payment_id: "pay_fe_retry_1",
            razorpay_order_id: "order_fe_retry_1",
            razorpay_signature: "sig_fe_retry_secret_1",
          });
        }
      },
    };

    api.payments.createOrder = async () => {
      createOrderCalls++;
      return {
        success: true,
        orderId: "order_fe_retry_1",
        amount: 6,
        amountInSubunits: 600,
        currency: "INR",
        keyId: RAZORPAY_KEY_ID,
        purpose: "premium_video_upload",
      };
    };

    api.payments.verify = async (payload) => {
      verifyCalls.push(payload);
      if (verifyShouldFail503) {
        const err: any = new Error(
          "Global Pool reserve schema migration has not been applied yet. Payment was not captured.",
        );
        err.status = 503;
        throw err;
      }
      return {
        verified: true,
        orderId: payload.orderId,
        paymentId: payload.paymentId,
        amount: 6,
        txNumber: 1,
      };
    };

    api.videos.create = async (payload) => {
      videoCreateCalls.push(payload);
      if (videoCreateShouldFail500) {
        const err: any = new Error("Temporary database timeout saving video");
        err.status = 500;
        throw err;
      }
      return {
        success: true,
        video: {
          id: payload.id,
          user_id: payload.user_id,
          userId: payload.user_id,
          creator_name: payload.creator_name,
          creatorName: payload.creator_name,
          title: payload.title,
          description: payload.description || "",
          video_url: payload.video_url,
          videoUrl: payload.video_url,
          thumbnail_url: payload.thumbnail_url || "",
          thumbnailUrl: payload.thumbnail_url || "",
          video_type: "premium",
          videoType: "premium",
          content_type: payload.content_type || "long",
          contentType: payload.content_type || "long",
          category: payload.category || "Coding",
          duration: payload.duration || "1:00",
          visibility: "public",
          views: 0,
          likes: 0,
          payment_status: "paid",
          paymentStatus: "paid",
          payment_id: payload.payment_id,
          paymentId: payload.payment_id,
          payment_amount: 6,
          paymentAmount: 6,
          is_promoted: false,
          isPromoted: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        } as any,
      };
    };

    try {
      let capturedProof = null as PendingPremiumPaymentProof | null;
      const failureMetaList: Array<{ msg: string; meta: any }> = [];
      let successCount = 0;

      // Attempt 1: initial payment -> verify throws 503
      await new Promise<void>((resolve) => {
        void initiatePremiumVideoPayment({
          uploaderUserId: "FT483921",
          uploaderName: "Alex Rivera",
          videoId: "vid_fe_orig_1",
          videoTitle: "Sponsor Retry Video",
          videoUrl: "/uploads/videos/sponsor_retry.mp4",
          contentType: "long",
          onPaymentCaptured: (proof) => {
            capturedProof = proof;
          },
          onPaymentVerified: (proof) => {
            capturedProof = { ...proof, verified: true };
          },
          onSuccess: () => {
            successCount++;
            resolve();
          },
          onFailure: (msg, meta) => {
            failureMetaList.push({ msg, meta });
            if (shouldClearPendingPremiumPaymentOnFailure(meta, msg)) {
              capturedProof = null;
            }
            resolve();
          },
        });
      });

      assert.equal(createOrderCalls, 1);
      assert.equal(razorpayOpenCalls, 1);
      assert.equal(verifyCalls.length, 1);
      assert.equal(videoCreateCalls.length, 0);
      assert.equal(successCount, 0);
      assert.ok(capturedProof, "Pending payment proof must be retained after 503 verify failure");
      assert.equal(capturedProof.videoId, "vid_fe_orig_1");
      assert.equal(capturedProof.orderId, "order_fe_retry_1");
      assert.equal(capturedProof.paymentId, "pay_fe_retry_1");
      assert.equal(capturedProof.signature, "sig_fe_retry_secret_1");
      assert.equal(capturedProof.verified, false);
      assert.doesNotMatch(failureMetaList[0]?.msg || "", /sig_fe_retry_secret_1/);

      // Attempt 2: Retry after verify succeeds, but videos.create fails 500
      verifyShouldFail503 = false;
      await new Promise<void>((resolve) => {
        void initiatePremiumVideoPayment({
          uploaderUserId: "FT483921",
          uploaderName: "Alex Rivera",
          videoId: capturedProof!.videoId,
          videoTitle: "Sponsor Retry Video",
          videoUrl: "/uploads/videos/sponsor_retry.mp4",
          contentType: "long",
          pendingPayment: capturedProof!,
          onPaymentVerified: (proof) => {
            capturedProof = { ...proof, verified: true };
          },
          onSuccess: () => {
            successCount++;
            resolve();
          },
          onFailure: (msg, meta) => {
            failureMetaList.push({ msg, meta });
            if (shouldClearPendingPremiumPaymentOnFailure(meta, msg)) {
              capturedProof = null;
            }
            resolve();
          },
        });
      });

      assert.equal(createOrderCalls, 1, "Retry must NOT call createOrder");
      assert.equal(razorpayOpenCalls, 1, "Retry must NOT reopen Razorpay checkout");
      assert.equal(verifyCalls.length, 2);
      assert.equal(verifyCalls[1]?.orderId, "order_fe_retry_1");
      assert.equal(verifyCalls[1]?.paymentId, "pay_fe_retry_1");
      assert.equal(verifyCalls[1]?.videoId, "vid_fe_orig_1");
      assert.equal(videoCreateCalls.length, 1);
      assert.equal(videoCreateCalls[0]?.id, "vid_fe_orig_1");
      assert.equal(videoCreateCalls[0]?.payment_id, "pay_fe_retry_1");
      assert.equal(capturedProof?.verified, true);
      assert.equal(successCount, 0);

      // Attempt 3: Retry after videos.create recovers (resumes directly into video creation with original videoId + paymentId)
      videoCreateShouldFail500 = false;
      await new Promise<void>((resolve) => {
        void initiatePremiumVideoPayment({
          uploaderUserId: "FT483921",
          uploaderName: "Alex Rivera",
          videoId: capturedProof!.videoId,
          videoTitle: "Sponsor Retry Video",
          videoUrl: "/uploads/videos/sponsor_retry.mp4",
          contentType: "long",
          pendingPayment: capturedProof!,
          onSuccess: (_pid, createdVideo) => {
            successCount++;
            assert.equal(createdVideo?.id, "vid_fe_orig_1");
            resolve();
          },
          onFailure: (msg) => {
            assert.fail(`Unexpected failure: ${msg}`);
          },
        });
      });

      assert.equal(createOrderCalls, 1);
      assert.equal(razorpayOpenCalls, 1);
      assert.equal(
        verifyCalls.length,
        2,
        "Already-verified retry resumes video creation without re-hitting verify",
      );
      assert.equal(videoCreateCalls.length, 2);
      assert.equal(videoCreateCalls[1]?.id, "vid_fe_orig_1");
      assert.equal(videoCreateCalls[1]?.payment_id, "pay_fe_retry_1");
      assert.equal(successCount, 1);

      // Verify helper behavior on terminal vs transient errors
      assert.equal(
        shouldClearPendingPremiumPaymentOnFailure({ stage: "verify", status: 503 }, "503"),
        false,
      );
      assert.equal(
        shouldClearPendingPremiumPaymentOnFailure({ stage: "video_create", status: 500 }, "DB"),
        false,
      );
      assert.equal(
        shouldClearPendingPremiumPaymentOnFailure({ stage: "verify", status: 409 }, "Conflict"),
        true,
      );
      assert.equal(
        shouldClearPendingPremiumPaymentOnFailure(
          { stage: "verify", status: 400 },
          "Invalid Razorpay payment signature verification failed.",
        ),
        true,
      );
    } finally {
      (globalThis as any).window = origWindow;
      (globalThis as any).localStorage = origLocalStorage;
      api.payments.createOrder = origCreateOrder;
      api.payments.verify = origVerify;
      api.videos.create = origVideosCreate;
    }
  });

  it("5. Normal ₹6 Sponsor upload succeeds end-to-end when global_pool_reserves schema exists", async () => {
    enableMockMysqlEnv();
    const harness = createSponsorRetryMysqlHarness({
      hasGlobalPoolReservesTable: true,
      eligibleVideos: [{ video_id: "vid_elig_other", user_id: "FT900431", is_blocked: 0 }],
    });
    setMysqlPoolForTesting(harness.mockPool as any);

    const gatewayCalls: string[] = [];
    const generatedOrderId = "order_normal_sponsor_1";
    const paymentId = "pay_normal_sponsor_1";

    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      gatewayCalls.push(u);
      if (u.endsWith("/v1/orders")) {
        return new Response(
          JSON.stringify({ id: generatedOrderId, amount: 600, currency: "INR" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (u.endsWith(`/v1/payments/${paymentId}`)) {
        return new Response(
          JSON.stringify({
            id: paymentId,
            order_id: generatedOrderId,
            status: "authorized",
            amount: 600,
            currency: "INR",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (u.endsWith(`/v1/payments/${paymentId}/capture`)) {
        return new Response(JSON.stringify({ id: paymentId, status: "captured" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${u}`);
    }) as typeof fetch;

    const env = { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET: RAZORPAY_SECRET };
    const vidId = "vid_normal_sponsor_1";

    const orderRes = await handleApiRequest(
      new Request("http://localhost:3000/api/payments/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tok_1" },
        body: JSON.stringify({
          purpose: "premium_video_upload",
          userId: "FT483921",
          videoId: vidId,
          contentType: "long",
        }),
      }),
      env,
    );
    assert.equal(orderRes?.status, 200);

    const verifyRes = await handleApiRequest(
      new Request("http://localhost:3000/api/payments/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tok_1" },
        body: JSON.stringify({
          orderId: generatedOrderId,
          paymentId,
          signature: signOrderPayment(generatedOrderId, paymentId),
          userId: "FT483921",
          videoId: vidId,
          purpose: "premium_video_upload",
        }),
      }),
      env,
    );
    assert.equal(verifyRes?.status, 200);
    const verifyBody = await verifyRes?.json();
    assert.equal(verifyBody.verified, true);
    assert.equal(verifyBody.distribution.globalPoolDistributedAmount, 3.0);
    assert.equal(verifyBody.distribution.globalPoolReserveAmount, 0.0);

    const vidRes = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tok_1" },
        body: JSON.stringify({
          id: vidId,
          userId: "FT483921",
          title: "Normal Sponsor Upload",
          videoUrl: "/uploads/videos/normal.mp4",
          videoType: "premium",
          contentType: "long",
          visibility: "public",
          paymentId,
        }),
      }),
      env,
    );
    assert.equal(vidRes?.status, 201);
    assert.equal(gatewayCalls.filter((u) => u.includes("/capture")).length, 1);
  });

  it("6. PHP & Node parity + upload.tsx retry wiring checks", () => {
    const createOrderPhp = fs.readFileSync(
      path.resolve(process.cwd(), "api/payments/create-order.php"),
      "utf8",
    );
    const verifyPhp = fs.readFileSync(
      path.resolve(process.cwd(), "api/payments/verify.php"),
      "utf8",
    );
    const uploadTsx = fs.readFileSync(path.resolve(process.cwd(), "src/routes/upload.tsx"), "utf8");
    const rzpServiceTs = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/razorpay-service.ts"),
      "utf8",
    );

    // create-order.php: checks global_pool_reserves for premium_video_upload BEFORE Razorpay /v1/orders and fails closed 503
    const createOrderGuardIdx = createOrderPhp.indexOf("TABLE_NAME = 'global_pool_reserves'");
    const createOrderCurlIdx = createOrderPhp.indexOf("https://api.razorpay.com/v1/orders");
    assert.notEqual(createOrderGuardIdx, -1);
    assert.notEqual(createOrderCurlIdx, -1);
    assert.ok(createOrderGuardIdx < createOrderCurlIdx);
    assert.ok(
      createOrderPhp.includes(
        "error_log('[create-order.php] Global Pool reserve readiness check failed",
      ),
    );
    assert.ok(createOrderPhp.includes("], 503);"));

    // verify.php: checks global_pool_reserves for premium_video_upload AFTER fast-path idempotency and BEFORE Razorpay lookup/capture
    const fastPathIdx = verifyPhp.indexOf(
      "Fast-path idempotency before hitting remote Razorpay API",
    );
    const preCapGuardIdx = verifyPhp.indexOf("Pre-capture Global Pool reserve readiness check");
    const rzpLookupIdx = verifyPhp.indexOf("https://api.razorpay.com/v1/payments/{$paymentId}");
    assert.notEqual(fastPathIdx, -1);
    assert.notEqual(preCapGuardIdx, -1);
    assert.notEqual(rzpLookupIdx, -1);
    assert.ok(fastPathIdx < preCapGuardIdx && preCapGuardIdx < rzpLookupIdx);
    assert.ok(
      verifyPhp.includes(
        "error_log('[verify.php] Pre-capture Global Pool reserve readiness check failed",
      ),
    );
    assert.ok(verifyPhp.includes("Payment was not captured."));

    // upload.tsx & razorpay-service.ts wire pending payment proof & never log signatures
    assert.ok(uploadTsx.includes("pendingPaymentRef"));
    assert.ok(uploadTsx.includes("pendingPremiumPayment"));
    assert.ok(uploadTsx.includes("onPaymentCaptured"));
    assert.ok(uploadTsx.includes("onPaymentVerified"));
    assert.ok(uploadTsx.includes("shouldClearPendingPremiumPaymentOnFailure"));
    assert.equal(/console\.(log|error|warn)\([^)]*signature/i.test(rzpServiceTs), false);
    assert.equal(/console\.(log|error|warn)\([^)]*signature/i.test(uploadTsx), false);
  });
});
