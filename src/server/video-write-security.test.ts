import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleApiRequest, resetInMemoryStore, resetStoreForTests } from "./api-handler";
import { setMysqlPoolForTesting } from "./mysql";

const TEST_KEY_ID = "rzp_test_Step3ASecurity";
const TEST_SECRET = "test_secret_step3a_video_write_987654321";

const RZP_ENV = {
  RAZORPAY_KEY_ID: TEST_KEY_ID,
  RAZORPAY_KEY_SECRET: TEST_SECRET,
  RAZORPAY_SKIP_REMOTE_CHECK: "true",
};

async function loginAs(
  identifier: string,
  password: string,
): Promise<{ token: string; userId: string }> {
  const res = await handleApiRequest(
    new Request("http://localhost:3000/api/auth/login.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier, password }),
    }),
  );
  assert.ok(res, "Login response should exist");
  assert.equal(res.status, 200, `Login for ${identifier} should succeed`);
  const data = await res.json();
  assert.ok(data.token, "Login response should include Bearer token");
  return {
    token: data.token,
    userId: String(data.user?.user_id || data.user?.userId || ""),
  };
}

async function createVerifiedPayment(params: {
  token: string;
  userId: string;
  purpose: "premium_video_upload" | "ads_promotion";
  videoId?: string;
  planId?: "plan-7-days" | "plan-15-days" | "plan-monthly" | "plan-yearly";
  amount: number;
}): Promise<{ orderId: string; paymentId: string }> {
  const orderRes = await handleApiRequest(
    new Request("http://localhost:3000/api/payments/create-order", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.token}`,
      },
      body: JSON.stringify({
        purpose: params.purpose,
        userId: params.userId,
        videoId: params.videoId,
        planId: params.planId,
      }),
    }),
    RZP_ENV,
  );
  assert.ok(orderRes);
  assert.equal(orderRes.status, 200, `create-order for ${params.purpose} should return 200`);
  const orderBody = await orderRes.json();
  const orderId = orderBody.orderId as string;
  assert.ok(orderId);

  const paymentId = `pay_step3a_${params.purpose}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const signature = crypto
    .createHmac("sha256", TEST_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");

  const verifyRes = await handleApiRequest(
    new Request("http://localhost:3000/api/payments/verify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.token}`,
      },
      body: JSON.stringify({
        orderId,
        paymentId,
        signature,
        userId: params.userId,
        purpose: params.purpose,
        videoId: params.videoId,
        planId: params.planId,
        amount: params.amount,
      }),
    }),
    RZP_ENV,
  );
  assert.ok(verifyRes);
  assert.equal(verifyRes.status, 200, `verify for ${params.purpose} should return 200`);
  const verifyBody = await verifyRes.json();
  assert.equal(verifyBody.verified, true);
  return { orderId, paymentId };
}

describe("Phase 2B Step 3A: Secure Video Write Endpoints & Checkout Parity", () => {
  let tempDataDir = "";
  let prevDataDir: string | undefined;

  beforeEach(() => {
    prevDataDir = process.env["FACETUBE_DATA_DIR"];
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-video-write-test-"));
    process.env["FACETUBE_DATA_DIR"] = tempDataDir;
    setMysqlPoolForTesting(null);
    resetInMemoryStore();
    resetStoreForTests();
  });

  afterEach(() => {
    setMysqlPoolForTesting(null);
    resetInMemoryStore();
    if (prevDataDir === undefined) {
      delete process.env["FACETUBE_DATA_DIR"];
    } else {
      process.env["FACETUBE_DATA_DIR"] = prevDataDir;
    }
    if (tempDataDir && fs.existsSync(tempDataDir)) {
      fs.rmSync(tempDataDir, { recursive: true, force: true });
    }
  });

  it("1. Rejects unauthenticated requests to videos/create and videos/promote with 401", async () => {
    const resCreateNoBody = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/create", { method: "POST" }),
    );
    assert.ok(resCreateNoBody);
    assert.equal(resCreateNoBody.status, 401);

    const resCreateSpoofed = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: "FT483921",
          title: "Unauthenticated Upload",
          video_url: "https://example.com/v.mp4",
        }),
      }),
    );
    assert.ok(resCreateSpoofed);
    assert.equal(resCreateSpoofed.status, 401);

    const resPromote = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoId: "vid-seed-001",
          paymentId: "pay_fake_123",
          durationDays: 365,
        }),
      }),
    );
    assert.ok(resPromote);
    assert.equal(resPromote.status, 401);
  });

  it("2. Fails closed with 503 in production when MySQL pool is unavailable", async () => {
    const alex = await loginAs("alex@facetube.com", "password123");
    const prodEnv = { ...RZP_ENV, APP_ENV: "production", NODE_ENV: "production" };

    const resCreate = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${alex.token}`,
        },
        body: JSON.stringify({
          title: "Prod Fail Closed",
          video_url: "https://example.com/prod.mp4",
        }),
      }),
      prodEnv,
    );
    assert.ok(resCreate);
    assert.equal(resCreate.status, 503);

    const resPromote = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/promote", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${alex.token}`,
        },
        body: JSON.stringify({
          videoId: "vid-seed-001",
          paymentId: "pay_any_123",
        }),
      }),
      prodEnv,
    );
    assert.ok(resPromote);
    assert.equal(resPromote.status, 503);
  });

  it("3. Prevents cross-user video creation and cross-user overwrite (403), while allowing Admin", async () => {
    const alex = await loginAs("alex@facetube.com", "password123");
    const maya = await loginAs("maya@facetube.com", "password123");
    const admin = await loginAs("admin@facetube.com", "password");

    // Regular user cannot create under another user_id
    const crossCreate = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${maya.token}`,
        },
        body: JSON.stringify({
          user_id: alex.userId,
          title: "Spoofed Owner Video",
          video_url: "https://example.com/spoof.mp4",
        }),
      }),
    );
    assert.ok(crossCreate);
    assert.equal(crossCreate.status, 403);

    // Alex creates his own video (omitting user_id derives it from session)
    const videoId = `vid-own-${Date.now()}`;
    const createOwn = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${alex.token}`,
        },
        body: JSON.stringify({
          id: videoId,
          title: "Alex Original Title",
          video_url: "https://example.com/alex-orig.mp4",
          visibility: "private",
        }),
      }),
    );
    assert.ok(createOwn);
    assert.equal(createOwn.status, 201);
    const createdBody = await createOwn.json();
    assert.equal(createdBody.video.user_id, alex.userId);
    assert.equal(createdBody.video.visibility, "private");

    // Maya cannot overwrite Alex's existing video ID
    const crossOverwrite = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${maya.token}`,
        },
        body: JSON.stringify({
          id: videoId,
          title: "Hijacked Title",
          video_url: "https://example.com/hijacked.mp4",
        }),
      }),
    );
    assert.ok(crossOverwrite);
    assert.equal(crossOverwrite.status, 403);

    // Admin can update Alex's video while preserving original owner unless specified
    const adminUpdate = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${admin.token}`,
        },
        body: JSON.stringify({
          id: videoId,
          title: "Admin Moderated Title",
          video_url: "https://example.com/alex-orig.mp4",
          visibility: "unlisted",
        }),
      }),
    );
    assert.ok(adminUpdate);
    assert.equal(adminUpdate.status, 201);
    const adminBody = await adminUpdate.json();
    assert.equal(adminBody.video.user_id, alex.userId);
    assert.equal(adminBody.video.visibility, "unlisted");
  });

  it("4. Validates visibility, sanitizes free video client claims, and upserts in-place without duplicates", async () => {
    const alex = await loginAs("alex@facetube.com", "password123");
    const vidId = `vid-upsert-${Date.now()}`;

    // Invalid visibility -> 400
    const badVis = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${alex.token}`,
        },
        body: JSON.stringify({
          id: vidId,
          title: "Invalid Visibility",
          video_url: "https://example.com/v1.mp4",
          visibility: "friends_only",
        }),
      }),
    );
    assert.ok(badVis);
    assert.equal(badVis.status, 400);

    // Client tries to spoof payment_status, payment_amount, and is_promoted on a free video
    const firstCreate = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${alex.token}`,
        },
        body: JSON.stringify({
          id: vidId,
          title: "Free Video Attempt 1",
          video_url: "https://example.com/v1.mp4",
          video_type: "free",
          visibility: "unlisted",
          payment_status: "paid",
          payment_amount: 6,
          payment_id: "pay_forged_free_1",
          is_promoted: true,
        }),
      }),
    );
    assert.ok(firstCreate);
    assert.equal(firstCreate.status, 201);
    const firstBody = await firstCreate.json();
    assert.equal(firstBody.video.payment_status, "not_required");
    assert.equal(firstBody.video.payment_amount, 0);
    assert.equal(firstBody.video.payment_id, undefined);
    assert.equal(firstBody.video.is_promoted, false);
    assert.equal(firstBody.video.visibility, "unlisted");

    // Second upsert by owner updates in-place with no duplicate IDs
    const secondUpsert = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${alex.token}`,
        },
        body: JSON.stringify({
          id: vidId,
          title: "Free Video Updated Title",
          video_url: "https://example.com/v1-updated.mp4",
          video_type: "free",
          visibility: "private",
          is_promoted: true,
        }),
      }),
    );
    assert.ok(secondUpsert);
    assert.equal(secondUpsert.status, 201);
    const secondBody = await secondUpsert.json();
    assert.equal(secondBody.video.title, "Free Video Updated Title");
    assert.equal(secondBody.video.visibility, "private");
    assert.equal(secondBody.video.is_promoted, false);

    // Check list to confirm no duplicate entries with the same ID
    const listRes = await handleApiRequest(
      new Request(`http://localhost:3000/api/videos/list?userId=${alex.userId}`, {
        headers: { Authorization: `Bearer ${alex.token}` },
      }),
    );
    assert.ok(listRes);
    const listBody = await listRes.json();
    const matches = (listBody.videos || []).filter((v: any) => v.id === vidId);
    assert.equal(matches.length, 1, "JSON store upsert must update existing video in-place");
    assert.equal(matches[0].title, "Free Video Updated Title");
  });

  it("5. Rejects forged premium uploads, accepts ₹6 verified Sponsor upload, and blocks payment reuse", async () => {
    const alex = await loginAs("alex@facetube.com", "password123");
    const maya = await loginAs("maya@facetube.com", "password123");

    // Missing payment_id -> 400
    const missingPay = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${alex.token}`,
        },
        body: JSON.stringify({
          title: "Sponsor Without Payment",
          video_url: "https://example.com/sponsor.mp4",
          video_type: "premium",
          payment_status: "paid",
          payment_amount: 6,
        }),
      }),
    );
    assert.ok(missingPay);
    assert.equal(missingPay.status, 400);

    // Forged non-existent payment_id -> 400
    const forgedPay = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${alex.token}`,
        },
        body: JSON.stringify({
          title: "Sponsor Forged Payment",
          video_url: "https://example.com/sponsor.mp4",
          video_type: "premium",
          payment_status: "paid",
          payment_id: "pay_forged_99999",
          payment_amount: 6,
        }),
      }),
    );
    assert.ok(forgedPay);
    assert.equal(forgedPay.status, 400);

    // Create a legitimate ₹6 payment for Alex
    const { paymentId: alexSponsorPayId } = await createVerifiedPayment({
      token: alex.token,
      userId: alex.userId,
      purpose: "premium_video_upload",
      amount: 6,
    });

    // Maya cannot steal Alex's verified ₹6 payment_id -> 403
    const stolenPayRes = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${maya.token}`,
        },
        body: JSON.stringify({
          title: "Maya Stealing Alex Sponsor Payment",
          video_url: "https://example.com/maya-steal.mp4",
          video_type: "premium",
          payment_id: alexSponsorPayId,
        }),
      }),
    );
    assert.ok(stolenPayRes);
    assert.equal(stolenPayRes.status, 403);

    // Alex creates the legitimate ₹6 Sponsor video
    const sponsorVid1 = `vid-sponsor-1-${Date.now()}`;
    const validSponsorRes = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${alex.token}`,
        },
        body: JSON.stringify({
          id: sponsorVid1,
          title: "Valid ₹6 Sponsor Video",
          video_url: "https://example.com/sponsor-valid.mp4",
          video_type: "premium",
          visibility: "public",
          payment_id: alexSponsorPayId,
        }),
      }),
    );
    assert.ok(validSponsorRes);
    assert.equal(validSponsorRes.status, 201);
    const validSponsorBody = await validSponsorRes.json();
    assert.equal(validSponsorBody.video.video_type, "premium");
    assert.equal(validSponsorBody.video.payment_status, "paid");
    assert.equal(validSponsorBody.video.payment_amount, 6);
    assert.equal(validSponsorBody.video.payment_id, alexSponsorPayId);

    // Reusing the same ₹6 payment_id on a second video -> 409 Conflict
    const reusePayRes = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${alex.token}`,
        },
        body: JSON.stringify({
          id: `vid-sponsor-2-${Date.now()}`,
          title: "Reused Sponsor Payment",
          video_url: "https://example.com/sponsor-reuse.mp4",
          video_type: "premium",
          payment_id: alexSponsorPayId,
        }),
      }),
    );
    assert.ok(reusePayRes);
    assert.equal(reusePayRes.status, 409);

    // Using an ads_promotion payment_id to create a premium video -> 400 purpose mismatch
    const { paymentId: adsPayId } = await createVerifiedPayment({
      token: alex.token,
      userId: alex.userId,
      purpose: "ads_promotion",
      videoId: sponsorVid1,
      planId: "plan-7-days",
      amount: 100,
    });
    const wrongPurposeCreate = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${alex.token}`,
        },
        body: JSON.stringify({
          id: `vid-wrong-purpose-${Date.now()}`,
          title: "Wrong Purpose Premium Video",
          video_url: "https://example.com/wrong-purpose.mp4",
          video_type: "premium",
          payment_id: adsPayId,
        }),
      }),
    );
    assert.ok(wrongPurposeCreate);
    assert.equal(wrongPurposeCreate.status, 400);
  });

  it("6. Secures videos/promote: rejects unverified, cross-user, wrong-video, and spoofed plan/duration requests; preserves idempotency and additive renewal", async () => {
    const alex = await loginAs("alex@facetube.com", "password123");
    const maya = await loginAs("maya@facetube.com", "password123");

    // Alex creates two real videos first (matching Step 3A Ads Promotion flow)
    const vidA = `vid-promo-a-${Date.now()}`;
    const vidB = `vid-promo-b-${Date.now()}`;

    for (const [id, title] of [
      [vidA, "Campaign Video A"],
      [vidB, "Campaign Video B"],
    ] as const) {
      const cRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${alex.token}`,
          },
          body: JSON.stringify({
            id,
            title,
            video_url: `https://example.com/${id}.mp4`,
            video_type: "free",
            visibility: "public",
          }),
        }),
      );
      assert.ok(cRes);
      assert.equal(cRes.status, 201);
    }

    // 1. Missing or unverified paymentId -> 400
    const missingPayRes = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/promote", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${alex.token}`,
        },
        body: JSON.stringify({ videoId: vidA, planId: "plan-7-days" }),
      }),
    );
    assert.ok(missingPayRes);
    assert.equal(missingPayRes.status, 400);

    const fakePayRes = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/promote", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${alex.token}`,
        },
        body: JSON.stringify({
          videoId: vidA,
          paymentId: "pay_unverified_fake_1",
          planId: "plan-yearly",
          durationDays: 9999,
        }),
      }),
    );
    assert.ok(fakePayRes);
    assert.equal(fakePayRes.status, 400);

    // 2. Non-existent video -> 404
    const missingVidRes = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/promote", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${alex.token}`,
        },
        body: JSON.stringify({
          videoId: "vid-does-not-exist-999",
          paymentId: "pay_any",
        }),
      }),
    );
    assert.ok(missingVidRes);
    assert.equal(missingVidRes.status, 404);

    // 3. Premium ₹6 upload payment cannot be used for ads promotion -> 400
    const { paymentId: sponsorPayId } = await createVerifiedPayment({
      token: alex.token,
      userId: alex.userId,
      purpose: "premium_video_upload",
      amount: 6,
    });
    const wrongPurposePromote = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/promote", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${alex.token}`,
        },
        body: JSON.stringify({
          videoId: vidA,
          paymentId: sponsorPayId,
        }),
      }),
    );
    assert.ok(wrongPurposePromote);
    assert.equal(wrongPurposePromote.status, 400);

    // 4. Legitimate plan-7-days ads_promotion checkout for vidA
    const beforeFirstVerify = Date.now();
    const { paymentId: promo7PayId } = await createVerifiedPayment({
      token: alex.token,
      userId: alex.userId,
      purpose: "ads_promotion",
      videoId: vidA,
      planId: "plan-7-days",
      amount: 100,
    });

    // Cross-user promote by Maya on Alex's video -> 403
    const crossUserPromote = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/promote", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${maya.token}`,
        },
        body: JSON.stringify({
          videoId: vidA,
          paymentId: promo7PayId,
          planId: "plan-7-days",
        }),
      }),
    );
    assert.ok(crossUserPromote);
    assert.equal(crossUserPromote.status, 403);

    // Reusing vidA's paymentId on vidB -> 409 Conflict
    const crossVideoPromote = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/promote", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${alex.token}`,
        },
        body: JSON.stringify({
          videoId: vidB,
          paymentId: promo7PayId,
        }),
      }),
    );
    assert.ok(crossVideoPromote);
    assert.equal(crossVideoPromote.status, 409);

    // Mismatched client planId ("plan-yearly" when verified order is "plan-7-days") -> 400
    const spoofedPlanRes = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/promote", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${alex.token}`,
        },
        body: JSON.stringify({
          videoId: vidA,
          paymentId: promo7PayId,
          planId: "plan-yearly",
        }),
      }),
    );
    assert.ok(spoofedPlanRes);
    assert.equal(spoofedPlanRes.status, 400);

    // Spoofed durationDays (9999) on matching planId is ignored and payment is idempotent (no second extension!)
    const promoWithSpoofedDuration = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/promote", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${alex.token}`,
        },
        body: JSON.stringify({
          videoId: vidA,
          paymentId: promo7PayId,
          planId: "plan-7-days",
          durationDays: 9999,
        }),
      }),
    );
    assert.ok(promoWithSpoofedDuration);
    assert.equal(promoWithSpoofedDuration.status, 200);
    const promoBody1 = await promoWithSpoofedDuration.json();
    assert.equal(promoBody1.success, true);
    assert.equal(promoBody1.idempotent, true, "Already activated during payments/verify");
    assert.equal(promoBody1.promotionPlan, "plan-7-days");

    const expiry1Ms = new Date(promoBody1.promotionExpiresAt).getTime();
    const expected7DaysMs = beforeFirstVerify + 7 * 24 * 60 * 60 * 1000;
    assert.ok(
      Math.abs(expiry1Ms - expected7DaysMs) < 60_000,
      `Expiry must remain ~7 days (not extended again or 9999 days), delta=${expiry1Ms - expected7DaysMs}ms`,
    );

    // Duplicate call to videos/promote returns exact same expiry without extension
    const duplicatePromo = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/promote", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${alex.token}`,
        },
        body: JSON.stringify({
          videoId: vidA,
          paymentId: promo7PayId,
        }),
      }),
    );
    assert.ok(duplicatePromo);
    assert.equal(duplicatePromo.status, 200);
    const promoBodyDup = await duplicatePromo.json();
    assert.equal(promoBodyDup.idempotent, true);
    assert.equal(promoBodyDup.promotionExpiresAt, promoBody1.promotionExpiresAt);

    // Additive renewal with a second verified 15-day order extends expiry by +15 days (~22 days total)
    const { paymentId: promo15PayId } = await createVerifiedPayment({
      token: alex.token,
      userId: alex.userId,
      purpose: "ads_promotion",
      videoId: vidA,
      planId: "plan-15-days",
      amount: 200,
    });
    const renewalPromo = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/promote", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${alex.token}`,
        },
        body: JSON.stringify({
          videoId: vidA,
          paymentId: promo15PayId,
        }),
      }),
    );
    assert.ok(renewalPromo);
    assert.equal(renewalPromo.status, 200);
    const renewalBody = await renewalPromo.json();
    const expiry2Ms = new Date(renewalBody.promotionExpiresAt).getTime();
    const expected15AddedMs = expiry1Ms + 15 * 24 * 60 * 60 * 1000;
    assert.ok(
      Math.abs(expiry2Ms - expected15AddedMs) < 5_000,
      `Renewal should extend additively by 15 days from existing expiry`,
    );
  });

  it("7. MySQL path parity: videos/promote enforces transaction, idempotency, and server duration (ignores spoofed durationDays)", async () => {
    const alex = await loginAs("alex@facetube.com", "password123");

    let videoPromotedUpdates = 0;
    let orderAppliedUpdates = 0;
    let promotionAppliedAt: string | null = null;
    let promotionPaymentId: string | null = null;
    const baseExpiryIso = "2026-12-01T00:00:00.000Z";
    const extendedExpiryIso = "2026-12-08T00:00:00.000Z";

    const mockConn = {
      async beginTransaction() {},
      async commit() {},
      async rollback() {},
      release() {},
      async query(sql: string, params: any[] = []) {
        if (sql.includes("FROM uploaded_videos WHERE id = ? LIMIT 1 FOR UPDATE")) {
          return [
            [
              {
                id: "vid-mysql-1",
                user_id: alex.userId,
                is_promoted: promotionAppliedAt ? 1 : 0,
                promotion_plan: promotionAppliedAt ? "plan-7-days" : null,
                promotion_expires_at: promotionAppliedAt ? extendedExpiryIso : baseExpiryIso,
                promotion_payment_id: promotionPaymentId,
              },
            ],
          ];
        }
        if (sql.includes("FROM uploaded_videos WHERE promotion_payment_id = ? AND id != ?")) {
          return [[]];
        }
        if (sql.includes("FROM payment_orders WHERE payment_id = ?")) {
          return [
            [
              {
                order_id: "order_mysql_promo_1",
                payment_id: "pay_mysql_promo_1",
                user_id: alex.userId,
                purpose: "ads_promotion",
                status: "paid",
                currency: "INR",
                amount: 100.0,
                plan_id: "plan-7-days",
                video_id: "vid-mysql-1",
                promotion_applied_at: promotionAppliedAt,
              },
            ],
          ];
        }
        if (sql.includes("FROM payment_transactions WHERE payment_id = ?")) {
          return [
            [
              {
                payment_id: "pay_mysql_promo_1",
                user_id: alex.userId,
                purpose: "ads_promotion",
                amount: 100.0,
                video_id: "vid-mysql-1",
              },
            ],
          ];
        }
        if (sql.includes("UPDATE uploaded_videos")) {
          videoPromotedUpdates += 1;
          // Verify durationDays bound parameters came from authoritative plan-7-days (7), NOT client 9999
          assert.equal(params[0], "plan-7-days");
          assert.equal(params[1], 7);
          assert.equal(params[2], 7);
          assert.equal(params[3], "pay_mysql_promo_1");
          assert.equal(params[4], "vid-mysql-1");
          promotionPaymentId = "pay_mysql_promo_1";
          return [{ affectedRows: 1 }];
        }
        if (sql.includes("UPDATE payment_orders SET promotion_applied_at = NOW()")) {
          orderAppliedUpdates += 1;
          promotionAppliedAt = new Date().toISOString();
          return [{ affectedRows: 1 }];
        }
        if (sql.includes("SELECT promotion_plan, promotion_expires_at FROM uploaded_videos")) {
          return [[{ promotion_plan: "plan-7-days", promotion_expires_at: extendedExpiryIso }]];
        }
        return [[]];
      },
    };

    const mockPool = {
      async query(sql: string, params: any[] = []) {
        if (sql.includes("INFORMATION_SCHEMA.COLUMNS")) {
          return [
            [
              { TABLE_NAME: "uploaded_videos", COLUMN_NAME: "promotion_payment_id" },
              { TABLE_NAME: "payment_orders", COLUMN_NAME: "promotion_applied_at" },
            ],
          ];
        }
        if (
          sql.includes("FROM sessions") ||
          sql.includes("FROM user_sessions") ||
          sql.includes("FROM users")
        ) {
          return [[{ user_id: alex.userId, role: "user", name: "Alex Rivera", is_blocked: 0 }]];
        }
        return [[], []];
      },
      async getConnection() {
        return mockConn;
      },
    };

    const prevDbHost = process.env["DB_HOST"];
    const prevDbName = process.env["DB_NAME"];
    const prevDbUser = process.env["DB_USER"];
    process.env["DB_HOST"] = "127.0.0.1";
    process.env["DB_NAME"] = "facetube_test";
    process.env["DB_USER"] = "facetube_test";

    try {
      setMysqlPoolForTesting(mockPool);

      const firstPromote = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/promote", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${alex.token}`,
          },
          body: JSON.stringify({
            videoId: "vid-mysql-1",
            paymentId: "pay_mysql_promo_1",
            durationDays: 9999,
          }),
        }),
      );
      assert.ok(firstPromote);
      assert.equal(firstPromote.status, 200);
      const firstData = await firstPromote.json();
      assert.equal(firstData.success, true);
      assert.equal(firstData.idempotent, false);
      assert.equal(firstData.promotionPlan, "plan-7-days");
      assert.equal(videoPromotedUpdates, 1);
      assert.equal(orderAppliedUpdates, 1);

      // Second promote request with same paymentId must be idempotent and execute ZERO updates
      const secondPromote = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/promote", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${alex.token}`,
          },
          body: JSON.stringify({
            videoId: "vid-mysql-1",
            paymentId: "pay_mysql_promo_1",
            durationDays: 9999,
          }),
        }),
      );
      assert.ok(secondPromote);
      assert.equal(secondPromote.status, 200);
      const secondData = await secondPromote.json();
      assert.equal(secondData.success, true);
      assert.equal(secondData.idempotent, true);
      assert.equal(secondData.promotionExpiresAt, extendedExpiryIso);
      assert.equal(videoPromotedUpdates, 1, "Must not extend expiry a second time");
      assert.equal(orderAppliedUpdates, 1, "Must not reapply order update");
    } finally {
      setMysqlPoolForTesting(null);
      if (prevDbHost === undefined) delete process.env["DB_HOST"];
      else process.env["DB_HOST"] = prevDbHost;
      if (prevDbName === undefined) delete process.env["DB_NAME"];
      else process.env["DB_NAME"] = prevDbName;
      if (prevDbUser === undefined) delete process.env["DB_USER"];
      else process.env["DB_USER"] = prevDbUser;
    }
  });

  it("8. Static PHP/Node parity and Ads Promotion upload-mode real-video-ID regression checks", () => {
    const createPhp = fs.readFileSync(path.resolve(process.cwd(), "api/videos/create.php"), "utf8");
    const promotePhp = fs.readFileSync(
      path.resolve(process.cwd(), "api/videos/promote.php"),
      "utf8",
    );
    const adsRoute = fs.readFileSync(
      path.resolve(process.cwd(), "src/routes/ads-promotions.tsx"),
      "utf8",
    );

    // PHP videos/create.php parity checks
    assert.match(createPhp, /getAuthUser\(\$pdo,\s*true\)/);
    assert.equal(createPhp.includes("FT483921"), false, "No hardcoded FT483921 fallback");
    assert.match(
      createPhp,
      /in_array\(\$normalizedVisibility,\s*\['public',\s*'unlisted',\s*'private'\]/,
    );
    assert.match(
      createPhp,
      /SELECT id FROM uploaded_videos WHERE payment_id = \? AND id != \? LIMIT 1 FOR UPDATE/,
    );
    assert.match(createPhp, /FROM payment_orders WHERE payment_id = \? LIMIT 1 FOR UPDATE/);
    assert.match(createPhp, /FROM payment_transactions WHERE payment_id = \? LIMIT 1 FOR UPDATE/);
    assert.match(createPhp, /abs\(floatval\(\$orderRow\['amount'\] \?\? 0\) - 6\.00\)/);
    assert.match(createPhp, /\$paymentStatus = 'not_required';/);
    assert.match(createPhp, /\$paymentAmount = 0\.00;/);
    assert.equal(
      /jsonResponse\(\s*\[[^\]]*\$e->getMessage\(\)/.test(createPhp),
      false,
      "Do not leak raw exception message in create.php JSON response",
    );

    // PHP videos/promote.php parity checks
    assert.match(promotePhp, /getAuthUser\(\$pdo,\s*true\)/);
    assert.match(promotePhp, /SELECT \* FROM uploaded_videos WHERE id = \? LIMIT 1 FOR UPDATE/);
    assert.match(
      promotePhp,
      /SELECT id FROM uploaded_videos WHERE promotion_payment_id = \? AND id != \? LIMIT 1 FOR UPDATE/,
    );
    assert.match(promotePhp, /FROM payment_orders WHERE payment_id = \? LIMIT 1 FOR UPDATE/);
    assert.match(promotePhp, /FROM payment_transactions WHERE payment_id = \? LIMIT 1 FOR UPDATE/);
    assert.match(promotePhp, /\$alreadyAppliedOrder \|\| \$alreadyAppliedVideo/);
    assert.match(promotePhp, /\$durationDays = \$authoritativePlan\['days'\];/);
    assert.equal(
      promotePhp.includes("$_REQUEST['durationDays']") ||
        promotePhp.includes("$input['durationDays']"),
      false,
      "promote.php must never trust client durationDays",
    );
    assert.equal(
      /jsonResponse\(\s*\[[^\]]*\$e->getMessage\(\)/.test(promotePhp),
      false,
      "Do not leak raw exception message in promote.php JSON response",
    );

    // Ads Promotion upload-mode sequence check: no camp-vid-* IDs, creates real video before initiating payment
    assert.equal(
      adsRoute.includes("camp-vid-"),
      false,
      "ads-promotions.tsx must not synthesize fake camp-vid-* IDs",
    );
    const fnStart = adsRoute.indexOf("handleActivatePromotion");
    assert.ok(fnStart > -1);
    const fnBody = adsRoute.slice(fnStart);
    const uploadIdx = fnBody.indexOf("api.uploads.uploadVideo");
    const createIdx = fnBody.indexOf("recordNewVideoUpload");
    const payIdx = fnBody.indexOf("initiateAdsPromotionPayment");
    assert.ok(uploadIdx > -1 && createIdx > -1 && payIdx > -1);
    assert.ok(uploadIdx < createIdx, "Upload video file before persisting video record");
    assert.ok(createIdx < payIdx, "Persist real video record before initiating ads payment");
  });

  it("9. Existing private/unlisted visibility is preserved when omitted, explicit updates work, new uploads default to public, and PHP matches", async () => {
    const alex = await loginAs("alex@facetube.com", "password123");
    const admin = await loginAs("admin@facetube.com", "password");

    // 1. New video without visibility defaults to "public"
    const createNewRes = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${alex.token}`,
        },
        body: JSON.stringify({
          id: "vid-default-public-1",
          title: "Brand New Video No Visibility",
          video_url: "/uploads/videos/new_default.mp4",
          video_type: "free",
          content_type: "long",
        }),
      }),
    );
    assert.ok(createNewRes);
    assert.equal(createNewRes.status, 201);
    const createNewBody = await createNewRes.json();
    assert.equal(createNewBody.video.visibility, "public");

    // 2. Existing private video remains private when visibility is omitted (missing or blank)
    const createPrivRes = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${alex.token}`,
        },
        body: JSON.stringify({
          id: "vid-priv-preserve-1",
          title: "Initial Private Title",
          video_url: "/uploads/videos/priv_preserve.mp4",
          video_type: "free",
          content_type: "long",
          visibility: "private",
        }),
      }),
    );
    assert.ok(createPrivRes);
    assert.equal(createPrivRes.status, 201);
    assert.equal((await createPrivRes.json()).video.visibility, "private");

    const updatePrivOmittedRes = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${alex.token}`,
        },
        body: JSON.stringify({
          id: "vid-priv-preserve-1",
          title: "Updated Private Title Without Visibility",
          video_url: "/uploads/videos/priv_preserve.mp4",
          video_type: "free",
          content_type: "long",
        }),
      }),
    );
    assert.ok(updatePrivOmittedRes);
    assert.equal(updatePrivOmittedRes.status, 201);
    const updatePrivOmittedBody = await updatePrivOmittedRes.json();
    assert.equal(updatePrivOmittedBody.video.visibility, "private");
    assert.equal(updatePrivOmittedBody.video.title, "Updated Private Title Without Visibility");

    // 3. Existing unlisted video remains unlisted when visibility is omitted or whitespace
    const createUnlistedRes = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${alex.token}`,
        },
        body: JSON.stringify({
          id: "vid-unlisted-preserve-1",
          title: "Initial Unlisted Title",
          video_url: "/uploads/videos/unlisted_preserve.mp4",
          video_type: "free",
          content_type: "short",
          visibility: "unlisted",
        }),
      }),
    );
    assert.ok(createUnlistedRes);
    assert.equal(createUnlistedRes.status, 201);

    const updateUnlistedOmittedRes = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${alex.token}`,
        },
        body: JSON.stringify({
          id: "vid-unlisted-preserve-1",
          title: "Updated Unlisted Title",
          video_url: "/uploads/videos/unlisted_preserve.mp4",
          video_type: "free",
          content_type: "short",
          visibility: "   ",
        }),
      }),
    );
    assert.ok(updateUnlistedOmittedRes);
    assert.equal(updateUnlistedOmittedRes.status, 201);
    assert.equal((await updateUnlistedOmittedRes.json()).video.visibility, "unlisted");

    // 4. Explicit public/private/unlisted transitions continue working (including Admin update)
    for (const nextVis of ["unlisted", "public", "private"] as const) {
      const explicitRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${alex.token}`,
          },
          body: JSON.stringify({
            id: "vid-priv-preserve-1",
            title: `Explicit Transition (${nextVis})`,
            video_url: "/uploads/videos/priv_preserve.mp4",
            video_type: "free",
            content_type: "long",
            visibility: nextVis,
          }),
        }),
      );
      assert.ok(explicitRes);
      assert.equal(explicitRes.status, 201);
      assert.equal((await explicitRes.json()).video.visibility, nextVis);
    }

    // Admin updating owner's private video without visibility must preserve owner and private visibility
    const adminUpdateOmitted = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${admin.token}`,
        },
        body: JSON.stringify({
          id: "vid-priv-preserve-1",
          title: "Admin Moderated Title",
          video_url: "/uploads/videos/priv_preserve.mp4",
          video_type: "free",
          content_type: "long",
        }),
      }),
    );
    assert.ok(adminUpdateOmitted);
    assert.equal(adminUpdateOmitted.status, 201);
    const adminBody = await adminUpdateOmitted.json();
    assert.equal(adminBody.video.user_id, alex.userId);
    assert.equal(adminBody.video.visibility, "private");

    // Public list must still exclude private & unlisted videos
    const publicListRes = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/list?video_type=free&limit=50"),
    );
    assert.ok(publicListRes);
    const publicIds = ((await publicListRes.json()).videos || []).map((v: any) => v.id);
    assert.equal(publicIds.includes("vid-default-public-1"), true);
    assert.equal(publicIds.includes("vid-priv-preserve-1"), false);
    assert.equal(publicIds.includes("vid-unlisted-preserve-1"), false);

    // 5. MySQL path preserves existing private visibility when visibility is omitted
    let capturedInsertVisibility: string | null = null;
    const mockMysqlConn = {
      async beginTransaction() {},
      async commit() {},
      async rollback() {},
      release() {},
      async query(sql: string, params: any[] = []) {
        if (sql.includes("FROM uploaded_videos") && sql.includes("FOR UPDATE")) {
          return [
            [
              {
                id: "vid-mysql-priv-1",
                user_id: alex.userId,
                visibility: "private",
                payment_status: "not_required",
                payment_id: null,
                payment_amount: 0,
                is_promoted: 0,
                promotion_plan: null,
                promotion_expires_at: null,
                views: 5,
                likes: 1,
                created_at: "2026-11-22T00:00:00.000Z",
              },
            ],
          ];
        }
        if (sql.includes("INSERT INTO uploaded_videos")) {
          capturedInsertVisibility = String(params[14] ?? "");
          return [{ affectedRows: 1 }];
        }
        return [[]];
      },
    };
    const mockMysqlPool = {
      async query(sql: string) {
        if (
          sql.includes("FROM sessions") ||
          sql.includes("FROM user_sessions") ||
          sql.includes("FROM users")
        ) {
          return [[{ user_id: alex.userId, role: "user", name: "Alex Rivera", is_blocked: 0 }]];
        }
        return [[], []];
      },
      async getConnection() {
        return mockMysqlConn;
      },
    };

    const prevDbHost = process.env["DB_HOST"];
    const prevDbName = process.env["DB_NAME"];
    const prevDbUser = process.env["DB_USER"];
    process.env["DB_HOST"] = "127.0.0.1";
    process.env["DB_NAME"] = "facetube_test";
    process.env["DB_USER"] = "facetube_test";

    try {
      setMysqlPoolForTesting(mockMysqlPool);
      const mysqlUpdateRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${alex.token}`,
          },
          body: JSON.stringify({
            id: "vid-mysql-priv-1",
            title: "MySQL Private Update Without Visibility",
            video_url: "/uploads/videos/mysql_priv.mp4",
            video_type: "free",
            content_type: "long",
          }),
        }),
      );
      assert.ok(mysqlUpdateRes);
      assert.equal(mysqlUpdateRes.status, 201);
      const mysqlBody = await mysqlUpdateRes.json();
      assert.equal(capturedInsertVisibility, "private");
      assert.equal(mysqlBody.video.visibility, "private");
    } finally {
      setMysqlPoolForTesting(null);
      if (prevDbHost === undefined) delete process.env["DB_HOST"];
      else process.env["DB_HOST"] = prevDbHost;
      if (prevDbName === undefined) delete process.env["DB_NAME"];
      else process.env["DB_NAME"] = prevDbName;
      if (prevDbUser === undefined) delete process.env["DB_USER"];
      else process.env["DB_USER"] = prevDbUser;
    }

    // 6. PHP create.php parity check
    const createPhp = fs.readFileSync(path.resolve(process.cwd(), "api/videos/create.php"), "utf8");
    assert.match(createPhp, /\$hasExplicitVisibility\s*=/);
    assert.match(createPhp, /SELECT\s+id,\s*user_id,\s*visibility,/);
    assert.match(createPhp, /if\s*\(\s*!\$hasExplicitVisibility\s*\)/);
    assert.match(createPhp, /\$existingVideo\['visibility'\]/);
  });
});
