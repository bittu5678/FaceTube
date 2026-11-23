import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleApiRequest, resetInMemoryStore } from "./api-handler.ts";
import { setMysqlPoolForTesting } from "./mysql.ts";
import { PRICING_CONFIG, resetPersistentPremiumState, verifyServerPayment } from "./payments.ts";

describe("FaceTube Point 9 – Phase 1 Security Fixes", () => {
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

  const secret = "rzp_test_point9_phase1_secret";
  const keyId = "rzp_test_point9_key";
  const origRzpSkip = process.env["RAZORPAY_SKIP_REMOTE_CHECK"];
  const rzpEnv = {
    RAZORPAY_KEY_SECRET: secret,
    RAZORPAY_KEY_ID: keyId,
    RAZORPAY_SKIP_REMOTE_CHECK: "true",
    NODE_ENV: "test",
  };

  function signOrderPayment(orderId: string, paymentId: string): string {
    return crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
  }

  beforeEach(async () => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-point9-p1-"));
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

  function writeIsolatedStore(storeData: Record<string, unknown>): void {
    fs.writeFileSync(
      path.join(tmpDataDir, "facetube_store.json"),
      JSON.stringify(storeData, null, 2),
      "utf-8",
    );
    resetInMemoryStore();
  }

  describe("1. Wallet Earnings History API – IDOR & Auth Fix", () => {
    function seedEarningsHistoryStore() {
      const today = new Date().toISOString().split("T")[0]!;
      writeIsolatedStore({
        users: [
          {
            id: "uuid-owner-111",
            user_id: "FT111111",
            name: "Owner User",
            email: "owner@facetube.com",
            mobile: "9000000011",
            role: "user",
            referral_code: null,
            created_at: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "uuid-victim-222",
            user_id: "FT222222",
            name: "Victim User",
            email: "victim@facetube.com",
            mobile: "9000000022",
            role: "user",
            referral_code: null,
            created_at: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "uuid-default-483921",
            user_id: "FT483921",
            name: "Protected Account",
            email: "ft483921@facetube.com",
            mobile: "9000000099",
            role: "user",
            referral_code: null,
            created_at: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "uuid-admin-102857",
            user_id: "FT102857",
            name: "Platform Admin",
            email: "admin@facetube.com",
            mobile: "9000000001",
            role: "admin",
            referral_code: null,
            created_at: "2026-01-01T00:00:00.000Z",
          },
        ],
        sessions: {
          tok_owner: "FT111111",
          tok_victim: "FT222222",
          tok_admin: "FT102857",
        },
        walletTransactions: [
          {
            id: "led-owner-1",
            transaction_id: "TX_REF_OWNER_1",
            user_id: "FT111111",
            income_type: "referral_income",
            amount: 12.0,
            status: "settled",
            created_at: `${today}T08:00:00.000Z`,
          },
          {
            id: "led-victim-1",
            transaction_id: "TX_REF_VICTIM_1",
            user_id: "FT222222",
            income_type: "referral_income",
            amount: 75.5,
            status: "settled",
            created_at: `${today}T09:00:00.000Z`,
          },
          {
            id: "led-483921-1",
            transaction_id: "TX_REF_483921_1",
            user_id: "FT483921",
            income_type: "referral_income",
            amount: 999.0,
            status: "settled",
            created_at: `${today}T10:00:00.000Z`,
          },
        ],
      });
    }

    it("rejects unauthenticated access (401) and never falls back to FT483921", async () => {
      seedEarningsHistoryStore();

      // Missing Authorization header without user_id (previously defaulted to FT483921)
      const resNoParam = await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/earnings-history.php?period=7D"),
      );
      assert.equal(resNoParam?.status, 401);
      const bodyNoParam = (await resNoParam?.json()) as any;
      assert.equal(bodyNoParam.success, false);
      assert.equal("history" in bodyNoParam, false);
      assert.equal("summary" in bodyNoParam, false);
      assert.equal("user_id" in bodyNoParam, false);

      // Missing Authorization header with explicit ?user_id=FT483921
      const resWithParam = await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/earnings-history?user_id=FT483921&period=7D"),
      );
      assert.equal(resWithParam?.status, 401);
      const bodyWithParam = (await resWithParam?.json()) as any;
      assert.equal(bodyWithParam.success, false);
      assert.equal("history" in bodyWithParam, false);

      // Invalid/forged Bearer token
      const resInvalidTok = await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/earnings-history.php?period=7D", {
          headers: { Authorization: "Bearer forged_invalid_token" },
        }),
      );
      assert.equal(resInvalidTok?.status, 401);
      const bodyInvalidTok = (await resInvalidTok?.json()) as any;
      assert.equal(bodyInvalidTok.success, false);
      assert.equal("history" in bodyInvalidTok, false);
    });

    it("allows authenticated user to access their own earnings history (omitted user_id, public user_id, or internal id)", async () => {
      seedEarningsHistoryStore();

      // Omitted user_id -> derived from session FT111111
      const resOmitted = await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/earnings-history.php?period=7D", {
          headers: { Authorization: "Bearer tok_owner" },
        }),
      );
      assert.equal(resOmitted?.status, 200);
      const bodyOmitted = (await resOmitted?.json()) as any;
      assert.equal(bodyOmitted.success, true);
      assert.equal(bodyOmitted.user_id, "FT111111");
      assert.equal(bodyOmitted.summary.referral, 12.0);
      assert.equal(bodyOmitted.summary.total_revenue, 12.0);

      // Matching public user_id (lowercase)
      const resOwnPublic = await handleApiRequest(
        new Request(
          "http://localhost:3000/api/wallet/earnings-history?user_id=ft111111&period=7D",
          {
            headers: { Authorization: "Bearer tok_owner" },
          },
        ),
      );
      assert.equal(resOwnPublic?.status, 200);
      const bodyOwnPublic = (await resOwnPublic?.json()) as any;
      assert.equal(bodyOwnPublic.user_id, "FT111111");
      assert.equal(bodyOwnPublic.summary.total_revenue, 12.0);

      // Matching internal UUID id -> canonical public user_id FT111111
      const resOwnInternal = await handleApiRequest(
        new Request(
          "http://localhost:3000/api/wallet/earnings-history.php?userId=uuid-owner-111&period=7D",
          {
            headers: { Authorization: "Bearer tok_owner" },
          },
        ),
      );
      assert.equal(resOwnInternal?.status, 200);
      const bodyOwnInternal = (await resOwnInternal?.json()) as any;
      assert.equal(bodyOwnInternal.user_id, "FT111111");
      assert.equal(bodyOwnInternal.summary.total_revenue, 12.0);
    });

    it("rejects cross-user access for non-admin users (403) without querying database, while allowing verified admin access (200)", async () => {
      seedEarningsHistoryStore();
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";

      let ledgerQueries = 0;
      const today = new Date().toISOString().split("T")[0]!;
      setMysqlPoolForTesting({
        query: async (sql: string, params?: any[]) => {
          if (sql.includes("FROM sessions s")) {
            const tok = String(params?.[0] || "");
            if (tok === "tok_owner") {
              return [
                [
                  {
                    id: "uuid-owner-111",
                    user_id: "FT111111",
                    name: "Owner User",
                    email: "owner@facetube.com",
                    mobile: "9000000011",
                    role: "user",
                    referral_code: null,
                    created_at: "2026-01-01T00:00:00.000Z",
                  },
                ],
              ];
            }
            if (tok === "tok_admin") {
              return [
                [
                  {
                    id: "uuid-admin-102857",
                    user_id: "FT102857",
                    name: "Platform Admin",
                    email: "admin@facetube.com",
                    mobile: "9000000001",
                    role: "admin",
                    referral_code: null,
                    created_at: "2026-01-01T00:00:00.000Z",
                  },
                ],
              ];
            }
            return [[]];
          }
          if (sql.includes("FROM income_ledger")) {
            ledgerQueries += 1;
            assert.equal(params?.[0], "FT222222");
            return [
              [
                {
                  period_key: today,
                  income_type: "referral_income",
                  total_amount: 75.5,
                  tx_count: 1,
                },
              ],
            ];
          }
          return [[]];
        },
      } as any);

      // Non-admin cross-user attempt via ?user_id=
      const resCross1 = await handleApiRequest(
        new Request(
          "http://localhost:3000/api/wallet/earnings-history.php?user_id=FT222222&period=7D",
          { headers: { Authorization: "Bearer tok_owner" } },
        ),
      );
      assert.equal(resCross1?.status, 403);
      const bodyCross1 = (await resCross1?.json()) as any;
      assert.equal(bodyCross1.success, false);
      assert.equal(ledgerQueries, 0, "Cross-user request must never query income_ledger");

      // Non-admin cross-user attempt via ?userId=
      const resCross2 = await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/earnings-history?userId=FT483921&period=7D", {
          headers: { Authorization: "Bearer tok_owner" },
        }),
      );
      assert.equal(resCross2?.status, 403);
      assert.equal(ledgerQueries, 0);

      // Verified admin cross-user lookup succeeds
      const resAdmin = await handleApiRequest(
        new Request(
          "http://localhost:3000/api/wallet/earnings-history.php?user_id=FT222222&period=7D",
          { headers: { Authorization: "Bearer tok_admin" } },
        ),
      );
      assert.equal(resAdmin?.status, 200);
      const bodyAdmin = (await resAdmin?.json()) as any;
      assert.equal(bodyAdmin.success, true);
      assert.equal(bodyAdmin.user_id, "FT222222");
      assert.equal(bodyAdmin.summary.referral, 75.5);
      assert.equal(ledgerQueries, 1);
    });

    it("fails closed in production (503/500) and returns 405 on non-GET", async () => {
      seedEarningsHistoryStore();

      const res405 = await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/earnings-history.php", {
          method: "POST",
          headers: { Authorization: "Bearer tok_owner" },
        }),
      );
      assert.equal(res405?.status, 405);

      process.env["NODE_ENV"] = "production";
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_prod";
      process.env["DB_USER"] = "prod_user";

      // Production DB unavailable during query -> 503 (never falls back to store)
      setMysqlPoolForTesting({
        query: async (sql: string) => {
          if (sql.includes("FROM sessions s")) {
            return [
              [
                {
                  id: "uuid-owner-111",
                  user_id: "FT111111",
                  name: "Owner User",
                  email: "owner@facetube.com",
                  mobile: "9000000011",
                  role: "user",
                  referral_code: null,
                  created_at: "2026-01-01T00:00:00.000Z",
                },
              ],
            ];
          }
          const err = new Error("Connection refused");
          (err as any).code = "ECONNREFUSED";
          throw err;
        },
      } as any);

      const resProd503 = await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/earnings-history.php?period=7D", {
          headers: { Authorization: "Bearer tok_owner" },
        }),
      );
      assert.equal(resProd503?.status, 503);
      const bodyProd503 = (await resProd503?.json()) as any;
      assert.equal(bodyProd503.success, false);
      assert.equal("history" in bodyProd503, false);

      // Unexpected DB error -> 500
      setMysqlPoolForTesting({
        query: async (sql: string) => {
          if (sql.includes("FROM sessions s")) {
            return [
              [
                {
                  id: "uuid-owner-111",
                  user_id: "FT111111",
                  name: "Owner User",
                  email: "owner@facetube.com",
                  mobile: "9000000011",
                  role: "user",
                  referral_code: null,
                  created_at: "2026-01-01T00:00:00.000Z",
                },
              ],
            ];
          }
          throw new Error("Table income_ledger does not exist");
        },
      } as any);

      const resProd500 = await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/earnings-history.php?period=7D", {
          headers: { Authorization: "Bearer tok_owner" },
        }),
      );
      assert.equal(resProd500?.status, 500);

      // Node api-handler.ts must not contain hardcoded FT483921 fallback in earnings-history
      const apiHandlerSource = fs.readFileSync(
        path.resolve(process.cwd(), "src/server/api-handler.ts"),
        "utf-8",
      );
      const earningsSliceStart = apiHandlerSource.indexOf(
        'if (route === "wallet/earnings-history")',
      );
      const earningsSliceEnd = apiHandlerSource.indexOf("// 18. Live Streams & Chat");
      assert.ok(earningsSliceStart > 0 && earningsSliceEnd > earningsSliceStart);
      const earningsSlice = apiHandlerSource.slice(earningsSliceStart, earningsSliceEnd);
      assert.doesNotMatch(earningsSlice, /FT483921/);
      assert.match(earningsSlice, /requireAuth\(authUser,\s*qUserId\)/);
    });
  });

  describe("2. Ads Promotion – Fake Sponsor Removal & Server-Side Attribution", () => {
    it("removes hardcoded FT810492, Samantha Chen, referred_by, and client directReferrerId from Ads Promotions frontend", () => {
      const adsPromotionsSource = fs.readFileSync(
        path.resolve(process.cwd(), "src/routes/ads-promotions.tsx"),
        "utf-8",
      );
      const razorpayServiceSource = fs.readFileSync(
        path.resolve(process.cwd(), "src/lib/razorpay-service.ts"),
        "utf-8",
      );

      assert.doesNotMatch(adsPromotionsSource, /FT810492/);
      assert.doesNotMatch(adsPromotionsSource, /Samantha\s+Chen/i);
      assert.doesNotMatch(adsPromotionsSource, /referred_by/);
      assert.doesNotMatch(adsPromotionsSource, /sponsor_name/);
      assert.doesNotMatch(adsPromotionsSource, /directReferrerId/);
      assert.match(
        adsPromotionsSource,
        /profile\?\.referral_code\s*\?\?\s*dbUser\?\.referral_code/,
      );

      const adsFnStart = razorpayServiceSource.indexOf(
        "export async function initiateAdsPromotionPayment",
      );
      const adsFnEnd = razorpayServiceSource.indexOf(
        "export interface InitiatePaidSubscriptionPaymentParams",
      );
      assert.ok(adsFnStart > 0 && adsFnEnd > adsFnStart);
      const adsFnSlice = razorpayServiceSource.slice(adsFnStart, adsFnEnd);
      assert.doesNotMatch(adsFnSlice, /referrerUserId\s*:/);
    });

    it("verifyServerPayment rejects client-supplied req.referrerUserId spoofing and self-referral for ads_promotion & premium_video_upload", async () => {
      // 1. Ads Promotion with spoofed client req.referrerUserId and server uplines = []
      const adsOrder = "ord_p9_ads_spoof_1";
      const adsPay = "pay_p9_ads_spoof_1";
      const adsRes = await verifyServerPayment(
        {
          orderId: adsOrder,
          paymentId: adsPay,
          signature: signOrderPayment(adsOrder, adsPay),
          userId: "FT_PROMOTER_1",
          purpose: "ads_promotion",
          planId: "plan-monthly",
          referrerUserId: "FT810492", // Untrusted client input must be ignored
        },
        [],
        null,
        rzpEnv,
        [], // Server resolved 0 uplines
      );

      assert.equal(adsRes.verified, true);
      assert.equal(adsRes.amount, PRICING_CONFIG.ADS_PROMOTION["plan-monthly"].price);
      assert.equal(adsRes.distribution?.totalReferralAmount, 0);
      assert.equal(adsRes.distribution?.levelPayouts?.length, 0);
      assert.equal(adsRes.distribution?.referrerId, null);
      assert.equal(
        adsRes.distribution?.adminAmount,
        300,
        "Unassigned Ads Promotion referral share must route to Admin, never a spoofed user",
      );

      // 2. Ads Promotion rejects accidental self-referral even if server argument matches uploader
      const selfAdsOrder = "ord_p9_ads_self_1";
      const selfAdsPay = "pay_p9_ads_self_1";
      const selfAdsRes = await verifyServerPayment(
        {
          orderId: selfAdsOrder,
          paymentId: selfAdsPay,
          signature: signOrderPayment(selfAdsOrder, selfAdsPay),
          userId: "FT_PROMOTER_1",
          purpose: "ads_promotion",
          planId: "plan-7-days",
          referrerUserId: "FT_PROMOTER_1",
        },
        [],
        "FT_PROMOTER_1",
        rzpEnv,
      );
      assert.equal(selfAdsRes.verified, true);
      assert.equal(selfAdsRes.distribution?.totalReferralAmount, 0);
      assert.equal(selfAdsRes.distribution?.adminAmount, 100);

      // 3. Premium Video Upload with spoofed client req.referrerUserId and server referrer = null
      const premOrder = "ord_p9_prem_spoof_1";
      const premPay = "pay_p9_prem_spoof_1";
      const premRes = await verifyServerPayment(
        {
          orderId: premOrder,
          paymentId: premPay,
          signature: signOrderPayment(premOrder, premPay),
          userId: "FT_UPLOADER_1",
          purpose: "premium_video_upload",
          referrerUserId: "FT810492", // Untrusted client input must be ignored
        },
        [],
        null,
        rzpEnv,
      );
      assert.equal(premRes.verified, true);
      assert.equal(premRes.distribution?.referralStatus, "unassigned_pending");
      assert.equal(premRes.distribution?.referrerId, null);
      assert.equal(premRes.distribution?.directReferralAmount, 1.0);
      assert.equal(premRes.distribution?.adminAmount, 1.0);
      assert.equal(premRes.distribution?.globalPoolAmount, 3.0);
    });

    it("HTTP /api/payments/verify resolves multi-level sponsor uplines server-side via referral_code, ignores client referrerUserId, and credits no arbitrary user when unlinked", async () => {
      // Seed isolated store:
      // FT_PROMO_LINKED -> referral_code: 'CREATOR50' (resolves to L1: FT483921)
      // FT483921 -> referral_code: 'FT102857' (resolves to L2: FT102857 Admin)
      // FT_PROMO_UNLINKED -> referral_code: null (no sponsor)
      // FT_ATTACKER / FT810492 -> unlinked target attacker tries to spoof via payload.referrerUserId
      writeIsolatedStore({
        users: [
          {
            id: "u-admin",
            user_id: "FT102857",
            name: "Admin Top",
            email: "admin@facetube.com",
            mobile: "9000000001",
            role: "admin",
            referral_code: null,
            created_at: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "u-l1",
            user_id: "FT483921",
            name: "Level One Sponsor",
            email: "l1@facetube.com",
            mobile: "9000000002",
            role: "user",
            referral_code: "FT102857",
            created_at: "2026-01-02T00:00:00.000Z",
          },
          {
            id: "u-linked",
            user_id: "FT_PROMO_LINKED",
            name: "Linked Advertiser",
            email: "linked@facetube.com",
            mobile: "9000000003",
            role: "user",
            referral_code: "CREATOR50",
            created_at: "2026-01-03T00:00:00.000Z",
          },
          {
            id: "u-unlinked",
            user_id: "FT_PROMO_UNLINKED",
            name: "Unlinked Advertiser",
            email: "unlinked@facetube.com",
            mobile: "9000000004",
            role: "user",
            referral_code: null,
            created_at: "2026-01-04T00:00:00.000Z",
          },
          {
            id: "u-attacker",
            user_id: "FT810492",
            name: "Spoofed Sponsor",
            email: "spoof@facetube.com",
            mobile: "9000000005",
            role: "user",
            referral_code: null,
            created_at: "2026-01-05T00:00:00.000Z",
          },
        ],
        sessions: {
          tok_linked: "FT_PROMO_LINKED",
          tok_unlinked: "FT_PROMO_UNLINKED",
        },
        videos: [
          {
            id: "vid_ads_linked",
            user_id: "FT_PROMO_LINKED",
            title: "Linked Promo Video",
            video_type: "free",
            payment_status: "not_required",
            ad_earnings: 0,
          },
          {
            id: "vid_ads_unlinked",
            user_id: "FT_PROMO_UNLINKED",
            title: "Unlinked Promo Video",
            video_type: "free",
            payment_status: "not_required",
            ad_earnings: 0,
          },
        ],
        paymentOrders: [
          {
            order_id: "ord_http_linked",
            user_id: "FT_PROMO_LINKED",
            video_id: "vid_ads_linked",
            purpose: "ads_promotion",
            plan_id: "plan-monthly",
            amount: 300,
            currency: "INR",
            status: "created",
            created_at: "2026-01-06T00:00:00.000Z",
          },
          {
            order_id: "ord_http_unlinked",
            user_id: "FT_PROMO_UNLINKED",
            video_id: "vid_ads_unlinked",
            purpose: "ads_promotion",
            plan_id: "plan-monthly",
            amount: 300,
            currency: "INR",
            status: "created",
            created_at: "2026-01-06T00:05:00.000Z",
          },
        ],
        wallets: {},
        walletTransactions: [],
      });

      // A. Linked user sends spoofed referrerUserId 'FT810492' -> ignored; server resolves L1=FT483921 (15%=₹45), L2=FT102857 (10%=₹30)
      const payLinked = "pay_http_linked_1";
      const resLinked = await handleApiRequest(
        new Request("http://localhost:3000/api/payments/verify.php", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer tok_linked",
          },
          body: JSON.stringify({
            orderId: "ord_http_linked",
            paymentId: payLinked,
            signature: signOrderPayment("ord_http_linked", payLinked),
            userId: "FT_PROMO_LINKED",
            videoId: "vid_ads_linked",
            purpose: "ads_promotion",
            planId: "plan-monthly",
            referrerUserId: "FT810492",
          }),
        }),
      );
      assert.equal(resLinked?.status, 200);
      const bodyLinked = (await resLinked?.json()) as any;
      assert.equal(bodyLinked.verified, true);
      assert.equal(bodyLinked.distribution.referrerId, "FT483921");
      assert.equal(bodyLinked.distribution.levelPayouts.length, 2);
      assert.equal(bodyLinked.distribution.levelPayouts[0].userId, "FT483921");
      assert.equal(bodyLinked.distribution.levelPayouts[0].amount, 45);
      assert.equal(bodyLinked.distribution.levelPayouts[1].userId, "FT102857");
      assert.equal(bodyLinked.distribution.levelPayouts[1].amount, 30);
      assert.equal(bodyLinked.distribution.totalReferralAmount, 75);
      assert.equal(bodyLinked.distribution.adminAmount, 225);

      // B. Unlinked user sends spoofed referrerUserId 'FT810492' -> ignored; 0 uplines credited, 100% ₹300 to Admin
      const payUnlinked = "pay_http_unlinked_1";
      const resUnlinked = await handleApiRequest(
        new Request("http://localhost:3000/api/payments/verify.php", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer tok_unlinked",
          },
          body: JSON.stringify({
            orderId: "ord_http_unlinked",
            paymentId: payUnlinked,
            signature: signOrderPayment("ord_http_unlinked", payUnlinked),
            userId: "FT_PROMO_UNLINKED",
            videoId: "vid_ads_unlinked",
            purpose: "ads_promotion",
            planId: "plan-monthly",
            referrerUserId: "FT810492",
          }),
        }),
      );
      assert.equal(resUnlinked?.status, 200);
      const bodyUnlinked = (await resUnlinked?.json()) as any;
      assert.equal(bodyUnlinked.verified, true);
      assert.equal(bodyUnlinked.distribution.referrerId, null);
      assert.equal(bodyUnlinked.distribution.levelPayouts.length, 0);
      assert.equal(bodyUnlinked.distribution.totalReferralAmount, 0);
      assert.equal(bodyUnlinked.distribution.adminAmount, 300);

      const finalStore = JSON.parse(
        fs.readFileSync(path.join(tmpDataDir, "facetube_store.json"), "utf-8"),
      );
      assert.equal(
        finalStore.wallets["FT810492"]?.balance ?? 0,
        0,
        "Spoofed sponsor FT810492 must NEVER receive any wallet balance",
      );
      assert.equal(finalStore.wallets["FT483921"]?.balance, 45);
      assert.equal(finalStore.wallets["FT102857"]?.balance, 30 + 225 + 300);
    });
  });
});
