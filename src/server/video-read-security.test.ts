import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { handleApiRequest, resetInMemoryStore } from "./api-handler";
import { setMysqlPoolForTesting } from "./mysql";

const TEST_KEY_ID = "rzp_test_Step3BReadSec";
const TEST_SECRET = "test_secret_step3b_video_read_987654321";

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

async function createVerifiedSponsorPayment(params: {
  token: string;
  userId: string;
  videoId: string;
}): Promise<string> {
  const orderRes = await handleApiRequest(
    new Request("http://localhost:3000/api/payments/create-order", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.token}`,
      },
      body: JSON.stringify({
        purpose: "premium_video_upload",
        userId: params.userId,
        videoId: params.videoId,
      }),
    }),
    RZP_ENV,
  );
  assert.ok(orderRes);
  assert.equal(orderRes.status, 200);
  const orderBody = await orderRes.json();
  const orderId = orderBody.orderId as string;

  const paymentId = `pay_3b_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
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
        purpose: "premium_video_upload",
        videoId: params.videoId,
        amount: 6,
      }),
    }),
    RZP_ENV,
  );
  assert.ok(verifyRes);
  assert.equal(verifyRes.status, 200);
  return paymentId;
}

async function createVideo(token: string, payload: Record<string, unknown>): Promise<any> {
  const res = await handleApiRequest(
    new Request("http://localhost:3000/api/videos/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    }),
    RZP_ENV,
  );
  assert.ok(res);
  assert.equal(res.status, 201, `createVideo failed: ${res.status}`);
  const data = await res.json();
  return data.video;
}

async function setVideoBlocked(
  adminToken: string,
  videoId: string,
  isBlocked: boolean,
  reason = "Moderation policy violation",
) {
  const res = await handleApiRequest(
    new Request("http://localhost:3000/api/admin/videos", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ videoId, isBlocked, reason }),
    }),
  );
  assert.ok(res);
  assert.equal(res.status, 200);
}

function injectStoreVideos(fixtures: Array<Record<string, unknown>>) {
  const storePath = path.resolve(process.cwd(), "data/facetube_store.json");
  const raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
  const now = new Date().toISOString();
  for (const f of fixtures) {
    raw.videos.push({
      description: "",
      thumbnail_url: "",
      category: "General",
      duration: "1:00",
      views: 0,
      likes: 0,
      payment_id: null,
      payment_amount: 0,
      is_promoted: false,
      visibility: "public",
      created_at: now,
      updated_at: now,
      ...f,
    });
  }
  fs.writeFileSync(storePath, JSON.stringify(raw, null, 2), "utf8");
  resetInMemoryStore();
}

describe("Phase 2B Step 3B: Secure Video Read Endpoints (list, get, counts)", () => {
  const storePath = path.resolve(process.cwd(), "data/facetube_store.json");
  let storeSnapshot: string | null = null;
  let storeExisted = false;

  beforeEach(() => {
    storeExisted = fs.existsSync(storePath);
    storeSnapshot = storeExisted ? fs.readFileSync(storePath, "utf8") : null;
    if (fs.existsSync(storePath)) {
      fs.unlinkSync(storePath);
    }
    resetInMemoryStore();
    setMysqlPoolForTesting(null);
  });

  afterEach(() => {
    setMysqlPoolForTesting(null);
    if (storeExisted && storeSnapshot !== null) {
      fs.writeFileSync(storePath, storeSnapshot, "utf8");
    } else if (fs.existsSync(storePath)) {
      fs.unlinkSync(storePath);
    }
    resetInMemoryStore();
  });

  it("1. Public videos/list returns eligible public videos from multiple creators and excludes private, unlisted, blocked, and unpaid Sponsor videos", async () => {
    const alex = await loginAs("alex@facetube.com", "password123");
    const maya = await loginAs("maya@facetube.com", "password123");
    const admin = await loginAs("admin@facetube.com", "password123");

    // Create eligible public videos across two creators
    await createVideo(alex.token, {
      id: "vid-alex-public",
      title: "Alex Public Tutorial",
      video_url: "https://example.com/alex-pub.mp4",
      video_type: "free",
      content_type: "long",
      visibility: "public",
    });

    const mayaSponsorPayId = await createVerifiedSponsorPayment({
      token: maya.token,
      userId: maya.userId,
      videoId: "vid-maya-public-paid",
    });
    await createVideo(maya.token, {
      id: "vid-maya-public-paid",
      title: "Maya Paid Sponsor Video",
      video_url: "https://example.com/maya-paid.mp4",
      video_type: "premium",
      content_type: "short",
      visibility: "public",
      payment_id: mayaSponsorPayId,
      payment_status: "paid",
      payment_amount: 6,
    });

    // Create excluded videos: private, unlisted, unpaid pending Sponsor, failed Sponsor, blocked public
    await createVideo(alex.token, {
      id: "vid-alex-private",
      title: "Alex Private Draft",
      video_url: "https://example.com/alex-priv.mp4",
      video_type: "free",
      content_type: "long",
      visibility: "private",
    });
    await createVideo(alex.token, {
      id: "vid-alex-unlisted",
      title: "Alex Unlisted Share",
      video_url: "https://example.com/alex-unlisted.mp4",
      video_type: "free",
      content_type: "short",
      visibility: "unlisted",
    });
    injectStoreVideos([
      {
        id: "vid-alex-unpaid-sponsor",
        user_id: alex.userId,
        creator_name: "Alex Rivera",
        title: "Alex Pending Sponsor",
        video_url: "https://example.com/alex-pending.mp4",
        video_type: "premium",
        content_type: "long",
        visibility: "public",
        payment_status: "pending",
      },
      {
        id: "vid-maya-failed-sponsor",
        user_id: maya.userId,
        creator_name: "Maya Lin",
        title: "Maya Failed Sponsor",
        video_url: "https://example.com/maya-failed.mp4",
        video_type: "premium",
        content_type: "long",
        visibility: "public",
        payment_status: "failed",
      },
    ]);
    await createVideo(alex.token, {
      id: "vid-alex-blocked",
      title: "Alex Blocked Public",
      video_url: "https://example.com/alex-blocked.mp4",
      video_type: "free",
      content_type: "long",
      visibility: "public",
    });
    await setVideoBlocked(admin.token, "vid-alex-blocked", true);

    const listRes = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/list?limit=100", { method: "GET" }),
    );
    assert.ok(listRes);
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    const ids = new Set((listData.videos as any[]).map((v) => v.id));

    assert.equal(ids.has("vid-alex-public"), true);
    assert.equal(ids.has("vid-maya-public-paid"), true);
    assert.equal(ids.has("vid-alex-private"), false, "private excluded from public list");
    assert.equal(ids.has("vid-alex-unlisted"), false, "unlisted excluded from public list");
    assert.equal(
      ids.has("vid-alex-unpaid-sponsor"),
      false,
      "unpaid Sponsor excluded from public list",
    );
    assert.equal(
      ids.has("vid-maya-failed-sponsor"),
      false,
      "failed Sponsor excluded from public list",
    );
    assert.equal(ids.has("vid-alex-blocked"), false, "blocked excluded from public list");

    const alexPub = listData.videos.find((v: any) => v.id === "vid-alex-public");
    assert.equal(alexPub.visibility, "public");
  });

  it("2. Authenticated owner sees own private, unlisted, and pending Sponsor videos while cross-user filter hides them", async () => {
    const alex = await loginAs("alex@facetube.com", "password123");
    const maya = await loginAs("maya@facetube.com", "password123");
    const admin = await loginAs("admin@facetube.com", "password123");

    await createVideo(alex.token, {
      id: "vid-own-pub",
      title: "Own Public",
      video_url: "https://example.com/opub.mp4",
      visibility: "public",
    });
    await createVideo(alex.token, {
      id: "vid-own-priv",
      title: "Own Private",
      video_url: "https://example.com/opriv.mp4",
      visibility: "private",
    });
    await createVideo(alex.token, {
      id: "vid-own-unl",
      title: "Own Unlisted",
      video_url: "https://example.com/ounl.mp4",
      visibility: "unlisted",
    });
    injectStoreVideos([
      {
        id: "vid-own-pend",
        user_id: alex.userId,
        creator_name: "Alex Rivera",
        title: "Own Pending Sponsor",
        video_url: "https://example.com/opend.mp4",
        video_type: "premium",
        content_type: "long",
        visibility: "public",
        payment_status: "pending",
      },
    ]);
    await createVideo(alex.token, {
      id: "vid-own-blk",
      title: "Own Blocked",
      video_url: "https://example.com/oblk.mp4",
      visibility: "public",
    });
    await setVideoBlocked(admin.token, "vid-own-blk", true);

    // Owner dashboard request: sees private, unlisted, pending Sponsor (but not blocked without admin include_blocked)
    const ownerRes = await handleApiRequest(
      new Request(`http://localhost:3000/api/videos/list?userId=${alex.userId}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${alex.token}` },
      }),
    );
    assert.ok(ownerRes);
    assert.equal(ownerRes.status, 200);
    const ownerData = await ownerRes.json();
    const ownerIds = new Set((ownerData.videos as any[]).map((v) => v.id));
    assert.equal(ownerIds.has("vid-own-pub"), true);
    assert.equal(ownerIds.has("vid-own-priv"), true);
    assert.equal(ownerIds.has("vid-own-unl"), true);
    assert.equal(ownerIds.has("vid-own-pend"), true);
    assert.equal(ownerIds.has("vid-own-blk"), false);

    // Another authenticated user filtering ?userId=FT483921 must ONLY see eligible public videos
    const otherRes = await handleApiRequest(
      new Request(`http://localhost:3000/api/videos/list?userId=${alex.userId}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${maya.token}` },
      }),
    );
    assert.ok(otherRes);
    assert.equal(otherRes.status, 200);
    const otherData = await otherRes.json();
    const otherIds = new Set((otherData.videos as any[]).map((v) => v.id));
    assert.equal(otherIds.has("vid-own-pub"), true);
    assert.equal(otherIds.has("vid-own-priv"), false);
    assert.equal(otherIds.has("vid-own-unl"), false);
    assert.equal(otherIds.has("vid-own-pend"), false);
    assert.equal(otherIds.has("vid-own-blk"), false);
  });

  it("3. Enforces include_blocked=1 and includeBlocked=1 as Admin-only (401 unauth, 403 non-admin, 200 Admin)", async () => {
    const alex = await loginAs("alex@facetube.com", "password123");
    const admin = await loginAs("admin@facetube.com", "password123");

    await createVideo(alex.token, {
      id: "vid-mod-blocked",
      title: "Moderation Target",
      video_url: "https://example.com/mod.mp4",
      visibility: "public",
    });
    await setVideoBlocked(admin.token, "vid-mod-blocked", true, "Copyright strike");

    for (const param of ["include_blocked=1", "includeBlocked=1"]) {
      // Unauthenticated -> 401
      const unauthList = await handleApiRequest(
        new Request(`http://localhost:3000/api/videos/list?${param}`, { method: "GET" }),
      );
      assert.equal(unauthList?.status, 401, `list?${param} without auth must return 401`);

      const unauthCounts = await handleApiRequest(
        new Request(`http://localhost:3000/api/videos/counts?${param}`, { method: "GET" }),
      );
      assert.equal(unauthCounts?.status, 401, `counts?${param} without auth must return 401`);

      // Non-admin authenticated -> 403
      const userList = await handleApiRequest(
        new Request(`http://localhost:3000/api/videos/list?${param}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${alex.token}` },
        }),
      );
      assert.equal(userList?.status, 403, `list?${param} as non-admin must return 403`);

      const userCounts = await handleApiRequest(
        new Request(`http://localhost:3000/api/videos/counts?${param}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${alex.token}` },
        }),
      );
      assert.equal(userCounts?.status, 403, `counts?${param} as non-admin must return 403`);

      // Admin -> 200 and includes blocked video
      const adminList = await handleApiRequest(
        new Request(`http://localhost:3000/api/videos/list?${param}&limit=100`, {
          method: "GET",
          headers: { Authorization: `Bearer ${admin.token}` },
        }),
      );
      assert.equal(adminList?.status, 200, `list?${param} as admin must return 200`);
      const adminData = await adminList!.json();
      const blockedItem = adminData.videos.find((v: any) => v.id === "vid-mod-blocked");
      assert.ok(blockedItem, `admin list?${param} must include blocked video`);
      assert.equal(blockedItem.isBlocked, true);
      assert.equal(blockedItem.blockReason, "Copyright strike");

      const adminCounts = await handleApiRequest(
        new Request(`http://localhost:3000/api/videos/counts?${param}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${admin.token}` },
        }),
      );
      assert.equal(adminCounts?.status, 200, `counts?${param} as admin must return 200`);
    }
  });

  it("4. videos/get enforces direct access rules (blocked 403 even for owner, private & unpaid Sponsor owner/admin only, unlisted direct public) and NEVER increments views on denial", async () => {
    const alex = await loginAs("alex@facetube.com", "password123");
    const maya = await loginAs("maya@facetube.com", "password123");
    const admin = await loginAs("admin@facetube.com", "password123");

    await createVideo(alex.token, {
      id: "vid-get-priv",
      title: "Private Video",
      video_url: "https://example.com/priv.mp4",
      visibility: "private",
    });
    await createVideo(alex.token, {
      id: "vid-get-unl",
      title: "Unlisted Video",
      video_url: "https://example.com/unl.mp4",
      visibility: "unlisted",
    });
    injectStoreVideos([
      {
        id: "vid-get-unpaid",
        user_id: alex.userId,
        creator_name: "Alex Rivera",
        title: "Unpaid Sponsor",
        video_url: "https://example.com/unpaid.mp4",
        video_type: "premium",
        content_type: "long",
        visibility: "public",
        payment_status: "pending",
      },
    ]);
    await createVideo(alex.token, {
      id: "vid-get-blk",
      title: "Blocked Video",
      video_url: "https://example.com/blk.mp4",
      visibility: "public",
    });
    await setVideoBlocked(admin.token, "vid-get-blk", true);

    // Blocked video: 403 for unauth, other user, owner, and admin by default
    for (const headers of [
      {},
      { Authorization: `Bearer ${maya.token}` },
      { Authorization: `Bearer ${alex.token}` },
      { Authorization: `Bearer ${admin.token}` },
    ]) {
      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/get?id=vid-get-blk", {
          method: "GET",
          headers,
        }),
      );
      assert.equal(res?.status, 403, "Blocked video must return 403 for everyone");
    }

    // Private video: 401 unauth, 403 non-owner -> views must remain 0
    const privUnauth = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/get?id=vid-get-priv", { method: "GET" }),
    );
    assert.equal(privUnauth?.status, 401);

    const privOther = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/get?id=vid-get-priv", {
        method: "GET",
        headers: { Authorization: `Bearer ${maya.token}` },
      }),
    );
    assert.equal(privOther?.status, 403);

    // Owner access succeeds and views becomes 1 (proving the 2 denied calls did NOT increment views)
    const privOwner = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/get?id=vid-get-priv", {
        method: "GET",
        headers: { Authorization: `Bearer ${alex.token}` },
      }),
    );
    assert.equal(privOwner?.status, 200);
    const privOwnerData = await privOwner!.json();
    assert.equal(privOwnerData.video.visibility, "private");
    assert.equal(privOwnerData.video.views, 1, "Denied requests must NOT have incremented views");

    // Admin access to private video also succeeds and increments views to 2
    const privAdmin = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/get?id=vid-get-priv", {
        method: "GET",
        headers: { Authorization: `Bearer ${admin.token}` },
      }),
    );
    assert.equal(privAdmin?.status, 200);
    const privAdminData = await privAdmin!.json();
    assert.equal(privAdminData.video.views, 2);

    // Unpaid Sponsor video: 401 unauth, 403 non-owner -> views remains 0 until owner accesses it
    const unpaidUnauth = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/get?id=vid-get-unpaid", { method: "GET" }),
    );
    assert.equal(unpaidUnauth?.status, 401);

    const unpaidOther = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/get?id=vid-get-unpaid", {
        method: "GET",
        headers: { Authorization: `Bearer ${maya.token}` },
      }),
    );
    assert.equal(unpaidOther?.status, 403);

    const unpaidOwner = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/get?id=vid-get-unpaid", {
        method: "GET",
        headers: { Authorization: `Bearer ${alex.token}` },
      }),
    );
    assert.equal(unpaidOwner?.status, 200);
    const unpaidOwnerData = await unpaidOwner!.json();
    assert.equal(
      unpaidOwnerData.video.views,
      1,
      "Denied requests for unpaid Sponsor must NOT increment views",
    );

    // Unlisted eligible video: unauthenticated direct ID access succeeds (200) and increments views
    const unlPublicGet = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/get?id=vid-get-unl", { method: "GET" }),
    );
    assert.equal(unlPublicGet?.status, 200);
    const unlData = await unlPublicGet!.json();
    assert.equal(unlData.video.visibility, "unlisted");
    assert.equal(unlData.video.views, 1);

    // Seeded eligible public video remains accessible without login
    const pubSeedGet = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/get?id=vid-seed-001", { method: "GET" }),
    );
    assert.equal(pubSeedGet?.status, 200);
  });

  it("5. videos/counts excludes hidden/blocked/unpaid videos publicly, includes owner's non-blocked items, and follows Admin moderation rules", async () => {
    const alex = await loginAs("alex@facetube.com", "password123");
    const maya = await loginAs("maya@facetube.com", "password123");
    const admin = await loginAs("admin@facetube.com", "password123");

    // Baseline public counts for Alex (seed data has 1 free short + 1 free long for FT483921? Let's measure baseline first)
    const basePubRes = await handleApiRequest(
      new Request(`http://localhost:3000/api/videos/counts?userId=${alex.userId}`, {
        method: "GET",
      }),
    );
    assert.equal(basePubRes?.status, 200);
    const basePub = (await basePubRes!.json()).counts;

    // Add 1 private free short, 1 unlisted free long, 1 unpaid premium short, 1 blocked public free short
    await createVideo(alex.token, {
      id: "vid-cnt-priv",
      title: "Cnt Private",
      video_url: "https://example.com/c1.mp4",
      video_type: "free",
      content_type: "short",
      visibility: "private",
    });
    await createVideo(alex.token, {
      id: "vid-cnt-unl",
      title: "Cnt Unlisted",
      video_url: "https://example.com/c2.mp4",
      video_type: "free",
      content_type: "long",
      visibility: "unlisted",
    });
    injectStoreVideos([
      {
        id: "vid-cnt-unpaid",
        user_id: alex.userId,
        creator_name: "Alex Rivera",
        title: "Cnt Unpaid Sponsor",
        video_url: "https://example.com/c3.mp4",
        video_type: "premium",
        content_type: "short",
        visibility: "public",
        payment_status: "pending",
      },
    ]);
    await createVideo(alex.token, {
      id: "vid-cnt-blk",
      title: "Cnt Blocked",
      video_url: "https://example.com/c4.mp4",
      video_type: "free",
      content_type: "short",
      visibility: "public",
    });
    await setVideoBlocked(admin.token, "vid-cnt-blk", true);

    // Public counts for Alex must be unchanged
    const afterPubRes = await handleApiRequest(
      new Request(`http://localhost:3000/api/videos/counts?userId=${alex.userId}`, {
        method: "GET",
      }),
    );
    const afterPub = (await afterPubRes!.json()).counts;
    assert.deepEqual(
      afterPub,
      basePub,
      "Public counts must exclude private, unlisted, unpaid, blocked",
    );

    // Cross-user authenticated counts (Maya querying Alex's userId) must also equal public counts
    const crossRes = await handleApiRequest(
      new Request(`http://localhost:3000/api/videos/counts?userId=${alex.userId}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${maya.token}` },
      }),
    );
    const crossCounts = (await crossRes!.json()).counts;
    assert.deepEqual(crossCounts, basePub);

    // Owner counts for Alex must include the 3 non-blocked private/unlisted/pending videos, excluding blocked
    const ownerRes = await handleApiRequest(
      new Request(`http://localhost:3000/api/videos/counts?userId=${alex.userId}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${alex.token}` },
      }),
    );
    const ownerCounts = (await ownerRes!.json()).counts;
    assert.equal(ownerCounts.freeShort, basePub.freeShort + 1);
    assert.equal(ownerCounts.freeLong, basePub.freeLong + 1);
    assert.equal(ownerCounts.premiumShort, basePub.premiumShort + 1);
    assert.equal(ownerCounts.totalUploaded, basePub.totalUploaded + 3);

    // Admin counts without include_blocked MUST match public eligible counts; with include_blocked=1 returns full moderation totals (+1 blocked freeShort)
    const adminNoBlkRes = await handleApiRequest(
      new Request(`http://localhost:3000/api/videos/counts?userId=${alex.userId}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${admin.token}` },
      }),
    );
    const adminNoBlk = (await adminNoBlkRes!.json()).counts;
    assert.deepEqual(
      adminNoBlk,
      basePub,
      "Admin counts without include_blocked must enforce public visibility/payment/block filters",
    );

    const adminWithBlkRes = await handleApiRequest(
      new Request(
        `http://localhost:3000/api/videos/counts?userId=${alex.userId}&include_blocked=1`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${admin.token}` },
        },
      ),
    );
    const adminWithBlk = (await adminWithBlkRes!.json()).counts;
    assert.equal(adminWithBlk.freeShort, ownerCounts.freeShort + 1);
    assert.equal(adminWithBlk.totalUploaded, ownerCounts.totalUploaded + 1);
  });

  it("6. Production Node MySQL pool behavior: videos/counts queries MySQL (no JSON fallback) and fails closed with 503/500, and videos/get skips UPDATE on denial", async () => {
    const alex = await loginAs("alex@facetube.com", "password123");
    const prodEnv = { APP_ENV: "production", NODE_ENV: "production" };

    // 1) Fail closed 503 when pool unavailable in production
    const noPoolCounts = await handleApiRequest(
      new Request("https://facetube.online/api/videos/counts", { method: "GET" }),
      prodEnv,
    );
    assert.equal(noPoolCounts?.status, 503);

    const prevDbHost = process.env["DB_HOST"];
    const prevDbName = process.env["DB_NAME"];
    const prevDbUser = process.env["DB_USER"];
    process.env["DB_HOST"] = "127.0.0.1";
    process.env["DB_NAME"] = "facetube_prod";
    process.env["DB_USER"] = "prod_user";

    let viewUpdateCalls = 0;
    let lastCountsSql = "";

    const mockPool: any = {
      query: async (sql: string, params: any[] = []) => {
        if (sql.includes("FROM sessions") && sql.includes("JOIN users")) {
          // Return Alex session for bearer token validation
          return [
            [
              {
                token: alex.token,
                user_id: alex.userId,
                id: "a0000000-0000-0000-0000-000000000002",
                name: "Alex Rivera",
                email: "alex@facetube.com",
                role: "user",
                expires_at: new Date(Date.now() + 3600_000).toISOString(),
              },
            ],
            [],
          ];
        }
        if (sql.includes("FROM uploaded_videos") && sql.includes("AS freeShort")) {
          lastCountsSql = sql;
          return [
            [
              {
                freeShort: 2,
                freeLong: 3,
                premiumShort: 1,
                premiumLong: 4,
              },
            ],
            [],
          ];
        }
        if (sql.includes("FROM uploaded_videos v") && sql.includes("WHERE v.id = ?")) {
          const vid = params[0];
          if (vid === "mysql-priv-1") {
            return [
              [
                {
                  id: "mysql-priv-1",
                  user_id: "FT900431",
                  creator_name: "Maya Lin",
                  title: "Private MySQL Video",
                  video_url: "https://example.com/mp.mp4",
                  video_type: "free",
                  content_type: "long",
                  visibility: "private",
                  payment_status: "not_required",
                  payment_amount: 0,
                  views: 5,
                  likes: 0,
                  is_blocked: 0,
                  is_promoted: 0,
                },
              ],
              [],
            ];
          }
          if (vid === "mysql-pub-1") {
            return [
              [
                {
                  id: "mysql-pub-1",
                  user_id: "FT900431",
                  creator_name: "Maya Lin",
                  title: "Public MySQL Video",
                  video_url: "https://example.com/mpub.mp4",
                  video_type: "free",
                  content_type: "long",
                  visibility: "public",
                  payment_status: "not_required",
                  payment_amount: 0,
                  views: 5,
                  likes: 0,
                  is_blocked: 0,
                  is_promoted: 0,
                },
              ],
              [],
            ];
          }
          return [[], []];
        }
        if (sql.includes("UPDATE uploaded_videos SET views = views + 1")) {
          viewUpdateCalls++;
          return [{ affectedRows: 1 }, []];
        }
        return [[], []];
      },
    };

    try {
      setMysqlPoolForTesting(mockPool);

      // Healthy MySQL counts returns pool numbers (not JSON store)
      const mysqlCountsRes = await handleApiRequest(
        new Request("https://facetube.online/api/videos/counts", { method: "GET" }),
        prodEnv,
      );
      assert.equal(mysqlCountsRes?.status, 200);
      const mysqlCountsData = await mysqlCountsRes!.json();
      assert.deepEqual(mysqlCountsData.counts, {
        freeShort: 2,
        freeLong: 3,
        premiumShort: 1,
        premiumLong: 4,
        totalFree: 5,
        totalPremium: 5,
        totalUploaded: 10,
      });
      assert.match(lastCountsSql, /COALESCE\(is_blocked, 0\) = 0/);
      assert.match(lastCountsSql, /COALESCE\(NULLIF\(visibility, ''\), 'public'\) = 'public'/);

      // Denied private get by non-owner Alex -> 403 and ZERO UPDATE views queries
      const deniedGet = await handleApiRequest(
        new Request("https://facetube.online/api/videos/get?id=mysql-priv-1", {
          method: "GET",
          headers: { Authorization: `Bearer ${alex.token}` },
        }),
        prodEnv,
      );
      assert.equal(deniedGet?.status, 403);
      assert.equal(viewUpdateCalls, 0, "MySQL view UPDATE must NOT execute on 403");

      // Authorized public get -> 200 and ONE UPDATE views query
      const allowedGet = await handleApiRequest(
        new Request("https://facetube.online/api/videos/get?id=mysql-pub-1", { method: "GET" }),
        prodEnv,
      );
      assert.equal(allowedGet?.status, 200);
      const allowedData = await allowedGet!.json();
      assert.equal(allowedData.video.views, 6);
      assert.equal(viewUpdateCalls, 1);

      // Failing MySQL counts query in production -> 500
      setMysqlPoolForTesting({
        query: async () => {
          throw new Error("Simulated MySQL failure");
        },
      } as any);
      const errCountsRes = await handleApiRequest(
        new Request("https://facetube.online/api/videos/counts", { method: "GET" }),
        prodEnv,
      );
      assert.equal(errCountsRes?.status, 500);
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

  it("7. Static PHP/Node parity checks for api/videos/list.php, api/videos/get.php, and api/videos/counts.php", () => {
    const listPhp = fs.readFileSync(path.resolve(process.cwd(), "api/videos/list.php"), "utf8");
    const getPhp = fs.readFileSync(path.resolve(process.cwd(), "api/videos/get.php"), "utf8");
    const countsPhp = fs.readFileSync(path.resolve(process.cwd(), "api/videos/counts.php"), "utf8");

    for (const [name, src] of [
      ["list.php", listPhp],
      ["get.php", getPhp],
      ["counts.php", countsPhp],
    ] as const) {
      assert.match(src, /getAuthUser\(\$pdo,\s*true\)/, `${name} must use optional getAuthUser`);
      assert.match(src, /isConnectionUnavailable/, `${name} must distinguish 503 vs 500 DB errors`);
      assert.equal(
        /jsonResponse\(\s*\[[^\]]*\$e->getMessage\(\)/.test(src) ||
          /jsonResponse\(\s*\[[^\]]*\$authErr->getMessage\(\)/.test(src),
        false,
        `${name} must not leak raw exception messages in JSON responses`,
      );
    }

    // list.php parity (Step 3D-A: Admin isolation & fail-closed visibility)
    assert.match(listPhp, /include_blocked/);
    assert.match(listPhp, /includeBlocked/);
    assert.match(listPhp, /COALESCE\(v\.is_blocked, 0\) = 0/);
    assert.match(listPhp, /COALESCE\(NULLIF\(v\.visibility, ''\), 'public'\) = 'public'/);
    assert.match(listPhp, /'visibility'\s*=>\s*\$visibility/);
    assert.match(listPhp, /if\s*\(\s*!\$isOwnerFilter\s*&&\s*!\(\$isAdmin\s*&&\s*\$includeBlocked\)\s*\)/);
    assert.match(listPhp, /\$visibility\s*=\s*'private'/);

    // get.php parity: blocked + private + unpaid checks BEFORE view increment + fail-closed visibility
    const blockedCheckIdx = getPhp.indexOf("!empty($row['is_blocked'])");
    const privateCheckIdx = getPhp.indexOf("$visibility === 'private'");
    const paymentCheckIdx = getPhp.indexOf("!$isPaymentEligible");
    const viewUpdateIdx = getPhp.indexOf("UPDATE uploaded_videos SET views = views + 1");
    assert.ok(
      blockedCheckIdx > -1 && privateCheckIdx > -1 && paymentCheckIdx > -1 && viewUpdateIdx > -1,
    );
    assert.ok(
      blockedCheckIdx < viewUpdateIdx,
      "get.php must check is_blocked before incrementing views",
    );
    assert.ok(
      privateCheckIdx < viewUpdateIdx,
      "get.php must check private visibility before incrementing views",
    );
    assert.ok(
      paymentCheckIdx < viewUpdateIdx,
      "get.php must check payment eligibility before incrementing views",
    );
    assert.match(getPhp, /'visibility'\s*=>\s*\$visibility/);
    assert.match(getPhp, /\$visibility\s*=\s*'private'/);

    // counts.php parity: excludes unpaid premium, private, unlisted, blocked; supports include_blocked/includeBlocked; isolates Admin public counts
    assert.match(countsPhp, /include_blocked/);
    assert.match(countsPhp, /includeBlocked/);
    assert.match(countsPhp, /COALESCE\(is_blocked, 0\) = 0/);
    assert.match(countsPhp, /COALESCE\(NULLIF\(visibility, ''\), 'public'\) = 'public'/);
    assert.match(countsPhp, /video_type = 'premium' AND payment_status = 'paid'/);
    assert.match(
      countsPhp,
      /if\s*\(\s*!\$isOwnerCounts\s*&&\s*!\(\$isAdmin\s*&&\s*\$includeBlocked\)\s*\)/,
    );
  });

  it("8. Step 3D-A: Logged-in Admin receives only eligible public videos on normal feeds/counts while preserving include_blocked=1 and /api/admin/videos moderation", async () => {
    const alex = await loginAs("alex@facetube.com", "password123");
    const admin = await loginAs("admin@facetube.com", "password123");

    await createVideo(alex.token, {
      id: "vid-3da-pub-free",
      title: "3DA Public Free",
      video_url: "https://example.com/3da-pub-free.mp4",
      video_type: "free",
      content_type: "long",
      visibility: "public",
    });

    const sponsorPayId = await createVerifiedSponsorPayment({
      token: alex.token,
      userId: alex.userId,
      videoId: "vid-3da-pub-paid-sponsor",
    });
    await createVideo(alex.token, {
      id: "vid-3da-pub-paid-sponsor",
      title: "3DA Public Paid Sponsor",
      video_url: "https://example.com/3da-paid.mp4",
      video_type: "premium",
      content_type: "short",
      visibility: "public",
      payment_id: sponsorPayId,
      payment_status: "paid",
      payment_amount: 6,
    });

    await createVideo(alex.token, {
      id: "vid-3da-priv",
      title: "3DA Private",
      video_url: "https://example.com/3da-priv.mp4",
      video_type: "free",
      content_type: "long",
      visibility: "private",
    });
    await createVideo(alex.token, {
      id: "vid-3da-unl",
      title: "3DA Unlisted",
      video_url: "https://example.com/3da-unl.mp4",
      video_type: "free",
      content_type: "short",
      visibility: "unlisted",
    });
    await createVideo(alex.token, {
      id: "vid-3da-blk",
      title: "3DA Blocked",
      video_url: "https://example.com/3da-blk.mp4",
      video_type: "free",
      content_type: "long",
      visibility: "public",
    });
    await setVideoBlocked(admin.token, "vid-3da-blk", true, "Moderation test");

    injectStoreVideos([
      {
        id: "vid-3da-unpaid-pend",
        user_id: alex.userId,
        creator_name: "Alex Rivera",
        title: "3DA Pending Sponsor",
        video_url: "https://example.com/3da-pend.mp4",
        video_type: "premium",
        content_type: "long",
        visibility: "public",
        payment_status: "pending",
      },
      {
        id: "vid-3da-unpaid-nr",
        user_id: alex.userId,
        creator_name: "Alex Rivera",
        title: "3DA NotRequired Sponsor",
        video_url: "https://example.com/3da-nr.mp4",
        video_type: "premium",
        content_type: "long",
        visibility: "public",
        payment_status: "not_required",
      },
    ]);

    // 1) Admin calling normal public videos/list (all, userId=alex, videoType=free, videoType=premium) without include_blocked
    for (const url of [
      "http://localhost:3000/api/videos/list?limit=100",
      `http://localhost:3000/api/videos/list?userId=${alex.userId}&limit=100`,
    ]) {
      const res = await handleApiRequest(
        new Request(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${admin.token}` },
        }),
      );
      assert.equal(res?.status, 200);
      const data = await res!.json();
      const ids = new Set((data.videos as any[]).map((v) => v.id));

      assert.equal(ids.has("vid-3da-pub-free"), true);
      assert.equal(ids.has("vid-3da-pub-paid-sponsor"), true);
      assert.equal(ids.has("vid-3da-priv"), false, `Admin normal feed must hide private (${url})`);
      assert.equal(ids.has("vid-3da-unl"), false, `Admin normal feed must hide unlisted (${url})`);
      assert.equal(ids.has("vid-3da-blk"), false, `Admin normal feed must hide blocked (${url})`);
      assert.equal(
        ids.has("vid-3da-unpaid-pend"),
        false,
        `Admin normal feed must hide pending Sponsor (${url})`,
      );
      assert.equal(
        ids.has("vid-3da-unpaid-nr"),
        false,
        `Admin normal feed must hide not_required Sponsor (${url})`,
      );
    }

    const adminPremRes = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/list?videoType=premium&limit=100", {
        method: "GET",
        headers: { Authorization: `Bearer ${admin.token}` },
      }),
    );
    const adminPremIds = new Set(((await adminPremRes!.json()).videos as any[]).map((v) => v.id));
    assert.equal(adminPremIds.has("vid-3da-pub-paid-sponsor"), true);
    assert.equal(adminPremIds.has("vid-3da-unpaid-pend"), false);
    assert.equal(adminPremIds.has("vid-3da-unpaid-nr"), false);

    // 2) Admin global videos/counts without include_blocked equals unauthenticated global counts
    const pubCountsRes = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/counts", { method: "GET" }),
    );
    const adminCountsRes = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/counts", {
        method: "GET",
        headers: { Authorization: `Bearer ${admin.token}` },
      }),
    );
    assert.deepEqual((await adminCountsRes!.json()).counts, (await pubCountsRes!.json()).counts);

    // 3) Admin moderation scope WITH include_blocked=1 and /api/admin/videos remain intact
    const modListRes = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/list?include_blocked=1&limit=100", {
        method: "GET",
        headers: { Authorization: `Bearer ${admin.token}` },
      }),
    );
    assert.equal(modListRes?.status, 200);
    const modIds = new Set(((await modListRes!.json()).videos as any[]).map((v) => v.id));
    assert.equal(modIds.has("vid-3da-blk"), true);
    assert.equal(modIds.has("vid-3da-priv"), true);
    assert.equal(modIds.has("vid-3da-unl"), true);

    const adminEndpointRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/videos?limit=100", {
        method: "GET",
        headers: { Authorization: `Bearer ${admin.token}` },
      }),
    );
    assert.equal(adminEndpointRes?.status, 200);
    const adminEndpointIds = new Set(
      ((await adminEndpointRes!.json()).videos as any[]).map((v) => v.id),
    );
    assert.equal(adminEndpointIds.has("vid-3da-blk"), true);
  });

  it("9. Step 3D-A: Unknown or corrupted non-empty visibility values fail closed to private in list, counts, and get", async () => {
    const alex = await loginAs("alex@facetube.com", "password123");
    const maya = await loginAs("maya@facetube.com", "password123");
    const admin = await loginAs("admin@facetube.com", "password123");

    const baseCountsRes = await handleApiRequest(
      new Request(`http://localhost:3000/api/videos/counts?userId=${alex.userId}`, {
        method: "GET",
      }),
    );
    const baseCounts = (await baseCountsRes!.json()).counts;

    injectStoreVideos([
      {
        id: "vid-corrupt-vis-1",
        user_id: alex.userId,
        creator_name: "Alex Rivera",
        title: "Corrupted Visibility Video",
        video_url: "https://example.com/corrupt.mp4",
        video_type: "free",
        content_type: "long",
        visibility: "draft_legacy_unknown",
        payment_status: "not_required",
        views: 0,
      },
    ]);

    // Excluded from public, cross-user, and Admin normal list
    for (const headers of [
      {},
      { Authorization: `Bearer ${maya.token}` },
      { Authorization: `Bearer ${admin.token}` },
    ]) {
      const listRes = await handleApiRequest(
        new Request(`http://localhost:3000/api/videos/list?userId=${alex.userId}&limit=100`, {
          method: "GET",
          headers,
        }),
      );
      const ids = new Set(((await listRes!.json()).videos as any[]).map((v) => v.id));
      assert.equal(ids.has("vid-corrupt-vis-1"), false);
    }

    // Excluded from public and Admin normal counts
    const afterPubCounts = await handleApiRequest(
      new Request(`http://localhost:3000/api/videos/counts?userId=${alex.userId}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${admin.token}` },
      }),
    );
    assert.deepEqual((await afterPubCounts!.json()).counts, baseCounts);

    // videos/get denies unauth (401) and non-owner (403) without incrementing views
    const unauthGet = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/get?id=vid-corrupt-vis-1", { method: "GET" }),
    );
    assert.equal(unauthGet?.status, 401);

    const otherGet = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/get?id=vid-corrupt-vis-1", {
        method: "GET",
        headers: { Authorization: `Bearer ${maya.token}` },
      }),
    );
    assert.equal(otherGet?.status, 403);

    // Owner and Admin receive fail-closed visibility: "private", proving denied calls didn't increment views
    const ownerGet = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/get?id=vid-corrupt-vis-1", {
        method: "GET",
        headers: { Authorization: `Bearer ${alex.token}` },
      }),
    );
    assert.equal(ownerGet?.status, 200);
    const ownerVideo = (await ownerGet!.json()).video;
    assert.equal(ownerVideo.visibility, "private");
    assert.equal(ownerVideo.views, 1);

    // Production MySQL path fail-closed check for corrupted visibility
    const prodEnv = { APP_ENV: "production", NODE_ENV: "production" };
    const prevDbHost = process.env["DB_HOST"];
    const prevDbName = process.env["DB_NAME"];
    const prevDbUser = process.env["DB_USER"];
    process.env["DB_HOST"] = "127.0.0.1";
    process.env["DB_NAME"] = "facetube_prod";
    process.env["DB_USER"] = "prod_user";
    let mysqlUpdates = 0;

    setMysqlPoolForTesting({
      query: async (sql: string, params: any[] = []) => {
        if (sql.includes("FROM sessions") && sql.includes("JOIN users")) {
          const tok = params[0];
          const isAdm = tok === admin.token;
          return [
            [
              {
                token: tok,
                user_id: isAdm ? admin.userId : alex.userId,
                id: isAdm ? "adm-1" : "alex-1",
                name: isAdm ? "Admin" : "Alex",
                email: isAdm ? "admin@facetube.com" : "alex@facetube.com",
                role: isAdm ? "admin" : "user",
                expires_at: new Date(Date.now() + 3600_000).toISOString(),
              },
            ],
            [],
          ];
        }
        if (sql.includes("FROM uploaded_videos v") && sql.includes("WHERE v.id = ?")) {
          return [
            [
              {
                id: "mysql-corrupt-1",
                user_id: "FT900431",
                creator_name: "Maya Lin",
                title: "MySQL Corrupt Vis",
                video_url: "https://example.com/mc.mp4",
                video_type: "free",
                content_type: "long",
                visibility: "corrupted_status",
                payment_status: "not_required",
                payment_amount: 0,
                views: 4,
                likes: 0,
                is_blocked: 0,
                is_promoted: 0,
              },
            ],
            [],
          ];
        }
        if (sql.includes("UPDATE uploaded_videos SET views = views + 1")) {
          mysqlUpdates += 1;
          return [{ affectedRows: 1 }, []];
        }
        return [[], []];
      },
    } as any);

    try {
      const mysqlDenied = await handleApiRequest(
        new Request("https://facetube.online/api/videos/get?id=mysql-corrupt-1", {
          method: "GET",
          headers: { Authorization: `Bearer ${alex.token}` },
        }),
        prodEnv,
      );
      assert.equal(mysqlDenied?.status, 403);
      assert.equal(mysqlUpdates, 0);

      const mysqlAdmin = await handleApiRequest(
        new Request("https://facetube.online/api/videos/get?id=mysql-corrupt-1", {
          method: "GET",
          headers: { Authorization: `Bearer ${admin.token}` },
        }),
        prodEnv,
      );
      assert.equal(mysqlAdmin?.status, 200);
      assert.equal((await mysqlAdmin!.json()).video.visibility, "private");
      assert.equal(mysqlUpdates, 1);
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

  it("10. Step 3D-A: Public Shorts query (?contentType=short) returns only eligible public Shorts and excludes long, private, unlisted, blocked, and unpaid Sponsor Shorts", async () => {
    const alex = await loginAs("alex@facetube.com", "password123");
    const admin = await loginAs("admin@facetube.com", "password123");

    await createVideo(alex.token, {
      id: "vid-short-pub-free",
      title: "Public Free Short",
      video_url: "https://example.com/s1.mp4",
      video_type: "free",
      content_type: "short",
      visibility: "public",
    });

    const paidShortPayId = await createVerifiedSponsorPayment({
      token: alex.token,
      userId: alex.userId,
      videoId: "vid-short-pub-paid-sponsor",
    });
    await createVideo(alex.token, {
      id: "vid-short-pub-paid-sponsor",
      title: "Public Paid Sponsor Short",
      video_url: "https://example.com/s2.mp4",
      video_type: "premium",
      content_type: "short",
      visibility: "public",
      payment_id: paidShortPayId,
      payment_status: "paid",
      payment_amount: 6,
    });

    await createVideo(alex.token, {
      id: "vid-long-pub-free",
      title: "Public Free Long",
      video_url: "https://example.com/l1.mp4",
      video_type: "free",
      content_type: "long",
      visibility: "public",
    });
    await createVideo(alex.token, {
      id: "vid-short-priv",
      title: "Private Short",
      video_url: "https://example.com/s3.mp4",
      video_type: "free",
      content_type: "short",
      visibility: "private",
    });
    await createVideo(alex.token, {
      id: "vid-short-unl",
      title: "Unlisted Short",
      video_url: "https://example.com/s4.mp4",
      video_type: "free",
      content_type: "short",
      visibility: "unlisted",
    });
    await createVideo(alex.token, {
      id: "vid-short-blk",
      title: "Blocked Short",
      video_url: "https://example.com/s5.mp4",
      video_type: "free",
      content_type: "short",
      visibility: "public",
    });
    await setVideoBlocked(admin.token, "vid-short-blk", true);

    injectStoreVideos([
      {
        id: "vid-short-unpaid-sponsor",
        user_id: alex.userId,
        creator_name: "Alex Rivera",
        title: "Unpaid Sponsor Short",
        video_url: "https://example.com/s6.mp4",
        video_type: "premium",
        content_type: "short",
        visibility: "public",
        payment_status: "not_required",
      },
    ]);

    for (const headers of [{}, { Authorization: `Bearer ${admin.token}` }]) {
      const shortsRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/list?contentType=short&limit=100", {
          method: "GET",
          headers,
        }),
      );
      assert.equal(shortsRes?.status, 200);
      const shorts = (await shortsRes!.json()).videos as any[];
      const ids = new Set(shorts.map((v) => v.id));

      assert.equal(ids.has("vid-short-pub-free"), true);
      assert.equal(ids.has("vid-short-pub-paid-sponsor"), true);
      assert.equal(ids.has("vid-long-pub-free"), false, "Long video must be excluded from Shorts");
      assert.equal(ids.has("vid-short-priv"), false, "Private short must be excluded");
      assert.equal(ids.has("vid-short-unl"), false, "Unlisted short must be excluded");
      assert.equal(ids.has("vid-short-blk"), false, "Blocked short must be excluded");
      assert.equal(ids.has("vid-short-unpaid-sponsor"), false, "Unpaid Sponsor short excluded");
    }
  });
});
