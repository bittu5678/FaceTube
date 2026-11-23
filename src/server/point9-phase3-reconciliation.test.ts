import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleApiRequest, resetInMemoryStore } from "./api-handler.ts";
import { setMysqlPoolForTesting } from "./mysql.ts";
import { PRICING_CONFIG, ADS_REFERRAL_RATES, resetPersistentPremiumState } from "./payments.ts";
import { api } from "../lib/api.ts";
import { saveStoredLedger } from "../lib/ledger-service.ts";
import { saveLocalDbUsers } from "../lib/user-service.ts";
import { saveStoredVideos } from "../lib/video-service.ts";
import { getReferralDashboardData } from "../lib/referral-service.ts";

describe("FaceTube Point 9 – Phase 3: Final Reconciliation & Regression Fixes", () => {
  let tmpDataDir = "";
  const origDataDir = process.env["FACETUBE_DATA_DIR"];
  const origStateFile = process.env["FACETUBE_PAYMENT_STATE_FILE"];
  const origNodeEnv = process.env["NODE_ENV"];
  const origAppEnv = process.env["APP_ENV"];
  const origDbHost = process.env["DB_HOST"];
  const origDbName = process.env["DB_NAME"];
  const origDbUser = process.env["DB_USER"];

  function writeIsolatedStore(storeData: Record<string, unknown>): void {
    fs.writeFileSync(
      path.join(tmpDataDir, "facetube_store.json"),
      JSON.stringify(storeData, null, 2),
      "utf-8",
    );
    resetInMemoryStore();
  }

  beforeEach(async () => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-point9-p3-"));
    process.env["FACETUBE_DATA_DIR"] = tmpDataDir;
    process.env["NODE_ENV"] = "test";
    delete process.env["APP_ENV"];
    delete process.env["DB_HOST"];
    delete process.env["DB_NAME"];
    delete process.env["DB_USER"];
    setMysqlPoolForTesting(null);
    await resetPersistentPremiumState(0, []);
    resetInMemoryStore();
  });

  afterEach(() => {
    setMysqlPoolForTesting(null);
    if (origDataDir !== undefined) process.env["FACETUBE_DATA_DIR"] = origDataDir;
    else delete process.env["FACETUBE_DATA_DIR"];
    if (origStateFile !== undefined) process.env["FACETUBE_PAYMENT_STATE_FILE"] = origStateFile;
    else delete process.env["FACETUBE_PAYMENT_STATE_FILE"];
    if (origNodeEnv !== undefined) process.env["NODE_ENV"] = origNodeEnv;
    else delete process.env["NODE_ENV"];
    if (origAppEnv !== undefined) process.env["APP_ENV"] = origAppEnv;
    else delete process.env["APP_ENV"];
    if (origDbHost !== undefined) process.env["DB_HOST"] = origDbHost;
    else delete process.env["DB_HOST"];
    if (origDbName !== undefined) process.env["DB_NAME"] = origDbName;
    else delete process.env["DB_NAME"];
    if (origDbUser !== undefined) process.env["DB_USER"] = origDbUser;
    else delete process.env["DB_USER"];

    resetInMemoryStore();
    if (tmpDataDir && fs.existsSync(tmpDataDir)) {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    }
  });

  describe("1. marketing_income ENUM Fallback Exclusive Ad Boost Classification", () => {
    it("classifies marketing_income + TX_ADS_L*/ADS_REF_L* exclusively as Ad Boost across wallet/transactions, earnings-history, referrals/dashboard, and admin/earnings-report (Store + CSV)", async () => {
      const today = new Date().toISOString().split("T")[0]!;

      writeIsolatedStore({
        users: [
          {
            id: "u-admin",
            user_id: "FT102857",
            name: "Admin",
            email: "admin@facetube.com",
            role: "admin",
            created_at: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "u-earner",
            user_id: "FT888888",
            name: "Mixed Earner",
            email: "mixed@facetube.com",
            role: "user",
            created_at: "2026-01-02T00:00:00.000Z",
          },
          {
            id: "u-down",
            user_id: "FT888889",
            name: "Downline Creator",
            email: "down@facetube.com",
            role: "user",
            referral_code: "FT888888",
            created_at: "2026-01-03T00:00:00.000Z",
          },
        ],
        sessions: {
          tok_admin: "FT102857",
          tok_earner: "FT888888",
        },
        wallets: {
          FT888888: {
            balance: 106.2,
            total_earned: 106.2,
            total_withdrawn: 0,
            referral_income: 86.2,
            global_income: 0,
            adsense_income: 0,
            admob_income: 0,
            affiliate_income: 20.0,
          },
        },
        walletTransactions: [
          // 1. Direct referral (₹1.20)
          {
            id: "tx-dir",
            transaction_id: "TX_REF_pay_dir_1",
            user_id: "FT888888",
            source_user_id: "FT888889",
            income_type: "referral_income",
            amount: 1.2,
            status: "settled",
            created_at: `${today}T08:00:00.000Z`,
          },
          // 2. Ads Promotion recorded using ENUM fallback marketing_income + TX_ADS_L1 + ADS_REF_L1 (₹75.00)
          {
            id: "tx-ads-enum",
            transaction_id: "TX_ADS_L1_pay_ads_fallback",
            user_id: "FT888888",
            source_user_id: "FT888889",
            income_type: "marketing_income",
            special_tag: "ADS_REF_L1",
            amount: 75.0,
            status: "settled",
            created_at: `${today}T09:00:00.000Z`,
          },
          // 3. Ads Promotion with marketing_income + ADS_REF_L2 tag only (₹10.00)
          {
            id: "tx-ads-tag",
            transaction_id: "LEGACY_BOOST_002",
            user_id: "FT888888",
            source_user_id: "FT888889",
            income_type: "marketing_income",
            special_tag: "ADS_REF_L2",
            amount: 10.0,
            status: "settled",
            created_at: `${today}T10:00:00.000Z`,
          },
          // 4. Genuine Affiliate income recorded as marketing_income without TX_ADS_L/ADS_REF_L (₹20.00)
          {
            id: "tx-aff-real",
            transaction_id: "TX_AFF_CONVERSION_001",
            user_id: "FT888888",
            income_type: "marketing_income",
            special_tag: "AFFILIATE_CONV",
            amount: 20.0,
            status: "settled",
            created_at: `${today}T11:00:00.000Z`,
          },
        ],
      });

      // A. wallet/transactions
      const wtRes = await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/transactions.php", {
          headers: { Authorization: "Bearer tok_earner" },
        }),
      );
      assert.equal(wtRes?.status, 200);
      const wtBody = (await wtRes?.json()) as any;
      assert.equal(wtBody.summary.directReferralIncome, 1.2);
      assert.equal(wtBody.summary.adBoostIncome, 85.0);
      assert.equal(wtBody.summary.affiliateIncome, 20.0);
      assert.equal(wtBody.summary.totalEarned, 106.2);

      // B. wallet/earnings-history (7D & 12M)
      for (const period of ["7D", "12M"]) {
        const ehRes = await handleApiRequest(
          new Request(`http://localhost:3000/api/wallet/earnings-history.php?period=${period}`, {
            headers: { Authorization: "Bearer tok_earner" },
          }),
        );
        assert.equal(ehRes?.status, 200);
        const ehBody = (await ehRes?.json()) as any;
        assert.equal(ehBody.summary.referral, 1.2, `${period} referral`);
        assert.equal(ehBody.summary.ad_boost, 85.0, `${period} ad_boost`);
        assert.equal(ehBody.summary.affiliate, 20.0, `${period} affiliate`);
        assert.equal(ehBody.summary.total_revenue, 106.2, `${period} total_revenue`);
      }

      // C. referrals/dashboard
      const refRes = await handleApiRequest(
        new Request("http://localhost:3000/api/referrals/dashboard.php", {
          headers: { Authorization: "Bearer tok_earner" },
        }),
      );
      assert.equal(refRes?.status, 200);
      const refBody = (await refRes?.json()) as any;
      assert.equal(refBody.dashboard.directReferralIncome, 1.2);
      assert.equal(refBody.dashboard.adsPromotionIncome, 85.0);
      assert.equal(refBody.dashboard.totalReferralIncome, 86.2);

      // D. admin/earnings-report JSON & CSV
      const repRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/earnings-report.php?search=FT888888", {
          headers: { Authorization: "Bearer tok_admin" },
        }),
      );
      assert.equal(repRes?.status, 200);
      const repBody = (await repRes?.json()) as any;
      assert.equal(repBody.summary.totalReferralIncome, 1.2);
      assert.equal(repBody.summary.totalAdBoostIncome, 85.0);
      assert.equal(repBody.summary.totalAffiliateIncome, 20.0);
      assert.equal(repBody.users[0].referralIncome, 1.2);
      assert.equal(repBody.users[0].adBoostIncome, 85.0);
      assert.equal(repBody.users[0].affiliateIncome, 20.0);

      const csvRes = await handleApiRequest(
        new Request(
          "http://localhost:3000/api/admin/earnings-report.php?search=FT888888&export=csv",
          {
            headers: { Authorization: "Bearer tok_admin" },
          },
        ),
      );
      assert.equal(csvRes?.status, 200);
      const csvText = await csvRes!.text();
      assert.match(csvText, /,1\.20,85\.00,0\.00,0\.00,0\.00,0\.00,20\.00,/);
    });

    it("enforces exclusive Ad Boost classification in Node MySQL SQL queries and PHP endpoints (no affiliate double-counting)", async () => {
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";

      const capturedSql: string[] = [];
      setMysqlPoolForTesting({
        query: async (sql: string) => {
          const norm = sql.replace(/\s+/g, " ").trim();
          capturedSql.push(norm);
          if (norm.includes("FROM sessions s")) {
            return [[{ id: "u-admin", user_id: "FT102857", name: "Admin", role: "admin" }]];
          }
          if (norm.includes("FROM income_ledger") && norm.includes("ORDER BY created_at DESC")) {
            return [
              [
                {
                  id: "1",
                  transaction_id: "TX_ADS_L1_1",
                  income_type: "marketing_income",
                  special_tag: "ADS_REF_L1",
                  amount: 75,
                },
              ],
            ];
          }
          if (norm.includes("AS total_count")) {
            return [
              [
                {
                  total_count: 1,
                  direct_referral_income: 0,
                  ad_boost_income: 75,
                  pending_referral_income: 0,
                  global_income: 0,
                  adsense_income: 0,
                  admob_income: 0,
                  affiliate_income: 0,
                  total_earned: 75,
                  total_withdrawn: 0,
                },
              ],
            ];
          }
          if (norm.includes("FROM INFORMATION_SCHEMA.COLUMNS")) {
            return [
              [
                {
                  TABLE_NAME: "wallet_balances",
                  COLUMN_NAME: "admob_income",
                  COLUMN_TYPE: "decimal(10,2)",
                },
              ],
            ];
          }
          if (norm.includes("SELECT COUNT(*) AS total FROM users u")) {
            return [[{ total: 0 }]];
          }
          return [[]];
        },
      } as any);

      // wallet/transactions SQL check
      await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/transactions?userId=FT888888", {
          headers: { Authorization: "Bearer tok_mysql" },
        }),
      );
      const wtAggSql = capturedSql.find((s) => s.includes("AS affiliate_income"));
      assert.ok(wtAggSql);
      assert.match(
        wtAggSql,
        /IN \('affiliate_income', 'marketing_income'\) AND UPPER\(COALESCE\(transaction_id, ''\)\) NOT LIKE 'TX\|_ADS\|_L%' ESCAPE '\|' AND UPPER\(COALESCE\(special_tag, ''\)\) NOT LIKE 'ADS\|_REF\|_L%' ESCAPE '\|'/i,
      );

      // wallet/earnings-history 7D & 12M SQL check
      capturedSql.length = 0;
      await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/earnings-history?period=12M", {
          headers: { Authorization: "Bearer tok_mysql" },
        }),
      );
      await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/earnings-history?period=30D", {
          headers: { Authorization: "Bearer tok_mysql" },
        }),
      );
      const ehSqls = capturedSql.filter((s) => s.includes("THEN 'ad_boost_income'"));
      assert.equal(ehSqls.length, 2);
      for (const s of ehSqls) {
        assert.doesNotMatch(
          s,
          /WHEN income_type IN \('referral_income', 'direct_commission'\) AND/i,
        );
        assert.match(
          s,
          /WHEN COALESCE\(income_type, ''\) IN \('ad_boost_income', 'marketing_ads'\) OR UPPER\(COALESCE\(transaction_id, ''\)\) LIKE 'TX\|_ADS\|_L%' ESCAPE '\|'/i,
        );
      }

      // admin/earnings-report SQL check
      capturedSql.length = 0;
      await handleApiRequest(
        new Request("http://localhost:3000/api/admin/earnings-report", {
          headers: { Authorization: "Bearer tok_mysql" },
        }),
      );
      const reportAffSqls = capturedSql.filter((s) => s.includes("AS ledger_affiliate_income"));
      assert.equal(reportAffSqls.length, 2);
      for (const s of reportAffSqls) {
        assert.match(
          s,
          /IN \('affiliate_income', 'marketing_income'\) AND UPPER\(COALESCE\(transaction_id, ''\)\) NOT LIKE 'TX\|_ADS\|_L%' ESCAPE '\|' AND UPPER\(COALESCE\(special_tag, ''\)\) NOT LIKE 'ADS\|_REF\|_L%' ESCAPE '\|'/i,
        );
      }

      // PHP structural verification
      const phpTx = fs.readFileSync(
        path.resolve(process.cwd(), "api/wallet/transactions.php"),
        "utf8",
      );
      const phpHist = fs.readFileSync(
        path.resolve(process.cwd(), "api/wallet/earnings-history.php"),
        "utf8",
      );
      const phpRep = fs.readFileSync(
        path.resolve(process.cwd(), "api/admin/earnings-report.php"),
        "utf8",
      );

      assert.match(
        phpTx,
        /IN \('affiliate_income', 'marketing_income'\)\s+AND UPPER\(COALESCE\(transaction_id, ''\)\) NOT LIKE 'TX\|_ADS\|_L%'/i,
      );
      assert.doesNotMatch(
        phpHist,
        /WHEN income_type IN \("referral_income", "direct_commission"\)\s+AND/i,
      );
      assert.match(
        phpHist,
        /WHEN COALESCE\(income_type, ""\) IN \("ad_boost_income", "marketing_ads"\)\s+OR UPPER\(COALESCE\(transaction_id, ""\)\) LIKE "TX\|_ADS\|_L%"/i,
      );
      assert.match(
        phpRep,
        /IN \('affiliate_income', 'marketing_income'\)\s+AND UPPER\(COALESCE\(transaction_id, ''\)\) NOT LIKE 'TX\|_ADS\|_L%'/i,
      );
    });
  });

  describe("2. Node Admin Settings Explicit Zero Parsing", () => {
    it("preserves explicit 0% for marketing_income_percentage and ads_referral_rate_l1..l7 while falling back cleanly on invalid inputs", async () => {
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";

      setMysqlPoolForTesting({
        query: async (sql: string) => {
          if (sql.includes("FROM sessions s")) {
            return [[{ id: "u-admin", user_id: "FT102857", name: "Admin", role: "admin" }]];
          }
          if (sql.includes("FROM platform_settings")) {
            return [
              [
                { setting_key: "marketing_income_percentage", setting_value: "0" },
                { setting_key: "ads_referral_rate_l1", setting_value: "0" },
                { setting_key: "ads_referral_rate_l2", setting_value: "0.0" },
                { setting_key: "ads_referral_rate_l3", setting_value: "invalid" },
                { setting_key: "ads_referral_rate_l4", setting_value: "" },
                { setting_key: "ads_referral_rate_l5", setting_value: "-5" },
                { setting_key: "ads_referral_rate_l6", setting_value: "120" },
                { setting_key: "ads_referral_rate_l7", setting_value: "2.5" },
              ],
            ];
          }
          return [[]];
        },
      } as any);

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/settings.php", {
          headers: { Authorization: "Bearer tok_admin" },
        }),
      );
      assert.equal(res?.status, 200);
      const body = (await res?.json()) as any;
      assert.equal(body.success, true);
      assert.strictEqual(body.settings.marketing_income_percentage, 0);
      assert.deepEqual(body.settings.ads_referral_rates, {
        1: 0,
        2: 0,
        3: 5, // default preserved for non-finite "invalid"
        4: 4, // default preserved for empty ""
        5: 3, // default preserved for out-of-range -5
        6: 2, // default preserved for out-of-range 120
        7: 2.5, // finite decimal preserved
      });
    });
  });

  describe("3. Referral Dashboard Reconciliation & Deduplication", () => {
    it("deduplicates duplicate ledger entries, supports valid orphans, and reconciles top-level, attributed member sum, and unattributed totals across Store, MySQL, Client fallback, and PHP", async () => {
      // A. Node Store reconciliation + duplicate protection + unattributed handling
      writeIsolatedStore({
        users: [
          { id: "u-sp", user_id: "FT111111", name: "Sponsor", role: "user", referral_code: null },
          {
            id: "u-m1",
            user_id: "FT222222",
            name: "Member 1",
            role: "user",
            referral_code: "FT111111",
          },
        ],
        sessions: { tok_sp: "FT111111" },
        walletTransactions: [
          // Duplicate TX_REF_dup_001 twice (must count ONCE = ₹1.20)
          {
            id: "d1",
            transaction_id: "TX_REF_dup_001",
            user_id: "FT111111",
            source_user_id: "FT222222",
            income_type: "referral_income",
            amount: 1.2,
            status: "settled",
          },
          {
            id: "d2",
            transaction_id: "TX_REF_dup_001",
            user_id: "FT111111",
            source_user_id: "FT222222",
            income_type: "referral_income",
            amount: 1.2,
            status: "settled",
          },
          // Unattributed settled direct referral (empty source_user_id) = ₹2.40
          {
            id: "d3",
            transaction_id: "TX_DIR_UNATTR_002",
            user_id: "FT111111",
            source_user_id: "",
            income_type: "direct_commission",
            amount: 2.4,
            status: "settled",
          },
          // Deleted / non-L1 source user ledger entry = ₹1.20 (cannot be invented onto FT222222!)
          {
            id: "d4",
            transaction_id: "TX_REF_orphan_nonl1",
            user_id: "FT111111",
            source_user_id: "FT_DELETED_999",
            income_type: "referral_income",
            amount: 1.2,
            status: "settled",
          },
        ],
      });

      const storeRes = await handleApiRequest(
        new Request("http://localhost:3000/api/referrals/dashboard.php", {
          headers: { Authorization: "Bearer tok_sp" },
        }),
      );
      assert.equal(storeRes?.status, 200);
      const storeBody = (await storeRes?.json()) as any;
      const sd = storeBody.dashboard;
      assert.equal(sd.members.length, 1);
      assert.equal(sd.members[0].directCommissionEarned, 1.2);
      assert.equal(sd.attributedDirectReferralIncome, 1.2);
      assert.equal(sd.unattributedDirectReferralIncome, 3.6);
      assert.equal(sd.directReferralIncome, 4.8);
      assert.equal(
        Number(
          (sd.attributedDirectReferralIncome + sd.unattributedDirectReferralIncome).toFixed(2),
        ),
        sd.directReferralIncome,
      );

      // B. Node MySQL SQL deduplication + reconciliation
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";

      const capturedSql: string[] = [];
      setMysqlPoolForTesting({
        query: async (sql: string) => {
          const norm = sql.replace(/\s+/g, " ").trim();
          capturedSql.push(norm);
          if (norm.includes("FROM sessions s")) {
            return [[{ id: "u-sp", user_id: "FT111111", name: "Sponsor", role: "user" }]];
          }
          if (norm.includes("FROM users WHERE UPPER(user_id) = UPPER(?)")) {
            return [
              [{ user_id: "FT111111", referral_code: null, mobile: "9000", name: "Sponsor" }],
            ];
          }
          if (norm.includes("FROM users")) {
            return [
              [
                {
                  id: "u-sp",
                  user_id: "FT111111",
                  name: "Sponsor",
                  role: "user",
                  referral_code: null,
                },
                {
                  id: "u-m1",
                  user_id: "FT222222",
                  name: "Member 1",
                  role: "user",
                  referral_code: "FT111111",
                },
              ],
            ];
          }
          if (norm.includes("FROM income_ledger il")) {
            // Simulate duplicate dedup_tx_id row returned by mock & non-L1 source
            return [
              [
                { dedup_tx_id: "TX_REF_DUP_1", member_user_id: "FT222222", direct_commission: 1.2 },
                { dedup_tx_id: "TX_REF_DUP_1", member_user_id: "FT222222", direct_commission: 1.2 },
                { dedup_tx_id: "TX_REF_UNATTR", member_user_id: "", direct_commission: 2.4 },
                {
                  dedup_tx_id: "TX_REF_NONL1",
                  member_user_id: "FT_DELETED_999",
                  direct_commission: 1.2,
                },
              ],
            ];
          }
          if (norm.includes("AS ads_income")) return [[{ ads_income: 15.0 }]];
          if (norm.includes("AS pending_income")) return [[{ pending_income: 0 }]];
          if (norm.includes("FROM uploaded_videos")) return [[]];
          return [[]];
        },
      } as any);

      const mysqlRes = await handleApiRequest(
        new Request("http://localhost:3000/api/referrals/dashboard", {
          headers: { Authorization: "Bearer tok_mysql" },
        }),
      );
      assert.equal(mysqlRes?.status, 200);
      const mysqlBody = (await mysqlRes?.json()) as any;
      const md = mysqlBody.dashboard;
      assert.equal(md.members[0].directCommissionEarned, 1.2);
      assert.equal(md.attributedDirectReferralIncome, 1.2);
      assert.equal(md.unattributedDirectReferralIncome, 3.6);
      assert.equal(md.directReferralIncome, 4.8);
      assert.equal(md.totalReferralIncome, 19.8);

      const directSql = capturedSql.find((s) => s.includes("FROM income_ledger il"));
      assert.ok(directSql);
      assert.match(
        directSql,
        /GROUP BY COALESCE\(NULLIF\(UPPER\(TRIM\(il\.transaction_id\)\), ''\), CONCAT\('ID_', il\.id\)\)/i,
      );
      assert.match(directSql, /MAX\(il\.amount\) AS direct_commission/i);
      assert.match(directSql, /LEFT JOIN payment_transactions pt/i);

      // C. Client offline fallback consistency
      const origDashboard = api.referrals.getDashboard;
      const origTx = api.wallet.getTransactions;
      const hadLS = typeof (globalThis as any).localStorage !== "undefined";
      const prevLS = (globalThis as any).localStorage;
      const memStorage = new Map<string, string>();
      if (!hadLS) {
        (globalThis as any).localStorage = {
          getItem: (k: string) => memStorage.get(k) ?? null,
          setItem: (k: string, v: string) => {
            memStorage.set(k, String(v));
          },
          removeItem: (k: string) => {
            memStorage.delete(k);
          },
          clear: () => memStorage.clear(),
        };
      }
      try {
        api.referrals.getDashboard = async () => {
          throw new Error("Offline");
        };
        api.wallet.getTransactions = async () => {
          throw new Error("Offline");
        };
        saveLocalDbUsers([
          {
            id: "u1",
            user_id: "FT111111",
            name: "Sponsor",
            email: "s@ft.com",
            mobile: "111",
            password_hash: "x",
            referral_code: null,
            created_at: "2026-01-01T00:00:00Z",
            role: "user",
          },
          {
            id: "u2",
            user_id: "FT222222",
            name: "Member 1",
            email: "m@ft.com",
            mobile: "222",
            password_hash: "x",
            referral_code: "FT111111",
            created_at: "2026-01-01T00:00:00Z",
            role: "user",
          },
        ]);
        saveStoredVideos([]);
        saveStoredLedger([
          {
            id: "d1",
            transactionId: "TX_REF_DUP_1",
            userId: "FT111111",
            sourceUserId: "FT222222",
            incomeType: "referral_income",
            amount: 1.2,
            status: "settled",
            description: "Direct",
            createdAt: "2026-01-01T00:00:00Z",
          },
          {
            id: "d2",
            transactionId: "TX_REF_DUP_1",
            userId: "FT111111",
            sourceUserId: "FT222222",
            incomeType: "referral_income",
            amount: 1.2,
            status: "settled",
            description: "Duplicate",
            createdAt: "2026-01-01T00:00:00Z",
          },
          {
            id: "d3",
            transactionId: "TX_DIR_UNATTR",
            userId: "FT111111",
            sourceUserId: "",
            incomeType: "direct_commission",
            amount: 2.4,
            status: "settled",
            description: "Orphan",
            createdAt: "2026-01-01T00:00:00Z",
          },
          {
            id: "d4",
            transactionId: "TX_REF_NONL1",
            userId: "FT111111",
            sourceUserId: "FT_DELETED_999",
            incomeType: "referral_income",
            amount: 1.2,
            status: "settled",
            description: "Non-L1",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ]);
        const clientDash = await getReferralDashboardData("FT111111");
        assert.equal(clientDash.members[0]?.directCommissionEarned, 1.2);
        assert.equal(clientDash.attributedDirectReferralIncome, 1.2);
        assert.equal(clientDash.unattributedDirectReferralIncome, 3.6);
        assert.equal(clientDash.directReferralIncome, 4.8);
      } finally {
        api.referrals.getDashboard = origDashboard;
        api.wallet.getTransactions = origTx;
        saveLocalDbUsers([]);
        saveStoredVideos([]);
        saveStoredLedger([]);
        if (!hadLS) delete (globalThis as any).localStorage;
        else (globalThis as any).localStorage = prevLS;
      }

      // D. PHP source reconciliation assertions
      const phpDash = fs.readFileSync(
        path.resolve(process.cwd(), "api/referrals/dashboard.php"),
        "utf8",
      );
      assert.match(phpDash, /\$attributedDirectReferralIncome/);
      assert.match(phpDash, /\$unattributedDirectReferralIncome/);
      assert.match(
        phpDash,
        /GROUP BY COALESCE\(NULLIF\(UPPER\(TRIM\(il\.transaction_id\)\), ''\), CONCAT\('ID_', il\.id\)\)/i,
      );
    });
  });

  describe("4. Wallet Transactions Fallback Summary (wallet_transactions)", () => {
    it("computes accurate untruncated summary totals across all wallet_transactions fallback rows while paginating", async () => {
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";

      const fallbackRows = [
        {
          id: "wt-1",
          transaction_id: "TX_REF_wt_1",
          user_id: "FT777777",
          type: "referral_income",
          amount: 1.2,
          status: "settled",
          created_at: "2026-02-05T10:00:00.000Z",
        },
        {
          id: "wt-2",
          transaction_id: "TX_ADS_L1_wt_2",
          user_id: "FT777777",
          type: "marketing_income",
          special_tag: "ADS_REF_L1",
          amount: 75.0,
          status: "settled",
          created_at: "2026-02-04T10:00:00.000Z",
        },
        {
          id: "wt-3",
          transaction_id: "TX_GLB_wt_3",
          user_id: "FT777777",
          type: "global_income",
          amount: 30.0,
          status: "settled",
          created_at: "2026-02-03T10:00:00.000Z",
        },
        {
          id: "wt-4",
          transaction_id: "TX_AFF_wt_4",
          user_id: "FT777777",
          type: "marketing_income",
          amount: 10.0,
          status: "settled",
          created_at: "2026-02-02T10:00:00.000Z",
        },
        {
          id: "wt-5",
          transaction_id: "TX_WD_wt_5",
          user_id: "FT777777",
          type: "withdrawal",
          amount: 50.0,
          status: "completed",
          created_at: "2026-02-01T10:00:00.000Z",
        },
      ];

      setMysqlPoolForTesting({
        query: async (sql: string) => {
          const norm = sql.replace(/\s+/g, " ").trim();
          if (norm.includes("FROM sessions s")) {
            return [[{ id: "u-fb", user_id: "FT777777", name: "Fallback Earner", role: "user" }]];
          }
          if (norm.includes("FROM income_ledger")) {
            throw new Error("Table 'facetube.income_ledger' doesn't exist");
          }
          if (norm.includes("FROM wallet_transactions") && norm.includes("LIMIT ? OFFSET ?")) {
            // Page 1 of limit=2 returns only first 2 rows
            return [fallbackRows.slice(0, 2)];
          }
          if (norm.includes("SELECT * FROM wallet_transactions")) {
            // Full fallback query returns all 5 rows
            return [fallbackRows];
          }
          return [[]];
        },
      } as any);

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/transactions.php?page=1&limit=2", {
          headers: { Authorization: "Bearer tok_fb" },
        }),
      );
      assert.equal(res?.status, 200);
      const body = (await res?.json()) as any;
      assert.equal(body.success, true);
      assert.equal(body.transactions.length, 2);
      assert.equal(body.total, 5);
      assert.equal(body.page, 1);
      assert.equal(body.totalPages, 3);
      assert.equal(body.hasMore, true);
      assert.equal(body.summary.totalCount, 5);
      assert.equal(body.summary.directReferralIncome, 1.2);
      assert.equal(body.summary.adBoostIncome, 75.0);
      assert.equal(body.summary.globalIncome, 30.0);
      assert.equal(body.summary.affiliateIncome, 10.0);
      assert.equal(body.summary.totalEarned, 116.2);
      assert.equal(body.summary.totalWithdrawn, 50.0);

      // Verify PHP wallet/transactions.php also summarizes full fallback wallet_transactions rows
      const phpTx = fs.readFileSync(
        path.resolve(process.cwd(), "api/wallet/transactions.php"),
        "utf8",
      );
      assert.match(phpTx, /\$summarizeTransactionRows/);
      assert.match(phpTx, /SELECT \* FROM wallet_transactions \{\$whereLedger\}/);
    });
  });

  describe("5. Financial Constants Integrity Check", () => {
    it("confirms ₹6 Premium split and 7-level Ads Promotion rates remain completely unmodified", () => {
      assert.equal(PRICING_CONFIG.PREMIUM_VIDEO.TOTAL_PRICE, 6);
      assert.equal(PRICING_CONFIG.PREMIUM_VIDEO.REFERRAL_SHARE, 1);
      assert.equal(PRICING_CONFIG.PREMIUM_VIDEO.GLOBAL_POOL_SHARE, 3);
      assert.equal(PRICING_CONFIG.PREMIUM_VIDEO.ADMIN_SHARE, 1);
      assert.equal(PRICING_CONFIG.PREMIUM_VIDEO.GST_AMOUNT, 0.9);
      assert.equal(PRICING_CONFIG.PREMIUM_VIDEO.PG_FEE, 0.1);
      assert.deepEqual(
        ADS_REFERRAL_RATES.map((r) => r.percent),
        [15, 10, 5, 4, 3, 2, 1],
      );
    });
  });
});
