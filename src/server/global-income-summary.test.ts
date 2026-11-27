import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleApiRequest, resetInMemoryStore } from "./api-handler";
import { resetPersistentPremiumState } from "./payments";
import { setMysqlPoolForTesting } from "./mysql";
import { api } from "../lib/api";
import {
  calculateTotalAdEarnings,
  deduplicateGlobalIncomeTransactions,
  extractGlobalIncomeEntryMeta,
  getDailyWithdrawnAmount,
  getGlobalIncomePaymentGroupKey,
  getGlobalIncomeSummary,
  getUserLedger,
  getUserWallet,
  groupGlobalIncomeTransactions,
  paginateGroupedGlobalIncomeEntries,
  resolveGlobalIncomeSourceMember,
  resolveGroupedGlobalIncomeStatus,
  sanitizeLedgerMemberText,
  type LedgerTransaction,
} from "../lib/ledger-service";
import { resolveAuthenticatedUserId } from "../lib/video-service";

interface MockAuthSession {
  token: string;
  user_id: string;
  id: string;
  name: string;
  role: "user" | "admin";
}

interface MockHarnessOptions {
  sessions?: MockAuthSession[];
  existingTables?: string[];
  existingColumns?: Array<{ table: string; column: string }>;
  walletRow?: {
    user_id: string;
    balance: number;
    total_earned: number;
    total_withdrawn: number;
    global_income: number;
  } | null;
  ledgerRow?: {
    ledger_total_earned: number;
    ledger_global_income: number;
    global_tx_count: number;
  };
  ptRows?: Array<{
    id: number;
    payment_id: string | null;
    order_id: string | null;
    purpose: string;
    status?: string | null;
    amount: number;
    referral_commission: number;
    admin_allocation: number;
    global_pool_allocation: number;
    gst_amount?: number;
    pg_fee?: number;
    global_pool_distributed?: number;
    global_pool_status?: string | null;
  }>;
  paymentOrders?: Array<{
    order_id: string;
    purpose: string;
    status: string;
    payment_id?: string | null;
  }>;
  settledLedgerProofs?: Array<{
    transaction_id: string;
    status: string;
    amount: number;
  }>;
  paidVideos?: Array<{
    video_id: string;
    user_id: string;
    video_type: string;
    payment_id?: string | null;
    payment_status: string;
    is_blocked?: number | null;
  }>;
  settlementBatches?: Array<{
    id: string;
    idempotency_key?: string | null;
    distributed_amount: number;
  }>;
  reserves?: Array<{
    id: string;
    payment_id?: string | null;
    reserve_amount: number;
    status: string;
  }>;
}

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function createGlobalIncomeMysqlHarness(opts: MockHarnessOptions) {
  const executedQueries: Array<{ sql: string; params: any[] }> = [];
  const existingTables = new Set((opts.existingTables || []).map((t) => t.toLowerCase()));
  const existingCols = opts.existingColumns || [];

  const sessions = opts.sessions || [
    {
      token: "tok_user_1",
      user_id: "FT483921",
      id: "uuid-483921",
      name: "Alex Creator",
      role: "user",
    },
    {
      token: "tok_admin_1",
      user_id: "FT100001",
      id: "uuid-admin",
      name: "Platform Admin",
      role: "admin",
    },
  ];

  const handleQuery = async (sql: string, params: any[] = []) => {
    const norm = sql.replace(/\s+/g, " ").trim();
    executedQueries.push({ sql: norm, params });

    // Enforce strictly read-only queries
    assert.equal(
      /^(SELECT|SHOW)\b/i.test(norm),
      true,
      `Expected strictly read-only SQL query, got: ${norm}`,
    );

    if (norm.includes("FROM sessions s INNER JOIN users u")) {
      const token = String(params[0] || "").trim();
      const hit = sessions.find((s) => s.token === token);
      return [hit ? [hit] : [], []];
    }

    if (norm.includes("FROM INFORMATION_SCHEMA.TABLES")) {
      return [Array.from(existingTables).map((t) => ({ TABLE_NAME: t })), []];
    }

    if (norm.includes("FROM INFORMATION_SCHEMA.COLUMNS")) {
      return [
        existingCols.map((c) => ({
          TABLE_NAME: c.table.toLowerCase(),
          COLUMN_NAME: c.column.toLowerCase(),
        })),
        [],
      ];
    }

    if (norm.includes("FROM wallet_balances")) {
      if (!existingTables.has("wallet_balances")) {
        throw new Error("Table wallet_balances queried without INFORMATION_SCHEMA guard");
      }
      const reqUid = String(params[0] || "")
        .trim()
        .toUpperCase();
      if (opts.walletRow && opts.walletRow.user_id.toUpperCase() === reqUid) {
        return [[opts.walletRow], []];
      }
      return [[], []];
    }

    if (norm.includes("AS ledger_total_earned") && norm.includes("FROM income_ledger")) {
      if (!existingTables.has("income_ledger")) {
        throw new Error("Table income_ledger queried without INFORMATION_SCHEMA guard");
      }
      return [
        [
          opts.ledgerRow || {
            ledger_total_earned: 0,
            ledger_global_income: 0,
            global_tx_count: 0,
          },
        ],
        [],
      ];
    }

    if (
      norm.includes("AS total_premium_transactions") &&
      norm.includes("FROM payment_transactions pt")
    ) {
      if (!existingTables.has("payment_transactions")) {
        throw new Error("Table payment_transactions queried without INFORMATION_SCHEMA guard");
      }

      const hasPoJoin = norm.includes("INNER JOIN payment_orders po");
      const hasStatusFilter = norm.includes("LOWER(TRIM(COALESCE(pt_in.status, ''))) IN");
      const hasExistsProof =
        norm.includes("EXISTS ( SELECT 1 FROM income_ledger il") ||
        norm.includes("EXISTS ( SELECT 1 FROM uploaded_videos uv");
      const usesStoredTax = norm.includes("COALESCE(pt.gst_amount, 0.00)");
      const usesPoolCols =
        norm.includes("pt.global_pool_status") && norm.includes("pt.global_pool_distributed");

      const allowedStatuses = new Set(["paid", "settled", "captured", "completed", "success"]);
      const firstByPaymentId = new Map<string, NonNullable<MockHarnessOptions["ptRows"]>[number]>();

      for (const row of [...(opts.ptRows || [])].sort((a, b) => a.id - b.id)) {
        if (row.purpose !== "premium_video_upload") continue;
        const payId = String(row.payment_id || "").trim();
        if (!payId || !(Number(row.amount) > 0)) continue;

        if (hasPoJoin) {
          const orderId = String(row.order_id || "").trim();
          if (!orderId) continue;
          const matchingOrder = (opts.paymentOrders || []).find(
            (o) =>
              o.order_id === orderId &&
              o.status.trim().toLowerCase() === "paid" &&
              o.purpose === "premium_video_upload" &&
              (!o.payment_id || o.payment_id.trim() === "" || o.payment_id.trim() === payId),
          );
          if (!matchingOrder) continue;
        }

        if (hasStatusFilter) {
          const st = String(row.status || "")
            .trim()
            .toLowerCase();
          if (!allowedStatuses.has(st)) continue;
        }

        if (!hasPoJoin && !hasStatusFilter) {
          if (!hasExistsProof) continue;
          const hasLedgerProof = (opts.settledLedgerProofs || []).some(
            (il) =>
              il.status === "settled" &&
              il.amount > 0 &&
              (il.transaction_id === `TX_ADM_${payId}` ||
                il.transaction_id === `TX_REF_${payId}` ||
                il.transaction_id.startsWith(`TX_GLB_${payId}_`)),
          );
          const hasVideoProof = (opts.paidVideos || []).some(
            (v) =>
              v.payment_id &&
              v.payment_id.trim() === payId &&
              v.payment_status.trim().toLowerCase() === "paid",
          );
          if (!hasLedgerProof && !hasVideoProof) continue;
        }

        if (!firstByPaymentId.has(payId)) {
          firstByPaymentId.set(payId, row);
        }
      }

      const uniqueRows = Array.from(firstByPaymentId.values());
      let totalTxAmount = 0;
      let refTotal = 0;
      let admTotal = 0;
      let gstTotal = 0;
      let pgTotal = 0;
      let glbAllocTotal = 0;
      let glbImmDistTotal = 0;

      for (const r of uniqueRows) {
        const amt = Number(r.amount) || 0;
        const ref = Number(r.referral_commission) || 0;
        const adm = Number(r.admin_allocation) || 0;
        const glb = Number(r.global_pool_allocation) || 0;
        totalTxAmount += amt;
        refTotal += ref;
        admTotal += adm;
        glbAllocTotal += glb;

        const isHist6 =
          Math.abs(amt - 6.0) <= 0.005 && Math.abs(amt - (ref + adm + glb) - 1.0) <= 0.005;

        if (usesStoredTax) {
          const sg = Number(r.gst_amount) || 0;
          const sp = Number(r.pg_fee) || 0;
          if (sg > 0 || sp > 0) {
            gstTotal += sg;
            pgTotal += sp;
          } else if (isHist6) {
            gstTotal += 0.9;
            pgTotal += 0.1;
          }
        } else if (isHist6) {
          gstTotal += 0.9;
          pgTotal += 0.1;
        }

        if (usesPoolCols) {
          const pStatus = String(r.global_pool_status || "").trim() || "not_applicable";
          glbImmDistTotal +=
            pStatus === "not_applicable" ? glb : Number(r.global_pool_distributed) || 0;
        } else {
          glbImmDistTotal += glb;
        }
      }

      return [
        [
          {
            total_premium_transactions: uniqueRows.length,
            total_transaction_amount: round2(totalTxAmount),
            referral_allocation_total: round2(refTotal),
            admin_allocation_total: round2(admTotal),
            gst_total: round2(gstTotal),
            pg_fee_total: round2(pgTotal),
            global_pool_allocation_total: round2(glbAllocTotal),
            immediate_global_pool_distributed_total: round2(glbImmDistTotal),
          },
        ],
        [],
      ];
    }

    if (norm.includes("FROM global_pool_settlements")) {
      if (!existingTables.has("global_pool_settlements")) {
        throw new Error("Table global_pool_settlements queried without INFORMATION_SCHEMA guard");
      }
      const byBatch = new Map<string, number>();
      for (const b of opts.settlementBatches || []) {
        const key = String(b.idempotency_key || "").trim() || b.id;
        byBatch.set(key, Math.max(byBatch.get(key) ?? 0, Number(b.distributed_amount) || 0));
      }
      return [
        [
          {
            settlement_batch_count: byBatch.size,
            settlement_distributed_total: round2(
              Array.from(byBatch.values()).reduce((s, v) => s + v, 0),
            ),
          },
        ],
        [],
      ];
    }

    if (norm.includes("FROM global_pool_reserves gpr")) {
      if (!existingTables.has("global_pool_reserves")) {
        throw new Error("Table global_pool_reserves queried without INFORMATION_SCHEMA guard");
      }
      const seen = new Set<string>();
      let pendingCount = 0;
      let pendingTotal = 0;
      let settledCount = 0;
      let settledTotal = 0;
      let cancelledCount = 0;
      let cancelledTotal = 0;

      for (const res of opts.reserves || []) {
        const key = String(res.payment_id || "").trim() || res.id;
        if (seen.has(key)) continue;
        seen.add(key);
        const st = res.status.trim().toLowerCase();
        const amt = Number(res.reserve_amount) || 0;
        if (st === "pending") {
          pendingCount += 1;
          pendingTotal += amt;
        } else if (st === "settled") {
          settledCount += 1;
          settledTotal += amt;
        } else if (st === "cancelled") {
          cancelledCount += 1;
          cancelledTotal += amt;
        }
      }

      return [
        [
          {
            pending_reserve_count: pendingCount,
            pending_reserve_total: round2(pendingTotal),
            settled_reserve_count: settledCount,
            settled_reserve_total: round2(settledTotal),
            cancelled_reserve_count: cancelledCount,
            cancelled_reserve_total: round2(cancelledTotal),
          },
        ],
        [],
      ];
    }

    if (norm.includes("FROM uploaded_videos")) {
      const checkBlocked = norm.includes("is_blocked = 0 OR is_blocked IS NULL");
      const eligible = (opts.paidVideos || []).filter(
        (v) =>
          (v.video_type === "premium" || v.payment_status === "paid") &&
          (!checkBlocked || Number(v.is_blocked || 0) === 0),
      );
      const creators = new Set(eligible.map((v) => v.user_id.trim().toUpperCase()));
      return [
        [
          {
            eligible_creator_count: creators.size,
            eligible_video_count: eligible.length,
          },
        ],
        [],
      ];
    }

    throw new Error(`Unexpected SQL query in mock harness: ${norm}`);
  };

  const mockPool: any = {
    query: handleQuery,
    execute: handleQuery,
    getConnection: async () => ({
      query: handleQuery,
      execute: handleQuery,
      release: () => {},
    }),
  };

  return { mockPool, executedQueries };
}

describe("FaceTube Task 2: Backend Global Income Summary Tests", () => {
  let tmpDataDir = "";
  let prevFacetubeDataDir: string | undefined;
  let prevDbEnv: Record<string, string | undefined> = {};

  function enableMockMysqlEnv() {
    process.env["DB_HOST"] = "127.0.0.1";
    process.env["DB_NAME"] = "facetube_global_income_test";
    process.env["DB_USER"] = "facetube_test";
    process.env["DB_PASSWORD"] = "facetube_pass";
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
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-gi-test-"));
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

  const prodEnv = { APP_ENV: "production", NODE_ENV: "production" };

  it("1. Enforces method (405), auth (401), cross-user restrictions (403/200 admin), and prod DB unavailability (503)", async () => {
    enableMockMysqlEnv();
    const { mockPool } = createGlobalIncomeMysqlHarness({
      existingTables: ["wallet_balances", "income_ledger"],
      walletRow: {
        user_id: "FT483921",
        balance: 100,
        total_earned: 250,
        total_withdrawn: 150,
        global_income: 75,
      },
    });
    setMysqlPoolForTesting(mockPool);

    // Non-GET -> 405
    const postRes = await handleApiRequest(
      new Request("http://localhost/api/wallet/global-income", { method: "POST" }),
      prodEnv,
    );
    assert.equal(postRes?.status, 405);

    // Unauthenticated -> 401
    const unauthRes = await handleApiRequest(
      new Request("http://localhost/api/wallet/global-income.php", { method: "GET" }),
      prodEnv,
    );
    assert.equal(unauthRes?.status, 401);

    // Cross-user non-admin -> 403
    const crossRes = await handleApiRequest(
      new Request("http://localhost/api/wallet/global-income?userId=FT900431", {
        method: "GET",
        headers: { Authorization: "Bearer tok_user_1" },
      }),
      prodEnv,
    );
    assert.equal(crossRes?.status, 403);

    // Admin cross-user -> 200
    const adminRes = await handleApiRequest(
      new Request("http://localhost/api/wallet/global-income?userId=FT483921", {
        method: "GET",
        headers: { Authorization: "Bearer tok_admin_1" },
      }),
      prodEnv,
    );
    assert.equal(adminRes?.status, 200);
    const adminJson: any = await adminRes?.json();
    assert.equal(adminJson.personal.userId, "FT483921");
    assert.equal(adminJson.personal.totalIncome, 250);

    // Production with no MySQL pool -> 503
    setMysqlPoolForTesting(null);
    restoreMockMysqlEnv();
    const noDbRes = await handleApiRequest(
      new Request("http://localhost/api/wallet/global-income", {
        method: "GET",
        headers: { Authorization: "Bearer tok_user_1" },
      }),
      prodEnv,
    );
    assert.equal(noDbRes?.status, 503);
  });

  it("2. Case A (payment_orders exists): verifies strict paid order matching, deduplication, GST/PG historical fallback, settlements & reserves without double counting", async () => {
    enableMockMysqlEnv();
    const { mockPool, executedQueries } = createGlobalIncomeMysqlHarness({
      existingTables: [
        "payment_orders",
        "global_pool_reserves",
        "global_pool_settlements",
        "payment_transactions",
        "income_ledger",
        "wallet_balances",
        "uploaded_videos",
      ],
      existingColumns: [
        { table: "payment_transactions", column: "status" },
        { table: "payment_transactions", column: "gst_amount" },
        { table: "payment_transactions", column: "pg_fee" },
        { table: "payment_transactions", column: "global_pool_distributed" },
        { table: "payment_transactions", column: "global_pool_status" },
        { table: "uploaded_videos", column: "is_blocked" },
      ],
      walletRow: {
        user_id: "FT483921",
        balance: 4280.5,
        total_earned: 7430.5,
        total_withdrawn: 3150.0,
        global_income: 2450.0,
      },
      ledgerRow: {
        ledger_total_earned: 2.5,
        ledger_global_income: 1.5,
        global_tx_count: 1,
      },
      paymentOrders: [
        {
          order_id: "ord_ok_1",
          purpose: "premium_video_upload",
          status: "paid",
          payment_id: "pay_ok_1",
        },
        {
          order_id: "ord_ok_2",
          purpose: "premium_video_upload",
          status: "paid",
          payment_id: "pay_ok_2",
        },
        {
          order_id: "ord_hist_3",
          purpose: "premium_video_upload",
          status: "paid",
          payment_id: "pay_hist_3",
        },
        {
          order_id: "ord_created",
          purpose: "premium_video_upload",
          status: "created",
          payment_id: "pay_created",
        },
        {
          order_id: "ord_failed",
          purpose: "premium_video_upload",
          status: "failed",
          payment_id: "pay_failed",
        },
        { order_id: "ord_ads", purpose: "ads_promotion", status: "paid", payment_id: "pay_ads" },
        {
          order_id: "ord_mismatch",
          purpose: "premium_video_upload",
          status: "paid",
          payment_id: "pay_other",
        },
      ],
      ptRows: [
        // Valid tx 1 (immediate full distribution, stored GST/PG)
        {
          id: 1,
          payment_id: "pay_ok_1",
          order_id: "ord_ok_1",
          purpose: "premium_video_upload",
          status: "paid",
          amount: 6.0,
          referral_commission: 1.0,
          admin_allocation: 1.0,
          global_pool_allocation: 3.0,
          gst_amount: 0.9,
          pg_fee: 0.1,
          global_pool_distributed: 3.0,
          global_pool_status: "distributed",
        },
        // Duplicate of pay_ok_1 -> must NOT be counted twice
        {
          id: 2,
          payment_id: "pay_ok_1",
          order_id: "ord_ok_1",
          purpose: "premium_video_upload",
          status: "paid",
          amount: 6.0,
          referral_commission: 1.0,
          admin_allocation: 1.0,
          global_pool_allocation: 3.0,
          gst_amount: 0.9,
          pg_fee: 0.1,
          global_pool_distributed: 3.0,
          global_pool_status: "distributed",
        },
        // Valid tx 2 (reserved ₹3 -> immediate distributed = 0, handled via settlement batches)
        {
          id: 3,
          payment_id: "pay_ok_2",
          order_id: "ord_ok_2",
          purpose: "premium_video_upload",
          status: "settled",
          amount: 6.0,
          referral_commission: 1.0,
          admin_allocation: 1.0,
          global_pool_allocation: 3.0,
          gst_amount: 0.9,
          pg_fee: 0.1,
          global_pool_distributed: 0.0,
          global_pool_status: "reserved",
        },
        // Valid historical tx 3 (default-zero GST/PG + 'not_applicable' immediate pool fallback)
        {
          id: 4,
          payment_id: "pay_hist_3",
          order_id: "ord_hist_3",
          purpose: "premium_video_upload",
          status: "paid",
          amount: 6.0,
          referral_commission: 1.0,
          admin_allocation: 1.0,
          global_pool_allocation: 3.0,
          gst_amount: 0.0,
          pg_fee: 0.0,
          global_pool_distributed: 0.0,
          global_pool_status: "not_applicable",
        },
        // Excluded rows: unpaid order, failed order, wrong purpose, mismatched payment_id, missing order_id
        {
          id: 5,
          payment_id: "pay_created",
          order_id: "ord_created",
          purpose: "premium_video_upload",
          status: "paid",
          amount: 6.0,
          referral_commission: 1.0,
          admin_allocation: 1.0,
          global_pool_allocation: 3.0,
        },
        {
          id: 6,
          payment_id: "pay_failed",
          order_id: "ord_failed",
          purpose: "premium_video_upload",
          status: "failed",
          amount: 6.0,
          referral_commission: 1.0,
          admin_allocation: 1.0,
          global_pool_allocation: 3.0,
        },
        {
          id: 7,
          payment_id: "pay_ads",
          order_id: "ord_ads",
          purpose: "premium_video_upload",
          status: "paid",
          amount: 6.0,
          referral_commission: 1.0,
          admin_allocation: 1.0,
          global_pool_allocation: 3.0,
        },
        {
          id: 8,
          payment_id: "pay_mismatch",
          order_id: "ord_mismatch",
          purpose: "premium_video_upload",
          status: "paid",
          amount: 6.0,
          referral_commission: 1.0,
          admin_allocation: 1.0,
          global_pool_allocation: 3.0,
        },
        {
          id: 9,
          payment_id: "pay_no_order",
          order_id: null,
          purpose: "premium_video_upload",
          status: "paid",
          amount: 6.0,
          referral_commission: 1.0,
          admin_allocation: 1.0,
          global_pool_allocation: 3.0,
        },
      ],
      settlementBatches: [
        { id: "set_1", idempotency_key: "idem_1", distributed_amount: 2.94 },
        // Duplicate idempotency batch row must count once
        { id: "set_1_dup", idempotency_key: "idem_1", distributed_amount: 2.94 },
      ],
      reserves: [
        // Settled original ₹3 reserve + ₹0.06 carry-forward pending reserve + cancelled reserve
        { id: "res_1", payment_id: "pay_ok_2", reserve_amount: 3.0, status: "settled" },
        { id: "res_cf_1", payment_id: "CF_RES_1", reserve_amount: 0.06, status: "pending" },
        { id: "res_can_1", payment_id: "pay_can", reserve_amount: 3.0, status: "cancelled" },
      ],
      paidVideos: [
        {
          video_id: "v1",
          user_id: "FT483921",
          video_type: "premium",
          payment_status: "paid",
          is_blocked: 0,
        },
        {
          video_id: "v2",
          user_id: "ft483921",
          video_type: "premium",
          payment_status: "paid",
          is_blocked: 0,
        },
        {
          video_id: "v3",
          user_id: "FT900431",
          video_type: "premium",
          payment_status: "paid",
          is_blocked: 0,
        },
        {
          video_id: "v_blk",
          user_id: "FT999999",
          video_type: "premium",
          payment_status: "paid",
          is_blocked: 1,
        },
      ],
    });
    setMysqlPoolForTesting(mockPool);

    const res = await handleApiRequest(
      new Request("http://localhost/api/wallet/global-income.php", {
        method: "GET",
        headers: { Authorization: "Bearer tok_user_1" },
      }),
      prodEnv,
    );
    assert.equal(res?.status, 200);
    const data: any = await res?.json();

    assert.equal(data.success, true);
    // Personal: wallet_balances authoritative + cross-check diff without double adding
    assert.equal(data.personal.userId, "FT483921");
    assert.equal(data.personal.hasWalletRow, true);
    assert.equal(data.personal.totalIncome, 7430.5);
    assert.equal(data.personal.globalIncome, 2450.0);
    assert.equal(data.personal.ledgerTotalEarned, 2.5);
    assert.equal(data.personal.walletVsLedgerDiff, 7428.0);
    assert.equal(data.personal.source, "wallet_balances");

    // Platform: 3 valid unique transactions = ₹18.00
    assert.equal(data.platform.totalPremiumTransactions, 3);
    assert.equal(data.platform.totalTransactionAmount, 18.0);
    assert.equal(data.platform.referralAllocationTotal, 3.0);
    assert.equal(data.platform.adminAllocationTotal, 3.0);
    assert.equal(data.platform.gstTotal, 2.7); // 3 * 0.90 (including 1 historical fallback)
    assert.equal(data.platform.pgFeeTotal, 0.3); // 3 * 0.10
    assert.equal(data.platform.globalPoolAllocationTotal, 9.0);
    // Immediate = 3.0 (pay_ok_1) + 0.0 (pay_ok_2 reserved) + 3.0 (pay_hist_3 not_applicable) = 6.0
    assert.equal(data.platform.immediateGlobalPoolDistributedTotal, 6.0);
    assert.equal(data.platform.settlementBatchCount, 1);
    assert.equal(data.platform.settlementDistributedTotal, 2.94);
    // Distributed = 6.0 + 2.94 = 8.94 (settled ₹3.00 reserve is NOT added again!)
    assert.equal(data.platform.globalPoolDistributedTotal, 8.94);
    assert.equal(data.platform.pendingReserveCount, 1);
    assert.equal(data.platform.pendingReserveTotal, 0.06);
    assert.equal(data.platform.settledReserveCount, 1);
    assert.equal(data.platform.settledReserveTotal, 3.0);
    assert.equal(data.platform.cancelledReserveCount, 1);
    assert.equal(data.platform.cancelledReserveTotal, 3.0);
    assert.equal(data.platform.eligibleCreatorCount, 2);
    assert.equal(data.platform.eligibleVideoCount, 3);

    // Must omit poolAvgPerCreator completely
    assert.equal("poolAvgPerCreator" in data, false);
    assert.equal("poolAvgPerCreator" in data.platform, false);
    assert.equal("poolAvgPerCreator" in data.personal, false);

    // Case A SQL must INNER JOIN payment_orders
    const ptSql =
      executedQueries.find((q) => q.sql.includes("AS total_premium_transactions"))?.sql || "";
    assert.ok(ptSql.includes("INNER JOIN payment_orders po"));
  });

  it("3. Case B1 (payment_orders absent, payment_transactions.status exists): requires successful status and ignores unverified rows", async () => {
    enableMockMysqlEnv();
    const { mockPool, executedQueries } = createGlobalIncomeMysqlHarness({
      existingTables: ["payment_transactions", "income_ledger", "wallet_balances"],
      existingColumns: [{ table: "payment_transactions", column: "status" }],
      walletRow: null, // missing wallet row -> income_ledger_fallback
      ledgerRow: {
        ledger_total_earned: 12.5,
        ledger_global_income: 4.5,
        global_tx_count: 3,
      },
      ptRows: [
        {
          id: 10,
          payment_id: "pay_b1_paid",
          order_id: null,
          purpose: "premium_video_upload",
          status: "captured",
          amount: 6.0,
          referral_commission: 1.0,
          admin_allocation: 1.0,
          global_pool_allocation: 3.0,
        },
        // Non-₹6 historical zero row (0 remainder -> GST/PG fallback must stay 0.00!)
        {
          id: 11,
          payment_id: "pay_b1_zero_rem",
          order_id: null,
          purpose: "premium_video_upload",
          status: "success",
          amount: 6.0,
          referral_commission: 1.0,
          admin_allocation: 2.0,
          global_pool_allocation: 3.0,
        },
        {
          id: 12,
          payment_id: "pay_b1_pending",
          order_id: null,
          purpose: "premium_video_upload",
          status: "pending",
          amount: 6.0,
          referral_commission: 1.0,
          admin_allocation: 1.0,
          global_pool_allocation: 3.0,
        },
        {
          id: 13,
          payment_id: "pay_b1_null",
          order_id: null,
          purpose: "premium_video_upload",
          status: null,
          amount: 6.0,
          referral_commission: 1.0,
          admin_allocation: 1.0,
          global_pool_allocation: 3.0,
        },
      ],
    });
    setMysqlPoolForTesting(mockPool);

    const res = await handleApiRequest(
      new Request("http://localhost/api/wallet/global-income", {
        method: "GET",
        headers: { Authorization: "Bearer tok_user_1" },
      }),
      prodEnv,
    );
    assert.equal(res?.status, 200);
    const data: any = await res?.json();

    assert.equal(data.personal.hasWalletRow, false);
    assert.equal(data.personal.source, "income_ledger_fallback");
    assert.equal(data.personal.totalIncome, 12.5);
    assert.equal(data.personal.globalIncome, 4.5);

    assert.equal(data.platform.totalPremiumTransactions, 2);
    assert.equal(data.platform.totalTransactionAmount, 12.0);
    // Only pay_b1_paid qualifies for 0.90 / 0.10 fallback; pay_b1_zero_rem has remainder 0 -> 0.00
    assert.equal(data.platform.gstTotal, 0.9);
    assert.equal(data.platform.pgFeeTotal, 0.1);
    // Optional tables missing -> 0 safely
    assert.equal(data.platform.settlementBatchCount, 0);
    assert.equal(data.platform.pendingReserveTotal, 0);
    assert.equal(data.platform.eligibleCreatorCount, 0);

    const ptSql =
      executedQueries.find((q) => q.sql.includes("AS total_premium_transactions"))?.sql || "";
    assert.equal(ptSql.includes("payment_orders"), false);
    assert.ok(ptSql.includes("LOWER(TRIM(COALESCE(pt_in.status, ''))) IN"));
  });

  it("4. Case B2 (neither payment_orders nor payment_transactions.status exists): requires settled ledger or paid video proof", async () => {
    enableMockMysqlEnv();
    const { mockPool, executedQueries } = createGlobalIncomeMysqlHarness({
      existingTables: [
        "payment_transactions",
        "income_ledger",
        "uploaded_videos",
        "wallet_balances",
      ],
      existingColumns: [], // no status, no tax cols, no pool cols, no is_blocked
      ptRows: [
        // Verified via TX_ADM_ ledger
        {
          id: 21,
          payment_id: "pay_b2_adm",
          order_id: null,
          purpose: "premium_video_upload",
          amount: 6.0,
          referral_commission: 1.0,
          admin_allocation: 1.0,
          global_pool_allocation: 3.0,
        },
        // Verified via uploaded_videos payment_status='paid'
        {
          id: 22,
          payment_id: "pay_b2_vid",
          order_id: null,
          purpose: "premium_video_upload",
          amount: 6.0,
          referral_commission: 1.0,
          admin_allocation: 1.0,
          global_pool_allocation: 3.0,
        },
        // Unverified orphan row -> MUST be excluded!
        {
          id: 23,
          payment_id: "pay_b2_orphan",
          order_id: null,
          purpose: "premium_video_upload",
          amount: 6.0,
          referral_commission: 1.0,
          admin_allocation: 1.0,
          global_pool_allocation: 3.0,
        },
      ],
      settledLedgerProofs: [
        { transaction_id: "TX_ADM_pay_b2_adm", status: "settled", amount: 1.0 },
      ],
      paidVideos: [
        {
          video_id: "vid_b2",
          user_id: "FT483921",
          video_type: "premium",
          payment_id: "pay_b2_vid",
          payment_status: "paid",
        },
      ],
    });
    setMysqlPoolForTesting(mockPool);

    const res = await handleApiRequest(
      new Request("http://localhost/api/wallet/global-income", {
        method: "GET",
        headers: { Authorization: "Bearer tok_user_1" },
      }),
      prodEnv,
    );
    assert.equal(res?.status, 200);
    const data: any = await res?.json();

    assert.equal(data.platform.totalPremiumTransactions, 2);
    assert.equal(data.platform.totalTransactionAmount, 12.0);
    assert.equal(data.platform.gstTotal, 1.8);
    assert.equal(data.platform.pgFeeTotal, 0.2);
    assert.equal(data.platform.globalPoolDistributedTotal, 6.0);
    assert.equal(data.platform.eligibleCreatorCount, 1);

    const ptSql =
      executedQueries.find((q) => q.sql.includes("AS total_premium_transactions"))?.sql || "";
    assert.equal(ptSql.includes("payment_orders"), false);
    assert.ok(ptSql.includes("EXISTS"));
    assert.equal(ptSql.includes("is_blocked"), false);
  });

  it("5. PHP/Node contract parity & static source verification: frontend omits poolAvgPerCreator and preserves existing ₹6 accounting rules", () => {
    const phpPath = path.resolve(process.cwd(), "api", "wallet", "global-income.php");
    const phpSrc = fs.readFileSync(phpPath, "utf-8");

    const requiredContractKeys = [
      "'userId'",
      "'hasWalletRow'",
      "'totalIncome'",
      "'globalIncome'",
      "'balance'",
      "'totalWithdrawn'",
      "'walletTotalEarned'",
      "'walletGlobalIncome'",
      "'ledgerTotalEarned'",
      "'ledgerGlobalIncome'",
      "'walletVsLedgerDiff'",
      "'globalTxCount'",
      "'source'",
      "'totalPremiumTransactions'",
      "'totalTransactionAmount'",
      "'referralAllocationTotal'",
      "'adminAllocationTotal'",
      "'gstTotal'",
      "'pgFeeTotal'",
      "'globalPoolAllocationTotal'",
      "'immediateGlobalPoolDistributedTotal'",
      "'settlementBatchCount'",
      "'settlementDistributedTotal'",
      "'globalPoolDistributedTotal'",
      "'pendingReserveCount'",
      "'pendingReserveTotal'",
      "'settledReserveCount'",
      "'settledReserveTotal'",
      "'cancelledReserveCount'",
      "'cancelledReserveTotal'",
      "'eligibleCreatorCount'",
      "'eligibleVideoCount'",
    ];

    for (const key of requiredContractKeys) {
      assert.ok(phpSrc.includes(key), `PHP endpoint missing required JSON key ${key}`);
    }
    assert.equal(
      phpSrc.includes("poolAvgPerCreator"),
      false,
      "PHP endpoint must omit poolAvgPerCreator completely",
    );
    assert.ok(phpSrc.includes("INFORMATION_SCHEMA.TABLES"));
    assert.ok(phpSrc.includes("INFORMATION_SCHEMA.COLUMNS"));
    assert.ok(phpSrc.includes("INNER JOIN payment_orders po"));
    assert.ok(phpSrc.includes("LOWER(TRIM(COALESCE(pt_in.status, ''))) IN"));
    assert.ok(phpSrc.includes("TX_ADM_"));
    // Strictly read-only SQL check in PHP
    assert.equal(
      /\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i.test(phpSrc),
      false,
      "api/wallet/global-income.php must be strictly read-only",
    );

    const routePath = path.resolve(process.cwd(), "src", "routes", "global-income.tsx");
    const routeSrc = fs.readFileSync(routePath, "utf-8");
    assert.ok(routeSrc.includes("getGlobalIncomeSummary"));
    assert.ok(routeSrc.includes("summary.personal.totalIncome"));
    assert.ok(routeSrc.includes("Total Income"));
    for (const forbiddenLabel of [
      "GST + PG",
      "₹0.90 GST + ₹0.10 PG Fee",
      "Company infrastructure & servers",
      "Global Distribution",
      "Weighted pool for eligible Sponsor videos",
      "Sponsor Video Allocation Overview",
      "Global Pool Distributed",
      "Eligible Creators",
    ]) {
      assert.equal(
        routeSrc.includes(forbiddenLabel),
        false,
        `global-income.tsx must NOT display removed breakdown label: ${forbiddenLabel}`,
      );
    }
    assert.equal(
      routeSrc.includes("getEligibleGlobalIncomeUsers"),
      false,
      "global-income.tsx must not use localStorage getEligibleGlobalIncomeUsers",
    );
    assert.equal(
      routeSrc.includes("poolAvgPerCreator"),
      false,
      "global-income.tsx must omit poolAvgPerCreator completely",
    );
  });
});

describe("Global Income per-video ledger deduplication and display metadata", () => {
  const makeGlobalTx = (
    overrides: Partial<LedgerTransaction> & { transactionId: string },
  ): LedgerTransaction => ({
    id: overrides.id ?? overrides.transactionId,
    userId: "FT483921",
    sourceUserId: "FT999001",
    sourceUserName: "Uploader Creator",
    incomeType: "global_income",
    amount: 0.14,
    status: "settled",
    specialTag: "NORMAL_PREMIUM",
    description: "Global Pool share",
    createdAt: "2026-11-26T10:00:00.000Z",
    isStale: false,
    ...overrides,
  });

  it("extracts distinct rewardedVideoId and shared sourcePaymentId for legitimate per-video payouts from the same payment", () => {
    const txs = [
      makeGlobalTx({
        transactionId: "TX_GLB_pay_Rzp123_vid_1",
        videoId: "vid_1",
        description: "Global Pool 50% share (Normal Premium ₹3.00 / 21 videos) for video #vid_1",
      }),
      makeGlobalTx({
        transactionId: "TX_GLB_pay_Rzp123_vid_2",
        videoId: "vid_2",
        description: "Global Pool 50% share (Normal Premium ₹3.00 / 21 videos) for video #vid_2",
      }),
      makeGlobalTx({
        transactionId: "TX_GLB_pay_Rzp123_vid_3",
        videoId: "vid_3",
        description: "Global Pool 50% share (Normal Premium ₹3.00 / 21 videos) for video #vid_3",
      }),
    ];

    const metas = txs.map((tx) => extractGlobalIncomeEntryMeta(tx));
    assert.deepEqual(
      metas.map((m) => m.rewardedVideoId),
      ["vid_1", "vid_2", "vid_3"],
    );
    assert.deepEqual(
      metas.map((m) => m.sourcePaymentId),
      ["pay_Rzp123", "pay_Rzp123", "pay_Rzp123"],
    );

    // Fallback when videoId field is omitted but description has `for video #<id>`
    const fallbackMeta = extractGlobalIncomeEntryMeta(
      makeGlobalTx({
        transactionId: "TX_GLB_pay_live_999_vid_alpha_7",
        description: "Global Pool share for video #vid_alpha_7 (Premium Video #12)",
      }),
    );
    assert.equal(fallbackMeta.rewardedVideoId, "vid_alpha_7");
    assert.equal(fallbackMeta.sourcePaymentId, "pay_live_999");
    assert.equal(fallbackMeta.poolVideoNumber, "12");

    // Settlement batch & reserve formats
    const settleMeta = extractGlobalIncomeEntryMeta(
      makeGlobalTx({
        transactionId: "TX_GLB_SETTLE_batch_2026_01_vid_9",
        videoId: "vid_9",
      }),
    );
    assert.equal(settleMeta.rewardedVideoId, "vid_9");
    assert.equal(settleMeta.settlementBatchId, "batch_2026_01");

    const reserveMeta = extractGlobalIncomeEntryMeta(
      makeGlobalTx({
        transactionId: "TX_GLB_RESERVE_pay_Rzp777",
        status: "pending",
      }),
    );
    assert.equal(reserveMeta.sourcePaymentId, "pay_Rzp777");
  });

  it("preserves 3 legitimate per-video payouts while collapsing case-variant duplicates, stale rows, and non-global rows", () => {
    const ledger: LedgerTransaction[] = [
      makeGlobalTx({ transactionId: "TX_GLB_pay_Rzp123_vid_1", videoId: "vid_1" }),
      makeGlobalTx({ transactionId: "tx_glb_pay_rzp123_vid_1", videoId: "vid_1" }), // case-variant duplicate
      makeGlobalTx({ transactionId: "TX_GLB_pay_Rzp123_vid_2", videoId: "vid_2" }),
      makeGlobalTx({ transactionId: "TX_GLB_pay_Rzp123_vid_3", videoId: "vid_3" }),
      makeGlobalTx({ transactionId: "TX_GLB_pay_Stale_vid_4", videoId: "vid_4", isStale: true }),
      makeGlobalTx({
        transactionId: "TX_REF_pay_Rzp123",
        incomeType: "referral_income",
        amount: 1.0,
      }),
    ];

    const deduped = deduplicateGlobalIncomeTransactions(ledger);
    assert.equal(deduped.length, 3);
    assert.deepEqual(
      deduped.map((tx) => tx.videoId),
      ["vid_1", "vid_2", "vid_3"],
    );
    const total = deduped.reduce((sum, tx) => sum + tx.amount, 0);
    assert.ok(Math.abs(total - 0.42) < 1e-6);
  });

  it("verifies global-income.tsx distinguishes per-video rows & real statuses and transactions.php returns videoId + video_id", () => {
    const routePath = path.resolve(process.cwd(), "src", "routes", "global-income.tsx");
    const routeSrc = fs.readFileSync(routePath, "utf-8");

    assert.ok(routeSrc.includes("deduplicateGlobalIncomeTransactions"));
    assert.ok(routeSrc.includes("extractGlobalIncomeEntryMeta"));
    assert.ok(routeSrc.includes("Rewarded Video"));
    assert.ok(routeSrc.includes("renderGlobalTxStatus"));
    assert.ok(routeSrc.includes("Pending"));
    assert.ok(routeSrc.includes("Failed"));
    assert.ok(routeSrc.includes("whitespace-normal break-words"));
    assert.equal(routeSrc.includes("max-w-sm truncate"), false);

    const phpTxPath = path.resolve(process.cwd(), "api", "wallet", "transactions.php");
    const phpTxSrc = fs.readFileSync(phpTxPath, "utf-8");
    assert.ok(phpTxSrc.includes("'videoId' => $tx['video_id'] ?? null"));
    assert.ok(phpTxSrc.includes("'video_id' => $tx['video_id'] ?? null"));
  });
});

describe("Global Income & Withdrawal Identity Guard and Source Member Sanitization", () => {
  it("1. Enforces canonical resolveAuthenticatedUserId without FT483921 or email-prefix fallback in affected routes", () => {
    for (const relPath of [
      "src/routes/global-income.tsx",
      "src/routes/withdrawal-balance.tsx",
    ] as const) {
      const src = fs.readFileSync(path.resolve(process.cwd(), relPath), "utf-8");
      assert.equal(
        src.includes("FT483921"),
        false,
        `${relPath} must not contain hardcoded FT483921 fallback`,
      );
      assert.equal(
        src.includes('email?.split("@")[0]'),
        false,
        `${relPath} must not derive userId from email prefix`,
      );
      assert.ok(
        src.includes("resolveAuthenticatedUserId"),
        `${relPath} must use canonical resolveAuthenticatedUserId`,
      );
      assert.ok(src.includes("if (!userId)"), `${relPath} must guard against empty userId`);
    }

    const globalRouteSrc = fs.readFileSync(
      path.resolve(process.cwd(), "src/routes/global-income.tsx"),
      "utf-8",
    );
    assert.ok(
      globalRouteSrc.includes("resolveGlobalIncomeSourceMember(group)"),
      "global-income.tsx must render Source Member via resolveGlobalIncomeSourceMember",
    );

    assert.equal(
      resolveAuthenticatedUserId({
        user: { user_id: undefined, user_metadata: null } as any,
        profile: null,
        dbUser: null,
      }),
      "",
    );
    assert.equal(
      resolveAuthenticatedUserId({
        user: { user_id: "FT900431" },
        profile: null,
        dbUser: null,
      }),
      "FT900431",
    );
    assert.equal(
      resolveAuthenticatedUserId({
        user: null,
        profile: { user_id: "FT102857" },
        dbUser: { user_id: "FT900431" },
      }),
      "FT102857",
    );
  });

  it("2. Does not issue wallet or ledger API requests when authenticated user ID is unavailable, while preserving logged-in requests", async () => {
    const origGetBalance = api.wallet.getBalance;
    const origGetTransactions = api.wallet.getTransactions;
    const origGetGlobalSummary = api.wallet.getGlobalIncomeSummary;

    let balanceCalls = 0;
    let txCalls = 0;
    let summaryCalls = 0;

    try {
      api.wallet.getBalance = async (uid?: string) => {
        balanceCalls += 1;
        return {
          success: true,
          wallet: {
            user_id: uid,
            balance: 120,
            total_earned: 120,
            total_withdrawn: 0,
            referral_income: 0,
            global_income: 120,
            adsense_income: 0,
            affiliate_income: 0,
            updated_at: "2026-11-27T00:00:00.000Z",
          },
        };
      };
      api.wallet.getTransactions = async (uid?: string) => {
        txCalls += 1;
        return {
          success: true,
          transactions: [
            {
              id: "tx-logged-in-1",
              transaction_id: "TX_GLB_pay_123_vid_1",
              user_id: uid,
              source_user_id: "FT262457",
              source_user_name: "null",
              video_id: "vid_1",
              income_type: "global_income",
              amount: 0.14,
              status: "settled",
              description: "Global Pool share",
              created_at: "2026-11-27T00:00:00.000Z",
            },
          ],
          total: 1,
          hasMore: false,
        };
      };
      api.wallet.getGlobalIncomeSummary = async (uid?: string) => {
        summaryCalls += 1;
        return {
          success: true,
          personal: {
            userId: uid || "",
            hasWalletRow: true,
            totalIncome: 120,
            globalIncome: 120,
            balance: 120,
            totalWithdrawn: 0,
            walletTotalEarned: 120,
            walletGlobalIncome: 120,
            ledgerTotalEarned: 120,
            ledgerGlobalIncome: 120,
            walletVsLedgerDiff: 0,
            globalTxCount: 1,
            source: "wallet_balances" as const,
          },
          platform: {
            totalPremiumTransactions: 1,
            totalTransactionAmount: 6,
            referralAllocationTotal: 1,
            adminAllocationTotal: 1,
            gstTotal: 0.9,
            pgFeeTotal: 0.1,
            globalPoolAllocationTotal: 3,
            immediateGlobalPoolDistributedTotal: 3,
            settlementBatchCount: 0,
            settlementDistributedTotal: 0,
            globalPoolDistributedTotal: 3,
            pendingReserveCount: 0,
            pendingReserveTotal: 0,
            settledReserveCount: 0,
            settledReserveTotal: 0,
            cancelledReserveCount: 0,
            cancelledReserveTotal: 0,
            eligibleCreatorCount: 1,
            eligibleVideoCount: 1,
          },
        };
      };

      // Unavailable / empty / whitespace user IDs -> zero network calls
      const emptyWallet = await getUserWallet("");
      const blankWallet = await getUserWallet("   ");
      const emptyLedger = await getUserLedger("");
      const blankLedger = await getUserLedger("   ");
      const emptySummary = await getGlobalIncomeSummary("");
      const blankSummary = await getGlobalIncomeSummary("   ");
      const emptyDaily = await getDailyWithdrawnAmount("");

      assert.equal(balanceCalls, 0);
      assert.equal(txCalls, 0);
      assert.equal(summaryCalls, 0);
      assert.equal(emptyWallet.userId, "");
      assert.equal(blankWallet.userId, "");
      assert.deepEqual(emptyLedger, []);
      assert.deepEqual(blankLedger, []);
      assert.equal(emptySummary, null);
      assert.equal(blankSummary, null);
      assert.equal(emptyDaily, 0);

      // Valid logged-in user -> normal API calls proceed and sourceUserName is sanitized
      const liveWallet = await getUserWallet("FT900431");
      const liveLedger = await getUserLedger("FT900431");
      const liveSummary = await getGlobalIncomeSummary("FT900431");

      assert.equal(balanceCalls, 1);
      assert.equal(txCalls, 1);
      assert.equal(summaryCalls, 1);
      assert.equal(liveWallet.balance, 120);
      assert.equal(liveSummary?.personal.totalIncome, 120);
      assert.equal(liveLedger.length, 1);
      assert.equal(liveLedger[0]?.sourceUserName, undefined);
      assert.equal(resolveGlobalIncomeSourceMember(liveLedger[0]!), "FT262457");
    } finally {
      api.wallet.getBalance = origGetBalance;
      api.wallet.getTransactions = origGetTransactions;
      api.wallet.getGlobalIncomeSummary = origGetGlobalSummary;
    }
  });

  it("3. Sanitizes sourceUserName edge cases and resolves fallback order without altering ledger amounts, IDs, statuses, or deduplication", () => {
    const invalidInputs: unknown[] = [
      null,
      undefined,
      "",
      "   ",
      "\t\n",
      "null",
      "NULL",
      " null ",
      "undefined",
      "UNDEFINED",
      " undefined ",
    ];

    for (const raw of invalidInputs) {
      assert.equal(
        sanitizeLedgerMemberText(raw),
        undefined,
        `Expected ${JSON.stringify(raw)} to be treated as missing`,
      );
      assert.equal(
        resolveGlobalIncomeSourceMember({
          sourceUserName: raw as any,
          sourceUserId: "FT262457",
        }),
        "FT262457",
      );
      assert.equal(
        resolveGlobalIncomeSourceMember({
          sourceUserName: raw as any,
          sourceUserId: raw as any,
        }),
        "Global System",
      );
    }

    assert.equal(
      resolveGlobalIncomeSourceMember({
        sourceUserName: "  Maya Lin  ",
        sourceUserId: "FT900431",
      }),
      "Maya Lin",
    );

    const ledger: LedgerTransaction[] = [
      {
        id: "1",
        transactionId: "TX_GLB_pay_1_v1",
        userId: "FT900431",
        sourceUserId: "FT262457",
        sourceUserName: "null",
        videoId: "v1",
        incomeType: "global_income",
        amount: 0.14,
        status: "settled",
        description: "Share 1",
        createdAt: "2026-11-27T00:00:00.000Z",
      },
      {
        id: "2",
        transactionId: "TX_GLB_pay_1_v2",
        userId: "FT900431",
        sourceUserId: undefined,
        sourceUserName: "undefined",
        videoId: "v2",
        incomeType: "global_income",
        amount: 0.14,
        status: "pending",
        description: "Share 2",
        createdAt: "2026-11-27T00:00:01.000Z",
      },
    ];

    const deduped = deduplicateGlobalIncomeTransactions(ledger);
    assert.equal(deduped.length, 2);
    assert.equal(deduped[0]?.amount, 0.14);
    assert.equal(deduped[0]?.status, "settled");
    assert.equal(deduped[1]?.status, "pending");
    assert.equal(resolveGlobalIncomeSourceMember(deduped[0]!), "FT262457");
    assert.equal(resolveGlobalIncomeSourceMember(deduped[1]!), "Global System");
  });
});

describe("Global Income Payment-Level Display Grouping", () => {
  const makeEntry = (
    overrides: Partial<LedgerTransaction> & { transactionId: string },
  ): LedgerTransaction => ({
    id: overrides.id ?? overrides.transactionId,
    userId: "FT900431",
    sourceUserId: "FT262457",
    sourceUserName: "Creator Uploader",
    incomeType: "global_income",
    amount: 0.14,
    status: "settled",
    specialTag: "NORMAL_PREMIUM",
    description: "Global Pool 50% share",
    createdAt: "2026-11-27T10:00:00.000Z",
    isStale: false,
    ...overrides,
  });

  it("1. Combines three ₹0.14 entries from the same payment (pay_U59VcCCe2vabiR) into one ₹0.42 row with 3 video allocations", () => {
    const ledger: LedgerTransaction[] = [
      makeEntry({
        id: "row-1",
        transactionId: "TX_GLB_pay_U59VcCCe2vabiR_vid_101",
        videoId: "vid_101",
        description: "Global Pool share for video #vid_101",
      }),
      makeEntry({
        id: "row-2",
        transactionId: "TX_GLB_pay_U59VcCCe2vabiR_vid_102",
        videoId: "vid_102",
        description: "Global Pool share for video #vid_102",
      }),
      makeEntry({
        id: "row-3",
        transactionId: "TX_GLB_pay_U59VcCCe2vabiR_vid_103",
        videoId: "vid_103",
        description: "Global Pool share for video #vid_103",
      }),
    ];

    const grouped = groupGlobalIncomeTransactions(ledger);
    assert.equal(grouped.length, 1);
    const row = grouped[0]!;
    assert.equal(row.sourcePaymentId, "pay_U59VcCCe2vabiR");
    assert.equal(row.groupKey, "PAYMENT:PAY_U59VCCCE2VABIR");
    assert.equal(row.amount, 0.42);
    assert.equal(row.videoAllocationCount, 3);
    assert.equal(row.entryCount, 3);
    assert.deepEqual(row.videoIds, ["vid_101", "vid_102", "vid_103"]);
    assert.equal(row.status, "settled");
    assert.equal(resolveGlobalIncomeSourceMember(row), "Creator Uploader");
  });

  it("2. Keeps different payment IDs separate even when source user, timestamp, amount, and status are identical", () => {
    const sameTimestamp = "2026-11-27T11:15:00.000Z";
    const ledger: LedgerTransaction[] = [
      makeEntry({
        transactionId: "TX_GLB_pay_AAA111_vid_1",
        videoId: "vid_1",
        sourceUserId: "FT262457",
        sourceUserName: "Same Uploader",
        createdAt: sameTimestamp,
        amount: 0.14,
        status: "settled",
      }),
      makeEntry({
        transactionId: "TX_GLB_pay_AAA111_vid_2",
        videoId: "vid_2",
        sourceUserId: "FT262457",
        sourceUserName: "Same Uploader",
        createdAt: sameTimestamp,
        amount: 0.14,
        status: "settled",
      }),
      makeEntry({
        transactionId: "TX_GLB_pay_BBB222_vid_1",
        videoId: "vid_1",
        sourceUserId: "FT262457",
        sourceUserName: "Same Uploader",
        createdAt: sameTimestamp,
        amount: 0.14,
        status: "settled",
      }),
      makeEntry({
        transactionId: "TX_GLB_84729103",
        videoId: undefined,
        sourceUserId: "FT262457",
        sourceUserName: "Same Uploader",
        createdAt: sameTimestamp,
        amount: 0.14,
        status: "settled",
      }),
      makeEntry({
        transactionId: "TX_GLB_RESERVE_pay_CCC333",
        videoId: undefined,
        sourceUserId: "FT262457",
        sourceUserName: "Same Uploader",
        createdAt: sameTimestamp,
        amount: 3.0,
        status: "pending",
      }),
    ];

    const grouped = groupGlobalIncomeTransactions(ledger);
    assert.equal(grouped.length, 4);
    assert.equal(grouped[0]?.sourcePaymentId, "pay_AAA111");
    assert.equal(grouped[0]?.amount, 0.28);
    assert.equal(grouped[0]?.videoAllocationCount, 2);
    assert.equal(grouped[1]?.sourcePaymentId, "pay_BBB222");
    assert.equal(grouped[1]?.amount, 0.14);
    assert.equal(grouped[1]?.videoAllocationCount, 1);
    assert.equal(grouped[2]?.displayTransactionId, "TX_GLB_84729103");
    assert.equal(grouped[3]?.displayTransactionId, "TX_GLB_RESERVE_pay_CCC333");
    assert.equal(grouped[3]?.status, "pending");

    assert.notEqual(
      getGlobalIncomePaymentGroupKey(ledger[0]!).groupKey,
      getGlobalIncomePaymentGroupKey(ledger[2]!).groupKey,
    );
  });

  it("3. Handles mixed statuses safely and never labels a group Settled unless all entries are settled", () => {
    const settledPlusPending = groupGlobalIncomeTransactions([
      makeEntry({ transactionId: "TX_GLB_pay_MIX1_v1", videoId: "v1", status: "settled" }),
      makeEntry({ transactionId: "TX_GLB_pay_MIX1_v2", videoId: "v2", status: "pending" }),
    ]);
    assert.equal(settledPlusPending[0]?.status, "mixed");
    assert.deepEqual(settledPlusPending[0]?.statusCounts, { settled: 1, pending: 1, failed: 0 });

    const settledPlusFailed = groupGlobalIncomeTransactions([
      makeEntry({ transactionId: "TX_GLB_pay_MIX2_v1", videoId: "v1", status: "settled" }),
      makeEntry({ transactionId: "TX_GLB_pay_MIX2_v2", videoId: "v2", status: "failed" }),
    ]);
    assert.equal(settledPlusFailed[0]?.status, "mixed");

    const allPending = resolveGroupedGlobalIncomeStatus([
      { status: "pending" },
      { status: "pending" },
    ]);
    assert.equal(allPending.status, "pending");

    const allFailed = resolveGroupedGlobalIncomeStatus([
      { status: "failed" },
      { status: "failed" },
    ]);
    assert.equal(allFailed.status, "failed");

    const allSettled = resolveGroupedGlobalIncomeStatus([
      { status: "settled" },
      { status: "settled" },
    ]);
    assert.equal(allSettled.status, "settled");
  });

  it("4. Preserves original ledger records and wallet calculations, and paginates grouped payments without splitting or omitting entries", () => {
    const originalLedger: LedgerTransaction[] = [
      makeEntry({
        id: "a1",
        transactionId: "TX_GLB_pay_P1_v1",
        videoId: "v1",
        amount: 0.14,
        status: "settled",
      }),
      makeEntry({
        id: "a2",
        transactionId: "TX_GLB_pay_P1_v2",
        videoId: "v2",
        amount: 0.14,
        status: "settled",
      }),
      makeEntry({
        id: "a3",
        transactionId: "TX_GLB_pay_P1_v3",
        videoId: "v3",
        amount: 0.14,
        status: "settled",
      }),
      makeEntry({
        id: "b1",
        transactionId: "TX_GLB_pay_P2_v1",
        videoId: "v1",
        amount: 0.25,
        status: "settled",
      }),
      makeEntry({
        id: "b2",
        transactionId: "TX_GLB_pay_P2_v2",
        videoId: "v2",
        amount: 0.25,
        status: "settled",
      }),
      makeEntry({
        id: "c1",
        transactionId: "TX_GLB_pay_P3_v1",
        videoId: "v1",
        amount: 0.5,
        status: "settled",
      }),
    ];
    const snapshot = JSON.stringify(originalLedger);

    const grouped = groupGlobalIncomeTransactions(originalLedger);
    assert.equal(grouped.length, 3);
    assert.equal(
      JSON.stringify(originalLedger),
      snapshot,
      "Original ledger must remain unmodified",
    );

    // Sum across groups equals sum across original ledger and calculateTotalAdEarnings
    const groupedSum = grouped.reduce((acc, g) => acc + Math.round(g.amount * 100), 0) / 100;
    const earnings = calculateTotalAdEarnings(null, originalLedger);
    assert.equal(groupedSum, 1.42);
    assert.equal(earnings.globalIncome, 1.42);
    assert.equal(earnings.totalAdEarnings, 1.42);

    // Paginating grouped rows by 2 payments per page keeps pay_P1 (3 allocations) intact on page 1
    // and pay_P3 on page 2 without splitting or omitting any payment or allocation.
    const page1 = paginateGroupedGlobalIncomeEntries(grouped, 1, 2);
    const page2 = paginateGroupedGlobalIncomeEntries(grouped, 2, 2);
    assert.equal(page1.totalPages, 2);
    assert.equal(page1.totalGroups, 3);
    assert.equal(page1.items.length, 2);
    assert.equal(page1.items[0]?.sourcePaymentId, "pay_P1");
    assert.equal(page1.items[0]?.entryCount, 3);
    assert.equal(page1.items[1]?.sourcePaymentId, "pay_P2");
    assert.equal(page1.items[1]?.entryCount, 2);
    assert.equal(page2.items.length, 1);
    assert.equal(page2.items[0]?.sourcePaymentId, "pay_P3");
    assert.equal(page2.items[0]?.entryCount, 1);

    const routeSrc = fs.readFileSync(
      path.resolve(process.cwd(), "src", "routes", "global-income.tsx"),
      "utf-8",
    );
    assert.ok(routeSrc.includes("groupGlobalIncomeTransactions"));
    assert.ok(routeSrc.includes("paginateGroupedGlobalIncomeEntries"));
    assert.ok(routeSrc.includes("video allocations"));
    assert.ok(routeSrc.includes("Mixed"));
  });
});
