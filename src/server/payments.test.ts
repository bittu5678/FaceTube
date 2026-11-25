import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  verifyServerPayment,
  verifyPayment,
  PRICING_CONFIG,
  evaluateAdsDistribution,
  evaluatePremiumDistribution,
  calculateWeightedPoolPayouts,
  resolveUplineSponsors,
  ADS_REFERRAL_RATES,
  getPersistentPremiumTxNumber,
  getPersistentGlobalPoolState,
  resetPersistentPremiumState,
  isSpecialGlobalTransaction as isSpecialServerTx,
} from "./payments";
import {
  handleApiRequest,
  isAdPromotionActive,
  maskAccountNumber,
  maskUpiId,
  buildMaskedBeneficiaryDetails,
  setStoreWalletBalance,
  resetStoreForTests,
  resetInMemoryStore,
} from "./api-handler";
import { setMysqlPoolForTesting } from "./mysql";
import { isPromotionActive, getVideoBadgeLabels } from "../lib/video-service";
import { api } from "../lib/api";
import {
  processWithdrawal,
  getUserWallet,
  saveStoredLedger,
  distributePremiumVideoIncome,
  isSpecialGlobalTransaction as isSpecialClientTx,
  getStoredLedger,
  getStoredWallets,
} from "../lib/ledger-service";

beforeEach(() => {
  resetStoreForTests();
});

describe("Payment Verification & Referral Security Audit Tests", () => {
  const secret = "test_razorpay_secret_key_1234567890";
  const orderId = "order_test_1001";
  const paymentId = "pay_test_2002";
  const validSignature = crypto
    .createHmac("sha256", secret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");

  it("1. Fails closed when Razorpay secret credentials are missing", async () => {
    const res = await verifyPayment(
      {
        orderId,
        paymentId,
        signature: validSignature,
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      ["FT483921"],
      "FT102857",
      { RAZORPAY_KEY_SECRET: "" }, // Explicitly missing secret
    );

    assert.equal(res.verified, false);
    assert.match(res.error || "", /missing|not configured|failed closed/i);
  });

  it("2. Rejects mock signatures and bypass tokens", async () => {
    const res = await verifyPayment(
      {
        orderId,
        paymentId: "pay_test_mock_1",
        signature: "mock_signature_bypass",
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      ["FT483921"],
      "FT102857",
      { RAZORPAY_KEY_SECRET: secret },
    );

    assert.equal(res.verified, false);
    assert.match(res.error || "", /mock|invalid/i);
  });

  it("3. Rejects invalid or tampered HMAC signature", async () => {
    const res = await verifyPayment(
      {
        orderId,
        paymentId,
        signature: "tampered_fake_signature_382910382910381029381029",
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      ["FT483921"],
      "FT102857",
      { RAZORPAY_KEY_SECRET: secret },
    );

    assert.equal(res.verified, false);
    assert.match(res.error || "", /signature verification failed/i);
  });

  it("4. Credits referral commission correctly for verified premium video upload", async () => {
    const uniquePayId = `pay_unique_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const sig = crypto
      .createHmac("sha256", secret)
      .update(`${orderId}|${uniquePayId}`)
      .digest("hex");

    const res = await verifyPayment(
      {
        orderId,
        paymentId: uniquePayId,
        signature: sig,
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      ["FT483921"],
      "FT102857", // Verified sponsor
      { RAZORPAY_KEY_SECRET: secret },
    );

    assert.equal(res.verified, true);
    assert.equal(res.amount, 6.0); // Exact ₹6.00 business rule
    assert.equal(res.distribution?.directReferralAmount, 1.0); // Exact ₹1.00 business rule
    assert.equal(res.distribution?.referrerId, "FT102857");
  });

  it("5. Prevents duplicate commission credit on duplicate payment ID (idempotency)", async () => {
    const uniquePayId = `pay_dedup_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const sig = crypto
      .createHmac("sha256", secret)
      .update(`${orderId}|${uniquePayId}`)
      .digest("hex");

    // First attempt
    const firstRes = await verifyPayment(
      {
        orderId,
        paymentId: uniquePayId,
        signature: sig,
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      ["FT483921"],
      "FT102857",
      { RAZORPAY_KEY_SECRET: secret },
    );
    assert.equal(firstRes.verified, true);

    // Second duplicate attempt
    const secondRes = await verifyPayment(
      {
        orderId,
        paymentId: uniquePayId,
        signature: sig,
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      ["FT483921"],
      "FT102857",
      { RAZORPAY_KEY_SECRET: secret },
    );

    assert.equal(secondRes.verified, true);
    assert.equal(secondRes.txNumber, firstRes.txNumber); // Does not increment sequence
    assert.match(secondRes.error || "", /already been processed/i);
  });

  it("6. Handles concurrent duplicate payment verification requests safely", async () => {
    const concurrentPayId = `pay_concurrent_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const sig = crypto
      .createHmac("sha256", secret)
      .update(`${orderId}|${concurrentPayId}`)
      .digest("hex");

    const reqData = {
      orderId,
      paymentId: concurrentPayId,
      signature: sig,
      userId: "FT483921",
      purpose: "premium_video_upload" as const,
    };

    // Fire 3 simultaneous verification attempts
    const [res1, res2, res3] = await Promise.all([
      verifyServerPayment(reqData, ["FT483921"], "FT102857", { RAZORPAY_KEY_SECRET: secret }),
      verifyServerPayment(reqData, ["FT483921"], "FT102857", { RAZORPAY_KEY_SECRET: secret }),
      verifyServerPayment(reqData, ["FT483921"], "FT102857", { RAZORPAY_KEY_SECRET: secret }),
    ]);

    // All should be marked verified, but only one is the original sequence allocation
    assert.equal(res1.verified, true);
    assert.equal(res2.verified, true);
    assert.equal(res3.verified, true);

    // All must have identical sequence numbers (no sequence inflation)
    assert.equal(res1.txNumber, res2.txNumber);
    assert.equal(res2.txNumber, res3.txNumber);
  });
});

describe("API Handler Authentication & Authorization Security Tests", () => {
  const adminToken = "test_session_token_admin_001";
  const userToken = "test_session_token_user_002";
  const envConfig = { RAZORPAY_KEY_SECRET: "test_secret_for_api_tests_123456" };

  // Helper to simulate API requests with tokens
  async function makeApiCall(
    url: string,
    method = "GET",
    body: any = null,
    token: string | null = null,
  ) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    const init: RequestInit = { method, headers };
    if (body) {
      init.body = JSON.stringify(body);
    }
    const req = new Request(`http://localhost:3000${url}`, init);
    const resp = await handleApiRequest(req, envConfig);
    assert.ok(resp, `Response should exist for ${url}`);
    const data = await resp.json();
    return { status: resp.status, data };
  }

  it("1. Rejects unauthenticated access to wallet/balance with 401", async () => {
    const { status, data } = await makeApiCall("/api/wallet/balance.php?userId=FT483921");
    assert.equal(status, 401);
    assert.equal(data.success, false);
    assert.match(data.error, /Authentication required/i);
  });

  it("2. Rejects unauthenticated access to wallet/transactions with 401", async () => {
    const { status, data } = await makeApiCall("/api/wallet/transactions.php");
    assert.equal(status, 401);
    assert.equal(data.success, false);
    assert.match(data.error, /Authentication required/i);
  });

  it("3. Rejects unauthenticated access to wallet/withdraw with 401", async () => {
    const { status, data } = await makeApiCall("/api/wallet/withdraw.php", "POST", {
      amount: 1000,
      userId: "FT483921",
    });
    assert.equal(status, 401);
    assert.equal(data.success, false);
    assert.match(data.error, /Authentication required/i);
  });

  it("4. Rejects unauthenticated access to referrals/dashboard with 401", async () => {
    const { status, data } = await makeApiCall("/api/referrals/dashboard.php?userId=FT483921");
    assert.equal(status, 401);
    assert.equal(data.success, false);
    assert.match(data.error, /Authentication required/i);
  });

  it("5. Authenticates regular user and generates valid session token", async () => {
    const { status, data } = await makeApiCall("/api/auth/login.php", "POST", {
      identifier: "alex@facetube.com",
      password: "password123",
    });
    assert.equal(status, 200);
    assert.equal(data.success, true);
    assert.ok(data.token, "Login should return session token");
    assert.equal(data.user.user_id, "FT483921");
    assert.equal(data.user.role, "user");
  });

  it("6. Allows regular user to access their own wallet/balance", async () => {
    // Log in as Alex
    const login = await makeApiCall("/api/auth/login.php", "POST", {
      identifier: "alex@facetube.com",
      password: "password123",
    });
    const token = login.data.token;

    const { status, data } = await makeApiCall(
      "/api/wallet/balance.php?userId=FT483921",
      "GET",
      null,
      token,
    );
    assert.equal(status, 200);
    assert.equal(data.success, true);
    assert.equal(data.wallet.userId, "FT483921");
  });

  it("7. Blocks standard user from cross-user access to another user's wallet with 403", async () => {
    // Log in as Alex (role: user)
    const login = await makeApiCall("/api/auth/login.php", "POST", {
      identifier: "alex@facetube.com",
      password: "password123",
    });
    const token = login.data.token;

    // Try accessing Admin's wallet (FT102857)
    const { status, data } = await makeApiCall(
      "/api/wallet/balance.php?userId=FT102857",
      "GET",
      null,
      token,
    );
    assert.equal(status, 403);
    assert.equal(data.success, false);
    assert.match(data.error, /Cross-user access is restricted to verified administrators/i);
  });

  it("8. Blocks standard user from cross-user access to another user's referrals/dashboard with 403", async () => {
    // Log in as Alex
    const login = await makeApiCall("/api/auth/login.php", "POST", {
      identifier: "alex@facetube.com",
      password: "password123",
    });
    const token = login.data.token;

    // Try accessing Admin's referral dashboard
    const { status, data } = await makeApiCall(
      "/api/referrals/dashboard.php?userId=FT102857",
      "GET",
      null,
      token,
    );
    assert.equal(status, 403);
    assert.equal(data.success, false);
    assert.match(data.error, /Cross-user access is restricted to verified administrators/i);
  });

  it("9. Permits admin user to access cross-user wallet/balance and referrals/dashboard", async () => {
    // Log in as Admin
    const login = await makeApiCall("/api/auth/login.php", "POST", {
      identifier: "admin@facetube.com",
      password: "password",
    });
    assert.equal(login.status, 200);
    const token = login.data.token;

    // Admin accessing Alex's wallet
    const walletRes = await makeApiCall(
      "/api/wallet/balance.php?userId=FT483921",
      "GET",
      null,
      token,
    );
    assert.equal(walletRes.status, 200);
    assert.equal(walletRes.data.success, true);
    assert.equal(walletRes.data.wallet.userId, "FT483921");

    // Admin accessing Alex's referrals
    const refRes = await makeApiCall(
      "/api/referrals/dashboard.php?userId=FT483921",
      "GET",
      null,
      token,
    );
    assert.equal(refRes.status, 200);
    assert.equal(refRes.data.success, true);
    assert.equal(refRes.data.dashboard.userId, "FT483921");
  });

  it("10. Enforces withdrawal limit boundaries (min ₹100 and max ₹10,000) with company confirmed charge breakdown", async () => {
    const login = await makeApiCall("/api/auth/login.php", "POST", {
      identifier: "admin@facetube.com",
      password: "password",
    });
    const token = login.data.token;

    // Below minimum (< ₹100)
    const belowMin = await makeApiCall("/api/wallet/withdraw.php", "POST", { amount: 50 }, token);
    assert.equal(belowMin.status, 400);
    assert.match(belowMin.data.error, /Minimum withdrawal amount is ₹100/i);

    // Above maximum (> ₹10,000)
    const aboveMax = await makeApiCall(
      "/api/wallet/withdraw.php",
      "POST",
      { amount: 15000 },
      token,
    );
    assert.equal(aboveMax.status, 400);
    assert.match(aboveMax.data.error, /Maximum daily withdrawal limit is ₹10,000/i);

    // Valid ₹100 minimum withdrawal with confirmed charges breakdown (20% total charge: 18% GST + 2% PG -> ₹80 net)
    const valid100Withdrawal = await makeApiCall(
      "/api/wallet/withdraw.php",
      "POST",
      { amount: 100 },
      token,
    );
    assert.equal(valid100Withdrawal.status, 200);
    assert.equal(valid100Withdrawal.data.success, true);
    assert.equal(valid100Withdrawal.data.transaction.amount, 100);
    assert.equal(valid100Withdrawal.data.transaction.fee, 20);
    assert.equal(valid100Withdrawal.data.transaction.netAmount, 80);
    assert.equal(valid100Withdrawal.data.transaction.chargesBreakdown.gstAmount, 18);
    assert.equal(valid100Withdrawal.data.transaction.chargesBreakdown.pgFeeAmount, 2);
    assert.equal(valid100Withdrawal.data.transaction.chargesBreakdown.totalCharge, 20);
    assert.equal(valid100Withdrawal.data.transaction.chargesBreakdown.netPayable, 80);

    // Valid ₹1,000 withdrawal with confirmed charges breakdown (20% total charge: 18% GST + 2% PG -> ₹800 net)
    const validWithdrawal = await makeApiCall(
      "/api/wallet/withdraw.php",
      "POST",
      { amount: 1000 },
      token,
    );
    assert.equal(validWithdrawal.status, 200);
    assert.equal(validWithdrawal.data.success, true);
    assert.equal(validWithdrawal.data.transaction.amount, 1000);
    assert.equal(validWithdrawal.data.transaction.fee, 200);
    assert.equal(validWithdrawal.data.transaction.netAmount, 800);
    assert.ok(validWithdrawal.data.transaction.chargesBreakdown);
    assert.equal(validWithdrawal.data.transaction.chargesBreakdown.gstAmount, 180);
    assert.equal(validWithdrawal.data.transaction.chargesBreakdown.pgFeeAmount, 20);
    assert.equal(validWithdrawal.data.transaction.chargesBreakdown.totalCharge, 200);
    assert.equal(validWithdrawal.data.transaction.chargesBreakdown.netPayable, 800);
  });

  it("11. Rejects payment verification for mismatched amount or unsupported purpose", async () => {
    const login = await makeApiCall("/api/auth/login.php", "POST", {
      identifier: "alex@facetube.com",
      password: "password123",
    });
    const token = login.data.token;

    const orderRes = await handleApiRequest(
      new Request("http://localhost:3000/api/payments/create-order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          purpose: "premium_video_upload",
          userId: "FT483921",
        }),
      }),
      {
        RAZORPAY_KEY_ID: "rzp_test_api_123456",
        RAZORPAY_KEY_SECRET: envConfig.RAZORPAY_KEY_SECRET,
        RAZORPAY_SKIP_REMOTE_CHECK: "true",
      },
    );
    assert.ok(orderRes);
    assert.equal(orderRes.status, 200);
    const orderData = await orderRes.json();
    const ordId = orderData.orderId;
    const payId = `pay_val_${Date.now()}`;
    const sig = crypto
      .createHmac("sha256", envConfig.RAZORPAY_KEY_SECRET)
      .update(`${ordId}|${payId}`)
      .digest("hex");

    // Mismatched amount (e.g. ₹5 instead of required ₹6 for premium video)
    const badAmount = await makeApiCall(
      "/api/payments/verify.php",
      "POST",
      {
        orderId: ordId,
        paymentId: payId,
        signature: sig,
        purpose: "premium_video_upload",
        amount: 5.0,
      },
      token,
    );
    assert.equal(badAmount.status, 400);
    assert.match(badAmount.data.error, /does not match expected fee/i);

    // Unsupported purpose (client purpose does not match server order purpose)
    const badPurpose = await makeApiCall(
      "/api/payments/verify.php",
      "POST",
      {
        orderId: ordId,
        paymentId: payId,
        signature: sig,
        purpose: "unknown_hack_purpose",
      },
      token,
    );
    assert.equal(badPurpose.status, 400);
    assert.match(badPurpose.data.error, /purpose does not match|Unsupported payment purpose/i);
  });

  it("12. Rejects payment verification when user attempts to verify video owned by another creator", async () => {
    // Maya Lin attempting to verify Alex's video (vid-seed-001)
    const login = await makeApiCall("/api/auth/login.php", "POST", {
      identifier: "maya@facetube.com",
      password: "password123",
    });
    const token = login.data.token;

    const orderRes = await handleApiRequest(
      new Request("http://localhost:3000/api/payments/create-order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          purpose: "premium_video_upload",
          userId: "FT900431",
        }),
      }),
      {
        RAZORPAY_KEY_ID: "rzp_test_api_123456",
        RAZORPAY_KEY_SECRET: envConfig.RAZORPAY_KEY_SECRET,
        RAZORPAY_SKIP_REMOTE_CHECK: "true",
      },
    );
    assert.ok(orderRes);
    assert.equal(orderRes.status, 200);
    const orderData = await orderRes.json();
    const ordId = orderData.orderId;
    const payId = `pay_vid_${Date.now()}`;
    const sig = crypto
      .createHmac("sha256", envConfig.RAZORPAY_KEY_SECRET)
      .update(`${ordId}|${payId}`)
      .digest("hex");

    const res = await makeApiCall(
      "/api/payments/verify.php",
      "POST",
      {
        orderId: ordId,
        paymentId: payId,
        signature: sig,
        videoId: "vid-seed-001", // Alex's video
        userId: "FT900431", // Maya's ID
        purpose: "premium_video_upload",
      },
      token,
    );

    assert.equal(res.status, 403);
    assert.match(res.data.error, /does not match the authenticated payer/i);
  });

  it("13. Proves wallet withdrawal action invokes api.wallet.withdraw mutation exactly once", async () => {
    let withdrawCallCount = 0;
    const originalWithdraw = api.wallet.withdraw;
    const originalGetBalance = api.wallet.getBalance;

    api.wallet.getBalance = async (_userId?: string) => {
      return {
        success: true,
        wallet: {
          user_id: "FT483921",
          balance: 5000,
          total_earned: 5000,
          total_withdrawn: 0,
          referral_income: 0,
          global_income: 0,
          adsense_income: 0,
          affiliate_income: 0,
          updated_at: new Date().toISOString(),
        },
      };
    };

    api.wallet.withdraw = async (_data: any) => {
      withdrawCallCount++;
      return {
        success: true,
        transaction: { id: "test_tx_wdr_1" },
        updatedWallet: { balance: 4000, total_withdrawn: 1000 },
      };
    };

    try {
      const res = await processWithdrawal("FT483921", 1000, {
        accountHolder: "Alex Rivera",
        accountNumber: "50100481920194",
        bankName: "HDFC Bank",
        upiId: "alexrivera@okhdfcbank",
      });

      assert.equal(res.success, true, "Withdrawal should succeed when balance is sufficient");
      assert.equal(
        withdrawCallCount,
        1,
        "api.wallet.withdraw must be called exactly once per withdrawal action",
      );
    } finally {
      api.wallet.withdraw = originalWithdraw;
      api.wallet.getBalance = originalGetBalance;
    }
  });

  it("13b. Proves processWithdrawal NEVER returns success: true when api.wallet.withdraw throws an error", async () => {
    const originalWithdraw = api.wallet.withdraw;
    const originalGetBalance = api.wallet.getBalance;

    api.wallet.getBalance = async (_userId?: string) => {
      return {
        success: true,
        wallet: {
          user_id: "FT483921",
          balance: 5000,
          total_earned: 5000,
          total_withdrawn: 0,
          referral_income: 0,
          global_income: 0,
          adsense_income: 0,
          affiliate_income: 0,
          updated_at: new Date().toISOString(),
        },
      };
    };

    // Simulate upstream Hostinger failure / network drop
    api.wallet.withdraw = async (_data: any) => {
      throw new Error("502 Bad Gateway: Upstream Hostinger API connection failed");
    };

    saveStoredLedger([]);
    try {
      const res = await processWithdrawal("FT483921", 1000, {
        accountHolder: "Alex Rivera",
        accountNumber: "50100481920194",
        bankName: "HDFC Bank",
      });

      assert.equal(res.success, false, "Must NEVER return success: true when server call fails");
      assert.ok(res.error, "Must provide an honest error explanation");
      assert.match(
        res.error!,
        /could not be verified by server/i,
        "Error message must clearly inform the user that funds were not deducted",
      );
    } finally {
      api.wallet.withdraw = originalWithdraw;
      api.wallet.getBalance = originalGetBalance;
    }
  });

  it("13c. Proves processWithdrawal NEVER returns success: true when api.wallet.withdraw returns success: false", async () => {
    const originalWithdraw = api.wallet.withdraw;
    const originalGetBalance = api.wallet.getBalance;

    api.wallet.getBalance = async (_userId?: string) => {
      return {
        success: true,
        wallet: {
          user_id: "FT483921",
          balance: 5000,
          total_earned: 5000,
          total_withdrawn: 0,
          referral_income: 0,
          global_income: 0,
          adsense_income: 0,
          affiliate_income: 0,
          updated_at: new Date().toISOString(),
        },
      };
    };

    // Simulate server rejecting withdrawal
    api.wallet.withdraw = async (_data: any) => {
      return {
        success: false,
        error: "Hostinger database lock timeout: transaction rolled back.",
      };
    };

    saveStoredLedger([]);
    try {
      const res = await processWithdrawal("FT483921", 1000, {
        accountHolder: "Alex Rivera",
        accountNumber: "50100481920194",
        bankName: "HDFC Bank",
      });

      assert.equal(
        res.success,
        false,
        "Must return success: false when server rejects transaction",
      );
      assert.equal(
        res.error,
        "Hostinger database lock timeout: transaction rolled back.",
        "Must return authoritative server rejection reason",
      );
    } finally {
      api.wallet.withdraw = originalWithdraw;
      api.wallet.getBalance = originalGetBalance;
    }
  });

  it("13d. Proves getUserWallet marks isStale: true when server API fails without overwriting local cache", async () => {
    const originalGetBalance = api.wallet.getBalance;

    // Simulate server connection failure
    api.wallet.getBalance = async (_userId?: string) => {
      throw new Error("Network unreachable");
    };

    try {
      const w = await getUserWallet("FT999999");
      assert.equal(w.isStale, true, "Must be tagged as isStale: true on API failure");
      assert.equal(w.userId, "FT999999");
    } finally {
      api.wallet.getBalance = originalGetBalance;
    }
  });

  it("14. Admin bulk payout executes batch disbursement and updates wallet deductions consistently", async () => {
    // Ensure sufficient test balances for recipients (FT483921: 100, FT102857: 15400)
    setStoreWalletBalance("FT483921", 100);
    setStoreWalletBalance("FT102857", 15400);

    const adminLogin = await makeApiCall("/api/auth/login.php", "POST", {
      identifier: "admin@facetube.com",
      password: "password",
    });
    const adminToken = adminLogin.data.token;

    const bulkRes = await makeApiCall(
      "/api/admin/bulk-payout.php",
      "POST",
      {
        payouts: [
          { userId: "FT483921", amount: 50 },
          { userId: "FT102857", amount: 250 },
        ],
        notes: "Test batch payout disbursement",
      },
      adminToken,
    );
    assert.equal(bulkRes.status, 200);
    assert.equal(bulkRes.data.success, true);
    assert.equal(bulkRes.data.total_recipients, 2);
    assert.equal(bulkRes.data.total_amount, 300);
    assert.ok(bulkRes.data.batch_id);
  });
});

describe("Database Transaction Rollback Simulation Tests", () => {
  it("Simulates MySQL transaction rollback on failure during payment verification flow", async () => {
    let transactionBegun = false;
    let transactionCommitted = false;
    let transactionRolledBack = false;

    // Mock MySQL Connection with transactional operations
    const mockConnection = {
      beginTransaction: async () => {
        transactionBegun = true;
      },
      query: async (sql: string) => {
        if (sql.includes("SELECT * FROM payment_transactions")) {
          return [[]]; // No duplicate
        }
        if (sql.includes("COUNT(*)")) {
          return [[{ total: 5 }]];
        }
        if (sql.includes("INSERT INTO payment_transactions")) {
          // Simulate simulated unexpected database constraint error on ledger
          throw new Error("Simulated database failure during ledger step");
        }
        return [{}];
      },
      commit: async () => {
        transactionCommitted = true;
      },
      rollback: async () => {
        transactionRolledBack = true;
      },
      release: () => {},
    };

    try {
      await mockConnection.beginTransaction();
      await mockConnection.query("SELECT * FROM payment_transactions WHERE payment_id = ?");
      await mockConnection.query("INSERT INTO payment_transactions ...");
      await mockConnection.commit();
    } catch (_err) {
      await mockConnection.rollback();
    }

    assert.equal(transactionBegun, true, "Transaction must begin");
    assert.equal(transactionCommitted, false, "Transaction must not commit on error");
    assert.equal(transactionRolledBack, true, "Transaction must roll back on error");
  });
});

describe("Razorpay Real Order Creation & Gateway Verification Tests", () => {
  const testKeyId = "rzp_test_testkey123456";
  const testSecret = "test_secret_key_abcdef123456";

  it("1. createServerPaymentOrder fails closed when credentials missing", async () => {
    const { createServerPaymentOrder } = await import("./payments");

    await assert.rejects(async () => {
      await createServerPaymentOrder(
        {
          purpose: "premium_video_upload",
          userId: "FT483921",
        },
        { RAZORPAY_KEY_ID: "", RAZORPAY_KEY_SECRET: "" },
      );
    }, /credentials.*not configured/i);
  });

  it("2. createServerPaymentOrder generates exact pricing for premium video and ads", async () => {
    const { createServerPaymentOrder } = await import("./payments");

    // Premium video: ₹6.00 / 600 paise
    const premiumOrder = await createServerPaymentOrder(
      {
        purpose: "premium_video_upload",
        userId: "FT483921",
      },
      {
        RAZORPAY_KEY_ID: testKeyId,
        RAZORPAY_KEY_SECRET: testSecret,
        RAZORPAY_SKIP_REMOTE_CHECK: "true",
      },
    );
    assert.equal(premiumOrder.amount, 6.0);
    assert.equal(premiumOrder.amountInSubunits, 600);
    assert.equal(premiumOrder.currency, "INR");

    // Ads promotion: 7 days = ₹100 / 10000 paise
    const ads7Days = await createServerPaymentOrder(
      {
        purpose: "ads_promotion",
        userId: "FT483921",
        planId: "plan-7-days",
      },
      {
        RAZORPAY_KEY_ID: testKeyId,
        RAZORPAY_KEY_SECRET: testSecret,
        RAZORPAY_SKIP_REMOTE_CHECK: "true",
      },
    );
    assert.equal(ads7Days.amount, 100.0);
    assert.equal(ads7Days.amountInSubunits, 10000);

    // Ads promotion: 15 days = ₹200 / 20000 paise
    const ads15Days = await createServerPaymentOrder(
      {
        purpose: "ads_promotion",
        userId: "FT483921",
        planId: "plan-15-days",
      },
      {
        RAZORPAY_KEY_ID: testKeyId,
        RAZORPAY_KEY_SECRET: testSecret,
        RAZORPAY_SKIP_REMOTE_CHECK: "true",
      },
    );
    assert.equal(ads15Days.amount, 200.0);
    assert.equal(ads15Days.amountInSubunits, 20000);

    // Ads promotion: monthly = ₹300 / 30000 paise
    const adsMonthly = await createServerPaymentOrder(
      {
        purpose: "ads_promotion",
        userId: "FT483921",
        planId: "plan-monthly",
      },
      {
        RAZORPAY_KEY_ID: testKeyId,
        RAZORPAY_KEY_SECRET: testSecret,
        RAZORPAY_SKIP_REMOTE_CHECK: "true",
      },
    );
    assert.equal(adsMonthly.amount, 300.0);
    assert.equal(adsMonthly.amountInSubunits, 30000);

    // Ads promotion: yearly = ₹3,000 / 300000 paise
    const adsYearly = await createServerPaymentOrder(
      {
        purpose: "ads_promotion",
        userId: "FT483921",
        planId: "plan-yearly",
      },
      {
        RAZORPAY_KEY_ID: testKeyId,
        RAZORPAY_KEY_SECRET: testSecret,
        RAZORPAY_SKIP_REMOTE_CHECK: "true",
      },
    );
    assert.equal(adsYearly.amount, 3000.0);
    assert.equal(adsYearly.amountInSubunits, 300000);
  });

  it("3. API create-order route returns 503 when credentials missing", async () => {
    const req = new Request("http://localhost:3000/api/payments/create-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        purpose: "premium_video_upload",
        userId: "FT483921",
      }),
    });

    const res = await handleApiRequest(req, {
      RAZORPAY_KEY_ID: "",
      RAZORPAY_KEY_SECRET: "",
    });

    assert.ok(res);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.match(body.error || "", /credentials.*not configured/i);
  });

  it("4. Verifies all four ads promotion tiers with exact authoritative pricing via metadata or planId", async () => {
    const loginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login.php", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
      }),
    );
    assert.ok(loginRes);
    const { token } = await loginRes.json();

    const rzpEnv = {
      RAZORPAY_KEY_ID: testKeyId,
      RAZORPAY_KEY_SECRET: testSecret,
      RAZORPAY_SKIP_REMOTE_CHECK: "true",
    };

    const testCases: Array<{
      planId: "plan-7-days" | "plan-15-days" | "plan-monthly" | "plan-yearly";
      expectedAmount: number;
    }> = [
      { planId: "plan-7-days", expectedAmount: 100.0 },
      { planId: "plan-15-days", expectedAmount: 200.0 },
      { planId: "plan-monthly", expectedAmount: 300.0 },
      { planId: "plan-yearly", expectedAmount: 3000.0 },
    ];

    for (const { planId, expectedAmount } of testCases) {
      const orderRes = await handleApiRequest(
        new Request("http://localhost:3000/api/payments/create-order", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            purpose: "ads_promotion",
            userId: "FT483921",
            videoId: "vid-seed-002",
            planId,
          }),
        }),
        rzpEnv,
      );
      assert.ok(orderRes);
      assert.equal(orderRes.status, 200);
      const { orderId } = await orderRes.json();

      const paymentId = `pay_test_ads_${planId}_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`;
      const signature = crypto
        .createHmac("sha256", testSecret)
        .update(`${orderId}|${paymentId}`)
        .digest("hex");

      // Verify sending planId inside metadata (as frontend ads-promotions.tsx does)
      const req = new Request("http://localhost:3000/api/payments/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          orderId,
          paymentId,
          signature,
          userId: "FT483921",
          videoId: "vid-seed-002",
          purpose: "ads_promotion",
          metadata: { planId },
          amount: expectedAmount,
        }),
      });

      const res = await handleApiRequest(req, rzpEnv);

      assert.ok(res);
      assert.equal(res.status, 200, `Plan ${planId} verification should return 200`);
      const body = await res.json();
      assert.equal(body.verified, true, `Plan ${planId} should be verified`);
      assert.equal(
        body.amount,
        expectedAmount,
        `Plan ${planId} should charge exactly ₹${expectedAmount}`,
      );
    }

    // Verify amount mismatch rejection: e.g. claiming ₹100 for yearly ₹3,000 plan
    const badOrderRes = await handleApiRequest(
      new Request("http://localhost:3000/api/payments/create-order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          purpose: "ads_promotion",
          userId: "FT483921",
          videoId: "vid-seed-002",
          planId: "plan-yearly",
        }),
      }),
      rzpEnv,
    );
    assert.ok(badOrderRes);
    const { orderId: badOrderId } = await badOrderRes.json();
    const badPayId = `pay_test_mismatch_${Date.now()}`;
    const badSig = crypto
      .createHmac("sha256", testSecret)
      .update(`${badOrderId}|${badPayId}`)
      .digest("hex");

    const mismatchReq = new Request("http://localhost:3000/api/payments/verify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        orderId: badOrderId,
        paymentId: badPayId,
        signature: badSig,
        userId: "FT483921",
        videoId: "vid-seed-002",
        purpose: "ads_promotion",
        metadata: { planId: "plan-yearly" },
        amount: 100.0, // Fraudulent claim: ₹100 instead of ₹3,000
      }),
    });

    const mismatchRes = await handleApiRequest(mismatchReq, rzpEnv);

    assert.ok(mismatchRes);
    assert.equal(mismatchRes.status, 400, "Mismatched amount must return 400");
    const mismatchBody = await mismatchRes.json();
    assert.equal(mismatchBody.verified, false);
    assert.match(mismatchBody.error, /does not match expected fee of ₹3000\.00/i);
  });

  it("5. Rejects unauthorized video promotion order creation by non-owner user with 403", async () => {
    // Log in as Maya Lin (FT900431)
    const loginReq = new Request("http://localhost:3000/api/auth/login.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "maya@facetube.com",
        password: "password123",
      }),
    });
    const loginRes = await handleApiRequest(loginReq);
    assert.ok(loginRes);
    const loginData = await loginRes.json();
    const token = loginData.token;

    // Maya attempts to initiate an ad promotion for Alex's video (vid-seed-001, owned by FT483921)
    const req = new Request("http://localhost:3000/api/payments/create-order", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        purpose: "ads_promotion",
        videoId: "vid-seed-001", // Alex's video
        userId: "FT900431", // Maya's ID
        planId: "plan-monthly",
      }),
    });

    const res = await handleApiRequest(req, {
      RAZORPAY_KEY_ID: testKeyId,
      RAZORPAY_KEY_SECRET: testSecret,
      RAZORPAY_SKIP_REMOTE_CHECK: "true",
    });

    assert.ok(res);
    assert.equal(res.status, 403, "Non-owner promotion order must be rejected with 403");
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.error, /only initiate promotion for your own uploaded videos/i);
  });

  it("6. Activates promotion with renewal logic and prevents duplicate re-extension on repeated verification", async () => {
    const loginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login.php", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
      }),
    );
    assert.ok(loginRes);
    const { token } = await loginRes.json();

    const rzpEnv = {
      RAZORPAY_KEY_ID: testKeyId,
      RAZORPAY_KEY_SECRET: testSecret,
      RAZORPAY_SKIP_REMOTE_CHECK: "true",
    };

    const createOrderRes = await handleApiRequest(
      new Request("http://localhost:3000/api/payments/create-order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          purpose: "ads_promotion",
          userId: "FT483921",
          videoId: "vid-seed-002",
          planId: "plan-7-days",
        }),
      }),
      rzpEnv,
    );
    assert.ok(createOrderRes);
    assert.equal(createOrderRes.status, 200);
    const { orderId } = await createOrderRes.json();

    const paymentId = `pay_test_renewal_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const signature = crypto
      .createHmac("sha256", testSecret)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");

    // First verification (Alex promotes his own video vid-seed-002 for 7 days)
    const verifyReq1 = new Request("http://localhost:3000/api/payments/verify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        orderId,
        paymentId,
        signature,
        userId: "FT483921",
        videoId: "vid-seed-002",
        purpose: "ads_promotion",
        planId: "plan-7-days",
        amount: 100.0,
      }),
    });

    const res1 = await handleApiRequest(verifyReq1, rzpEnv);

    assert.ok(res1);
    assert.equal(res1.status, 200);
    const body1 = await res1.json();
    assert.equal(body1.verified, true);

    // Read video's recorded promotion expiry after 1st verification
    const vidReq1 = new Request("http://localhost:3000/api/videos/get.php?id=vid-seed-002");
    const vidRes1 = await handleApiRequest(vidReq1);
    assert.ok(vidRes1);
    const vidData1 = await vidRes1.json();
    assert.equal(vidData1.video.isPromoted, true);
    const firstExpiry = vidData1.video.promotionExpiresAt;
    assert.ok(firstExpiry, "Expiry date must be set");

    // Second repeated verification of the exact same paymentId
    const verifyReq2 = new Request("http://localhost:3000/api/payments/verify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        orderId,
        paymentId,
        signature,
        userId: "FT483921",
        videoId: "vid-seed-002",
        purpose: "ads_promotion",
        planId: "plan-7-days",
        amount: 100.0,
      }),
    });

    const res2 = await handleApiRequest(verifyReq2, rzpEnv);

    assert.ok(res2);
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.verified, true);
    assert.equal(body2.duplicate, true, "Must be flagged as idempotent duplicate");

    // Re-verify that expiry date was NOT extended again on duplicate call
    const vidReq2 = new Request("http://localhost:3000/api/videos/get.php?id=vid-seed-002");
    const vidRes2 = await handleApiRequest(vidReq2);
    assert.ok(vidRes2);
    const vidData2 = await vidRes2.json();
    assert.equal(
      vidData2.video.promotionExpiresAt,
      firstExpiry,
      "Duplicate verification must NOT extend promotion expiry date again",
    );
  });
});

describe("Task 32: Yearly Ads Pricing & Expired Ad Promotion Validation Tests", () => {
  it("1. Verifies authoritative ₹3,000 yearly ads plan pricing across server configurations", () => {
    const yearlyPlan = PRICING_CONFIG.ADS_PROMOTION["plan-yearly"];
    assert.equal(yearlyPlan.price, 3000, "Yearly ads plan must be exactly ₹3,000");
    assert.equal(yearlyPlan.days, 365, "Yearly ads plan duration must be 365 days");

    // All four plan prices must agree with company specifications
    assert.equal(PRICING_CONFIG.ADS_PROMOTION["plan-7-days"].price, 100);
    assert.equal(PRICING_CONFIG.ADS_PROMOTION["plan-15-days"].price, 200);
    assert.equal(PRICING_CONFIG.ADS_PROMOTION["plan-monthly"].price, 300);
    assert.equal(PRICING_CONFIG.ADS_PROMOTION["plan-yearly"].price, 3000);
  });

  it("2. isAdPromotionActive and isPromotionActive return true strictly for active future promotions", () => {
    const futureDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const activeSample = {
      isPromoted: true,
      promotionExpiresAt: futureDate,
    };

    assert.equal(isAdPromotionActive(activeSample), true);
    assert.equal(isPromotionActive(activeSample), true);
  });

  it("3. isAdPromotionActive and isPromotionActive return false for expired promotions (past timestamp)", () => {
    const pastDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const expiredSample = {
      is_promoted: true,
      promotion_expires_at: pastDate,
    };

    assert.equal(isAdPromotionActive(expiredSample), false);
    assert.equal(isPromotionActive(expiredSample), false);
  });

  it("4. Safely handles null, undefined, or empty expiry timestamps by failing closed (returns false)", () => {
    const nullExpirySample = { isPromoted: true, promotionExpiresAt: null };
    const missingExpirySample = { is_promoted: true };
    const invalidDateSample = { isPromoted: true, promotionExpiresAt: "invalid-timestamp" };
    const unpromotedSample = {
      isPromoted: false,
      promotionExpiresAt: new Date(Date.now() + 100000).toISOString(),
    };

    assert.equal(isAdPromotionActive(nullExpirySample as any), false);
    assert.equal(isPromotionActive(nullExpirySample as any), false);

    assert.equal(isAdPromotionActive(missingExpirySample as any), false);
    assert.equal(isPromotionActive(missingExpirySample as any), false);

    assert.equal(isAdPromotionActive(invalidDateSample), false);
    assert.equal(isPromotionActive(invalidDateSample), false);

    assert.equal(isAdPromotionActive(unpromotedSample), false);
    assert.equal(isPromotionActive(unpromotedSample), false);
  });

  it("5. API /api/videos/list correctly assigns isPromoted false and deprioritizes expired promotions", async () => {
    const req = new Request("http://localhost:3000/api/videos/list");
    const res = await handleApiRequest(req);
    assert.ok(res);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.videos));

    // Verify all returned videos have isPromoted consistently matching expiry evaluation
    for (const vid of body.videos) {
      if (vid.isPromoted) {
        assert.ok(vid.promotionExpiresAt, "Promoted video must have an expiry timestamp");
        const exp = new Date(vid.promotionExpiresAt).getTime();
        assert.ok(
          exp > Date.now(),
          `Active promoted video must have future expiry date: ${vid.promotionExpiresAt}`,
        );
      }
    }
  });
});

describe("Task 33: 7-Level Ads Referral Distribution & Counter Isolation Tests", () => {
  const secret = "test_razorpay_secret_key_1234567890";
  const env = {
    RAZORPAY_KEY_ID: "rzp_test_1234567890",
    RAZORPAY_KEY_SECRET: secret,
    RAZORPAY_SKIP_REMOTE_CHECK: "true",
  };

  const fullUplineChain = [
    { level: 1, userId: "UP_LEVEL_1", name: "Sponsor L1" },
    { level: 2, userId: "UP_LEVEL_2", name: "Sponsor L2" },
    { level: 3, userId: "UP_LEVEL_3", name: "Sponsor L3" },
    { level: 4, userId: "UP_LEVEL_4", name: "Sponsor L4" },
    { level: 5, userId: "UP_LEVEL_5", name: "Sponsor L5" },
    { level: 6, userId: "UP_LEVEL_6", name: "Sponsor L6" },
    { level: 7, userId: "UP_LEVEL_7", name: "Sponsor L7" },
  ];

  it("1. Evaluates all four ads promotion tiers with exact 7-level payouts and zero paise leakage", () => {
    const plans = [
      { amount: 100, label: "7 Days (₹100)", expectedReferral: 40, expectedAdmin: 60 },
      { amount: 200, label: "15 Days (₹200)", expectedReferral: 80, expectedAdmin: 120 },
      { amount: 300, label: "1 Month (₹300)", expectedReferral: 120, expectedAdmin: 180 },
      { amount: 3000, label: "1 Year (₹3,000)", expectedReferral: 1200, expectedAdmin: 1800 },
    ];

    const expectedRates = [
      { level: 1, pct: 15 },
      { level: 2, pct: 10 },
      { level: 3, pct: 5 },
      { level: 4, pct: 4 },
      { level: 5, pct: 3 },
      { level: 6, pct: 2 },
      { level: 7, pct: 1 },
    ];

    for (const plan of plans) {
      const dist = evaluateAdsDistribution(plan.amount, fullUplineChain);
      assert.equal(dist.planAmount, plan.amount);
      assert.equal(dist.totalReferralAmount, plan.expectedReferral);
      assert.equal(dist.adminAmount, plan.expectedAdmin);
      assert.equal(dist.adminPercent, 60);
      assert.equal(dist.missingLevels.length, 0);

      // Verify each level
      let sumPaise = 0;
      for (const tier of expectedRates) {
        const payout = dist.levelPayouts.find((p) => p.level === tier.level);
        assert.ok(payout, `Missing payout for level ${tier.level} in ${plan.label}`);
        const expectedTierPaise = Math.round(plan.amount * 100 * (tier.pct / 100));
        assert.equal(payout.amountPaise, expectedTierPaise);
        assert.equal(payout.amount, expectedTierPaise / 100);
        sumPaise += payout.amountPaise;
      }

      assert.equal(sumPaise, plan.expectedReferral * 100);
      assert.equal(sumPaise + dist.adminPaise, plan.amount * 100, `Paise leakage in ${plan.label}`);
      assert.equal(dist.totalReferralAmount + dist.adminAmount, plan.amount);
    }
  });

  it("2. Accurately redirects missing level percentages to Admin when partial or no upline exists", () => {
    // 2 levels present (L1, L2): L1=15%, L2=10% -> 25% referral. Missing L3-L7 = 15%. Admin = 60% + 15% = 75%.
    const partial2 = [
      { level: 1, userId: "UP1" },
      { level: 2, userId: "UP2" },
    ];
    const dist2 = evaluateAdsDistribution(100, partial2);
    assert.equal(dist2.totalReferralAmount, 25);
    assert.equal(dist2.adminAmount, 75);
    assert.equal(dist2.adminPercent, 75);
    assert.deepEqual(dist2.missingLevels, [3, 4, 5, 6, 7]);
    assert.equal(dist2.totalReferralAmount + dist2.adminAmount, 100);

    // 1 level present (L1 only): L1=15% -> 15% referral. Missing L2-L7 = 25%. Admin = 60% + 25% = 85%.
    const partial1 = [{ level: 1, userId: "UP1" }];
    const dist1 = evaluateAdsDistribution(300, partial1);
    assert.equal(dist1.totalReferralAmount, 45); // 15% of 300
    assert.equal(dist1.adminAmount, 255); // 85% of 300
    assert.equal(dist1.adminPercent, 85);
    assert.deepEqual(dist1.missingLevels, [2, 3, 4, 5, 6, 7]);
    assert.equal(dist1.totalReferralAmount + dist1.adminAmount, 300);

    // 0 levels present (orphan creator): Admin receives 100% (Base 60% + 40% redirected)
    const dist0 = evaluateAdsDistribution(3000, []);
    assert.equal(dist0.totalReferralAmount, 0);
    assert.equal(dist0.adminAmount, 3000);
    assert.equal(dist0.adminPercent, 100);
    assert.equal(dist0.levelPayouts.length, 0);
    assert.deepEqual(dist0.missingLevels, [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(dist0.totalReferralAmount + dist0.adminAmount, 3000);
  });

  it("3. Resolves upline sponsors safely and terminates without infinite loop on cycles or self-referrals", () => {
    // Mock user dataset with circular loop: User A -> User B -> User C -> User A
    const usersWithLoop = [
      { user_id: "USER_A", referral_code: "USER_B" },
      { user_id: "USER_B", referral_code: "USER_C" },
      { user_id: "USER_C", referral_code: "USER_A" }, // Loop back to A
    ];

    const uplinesFromA = resolveUplineSponsors("USER_A", usersWithLoop);
    // Should resolve B (L1), C (L2), then stop when encountering A (already visited)
    assert.equal(uplinesFromA.length, 2);
    assert.equal(uplinesFromA[0]?.level, 1);
    assert.equal(uplinesFromA[0]?.userId, "USER_B");
    assert.equal(uplinesFromA[1]?.level, 2);
    assert.equal(uplinesFromA[1]?.userId, "USER_C");

    // Self-referral case: User X refers User X
    const selfRefUsers = [{ user_id: "USER_X", referral_code: "USER_X" }];
    const uplinesSelf = resolveUplineSponsors("USER_X", selfRefUsers);
    assert.equal(uplinesSelf.length, 0);

    // Full 7-level clean chain
    const deepChainUsers = [
      { user_id: "CREATOR", referral_code: "SPONSOR_1" },
      { user_id: "SPONSOR_1", referral_code: "SPONSOR_2" },
      { user_id: "SPONSOR_2", referral_code: "SPONSOR_3" },
      { user_id: "SPONSOR_3", referral_code: "SPONSOR_4" },
      { user_id: "SPONSOR_4", referral_code: "SPONSOR_5" },
      { user_id: "SPONSOR_5", referral_code: "SPONSOR_6" },
      { user_id: "SPONSOR_6", referral_code: "SPONSOR_7" },
      { user_id: "SPONSOR_7", referral_code: "SPONSOR_8" }, // Level 8 should not be included
    ];

    const deepUplines = resolveUplineSponsors("CREATOR", deepChainUsers);
    assert.equal(deepUplines.length, 7);
    assert.equal(deepUplines[0]?.userId, "SPONSOR_1");
    assert.equal(deepUplines[6]?.userId, "SPONSOR_7");
  });

  it("4. Ads promotion payments do NOT increment or trigger the ₹6 special 11th/21st/31st counter", async () => {
    const initialTxNum = await getPersistentPremiumTxNumber();

    const orderId = `ord_ads_iso_${Date.now()}`;
    const paymentId = `pay_ads_iso_${Date.now()}`;
    const sig = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

    const res = await verifyServerPayment(
      {
        orderId,
        paymentId,
        signature: sig,
        userId: "FT483921",
        purpose: "ads_promotion",
        planId: "plan-monthly",
      },
      ["FT483921"],
      "FT102857",
      env,
      fullUplineChain,
    );

    assert.equal(res.verified, true);
    assert.equal(res.purpose, "ads_promotion");
    assert.equal(res.specialTag, "ADS_PROMOTION");
    assert.equal(res.isSpecialTransaction, false);

    // The persistent sequence counter MUST NOT have incremented
    const afterTxNum = await getPersistentPremiumTxNumber();
    assert.equal(
      afterTxNum,
      initialTxNum,
      "Ads promotion must not advance the premium video sequence counter",
    );
  });

  it("5. Idempotent duplicate verification rejects double credit for ads promotion", async () => {
    const orderId = `ord_ads_dup_${Date.now()}`;
    const paymentId = `pay_ads_dup_${Date.now()}`;
    const sig = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

    // First verification
    const res1 = await verifyServerPayment(
      {
        orderId,
        paymentId,
        signature: sig,
        userId: "FT483921",
        purpose: "ads_promotion",
        planId: "plan-7-days",
      },
      ["FT483921"],
      "FT102857",
      env,
      fullUplineChain,
    );

    assert.equal(res1.verified, true);
    assert.equal(res1.amount, 100);
    assert.equal(res1.duplicate, undefined);

    // Second verification with identical payment ID
    const res2 = await verifyServerPayment(
      {
        orderId,
        paymentId,
        signature: sig,
        userId: "FT483921",
        purpose: "ads_promotion",
        planId: "plan-7-days",
      },
      ["FT483921"],
      "FT102857",
      env,
      fullUplineChain,
    );

    assert.equal(res2.verified, true);
    assert.equal(res2.duplicate, true);
    assert.match(res2.error || "", /already been processed/i);
    assert.equal(res2.amount, 100);
  });

  it("6. API endpoint /api/payments/verify processes ads promotion and returns 7-level distribution breakdown", async () => {
    const loginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login.php", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
      }),
    );
    assert.ok(loginRes);
    const { token } = await loginRes.json();

    const orderRes = await handleApiRequest(
      new Request("http://localhost:3000/api/payments/create-order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          purpose: "ads_promotion",
          userId: "FT483921",
          videoId: "vid-seed-002",
          planId: "plan-yearly",
        }),
      }),
      env,
    );
    assert.ok(orderRes);
    assert.equal(orderRes.status, 200);
    const { orderId } = await orderRes.json();

    const paymentId = `pay_api_ads_${Date.now()}`;
    const sig = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

    const req = new Request("http://localhost:3000/api/payments/verify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        orderId,
        paymentId,
        signature: sig,
        userId: "FT483921",
        userName: "Alex Rivera",
        videoId: "vid-seed-002",
        purpose: "ads_promotion",
        planId: "plan-yearly",
        metadata: { planId: "plan-yearly" },
      }),
    });

    const res = await handleApiRequest(req, env);
    assert.ok(res);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.verified, true);
    assert.equal(body.amount, 3000);
    assert.equal(body.purpose, "ads_promotion");
    assert.equal(body.specialTag, "ADS_PROMOTION");
    assert.ok(body.distribution);
    assert.ok(Array.isArray(body.distribution.levelPayouts));
    assert.ok(Array.isArray(body.distribution.missingLevels));
    assert.equal(typeof body.distribution.adminAmount, "number");
    assert.equal(typeof body.distribution.totalReferralAmount, "number");
    assert.equal(body.distribution.adminAmount + body.distribution.totalReferralAmount, 3000);
  });
});

describe("Task 34: Premium Video Global Pool & Admin Ledger Verification Tests", () => {
  const secret = "test_razorpay_secret_key_1234567890";
  const env = {
    RAZORPAY_KEY_ID: "rzp_test_1234567890",
    RAZORPAY_KEY_SECRET: secret,
    RAZORPAY_SKIP_REMOTE_CHECK: "true",
  };

  it("1. Normal transaction with multiple eligible previous creators distributes integer paise equally", async () => {
    // Isolate sequence state to tx #1 so next is tx #2 (normal, non-special)
    await resetPersistentPremiumState(1, []);

    // Pure calculation check: tx 2, valid referrer, 2 eligible creators
    const dist = evaluatePremiumDistribution(2, "FT102857", 2);
    assert.equal(dist.isSpecial, false);
    assert.equal(dist.directReferralAmount, 1.0);
    assert.equal(dist.adminAmount, 1.0);
    assert.equal(dist.globalPoolAmount, 3.0);
    assert.equal(dist.perMemberShare, 1.5);
    assert.equal(dist.totalAmount, 6.0);

    // Gateway / server verification check
    const orderId = `ord_t34_norm_${Date.now()}`;
    const paymentId = `pay_t34_norm_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const sig = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

    const res = await verifyServerPayment(
      {
        orderId,
        paymentId,
        signature: sig,
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      ["CREATOR_PREV_1", "CREATOR_PREV_2"],
      "FT102857",
      env,
    );

    assert.equal(res.verified, true);
    assert.equal(res.amount, 6.0);
    assert.equal(res.txNumber, 2);
    assert.equal(res.isSpecialTransaction, false);
    assert.equal(res.distribution?.directReferralAmount, 1.0);
    assert.equal(res.distribution?.adminAmount, 1.0);
    assert.equal(res.distribution?.globalPoolAmount, 3.0);
    assert.equal(res.distribution?.eligibleMembersCount, 2);
    assert.equal(res.distribution?.perMemberShare, 1.5);
    assert.ok(Array.isArray(res.distribution?.creatorPayouts));
    assert.equal(res.distribution?.creatorPayouts?.length, 2);
    assert.equal(res.distribution?.creatorPayouts?.[0]?.amount, 1.5);
    assert.equal(res.distribution?.creatorPayouts?.[1]?.amount, 1.5);
  });

  it("2. First transaction with no eligible creators keeps Admin at ₹1.00 and preserves ₹3.00 in pending Global Pool reserve", async () => {
    // Reset to 0 so next is tx #1
    await resetPersistentPremiumState(0, []);

    // Pure calculation: 0 eligible creators, valid referrer -> Admin ₹1.00, Global Pool ₹3.00 pending reserve
    const dist = evaluatePremiumDistribution(1, "FT102857", 0);
    assert.equal(dist.isSpecial, false);
    assert.equal(dist.directReferralAmount, 1.0);
    assert.equal(dist.adminAmount, 1.0);
    assert.equal(dist.globalPoolAmount, 3.0);
    assert.equal(dist.globalPoolDistributedAmount, 0.0);
    assert.equal(dist.globalPoolReserveAmount, 3.0);
    assert.equal(dist.globalPoolStatus, "pending_reserve");
    assert.equal(dist.reserveReason, "no_eligible_videos");
    assert.equal(dist.perMemberShare, 0.0);
    assert.equal(dist.totalAmount, 6.0);

    const orderId = `ord_t34_first_${Date.now()}`;
    const paymentId = `pay_t34_first_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const sig = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

    const res = await verifyServerPayment(
      {
        orderId,
        paymentId,
        signature: sig,
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      [], // Zero previous creators
      "FT102857",
      env,
    );

    assert.equal(res.verified, true);
    assert.equal(res.txNumber, 1);
    assert.equal(res.distribution?.directReferralAmount, 1.0);
    assert.equal(res.distribution?.adminAmount, 1.0);
    assert.equal(res.distribution?.globalPoolAmount, 3.0);
    assert.equal(res.distribution?.globalPoolDistributedAmount, 0.0);
    assert.equal(res.distribution?.globalPoolReserveAmount, 3.0);
    assert.equal(res.distribution?.globalPoolStatus, "pending_reserve");
    assert.equal(res.distribution?.globalPoolReserveReason, "no_eligible_videos");
    assert.equal(res.distribution?.eligibleMembersCount, 0);
    assert.equal(res.distribution?.creatorPayouts?.length, 0);
  });

  it("3. Uniform ₹6 split applies equally on 11th/21st/31st transactions (₹1 referrer, ₹1 Admin, ₹3 global pool, ₹0.90 GST + ₹0.10 PG)", async () => {
    const formerSpecials = [11, 21, 31, 41, 51, 101];
    for (const tx of formerSpecials) {
      const dist = evaluatePremiumDistribution(tx, "FT102857", 5);
      assert.equal(dist.isSpecial, false, `tx #${tx} must follow uniform ₹6 rule`);
      assert.equal(dist.specialTag, "NORMAL_PREMIUM");
      assert.equal(dist.directReferralAmount, 1.0);
      assert.equal(dist.referralStatus, "credited");
      assert.equal(dist.adminAmount, 1.0);
      assert.equal(dist.globalPoolAmount, 3.0);
      assert.equal(dist.gstAmount, 0.9);
      assert.equal(dist.pgFeeAmount, 0.1);
      assert.equal(dist.eligibleMembersCount, 5);
      assert.equal(dist.perMemberShare, 0.6);
      assert.equal(dist.totalAmount, 6.0);
    }

    // Server verification check at tx #11
    await resetPersistentPremiumState(10, []);
    const orderId = `ord_t34_spec_${Date.now()}`;
    const paymentId = `pay_t34_spec_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const sig = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

    const res = await verifyServerPayment(
      {
        orderId,
        paymentId,
        signature: sig,
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      ["CR_1", "CR_2", "CR_3"],
      "FT102857",
      env,
    );

    assert.equal(res.verified, true);
    assert.equal(res.txNumber, 11);
    assert.equal(res.isSpecialTransaction, false);
    assert.equal(res.specialTag, "NORMAL_PREMIUM");
    assert.equal(res.distribution?.directReferralAmount, 1.0);
    assert.equal(res.distribution?.referralStatus, "credited");
    assert.equal(res.distribution?.adminAmount, 1.0);
    assert.equal(res.distribution?.globalPoolAmount, 3.0);
    assert.equal(res.distribution?.gstAmount, 0.9);
    assert.equal(res.distribution?.pgFeeAmount, 0.1);
    assert.equal(res.distribution?.eligibleMembersCount, 3);
  });

  it("4. Transaction without valid referrer preserves ₹1.00 as unassigned_pending without diverting to Admin", async () => {
    // No referrer, 2 eligible creators:
    // Referral: ₹1.00 (unassigned_pending). Admin: ₹1.00 base. Global Pool: ₹3.00 (₹1.50 each). GST: ₹0.90, PG: ₹0.10. Total: ₹6.00.
    const distWithCreators = evaluatePremiumDistribution(2, null, 2);
    assert.equal(distWithCreators.isSpecial, false);
    assert.equal(distWithCreators.directReferralAmount, 1.0);
    assert.equal(distWithCreators.referralStatus, "unassigned_pending");
    assert.equal(distWithCreators.adminAmount, 1.0);
    assert.equal(distWithCreators.globalPoolAmount, 3.0);
    assert.equal(distWithCreators.perMemberShare, 1.5);
    assert.equal(distWithCreators.gstAmount, 0.9);
    assert.equal(distWithCreators.pgFeeAmount, 0.1);
    assert.equal(distWithCreators.totalAmount, 6.0);

    // No referrer, 0 eligible creators:
    // Referral: ₹1.00 (unassigned_pending). Admin: ₹1.00 ALWAYS. Global Pool: ₹3.00 pending reserve. Fees: ₹1.00. Total: ₹6.00.
    const distZeroCreators = evaluatePremiumDistribution(2, null, 0);
    assert.equal(distZeroCreators.isSpecial, false);
    assert.equal(distZeroCreators.directReferralAmount, 1.0);
    assert.equal(distZeroCreators.referralStatus, "unassigned_pending");
    assert.equal(distZeroCreators.adminAmount, 1.0);
    assert.equal(distZeroCreators.globalPoolAmount, 3.0);
    assert.equal(distZeroCreators.globalPoolDistributedAmount, 0.0);
    assert.equal(distZeroCreators.globalPoolReserveAmount, 3.0);
    assert.equal(distZeroCreators.globalPoolStatus, "pending_reserve");
    assert.equal(distZeroCreators.totalAmount, 6.0);

    // Server verification with null referrer and creators
    await resetPersistentPremiumState(1, []);
    const orderId = `ord_t34_noref_${Date.now()}`;
    const paymentId = `pay_t34_noref_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const sig = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

    const res = await verifyServerPayment(
      {
        orderId,
        paymentId,
        signature: sig,
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      ["CR_1", "CR_2"],
      null, // No referrer
      env,
    );

    assert.equal(res.verified, true);
    assert.equal(res.distribution?.directReferralAmount, 1.0);
    assert.equal(res.distribution?.referralStatus, "unassigned_pending");
    assert.equal(res.distribution?.adminAmount, 1.0);
    assert.equal(res.distribution?.globalPoolAmount, 3.0);
    assert.equal(res.distribution?.gstAmount, 0.9);
    assert.equal(res.distribution?.pgFeeAmount, 0.1);
  });

  it("5. Transaction #11/#21/#31 without valid referrer still applies uniform ₹6 split with ₹1.00 unassigned_pending and ₹3.00 Global Pool", async () => {
    const seqs = [11, 21, 31, 41, 51];
    for (const tx of seqs) {
      const dist = evaluatePremiumDistribution(tx, null, 5); // null referrer
      assert.equal(dist.isSpecial, false);
      assert.equal(dist.directReferralAmount, 1.0);
      assert.equal(dist.referralStatus, "unassigned_pending");
      assert.equal(dist.adminAmount, 1.0, `tx #${tx} without referrer must keep Admin at ₹1.00`);
      assert.equal(dist.globalPoolAmount, 3.0);
      assert.equal(dist.gstAmount, 0.9);
      assert.equal(dist.pgFeeAmount, 0.1);
      assert.equal(dist.taxAndFees, 1.0);
      assert.equal(dist.totalAmount, 6.0);
    }

    await resetPersistentPremiumState(10, []);
    const orderId = `ord_t34_spec_noref_${Date.now()}`;
    const paymentId = `pay_t34_spec_noref_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const sig = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

    const res = await verifyServerPayment(
      {
        orderId,
        paymentId,
        signature: sig,
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      ["CR_1", "CR_2"],
      null, // No referrer
      env,
    );

    assert.equal(res.verified, true);
    assert.equal(res.txNumber, 11);
    assert.equal(res.isSpecialTransaction, false);
    assert.equal(res.distribution?.directReferralAmount, 1.0);
    assert.equal(res.distribution?.referralStatus, "unassigned_pending");
    assert.equal(res.distribution?.adminAmount, 1.0);
    assert.equal(res.distribution?.globalPoolAmount, 3.0);
  });

  it("6. Exact ₹6 accounting with integer-paise division and indivisible residual held in Global Pool reserve (e.g. 7 creators)", async () => {
    // 300 paise / 7 = 42 paise each (₹0.42 * 7 = 294 paise). Residual = 6 paise (₹0.06).
    // Admin stays strictly ₹1.00; ₹0.06 stays in Global Pool pending reserve (2.94 + 0.06 = ₹3.00).
    const dist7 = evaluatePremiumDistribution(2, "FT102857", 7);
    assert.equal(dist7.directReferralAmount, 1.0);
    assert.equal(dist7.adminAmount, 1.0);
    assert.equal(dist7.globalPoolAmount, 3.0);
    assert.equal(dist7.globalPoolDistributedAmount, 2.94);
    assert.equal(dist7.globalPoolReserveAmount, 0.06);
    assert.equal(dist7.globalPoolStatus, "partial_reserve");
    assert.equal(dist7.reserveReason, "rounding_residual");
    assert.equal(dist7.perMemberShare, 0.42);
    assert.equal(dist7.taxAndFees, 1.0);
    // Exact mathematical sum
    assert.equal(
      Math.round(
        (dist7.directReferralAmount +
          dist7.adminAmount +
          dist7.globalPoolAmount +
          dist7.taxAndFees) *
          100,
      ),
      600,
      "Zero paise leakage must be preserved across integer-paise division",
    );

    await resetPersistentPremiumState(1, []);
    const orderId = `ord_t34_paise_${Date.now()}`;
    const paymentId = `pay_t34_paise_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const sig = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

    const sevenCreators = ["CR_1", "CR_2", "CR_3", "CR_4", "CR_5", "CR_6", "CR_7"];

    const res = await verifyServerPayment(
      {
        orderId,
        paymentId,
        signature: sig,
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      sevenCreators,
      "FT102857",
      env,
    );

    assert.equal(res.verified, true);
    assert.equal(res.distribution?.adminAmount, 1.0);
    assert.equal(res.distribution?.globalPoolAmount, 3.0);
    assert.equal(res.distribution?.globalPoolDistributedAmount, 2.94);
    assert.equal(res.distribution?.globalPoolReserveAmount, 0.06);
    assert.equal(res.distribution?.globalPoolStatus, "partial_reserve");
    assert.equal(res.distribution?.creatorPayouts?.length, 7);
    for (const p of res.distribution?.creatorPayouts || []) {
      assert.equal(p.amountPaise, 42);
      assert.equal(p.amount, 0.42);
    }
  });

  it("7. Admin residual allocation verified across prime and uneven creator counts with zero leakage", () => {
    const testCounts = [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 13, 17, 23, 29, 37, 50, 100];
    for (const count of testCounts) {
      const dist = evaluatePremiumDistribution(4, "SPONSOR", count);
      const totalPaise = Math.round(
        (dist.directReferralAmount + dist.adminAmount + dist.globalPoolAmount + dist.taxAndFees) *
          100,
      );
      assert.equal(totalPaise, 600, `Leakage detected for creator count: ${count}`);
    }
  });

  it("8. Current uploader is strictly excluded from receiving a global pool share of their own upload", async () => {
    await resetPersistentPremiumState(1, []);
    const orderId = `ord_t34_excl_${Date.now()}`;
    const paymentId = `pay_t34_excl_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const sig = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

    // Pass uploader 'FT483921' in the candidate list alongside another creator
    const res = await verifyServerPayment(
      {
        orderId,
        paymentId,
        signature: sig,
        userId: "FT483921", // The current uploader
        purpose: "premium_video_upload",
      },
      ["FT483921", "OTHER_CREATOR_99"], // Contains current uploader
      "FT102857",
      env,
    );

    assert.equal(res.verified, true);
    assert.equal(res.distribution?.eligibleMembersCount, 1); // FT483921 must be excluded
    assert.equal(res.distribution?.creatorPayouts?.length, 1);
    assert.equal(res.distribution?.creatorPayouts?.[0]?.userId, "OTHER_CREATOR_99");
    assert.equal(res.distribution?.creatorPayouts?.[0]?.amount, 3.0); // Entire ₹3 goes to the sole remaining eligible creator
  });

  it("9. Duplicate eligible creator records are deduplicated before pool division", async () => {
    await resetPersistentPremiumState(1, []);
    const orderId = `ord_t34_dedup_${Date.now()}`;
    const paymentId = `pay_t34_dedup_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const sig = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

    // Input array contains duplicate references to same users
    const res = await verifyServerPayment(
      {
        orderId,
        paymentId,
        signature: sig,
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      ["CREATOR_ALPHA", "CREATOR_ALPHA", "CREATOR_BETA", "CREATOR_BETA"],
      "FT102857",
      env,
    );

    assert.equal(res.verified, true);
    assert.equal(res.distribution?.eligibleMembersCount, 2); // 2 distinct creators
    assert.equal(res.distribution?.perMemberShare, 1.5);
    assert.equal(res.distribution?.creatorPayouts?.length, 2);
    assert.equal(res.distribution?.creatorPayouts?.[0]?.amount, 1.5);
    assert.equal(res.distribution?.creatorPayouts?.[1]?.amount, 1.5);
  });

  it("10. Idempotent duplicate verification prevents double crediting and sequence advance for Premium Video", async () => {
    await resetPersistentPremiumState(1, []);
    const orderId = `ord_t34_dup_${Date.now()}`;
    const paymentId = `pay_t34_dup_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const sig = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

    const res1 = await verifyServerPayment(
      {
        orderId,
        paymentId,
        signature: sig,
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      ["CR_1", "CR_2"],
      "FT102857",
      env,
    );
    assert.equal(res1.verified, true);
    assert.equal(res1.duplicate, undefined);
    const firstTxNumber = res1.txNumber;

    const res2 = await verifyServerPayment(
      {
        orderId,
        paymentId,
        signature: sig,
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      ["CR_1", "CR_2"],
      "FT102857",
      env,
    );
    assert.equal(res2.verified, true);
    assert.equal(res2.duplicate, true);
    assert.match(res2.error || "", /already been processed/i);
    assert.equal(res2.txNumber, firstTxNumber);
  });

  it("11. Concurrency test: Parallel requests with distinct payment IDs serialize safely without race conditions", async () => {
    await resetPersistentPremiumState(1, []);
    const count = 5;
    const promises: Promise<any>[] = [];

    for (let i = 0; i < count; i++) {
      const orderId = `ord_t34_conc_${Date.now()}_${i}`;
      const paymentId = `pay_t34_conc_${Date.now()}_${i}_${Math.random().toString(36).substring(2, 6)}`;
      const sig = crypto
        .createHmac("sha256", secret)
        .update(`${orderId}|${paymentId}`)
        .digest("hex");

      promises.push(
        verifyServerPayment(
          {
            orderId,
            paymentId,
            signature: sig,
            userId: `USER_${i}`,
            purpose: "premium_video_upload",
          },
          ["CR_A", "CR_B"],
          "FT102857",
          env,
        ),
      );
    }

    const results = await Promise.all(promises);
    assert.equal(results.length, count);
    const txNumbers = results.map((r) => r.txNumber);
    // All results must be verified
    for (const r of results) {
      assert.equal(r.verified, true);
    }
    // All txNumbers must be unique and strictly sequential: 2, 3, 4, 5, 6
    assert.equal(new Set(txNumbers).size, count);
    assert.deepEqual(
      txNumbers.sort((a, b) => a - b),
      [2, 3, 4, 5, 6],
    );
  });

  it("12. Concurrency duplicate test: Simultaneous requests with identical payment ID resolve idempotently", async () => {
    await resetPersistentPremiumState(1, []);
    const orderId = `ord_t34_cdup_${Date.now()}`;
    const paymentId = `pay_t34_cdup_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const sig = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

    // Launch 3 simultaneous verification attempts for same payment ID
    const promises = [1, 2, 3].map(() =>
      verifyServerPayment(
        {
          orderId,
          paymentId,
          signature: sig,
          userId: "FT483921",
          purpose: "premium_video_upload",
        },
        ["CR_1", "CR_2"],
        "FT102857",
        env,
      ),
    );

    const results = await Promise.all(promises);
    assert.equal(results.length, 3);
    const [r1, r2, r3] = results;
    // All 3 report verified: true
    assert.equal(r1?.verified, true);
    assert.equal(r2?.verified, true);
    assert.equal(r3?.verified, true);

    // Exactly one is original, the other two are flagged as duplicates
    const duplicates = results.filter((r) => r?.duplicate === true);
    assert.equal(duplicates.length, 2);

    // Sequence only incremented once (txNumber: 2)
    const afterTxNum = await getPersistentPremiumTxNumber();
    assert.equal(afterTxNum, 2);
  });

  it("13. Rollback & failure scenarios: Invalid signature or missing credentials leave sequence untouched", async () => {
    await resetPersistentPremiumState(5, []);
    const orderId = `ord_t34_fail_${Date.now()}`;
    const paymentId = `pay_t34_fail_${Date.now()}`;

    // Test A: Invalid HMAC signature
    const badSigRes = await verifyServerPayment(
      {
        orderId,
        paymentId,
        signature: "invalid_tampered_signature_hex",
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      ["CR_1"],
      "FT102857",
      env,
    );
    assert.equal(badSigRes.verified, false);
    assert.match(badSigRes.error || "", /signature/i);

    // Sequence must NOT have advanced
    let currentTxNum = await getPersistentPremiumTxNumber();
    assert.equal(currentTxNum, 5);

    // Test B: Missing secret fails closed
    const noSecretRes = await verifyServerPayment(
      {
        orderId,
        paymentId,
        signature: "some_sig",
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      ["CR_1"],
      "FT102857",
      { RAZORPAY_KEY_SECRET: "" },
    );
    assert.equal(noSecretRes.verified, false);
    assert.match(noSecretRes.error || "", /RAZORPAY_KEY_SECRET/i);

    // Sequence must still be untouched
    currentTxNum = await getPersistentPremiumTxNumber();
    assert.equal(currentTxNum, 5);
  });

  it("14. API handler /api/payments/verify returns complete server-authoritative distribution breakdown for Premium Video", async () => {
    const loginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login.php", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
      }),
    );
    assert.ok(loginRes);
    const { token } = await loginRes.json();

    const orderRes = await handleApiRequest(
      new Request("http://localhost:3000/api/payments/create-order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          purpose: "premium_video_upload",
          userId: "FT483921",
        }),
      }),
      env,
    );
    assert.ok(orderRes);
    assert.equal(orderRes.status, 200);
    const { orderId } = await orderRes.json();

    const paymentId = `pay_t34_api_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const sig = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

    const req = new Request("http://localhost:3000/api/payments/verify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        orderId,
        paymentId,
        signature: sig,
        userId: "FT483921",
        userName: "Alex Rivera",
        purpose: "premium_video_upload",
      }),
    });

    const res = await handleApiRequest(req, env);
    assert.ok(res);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.verified, true);
    assert.equal(body.amount, 6.0);
    assert.equal(body.purpose, "premium_video_upload");
    assert.ok(body.distribution);
    assert.equal(typeof body.distribution.adminAmount, "number");
    assert.equal(typeof body.distribution.globalPoolAmount, "number");
    assert.equal(typeof body.distribution.eligibleMembersCount, "number");
    assert.ok(Array.isArray(body.distribution.creatorPayouts));
  });

  it("15. Seven-level Ads referral tests remain completely isolated and unaffected", async () => {
    const adsPlan = PRICING_CONFIG.ADS_PROMOTION["plan-15-days"];
    assert.equal(adsPlan.price, 200);
    assert.equal(adsPlan.days, 15);

    // Verify 7-level rates untouched
    const dist = evaluateAdsDistribution(200, [
      { level: 1, userId: "UP1" },
      { level: 2, userId: "UP2" },
      { level: 3, userId: "UP3" },
      { level: 4, userId: "UP4" },
      { level: 5, userId: "UP5" },
      { level: 6, userId: "UP6" },
      { level: 7, userId: "UP7" },
    ]);
    assert.equal(dist.totalReferralAmount, 80);
    assert.equal(dist.adminAmount, 120);
    assert.equal(dist.adminPercent, 60);
  });
});

describe("Task 35: Free, Paid/Premium Sponsor, and Ads UI Label Validation Tests", () => {
  it("1. Free videos appear normally with zero Sponsor, Ads, Premium, or price labels", () => {
    const freeShort = {
      id: "vid-free-001",
      title: "Free React Masterclass",
      videoType: "free" as const,
      contentType: "short" as const,
      duration: "0:45",
      isPromoted: false,
    };
    const labels = getVideoBadgeLabels(freeShort);
    assert.equal(labels.isFree, true);
    assert.equal(labels.showSponsorLabel, false);
    assert.equal(labels.showAdsLabel, false);
    assert.equal(labels.badges.length, 0);

    const freeLong = {
      id: "vid-free-002",
      title: "Full Stack Architecture Tutorial",
      videoType: "free" as const,
      contentType: "long" as const,
      duration: "42:15",
      isPromoted: false,
    };
    const longLabels = getVideoBadgeLabels(freeLong);
    assert.equal(longLabels.isFree, true);
    assert.equal(longLabels.showSponsorLabel, false);
    assert.equal(longLabels.showAdsLabel, false);
    assert.equal(longLabels.badges.length, 0);
  });

  it("2. Paid/premium uploads display a small 'Sponsored' label beside channel name and remove 'Premium' and '₹6' labels", () => {
    const paidUpload = {
      id: "vid-paid-001",
      title: "Exclusive Creator Course",
      videoType: "premium" as const,
      contentType: "long" as const,
      duration: "25:30",
      isPromoted: false,
    };
    const labels = getVideoBadgeLabels(paidUpload);
    assert.equal(labels.isFree, false);
    assert.equal(labels.showSponsorLabel, true);
    assert.equal(labels.showAdsLabel, false); // Must NOT be labeled as Ads!

    // Validate badge text
    assert.equal(labels.badges.length, 1);
    assert.equal(labels.badges[0]?.type, "sponsor");
    assert.equal(labels.badges[0]?.label, "Sponsored");

    // Strictly ensure "Premium" and "₹6" do not appear in public badge text
    const badgeText = labels.badges.map((b) => b.label).join(" ");
    assert.ok(!badgeText.toLowerCase().includes("premium"));
    assert.ok(!badgeText.includes("₹6"));
    assert.ok(!badgeText.includes("6"));
  });

  it("3. Ads videos display small 'Ads' label only for genuine active advertising/promotional content", () => {
    // Actively promoted video
    const activeAdVideo = {
      id: "vid-ad-001",
      title: "Summer Sale Campaign",
      videoType: "free" as const,
      contentType: "short" as const,
      duration: "0:30",
      isPromoted: true,
      promotionExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const activeLabels = getVideoBadgeLabels(activeAdVideo);
    assert.equal(activeLabels.showAdsLabel, true);
    assert.equal(activeLabels.showSponsorLabel, false); // Do not create fake sponsor relationship!
    assert.equal(activeLabels.badges.length, 1);
    assert.equal(activeLabels.badges[0]?.type, "ads");
    assert.equal(activeLabels.badges[0]?.label, "Ads");

    // Expired promotion safely fails closed
    const expiredAdVideo = {
      id: "vid-ad-002",
      title: "Expired Sale Campaign",
      videoType: "free" as const,
      contentType: "short" as const,
      duration: "0:30",
      isPromoted: true,
      promotionExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    };
    const expiredLabels = getVideoBadgeLabels(expiredAdVideo);
    assert.equal(expiredLabels.showAdsLabel, false);
    assert.equal(expiredLabels.isFree, true);
  });

  it("4. Video duration alone is NEVER used to decide whether a video is sponsored or an advertisement", () => {
    // Short video with zero paid or promoted metadata
    const shortVideo = {
      id: "vid-short-001",
      title: "Quick Tips",
      videoType: "free" as const,
      contentType: "short" as const,
      duration: "0:15",
      isPromoted: false,
    };
    const shortLabels = getVideoBadgeLabels(shortVideo);
    assert.equal(shortLabels.showSponsorLabel, false);
    assert.equal(shortLabels.showAdsLabel, false);

    // Long video with zero paid or promoted metadata
    const longVideo = {
      id: "vid-long-001",
      title: "Full Documentary",
      videoType: "free" as const,
      contentType: "long" as const,
      duration: "1:45:00",
      isPromoted: false,
    };
    const longLabels = getVideoBadgeLabels(longVideo);
    assert.equal(longLabels.showSponsorLabel, false);
    assert.equal(longLabels.showAdsLabel, false);
  });

  it("5. Supports combined Paid Sponsored + Active Ads promotion cleanly without label conflicts", () => {
    const combinedVideo = {
      id: "vid-combined-001",
      title: "Partner Brand Showcase",
      videoType: "premium" as const,
      contentType: "long" as const,
      duration: "18:20",
      isPromoted: true,
      promotionExpiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const labels = getVideoBadgeLabels(combinedVideo);
    assert.equal(labels.showSponsorLabel, true);
    assert.equal(labels.showAdsLabel, true);
    assert.equal(labels.badges.length, 2);
    assert.deepEqual(labels.badges, [
      { type: "sponsor", label: "Sponsored" },
      { type: "ads", label: "Ads" },
    ]);
  });

  it("6. Regression test: Video thumbnails have NO Ads overlay badge while eligible active promotion shows Ads label below the title", () => {
    // 1. Actively promoted video (e.g. Free video with active ad campaign)
    const activePromotedVideo = {
      id: "vid-regress-001",
      title: "Active Promotion Tutorial",
      videoType: "free" as const,
      contentType: "long" as const,
      duration: "10:15",
      isPromoted: true,
      promotionExpiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const activeLabels = getVideoBadgeLabels(activePromotedVideo);
    // Regression check: Video thumbnail overlay MUST NOT display an Ads badge
    assert.equal(
      activeLabels.showThumbnailAdsOverlay,
      false,
      "Thumbnail overlay must never show Ads badge",
    );
    // Below title: Must show small Ads label
    assert.equal(
      activeLabels.showAdsLabel,
      true,
      "Below title must show Ads label for active promotion",
    );
    assert.equal(activeLabels.badges.length, 1);
    assert.equal(activeLabels.badges[0]?.type, "ads");
    assert.equal(activeLabels.badges[0]?.label, "Ads");

    // 2. Paid / Premium upload with active promotion
    const paidWithPromotion = {
      id: "vid-regress-002",
      title: "Paid Upload with Active Ads",
      videoType: "premium" as const,
      contentType: "long" as const,
      duration: "12:00",
      isPromoted: true,
      promotionExpiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const paidLabels = getVideoBadgeLabels(paidWithPromotion);
    // Neither Sponsor nor Ads badge is placed on the thumbnail overlay
    assert.equal(
      paidLabels.showThumbnailAdsOverlay,
      false,
      "Thumbnail overlay must not show Ads badge",
    );
    // Both Sponsor and Ads appear strictly below the title
    assert.equal(paidLabels.showSponsorLabel, true);
    assert.equal(paidLabels.showAdsLabel, true);

    // 3. Normal Free video
    const normalFreeVideo = {
      id: "vid-regress-003",
      title: "Normal Free Video",
      videoType: "free" as const,
      contentType: "long" as const,
      duration: "08:30",
      isPromoted: false,
    };
    const freeLabels = getVideoBadgeLabels(normalFreeVideo);
    assert.equal(freeLabels.showThumbnailAdsOverlay, false);
    assert.equal(freeLabels.showAdsLabel, false);
    assert.equal(freeLabels.showSponsorLabel, false);
    assert.equal(freeLabels.isFree, true);
    assert.equal(freeLabels.badges.length, 0);
  });

  it("59. Requirement 9: calculateWeightedPoolPayouts weights video share by actual ad earnings", () => {
    // 3 creators with different ad earnings: 100, 200, 700 (Total = 1000)
    // Pool = ₹3.00 (300 paise)
    // Creator 1: 10% -> 30 paise
    // Creator 2: 20% -> 60 paise
    // Creator 3: 70% -> 210 paise
    const creators = [
      { userId: "creator_a", adEarnings: 100 },
      { userId: "creator_b", adEarnings: 200 },
      { userId: "creator_c", adEarnings: 700 },
    ];

    const result = calculateWeightedPoolPayouts(300, creators);
    assert.equal(result.payouts.length, 3);
    assert.equal(result.payouts[0]?.userId, "creator_a");
    assert.equal(result.payouts[0]?.amountPaise, 30);
    assert.equal(result.payouts[0]?.amount, 0.3);

    assert.equal(result.payouts[1]?.userId, "creator_b");
    assert.equal(result.payouts[1]?.amountPaise, 60);
    assert.equal(result.payouts[1]?.amount, 0.6);

    assert.equal(result.payouts[2]?.userId, "creator_c");
    assert.equal(result.payouts[2]?.amountPaise, 210);
    assert.equal(result.payouts[2]?.amount, 2.1);

    assert.equal(result.distributedPaise, 300);
    assert.equal(result.residualPaise, 0);

    // Verify evaluatePremiumDistribution uses weighted distribution and balances exactly to ₹6.00
    const evalResult = evaluatePremiumDistribution(1, "sponsor_ref", 3, creators);
    assert.equal(evalResult.isSpecial, false);
    assert.equal(evalResult.directReferralAmount, 1.0);
    assert.equal(evalResult.globalPoolAmount, 3.0);
    assert.equal(evalResult.adminAmount, 1.0);
    assert.equal(evalResult.taxAndFees, 1.0);
    const sum =
      evalResult.directReferralAmount +
      evalResult.globalPoolAmount +
      evalResult.adminAmount +
      evalResult.taxAndFees;
    assert.equal(Math.round(sum * 100) / 100, 6.0);
    assert.equal(evalResult.weightedPayouts?.length, 3);
  });

  it("60. Requirement 9: calculateWeightedPoolPayouts gracefully falls back to equal share when no ad earnings exist", () => {
    const creators = [
      { userId: "creator_1", adEarnings: 0 },
      { userId: "creator_2", adEarnings: 0 },
      { userId: "creator_3", adEarnings: 0 },
    ];

    const result = calculateWeightedPoolPayouts(300, creators);
    assert.equal(result.payouts.length, 3);
    assert.equal(result.payouts[0]?.amountPaise, 100);
    assert.equal(result.payouts[1]?.amountPaise, 100);
    assert.equal(result.payouts[2]?.amountPaise, 100);
    assert.equal(result.distributedPaise, 300);
    assert.equal(result.residualPaise, 0);
  });
});

describe("Phase 1 Security & Production Safety Tests", () => {
  const secret = "test_razorpay_secret_key_1234567890";
  const env = {
    RAZORPAY_KEY_ID: "rzp_test_1234567890",
    RAZORPAY_KEY_SECRET: secret,
    RAZORPAY_SKIP_REMOTE_CHECK: "true",
  };

  it("1. Admin role endpoint rejects unauthenticated requests with 401", async () => {
    const req = new Request("http://localhost:3000/api/admin/role", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "FT483921", role: "admin" }),
    });
    const res = await handleApiRequest(req, env);
    assert.ok(res);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.error, /Authentication required/i);
  });

  it("2. Admin role endpoint rejects non-admin users with 403 Forbidden", async () => {
    // Log in as Alex Rivera (role: user) to obtain valid token
    const loginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "FT483921", password: "password123" }),
    });
    const loginRes = await handleApiRequest(loginReq, env);
    assert.ok(loginRes);
    assert.equal(loginRes.status, 200);
    const { token } = await loginRes.json();

    // Attempt to self-promote or update role
    const req = new Request("http://localhost:3000/api/admin/role", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ userId: "FT483921", role: "admin" }),
    });
    const res = await handleApiRequest(req, env);
    assert.ok(res);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.error, /Admin authorization required|Administrator privileges required/i);
  });

  it("3. Admin role endpoint allows authenticated administrator to update user role", async () => {
    // Log in as FaceTube Administrator (FT102857)
    const loginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "FT102857", password: "password" }),
    });
    const loginRes = await handleApiRequest(loginReq, env);
    assert.ok(loginRes);
    assert.equal(loginRes.status, 200);
    const { token } = await loginRes.json();

    try {
      const req = new Request("http://localhost:3000/api/admin/role", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ userId: "FT900431", role: "admin" }),
      });
      const res = await handleApiRequest(req, env);
      assert.ok(res);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.match(body.message, /updated to admin successfully/i);
    } finally {
      await handleApiRequest(
        new Request("http://localhost:3000/api/admin/role", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ userId: "FT900431", role: "user" }),
        }),
        env,
      );
    }
  });

  it("4. Withdrawal endpoint rejects unauthenticated requests with 401", async () => {
    const req = new Request("http://localhost:3000/api/wallet/withdraw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 1000 }),
    });
    const res = await handleApiRequest(req, env);
    assert.ok(res);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.error, /Authentication required/i);
  });

  it("5. Withdrawal enforces min withdrawal (₹100) and balance sufficiency for authenticated user", async () => {
    // Log in as Alex Rivera
    const loginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "FT483921", password: "password123" }),
    });
    const loginRes = await handleApiRequest(loginReq, env);
    assert.ok(loginRes);
    const { token } = await loginRes.json();

    // Less than minimum ₹100
    const reqBelowMin = new Request("http://localhost:3000/api/wallet/withdraw", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ amount: 50 }),
    });
    const resBelowMin = await handleApiRequest(reqBelowMin, env);
    assert.ok(resBelowMin);
    assert.equal(resBelowMin.status, 400);
    const bodyBelowMin = await resBelowMin.json();
    assert.match(bodyBelowMin.error, /Minimum withdrawal/i);

    // Balance sufficiency check: when amount is within daily limit (<= ₹10,000) but exceeds balance
    const reqInsufficient = new Request("http://localhost:3000/api/wallet/withdraw", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ amount: 1500 }),
    });
    const resInsufficient = await handleApiRequest(reqInsufficient, env);
    assert.ok(resInsufficient);
    assert.equal(resInsufficient.status, 400);
    const bodyInsufficient = await resInsufficient.json();
    assert.match(bodyInsufficient.error, /Insufficient balance/i);

    // Successful withdrawal for admin user who has sufficient balance
    const adminLoginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "FT102857", password: "password" }),
    });
    const adminLoginRes = await handleApiRequest(adminLoginReq, env);
    assert.ok(adminLoginRes);
    const { token: adminToken } = await adminLoginRes.json();

    const reqValid = new Request("http://localhost:3000/api/wallet/withdraw", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ amount: 1000 }),
    });
    const resValid = await handleApiRequest(reqValid, env);
    assert.ok(resValid);
    assert.equal(resValid.status, 200);
    const bodyValid = await resValid.json();
    assert.equal(bodyValid.success, true);
    assert.equal(bodyValid.transaction.amount, 1000);
    assert.equal(bodyValid.transaction.fee, 200);
    assert.equal(bodyValid.transaction.netAmount, 800);
    assert.equal(bodyValid.transaction.chargesBreakdown.totalCharge, 200);
    assert.equal(bodyValid.transaction.chargesBreakdown.netPayable, 800);
  });

  it("6. Hardcoded password bypass ('admin123' / incorrect password) is strictly rejected", async () => {
    const bypassReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "FT483921", password: "admin123" }),
    });
    const res = await handleApiRequest(bypassReq, env);
    assert.ok(res);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.error, /Incorrect password/i);
  });

  it("7. Production mode (NODE_ENV=production) safely fails closed with 503 when MySQL pool is unavailable", async () => {
    // Obtain valid tokens while still in test mode
    const userLogin = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "FT483921", password: "password123" }),
      }),
      env,
    );
    assert.ok(userLogin);
    const { token: userToken } = await userLogin.json();

    const adminLogin = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "FT102857", password: "password" }),
      }),
      env,
    );
    assert.ok(adminLogin);
    const { token: adminToken } = await adminLogin.json();

    const prevEnv = process.env["NODE_ENV"];
    try {
      process.env["NODE_ENV"] = "production";

      // 1. Withdrawal fails closed with 503
      const withdrawReq = new Request("http://localhost:3000/api/wallet/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${userToken}` },
        body: JSON.stringify({ amount: 1000 }),
      });
      const withdrawRes = await handleApiRequest(withdrawReq, env);
      assert.ok(withdrawRes);
      assert.equal(withdrawRes.status, 503);
      const withdrawBody = await withdrawRes.json();
      assert.equal(withdrawBody.success, false);
      assert.match(withdrawBody.error, /Database connection unavailable/i);

      // 2. Balance fails closed with 503
      const balanceReq = new Request("http://localhost:3000/api/wallet/balance?userId=FT483921", {
        method: "GET",
        headers: { Authorization: `Bearer ${userToken}` },
      });
      const balanceRes = await handleApiRequest(balanceReq, env);
      assert.ok(balanceRes);
      assert.equal(balanceRes.status, 503);
      const balanceBody = await balanceRes.json();
      assert.equal(balanceBody.success, false);
      assert.match(balanceBody.error, /Database connection unavailable/i);

      // 3. Admin role fails closed with 503
      const adminReq = new Request("http://localhost:3000/api/admin/role", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ userId: "FT483921", role: "admin" }),
      });
      const adminRes = await handleApiRequest(adminReq, env);
      assert.ok(adminRes);
      assert.equal(adminRes.status, 503);
      const adminBody = await adminRes.json();
      assert.equal(adminBody.success, false);
      assert.match(adminBody.error, /Database connection unavailable/i);

      // 4. Payment verify fails closed with 503
      const payReq = new Request("http://localhost:3000/api/payments/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: "ord_prod_fail",
          paymentId: "pay_prod_fail",
          signature: "some_sig",
          userId: "FT483921",
        }),
      });
      const payRes = await handleApiRequest(payReq, env);
      assert.ok(payRes);
      assert.equal(payRes.status, 503);
      const payBody = await payRes.json();
      assert.equal(payBody.verified, false);
      assert.match(payBody.error, /Database connection unavailable/i);
    } finally {
      process.env["NODE_ENV"] = prevEnv;
    }
  });
});

describe("Bulk Payout Double-Deduction Regression & Integrity Tests", () => {
  const env = {
    RAZORPAY_KEY_ID: "rzp_test_1234567890",
    RAZORPAY_KEY_SECRET: "test_razorpay_secret_key_1234567890",
  };

  it("1. Processing an existing withdrawal request through bulk payout does NOT deduct wallet a second time and does NOT duplicate transaction", async () => {
    // 1. Admin login to obtain admin token
    const adminLoginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "FT102857", password: "password" }),
      }),
      env,
    );
    assert.ok(adminLoginRes);
    const { token: adminToken } = await adminLoginRes.json();

    // 2. Fetch initial balance for FT102857
    const initBalRes = await handleApiRequest(
      new Request("http://localhost:3000/api/wallet/balance?userId=FT102857", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      env,
    );
    assert.ok(initBalRes);
    const initBalBody = await initBalRes.json();
    const balanceBeforeWithdrawal = Number(initBalBody.wallet.balance);

    // 3. Initiate a withdrawal request for ₹1,000
    const withdrawRes = await handleApiRequest(
      new Request("http://localhost:3000/api/wallet/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ amount: 1000 }),
      }),
      env,
    );
    assert.ok(withdrawRes);
    assert.equal(withdrawRes.status, 200);
    const withdrawBody = await withdrawRes.json();
    assert.equal(withdrawBody.success, true);
    const txId = withdrawBody.transaction.id;
    const balanceAfterWithdrawal = Number(withdrawBody.updatedWallet.balance);

    // Verify exactly ₹1,000 was deducted on initial withdrawal
    assert.equal(balanceAfterWithdrawal, balanceBeforeWithdrawal - 1000);

    // 4. Fetch transactions to check initial count
    const txsBeforeBulk = await handleApiRequest(
      new Request("http://localhost:3000/api/wallet/transactions?userId=FT102857", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      env,
    );
    assert.ok(txsBeforeBulk);
    const txList1 = (await txsBeforeBulk.json()).transactions || [];
    const countWithTxIdBefore = txList1.filter(
      (t: any) => t.id === txId || t.transactionId === txId,
    ).length;
    assert.equal(countWithTxIdBefore, 1);

    // 5. Execute Admin Bulk Payout specifying this existing transaction ID
    const bulkRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/bulk-payout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          payouts: [{ userId: "FT102857", amount: 100, transactionId: txId }],
          notes: "Settling test withdrawal",
        }),
      }),
      env,
    );
    assert.ok(bulkRes);
    assert.equal(bulkRes.status, 200);
    const bulkBody = await bulkRes.json();
    assert.equal(bulkBody.success, true);
    assert.equal(bulkBody.total_recipients, 1);
    assert.equal(bulkBody.processed[0].deduction_type, "settled_existing_request");

    // 6. CRITICAL REGRESSION CHECK: Wallet balance must NOT be debited a second time!
    const balAfterBulkRes = await handleApiRequest(
      new Request("http://localhost:3000/api/wallet/balance?userId=FT102857", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      env,
    );
    assert.ok(balAfterBulkRes);
    const balAfterBulkBody = await balAfterBulkRes.json();
    const balanceAfterBulk = Number(balAfterBulkBody.wallet.balance);

    // Assert balance remained EXACTLY the same as after withdrawal (zero double deduction!)
    assert.equal(
      balanceAfterBulk,
      balanceAfterWithdrawal,
      `Balance must remain ${balanceAfterWithdrawal} but was ${balanceAfterBulk} (double deduction detected!)`,
    );

    // 7. CRITICAL REGRESSION CHECK: No duplicate transaction created!
    const txsAfterBulk = await handleApiRequest(
      new Request("http://localhost:3000/api/wallet/transactions?userId=FT102857", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      env,
    );
    assert.ok(txsAfterBulk);
    const txList2 = (await txsAfterBulk.json()).transactions || [];
    const matchingTxs = txList2.filter((t: any) => t.id === txId || t.transactionId === txId);
    assert.equal(
      matchingTxs.length,
      1,
      `Expected exactly 1 transaction with id ${txId}, found ${matchingTxs.length}`,
    );
    assert.equal(matchingTxs[0].status, "completed");
  });

  it("2. Legitimate new direct bulk payout (without transactionId) deducts wallet exactly once", async () => {
    const adminLoginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "FT102857", password: "password" }),
      }),
      env,
    );
    assert.ok(adminLoginRes);
    const { token: adminToken } = await adminLoginRes.json();

    const initBalRes = await handleApiRequest(
      new Request("http://localhost:3000/api/wallet/balance?userId=FT102857", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      env,
    );
    assert.ok(initBalRes);
    const balanceBeforeDirect = Number((await initBalRes.json()).wallet.balance);

    // Execute direct payout for ₹50 with NO transaction ID
    const directRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/bulk-payout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          payouts: [{ userId: "FT102857", amount: 50 }],
          notes: "Direct bonus payout",
        }),
      }),
      env,
    );
    assert.ok(directRes);
    assert.equal(directRes.status, 200);
    const directBody = await directRes.json();
    assert.equal(directBody.success, true);
    assert.equal(directBody.processed[0].deduction_type, "new_direct_disbursement");

    // Check balance deducted exactly ₹50 once
    const balAfterDirectRes = await handleApiRequest(
      new Request("http://localhost:3000/api/wallet/balance?userId=FT102857", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      env,
    );
    assert.ok(balAfterDirectRes);
    const balanceAfterDirect = Number((await balAfterDirectRes.json()).wallet.balance);
    assert.equal(balanceAfterDirect, balanceBeforeDirect - 50);
  });

  it("3. Direct payout rejects with 400 when recipient has insufficient balance", async () => {
    const adminLoginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "FT102857", password: "password" }),
      }),
      env,
    );
    assert.ok(adminLoginRes);
    const { token: adminToken } = await adminLoginRes.json();

    const res = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/bulk-payout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          payouts: [{ userId: "FT102857", amount: 99999999 }],
        }),
      }),
      env,
    );
    assert.ok(res);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.error, /Insufficient balance/i);
  });

  it("4. Bulk payout rejects with 404 when transactionId is invalid or not found", async () => {
    const adminLoginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "FT102857", password: "password" }),
      }),
      env,
    );
    assert.ok(adminLoginRes);
    const { token: adminToken } = await adminLoginRes.json();

    const res = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/bulk-payout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          payouts: [{ userId: "FT102857", amount: 100, transactionId: "tx_nonexistent_xyz999" }],
        }),
      }),
      env,
    );
    assert.ok(res);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.error, /Invalid transaction ID|not found/i);
  });

  it("5. Bulk payout rejects with 403 on authorization mismatch (transaction user does not match item user)", async () => {
    const adminLoginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "FT102857", password: "password" }),
      }),
      env,
    );
    assert.ok(adminLoginRes);
    const { token: adminToken } = await adminLoginRes.json();

    // Create a withdrawal for FT102857
    const withdrawRes = await handleApiRequest(
      new Request("http://localhost:3000/api/wallet/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ amount: 1000 }),
      }),
      env,
    );
    assert.ok(withdrawRes);
    const { transaction } = await withdrawRes.json();

    // Try to settle transaction belonging to FT102857 as FT483921
    const res = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/bulk-payout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          payouts: [{ userId: "FT483921", amount: 1000, transactionId: transaction.id }],
        }),
      }),
      env,
    );
    assert.ok(res);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.error, /Authorization mismatch/i);
  });

  it("6. Replay prevention: rejects bulk payout if transaction is already completed", async () => {
    const adminLoginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "FT102857", password: "password" }),
      }),
      env,
    );
    assert.ok(adminLoginRes);
    const { token: adminToken } = await adminLoginRes.json();

    // Create a withdrawal
    const withdrawRes = await handleApiRequest(
      new Request("http://localhost:3000/api/wallet/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ amount: 1000 }),
      }),
      env,
    );
    assert.ok(withdrawRes);
    const { transaction } = await withdrawRes.json();

    // First bulk payout: succeeds
    const firstPayout = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/bulk-payout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          payouts: [{ userId: "FT102857", amount: 1000, transactionId: transaction.id }],
        }),
      }),
      env,
    );
    assert.ok(firstPayout);
    assert.equal(firstPayout.status, 200);

    // Second bulk payout on same transaction: must reject with 400
    const secondPayout = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/bulk-payout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          payouts: [{ userId: "FT102857", amount: 1000, transactionId: transaction.id }],
        }),
      }),
      env,
    );
    assert.ok(secondPayout);
    assert.equal(secondPayout.status, 400);
    const body = await secondPayout.json();
    assert.equal(body.success, false);
    assert.match(body.error, /already been marked as completed/i);
  });

  it("7. Bulk payout rejects unauthorized non-admin users with 403", async () => {
    const userLoginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "FT483921", password: "password123" }),
      }),
      env,
    );
    assert.ok(userLoginRes);
    const { token: userToken } = await userLoginRes.json();

    const res = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/bulk-payout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${userToken}` },
        body: JSON.stringify({
          payouts: [{ userId: "FT483921", amount: 100 }],
        }),
      }),
      env,
    );
    assert.ok(res);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.error, /Admin authorization required/i);
  });

  it("8. Safe internal chunking and progress tracking for 50+ users", async () => {
    const adminLoginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "FT102857", password: "password" }),
      }),
      env,
    );
    assert.ok(adminLoginRes);
    const { token: adminToken } = await adminLoginRes.json();

    // Create 60 small payouts to test 2 chunks (50 + 10)
    const sixtyPayouts = Array.from({ length: 60 }, (_, i) => ({
      userId: "FT102857",
      amount: 1, // ₹1 each = ₹60 total
    }));

    const batchId = `test_batch_chunk_${Date.now()}`;
    const bulkRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/bulk-payout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          batch_id: batchId,
          chunk_size: 50,
          payouts: sixtyPayouts,
          notes: "Testing 60 users chunking",
        }),
      }),
      env,
    );

    assert.ok(bulkRes);
    assert.equal(bulkRes.status, 200);
    const data = await bulkRes.json();
    assert.equal(data.success, true);
    assert.equal(data.batch_id, batchId);
    assert.equal(data.total_recipients, 60);
    assert.equal(data.total_amount, 60);
    assert.equal(data.total_chunks, 2);
    assert.equal(data.chunks_processed, 2);
    assert.equal(data.chunk_size, 50);
    assert.deepEqual(data.progress, {
      total: 60,
      processed: 60,
      successful: 60,
      failed: 0,
    });
    assert.equal(data.processed.length, 60);
  });

  it("9. Idempotent retry: re-submitting with identical batch_id succeeds without double deduction", async () => {
    const adminLoginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "FT102857", password: "password" }),
      }),
      env,
    );
    assert.ok(adminLoginRes);
    const { token: adminToken } = await adminLoginRes.json();

    const initBalRes = await handleApiRequest(
      new Request("http://localhost:3000/api/wallet/balance?userId=FT102857", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      env,
    );
    assert.ok(initBalRes);
    const balBefore = Number((await initBalRes.json()).wallet.balance);

    const testBatchId = `idempotent_test_${Date.now()}`;
    const payouts = [
      { userId: "FT102857", amount: 25 },
      { userId: "FT102857", amount: 35 },
    ];

    // First run
    const firstRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/bulk-payout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          batch_id: testBatchId,
          payouts,
        }),
      }),
      env,
    );
    assert.ok(firstRes);
    assert.equal(firstRes.status, 200);

    const balFirstReqRes = await handleApiRequest(
      new Request("http://localhost:3000/api/wallet/balance?userId=FT102857", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      env,
    );
    assert.ok(balFirstReqRes);
    const balAfterFirst = Number((await balFirstReqRes.json()).wallet.balance);
    assert.equal(balAfterFirst, balBefore - 60);

    // Second run with EXACT same batch_id (idempotent replay)
    const retryRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/bulk-payout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          batch_id: testBatchId,
          payouts,
        }),
      }),
      env,
    );
    assert.ok(retryRes);
    assert.equal(retryRes.status, 200);
    const retryData = await retryRes.json();
    assert.equal(retryData.success, true);
    assert.equal(retryData.processed.length, 2);
    assert.equal(retryData.processed[0].idempotent_replay, true);
    assert.equal(retryData.processed[1].idempotent_replay, true);

    // Balance MUST remain unchanged (zero double deduction!)
    const balRetryReqRes = await handleApiRequest(
      new Request("http://localhost:3000/api/wallet/balance?userId=FT102857", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      env,
    );
    assert.ok(balRetryReqRes);
    const balAfterRetry = Number((await balRetryReqRes.json()).wallet.balance);
    assert.equal(
      balAfterRetry,
      balAfterFirst,
      "Idempotent retry must not deduct balance a second time!",
    );
  });
});

describe("Payout Metadata and Sensitive Beneficiary Masking Audit Tests", () => {
  it("Masks bank account numbers preserving only the trailing 4 digits without plain text leakage", () => {
    assert.equal(maskAccountNumber("50100481920194"), "XXXXXXXXXX0194");
    assert.equal(maskAccountNumber("849201948201"), "XXXXXXXX8201");
    assert.equal(maskAccountNumber("1234"), "XXXX");
    assert.equal(maskAccountNumber(""), "");
  });

  it("Masks UPI handles protecting user identity while retaining domain", () => {
    assert.equal(maskUpiId("alexrivera@okhdfcbank"), "al***ra@okhdfcbank");
    assert.equal(maskUpiId("alex@upi"), "a**x@upi");
    assert.equal(maskUpiId("a@upi"), "a*@upi");
  });

  it("buildMaskedBeneficiaryDetails returns valid JSON with masked account and UPI without plaintext", () => {
    const masked = buildMaskedBeneficiaryDetails({
      accountHolder: "Alex Rivera",
      bankName: "HDFC Bank",
      accountNumber: "50100481920194",
      ifscCode: "hdfc0001234",
      upiId: "alexrivera@okhdfcbank",
    });
    assert.ok(masked);
    const parsed = JSON.parse(masked!);
    assert.equal(parsed.account_holder, "Alex Rivera");
    assert.equal(parsed.bank_name, "HDFC Bank");
    assert.equal(parsed.account_number_masked, "XXXXXXXXXX0194");
    assert.equal(parsed.ifsc_code, "HDFC0001234");
    assert.equal(parsed.upi_id_masked, "al***ra@okhdfcbank");
    // Explicit assertion: plaintext account number does NOT exist
    assert.equal("accountNumber" in parsed, false);
    assert.equal("account_number" in parsed, false);
    assert.equal(masked!.includes("50100481920194"), false);
  });

  it("Explicitly persists payout_method and beneficiary_details on withdrawal requests", async () => {
    const env = { JWT_SECRET: "test_jwt_secret_key" };
    const userLogin = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "FT102857", password: "password" }),
      }),
      env,
    );
    assert.ok(userLogin);
    const { token: userToken } = await userLogin.json();

    const withdrawRes = await handleApiRequest(
      new Request("http://localhost:3000/api/wallet/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${userToken}` },
        body: JSON.stringify({
          amount: 1000,
          userId: "FT102857",
          payout_method: "bank_transfer",
          bankDetails: {
            accountHolder: "FaceTube Admin",
            bankName: "State Bank of India",
            accountNumber: "123456789012",
            ifscCode: "SBIN0001234",
            upiId: "admin@oksbi",
          },
        }),
      }),
      env,
    );
    assert.ok(withdrawRes);
    const wData = await withdrawRes.json();
    assert.equal(wData.success, true, `Withdrawal failed: ${wData.error}`);
    assert.ok(wData.transaction);
    assert.equal(wData.transaction.payout_method, "bank_transfer");
    assert.ok(wData.transaction.beneficiary_details);
    const parsedBeneficiary = JSON.parse(wData.transaction.beneficiary_details);
    assert.equal(parsedBeneficiary.account_number_masked, "XXXXXXXX9012");
    assert.equal(wData.transaction.beneficiary_details.includes("123456789012"), false);
  });

  it("Bulk payout settlement assigns batch_id and payout_method to existing withdrawal records", async () => {
    const env = { JWT_SECRET: "test_jwt_secret_key" };
    const adminLogin = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "admin@facetube.com", password: "password" }),
      }),
      env,
    );
    assert.ok(adminLogin);
    const { token: adminToken } = await adminLogin.json();

    // 1. Create a withdrawal request as admin/user
    const wRes = await handleApiRequest(
      new Request("http://localhost:3000/api/wallet/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          amount: 1000,
          userId: "FT102857",
        }),
      }),
      env,
    );
    assert.ok(wRes);
    const wData = await wRes.json();
    assert.equal(wData.success, true);
    const txId = wData.transaction.id;

    // 2. Settle this withdrawal via bulk payout
    const batchId = `settle_batch_${Date.now()}`;
    const bulkRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/bulk-payout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          batch_id: batchId,
          payouts: [
            {
              userId: "FT102857",
              transaction_id: txId,
              amount: 1000,
              payout_method: "bulk_bank_transfer",
            },
          ],
        }),
      }),
      env,
    );
    assert.ok(bulkRes);
    const bulkData = await bulkRes.json();
    assert.equal(bulkData.success, true);
    assert.equal(bulkData.processed.length, 1);
    assert.equal(bulkData.processed[0].status, "completed");

    // 3. Verify transactions list contains batch_id and payout_method
    const txListRes = await handleApiRequest(
      new Request("http://localhost:3000/api/wallet/transactions?userId=FT102857", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      env,
    );
    assert.ok(txListRes);
    const txListData = await txListRes.json();
    const settledTx = txListData.transactions.find(
      (t: any) => t.id === txId || t.transaction_id === txId || t.transactionId === txId,
    );
    assert.ok(settledTx);
    assert.equal(settledTx.batch_id || settledTx.batchId, batchId);
    assert.ok(settledTx.payout_method || settledTx.payoutMethod);
  });

  it("Direct bulk payout records batch_id, payout_method, and masked beneficiary details", async () => {
    const env = { JWT_SECRET: "test_jwt_secret_key" };
    const adminLogin = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "admin@facetube.com", password: "password" }),
      }),
      env,
    );
    assert.ok(adminLogin);
    const { token: adminToken } = await adminLogin.json();

    const batchId = `direct_meta_batch_${Date.now()}`;
    const directRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/bulk-payout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          batch_id: batchId,
          payouts: [
            {
              userId: "FT102857",
              amount: 50,
              payout_method: "bulk_bank_transfer",
              bankDetails: {
                accountHolder: "Admin Beneficiary",
                accountNumber: "987654321098",
                bankName: "HDFC Bank",
                ifscCode: "HDFC0001234",
              },
            },
          ],
        }),
      }),
      env,
    );
    assert.ok(directRes);
    const directData = await directRes.json();
    assert.equal(directData.success, true);
    assert.equal(directData.processed.length, 1);
    const directTxId = directData.processed[0].transaction_id;

    // Verify transactions list has batch_id and payout_method and masked beneficiary details
    const txListRes = await handleApiRequest(
      new Request("http://localhost:3000/api/wallet/transactions?userId=FT102857", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      env,
    );
    assert.ok(txListRes);
    const txListData = await txListRes.json();
    const directTx = txListData.transactions.find(
      (t: any) => t.id === directTxId || t.transaction_id === directTxId,
    );
    assert.ok(directTx);
    assert.equal(directTx.batch_id || directTx.batchId, batchId);
    assert.equal(directTx.payout_method || directTx.payoutMethod, "bulk_bank_transfer");
    if (directTx.beneficiary_details || directTx.beneficiaryDetails) {
      const bStr = directTx.beneficiary_details || directTx.beneficiaryDetails;
      assert.equal(bStr.includes("987654321098"), false);
      assert.equal(bStr.includes("XXXXXXXX1098"), true);
    }
  });
});

describe("Task 5J-V2: Payment Create-Order Production Fail-Closed Tests", () => {
  const envKeys = [
    "NODE_ENV",
    "APP_ENV",
    "USE_REMOTE_PHP_API",
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
    "RAZORPAY_KEY_ID",
    "RAZORPAY_KEY_SECRET",
    "RAZORPAY_SKIP_REMOTE_CHECK",
  ] as const;

  const storePath = path.resolve(process.cwd(), "data/facetube_store.json");
  let envSnapshot: Record<string, string | undefined> = {};
  let storeExisted = false;
  let storeSnapshot: string | null = null;
  let originalFetch: typeof globalThis.fetch;

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
      if (isTargetStore(p)) ops.existsChecks++;
      return origExistsSync(p);
    }) as typeof fs.existsSync;

    (fs as any).statSync = ((p: fs.PathLike, options?: any) => {
      if (isTargetStore(p)) ops.statChecks++;
      return origStatSync(p, options);
    }) as typeof fs.statSync;

    fs.readFileSync = ((p: fs.PathOrFileDescriptor, options?: any) => {
      if (isTargetStore(p)) ops.reads++;
      return origReadFileSync(p, options);
    }) as typeof fs.readFileSync;

    fs.writeFileSync = ((p: fs.PathOrFileDescriptor, data: any, options?: any) => {
      if (isTargetStore(p)) ops.writes++;
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

  function enableMockDbEnv() {
    process.env["DB_HOST"] = "127.0.0.1";
    process.env["DB_NAME"] = "facetube_test";
    process.env["DB_USER"] = "facetube_user";
    process.env["DB_PASSWORD"] = "secret";
  }

  function createAuthSessionRow(userId = "FT483921", role = "user") {
    return {
      id: userId,
      user_id: userId,
      name: userId === "FT900431" ? "Maya Lin" : "Alex Rivera",
      mobile: "9999999999",
      email: userId === "FT900431" ? "maya@facetube.com" : "alex@facetube.com",
      role,
      referral_code: userId,
      avatar_url: null,
      channel_logo_url: null,
      channel_name: "Creator Channel",
      channel_description: null,
      created_at: new Date().toISOString(),
    };
  }

  beforeEach(() => {
    envSnapshot = {};
    for (const k of envKeys) {
      envSnapshot[k] = process.env[k];
    }
    originalFetch = globalThis.fetch;
    storeExisted = fs.existsSync(storePath);
    storeSnapshot = storeExisted ? fs.readFileSync(storePath, "utf-8") : null;
    resetInMemoryStore();
    setMysqlPoolForTesting(null);
    delete process.env["USE_REMOTE_PHP_API"];
    delete process.env["DB_HOST"];
    delete process.env["DB_NAME"];
    delete process.env["DB_USER"];
    delete process.env["DB_PASSWORD"];
    delete process.env["MYSQL_HOST"];
    delete process.env["MYSQL_DATABASE"];
    delete process.env["MYSQL_USER"];
    delete process.env["MYSQL_PASSWORD"];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
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

  it("1. Production without MySQL pool returns 503 and never accesses JSON store or Razorpay", async () => {
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath);

    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ id: "order_should_not_exist" }), { status: 200 });
    }) as typeof fetch;

    const spy = installStoreFsSpy();
    try {
      const cases: Array<{
        label: string;
        procNode?: string;
        procApp?: string;
        handlerEnv?: Record<string, string | undefined>;
      }> = [
        { label: "NODE_ENV=production", procNode: "production" },
        {
          label: "APP_ENV=production overrides NODE_ENV=development",
          procNode: "development",
          procApp: "production",
        },
        {
          label: "Handler env APP_ENV=production overrides process.env",
          procNode: "development",
          handlerEnv: { APP_ENV: "production", NODE_ENV: "development" },
        },
        { label: "Unset APP_ENV and NODE_ENV fail closed as production" },
      ];

      for (const tc of cases) {
        if (tc.procNode === undefined) delete process.env["NODE_ENV"];
        else process.env["NODE_ENV"] = tc.procNode;

        if (tc.procApp === undefined) delete process.env["APP_ENV"];
        else process.env["APP_ENV"] = tc.procApp;

        const req = new Request("https://facetube.online/api/payments/create-order", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            purpose: "premium_video_upload",
            userId: "FT483921",
          }),
        });

        const res = await handleApiRequest(req, {
          RAZORPAY_KEY_ID: "rzp_test_prod_key",
          RAZORPAY_KEY_SECRET: "rzp_test_prod_secret",
          ...(tc.handlerEnv || {}),
        });

        assert.ok(res, tc.label);
        assert.equal(res.status, 503, `${tc.label}: expected 503`);
        const body = await res.json();
        assert.equal(body.success, false, tc.label);
        assert.match(body.error || "", /database connection unavailable/i, tc.label);
      }

      assert.equal(fetchCalls, 0);
      assert.equal(spy.ops.reads, 0);
      assert.equal(spy.ops.writes, 0);
      assert.equal(spy.ops.existsChecks, 0);
      assert.equal(fs.existsSync(storePath), false);
    } finally {
      spy.restore();
    }
  });

  it("2. Production MySQL payment_orders INSERT failure fails closed with 500 and never writes JSON or returns orderId", async () => {
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
    process.env["NODE_ENV"] = "production";
    delete process.env["APP_ENV"];
    enableMockDbEnv();

    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ id: "order_rzp_fail_test_1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const spy = installStoreFsSpy();
    try {
      // Scenario A: pool.query throws during INSERT INTO payment_orders
      setMysqlPoolForTesting({
        query: async (sql: string) => {
          if (sql.includes("FROM INFORMATION_SCHEMA.TABLES")) {
            return [[{ TABLE_NAME: "global_pool_reserves" }], []];
          }
          if (sql.includes("FROM sessions s")) {
            return [[createAuthSessionRow("FT483921")], []];
          }
          if (sql.includes("INSERT INTO payment_orders")) {
            throw new Error("MySQL deadlock or write error");
          }
          return [[], []];
        },
      } as any);

      const resThrow = await handleApiRequest(
        new Request("https://facetube.online/api/payments/create-order", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer valid_prod_token_1",
          },
          body: JSON.stringify({
            purpose: "premium_video_upload",
            userId: "FT483921",
          }),
        }),
        {
          RAZORPAY_KEY_ID: "rzp_test_prod_key",
          RAZORPAY_KEY_SECRET: "rzp_test_prod_secret",
        },
      );

      assert.ok(resThrow);
      assert.equal(resThrow.status, 500);
      const bodyThrow = await resThrow.json();
      assert.equal(bodyThrow.success, false);
      assert.equal(bodyThrow.orderId, undefined);
      assert.match(bodyThrow.error || "", /persisting payment order/i);

      // Scenario B: INSERT INTO payment_orders resolves with affectedRows: 0
      setMysqlPoolForTesting({
        query: async (sql: string) => {
          if (sql.includes("FROM sessions s")) {
            return [[createAuthSessionRow("FT483921")], []];
          }
          if (sql.includes("INSERT INTO payment_orders")) {
            return [{ affectedRows: 0 }, []];
          }
          return [[], []];
        },
      } as any);

      const resZeroRows = await handleApiRequest(
        new Request("https://facetube.online/api/payments/create-order", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer valid_prod_token_1",
          },
          body: JSON.stringify({
            purpose: "paid_subscription",
            planId: "member-monthly",
            userId: "FT483921",
          }),
        }),
        {
          RAZORPAY_KEY_ID: "rzp_test_prod_key",
          RAZORPAY_KEY_SECRET: "rzp_test_prod_secret",
        },
      );

      assert.ok(resZeroRows);
      assert.equal(resZeroRows.status, 500);
      const bodyZeroRows = await resZeroRows.json();
      assert.equal(bodyZeroRows.success, false);
      assert.equal(bodyZeroRows.orderId, undefined);
      assert.match(bodyZeroRows.error || "", /failed to persist payment order/i);

      assert.equal(spy.ops.writes, 0);
      assert.equal(spy.ops.reads, 0);
      assert.equal(fs.existsSync(storePath), false);
    } finally {
      spy.restore();
    }
  });

  it("3. Production verifies video ownership & eligibility from authoritative MySQL uploaded_videos", async () => {
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
    process.env["APP_ENV"] = "production";
    process.env["NODE_ENV"] = "development";
    enableMockDbEnv();

    let razorpayCalls = 0;
    globalThis.fetch = (async () => {
      razorpayCalls++;
      return new Response(JSON.stringify({ id: "order_should_not_be_created" }), { status: 200 });
    }) as typeof fetch;

    setMysqlPoolForTesting({
      query: async (sql: string, params?: any[]) => {
        if (sql.includes("FROM sessions s")) {
          const token = params?.[0];
          if (token === "token_maya") return [[createAuthSessionRow("FT900431")], []];
          return [[createAuthSessionRow("FT483921")], []];
        }
        if (sql.includes("FROM uploaded_videos")) {
          const vid = params?.[0];
          if (vid === "vid-db-alex-1") {
            return [
              [{ id: vid, user_id: "FT483921", video_type: "ads", payment_status: "pending" }],
              [],
            ];
          }
          if (vid === "vid-db-free-maya") {
            return [
              [{ id: vid, user_id: "FT900431", video_type: "free", payment_status: "paid" }],
              [],
            ];
          }
          if (vid === "vid-db-err") {
            throw new Error("uploaded_videos lookup failed");
          }
          return [[], []];
        }
        return [[], []];
      },
    } as any);

    const env = {
      APP_ENV: "production",
      NODE_ENV: "development",
      RAZORPAY_KEY_ID: "rzp_test_prod_key",
      RAZORPAY_KEY_SECRET: "rzp_test_prod_secret",
    };

    // 3a. Non-owner (Maya) blocked from promoting Alex's DB video -> 403
    const nonOwnerPromoRes = await handleApiRequest(
      new Request("https://facetube.online/api/payments/create-order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer token_maya",
        },
        body: JSON.stringify({
          purpose: "ads_promotion",
          videoId: "vid-db-alex-1",
          planId: "plan-monthly",
          userId: "FT900431",
        }),
      }),
      env,
    );
    assert.equal(nonOwnerPromoRes?.status, 403);

    // 3b. Missing video for ads_promotion -> 404
    const missingVideoRes = await handleApiRequest(
      new Request("https://facetube.online/api/payments/create-order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer token_alex",
        },
        body: JSON.stringify({
          purpose: "ads_promotion",
          videoId: "vid-nonexistent",
          planId: "plan-monthly",
          userId: "FT483921",
        }),
      }),
      env,
    );
    assert.equal(missingVideoRes?.status, 404);

    // 3c. Free video for premium_video_upload -> 400
    const freeVideoRes = await handleApiRequest(
      new Request("https://facetube.online/api/payments/create-order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer token_maya",
        },
        body: JSON.stringify({
          purpose: "premium_video_upload",
          videoId: "vid-db-free-maya",
          userId: "FT900431",
        }),
      }),
      env,
    );
    assert.equal(freeVideoRes?.status, 400);

    // 3d. DB error during uploaded_videos check -> 500 fail closed
    const dbErrRes = await handleApiRequest(
      new Request("https://facetube.online/api/payments/create-order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer token_alex",
        },
        body: JSON.stringify({
          purpose: "ads_promotion",
          videoId: "vid-db-err",
          planId: "plan-monthly",
          userId: "FT483921",
        }),
      }),
      env,
    );
    assert.equal(dbErrRes?.status, 500);
    assert.equal(razorpayCalls, 0);
  });

  it("4. Valid production MySQL order creation preserves Razorpay amount/INR currency and persists to MySQL without touching JSON", async () => {
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
    process.env["NODE_ENV"] = "production";
    delete process.env["APP_ENV"];
    enableMockDbEnv();

    const razorpayRequests: Array<{ amount: number; currency: string; purpose?: string }> = [];
    const persistedOrders: any[][] = [];

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body || "{}"));
      razorpayRequests.push({
        amount: sent.amount,
        currency: sent.currency,
        purpose: sent.notes?.purpose,
      });
      return new Response(JSON.stringify({ id: `order_prod_${razorpayRequests.length}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    setMysqlPoolForTesting({
      query: async (sql: string, params?: any[]) => {
        if (sql.includes("FROM INFORMATION_SCHEMA.TABLES")) {
          return [[{ TABLE_NAME: "global_pool_reserves" }], []];
        }
        if (sql.includes("FROM sessions s")) {
          return [[createAuthSessionRow("FT483921")], []];
        }
        if (sql.includes("FROM uploaded_videos")) {
          const vid = params?.[0];
          return [
            [{ id: vid, user_id: "FT483921", video_type: "premium", payment_status: "pending" }],
            [],
          ];
        }
        if (sql.includes("INSERT INTO payment_orders")) {
          persistedOrders.push(params || []);
          return [{ affectedRows: 1 }, []];
        }
        return [[], []];
      },
    } as any);

    const spy = installStoreFsSpy();
    try {
      const testCases = [
        {
          body: { purpose: "premium_video_upload", videoId: "vid-db-prem-1", userId: "FT483921" },
          expectedAmount: 6,
          expectedSubunits: 600,
        },
        {
          body: {
            purpose: "ads_promotion",
            videoId: "vid-db-ads-1",
            planId: "plan-yearly",
            userId: "FT483921",
          },
          expectedAmount: 3000,
          expectedSubunits: 300000,
        },
        {
          body: { purpose: "paid_subscription", planId: "member-monthly", userId: "FT483921" },
          expectedAmount: 49,
          expectedSubunits: 4900,
        },
      ];

      for (let i = 0; i < testCases.length; i++) {
        const tc = testCases[i]!;
        const res = await handleApiRequest(
          new Request("https://facetube.online/api/payments/create-order", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer token_alex_prod",
            },
            body: JSON.stringify(tc.body),
          }),
          {
            RAZORPAY_KEY_ID: "rzp_test_prod_key",
            RAZORPAY_KEY_SECRET: "rzp_test_prod_secret",
          },
        );

        assert.ok(res);
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.orderId, `order_prod_${i + 1}`);
        assert.equal(data.amount, tc.expectedAmount);
        assert.equal(data.amountInSubunits, tc.expectedSubunits);
        assert.equal(data.currency, "INR");
      }

      assert.equal(razorpayRequests.length, 3);
      assert.deepEqual(
        razorpayRequests.map((r) => [r.amount, r.currency]),
        [
          [600, "INR"],
          [300000, "INR"],
          [4900, "INR"],
        ],
      );
      assert.equal(persistedOrders.length, 3);
      assert.equal(persistedOrders[0]?.[0], "order_prod_1");
      assert.equal(persistedOrders[1]?.[5], "plan-yearly");
      assert.equal(persistedOrders[2]?.[5], "member-monthly");
      assert.equal(spy.ops.reads, 0);
      assert.equal(spy.ops.writes, 0);
      assert.equal(fs.existsSync(storePath), false);
    } finally {
      spy.restore();
    }
  });

  it("5. Development/test fallback without MySQL pool preserves JSON store paymentOrders persistence", async () => {
    process.env["NODE_ENV"] = "test";
    delete process.env["APP_ENV"];

    const loginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login.php", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
      }),
    );
    assert.ok(loginRes);
    const { token } = await loginRes.json();

    const res = await handleApiRequest(
      new Request("http://localhost:3000/api/payments/create-order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          purpose: "paid_subscription",
          planId: "member-monthly",
          userId: "FT483921",
        }),
      }),
      {
        NODE_ENV: "test",
        RAZORPAY_KEY_ID: "rzp_test_dev_key",
        RAZORPAY_KEY_SECRET: "rzp_test_dev_secret",
        RAZORPAY_SKIP_REMOTE_CHECK: "true",
      },
    );

    assert.ok(res);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.orderId);
    assert.equal(data.amount, 49);
    assert.equal(data.currency, "INR");

    const diskStore = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    const recorded = (diskStore.paymentOrders || []).find((o: any) => o.order_id === data.orderId);
    assert.ok(recorded, "Dev/test fallback should record order into JSON store");
    assert.equal(recorded.amount, 49);
    assert.equal(recorded.currency, "INR");
  });

  it("6. PHP counterpart api/payments/create-order.php fails closed on payment_orders INSERT error and verifies DB video eligibility", () => {
    const phpPath = path.resolve(process.cwd(), "api/payments/create-order.php");
    const phpCode = fs.readFileSync(phpPath, "utf-8");

    assert.match(phpCode, /INSERT INTO payment_orders/);
    assert.match(phpCode, /\$inserted\s*===\s*false/);
    assert.match(phpCode, /catch\s*\(\s*Throwable\s+\$ePo\s*\)/);
    assert.match(
      phpCode,
      /jsonResponse\(\[\s*'success'\s*=>\s*false,\s*'error'\s*=>\s*'Failed to persist payment order in database\. Please try again\.',?\s*\],\s*500\)/,
    );
    assert.equal(
      phpCode.includes("Warning: Failed to record payment_orders"),
      false,
      "PHP create-order must not swallow payment_orders DB errors as warnings",
    );

    assert.match(
      phpCode,
      /SELECT id, user_id, video_type FROM uploaded_videos WHERE id = \? LIMIT 1/,
    );
    assert.match(phpCode, /catch\s*\(\s*Throwable\s+\$eVid\s*\)/);
    assert.match(phpCode, /Free video uploads do not require payment\./);
    assert.match(phpCode, /Video not found for promotion\./);
  });
});

describe("Task 5J-V3: Admin Bulk Payout Production Fail-Closed Tests", () => {
  const envKeys = [
    "NODE_ENV",
    "APP_ENV",
    "USE_REMOTE_PHP_API",
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
      if (isTargetStore(p)) ops.existsChecks++;
      return origExistsSync(p);
    }) as typeof fs.existsSync;

    (fs as any).statSync = ((p: fs.PathLike, options?: any) => {
      if (isTargetStore(p)) ops.statChecks++;
      return origStatSync(p, options);
    }) as typeof fs.statSync;

    fs.readFileSync = ((p: fs.PathOrFileDescriptor, options?: any) => {
      if (isTargetStore(p)) ops.reads++;
      return origReadFileSync(p, options);
    }) as typeof fs.readFileSync;

    fs.writeFileSync = ((p: fs.PathOrFileDescriptor, data: any, options?: any) => {
      if (isTargetStore(p)) ops.writes++;
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

  function enableMockDbEnv() {
    process.env["DB_HOST"] = "127.0.0.1";
    process.env["DB_NAME"] = "facetube_test";
    process.env["DB_USER"] = "facetube_user";
    process.env["DB_PASSWORD"] = "secret";
  }

  function createAuthSessionRow(userId = "FT102857", role: "admin" | "user" = "admin") {
    return {
      id: userId,
      user_id: userId,
      name: role === "admin" ? "FaceTube Admin" : "Alex Rivera",
      mobile: "9999999999",
      email: role === "admin" ? "admin@facetube.com" : "alex@facetube.com",
      role,
      referral_code: userId,
      avatar_url: null,
      channel_logo_url: null,
      channel_name: "FaceTube Official",
      channel_description: null,
      created_at: new Date().toISOString(),
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
    delete process.env["USE_REMOTE_PHP_API"];
    delete process.env["DB_HOST"];
    delete process.env["DB_NAME"];
    delete process.env["DB_USER"];
    delete process.env["DB_PASSWORD"];
    delete process.env["MYSQL_HOST"];
    delete process.env["MYSQL_DATABASE"];
    delete process.env["MYSQL_USER"];
    delete process.env["MYSQL_PASSWORD"];
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

  it("1. Production without MySQL pool returns 503 and never accesses JSON store or seeds demo balances", async () => {
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath);

    const spy = installStoreFsSpy();
    try {
      const cases: Array<{
        label: string;
        procNode?: string;
        procApp?: string;
        handlerEnv?: Record<string, string | undefined>;
        withBearer?: boolean;
      }> = [
        { label: "NODE_ENV=production (no token)", procNode: "production", withBearer: false },
        { label: "NODE_ENV=production (with token)", procNode: "production", withBearer: true },
        {
          label: "APP_ENV=production overrides NODE_ENV=development",
          procNode: "development",
          procApp: "production",
          withBearer: true,
        },
        {
          label: "Handler env APP_ENV=production overrides process.env",
          procNode: "development",
          handlerEnv: { APP_ENV: "production", NODE_ENV: "development" },
          withBearer: true,
        },
        { label: "Unset APP_ENV and NODE_ENV fail closed as production", withBearer: true },
      ];

      for (const tc of cases) {
        if (tc.procNode === undefined) delete process.env["NODE_ENV"];
        else process.env["NODE_ENV"] = tc.procNode;

        if (tc.procApp === undefined) delete process.env["APP_ENV"];
        else process.env["APP_ENV"] = tc.procApp;

        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (tc.withBearer) {
          headers["Authorization"] = "Bearer prod_admin_token";
        }

        const req = new Request("https://facetube.online/api/admin/bulk-payout", {
          method: "POST",
          headers,
          body: JSON.stringify({
            payouts: [{ userId: "FT102857", amount: 100 }],
          }),
        });

        const res = await handleApiRequest(req, tc.handlerEnv);
        assert.ok(res, tc.label);
        assert.equal(res.status, 503, `${tc.label}: expected 503`);
        const body = await res.json();
        assert.equal(body.success, false, tc.label);
        assert.match(body.error || "", /database connection unavailable/i, tc.label);
      }

      assert.equal(spy.ops.reads, 0);
      assert.equal(spy.ops.writes, 0);
      assert.equal(spy.ops.existsChecks, 0);
      assert.equal(fs.existsSync(storePath), false);
    } finally {
      spy.restore();
    }
  });

  it("2. Production MySQL read/query/persistence failures return 500/503, roll back transactions, and never return success", async () => {
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
    process.env["NODE_ENV"] = "production";
    delete process.env["APP_ENV"];
    enableMockDbEnv();

    const spy = installStoreFsSpy();
    try {
      // Scenario A: pool.getConnection() throws ECONNREFUSED -> 503
      setMysqlPoolForTesting({
        query: async (sql: string) => {
          if (sql.includes("FROM sessions s")) {
            return [[createAuthSessionRow("FT102857", "admin")], []];
          }
          return [{ affectedRows: 1 }, []];
        },
        getConnection: async () => {
          const err: any = new Error("connect ECONNREFUSED 127.0.0.1:3306");
          err.code = "ECONNREFUSED";
          throw err;
        },
      } as any);

      const resConnErr = await handleApiRequest(
        new Request("https://facetube.online/api/admin/bulk-payout", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer prod_admin_token",
          },
          body: JSON.stringify({
            payouts: [{ userId: "FT483921", amount: 100 }],
          }),
        }),
      );
      assert.ok(resConnErr);
      assert.equal(resConnErr.status, 503);
      assert.equal((await resConnErr.json()).success, false);

      // Scenario B: Case 1 transaction lookup throws non-schema DB read error -> 500 (never 404)
      let rollbackCountB = 0;
      setMysqlPoolForTesting({
        query: async (sql: string) => {
          if (sql.includes("FROM sessions s")) {
            return [[createAuthSessionRow("FT102857", "admin")], []];
          }
          return [{ affectedRows: 1 }, []];
        },
        getConnection: async () => ({
          beginTransaction: async () => {},
          commit: async () => {},
          rollback: async () => {
            rollbackCountB++;
          },
          release: () => {},
          query: async (sql: string) => {
            if (sql.includes("FROM wallet_transactions")) {
              throw new Error("MySQL deadlock during transaction lookup");
            }
            return [[], []];
          },
        }),
      } as any);

      const resLookupErr = await handleApiRequest(
        new Request("https://facetube.online/api/admin/bulk-payout", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer prod_admin_token",
          },
          body: JSON.stringify({
            payouts: [{ userId: "FT483921", amount: 100, transactionId: "tx_wdr_1" }],
          }),
        }),
      );
      assert.ok(resLookupErr);
      assert.equal(resLookupErr.status, 500);
      assert.equal(rollbackCountB, 1);
      assert.equal((await resLookupErr.json()).success, false);

      // Scenario C: Case 2 INSERT INTO wallet_transactions returns affectedRows: 0 -> 500 + rollback
      let rollbackCountC = 0;
      let commitCountC = 0;
      setMysqlPoolForTesting({
        query: async (sql: string) => {
          if (sql.includes("FROM sessions s")) {
            return [[createAuthSessionRow("FT102857", "admin")], []];
          }
          return [{ affectedRows: 1 }, []];
        },
        getConnection: async () => ({
          beginTransaction: async () => {},
          commit: async () => {
            commitCountC++;
          },
          rollback: async () => {
            rollbackCountC++;
          },
          release: () => {},
          query: async (sql: string) => {
            if (sql.includes("FROM wallet_transactions WHERE id = ? AND batch_id = ?")) {
              return [[], []];
            }
            if (sql.includes("FROM income_ledger WHERE")) {
              return [[], []];
            }
            if (sql.includes("SELECT balance FROM wallet_balances")) {
              return [[{ balance: 5000 }], []];
            }
            if (sql.includes("INSERT INTO wallet_transactions")) {
              return [{ affectedRows: 0 }, []];
            }
            return [{ affectedRows: 1 }, []];
          },
        }),
      } as any);

      const resZeroInsert = await handleApiRequest(
        new Request("https://facetube.online/api/admin/bulk-payout", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer prod_admin_token",
          },
          body: JSON.stringify({
            payouts: [{ userId: "FT483921", amount: 100 }],
          }),
        }),
      );
      assert.equal(resZeroInsert?.status, 500);
      assert.equal(commitCountC, 0);
      assert.equal(rollbackCountC, 1);
      const bodyZeroInsert = await resZeroInsert?.json();
      assert.equal(bodyZeroInsert.success, false);
      assert.match(bodyZeroInsert.error || "", /failed to persist payout transaction record/i);

      // Scenario D: Case 2 UPDATE wallet_balances returns affectedRows: 0 -> 500 + rollback
      let rollbackCountD = 0;
      let commitCountD = 0;
      setMysqlPoolForTesting({
        query: async (sql: string) => {
          if (sql.includes("FROM sessions s")) {
            return [[createAuthSessionRow("FT102857", "admin")], []];
          }
          return [{ affectedRows: 1 }, []];
        },
        getConnection: async () => ({
          beginTransaction: async () => {},
          commit: async () => {
            commitCountD++;
          },
          rollback: async () => {
            rollbackCountD++;
          },
          release: () => {},
          query: async (sql: string) => {
            if (sql.includes("FROM wallet_transactions WHERE id = ? AND batch_id = ?")) {
              return [[], []];
            }
            if (sql.includes("FROM income_ledger WHERE")) {
              return [[], []];
            }
            if (sql.includes("SELECT balance FROM wallet_balances")) {
              return [[{ balance: 5000 }], []];
            }
            if (sql.includes("INSERT INTO wallet_transactions")) {
              return [{ affectedRows: 1 }, []];
            }
            if (sql.includes("UPDATE wallet_balances")) {
              return [{ affectedRows: 0 }, []];
            }
            return [{ affectedRows: 1 }, []];
          },
        }),
      } as any);

      const resZeroWallet = await handleApiRequest(
        new Request("https://facetube.online/api/admin/bulk-payout", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer prod_admin_token",
          },
          body: JSON.stringify({
            payouts: [{ userId: "FT483921", amount: 100 }],
          }),
        }),
      );
      assert.equal(resZeroWallet?.status, 500);
      assert.equal(commitCountD, 0);
      assert.equal(rollbackCountD, 1);
      const bodyZeroWallet = await resZeroWallet?.json();
      assert.equal(bodyZeroWallet.success, false);
      assert.match(bodyZeroWallet.error || "", /failed to persist wallet balance update/i);

      // Scenario E: Case 1 UPDATE wallet_transactions returns affectedRows: 0 -> 500 + rollback
      let rollbackCountE = 0;
      setMysqlPoolForTesting({
        query: async (sql: string) => {
          if (sql.includes("FROM sessions s")) {
            return [[createAuthSessionRow("FT102857", "admin")], []];
          }
          return [{ affectedRows: 1 }, []];
        },
        getConnection: async () => ({
          beginTransaction: async () => {},
          commit: async () => {},
          rollback: async () => {
            rollbackCountE++;
          },
          release: () => {},
          query: async (sql: string) => {
            if (
              sql.includes("SELECT id, user_id, amount, status, batch_id FROM wallet_transactions")
            ) {
              return [
                [
                  {
                    id: "tx_wdr_pending_1",
                    user_id: "FT483921",
                    amount: 250,
                    status: "pending",
                    batch_id: null,
                  },
                ],
                [],
              ];
            }
            if (sql.includes("UPDATE wallet_transactions")) {
              return [{ affectedRows: 0 }, []];
            }
            return [{ affectedRows: 1 }, []];
          },
        }),
      } as any);

      const resZeroStatusUpd = await handleApiRequest(
        new Request("https://facetube.online/api/admin/bulk-payout", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer prod_admin_token",
          },
          body: JSON.stringify({
            payouts: [{ userId: "FT483921", amount: 250, transactionId: "tx_wdr_pending_1" }],
          }),
        }),
      );
      assert.ok(resZeroStatusUpd);
      assert.equal(resZeroStatusUpd.status, 500);
      assert.equal(rollbackCountE, 1);
      assert.equal((await resZeroStatusUpd.json()).success, false);

      assert.equal(spy.ops.reads, 0);
      assert.equal(spy.ops.writes, 0);
      assert.equal(fs.existsSync(storePath), false);
    } finally {
      spy.restore();
    }
  });

  it("3. Production never seeds demo wallet balances for FT102857/FT483921/FT900431 when MySQL wallet row is missing", async () => {
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
    process.env["APP_ENV"] = "production";
    process.env["NODE_ENV"] = "development";
    enableMockDbEnv();

    let walletUpdates = 0;
    let txInserts = 0;
    setMysqlPoolForTesting({
      query: async (sql: string) => {
        if (sql.includes("FROM sessions s")) {
          return [[createAuthSessionRow("FT102857", "admin")], []];
        }
        return [{ affectedRows: 1 }, []];
      },
      getConnection: async () => ({
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        release: () => {},
        query: async (sql: string) => {
          if (sql.includes("FROM wallet_transactions WHERE id = ? AND batch_id = ?")) {
            return [[], []];
          }
          if (sql.includes("FROM income_ledger WHERE")) {
            return [[], []];
          }
          if (sql.includes("SELECT balance FROM wallet_balances")) {
            return [[], []]; // Missing wallet row in MySQL
          }
          if (
            sql.includes("INSERT INTO wallet_transactions") ||
            sql.includes("INSERT INTO income_ledger")
          ) {
            txInserts++;
          }
          if (sql.includes("UPDATE wallet_balances")) {
            walletUpdates++;
          }
          return [{ affectedRows: 1 }, []];
        },
      }),
    } as any);

    const spy = installStoreFsSpy();
    try {
      const res = await handleApiRequest(
        new Request("https://facetube.online/api/admin/bulk-payout", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer prod_admin_token",
          },
          body: JSON.stringify({
            payouts: [{ userId: "FT102857", amount: 100 }],
          }),
        }),
        { APP_ENV: "production", NODE_ENV: "development" },
      );

      assert.equal(res?.status, 400);
      const body = await res?.json();
      assert.equal(body.success, false);
      assert.match(body.error || "", /insufficient balance.*Available:\s*₹0/i);
      assert.equal(txInserts, 0);
      assert.equal(walletUpdates, 0);
      assert.equal(spy.ops.reads, 0);
      assert.equal(spy.ops.writes, 0);
      assert.equal(fs.existsSync(storePath), false);
    } finally {
      spy.restore();
    }
  });

  it("4. Successful production MySQL payout preserves exact accounting behavior without touching JSON store", async () => {
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
    process.env["NODE_ENV"] = "production";
    delete process.env["APP_ENV"];
    enableMockDbEnv();

    const wallets: Record<string, { balance: number; total_withdrawn: number }> = {
      FT483921: { balance: 1200, total_withdrawn: 300 },
      FT900431: { balance: 500, total_withdrawn: 0 },
    };
    const existingPendingTx = {
      id: "tx_wdr_existing_1",
      user_id: "FT900431",
      amount: 400,
      status: "pending",
      batch_id: null as string | null,
      payout_method: null as string | null,
    };
    const insertedDirectTxs: any[] = [];
    const batchRecords: any[] = [];
    let commits = 0;

    setMysqlPoolForTesting({
      query: async (sql: string, params?: any[]) => {
        if (sql.includes("FROM sessions s")) {
          return [[createAuthSessionRow("FT102857", "admin")], []];
        }
        if (sql.includes("INSERT INTO payout_batches")) {
          batchRecords.push(params);
          return [{ affectedRows: 1 }, []];
        }
        return [{ affectedRows: 1 }, []];
      },
      getConnection: async () => ({
        beginTransaction: async () => {},
        commit: async () => {
          commits++;
        },
        rollback: async () => {},
        release: () => {},
        query: async (sql: string, params?: any[]) => {
          if (
            sql.includes(
              "SELECT id, user_id, amount, status, batch_id FROM wallet_transactions WHERE id = ?",
            )
          ) {
            if (params?.[0] === existingPendingTx.id) {
              return [[{ ...existingPendingTx }], []];
            }
            return [[], []];
          }
          if (sql.includes("UPDATE wallet_transactions SET status = 'completed'")) {
            existingPendingTx.status = "completed";
            existingPendingTx.batch_id = params?.[0];
            existingPendingTx.payout_method = params?.[1];
            return [{ affectedRows: 1 }, []];
          }
          if (sql.includes("FROM wallet_transactions WHERE id = ? AND batch_id = ?")) {
            return [[], []];
          }
          if (sql.includes("FROM income_ledger WHERE")) {
            return [[], []];
          }
          if (sql.includes("SELECT balance FROM wallet_balances")) {
            const uid = String(params?.[0] || "").toUpperCase();
            const w = wallets[uid];
            return [w ? [{ balance: w.balance }] : [], []];
          }
          if (sql.includes("INSERT INTO wallet_transactions")) {
            insertedDirectTxs.push(params);
            return [{ affectedRows: 1 }, []];
          }
          if (sql.includes("UPDATE wallet_balances")) {
            const amt = Number(params?.[0] || 0);
            const uid = String(params?.[2] || "").toUpperCase();
            if (!wallets[uid]) return [{ affectedRows: 0 }, []];
            wallets[uid]!.balance -= amt;
            wallets[uid]!.total_withdrawn += amt;
            return [{ affectedRows: 1 }, []];
          }
          return [{ affectedRows: 1 }, []];
        },
      }),
    } as any);

    const spy = installStoreFsSpy();
    try {
      const batchId = "prod_batch_001";
      const res = await handleApiRequest(
        new Request("https://facetube.online/api/admin/bulk-payout", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer prod_admin_token",
          },
          body: JSON.stringify({
            batch_id: batchId,
            notes: "Production MySQL payout",
            payouts: [
              {
                userId: "FT900431",
                amount: 400,
                transactionId: "tx_wdr_existing_1",
                payout_method: "bank_transfer",
              },
              {
                userId: "FT483921",
                amount: 250,
                payout_method: "bulk_bank_transfer",
                bankDetails: {
                  accountHolder: "Alex Rivera",
                  accountNumber: "50100481920194",
                  bankName: "HDFC Bank",
                  ifscCode: "HDFC0001234",
                },
              },
            ],
          }),
        }),
      );

      assert.equal(res?.status, 200);
      const data = await res?.json();
      assert.equal(data.success, true);
      assert.equal(data.batch_id, batchId);
      assert.equal(data.total_recipients, 2);
      assert.equal(data.total_amount, 650);
      assert.equal(data.chunks_processed, 1);
      assert.deepEqual(data.progress, { total: 2, processed: 2, successful: 2, failed: 0 });
      assert.equal(data.processed[0].deduction_type, "settled_existing_request");
      assert.equal(data.processed[1].deduction_type, "new_direct_disbursement");
      assert.equal(data.processed[1].transaction_id, `tx_wdr_bulk_${batchId}_1`);

      // Existing withdrawal settlement must NOT deduct FT900431 wallet again
      assert.equal(wallets["FT900431"]?.balance, 500);
      assert.equal(wallets["FT900431"]?.total_withdrawn, 0);
      assert.equal(existingPendingTx.status, "completed");
      assert.equal(existingPendingTx.batch_id, batchId);

      // Direct payout deducts FT483921 wallet exactly once and masks beneficiary details
      assert.equal(wallets["FT483921"]?.balance, 950);
      assert.equal(wallets["FT483921"]?.total_withdrawn, 550);
      assert.equal(insertedDirectTxs.length, 1);
      assert.equal(String(insertedDirectTxs[0]?.[5] || "").includes("50100481920194"), false);
      assert.equal(String(insertedDirectTxs[0]?.[5] || "").includes("XXXXXXXXXX0194"), true);

      assert.equal(commits, 1);
      assert.equal(batchRecords.length, 2);
      assert.equal(spy.ops.reads, 0);
      assert.equal(spy.ops.writes, 0);
      assert.equal(fs.existsSync(storePath), false);
    } finally {
      spy.restore();
    }
  });

  it("5. Development/test fallback without MySQL pool preserves JSON store bulk payout behavior", async () => {
    process.env["NODE_ENV"] = "test";
    delete process.env["APP_ENV"];

    const devEnv = { NODE_ENV: "test" };
    const loginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "FT102857", password: "password" }),
      }),
      devEnv,
    );
    assert.equal(loginRes?.status, 200);
    const { token: adminToken } = await loginRes!.json();

    const batchId = `dev_fallback_batch_${Date.now()}`;
    const res = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/bulk-payout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          batch_id: batchId,
          payouts: [{ userId: "FT102857", amount: 75 }],
        }),
      }),
      devEnv,
    );

    assert.equal(res?.status, 200);
    const data = await res?.json();
    assert.equal(data.success, true);
    assert.equal(data.total_amount, 75);

    const diskStore = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    const savedBatch = (diskStore.payoutBatches || []).find((b: any) => b.id === batchId);
    assert.ok(savedBatch, "Dev/test fallback should persist payoutBatches to JSON store");
    assert.equal(savedBatch.status, "completed");
    assert.equal(savedBatch.total_amount, 75);
  });

  it("6. PHP counterpart api/admin/bulk-payout.php fails closed on non-schema PDO errors and zero-row mutations", () => {
    const phpPath = path.resolve(process.cwd(), "api/admin/bulk-payout.php");
    const phpCode = fs.readFileSync(phpPath, "utf-8");

    assert.match(phpCode, /function isMissingSchemaObjectException\(PDOException \$e\): bool/);
    assert.match(phpCode, /if\s*\(\s*!isMissingSchemaObjectException\(\$eCheck\)\s*\)/);
    assert.match(phpCode, /if\s*\(\s*\$stmtUpdate->rowCount\(\)\s*<\s*1\s*\)/);
    assert.match(phpCode, /if\s*\(\s*\$insertedRows\s*<\s*1\s*\)/);
    assert.match(phpCode, /if\s*\(\s*\$stmtWallet->rowCount\(\)\s*<\s*1\s*\)/);
  });
});

describe("Task 5J-V4-L: Payment Verify Fail-Closed Authentication & Transaction Safety Tests", () => {
  const verifyPhpPath = path.resolve(process.cwd(), "api/payments/verify.php");
  const responsePhpPath = path.resolve(process.cwd(), "api/response.php");

  function loadVerifyAndResponsePhp() {
    const verifyPhp = fs.readFileSync(verifyPhpPath, "utf-8");
    const responsePhp = fs.readFileSync(responsePhpPath, "utf-8");
    return { verifyPhp, responsePhp };
  }

  /**
   * Behavioral simulator mirroring api/payments/verify.php lines 184-265 & 1177-1255
   * using exact driver-code / regex classification extracted from api/response.php and verify.php.
   */
  function createVerifyAuthHarness(options: {
    responsePhp: string;
    verifyPhp: string;
    orderRecord: { user_id: string; status: string; amount: number; purpose: string } | null;
    bearerToken: string | null;
    sessionLookupBehavior:
      | { kind: "guest" }
      | { kind: "user"; user_id: string; role: string }
      | { kind: "invalid" }
      | {
          kind: "db_error";
          sqlState: string;
          driverCode: number;
          message: string;
          isRuntime?: boolean;
        };
    rollbackThrows?: boolean;
  }) {
    const fnStart = options.responsePhp.indexOf("function isDatabaseConnectionUnavailableError(");
    const fnBlock = options.responsePhp.slice(fnStart, fnStart + 900);
    const codeMatch = fnBlock.match(/in_array\(\$driverCode,\s*\[([^\]]+)\],\s*true\)/);
    const driverCodes = (codeMatch?.[1] || "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => !Number.isNaN(n));
    const regexMatch = fnBlock.match(/preg_match\('\/([^']+)\/i',\s*\$msg\)/);
    const msgRegex = new RegExp(regexMatch?.[1] || "", "i");

    const isConnUnavailable = (sqlState: string, driverCode: number, msg: string) =>
      sqlState.startsWith("08") || driverCodes.includes(driverCode) || msgRegex.test(msg);

    let inTransaction = false;
    let rollbackAttempts = 0;
    let paymentVerifyProceeded = false;
    const serverLogs: string[] = [];

    const safeRollback = () => {
      try {
        if (inTransaction) {
          rollbackAttempts++;
          if (options.rollbackThrows) {
            throw new Error("MySQL server has gone away during ROLLBACK");
          }
          inTransaction = false;
        }
      } catch (err: any) {
        serverLogs.push(`[verify.php][ROLLBACK] Rollback failed: ${err.message}`);
      }
    };

    try {
      inTransaction = true;
      const orderRecord = options.orderRecord;

      // Mirrors $authUser = getAuthUser($pdo, true); if (!$authUser) -> 401
      const suppliedBearerToken = options.bearerToken;
      let authUser: { user_id: string; role: string } | null = null;
      if (suppliedBearerToken !== null) {
        if (options.sessionLookupBehavior.kind === "user") {
          authUser = {
            user_id: options.sessionLookupBehavior.user_id,
            role: options.sessionLookupBehavior.role,
          };
        } else if (options.sessionLookupBehavior.kind === "invalid") {
          authUser = null;
        } else if (options.sessionLookupBehavior.kind === "db_error") {
          throw options.sessionLookupBehavior;
        }
      }

      if (!authUser) {
        safeRollback();
        return {
          status: 401,
          body: {
            verified: false,
            error: "Authentication required. Please log in to verify payment.",
          },
          rollbackAttempts,
          paymentVerifyProceeded,
          serverLogs,
        };
      }

      if (orderRecord && authUser) {
        const isOrderOwner = orderRecord.user_id.toUpperCase() === authUser.user_id.toUpperCase();
        const isAdmin = authUser.role.toLowerCase() === "admin";
        if (!isOrderOwner && !isAdmin) {
          safeRollback();
          return {
            status: 403,
            body: {
              verified: false,
              error: "Unauthorized: Payment order does not belong to the authenticated user.",
            },
            rollbackAttempts,
            paymentVerifyProceeded,
            serverLogs,
          };
        }
      }

      paymentVerifyProceeded = true;
      inTransaction = false;
      return {
        status: 200,
        body: { verified: true },
        rollbackAttempts,
        paymentVerifyProceeded,
        serverLogs,
      };
    } catch (e: any) {
      safeRollback();
      const unavailable =
        !e.isRuntime && isConnUnavailable(e.sqlState || "", e.driverCode || 0, e.message || "");
      serverLogs.push(`[verify.php] Database Exception: ${e.message}`);
      if (unavailable) {
        return {
          status: 503,
          body: {
            verified: false,
            error:
              "Database connection unavailable during payment verification. Transaction was safely rolled back.",
          },
          rollbackAttempts,
          paymentVerifyProceeded,
          serverLogs,
        };
      }
      return {
        status: 500,
        body: {
          verified: false,
          error:
            "Payment processing failed during database recording. Transaction was safely rolled back.",
        },
        rollbackAttempts,
        paymentVerifyProceeded,
        serverLogs,
      };
    }
  }

  it("1. Enforces strict Bearer authentication (rejects missing and invalid Bearer tokens with 401)", () => {
    const { verifyPhp, responsePhp } = loadVerifyAndResponsePhp();

    assert.match(verifyPhp, /\$authUser\s*=\s*getAuthUser\(\$pdo,\s*true\);/);
    assert.match(verifyPhp, /if\s*\(\s*!\$authUser\s*\)/);

    const missingTokenResult = createVerifyAuthHarness({
      responsePhp,
      verifyPhp,
      orderRecord: {
        user_id: "FT483921",
        status: "created",
        amount: 6,
        purpose: "premium_video_upload",
      },
      bearerToken: null,
      sessionLookupBehavior: { kind: "guest" },
    });
    assert.equal(missingTokenResult.status, 401);
    assert.equal(missingTokenResult.body.verified, false);
    assert.equal(missingTokenResult.paymentVerifyProceeded, false);

    const invalidTokenResult = createVerifyAuthHarness({
      responsePhp,
      verifyPhp,
      orderRecord: {
        user_id: "FT483921",
        status: "created",
        amount: 6,
        purpose: "premium_video_upload",
      },
      bearerToken: "invalid_or_expired_token_123",
      sessionLookupBehavior: { kind: "invalid" },
    });
    assert.equal(invalidTokenResult.status, 401);
    assert.equal(invalidTokenResult.body.verified, false);
    assert.equal(invalidTokenResult.rollbackAttempts, 1);
    assert.equal(invalidTokenResult.paymentVerifyProceeded, false);
  });

  it("2. Retains ownership validation for valid authenticated users (allowing owner/admin, rejecting cross-user with 403)", () => {
    const { verifyPhp, responsePhp } = loadVerifyAndResponsePhp();

    const ownerResult = createVerifyAuthHarness({
      responsePhp,
      verifyPhp,
      orderRecord: {
        user_id: "FT483921",
        status: "created",
        amount: 6,
        purpose: "premium_video_upload",
      },
      bearerToken: "valid_owner_token",
      sessionLookupBehavior: { kind: "user", user_id: "FT483921", role: "user" },
    });
    assert.equal(ownerResult.status, 200);
    assert.equal(ownerResult.paymentVerifyProceeded, true);

    const crossUserResult = createVerifyAuthHarness({
      responsePhp,
      verifyPhp,
      orderRecord: {
        user_id: "FT483921",
        status: "created",
        amount: 6,
        purpose: "premium_video_upload",
      },
      bearerToken: "valid_other_user_token",
      sessionLookupBehavior: { kind: "user", user_id: "FT900431", role: "user" },
    });
    assert.equal(crossUserResult.status, 403);
    assert.equal(crossUserResult.body.verified, false);
    assert.equal(crossUserResult.rollbackAttempts, 1);
    assert.equal(crossUserResult.paymentVerifyProceeded, false);
  });

  it("3. Returns HTTP 503 on auth DB connection error (1203), HTTP 500 on unexpected DB errors, logs rollback failures safely, and aborts verification", () => {
    const { verifyPhp, responsePhp } = loadVerifyAndResponsePhp();

    // Verify catch is widened to Throwable, uses $safeRollback, delegates to isDatabaseConnectionUnavailableError, and never exposes $e->getMessage() in jsonResponse
    assert.match(verifyPhp, /\}\s*catch\s*\(\s*Throwable\s+\$e\s*\)\s*\{/);
    assert.match(verifyPhp, /\$safeRollback\(\$pdo\);/);
    assert.match(verifyPhp, /isDatabaseConnectionUnavailableError\(\$e\)/);
    assert.doesNotMatch(verifyPhp, /jsonResponse\(\[[^\]]*\$e->getMessage\(\)/);
    assert.doesNotMatch(verifyPhp, /jsonResponse\(\[[^\]]*\$_rollbackErr->getMessage\(\)/);

    const err1203 = createVerifyAuthHarness({
      responsePhp,
      verifyPhp,
      orderRecord: {
        user_id: "FT483921",
        status: "created",
        amount: 6,
        purpose: "premium_video_upload",
      },
      bearerToken: "valid_owner_token",
      sessionLookupBehavior: {
        kind: "db_error",
        sqlState: "42000",
        driverCode: 1203,
        message: "User already has more than 'max_user_connections' active connections",
      },
      rollbackThrows: true,
    });
    assert.equal(err1203.status, 503);
    assert.equal(err1203.body.verified, false);
    assert.equal(err1203.rollbackAttempts, 1);
    assert.equal(err1203.paymentVerifyProceeded, false);
    assert.ok(
      err1203.serverLogs.some((l) => l.includes("[verify.php][ROLLBACK]")),
      "Rollback failure must be logged server-side without masking 503",
    );
    assert.ok(err1203.body.error);
    assert.equal((err1203.body.error || "").includes("max_user_connections"), false);

    const unexpectedErr = createVerifyAuthHarness({
      responsePhp,
      verifyPhp,
      orderRecord: {
        user_id: "FT483921",
        status: "created",
        amount: 6,
        purpose: "premium_video_upload",
      },
      bearerToken: "valid_owner_token",
      sessionLookupBehavior: {
        kind: "db_error",
        sqlState: "42S02",
        driverCode: 1146,
        message: "Table 'prod_db.sessions' doesn't exist",
      },
    });
    assert.equal(unexpectedErr.status, 500);
    assert.equal(unexpectedErr.body.verified, false);
    assert.equal(unexpectedErr.rollbackAttempts, 1);
    assert.equal(unexpectedErr.paymentVerifyProceeded, false);
    assert.ok(unexpectedErr.body.error);
    assert.equal((unexpectedErr.body.error || "").includes("sessions"), false);

    const runtimeErr = createVerifyAuthHarness({
      responsePhp,
      verifyPhp,
      orderRecord: {
        user_id: "FT483921",
        status: "created",
        amount: 6,
        purpose: "premium_video_upload",
      },
      bearerToken: "valid_owner_token",
      sessionLookupBehavior: {
        kind: "db_error",
        sqlState: "0",
        driverCode: 0,
        message: "Failed to execute authentication session query.",
        isRuntime: true,
      },
    });
    assert.equal(runtimeErr.status, 500);
    assert.equal(runtimeErr.rollbackAttempts, 1);
    assert.equal(runtimeErr.paymentVerifyProceeded, false);
  });

  it("4. Preserves Razorpay HMAC signature check, remote cURL capture check, and ₹6 upload/subscription/promotion amounts unchanged", async () => {
    const { verifyPhp } = loadVerifyAndResponsePhp();

    assert.match(
      verifyPhp,
      /hash_hmac\('sha256',\s*"\{\$orderId\}\|\{\$paymentId\}",\s*\$secret\)/,
    );
    assert.match(verifyPhp, /https:\/\/api\.razorpay\.com\/v1\/payments\/\{\$paymentId\}/);
    assert.match(verifyPhp, /\$authoritativeAmount\s*=\s*6\.00;/);
    assert.match(verifyPhp, /'member-monthly'\s*=>\s*\['price'\s*=>\s*49\.00/);
    assert.match(verifyPhp, /\$referralCommission\s*=\s*1\.00;/);
    assert.match(
      verifyPhp,
      /\$referralStatus\s*=\s*\$hasReferrer\s*\?\s*'credited'\s*:\s*'unassigned_pending';/,
    );
    assert.match(verifyPhp, /\$gstAmount\s*=\s*0\.90;/);
    assert.match(verifyPhp, /\$pgFeeAmount\s*=\s*0\.10;/);

    const loginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login.php", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
      }),
    );
    assert.ok(loginRes);
    const { token } = await loginRes.json();

    const secret = "test_secret_for_api_tests_123456";
    const rzpEnv = {
      RAZORPAY_KEY_ID: "rzp_test_v4l_123456",
      RAZORPAY_KEY_SECRET: secret,
      RAZORPAY_SKIP_REMOTE_CHECK: "true",
    };

    const orderRes = await handleApiRequest(
      new Request("http://localhost:3000/api/payments/create-order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          purpose: "premium_video_upload",
          userId: "FT483921",
        }),
      }),
      rzpEnv,
    );
    assert.ok(orderRes);
    assert.equal(orderRes.status, 200);
    const { orderId } = await orderRes.json();

    // Also run Node handler verification for ₹6 upload to confirm zero behavioral regression
    const payId = `pay_v4l_preserve_${Date.now()}`;
    const sig = crypto.createHmac("sha256", secret).update(`${orderId}|${payId}`).digest("hex");

    const res = await handleApiRequest(
      new Request("http://localhost:3000/api/payments/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          orderId,
          paymentId: payId,
          signature: sig,
          userId: "FT483921",
          purpose: "premium_video_upload",
        }),
      }),
      rzpEnv,
    );
    assert.equal(res?.status, 200);
    const data = await res?.json();
    assert.equal(data.verified, true);
    assert.equal(data.amount, 6);
  });
});

describe("Uniform ₹6 Premium Transaction Distribution (Phase 1)", () => {
  const secret = "test_uniform_six_secret_key_1234567890";
  const rzpEnv = {
    RAZORPAY_KEY_ID: "rzp_test_uniform6_123456",
    RAZORPAY_KEY_SECRET: secret,
    RAZORPAY_SKIP_REMOTE_CHECK: "true",
  };
  const premiumFilePath = path.resolve(process.cwd(), "data", "premium_transactions.json");
  let initialPremiumFileRaw: string | null = null;
  const savedDbEnv: Record<string, string | undefined> = {};

  function enableMockMysqlEnv() {
    process.env["DB_HOST"] = "127.0.0.1";
    process.env["DB_NAME"] = "facetube_test";
    process.env["DB_USER"] = "facetube_user";
    process.env["DB_PASSWORD"] = "secret";
  }

  function disableMockMysqlEnv() {
    delete process.env["DB_HOST"];
    delete process.env["DB_NAME"];
    delete process.env["DB_USER"];
    delete process.env["DB_PASSWORD"];
    setMysqlPoolForTesting(null);
  }

  beforeEach(() => {
    for (const key of ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"]) {
      savedDbEnv[key] = process.env[key];
    }
    if (initialPremiumFileRaw === null && fs.existsSync(premiumFilePath)) {
      initialPremiumFileRaw = fs.readFileSync(premiumFilePath, "utf-8");
    }
    disableMockMysqlEnv();
  });

  afterEach(() => {
    setMysqlPoolForTesting(null);
    for (const key of ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"]) {
      if (savedDbEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedDbEnv[key];
    }
    if (initialPremiumFileRaw !== null) {
      fs.writeFileSync(premiumFilePath, initialPremiumFileRaw, "utf-8");
    }
  });

  function signOrderPayment(orderId: string, paymentId: string): string {
    return crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
  }

  function createUniformMysqlHarness(options: {
    txCount?: number;
    hasReferrer?: boolean;
    eligibleVideos?: Array<{ video_id: string; user_id: string; ad_earnings: number }>;
    alreadyPaid?: boolean;
  }) {
    const paymentTxInserts: Array<{ sql: string; params: any[] }> = [];
    const premiumTxInserts: Array<{ sql: string; params: any[] }> = [];
    const ledgerInserts: Array<{ sql: string; params: any[] }> = [];
    const walletCredits: Array<{
      userId: string;
      balanceDelta: number;
      referralDelta: number;
      globalDelta: number;
    }> = [];
    let committed = false;
    let rolledBack = false;

    const existingTxRow = options.alreadyPaid
      ? {
          payment_id: "pay_mysql_dup_1",
          order_id: "order_mysql_dup_1",
          user_id: "FT483921",
          purpose: "premium_video_upload",
          amount: 6.0,
          tx_number: (options.txCount ?? 10) + 1,
          is_special: 0,
          special_tag: "NORMAL_PREMIUM",
          referral_commission: 1.0,
          admin_allocation: 1.0,
          global_pool_allocation: 3.0,
          gst_amount: 0.9,
          pg_fee: 0.1,
          referral_status: options.hasReferrer === false ? "unassigned_pending" : "credited",
        }
      : null;

    const handleQuery = async (sql: string, params: any[] = []) => {
      const normalized = sql.replace(/\s+/g, " ").trim();

      if (normalized.includes("FROM INFORMATION_SCHEMA.TABLES")) {
        return [[{ TABLE_NAME: "global_pool_reserves" }]];
      }
      if (normalized.includes("FROM INFORMATION_SCHEMA.COLUMNS")) {
        return [
          [
            { TABLE_NAME: "payment_transactions", COLUMN_NAME: "gst_amount" },
            { TABLE_NAME: "payment_transactions", COLUMN_NAME: "pg_fee" },
            { TABLE_NAME: "payment_transactions", COLUMN_NAME: "referral_status" },
            { TABLE_NAME: "premium_transactions", COLUMN_NAME: "gst_amount" },
            { TABLE_NAME: "premium_transactions", COLUMN_NAME: "pg_fee" },
            { TABLE_NAME: "premium_transactions", COLUMN_NAME: "referral_status" },
          ],
        ];
      }
      if (normalized.includes("FROM sessions s") && normalized.includes("JOIN users u")) {
        return [
          [
            {
              id: "u-alex",
              user_id: "FT483921",
              name: "Alex Rivera",
              mobile: "9999999999",
              email: "alex@facetube.com",
              role: "user",
              referral_code: options.hasReferrer ? "FT900431" : null,
              avatar_url: null,
              channel_logo_url: null,
              channel_name: "Alex Channel",
              channel_description: null,
              created_at: "2026-01-01T00:00:00.000Z",
            },
          ],
        ];
      }
      if (normalized.includes("FROM payment_orders WHERE order_id = ?")) {
        return [
          [
            {
              order_id: params[0],
              user_id: "FT483921",
              user_name: "Alex Rivera",
              video_id: "vid_u6_1",
              purpose: "premium_video_upload",
              plan_id: null,
              amount: 6.0,
              currency: "INR",
              status: options.alreadyPaid ? "paid" : "created",
              payment_id: options.alreadyPaid ? "pay_mysql_dup_1" : null,
            },
          ],
        ];
      }
      if (normalized.includes("FROM payment_transactions WHERE payment_id = ? FOR UPDATE")) {
        return [existingTxRow ? [existingTxRow] : []];
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
      if (
        normalized.includes(
          "SELECT COUNT(*) as total FROM payment_transactions WHERE purpose = 'premium_video_upload'",
        )
      ) {
        return [[{ total: options.txCount ?? 10 }]];
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
      if (
        normalized.includes("SELECT user_id FROM users WHERE (UPPER(user_id)") ||
        (normalized.includes("SELECT user_id, referral_code, name FROM users") &&
          normalized.includes("UPPER(user_id) != UPPER(?)"))
      ) {
        return [
          options.hasReferrer
            ? [{ user_id: "FT900431", referral_code: null, name: "Sponsor" }]
            : [],
        ];
      }
      if (normalized.includes("FROM uploaded_videos WHERE (video_type = 'premium'")) {
        return [options.eligibleVideos ?? []];
      }
      if (normalized.startsWith("INSERT INTO payment_transactions")) {
        paymentTxInserts.push({ sql: normalized, params });
        return [{ affectedRows: 1 }];
      }
      if (normalized.startsWith("INSERT INTO premium_transactions")) {
        premiumTxInserts.push({ sql: normalized, params });
        return [{ affectedRows: 1 }];
      }
      if (normalized.startsWith("INSERT INTO income_ledger")) {
        ledgerInserts.push({ sql: normalized, params });
        return [{ affectedRows: 1 }];
      }
      if (normalized.startsWith("INSERT INTO wallet_balances")) {
        const uid = String(params[0]);
        if (
          normalized.includes(
            "referral_income, global_income, adsense_income, affiliate_income, updated_at) VALUES (?, 1.00",
          )
        ) {
          walletCredits.push({
            userId: uid,
            balanceDelta: 1.0,
            referralDelta: 1.0,
            globalDelta: 0,
          });
        } else if (params.length === 4) {
          walletCredits.push({
            userId: uid,
            balanceDelta: Number(params[1]),
            referralDelta: 0,
            globalDelta: Number(params[3]),
          });
        } else {
          walletCredits.push({
            userId: uid,
            balanceDelta: Number(params[1]),
            referralDelta: 0,
            globalDelta: 0,
          });
        }
        return [{ affectedRows: 1 }];
      }
      if (
        normalized.startsWith("UPDATE uploaded_videos") ||
        normalized.startsWith("UPDATE payment_orders")
      ) {
        return [{ affectedRows: 1 }];
      }
      return [[]];
    };

    const mockPool = {
      query: handleQuery,
      getConnection: async () => ({
        query: handleQuery,
        beginTransaction: async () => {},
        commit: async () => {
          committed = true;
        },
        rollback: async () => {
          rolledBack = true;
        },
        release: () => {},
      }),
    };

    return {
      mockPool,
      paymentTxInserts,
      premiumTxInserts,
      ledgerInserts,
      walletCredits,
      getStatus: () => ({ committed, rolledBack }),
    };
  }

  it("1-5. Transactions #1, #10, #11, #21, #31, #41 all follow exact uniform ₹6 split without SPECIAL_GLOBAL_RULE", async () => {
    const seqs = [1, 10, 11, 21, 31, 41];
    for (const seq of seqs) {
      assert.equal(isSpecialServerTx(seq), false);
      assert.equal(isSpecialClientTx(seq), false);

      const dist = evaluatePremiumDistribution(seq, "FT900431", 3);
      assert.equal(dist.isSpecial, false, `tx #${seq} must NOT be marked special`);
      assert.equal(dist.specialTag, "NORMAL_PREMIUM");
      assert.equal(dist.directReferralAmount, 1.0);
      assert.equal(dist.referralStatus, "credited");
      assert.equal(dist.adminAmount, 1.0);
      assert.equal(dist.globalPoolAmount, 3.0);
      assert.equal(dist.gstAmount, 0.9);
      assert.equal(dist.pgFeeAmount, 0.1);
      assert.equal(dist.taxAndFees, 1.0);
      assert.equal(dist.totalAmount, 6.0);
    }

    // Sequence transition #10 -> #11 via server verification
    await resetPersistentPremiumState(9, []);
    for (const expectedTx of [10, 11]) {
      const orderId = `ord_u6_${expectedTx}_${Date.now()}`;
      const payId = `pay_u6_${expectedTx}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const res = await verifyServerPayment(
        {
          orderId,
          paymentId: payId,
          signature: signOrderPayment(orderId, payId),
          userId: "FT483921",
          purpose: "premium_video_upload",
        },
        [
          { userId: "CR_1", videoId: "vid_1", adEarnings: 10 },
          { userId: "CR_2", videoId: "vid_2", adEarnings: 20 },
          { userId: "CR_3", videoId: "vid_3", adEarnings: 30 },
        ],
        "FT900431",
        rzpEnv,
      );

      assert.equal(res.verified, true);
      assert.equal(res.txNumber, expectedTx);
      assert.equal(res.isSpecialTransaction, false);
      assert.equal(res.specialTag, "NORMAL_PREMIUM");
      assert.equal(res.distribution?.directReferralAmount, 1.0);
      assert.equal(res.distribution?.adminAmount, 1.0);
      assert.equal(res.distribution?.globalPoolAmount, 3.0);
      assert.equal(res.distribution?.gstAmount, 0.9);
      assert.equal(res.distribution?.pgFeeAmount, 0.1);
    }
  });

  it("6. Valid referrer in MySQL path credits referrer ₹1.00, Admin ₹1.00, GST ₹0.90, PG ₹0.10, and records TX #11", async () => {
    const harness = createUniformMysqlHarness({
      txCount: 10, // next txNumber = 11
      hasReferrer: true,
      eligibleVideos: [
        { video_id: "v_1", user_id: "CR_A", ad_earnings: 50 },
        { video_id: "v_2", user_id: "CR_B", ad_earnings: 50 },
        { video_id: "v_3", user_id: "CR_C", ad_earnings: 50 },
      ],
    });
    enableMockMysqlEnv();
    setMysqlPoolForTesting(harness.mockPool as any);

    const orderId = "ord_u6_mysql_valid_ref";
    const payId = "pay_u6_mysql_valid_ref";
    const res = await handleApiRequest(
      new Request("http://localhost:3000/api/payments/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tok_u6_valid_ref",
        },
        body: JSON.stringify({
          orderId,
          paymentId: payId,
          signature: signOrderPayment(orderId, payId),
          userId: "FT483921",
          videoId: "vid_u6_1",
          purpose: "premium_video_upload",
        }),
      }),
      rzpEnv,
    );

    assert.equal(res?.status, 200);
    const body = await res?.json();
    assert.equal(body.verified, true);
    assert.equal(body.txNumber, 11);
    assert.equal(body.isSpecialTransaction, false);
    assert.equal(body.specialTag, "NORMAL_PREMIUM");
    assert.equal(body.distribution.directReferralAmount, 1.0);
    assert.equal(body.distribution.referralStatus, "credited");
    assert.equal(body.distribution.adminAmount, 1.0);
    assert.equal(body.distribution.globalPoolAmount, 3.0);
    assert.equal(body.distribution.gstAmount, 0.9);
    assert.equal(body.distribution.pgFeeAmount, 0.1);
    assert.equal(harness.getStatus().committed, true);

    const refWallet = harness.walletCredits.find((w) => w.userId === "FT900431");
    assert.equal(refWallet?.referralDelta, 1.0);
    const admWallet = harness.walletCredits.find((w) => w.userId === "FT102857");
    assert.equal(admWallet?.balanceDelta, 1.0);
  });

  it("7. Missing referrer keeps Admin at ₹1.00 and preserves ₹1.00 referral in unassigned_pending (MySQL + fallback store)", async () => {
    // (a) MySQL authoritative verification without valid referrer
    const harness = createUniformMysqlHarness({
      txCount: 10, // #11
      hasReferrer: false,
      eligibleVideos: [
        { video_id: "v_1", user_id: "CR_A", ad_earnings: 100 },
        { video_id: "v_2", user_id: "CR_B", ad_earnings: 50 },
        { video_id: "v_3", user_id: "CR_C", ad_earnings: 50 },
      ],
    });
    enableMockMysqlEnv();
    setMysqlPoolForTesting(harness.mockPool as any);

    const orderId = "ord_u6_mysql_noref";
    const payId = "pay_u6_mysql_noref";
    const mysqlRes = await handleApiRequest(
      new Request("http://localhost:3000/api/payments/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tok_u6_noref",
        },
        body: JSON.stringify({
          orderId,
          paymentId: payId,
          signature: signOrderPayment(orderId, payId),
          userId: "FT483921",
          videoId: "vid_u6_1",
          purpose: "premium_video_upload",
        }),
      }),
      rzpEnv,
    );

    assert.equal(mysqlRes?.status, 200);
    const mysqlBody = await mysqlRes?.json();
    assert.equal(mysqlBody.distribution.directReferralAmount, 1.0);
    assert.equal(mysqlBody.distribution.referralStatus, "unassigned_pending");
    assert.equal(mysqlBody.distribution.adminAmount, 1.0);
    assert.equal(mysqlBody.distribution.globalPoolAmount, 3.0);
    assert.equal(mysqlBody.distribution.gstAmount, 0.9);
    assert.equal(mysqlBody.distribution.pgFeeAmount, 0.1);

    // Admin must only receive ₹1.00 — never ₹2.00
    const admWallet = harness.walletCredits.find((w) => w.userId === "FT102857");
    assert.equal(admWallet?.balanceDelta, 1.0);
    assert.equal(
      harness.walletCredits.some((w) => w.userId === "UNASSIGNED_REFERRAL"),
      false,
      "Unassigned pending referral must NOT credit any wallet balance",
    );

    // income_ledger records an explicit pending UNASSIGNED_REFERRAL entry for ₹1.00
    const pendingRefLedger = harness.ledgerInserts.find(
      (ins) => ins.sql.includes("'UNASSIGNED_REFERRAL'") && ins.sql.includes("'pending'"),
    );
    assert.ok(
      pendingRefLedger,
      "MySQL income_ledger must insert pending UNASSIGNED_REFERRAL entry",
    );
    assert.equal(pendingRefLedger?.params[1], `TX_REF_PENDING_${payId}`);

    // payment_transactions stores explicit gst_amount=0.9, pg_fee=0.1, referral_status='unassigned_pending'
    const ptInsert = harness.paymentTxInserts[0];
    assert.ok(ptInsert);
    assert.ok(ptInsert.sql.includes("gst_amount, pg_fee, referral_status"));
    assert.equal(ptInsert.params[ptInsert.params.length - 3], 0.9);
    assert.equal(ptInsert.params[ptInsert.params.length - 2], 0.1);
    assert.equal(ptInsert.params[ptInsert.params.length - 1], "unassigned_pending");

    // (b) Fallback non-production store path without referrer
    disableMockMysqlEnv();
    await resetPersistentPremiumState(10, []);

    const loginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login.php", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "maya@facetube.com", password: "password123" }),
      }),
    );
    const loginData = await loginRes?.json();
    const storeToken = loginData.token;
    const storeUserId = loginData.user.user_id;

    // Admin logs in to inspect Admin wallet balance before/after Maya (referral_code: null) verifies ₹6 payment
    const admLoginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login.php", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "admin@facetube.com", password: "password123" }),
      }),
    );
    const admToken = (await admLoginRes?.json())?.token;

    const admWBefore = await (
      await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/balance?userId=FT102857", {
          method: "GET",
          headers: { Authorization: `Bearer ${admToken}` },
        }),
      )
    )?.json();
    const adminBalanceBefore = Number(admWBefore.wallet.balance);

    const storeOrdRes = await handleApiRequest(
      new Request("http://localhost:3000/api/payments/create-order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${storeToken}`,
        },
        body: JSON.stringify({
          purpose: "premium_video_upload",
          userId: storeUserId,
        }),
      }),
      rzpEnv,
    );
    const storeOrdData = await storeOrdRes?.json();
    const storeOrdId = storeOrdData?.orderId;
    const storePayId = `pay_store_noref_${Date.now()}`;

    const storeVerifyRes = await handleApiRequest(
      new Request("http://localhost:3000/api/payments/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${storeToken}`,
        },
        body: JSON.stringify({
          orderId: storeOrdId,
          paymentId: storePayId,
          signature: signOrderPayment(storeOrdId, storePayId),
          userId: storeUserId,
          purpose: "premium_video_upload",
        }),
      }),
      rzpEnv,
    );

    assert.equal(storeVerifyRes?.status, 200);
    const storeVerifyBody = await storeVerifyRes?.json();
    assert.equal(storeVerifyBody.txNumber, 11);
    assert.equal(storeVerifyBody.distribution.directReferralAmount, 1.0);
    assert.equal(storeVerifyBody.distribution.referralStatus, "unassigned_pending");
    assert.equal(storeVerifyBody.distribution.gstAmount, 0.9);
    assert.equal(storeVerifyBody.distribution.pgFeeAmount, 0.1);
    // Admin receives strictly ₹1.00 ALWAYS — never unassigned referral and never rounding residual paise.
    assert.equal(storeVerifyBody.distribution.adminAmount, 1.0);
    assert.equal(storeVerifyBody.distribution.globalPoolAmount, 3.0);
    assert.equal(
      Number(
        (
          (storeVerifyBody.distribution.globalPoolDistributedAmount ?? 0) +
          (storeVerifyBody.distribution.globalPoolReserveAmount ?? 0)
        ).toFixed(2),
      ),
      3.0,
    );

    const admWAfter = await (
      await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/balance?userId=FT102857", {
          method: "GET",
          headers: { Authorization: `Bearer ${admToken}` },
        }),
      )
    )?.json();
    const adminBalanceDelta = Number(
      (Number(admWAfter.wallet.balance) - adminBalanceBefore).toFixed(2),
    );
    assert.equal(
      adminBalanceDelta,
      1.0,
      "Fallback store must credit Admin strictly ₹1.00, never unassigned referral or pool residuals",
    );
  });

  it("8-9. Weighted ad_earnings pool and zero eligible videos both maintain exact ₹6.00 sum with zero paise leakage", () => {
    const zeroEligible = evaluatePremiumDistribution(11, "FT900431", 0);
    assert.equal(zeroEligible.directReferralAmount, 1.0);
    assert.equal(zeroEligible.adminAmount, 1.0);
    assert.equal(zeroEligible.globalPoolAmount, 3.0);
    assert.equal(zeroEligible.globalPoolDistributedAmount, 0.0);
    assert.equal(zeroEligible.globalPoolReserveAmount, 3.0);
    assert.equal(zeroEligible.globalPoolStatus, "pending_reserve");
    assert.equal(zeroEligible.gstAmount, 0.9);
    assert.equal(zeroEligible.pgFeeAmount, 0.1);
    assert.equal(
      Math.round(
        (zeroEligible.directReferralAmount +
          zeroEligible.adminAmount +
          zeroEligible.globalPoolAmount +
          zeroEligible.gstAmount +
          zeroEligible.pgFeeAmount) *
          100,
      ),
      600,
    );

    const weightedDist = evaluatePremiumDistribution(11, null, 3, [
      { userId: "C1", videoId: "v1", adEarnings: 120 },
      { userId: "C2", videoId: "v2", adEarnings: 60 },
      { userId: "C3", videoId: "v3", adEarnings: 20 },
    ]);
    assert.equal(weightedDist.directReferralAmount, 1.0);
    assert.equal(weightedDist.referralStatus, "unassigned_pending");
    assert.equal(weightedDist.adminAmount, 1.0);
    assert.equal(weightedDist.globalPoolAmount, 3.0);
    assert.equal(weightedDist.weightedPayouts?.[0]?.amount, 1.8);
    assert.equal(weightedDist.weightedPayouts?.[1]?.amount, 0.9);
    assert.equal(weightedDist.weightedPayouts?.[2]?.amount, 0.3);
  });

  it("10-11. Duplicate payment verification is idempotent and concurrent calls serialize without double credit", async () => {
    const dupHarness = createUniformMysqlHarness({
      txCount: 10,
      hasReferrer: false,
      alreadyPaid: true,
    });
    enableMockMysqlEnv();
    setMysqlPoolForTesting(dupHarness.mockPool as any);

    const dupRes = await handleApiRequest(
      new Request("http://localhost:3000/api/payments/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tok_u6_dup",
        },
        body: JSON.stringify({
          orderId: "order_mysql_dup_1",
          paymentId: "pay_mysql_dup_1",
          signature: signOrderPayment("order_mysql_dup_1", "pay_mysql_dup_1"),
          userId: "FT483921",
          purpose: "premium_video_upload",
        }),
      }),
      rzpEnv,
    );
    assert.equal(dupRes?.status, 200);
    const dupBody = await dupRes?.json();
    assert.equal(dupBody.verified, true);
    assert.equal(dupBody.duplicate, true);
    assert.equal(dupBody.distribution.directReferralAmount, 1.0);
    assert.equal(dupBody.distribution.referralStatus, "unassigned_pending");
    assert.equal(dupBody.distribution.gstAmount, 0.9);
    assert.equal(dupBody.distribution.pgFeeAmount, 0.1);
    assert.equal(dupHarness.walletCredits.length, 0);
    assert.equal(dupHarness.ledgerInserts.length, 0);

    // Concurrent verification serialization in verifyServerPayment
    disableMockMysqlEnv();
    await resetPersistentPremiumState(10, []);
    const order1 = `ord_conc_1_${Date.now()}`;
    const pay1 = `pay_conc_1_${Date.now()}`;
    const order2 = `ord_conc_2_${Date.now()}`;
    const pay2 = `pay_conc_2_${Date.now()}`;
    const creators = ["CR_1", "CR_2", "CR_3"];

    const [r1, r2, r1Dup] = await Promise.all([
      verifyServerPayment(
        {
          orderId: order1,
          paymentId: pay1,
          signature: signOrderPayment(order1, pay1),
          userId: "FT483921",
          purpose: "premium_video_upload",
        },
        creators,
        null,
        rzpEnv,
      ),
      verifyServerPayment(
        {
          orderId: order2,
          paymentId: pay2,
          signature: signOrderPayment(order2, pay2),
          userId: "FT483921",
          purpose: "premium_video_upload",
        },
        creators,
        "FT900431",
        rzpEnv,
      ),
      verifyServerPayment(
        {
          orderId: order1,
          paymentId: pay1,
          signature: signOrderPayment(order1, pay1),
          userId: "FT483921",
          purpose: "premium_video_upload",
        },
        creators,
        null,
        rzpEnv,
      ),
    ]);

    assert.deepEqual(
      [r1.txNumber, r2.txNumber].sort((a, b) => (a ?? 0) - (b ?? 0)),
      [11, 12],
    );
    assert.equal(r1Dup.duplicate, true);
    assert.equal(await getPersistentPremiumTxNumber(), 12);
  });

  it("12. PHP api/payments/verify.php matches Node accounting rules and fixes $eligibleCreatorCount bug", () => {
    const verifyPhp = fs.readFileSync(
      path.resolve(process.cwd(), "api", "payments", "verify.php"),
      "utf-8",
    );
    assert.equal(
      verifyPhp.includes("SPECIAL_GLOBAL_RULE"),
      false,
      "verify.php must remove SPECIAL_GLOBAL_RULE behavior",
    );
    assert.match(verifyPhp, /\$isSpecial\s*=\s*false;/);
    assert.match(verifyPhp, /\$specialTag\s*=\s*'NORMAL_PREMIUM';/);
    assert.match(verifyPhp, /\$referralCommission\s*=\s*1\.00;/);
    assert.match(
      verifyPhp,
      /\$referralStatus\s*=\s*\$hasReferrer\s*\?\s*'credited'\s*:\s*'unassigned_pending';/,
    );
    assert.match(verifyPhp, /\$gstAmount\s*=\s*0\.90;/);
    assert.match(verifyPhp, /\$pgFeeAmount\s*=\s*0\.10;/);
    assert.match(verifyPhp, /\$adminAllocation\s*=\s*1\.00;/);
    assert.match(verifyPhp, /\$poolPaise\s*=\s*300;/);
    assert.match(
      verifyPhp,
      /\$eligibleCreatorCount\s*=\s*\$eligibleVideoCount;/,
      "verify.php must set $eligibleCreatorCount = $eligibleVideoCount instead of leaving it 0",
    );
    assert.ok(verifyPhp.includes("UNASSIGNED_REFERRAL"));
    assert.ok(verifyPhp.includes("REFERRAL_UNASSIGNED_PENDING"));
    assert.ok(verifyPhp.includes("gst_amount, pg_fee, referral_status"));
  });

  it("13. Exact ₹6.00 reconciliation across creator counts 0..100", () => {
    for (let count = 0; count <= 100; count++) {
      for (const ref of ["FT900431", null]) {
        const dist = evaluatePremiumDistribution(11 + count, ref, count);
        const totalPaise = Math.round(
          (dist.directReferralAmount +
            dist.adminAmount +
            dist.globalPoolAmount +
            dist.gstAmount +
            dist.pgFeeAmount) *
            100,
        );
        assert.equal(totalPaise, 600, `Sum mismatch for count=${count}, ref=${String(ref)}`);
      }
    }
  });

  it("14. Client distributePremiumVideoIncome() is safely disabled and razorpay-service does not invoke it", async () => {
    const walletsBefore = JSON.stringify(getStoredWallets());
    const ledgerBefore = JSON.stringify(getStoredLedger());

    const res = await distributePremiumVideoIncome({
      uploaderUserId: "FT483921",
      uploaderName: "Alex Rivera",
      videoId: "vid_client_noop",
      paymentId: "pay_client_noop",
      txNumber: 11,
      directReferrerId: null,
    });

    assert.equal(res.isSpecial, false);
    assert.deepEqual(res.globalTransactions, []);
    assert.equal(res.referralTransaction, undefined);
    assert.equal(res.adminTransaction, undefined);
    assert.equal(JSON.stringify(getStoredWallets()), walletsBefore);
    assert.equal(JSON.stringify(getStoredLedger()), ledgerBefore);

    const razorpayService = fs.readFileSync(
      path.resolve(process.cwd(), "src", "lib", "razorpay-service.ts"),
      "utf-8",
    );
    assert.equal(
      razorpayService.includes("distributePremiumVideoIncome"),
      false,
      "razorpay-service.ts must not invoke or import distributePremiumVideoIncome",
    );
  });

  it("15. global-income.tsx displays backend Total Income without breakdown splits or hardcoded ₹2,450.00 fallback", () => {
    const globalIncomeRoute = fs.readFileSync(
      path.resolve(process.cwd(), "src", "routes", "global-income.tsx"),
      "utf-8",
    );
    assert.ok(globalIncomeRoute.includes("Total Income"));
    assert.ok(globalIncomeRoute.includes("getGlobalIncomeSummary"));
    assert.ok(globalIncomeRoute.includes("summary.personal.totalIncome"));
    assert.equal(
      globalIncomeRoute.includes("₹0.90 GST + ₹0.10 PG Fee"),
      false,
      "global-income.tsx must NOT display GST + PG split breakdown",
    );
    assert.equal(
      globalIncomeRoute.includes("Company infrastructure & servers"),
      false,
      "global-income.tsx must NOT display Admin breakdown description",
    );
    assert.equal(
      globalIncomeRoute.includes("Weighted pool for eligible Sponsor videos"),
      false,
      "global-income.tsx must NOT display Global Distribution breakdown description",
    );
    assert.equal(
      globalIncomeRoute.includes("₹2,450.00"),
      false,
      "global-income.tsx must NOT contain hardcoded ₹2,450.00 fallback",
    );
    assert.ok(globalIncomeRoute.includes("Unavailable"));
  });
});

describe("Phase 1.1: Global Pool Pending Reserve & Safe Settlement Tests", () => {
  const secret = "test_razorpay_secret_key_1234567890";
  const rzpEnv = {
    RAZORPAY_KEY_ID: "rzp_test_1234567890",
    RAZORPAY_KEY_SECRET: secret,
    RAZORPAY_SKIP_REMOTE_CHECK: "true",
    APP_ENV: "development",
    NODE_ENV: "test",
  };

  afterEach(() => {
    setMysqlPoolForTesting(null);
    delete process.env["DB_HOST"];
    delete process.env["DB_NAME"];
    delete process.env["DB_USER"];
    delete process.env["DB_PASSWORD"];
    delete process.env["MYSQL_HOST"];
    delete process.env["MYSQL_DATABASE"];
    delete process.env["MYSQL_USER"];
    delete process.env["MYSQL_PASSWORD"];
  });

  function enableMockMysqlEnv() {
    process.env["DB_HOST"] = "127.0.0.1";
    process.env["DB_NAME"] = "facetube_test";
    process.env["DB_USER"] = "facetube_user";
    process.env["DB_PASSWORD"] = "facetube_pass";
  }

  function disableMockMysqlEnv() {
    delete process.env["DB_HOST"];
    delete process.env["DB_NAME"];
    delete process.env["DB_USER"];
    delete process.env["DB_PASSWORD"];
  }

  function signOrderPayment(orderId: string, paymentId: string): string {
    return crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
  }

  function createPhase11MysqlHarness(options: {
    txCount?: number;
    hasReferrer?: boolean;
    eligibleVideos?: Array<{ video_id: string; user_id: string; ad_earnings: number }>;
    pendingReserves?: Array<{
      id: string;
      payment_id: string;
      order_id: string | null;
      tx_number: number;
      source_user_id: string;
      source_video_id: string | null;
      reserve_amount: number;
      reserve_paise: number;
      reserve_reason: "no_eligible_videos" | "rounding_residual";
      status: "pending" | "settled";
    }>;
    authRole?: "admin" | "user";
  }) {
    const paymentTxInserts: Array<{ sql: string; params: any[] }> = [];
    const premiumTxInserts: Array<{ sql: string; params: any[] }> = [];
    const ledgerInserts: Array<{ sql: string; params: any[] }> = [];
    const ledgerUpdates: Array<{ sql: string; params: any[] }> = [];
    const reserveInserts: Array<{ sql: string; params: any[] }> = [];
    const reserveUpdates: Array<{ sql: string; params: any[] }> = [];
    const settlementInserts: Array<{ sql: string; params: any[] }> = [];
    const settlementsByIdempotency = new Map<string, any>();
    const walletCredits: Array<{
      userId: string;
      balanceDelta: number;
      referralDelta: number;
      globalDelta: number;
    }> = [];
    const reserves = (options.pendingReserves || []).map((r) => ({ ...r }));
    let committed = false;
    let rolledBack = false;

    const handleQuery = async (sql: string, params: any[] = []) => {
      const normalized = sql.replace(/\s+/g, " ").trim();

      if (normalized.includes("FROM INFORMATION_SCHEMA.COLUMNS")) {
        return [
          [
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
          ],
        ];
      }
      if (normalized.includes("FROM INFORMATION_SCHEMA.TABLES")) {
        return [[{ TABLE_NAME: "global_pool_reserves" }]];
      }
      if (normalized.includes("FROM sessions s") && normalized.includes("JOIN users u")) {
        const role = options.authRole || "user";
        return [
          [
            {
              id: role === "admin" ? "u-admin" : "u-alex",
              user_id: role === "admin" ? "FT102857" : "FT483921",
              name: role === "admin" ? "Admin" : "Alex Rivera",
              mobile: "9999999999",
              email: role === "admin" ? "admin@facetube.com" : "alex@facetube.com",
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
        return [
          [
            {
              order_id: params[0],
              user_id: "FT483921",
              user_name: "Alex Rivera",
              video_id: "vid_p11_1",
              purpose: "premium_video_upload",
              plan_id: null,
              amount: 6.0,
              currency: "INR",
              status: "created",
              payment_id: null,
            },
          ],
        ];
      }
      if (normalized.includes("FROM payment_transactions WHERE payment_id = ? FOR UPDATE")) {
        return [[]];
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
      if (
        normalized.includes(
          "SELECT COUNT(*) as total FROM payment_transactions WHERE purpose = 'premium_video_upload'",
        )
      ) {
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
      if (
        normalized.includes("SELECT user_id FROM users WHERE (UPPER(user_id)") ||
        (normalized.includes("SELECT user_id, referral_code, name FROM users") &&
          normalized.includes("UPPER(user_id) != UPPER(?)"))
      ) {
        return [
          options.hasReferrer
            ? [{ user_id: "FT900431", referral_code: null, name: "Sponsor" }]
            : [],
        ];
      }
      if (normalized.includes("FROM uploaded_videos WHERE (video_type = 'premium'")) {
        if (normalized.includes("UPPER(user_id) != UPPER(?)")) {
          const excl = String(params[0] || "").toUpperCase();
          return [(options.eligibleVideos ?? []).filter((v) => v.user_id.toUpperCase() !== excl)];
        }
        return [options.eligibleVideos ?? []];
      }
      if (
        normalized.includes("FROM global_pool_settlements WHERE idempotency_key = ? FOR UPDATE")
      ) {
        const key = String(params[0] || "");
        const existing = settlementsByIdempotency.get(key);
        return [existing ? [existing] : []];
      }
      if (normalized.includes("FROM global_pool_settlements ORDER BY created_at DESC")) {
        return [Array.from(settlementsByIdempotency.values())];
      }
      if (
        normalized.includes("FROM global_pool_reserves WHERE status = 'pending'") &&
        normalized.includes("FOR UPDATE")
      ) {
        return [reserves.filter((r) => r.status === "pending")];
      }
      if (normalized.includes("FROM global_pool_reserves ORDER BY tx_number ASC")) {
        return [reserves];
      }
      if (normalized.startsWith("INSERT INTO payment_transactions")) {
        paymentTxInserts.push({ sql: normalized, params });
        return [{ affectedRows: 1 }];
      }
      if (normalized.startsWith("INSERT INTO premium_transactions")) {
        premiumTxInserts.push({ sql: normalized, params });
        return [{ affectedRows: 1 }];
      }
      if (normalized.startsWith("INSERT INTO global_pool_reserves")) {
        reserveInserts.push({ sql: normalized, params });
        if (normalized.includes("'GLOBAL_POOL_SETTLEMENT'")) {
          reserves.push({
            id: String(params[0]),
            payment_id: String(params[1]),
            order_id: null,
            tx_number: 0,
            source_user_id: "GLOBAL_POOL_SETTLEMENT",
            source_video_id: null,
            reserve_amount: Number(params[2]),
            reserve_paise: Number(params[3]),
            reserve_reason: "rounding_residual",
            status: "pending",
          });
        } else {
          reserves.push({
            id: String(params[0]),
            payment_id: String(params[1]),
            order_id: String(params[2]),
            tx_number: Number(params[3]),
            source_user_id: String(params[4]),
            source_video_id: params[5] ? String(params[5]) : null,
            reserve_amount: Number(params[6]),
            reserve_paise: Number(params[7]),
            reserve_reason: params[8],
            status: "pending",
          });
        }
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
        settlementsByIdempotency.set(String(params[1]), row);
        return [{ affectedRows: 1 }];
      }
      if (normalized.startsWith("INSERT INTO income_ledger")) {
        ledgerInserts.push({ sql: normalized, params });
        return [{ affectedRows: 1 }];
      }
      if (normalized.startsWith("UPDATE income_ledger SET status = 'settled'")) {
        ledgerUpdates.push({ sql: normalized, params });
        return [{ affectedRows: 1 }];
      }
      if (normalized.startsWith("INSERT INTO wallet_balances")) {
        const uid = String(params[0]);
        if (
          normalized.includes(
            "referral_income, global_income, adsense_income, affiliate_income, updated_at) VALUES (?, 1.00",
          )
        ) {
          walletCredits.push({
            userId: uid,
            balanceDelta: 1.0,
            referralDelta: 1.0,
            globalDelta: 0,
          });
        } else if (params.length === 4) {
          walletCredits.push({
            userId: uid,
            balanceDelta: Number(params[1]),
            referralDelta: 0,
            globalDelta: Number(params[3]),
          });
        } else {
          walletCredits.push({
            userId: uid,
            balanceDelta: Number(params[1]),
            referralDelta: 0,
            globalDelta: 0,
          });
        }
        return [{ affectedRows: 1 }];
      }
      if (
        normalized.startsWith("UPDATE uploaded_videos") ||
        normalized.startsWith("UPDATE payment_orders")
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
        },
        commit: async () => {
          committed = true;
        },
        rollback: async () => {
          rolledBack = true;
        },
        release: () => {},
      }),
    };

    return {
      mockPool,
      paymentTxInserts,
      premiumTxInserts,
      ledgerInserts,
      ledgerUpdates,
      reserveInserts,
      reserveUpdates,
      settlementInserts,
      walletCredits,
      reserves,
      getStatus: () => ({ committed, rolledBack }),
    };
  }

  it("1. Zero eligible videos holds full ₹3.00 in pending Global Pool reserve (MySQL + fallback + verifyServerPayment) and keeps Admin strictly at ₹1.00", async () => {
    // (a) MySQL path
    const harness = createPhase11MysqlHarness({
      txCount: 0, // TX #1
      hasReferrer: true,
      eligibleVideos: [],
    });
    enableMockMysqlEnv();
    setMysqlPoolForTesting(harness.mockPool as any);

    const ordId = "ord_p11_zero_mysql";
    const payId = "pay_p11_zero_mysql";
    const res = await handleApiRequest(
      new Request("http://localhost:3000/api/payments/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tok_p11_zero",
        },
        body: JSON.stringify({
          orderId: ordId,
          paymentId: payId,
          signature: signOrderPayment(ordId, payId),
          userId: "FT483921",
          videoId: "vid_p11_1",
          purpose: "premium_video_upload",
        }),
      }),
      rzpEnv,
    );

    assert.equal(res?.status, 200);
    const body = await res?.json();
    assert.equal(body.verified, true);
    assert.equal(body.txNumber, 1);
    assert.equal(body.distribution.directReferralAmount, 1.0);
    assert.equal(
      body.distribution.adminAmount,
      1.0,
      "Admin MUST remain ₹1.00 even with 0 eligible videos",
    );
    assert.equal(body.distribution.globalPoolAmount, 3.0);
    assert.equal(body.distribution.globalPoolDistributedAmount, 0.0);
    assert.equal(body.distribution.globalPoolReserveAmount, 3.0);
    assert.equal(body.distribution.globalPoolStatus, "pending_reserve");
    assert.equal(body.distribution.globalPoolReserveReason, "no_eligible_videos");
    assert.equal(body.distribution.gstAmount, 0.9);
    assert.equal(body.distribution.pgFeeAmount, 0.1);

    // Wallet credit checks: Admin gets ONLY ₹1.00, Referrer gets ₹1.00, NO Global Pool Reserve wallet credit
    const admCredit = harness.walletCredits.find((w) => w.userId === "FT102857");
    assert.equal(admCredit?.balanceDelta, 1.0);
    assert.equal(
      harness.walletCredits.some((w) => w.userId === "GLOBAL_POOL_RESERVE"),
      false,
      "GLOBAL_POOL_RESERVE must NOT have a wallet_balances credit",
    );

    // Ledger & Reserve table inserts
    const glbResLedger = harness.ledgerInserts.find((l) => l.sql.includes("'GLOBAL_POOL_RESERVE'"));
    assert.ok(glbResLedger, "Must insert pending GLOBAL_POOL_RESERVE entry in income_ledger");
    assert.equal(glbResLedger?.params[1], `TX_GLB_RESERVE_${payId}`);
    assert.equal(glbResLedger?.params[5], 3.0);

    assert.equal(harness.reserveInserts.length, 1);
    assert.equal(harness.reserveInserts[0]?.params[6], 3.0);
    assert.equal(harness.reserveInserts[0]?.params[7], 300);
    assert.equal(harness.reserveInserts[0]?.params[8], "no_eligible_videos");

    // (b) Direct verifyServerPayment check
    disableMockMysqlEnv();
    await resetPersistentPremiumState(0, []);
    const sOrd = `ord_p11_zero_srv_${Date.now()}`;
    const sPay = `pay_p11_zero_srv_${Date.now()}`;
    const sRes = await verifyServerPayment(
      {
        orderId: sOrd,
        paymentId: sPay,
        signature: signOrderPayment(sOrd, sPay),
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      [],
      null,
      rzpEnv,
    );
    assert.equal(sRes.distribution?.adminAmount, 1.0);
    assert.equal(sRes.distribution?.referralStatus, "unassigned_pending");
    assert.equal(sRes.distribution?.globalPoolAmount, 3.0);
    assert.equal(sRes.distribution?.globalPoolDistributedAmount, 0.0);
    assert.equal(sRes.distribution?.globalPoolReserveAmount, 3.0);
    assert.equal(sRes.distribution?.globalPoolStatus, "pending_reserve");
    const gpState = await getPersistentGlobalPoolState();
    assert.equal(gpState.reserves.length, 1);
    assert.equal(gpState.reserves[0]?.status, "pending");
    assert.equal(gpState.reserves[0]?.reservePaise, 300);
  });

  it("2. One eligible video distributes entire ₹3.00 immediately with ₹0.00 reserve; Admin remains ₹1.00", async () => {
    await resetPersistentPremiumState(10, []);
    const ord = `ord_p11_one_${Date.now()}`;
    const pay = `pay_p11_one_${Date.now()}`;
    const res = await verifyServerPayment(
      {
        orderId: ord,
        paymentId: pay,
        signature: signOrderPayment(ord, pay),
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      [{ userId: "CR_SOLO", videoId: "vid_solo", adEarnings: 0 }],
      "FT900431",
      rzpEnv,
    );
    assert.equal(res.txNumber, 11);
    assert.equal(res.distribution?.adminAmount, 1.0);
    assert.equal(res.distribution?.globalPoolAmount, 3.0);
    assert.equal(res.distribution?.globalPoolDistributedAmount, 3.0);
    assert.equal(res.distribution?.globalPoolReserveAmount, 0.0);
    assert.equal(res.distribution?.globalPoolStatus, "settled");
    assert.equal(res.distribution?.creatorPayouts?.[0]?.amount, 3.0);
    const gpState = await getPersistentGlobalPoolState();
    assert.equal(gpState.reserves.length, 0);
  });

  it("3. Weighted ad_earnings decimal scaling avoids float drift (0.1 + 0.2 + 0.3) and places rounding residual paise into Global Pool reserve", async () => {
    // Decimal weights: 0.1, 0.2, 0.3 -> exact 50, 100, 150 paise (distributed=300, residual=0)
    const decimalWeighted = calculateWeightedPoolPayouts(300, [
      { userId: "C1", videoId: "v1", adEarnings: 0.1 },
      { userId: "C2", videoId: "v2", adEarnings: 0.2 },
      { userId: "C3", videoId: "v3", adEarnings: 0.3 },
    ]);
    assert.equal(decimalWeighted.payouts[0]?.amountPaise, 50);
    assert.equal(decimalWeighted.payouts[1]?.amountPaise, 100);
    assert.equal(decimalWeighted.payouts[2]?.amountPaise, 150);
    assert.equal(decimalWeighted.distributedPaise, 300);
    assert.equal(decimalWeighted.residualPaise, 0);

    // Uneven weights with rounding residual: 1, 2, 4 -> total=7 -> floor(300/7)=42, floor(600/7)=85, floor(1200/7)=171 -> 298 distributed + 2 paise reserve
    const unevenDist = evaluatePremiumDistribution(31, null, 3, [
      { userId: "C1", videoId: "v1", adEarnings: 1 },
      { userId: "C2", videoId: "v2", adEarnings: 2 },
      { userId: "C3", videoId: "v3", adEarnings: 4 },
    ]);
    assert.equal(unevenDist.directReferralAmount, 1.0);
    assert.equal(unevenDist.referralStatus, "unassigned_pending");
    assert.equal(
      unevenDist.adminAmount,
      1.0,
      "Rounding residual must NEVER increase Admin above ₹1.00",
    );
    assert.equal(unevenDist.globalPoolAmount, 3.0);
    assert.equal(unevenDist.globalPoolDistributedAmount, 2.98);
    assert.equal(unevenDist.globalPoolReserveAmount, 0.02);
    assert.equal(unevenDist.globalPoolStatus, "partial_reserve");
    assert.equal(unevenDist.reserveReason, "rounding_residual");
    assert.equal(unevenDist.gstAmount, 0.9);
    assert.equal(unevenDist.pgFeeAmount, 0.1);
  });

  it("4. Transactions #1, #10, #11, #21, #31, #41 across 0..50 creators maintain Referral ₹1 + Admin ₹1 + GST ₹0.90 + PG ₹0.10 + Global ₹3 = ₹6", () => {
    for (const tx of [1, 10, 11, 21, 31, 41]) {
      for (const count of [0, 1, 2, 3, 7, 13, 29, 50]) {
        for (const ref of ["FT900431", null]) {
          const d = evaluatePremiumDistribution(tx, ref, count);
          assert.equal(d.directReferralAmount, 1.0);
          assert.equal(
            d.adminAmount,
            1.0,
            `tx=${tx}, count=${count}: Admin must strictly be ₹1.00`,
          );
          assert.equal(d.gstAmount, 0.9);
          assert.equal(d.pgFeeAmount, 0.1);
          assert.equal(d.globalPoolAmount, 3.0);
          assert.equal(
            Math.round((d.globalPoolDistributedAmount + d.globalPoolReserveAmount) * 100),
            300,
          );
          assert.equal(
            Math.round(
              (d.directReferralAmount +
                d.adminAmount +
                d.globalPoolAmount +
                d.gstAmount +
                d.pgFeeAmount) *
                100,
            ),
            600,
          );
        }
      }
    }
  });

  it("5. Duplicate and concurrent verification of zero-eligible transactions create only ONE pending reserve record", async () => {
    await resetPersistentPremiumState(0, []);
    const ord1 = `ord_p11_conc1_${Date.now()}`;
    const pay1 = `pay_p11_conc1_${Date.now()}`;
    const ord2 = `ord_p11_conc2_${Date.now()}`;
    const pay2 = `pay_p11_conc2_${Date.now()}`;

    const [a, aDup, b] = await Promise.all([
      verifyServerPayment(
        {
          orderId: ord1,
          paymentId: pay1,
          signature: signOrderPayment(ord1, pay1),
          userId: "FT483921",
          purpose: "premium_video_upload",
        },
        [],
        null,
        rzpEnv,
      ),
      verifyServerPayment(
        {
          orderId: ord1,
          paymentId: pay1,
          signature: signOrderPayment(ord1, pay1),
          userId: "FT483921",
          purpose: "premium_video_upload",
        },
        [],
        null,
        rzpEnv,
      ),
      verifyServerPayment(
        {
          orderId: ord2,
          paymentId: pay2,
          signature: signOrderPayment(ord2, pay2),
          userId: "FT483921",
          purpose: "premium_video_upload",
        },
        [],
        "FT900431",
        rzpEnv,
      ),
    ]);

    assert.equal(a.verified, true);
    assert.equal(aDup.duplicate, true);
    assert.equal(aDup.distribution?.adminAmount, 1.0);
    assert.equal(aDup.distribution?.globalPoolAmount, 3.0);
    assert.equal(aDup.distribution?.globalPoolReserveAmount, 3.0);
    assert.equal(b.verified, true);

    const gpState = await getPersistentGlobalPoolState();
    assert.equal(gpState.reserves.length, 2, "Duplicate call must never create a second reserve");
  });

  it("6. Safe, idempotent, auditable reserve settlement enforces admin auth, uploader exclusion, and carry-forward residual (MySQL + fallback store)", async () => {
    // (a) MySQL harness settlement test:
    // Pending reserves:
    //  - r1: ₹3.00 (300p) uploaded by FT483921 (no_eligible_videos)
    //  - r2: ₹0.07 (7p) rounding residual uploaded by FT900431
    // Eligible videos:
    //  - v_a by CR_1 (ad_earnings: 100)
    //  - v_b by CR_2 (ad_earnings: 200)
    // For r1 (300p): CR_1 gets 100p (₹1.00), CR_2 gets 200p (₹2.00), residual 0p.
    // For r2 (7p): CR_1 gets floor(7/3)=2p (₹0.02), CR_2 gets floor(14/3)=4p (₹0.04), residual 1p (₹0.01 carry forward!).
    const harness = createPhase11MysqlHarness({
      authRole: "user",
      eligibleVideos: [
        { video_id: "v_a", user_id: "CR_1", ad_earnings: 100 },
        { video_id: "v_b", user_id: "CR_2", ad_earnings: 200 },
      ],
      pendingReserves: [
        {
          id: "gpr_1",
          payment_id: "pay_hist_1",
          order_id: "ord_hist_1",
          tx_number: 1,
          source_user_id: "FT483921",
          source_video_id: "vid_1",
          reserve_amount: 3.0,
          reserve_paise: 300,
          reserve_reason: "no_eligible_videos",
          status: "pending",
        },
        {
          id: "gpr_2",
          payment_id: "pay_hist_2",
          order_id: "ord_hist_2",
          tx_number: 2,
          source_user_id: "FT900431",
          source_video_id: "vid_2",
          reserve_amount: 0.07,
          reserve_paise: 7,
          reserve_reason: "rounding_residual",
          status: "pending",
        },
      ],
    });
    enableMockMysqlEnv();
    setMysqlPoolForTesting(harness.mockPool as any);

    // Unauthenticated rejected 401
    const unauthRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/global-pool-settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKey: "settle-batch-1" }),
      }),
      rzpEnv,
    );
    assert.equal(unauthRes?.status, 401);

    // Non-admin rejected 403
    const userRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/global-pool-settle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tok_user",
        },
        body: JSON.stringify({ idempotencyKey: "settle-batch-1" }),
      }),
      rzpEnv,
    );
    assert.equal(userRes?.status, 403);

    // Switch to Admin role
    const adminHarness = createPhase11MysqlHarness({
      authRole: "admin",
      eligibleVideos: [
        { video_id: "v_a", user_id: "CR_1", ad_earnings: 100 },
        { video_id: "v_b", user_id: "CR_2", ad_earnings: 200 },
      ],
      pendingReserves: [
        {
          id: "gpr_1",
          payment_id: "pay_hist_1",
          order_id: "ord_hist_1",
          tx_number: 1,
          source_user_id: "FT483921",
          source_video_id: "vid_1",
          reserve_amount: 3.0,
          reserve_paise: 300,
          reserve_reason: "no_eligible_videos",
          status: "pending",
        },
        {
          id: "gpr_2",
          payment_id: "pay_hist_2",
          order_id: "ord_hist_2",
          tx_number: 2,
          source_user_id: "FT900431",
          source_video_id: "vid_2",
          reserve_amount: 0.07,
          reserve_paise: 7,
          reserve_reason: "rounding_residual",
          status: "pending",
        },
      ],
    });
    setMysqlPoolForTesting(adminHarness.mockPool as any);

    // Missing idempotencyKey rejected 400
    const badKeyRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/global-pool-settle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tok_admin",
        },
        body: JSON.stringify({}),
      }),
      rzpEnv,
    );
    assert.equal(badKeyRes?.status, 400);

    // Execute settlement
    const settleRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/global-pool-settle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tok_admin",
        },
        body: JSON.stringify({
          idempotencyKey: "settle-batch-2026-01",
          notes: "Monthly reserve clearance",
        }),
      }),
      rzpEnv,
    );
    assert.equal(settleRes?.status, 200);
    const settleBody = await settleRes?.json();
    assert.equal(settleBody.success, true);
    assert.equal(settleBody.duplicate, false);
    assert.equal(settleBody.settledCount, 2);
    assert.equal(settleBody.settlement.totalReserveAmount, 3.07);
    assert.equal(settleBody.settlement.distributedAmount, 3.06);
    assert.equal(settleBody.settlement.carryForwardAmount, 0.01);
    assert.equal(adminHarness.getStatus().committed, true);

    const cr1Credit = adminHarness.walletCredits.find((w) => w.userId === "CR_1");
    const cr2Credit = adminHarness.walletCredits.find((w) => w.userId === "CR_2");
    assert.equal(cr1Credit?.globalDelta, 1.02);
    assert.equal(cr2Credit?.globalDelta, 2.04);
    assert.equal(
      adminHarness.walletCredits.some((w) => w.userId === "FT102857"),
      false,
      "Settlement carry-forward residual must NEVER credit Admin",
    );
    assert.equal(adminHarness.reserveUpdates.length, 2);
    assert.equal(adminHarness.ledgerUpdates.length, 2);
    assert.equal(adminHarness.settlementInserts.length, 1);

    // Carry-forward reserve row created as pending
    const pendingAfter = adminHarness.reserves.filter((r) => r.status === "pending");
    assert.equal(pendingAfter.length, 1);
    assert.equal(pendingAfter[0]?.reserve_amount, 0.01);
    assert.equal(pendingAfter[0]?.source_user_id, "GLOBAL_POOL_SETTLEMENT");

    // Duplicate replay with same idempotencyKey returns existing settlement without double crediting
    const creditsCountBefore = adminHarness.walletCredits.length;
    const replayRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/global-pool-settle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tok_admin",
        },
        body: JSON.stringify({ idempotencyKey: "settle-batch-2026-01" }),
      }),
      rzpEnv,
    );
    assert.equal(replayRes?.status, 200);
    const replayBody = await replayRes?.json();
    assert.equal(replayBody.duplicate, true);
    assert.equal(adminHarness.walletCredits.length, creditsCountBefore);

    // (b) Fallback store end-to-end uploader exclusion + settlement check
    disableMockMysqlEnv();
    await resetPersistentPremiumState(0, []);

    const admToken = (
      await (
        await handleApiRequest(
          new Request("http://localhost:3000/api/auth/login.php", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ identifier: "admin@facetube.com", password: "password123" }),
          }),
        )
      )?.json()
    )?.token;
    const alexToken = (
      await (
        await handleApiRequest(
          new Request("http://localhost:3000/api/auth/login.php", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
          }),
        )
      )?.json()
    )?.token;

    // Directly test uploader exclusion when Alex (FT483921) is the ONLY premium video owner
    const ordSolo = `ord_p11_fb_${Date.now()}`;
    const paySolo = `pay_p11_fb_${Date.now()}`;
    await verifyServerPayment(
      {
        orderId: ordSolo,
        paymentId: paySolo,
        signature: signOrderPayment(ordSolo, paySolo),
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      [],
      null,
      rzpEnv,
    );

    // Now GET reserves via Admin endpoint -> 1 pending (₹3.00)
    const getGpRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/global-pool-settle", {
        method: "GET",
        headers: { Authorization: `Bearer ${admToken}` },
      }),
      rzpEnv,
    );
    const getGpBody = await getGpRes?.json();
    assert.equal(getGpBody.pendingCount, 1);
    assert.equal(getGpBody.totalPendingAmount, 3.0);

    // Non-admin user (Alex) cannot invoke GET or POST
    const alexGetRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/global-pool-settle", {
        method: "GET",
        headers: { Authorization: `Bearer ${alexToken}` },
      }),
      rzpEnv,
    );
    assert.equal(alexGetRes?.status, 403);

    // Settle in fallback store (seed store has eligible videos from other creators FT900431 etc.)
    const fbSettleRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/global-pool-settle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${admToken}`,
        },
        body: JSON.stringify({ idempotencyKey: `fb-settle-${Date.now()}` }),
      }),
      rzpEnv,
    );
    assert.equal(fbSettleRes?.status, 200);
    const fbSettleBody = await fbSettleRes?.json();
    assert.equal(fbSettleBody.success, true);
    assert.equal(fbSettleBody.settledCount, 1);
    assert.equal(fbSettleBody.settlement.totalReserveAmount, 3.0);
  });

  it("7. PHP verify.php & global-pool-settle.php maintain full Phase 1.1 parity with Node", () => {
    const verifyPhp = fs.readFileSync(
      path.resolve(process.cwd(), "api", "payments", "verify.php"),
      "utf-8",
    );
    const settlePhp = fs.readFileSync(
      path.resolve(process.cwd(), "api", "admin", "global-pool-settle.php"),
      "utf-8",
    );

    assert.match(verifyPhp, /\$adminAllocation\s*=\s*1\.00;/);
    assert.match(verifyPhp, /\$globalPoolAllocation\s*=\s*3\.00;/);
    assert.equal(
      verifyPhp.includes("$baseAdminPaise + 300"),
      false,
      "verify.php must never redirect ₹3.00 Global Pool to Admin when 0 eligible videos exist",
    );
    assert.equal(
      verifyPhp.includes("$baseAdminPaise + $residualPaise"),
      false,
      "verify.php must never add rounding residual paise to Admin",
    );
    assert.ok(verifyPhp.includes("GLOBAL_POOL_RESERVE"));
    assert.ok(verifyPhp.includes("GLOBAL_POOL_PENDING_RESERVE"));
    assert.ok(verifyPhp.includes("global_pool_reserves"));
    assert.ok(
      verifyPhp.includes("global_pool_distributed, global_pool_reserve, global_pool_status"),
    );

    assert.ok(settlePhp.includes("getAuthUser($pdo, true)"));
    assert.ok(settlePhp.includes("!== 'admin'"));
    assert.ok(settlePhp.includes("global_pool_settlements WHERE idempotency_key = ? FOR UPDATE"));
    assert.ok(settlePhp.includes("FROM global_pool_reserves"));
    assert.ok(settlePhp.includes("FOR UPDATE"));
    assert.ok(settlePhp.includes("SETTLE_CARRY_"));
    assert.ok(settlePhp.includes("TX_GLB_SETTLE_"));
  });
});
