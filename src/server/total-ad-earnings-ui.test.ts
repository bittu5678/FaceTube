import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  calculateTotalAdEarnings,
  calculateUploadOptionsTotalEarnings,
  getUserWallet,
  WITHDRAWAL_RULES,
  WITHDRAWAL_CHARGES,
  saveStoredWallets,
} from "../lib/ledger-service.ts";
import { handleApiRequest, resetInMemoryStore } from "./api-handler.ts";

describe("FaceTube — Canonical 6-Source Total Ad Earnings Consistency & UI Verification", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetInMemoryStore();
    saveStoredWallets({});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("1. Sums all six settled income sources individually and combined in camelCase and snake_case", () => {
    assert.strictEqual(
      calculateUploadOptionsTotalEarnings,
      calculateTotalAdEarnings,
      "Must expose one canonical calculation helper",
    );

    // Test each of the 6 categories individually
    assert.equal(
      calculateTotalAdEarnings({ directReferralIncome: 111.11 }).totalAdEarnings,
      111.11,
    );
    assert.equal(calculateTotalAdEarnings({ globalIncome: 222.22 }).totalAdEarnings, 222.22);
    assert.equal(calculateTotalAdEarnings({ adsenseIncome: 333.33 }).totalAdEarnings, 333.33);
    assert.equal(calculateTotalAdEarnings({ admobIncome: 444.44 }).totalAdEarnings, 444.44);
    assert.equal(calculateTotalAdEarnings({ affiliateIncome: 555.55 }).totalAdEarnings, 555.55);
    assert.equal(calculateTotalAdEarnings({ adsPromotionIncome: 666.66 }).totalAdEarnings, 666.66);

    const camel = calculateTotalAdEarnings({
      directReferralIncome: 125.5,
      globalIncome: 310.25,
      adsenseIncome: 249.25,
      admobIncome: 1250.75,
      affiliateIncome: 89.45,
      adsPromotionIncome: 204.8,
    });
    assert.deepEqual(camel, {
      referralIncome: 125.5,
      globalIncome: 310.25,
      adsenseIncome: 249.25,
      admobIncome: 1250.75,
      affiliateIncome: 89.45,
      adPromotionIncome: 204.8,
      totalAdEarnings: 2230,
    });

    const snake = calculateTotalAdEarnings({
      direct_referral_income: "10.10",
      global_income: "20.20",
      adsense_income: "100.10",
      admob_income: "200.20",
      affiliate_income: "30.30",
      ad_boost_income: "40.40",
    });
    assert.deepEqual(snake, {
      referralIncome: 10.1,
      globalIncome: 20.2,
      adsenseIncome: 100.1,
      admobIncome: 200.2,
      affiliateIncome: 30.3,
      adPromotionIncome: 40.4,
      totalAdEarnings: 401.3,
    });
  });

  it("2. Excludes balance, totalEarned, totalWithdrawn, pendingWithdrawals, and prevents legacy/alias double-counting", () => {
    const walletPayload = {
      userId: "FT_USER_OVERLAP",
      balance: 9800,
      totalEarned: 15000,
      totalWithdrawn: 5200,
      pendingWithdrawals: 400,
      // Legacy combined referralIncome (1500) = direct (1000) + adBoost (500)
      referralIncome: 1500,
      referral_income: 1500,
      directReferralIncome: 1000,
      direct_referral_income: 1000,
      globalIncome: 300,
      adsenseIncome: 600.5,
      admobIncome: 399.5,
      affiliateIncome: 200,
      adsPromotionIncome: 500,
      adPromotionIncome: 500,
      ad_promotion_income: 500,
      adBoostIncome: 500,
      ad_boost_income: 500,
      updatedAt: new Date().toISOString(),
    };

    const res = calculateTotalAdEarnings(walletPayload);
    assert.deepEqual(res, {
      referralIncome: 1000,
      globalIncome: 300,
      adsenseIncome: 600.5,
      admobIncome: 399.5,
      affiliateIncome: 200,
      adPromotionIncome: 500,
      totalAdEarnings: 3000,
    });
    assert.notEqual(res.totalAdEarnings, walletPayload.totalEarned);
    assert.notEqual(res.totalAdEarnings, walletPayload.balance);
  });

  it("3. Handles zero, null, undefined, empty string, NaN, and negative values safely as 0", () => {
    assert.deepEqual(
      calculateTotalAdEarnings({
        directReferralIncome: 0,
        globalIncome: 0,
        adsenseIncome: 0,
        admobIncome: 0,
        affiliateIncome: 0,
        adsPromotionIncome: 0,
      }),
      {
        referralIncome: 0,
        globalIncome: 0,
        adsenseIncome: 0,
        admobIncome: 0,
        affiliateIncome: 0,
        adPromotionIncome: 0,
        totalAdEarnings: 0,
      },
    );

    assert.deepEqual(
      calculateTotalAdEarnings({
        referralIncome: null,
        globalIncome: undefined,
        adsenseIncome: "",
        admobIncome: Number.NaN,
        affiliateIncome: -75,
        adBoostIncome: 145.75,
      }),
      {
        referralIncome: 0,
        globalIncome: 0,
        adsenseIncome: 0,
        admobIncome: 0,
        affiliateIncome: 0,
        adPromotionIncome: 145.75,
        totalAdEarnings: 145.75,
      },
    );

    assert.deepEqual(calculateTotalAdEarnings(null), {
      referralIncome: 0,
      globalIncome: 0,
      adsenseIncome: 0,
      admobIncome: 0,
      affiliateIncome: 0,
      adPromotionIncome: 0,
      totalAdEarnings: 0,
    });
    assert.deepEqual(calculateTotalAdEarnings(undefined), {
      referralIncome: 0,
      globalIncome: 0,
      adsenseIncome: 0,
      admobIncome: 0,
      affiliateIncome: 0,
      adPromotionIncome: 0,
      totalAdEarnings: 0,
    });
  });

  it("4. Excludes pending/rejected/fee ledger records, deduplicates duplicate transaction IDs, and prevents wallet + ledger double-counting", () => {
    const overlappingWallet = {
      balance: 2500,
      totalEarned: 3000,
      directReferralIncome: 100,
      globalIncome: 200,
      adsenseIncome: 300,
      admobIncome: 400,
      affiliateIncome: 150,
      adBoostIncome: 250,
    };

    const ledgerRows = [
      // Duplicate settled AdMob transactions (same transaction_id in different cases) -> count ONCE (400)
      {
        transactionId: "TX_ADMOB_2026_06",
        incomeType: "admob_income",
        amount: 400,
        status: "settled",
      },
      {
        transaction_id: "tx_admob_2026_06",
        income_type: "admob_income",
        amount: 400,
        status: "settled",
      },
      // Pending & failed AdMob records -> MUST be excluded
      {
        transactionId: "TX_ADMOB_PENDING_1",
        incomeType: "admob_income",
        amount: 999,
        status: "pending",
      },
      {
        transactionId: "TX_ADMOB_FAILED_1",
        incomeType: "admob_income",
        amount: 500,
        status: "failed",
      },
      // Overlapping settled AdSense row (already in wallet.adsenseIncome=300) -> MUST NOT become 600
      {
        transactionId: "TX_ADSENSE_1",
        incomeType: "adsense_income",
        amount: 300,
        status: "settled",
      },
      // Pending direct referral + valid settled direct referral
      {
        transactionId: "TX_REF_PENDING_pay9",
        incomeType: "referral_income",
        amount: 50,
        status: "pending",
      },
      {
        transactionId: "TX_REF_pay1",
        incomeType: "referral_income",
        amount: 100,
        status: "settled",
      },
      // Legacy marketing_income with TX_ADS_L1 belongs ONLY to Ad Promotion (250), NOT Affiliate
      {
        transactionId: "TX_ADS_L1_pay2",
        incomeType: "marketing_income",
        specialTag: "ADS_REF_L1",
        amount: 250,
        status: "settled",
      },
      // Genuine affiliate
      { transactionId: "TX_AFF_1", incomeType: "affiliate_income", amount: 150, status: "settled" },
      // Settled global + pending global reserve
      { transactionId: "TX_GLOBAL_1", incomeType: "global_income", amount: 200, status: "settled" },
      {
        transactionId: "TX_GLOBAL_PENDING",
        incomeType: "global_income",
        amount: 800,
        status: "pending",
      },
      // Withdrawals & sponsor fees must be ignored
      { transactionId: "TX_WD_1", incomeType: "withdrawal", amount: 500, status: "settled" },
      {
        transactionId: "TX_FEE_1",
        incomeType: "ads_promotion_fee",
        amount: 499,
        status: "settled",
      },
    ];

    const reconciled = calculateTotalAdEarnings(overlappingWallet, ledgerRows);
    assert.deepEqual(reconciled, {
      referralIncome: 100,
      globalIncome: 200,
      adsenseIncome: 300,
      admobIncome: 400,
      affiliateIncome: 150,
      adPromotionIncome: 250,
      totalAdEarnings: 1400,
    });
    // Ensure individual AdSense & AdMob remain strictly isolated to their own channels
    assert.equal(reconciled.adsenseIncome, 300);
    assert.equal(reconciled.admobIncome, 400);
  });

  it("5. Uses actual authenticated user's wallet data from backend and avoids unauthenticated fallback fetches", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("Should not fetch for empty userId");
    }) as typeof fetch;

    const emptyWallet = await getUserWallet("");
    assert.equal(fetchCalled, false, "Empty userId must not invoke wallet API");
    assert.equal(emptyWallet.userId, "");
    assert.equal(calculateTotalAdEarnings(emptyWallet).totalAdEarnings, 0);

    // Log in as an existing creator via handleApiRequest and verify getUserWallet reads live wallet
    const loginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "alex@facetube.com",
        password: "password123",
      }),
    });
    const loginRes = await handleApiRequest(loginReq);
    assert.ok(loginRes && loginRes.status === 200);
    const loginBody = (await loginRes.json()) as { token: string; user: { user_id: string } };
    const uid = loginBody.user.user_id;
    assert.ok(uid);

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const normalizedUrl = url.replace("http://127.0.0.1:3000", "http://localhost:3000");
      const req = new Request(normalizedUrl, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string>),
          Authorization: `Bearer ${loginBody.token}`,
        },
      });
      const handled = await handleApiRequest(req);
      if (handled) return handled;
      return new Response(JSON.stringify({ success: false }), { status: 404 });
    }) as typeof fetch;

    const backendWallet = await getUserWallet(uid);
    assert.equal(backendWallet.userId, uid);
    assert.equal(backendWallet.isStale, false);
    const backendBreakdown = calculateTotalAdEarnings(backendWallet);
    assert.equal(
      backendBreakdown.totalAdEarnings,
      Math.round(
        (backendBreakdown.referralIncome +
          backendBreakdown.globalIncome +
          backendBreakdown.adsenseIncome +
          backendBreakdown.admobIncome +
          backendBreakdown.affiliateIncome +
          backendBreakdown.adPromotionIncome) *
          100,
      ) / 100,
    );

    // Verify server wallet response with all 6 distinct settled streams
    const serverPayloadWallet = {
      user_id: uid,
      balance: 3100.5,
      total_earned: 3600.5,
      total_withdrawn: 500,
      direct_referral_income: 500,
      referral_income: 700, // legacy overlapping field must NOT double-count ad_boost_income=200
      ad_boost_income: 200,
      global_income: 400,
      adsense_income: 550.25,
      admob_income: 950.25,
      affiliate_income: 100,
    };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ success: true, wallet: serverPayloadWallet }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    const liveWallet = await getUserWallet(uid);
    assert.equal(liveWallet.userId, uid);
    assert.equal(liveWallet.adsenseIncome, 550.25);
    assert.equal(liveWallet.admobIncome, 950.25);
    assert.equal(liveWallet.directReferralIncome, 500);
    assert.equal(liveWallet.adsPromotionIncome, 200);
    assert.equal(liveWallet.totalEarned, 3600.5);

    const breakdown = calculateTotalAdEarnings(liveWallet);
    assert.deepEqual(breakdown, {
      referralIncome: 500,
      globalIncome: 400,
      adsenseIncome: 550.25,
      admobIncome: 950.25,
      affiliateIncome: 100,
      adPromotionIncome: 200,
      totalAdEarnings: 2700.5,
    });
  });

  it("6. Verifies Dashboard, Income, Wallet, AdSense, AdMob, and Upload Options UI all reuse canonical calculateTotalAdEarnings cleanly", () => {
    const readSrc = (relPath: string) =>
      fs.readFileSync(path.resolve(process.cwd(), relPath), "utf-8");

    const summaryCards = readSrc("src/components/videohub/DashboardSummaryCards.tsx");
    const uploadModal = readSrc("src/components/videohub/UploadOptionsModal.tsx");
    const uploadRoute = readSrc("src/routes/upload.tsx");
    const dashboardRoute = readSrc("src/routes/dashboard.tsx");
    const incomeRoute = readSrc("src/routes/income.tsx");
    const walletRoute = readSrc("src/routes/wallet-balance.tsx");
    const adsenseRoute = readSrc("src/routes/adsense-income.tsx");
    const admobRoute = readSrc("src/routes/admob-income.tsx");

    // DashboardSummaryCards: has total-ad-earnings, adsense-income, admob-income; reflects 6 streams; no static placeholders
    assert.ok(summaryCards.includes('id: "adsense-income"'));
    assert.ok(summaryCards.includes('id: "admob-income"'));
    assert.ok(summaryCards.includes('id: "total-ad-earnings"'));
    assert.ok(summaryCards.includes('title: "Total Ad Earnings"'));
    assert.ok(summaryCards.includes("All 6 credited income streams"));
    assert.ok(!summaryCards.includes("AdSense + AdMob combined"));
    assert.ok(!summaryCards.includes("₹840 ad revenue"), "Must remove ₹840 ad revenue placeholder");
    assert.ok(!summaryCards.includes("₹3,150.00"), "Must remove static ₹3,150.00 placeholder");
    assert.ok(!summaryCards.includes("Last paid Sep 18"), "Must remove static Last paid Sep 18");

    // Every Total Ad Earnings UI location uses canonical calculateTotalAdEarnings and has no stale AdSense+AdMob-only copy
    for (const [name, content] of [
      ["UploadOptionsModal.tsx", uploadModal],
      ["upload.tsx", uploadRoute],
      ["dashboard.tsx", dashboardRoute],
      ["income.tsx", incomeRoute],
      ["wallet-balance.tsx", walletRoute],
      ["adsense-income.tsx", adsenseRoute],
      ["admob-income.tsx", admobRoute],
    ] as const) {
      assert.ok(
        !content.includes("FT483921"),
        `${name} must not contain hardcoded fallback user FT483921`,
      );
      assert.ok(
        content.includes("resolveAuthenticatedUserId"),
        `${name} must resolve canonical authenticated user ID`,
      );
      assert.ok(
        content.includes("calculateTotalAdEarnings"),
        `${name} must reuse canonical calculateTotalAdEarnings`,
      );
      assert.ok(
        content.includes("Total Ad Earnings"),
        `${name} must render combined Total Ad Earnings`,
      );
      assert.ok(
        !content.includes("AdSense + AdMob combined"),
        `${name} must not label Total Ad Earnings as AdSense + AdMob combined`,
      );
      assert.ok(
        !content.includes("Total Ad Earnings (AdSense + AdMob)"),
        `${name} must not label Total Ad Earnings as AdSense + AdMob only`,
      );
      assert.ok(
        !content.includes("Total Ads Earning"),
        `${name} must use exact Total Ad Earnings label`,
      );
    }

    // Dashboard maps individual AdSense, AdMob, Referral, Global, Affiliate, and Total Ad Earnings
    assert.ok(dashboardRoute.includes('"adsense-income"'));
    assert.ok(dashboardRoute.includes('"admob-income"'));
    assert.ok(dashboardRoute.includes('"total-ad-earnings"'));
    assert.ok(dashboardRoute.includes("h.admob ?? h.admob_income"));

    // Income page has zero hardcoded sample rupee values and updates badge/description
    assert.ok(incomeRoute.includes("All 6 Streams"));
    for (const sampleVal of ["₹2,450.00", "₹1,890.20", "₹940.80", "₹4,280.50", "₹3,150.00"]) {
      assert.ok(
        !incomeRoute.includes(sampleVal),
        `income.tsx must not contain sample ${sampleVal}`,
      );
    }

    // Wallet Balance passes non-stale ledger safely and keeps individual AdSense/AdMob separate
    assert.ok(walletRoute.includes("AdSense Income"));
    assert.ok(walletRoute.includes("AdMob Income"));
    assert.ok(walletRoute.includes("All 6 credited income streams"));

    // AdSense & AdMob pages preserve individual channel revenue while showing unified 6-stream Total Ad Earnings
    assert.ok(adsenseRoute.includes("const adsenseRevenue = adEarnings.adsenseIncome"));
    assert.ok(adsenseRoute.includes("adsenseRevenue.toFixed(2)"));
    assert.ok(adsenseRoute.includes("All 6 credited income streams"));
    assert.ok(admobRoute.includes("const admobRevenue = adEarnings.admobIncome"));
    assert.ok(admobRoute.includes("admobRevenue.toFixed(2)"));
    assert.ok(admobRoute.includes("All 6 credited income streams"));
  });

  it("7. Preserves withdrawal rules and deduction rates unchanged", () => {
    assert.equal(WITHDRAWAL_RULES.MIN_AMOUNT, 100);
    assert.equal(WITHDRAWAL_RULES.MAX_DAILY_LIMIT, 10000);
    assert.equal(WITHDRAWAL_CHARGES.GST_RATE, 0.18);
    assert.equal(WITHDRAWAL_CHARGES.PG_FEE_RATE, 0.02);
    assert.equal(WITHDRAWAL_CHARGES.TOTAL_DEDUCTION_RATE, 0.2);
    assert.equal(WITHDRAWAL_CHARGES.NET_PAYOUT_RATE, 0.8);
  });
});
