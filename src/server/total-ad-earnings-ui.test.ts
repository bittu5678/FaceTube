import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  calculateTotalAdEarnings,
  getUserWallet,
  WITHDRAWAL_RULES,
  WITHDRAWAL_CHARGES,
  saveStoredWallets,
} from "../lib/ledger-service.ts";
import { handleApiRequest, resetInMemoryStore } from "./api-handler.ts";

describe("FaceTube Requirement #9 — Step 9B: Total Ad Earnings (AdSense + AdMob) Calculation & UI", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetInMemoryStore();
    saveStoredWallets({});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("1. Calculates Total Ad Earnings = AdSense Income + AdMob Income cleanly", () => {
    const res = calculateTotalAdEarnings({
      adsenseIncome: 249.25,
      admobIncome: 1250.75,
    });

    assert.equal(res.adsenseIncome, 249.25);
    assert.equal(res.admobIncome, 1250.75);
    assert.equal(res.totalAdEarnings, 1500);

    // Also supports snake_case backend payloads
    const snakeRes = calculateTotalAdEarnings({
      adsense_income: "100.10",
      admob_income: "200.20",
    });
    assert.equal(snakeRes.adsenseIncome, 100.1);
    assert.equal(snakeRes.admobIncome, 200.2);
    assert.equal(snakeRes.totalAdEarnings, 300.3);
  });

  it("2. Excludes Referral, Global Pool, Affiliate, Sponsor income, balance, and totalEarned", () => {
    const walletPayload = {
      userId: "FT_USER_EXCLUSION",
      balance: 9800,
      totalEarned: 15000, // Includes referral/global/affiliate + ads
      totalWithdrawn: 5200,
      referralIncome: 5000,
      globalIncome: 3000,
      affiliateIncome: 4500,
      adsenseIncome: 600.5,
      admobIncome: 399.5,
      updatedAt: new Date().toISOString(),
    };

    const res = calculateTotalAdEarnings(walletPayload);
    assert.equal(res.adsenseIncome, 600.5);
    assert.equal(res.admobIncome, 399.5);
    assert.equal(
      res.totalAdEarnings,
      1000,
      "Total Ad Earnings must strictly equal AdSense + AdMob (₹1,000), NOT totalEarned (₹15,000)",
    );
    assert.notEqual(res.totalAdEarnings, walletPayload.totalEarned);
  });

  it("3. Handles null, undefined, empty string, and non-finite admobIncome safely as 0", () => {
    assert.deepEqual(calculateTotalAdEarnings({ adsenseIncome: 420.5, admobIncome: null }), {
      adsenseIncome: 420.5,
      admobIncome: 0,
      totalAdEarnings: 420.5,
    });
    assert.deepEqual(calculateTotalAdEarnings({ adsenseIncome: 420.5, admobIncome: undefined }), {
      adsenseIncome: 420.5,
      admobIncome: 0,
      totalAdEarnings: 420.5,
    });
    assert.deepEqual(calculateTotalAdEarnings({ adsenseIncome: 420.5, admobIncome: "" }), {
      adsenseIncome: 420.5,
      admobIncome: 0,
      totalAdEarnings: 420.5,
    });
    assert.deepEqual(calculateTotalAdEarnings({ adsenseIncome: 420.5, admobIncome: Number.NaN }), {
      adsenseIncome: 420.5,
      admobIncome: 0,
      totalAdEarnings: 420.5,
    });
  });

  it("4. Handles null, undefined, empty string, and missing wallet for adsenseIncome safely as 0", () => {
    assert.deepEqual(calculateTotalAdEarnings({ adsenseIncome: null, admobIncome: 750.25 }), {
      adsenseIncome: 0,
      admobIncome: 750.25,
      totalAdEarnings: 750.25,
    });
    assert.deepEqual(calculateTotalAdEarnings({ adsenseIncome: undefined, admobIncome: 750.25 }), {
      adsenseIncome: 0,
      admobIncome: 750.25,
      totalAdEarnings: 750.25,
    });
    assert.deepEqual(calculateTotalAdEarnings(null), {
      adsenseIncome: 0,
      admobIncome: 0,
      totalAdEarnings: 0,
    });
    assert.deepEqual(calculateTotalAdEarnings(undefined), {
      adsenseIncome: 0,
      admobIncome: 0,
      totalAdEarnings: 0,
    });
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
    assert.equal(emptyWallet.adsenseIncome, 0);
    assert.equal(emptyWallet.admobIncome, 0);
    assert.equal(calculateTotalAdEarnings(emptyWallet).totalAdEarnings, 0);

    // Log in as an existing creator via handleApiRequest and verify getUserWallet reads live AdSense + AdMob
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

    // Fetch live wallet through Node API handler bridged via globalThis.fetch
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
      Math.round((backendBreakdown.adsenseIncome + backendBreakdown.admobIncome) * 100) / 100,
    );

    // Verify server wallet response with distinct AdSense, AdMob, Referral, and total_earned
    const serverPayloadWallet = {
      user_id: uid,
      balance: 2100.5,
      total_earned: 2600.5,
      total_withdrawn: 500,
      referral_income: 700,
      global_income: 400,
      adsense_income: 550.25,
      admob_income: 950.25,
      affiliate_income: 0,
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
    assert.equal(liveWallet.referralIncome, 700);
    assert.equal(liveWallet.totalEarned, 2600.5);

    const breakdown = calculateTotalAdEarnings(liveWallet);
    assert.equal(breakdown.adsenseIncome, 550.25);
    assert.equal(breakdown.admobIncome, 950.25);
    assert.equal(breakdown.totalAdEarnings, 1500.5);
  });

  it("6. Verifies Dashboard, Upload Modal/Studio, Income, Wallet, AdSense & AdMob UI use Total Ad Earnings cleanly without hardcoded placeholders", () => {
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

    // DashboardSummaryCards: has total-ad-earnings, adsense-income, admob-income; no static placeholders
    assert.ok(summaryCards.includes('id: "adsense-income"'));
    assert.ok(summaryCards.includes('id: "admob-income"'));
    assert.ok(summaryCards.includes('id: "total-ad-earnings"'));
    assert.ok(summaryCards.includes('title: "Total Ad Earnings"'));
    assert.ok(!summaryCards.includes("₹840 ad revenue"), "Must remove ₹840 ad revenue placeholder");
    assert.ok(!summaryCards.includes("₹3,150.00"), "Must remove static ₹3,150.00 placeholder");
    assert.ok(!summaryCards.includes("Last paid Sep 18"), "Must remove static Last paid Sep 18");

    // UploadOptionsModal & upload.tsx: use calculateUploadOptionsTotalEarnings (all 6 credited sources), not AdSense-only "Total Ads Earning"
    assert.ok(uploadModal.includes("calculateUploadOptionsTotalEarnings"));
    assert.ok(uploadModal.includes("resolveAuthenticatedUserId"));
    assert.ok(uploadModal.includes("Total Ad Earnings"));
    assert.ok(!uploadModal.includes("Total Ads Earning"));
    assert.ok(!uploadModal.includes("wallet?.adsenseIncome ?? 0"));

    assert.ok(uploadRoute.includes("calculateUploadOptionsTotalEarnings"));
    assert.ok(uploadRoute.includes("Total Ad Earnings"));
    assert.ok(!uploadRoute.includes("Total Ads Earning"));
    assert.ok(!uploadRoute.includes("wallet?.adsenseIncome ?? 0"));

    // Dashboard, Income, Wallet, AdSense, AdMob: no hardcoded FT483921 fallback; all compute calculateTotalAdEarnings
    for (const [name, content] of [
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
        `${name} must use calculateTotalAdEarnings(wallet)`,
      );
      assert.ok(
        content.includes("Total Ad Earnings"),
        `${name} must render combined Total Ad Earnings`,
      );
    }

    // Dashboard maps admob stream & overrides
    assert.ok(dashboardRoute.includes('"adsense-income"'));
    assert.ok(dashboardRoute.includes('"admob-income"'));
    assert.ok(dashboardRoute.includes('"total-ad-earnings"'));
    assert.ok(dashboardRoute.includes("h.admob ?? h.admob_income"));

    // Income page has zero hardcoded sample rupee values
    for (const sampleVal of ["₹2,450.00", "₹1,890.20", "₹940.80", "₹4,280.50", "₹3,150.00"]) {
      assert.ok(
        !incomeRoute.includes(sampleVal),
        `income.tsx must not contain sample ${sampleVal}`,
      );
    }

    // Wallet Balance renders AdSense, AdMob, and Total Ad Earnings separately
    assert.ok(walletRoute.includes("AdSense Income"));
    assert.ok(walletRoute.includes("AdMob Income"));
    assert.ok(walletRoute.includes("Total Ad Earnings"));
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
