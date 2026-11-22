import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  evaluatePremiumDistribution,
  getPersistentGlobalPoolState,
  resetPersistentPremiumState,
  settlePersistentGlobalPoolReserves,
  verifyServerPayment,
} from "./payments";
import { handleApiRequest, resetInMemoryStore } from "./api-handler";
import { setMysqlPoolForTesting } from "./mysql";

const RAZORPAY_SECRET = "test_phase12_secret_key_abcdef123456";
const RAZORPAY_ENV: Record<string, string> = {
  RAZORPAY_KEY_ID: "rzp_test_phase12",
  RAZORPAY_KEY_SECRET: RAZORPAY_SECRET,
  RAZORPAY_SKIP_REMOTE_CHECK: "true",
};

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

describe("Phase 1.2 Corrective Fixes — Accounting, Schema Compatibility, Duplicate Handling, Zero-Payout & Parity", () => {
  let tmpDataDir = "";
  let prevFacetubeDataDir: string | undefined;
  let prevDbEnv: Record<string, string | undefined> = {};

  function enableMockMysqlEnv() {
    process.env["DB_HOST"] = "127.0.0.1";
    process.env["DB_NAME"] = "facetube_phase12_test";
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
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-p12-test-"));
    process.env["FACETUBE_DATA_DIR"] = tmpDataDir;
    resetInMemoryStore();
  });

  after(() => {
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
    setMysqlPoolForTesting(null);
    restoreMockMysqlEnv();
    resetInMemoryStore();
    await resetPersistentPremiumState(0, []);
  });

  afterEach(() => {
    setMysqlPoolForTesting(null);
    restoreMockMysqlEnv();
  });

  function createPhase12MysqlHarness(options: {
    uploadedVideoCols?: Array<"ad_earnings" | "is_blocked" | "promotion_payment_id">;
    hasGlobalPoolReservesTable?: boolean;
    hasGlobalPoolSettlementsTable?: boolean;
    reserveReasonEnum?: string;
    authRole?: string;
    hasReferrer?: boolean;
    txCount?: number;
    eligibleVideos?: Array<{
      video_id: string;
      user_id: string;
      ad_earnings?: number;
      is_blocked?: number;
    }>;
    pendingReserves?: Array<{
      id: string;
      payment_id: string;
      order_id: string | null;
      tx_number: number;
      source_user_id: string;
      source_video_id: string | null;
      reserve_amount: number;
      reserve_paise: number;
      reserve_reason: string;
      status: "pending" | "settled";
    }>;
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
    existingPremiumTx?: any;
    existingLedgerRows?: Array<{ transaction_id: string; user_id: string }>;
    existingSettlements?: Array<any>;
    failNextLedgerInsertWithDup?: boolean;
    failNextSettlementInsertWithDup?: boolean;
    failMissingTablesOnQuery?: boolean;
  }) {
    const executedQueries: Array<{ sql: string; params: any[] }> = [];
    const paymentTxInserts: Array<{ sql: string; params: any[] }> = [];
    const ledgerInserts: Array<{ sql: string; params: any[] }> = [];
    const reserveInserts: Array<{ sql: string; params: any[] }> = [];
    const reserveUpdates: Array<{ sql: string; params: any[] }> = [];
    const settlementInserts: Array<{ sql: string; params: any[] }> = [];
    const walletCredits: Array<{ userId: string; params: any[] }> = [];
    const reserves = (options.pendingReserves || []).map((r) => ({ ...r }));
    const settlements = new Map<string, any>();
    for (const s of options.existingSettlements || []) {
      settlements.set(String(s.idempotency_key), s);
    }
    let txSnapshotReserves: any[] | null = null;
    let txSnapshotSettlements: Map<string, any> | null = null;

    let committed = false;
    let rolledBack = false;
    let dupLedgerFailedOnce = false;
    let dupSettlementFailedOnce = false;

    const uploadedCols = options.uploadedVideoCols ?? ["ad_earnings", "is_blocked"];
    const hasReservesTbl = options.hasGlobalPoolReservesTable ?? true;
    const hasSettlementsTbl = options.hasGlobalPoolSettlementsTable ?? true;

    const handleQuery = async (sql: string, params: any[] = []) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      executedQueries.push({ sql: normalized, params });

      if (normalized.includes("FROM INFORMATION_SCHEMA.COLUMNS")) {
        const rows: any[] = [
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
              options.reserveReasonEnum ?? "enum('no_eligible_videos','rounding_residual')",
          },
        ];
        for (const col of uploadedCols) {
          rows.push({ TABLE_NAME: "uploaded_videos", COLUMN_NAME: col });
        }
        return [rows];
      }

      if (normalized.includes("FROM INFORMATION_SCHEMA.TABLES")) {
        const rows: any[] = [];
        if (hasReservesTbl) rows.push({ TABLE_NAME: "global_pool_reserves" });
        if (hasSettlementsTbl) rows.push({ TABLE_NAME: "global_pool_settlements" });
        return [rows];
      }

      if (normalized.includes("FROM sessions s") && normalized.includes("JOIN users u")) {
        const role = options.authRole ?? "user";
        const isAdm = role.toLowerCase() === "admin";
        return [
          [
            {
              id: isAdm ? "u-admin" : "u-alex",
              user_id: isAdm ? "FT102857" : "FT483921",
              name: isAdm ? "Admin" : "Alex Rivera",
              mobile: "9999999999",
              email: isAdm ? "admin@facetube.com" : "alex@facetube.com",
              role,
              referral_code: options.hasReferrer ? "FT900431" : null,
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
          video_id: "vid_p12_1",
          purpose: "premium_video_upload",
          plan_id: null,
          amount: 6.0,
          currency: "INR",
          status: "created",
          payment_id: null,
        };
        return [[ord]];
      }

      if (normalized.includes("FROM payment_transactions WHERE payment_id = ?")) {
        return [options.existingTx ? [options.existingTx] : []];
      }

      if (
        normalized.includes("SELECT referrer_id FROM premium_transactions WHERE payment_id = ?")
      ) {
        return [options.existingPremiumTx ? [options.existingPremiumTx] : []];
      }

      if (normalized.includes("FROM income_ledger WHERE transaction_id = ?")) {
        const txId = String(params[0] || "");
        const match = (options.existingLedgerRows || []).find(
          (l) => l.transaction_id === txId && l.user_id !== "UNASSIGNED_REFERRAL",
        );
        return [match ? [match] : []];
      }

      if (normalized.includes("FROM payment_transactions ORDER BY tx_number DESC")) {
        return [options.existingTx ? [options.existingTx] : []];
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
        return [[{ total: options.txCount ?? 0 }]];
      }

      if (normalized.includes("SELECT id, user_id, referral_code FROM users")) {
        return [
          [
            {
              id: "u-alex",
              user_id: "FT483921",
              referral_code: options.hasReferrer ? "FT900431" : null,
            },
          ],
        ];
      }

      if (normalized.includes("SELECT user_id FROM users WHERE (UPPER(user_id)")) {
        return [options.hasReferrer ? [{ user_id: "FT900431" }] : []];
      }

      if (normalized.includes("FROM uploaded_videos WHERE (video_type = 'premium'")) {
        // Strict schema check: simulate real MySQL ER_BAD_FIELD_ERROR if missing column referenced
        if (!uploadedCols.includes("ad_earnings") && normalized.includes("ad_earnings)")) {
          throw makeMysqlError(
            "Unknown column 'ad_earnings' in 'field list'",
            "ER_BAD_FIELD_ERROR",
            1054,
            "42S22",
          );
        }
        if (!uploadedCols.includes("is_blocked") && normalized.includes("is_blocked")) {
          throw makeMysqlError(
            "Unknown column 'is_blocked' in 'where clause'",
            "ER_BAD_FIELD_ERROR",
            1054,
            "42S22",
          );
        }
        let rows = options.eligibleVideos ?? [];
        if (normalized.includes("UPPER(user_id) != UPPER(?)")) {
          const excl = String(params[0] || "").toUpperCase();
          rows = rows.filter((v) => v.user_id.toUpperCase() !== excl);
        }
        if (uploadedCols.includes("is_blocked")) {
          rows = rows.filter((v) => !v.is_blocked);
        }
        return [rows];
      }

      if (
        (normalized.includes("FROM global_pool_reserves") ||
          normalized.includes("FROM global_pool_settlements")) &&
        options.failMissingTablesOnQuery
      ) {
        throw makeMysqlError(
          "Table 'facetube.global_pool_reserves' doesn't exist",
          "ER_NO_SUCH_TABLE",
          1146,
          "42S02",
        );
      }

      if (normalized.includes("FROM global_pool_settlements WHERE idempotency_key = ?")) {
        const key = String(params[0] || "");
        const row = settlements.get(key);
        return [row ? [row] : []];
      }

      if (normalized.includes("FROM global_pool_settlements ORDER BY created_at DESC")) {
        return [Array.from(settlements.values())];
      }

      if (normalized.includes("FROM global_pool_reserves WHERE status = 'pending'")) {
        return [reserves.filter((r) => r.status === "pending")];
      }

      if (normalized.includes("FROM global_pool_reserves ORDER BY tx_number ASC")) {
        return [reserves];
      }

      if (normalized.startsWith("INSERT INTO payment_transactions")) {
        paymentTxInserts.push({ sql: normalized, params });
        return [{ affectedRows: 1 }];
      }

      if (normalized.startsWith("INSERT INTO income_ledger")) {
        if (options.failNextLedgerInsertWithDup && !dupLedgerFailedOnce) {
          dupLedgerFailedOnce = true;
          throw makeMysqlError(
            "Duplicate entry 'TX_CONFLICT' for key 'transaction_id'",
            "ER_DUP_ENTRY",
            1062,
          );
        }
        ledgerInserts.push({ sql: normalized, params });
        return [{ affectedRows: 1 }];
      }

      if (normalized.startsWith("INSERT INTO global_pool_reserves")) {
        reserveInserts.push({ sql: normalized, params });
        reserves.push({
          id: String(params[0]),
          payment_id: String(params[1]),
          order_id: normalized.includes("'GLOBAL_POOL_SETTLEMENT'") ? null : String(params[2]),
          tx_number: normalized.includes("'GLOBAL_POOL_SETTLEMENT'") ? 0 : Number(params[3]),
          source_user_id: normalized.includes("'GLOBAL_POOL_SETTLEMENT'")
            ? "GLOBAL_POOL_SETTLEMENT"
            : String(params[4]),
          source_video_id: null,
          reserve_amount: Number(
            normalized.includes("'GLOBAL_POOL_SETTLEMENT'") ? params[2] : params[6],
          ),
          reserve_paise: Number(
            normalized.includes("'GLOBAL_POOL_SETTLEMENT'") ? params[3] : params[7],
          ),
          reserve_reason: normalized.includes("'GLOBAL_POOL_SETTLEMENT'")
            ? "rounding_residual"
            : String(params[8]),
          status: "pending",
        });
        return [{ affectedRows: 1 }];
      }

      if (normalized.startsWith("UPDATE global_pool_reserves SET status = 'settled'")) {
        reserveUpdates.push({ sql: normalized, params });
        const targetId = String(params[3]);
        const row = reserves.find((r) => r.id === targetId);
        if (row) row.status = "settled";
        return [{ affectedRows: row ? 1 : 0 }];
      }

      if (normalized.startsWith("INSERT INTO global_pool_settlements")) {
        if (options.failNextSettlementInsertWithDup && !dupSettlementFailedOnce) {
          dupSettlementFailedOnce = true;
          throw makeMysqlError(
            "Duplicate entry 'idem-key' for key 'idempotency_key'",
            "ER_DUP_ENTRY",
            1062,
          );
        }
        settlementInserts.push({ sql: normalized, params });
        const row = {
          id: params[0],
          idempotency_key: params[1],
          total_reserve_amount: params[2],
          distributed_amount: params[3],
          carry_forward_amount: params[4],
          reserve_count: params[5],
          eligible_video_count: params[6],
          payout_count: params[7],
          settled_by: params[8],
          notes: params[9],
          created_at: new Date().toISOString(),
        };
        settlements.set(String(params[1]), row);
        return [{ affectedRows: 1 }];
      }

      if (normalized.startsWith("INSERT INTO wallet_balances")) {
        walletCredits.push({ userId: String(params[0]), params });
        return [{ affectedRows: 1 }];
      }

      if (
        normalized.startsWith("UPDATE uploaded_videos") ||
        normalized.startsWith("UPDATE payment_orders") ||
        normalized.startsWith("UPDATE income_ledger")
      ) {
        return [{ affectedRows: 1 }];
      }

      return [[]];
    };

    const mockPool = {
      query: handleQuery,
      getConnection: async () => ({
        query: handleQuery,
        beginTransaction: async () => {
          committed = false;
          rolledBack = false;
          txSnapshotReserves = reserves.map((r) => ({ ...r }));
          txSnapshotSettlements = new Map(settlements);
        },
        commit: async () => {
          committed = true;
          txSnapshotReserves = null;
          txSnapshotSettlements = null;
        },
        rollback: async () => {
          rolledBack = true;
          if (txSnapshotReserves) {
            reserves.length = 0;
            reserves.push(...txSnapshotReserves);
            txSnapshotReserves = null;
          }
          if (txSnapshotSettlements) {
            settlements.clear();
            for (const [k, v] of txSnapshotSettlements.entries()) {
              settlements.set(k, v);
            }
            txSnapshotSettlements = null;
          }
        },
        release: () => {},
      }),
    };

    return {
      mockPool,
      executedQueries,
      paymentTxInserts,
      ledgerInserts,
      reserveInserts,
      reserveUpdates,
      settlementInserts,
      walletCredits,
      reserves,
      getStatus: () => ({ committed, rolledBack }),
    };
  }

  // ---------------------------------------------------------------------------
  // A. HIGH PRIORITY — Node MySQL schema compatibility & fail-closed 503
  // ---------------------------------------------------------------------------
  describe("A. Node MySQL Schema Compatibility & Fail-Closed Reserves", () => {
    it("A.1-A.3: Node payment verification & settlement adapt SQL when ad_earnings / is_blocked columns are missing (no ER_BAD_FIELD_ERROR)", async () => {
      // Minimal uploaded_videos table with NEITHER ad_earnings NOR is_blocked
      const verifyHarness = createPhase12MysqlHarness({
        uploadedVideoCols: [],
        hasGlobalPoolReservesTable: true,
        hasReferrer: true,
        txCount: 0,
        eligibleVideos: [{ video_id: "vid_min_1", user_id: "CR_A" }],
      });
      enableMockMysqlEnv();
      setMysqlPoolForTesting(verifyHarness.mockPool as any);

      const ordId = "ord_p12_mincols_1";
      const payId = "pay_p12_mincols_1";
      const verifyRes = await handleApiRequest(
        new Request("http://localhost:3000/api/payments/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer tok_p12" },
          body: JSON.stringify({
            orderId: ordId,
            paymentId: payId,
            signature: signOrderPayment(ordId, payId),
            userId: "FT483921",
            videoId: "vid_p12_1",
            purpose: "premium_video_upload",
          }),
        }),
        RAZORPAY_ENV,
      );
      assert.equal(verifyRes?.status, 200);
      const verifyBody = await verifyRes?.json();
      assert.equal(verifyBody.verified, true);
      assert.equal(verifyBody.distribution.globalPoolDistributedAmount, 3.0);
      assert.equal(verifyBody.distribution.adminAmount, 1.0);

      const videoQueriesVerify = verifyHarness.executedQueries.filter((q) =>
        q.sql.includes("FROM uploaded_videos WHERE (video_type = 'premium'"),
      );
      assert.equal(videoQueriesVerify.length, 1);
      assert.equal(videoQueriesVerify[0]?.sql.includes("COALESCE(ad_earnings"), false);
      assert.equal(videoQueriesVerify[0]?.sql.includes("is_blocked"), false);

      // Settlement with partial schema: only is_blocked present, no ad_earnings
      const settleHarness = createPhase12MysqlHarness({
        uploadedVideoCols: ["is_blocked"],
        authRole: "admin",
        eligibleVideos: [
          { video_id: "vid_s1", user_id: "CR_1", is_blocked: 0 },
          { video_id: "vid_s2", user_id: "CR_2", is_blocked: 1 },
        ],
        pendingReserves: [
          {
            id: "gpr_min_1",
            payment_id: "pay_min_prev",
            order_id: "ord_min_prev",
            tx_number: 1,
            source_user_id: "FT483921",
            source_video_id: "vid_src",
            reserve_amount: 3.0,
            reserve_paise: 300,
            reserve_reason: "no_eligible_videos",
            status: "pending",
          },
        ],
      });
      setMysqlPoolForTesting(settleHarness.mockPool as any);

      const settleRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/global-pool-settle", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer tok_adm" },
          body: JSON.stringify({ idempotencyKey: "settle-mincols-1" }),
        }),
        RAZORPAY_ENV,
      );
      assert.equal(settleRes?.status, 200);
      const settleBody = await settleRes?.json();
      assert.equal(settleBody.settledCount, 1);
      assert.equal(settleBody.settlement.payoutCount, 1); // blocked vid_s2 excluded cleanly
      assert.equal(settleBody.settlement.distributedAmount, 3.0);

      const videoQueriesSettle = settleHarness.executedQueries.filter((q) =>
        q.sql.includes("FROM uploaded_videos WHERE (video_type = 'premium'"),
      );
      assert.equal(videoQueriesSettle.length, 1);
      assert.equal(videoQueriesSettle[0]?.sql.includes("COALESCE(ad_earnings"), false);
      assert.equal(videoQueriesSettle[0]?.sql.includes("is_blocked"), true);
    });

    it("A.4-A.5: Missing global_pool_reserves fails closed with 503 BEFORE any partial ledger, transaction, or wallet writes", async () => {
      const harness = createPhase12MysqlHarness({
        hasGlobalPoolReservesTable: false,
        hasReferrer: true,
        txCount: 0,
        eligibleVideos: [], // reservePaise = 300 > 0
      });
      enableMockMysqlEnv();
      setMysqlPoolForTesting(harness.mockPool as any);

      const ordId = "ord_p12_missing_res_tbl";
      const payId = "pay_p12_missing_res_tbl";
      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/payments/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer tok_p12" },
          body: JSON.stringify({
            orderId: ordId,
            paymentId: payId,
            signature: signOrderPayment(ordId, payId),
            userId: "FT483921",
            videoId: "vid_p12_1",
            purpose: "premium_video_upload",
          }),
        }),
        RAZORPAY_ENV,
      );

      assert.equal(res?.status, 503);
      const body = await res?.json();
      assert.equal(body.verified, false);
      assert.equal(harness.getStatus().committed, false);
      assert.equal(harness.getStatus().rolledBack, true);
      assert.equal(harness.paymentTxInserts.length, 0);
      assert.equal(harness.ledgerInserts.length, 0);
      assert.equal(harness.walletCredits.length, 0);
      assert.equal(harness.reserveInserts.length, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // B. HIGH PRIORITY — Correct duplicate-key handling & 409 conflicts
  // ---------------------------------------------------------------------------
  describe("B. Duplicate-Key Handling & Transaction Identity Verification", () => {
    it("B.1-B.3: Settlement ER_DUP_ENTRY on income_ledger returns 409 conflict unless exact idempotencyKey exists in global_pool_settlements", async () => {
      const conflictHarness = createPhase12MysqlHarness({
        authRole: "admin",
        eligibleVideos: [{ video_id: "v_1", user_id: "CR_1", ad_earnings: 10 }],
        pendingReserves: [
          {
            id: "gpr_dup_1",
            payment_id: "pay_dup_1",
            order_id: "ord_dup_1",
            tx_number: 1,
            source_user_id: "FT483921",
            source_video_id: "vid_src",
            reserve_amount: 3.0,
            reserve_paise: 300,
            reserve_reason: "no_eligible_videos",
            status: "pending",
          },
        ],
        failNextLedgerInsertWithDup: true,
      });
      enableMockMysqlEnv();
      setMysqlPoolForTesting(conflictHarness.mockPool as any);

      const conflictRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/global-pool-settle", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer tok_adm" },
          body: JSON.stringify({ idempotencyKey: "settle-dup-conflict" }),
        }),
        RAZORPAY_ENV,
      );
      assert.equal(conflictRes?.status, 409);
      const conflictBody = await conflictRes?.json();
      assert.equal(conflictBody.success, false);
      assert.equal(conflictHarness.getStatus().rolledBack, true);
      assert.equal(conflictHarness.getStatus().committed, false);

      // Now test true replay race: ER_DUP_ENTRY on global_pool_settlements where idempotencyKey ALREADY exists
      const replayHarness = createPhase12MysqlHarness({
        authRole: "admin",
        eligibleVideos: [{ video_id: "v_1", user_id: "CR_1", ad_earnings: 10 }],
        pendingReserves: [
          {
            id: "gpr_dup_2",
            payment_id: "pay_dup_2",
            order_id: "ord_dup_2",
            tx_number: 2,
            source_user_id: "FT483921",
            source_video_id: "vid_src_2",
            reserve_amount: 3.0,
            reserve_paise: 300,
            reserve_reason: "no_eligible_videos",
            status: "pending",
          },
        ],
        failNextSettlementInsertWithDup: true,
      });
      // Inject matching batch into global_pool_settlements only AFTER FOR UPDATE check via custom query override
      const origQuery = replayHarness.mockPool.query;
      let sawInsertErr = false;
      replayHarness.mockPool.query = async (sql: string, params: any[] = []) => {
        const norm = sql.replace(/\s+/g, " ").trim();
        if (norm.startsWith("INSERT INTO global_pool_settlements")) {
          sawInsertErr = true;
        }
        if (
          sawInsertErr &&
          norm.includes("FROM global_pool_settlements WHERE idempotency_key = ? LIMIT 1")
        ) {
          return [
            [
              {
                id: "gps_race_winner",
                idempotency_key: params[0],
                total_reserve_amount: 3.0,
                distributed_amount: 3.0,
                carry_forward_amount: 0.0,
                reserve_count: 1,
                eligible_video_count: 1,
                payout_count: 1,
                settled_by: "FT102857",
                notes: "race winner",
                created_at: "2026-11-22T00:00:00.000Z",
              },
            ],
          ];
        }
        return origQuery(sql, params);
      };
      // Also proxy getConnection().query to the same wrapper
      const origGetConn = replayHarness.mockPool.getConnection;
      replayHarness.mockPool.getConnection = async () => {
        const c = await origGetConn();
        return { ...c, query: replayHarness.mockPool.query };
      };
      setMysqlPoolForTesting(replayHarness.mockPool as any);

      const raceReplayRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/global-pool-settle", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer tok_adm" },
          body: JSON.stringify({ idempotencyKey: "settle-race-replay" }),
        }),
        RAZORPAY_ENV,
      );
      assert.equal(raceReplayRes?.status, 200);
      const raceReplayBody = await raceReplayRes?.json();
      assert.equal(raceReplayBody.success, true);
      assert.equal(raceReplayBody.duplicate, true);
      assert.equal(raceReplayBody.settlement.id, "gps_race_winner");
    });

    it("B.3-B.5: Payment verify ER_DUP_ENTRY on ledger without payment_transactions returns 409, and conflicting identity returns 409 (never verified:true)", async () => {
      // 1) Duplicate on income_ledger when payment_transactions has NO row -> 409
      const ledgerConflictHarness = createPhase12MysqlHarness({
        hasReferrer: true,
        txCount: 0,
        eligibleVideos: [{ video_id: "v_1", user_id: "CR_1", ad_earnings: 5 }],
        failNextLedgerInsertWithDup: true,
      });
      enableMockMysqlEnv();
      setMysqlPoolForTesting(ledgerConflictHarness.mockPool as any);

      const ord1 = "ord_p12_led_dup";
      const pay1 = "pay_p12_led_dup";
      const conflictLedgerRes = await handleApiRequest(
        new Request("http://localhost:3000/api/payments/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer tok_p12" },
          body: JSON.stringify({
            orderId: ord1,
            paymentId: pay1,
            signature: signOrderPayment(ord1, pay1),
            userId: "FT483921",
            videoId: "vid_p12_1",
            purpose: "premium_video_upload",
          }),
        }),
        RAZORPAY_ENV,
      );
      assert.equal(conflictLedgerRes?.status, 409);
      const conflictLedgerBody = await conflictLedgerRes?.json();
      assert.equal(conflictLedgerBody.verified, false);
      assert.equal(ledgerConflictHarness.getStatus().rolledBack, true);

      // 2) Duplicate payment_id with mismatched video_id -> 409
      const mismatchHarness = createPhase12MysqlHarness({
        existingOrder: {
          order_id: "ord_p12_mismatch",
          user_id: "FT483921",
          user_name: "Alex Rivera",
          video_id: "vid_NEW",
          purpose: "premium_video_upload",
          amount: 6.0,
          currency: "INR",
          status: "created",
          payment_id: null,
        },
        existingTx: {
          payment_id: "pay_p12_mismatch",
          order_id: "ord_p12_mismatch",
          user_id: "FT483921",
          video_id: "vid_OTHER",
          purpose: "premium_video_upload",
          amount: 6.0,
          tx_number: 1,
          is_special: 0,
          special_tag: "NORMAL_PREMIUM",
          referral_commission: 1.0,
          admin_allocation: 1.0,
          global_pool_allocation: 3.0,
          referral_status: "credited",
        },
      });
      setMysqlPoolForTesting(mismatchHarness.mockPool as any);

      const mismatchRes = await handleApiRequest(
        new Request("http://localhost:3000/api/payments/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer tok_p12" },
          body: JSON.stringify({
            orderId: "ord_p12_mismatch",
            paymentId: "pay_p12_mismatch",
            signature: signOrderPayment("ord_p12_mismatch", "pay_p12_mismatch"),
            userId: "FT483921",
            videoId: "vid_NEW",
            purpose: "premium_video_upload",
          }),
        }),
        RAZORPAY_ENV,
      );
      assert.equal(mismatchRes?.status, 409);
      const mismatchBody = await mismatchRes?.json();
      assert.equal(mismatchBody.verified, false);
    });

    it("B.4 (fallback): verifyServerPayment rejects reused paymentId with different videoId, userId, orderId, or purpose", async () => {
      const ordA = "ord_fb_identity_a";
      const payA = "pay_fb_identity_a";
      const first = await verifyServerPayment(
        {
          orderId: ordA,
          paymentId: payA,
          signature: signOrderPayment(ordA, payA),
          userId: "FT483921",
          videoId: "vid_fb_1",
          purpose: "premium_video_upload",
        },
        [],
        "FT900431",
        RAZORPAY_ENV,
      );
      assert.equal(first.verified, true);

      const mismatchVideo = await verifyServerPayment(
        {
          orderId: ordA,
          paymentId: payA,
          signature: signOrderPayment(ordA, payA),
          userId: "FT483921",
          videoId: "vid_fb_2",
          purpose: "premium_video_upload",
        },
        [],
        "FT900431",
        RAZORPAY_ENV,
      );
      assert.equal(mismatchVideo.verified, false);
      assert.match(String(mismatchVideo.error), /Conflict/i);
    });
  });

  // ---------------------------------------------------------------------------
  // C. HIGH PRIORITY — Zero-payout settlement & insufficient_distributable_paise
  // ---------------------------------------------------------------------------
  describe("C. Zero-Payout Settlement & Reserve Reason Accuracy", () => {
    it("C.1-C.6 (MySQL): 2-paise reserve across 3 eligible creators stays pending, emits no 0-payout batch or SETTLE_CARRY, and credits Admin ₹0", async () => {
      const harness = createPhase12MysqlHarness({
        authRole: "admin",
        eligibleVideos: [
          { video_id: "v_c1", user_id: "CR_1", ad_earnings: 10 },
          { video_id: "v_c2", user_id: "CR_2", ad_earnings: 10 },
          { video_id: "v_c3", user_id: "CR_3", ad_earnings: 10 },
        ],
        pendingReserves: [
          {
            id: "gpr_2paise",
            payment_id: "pay_2paise",
            order_id: "ord_2paise",
            tx_number: 5,
            source_user_id: "FT483921",
            source_video_id: "vid_src_5",
            reserve_amount: 0.02,
            reserve_paise: 2,
            reserve_reason: "rounding_residual",
            status: "pending",
          },
        ],
      });
      enableMockMysqlEnv();
      setMysqlPoolForTesting(harness.mockPool as any);

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/global-pool-settle", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer tok_adm" },
          body: JSON.stringify({ idempotencyKey: "settle-2paise-zero-payout" }),
        }),
        RAZORPAY_ENV,
      );
      assert.equal(res?.status, 200);
      const body = await res?.json();
      assert.equal(body.success, true);
      assert.equal(body.settledCount, 0);
      assert.equal(body.remainingPendingCount, 1);
      assert.equal(body.reason, "insufficient_distributable_paise");
      assert.equal(body.settlement, null);
      assert.equal(harness.settlementInserts.length, 0);
      assert.equal(harness.reserveInserts.length, 0);
      assert.equal(harness.reserveUpdates.length, 0);
      assert.equal(harness.walletCredits.length, 0);
      assert.equal(harness.reserves[0]?.status, "pending");
    });

    it("C.1-C.6 (Fallback): settlePersistentGlobalPoolReserves keeps 2-paise reserve pending with reason insufficient_distributable_paise", async () => {
      await resetPersistentPremiumState(
        0,
        [],
        [],
        [],
        [
          {
            id: "gpr_fb_2p",
            paymentId: "pay_fb_2p",
            orderId: "ord_fb_2p",
            txNumber: 1,
            sourceUserId: "FT483921",
            sourceVideoId: "vid_src",
            reserveAmount: 0.02,
            reservePaise: 2,
            reserveReason: "rounding_residual",
            status: "pending",
            createdAt: "2026-11-22T00:00:00.000Z",
            updatedAt: "2026-11-22T00:00:00.000Z",
          },
        ],
      );

      const out = await settlePersistentGlobalPoolReserves({
        idempotencyKey: "fb-2paise-check",
        settledBy: "FT102857",
        eligibleVideos: [
          { userId: "CR_1", videoId: "v1", adEarnings: 5 },
          { userId: "CR_2", videoId: "v2", adEarnings: 5 },
          { userId: "CR_3", videoId: "v3", adEarnings: 5 },
        ],
      });

      assert.equal(out.settledCount, 0);
      assert.equal(out.remainingPendingCount, 1);
      assert.equal(out.skippedInsufficientPaiseCount, 1);
      assert.equal(out.reason, "insufficient_distributable_paise");
      assert.equal(out.settlement, null);
      assert.equal(out.carryForwardReserve, null);

      const gpState = await getPersistentGlobalPoolState();
      assert.equal(gpState.reserves.length, 1);
      assert.equal(gpState.reserves[0]?.status, "pending");
      assert.equal(gpState.settlements.length, 0);
    });

    it("C.5-C.6: evaluatePremiumDistribution uses insufficient_distributable_paise when eligible > 0 yields 0p, and no_eligible_videos ONLY when count === 0", async () => {
      const zeroEligible = evaluatePremiumDistribution(11, "FT900431", 0);
      assert.equal(zeroEligible.reserveReason, "no_eligible_videos");
      assert.equal(zeroEligible.adminAmount, 1.0);
      assert.equal(zeroEligible.globalPoolReserveAmount, 3.0);

      const tooManyCreators = evaluatePremiumDistribution(11, "FT900431", 301);
      assert.equal(tooManyCreators.eligibleMembersCount, 301);
      assert.equal(tooManyCreators.globalPoolDistributedAmount, 0);
      assert.equal(tooManyCreators.globalPoolReserveAmount, 3.0);
      assert.equal(tooManyCreators.reserveReason, "insufficient_distributable_paise");
      assert.equal(tooManyCreators.adminAmount, 1.0);

      // Verify MySQL verifies legacy ENUM safely maps insufficient_distributable_paise -> rounding_residual in SQL while returning exact JSON reason
      const manyVideos = Array.from({ length: 301 }, (_, i) => ({
        video_id: `v_many_${i}`,
        user_id: `CR_${i}`,
        ad_earnings: 1,
      }));
      const harness = createPhase12MysqlHarness({
        uploadedVideoCols: ["ad_earnings", "is_blocked"],
        reserveReasonEnum: "enum('no_eligible_videos','rounding_residual')",
        eligibleVideos: manyVideos,
        hasReferrer: true,
        txCount: 10,
      });
      enableMockMysqlEnv();
      setMysqlPoolForTesting(harness.mockPool as any);

      const ordId = "ord_p12_301_vids";
      const payId = "pay_p12_301_vids";
      const verifyRes = await handleApiRequest(
        new Request("http://localhost:3000/api/payments/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer tok_p12" },
          body: JSON.stringify({
            orderId: ordId,
            paymentId: payId,
            signature: signOrderPayment(ordId, payId),
            userId: "FT483921",
            videoId: "vid_p12_1",
            purpose: "premium_video_upload",
          }),
        }),
        RAZORPAY_ENV,
      );
      assert.equal(verifyRes?.status, 200);
      const body = await verifyRes?.json();
      assert.equal(body.distribution.globalPoolReserveReason, "insufficient_distributable_paise");
      assert.equal(body.distribution.adminAmount, 1.0);
      assert.equal(harness.reserveInserts.length, 1);
      // Mapped safely for un-migrated ENUM column:
      assert.equal(harness.reserveInserts[0]?.params[8], "rounding_residual");
      // Truthful text preserved in notes:
      assert.match(
        String(harness.reserveInserts[0]?.params[9]),
        /insufficient distributable paise/i,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // D. HIGH PRIORITY — Node/PHP parity
  // ---------------------------------------------------------------------------
  describe("D. Node/PHP Parity", () => {
    it("D.1 & D.2: Node admin settlement accepts case-insensitive 'Admin' role and returns 503 when tables are missing", async () => {
      const missingTblHarness = createPhase12MysqlHarness({
        authRole: "Admin",
        failMissingTablesOnQuery: true,
      });
      enableMockMysqlEnv();
      setMysqlPoolForTesting(missingTblHarness.mockPool as any);

      const getRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/global-pool-settle", {
          method: "GET",
          headers: { Authorization: "Bearer tok_adm_cap" },
        }),
        RAZORPAY_ENV,
      );
      assert.equal(getRes?.status, 503);

      const postRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/global-pool-settle", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer tok_adm_cap" },
          body: JSON.stringify({ idempotencyKey: "settle-503-check" }),
        }),
        RAZORPAY_ENV,
      );
      assert.equal(postRes?.status, 503);
    });

    it("D.3 & D.6: Paid-order fast-path skips remote Razorpay fetch and duplicate referrerId never leaks uploader ID", async () => {
      // Test 1: Credited duplicate with verified referrer FT900431 (uploader is FT483921)
      const creditedDupHarness = createPhase12MysqlHarness({
        existingOrder: {
          order_id: "ord_p12_fast_cred",
          user_id: "FT483921",
          user_name: "Alex Rivera",
          video_id: "vid_fast_1",
          purpose: "premium_video_upload",
          amount: 6.0,
          currency: "INR",
          status: "paid",
          payment_id: "pay_p12_fast_cred",
        },
        existingTx: {
          payment_id: "pay_p12_fast_cred",
          order_id: "ord_p12_fast_cred",
          user_id: "FT483921",
          video_id: "vid_fast_1",
          purpose: "premium_video_upload",
          amount: 6.0,
          tx_number: 11,
          is_special: 0,
          special_tag: "NORMAL_PREMIUM",
          referral_commission: 1.0,
          admin_allocation: 1.0,
          global_pool_allocation: 3.0,
          global_pool_distributed: 3.0,
          global_pool_reserve: 0.0,
          global_pool_status: "settled",
          gst_amount: 0.9,
          pg_fee: 0.1,
          referral_status: "credited",
        },
        existingPremiumTx: { referrer_id: "FT900431" },
      });
      enableMockMysqlEnv();
      setMysqlPoolForTesting(creditedDupHarness.mockPool as any);

      let razorpayFetchCalls = 0;
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        razorpayFetchCalls += 1;
        throw new Error("Should not hit Razorpay API on paid-order fast path");
      }) as typeof fetch;

      try {
        // Call with RAZORPAY_SKIP_REMOTE_CHECK unset to prove fast-path short-circuits remote fetch
        const envNoSkip = {
          RAZORPAY_KEY_ID: RAZORPAY_ENV["RAZORPAY_KEY_ID"],
          RAZORPAY_KEY_SECRET: RAZORPAY_SECRET,
        };
        const res1 = await handleApiRequest(
          new Request("http://localhost:3000/api/payments/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer tok_p12" },
            body: JSON.stringify({
              orderId: "ord_p12_fast_cred",
              paymentId: "pay_p12_fast_cred",
              signature: signOrderPayment("ord_p12_fast_cred", "pay_p12_fast_cred"),
              userId: "FT483921",
              videoId: "vid_fast_1",
              purpose: "premium_video_upload",
            }),
          }),
          envNoSkip,
        );
        assert.equal(res1?.status, 200);
        const body1 = await res1?.json();
        assert.equal(body1.verified, true);
        assert.equal(body1.duplicate, true);
        assert.equal(body1.txNumber, 11);
        assert.equal(body1.distribution.referrerId, "FT900431");
        assert.notEqual(body1.distribution.referrerId, "FT483921");
        assert.equal(razorpayFetchCalls, 0);

        // Test 2: Unassigned duplicate must return referrerId === null (never uploader FT483921)
        const unassignedHarness = createPhase12MysqlHarness({
          existingOrder: {
            order_id: "ord_p12_fast_unass",
            user_id: "FT483921",
            user_name: "Alex Rivera",
            video_id: "vid_fast_2",
            purpose: "premium_video_upload",
            amount: 6.0,
            currency: "INR",
            status: "paid",
            payment_id: "pay_p12_fast_unass",
          },
          existingTx: {
            payment_id: "pay_p12_fast_unass",
            order_id: "ord_p12_fast_unass",
            user_id: "FT483921",
            video_id: "vid_fast_2",
            purpose: "premium_video_upload",
            amount: 6.0,
            tx_number: 12,
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
        setMysqlPoolForTesting(unassignedHarness.mockPool as any);

        const res2 = await handleApiRequest(
          new Request("http://localhost:3000/api/payments/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer tok_p12" },
            body: JSON.stringify({
              orderId: "ord_p12_fast_unass",
              paymentId: "pay_p12_fast_unass",
              signature: signOrderPayment("ord_p12_fast_unass", "pay_p12_fast_unass"),
              userId: "FT483921",
              videoId: "vid_fast_2",
              purpose: "premium_video_upload",
            }),
          }),
          envNoSkip,
        );
        assert.equal(res2?.status, 200);
        const body2 = await res2?.json();
        assert.equal(body2.distribution.referralStatus, "unassigned_pending");
        assert.equal(body2.distribution.referrerId, null);
        assert.equal(razorpayFetchCalls, 0);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("D.4 & D.5: Fallback store aligns eligible video rule ((premium || paid) && !is_blocked) and never creates empty zero-balance wallets", async () => {
      // Log in as Alex to get a valid session token in isolated store
      const loginRes = await handleApiRequest(
        new Request("http://localhost:3000/api/auth/login.php", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
        }),
      );
      const loginBody = await loginRes?.json();
      const alexToken = loginBody?.token;
      assert.ok(alexToken);

      // Reset store videos to control eligibility cleanly & remove any pre-created creator wallets
      const tmpStorePath = path.join(tmpDataDir, "facetube_store.json");
      const store = JSON.parse(fs.readFileSync(tmpStorePath, "utf-8"));
      delete store.wallets["CR_PAID_ONLY"];
      delete store.wallets["CR_BLOCKED"];
      delete store.wallets["CR_TINY"];
      store.videos = [
        {
          id: "vid_uploader_cur",
          user_id: "FT483921",
          title: "Current Upload",
          video_type: "premium",
          payment_status: "pending",
          is_blocked: false,
          ad_earnings: 0,
        },
        {
          id: "vid_paid_only",
          user_id: "CR_PAID_ONLY",
          title: "Paid Video Without Premium Tag",
          video_type: "sponsored",
          payment_status: "paid",
          is_blocked: false,
          ad_earnings: 500, // 5,000,000 units -> gets 300 paise
        },
        {
          id: "vid_blocked",
          user_id: "CR_BLOCKED",
          title: "Blocked Premium",
          video_type: "premium",
          payment_status: "paid",
          is_blocked: true,
          ad_earnings: 500,
        },
        {
          id: "vid_tiny_zero",
          user_id: "CR_TINY",
          title: "Tiny Earnings Rounded To 0p",
          video_type: "premium",
          payment_status: "paid",
          is_blocked: false,
          ad_earnings: 0.0001, // 1 unit out of 5,000,001 -> 0 paise payout!
        },
      ];
      const ordId = "ord_fb_parity_1";
      const payId = "pay_fb_parity_1";
      store.paymentOrders = [
        {
          order_id: ordId,
          user_id: "FT483921",
          user_name: "Alex Rivera",
          video_id: "vid_uploader_cur",
          purpose: "premium_video_upload",
          amount: 6.0,
          currency: "INR",
          status: "created",
          created_at: new Date().toISOString(),
        },
      ];
      fs.writeFileSync(tmpStorePath, JSON.stringify(store, null, 2), "utf-8");
      resetInMemoryStore();

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/payments/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${alexToken}` },
          body: JSON.stringify({
            orderId: ordId,
            paymentId: payId,
            signature: signOrderPayment(ordId, payId),
            userId: "FT483921",
            videoId: "vid_uploader_cur",
            purpose: "premium_video_upload",
          }),
        }),
        RAZORPAY_ENV,
      );
      assert.equal(res?.status, 200);
      const body = await res?.json();
      assert.equal(body.verified, true);
      // CR_PAID_ONLY + CR_TINY eligible (2 eligible, CR_BLOCKED excluded)
      assert.equal(body.distribution.eligibleMembersCount, 2);

      const postStore = JSON.parse(fs.readFileSync(tmpStorePath, "utf-8"));
      assert.ok(postStore.wallets["CR_PAID_ONLY"], "Paid creator receiving >0p must be credited");
      assert.equal(
        postStore.wallets["CR_BLOCKED"],
        undefined,
        "Blocked video creator must be excluded",
      );
      assert.equal(
        postStore.wallets["CR_TINY"],
        undefined,
        "Zero-paise payout must NOT create an empty zero-balance wallet entry",
      );
    });

    it("D.7: payments/transactions queries MySQL payment_transactions when pool exists and fails closed 503 in production without pool", async () => {
      // Production without MySQL pool -> 503
      const prodRes = await handleApiRequest(
        new Request("http://localhost:3000/api/payments/transactions", { method: "GET" }),
        { NODE_ENV: "production" },
      );
      assert.equal(prodRes?.status, 503);

      // With MySQL pool -> queries payment_transactions directly
      const txHarness = createPhase12MysqlHarness({
        existingTx: {
          tx_number: 11,
          payment_id: "pay_tx_list_1",
          order_id: "ord_tx_list_1",
          video_id: "vid_tx_1",
          user_id: "FT483921",
          amount: 6.0,
          purpose: "premium_video_upload",
          is_special: 0,
          special_tag: "NORMAL_PREMIUM",
          referral_commission: 1.0,
          admin_allocation: 1.0,
          global_pool_allocation: 3.0,
          global_pool_distributed: 3.0,
          global_pool_reserve: 0.0,
          global_pool_status: "settled",
          gst_amount: 0.9,
          pg_fee: 0.1,
          referral_status: "credited",
          created_at: "2026-11-22T00:00:00.000Z",
        },
      });
      enableMockMysqlEnv();
      setMysqlPoolForTesting(txHarness.mockPool as any);

      const mysqlTxRes = await handleApiRequest(
        new Request("http://localhost:3000/api/payments/transactions", { method: "GET" }),
      );
      assert.equal(mysqlTxRes?.status, 200);
      const mysqlTxBody = await mysqlTxRes?.json();
      assert.equal(mysqlTxBody.status, "ok");
      assert.equal(mysqlTxBody.lastTxNumber, 11);
      assert.equal(mysqlTxBody.transactions.length, 1);
      assert.equal(mysqlTxBody.transactions[0].payment_id, "pay_tx_list_1");
    });

    it("PHP static parity checks confirm Phase 1.2 fixes in verify.php & global-pool-settle.php", () => {
      const verifyPhp = fs.readFileSync(
        path.resolve(process.cwd(), "api", "payments", "verify.php"),
        "utf-8",
      );
      const settlePhp = fs.readFileSync(
        path.resolve(process.cwd(), "api", "admin", "global-pool-settle.php"),
        "utf-8",
      );

      assert.ok(verifyPhp.includes("$resolveDuplicateReferrerId"));
      assert.ok(verifyPhp.includes("$buildDuplicateVerifyResponse"));
      assert.ok(
        verifyPhp.includes("Global Pool reserve schema migration has not been applied yet"),
      );
      assert.ok(verifyPhp.includes("insufficient_distributable_paise"));
      assert.ok(verifyPhp.includes("strtolower((string)$authUser['role']) === 'admin'"));
      // Ensure pre-cURL paid-order fast path appears before curl_init
      const fastPathIdx = verifyPhp.indexOf(
        "Fast-path idempotency before hitting remote Razorpay API",
      );
      const curlInitIdx = verifyPhp.indexOf('curl_init("https://api.razorpay.com');
      assert.ok(fastPathIdx > 0 && curlInitIdx > fastPathIdx);

      assert.ok(settlePhp.includes("insufficient_distributable_paise"));
      assert.ok(
        settlePhp.includes("Global Pool reserve schema migration has not been applied yet."),
      );
      assert.ok(
        settlePhp.includes("FROM global_pool_settlements WHERE idempotency_key = ? LIMIT 1"),
      );
      assert.ok(settlePhp.includes("Conflict: Duplicate accounting key"));
    });
  });
});
