import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleApiRequest, resetInMemoryStore } from "./api-handler.ts";
import { setMysqlPoolForTesting } from "./mysql.ts";
import { api } from "../lib/api.ts";
import {
  getOwnerStoredVideos,
  getStoredVideos,
  saveOwnerStoredVideos,
  saveStoredVideos,
  updateVideoVisibility,
  type UploadedVideo,
} from "../lib/video-service.ts";

const TEST_KEY_ID = "rzp_test_Point6Visibility";
const TEST_SECRET = "test_secret_point6_visibility_1234567890";

const RZP_ENV: Record<string, string> = {
  RAZORPAY_KEY_ID: TEST_KEY_ID,
  RAZORPAY_KEY_SECRET: TEST_SECRET,
  RAZORPAY_SKIP_REMOTE_CHECK: "true",
};

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
}

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
  const data = (await res.json()) as {
    token?: string;
    user?: { user_id?: string; userId?: string };
  };
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
  const orderBody = (await orderRes.json()) as { orderId: string };
  const orderId = orderBody.orderId;

  const paymentId = `pay_p6_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
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

async function createVideo(
  token: string,
  payload: Record<string, unknown>,
): Promise<Record<string, any>> {
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
  assert.equal(res.status, 201, `createVideo failed with status ${res.status}`);
  const data = (await res.json()) as { video: Record<string, any> };
  return data.video;
}

describe("Point 6: Cross-User Video Visibility & Safe Visibility Management", () => {
  let tempDataDir = "";
  let prevDataDir: string | undefined;

  const originalWindow = (globalThis as Record<string, unknown>)["window"];
  const originalLocalStorage = (globalThis as Record<string, unknown>)["localStorage"];
  const originalUpdateVisibility = api.videos.updateVisibility;

  beforeEach(() => {
    prevDataDir = process.env["FACETUBE_DATA_DIR"];
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-point6-vis-"));
    process.env["FACETUBE_DATA_DIR"] = tempDataDir;
    resetInMemoryStore();
    setMysqlPoolForTesting(null);
  });

  afterEach(() => {
    setMysqlPoolForTesting(null);
    api.videos.updateVisibility = originalUpdateVisibility;
    if (originalWindow === undefined) {
      delete (globalThis as Record<string, unknown>)["window"];
    } else {
      (globalThis as Record<string, unknown>)["window"] = originalWindow;
    }
    if (originalLocalStorage === undefined) {
      delete (globalThis as Record<string, unknown>)["localStorage"];
    } else {
      (globalThis as Record<string, unknown>)["localStorage"] = originalLocalStorage;
    }

    if (prevDataDir === undefined) {
      delete process.env["FACETUBE_DATA_DIR"];
    } else {
      process.env["FACETUBE_DATA_DIR"] = prevDataDir;
    }
    resetInMemoryStore();
    if (tempDataDir && fs.existsSync(tempDataDir)) {
      fs.rmSync(tempDataDir, { recursive: true, force: true });
    }
  });

  it("1. User A uploads public Free and paid Sponsor videos -> visible to User B & anonymous while unpaid Sponsor remains excluded", async () => {
    const userA = await loginAs("alex@facetube.com", "password123");
    const userB = await loginAs("maya@facetube.com", "password123");

    await createVideo(userA.token, {
      id: "vid-p6-a-free-pub",
      title: "User A Public Free Upload",
      video_url: "https://example.com/p6-free.mp4",
      video_type: "free",
      content_type: "long",
      visibility: "public",
    });

    const paidSponsorId = await createVerifiedSponsorPayment({
      token: userA.token,
      userId: userA.userId,
      videoId: "vid-p6-a-sponsor-paid",
    });
    await createVideo(userA.token, {
      id: "vid-p6-a-sponsor-paid",
      title: "User A Paid Sponsor Upload",
      video_url: "https://example.com/p6-sponsor-paid.mp4",
      video_type: "premium",
      content_type: "short",
      visibility: "public",
      payment_id: paidSponsorId,
      payment_status: "paid",
      payment_amount: 6,
    });

    // Inject an unpaid Sponsor video marked public directly into store to verify exclusion
    const storePath = path.join(tempDataDir, "facetube_store.json");
    const rawStore = JSON.parse(fs.readFileSync(storePath, "utf8")) as {
      videos: Array<Record<string, unknown>>;
    };
    rawStore.videos.push({
      id: "vid-p6-a-sponsor-unpaid",
      user_id: userA.userId,
      creator_name: "Alex Rivera",
      title: "Unpaid Public Sponsor",
      video_url: "https://example.com/p6-unpaid.mp4",
      video_type: "premium",
      content_type: "long",
      visibility: "public",
      payment_status: "pending",
      payment_amount: 6,
      is_promoted: false,
      views: 0,
      likes: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    fs.writeFileSync(storePath, JSON.stringify(rawStore, null, 2), "utf8");
    resetInMemoryStore();

    for (const headers of [{}, { Authorization: `Bearer ${userB.token}` }]) {
      const listRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/list?limit=50", {
          method: "GET",
          headers,
        }),
      );
      assert.equal(listRes?.status, 200);
      const listData = (await listRes!.json()) as { videos: Array<{ id: string }> };
      const ids = new Set(listData.videos.map((v) => v.id));

      assert.equal(ids.has("vid-p6-a-free-pub"), true);
      assert.equal(ids.has("vid-p6-a-sponsor-paid"), true);
      assert.equal(ids.has("vid-p6-a-sponsor-unpaid"), false);

      const channelRes = await handleApiRequest(
        new Request(`http://localhost:3000/api/videos/list?userId=${userA.userId}&limit=50`, {
          method: "GET",
          headers,
        }),
      );
      assert.equal(channelRes?.status, 200);
      const channelIds = new Set(
        ((await channelRes!.json()) as { videos: Array<{ id: string }> }).videos.map((v) => v.id),
      );
      assert.equal(channelIds.has("vid-p6-a-free-pub"), true);
      assert.equal(channelIds.has("vid-p6-a-sponsor-paid"), true);
      assert.equal(channelIds.has("vid-p6-a-sponsor-unpaid"), false);

      const getPaidRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/get?id=vid-p6-a-sponsor-paid", {
          method: "GET",
          headers,
        }),
      );
      assert.equal(getPaidRes?.status, 200);

      const getUnpaidRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/get?id=vid-p6-a-sponsor-unpaid", {
          method: "GET",
          headers,
        }),
      );
      assert.ok(getUnpaidRes);
      assert.equal(getUnpaidRes.status, "Authorization" in headers ? 403 : 401);
    }
  });

  it("2. Creator toggling private -> public -> unlisted -> private updates discovery and direct watch access immediately", async () => {
    const userA = await loginAs("alex@facetube.com", "password123");
    const userB = await loginAs("maya@facetube.com", "password123");

    await createVideo(userA.token, {
      id: "vid-p6-lifecycle",
      title: "Lifecycle Visibility Video",
      video_url: "https://example.com/p6-lifecycle.mp4",
      video_type: "free",
      content_type: "long",
      visibility: "private",
    });

    // Initially private -> hidden from User B & anonymous
    const anonListPrivate = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/list?limit=50"),
    );
    assert.equal(
      ((await anonListPrivate!.json()) as { videos: Array<{ id: string }> }).videos.some(
        (v) => v.id === "vid-p6-lifecycle",
      ),
      false,
    );
    const bGetPrivate = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/get?id=vid-p6-lifecycle", {
        headers: { Authorization: `Bearer ${userB.token}` },
      }),
    );
    assert.equal(bGetPrivate?.status, 403);

    // Owner sets visibility -> public
    const toPublicRes = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/visibility.php", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({ videoId: "vid-p6-lifecycle", visibility: "public" }),
      }),
    );
    assert.equal(toPublicRes?.status, 200);
    assert.equal(
      ((await toPublicRes!.json()) as { video: { visibility: string } }).video.visibility,
      "public",
    );

    // Visible in public feeds and direct watch for User B & anonymous
    const bListPublic = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/list?limit=50", {
        headers: { Authorization: `Bearer ${userB.token}` },
      }),
    );
    assert.equal(
      ((await bListPublic!.json()) as { videos: Array<{ id: string }> }).videos.some(
        (v) => v.id === "vid-p6-lifecycle",
      ),
      true,
    );
    const anonGetPublic = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/get?id=vid-p6-lifecycle"),
    );
    assert.equal(anonGetPublic?.status, 200);

    // Owner sets visibility -> unlisted (excluded from list, allowed on direct watch)
    const toUnlistedRes = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/visibility", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({ videoId: "vid-p6-lifecycle", visibility: "unlisted" }),
      }),
    );
    assert.equal(toUnlistedRes?.status, 200);
    const anonListUnlisted = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/list?limit=50"),
    );
    assert.equal(
      ((await anonListUnlisted!.json()) as { videos: Array<{ id: string }> }).videos.some(
        (v) => v.id === "vid-p6-lifecycle",
      ),
      false,
    );
    const bGetUnlisted = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/get?id=vid-p6-lifecycle", {
        headers: { Authorization: `Bearer ${userB.token}` },
      }),
    );
    assert.equal(bGetUnlisted?.status, 200);

    // Owner sets visibility -> private again
    const toPrivateRes = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/visibility", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({ videoId: "vid-p6-lifecycle", visibility: "private" }),
      }),
    );
    assert.equal(toPrivateRes?.status, 200);
    const anonGetAfterPrivate = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/get?id=vid-p6-lifecycle"),
    );
    assert.equal(anonGetAfterPrivate?.status, 401);
  });

  it("3. Visibility endpoint enforces auth (401/403), validation (400), 404, 503 fail-closed production, blocked rules, and preserves payment/promotion fields", async () => {
    const userA = await loginAs("alex@facetube.com", "password123");
    const userB = await loginAs("maya@facetube.com", "password123");
    const admin = await loginAs("admin@facetube.com", "password123");

    const sponsorPayId = await createVerifiedSponsorPayment({
      token: userA.token,
      userId: userA.userId,
      videoId: "vid-p6-protected-1",
    });

    await createVideo(userA.token, {
      id: "vid-p6-protected-1",
      title: "Protected Paid Video",
      video_url: "https://example.com/p6-prot.mp4",
      video_type: "premium",
      content_type: "long",
      visibility: "private",
      payment_id: sponsorPayId,
      payment_status: "paid",
      payment_amount: 6,
    });

    // Inject active promotion metadata to confirm visibility updates do not mutate it
    const storePath = path.join(tempDataDir, "facetube_store.json");
    const rawStore = JSON.parse(fs.readFileSync(storePath, "utf8")) as {
      videos: Array<Record<string, unknown>>;
    };
    const futureExpiry = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
    const targetRow = rawStore.videos.find((v) => v["id"] === "vid-p6-protected-1");
    assert.ok(targetRow);
    targetRow["is_promoted"] = true;
    targetRow["promotion_plan"] = "plan-7-days";
    targetRow["promotion_expires_at"] = futureExpiry;
    fs.writeFileSync(storePath, JSON.stringify(rawStore, null, 2), "utf8");
    resetInMemoryStore();

    // Unauthenticated -> 401
    const unauthRes = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/visibility", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: "vid-p6-protected-1", visibility: "public" }),
      }),
    );
    assert.equal(unauthRes?.status, 401);

    // Other user -> 403
    const userBRes = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/visibility", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userB.token}`,
        },
        body: JSON.stringify({ videoId: "vid-p6-protected-1", visibility: "public" }),
      }),
    );
    assert.equal(userBRes?.status, 403);

    // Invalid visibility -> 400
    for (const badVis of ["", "everyone", "draft"]) {
      const badVisRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/visibility", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userA.token}`,
          },
          body: JSON.stringify({ videoId: "vid-p6-protected-1", visibility: badVis }),
        }),
      );
      assert.equal(badVisRes?.status, 400);
    }

    // Missing video -> 404
    const notFoundRes = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/visibility", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({ videoId: "vid-does-not-exist", visibility: "public" }),
      }),
    );
    assert.equal(notFoundRes?.status, 404);

    // Production env without MySQL pool -> 503
    const prodNoMysqlRes = await handleApiRequest(
      new Request("https://facetube.online/api/videos/visibility", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({ videoId: "vid-p6-protected-1", visibility: "public" }),
      }),
      { APP_ENV: "production", NODE_ENV: "production" },
    );
    assert.equal(prodNoMysqlRes?.status, 503);

    // Admin individually publishes User A's private paid Sponsor video -> succeeds and preserves financial/promotion fields
    const adminPublishRes = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/visibility", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${admin.token}`,
        },
        body: JSON.stringify({ videoId: "vid-p6-protected-1", visibility: "public" }),
      }),
    );
    assert.equal(adminPublishRes?.status, 200);
    const publishedData = (await adminPublishRes!.json()) as { video: Record<string, unknown> };
    assert.equal(publishedData.video["visibility"], "public");
    assert.equal(publishedData.video["payment_status"], "paid");
    assert.equal(publishedData.video["payment_id"], sponsorPayId);
    assert.equal(publishedData.video["payment_amount"], 6);
    assert.equal(publishedData.video["video_type"], "premium");
    assert.equal(publishedData.video["user_id"], userA.userId);
    assert.equal(publishedData.video["is_promoted"], true);
    assert.equal(publishedData.video["promotion_plan"], "plan-7-days");
    assert.equal(publishedData.video["promotion_expires_at"], futureExpiry);

    // Block the video -> creator cannot change visibility (403) and admin cannot publish directly (409)
    const blockRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/videos", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${admin.token}`,
        },
        body: JSON.stringify({
          videoId: "vid-p6-protected-1",
          isBlocked: true,
          reason: "Policy check",
        }),
      }),
    );
    assert.equal(blockRes?.status, 200);

    const ownerOnBlocked = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/visibility", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({ videoId: "vid-p6-protected-1", visibility: "private" }),
      }),
    );
    assert.equal(ownerOnBlocked?.status, 403);

    const adminPublishBlocked = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/visibility", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${admin.token}`,
        },
        body: JSON.stringify({ videoId: "vid-p6-protected-1", visibility: "public" }),
      }),
    );
    assert.equal(adminPublishBlocked?.status, 409);

    // Verify still blocked in videos/get
    const blockedGet = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/get?id=vid-p6-protected-1", {
        headers: { Authorization: `Bearer ${admin.token}` },
      }),
    );
    assert.equal(blockedGet?.status, 403);
  });

  it("4. Corrupted stored visibility fails closed to private in videos/create update, with PHP parity", async () => {
    const userA = await loginAs("alex@facetube.com", "password123");

    const storePath = path.join(tempDataDir, "facetube_store.json");
    const rawStore = JSON.parse(fs.readFileSync(storePath, "utf8")) as {
      videos: Array<Record<string, unknown>>;
    };
    rawStore.videos.push({
      id: "vid-p6-corrupt-vis",
      user_id: userA.userId,
      creator_name: "Alex Rivera",
      title: "Corrupted Initial",
      description: "",
      video_url: "https://example.com/corrupt.mp4",
      thumbnail_url: "",
      video_type: "free",
      content_type: "long",
      category: "Coding",
      duration: "2:00",
      views: 0,
      likes: 0,
      payment_status: "not_required",
      payment_amount: 0,
      is_promoted: false,
      visibility: "legacy_corrupted_state",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    fs.writeFileSync(storePath, JSON.stringify(rawStore, null, 2), "utf8");
    resetInMemoryStore();

    const updateRes = await handleApiRequest(
      new Request("http://localhost:3000/api/videos/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({
          id: "vid-p6-corrupt-vis",
          title: "Corrupted Updated Metadata Only",
          video_url: "https://example.com/corrupt.mp4",
          video_type: "free",
          content_type: "long",
        }),
      }),
    );
    assert.equal(updateRes?.status, 201);
    const updatedBody = (await updateRes!.json()) as { video: { visibility: string } };
    assert.equal(updatedBody.video.visibility, "private");

    // Static PHP parity checks
    const createPhp = fs.readFileSync(path.resolve(process.cwd(), "api/videos/create.php"), "utf8");
    assert.match(
      createPhp,
      /in_array\(\$existingVisibility,\s*\['public',\s*'unlisted',\s*'private'\],\s*true\)\s*\?\s*\$existingVisibility\s*:\s*'private'/,
    );

    const visPhp = fs.readFileSync(
      path.resolve(process.cwd(), "api/videos/visibility.php"),
      "utf8",
    );
    assert.match(visPhp, /getAuthUser\(\$pdo,\s*true\)/);
    assert.match(
      visPhp,
      /UPDATE uploaded_videos SET visibility = \?, updated_at = NOW\(\) WHERE id = \?/,
    );
    assert.match(visPhp, /is_blocked/);
    assert.equal(/jsonResponse\(\s*\[[^\]]*\$(e|authErr)->getMessage\(\)/.test(visPhp), false);

    const adminPhp = fs.readFileSync(path.resolve(process.cwd(), "api/admin/videos.php"), "utf8");
    assert.match(adminPhp, /payment_status,\s*visibility/);
    assert.equal(/jsonResponse\(\s*\[[^\]]*\$(e|authErr)->getMessage\(\)/.test(adminPhp), false);
  });

  it("5. Admin GET /api/admin/videos returns visibility & payment_status across MySQL pool and non-prod store", async () => {
    const userA = await loginAs("alex@facetube.com", "password123");
    const admin = await loginAs("admin@facetube.com", "password123");

    // Non-prod auth checks on /api/admin/videos
    const unauthAdminRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/videos", { method: "GET" }),
    );
    assert.equal(unauthAdminRes?.status, 401);

    const nonAdminRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/videos", {
        method: "GET",
        headers: { Authorization: `Bearer ${userA.token}` },
      }),
    );
    assert.equal(nonAdminRes?.status, 403);

    let queriedSql = "";
    let updatedParams: unknown[] = [];
    const mockConn = {
      async beginTransaction() {},
      async commit() {},
      async rollback() {},
      release() {},
      async query(sql: string, params: unknown[] = []) {
        if (sql.includes("FROM uploaded_videos") && sql.includes("FOR UPDATE")) {
          return [
            [
              {
                id: "vid-mysql-vis-1",
                user_id: userA.userId,
                creator_name: "Alex Rivera",
                title: "MySQL Private Video",
                video_url: "https://example.com/mysql.mp4",
                thumbnail_url: "",
                video_type: "premium",
                content_type: "long",
                category: "Coding",
                duration: "5:00",
                views: 12,
                likes: 3,
                payment_status: "paid",
                payment_id: "pay_mysql_1",
                payment_amount: 6,
                is_promoted: 1,
                promotion_plan: "plan-7-days",
                promotion_expires_at: "2027-01-01T00:00:00.000Z",
                visibility: "private",
                is_blocked: 0,
                created_at: "2026-11-22T00:00:00.000Z",
              },
            ],
          ];
        }
        if (sql.includes("UPDATE uploaded_videos SET visibility = ?")) {
          updatedParams = params;
          return [{ affectedRows: 1 }];
        }
        return [[]];
      },
    };
    const mockPool = {
      async query(sql: string) {
        if (sql.includes("FROM sessions") || sql.includes("FROM users")) {
          return [[{ user_id: admin.userId, role: "admin", name: "Admin", is_blocked: 0 }]];
        }
        if (sql.includes("FROM uploaded_videos")) {
          queriedSql = sql;
          return [
            [
              {
                id: "vid-mysql-vis-1",
                user_id: userA.userId,
                creator_name: "Alex Rivera",
                title: "MySQL Private Video",
                video_url: "https://example.com/mysql.mp4",
                thumbnail_url: "",
                video_type: "premium",
                content_type: "long",
                category: "Coding",
                duration: "5:00",
                views: 12,
                likes: 3,
                payment_status: "paid",
                visibility: "private",
                is_promoted: 1,
                is_blocked: 0,
                created_at: "2026-11-22T00:00:00.000Z",
              },
            ],
          ];
        }
        return [[]];
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

      const adminListRes = await handleApiRequest(
        new Request("https://facetube.online/api/admin/videos", {
          method: "GET",
          headers: { Authorization: `Bearer ${admin.token}` },
        }),
        { APP_ENV: "production", NODE_ENV: "production" },
      );
      assert.equal(adminListRes?.status, 200);
      assert.match(queriedSql, /payment_status/);
      assert.match(queriedSql, /visibility/);
      const adminListBody = (await adminListRes!.json()) as {
        videos: Array<{
          id: string;
          visibility: string;
          payment_status: string;
          is_blocked: boolean;
        }>;
      };
      assert.equal(adminListBody.videos[0]?.visibility, "private");
      assert.equal(adminListBody.videos[0]?.payment_status, "paid");
      assert.equal(adminListBody.videos[0]?.is_blocked, false);

      // Admin updates visibility in MySQL production mode
      const mysqlVisRes = await handleApiRequest(
        new Request("https://facetube.online/api/videos/visibility", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${admin.token}`,
          },
          body: JSON.stringify({ videoId: "vid-mysql-vis-1", visibility: "public" }),
        }),
        { APP_ENV: "production", NODE_ENV: "production" },
      );
      assert.equal(mysqlVisRes?.status, 200);
      assert.deepEqual(updatedParams, ["public", "vid-mysql-vis-1"]);
      const mysqlVisBody = (await mysqlVisRes!.json()) as {
        video: { visibility: string; payment_status: string; is_promoted: boolean };
      };
      assert.equal(mysqlVisBody.video.visibility, "public");
      assert.equal(mysqlVisBody.video.payment_status, "paid");
      assert.equal(mysqlVisBody.video.is_promoted, true);
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

  it("6. Frontend updateVideoVisibility reconciles public & owner caches only on server confirmation", async () => {
    const storage = createMemoryStorage();
    (globalThis as Record<string, unknown>)["window"] = {};
    (globalThis as Record<string, unknown>)["localStorage"] = storage;

    storage.setItem(
      "facetube_session_v2",
      JSON.stringify({
        user: { id: "FT111111", user_id: "FT111111" },
        profile: { id: "FT111111", user_id: "FT111111" },
        dbUser: { id: "FT111111", user_id: "FT111111", role: "user" },
        role: "user",
        token: "tok-ft111111",
      }),
    );
    storage.setItem("facetube_auth_token", "tok-ft111111");

    const baseVideo: UploadedVideo = {
      id: "vid-cache-vis-1",
      userId: "FT111111",
      creatorName: "Creator",
      title: "Cache Visibility Test",
      description: "",
      videoUrl: "https://example.com/cache.mp4",
      thumbnailUrl: "https://example.com/cache.jpg",
      videoType: "free",
      contentType: "long",
      category: "Coding",
      duration: "1:00",
      views: 0,
      likes: 0,
      paymentStatus: "not_required",
      paymentAmount: 0,
      isPromoted: false,
      visibility: "public",
      createdAt: "2026-11-22T00:00:00.000Z",
      updatedAt: "2026-11-22T00:00:00.000Z",
    };

    saveStoredVideos([baseVideo]);
    saveOwnerStoredVideos("FT111111", [baseVideo]);

    // Failed API call must NOT mutate caches
    api.videos.updateVisibility = async () => {
      throw new Error("Server rejected update");
    };
    await assert.rejects(
      () => updateVideoVisibility({ videoId: "vid-cache-vis-1", visibility: "private" }),
      /Server rejected update/,
    );
    assert.equal(
      getStoredVideos().some((v) => v.id === "vid-cache-vis-1"),
      true,
    );

    // Confirmed private update removes from public cache and updates owner cache
    api.videos.updateVisibility = async () => ({
      success: true,
      video: {
        id: "vid-cache-vis-1",
        user_id: "FT111111",
        creator_name: "Creator",
        title: "Cache Visibility Test",
        video_url: "https://example.com/cache.mp4",
        thumbnail_url: "https://example.com/cache.jpg",
        video_type: "free",
        content_type: "long",
        category: "Coding",
        duration: "1:00",
        payment_status: "not_required",
        visibility: "private",
        created_at: "2026-11-22T00:00:00.000Z",
        updated_at: "2026-11-23T00:00:00.000Z",
      },
    });
    const privateRes = await updateVideoVisibility({
      videoId: "vid-cache-vis-1",
      visibility: "private",
    });
    assert.equal(privateRes.visibility, "private");
    assert.equal(
      getStoredVideos().some((v) => v.id === "vid-cache-vis-1"),
      false,
    );
    assert.equal(getOwnerStoredVideos("FT111111")?.[0]?.visibility, "private");

    // Confirmed public update restores to public cache
    api.videos.updateVisibility = async () => ({
      success: true,
      video: {
        id: "vid-cache-vis-1",
        user_id: "FT111111",
        creator_name: "Creator",
        title: "Cache Visibility Test",
        video_url: "https://example.com/cache.mp4",
        thumbnail_url: "https://example.com/cache.jpg",
        video_type: "free",
        content_type: "long",
        category: "Coding",
        duration: "1:00",
        payment_status: "not_required",
        visibility: "public",
        created_at: "2026-11-22T00:00:00.000Z",
        updated_at: "2026-11-23T00:01:00.000Z",
      },
    });
    const publicRes = await updateVideoVisibility({
      videoId: "vid-cache-vis-1",
      visibility: "public",
    });
    assert.equal(publicRes.visibility, "public");
    assert.equal(
      getStoredVideos().some((v) => v.id === "vid-cache-vis-1"),
      true,
    );
    assert.equal(getOwnerStoredVideos("FT111111")?.[0]?.visibility, "public");
  });
});
