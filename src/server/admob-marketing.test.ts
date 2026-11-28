import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  handleApiRequest,
  isFailClosedProductionEnv,
  isMysqlDuplicateKeyError,
  parseValidatedAdMobMetric,
  parseValidatedCurrencyAmount,
  resetInMemoryStore,
} from "./api-handler.ts";
import { setMysqlPoolForTesting } from "./mysql.ts";
import { ADMOB_TEST_IDS, resolveAdMobConfig, requireAdMobConfig } from "../lib/admob-service.ts";

describe("FaceTube Google AdMob Integration & Backend Statements Test Suite", () => {
  let adminToken = "";
  let userToken = "";
  const targetCreator = "FT483921";
  const testMonth = "2026-08";
  const storePath = path.resolve(process.cwd(), "data/facetube_store.json");
  let initialWalletSnapshot: any = null;
  const originalNodeEnv = process.env["NODE_ENV"];

  before(async () => {
    if (!process.env["NODE_ENV"] && !process.env["APP_ENV"]) {
      process.env["NODE_ENV"] = "test";
    }
    if (fs.existsSync(storePath)) {
      try {
        const store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
        if (store.admobStatements) {
          delete store.admobStatements[`${targetCreator}_${testMonth}`];
        }
        if (Array.isArray(store.walletTransactions)) {
          store.walletTransactions = store.walletTransactions.filter(
            (tx: any) =>
              !String(tx["transaction_id"] || tx["transactionId"] || "").includes("ADMOB"),
          );
        }
        if (store.wallets?.[targetCreator]) {
          store.wallets[targetCreator].admob_income = 0;
          initialWalletSnapshot = structuredClone(store.wallets[targetCreator]);
        }
        fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
      } catch (_e) {
        // ignore
      }
    }
    resetInMemoryStore();

    // 1. Authenticate as Admin (admin@facetube.com)
    const adminLoginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "admin@facetube.com", password: "password123" }),
    });
    const adminLoginRes = await handleApiRequest(adminLoginReq);
    assert.ok(adminLoginRes, "Admin login request must return a response");
    const adminData = (await adminLoginRes.json()) as any;
    assert.ok(adminData.token, "Admin login must return a session token");
    adminToken = adminData.token;

    // 2. Authenticate as Standard User (alex@facetube.com)
    const userLoginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
    });
    const userLoginRes = await handleApiRequest(userLoginReq);
    assert.ok(userLoginRes, "User login request must return a response");
    const userData = (await userLoginRes.json()) as any;
    assert.ok(userData.token, "User login must return a session token");
    userToken = userData.token;
  });

  after(() => {
    setMysqlPoolForTesting(null);
    if (originalNodeEnv !== undefined) process.env["NODE_ENV"] = originalNodeEnv;
    else delete process.env["NODE_ENV"];

    if (fs.existsSync(storePath)) {
      try {
        const store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
        if (store.admobStatements) {
          delete store.admobStatements[`${targetCreator}_${testMonth}`];
        }
        if (Array.isArray(store.walletTransactions)) {
          store.walletTransactions = store.walletTransactions.filter(
            (tx: any) =>
              !String(tx["transaction_id"] || tx["transactionId"] || "").includes("ADMOB"),
          );
        }
        if (initialWalletSnapshot && store.wallets) {
          store.wallets[targetCreator] = initialWalletSnapshot;
        }
        fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
      } catch (_e) {
        // cleanup
      }
    }
  });

  it("1. Admin Authorization Enforcement", async () => {
    // 1a. Unauthenticated request rejected with 401
    const unauthReq = new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: targetCreator,
        amount: 500,
        reportMonth: testMonth,
      }),
    });
    const unauthRes = await handleApiRequest(unauthReq);
    assert.ok(unauthRes, "Handler returned a response");
    assert.equal(unauthRes.status, 401, "Rejects unauthenticated request with 401");

    // 1b. Regular non-admin user rejected with 403
    const userReq = new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({
        userId: targetCreator,
        amount: 500,
        reportMonth: testMonth,
      }),
    });
    const userRes = await handleApiRequest(userReq);
    assert.ok(userRes, "Handler returned a response");
    assert.equal(userRes.status, 403, "Rejects non-admin user with 403");
  });

  it("2. Input Validation (Amount, UserId, Month format)", async () => {
    // 2a. Missing userId -> 400
    const missingUserReq = new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        amount: 500,
        reportMonth: testMonth,
      }),
    });
    const missingUserRes = await handleApiRequest(missingUserReq);
    assert.equal(missingUserRes?.status, 400, "Rejects missing userId with 400");

    // 2b. Zero or negative amount -> 400
    const invalidAmountReq = new Request(
      "http://localhost:3000/api/admin/record-admob-earning.php",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          userId: targetCreator,
          amount: -50,
          reportMonth: testMonth,
        }),
      },
    );
    const invalidAmountRes = await handleApiRequest(invalidAmountReq);
    assert.equal(invalidAmountRes?.status, 400, "Rejects negative amount with 400");

    // 2c. Invalid reportMonth format -> 400
    const invalidMonthReq = new Request(
      "http://localhost:3000/api/admin/record-admob-earning.php",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          userId: targetCreator,
          amount: 500,
          reportMonth: "invalid-month",
        }),
      },
    );
    const invalidMonthRes = await handleApiRequest(invalidMonthReq);
    assert.equal(invalidMonthRes?.status, 400, "Rejects invalid reportMonth with 400");
  });

  it("3. Successful Statement Recording, Existing Balance Preservation & Duplicate Protection", async () => {
    const testAmount = 350.75;

    // 3a. Snapshot creator wallet before AdMob credit
    const preWalletReq = new Request(
      `http://localhost:3000/api/wallet/balance.php?userId=${targetCreator}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      },
    );
    const preWalletRes = await handleApiRequest(preWalletReq);
    const preWalletBody = (await preWalletRes?.json()) as any;
    assert.equal(preWalletBody.success, true);
    const preWallet = preWalletBody.wallet;

    // 3b. Record verified AdMob monthly statement
    const recordReq = new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        userId: targetCreator,
        amount: testAmount,
        reportMonth: testMonth,
        impressions: 12500,
        ecpm: 28.06,
        description: "Google AdMob Finalized Performance Statement August 2026",
      }),
    });
    const recordRes = await handleApiRequest(recordReq);
    assert.equal(recordRes?.status, 201, "Successfully credits statement with 201");
    const recordBody = (await recordRes?.json()) as any;
    assert.equal(recordBody.success, true);
    assert.equal(recordBody.amount, testAmount);
    assert.ok(recordBody.transactionId, "Generated transaction ID");

    // 3c. Verify wallet admob_income, balance, and total_earned incremented while other incomes are preserved
    const walletReq = new Request(
      `http://localhost:3000/api/wallet/balance.php?userId=${targetCreator}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      },
    );
    const walletRes = await handleApiRequest(walletReq);
    const walletBody = (await walletRes?.json()) as any;
    assert.equal(walletBody.success, true);
    const postWallet = walletBody.wallet;

    assert.equal(
      Number((postWallet.admob_income - preWallet.admob_income).toFixed(2)),
      testAmount,
      "Wallet admob_income incremented by exact AdMob amount",
    );
    assert.equal(
      Number((postWallet.balance - preWallet.balance).toFixed(2)),
      testAmount,
      "Wallet balance incremented by exact AdMob amount",
    );
    assert.equal(
      Number((postWallet.total_earned - preWallet.total_earned).toFixed(2)),
      testAmount,
      "Wallet total_earned incremented by exact AdMob amount",
    );
    assert.equal(
      postWallet.referral_income,
      preWallet.referral_income,
      "Existing referral_income preserved",
    );
    assert.equal(
      postWallet.global_income,
      preWallet.global_income,
      "Existing global_income preserved",
    );
    assert.equal(
      postWallet.adsense_income,
      preWallet.adsense_income,
      "Existing adsense_income preserved",
    );
    assert.equal(
      postWallet.affiliate_income,
      preWallet.affiliate_income,
      "Existing affiliate_income preserved",
    );
    assert.equal(
      postWallet.total_withdrawn,
      preWallet.total_withdrawn,
      "Existing total_withdrawn preserved",
    );

    // 3d. Duplicate prevention: Re-recording same user and month returns 409 Conflict
    const dupReq = new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        userId: targetCreator,
        amount: testAmount,
        reportMonth: testMonth,
      }),
    });
    const dupRes = await handleApiRequest(dupReq);
    assert.equal(dupRes?.status, 409, "Blocks duplicate statement credit with HTTP 409 Conflict");

    // Verify wallet balance did not change after duplicate attempt
    const afterDupWalletRes = await handleApiRequest(
      new Request(`http://localhost:3000/api/wallet/balance.php?userId=${targetCreator}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
    );
    const afterDupWallet = ((await afterDupWalletRes?.json()) as any).wallet;
    assert.equal(afterDupWallet.admob_income, postWallet.admob_income);
    assert.equal(afterDupWallet.balance, postWallet.balance);
  });

  it("4. Admin AdMob Statements Listing", async () => {
    const listReq = new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
      method: "GET",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const listRes = await handleApiRequest(listReq);
    assert.equal(listRes?.status, 200, "Returns HTTP 200 for statements list");
    const listBody = (await listRes?.json()) as any;
    assert.equal(listBody.success, true);
    assert.ok(Array.isArray(listBody.statements), "Statements list is an array");
    assert.ok(listBody.count > 0, "Contains recorded statements");
  });

  it("5. Zero Default for Existing Wallet Records Without admob_income Field", async () => {
    const testUser = "FT900431";
    const originalWallet =
      fs.existsSync(storePath) &&
      JSON.parse(fs.readFileSync(storePath, "utf-8")).wallets?.[testUser]
        ? structuredClone(JSON.parse(fs.readFileSync(storePath, "utf-8")).wallets[testUser])
        : null;

    if (fs.existsSync(storePath)) {
      const store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
      if (store.wallets?.[testUser]) {
        delete store.wallets[testUser].admob_income;
        fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
      }
    }

    try {
      const res = await handleApiRequest(
        new Request(`http://localhost:3000/api/wallet/balance.php?userId=${testUser}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
      );
      assert.equal(res?.status, 200);
      const body = (await res?.json()) as any;
      assert.equal(body.success, true);
      assert.equal(body.wallet.admob_income, 0, "Legacy wallet without admob_income defaults to 0");
      assert.equal(body.wallet.admobIncome, 0, "CamelCase admobIncome defaults to 0");
    } finally {
      if (originalWallet && fs.existsSync(storePath)) {
        const store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
        store.wallets[testUser] = originalWallet;
        fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
      }
    }
  });

  it("6. MySQL Path: Credits wallet_balances.admob_income, Preserves Other Balances, Enforces Duplicate Protection & Zero Default", async () => {
    const origHost = process.env["DB_HOST"];
    const origName = process.env["DB_NAME"];
    const origUser = process.env["DB_USER"];

    process.env["DB_HOST"] = "127.0.0.1";
    process.env["DB_NAME"] = "facetube_test";
    process.env["DB_USER"] = "test_user";

    const mysqlWalletState = {
      user_id: targetCreator,
      balance: 4280.5,
      total_earned: 7430.5,
      total_withdrawn: 3150.0,
      referral_income: 1079.5,
      global_income: 2450.0,
      adsense_income: 1890.2,
      admob_income: 0.0,
      affiliate_income: 940.8,
      updated_at: "2026-11-13 08:00:00",
    };

    const recordedStatements = new Map<string, { id: number; statement_id: string }>();
    let committed = false;
    let rolledBack = false;

    const executeQuery = async (sql: string, params: any[] = []) => {
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
      if (sql.includes("SELECT id, user_id, name, email FROM users WHERE UPPER(user_id)")) {
        return [[{ id: "a0000000-0000-0000-0000-000000000002", user_id: targetCreator }]];
      }
      if (sql.includes("FROM admob_monthly_statements WHERE user_id = ? AND report_month = ?")) {
        const key = `${params[0]}_${params[1]}`;
        const existing = recordedStatements.get(key);
        return [existing ? [existing] : []];
      }
      if (sql.startsWith("INSERT INTO income_ledger")) {
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith("INSERT INTO admob_monthly_statements")) {
        assert.equal(
          params[7],
          null,
          "Non-production calls omitting appId must bind SQL NULL, never Google test App ID",
        );
        const key = `${params[1]}_${params[2]}`;
        recordedStatements.set(key, { id: 1, statement_id: String(params[0]) });
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith("INSERT INTO wallet_balances")) {
        assert.ok(
          sql.includes("admob_income") &&
            sql.includes("admob_income = admob_income + VALUES(admob_income)"),
          "MySQL wallet_balances query must explicitly insert and increment admob_income",
        );
        assert.equal(
          params.length,
          4,
          "Wallet query must bind [userId, balance, total_earned, admob_income]",
        );
        assert.equal(
          params[1],
          params[3],
          "Credited admob_income must match credited balance amount",
        );
        mysqlWalletState.balance += Number(params[1]);
        mysqlWalletState.total_earned += Number(params[2]);
        mysqlWalletState.admob_income += Number(params[3]);
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("FROM wallet_balances WHERE UPPER(user_id) = UPPER(?)")) {
        return [[{ ...mysqlWalletState }]];
      }
      return [[]];
    };

    const mockPool = {
      query: executeQuery,
      getConnection: async () => ({
        beginTransaction: async () => {
          committed = false;
          rolledBack = false;
        },
        query: executeQuery,
        commit: async () => {
          committed = true;
        },
        rollback: async () => {
          rolledBack = true;
        },
        release: () => {},
      }),
    };

    setMysqlPoolForTesting(mockPool);

    try {
      // 6a. Zero default before any AdMob earnings
      const preRes = await handleApiRequest(
        new Request(`http://localhost:3000/api/wallet/balance?userId=${targetCreator}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
      );
      assert.equal(preRes?.status, 200);
      const preData = (await preRes?.json()) as any;
      assert.equal(preData.wallet.admob_income, 0);
      assert.equal(preData.wallet.balance, 4280.5);

      // 6b. Record verified AdMob earning through MySQL path
      const creditRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: targetCreator,
            amount: 250.25,
            reportMonth: "2026-09",
          }),
        }),
      );
      assert.equal(creditRes?.status, 201);
      assert.equal(committed, true);
      assert.equal(mysqlWalletState.admob_income, 250.25);
      assert.equal(mysqlWalletState.balance, 4530.75);
      assert.equal(mysqlWalletState.total_earned, 7680.75);
      assert.equal(mysqlWalletState.referral_income, 1079.5);
      assert.equal(mysqlWalletState.global_income, 2450.0);
      assert.equal(mysqlWalletState.adsense_income, 1890.2);
      assert.equal(mysqlWalletState.affiliate_income, 940.8);
      assert.equal(mysqlWalletState.total_withdrawn, 3150.0);

      // 6c. Duplicate month blocked in MySQL path with 409 + rollback
      const dupRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: targetCreator,
            amount: 250.25,
            reportMonth: "2026-09",
          }),
        }),
      );
      assert.equal(dupRes?.status, 409);
      assert.equal(rolledBack, true);
      assert.equal(mysqlWalletState.admob_income, 250.25);
      assert.equal(mysqlWalletState.balance, 4530.75);
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

  it("7. Migration & Schema Verification for wallet_balances.admob_income", () => {
    const migrationPath = path.resolve(
      process.cwd(),
      "database/migrations/20261112_wallet_balances_admob_income.sql",
    );
    const schemaPath = path.resolve(process.cwd(), "database/schema.sql");

    assert.ok(
      fs.existsSync(migrationPath),
      "Migration 20261112_wallet_balances_admob_income.sql must exist",
    );
    const migrationSql = fs.readFileSync(migrationPath, "utf-8");
    assert.ok(migrationSql.includes("INFORMATION_SCHEMA.COLUMNS"));
    assert.ok(migrationSql.includes("wallet_balances"));
    assert.ok(migrationSql.includes("`admob_income` DECIMAL(14, 2) NOT NULL DEFAULT 0.00"));
    assert.ok(!migrationSql.includes("ADD COLUMN IF NOT EXISTS"));

    const schemaSql = fs.readFileSync(schemaPath, "utf-8");
    assert.ok(
      schemaSql.includes("`admob_income` DECIMAL(14, 2) NOT NULL DEFAULT 0.00"),
      "database/schema.sql must define wallet_balances.admob_income DECIMAL(14, 2) NOT NULL DEFAULT 0.00",
    );
  });

  it("8. Production App ID Safety: Fail-Closed Validation, ADMOB_APP_ID Resolution, Atomic Rollback & Duplicate Race 409", async () => {
    const origHost = process.env["DB_HOST"];
    const origName = process.env["DB_NAME"];
    const origUser = process.env["DB_USER"];
    const origNodeEnv = process.env["NODE_ENV"];
    const origAppEnv = process.env["APP_ENV"];
    const origAdMobAppId = process.env["ADMOB_APP_ID"];

    process.env["DB_HOST"] = "127.0.0.1";
    process.env["DB_NAME"] = "facetube_test";
    process.env["DB_USER"] = "test_user";

    const realProdAppId = "ca-app-pub-1234567890123456~1234567890";
    let ledgerInserts: number = 0;
    let walletInserts: number = 0;
    const recordedAppIds: Array<string | null> = [];
    let rolledBack = false;
    let committed = false;
    let getConnectionCalls: number = 0;
    let simulateStatementFailure:
      "none" | "missing_table" | "dup_race" | "not_null_23000" | "fk_23000" = "none";

    const executeQuery = async (sql: string, params: any[] = []) => {
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
      if (sql.includes("SELECT id, user_id, name, email FROM users WHERE UPPER(user_id)")) {
        return [[{ id: "a0000000-0000-0000-0000-000000000002", user_id: targetCreator }]];
      }
      if (sql.includes("FROM admob_monthly_statements WHERE user_id = ? AND report_month = ?")) {
        return [[]];
      }
      if (sql.startsWith("INSERT INTO income_ledger")) {
        ledgerInserts += 1;
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith("INSERT INTO admob_monthly_statements")) {
        if (simulateStatementFailure === "missing_table") {
          const err: any = new Error(
            "Table 'facetube_test.admob_monthly_statements' doesn't exist",
          );
          err.code = "ER_NO_SUCH_TABLE";
          err.errno = 1146;
          throw err;
        }
        if (simulateStatementFailure === "dup_race") {
          const err: any = new Error(
            "Duplicate entry 'FT483921-2026-10' for key 'uniq_admob_statement_user_month'",
          );
          err.code = "ER_DUP_ENTRY";
          err.errno = 1062;
          err.sqlState = "23000";
          throw err;
        }
        if (simulateStatementFailure === "not_null_23000") {
          const err: any = new Error("Column 'verified_by' cannot be null");
          err.code = "ER_BAD_NULL_ERROR";
          err.errno = 1048;
          err.sqlState = "23000";
          throw err;
        }
        if (simulateStatementFailure === "fk_23000") {
          const err: any = new Error(
            "Cannot add or update a child row: a foreign key constraint fails",
          );
          err.code = "ER_NO_REFERENCED_ROW_2";
          err.errno = 1452;
          err.sqlState = "23000";
          throw err;
        }
        recordedAppIds.push(params[7]);
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith("INSERT INTO wallet_balances")) {
        walletInserts += 1;
        return [{ affectedRows: 1 }];
      }
      return [[]];
    };

    const mockPool = {
      query: executeQuery,
      getConnection: async () => {
        getConnectionCalls += 1;
        return {
          beginTransaction: async () => {
            rolledBack = false;
            committed = false;
          },
          query: executeQuery,
          commit: async () => {
            committed = true;
          },
          rollback: async () => {
            rolledBack = true;
          },
          release: () => {},
        };
      },
    };

    setMysqlPoolForTesting(mockPool);

    try {
      // 8a. Fail closed when neither NODE_ENV nor APP_ENV is set and ADMOB_APP_ID is missing
      delete process.env["NODE_ENV"];
      delete process.env["APP_ENV"];
      delete process.env["ADMOB_APP_ID"];
      const unsetEnvRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: targetCreator,
            amount: 100,
            reportMonth: "2026-10",
          }),
        }),
      );
      assert.equal(
        unsetEnvRes?.status,
        500,
        "Fails closed when env mode is unset and ADMOB_APP_ID is missing",
      );
      assert.equal(getConnectionCalls, 0, "Does not start transaction on missing ADMOB_APP_ID");

      // 8b. NODE_ENV=production rejects missing ADMOB_APP_ID before DB transaction
      process.env["NODE_ENV"] = "production";
      const missingConfigRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: targetCreator,
            amount: 100,
            reportMonth: "2026-10",
          }),
        }),
      );
      assert.equal(missingConfigRes?.status, 500);
      assert.equal(getConnectionCalls, 0);

      // 8c. Reject Google reserved test publisher ID (even if explicitly passed or set in ADMOB_APP_ID) & malformed/ad-unit IDs
      for (const badId of [
        "ca-app-pub-3940256099942544~3347511713",
        "ca-app-pub-3940256099942544~9999999999",
        "ca-app-pub-1234567890123456/1234567890",
        "invalid-app-id",
      ]) {
        const badRes = await handleApiRequest(
          new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
              userId: targetCreator,
              amount: 100,
              reportMonth: "2026-10",
              appId: badId,
            }),
          }),
        );
        assert.equal(badRes?.status, 400, `Production rejects invalid/test appId '${badId}'`);
      }

      process.env["ADMOB_APP_ID"] = "ca-app-pub-3940256099942544~3347511713";
      const testEnvIdRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: targetCreator,
            amount: 100,
            reportMonth: "2026-10",
          }),
        }),
      );
      assert.equal(
        testEnvIdRes?.status,
        400,
        "Rejects misconfigured ADMOB_APP_ID containing reserved test publisher ID",
      );
      assert.equal(getConnectionCalls, 0, "Never opens DB transaction for invalid/test App IDs");

      // 8d. Valid production ADMOB_APP_ID resolves when caller omits appId
      process.env["ADMOB_APP_ID"] = realProdAppId;
      const validProdRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: targetCreator,
            amount: 325.5,
            reportMonth: "2026-10",
          }),
        }),
      );
      assert.equal(validProdRes?.status, 201);
      assert.equal(committed, true);
      assert.equal(recordedAppIds[0], realProdAppId);
      assert.equal(walletInserts, 1);

      // 8e. Failure inserting into admob_monthly_statements rolls back income_ledger and skips wallet_balances
      const ledgerBeforeFail = ledgerInserts;
      const walletBeforeFail = walletInserts;
      simulateStatementFailure = "missing_table";
      const stmtFailRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: targetCreator,
            amount: 325.5,
            reportMonth: "2026-11",
          }),
        }),
      );
      assert.equal(
        stmtFailRes?.status,
        500,
        "Returns 500 when monthly statement persistence fails",
      );
      assert.equal(rolledBack, true, "Rolls back transaction when statement insert fails");
      assert.equal(committed, false, "Does not commit transaction on statement failure");
      assert.equal(ledgerInserts, ledgerBeforeFail + 1, "Rolled back ledger attempt");
      assert.equal(
        walletInserts,
        walletBeforeFail,
        "Never updates wallet_balances on statement fail",
      );

      // 8f. Concurrent duplicate key race (ER_DUP_ENTRY / 1062) rolls back and returns 409 Conflict
      simulateStatementFailure = "dup_race";
      const raceDupRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: targetCreator,
            amount: 325.5,
            reportMonth: "2026-10",
          }),
        }),
      );
      assert.equal(raceDupRes?.status, 409, "Returns 409 Conflict on UNIQUE constraint race");
      assert.equal(rolledBack, true, "Rolls back transaction on ER_DUP_ENTRY");
      assert.equal(committed, false, "Never commits on duplicate race");
      assert.equal(walletInserts, walletBeforeFail, "Never credits wallet on duplicate race");

      // 8f-2. Other SQLSTATE 23000 integrity errors (errno 1048 NOT NULL, errno 1452 FK) return 500 after rollback
      for (const failureMode of ["not_null_23000", "fk_23000"] as const) {
        const ledgerBefore23000: number = ledgerInserts;
        const walletBefore23000: number = walletInserts;
        simulateStatementFailure = failureMode;
        const integrityRes = await handleApiRequest(
          new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
              userId: targetCreator,
              amount: 325.5,
              reportMonth: "2026-12",
            }),
          }),
        );
        assert.equal(
          integrityRes?.status,
          500,
          `Non-1062 SQLSTATE 23000 error (${failureMode}) must return HTTP 500, not 409`,
        );
        assert.equal(rolledBack, true, `Rolls back transaction on ${failureMode}`);
        assert.equal(committed, false, `Does not commit transaction on ${failureMode}`);
        assert.equal(ledgerInserts, ledgerBefore23000 + 1, "Attempted ledger insert rolled back");
        assert.equal(walletInserts, walletBefore23000, `Never credits wallet on ${failureMode}`);
      }

      // 8f-3. Fail-closed APP_ENV / NODE_ENV matrix with missing ADMOB_APP_ID
      simulateStatementFailure = "none";
      delete process.env["ADMOB_APP_ID"];
      const envMatrix: Array<{
        appEnv: string | undefined;
        nodeEnv: string | undefined;
        expectedProd: boolean;
        label: string;
      }> = [
        {
          appEnv: "test",
          nodeEnv: undefined,
          expectedProd: false,
          label: "APP_ENV=test, NODE_ENV empty",
        },
        {
          appEnv: undefined,
          nodeEnv: "test",
          expectedProd: false,
          label: "APP_ENV empty, NODE_ENV=test",
        },
        {
          appEnv: "development",
          nodeEnv: "test",
          expectedProd: false,
          label: "APP_ENV=development, NODE_ENV=test",
        },
        {
          appEnv: "staging",
          nodeEnv: "test",
          expectedProd: true,
          label: "APP_ENV=staging, NODE_ENV=test",
        },
        {
          appEnv: "unknown",
          nodeEnv: "development",
          expectedProd: true,
          label: "APP_ENV=unknown, NODE_ENV=development",
        },
        { appEnv: undefined, nodeEnv: undefined, expectedProd: true, label: "Both empty" },
        {
          appEnv: "production",
          nodeEnv: "test",
          expectedProd: true,
          label: "APP_ENV=production, NODE_ENV=test",
        },
        {
          appEnv: "development",
          nodeEnv: "production",
          expectedProd: true,
          label: "APP_ENV=development, NODE_ENV=production",
        },
      ];

      for (const tc of envMatrix) {
        assert.equal(
          isFailClosedProductionEnv(tc.appEnv, tc.nodeEnv),
          tc.expectedProd,
          `isFailClosedProductionEnv mismatch for ${tc.label}`,
        );

        if (tc.appEnv !== undefined) process.env["APP_ENV"] = tc.appEnv;
        else delete process.env["APP_ENV"];
        if (tc.nodeEnv !== undefined) process.env["NODE_ENV"] = tc.nodeEnv;
        else delete process.env["NODE_ENV"];

        const connBefore: number = getConnectionCalls;
        const walletBefore: number = walletInserts;
        const envRes = await handleApiRequest(
          new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
              userId: targetCreator,
              amount: 120,
              reportMonth: "2026-09",
            }),
          }),
        );
        if (tc.expectedProd) {
          assert.equal(envRes?.status, 500, `${tc.label} must fail closed with HTTP 500`);
          assert.equal(getConnectionCalls, connBefore, `${tc.label} must not open DB transaction`);
          assert.equal(walletInserts, walletBefore, `${tc.label} must not credit wallet`);
        } else {
          assert.equal(envRes?.status, 201, `${tc.label} must allow non-production recording`);
          assert.equal(committed, true, `${tc.label} commits atomic transaction`);
          assert.equal(walletInserts, walletBefore + 1, `${tc.label} credits wallet`);
        }
      }

      // 8f-4. Duplicate-key helper & PHP endpoint parity verification
      assert.equal(
        isMysqlDuplicateKeyError({ code: "ER_DUP_ENTRY", errno: 1062, sqlState: "23000" }),
        true,
      );
      assert.equal(isMysqlDuplicateKeyError({ errno: 1062 }), true);
      assert.equal(
        isMysqlDuplicateKeyError({ code: "ER_BAD_NULL_ERROR", errno: 1048, sqlState: "23000" }),
        false,
      );
      assert.equal(
        isMysqlDuplicateKeyError({
          code: "ER_NO_REFERENCED_ROW_2",
          errno: 1452,
          sqlState: "23000",
        }),
        false,
      );
      assert.equal(isMysqlDuplicateKeyError({ sqlState: "23000" }), false);

      const phpSource = fs.readFileSync(
        path.resolve(process.cwd(), "api/admin/record-admob-earning.php"),
        "utf-8",
      );
      assert.ok(
        phpSource.includes("if ($mysqlErrno === 1062)"),
        "PHP endpoint must classify HTTP 409 strictly on MySQL errno 1062",
      );
      assert.ok(
        !phpSource.includes("$sqlState === '23000'"),
        "PHP endpoint must NOT treat generic SQLSTATE 23000 as duplicate-key 409",
      );
      assert.ok(
        phpSource.includes("count($presentEnvs) === 0") &&
          phpSource.includes("!in_array($v, $nonProdEnvs, true)"),
        "PHP endpoint must enforce fail-closed APP_ENV/NODE_ENV validation across every non-empty value",
      );

      // 8g. Migration files & .env.example verification
      const migration20261108 = fs.readFileSync(
        path.resolve(process.cwd(), "database/migrations/20261108_admob_income_foundation.sql"),
        "utf-8",
      );
      assert.ok(
        migration20261108.includes("`app_id` VARCHAR(100) DEFAULT NULL"),
        "20261108 migration must use DEFAULT NULL for app_id",
      );
      assert.ok(
        !migration20261108.includes("3940256099942544"),
        "20261108 migration must not contain Google test App ID",
      );

      const migration20261113 = fs.readFileSync(
        path.resolve(
          process.cwd(),
          "database/migrations/20261113_admob_statements_remove_test_app_id_default.sql",
        ),
        "utf-8",
      );
      assert.ok(migration20261113.includes("INFORMATION_SCHEMA.TABLES"));
      assert.ok(migration20261113.includes("INFORMATION_SCHEMA.COLUMNS"));
      assert.ok(migration20261113.includes("MODIFY COLUMN `app_id` VARCHAR(100) DEFAULT NULL"));

      const envExample = fs.readFileSync(path.resolve(process.cwd(), ".env.example"), "utf-8");
      assert.ok(
        /^ADMOB_APP_ID=$/m.test(envExample),
        ".env.example must define empty ADMOB_APP_ID=",
      );
    } finally {
      setMysqlPoolForTesting(null);
      if (origHost !== undefined) process.env["DB_HOST"] = origHost;
      else delete process.env["DB_HOST"];
      if (origName !== undefined) process.env["DB_NAME"] = origName;
      else delete process.env["DB_NAME"];
      if (origUser !== undefined) process.env["DB_USER"] = origUser;
      else delete process.env["DB_USER"];
      if (origNodeEnv !== undefined) process.env["NODE_ENV"] = origNodeEnv;
      else delete process.env["NODE_ENV"];
      if (origAppEnv !== undefined) process.env["APP_ENV"] = origAppEnv;
      else delete process.env["APP_ENV"];
      if (origAdMobAppId !== undefined) process.env["ADMOB_APP_ID"] = origAdMobAppId;
      else delete process.env["ADMOB_APP_ID"];
    }
  });

  it("9. Android & Client AdMob Configuration: Dev Test IDs, Production Fail-Closed, and Runbook", () => {
    // 9a. Development/test mode preserves official Google test IDs and enables isTesting
    const devConfig = resolveAdMobConfig({
      MODE: "development",
      DEV: true,
      PROD: false,
    });
    assert.equal(devConfig.valid, true);
    assert.equal(devConfig.isProduction, false);
    assert.equal(devConfig.isTesting, true);
    assert.equal(devConfig.appId, ADMOB_TEST_IDS.APP_ID);
    assert.equal(devConfig.bannerAdUnitId, ADMOB_TEST_IDS.BANNER);
    assert.equal(devConfig.interstitialAdUnitId, ADMOB_TEST_IDS.INTERSTITIAL);
    assert.equal(devConfig.rewardedAdUnitId, ADMOB_TEST_IDS.REWARDED);

    const testModeConfig = resolveAdMobConfig({ NODE_ENV: "test" });
    assert.equal(testModeConfig.valid, true);
    assert.equal(testModeConfig.isTesting, true);

    // 9b. Production fails when real AdMob IDs are missing (never falls back to test IDs)
    const missingProdConfig = resolveAdMobConfig({
      MODE: "production",
      PROD: true,
      DEV: false,
    });
    assert.equal(missingProdConfig.valid, false);
    assert.equal(missingProdConfig.isProduction, true);
    assert.equal(missingProdConfig.isTesting, false);
    assert.equal(missingProdConfig.appId, "");
    assert.equal(missingProdConfig.bannerAdUnitId, "");
    assert.throws(() => requireAdMobConfig({ MODE: "production", PROD: true }));

    // Ambiguous / empty env also fails closed
    const emptyEnvConfig = resolveAdMobConfig({});
    assert.equal(emptyEnvConfig.isProduction, true);
    assert.equal(emptyEnvConfig.valid, false);
    assert.equal(emptyEnvConfig.isTesting, false);

    // 9c. Production rejects Google test App ID and test ad unit IDs
    const testAppInProd = resolveAdMobConfig({
      MODE: "production",
      PROD: true,
      VITE_ADMOB_APP_ID: ADMOB_TEST_IDS.APP_ID,
      VITE_ADMOB_BANNER_AD_UNIT_ID: "ca-app-pub-1234567890123456/1111111111",
      VITE_ADMOB_INTERSTITIAL_AD_UNIT_ID: "ca-app-pub-1234567890123456/2222222222",
      VITE_ADMOB_REWARDED_AD_UNIT_ID: "ca-app-pub-1234567890123456/3333333333",
    });
    assert.equal(testAppInProd.valid, false);
    assert.equal(testAppInProd.isTesting, false);
    assert.ok(testAppInProd.error?.includes("test AdMob ID"));

    const testBannerInProd = resolveAdMobConfig({
      MODE: "production",
      PROD: true,
      VITE_ADMOB_APP_ID: "ca-app-pub-1234567890123456~1234567890",
      VITE_ADMOB_BANNER_AD_UNIT_ID: ADMOB_TEST_IDS.BANNER,
      VITE_ADMOB_INTERSTITIAL_AD_UNIT_ID: "ca-app-pub-1234567890123456/2222222222",
      VITE_ADMOB_REWARDED_AD_UNIT_ID: "ca-app-pub-1234567890123456/3333333333",
    });
    assert.equal(testBannerInProd.valid, false);
    assert.ok(testBannerInProd.error?.includes("test AdMob ID"));

    // 9d. Valid real production IDs pass with isTesting disabled
    const validProd = requireAdMobConfig({
      MODE: "production",
      PROD: true,
      VITE_ADMOB_APP_ID: "ca-app-pub-1234567890123456~1234567890",
      VITE_ADMOB_BANNER_AD_UNIT_ID: "ca-app-pub-1234567890123456/1111111111",
      VITE_ADMOB_INTERSTITIAL_AD_UNIT_ID: "ca-app-pub-1234567890123456/2222222222",
      VITE_ADMOB_REWARDED_AD_UNIT_ID: "ca-app-pub-1234567890123456/3333333333",
    });
    assert.equal(validProd.valid, true);
    assert.equal(validProd.isProduction, true);
    assert.equal(validProd.isTesting, false);

    // 9e. AndroidManifest.xml, build.gradle, capacitor.config.ts, and Migration Runbook verification
    const manifest = fs.readFileSync(
      path.resolve(process.cwd(), "android/app/src/main/AndroidManifest.xml"),
      "utf-8",
    );
    assert.ok(
      manifest.includes("${admobApplicationId}"),
      "AndroidManifest.xml must use Gradle placeholder ${admobApplicationId}",
    );
    assert.ok(
      !manifest.includes("3940256099942544"),
      "AndroidManifest.xml must not hardcode Google test App ID",
    );

    const buildGradle = fs.readFileSync(
      path.resolve(process.cwd(), "android/app/build.gradle"),
      "utf-8",
    );
    assert.ok(buildGradle.includes("admobApplicationId"), "build.gradle must inject placeholder");
    assert.ok(
      buildGradle.includes("GradleException"),
      "build.gradle must fail release builds missing valid ADMOB_APP_ID",
    );

    const capConfig = fs.readFileSync(path.resolve(process.cwd(), "capacitor.config.ts"), "utf-8");
    assert.ok(
      !capConfig.includes("initializeForTesting: true"),
      "capacitor.config.ts must not unconditionally hardcode initializeForTesting: true",
    );

    const runbook = fs.readFileSync(
      path.resolve(process.cwd(), "database/ADMOB_MIGRATION_RUNBOOK.md"),
      "utf-8",
    );
    assert.ok(runbook.includes("20261108_admob_income_foundation.sql"));
    assert.ok(runbook.includes("20261112_wallet_balances_admob_income.sql"));
    assert.ok(runbook.includes("20261113_admob_statements_remove_test_app_id_default.sql"));
    assert.ok(runbook.includes("mysqldump"));
  });

  it("10. Production Fail-Closed Guards Without MySQL Pool (503 & Zero Local Store Writes)", async () => {
    const envKeys = [
      "NODE_ENV",
      "APP_ENV",
      "ADMOB_APP_ID",
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

    const envSnapshot: Record<string, string | undefined> = {};
    for (const k of envKeys) {
      envSnapshot[k] = process.env[k];
    }

    const storeExisted = fs.existsSync(storePath);
    const storeSnapshot = storeExisted ? fs.readFileSync(storePath, "utf-8") : null;

    const installStoreFsSpy = () => {
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
    };

    resetInMemoryStore();
    setMysqlPoolForTesting(null);
    for (const k of envKeys) {
      if (k !== "NODE_ENV" && k !== "APP_ENV") {
        delete process.env[k];
      }
    }

    try {
      const cases: Array<{
        label: string;
        procApp?: string | undefined;
        procNode?: string | undefined;
        admobAppId?: string | undefined;
        handlerEnv?: Record<string, string | undefined> | undefined;
        withBearer?: boolean | undefined;
      }> = [
        {
          label: "APP_ENV=production overrides NODE_ENV=development",
          procApp: "production",
          procNode: "development",
          admobAppId: "ca-app-pub-1234567890123456~1234567890",
          withBearer: true,
        },
        {
          label: "NODE_ENV=production without APP_ENV (no Bearer token)",
          procApp: undefined,
          procNode: "production",
          withBearer: false,
        },
        {
          label: "NODE_ENV=production with Bearer token",
          procApp: undefined,
          procNode: "production",
          admobAppId: "ca-app-pub-1234567890123456~1234567890",
          withBearer: true,
        },
        {
          label: "Both APP_ENV and NODE_ENV unset fail closed as production",
          procApp: undefined,
          procNode: undefined,
          withBearer: true,
        },
        {
          label: "Unexpected APP_ENV=staging fails closed with NODE_ENV=test",
          procApp: "staging",
          procNode: "test",
          withBearer: true,
        },
        {
          label: "Unexpected NODE_ENV=qa fails closed with APP_ENV=development",
          procApp: "development",
          procNode: "qa",
          withBearer: true,
        },
        {
          label: "Runtime handler env APP_ENV=production overrides development process.env",
          procApp: "development",
          procNode: "development",
          handlerEnv: {
            APP_ENV: "production",
            NODE_ENV: "development",
            ADMOB_APP_ID: "ca-app-pub-1234567890123456~1234567890",
          },
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

          if (tc.admobAppId === undefined) delete process.env["ADMOB_APP_ID"];
          else process.env["ADMOB_APP_ID"] = tc.admobAppId;

          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (tc.withBearer) {
            headers["Authorization"] = `Bearer ${adminToken}`;
          }

          const res = await handleApiRequest(
            new Request("http://localhost:3000/api/admin/record-admob-earning", {
              method: "POST",
              headers,
              body: JSON.stringify({
                userId: targetCreator,
                amount: 640,
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

      // Preserve development/test local-store fallback when runtime handler env explicitly selects test
      process.env["APP_ENV"] = "production";
      process.env["NODE_ENV"] = "production";
      const fallbackRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-admob-earning", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: targetCreator,
            amount: 640,
            reportMonth: "2026-11",
          }),
        }),
        { APP_ENV: "test", NODE_ENV: "test" },
      );

      assert.ok(fallbackRes);
      assert.equal(fallbackRes.status, 201);
      const fallbackBody = (await fallbackRes.json()) as any;
      assert.equal(fallbackBody.success, true);
      assert.equal(fallbackBody.transactionId, "TX_ADMOB_FT483921_202611");

      const persisted = JSON.parse(fs.readFileSync(storePath, "utf-8"));
      assert.equal(persisted.admobStatements?.["FT483921_2026-11"]?.amount, 640);
    } finally {
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
    }
  });

  it("11. MySQL Connection Acquisition & Rollback Failure Safety", async () => {
    const dbEnvKeys = [
      "NODE_ENV",
      "APP_ENV",
      "ADMOB_APP_ID",
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

    const envSnapshot: Record<string, string | undefined> = {};
    for (const k of dbEnvKeys) {
      envSnapshot[k] = process.env[k];
    }

    const prodEnv = {
      APP_ENV: "production",
      NODE_ENV: "production",
      ADMOB_APP_ID: "ca-app-pub-1234567890123456~1234567890",
    };

    const sessionQuery = async (sql: string) => {
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

    try {
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";

      // 11a. ECONNREFUSED on pool.getConnection() -> 503, zero DB writes
      let econnQueryCalls = 0;
      setMysqlPoolForTesting({
        query: async (sql: string) => {
          econnQueryCalls += 1;
          return sessionQuery(sql);
        },
        getConnection: async () => {
          const err: any = new Error("connect ECONNREFUSED 127.0.0.1:3306");
          err.code = "ECONNREFUSED";
          err.errno = 2003;
          throw err;
        },
      } as any);

      const econnRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-admob-earning", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: targetCreator,
            amount: 550,
            reportMonth: "2026-10",
          }),
        }),
        prodEnv,
      );
      assert.ok(econnRes);
      assert.equal(econnRes.status, 503);
      const econnBody = (await econnRes.json()) as any;
      assert.equal(econnBody.success, false);
      assert.match(econnBody.error || "", /database connection unavailable/i);
      assert.equal(econnQueryCalls, 1, "Zero earning/ledger/wallet queries on ECONNREFUSED");

      // 11b. Unexpected pool.getConnection() error -> 500, zero DB writes
      let unexpectedQueryCalls = 0;
      setMysqlPoolForTesting({
        query: async (sql: string) => {
          unexpectedQueryCalls += 1;
          return sessionQuery(sql);
        },
        getConnection: async () => {
          throw new Error("Unexpected pool driver error");
        },
      } as any);

      const unexpectedRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-admob-earning", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: targetCreator,
            amount: 550,
            reportMonth: "2026-10",
          }),
        }),
        prodEnv,
      );
      assert.ok(unexpectedRes);
      assert.equal(unexpectedRes.status, 500);
      const unexpectedBody = (await unexpectedRes.json()) as any;
      assert.equal(unexpectedBody.success, false);
      assert.match(unexpectedBody.error || "", /failed to acquire database connection/i);
      assert.equal(
        unexpectedQueryCalls,
        1,
        "Zero earning/ledger/wallet queries on unexpected error",
      );

      // 11c. Rollback failure after transaction error (500 and 409) does not mask error and still releases connection
      for (const scenario of [
        { label: "lock timeout", errCode: "ER_LOCK_WAIT_TIMEOUT", errNo: 1205, status: 500 },
        { label: "duplicate key race", errCode: "ER_DUP_ENTRY", errNo: 1062, status: 409 },
      ] as const) {
        let rollbackAttempts = 0;
        let releaseAttempts = 0;
        let committed = false;
        let walletWrites = 0;

        setMysqlPoolForTesting({
          query: sessionQuery,
          getConnection: async () => ({
            beginTransaction: async () => {},
            query: async (sql: string) => {
              if (sql.includes("FROM users WHERE UPPER(user_id)")) {
                return [
                  [
                    {
                      id: "u2",
                      user_id: targetCreator,
                      name: "Alex Rivera",
                      email: "alex@facetube.com",
                    },
                  ],
                ];
              }
              if (sql.startsWith("INSERT INTO income_ledger")) {
                const err: any = new Error(`${scenario.label} failed`);
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
              throw new Error("Rollback transport failure");
            },
            release: () => {
              releaseAttempts += 1;
            },
          }),
        } as any);

        const res = await handleApiRequest(
          new Request("http://localhost:3000/api/admin/record-admob-earning", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
              userId: targetCreator,
              amount: 550,
              reportMonth: "2026-10",
            }),
          }),
          prodEnv,
        );
        assert.ok(res, scenario.label);
        assert.equal(res.status, scenario.status, `${scenario.label}: original status preserved`);
        const body = (await res.json()) as any;
        assert.equal(body.success, false);
        assert.equal(
          String(body.error || "").includes("Rollback transport failure"),
          false,
          `${scenario.label}: rollback failure must not mask original DB error`,
        );
        assert.equal(rollbackAttempts, 1, `${scenario.label}: rollback attempted`);
        assert.equal(releaseAttempts, 1, `${scenario.label}: conn.release() still attempted`);
        assert.equal(committed, false);
        assert.equal(walletWrites, 0);
      }

      // 11d. beginTransaction failure before tx starts skips rollback and still calls conn.release()
      let preTxRollbackAttempts = 0;
      let preTxReleaseAttempts = 0;
      setMysqlPoolForTesting({
        query: sessionQuery,
        getConnection: async () => ({
          beginTransaction: async () => {
            throw new Error("beginTransaction failure");
          },
          query: async () => [[]],
          commit: async () => {},
          rollback: async () => {
            preTxRollbackAttempts += 1;
          },
          release: () => {
            preTxReleaseAttempts += 1;
          },
        }),
      } as any);

      const preTxRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-admob-earning", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: targetCreator,
            amount: 550,
            reportMonth: "2026-10",
          }),
        }),
        prodEnv,
      );
      assert.ok(preTxRes);
      assert.equal(preTxRes.status, 500);
      assert.equal(preTxRollbackAttempts, 0, "Must not call rollback if transaction never started");
      assert.equal(preTxReleaseAttempts, 1, "Must still release acquired connection");
    } finally {
      setMysqlPoolForTesting(null);
      resetInMemoryStore();
      for (const k of dbEnvKeys) {
        if (envSnapshot[k] === undefined) delete process.env[k];
        else process.env[k] = envSnapshot[k];
      }
    }
  });

  it("12. Deterministic Transaction ID & income_ledger Duplicate Protection (Node & PHP Parity)", async () => {
    const dbEnvKeys = [
      "NODE_ENV",
      "APP_ENV",
      "ADMOB_APP_ID",
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

    const envSnapshot: Record<string, string | undefined> = {};
    for (const k of dbEnvKeys) {
      envSnapshot[k] = process.env[k];
    }

    const storeExisted = fs.existsSync(storePath);
    const storeSnapshot = storeExisted ? fs.readFileSync(storePath, "utf-8") : null;

    const prodEnv = {
      APP_ENV: "production",
      NODE_ENV: "production",
      ADMOB_APP_ID: "ca-app-pub-1234567890123456~1234567890",
    };

    try {
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";

      const recordedStatements = new Map<string, { id: number; statement_id: string }>();
      const recordedLedgerByTx = new Map<string, { id: string; transaction_id: string }>();
      let walletCredits = 0;
      let ledgerInserts = 0;
      let rolledBack = false;
      let committed = false;

      const executeQuery = async (sql: string, params: any[] = []) => {
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
          const reqId = String(params[0] || "")
            .trim()
            .toUpperCase();
          if (reqId === "FT483921" || reqId === "FT900431") {
            return [[{ id: `u_${reqId}`, user_id: reqId, name: reqId, email: `${reqId}@ft.test` }]];
          }
          return [[]];
        }
        if (sql.includes("FROM admob_monthly_statements WHERE user_id = ? AND report_month = ?")) {
          const existing = recordedStatements.get(`${params[0]}_${params[1]}`);
          return [existing ? [existing] : []];
        }
        if (
          sql.includes("FROM income_ledger WHERE transaction_id = ?") &&
          sql.includes("FOR UPDATE")
        ) {
          const existing = recordedLedgerByTx.get(String(params[0]));
          return [existing ? [existing] : []];
        }
        if (sql.startsWith("INSERT INTO income_ledger")) {
          ledgerInserts += 1;
          recordedLedgerByTx.set(String(params[1]), {
            id: String(params[0]),
            transaction_id: String(params[1]),
          });
          return [{ affectedRows: 1 }];
        }
        if (sql.startsWith("INSERT INTO admob_monthly_statements")) {
          recordedStatements.set(`${params[1]}_${params[2]}`, {
            id: recordedStatements.size + 1,
            statement_id: String(params[0]),
          });
          return [{ affectedRows: 1 }];
        }
        if (sql.startsWith("INSERT INTO wallet_balances")) {
          walletCredits += Number(params[1] || 0);
          return [{ affectedRows: 1 }];
        }
        return [[]];
      };

      setMysqlPoolForTesting({
        query: executeQuery,
        getConnection: async () => ({
          beginTransaction: async () => {
            rolledBack = false;
            committed = false;
          },
          query: executeQuery,
          commit: async () => {
            committed = true;
          },
          rollback: async () => {
            rolledBack = true;
          },
          release: () => {},
        }),
      } as any);

      // 12a. First submission succeeds with deterministic TX_ADMOB_<CANONICAL_USER_ID>_<YYYYMM>
      const firstRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-admob-earning", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: "ft483921",
            amount: 420,
            reportMonth: "2026-10",
          }),
        }),
        prodEnv,
      );
      assert.ok(firstRes);
      assert.equal(firstRes.status, 201);
      const firstBody = (await firstRes.json()) as any;
      assert.equal(firstBody.success, true);
      assert.equal(firstBody.transactionId, "TX_ADMOB_FT483921_202610");
      assert.equal(committed, true);
      assert.equal(walletCredits, 420);
      assert.equal(ledgerInserts, 1);

      // 12b. Submitting the same creator + same month a second time returns 409 and skips writes
      const secondRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-admob-earning", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: "FT483921",
            amount: 420,
            reportMonth: "2026-10",
          }),
        }),
        prodEnv,
      );
      assert.ok(secondRes);
      assert.equal(secondRes.status, 409);
      assert.equal(rolledBack, true);
      assert.equal(walletCredits, 420);
      assert.equal(ledgerInserts, 1);

      // 12c. Monthly statement record missing/cleared, but income_ledger still has deterministic txId -> 409
      recordedStatements.delete("FT483921_2026-10");
      const ledgerDupRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-admob-earning", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: "FT483921",
            amount: 420,
            reportMonth: "2026-10",
          }),
        }),
        prodEnv,
      );
      assert.ok(ledgerDupRes);
      assert.equal(
        ledgerDupRes.status,
        409,
        "Must block duplicate via income_ledger deterministic TX ID even if monthly statement row is missing",
      );
      const ledgerDupBody = (await ledgerDupRes.json()) as any;
      assert.equal(ledgerDupBody.success, false);
      assert.match(ledgerDupBody.error || "", /duplicate credits blocked/i);
      assert.equal(rolledBack, true);
      assert.equal(committed, false);
      assert.equal(walletCredits, 420);
      assert.equal(ledgerInserts, 1);

      // 12d. Different month for same creator remains eligible
      const diffMonthRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-admob-earning", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: "FT483921",
            amount: 310,
            reportMonth: "2026-11",
          }),
        }),
        prodEnv,
      );
      assert.ok(diffMonthRes);
      assert.equal(diffMonthRes.status, 201);
      const diffMonthBody = (await diffMonthRes.json()) as any;
      assert.equal(diffMonthBody.transactionId, "TX_ADMOB_FT483921_202611");
      assert.equal(walletCredits, 730);
      assert.equal(ledgerInserts, 2);

      // 12e. Different creator for same month remains eligible
      const diffCreatorRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-admob-earning", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: "FT900431",
            amount: 185,
            reportMonth: "2026-10",
          }),
        }),
        prodEnv,
      );
      assert.ok(diffCreatorRes);
      assert.equal(diffCreatorRes.status, 201);
      const diffCreatorBody = (await diffCreatorRes.json()) as any;
      assert.equal(diffCreatorBody.transactionId, "TX_ADMOB_FT900431_202610");
      assert.equal(walletCredits, 915);
      assert.equal(ledgerInserts, 3);

      // 12f. PHP static parity: deterministic TX_ADMOB_<USER>_<YYYYMM> & parameterized income_ledger FOR UPDATE check
      const phpSource = fs.readFileSync(
        path.resolve(process.cwd(), "api/admin/record-admob-earning.php"),
        "utf-8",
      );
      assert.ok(
        phpSource.includes("$txId = 'TX_ADMOB_' . $cleanUserId . '_' . $cleanMonth;"),
        "PHP endpoint must generate deterministic TX_ADMOB_<CANONICAL_USER_ID>_<YYYYMM>",
      );
      assert.ok(
        !/\$txId\s*=.*random_bytes/.test(phpSource),
        "PHP endpoint must not use random_bytes for $txId",
      );
      assert.ok(
        phpSource.includes("FROM income_ledger") &&
          phpSource.includes("WHERE transaction_id = ?") &&
          phpSource.includes("FOR UPDATE") &&
          phpSource.includes("$stmtLedgerDup->execute([$txId])"),
        "PHP endpoint must run parameterized income_ledger FOR UPDATE duplicate check inside transaction",
      );
      assert.ok(
        phpSource.includes("FROM admob_monthly_statements"),
        "PHP endpoint preserves admob_monthly_statements duplicate check",
      );
    } finally {
      setMysqlPoolForTesting(null);
      resetInMemoryStore();
      for (const k of dbEnvKeys) {
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
    }
  });

  it("13. Amount Precision, Impressions/eCPM Validation, Ledger-Wallet Consistency & Write Confirmation Safety", async () => {
    const dbEnvKeys = [
      "NODE_ENV",
      "APP_ENV",
      "ADMOB_APP_ID",
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

    const envSnapshot: Record<string, string | undefined> = {};
    for (const k of dbEnvKeys) {
      envSnapshot[k] = process.env[k];
    }

    const storeExisted = fs.existsSync(storePath);
    const storeSnapshot = storeExisted ? fs.readFileSync(storePath, "utf-8") : null;

    const prodEnv = {
      APP_ENV: "production",
      NODE_ENV: "production",
      ADMOB_APP_ID: "ca-app-pub-1234567890123456~1234567890",
    };

    try {
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";

      const sessionQuery = async (sql: string) => {
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

      // 13a. Direct helper assertions for JS NaN / Infinity / precision / metrics
      for (const rawInvalid of [NaN, Infinity, -Infinity, 0, -1, 0.004, 100.1234, 1e-5]) {
        assert.equal(
          parseValidatedCurrencyAmount(rawInvalid, "AdMob").valid,
          false,
          `Amount helper must reject ${String(rawInvalid)}`,
        );
      }
      for (const rawBadImp of [-1, NaN, Infinity, 12.5, "abc", true]) {
        assert.equal(
          parseValidatedAdMobMetric(rawBadImp, "impressions", {
            integerOnly: true,
            max: 4294967295,
          }).valid,
          false,
          `Impressions helper must reject ${String(rawBadImp)}`,
        );
      }
      for (const rawBadEcpm of [-0.01, NaN, Infinity, "abc", false]) {
        assert.equal(
          parseValidatedAdMobMetric(rawBadEcpm, "ecpm", { integerOnly: false, max: 999999.9999 })
            .valid,
          false,
          `eCPM helper must reject ${String(rawBadEcpm)}`,
        );
      }

      // 13b. Endpoint rejects invalid amounts, impressions, and ecpm with 400 and zero DB calls
      let dbConnCalls = 0;
      setMysqlPoolForTesting({
        query: sessionQuery,
        getConnection: async () => {
          dbConnCalls += 1;
          throw new Error("Should not acquire DB connection on validation failure");
        },
      } as any);

      const invalidPayloads: Array<Record<string, unknown>> = [
        { userId: targetCreator, amount: null, reportMonth: "2026-12" },
        { userId: targetCreator, amount: 0, reportMonth: "2026-12" },
        { userId: targetCreator, amount: -5, reportMonth: "2026-12" },
        { userId: targetCreator, amount: "NaN", reportMonth: "2026-12" },
        { userId: targetCreator, amount: "Infinity", reportMonth: "2026-12" },
        { userId: targetCreator, amount: "-Infinity", reportMonth: "2026-12" },
        { userId: targetCreator, amount: 0.004, reportMonth: "2026-12" },
        { userId: targetCreator, amount: 100.1234, reportMonth: "2026-12" },
        { userId: targetCreator, amount: "19.999", reportMonth: "2026-12" },
        { userId: targetCreator, amount: 100, reportMonth: "2026-12", impressions: -10 },
        { userId: targetCreator, amount: 100, reportMonth: "2026-12", impressions: 12.5 },
        { userId: targetCreator, amount: 100, reportMonth: "2026-12", impressions: "NaN" },
        { userId: targetCreator, amount: 100, reportMonth: "2026-12", ecpm: -1.5 },
        { userId: targetCreator, amount: 100, reportMonth: "2026-12", ecpm: "Infinity" },
        { userId: targetCreator, amount: 100, reportMonth: "2026-12", ecpm: "bad" },
      ];

      for (const payload of invalidPayloads) {
        const res = await handleApiRequest(
          new Request("http://localhost:3000/api/admin/record-admob-earning", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify(payload),
          }),
          prodEnv,
        );
        assert.ok(res);
        assert.equal(res.status, 400, `Expected HTTP 400 for payload ${JSON.stringify(payload)}`);
        const body = (await res.json()) as any;
        assert.equal(body.success, false);
      }
      assert.equal(dbConnCalls, 0, "Zero DB connections opened for invalid inputs");

      // 13c. Valid 2-decimal amounts persist identically across ledger, statement, wallet, response
      for (const validAmount of [0.01, 19.99, 425.75]) {
        const recorded: {
          ledgerAmount?: number;
          stmtGross?: number;
          stmtNet?: number;
          stmtImpressions?: number;
          stmtEcpm?: number;
          walletAmounts?: number[];
          committed: boolean;
        } = { committed: false };

        const executeQuery = async (sql: string, params: any[] = []) => {
          if (sql.includes("FROM sessions s") && sql.includes("JOIN users u")) {
            return sessionQuery(sql);
          }
          if (sql.includes("FROM users WHERE UPPER(user_id)")) {
            return [[{ id: "u2", user_id: targetCreator, name: "Alex Rivera", email: "a@b.c" }]];
          }
          if (sql.startsWith("INSERT INTO income_ledger")) {
            recorded.ledgerAmount = params[3];
            return [{ affectedRows: 1 }];
          }
          if (sql.startsWith("INSERT INTO admob_monthly_statements")) {
            recorded.stmtGross = params[3];
            recorded.stmtNet = params[4];
            recorded.stmtImpressions = params[5];
            recorded.stmtEcpm = params[6];
            return [{ affectedRows: 1 }];
          }
          if (sql.startsWith("INSERT INTO wallet_balances")) {
            recorded.walletAmounts = [params[1], params[2], params[3]];
            return [{ affectedRows: 1 }];
          }
          return [[]];
        };

        setMysqlPoolForTesting({
          query: executeQuery,
          getConnection: async () => ({
            beginTransaction: async () => {},
            query: executeQuery,
            commit: async () => {
              recorded.committed = true;
            },
            rollback: async () => {},
            release: () => {},
          }),
        } as any);

        const res = await handleApiRequest(
          new Request("http://localhost:3000/api/admin/record-admob-earning", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
              userId: targetCreator,
              amount: validAmount,
              reportMonth: "2026-12",
              impressions: 1500,
              ecpm: 13.32,
            }),
          }),
          prodEnv,
        );
        assert.ok(res);
        assert.equal(res.status, 201, `Expected HTTP 201 for valid amount ${validAmount}`);
        const body = (await res.json()) as any;
        assert.equal(body.success, true);
        assert.equal(body.amount, validAmount);
        assert.equal(recorded.committed, true);
        assert.equal(recorded.ledgerAmount, validAmount);
        assert.equal(recorded.stmtGross, validAmount);
        assert.equal(recorded.stmtNet, validAmount);
        assert.equal(recorded.stmtImpressions, 1500);
        assert.equal(recorded.stmtEcpm, 13.32);
        assert.deepEqual(recorded.walletAmounts, [validAmount, validAmount, validAmount]);
      }

      // 13d. affectedRows < 1 triggers rollback + HTTP 500 without committing
      for (const failStage of ["ledger", "statement", "wallet"] as const) {
        let committed = false;
        let rolledBack = false;
        let released = false;
        let walletAttempts = 0;

        const executeQuery = async (sql: string) => {
          if (sql.includes("FROM sessions s") && sql.includes("JOIN users u")) {
            return sessionQuery(sql);
          }
          if (sql.includes("FROM users WHERE UPPER(user_id)")) {
            return [[{ id: "u2", user_id: targetCreator, name: "Alex Rivera", email: "a@b.c" }]];
          }
          if (sql.startsWith("INSERT INTO income_ledger")) {
            return [{ affectedRows: failStage === "ledger" ? 0 : 1 }];
          }
          if (sql.startsWith("INSERT INTO admob_monthly_statements")) {
            return [{ affectedRows: failStage === "statement" ? 0 : 1 }];
          }
          if (sql.startsWith("INSERT INTO wallet_balances")) {
            walletAttempts += 1;
            return [{ affectedRows: failStage === "wallet" ? 0 : 1 }];
          }
          return [[]];
        };

        setMysqlPoolForTesting({
          query: executeQuery,
          getConnection: async () => ({
            beginTransaction: async () => {},
            query: executeQuery,
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
          new Request("http://localhost:3000/api/admin/record-admob-earning", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
              userId: targetCreator,
              amount: 210.5,
              reportMonth: "2026-12",
            }),
          }),
          prodEnv,
        );

        assert.ok(res);
        assert.equal(res.status, 500, `affectedRows=0 at ${failStage} must return HTTP 500`);
        assert.equal(rolledBack, true, `affectedRows=0 at ${failStage} must roll back`);
        assert.equal(committed, false, `affectedRows=0 at ${failStage} must not commit`);
        assert.equal(released, true, `affectedRows=0 at ${failStage} must release connection`);
        if (failStage !== "wallet") {
          assert.equal(walletAttempts, 0, `${failStage} failure must not proceed to wallet write`);
        }
      }

      // 13e. PHP static parity assertions
      const phpSource = fs.readFileSync(
        path.resolve(process.cwd(), "api/admin/record-admob-earning.php"),
        "utf-8",
      );
      assert.ok(
        phpSource.includes("is_finite($parsedAmount)") &&
          phpSource.includes("abs(($parsedAmount * 100) - $scaledAmount) > 1e-6"),
        "PHP AdMob handler must enforce finite 2-decimal amount precision",
      );
      assert.ok(
        phpSource.includes("is_finite($impNum) || $impNum < 0 || floor($impNum) !== $impNum") &&
          phpSource.includes("!is_finite($ecpmNum) || $ecpmNum < 0"),
        "PHP AdMob handler must enforce finite non-negative impressions and ecpm",
      );
      assert.ok(
        phpSource.includes("$stmtLedger->rowCount() < 1") &&
          phpSource.includes("$stmtStmt->rowCount() < 1") &&
          phpSource.includes("$stmtWallet->rowCount() < 1"),
        "PHP AdMob handler must verify rowCount() >= 1 on ledger, statement, and wallet writes",
      );
    } finally {
      setMysqlPoolForTesting(null);
      resetInMemoryStore();
      for (const k of dbEnvKeys) {
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
    }
  });

  it("14. GET Database Error Handling, Safe Responses & Production Fail-Closed Guards", async () => {
    const dbEnvKeys = [
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
    const envSnapshot: Record<string, string | undefined> = {};
    for (const k of dbEnvKeys) {
      envSnapshot[k] = process.env[k];
    }

    const prodEnv = { APP_ENV: "production", NODE_ENV: "production" };
    const sessionQuery = async (sql: string) => {
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

    const origConsoleError = console.error;
    const origReadFileSync = fs.readFileSync;
    const loggedErrors: unknown[] = [];

    try {
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";

      // 14a. Successful GET response format preserved
      const mockStatements = [
        {
          id: 1,
          statement_id: "STMT-ADMOB-202612-FT483921",
          user_id: targetCreator,
          report_month: "2026-12",
          gross_amount: 425.75,
          net_amount: 425.75,
          impressions: 12000,
          ecpm: 35.48,
          app_id: null,
          transaction_id: "TX_ADMOB_FT483921_202612",
          verified_by: "FT102857",
          status: "finalized",
          created_at: "2026-12-01 00:00:00",
        },
      ];
      setMysqlPoolForTesting({
        query: async (sql: string) => {
          if (sql.includes("FROM sessions s")) return sessionQuery(sql);
          if (sql.includes("FROM admob_monthly_statements")) return [mockStatements];
          return [[]];
        },
      } as any);

      const okRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-admob-earning", {
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
        prodEnv,
      );
      assert.equal(okRes?.status, 200);
      const okBody = (await okRes?.json()) as any;
      assert.equal(okBody.success, true);
      assert.equal(okBody.count, 1);
      assert.deepEqual(okBody.statements, mockStatements);

      console.error = (...args: unknown[]) => {
        loggedErrors.push(args);
      };

      // 14b. Connection failure -> 503 with safe redacted message
      setMysqlPoolForTesting({
        query: async (sql: string) => {
          if (sql.includes("FROM sessions s")) return sessionQuery(sql);
          const err: any = new Error(
            "PROTOCOL_CONNECTION_LOST mysql://admin:secretpass@10.1.2.3:3306/prod_db",
          );
          err.code = "PROTOCOL_CONNECTION_LOST";
          err.errno = 2013;
          throw err;
        },
      } as any);

      const connErrRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-admob-earning", {
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
        prodEnv,
      );
      assert.equal(connErrRes?.status, 503);
      const connErrBody = (await connErrRes?.json()) as any;
      assert.equal(connErrBody.success, false);
      assert.equal(
        String(connErrBody.error || "").includes("secretpass") ||
          String(connErrBody.error || "").includes("10.1.2.3") ||
          String(connErrBody.error || "").includes("mysql://"),
        false,
        "Production 503 must not expose credentials or connection strings",
      );

      // 14c. Missing required table or unexpected SQL error -> 500 (never 200 empty array) with safe message
      for (const dbFailure of [
        {
          label: "missing required admob_monthly_statements",
          code: "ER_NO_SUCH_TABLE",
          errno: 1146,
          message: "Table 'prod_db.admob_monthly_statements' doesn't exist",
        },
        {
          label: "unexpected query error",
          code: "ER_SYNTAX_ERROR",
          errno: 1064,
          message: "You have an error in your SQL syntax near secret_internal_col",
        },
      ]) {
        setMysqlPoolForTesting({
          query: async (sql: string) => {
            if (sql.includes("FROM sessions s")) return sessionQuery(sql);
            const err: any = new Error(dbFailure.message);
            err.code = dbFailure.code;
            err.errno = dbFailure.errno;
            throw err;
          },
        } as any);

        const failRes = await handleApiRequest(
          new Request("http://localhost:3000/api/admin/record-admob-earning", {
            headers: { Authorization: `Bearer ${adminToken}` },
          }),
          prodEnv,
        );
        assert.equal(failRes?.status, 500, `${dbFailure.label} must return 500`);
        const failBody = (await failRes?.json()) as any;
        assert.equal(failBody.success, false);
        assert.equal(
          String(failBody.error || "").includes("prod_db") ||
            String(failBody.error || "").includes("SQL syntax") ||
            String(failBody.error || "").includes("secret_internal_col"),
          false,
          `${dbFailure.label}: production 500 must not leak internal DB error details`,
        );
      }

      assert.ok(loggedErrors.length >= 3, "Detailed GET DB errors must be logged server-side");

      // 14d. Production GET without MySQL pool fails closed with 503 and zero local-store fallback
      setMysqlPoolForTesting(null);
      for (const k of dbEnvKeys) {
        if (k !== "NODE_ENV" && k !== "APP_ENV") delete process.env[k];
      }

      let storeReads = 0;
      fs.readFileSync = ((p: fs.PathOrFileDescriptor, options?: any) => {
        if (typeof p === "string" && path.resolve(p) === storePath) {
          storeReads += 1;
        }
        return origReadFileSync(p, options);
      }) as typeof fs.readFileSync;

      const noPoolRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-admob-earning", {
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
        prodEnv,
      );
      assert.equal(noPoolRes?.status, 503);
      const noPoolBody = (await noPoolRes?.json()) as any;
      assert.equal(noPoolBody.success, false);
      assert.match(noPoolBody.error || "", /database connection unavailable/i);
      assert.equal(storeReads, 0, "Production GET must never fall back to local JSON store");

      // 14e. PHP static parity checks for AdMob GET
      const phpSource = origReadFileSync(
        path.resolve(process.cwd(), "api/admin/record-admob-earning.php"),
        "utf-8",
      );
      assert.ok(
        phpSource.includes("error_log('[record-admob-earning.php][GET]") &&
          phpSource.includes("503") &&
          phpSource.includes("500") &&
          !phpSource.includes("Database error loading AdMob statements: ' . $e->getMessage()"),
        "PHP AdMob GET must log errors server-side and return safe 503/500 responses without leaking $e->getMessage()",
      );
    } finally {
      console.error = origConsoleError;
      fs.readFileSync = origReadFileSync;
      setMysqlPoolForTesting(null);
      resetInMemoryStore();
      for (const k of dbEnvKeys) {
        if (envSnapshot[k] === undefined) delete process.env[k];
        else process.env[k] = envSnapshot[k];
      }
    }
  });

  it("15. Task 5J-V4-H PHP AdMob POST Error-Handling Safety (Auth DB 503/500, Tx User Lookup, Safe Rollback & Redacted Responses)", () => {
    const admobPhp = fs.readFileSync(
      path.resolve(process.cwd(), "api/admin/record-admob-earning.php"),
      "utf-8",
    );

    // 1. Auth DB failure distinguished from 401
    assert.ok(
      admobPhp.includes("getAuthUser($pdo, true)") &&
        admobPhp.includes("[record-admob-earning.php][AUTH]"),
      "PHP AdMob must distinguish auth DB failures (503/500) from unauthenticated 401",
    );

    // 2. Target-user lookup inside beginTransaction() & try/catch with 404 rollback
    const beginTxIdx = admobPhp.indexOf("$pdo->beginTransaction();");
    const userLookupIdx = admobPhp.indexOf("FROM users WHERE UPPER(user_id) = UPPER(?)");
    assert.ok(
      beginTxIdx !== -1 && userLookupIdx > beginTxIdx,
      "Users lookup must execute inside beginTransaction()",
    );
    const missingUserIdx = admobPhp.indexOf("if (!$targetUser)");
    assert.ok(missingUserIdx > userLookupIdx);
    const missingUserBlock = admobPhp.slice(missingUserIdx, missingUserIdx + 220);
    assert.ok(
      missingUserBlock.includes("$safeRollback($pdo);") && missingUserBlock.includes("404"),
      "Missing target user must safely roll back and return 404",
    );

    // 3. Safe rollback, Throwable catch, and strict 1062 duplicate classification
    assert.ok(
      admobPhp.includes("$safeRollback = static function (PDO $conn): void") &&
        admobPhp.includes("if ($conn->inTransaction())") &&
        admobPhp.includes("catch (Throwable $_rollbackErr)"),
      "PHP AdMob POST must guard rollback with inTransaction() and absorb rollback failures",
    );
    assert.ok(
      admobPhp.includes("} catch (Throwable $e) {") &&
        admobPhp.includes("if ($mysqlErrno === 1062)"),
      "PHP AdMob POST must catch Throwable and classify duplicates strictly on errno 1062",
    );

    // 4. Sanitized POST responses + server-side logging + 503/500 mapping
    assert.ok(
      !admobPhp.includes("Database error recording AdMob earnings: ' . $e->getMessage()"),
      "PHP AdMob POST must never leak raw $e->getMessage() in JSON responses",
    );
    assert.ok(
      admobPhp.includes(
        "error_log('[record-admob-earning.php][POST] Transaction error: ' . $e->getMessage())",
      ) &&
        admobPhp.includes("$isConnectionUnavailable($e)") &&
        admobPhp.includes("503") &&
        admobPhp.includes("500"),
      "PHP AdMob POST must log DB errors server-side and return safe 503/500 responses",
    );

    // 5. V4-D / V4-E preservation
    assert.ok(
      admobPhp.includes("$txId = 'TX_ADMOB_' . $cleanUserId . '_' . $cleanMonth;") &&
        admobPhp.includes("abs(($parsedAmount * 100) - $scaledAmount) > 1e-6") &&
        admobPhp.includes("$stmtLedger->rowCount() < 1") &&
        admobPhp.includes("$stmtStmt->rowCount() < 1") &&
        admobPhp.includes("$stmtWallet->rowCount() < 1"),
      "Existing V4-D deterministic TX ID and V4-E precision/rowCount validations must remain intact",
    );
  });

  it("16. Task 5J-V4-J PHP AdMob Connection Classification (1203/1042/1053/1129/1927/2026) & Rollback Failure Logging", () => {
    const admobPhp = fs.readFileSync(
      path.resolve(process.cwd(), "api/admin/record-admob-earning.php"),
      "utf-8",
    );
    const responsePhp = fs.readFileSync(path.resolve(process.cwd(), "api/response.php"), "utf-8");

    // 1. AdMob fallback classifier includes errno 1203 and matches shared classifier codes
    const sharedCodeMatch = responsePhp.match(/in_array\(\$driverCode,\s*\[([^\]]+)\],\s*true\)/);
    const admobCodeMatch = admobPhp.match(/in_array\(\$driverCode,\s*\[([^\]]+)\],\s*true\)/);
    assert.ok(sharedCodeMatch?.[1] && admobCodeMatch?.[1]);
    assert.equal(
      admobCodeMatch[1].trim(),
      sharedCodeMatch[1].trim(),
      "AdMob fallback connection-unavailable driverCode list must stay synced with api/response.php",
    );
    assert.ok(
      admobPhp.includes("1203") && admobPhp.includes("max_user_connections"),
      "AdMob fallback classifier must handle MySQL errno 1203 (ER_TOO_MANY_USER_CONNECTIONS)",
    );

    // 2. safeRollback logs server-side via error_log and never leaks rollback details or hides original error
    const rollbackStart = admobPhp.indexOf("$safeRollback = static function");
    const rollbackEnd = admobPhp.indexOf("};", rollbackStart);
    assert.ok(rollbackStart !== -1 && rollbackEnd > rollbackStart);
    const rollbackBlock = admobPhp.slice(rollbackStart, rollbackEnd + 2);
    assert.ok(
      rollbackBlock.includes("error_log('[record-admob-earning.php][ROLLBACK]") &&
        rollbackBlock.includes("$_rollbackErr->getMessage()") &&
        !rollbackBlock.includes("jsonResponse") &&
        !rollbackBlock.includes("throw "),
      "AdMob safeRollback must log rollback failures server-side without throwing or leaking details in JSON",
    );
  });

  it("17. Step 9A: Admin Earnings Report Includes AdMob in User Totals, Summary Totals, CSV Export, Prevents Double Counting & Matches PHP Parity", async () => {
    const rawBackup = fs.existsSync(storePath) ? fs.readFileSync(storePath, "utf-8") : null;
    const origHost = process.env["DB_HOST"];
    const origName = process.env["DB_NAME"];
    const origUser = process.env["DB_USER"];

    const capturedSqls: string[] = [];

    try {
      // 17a. MySQL path: verify SQL queries, per-user admobIncome, summary.totalAdmobIncome, CSV column & no double counting
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";

      setMysqlPoolForTesting({
        query: async (sql: string) => {
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
          if (sql.includes("SELECT COUNT(*) AS total FROM users u")) {
            return [[{ total: 2 }]];
          }
          if (sql.includes("AS total_admob_income")) {
            capturedSqls.push(sql);
            return [
              [
                {
                  total_count: 2,
                  total_wallet_balance: 5130.5,
                  total_earned: 8856.5,
                  total_withdrawn: 3150.0,
                  total_referral_income: 1079.5,
                  total_global_income: 2450.0,
                  total_adsense_income: 1890.2,
                  total_admob_income: 576.0,
                  total_affiliate_income: 940.8,
                },
              ],
            ];
          }
          if (sql.includes("AS admob_income")) {
            capturedSqls.push(sql);
            return [
              [
                {
                  id: "u-1",
                  user_id: "FT483921",
                  name: "Alex Rivera",
                  email: "alex@facetube.com",
                  role: "user",
                  referral_code: "ALEX99",
                  created_at: "2026-01-01 00:00:00",
                  balance: 4706.25,
                  total_earned: 7856.25,
                  total_withdrawn: 3150.0,
                  referral_income: 1079.5,
                  global_income: 2450.0,
                  adsense_income: 1890.2,
                  admob_income: 425.75,
                  affiliate_income: 940.8,
                },
                {
                  id: "u-2",
                  user_id: "FT900431",
                  name: "Sam Creator",
                  email: "sam@facetube.com",
                  role: "user",
                  referral_code: "SAM01",
                  created_at: "2026-01-02 00:00:00",
                  balance: 424.25,
                  total_earned: 1000.25,
                  total_withdrawn: 0.0,
                  referral_income: 0.0,
                  global_income: 0.0,
                  adsense_income: 0.0,
                  admob_income: 150.25,
                  affiliate_income: 0.0,
                },
              ],
            ];
          }
          return [[]];
        },
      } as any);

      const mysqlJsonRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/earnings-report.php", {
          method: "GET",
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
      );
      assert.equal(mysqlJsonRes?.status, 200);
      const mysqlJson = (await mysqlJsonRes?.json()) as any;
      assert.equal(mysqlJson.success, true);
      assert.equal(mysqlJson.summary.totalAdmobIncome, 576.0);
      assert.equal(mysqlJson.users.length, 2);
      assert.equal(mysqlJson.users[0].admobIncome, 425.75);
      assert.equal(mysqlJson.users[1].admobIncome, 150.25);

      assert.equal(capturedSqls.length, 2);
      for (const sql of capturedSqls) {
        assert.match(sql, /income_type\s*=\s*'admob_income'/);
        assert.match(sql, /WHERE\s+status\s*=\s*'settled'/);
        assert.match(
          sql,
          /COALESCE\([^)]*lt\.ledger_admob_income,\s*wb\.admob_income,\s*0(?:\.00)?\)/,
        );
      }

      const mysqlCsvRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/earnings-report.php?export=csv", {
          method: "GET",
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
      );
      assert.equal(mysqlCsvRes?.status, 200);
      const mysqlCsv = (await mysqlCsvRes?.text()) || "";
      const mysqlCsvLines = mysqlCsv.trim().split(/\r?\n/);
      const mysqlHeaderCols = mysqlCsvLines[0]!.replace(/^\uFEFF/, "").split(",");
      const admobColIdx = mysqlHeaderCols.indexOf("AdMob Income (INR)");
      assert.ok(admobColIdx > 0, "MySQL CSV export must contain 'AdMob Income (INR)' header");
      assert.equal(mysqlCsvLines[1]!.split(",")[admobColIdx], "425.75");
      assert.equal(mysqlCsvLines[2]!.split(",")[admobColIdx], "150.25");

      // 17b. Local store path: no double counting & ledger fallback projection excludes pending/failed/unknown
      setMysqlPoolForTesting(null);
      delete process.env["DB_HOST"];
      delete process.env["DB_NAME"];
      delete process.env["DB_USER"];
      if (rawBackup) {
        const store = JSON.parse(rawBackup);
        store.users = Array.isArray(store.users) ? store.users : [];
        store.walletTransactions = Array.isArray(store.walletTransactions)
          ? store.walletTransactions
          : [];
        store.wallets = store.wallets || {};

        // Custom user without store.wallets entry -> exercises derived ledger projection without double counting
        store.users.push({
          id: "u-step9a-proj",
          user_id: "FT_STEP9A_PROJ",
          name: "Step9A Ledger Projection",
          email: "proj9a@facetube.com",
          role: "user",
          referral_code: "PROJ9A",
          created_at: "2026-06-01T00:00:00.000Z",
        });
        delete store.wallets["FT_STEP9A_PROJ"];

        // Existing wallet WITH both store.wallets and matching settled ledger entry -> must NOT double count
        store.users.push({
          id: "u-step9a-wallet",
          user_id: "FT_STEP9A_WALLET",
          name: "Step9A Existing Wallet",
          email: "wallet9a@facetube.com",
          role: "user",
          referral_code: "WALLET9A",
          created_at: "2026-06-02T00:00:00.000Z",
        });
        store.wallets["FT_STEP9A_WALLET"] = {
          balance: 310.5,
          total_earned: 310.5,
          total_withdrawn: 0,
          referral_income: 0,
          global_income: 0,
          adsense_income: 0,
          admob_income: 310.5,
          affiliate_income: 0,
          updated_at: "2026-06-02T00:00:00.000Z",
        };

        store.walletTransactions.push(
          {
            id: "led_9a_proj_admob",
            transaction_id: "TX_9A_PROJ_ADMOB",
            user_id: "FT_STEP9A_PROJ",
            income_type: "admob_income",
            amount: 200.5,
            status: "settled",
            created_at: "2026-06-05T00:00:00.000Z",
          },
          {
            id: "led_9a_proj_ref",
            transaction_id: "TX_9A_PROJ_REF",
            user_id: "FT_STEP9A_PROJ",
            income_type: "referral_income",
            amount: 100.0,
            status: "settled",
            created_at: "2026-06-05T01:00:00.000Z",
          },
          {
            id: "led_9a_proj_pending",
            transaction_id: "TX_9A_PROJ_PENDING",
            user_id: "FT_STEP9A_PROJ",
            income_type: "admob_income",
            amount: 999.0,
            status: "pending",
            created_at: "2026-06-05T02:00:00.000Z",
          },
          {
            id: "led_9a_proj_failed",
            transaction_id: "TX_9A_PROJ_FAILED",
            user_id: "FT_STEP9A_PROJ",
            income_type: "adsense_income",
            amount: 888.0,
            status: "failed",
            created_at: "2026-06-05T03:00:00.000Z",
          },
          {
            id: "led_9a_proj_unknown",
            transaction_id: "TX_9A_PROJ_UNKNOWN",
            user_id: "FT_STEP9A_PROJ",
            income_type: "unrecognized_legacy_type",
            amount: 777.0,
            status: "settled",
            created_at: "2026-06-05T04:00:00.000Z",
          },
          {
            id: "led_9a_wallet_admob",
            transaction_id: "TX_9A_WALLET_ADMOB",
            user_id: "FT_STEP9A_WALLET",
            income_type: "admob_income",
            amount: 310.5,
            status: "settled",
            created_at: "2026-06-05T05:00:00.000Z",
          },
        );
        fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
      }
      resetInMemoryStore();

      const storeJsonRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/earnings-report.php?search=FT_STEP9A_", {
          method: "GET",
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
      );
      assert.equal(storeJsonRes?.status, 200);
      const storeJson = (await storeJsonRes?.json()) as any;
      assert.equal(storeJson.users.length, 2);

      const projUser = storeJson.users.find((u: any) => u.userId === "FT_STEP9A_PROJ");
      const walletUser = storeJson.users.find((u: any) => u.userId === "FT_STEP9A_WALLET");
      assert.ok(projUser && walletUser);
      assert.equal(projUser.admobIncome, 200.5);
      assert.equal(
        projUser.referralIncome,
        100.0,
        "Unknown/AdMob entries must NOT fall into referral",
      );
      assert.equal(projUser.adsenseIncome, 0, "Failed AdSense entry must be excluded");
      assert.equal(projUser.totalEarned, 300.5);

      assert.equal(
        walletUser.admobIncome,
        310.5,
        "Must NOT double count wallet + ledger AdMob income",
      );
      assert.equal(walletUser.totalEarned, 310.5);

      assert.equal(
        storeJson.summary.totalAdmobIncome,
        511.0,
        "Admin summary totalAdmobIncome must equal exact sum across matching users (200.5 + 310.5)",
      );

      const storeCsvRes = await handleApiRequest(
        new Request(
          "http://localhost:3000/api/admin/earnings-report.php?search=FT_STEP9A_&export=csv",
          {
            method: "GET",
            headers: { Authorization: `Bearer ${adminToken}` },
          },
        ),
      );
      assert.equal(storeCsvRes?.status, 200);
      const storeCsv = (await storeCsvRes?.text()) || "";
      const storeCsvLines = storeCsv.trim().split(/\r?\n/);
      const storeHeaderCols = storeCsvLines[0]!.replace(/^\uFEFF/, "").split(",");
      const storeAdmobIdx = storeHeaderCols.indexOf("AdMob Income (INR)");
      assert.ok(storeAdmobIdx > 0, "Store CSV export must contain 'AdMob Income (INR)' header");
      const projCsvRow = storeCsvLines.find((l) => l.includes("FT_STEP9A_PROJ"));
      const walletCsvRow = storeCsvLines.find((l) => l.includes("FT_STEP9A_WALLET"));
      assert.equal(projCsvRow?.split(",")[storeAdmobIdx], "200.50");
      assert.equal(walletCsvRow?.split(",")[storeAdmobIdx], "310.50");

      // 17c. PHP api/admin/earnings-report.php parity assertions
      const reportPhp = fs.readFileSync(
        path.resolve(process.cwd(), "api/admin/earnings-report.php"),
        "utf-8",
      );
      assert.match(
        reportPhp,
        /SUM\(CASE WHEN income_type = 'admob_income' THEN amount ELSE 0 END\)/,
      );
      assert.match(
        reportPhp,
        /COALESCE\(SUM\(COALESCE\(lt\.ledger_admob_income,\s*wb\.admob_income,\s*0\)\),\s*0\)/,
      );
      assert.match(
        reportPhp,
        /round\(floatval\(\$summaryRow\['total_admob_income'\] \?\? 0\),\s*2\)/,
      );
      assert.match(reportPhp, /COALESCE\(lt\.ledger_admob_income,\s*wb\.admob_income,\s*0\.00\)/);
      assert.match(reportPhp, /round\(floatval\(\$r\['admob_income'\]\),\s*2\)/);
      assert.match(reportPhp, /'AdMob Income \(INR\)'/);
      assert.match(
        reportPhp,
        /number_format\(floatval\(\$r\['admob_income'\]\),\s*2,\s*'\.',\s*''\)/,
      );
      assert.match(reportPhp, /WHERE status = 'settled'/);
    } finally {
      setMysqlPoolForTesting(null);
      if (origHost !== undefined) process.env["DB_HOST"] = origHost;
      else delete process.env["DB_HOST"];
      if (origName !== undefined) process.env["DB_NAME"] = origName;
      else delete process.env["DB_NAME"];
      if (origUser !== undefined) process.env["DB_USER"] = origUser;
      else delete process.env["DB_USER"];
      if (rawBackup !== null) {
        fs.writeFileSync(storePath, rawBackup, "utf-8");
      }
      resetInMemoryStore();
    }
  });
});
