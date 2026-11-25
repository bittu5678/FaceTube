import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleApiRequest, resetInMemoryStore } from "./api-handler";
import { getPersistentGlobalPoolState, resetPersistentPremiumState } from "./payments";
import { setMysqlPoolForTesting } from "./mysql";
import {
  recoverCapturedPremiumPayment,
  resetRazorpayClientStateForTests,
} from "../lib/razorpay-service";

const TARGET_PAYMENT_ID = "pay_U3yhnFuvK1k4fA";
const TARGET_ORDER_ID = "order_U3yhTN7XqKCVYz";
const TARGET_USER_ID = "FT315817";
const TARGET_VIDEO_ID = "vid-1795515782121-kf7k";
const TARGET_VIDEO_FILE = "sponsor-recovery-kf7k.mp4";
const TARGET_VIDEO_URL = `/uploads/videos/${TARGET_VIDEO_FILE}`;

const RAZORPAY_KEY_ID = "rzp_test_recovery_key";
const RAZORPAY_SECRET = "rzp_test_recovery_secret_123456";

function createRecoveryMysqlHarness(options?: {
  hasGlobalPoolReservesTable?: boolean;
  authUser?: { user_id: string; name: string; role: string; channel_name?: string };
  initialOrder?: Record<string, any> | null;
  initialVideo?: Record<string, any> | null;
  initialTx?: Record<string, any> | null;
  sponsorUserId?: string | null;
  eligibleVideos?: Array<{ video_id: string; user_id: string; ad_earnings?: number }>;
}) {
  const hasGlobalPoolReservesTable = options?.hasGlobalPoolReservesTable ?? true;
  const authUser = options?.authUser ?? {
    user_id: TARGET_USER_ID,
    name: "Recovery Creator",
    role: "user",
    channel_name: "Recovery Channel",
  };

  const orders = new Map<string, any>();
  if (options?.initialOrder !== null) {
    orders.set(
      options?.initialOrder?.order_id || TARGET_ORDER_ID,
      options?.initialOrder ?? {
        order_id: TARGET_ORDER_ID,
        user_id: TARGET_USER_ID,
        user_name: "Recovery Creator",
        video_id: TARGET_VIDEO_ID,
        purpose: "premium_video_upload",
        plan_id: null,
        content_type: "long",
        amount: 6.0,
        currency: "INR",
        status: "created",
        payment_id: null,
      },
    );
  }

  const paymentTransactions = new Map<string, any>();
  if (options?.initialTx) {
    paymentTransactions.set(String(options.initialTx.payment_id), options.initialTx);
  }

  const premiumTransactions: any[] = [];
  const reserves: any[] = [];
  const ledgerEntries: any[] = [];
  const walletBalances = new Map<
    string,
    { balance: number; total: number; referral: number; global: number }
  >();
  const videos = new Map<string, any>();
  if (options?.initialVideo) {
    videos.set(String(options.initialVideo.id), options.initialVideo);
  }

  let lockChain: Promise<void> = Promise.resolve();
  let committedCount = 0;
  let rolledBackCount = 0;

  const handleQuery = async (sql: string, params: any[] = []) => {
    const norm = sql.replace(/\s+/g, " ").trim();

    if (norm.includes("FROM INFORMATION_SCHEMA.TABLES")) {
      if (!hasGlobalPoolReservesTable) {
        return [[]];
      }
      if (norm.includes("global_pool_reserves")) {
        return [[{ TABLE_NAME: "global_pool_reserves" }]];
      }
      return [[]];
    }

    if (norm.includes("FROM INFORMATION_SCHEMA.COLUMNS")) {
      return [
        [
          { TABLE_NAME: "uploaded_videos", COLUMN_NAME: "ad_earnings" },
          { TABLE_NAME: "uploaded_videos", COLUMN_NAME: "is_blocked" },
          { TABLE_NAME: "uploaded_videos", COLUMN_NAME: "country_code" },
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
            id: `u-${authUser.user_id}`,
            user_id: authUser.user_id,
            name: authUser.name,
            mobile: "9999999999",
            email: `${authUser.user_id.toLowerCase()}@facetube.com`,
            role: authUser.role,
            referral_code: options?.sponsorUserId || null,
            avatar_url: null,
            channel_logo_url: null,
            channel_name: authUser.channel_name || authUser.name,
            channel_description: null,
            created_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      ];
    }

    if (norm.includes("FROM payment_orders WHERE order_id = ?")) {
      const ord = orders.get(String(params[0]));
      return [ord ? [{ ...ord }] : []];
    }

    if (norm.includes("FROM payment_orders WHERE payment_id = ? AND order_id != ?")) {
      const pid = String(params[0]);
      const oid = String(params[1]);
      for (const ord of orders.values()) {
        if (ord.payment_id === pid && ord.order_id !== oid) {
          return [[{ order_id: ord.order_id }]];
        }
      }
      return [[]];
    }

    if (norm.includes("FROM uploaded_videos WHERE payment_id = ? AND id != ?")) {
      const pid = String(params[0]);
      const vid = String(params[1]);
      for (const v of videos.values()) {
        if (v.payment_id === pid && v.id !== vid) {
          return [[{ id: v.id }]];
        }
      }
      return [[]];
    }

    if (norm.includes("FROM uploaded_videos WHERE id = ?")) {
      const v = videos.get(String(params[0]));
      return [v ? [{ ...v }] : []];
    }

    if (norm.includes("FROM payment_transactions WHERE payment_id = ?")) {
      const tx = paymentTransactions.get(String(params[0]));
      return [tx ? [{ ...tx }] : []];
    }

    if (norm.includes("SELECT COUNT(*) as total FROM payment_transactions")) {
      const total = Array.from(paymentTransactions.values()).filter(
        (t) => t.purpose === "premium_video_upload",
      ).length;
      return [[{ total }]];
    }

    if (norm.includes("FROM users WHERE role = 'admin'")) {
      return [[{ user_id: "FT102857" }]];
    }

    if (
      norm.includes("FROM users WHERE UPPER(user_id) = UPPER(?) AND UPPER(user_id) != UPPER(?)")
    ) {
      if (options?.sponsorUserId) {
        return [
          [
            {
              user_id: options.sponsorUserId,
              referral_code: null,
              name: "Sponsor User",
            },
          ],
        ];
      }
      return [[]];
    }

    if (norm.includes("FROM users WHERE UPPER(user_id) = UPPER(?)")) {
      return [
        [
          {
            id: `u-${TARGET_USER_ID}`,
            user_id: TARGET_USER_ID,
            referral_code: options?.sponsorUserId || null,
          },
        ],
      ];
    }

    if (norm.includes("FROM uploaded_videos WHERE (video_type = 'premium'")) {
      return [options?.eligibleVideos ?? []];
    }

    if (norm.startsWith("INSERT INTO payment_transactions")) {
      const pid = String(params[1]);
      if (paymentTransactions.has(pid)) {
        const dupErr: any = new Error(`Duplicate entry '${pid}' for key 'payment_id'`);
        dupErr.code = "ER_DUP_ENTRY";
        dupErr.errno = 1062;
        throw dupErr;
      }
      paymentTransactions.set(pid, {
        order_id: String(params[0]),
        payment_id: pid,
        user_id: String(params[2]),
        user_name: String(params[3]),
        video_id: params[4] ? String(params[4]) : null,
        purpose: "premium_video_upload",
        amount: Number(params[5]),
        tx_number: Number(params[6]),
        is_special: 0,
        special_tag: String(params[7]),
        referral_commission: Number(params[8]),
        admin_allocation: Number(params[9]),
        global_pool_allocation: Number(params[10]),
        global_pool_distributed: Number(params[11]),
        global_pool_reserve: Number(params[12]),
        global_pool_status: String(params[13]),
        gst_amount: Number(params[14]),
        pg_fee: Number(params[15]),
        referral_status: String(params[16]),
      });
      return [{ affectedRows: 1 }];
    }

    if (norm.startsWith("INSERT INTO premium_transactions")) {
      premiumTransactions.push({
        id: String(params[0]),
        tx_number: Number(params[1]),
        payment_id: String(params[2]),
        order_id: String(params[3]),
        video_id: params[4] ? String(params[4]) : null,
        user_id: String(params[5]),
        referrer_id: params[6] ? String(params[6]) : null,
        amount: Number(params[7]),
      });
      return [{ affectedRows: 1 }];
    }

    if (norm.startsWith("INSERT INTO income_ledger")) {
      const isPendingRef = norm.includes("'UNASSIGNED_REFERRAL'");
      const isPendingReserve = norm.includes("'GLOBAL_POOL_RESERVE'");
      if (isPendingRef) {
        ledgerEntries.push({
          id: params[0],
          transaction_id: params[1],
          user_id: "UNASSIGNED_REFERRAL",
          income_type: "referral_income",
          amount: 1.0,
          status: "pending",
        });
      } else if (isPendingReserve) {
        ledgerEntries.push({
          id: params[0],
          transaction_id: params[1],
          user_id: "GLOBAL_POOL_RESERVE",
          income_type: "global_income",
          amount: Number(params[5]),
          status: "pending",
        });
      } else {
        const isFixedRef = norm.includes("1.0000");
        ledgerEntries.push({
          id: params[0],
          transaction_id: params[1],
          user_id: params[2],
          income_type: norm.includes("'referral_income'")
            ? "referral_income"
            : norm.includes("'admin_allocation'")
              ? "admin_allocation"
              : "global_income",
          amount: isFixedRef ? 1.0 : Number(params[6]),
          status: "settled",
        });
      }
      return [{ affectedRows: 1 }];
    }

    if (norm.startsWith("INSERT INTO wallet_balances")) {
      const uid = String(params[0]);
      const cur = walletBalances.get(uid) || { balance: 0, total: 0, referral: 0, global: 0 };
      if (norm.includes("1.00, 1.00, 0.00, 1.00")) {
        cur.balance += 1.0;
        cur.total += 1.0;
        cur.referral += 1.0;
      } else if (norm.includes("VALUES (?, ?, ?, 0.00, 0.00, 0.00")) {
        cur.balance += Number(params[1]);
        cur.total += Number(params[2]);
      } else {
        cur.balance += Number(params[1]);
        cur.total += Number(params[2]);
        cur.global += Number(params[3]);
      }
      walletBalances.set(uid, cur);
      return [{ affectedRows: 1 }];
    }

    if (norm.startsWith("INSERT INTO global_pool_reserves")) {
      reserves.push({
        id: params[0],
        payment_id: params[1],
        order_id: params[2],
        tx_number: Number(params[3]),
        reserve_amount: Number(params[6]),
        reserve_paise: Number(params[7]),
        reserve_reason: String(params[8]),
        status: "pending",
      });
      return [{ affectedRows: 1 }];
    }

    if (norm.startsWith("INSERT INTO uploaded_videos")) {
      const vidId = String(params[0]);
      const existing = videos.get(vidId);
      videos.set(vidId, {
        id: vidId,
        user_id: String(params[1]),
        creator_name: String(params[2]),
        title: String(params[3]),
        description: String(params[4]),
        video_url: String(params[5]),
        thumbnail_url: String(params[6]),
        video_type: "premium",
        content_type: String(params[7]),
        category: String(params[8]),
        duration: String(params[9]),
        payment_status: "paid",
        payment_id: String(params[10]),
        payment_amount: 6.0,
        visibility: String(params[11]),
        country_code: params[12] ? String(params[12]) : "UNKNOWN",
        views: existing?.views ?? 0,
        likes: existing?.likes ?? 0,
        is_promoted: existing?.is_promoted ?? 0,
      });
      return [{ affectedRows: 1 }];
    }

    if (norm.startsWith("UPDATE payment_orders SET status = 'paid'")) {
      const pid = String(params[0]);
      const oid = String(params[1]);
      const ord = orders.get(oid);
      if (ord) {
        ord.status = "paid";
        ord.payment_id = pid;
      }
      return [{ affectedRows: 1 }];
    }

    return [[]];
  };

  const pool = {
    query: handleQuery,
    execute: handleQuery,
    getConnection: async () => {
      let releaseLock!: () => void;
      const myTurn = lockChain;
      lockChain = new Promise<void>((res) => {
        releaseLock = res;
      });
      await myTurn;
      let ended = false;
      const finish = () => {
        if (!ended) {
          ended = true;
          releaseLock();
        }
      };
      return {
        query: handleQuery,
        execute: handleQuery,
        beginTransaction: async () => {},
        commit: async () => {
          committedCount += 1;
        },
        rollback: async () => {
          rolledBackCount += 1;
        },
        release: () => {
          finish();
        },
      };
    },
  };

  return {
    pool,
    orders,
    paymentTransactions,
    premiumTransactions,
    reserves,
    ledgerEntries,
    walletBalances,
    videos,
    getStats: () => ({ committedCount, rolledBackCount }),
  };
}

function makeRecoveryRequest(body: Record<string, unknown>, token = "sess_valid_token"): Request {
  return new Request("http://localhost:3000/api/payments/recover-captured.php", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("Orphaned Captured Sponsor Payment Recovery", () => {
  let tmpDataDir: string;
  let tmpUploadsDir: string;
  let prevDataDir: string | undefined;
  let prevUploadsDir: string | undefined;
  let prevKeyId: string | undefined;
  let prevSecret: string | undefined;
  let prevDbHost: string | undefined;
  let prevDbName: string | undefined;
  let prevDbUser: string | undefined;
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-recover-data-"));
    tmpUploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-recover-uploads-"));
    fs.mkdirSync(path.join(tmpUploadsDir, "videos"), { recursive: true });
    fs.mkdirSync(path.join(tmpUploadsDir, "images"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpUploadsDir, "videos", TARGET_VIDEO_FILE),
      Buffer.from("ftypmp42recoveredvideoasset"),
    );

    prevDataDir = process.env["FACETUBE_DATA_DIR"];
    prevUploadsDir = process.env["FACETUBE_UPLOADS_DIR"];
    prevKeyId = process.env["RAZORPAY_KEY_ID"];
    prevSecret = process.env["RAZORPAY_KEY_SECRET"];
    prevDbHost = process.env["DB_HOST"];
    prevDbName = process.env["DB_NAME"];
    prevDbUser = process.env["DB_USER"];

    process.env["FACETUBE_DATA_DIR"] = tmpDataDir;
    process.env["FACETUBE_UPLOADS_DIR"] = tmpUploadsDir;
    process.env["RAZORPAY_KEY_ID"] = RAZORPAY_KEY_ID;
    process.env["RAZORPAY_KEY_SECRET"] = RAZORPAY_SECRET;
    process.env["DB_HOST"] = "127.0.0.1";
    process.env["DB_NAME"] = "facetube_test";
    process.env["DB_USER"] = "facetube_test";

    origFetch = globalThis.fetch;
    resetInMemoryStore();
    resetPersistentPremiumState();
    resetRazorpayClientStateForTests();
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    setMysqlPoolForTesting(null);

    if (prevDataDir === undefined) delete process.env["FACETUBE_DATA_DIR"];
    else process.env["FACETUBE_DATA_DIR"] = prevDataDir;

    if (prevUploadsDir === undefined) delete process.env["FACETUBE_UPLOADS_DIR"];
    else process.env["FACETUBE_UPLOADS_DIR"] = prevUploadsDir;

    if (prevKeyId === undefined) delete process.env["RAZORPAY_KEY_ID"];
    else process.env["RAZORPAY_KEY_ID"] = prevKeyId;

    if (prevSecret === undefined) delete process.env["RAZORPAY_KEY_SECRET"];
    else process.env["RAZORPAY_KEY_SECRET"] = prevSecret;

    if (prevDbHost === undefined) delete process.env["DB_HOST"];
    else process.env["DB_HOST"] = prevDbHost;

    if (prevDbName === undefined) delete process.env["DB_NAME"];
    else process.env["DB_NAME"] = prevDbName;

    if (prevDbUser === undefined) delete process.env["DB_USER"];
    else process.env["DB_USER"] = prevDbUser;

    fs.rmSync(tmpDataDir, { recursive: true, force: true });
    fs.rmSync(tmpUploadsDir, { recursive: true, force: true });
  });

  it("1. Recovers already-captured ₹6 payment (pay_U3yhnFuvK1k4fA / order_U3yhTN7XqKCVYz / FT315817 / vid-1795515782121-kf7k) cleanly with zero capture/order calls", async () => {
    const harness = createRecoveryMysqlHarness({
      sponsorUserId: "FT900431",
      eligibleVideos: [{ video_id: "vid-prev-1", user_id: "FT111111", ad_earnings: 10 }],
    });
    setMysqlPoolForTesting(harness.pool as any);

    const razorpayCalls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      const method = (init?.method || "GET").toUpperCase();
      razorpayCalls.push({ url, method });
      return new Response(
        JSON.stringify({
          id: TARGET_PAYMENT_ID,
          order_id: TARGET_ORDER_ID,
          status: "captured",
          amount: 600,
          currency: "INR",
          notes: {
            purpose: "premium_video_upload",
            userId: TARGET_USER_ID,
            videoId: TARGET_VIDEO_ID,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const res = await handleApiRequest(
      makeRecoveryRequest({
        orderId: TARGET_ORDER_ID,
        paymentId: TARGET_PAYMENT_ID,
        videoId: TARGET_VIDEO_ID,
        userId: TARGET_USER_ID,
        title: "Recovered Sponsor Video",
        description: "Reconciled without duplicate payment",
        videoUrl: TARGET_VIDEO_URL,
        contentType: "long",
        category: "Coding",
        visibility: "public",
      }),
      { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET: RAZORPAY_SECRET },
    );

    assert.equal(res?.status, 200);
    const data: any = await res!.json();
    assert.equal(data.recovered, true);
    assert.equal(data.verified, true);
    assert.equal(data.duplicate, false);
    assert.equal(data.videoPublished, true);
    assert.equal(data.amount, 6);
    assert.equal(data.currency, "INR");
    assert.equal(data.videoId, TARGET_VIDEO_ID);
    assert.equal(data.assetPath, TARGET_VIDEO_URL);

    // Must ONLY call GET /v1/payments/{id}; never /capture, /orders, or /refund
    assert.equal(razorpayCalls.length, 1);
    assert.equal(razorpayCalls[0]!.method, "GET");
    assert.equal(
      razorpayCalls[0]!.url,
      `https://api.razorpay.com/v1/payments/${TARGET_PAYMENT_ID}`,
    );

    // Exact Phase 1.1 ₹6 split & published video assertions
    assert.equal(harness.paymentTransactions.size, 1);
    assert.equal(harness.premiumTransactions.length, 1);
    assert.equal(harness.walletBalances.get("FT900431")?.referral, 1.0);
    assert.equal(harness.walletBalances.get("FT102857")?.balance, 1.0);
    assert.equal(harness.walletBalances.get("FT111111")?.global, 3.0);
    assert.equal(harness.reserves.length, 0);

    const published = harness.videos.get(TARGET_VIDEO_ID);
    assert.ok(published);
    assert.equal(published.user_id, TARGET_USER_ID);
    assert.equal(published.video_type, "premium");
    assert.equal(published.payment_status, "paid");
    assert.equal(published.payment_id, TARGET_PAYMENT_ID);
    assert.equal(published.payment_amount, 6.0);
    assert.equal(harness.orders.get(TARGET_ORDER_ID)?.status, "paid");
    assert.equal(harness.orders.get(TARGET_ORDER_ID)?.payment_id, TARGET_PAYMENT_ID);
    assert.equal(harness.getStats().committedCount, 1);
  });

  it("2. Rejects unauthenticated, wrong user (including admin override), wrong order/payment/amount/currency/purpose/status/video mapping", async () => {
    const mockFetch = async (payload: Record<string, any>) => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as typeof fetch;
    };

    const baseBody = {
      orderId: TARGET_ORDER_ID,
      paymentId: TARGET_PAYMENT_ID,
      videoId: TARGET_VIDEO_ID,
      title: "Sponsor Video",
      videoUrl: TARGET_VIDEO_URL,
    };

    // (a) Unauthenticated -> 401
    {
      const harness = createRecoveryMysqlHarness();
      setMysqlPoolForTesting(harness.pool as any);
      const res = await handleApiRequest(makeRecoveryRequest(baseBody, ""), {
        RAZORPAY_KEY_ID,
        RAZORPAY_KEY_SECRET: RAZORPAY_SECRET,
      });
      assert.equal(res?.status, 401);
      assert.equal(harness.paymentTransactions.size, 0);
    }

    // (b) Wrong owner & strict no admin bypass -> 403
    for (const role of ["user", "admin"]) {
      const harness = createRecoveryMysqlHarness({
        authUser: { user_id: "FT999999", name: "Other User", role },
      });
      setMysqlPoolForTesting(harness.pool as any);
      const res = await handleApiRequest(makeRecoveryRequest(baseBody), {
        RAZORPAY_KEY_ID,
        RAZORPAY_KEY_SECRET: RAZORPAY_SECRET,
      });
      assert.equal(res?.status, 403);
      assert.equal(harness.paymentTransactions.size, 0);
    }

    // (c) Client-supplied tampered amount/currency/purpose rejected -> 400
    {
      const harness = createRecoveryMysqlHarness();
      setMysqlPoolForTesting(harness.pool as any);
      for (const override of [{ amount: 1 }, { currency: "USD" }, { purpose: "ads_promotion" }]) {
        const res = await handleApiRequest(makeRecoveryRequest({ ...baseBody, ...override }), {
          RAZORPAY_KEY_ID,
          RAZORPAY_KEY_SECRET: RAZORPAY_SECRET,
        });
        assert.equal(res?.status, 400);
      }
      assert.equal(harness.paymentTransactions.size, 0);
    }

    // (d) Missing order -> 404
    {
      const harness = createRecoveryMysqlHarness({ initialOrder: null });
      setMysqlPoolForTesting(harness.pool as any);
      const res = await handleApiRequest(makeRecoveryRequest(baseBody), {
        RAZORPAY_KEY_ID,
        RAZORPAY_KEY_SECRET: RAZORPAY_SECRET,
      });
      assert.equal(res?.status, 404);
    }

    // (e) Order video mapping mismatch -> 409
    {
      const harness = createRecoveryMysqlHarness({
        initialOrder: {
          order_id: TARGET_ORDER_ID,
          user_id: TARGET_USER_ID,
          video_id: "vid-other-video",
          purpose: "premium_video_upload",
          amount: 6.0,
          currency: "INR",
          status: "created",
          payment_id: null,
        },
      });
      setMysqlPoolForTesting(harness.pool as any);
      const res = await handleApiRequest(makeRecoveryRequest(baseBody), {
        RAZORPAY_KEY_ID,
        RAZORPAY_KEY_SECRET: RAZORPAY_SECRET,
      });
      assert.equal(res?.status, 409);
    }

    // (f) Order wrong amount/currency/purpose -> 400
    for (const badOrder of [
      { purpose: "ads_promotion", amount: 6.0, currency: "INR" },
      { purpose: "premium_video_upload", amount: 5.0, currency: "INR" },
      { purpose: "premium_video_upload", amount: 6.0, currency: "USD" },
    ]) {
      const harness = createRecoveryMysqlHarness({
        initialOrder: {
          order_id: TARGET_ORDER_ID,
          user_id: TARGET_USER_ID,
          video_id: TARGET_VIDEO_ID,
          ...badOrder,
          status: "created",
          payment_id: null,
        },
      });
      setMysqlPoolForTesting(harness.pool as any);
      const res = await handleApiRequest(makeRecoveryRequest(baseBody), {
        RAZORPAY_KEY_ID,
        RAZORPAY_KEY_SECRET: RAZORPAY_SECRET,
      });
      assert.equal(res?.status, 400);
    }

    // (g) Gateway status authorized (never captured), wrong payment id, wrong order id, wrong amount (500/700), wrong currency
    for (const badGateway of [
      {
        id: TARGET_PAYMENT_ID,
        order_id: TARGET_ORDER_ID,
        status: "authorized",
        amount: 600,
        currency: "INR",
      },
      {
        id: TARGET_PAYMENT_ID,
        order_id: TARGET_ORDER_ID,
        status: "failed",
        amount: 600,
        currency: "INR",
      },
      {
        id: "pay_WRONG",
        order_id: TARGET_ORDER_ID,
        status: "captured",
        amount: 600,
        currency: "INR",
      },
      {
        id: TARGET_PAYMENT_ID,
        order_id: "order_WRONG",
        status: "captured",
        amount: 600,
        currency: "INR",
      },
      {
        id: TARGET_PAYMENT_ID,
        order_id: TARGET_ORDER_ID,
        status: "captured",
        amount: 700,
        currency: "INR",
      },
      {
        id: TARGET_PAYMENT_ID,
        order_id: TARGET_ORDER_ID,
        status: "captured",
        amount: 600,
        currency: "USD",
      },
    ]) {
      const harness = createRecoveryMysqlHarness();
      setMysqlPoolForTesting(harness.pool as any);
      let captureCalled = false;
      globalThis.fetch = (async (input: any) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("/capture") || url.includes("/orders")) {
          captureCalled = true;
        }
        return new Response(JSON.stringify(badGateway), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;

      const res = await handleApiRequest(makeRecoveryRequest(baseBody), {
        RAZORPAY_KEY_ID,
        RAZORPAY_KEY_SECRET: RAZORPAY_SECRET,
      });
      assert.equal(res?.status, 400);
      assert.equal(captureCalled, false);
      assert.equal(harness.paymentTransactions.size, 0);
      assert.equal(harness.videos.size, 0);
    }
    void mockFetch;
  });

  it("3. Stops safely and reports missing/invalid upload asset without publishing incomplete video", async () => {
    const harness = createRecoveryMysqlHarness();
    setMysqlPoolForTesting(harness.pool as any);

    // Prepare 0-byte file and symlink escape inside uploads/videos
    fs.writeFileSync(path.join(tmpUploadsDir, "videos", "empty.mp4"), Buffer.alloc(0));
    const outsideFile = path.join(tmpDataDir, "secret-outside.mp4");
    fs.writeFileSync(outsideFile, Buffer.from("outside-bytes"));
    fs.symlinkSync(outsideFile, path.join(tmpUploadsDir, "videos", "escaped.mp4"));

    let gatewayCalled = false;
    globalThis.fetch = (async () => {
      gatewayCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const badCases: Array<{ videoUrl: string; expectedStatus: number; expectedMissing: string }> = [
      { videoUrl: "", expectedStatus: 422, expectedMissing: "video_url" },
      {
        videoUrl: "blob:https://facetube.online/abc",
        expectedStatus: 422,
        expectedMissing: "video_url",
      },
      {
        videoUrl: "/uploads/videos/../../etc/passwd.mp4",
        expectedStatus: 400,
        expectedMissing: "video_url",
      },
      {
        videoUrl: "https://evil.example.com/uploads/videos/test.mp4",
        expectedStatus: 403,
        expectedMissing: "video_url",
      },
      {
        videoUrl: "/uploads/videos/does-not-exist.mp4",
        expectedStatus: 422,
        expectedMissing: "video_file",
      },
      { videoUrl: "/uploads/videos/empty.mp4", expectedStatus: 422, expectedMissing: "video_file" },
      {
        videoUrl: "/uploads/videos/escaped.mp4",
        expectedStatus: 403,
        expectedMissing: "video_file",
      },
    ];

    for (const c of badCases) {
      const res = await handleApiRequest(
        makeRecoveryRequest({
          orderId: TARGET_ORDER_ID,
          paymentId: TARGET_PAYMENT_ID,
          videoId: TARGET_VIDEO_ID,
          title: "Missing Asset Test",
          videoUrl: c.videoUrl,
        }),
        { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET: RAZORPAY_SECRET },
      );
      assert.equal(res?.status, c.expectedStatus);
      const data: any = await res!.json();
      assert.equal(data.recovered, false);
      assert.equal(data.missingAsset, c.expectedMissing);
    }

    assert.equal(gatewayCalled, false);
    assert.equal(harness.paymentTransactions.size, 0);
    assert.equal(harness.videos.size, 0);
  });

  it("4. Aborts fail-closed (503) before Razorpay call or DB mutation when Global Pool reserve schema is missing", async () => {
    const harness = createRecoveryMysqlHarness({ hasGlobalPoolReservesTable: false });
    setMysqlPoolForTesting(harness.pool as any);

    let gatewayCalled = false;
    globalThis.fetch = (async () => {
      gatewayCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const res = await handleApiRequest(
      makeRecoveryRequest({
        orderId: TARGET_ORDER_ID,
        paymentId: TARGET_PAYMENT_ID,
        videoId: TARGET_VIDEO_ID,
        title: "Schema Readiness Test",
        videoUrl: TARGET_VIDEO_URL,
      }),
      { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET: RAZORPAY_SECRET },
    );

    assert.equal(res?.status, 503);
    const data: any = await res!.json();
    assert.equal(data.recovered, false);
    assert.match(String(data.error), /Global Pool reserve schema/i);
    assert.equal(gatewayCalled, false);
    assert.equal(harness.paymentTransactions.size, 0);
    assert.equal(harness.videos.size, 0);
  });

  it("5. Partial recovery, repeated calls, and 5 concurrent recovery requests produce zero duplicate accounting", async () => {
    // 5a. Partial recovery (payment settled earlier, but video wasn't published & order wasn't marked paid)
    {
      const harness = createRecoveryMysqlHarness({
        initialTx: {
          order_id: TARGET_ORDER_ID,
          payment_id: TARGET_PAYMENT_ID,
          user_id: TARGET_USER_ID,
          user_name: "Recovery Creator",
          video_id: TARGET_VIDEO_ID,
          purpose: "premium_video_upload",
          amount: 6.0,
          tx_number: 1,
          is_special: 0,
          special_tag: "NORMAL_PREMIUM",
          referral_commission: 1.0,
          admin_allocation: 1.0,
          global_pool_allocation: 3.0,
          global_pool_distributed: 0.0,
          global_pool_reserve: 3.0,
          global_pool_status: "pending_reserve",
          gst_amount: 0.9,
          pg_fee: 0.1,
          referral_status: "unassigned_pending",
        },
      });
      setMysqlPoolForTesting(harness.pool as any);

      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            id: TARGET_PAYMENT_ID,
            order_id: TARGET_ORDER_ID,
            status: "captured",
            amount: 600,
            currency: "INR",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as typeof fetch;

      const partialRes = await handleApiRequest(
        makeRecoveryRequest({
          orderId: TARGET_ORDER_ID,
          paymentId: TARGET_PAYMENT_ID,
          videoId: TARGET_VIDEO_ID,
          title: "Recovered Missing Video Only",
          videoUrl: TARGET_VIDEO_URL,
        }),
        { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET: RAZORPAY_SECRET },
      );
      assert.equal(partialRes?.status, 200);
      const partialData: any = await partialRes!.json();
      assert.equal(partialData.recovered, true);
      assert.equal(partialData.videoPublished, true);
      assert.equal(partialData.duplicate, true);
      // Zero extra ledger credits, reserves, or wallet mutations!
      assert.equal(harness.ledgerEntries.length, 0);
      assert.equal(harness.reserves.length, 0);
      assert.equal(harness.walletBalances.size, 0);
      assert.equal(harness.videos.get(TARGET_VIDEO_ID)?.payment_status, "paid");
      assert.equal(harness.orders.get(TARGET_ORDER_ID)?.status, "paid");

      // Repeated call is fully idempotent
      const repeatRes = await handleApiRequest(
        makeRecoveryRequest({
          orderId: TARGET_ORDER_ID,
          paymentId: TARGET_PAYMENT_ID,
          videoId: TARGET_VIDEO_ID,
          title: "Recovered Missing Video Only",
          videoUrl: TARGET_VIDEO_URL,
        }),
        { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET: RAZORPAY_SECRET },
      );
      assert.equal(repeatRes?.status, 200);
      const repeatData: any = await repeatRes!.json();
      assert.equal(repeatData.alreadyPublished, true);
      assert.equal(repeatData.videoPublished, false);
      assert.equal(harness.ledgerEntries.length, 0);
    }

    // 5b. 5 concurrent MySQL recovery requests -> 1 tx, 1 reserve, 1 admin credit
    {
      const harness = createRecoveryMysqlHarness();
      setMysqlPoolForTesting(harness.pool as any);
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            id: TARGET_PAYMENT_ID,
            order_id: TARGET_ORDER_ID,
            status: "captured",
            amount: 600,
            currency: "INR",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as typeof fetch;

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          handleApiRequest(
            makeRecoveryRequest({
              orderId: TARGET_ORDER_ID,
              paymentId: TARGET_PAYMENT_ID,
              videoId: TARGET_VIDEO_ID,
              title: "Concurrent Recovery Video",
              videoUrl: TARGET_VIDEO_URL,
            }),
            { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET: RAZORPAY_SECRET },
          ),
        ),
      );

      for (const r of results) {
        assert.equal(r?.status, 200);
        const body: any = await r!.json();
        assert.equal(body.recovered, true);
      }

      assert.equal(harness.paymentTransactions.size, 1);
      assert.equal(harness.reserves.length, 1);
      assert.equal(harness.reserves[0].reserve_paise, 300);
      assert.equal(harness.walletBalances.get("FT102857")?.balance, 1.0);
      assert.equal(harness.videos.size, 1);
    }

    // 5c. Non-MySQL JSON store concurrency check (mutex-serialized recovery)
    {
      setMysqlPoolForTesting(null);
      delete process.env["DB_HOST"];
      delete process.env["DB_NAME"];
      delete process.env["DB_USER"];
      resetInMemoryStore();
      resetPersistentPremiumState();
      fs.writeFileSync(
        path.join(tmpDataDir, "facetube_store.json"),
        JSON.stringify({
          users: [
            {
              id: "u-admin",
              user_id: "FT102857",
              name: "Admin",
              email: "admin@facetube.com",
              mobile: "9000000000",
              role: "admin",
              created_at: "2026-01-01T00:00:00.000Z",
            },
            {
              id: "u-target",
              user_id: TARGET_USER_ID,
              name: "Target Creator",
              email: "target@facetube.com",
              mobile: "9999999999",
              role: "user",
              created_at: "2026-01-01T00:00:00.000Z",
            },
          ],
          sessions: {
            sess_store_token: TARGET_USER_ID,
          },
          videos: [],
          paymentOrders: [
            {
              order_id: TARGET_ORDER_ID,
              user_id: TARGET_USER_ID,
              user_name: "Target Creator",
              video_id: TARGET_VIDEO_ID,
              purpose: "premium_video_upload",
              content_type: "long",
              amount: 6.0,
              currency: "INR",
              status: "created",
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z",
            },
          ],
          wallets: {},
          walletTransactions: [],
        }),
      );

      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            id: TARGET_PAYMENT_ID,
            order_id: TARGET_ORDER_ID,
            status: "captured",
            amount: 600,
            currency: "INR",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as typeof fetch;

      const storeResponses = await Promise.all(
        Array.from({ length: 5 }, () =>
          handleApiRequest(
            makeRecoveryRequest(
              {
                orderId: TARGET_ORDER_ID,
                paymentId: TARGET_PAYMENT_ID,
                videoId: TARGET_VIDEO_ID,
                title: "Concurrent Store Video",
                videoUrl: TARGET_VIDEO_URL,
              },
              "sess_store_token",
            ),
            { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET: RAZORPAY_SECRET },
          ),
        ),
      );

      for (const r of storeResponses) {
        assert.equal(r?.status, 200);
        const body: any = await r!.json();
        assert.equal(body.recovered, true);
      }

      const persisted = JSON.parse(
        fs.readFileSync(path.join(tmpDataDir, "facetube_store.json"), "utf8"),
      );
      assert.equal(persisted.videos.length, 1);
      assert.equal(persisted.wallets["FT102857"].balance, 1.0);
      assert.equal(
        persisted.walletTransactions.filter(
          (t: any) => t.transactionId === `TX_ADM_${TARGET_PAYMENT_ID}`,
        ).length,
        1,
      );
      const poolState = await getPersistentGlobalPoolState();
      assert.equal(poolState.reserves.length, 1);
    }
  });

  it("6. Client recoverCapturedPremiumPayment & PHP routes never create orders, open checkout, or call capture", async () => {
    const calledUrls: string[] = [];
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      calledUrls.push(url);
      return new Response(
        JSON.stringify({
          recovered: true,
          verified: true,
          paymentId: TARGET_PAYMENT_ID,
          orderId: TARGET_ORDER_ID,
          videoId: TARGET_VIDEO_ID,
          amount: 6,
          currency: "INR",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const clientRes = await recoverCapturedPremiumPayment({
      orderId: TARGET_ORDER_ID,
      paymentId: TARGET_PAYMENT_ID,
      videoId: TARGET_VIDEO_ID,
      userId: TARGET_USER_ID,
      title: "Client Recovery",
      videoUrl: TARGET_VIDEO_URL,
    });

    assert.equal(clientRes.recovered, true);
    assert.equal(calledUrls.length, 1);
    assert.match(calledUrls[0]!, /\/payments\/recover-captured\.php$/);

    // Static verification on PHP files to guarantee no /capture, /orders, or /refund endpoint calls
    const recoverPhp = fs.readFileSync(
      path.resolve(process.cwd(), "api/payments/recover-captured.php"),
      "utf8",
    );
    const settlementPhp = fs.readFileSync(
      path.resolve(process.cwd(), "api/payments/premium-settlement.php"),
      "utf8",
    );
    assert.doesNotMatch(recoverPhp, /\/v1\/payments\/.*\/capture/);
    assert.doesNotMatch(recoverPhp, /\/v1\/orders/);
    assert.doesNotMatch(recoverPhp, /\/v1\/.*\/refund/);
    assert.doesNotMatch(settlementPhp, /\/v1\/payments\/.*\/capture/);
    assert.match(recoverPhp, /ftCheckGlobalPoolReserveSchemaReadyPhp/);
    assert.match(recoverPhp, /ftValidateUploadedVideoAssetPhp/);
    assert.match(recoverPhp, /\$gatewayStatus\s*!==\s*'captured'/);
  });
});
