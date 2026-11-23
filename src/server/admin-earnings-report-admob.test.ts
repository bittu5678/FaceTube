import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleApiRequest, resetInMemoryStore, resetStoreForTests } from "./api-handler.ts";
import { setMysqlPoolForTesting } from "./mysql.ts";

const TEST_ENV = {
  APP_ENV: "test",
  NODE_ENV: "test",
  ADMOB_APP_ID: "ca-app-pub-1234567890123456~9876543210",
};

let tempDataDir = "";
let previousDataDir: string | undefined;

async function withMockMysqlPool<T>(mockPool: any, fn: () => Promise<T>): Promise<T> {
  const prevHost = process.env["DB_HOST"];
  const prevName = process.env["DB_NAME"];
  const prevUser = process.env["DB_USER"];
  process.env["DB_HOST"] = "127.0.0.1";
  process.env["DB_NAME"] = "facetube_test";
  process.env["DB_USER"] = "facetube_test";
  setMysqlPoolForTesting(mockPool);
  try {
    return await fn();
  } finally {
    setMysqlPoolForTesting(null);
    if (prevHost === undefined) delete process.env["DB_HOST"];
    else process.env["DB_HOST"] = prevHost;
    if (prevName === undefined) delete process.env["DB_NAME"];
    else process.env["DB_NAME"] = prevName;
    if (prevUser === undefined) delete process.env["DB_USER"];
    else process.env["DB_USER"] = prevUser;
  }
}

async function loginAs(identifier: string, password: string): Promise<string> {
  const res = await handleApiRequest(
    new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier, password }),
    }),
    TEST_ENV,
  );
  assert.equal(res?.status, 200);
  const body = (await res?.json()) as any;
  assert.ok(body?.token, `Expected token for ${identifier}`);
  return body.token;
}

describe("Admin Earnings Report — AdMob Earnings & Total Ad Earnings Integration", () => {
  beforeEach(() => {
    previousDataDir = process.env["FACETUBE_DATA_DIR"];
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-admin-earnings-admob-"));
    process.env["FACETUBE_DATA_DIR"] = tempDataDir;
    resetInMemoryStore();
    resetStoreForTests();
  });

  afterEach(() => {
    setMysqlPoolForTesting(null);
    resetInMemoryStore();
    if (previousDataDir === undefined) {
      delete process.env["FACETUBE_DATA_DIR"];
    } else {
      process.env["FACETUBE_DATA_DIR"] = previousDataDir;
    }
    if (tempDataDir && fs.existsSync(tempDataDir)) {
      fs.rmSync(tempDataDir, { recursive: true, force: true });
    }
  });

  it("1. Aggregates AdMob earnings and reconciles Total Ad Earnings = AdSense + AdMob without non-ad streams", async () => {
    const adminToken = await loginAs("admin@facetube.com", "password123");

    const storePath = path.join(tempDataDir, "facetube_store.json");
    const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
    store.users = [
      ...(store.users || []),
      {
        id: "u-adm-1",
        user_id: "FT_ADM_C1",
        name: "Creator One",
        email: "c1@facetube.com",
        role: "user",
        referral_code: "C1REF",
        created_at: "2026-05-01T10:00:00.000Z",
      },
      {
        id: "u-adm-2",
        user_id: "FT_ADM_C2",
        name: "Creator Two",
        email: "c2@facetube.com",
        role: "user",
        referral_code: "C2REF",
        created_at: "2026-05-10T10:00:00.000Z",
      },
    ];
    store.wallets = {
      ...(store.wallets || {}),
      FT_ADM_C1: {
        balance: 2000.0,
        total_earned: 2500.0,
        total_withdrawn: 500.0,
        referral_income: 1000.0,
        global_income: 500.0,
        adsense_income: 420.5,
        admob_income: 0,
        affiliate_income: 579.5,
        updated_at: "2026-05-01T10:00:00.000Z",
      },
      FT_ADM_C2: {
        balance: 900.0,
        total_earned: 900.0,
        total_withdrawn: 0,
        referral_income: 300.0,
        global_income: 200.0,
        adsense_income: 150.25,
        admob_income: 0,
        affiliate_income: 249.75,
        updated_at: "2026-05-10T10:00:00.000Z",
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf8");
    resetInMemoryStore();

    // Record finalized AdMob statement for Creator One (₹310.75) and Creator Two (₹189.25)
    const rec1 = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          userId: "FT_ADM_C1",
          amount: 310.75,
          reportMonth: "2026-06",
          impressions: 12000,
          ecpm: 25.9,
        }),
      }),
      TEST_ENV,
    );
    assert.equal(rec1?.status, 201);

    const rec2 = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          userId: "FT_ADM_C2",
          amount: 189.25,
          reportMonth: "2026-06",
          impressions: 8000,
          ecpm: 23.66,
        }),
      }),
      TEST_ENV,
    );
    assert.equal(rec2?.status, 201);

    const reportRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/earnings-report.php?search=FT_ADM_", {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      TEST_ENV,
    );
    assert.equal(reportRes?.status, 200);
    const body = (await reportRes?.json()) as any;
    assert.equal(body.success, true);
    assert.equal(body.users.length, 2);

    const c1 = body.users.find((u: any) => u.userId === "FT_ADM_C1");
    const c2 = body.users.find((u: any) => u.userId === "FT_ADM_C2");
    assert.ok(c1 && c2);

    // Per-user reconciliation
    assert.equal(c1.adsenseIncome, 420.5);
    assert.equal(c1.admobIncome, 310.75);
    assert.equal(c1.totalAdEarnings, 731.25);
    assert.equal(c2.adsenseIncome, 150.25);
    assert.equal(c2.admobIncome, 189.25);
    assert.equal(c2.totalAdEarnings, 339.5);

    // Summary reconciliation (excludes Referral, Global Pool, Affiliate, Balance, Total Earned)
    assert.equal(body.summary.totalAdsenseIncome, 570.75);
    assert.equal(body.summary.totalAdmobIncome, 500.0);
    assert.equal(body.summary.totalAdEarnings, 1070.75);
    assert.equal(body.summary.totalReferralIncome, 1300.0);
    assert.equal(body.summary.totalGlobalIncome, 700.0);
    assert.equal(body.summary.totalAffiliateIncome, 829.25);
    assert.equal(body.summary.admobAvailable, true);
    assert.equal(body.summary.admobStatus, "available");
    assert.notEqual(body.summary.totalAdEarnings, body.summary.totalEarned);

    // CSV includes AdMob Income (INR) and Total Ad Earnings (INR)
    const csvRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/earnings-report.php?search=FT_ADM_&export=csv", {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      TEST_ENV,
    );
    assert.equal(csvRes?.status, 200);
    const csvLines = ((await csvRes?.text()) || "").trim().split(/\r?\n/);
    const headerCols = csvLines[0]!.replace(/^\uFEFF/, "").split(",");
    const admobIdx = headerCols.indexOf("AdMob Income (INR)");
    const totalAdIdx = headerCols.indexOf("Total Ad Earnings (INR)");
    assert.ok(admobIdx > 0 && totalAdIdx === admobIdx + 1);
    const c1Csv = csvLines.find((line) => line.includes("FT_ADM_C1"))!.split(",");
    assert.equal(c1Csv[admobIdx], "310.75");
    assert.equal(c1Csv[totalAdIdx], "731.25");
  });

  it("2. Prevents duplicate AdMob credits and deduplicates identical ledger transaction_ids", async () => {
    const adminToken = await loginAs("admin@facetube.com", "password123");

    const storePath = path.join(tempDataDir, "facetube_store.json");
    const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
    store.users = [
      ...(store.users || []),
      {
        id: "u-dup-1",
        user_id: "FT_DUP_TEST",
        name: "Duplicate Guard User",
        email: "duptest@facetube.com",
        role: "user",
        referral_code: "DUP1",
        created_at: "2026-06-01T00:00:00.000Z",
      },
    ];
    delete store.wallets["FT_DUP_TEST"];
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf8");
    resetInMemoryStore();

    // First credit succeeds
    const first = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          userId: "FT_DUP_TEST",
          amount: 250.5,
          reportMonth: "2026-07",
        }),
      }),
      TEST_ENV,
    );
    assert.equal(first?.status, 201);

    // Duplicate same creator + month must fail with 409 Conflict
    const second = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          userId: "FT_DUP_TEST",
          amount: 250.5,
          reportMonth: "2026-07",
        }),
      }),
      TEST_ENV,
    );
    assert.equal(second?.status, 409);

    // Also inject a duplicate ledger transaction row with same transaction_id to test read-side dedup
    const updatedStore = JSON.parse(fs.readFileSync(storePath, "utf8"));
    const admobTx = updatedStore.walletTransactions.find(
      (tx: any) => String(tx.user_id || tx.userId).toUpperCase() === "FT_DUP_TEST",
    );
    assert.ok(admobTx);
    updatedStore.walletTransactions.push({ ...admobTx });
    fs.writeFileSync(storePath, JSON.stringify(updatedStore, null, 2), "utf8");
    resetInMemoryStore();

    const reportRes = await handleApiRequest(
      new Request(
        "http://localhost:3000/api/admin/earnings-report.php?search=FT_DUP_TEST&date_mode=activity&start_date=2026-01-01&end_date=2030-12-31",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${adminToken}` },
        },
      ),
      TEST_ENV,
    );
    assert.equal(reportRes?.status, 200);
    const body = (await reportRes?.json()) as any;
    assert.equal(body.users.length, 1);
    assert.equal(body.users[0].admobIncome, 250.5);
    assert.equal(body.users[0].totalAdEarnings, 250.5);
    assert.equal(body.summary.totalAdmobIncome, 250.5);
  });

  it("3. Applies date_mode=joined and date_mode=activity filters consistently across Store and MySQL", async () => {
    const adminToken = await loginAs("admin@facetube.com", "password123");

    const storePath = path.join(tempDataDir, "facetube_store.json");
    const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
    store.users = [
      ...(store.users || []),
      {
        id: "u-dt-1",
        user_id: "FT_DATE_U1",
        name: "Date Filter User 1",
        email: "date1@facetube.com",
        role: "user",
        referral_code: "DT1",
        created_at: "2026-01-15T00:00:00.000Z",
      },
      {
        id: "u-dt-2",
        user_id: "FT_DATE_U2",
        name: "Date Filter User 2",
        email: "date2@facetube.com",
        role: "user",
        referral_code: "DT2",
        created_at: "2026-06-15T00:00:00.000Z",
      },
    ];
    store.wallets["FT_DATE_U1"] = {
      balance: 900,
      total_earned: 900,
      total_withdrawn: 0,
      referral_income: 100,
      global_income: 0,
      adsense_income: 200,
      admob_income: 600,
      affiliate_income: 0,
      updated_at: "2026-07-05T00:00:00.000Z",
    };
    store.walletTransactions = [
      ...(store.walletTransactions || []),
      {
        id: "led_dt_may_ref",
        transaction_id: "TX_DT_MAY_REF",
        user_id: "FT_DATE_U1",
        income_type: "referral_income",
        amount: 100,
        status: "settled",
        created_at: "2026-05-10T10:00:00.000Z",
      },
      {
        id: "led_dt_jun_admob",
        transaction_id: "TX_ADMOB_FTDATEU1_202606",
        user_id: "FT_DATE_U1",
        income_type: "admob_income",
        amount: 250,
        status: "settled",
        created_at: "2026-06-15T10:00:00.000Z",
      },
      {
        id: "led_dt_jun_adsense",
        transaction_id: "TX_ADSENSE_FTDATEU1_202606",
        user_id: "FT_DATE_U1",
        income_type: "adsense_income",
        amount: 200,
        status: "settled",
        created_at: "2026-06-20T10:00:00.000Z",
      },
      {
        id: "led_dt_jul_admob",
        transaction_id: "TX_ADMOB_FTDATEU1_202607",
        user_id: "FT_DATE_U1",
        income_type: "admob_income",
        amount: 350,
        status: "settled",
        created_at: "2026-07-05T10:00:00.000Z",
      },
    ];
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf8");
    resetInMemoryStore();

    // 3a. Joined date filter matches only FT_DATE_U2 in June 2026
    const joinedRes = await handleApiRequest(
      new Request(
        "http://localhost:3000/api/admin/earnings-report.php?search=FT_DATE_&date_mode=joined&start_date=2026-06-01&end_date=2026-06-30",
        { method: "GET", headers: { Authorization: `Bearer ${adminToken}` } },
      ),
      TEST_ENV,
    );
    assert.equal(joinedRes?.status, 200);
    const joinedBody = (await joinedRes?.json()) as any;
    assert.equal(joinedBody.users.length, 1);
    assert.equal(joinedBody.users[0].userId, "FT_DATE_U2");

    // 3b. Activity date filter for June 2026 returns ONLY June ledger metrics for FT_DATE_U1 (AdMob=250, AdSense=200, TotalAd=450)
    const activityRes = await handleApiRequest(
      new Request(
        "http://localhost:3000/api/admin/earnings-report.php?search=FT_DATE_&date_mode=activity&start_date=2026-06-01&end_date=2026-06-30",
        { method: "GET", headers: { Authorization: `Bearer ${adminToken}` } },
      ),
      TEST_ENV,
    );
    assert.equal(activityRes?.status, 200);
    const activityBody = (await activityRes?.json()) as any;
    assert.equal(activityBody.users.length, 1);
    assert.equal(activityBody.users[0].userId, "FT_DATE_U1");
    assert.equal(activityBody.users[0].admobIncome, 250);
    assert.equal(activityBody.users[0].adsenseIncome, 200);
    assert.equal(activityBody.users[0].totalAdEarnings, 450);
    assert.equal(activityBody.users[0].referralIncome, 0);
    assert.equal(activityBody.summary.totalAdmobIncome, 250);
    assert.equal(activityBody.summary.totalAdEarnings, 450);

    // 3c. Empty window returns zeroed totals cleanly
    const emptyRes = await handleApiRequest(
      new Request(
        "http://localhost:3000/api/admin/earnings-report.php?search=FT_DATE_&date_mode=activity&start_date=2026-08-01&end_date=2026-08-31",
        { method: "GET", headers: { Authorization: `Bearer ${adminToken}` } },
      ),
      TEST_ENV,
    );
    assert.equal(emptyRes?.status, 200);
    const emptyBody = (await emptyRes?.json()) as any;
    assert.equal(emptyBody.users.length, 0);
    assert.equal(emptyBody.summary.totalUsers, 0);
    assert.equal(emptyBody.summary.totalAdmobIncome, 0);
    assert.equal(emptyBody.summary.totalAdEarnings, 0);

    // 3d. MySQL activity filter passes date bounds into both lt subquery and u.user_id filter without wb fallback
    const capturedSqls: Array<{ sql: string; params: any[] }> = [];
    await withMockMysqlPool(
      {
        query: async (sql: string, params: any[] = []) => {
          if (sql.includes("FROM sessions s") && sql.includes("JOIN users u")) {
            return [
              [
                {
                  id: "a0000000-0000-0000-0000-000000000001",
                  user_id: "FT102857",
                  name: "Admin",
                  email: "admin@facetube.com",
                  role: "admin",
                },
              ],
            ];
          }
          if (sql.includes("FROM INFORMATION_SCHEMA.COLUMNS")) {
            return [
              [
                {
                  TABLE_NAME: "wallet_balances",
                  COLUMN_NAME: "admob_income",
                  COLUMN_TYPE: "decimal(14,2)",
                },
                {
                  TABLE_NAME: "income_ledger",
                  COLUMN_NAME: "income_type",
                  COLUMN_TYPE: "enum('referral_income','adsense_income','admob_income')",
                },
              ],
            ];
          }
          if (sql.includes("SELECT COUNT(*) AS total FROM users u")) {
            return [[{ total: 1 }]];
          }
          if (sql.includes("AS total_admob_income") || sql.includes("AS admob_income")) {
            capturedSqls.push({ sql, params });
          }
          return [[]];
        },
      },
      async () => {
        const res = await handleApiRequest(
          new Request(
            "http://localhost:3000/api/admin/earnings-report.php?date_mode=activity&start_date=2026-06-01&end_date=2026-06-30",
            { method: "GET", headers: { Authorization: `Bearer ${adminToken}` } },
          ),
          TEST_ENV,
        );
        assert.equal(res?.status, 200);
      },
    );

    assert.equal(capturedSqls.length, 2);
    for (const entry of capturedSqls) {
      assert.match(entry.sql, /WHERE status = 'settled' AND created_at >= \? AND created_at <= \?/);
      assert.doesNotMatch(entry.sql, /wb\.admob_income/);
      assert.equal(entry.params[0], "2026-06-01 00:00:00");
      assert.equal(entry.params[1], "2026-06-30 23:59:59");
    }
  });

  it("4. Reports unavailable status when AdMob schema is absent and fails closed in production if DB is unavailable", async () => {
    const adminToken = await loginAs("admin@facetube.com", "password123");

    // 4a. Pre-migration schema missing both wallet_balances.admob_income and income_ledger admob_income ENUM
    await withMockMysqlPool(
      {
        query: async (sql: string) => {
          if (sql.includes("FROM sessions s") && sql.includes("JOIN users u")) {
            return [
              [
                {
                  id: "a0000000-0000-0000-0000-000000000001",
                  user_id: "FT102857",
                  name: "Admin",
                  email: "admin@facetube.com",
                  role: "admin",
                },
              ],
            ];
          }
          if (sql.includes("FROM INFORMATION_SCHEMA.COLUMNS")) {
            return [
              [
                {
                  TABLE_NAME: "wallet_balances",
                  COLUMN_NAME: "adsense_income",
                  COLUMN_TYPE: "decimal(14,2)",
                },
                {
                  TABLE_NAME: "income_ledger",
                  COLUMN_NAME: "income_type",
                  COLUMN_TYPE: "enum('referral_income','global_income','adsense_income')",
                },
              ],
            ];
          }
          if (sql.includes("SELECT COUNT(*) AS total FROM users u")) {
            return [[{ total: 1 }]];
          }
          if (sql.includes("AS total_admob_income")) {
            assert.doesNotMatch(sql, /wb\.admob_income/);
            return [
              [
                {
                  total_count: 1,
                  total_wallet_balance: 500,
                  total_earned: 500,
                  total_withdrawn: 0,
                  total_referral_income: 0,
                  total_global_income: 0,
                  total_adsense_income: 300,
                  total_admob_income: 0,
                  total_affiliate_income: 0,
                },
              ],
            ];
          }
          if (sql.includes("AS admob_income")) {
            assert.doesNotMatch(sql, /wb\.admob_income/);
            return [
              [
                {
                  id: "u-pre-1",
                  user_id: "FT_PRE_1",
                  name: "Pre Migration User",
                  email: "pre@facetube.com",
                  role: "user",
                  referral_code: "PRE1",
                  created_at: "2026-01-01 00:00:00",
                  balance: 500,
                  total_earned: 500,
                  total_withdrawn: 0,
                  referral_income: 0,
                  global_income: 0,
                  adsense_income: 300,
                  admob_income: 0,
                  affiliate_income: 0,
                },
              ],
            ];
          }
          return [[]];
        },
      },
      async () => {
        const res = await handleApiRequest(
          new Request("http://localhost:3000/api/admin/earnings-report.php", {
            method: "GET",
            headers: { Authorization: `Bearer ${adminToken}` },
          }),
          TEST_ENV,
        );
        assert.equal(res?.status, 200);
        const json = (await res?.json()) as any;
        assert.equal(json.summary.admobAvailable, false);
        assert.equal(json.summary.admobStatus, "unavailable");
        assert.equal(json.summary.totalAdsenseIncome, 300);

        const csvRes = await handleApiRequest(
          new Request("http://localhost:3000/api/admin/earnings-report.php?export=csv", {
            method: "GET",
            headers: { Authorization: `Bearer ${adminToken}` },
          }),
          TEST_ENV,
        );
        assert.equal(csvRes?.status, 200);
        const csvText = (await csvRes?.text()) || "";
        assert.ok(csvText.includes("Unavailable"));
      },
    );

    // 4b. Fail closed with 503 in production when MySQL pool is absent
    const prodRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/earnings-report.php", {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      { APP_ENV: "production", NODE_ENV: "production" },
    );
    assert.equal(prodRes?.status, 503);
  });

  it("5. Verifies PHP, TypeScript API, and Admin UI parity for AdMob & Total Ad Earnings", () => {
    const phpSource = fs.readFileSync(
      path.resolve(process.cwd(), "api/admin/earnings-report.php"),
      "utf8",
    );
    const adminTsx = fs.readFileSync(path.resolve(process.cwd(), "src/routes/admin.tsx"), "utf8");
    const apiTs = fs.readFileSync(path.resolve(process.cwd(), "src/lib/api.ts"), "utf8");

    assert.match(phpSource, /'totalAdEarnings'\s*=>\s*\$summaryTotalAdEarnings/);
    assert.match(phpSource, /'admobAvailable'\s*=>\s*\$admobAvailable/);
    assert.match(phpSource, /'Total Ad Earnings \(INR\)'/);
    assert.match(phpSource, /INFORMATION_SCHEMA\.COLUMNS/);

    assert.ok(apiTs.includes("totalAdEarnings: number;"));
    assert.ok(apiTs.includes("admobAvailable?: boolean;"));

    assert.ok(adminTsx.includes("Google AdMob Income"));
    assert.ok(adminTsx.includes("Total Ad Earnings"));
    assert.ok(adminTsx.includes("totalAdmobIncome"));
    assert.ok(adminTsx.includes("totalAdEarnings"));
    assert.ok(adminTsx.includes("Unavailable"));
    assert.ok(adminTsx.includes('"AdMob Income (INR)"'));
    assert.ok(adminTsx.includes('"Total Ad Earnings (INR)"'));
  });
});
