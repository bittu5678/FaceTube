import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleApiRequest, resetInMemoryStore } from "./api-handler.ts";
import { setMysqlPoolForTesting } from "./mysql.ts";
import {
  ADS_REFERRAL_RATES,
  PRICING_CONFIG,
  resetPersistentPremiumState,
  verifyServerPayment,
} from "./payments.ts";
import { getUserLedger, getUserWallet } from "../lib/ledger-service.ts";

describe("FaceTube Point 9 – Phase 2: Referral & Earnings Reporting Fixes", () => {
  let tmpDataDir = "";
  const origDataDir = process.env["FACETUBE_DATA_DIR"];
  const origStateFile = process.env["FACETUBE_PAYMENT_STATE_FILE"];
  const origNodeEnv = process.env["NODE_ENV"];
  const origAppEnv = process.env["APP_ENV"];
  const origDbHost = process.env["DB_HOST"];
  const origDbName = process.env["DB_NAME"];
  const origDbUser = process.env["DB_USER"];
  const origRzpSecret = process.env["RAZORPAY_KEY_SECRET"];
  const origRzpKeyId = process.env["RAZORPAY_KEY_ID"];
  const origRzpSkip = process.env["RAZORPAY_SKIP_REMOTE_CHECK"];
  const origFetch = globalThis.fetch;

  const secret = "rzp_test_point9_phase2_secret";
  const keyId = "rzp_test_point9_p2_key";
  const rzpEnv = {
    RAZORPAY_KEY_SECRET: secret,
    RAZORPAY_KEY_ID: keyId,
    RAZORPAY_SKIP_REMOTE_CHECK: "true",
    NODE_ENV: "test",
  };

  function signOrderPayment(orderId: string, paymentId: string): string {
    return crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
  }

  function writeIsolatedStore(storeData: Record<string, unknown>): void {
    fs.writeFileSync(
      path.join(tmpDataDir, "facetube_store.json"),
      JSON.stringify(storeData, null, 2),
      "utf-8",
    );
    resetInMemoryStore();
  }

  beforeEach(async () => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-point9-p2-"));
    process.env["FACETUBE_DATA_DIR"] = tmpDataDir;
    process.env["RAZORPAY_KEY_SECRET"] = secret;
    process.env["RAZORPAY_KEY_ID"] = keyId;
    process.env["RAZORPAY_SKIP_REMOTE_CHECK"] = "true";
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
    globalThis.fetch = origFetch;
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
    if (origRzpSecret !== undefined) process.env["RAZORPAY_KEY_SECRET"] = origRzpSecret;
    else delete process.env["RAZORPAY_KEY_SECRET"];
    if (origRzpKeyId !== undefined) process.env["RAZORPAY_KEY_ID"] = origRzpKeyId;
    else delete process.env["RAZORPAY_KEY_ID"];
    if (origRzpSkip !== undefined) process.env["RAZORPAY_SKIP_REMOTE_CHECK"] = origRzpSkip;
    else delete process.env["RAZORPAY_SKIP_REMOTE_CHECK"];

    resetInMemoryStore();
    if (tmpDataDir && fs.existsSync(tmpDataDir)) {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    }
  });

  describe("1. Referral ledger entries without payment_transactions (LEFT JOIN fix)", () => {
    it("Node Store referrals/dashboard preserves valid settled ledger entries lacking payment_transactions while filtering invalid ones", async () => {
      writeIsolatedStore({
        users: [
          {
            id: "u-sp",
            user_id: "FT111111",
            name: "Sponsor User",
            email: "sponsor@facetube.com",
            mobile: "9000000011",
            role: "user",
            referral_code: null,
            created_at: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "u-m1",
            user_id: "FT222222",
            name: "Member One",
            email: "m1@facetube.com",
            mobile: "9000000022",
            role: "user",
            referral_code: "FT111111",
            created_at: "2026-01-02T00:00:00.000Z",
          },
          {
            id: "u-m2",
            user_id: "FT333333",
            name: "Member Two",
            email: "m2@facetube.com",
            mobile: "9000000033",
            role: "user",
            referral_code: "FT111111",
            created_at: "2026-01-03T00:00:00.000Z",
          },
        ],
        sessions: {
          tok_sponsor: "FT111111",
        },
        wallets: {},
        walletTransactions: [
          // Settled TX_REF_ with NO matching payment_transactions row -> MUST be preserved!
          {
            id: "tx-1",
            transaction_id: "TX_REF_pay_orphan_001",
            user_id: "FT111111",
            source_user_id: "FT222222",
            income_type: "referral_income",
            amount: 1.2,
            status: "settled",
            created_at: "2026-02-01T10:00:00.000Z",
          },
          // Settled direct_commission without TX_REF_ prefix and NO payment_transactions row -> MUST be preserved!
          {
            id: "tx-2",
            transaction_id: "TX_DIR_MANUAL_002",
            user_id: "FT111111",
            source_user_id: "FT333333",
            income_type: "direct_commission",
            amount: 1.2,
            status: "settled",
            created_at: "2026-02-02T10:00:00.000Z",
          },
          // Settled Ads Promotion entry -> MUST NOT pollute directReferralIncome
          {
            id: "tx-3",
            transaction_id: "TX_ADS_L1_pay_ad_003",
            user_id: "FT111111",
            source_user_id: "FT222222",
            income_type: "referral_income",
            special_tag: "ADS_REF_L1",
            amount: 74.85,
            status: "settled",
            created_at: "2026-02-03T10:00:00.000Z",
          },
          // Pending TX_REF_PENDING_ -> MUST NOT count as settled directReferralIncome
          {
            id: "tx-4",
            transaction_id: "TX_REF_PENDING_pay_004",
            user_id: "FT111111",
            source_user_id: "FT222222",
            income_type: "referral_income",
            amount: 1.2,
            status: "pending",
            created_at: "2026-02-04T10:00:00.000Z",
          },
          // Settled TX_REF_ whose matched payment row is an ads_promotion (non-premium) -> MUST be excluded!
          {
            id: "tx-5",
            transaction_id: "TX_REF_pay_wrong_purpose_005",
            user_id: "FT111111",
            source_user_id: "FT222222",
            income_type: "referral_income",
            amount: 99.0,
            status: "settled",
            created_at: "2026-02-05T10:00:00.000Z",
          },
        ],
      });

      // Seed one non-premium payment record for pay_wrong_purpose_005 in persistent payment file
      await resetPersistentPremiumState(1, [
        {
          txNumber: 1,
          paymentId: "pay_wrong_purpose_005",
          orderId: "order_wrong_005",
          videoId: "v5",
          userId: "FT222222",
          userName: "Member One",
          referrerId: "FT111111",
          amount: 499,
          transactionType: "ads_promotion",
          isSpecial: false,
          specialTag: "ADS_PROMOTION",
          referralCommission: 99,
          adminAllocation: 400,
          globalPoolAllocation: 0,
          createdAt: "2026-02-05T10:00:00.000Z",
        },
      ]);

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/referrals/dashboard.php", {
          headers: { Authorization: "Bearer tok_sponsor" },
        }),
      );
      assert.equal(res?.status, 200);
      const body = (await res?.json()) as any;
      assert.equal(body.success, true);
      assert.equal(body.dashboard.directReferralIncome, 2.4);
      assert.equal(body.dashboard.referralIncome, 2.4);
      assert.equal(body.dashboard.adsPromotionIncome, 74.85);
      assert.equal(body.dashboard.pendingReferralIncome, 1.2);
      assert.equal(body.dashboard.totalReferralIncome, 77.25);

      const m1 = body.dashboard.members.find((m: any) => m.userId === "FT222222");
      const m2 = body.dashboard.members.find((m: any) => m.userId === "FT333333");
      assert.equal(m1?.directCommissionEarned, 1.2);
      assert.equal(m2?.directCommissionEarned, 1.2);
    });

    it("Node MySQL referrals/dashboard uses LEFT JOIN payment_transactions and preserves unjoined ledger rows", async () => {
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";

      const seenQueries: string[] = [];
      setMysqlPoolForTesting({
        query: async (sql: string, params?: any[]) => {
          seenQueries.push(sql);
          if (sql.includes("FROM sessions s")) {
            return [
              [
                {
                  id: "u-sp",
                  user_id: "FT111111",
                  name: "Sponsor User",
                  email: "sponsor@facetube.com",
                  mobile: "9000000011",
                  role: "user",
                  referral_code: null,
                  created_at: "2026-01-01T00:00:00.000Z",
                },
              ],
            ];
          }
          if (sql.includes("FROM users WHERE UPPER(user_id) = UPPER(?)")) {
            return [
              [
                {
                  user_id: "FT111111",
                  referral_code: null,
                  mobile: "9000000011",
                  name: "Sponsor User",
                },
              ],
            ];
          }
          if (sql.includes("FROM users")) {
            return [
              [
                {
                  id: "u-sp",
                  user_id: "FT111111",
                  name: "Sponsor User",
                  email: "sponsor@facetube.com",
                  mobile: "9000000011",
                  created_at: "2026-01-01T00:00:00.000Z",
                  role: "user",
                  referral_code: null,
                },
                {
                  id: "u-m1",
                  user_id: "FT222222",
                  name: "Member One",
                  email: "m1@facetube.com",
                  mobile: "9000000022",
                  created_at: "2026-01-02T00:00:00.000Z",
                  role: "user",
                  referral_code: "FT111111",
                },
              ],
            ];
          }
          if (sql.includes("FROM income_ledger il")) {
            assert.match(sql, /LEFT JOIN payment_transactions pt/i);
            assert.doesNotMatch(sql, /INNER JOIN payment_transactions/i);
            assert.match(sql, /pt\.payment_id IS NULL/i);
            // Simulate 2 unjoined direct rows (one attributed to FT222222, one unattributed "")
            return [
              [
                { member_user_id: "FT222222", direct_commission: 1.2 },
                { member_user_id: "", direct_commission: 2.4 },
              ],
            ];
          }
          if (sql.includes("AS ads_income")) {
            return [[{ ads_income: 50.0 }]];
          }
          if (sql.includes("AS pending_income")) {
            return [[{ pending_income: 1.2 }]];
          }
          if (sql.includes("FROM uploaded_videos")) {
            assert.equal(params?.[0], "FT222222");
            return [[{ video_type: "premium", payment_status: "paid", cnt: 1 }]];
          }
          return [[]];
        },
      } as any);

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/referrals/dashboard", {
          headers: { Authorization: "Bearer tok_mysql" },
        }),
      );
      assert.equal(res?.status, 200);
      const body = (await res?.json()) as any;
      assert.equal(body.success, true);
      assert.equal(body.dashboard.directReferralIncome, 3.6);
      assert.equal(body.dashboard.referralIncome, 3.6);
      assert.equal(body.dashboard.adsPromotionIncome, 50.0);
      assert.equal(body.dashboard.pendingReferralIncome, 1.2);
      assert.equal(body.dashboard.members[0].directCommissionEarned, 1.2);
      assert.ok(seenQueries.some((q) => /LEFT JOIN payment_transactions pt/i.test(q)));
    });

    it("PHP api/referrals/dashboard.php uses LEFT JOIN payment_transactions with NULL-safe guards (no INNER JOIN)", () => {
      const phpDashboard = fs.readFileSync(
        path.resolve(process.cwd(), "api/referrals/dashboard.php"),
        "utf8",
      );
      assert.doesNotMatch(phpDashboard, /INNER\s+JOIN\s+payment_transactions/i);
      assert.match(phpDashboard, /LEFT\s+JOIN\s+payment_transactions\s+pt/i);
      assert.match(phpDashboard, /pt\.payment_id\s+IS\s+NULL/i);
      assert.match(phpDashboard, /COALESCE\(il\.transaction_id,\s*''\)/i);
    });
  });

  describe("2. Direct Referral vs Ad Boost Separation & Zero Double-Counting", () => {
    it("wallet/balance separates Direct Referral from Ad Boost in both Node Store and MySQL without double-counting", async () => {
      writeIsolatedStore({
        users: [
          {
            id: "u-sep",
            user_id: "FT555555",
            name: "Separated Earner",
            email: "sep@facetube.com",
            role: "user",
          },
        ],
        sessions: {
          tok_sep: "FT555555",
        },
        wallets: {
          FT555555: {
            balance: 100.0,
            total_earned: 100.0,
            total_withdrawn: 0,
            referral_income: 77.25, // Historical combined wallet bucket before split
            global_income: 10,
            adsense_income: 5,
            admob_income: 2.75,
            affiliate_income: 5,
          },
        },
        walletTransactions: [
          // Duplicate TX_REF_ entry should not double-count
          {
            id: "l1",
            transaction_id: "TX_REF_pay1",
            user_id: "FT555555",
            income_type: "referral_income",
            amount: 1.2,
            status: "settled",
          },
          {
            id: "l1-dup",
            transaction_id: "TX_REF_pay1",
            user_id: "FT555555",
            income_type: "referral_income",
            amount: 1.2,
            status: "settled",
          },
          {
            id: "l2",
            transaction_id: "TX_REF_pay2",
            user_id: "FT555555",
            income_type: "direct_commission",
            amount: 1.2,
            status: "settled",
          },
          // Legacy Ads commission tagged with referral_income + TX_ADS_L1
          {
            id: "l3",
            transaction_id: "TX_ADS_L1_pay3",
            user_id: "FT555555",
            income_type: "referral_income",
            special_tag: "ADS_REF_L1",
            amount: 49.85,
            status: "settled",
          },
          // Canonical ad_boost_income row
          {
            id: "l4",
            transaction_id: "TX_ADS_L2_pay4",
            user_id: "FT555555",
            income_type: "ad_boost_income",
            amount: 25.0,
            status: "settled",
          },
          // Pending entry should not count in settled direct or adBoost
          {
            id: "l5",
            transaction_id: "TX_REF_PENDING_pay5",
            user_id: "FT555555",
            income_type: "referral_income",
            amount: 1.2,
            status: "pending",
          },
        ],
      });

      const storeRes = await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/balance.php", {
          headers: { Authorization: "Bearer tok_sep" },
        }),
      );
      assert.equal(storeRes?.status, 200);
      const storeBody = (await storeRes?.json()) as any;
      assert.equal(storeBody.wallet.directReferralIncome, 2.4);
      assert.equal(storeBody.wallet.referralIncome, 2.4);
      assert.equal(storeBody.wallet.referral_income, 2.4);
      assert.equal(storeBody.wallet.adBoostIncome, 74.85);
      assert.equal(storeBody.wallet.ad_boost_income, 74.85);
      assert.equal(storeBody.wallet.adsPromotionIncome, 74.85);
      assert.equal(storeBody.wallet.totalEarnings, 100);
      assert.equal(storeBody.wallet.total_earned, 100);

      // Now test MySQL mode separation
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";
      setMysqlPoolForTesting({
        query: async (sql: string) => {
          if (sql.includes("FROM sessions s")) {
            return [[{ id: "u-sep", user_id: "FT555555", name: "Separated Earner", role: "user" }]];
          }
          if (sql.includes("FROM wallet_balances")) {
            return [
              [
                {
                  user_id: "FT555555",
                  balance: 100.0,
                  total_earned: 100.0,
                  total_withdrawn: 0,
                  referral_income: 77.25,
                  ad_boost_income: 0,
                  global_income: 10,
                  adsense_income: 5,
                  admob_income: 2.75,
                  affiliate_income: 5,
                  updated_at: "2026-02-01T00:00:00.000Z",
                },
              ],
            ];
          }
          if (sql.includes("AS ledger_direct_referral")) {
            return [
              [
                {
                  ledger_direct_referral: 2.4,
                  ledger_ad_boost: 74.85,
                  ref_row_count: 4,
                },
              ],
            ];
          }
          return [[]];
        },
      } as any);

      const mysqlRes = await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/balance", {
          headers: { Authorization: "Bearer tok_mysql" },
        }),
      );
      assert.equal(mysqlRes?.status, 200);
      const mysqlBody = (await mysqlRes?.json()) as any;
      assert.equal(mysqlBody.wallet.directReferralIncome, 2.4);
      assert.equal(mysqlBody.wallet.referralIncome, 2.4);
      assert.equal(mysqlBody.wallet.adBoostIncome, 74.85);
      assert.equal(mysqlBody.wallet.adsPromotionIncome, 74.85);
    });

    it("Client getUserWallet preserves directReferralIncome and adBoostIncome separation and UI routes separate Referral vs Ad Boost", async () => {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            success: true,
            wallet: {
              user_id: "FT555555",
              balance: 120,
              total_earned: 120,
              total_withdrawn: 0,
              referral_income: 3.6,
              directReferralIncome: 3.6,
              ad_boost_income: 74.85,
              adBoostIncome: 74.85,
              global_income: 20,
              adsense_income: 15,
              admob_income: 6.55,
              affiliate_income: 0,
              updated_at: "2026-02-10T00:00:00.000Z",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as typeof fetch;

      const wallet = await getUserWallet("FT555555");
      assert.equal(wallet.referralIncome, 3.6);
      assert.equal(wallet.directReferralIncome, 3.6);
      assert.equal(wallet.adBoostIncome, 74.85);
      assert.equal(wallet.adsPromotionIncome, 74.85);

      const walletBalanceSrc = fs.readFileSync(
        path.resolve(process.cwd(), "src/routes/wallet-balance.tsx"),
        "utf8",
      );
      assert.match(
        walletBalanceSrc,
        /wallet\.directReferralIncome\s*\?\?\s*wallet\.referralIncome/,
      );
      assert.match(walletBalanceSrc, /Ad Boost Income/);
      assert.match(walletBalanceSrc, /wallet\.adBoostIncome/);

      const phpWalletBalance = fs.readFileSync(
        path.resolve(process.cwd(), "api/wallet/balance.php"),
        "utf8",
      );
      assert.match(phpWalletBalance, /ledger_direct_referral/);
      assert.match(phpWalletBalance, /ledger_ad_boost/);
      assert.match(phpWalletBalance, /adBoostIncome/);
    });
  });

  describe("3. Admin Earnings Report & CSV Reconciliation", () => {
    it("Node MySQL admin/earnings-report handles pre-migration schemas (no ad_boost_income column) and COALESCE NULL guards in JSON & CSV", async () => {
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";

      setMysqlPoolForTesting({
        query: async (sql: string) => {
          if (sql.includes("FROM sessions s")) {
            return [[{ id: "u-admin", user_id: "FT102857", name: "Admin", role: "admin" }]];
          }
          if (sql.includes("FROM INFORMATION_SCHEMA.COLUMNS")) {
            return [
              [
                {
                  TABLE_NAME: "wallet_balances",
                  COLUMN_NAME: "admob_income",
                  COLUMN_TYPE: "decimal(10,2)",
                },
                {
                  TABLE_NAME: "income_ledger",
                  COLUMN_NAME: "income_type",
                  COLUMN_TYPE:
                    "enum('referral_income','global_income','adsense_income','admob_income','withdrawal')",
                },
              ],
            ];
          }
          if (sql.includes("SELECT COUNT(*) AS total FROM users u")) {
            return [[{ total: 1 }]];
          }
          if (sql.includes("AS total_ad_boost_income")) {
            // Confirm NULL-safe expressions and non-existent wb.ad_boost_income omitted when absent in schema
            assert.match(sql, /COALESCE\(income_type,\s*''\)/i);
            assert.match(sql, /COALESCE\(transaction_id,\s*''\)/i);
            assert.match(sql, /UPPER\(TRIM\(lt\.user_id\)\)\s*=\s*UPPER\(TRIM\(u\.user_id\)\)/i);
            assert.doesNotMatch(sql, /wb\.ad_boost_income/i);
            return [
              [
                {
                  total_count: 1,
                  total_wallet_balance: 77.25,
                  total_earned: 77.25,
                  total_withdrawn: 0,
                  total_referral_income: 2.4,
                  total_ad_boost_income: 74.85,
                  total_global_income: 0,
                  total_adsense_income: 0,
                  total_admob_income: 0,
                  total_affiliate_income: 0,
                },
              ],
            ];
          }
          if (sql.includes("AS ad_boost_income")) {
            assert.doesNotMatch(sql, /wb\.ad_boost_income/i);
            return [
              [
                {
                  id: "u1",
                  user_id: "FT555555",
                  name: "Creator Alpha",
                  email: "alpha@facetube.com",
                  role: "user",
                  referral_code: "FT102857",
                  created_at: "2026-02-01T00:00:00.000Z",
                  balance: 77.25,
                  total_earned: 77.25,
                  total_withdrawn: 0,
                  referral_income: 2.4,
                  ad_boost_income: 74.85,
                  global_income: 0,
                  adsense_income: 0,
                  admob_income: 0,
                  affiliate_income: 0,
                },
              ],
            ];
          }
          return [[]];
        },
      } as any);

      const jsonRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/earnings-report", {
          headers: { Authorization: "Bearer tok_admin" },
        }),
      );
      assert.equal(jsonRes?.status, 200);
      const report = (await jsonRes?.json()) as any;
      assert.equal(report.summary.totalReferralIncome, 2.4);
      assert.equal(report.summary.totalAdBoostIncome, 74.85);
      assert.equal(report.users[0].referralIncome, 2.4);
      assert.equal(report.users[0].adBoostIncome, 74.85);

      const csvRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/earnings-report.php?export=csv", {
          headers: { Authorization: "Bearer tok_admin" },
        }),
      );
      assert.equal(csvRes?.status, 200);
      const csvText = await csvRes!.text();
      const lines = csvText.trim().split(/\r?\n/);
      const headers = lines[0]!.replace(/^\uFEFF/, "").split(",");
      const refCol = headers.indexOf("Referral Income (INR)");
      const boostCol = headers.indexOf("Ad Boost Income (INR)");
      assert.ok(refCol >= 0);
      assert.equal(boostCol, refCol + 1);
      const rowCols = lines[1]!.split(",");
      assert.equal(rowCols[refCol], "2.40");
      assert.equal(rowCols[boostCol], "74.85");
    });

    it("Node Store admin/earnings-report CSV & JSON keep Direct Referral and Ad Boost separated without double-counting", async () => {
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
            id: "u-creator",
            user_id: "FT666666",
            name: "Boost Earner",
            email: "boost@facetube.com",
            role: "user",
            created_at: "2026-01-15T00:00:00.000Z",
          },
        ],
        sessions: {
          tok_admin: "FT102857",
        },
        wallets: {
          FT666666: {
            balance: 151.2,
            total_earned: 151.2,
            total_withdrawn: 0,
            referral_income: 151.2,
            global_income: 0,
            adsense_income: 0,
            admob_income: 0,
            affiliate_income: 0,
          },
        },
        walletTransactions: [
          {
            id: "t1",
            transaction_id: "TX_REF_pay_dir",
            user_id: "FT666666",
            income_type: "referral_income",
            amount: 1.2,
            status: "settled",
            created_at: "2026-02-01T00:00:00.000Z",
          },
          {
            id: "t2",
            transaction_id: "TX_ADS_L1_pay_boost",
            user_id: "FT666666",
            income_type: "referral_income",
            special_tag: "ADS_REF_L1",
            amount: 150.0,
            status: "settled",
            created_at: "2026-02-02T00:00:00.000Z",
          },
        ],
      });

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/earnings-report?search=FT666666", {
          headers: { Authorization: "Bearer tok_admin" },
        }),
      );
      assert.equal(res?.status, 200);
      const data = (await res?.json()) as any;
      assert.equal(data.summary.totalReferralIncome, 1.2);
      assert.equal(data.summary.totalAdBoostIncome, 150.0);
      assert.equal(data.summary.totalEarned, 151.2);
      assert.equal(data.users[0].referralIncome, 1.2);
      assert.equal(data.users[0].adBoostIncome, 150.0);

      const csvRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/earnings-report?search=FT666666&export=csv", {
          headers: { Authorization: "Bearer tok_admin" },
        }),
      );
      const csvText = await csvRes!.text();
      assert.match(csvText, /Ad Boost Income \(INR\)/);
      assert.match(csvText, /,1\.20,150\.00,/);

      const phpReport = fs.readFileSync(
        path.resolve(process.cwd(), "api/admin/earnings-report.php"),
        "utf8",
      );
      assert.match(phpReport, /hasWalletAdBoostCol/);
      assert.match(phpReport, /Ad Boost Income \(INR\)/);
      assert.match(phpReport, /COALESCE\(income_type,\s*''\)/i);

      const adminTsx = fs.readFileSync(path.resolve(process.cwd(), "src/routes/admin.tsx"), "utf8");
      assert.match(adminTsx, /totalAdBoostIncome/);
      assert.match(adminTsx, /Ad Boost Income \(INR\)/);
    });
  });

  describe("4. PHP & Node Ads Promotion Commission Settings Audit & Financial Rule Integrity", () => {
    it("preserves exact approved ₹6 Premium split and 7-level Ads Promotion rates (15%, 10%, 5%, 4%, 3%, 2%, 1%)", () => {
      assert.deepEqual(
        {
          TOTAL_PRICE: PRICING_CONFIG.PREMIUM_VIDEO.TOTAL_PRICE,
          BASE_PRICE: PRICING_CONFIG.PREMIUM_VIDEO.BASE_PRICE,
          GST_AMOUNT: PRICING_CONFIG.PREMIUM_VIDEO.GST_AMOUNT,
          PG_FEE: PRICING_CONFIG.PREMIUM_VIDEO.PG_FEE,
          REFERRAL_SHARE: PRICING_CONFIG.PREMIUM_VIDEO.REFERRAL_SHARE,
          GLOBAL_POOL_SHARE: PRICING_CONFIG.PREMIUM_VIDEO.GLOBAL_POOL_SHARE,
          ADMIN_SHARE: PRICING_CONFIG.PREMIUM_VIDEO.ADMIN_SHARE,
        },
        {
          TOTAL_PRICE: 6,
          BASE_PRICE: 5,
          GST_AMOUNT: 0.9,
          PG_FEE: 0.1,
          REFERRAL_SHARE: 1,
          GLOBAL_POOL_SHARE: 3,
          ADMIN_SHARE: 1,
        },
      );
      assert.deepEqual(
        ADS_REFERRAL_RATES.map((r) => [r.level, r.percent]),
        [
          [1, 15],
          [2, 10],
          [3, 5],
          [4, 4],
          [5, 3],
          [6, 2],
          [7, 1],
        ],
      );
    });

    it("reproduces exact audited differences between PHP and Node admin/settings and runtime commission overrides", async () => {
      // 1. Node admin/settings defaults marketing_income_percentage to 15.0 (whereas PHP settings.php defaults to 10.0)
      writeIsolatedStore({
        users: [
          {
            id: "u-admin",
            user_id: "FT102857",
            name: "Admin",
            email: "admin@facetube.com",
            role: "admin",
          },
        ],
        sessions: {
          tok_admin: "FT102857",
        },
      });

      const nodeDefaultRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/settings", {
          headers: { Authorization: "Bearer tok_admin" },
        }),
      );
      assert.equal(nodeDefaultRes?.status, 200);
      const nodeDefaultBody = (await nodeDefaultRes?.json()) as any;
      assert.equal(nodeDefaultBody.settings.marketing_income_percentage, 15.0);
      assert.deepEqual(nodeDefaultBody.settings.ads_referral_rates, {
        "1": 15,
        "2": 10,
        "3": 5,
        "4": 4,
        "5": 3,
        "6": 2,
        "7": 1,
      });

      const phpSettings = fs.readFileSync(
        path.resolve(process.cwd(), "api/admin/settings.php"),
        "utf8",
      );
      assert.match(phpSettings, /'marketing_income_percentage'\s*=>\s*10\.0/);

      // 2. Documented runtime platform_settings behavior:
      // PHP verify.php reads platform_settings (`marketing_income_percentage` + `ads_referral_rate_l1..l7`)
      // and reverts L1 to 15 if sum > 100%, whereas Node MySQL payments/verify uses static ADS_REFERRAL_RATES.
      const phpVerify = fs.readFileSync(
        path.resolve(process.cwd(), "api/payments/verify.php"),
        "utf8",
      );
      assert.match(phpVerify, /FROM\s+platform_settings/);
      assert.match(phpVerify, /ads_referral_rate_l\(\[1-7\]\)/);
      assert.match(phpVerify, /\$totalCommissionSchedule\s*>\s*100\.0/);

      // Zero-value falsy fallback difference in Node admin/settings GET vs PHP floatval/intval
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
                { setting_key: "ads_referral_rate_l2", setting_value: "0" },
              ],
            ];
          }
          return [[]];
        },
      } as any);
      const nodeZeroRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/settings", {
          headers: { Authorization: "Bearer tok_admin" },
        }),
      );
      const nodeZeroBody = (await nodeZeroRes?.json()) as any;
      // Verify explicit 0% settings remain 0 instead of falling back to defaults
      assert.equal(nodeZeroBody.settings.marketing_income_percentage, 0);
      assert.equal(nodeZeroBody.settings.ads_referral_rates["2"], 0);
    });
  });

  describe("5. Wallet Transactions Pagination & Un-Truncated Totals", () => {
    it("computes un-truncated summary totals across 125 transactions while paginating Store and MySQL responses", async () => {
      const txs: any[] = [];
      // 60 direct referral @ ₹1.20 = ₹72.00
      for (let i = 1; i <= 60; i++) {
        txs.push({
          id: `dir-${i}`,
          transaction_id: `TX_REF_p_${i}`,
          user_id: "FT777777",
          income_type: "referral_income",
          amount: 1.2,
          status: "settled",
          created_at: new Date(Date.UTC(2026, 1, 1, 0, i)).toISOString(),
        });
      }
      // 50 ad boost @ ₹15.00 = ₹750.00
      for (let i = 1; i <= 50; i++) {
        txs.push({
          id: `ads-${i}`,
          transaction_id: `TX_ADS_L1_p_${i}`,
          user_id: "FT777777",
          income_type: i % 2 === 0 ? "ad_boost_income" : "referral_income",
          special_tag: "ADS_REF_L1",
          amount: 15.0,
          status: "settled",
          created_at: new Date(Date.UTC(2026, 1, 2, 0, i)).toISOString(),
        });
      }
      // 15 global income @ ₹2.00 = ₹30.00 (Total tx count = 125, Total earned = ₹852.00)
      for (let i = 1; i <= 15; i++) {
        txs.push({
          id: `glb-${i}`,
          transaction_id: `TX_GLB_${i}`,
          user_id: "FT777777",
          income_type: "global_income",
          amount: 2.0,
          status: "settled",
          created_at: new Date(Date.UTC(2026, 1, 3, 0, i)).toISOString(),
        });
      }

      writeIsolatedStore({
        users: [{ id: "u-pag", user_id: "FT777777", name: "Heavy Earner", role: "user" }],
        sessions: {
          tok_pag: "FT777777",
        },
        walletTransactions: txs,
      });

      // Default limit (100) returns page 1 of 100 rows, but summary MUST cover all 125 rows!
      const resDefault = await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/transactions.php", {
          headers: { Authorization: "Bearer tok_pag" },
        }),
      );
      assert.equal(resDefault?.status, 200);
      const bodyDefault = (await resDefault?.json()) as any;
      assert.equal(bodyDefault.transactions.length, 100);
      assert.equal(bodyDefault.total, 125);
      assert.equal(bodyDefault.page, 1);
      assert.equal(bodyDefault.totalPages, 2);
      assert.equal(bodyDefault.hasMore, true);
      assert.equal(bodyDefault.summary.directReferralIncome, 72);
      assert.equal(bodyDefault.summary.adBoostIncome, 750);
      assert.equal(bodyDefault.summary.globalIncome, 30);
      assert.equal(bodyDefault.summary.totalEarned, 852);

      // Page 3 at limit=50 returns final 25 rows with full summary
      const resPage3 = await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/transactions?page=3&limit=50", {
          headers: { Authorization: "Bearer tok_pag" },
        }),
      );
      const bodyPage3 = (await resPage3?.json()) as any;
      assert.equal(bodyPage3.transactions.length, 25);
      assert.equal(bodyPage3.total, 125);
      assert.equal(bodyPage3.totalPages, 3);
      assert.equal(bodyPage3.hasMore, false);
      assert.equal(bodyPage3.summary.directReferralIncome, 72);

      // all=1 returns all 125 rows
      const resAll = await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/transactions?all=1", {
          headers: { Authorization: "Bearer tok_pag" },
        }),
      );
      const bodyAll = (await resAll?.json()) as any;
      assert.equal(bodyAll.transactions.length, 125);
      assert.equal(bodyAll.hasMore, false);

      // MySQL mode with SQL aggregate summary across >50 transactions
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";
      setMysqlPoolForTesting({
        query: async (sql: string) => {
          if (sql.includes("FROM sessions s")) {
            return [[{ id: "u-pag", user_id: "FT777777", name: "Heavy Earner", role: "user" }]];
          }
          if (sql.includes("SELECT * FROM income_ledger")) {
            return [txs.slice(0, 50)];
          }
          if (sql.includes("AS total_count")) {
            return [
              [
                {
                  total_count: 125,
                  direct_referral_income: 72,
                  ad_boost_income: 750,
                  pending_referral_income: 0,
                  global_income: 30,
                  adsense_income: 0,
                  admob_income: 0,
                  affiliate_income: 0,
                  total_earned: 852,
                  total_withdrawn: 0,
                },
              ],
            ];
          }
          return [[]];
        },
      } as any);

      const mysqlPage1 = await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/transactions.php?page=1&limit=50", {
          headers: { Authorization: "Bearer tok_mysql" },
        }),
      );
      const mysqlBody = (await mysqlPage1?.json()) as any;
      assert.equal(mysqlBody.transactions.length, 50);
      assert.equal(mysqlBody.total, 125);
      assert.equal(mysqlBody.totalPages, 3);
      assert.equal(mysqlBody.hasMore, true);
      assert.equal(mysqlBody.summary.directReferralIncome, 72);
      assert.equal(mysqlBody.summary.adBoostIncome, 750);

      // Verify PHP wallet/transactions.php supports pagination + full SQL aggregate summary
      const phpTx = fs.readFileSync(
        path.resolve(process.cwd(), "api/wallet/transactions.php"),
        "utf8",
      );
      assert.match(phpTx, /totalPages/);
      assert.match(phpTx, /hasMore/);
      assert.match(phpTx, /direct_referral_income/);
      assert.match(phpTx, /ad_boost_income/);
    });

    it("client getUserLedger retrieves all paginated batches without stopping at 50/100 and terminates cleanly on simple single-page mocks", async () => {
      let calls = 0;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        calls += 1;
        const url = String(input);
        const page = url.includes("page=2") ? 2 : 1;
        if (page === 1) {
          return new Response(
            JSON.stringify({
              success: true,
              page: 1,
              totalPages: 2,
              hasMore: true,
              transactions: [
                {
                  id: "1",
                  transaction_id: "TX_REF_A",
                  user_id: "FT777777",
                  income_type: "referral_income",
                  amount: 1.2,
                  status: "settled",
                  created_at: "2026-02-01T00:00:00Z",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            success: true,
            page: 2,
            totalPages: 2,
            hasMore: false,
            transactions: [
              // Intentional duplicate TX_REF_A to verify deduplication + TX_ADS_L1_B
              {
                id: "1",
                transaction_id: "TX_REF_A",
                user_id: "FT777777",
                income_type: "referral_income",
                amount: 1.2,
                status: "settled",
                created_at: "2026-02-01T00:00:00Z",
              },
              {
                id: "2",
                transaction_id: "TX_ADS_L1_B",
                user_id: "FT777777",
                income_type: "ad_boost_income",
                amount: 15,
                status: "settled",
                created_at: "2026-02-02T00:00:00Z",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch;

      const multiPage = await getUserLedger("FT777777");
      assert.equal(calls, 2);
      assert.equal(multiPage.length, 2);
      assert.deepEqual(
        multiPage.map((t) => t.transactionId),
        ["TX_REF_A", "TX_ADS_L1_B"],
      );

      // Single-page mock without hasMore/totalPages stops after 1 fetch
      let mockCalls = 0;
      globalThis.fetch = (async () => {
        mockCalls += 1;
        return new Response(
          JSON.stringify({
            success: true,
            transactions: [
              {
                id: "10",
                transaction_id: "TX_SIMPLE",
                user_id: "FT777777",
                income_type: "referral_income",
                amount: 1.2,
                status: "settled",
                created_at: "2026-02-01T00:00:00Z",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch;

      const simpleList = await getUserLedger("FT777777");
      assert.equal(mockCalls, 1);
      assert.equal(simpleList.length, 1);
    });
  });

  describe("6. Phase 1 Authentication & Sponsor Security Regression", () => {
    it("enforces 401/403 IDOR protection on wallet/earnings-history and rejects fake/client-spoofed sponsors (e.g. FT810492)", async () => {
      writeIsolatedStore({
        users: [
          { id: "u1", user_id: "FT111111", name: "User One", role: "user", referral_code: null },
          { id: "u2", user_id: "FT222222", name: "User Two", role: "user", referral_code: null },
        ],
        sessions: {
          tok_u1: "FT111111",
        },
        wallets: {},
        walletTransactions: [],
      });

      const res401 = await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/earnings-history.php?userId=FT111111"),
      );
      assert.equal(res401?.status, 401);

      const res403 = await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/earnings-history.php?userId=FT222222", {
          headers: { Authorization: "Bearer tok_u1" },
        }),
      );
      assert.equal(res403?.status, 403);

      const resOwn = await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/earnings-history.php", {
          headers: { Authorization: "Bearer tok_u1" },
        }),
      );
      assert.equal(resOwn?.status, 200);

      // Client-spoofed FT810492 must NEVER receive commission when server referrerUserId is null
      const orderId = "order_p2_ads_001";
      const paymentId = "pay_p2_ads_001";
      const verifyResult = await verifyServerPayment(
        {
          orderId,
          paymentId,
          signature: signOrderPayment(orderId, paymentId),
          purpose: "ads_promotion",
          planId: "plan-monthly",
          userId: "FT111111",
          referrerUserId: "FT810492",
        },
        [],
        null,
        rzpEnv,
        [],
      );
      assert.equal(verifyResult.verified, true);
      assert.equal(verifyResult.distribution?.referrerId, null);
      assert.equal(verifyResult.distribution?.levelPayouts?.length ?? 0, 0);
      assert.equal(verifyResult.distribution?.adminAmount, verifyResult.amount);

      const adsUi = fs.readFileSync(
        path.resolve(process.cwd(), "src/routes/ads-promotions.tsx"),
        "utf8",
      );
      assert.doesNotMatch(adsUi, /FT810492/);
      assert.doesNotMatch(adsUi, /Samantha\s+Chen/i);
    });
  });
});
