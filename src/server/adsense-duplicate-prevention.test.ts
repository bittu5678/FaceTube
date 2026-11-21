import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  handleApiRequest,
  parseValidatedCurrencyAmount,
  resetInMemoryStore,
} from "./api-handler.ts";
import { setMysqlPoolForTesting } from "./mysql.ts";

describe("AdSense Monthly Statement Idempotency & Duplicate Prevention Tests", () => {
  let adminToken = "";
  let userToken = "";
  let initialWalletsSnapshot = "";
  let initialTxsSnapshot = "";

  before(async () => {
    // 0. Clean up any previous test statement keys and snapshot store state
    const storePath = path.resolve(process.cwd(), "data/facetube_store.json");
    if (fs.existsSync(storePath)) {
      try {
        const store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
        if (store.adsenseStatements) {
          delete store.adsenseStatements["FT483921_2026-07"];
          delete store.adsenseStatements["FT900431_2026-06"];
          delete store.adsenseStatements["FT483921_2026-05"];
          delete store.adsenseStatements["FT900431_2026-05"];
        }
        if (Array.isArray(store.walletTransactions)) {
          store.walletTransactions = store.walletTransactions.filter(
            (tx: any) =>
              !String(tx["transaction_id"] || tx["transactionId"] || "").startsWith(
                "TX_ADSENSE_FT483921_202607",
              ) &&
              !String(tx["transaction_id"] || tx["transactionId"] || "").startsWith(
                "TX_ADSENSE_FT900431_202606",
              ) &&
              !String(tx["transaction_id"] || tx["transactionId"] || "").startsWith(
                "TX_ADSENSE_FT483921_202605",
              ) &&
              !String(tx["transaction_id"] || tx["transactionId"] || "").startsWith(
                "TX_ADSENSE_FT900431_202605",
              ),
          );
        }
        initialWalletsSnapshot = JSON.stringify(store.wallets || {});
        initialTxsSnapshot = JSON.stringify(store.walletTransactions || []);
        fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
      } catch (_e) {
        // Ignore errors during test file setup
      }
    }

    // 1. Authenticate as Admin (FT102857 / admin@facetube.com)
    const adminLoginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "admin@facetube.com", password: "password123" }),
    });
    const adminLoginRes = await handleApiRequest(adminLoginReq);
    assert.ok(adminLoginRes, "Admin login request must return a response");
    const adminData = await adminLoginRes.json();
    assert.ok(adminData.token, "Admin login must return a session token");
    adminToken = adminData.token;

    // 2. Authenticate as Standard User (FT483921 / alex@facetube.com)
    const userLoginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
    });
    const userLoginRes = await handleApiRequest(userLoginReq);
    assert.ok(userLoginRes, "User login request must return a response");
    const userData = await userLoginRes.json();
    assert.ok(userData.token, "User login must return a session token");
    userToken = userData.token;
  });

  after(() => {
    const storePath = path.resolve(process.cwd(), "data/facetube_store.json");
    if (fs.existsSync(storePath)) {
      try {
        const store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
        if (initialWalletsSnapshot) {
          store.wallets = JSON.parse(initialWalletsSnapshot);
        }
        if (initialTxsSnapshot) {
          store.walletTransactions = JSON.parse(initialTxsSnapshot);
        }
        if (store.adsenseStatements) {
          delete store.adsenseStatements["FT483921_2026-07"];
          delete store.adsenseStatements["FT900431_2026-06"];
          delete store.adsenseStatements["FT483921_2026-05"];
          delete store.adsenseStatements["FT900431_2026-05"];
        }
        fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
      } catch (_e) {
        // Ignore errors during test file teardown
      }
    }
  });

  describe("1. Authentication & RBAC Authorization", () => {
    it("rejects unauthenticated requests with HTTP 401", async () => {
      const req = new Request("http://localhost:3000/api/admin/record-adsense-earning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: "FT483921",
          amount: 500,
          reportMonth: "2026-08",
        }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /authentication required/i);
    });

    it("rejects non-admin users with HTTP 403", async () => {
      const req = new Request("http://localhost:3000/api/admin/record-adsense-earning", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          userId: "FT483921",
          amount: 500,
          reportMonth: "2026-08",
        }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /admin authorization required/i);
    });
  });

  describe("2. Parameter Validation", () => {
    it("rejects missing target user with HTTP 400", async () => {
      const req = new Request("http://localhost:3000/api/admin/record-adsense-earning", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          amount: 500,
          reportMonth: "2026-08",
        }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /user_id is required/i);
    });

    it("rejects negative or zero amount with HTTP 400", async () => {
      const req = new Request("http://localhost:3000/api/admin/record-adsense-earning", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          userId: "FT483921",
          amount: 0,
          reportMonth: "2026-08",
        }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /strictly greater than 0/i);
    });

    it("rejects invalid reportMonth format with HTTP 400", async () => {
      const req = new Request("http://localhost:3000/api/admin/record-adsense-earning", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          userId: "FT483921",
          amount: 500,
          reportMonth: "invalid-month",
        }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /invalid reportMonth format/i);
    });
  });

  describe("3. Initial Statement Credit & Atomic Wallet Update", () => {
    it("successfully records valid monthly statement and credits wallet", async () => {
      // Check initial wallet balance
      const initialWalletReq = new Request(
        "http://localhost:3000/api/wallet/balance?userId=FT483921",
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        },
      );
      const initialWalletRes = await handleApiRequest(initialWalletReq);
      const initialWalletData = await initialWalletRes?.json();
      const initialBalance = Number(initialWalletData?.wallet?.balance || 0);
      const initialAdsense = Number(initialWalletData?.wallet?.adsense_income || 0);

      const recordReq = new Request("http://localhost:3000/api/admin/record-adsense-earning", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          userId: "FT483921",
          amount: 1500,
          reportMonth: "2026-07",
        }),
      });
      const recordRes = await handleApiRequest(recordReq);
      assert.ok(recordRes);
      assert.equal(recordRes.status, 200);
      const recordData = await recordRes.json();
      assert.equal(recordData.success, true);
      assert.equal(recordData.amount, 1500);
      assert.equal(recordData.reportMonth, "2026-07");
      assert.ok(recordData.transactionId.startsWith("TX_ADSENSE_FT483921_202607"));

      // Check updated wallet balance
      const updatedWalletReq = new Request(
        "http://localhost:3000/api/wallet/balance?userId=FT483921",
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        },
      );
      const updatedWalletRes = await handleApiRequest(updatedWalletReq);
      const updatedWalletData = await updatedWalletRes?.json();
      assert.equal(
        Number(updatedWalletData?.wallet?.balance || 0),
        initialBalance + 1500,
        "Wallet balance must be credited exactly ₹1,500",
      );
      assert.equal(
        Number(updatedWalletData?.wallet?.adsense_income || 0),
        initialAdsense + 1500,
        "AdSense income metric must be incremented by ₹1,500",
      );
    });
  });

  describe("4. Sequential Duplicate Statement Rejection", () => {
    it("rejects duplicate submission for the same creator and month without altering balance", async () => {
      // Capture wallet balance before duplicate attempt
      const preWalletReq = new Request("http://localhost:3000/api/wallet/balance?userId=FT483921", {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const preWalletRes = await handleApiRequest(preWalletReq);
      const preWalletData = await preWalletRes?.json();
      const balanceBefore = Number(preWalletData?.wallet?.balance || 0);

      // Attempt duplicate submission for 2026-07
      const duplicateReq = new Request("http://localhost:3000/api/admin/record-adsense-earning", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          userId: "FT483921",
          amount: 1500,
          reportMonth: "2026-07",
        }),
      });
      const duplicateRes = await handleApiRequest(duplicateReq);
      assert.ok(duplicateRes);
      assert.equal(
        duplicateRes.status,
        409,
        "Must return HTTP 409 Conflict on duplicate submission",
      );
      const duplicateData = await duplicateRes.json();
      assert.equal(duplicateData.success, false);
      assert.match(duplicateData.error, /already been credited and settled/i);

      // Verify wallet balance remained completely unchanged
      const postWalletReq = new Request(
        "http://localhost:3000/api/wallet/balance?userId=FT483921",
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        },
      );
      const postWalletRes = await handleApiRequest(postWalletReq);
      const postWalletData = await postWalletRes?.json();
      const balanceAfter = Number(postWalletData?.wallet?.balance || 0);
      assert.equal(
        balanceAfter,
        balanceBefore,
        "Wallet balance must NOT be credited again on duplicate",
      );
    });
  });

  describe("5. Concurrent Duplicate Submission Resilience", () => {
    it("handles simultaneous duplicate requests such that exactly ONE succeeds and all others fail with 409", async () => {
      const month = "2026-06";
      const targetUser = "FT900431"; // Maya Lin

      const preWalletReq = new Request(
        `http://localhost:3000/api/wallet/balance?userId=${targetUser}`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        },
      );
      const preWalletRes = await handleApiRequest(preWalletReq);
      const preWalletData = await preWalletRes?.json();
      const balanceBefore = Number(preWalletData?.wallet?.balance || 0);

      // Fire 5 concurrent requests simultaneously
      const concurrentRequests = Array.from({ length: 5 }, () =>
        handleApiRequest(
          new Request("http://localhost:3000/api/admin/record-adsense-earning", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
              userId: targetUser,
              amount: 2500,
              reportMonth: month,
            }),
          }),
        ),
      );

      const responses = await Promise.all(concurrentRequests);
      const statuses = responses.map((r) => r?.status);
      const successCount = statuses.filter((s) => s === 200).length;
      const conflictCount = statuses.filter((s) => s === 409).length;

      assert.equal(successCount, 1, "Exactly one concurrent request must succeed with HTTP 200");
      assert.equal(
        conflictCount,
        4,
        "Remaining 4 concurrent requests must fail with HTTP 409 Conflict",
      );

      // Verify wallet was credited exactly once
      const postWalletReq = new Request(
        `http://localhost:3000/api/wallet/balance?userId=${targetUser}`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        },
      );
      const postWalletRes = await handleApiRequest(postWalletReq);
      const postWalletData = await postWalletRes?.json();
      const balanceAfter = Number(postWalletData?.wallet?.balance || 0);

      assert.equal(
        balanceAfter,
        balanceBefore + 2500,
        "Wallet balance must increase by exactly one payout amount (₹2,500), not multiplied",
      );
    });
  });

  describe("6. Multi-Month & Multi-Creator Independence", () => {
    it("allows statements for different months for the same creator", async () => {
      const req = new Request("http://localhost:3000/api/admin/record-adsense-earning", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          userId: "FT483921",
          amount: 800,
          reportMonth: "2026-05",
        }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.reportMonth, "2026-05");
    });

    it("allows statements for the same month for different creators", async () => {
      const req = new Request("http://localhost:3000/api/admin/record-adsense-earning", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          userId: "FT900431",
          amount: 950,
          reportMonth: "2026-05",
        }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.userId, "FT900431");
      assert.equal(data.reportMonth, "2026-05");
    });
  });

  describe("7. Historical Conflict Isolation & Administrative Reporting", () => {
    it("allows administrators to query statements and historical conflicts via GET", async () => {
      const stmtReq = new Request(
        "http://localhost:3000/api/admin/record-adsense-earning?action=statements",
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        },
      );
      const stmtRes = await handleApiRequest(stmtReq);
      assert.ok(stmtRes);
      assert.equal(stmtRes.status, 200);
      const stmtData = await stmtRes.json();
      assert.equal(stmtData.success, true);
      assert.ok(Array.isArray(stmtData.statements));

      const conflictReq = new Request(
        "http://localhost:3000/api/admin/record-adsense-earning?action=conflicts",
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        },
      );
      const conflictRes = await handleApiRequest(conflictReq);
      assert.ok(conflictRes);
      assert.equal(conflictRes.status, 200);
      const conflictData = await conflictRes.json();
      assert.equal(conflictData.success, true);
      assert.ok(Array.isArray(conflictData.conflicts));
    });

    it("blocks new statement recording when a creator/month has historical records flagged for review", async () => {
      // Simulate flagged historical conflict for FT483921 in 2026-03
      const storePath = path.resolve(process.cwd(), "data/facetube_store.json");
      const store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
      if (!store.adsenseHistoricalConflicts) {
        store.adsenseHistoricalConflicts = {};
      }
      store.adsenseHistoricalConflicts["FT483921_2026-03"] = {
        id: "conf-test-01",
        transactionId: "TX_ADSENSE_HIST_CONFLICT_01",
        userId: "FT483921",
        reportMonth: "2026-03",
        amount: 300,
        status: "flagged_for_review",
      };
      fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");

      const req = new Request("http://localhost:3000/api/admin/record-adsense-earning", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          userId: "FT483921",
          amount: 500,
          reportMonth: "2026-03",
        }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 409);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /flagged for manual review/i);

      // Clean up test conflict
      delete store.adsenseHistoricalConflicts["FT483921_2026-03"];
      fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
    });
  });

  describe("8. MySQL Transaction Safety & Error Handling Regression Tests", () => {
    function createAdsenseMockPool(options: {
      onStatementsSelect?: (() => any) | undefined;
      onConflictsSelect?: (() => any) | undefined;
      onIncomeLedgerSelect?: (() => any) | undefined;
      onStatementsInsert?: (() => any) | undefined;
      onRollback?: (() => Promise<void>) | undefined;
    }) {
      let committed = false;
      let rolledBack = false;
      let released = false;
      let incomeLedgerInserts = 0;
      let walletUpdates = 0;

      const queryHandler = async (sql: string) => {
        if (sql.includes("FROM sessions s") && sql.includes("JOIN users u")) {
          return [
            [
              {
                id: "a0000000-0000-0000-0000-000000000001",
                user_id: "FT102857",
                name: "FaceTube Administrator",
                email: "admin@facetube.com",
                role: "admin",
                referral_code: "FTVIP",
              },
            ],
          ];
        }
        if (sql.includes("FROM users WHERE UPPER(user_id)")) {
          return [
            [
              {
                id: "a0000000-0000-0000-0000-000000000002",
                user_id: "FT483921",
                name: "Alex Rivera",
              },
            ],
          ];
        }
        if (sql.includes("FROM adsense_monthly_statements") && sql.includes("FOR UPDATE")) {
          if (options.onStatementsSelect) return options.onStatementsSelect();
          return [[]];
        }
        if (sql.includes("FROM adsense_historical_conflicts")) {
          if (options.onConflictsSelect) return options.onConflictsSelect();
          return [[]];
        }
        if (sql.includes("FROM income_ledger") && sql.includes("FOR UPDATE")) {
          if (options.onIncomeLedgerSelect) return options.onIncomeLedgerSelect();
          return [[]];
        }
        if (sql.startsWith("INSERT INTO adsense_monthly_statements")) {
          if (options.onStatementsInsert) return options.onStatementsInsert();
          return [{ affectedRows: 1 }];
        }
        if (sql.startsWith("INSERT INTO income_ledger")) {
          incomeLedgerInserts += 1;
          return [{ affectedRows: 1 }];
        }
        if (sql.startsWith("INSERT INTO wallet_balances")) {
          walletUpdates += 1;
          return [{ affectedRows: 1 }];
        }
        return [[]];
      };

      const pool = {
        query: queryHandler,
        getConnection: async () => ({
          beginTransaction: async () => {
            committed = false;
            rolledBack = false;
            released = false;
          },
          query: queryHandler,
          commit: async () => {
            committed = true;
          },
          rollback: async () => {
            rolledBack = true;
            if (options.onRollback) {
              await options.onRollback();
            }
          },
          release: () => {
            released = true;
          },
        }),
      };

      return {
        pool,
        getState: () => ({
          committed,
          rolledBack,
          released,
          incomeLedgerInserts,
          walletUpdates,
        }),
      };
    }

    async function withMysqlMockEnv<T>(mockPool: any, fn: () => Promise<T>): Promise<T> {
      const origHost = process.env["DB_HOST"];
      const origName = process.env["DB_NAME"];
      const origUser = process.env["DB_USER"];
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";
      setMysqlPoolForTesting(mockPool);
      try {
        return await fn();
      } finally {
        setMysqlPoolForTesting(null);
        if (origHost !== undefined) process.env["DB_HOST"] = origHost;
        else delete process.env["DB_HOST"];
        if (origName !== undefined) process.env["DB_NAME"] = origName;
        else delete process.env["DB_NAME"];
        if (origUser !== undefined) process.env["DB_USER"] = origUser;
        else delete process.env["DB_USER"];
      }
    }

    it("preserves compatibility when optional tables are missing (ER_NO_SUCH_TABLE / 1146 / 42S02)", async () => {
      const mock = createAdsenseMockPool({
        onStatementsSelect: () => {
          const err: any = new Error(
            "Table 'facetube_test.adsense_monthly_statements' doesn't exist",
          );
          err.code = "ER_NO_SUCH_TABLE";
          err.errno = 1146;
          throw err;
        },
        onConflictsSelect: () => {
          const err: any = new Error(
            "Table 'facetube_test.adsense_historical_conflicts' doesn't exist",
          );
          err.sqlState = "42S02";
          throw err;
        },
        onStatementsInsert: () => {
          const err: any = new Error(
            "Table 'facetube_test.adsense_monthly_statements' doesn't exist",
          );
          err.errno = 1146;
          throw err;
        },
      });

      await withMysqlMockEnv(mock.pool, async () => {
        const res = await handleApiRequest(
          new Request("http://localhost:3000/api/admin/record-adsense-earning", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
              userId: "FT483921",
              amount: 1200,
              reportMonth: "2026-09",
            }),
          }),
          { APP_ENV: "production", NODE_ENV: "production" },
        );
        assert.ok(res);
        assert.equal(res.status, 200);
        const body = (await res.json()) as any;
        assert.equal(body.success, true);
        assert.equal(body.transactionId, "TX_ADSENSE_FT483921_202609");

        const state = mock.getState();
        assert.equal(state.committed, true);
        assert.equal(state.rolledBack, false);
        assert.equal(state.released, true);
        assert.equal(state.incomeLedgerInserts, 1);
        assert.equal(state.walletUpdates, 1);
      });
    });

    it("fails with HTTP 409, rolls back, and skips ledger/wallet credits on ER_DUP_ENTRY (1062) in statement INSERT", async () => {
      const mock = createAdsenseMockPool({
        onStatementsInsert: () => {
          const err: any = new Error(
            "Duplicate entry 'FT483921-2026-09' for key 'uniq_adsense_user_month'",
          );
          err.code = "ER_DUP_ENTRY";
          err.errno = 1062;
          err.sqlState = "23000";
          throw err;
        },
      });

      await withMysqlMockEnv(mock.pool, async () => {
        const res = await handleApiRequest(
          new Request("http://localhost:3000/api/admin/record-adsense-earning", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
              userId: "FT483921",
              amount: 1200,
              reportMonth: "2026-09",
            }),
          }),
          { APP_ENV: "production", NODE_ENV: "production" },
        );
        assert.ok(res);
        assert.equal(res.status, 409);
        const body = (await res.json()) as any;
        assert.equal(body.success, false);
        assert.match(body.error, /already been credited/i);

        const state = mock.getState();
        assert.equal(state.rolledBack, true);
        assert.equal(state.committed, false);
        assert.equal(state.released, true);
        assert.equal(state.incomeLedgerInserts, 0);
        assert.equal(state.walletUpdates, 0);
      });
    });

    it("rolls back and never credits ledger or wallet on deadlock, lock timeout, or connection failures across statement operations", async () => {
      const dbErrors = [
        {
          label: "deadlock (1213)",
          code: "ER_LOCK_DEADLOCK",
          errno: 1213,
          message: "Deadlock found when trying to get lock",
        },
        {
          label: "lock timeout (1205)",
          code: "ER_LOCK_WAIT_TIMEOUT",
          errno: 1205,
          message: "Lock wait timeout exceeded",
        },
        {
          label: "connection lost",
          code: "PROTOCOL_CONNECTION_LOST",
          errno: 2013,
          message: "Connection lost: The server closed the connection.",
        },
      ];

      for (const stage of ["statements_select", "conflicts_select", "statements_insert"] as const) {
        for (const errSpec of dbErrors) {
          const throwSpecErr = () => {
            const err: any = new Error(errSpec.message);
            err.code = errSpec.code;
            err.errno = errSpec.errno;
            throw err;
          };

          const mock = createAdsenseMockPool({
            onStatementsSelect: stage === "statements_select" ? throwSpecErr : undefined,
            onConflictsSelect: stage === "conflicts_select" ? throwSpecErr : undefined,
            onStatementsInsert: stage === "statements_insert" ? throwSpecErr : undefined,
            onRollback:
              errSpec.code === "PROTOCOL_CONNECTION_LOST"
                ? async () => {
                    throw new Error("Cannot rollback on closed connection");
                  }
                : undefined,
          });

          await withMysqlMockEnv(mock.pool, async () => {
            const res = await handleApiRequest(
              new Request("http://localhost:3000/api/admin/record-adsense-earning", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${adminToken}`,
                },
                body: JSON.stringify({
                  userId: "FT483921",
                  amount: 1200,
                  reportMonth: "2026-09",
                }),
              }),
              { APP_ENV: "production", NODE_ENV: "production" },
            );
            assert.ok(res, `${stage}/${errSpec.label} must return a response`);
            assert.equal(res.status, 500, `${stage}/${errSpec.label} must return HTTP 500`);
            const body = (await res.json()) as any;
            assert.equal(body.success, false);

            const state = mock.getState();
            assert.equal(state.rolledBack, true, `${stage}/${errSpec.label} must attempt rollback`);
            assert.equal(state.committed, false, `${stage}/${errSpec.label} must never commit`);
            assert.equal(state.released, true, `${stage}/${errSpec.label} must release connection`);
            assert.equal(
              state.incomeLedgerInserts,
              0,
              `${stage}/${errSpec.label} must not insert income_ledger`,
            );
            assert.equal(
              state.walletUpdates,
              0,
              `${stage}/${errSpec.label} must not update wallet_balances`,
            );
          });
        }
      }
    });
  });

  describe("9. Production Fail-Closed Guards (No MySQL Pool / Zero Local Store Writes)", () => {
    const envKeys = [
      "NODE_ENV",
      "APP_ENV",
      "DB_HOST",
      "DB_PORT",
      "DB_NAME",
      "DB_USER",
      "DB_PASSWORD",
      "MYSQL_HOST",
      "MYSQL_PORT",
      "MYSQL_DATABASE",
      "MYSQL_USER",
      "MYSQL_PASSWORD",
    ] as const;
    const storePath = path.resolve(process.cwd(), "data/facetube_store.json");
    let envSnapshot: Record<string, string | undefined> = {};
    let storeExisted = false;
    let storeSnapshot: string | null = null;

    function installStoreFsSpy() {
      const origExistsSync = fs.existsSync;
      const origStatSync = fs.statSync;
      const origReadFileSync = fs.readFileSync;
      const origWriteFileSync = fs.writeFileSync;

      const ops = {
        existsChecks: 0,
        statChecks: 0,
        reads: 0,
        writes: 0,
      };

      const isTargetStore = (p: fs.PathOrFileDescriptor | fs.PathLike): boolean => {
        if (typeof p !== "string" && !(p instanceof URL)) return false;
        const resolved = p instanceof URL ? p.pathname : path.resolve(p);
        return resolved === storePath;
      };

      fs.existsSync = ((p: fs.PathLike) => {
        if (isTargetStore(p)) ops.existsChecks += 1;
        return origExistsSync(p);
      }) as typeof fs.existsSync;

      (fs as any).statSync = ((p: fs.PathLike, options?: any) => {
        if (isTargetStore(p)) ops.statChecks += 1;
        return origStatSync(p, options);
      }) as typeof fs.statSync;

      fs.readFileSync = ((p: fs.PathOrFileDescriptor, options?: any) => {
        if (isTargetStore(p)) ops.reads += 1;
        return origReadFileSync(p, options);
      }) as typeof fs.readFileSync;

      fs.writeFileSync = ((p: fs.PathOrFileDescriptor, data: any, options?: any) => {
        if (isTargetStore(p)) ops.writes += 1;
        return origWriteFileSync(p, data, options);
      }) as typeof fs.writeFileSync;

      return {
        ops,
        restore: () => {
          fs.existsSync = origExistsSync;
          (fs as any).statSync = origStatSync;
          fs.readFileSync = origReadFileSync;
          fs.writeFileSync = origWriteFileSync;
        },
      };
    }

    beforeEach(() => {
      envSnapshot = {};
      for (const k of envKeys) {
        envSnapshot[k] = process.env[k];
      }
      storeExisted = fs.existsSync(storePath);
      storeSnapshot = storeExisted ? fs.readFileSync(storePath, "utf-8") : null;
      resetInMemoryStore();
      setMysqlPoolForTesting(null);
      for (const k of envKeys) {
        if (k !== "NODE_ENV" && k !== "APP_ENV") {
          delete process.env[k];
        }
      }
    });

    afterEach(() => {
      setMysqlPoolForTesting(null);
      resetInMemoryStore();
      for (const k of envKeys) {
        if (envSnapshot[k] === undefined) delete process.env[k];
        else process.env[k] = envSnapshot[k];
      }
      if (storeExisted && storeSnapshot !== null) {
        const dir = path.dirname(storePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(storePath, storeSnapshot, "utf-8");
      } else if (!storeExisted && fs.existsSync(storePath)) {
        fs.unlinkSync(storePath);
      }
    });

    it("returns HTTP 503 and performs zero local-store reads or writes across all production/fail-closed env matrices", async () => {
      const cases: Array<{
        label: string;
        procApp?: string | undefined;
        procNode?: string | undefined;
        handlerEnv?: Record<string, string | undefined> | undefined;
        withBearer?: boolean | undefined;
      }> = [
        {
          label: "APP_ENV=production overrides NODE_ENV=development",
          procApp: "production",
          procNode: "development",
          withBearer: true,
        },
        {
          label: "NODE_ENV=production without APP_ENV",
          procApp: undefined,
          procNode: "production",
          withBearer: false,
        },
        {
          label: "NODE_ENV=production with Bearer token",
          procApp: undefined,
          procNode: "production",
          withBearer: true,
        },
        {
          label: "Both APP_ENV and NODE_ENV unset fail closed as production",
          procApp: undefined,
          procNode: undefined,
          withBearer: true,
        },
        {
          label: "Unexpected APP_ENV=staging fails closed even with NODE_ENV=development",
          procApp: "staging",
          procNode: "development",
          withBearer: true,
        },
        {
          label: "Unexpected NODE_ENV=preview fails closed even with APP_ENV=test",
          procApp: "test",
          procNode: "preview",
          withBearer: true,
        },
        {
          label: "Runtime handler env APP_ENV=production overrides development process.env",
          procApp: "development",
          procNode: "development",
          handlerEnv: { APP_ENV: "production", NODE_ENV: "development" },
          withBearer: true,
        },
      ];

      const spy = installStoreFsSpy();
      try {
        for (const tc of cases) {
          if (tc.procApp === undefined) delete process.env["APP_ENV"];
          else process.env["APP_ENV"] = tc.procApp;

          if (tc.procNode === undefined) delete process.env["NODE_ENV"];
          else process.env["NODE_ENV"] = tc.procNode;

          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (tc.withBearer) {
            headers["Authorization"] = `Bearer ${adminToken}`;
          }

          const res = await handleApiRequest(
            new Request("http://localhost:3000/api/admin/record-adsense-earning", {
              method: "POST",
              headers,
              body: JSON.stringify({
                userId: "FT483921",
                amount: 750,
                reportMonth: "2026-11",
              }),
            }),
            tc.handlerEnv,
          );

          assert.ok(res, tc.label);
          assert.equal(res.status, 503, `${tc.label}: expected HTTP 503`);
          const body = (await res.json()) as any;
          assert.equal(body.success, false, tc.label);
          assert.match(body.error || "", /database connection unavailable/i, tc.label);
        }

        assert.equal(spy.ops.reads, 0, "Production 503 must not read local JSON store");
        assert.equal(spy.ops.writes, 0, "Production 503 must not write local JSON store");
        assert.equal(
          spy.ops.existsChecks,
          0,
          "Production 503 must not stat/check local JSON store",
        );
      } finally {
        spy.restore();
      }
    });

    it("preserves non-production local-store fallback when handler env specifies test/development over production process.env", async () => {
      process.env["APP_ENV"] = "production";
      process.env["NODE_ENV"] = "production";

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-adsense-earning", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: "FT483921",
            amount: 425,
            reportMonth: "2026-11",
          }),
        }),
        { APP_ENV: "test", NODE_ENV: "test" },
      );

      assert.ok(res);
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.success, true);
      assert.equal(body.transactionId, "TX_ADSENSE_FT483921_202611");

      const persisted = JSON.parse(fs.readFileSync(storePath, "utf-8"));
      assert.equal(persisted.adsenseStatements?.["FT483921_2026-11"]?.amount, 425);
    });
  });

  describe("10. MySQL Connection Acquisition & Rollback Failure Safety", () => {
    const dbEnvKeys = [
      "DB_HOST",
      "DB_PORT",
      "DB_NAME",
      "DB_USER",
      "DB_PASSWORD",
      "MYSQL_HOST",
      "MYSQL_PORT",
      "MYSQL_DATABASE",
      "MYSQL_USER",
      "MYSQL_PASSWORD",
      "NODE_ENV",
      "APP_ENV",
    ] as const;

    let envSnapshot: Record<string, string | undefined> = {};

    beforeEach(() => {
      envSnapshot = {};
      for (const k of dbEnvKeys) {
        envSnapshot[k] = process.env[k];
      }
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";
      process.env["APP_ENV"] = "production";
      process.env["NODE_ENV"] = "production";
    });

    afterEach(() => {
      setMysqlPoolForTesting(null);
      for (const k of dbEnvKeys) {
        if (envSnapshot[k] === undefined) delete process.env[k];
        else process.env[k] = envSnapshot[k];
      }
    });

    const createSessionQuery = () => async (sql: string) => {
      if (sql.includes("FROM sessions s") && sql.includes("JOIN users u")) {
        return [
          [
            {
              id: "a0000000-0000-0000-0000-000000000001",
              user_id: "FT102857",
              name: "FaceTube Administrator",
              email: "admin@facetube.com",
              role: "admin",
              referral_code: "FTVIP",
            },
          ],
        ];
      }
      return [[]];
    };

    it("returns HTTP 503 with zero DB/local writes and no conn.release() when pool.getConnection() rejects with ECONNREFUSED", async () => {
      let queryCalls = 0;

      setMysqlPoolForTesting({
        query: async (sql: string) => {
          queryCalls += 1;
          return createSessionQuery()(sql);
        },
        getConnection: async () => {
          const err: any = new Error("connect ECONNREFUSED 127.0.0.1:3306");
          err.code = "ECONNREFUSED";
          err.errno = 2003;
          throw err;
        },
      } as any);

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-adsense-earning", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: "FT483921",
            amount: 900,
            reportMonth: "2026-10",
          }),
        }),
        { APP_ENV: "production", NODE_ENV: "production" },
      );

      assert.ok(res);
      assert.equal(res.status, 503);
      const body = (await res.json()) as any;
      assert.equal(body.success, false);
      assert.match(body.error || "", /database connection unavailable/i);
      assert.equal(queryCalls, 1, "Only session auth query may execute; zero earning queries");
    });

    it("returns HTTP 500 with structured JSON error and zero writes on unexpected pool.getConnection() error", async () => {
      let queryCalls = 0;

      setMysqlPoolForTesting({
        query: async (sql: string) => {
          queryCalls += 1;
          return createSessionQuery()(sql);
        },
        getConnection: async () => {
          throw new Error("Unexpected pool driver initialization error");
        },
      } as any);

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-adsense-earning", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: "FT483921",
            amount: 900,
            reportMonth: "2026-10",
          }),
        }),
        { APP_ENV: "production", NODE_ENV: "production" },
      );

      assert.ok(res);
      assert.equal(res.status, 500);
      const body = (await res.json()) as any;
      assert.equal(body.success, false);
      assert.match(body.error || "", /failed to acquire database connection/i);
      assert.equal(queryCalls, 1, "Zero earning/ledger/wallet queries on getConnection failure");
    });

    it("does not mask original transaction error or duplicate-key 409 when rollback fails, and still calls conn.release()", async () => {
      for (const scenario of [
        {
          label: "transaction DB error",
          errCode: "ER_LOCK_WAIT_TIMEOUT",
          errNo: 1205,
          status: 500,
        },
        { label: "duplicate entry race", errCode: "ER_DUP_ENTRY", errNo: 1062, status: 409 },
      ] as const) {
        let rollbackAttempts = 0;
        let releaseAttempts = 0;
        let committed = false;
        let walletWrites = 0;

        setMysqlPoolForTesting({
          query: createSessionQuery(),
          getConnection: async () => ({
            beginTransaction: async () => {},
            query: async (sql: string) => {
              if (sql.includes("FROM users WHERE UPPER(user_id)")) {
                return [[{ id: "u2", user_id: "FT483921", name: "Alex Rivera" }]];
              }
              if (sql.startsWith("INSERT INTO income_ledger")) {
                const err: any = new Error(`${scenario.label} failure`);
                err.code = scenario.errCode;
                err.errno = scenario.errNo;
                throw err;
              }
              if (sql.startsWith("INSERT INTO wallet_balances")) {
                walletWrites += 1;
              }
              return [[]];
            },
            commit: async () => {
              committed = true;
            },
            rollback: async () => {
              rollbackAttempts += 1;
              throw new Error("Rollback transport error");
            },
            release: () => {
              releaseAttempts += 1;
            },
          }),
        } as any);

        const res = await handleApiRequest(
          new Request("http://localhost:3000/api/admin/record-adsense-earning", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
              userId: "FT483921",
              amount: 900,
              reportMonth: "2026-10",
            }),
          }),
          { APP_ENV: "production", NODE_ENV: "production" },
        );

        assert.ok(res, scenario.label);
        assert.equal(res.status, scenario.status, `${scenario.label}: original status preserved`);
        const body = (await res.json()) as any;
        assert.equal(body.success, false);
        assert.equal(
          String(body.error || "").includes("Rollback transport error"),
          false,
          `${scenario.label}: rollback error must never mask original DB error`,
        );
        assert.equal(rollbackAttempts, 1, `${scenario.label}: rollback attempted once`);
        assert.equal(releaseAttempts, 1, `${scenario.label}: conn.release() still called`);
        assert.equal(committed, false);
        assert.equal(walletWrites, 0);
      }
    });

    it("skips rollback when beginTransaction fails before starting tx and still safely calls conn.release()", async () => {
      let rollbackAttempts = 0;
      let releaseAttempts = 0;

      setMysqlPoolForTesting({
        query: createSessionQuery(),
        getConnection: async () => ({
          beginTransaction: async () => {
            throw new Error("beginTransaction failed");
          },
          query: async () => [[]],
          commit: async () => {},
          rollback: async () => {
            rollbackAttempts += 1;
          },
          release: () => {
            releaseAttempts += 1;
          },
        }),
      } as any);

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-adsense-earning", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: "FT483921",
            amount: 900,
            reportMonth: "2026-10",
          }),
        }),
        { APP_ENV: "production", NODE_ENV: "production" },
      );

      assert.ok(res);
      assert.equal(res.status, 500);
      assert.equal(rollbackAttempts, 0, "Must not call rollback if transaction never started");
      assert.equal(releaseAttempts, 1, "Must still release acquired connection");
    });
  });

  describe("11. Amount Precision, Ledger-Wallet Consistency & Write Confirmation Safety", () => {
    const dbEnvKeys = [
      "DB_HOST",
      "DB_PORT",
      "DB_NAME",
      "DB_USER",
      "DB_PASSWORD",
      "MYSQL_HOST",
      "MYSQL_PORT",
      "MYSQL_DATABASE",
      "MYSQL_USER",
      "MYSQL_PASSWORD",
      "NODE_ENV",
      "APP_ENV",
    ] as const;

    let envSnapshot: Record<string, string | undefined> = {};

    beforeEach(() => {
      envSnapshot = {};
      for (const k of dbEnvKeys) {
        envSnapshot[k] = process.env[k];
      }
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";
      process.env["APP_ENV"] = "production";
      process.env["NODE_ENV"] = "production";
    });

    afterEach(() => {
      setMysqlPoolForTesting(null);
      resetInMemoryStore();
      for (const k of dbEnvKeys) {
        if (envSnapshot[k] === undefined) delete process.env[k];
        else process.env[k] = envSnapshot[k];
      }
    });

    const createSessionQuery = () => async (sql: string) => {
      if (sql.includes("FROM sessions s") && sql.includes("JOIN users u")) {
        return [
          [
            {
              id: "a0000000-0000-0000-0000-000000000001",
              user_id: "FT102857",
              name: "FaceTube Administrator",
              email: "admin@facetube.com",
              role: "admin",
              referral_code: "FTVIP",
            },
          ],
        ];
      }
      return [[]];
    };

    it("rejects NaN, Infinity, non-positive, non-numeric, and >2-decimal amounts with HTTP 400 and zero DB activity", async () => {
      for (const rawInvalid of [NaN, Infinity, -Infinity, 0, -25.5, 0.004, 100.1234, 1e-5]) {
        const parsed = parseValidatedCurrencyAmount(rawInvalid, "AdSense");
        assert.equal(parsed.valid, false, `Helper must reject ${String(rawInvalid)}`);
      }

      let dbConnCalls = 0;
      setMysqlPoolForTesting({
        query: createSessionQuery(),
        getConnection: async () => {
          dbConnCalls += 1;
          throw new Error("Should never acquire DB connection on invalid amount");
        },
      } as any);

      const badAmounts: Array<unknown> = [
        null,
        0,
        -100,
        -0.01,
        "NaN",
        "Infinity",
        "-Infinity",
        "abc",
        "",
        true,
        0.004,
        0.005,
        100.1234,
        "12.345",
        1e-5,
      ];

      for (const badAmount of badAmounts) {
        const res = await handleApiRequest(
          new Request("http://localhost:3000/api/admin/record-adsense-earning", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
              userId: "FT483921",
              amount: badAmount,
              reportMonth: "2026-12",
            }),
          }),
          { APP_ENV: "production", NODE_ENV: "production" },
        );
        assert.ok(res, `Expected response for invalid amount ${JSON.stringify(badAmount)}`);
        assert.equal(
          res.status,
          400,
          `Expected HTTP 400 for invalid amount ${JSON.stringify(badAmount)}`,
        );
        const body = (await res.json()) as any;
        assert.equal(body.success, false);
      }

      assert.equal(dbConnCalls, 0, "Must never open DB transaction for invalid amounts");
    });

    it("persists identical validated 2-decimal amounts across statement, income_ledger, wallet_balances, and response", async () => {
      for (const validAmount of [0.01, 19.99, 1250.75]) {
        const captured: {
          stmtAmount?: number;
          ledgerAmount?: number;
          walletParams?: number[];
          committed: boolean;
        } = { committed: false };

        const queryFn = async (sql: string, params: any[] = []) => {
          if (sql.includes("FROM sessions s") && sql.includes("JOIN users u")) {
            return createSessionQuery()(sql);
          }
          if (sql.includes("FROM users WHERE UPPER(user_id)")) {
            return [[{ id: "u2", user_id: "FT483921", name: "Alex Rivera" }]];
          }
          if (sql.startsWith("INSERT INTO adsense_monthly_statements")) {
            captured.stmtAmount = params[3];
            return [{ affectedRows: 1 }];
          }
          if (sql.startsWith("INSERT INTO income_ledger")) {
            captured.ledgerAmount = params[6];
            return [{ affectedRows: 1 }];
          }
          if (sql.startsWith("INSERT INTO wallet_balances")) {
            captured.walletParams = [params[1], params[2], params[3]];
            return [{ affectedRows: 1 }];
          }
          return [[]];
        };

        setMysqlPoolForTesting({
          query: queryFn,
          getConnection: async () => ({
            beginTransaction: async () => {},
            query: queryFn,
            commit: async () => {
              captured.committed = true;
            },
            rollback: async () => {},
            release: () => {},
          }),
        } as any);

        const res = await handleApiRequest(
          new Request("http://localhost:3000/api/admin/record-adsense-earning", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
              userId: "FT483921",
              amount: validAmount,
              reportMonth: "2026-12",
            }),
          }),
          { APP_ENV: "production", NODE_ENV: "production" },
        );

        assert.ok(res);
        assert.equal(res.status, 200, `Expected 200 for valid 2-decimal amount ${validAmount}`);
        const body = (await res.json()) as any;
        assert.equal(body.success, true);
        assert.equal(body.amount, validAmount);
        assert.equal(captured.committed, true);
        assert.equal(captured.stmtAmount, validAmount);
        assert.equal(captured.ledgerAmount, validAmount);
        assert.deepEqual(captured.walletParams, [validAmount, validAmount, validAmount]);
      }
    });

    it("rolls back and returns HTTP 500 when affectedRows < 1 on statement, income_ledger, or wallet_balances write", async () => {
      for (const failStage of ["statement", "ledger", "wallet"] as const) {
        let committed = false;
        let rolledBack = false;
        let released = false;
        let walletAttempts = 0;

        const queryFn = async (sql: string) => {
          if (sql.includes("FROM sessions s") && sql.includes("JOIN users u")) {
            return createSessionQuery()(sql);
          }
          if (sql.includes("FROM users WHERE UPPER(user_id)")) {
            return [[{ id: "u2", user_id: "FT483921", name: "Alex Rivera" }]];
          }
          if (sql.startsWith("INSERT INTO adsense_monthly_statements")) {
            return [{ affectedRows: failStage === "statement" ? 0 : 1 }];
          }
          if (sql.startsWith("INSERT INTO income_ledger")) {
            return [{ affectedRows: failStage === "ledger" ? 0 : 1 }];
          }
          if (sql.startsWith("INSERT INTO wallet_balances")) {
            walletAttempts += 1;
            return [{ affectedRows: failStage === "wallet" ? 0 : 1 }];
          }
          return [[]];
        };

        setMysqlPoolForTesting({
          query: queryFn,
          getConnection: async () => ({
            beginTransaction: async () => {},
            query: queryFn,
            commit: async () => {
              committed = true;
            },
            rollback: async () => {
              rolledBack = true;
            },
            release: () => {
              released = true;
            },
          }),
        } as any);

        const res = await handleApiRequest(
          new Request("http://localhost:3000/api/admin/record-adsense-earning", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
              userId: "FT483921",
              amount: 275.5,
              reportMonth: "2026-12",
            }),
          }),
          { APP_ENV: "production", NODE_ENV: "production" },
        );

        assert.ok(res);
        assert.equal(res.status, 500, `affectedRows=0 at ${failStage} must return HTTP 500`);
        assert.equal(rolledBack, true, `affectedRows=0 at ${failStage} must roll back`);
        assert.equal(committed, false, `affectedRows=0 at ${failStage} must never commit`);
        assert.equal(released, true, `affectedRows=0 at ${failStage} must release connection`);
        if (failStage !== "wallet") {
          assert.equal(walletAttempts, 0, `${failStage} failure must not proceed to wallet write`);
        }
      }
    });

    it("enforces finite 2-decimal validation and rowCount() checks in PHP AdSense handler", () => {
      const phpSource = fs.readFileSync(
        path.resolve(process.cwd(), "api/admin/record-adsense-earning.php"),
        "utf-8",
      );
      assert.ok(
        phpSource.includes("is_finite($parsedAmount)") &&
          phpSource.includes("abs(($parsedAmount * 100) - $scaledAmount) > 1e-6"),
        "PHP AdSense handler must enforce finite 2-decimal amount precision without silent rounding",
      );
      assert.ok(
        phpSource.includes("$stmtInsertStatement->rowCount() < 1") &&
          phpSource.includes("$stmtLedger->rowCount() < 1") &&
          phpSource.includes("$stmtCredit->rowCount() < 1"),
        "PHP AdSense handler must verify rowCount() >= 1 on statement, ledger, and wallet writes",
      );
    });
  });

  describe("12. GET Database Error Handling, Optional Table Compatibility & Fail-Closed Guards", () => {
    const dbEnvKeys = [
      "DB_HOST",
      "DB_PORT",
      "DB_NAME",
      "DB_USER",
      "DB_PASSWORD",
      "MYSQL_HOST",
      "MYSQL_PORT",
      "MYSQL_DATABASE",
      "MYSQL_USER",
      "MYSQL_PASSWORD",
      "NODE_ENV",
      "APP_ENV",
    ] as const;
    const storePath = path.resolve(process.cwd(), "data/facetube_store.json");
    let envSnapshot: Record<string, string | undefined> = {};

    beforeEach(() => {
      envSnapshot = {};
      for (const k of dbEnvKeys) {
        envSnapshot[k] = process.env[k];
      }
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";
      process.env["APP_ENV"] = "production";
      process.env["NODE_ENV"] = "production";
    });

    afterEach(() => {
      setMysqlPoolForTesting(null);
      resetInMemoryStore();
      for (const k of dbEnvKeys) {
        if (envSnapshot[k] === undefined) delete process.env[k];
        else process.env[k] = envSnapshot[k];
      }
    });

    const createSessionQuery = () => async (sql: string) => {
      if (sql.includes("FROM sessions s") && sql.includes("JOIN users u")) {
        return [
          [
            {
              id: "a0000000-0000-0000-0000-000000000001",
              user_id: "FT102857",
              name: "FaceTube Administrator",
              email: "admin@facetube.com",
              role: "admin",
              referral_code: "FTVIP",
            },
          ],
        ];
      }
      return [[]];
    };

    it("preserves successful GET response formats for conflicts and statements", async () => {
      const mockConflicts = [
        { id: "c1", user_id: "FT483921", report_month: "2026-10", amount: 120.5 },
      ];
      const mockStatements = [
        { id: "s1", user_id: "FT483921", report_month: "2026-10", amount: 500.25 },
      ];

      setMysqlPoolForTesting({
        query: async (sql: string) => {
          if (sql.includes("FROM sessions s")) return createSessionQuery()(sql);
          if (sql.includes("FROM adsense_historical_conflicts")) return [mockConflicts];
          if (sql.includes("FROM adsense_monthly_statements")) return [mockStatements];
          return [[]];
        },
      } as any);

      const conflictsRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-adsense-earning?action=conflicts", {
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
        { APP_ENV: "production", NODE_ENV: "production" },
      );
      assert.equal(conflictsRes?.status, 200);
      const conflictsBody = (await conflictsRes?.json()) as any;
      assert.equal(conflictsBody.success, true);
      assert.equal(conflictsBody.count, 1);
      assert.deepEqual(conflictsBody.conflicts, mockConflicts);

      const statementsRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-adsense-earning?action=statements", {
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
        { APP_ENV: "production", NODE_ENV: "production" },
      );
      assert.equal(statementsRes?.status, 200);
      const statementsBody = (await statementsRes?.json()) as any;
      assert.equal(statementsBody.success, true);
      assert.equal(statementsBody.count, 1);
      assert.deepEqual(statementsBody.statements, mockStatements);
    });

    it("returns empty 200 arrays ONLY when optional tables are genuinely missing (ER_NO_SUCH_TABLE / 1146 / 42S02)", async () => {
      setMysqlPoolForTesting({
        query: async (sql: string) => {
          if (sql.includes("FROM sessions s")) return createSessionQuery()(sql);
          if (sql.includes("FROM adsense_historical_conflicts")) {
            const err: any = new Error(
              "Table 'facetube.adsense_historical_conflicts' doesn't exist",
            );
            err.code = "ER_NO_SUCH_TABLE";
            err.errno = 1146;
            throw err;
          }
          if (sql.includes("FROM adsense_monthly_statements")) {
            const err: any = new Error("Table 'facetube.adsense_monthly_statements' doesn't exist");
            err.sqlState = "42S02";
            throw err;
          }
          return [[]];
        },
      } as any);

      const conflictsRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-adsense-earning?action=conflicts", {
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
        { APP_ENV: "production", NODE_ENV: "production" },
      );
      assert.equal(conflictsRes?.status, 200);
      const conflictsBody = (await conflictsRes?.json()) as any;
      assert.deepEqual(conflictsBody, { success: true, count: 0, conflicts: [] });

      const statementsRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-adsense-earning?action=statements", {
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
        { APP_ENV: "production", NODE_ENV: "production" },
      );
      assert.equal(statementsRes?.status, 200);
      const statementsBody = (await statementsRes?.json()) as any;
      assert.deepEqual(statementsBody, { success: true, count: 0, statements: [] });
    });

    it("returns 503 on connection failure and 500 on unexpected query failure without exposing raw DB secrets", async () => {
      const origConsoleError = console.error;
      const loggedErrors: unknown[] = [];
      console.error = (...args: unknown[]) => {
        loggedErrors.push(args);
      };

      try {
        for (const action of ["conflicts", "statements"] as const) {
          // Connection failure -> 503
          setMysqlPoolForTesting({
            query: async (sql: string) => {
              if (sql.includes("FROM sessions s")) return createSessionQuery()(sql);
              const err: any = new Error(
                "connect ECONNREFUSED mysql://root:supersecret@10.0.0.5:3306/facetube_prod",
              );
              err.code = "ECONNREFUSED";
              err.errno = 2003;
              throw err;
            },
          } as any);

          const connRes = await handleApiRequest(
            new Request(`http://localhost:3000/api/admin/record-adsense-earning?action=${action}`, {
              headers: { Authorization: `Bearer ${adminToken}` },
            }),
            { APP_ENV: "production", NODE_ENV: "production" },
          );
          assert.equal(connRes?.status, 503, `${action} connection failure must return 503`);
          const connBody = (await connRes?.json()) as any;
          assert.equal(connBody.success, false);
          assert.equal(
            String(connBody.error || "").includes("supersecret") ||
              String(connBody.error || "").includes("10.0.0.5") ||
              String(connBody.error || "").includes("mysql://"),
            false,
            "Production 503 response must not leak connection strings or credentials",
          );

          // Unexpected SQL query failure -> 500
          setMysqlPoolForTesting({
            query: async (sql: string) => {
              if (sql.includes("FROM sessions s")) return createSessionQuery()(sql);
              const err: any = new Error(
                "SELECT command denied to user 'db_admin'@'10.0.0.9' for table 'adsense_monthly_statements'",
              );
              err.code = "ER_TABLEACCESS_DENIED_ERROR";
              err.errno = 1142;
              throw err;
            },
          } as any);

          const sqlRes = await handleApiRequest(
            new Request(`http://localhost:3000/api/admin/record-adsense-earning?action=${action}`, {
              headers: { Authorization: `Bearer ${adminToken}` },
            }),
            { APP_ENV: "production", NODE_ENV: "production" },
          );
          assert.equal(sqlRes?.status, 500, `${action} query failure must return 500`);
          const sqlBody = (await sqlRes?.json()) as any;
          assert.equal(sqlBody.success, false);
          assert.equal(
            String(sqlBody.error || "").includes("SELECT command denied") ||
              String(sqlBody.error || "").includes("db_admin") ||
              String(sqlBody.error || "").includes("10.0.0.9"),
            false,
            "Production 500 response must not leak raw SQL error messages or DB usernames",
          );
        }

        assert.ok(loggedErrors.length >= 4, "Detailed DB errors must be logged server-side");
      } finally {
        console.error = origConsoleError;
      }
    });

    it("fails closed with 503 and zero local-store reads on GET in production when MySQL pool is unavailable", async () => {
      setMysqlPoolForTesting(null);
      for (const k of dbEnvKeys) {
        if (k !== "NODE_ENV" && k !== "APP_ENV") delete process.env[k];
      }

      const origReadFileSync = fs.readFileSync;
      let storeReads = 0;
      fs.readFileSync = ((p: fs.PathOrFileDescriptor, options?: any) => {
        if (typeof p === "string" && path.resolve(p) === storePath) {
          storeReads += 1;
        }
        return origReadFileSync(p, options);
      }) as typeof fs.readFileSync;

      try {
        for (const action of ["conflicts", "statements"] as const) {
          const res = await handleApiRequest(
            new Request(`http://localhost:3000/api/admin/record-adsense-earning?action=${action}`, {
              headers: { Authorization: `Bearer ${adminToken}` },
            }),
            { APP_ENV: "production", NODE_ENV: "production" },
          );
          assert.equal(
            res?.status,
            503,
            `Production GET (${action}) without MySQL must return 503`,
          );
          const body = (await res?.json()) as any;
          assert.equal(body.success, false);
          assert.match(body.error || "", /database connection unavailable/i);
        }
        assert.equal(storeReads, 0, "Production GET must never fall back to local JSON store");
      } finally {
        fs.readFileSync = origReadFileSync;
      }
    });

    it("enforces missing-table-only empty compatibility, server-side logging, and safe 503/500 GET responses in PHP AdSense handler", () => {
      const phpSource = fs.readFileSync(
        path.resolve(process.cwd(), "api/admin/record-adsense-earning.php"),
        "utf-8",
      );
      assert.ok(
        phpSource.includes("$sqlState === '42S02' || $driverCode === 1146") &&
          phpSource.includes("if (!$isMissingOptionalTable($e))"),
        "PHP AdSense GET must allow empty results only on genuine missing optional table (42S02/1146)",
      );
      assert.ok(
        phpSource.includes("error_log('[record-adsense-earning.php][GET]") &&
          phpSource.includes("503") &&
          phpSource.includes("500"),
        "PHP AdSense GET must log DB errors server-side and return safe 503/500 responses",
      );
    });

    it("enforces Task 5J-V4-H PHP POST error-handling safety (missing-table, tx user lookup, 1062-only duplicate, safe rollback, redacted 500/503)", () => {
      const adsensePhp = fs.readFileSync(
        path.resolve(process.cwd(), "api/admin/record-adsense-earning.php"),
        "utf-8",
      );
      const responsePhp = fs.readFileSync(path.resolve(process.cwd(), "api/response.php"), "utf-8");
      const databasePhp = fs.readFileSync(
        path.resolve(process.cwd(), "api/config/database.php"),
        "utf-8",
      );

      // 1. No SHOW TABLES exception-swallowing; direct queries with 42S02/1146-only optional tolerance
      assert.ok(
        !adsensePhp.includes("SHOW TABLES LIKE 'adsense_monthly_statements'"),
        "PHP AdSense POST must query adsense_monthly_statements directly without SHOW TABLES swallowing",
      );
      assert.ok(
        adsensePhp.includes("if (!$isMissingOptionalTable($e)) {\n            throw $e;") &&
          adsensePhp.includes("FROM adsense_historical_conflicts"),
        "PHP AdSense POST must rethrow non-missing-table errors (deadlock/timeout/permission/connection) from optional table queries",
      );

      // 2. Target-user lookup moved inside transaction and safe try/catch, with 404 rollback
      const beginTxIdx = adsensePhp.indexOf("$pdo->beginTransaction();");
      const userLookupIdx = adsensePhp.indexOf("FROM users WHERE UPPER(user_id) = UPPER(?)");
      assert.ok(
        beginTxIdx !== -1 && userLookupIdx > beginTxIdx,
        "Users lookup must execute inside beginTransaction()",
      );
      const missingUserIdx = adsensePhp.indexOf("if (!$targetUser)");
      assert.ok(missingUserIdx > userLookupIdx);
      const missingUserBlock = adsensePhp.slice(missingUserIdx, missingUserIdx + 220);
      assert.ok(
        missingUserBlock.includes("$safeRollback($pdo);") && missingUserBlock.includes("404"),
        "Missing target user must safely roll back and return 404",
      );

      // 3. Strict 1062 duplicate classification (never generic SQLSTATE 23000)
      assert.ok(
        adsensePhp.includes("if ($mysqlErrno === 1062)"),
        "PHP AdSense POST must classify duplicates strictly on MySQL errno 1062",
      );
      assert.ok(
        !adsensePhp.includes("23000") && !adsensePhp.includes("Duplicate entry"),
        "PHP AdSense POST must not treat all SQLSTATE 23000 integrity errors as duplicate 409",
      );

      // 4. Safe rollback & Throwable catch
      assert.ok(
        adsensePhp.includes("$safeRollback = static function (PDO $conn): void") &&
          adsensePhp.includes("if ($conn->inTransaction())") &&
          adsensePhp.includes("catch (Throwable $_rollbackErr)"),
        "PHP AdSense POST must guard rollback with inTransaction() and absorb rollback failures",
      );
      assert.ok(
        adsensePhp.includes("} catch (Throwable $e) {"),
        "PHP AdSense POST outer handler must catch Throwable",
      );

      // 5. No raw $e->getMessage() leakage & safe 503/500 + server-side error_log
      assert.ok(
        !adsensePhp.includes("Database error recording AdSense earnings: ' . $e->getMessage()") &&
          !adsensePhp.includes("Error recording AdSense earnings: ' . $e->getMessage()"),
        "PHP AdSense POST must never expose raw $e->getMessage() in JSON responses",
      );
      assert.ok(
        adsensePhp.includes(
          "error_log('[record-adsense-earning.php][POST] Transaction error: ' . $e->getMessage())",
        ) &&
          adsensePhp.includes("$isConnectionUnavailable($e)") &&
          adsensePhp.includes("503") &&
          adsensePhp.includes("500"),
        "PHP AdSense POST must log server-side and map connection errors to 503 and DB errors to 500",
      );

      // 6. Auth DB outage distinguished from 401 + safe DB connection 503 handling
      assert.ok(
        adsensePhp.includes("getAuthUser($pdo, true)") &&
          adsensePhp.includes("[record-adsense-earning.php][AUTH]"),
        "PHP AdSense must distinguish auth DB failures (503/500) from unauthenticated 401",
      );
      assert.ok(
        responsePhp.includes("function getAuthUser($pdo, bool $rethrowDbError = false)") &&
          responsePhp.includes("error_log('[response.php][getAuthUser]"),
        "Shared getAuthUser must log DB failures and support rethrowing DB errors",
      );
      assert.ok(
        databasePhp.includes('error_log("[database.php] Database connection failed') &&
          databasePhp.includes("isDatabaseConnectionUnavailableError") &&
          databasePhp.includes("503"),
        "Shared getDatabaseConnection must safely log connection errors and return 503 when unavailable",
      );

      // 7. V4-D / V4-E preservation
      assert.ok(
        adsensePhp.includes('$txId = "TX_ADSENSE_{$cleanUserId}_{$cleanMonth}";') &&
          adsensePhp.includes("abs(($parsedAmount * 100) - $scaledAmount) > 1e-6") &&
          adsensePhp.includes("$stmtLedger->rowCount() < 1") &&
          adsensePhp.includes("$stmtCredit->rowCount() < 1"),
        "Existing V4-D deterministic TX ID and V4-E precision/rowCount validations must remain intact",
      );
    });
  });
});
