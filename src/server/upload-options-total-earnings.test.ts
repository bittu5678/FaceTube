import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  calculateUploadOptionsTotalEarnings,
  calculateTotalAdEarnings,
  getUserWallet,
  saveStoredWallets,
} from "../lib/ledger-service.ts";
import { handleApiRequest, resetInMemoryStore } from "./api-handler.ts";

describe("FaceTube Studio — Upload Options Total Ad Earnings (All 6 Credited Sources)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetInMemoryStore();
    saveStoredWallets({});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("1. Sums all six credited income sources accurately in both camelCase and snake_case payloads", () => {
    const camel = calculateUploadOptionsTotalEarnings({
      directReferralIncome: 125.5,
      globalIncome: 310.25,
      adsenseIncome: 450.15,
      admobIncome: 620.1,
      affiliateIncome: 89.45,
      adsPromotionIncome: 204.55,
    });

    assert.deepEqual(camel, {
      referralIncome: 125.5,
      globalIncome: 310.25,
      adsenseIncome: 450.15,
      admobIncome: 620.1,
      affiliateIncome: 89.45,
      adPromotionIncome: 204.55,
      totalAdEarnings: 1800,
    });

    const snake = calculateUploadOptionsTotalEarnings({
      direct_referral_income: "10.10",
      global_income: "20.20",
      adsense_income: "30.30",
      admob_income: "40.40",
      affiliate_income: "50.50",
      ad_boost_income: "60.60",
    });

    assert.deepEqual(snake, {
      referralIncome: 10.1,
      globalIncome: 20.2,
      adsenseIncome: 30.3,
      admobIncome: 40.4,
      affiliateIncome: 50.5,
      adPromotionIncome: 60.6,
      totalAdEarnings: 212.1,
    });
  });

  it("2. Handles zero values across all six sources cleanly", () => {
    const res = calculateUploadOptionsTotalEarnings({
      directReferralIncome: 0,
      globalIncome: 0,
      adsenseIncome: 0,
      admobIncome: 0,
      affiliateIncome: 0,
      adsPromotionIncome: 0,
    });

    assert.deepEqual(res, {
      referralIncome: 0,
      globalIncome: 0,
      adsenseIncome: 0,
      admobIncome: 0,
      affiliateIncome: 0,
      adPromotionIncome: 0,
      totalAdEarnings: 0,
    });
  });

  it("3. Handles missing, null, undefined, empty, NaN, and negative values safely as 0", () => {
    assert.deepEqual(calculateUploadOptionsTotalEarnings(null), {
      referralIncome: 0,
      globalIncome: 0,
      adsenseIncome: 0,
      admobIncome: 0,
      affiliateIncome: 0,
      adPromotionIncome: 0,
      totalAdEarnings: 0,
    });
    assert.deepEqual(calculateUploadOptionsTotalEarnings(undefined), {
      referralIncome: 0,
      globalIncome: 0,
      adsenseIncome: 0,
      admobIncome: 0,
      affiliateIncome: 0,
      adPromotionIncome: 0,
      totalAdEarnings: 0,
    });

    const partial = calculateUploadOptionsTotalEarnings({
      referralIncome: null,
      globalIncome: undefined,
      adsenseIncome: "",
      admobIncome: Number.NaN,
      affiliateIncome: -50,
      adBoostIncome: 145.75,
    });

    assert.deepEqual(partial, {
      referralIncome: 0,
      globalIncome: 0,
      adsenseIncome: 0,
      admobIncome: 0,
      affiliateIncome: 0,
      adPromotionIncome: 145.75,
      totalAdEarnings: 145.75,
    });
  });

  it("4. Prevents double-counting when legacy referralIncome overlaps with adBoostIncome or alias fields coexist", () => {
    const overlapping = calculateUploadOptionsTotalEarnings({
      // Legacy referralIncome (700) previously combined direct (500) + ad boost (200)
      referralIncome: 700,
      referral_income: 700,
      directReferralIncome: 500,
      direct_referral_income: 500,
      globalIncome: 300,
      adsenseIncome: 100,
      admobIncome: 150,
      affiliateIncome: 50,
      adBoostIncome: 200,
      ad_boost_income: 200,
      adsPromotionIncome: 200,
      adPromotionIncome: 200,
      ad_promotion_income: 200,
    });

    assert.equal(overlapping.referralIncome, 500);
    assert.equal(overlapping.adPromotionIncome, 200);
    assert.equal(
      overlapping.totalAdEarnings,
      1300,
      "Must sum 500 + 300 + 100 + 150 + 50 + 200 = 1300 without double-counting",
    );

    // Ensure non-Upload-Options AdSense + AdMob helper stays strictly AdSense + AdMob
    const adsOnly = calculateTotalAdEarnings({
      adsenseIncome: 100,
      admobIncome: 150,
    });
    assert.equal(adsOnly.totalAdEarnings, 250);
  });

  it("5. Backend wallet/balance API & getUserWallet prevent duplicate counting, exclude pending/rejected/fees, and isolate authenticated users", async () => {
    // 5a. Empty / unauthenticated userId never calls backend API
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("Should not fetch without userId");
    }) as typeof fetch;

    const emptyWallet = await getUserWallet("");
    assert.equal(fetchCalled, false);
    assert.equal(calculateUploadOptionsTotalEarnings(emptyWallet).totalAdEarnings, 0);

    // 5b. Unauthenticated request to /api/wallet/balance.php must be rejected (401)
    const unauthRes = await handleApiRequest(
      new Request("http://localhost:3000/api/wallet/balance.php?userId=FT_ISOLATION_A"),
    );
    assert.equal(unauthRes?.status, 401);

    // Log in as two distinct non-admin creators (alex@facetube.com and maya@facetube.com)
    const loginA = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: "alex@facetube.com",
          password: "password123",
        }),
      }),
    );
    assert.equal(loginA?.status, 200);
    const bodyA = (await loginA?.json()) as { token: string; user: { user_id: string } };
    const uidA = bodyA.user.user_id;

    const loginB = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: "maya@facetube.com",
          password: "password123",
        }),
      }),
    );
    assert.equal(loginB?.status, 200);
    const bodyB = (await loginB?.json()) as { token: string; user: { user_id: string } };
    const uidB = bodyB.user.user_id;
    assert.notEqual(uidA, uidB);

    // 5c. User A cannot request User B's wallet balance (403)
    const crossUserRes = await handleApiRequest(
      new Request(
        `http://localhost:3000/api/wallet/balance.php?userId=${encodeURIComponent(uidB)}`,
        {
          headers: { Authorization: `Bearer ${bodyA.token}` },
        },
      ),
    );
    assert.equal(crossUserRes?.status, 403);

    // 5d. Verify getUserWallet fetches User A's live wallet through handleApiRequest
    let activeToken = bodyA.token;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const normalizedUrl = url.replace("http://127.0.0.1:3000", "http://localhost:3000");
      const req = new Request(normalizedUrl, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string>),
          Authorization: `Bearer ${activeToken}`,
        },
      });
      const handled = await handleApiRequest(req);
      if (handled) return handled;
      return new Response(JSON.stringify({ success: false }), { status: 404 });
    }) as typeof fetch;

    const initialWalletA = await getUserWallet(uidA);
    assert.equal(initialWalletA.userId, uidA);
    assert.equal(initialWalletA.isStale, false);
    const initialTotalA = calculateUploadOptionsTotalEarnings(initialWalletA);
    assert.equal(
      initialTotalA.totalAdEarnings,
      Math.round(
        (initialTotalA.referralIncome +
          initialTotalA.globalIncome +
          initialTotalA.adsenseIncome +
          initialTotalA.admobIncome +
          initialTotalA.affiliateIncome +
          initialTotalA.adPromotionIncome) *
          100,
      ) / 100,
    );

    // Verify ledger separation + exclusion of pending/rejected/fee transactions when wallet/balance responds
    const mockedLedgersByToken: Record<string, Record<string, unknown>> = {
      [bodyA.token]: {
        user_id: uidA,
        balance: 9999, // wallet balance / total_earned must NOT be double-counted
        total_earned: 8888,
        total_withdrawn: 500,
        referral_income: 175, // legacy combined (100 direct + 75 ad boost)
        direct_referral_income: 100, // separated direct referral
        ad_boost_income: 75, // separated ad promotion
        adsPromotionIncome: 75,
        global_income: 250,
        adsense_income: 325.5,
        admob_income: 410.25,
        affiliate_income: 90.25,
        pendingWithdrawals: 120,
      },
      [bodyB.token]: {
        user_id: uidB,
        balance: 100,
        total_earned: 100,
        direct_referral_income: 12,
        global_income: 18,
        adsense_income: 20,
        admob_income: 25,
        affiliate_income: 15,
        ad_boost_income: 10,
      },
    };

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          success: true,
          wallet: mockedLedgersByToken[activeToken],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const walletA = await getUserWallet(uidA);
    const totalA = calculateUploadOptionsTotalEarnings(walletA);
    assert.deepEqual(totalA, {
      referralIncome: 100,
      globalIncome: 250,
      adsenseIncome: 325.5,
      admobIncome: 410.25,
      affiliateIncome: 90.25,
      adPromotionIncome: 75,
      totalAdEarnings: 1251,
    });

    // Switch authenticated user to User B -> completely isolated 6-source total
    activeToken = bodyB.token;
    const walletB = await getUserWallet(uidB);
    const totalB = calculateUploadOptionsTotalEarnings(walletB);
    assert.deepEqual(totalB, {
      referralIncome: 12,
      globalIncome: 18,
      adsenseIncome: 20,
      admobIncome: 25,
      affiliateIncome: 15,
      adPromotionIncome: 10,
      totalAdEarnings: 100,
    });

    // Updating User B's credited income refreshes immediately on next fetch
    mockedLedgersByToken[bodyB.token] = {
      ...mockedLedgersByToken[bodyB.token],
      affiliate_income: 65.5,
      ad_boost_income: 40,
    };
    const updatedWalletB = await getUserWallet(uidB);
    assert.equal(calculateUploadOptionsTotalEarnings(updatedWalletB).totalAdEarnings, 180.5);
  });

  it("6. UploadOptionsModal & upload.tsx use 6-source calculation, refresh automatically, and hide Global Pool/GST/Payment Fees UI", () => {
    const readSrc = (relPath: string) =>
      fs.readFileSync(path.resolve(process.cwd(), relPath), "utf-8");

    const uploadModal = readSrc("src/components/videohub/UploadOptionsModal.tsx");
    const uploadRoute = readSrc("src/routes/upload.tsx");
    const balanceHandler = readSrc("src/server/api-handler.ts");
    const balancePhp = readSrc("api/wallet/balance.php");

    for (const [name, src] of [
      ["UploadOptionsModal.tsx", uploadModal],
      ["upload.tsx", uploadRoute],
    ] as const) {
      assert.ok(
        src.includes("calculateUploadOptionsTotalEarnings"),
        `${name} must use calculateUploadOptionsTotalEarnings`,
      );
      assert.ok(
        !src.includes("calculateTotalAdEarnings"),
        `${name} must not use AdSense+AdMob-only calculateTotalAdEarnings`,
      );
      assert.ok(src.includes("Total Ad Earnings"), `${name} must preserve Total Ad Earnings label`);
      assert.ok(
        src.includes("adEarnings.totalAdEarnings.toFixed(2)"),
        `${name} must display ₹ total`,
      );
      assert.ok(
        src.includes("resolveAuthenticatedUserId"),
        `${name} must isolate authenticated userId`,
      );
      assert.ok(
        src.includes("facetube:wallet-updated"),
        `${name} must refresh when wallet updates`,
      );
      assert.ok(src.includes("visibilitychange"), `${name} must refresh on tab visibility change`);

      // Rule 9: Do not expose hidden Global Income Pool, GST, or Payment Fees breakdown in Upload Options Total card
      assert.ok(
        !src.includes("Global Income Pool Status"),
        `${name} must not expose Global Income Pool`,
      );
      assert.ok(!src.includes("Payment Fees"), `${name} must not expose Payment Fees`);
      assert.ok(!src.includes("18% GST"), `${name} must not expose GST deductions`);
    }

    // Confirm backend wallet/balance endpoints enforce TX_ADS_L* vs direct referral separation and settled-only filter
    assert.ok(balanceHandler.includes("AND status = 'settled'"));
    assert.ok(balanceHandler.includes("ledger_direct_referral"));
    assert.ok(balanceHandler.includes("ledger_ad_boost"));
    assert.ok(balancePhp.includes("AND status = 'settled'"));
    assert.ok(balancePhp.includes("ledger_direct_referral"));
    assert.ok(balancePhp.includes("ledger_ad_boost"));
  });
});
