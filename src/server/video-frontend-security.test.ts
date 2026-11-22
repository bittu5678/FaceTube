import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { api } from "../lib/api.ts";
import {
  buildPublicFeedVideos,
  buildPublicHomeSections,
  clearProtectedVideoCaches,
  convertUploadedToCatalogVideo,
  fetchPublicVideosFeed,
  fetchUploadedVideos,
  getOwnerStoredVideos,
  getStoredVideos,
  isPubliclyCacheableVideo,
  normalizeVideoVisibility,
  parseCatalogViews,
  recordNewVideoUpload,
  resolveAuthenticatedUserId,
  resolveStoredVideoVisibility,
  saveOwnerStoredVideos,
  saveStoredVideos,
  selectBulkQueueItemForUpload,
  uploadSingleBulkVideoItem,
  type UploadedVideo,
} from "../lib/video-service.ts";
import { recordNewImageUpload } from "../lib/image-service.ts";
import {
  findPublicCachedVideo,
  findVideoAsync,
  mapApiVideoToCatalogVideo,
  resolveWatchVideo,
} from "../lib/watch-video.ts";
import {
  initiatePremiumVideoPayment,
  resetRazorpayClientStateForTests,
} from "../lib/razorpay-service.ts";

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

function makeVideo(overrides: Partial<UploadedVideo> = {}): UploadedVideo {
  const now = "2026-11-22T00:00:00.000Z";
  return {
    id: overrides.id || `vid-test-${Math.random().toString(36).slice(2, 8)}`,
    userId: overrides.userId ?? "FT483921",
    creatorName: overrides.creatorName || "Alex Rivera",
    title: overrides.title || "Sample Video",
    description: overrides.description || "Sample description",
    videoUrl: overrides.videoUrl || "/uploads/videos/sample.mp4",
    thumbnailUrl: overrides.thumbnailUrl || "/uploads/images/sample.jpg",
    videoType: overrides.videoType || "free",
    contentType: overrides.contentType || "long",
    category: overrides.category || "Coding",
    duration: overrides.duration || "02:00",
    views: overrides.views ?? 10,
    likes: overrides.likes ?? 2,
    paymentStatus: overrides.paymentStatus || "not_required",
    paymentAmount: overrides.paymentAmount ?? 0,
    isPromoted: overrides.isPromoted ?? false,
    isBlocked: overrides.isBlocked,
    visibility: overrides.visibility ?? "public",
    createdAt: overrides.createdAt || now,
    updatedAt: overrides.updatedAt || now,
    ...(overrides.paymentId ? { paymentId: overrides.paymentId } : {}),
    ...(overrides.isStale !== undefined ? { isStale: overrides.isStale } : {}),
  };
}

function setActiveSession(storage: Storage, userId: string, token: string, role = "user"): void {
  storage.setItem(
    "facetube_session_v2",
    JSON.stringify({
      user: { id: userId, user_id: userId, email: `${userId.toLowerCase()}@facetube.com` },
      profile: { id: userId, user_id: userId, name: `Creator ${userId}` },
      dbUser: { id: userId, user_id: userId, role },
      role,
      token,
    }),
  );
  storage.setItem("facetube_auth_token", token);
}

describe("Phase 2B Step 3C: Frontend Watch Authorization, Cache Security & Visibility Tests", () => {
  const originalWindow = (globalThis as any).window;
  const originalDocument = (globalThis as any).document;
  const originalLocalStorage = (globalThis as any).localStorage;
  const originalVideosGet = api.videos.get;
  const originalVideosList = api.videos.list;
  const originalVideosCreate = api.videos.create;
  const originalImagesCreate = api.images.create;
  const originalUploadVideo = api.uploads.uploadVideo;
  const originalPaymentsCreateOrder = api.payments.createOrder;
  const originalPaymentsVerify = api.payments.verify;
  const originalWalletBalance = api.wallet.getBalance;
  const originalWalletTxs = api.wallet.getTransactions;

  let storage: Storage;

  beforeEach(() => {
    storage = createMemoryStorage();
    (globalThis as any).localStorage = storage;
    (globalThis as any).window = {
      location: { hostname: "localhost" },
    };
    resetRazorpayClientStateForTests();
  });

  afterEach(() => {
    (globalThis as any).window = originalWindow;
    (globalThis as any).document = originalDocument;
    (globalThis as any).localStorage = originalLocalStorage;
    api.videos.get = originalVideosGet;
    api.videos.list = originalVideosList;
    api.videos.create = originalVideosCreate;
    api.images.create = originalImagesCreate;
    api.uploads.uploadVideo = originalUploadVideo;
    api.payments.createOrder = originalPaymentsCreateOrder;
    api.payments.verify = originalPaymentsVerify;
    api.wallet.getBalance = originalWalletBalance;
    api.wallet.getTransactions = originalWalletTxs;
    resetRazorpayClientStateForTests();
  });

  it("1. Server 401/403 cannot be bypassed by localStorage caches", async () => {
    const cachedVideo = makeVideo({
      id: "vid-private-cache-bypass",
      visibility: "public",
      title: "Poisoned Local Entry",
    });
    saveStoredVideos([cachedVideo]);
    setActiveSession(storage, "FT483921", "tok_test_401");
    saveOwnerStoredVideos("FT483921", [
      makeVideo({ id: "vid-private-cache-bypass", visibility: "private" }),
    ]);

    for (const statusCode of [401, 403]) {
      api.videos.get = async () => {
        throw Object.assign(new Error(`HTTP ${statusCode}`), { status: statusCode });
      };

      const browserResolution = await resolveWatchVideo("vid-private-cache-bypass");
      assert.deepEqual(browserResolution, { status: "denied", httpStatus: statusCode });

      const asyncResult = await findVideoAsync("vid-private-cache-bypass");
      assert.equal(asyncResult, undefined);

      // In SSR (no window), 401/403 must defer to client auth check, never return status: "ok"
      (globalThis as any).window = undefined;
      const ssrResolution = await resolveWatchVideo("vid-private-cache-bypass");
      assert.deepEqual(ssrResolution, {
        status: "needs_client_auth",
        httpStatus: statusCode,
      });
      (globalThis as any).window = { location: { hostname: "localhost" } };
    }
  });

  it("2. Server 5xx and network failures fail closed and do not authorize cached playback", async () => {
    const cachedVideo = makeVideo({
      id: "vid-outage-cached",
      visibility: "public",
      title: "Cached During Outage",
    });
    saveStoredVideos([cachedVideo]);

    api.videos.get = async () => {
      throw Object.assign(new Error("Service Unavailable"), { status: 503 });
    };
    assert.deepEqual(await resolveWatchVideo("vid-outage-cached"), {
      status: "error",
      httpStatus: 503,
    });
    assert.equal(await findVideoAsync("vid-outage-cached"), undefined);

    api.videos.get = async () => {
      throw new Error("Network failure");
    };
    assert.deepEqual(await resolveWatchVideo("vid-outage-cached"), { status: "error" });
    assert.equal(await findVideoAsync("vid-outage-cached"), undefined);
  });

  it("3. Static showcase fallback on 404 allows showcase videos only and never exposes seedVideos or localStorage", async () => {
    const showcaseVideos = [
      {
        id: "v1",
        title: "Showcase React Dashboard",
        channel: "CodeCanvas",
        initials: "CC",
        views: "100 views",
        age: "1 day ago",
        duration: "10:00",
        thumb: "/thumb-1.jpg",
        tint: "oklch(0.45 0.15 27)",
        category: "Coding",
        description: "Showcase entry",
      },
    ];

    saveStoredVideos([
      makeVideo({ id: "vid-seed-005", title: "Seed In Local Cache" }),
      makeVideo({ id: "vid-local-only-999", title: "Local Only Cached Video" }),
    ]);

    api.videos.get = async () => {
      throw Object.assign(new Error("Not Found"), { status: 404 });
    };

    const showcaseRes = await resolveWatchVideo("v1", { showcaseVideos });
    assert.equal(showcaseRes.status, "ok");
    if (showcaseRes.status === "ok") {
      assert.equal(showcaseRes.video.id, "v1");
    }

    assert.deepEqual(await resolveWatchVideo("vid-seed-005", { showcaseVideos }), {
      status: "not_found",
    });
    assert.deepEqual(await resolveWatchVideo("vid-local-only-999", { showcaseVideos }), {
      status: "not_found",
    });
  });

  it("4. Public cache excludes private, unlisted, and blocked videos and sanitizes stored entries", () => {
    const eligible = makeVideo({
      id: "vid-pub-1",
      visibility: "public",
      videoType: "free",
      paymentStatus: "not_required",
    });
    const priv = makeVideo({ id: "vid-priv-1", visibility: "private" });
    const unlisted = makeVideo({ id: "vid-unl-1", visibility: "unlisted" });
    const blocked = makeVideo({ id: "vid-blk-1", visibility: "public", isBlocked: true });
    const blockedSnake = {
      ...makeVideo({ id: "vid-blk-2", visibility: "public" }),
      is_blocked: 1,
    };

    assert.equal(isPubliclyCacheableVideo(eligible), true);
    assert.equal(isPubliclyCacheableVideo(priv), false);
    assert.equal(isPubliclyCacheableVideo(unlisted), false);
    assert.equal(isPubliclyCacheableVideo(blocked), false);
    assert.equal(isPubliclyCacheableVideo(blockedSnake), false);

    saveStoredVideos([eligible, priv, unlisted, blocked, blockedSnake as UploadedVideo]);
    const stored = getStoredVideos();
    assert.deepEqual(
      stored.map((v) => v.id),
      ["vid-pub-1"],
    );
  });

  it("5. Premium videos with paymentStatus not_required, pending, or failed are excluded from public cache", () => {
    const premPaid = makeVideo({
      id: "vid-prem-paid",
      videoType: "premium",
      paymentStatus: "paid",
      paymentId: "pay_real_1",
      paymentAmount: 6,
    });
    const premNotRequired = makeVideo({
      id: "vid-prem-nr",
      videoType: "premium",
      paymentStatus: "not_required",
    });
    const premPending = makeVideo({
      id: "vid-prem-pend",
      videoType: "premium",
      paymentStatus: "pending",
    });
    const premFailed = makeVideo({
      id: "vid-prem-fail",
      videoType: "premium",
      paymentStatus: "failed",
    });
    const freePaid = makeVideo({
      id: "vid-free-paid",
      videoType: "free",
      paymentStatus: "paid",
    });
    const freePending = makeVideo({
      id: "vid-free-pend",
      videoType: "free",
      paymentStatus: "pending",
    });

    assert.equal(isPubliclyCacheableVideo(premPaid), true);
    assert.equal(isPubliclyCacheableVideo(premNotRequired), false);
    assert.equal(isPubliclyCacheableVideo(premPending), false);
    assert.equal(isPubliclyCacheableVideo(premFailed), false);
    assert.equal(isPubliclyCacheableVideo(freePaid), true);
    assert.equal(isPubliclyCacheableVideo(freePending), false);

    saveStoredVideos([premPaid, premNotRequired, premPending, premFailed, freePaid, freePending]);
    const storedIds = getStoredVideos().map((v) => v.id);
    assert.deepEqual(storedIds, ["vid-prem-paid", "vid-free-paid"]);
  });

  it("6. Logout and account switching isolate and evict owner-scoped video caches", () => {
    const userAPrivate = makeVideo({
      id: "vid-userA-priv",
      userId: "FT111111",
      visibility: "private",
    });
    const userBPrivate = makeVideo({
      id: "vid-userB-priv",
      userId: "FT222222",
      visibility: "private",
    });
    const publicVid = makeVideo({ id: "vid-public-keep", visibility: "public" });

    // User A signed in
    setActiveSession(storage, "FT111111", "token_user_a");
    saveOwnerStoredVideos("FT111111", [userAPrivate]);
    saveStoredVideos([publicVid]);

    assert.equal(getOwnerStoredVideos("FT111111")?.length, 1);
    assert.equal(getOwnerStoredVideos("FT222222"), null);

    // Account switch to User B
    setActiveSession(storage, "FT222222", "token_user_b");
    clearProtectedVideoCaches({ keepUserId: "FT222222" });

    assert.equal(storage.getItem("facetube_owner_videos_v1:FT111111"), null);
    assert.equal(getOwnerStoredVideos("FT111111"), null);

    // User B saves own private video
    saveOwnerStoredVideos("FT222222", [userBPrivate]);
    assert.deepEqual(
      getOwnerStoredVideos("FT222222")?.map((v) => v.id),
      ["vid-userB-priv"],
    );

    // Logout clears token, session, and all protected owner caches while keeping public eligible items
    storage.removeItem("facetube_session_v2");
    storage.removeItem("facetube_auth_token");
    clearProtectedVideoCaches();

    assert.equal(storage.getItem("facetube_owner_videos_v1:FT222222"), null);
    assert.equal(getOwnerStoredVideos("FT222222"), null);
    assert.deepEqual(
      getStoredVideos().map((v) => v.id),
      ["vid-public-keep"],
    );
  });

  it("7. Live empty API responses clear stale cached videos for per-type and unfiltered feeds", async () => {
    const staleFree = makeVideo({ id: "vid-stale-free", videoType: "free", visibility: "public" });
    const validPrem = makeVideo({
      id: "vid-valid-prem",
      videoType: "premium",
      paymentStatus: "paid",
      visibility: "public",
    });
    saveStoredVideos([staleFree, validPrem]);

    // 1. Live free feed returns empty [] -> stale free entry removed, valid premium kept
    api.videos.list = async () => ({ success: true, videos: [], total: 0 });
    const liveFreeEmpty = await fetchPublicVideosFeed("free");
    assert.deepEqual(liveFreeEmpty, []);
    assert.deepEqual(
      getStoredVideos().map((v) => v.id),
      ["vid-valid-prem"],
    );

    // Going offline afterward must not resurrect deleted/privatized free video
    api.videos.list = async () => {
      throw new Error("Offline");
    };
    assert.deepEqual(await fetchPublicVideosFeed("free"), []);

    // 2. Unfiltered live feed returns empty [] -> clears all stale public cache without re-seeding
    api.videos.list = async () => ({ success: true, videos: [], total: 0 });
    const liveAllEmpty = await fetchUploadedVideos();
    assert.deepEqual(liveAllEmpty, []);
    assert.deepEqual(getStoredVideos(), []);

    api.videos.list = async () => {
      throw new Error("Offline");
    };
    assert.deepEqual(await fetchUploadedVideos(), []);

    // 3. Unpaginated live empty Shorts response clears stale public Shorts while preserving public longs, owner cache, and error resilience
    setActiveSession(storage, "FT111111", "tok_shorts_owner");
    const ownerPrivateShort = makeVideo({
      id: "vid-owner-priv-short",
      userId: "FT111111",
      contentType: "short",
      visibility: "private",
    });
    saveOwnerStoredVideos("FT111111", [ownerPrivateShort]);
    const validLong = makeVideo({
      id: "vid-valid-long",
      videoType: "free",
      contentType: "long",
      duration: "12:00",
      visibility: "public",
    });
    const staleShort = makeVideo({
      id: "vid-stale-short",
      videoType: "free",
      contentType: "short",
      duration: "0:35",
      visibility: "public",
    });
    saveStoredVideos([validLong, staleShort]);

    // Network error / HTTP failure must NOT invalidate cached Shorts
    api.videos.list = async () => {
      throw Object.assign(new Error("HTTP 500"), { status: 500 });
    };
    const offlineShorts = await fetchUploadedVideos({ contentType: "short" });
    assert.deepEqual(
      offlineShorts.map((v) => v.id),
      ["vid-stale-short"],
    );
    assert.deepEqual(
      getStoredVideos().map((v) => v.id),
      ["vid-valid-long", "vid-stale-short"],
    );

    // Unsuccessful response payload (success: false) must NOT invalidate cached Shorts
    api.videos.list = async () => ({ success: false, videos: [], total: 0 });
    const unsuccessfulShorts = await fetchUploadedVideos({ contentType: "short" });
    assert.deepEqual(
      unsuccessfulShorts.map((v) => v.id),
      ["vid-stale-short"],
    );
    assert.deepEqual(
      getStoredVideos().map((v) => v.id),
      ["vid-valid-long", "vid-stale-short"],
    );

    // Successful empty Shorts response clears stale public Shorts while preserving public longs & owner cache
    api.videos.list = async () => ({ success: true, videos: [], total: 0 });
    const liveShortsEmpty = await fetchUploadedVideos({ contentType: "short" });
    assert.deepEqual(liveShortsEmpty, []);
    assert.deepEqual(
      getStoredVideos().map((v) => v.id),
      ["vid-valid-long"],
    );
    assert.deepEqual(
      getOwnerStoredVideos("FT111111")?.map((v) => v.id),
      ["vid-owner-priv-short"],
    );

    // Going offline afterward must not resurrect cleared Shorts while longs remain intact
    api.videos.list = async () => {
      throw new Error("Offline");
    };
    assert.deepEqual(await fetchUploadedVideos({ contentType: "short" }), []);
    assert.deepEqual(
      getStoredVideos().map((v) => v.id),
      ["vid-valid-long"],
    );
  });

  it("8. Free and Sponsor feeds do not merge stale localStorage cache when live API succeeds", async () => {
    const staleFree = makeVideo({ id: "vid-stale-free-1", videoType: "free" });
    const stalePrem = makeVideo({
      id: "vid-stale-prem-1",
      videoType: "premium",
      paymentStatus: "paid",
    });
    // Inject polluted raw cache entry directly (e.g. legacy not_required premium or private video)
    storage.setItem(
      "facetube_uploaded_videos_v3",
      JSON.stringify([
        staleFree,
        stalePrem,
        makeVideo({ id: "vid-raw-nr", videoType: "premium", paymentStatus: "not_required" }),
        makeVideo({ id: "vid-raw-priv", videoType: "free", visibility: "private" }),
      ]),
    );

    api.videos.list = async (params) => {
      if (params?.videoType === "free") {
        return {
          success: true,
          videos: [
            {
              id: "vid-live-free-1",
              user_id: "FT483921",
              creator_name: "Alex Rivera",
              title: "Fresh Live Free Video",
              video_type: "free",
              content_type: "long",
              payment_status: "not_required",
              visibility: "public",
            },
          ],
          total: 1,
        };
      }
      return {
        success: true,
        videos: [
          {
            id: "vid-live-prem-1",
            user_id: "FT483921",
            creator_name: "Alex Rivera",
            title: "Fresh Live Sponsor Video",
            video_type: "premium",
            content_type: "long",
            payment_status: "paid",
            visibility: "public",
          },
          {
            id: "vid-api-prem-unpaid",
            user_id: "FT483921",
            creator_name: "Alex Rivera",
            title: "Unpaid Sponsor Video",
            video_type: "premium",
            content_type: "long",
            payment_status: "not_required",
            visibility: "public",
          },
        ],
        total: 2,
      };
    };

    const freeFeed = await fetchPublicVideosFeed("free");
    assert.deepEqual(
      freeFeed.map((v) => v.id),
      ["vid-live-free-1"],
    );

    const premFeed = await fetchPublicVideosFeed("premium");
    assert.deepEqual(
      premFeed.map((v) => v.id),
      ["vid-live-prem-1"],
    );
  });

  it("9. Visibility passes through Free, Bulk, and Sponsor uploads and isolates non-public records", async () => {
    setActiveSession(storage, "FT483921", "tok_upload_vis");
    const createdPayloads: any[] = [];
    api.videos.create = async (payload: any) => {
      createdPayloads.push(payload);
      return {
        success: true,
        video: {
          ...payload,
          payment_status: payload.video_type === "premium" ? "paid" : "not_required",
          payment_amount: payload.video_type === "premium" ? 6 : 0,
        },
      };
    };

    // Free unlisted upload
    const freeUnlisted = await recordNewVideoUpload({
      userId: "FT483921",
      creatorName: "Alex Rivera",
      title: "Unlisted Free Tutorial",
      description: "Link only",
      videoUrl: "/uploads/videos/free_unlisted.mp4",
      videoType: "free",
      contentType: "long",
      visibility: "unlisted",
    });
    assert.equal(freeUnlisted.visibility, "unlisted");
    assert.equal(createdPayloads.at(-1)?.visibility, "unlisted");
    assert.equal(
      getStoredVideos().some((v) => v.id === freeUnlisted.id),
      false,
    );
    assert.equal(
      getOwnerStoredVideos("FT483921")?.some((v) => v.id === freeUnlisted.id),
      true,
    );

    // Bulk upload item (private + normalization check)
    api.uploads.uploadVideo = async () => ({
      success: true,
      url: "/uploads/videos/bulk_priv.mp4",
      fileName: "bulk_priv.mp4",
      format: "mp4",
    });
    const bulkPrivate = await uploadSingleBulkVideoItem(
      {
        id: "bulk-1",
        file: new File(["video"], "bulk_priv.mp4", { type: "video/mp4" }),
        title: "Bulk Private Clip",
        category: "Coding",
        contentType: "short",
        visibility: "private",
        thumbnailUrl: "/uploads/images/cover.jpg",
      },
      { userId: "FT483921", creatorName: "Alex Rivera" },
    );
    assert.equal(bulkPrivate.visibility, "private");
    assert.equal(createdPayloads.at(-1)?.visibility, "private");
    assert.equal(normalizeVideoVisibility("  UNLISTED "), "unlisted");
    assert.equal(normalizeVideoVisibility("invalid-value", "public"), "public");

    // Sponsor upload via initiatePremiumVideoPayment pass-through after verification
    api.payments.createOrder = async () => ({
      success: true,
      orderId: "order_vis_123",
      amount: 6,
      amountInSubunits: 600,
      currency: "INR",
      keyId: "rzp_test_key",
      purpose: "premium_video_upload",
    });
    api.payments.verify = async () => ({
      verified: true,
      orderId: "order_vis_123",
      paymentId: "pay_vis_123",
      amount: 6,
      txNumber: 1,
    });
    api.wallet.getBalance = async () => ({ success: true, wallet: {} });
    api.wallet.getTransactions = async () => ({ success: true, transactions: [], total: 0 });

    (globalThis as any).document = {
      querySelector: () => null,
      head: { appendChild: () => {} },
    };
    (globalThis as any).window.Razorpay = class MockRazorpay {
      private opts: any;
      constructor(opts: any) {
        this.opts = opts;
      }
      on() {}
      open() {
        this.opts.handler({
          razorpay_payment_id: "pay_vis_123",
          razorpay_order_id: "order_vis_123",
          razorpay_signature: "sig_vis_123",
        });
      }
    };

    const sponsorResult = await new Promise<UploadedVideo | undefined>((resolve, reject) => {
      void initiatePremiumVideoPayment({
        uploaderUserId: "FT483921",
        uploaderName: "Alex Rivera",
        videoId: "vid-sponsor-priv-1",
        videoTitle: "Private Sponsor Course",
        videoUrl: "/uploads/videos/sponsor_priv.mp4",
        thumbnailUrl: "/uploads/images/sponsor_priv.jpg",
        contentType: "long",
        visibility: "private",
        onSuccess: (_pid, createdVideo) => resolve(createdVideo),
        onFailure: (err) => reject(new Error(err)),
      });
    });

    assert.equal(sponsorResult?.id, "vid-sponsor-priv-1");
    assert.equal(sponsorResult?.visibility, "private");
    assert.equal(createdPayloads.at(-1)?.visibility, "private");
    assert.equal(
      getStoredVideos().some((v) => v.id === "vid-sponsor-priv-1"),
      false,
    );
    assert.equal(
      getOwnerStoredVideos("FT483921")?.some((v) => v.id === "vid-sponsor-priv-1"),
      true,
    );
  });

  it("10. Bulk upload queue selector resolves the exact pending/retryable item without state-updater races", () => {
    const queue = [
      {
        id: "item-1",
        status: "success" as const,
        title: "Done Video",
        visibility: "public" as const,
      },
      {
        id: "item-2",
        status: "uploading" as const,
        title: "In Flight",
        visibility: "unlisted" as const,
      },
      {
        id: "item-3",
        status: "queued" as const,
        title: "Next Queued",
        visibility: "unlisted" as const,
      },
      {
        id: "item-4",
        status: "error" as const,
        title: "Failed Retry",
        visibility: "private" as const,
      },
    ];

    assert.equal(selectBulkQueueItemForUpload(queue, "item-1"), undefined);
    assert.equal(selectBulkQueueItemForUpload(queue, "item-2"), undefined);
    assert.equal(selectBulkQueueItemForUpload(queue, "missing"), undefined);

    const selectedQueued = selectBulkQueueItemForUpload(queue, "item-3");
    assert.equal(selectedQueued?.id, "item-3");
    assert.equal(selectedQueued?.visibility, "unlisted");

    const selectedRetry = selectBulkQueueItemForUpload(queue, "item-4");
    assert.equal(selectedRetry?.id, "item-4");
    assert.equal(selectedRetry?.visibility, "private");
  });

  it("11. Missing authenticated identity cannot initiate an upload and studio routes contain no FT483921 fallback", async () => {
    // 1. Session resolver never falls back to FT483921 or email prefixes
    const anonUser = { id: "u-anon", email: "alex@facetube.com" } as Record<string, unknown>;
    assert.equal(
      resolveAuthenticatedUserId({
        user: anonUser,
        profile: null,
        dbUser: null,
      }),
      "",
    );
    assert.equal(resolveAuthenticatedUserId({ user: null, profile: null, dbUser: null }), "");

    // 2. Service & payment helpers fail closed before issuing network requests when userId is missing
    let apiCreateCalls = 0;
    let apiUploadCalls = 0;
    let apiImageCreateCalls = 0;
    let apiOrderCalls = 0;

    api.videos.create = async () => {
      apiCreateCalls += 1;
      return { success: true, video: {} };
    };
    api.uploads.uploadVideo = async () => {
      apiUploadCalls += 1;
      return {
        success: true,
        url: "/uploads/videos/should_not_run.mp4",
        fileName: "should_not_run.mp4",
        format: "mp4",
      };
    };
    api.images.create = async () => {
      apiImageCreateCalls += 1;
      return { success: true, image: {} };
    };
    api.payments.createOrder = async () => {
      apiOrderCalls += 1;
      return {
        orderId: "order_should_not_run",
        amount: 6,
        amountInSubunits: 600,
        currency: "INR",
        purpose: "premium_video_upload",
        keyId: "rzp_test",
      };
    };

    await assert.rejects(
      () =>
        recordNewVideoUpload({
          userId: "",
          creatorName: "Anon",
          title: "Unauth Video",
          description: "",
          videoUrl: "/uploads/videos/unauth.mp4",
          videoType: "free",
          contentType: "long",
        }),
      /Authentication required/i,
    );

    await assert.rejects(
      () =>
        uploadSingleBulkVideoItem(
          {
            id: "bulk-unauth",
            file: new File(["bytes"], "unauth.mp4", { type: "video/mp4" }),
            title: "Bulk Unauth",
            category: "Coding",
            contentType: "short",
          },
          { userId: "   ", creatorName: "Anon" },
        ),
      /Authentication required/i,
    );

    await assert.rejects(
      () =>
        recordNewImageUpload({
          userId: "",
          creatorName: "Anon",
          title: "Unauth Image",
          imageUrl: "/uploads/images/unauth.jpg",
          format: "jpg",
        }),
      /Authentication required/i,
    );

    let premiumFailure = "";
    await initiatePremiumVideoPayment({
      uploaderUserId: "",
      uploaderName: "Anon",
      videoId: "vid-unauth-prem",
      videoTitle: "Unauth Sponsor",
      videoUrl: "/uploads/videos/unauth_prem.mp4",
      contentType: "short",
      onSuccess: () => {
        throw new Error("Unauthenticated Sponsor payment must never succeed");
      },
      onFailure: (err) => {
        premiumFailure = err;
      },
    });
    assert.match(premiumFailure, /Authentication required/i);

    assert.equal(apiCreateCalls, 0);
    assert.equal(apiUploadCalls, 0);
    assert.equal(apiImageCreateCalls, 0);
    assert.equal(apiOrderCalls, 0);

    // 3. Static verification: no FT483921 fallback remains in studio/upload files
    for (const relPath of [
      "src/routes/upload.tsx",
      "src/routes/ads-promotions.tsx",
      "src/routes/your-videos.tsx",
      "src/routes/images-uploaded.tsx",
      "src/lib/razorpay-service.ts",
    ]) {
      const source = fs.readFileSync(path.resolve(process.cwd(), relPath), "utf8");
      assert.equal(
        source.includes("FT483921"),
        false,
        `${relPath} must not contain any FT483921 fallback`,
      );
    }
  });

  it("12. Authenticated owner uploads work and omit unset visibility on cold-cache updates so server visibility is preserved", async () => {
    const mayaUser = { id: "u-maya", user_id: "FT900431", email: "maya@facetube.com" } as Record<
      string,
      unknown
    >;
    const mayaProfile = { id: "p-maya", user_id: "FT900431", username: "FT900431" } as Record<
      string,
      unknown
    >;
    const resolvedOwner = resolveAuthenticatedUserId({
      user: mayaUser,
      profile: mayaProfile,
      dbUser: null,
    });
    assert.equal(resolvedOwner, "FT900431");

    const adminUser = { id: "u-admin", user_metadata: { user_id: "FT102857" } } as Record<
      string,
      unknown
    >;
    const resolvedAdmin = resolveAuthenticatedUserId({
      user: adminUser,
      profile: null,
      dbUser: null,
    });
    assert.equal(resolvedAdmin, "FT102857");

    setActiveSession(storage, resolvedOwner, "tok_maya_upload");
    const sentPayloads: any[] = [];

    api.videos.create = async (payload: any) => {
      sentPayloads.push(payload);
      const isExistingPrivate =
        payload.id === "vid-cold-private-1" && payload.visibility === undefined;
      return {
        success: true,
        video: {
          ...payload,
          visibility: isExistingPrivate ? "private" : (payload.visibility ?? "public"),
          payment_status: "not_required",
          payment_amount: 0,
        },
      };
    };

    // Cold-cache update with omitted visibility must NOT send visibility: "public"
    const preservedPrivate = await recordNewVideoUpload({
      id: "vid-cold-private-1",
      userId: resolvedOwner,
      creatorName: "Maya Lin",
      title: "Cold Cache Private Update",
      description: "Preserves server private visibility",
      videoUrl: "/uploads/videos/maya_priv.mp4",
      videoType: "free",
      contentType: "long",
    });
    assert.equal("visibility" in sentPayloads.at(-1), false);
    assert.equal(preservedPrivate.visibility, "private");
    assert.equal(
      getStoredVideos().some((v) => v.id === "vid-cold-private-1"),
      false,
    );
    assert.equal(
      getOwnerStoredVideos(resolvedOwner)?.some((v) => v.id === "vid-cold-private-1"),
      true,
    );

    // Authenticated new owner upload without visibility defaults cleanly to public
    const createdNewPublic = await recordNewVideoUpload({
      userId: resolvedOwner,
      creatorName: "Maya Lin",
      title: "Fresh Owner Upload",
      description: "Default public",
      videoUrl: "/uploads/videos/maya_pub.mp4",
      videoType: "free",
      contentType: "short",
    });
    assert.equal(createdNewPublic.visibility, "public");
    assert.equal(createdNewPublic.userId, resolvedOwner);
    assert.equal(
      getStoredVideos().some((v) => v.id === createdNewPublic.id),
      true,
    );
  });

  it("13. Step 3D-A: Empty localStorage getStoredVideos() returns [] with zero INITIAL_SEED_VIDEOS leakage", async () => {
    assert.equal(storage.getItem("facetube_uploaded_videos_v3"), null);
    assert.deepEqual(getStoredVideos(), []);

    api.videos.list = async () => ({ success: true, videos: [], total: 0 });
    const live = await fetchUploadedVideos();
    assert.deepEqual(live, []);
    assert.deepEqual(getStoredVideos(), []);
  });

  it("14. Step 3D-A: Public feed/home builders exclude private, unlisted, blocked, unknown-visibility, and unpaid Sponsor videos without static fallbacks", () => {
    // Empty inputs return empty sections (zero static seed/demo videos merged)
    assert.deepEqual(buildPublicFeedVideos([]), []);
    const emptySections = buildPublicHomeSections([], []);
    assert.deepEqual(emptySections.allCombinedVideos, []);
    assert.deepEqual(emptySections.recommendedVideos, []);
    assert.deepEqual(emptySections.trendingVideos, []);
    assert.deepEqual(emptySections.recentVideos, []);
    assert.deepEqual(emptySections.shortItems, []);

    const mixed: UploadedVideo[] = [
      makeVideo({
        id: "pub-free-long",
        userId: "FT111111",
        videoType: "free",
        contentType: "long",
        visibility: "public",
        paymentStatus: "not_required",
        views: 200,
      }),
      makeVideo({
        id: "pub-free-short",
        userId: "FT111111",
        videoType: "free",
        contentType: "short",
        duration: "0:45",
        visibility: "public",
        paymentStatus: "not_required",
        views: 1500,
      }),
      makeVideo({
        id: "pub-prem-paid-long",
        userId: "FT222222",
        videoType: "premium",
        contentType: "long",
        visibility: "public",
        paymentStatus: "paid",
        paymentId: "pay_ok_1",
        paymentAmount: 6,
        views: 500,
      }),
      makeVideo({
        id: "pub-prem-paid-short",
        userId: "FT222222",
        videoType: "premium",
        contentType: "short",
        duration: "0:30",
        visibility: "public",
        paymentStatus: "paid",
        paymentId: "pay_ok_2",
        paymentAmount: 6,
        views: 900,
      }),
      makeVideo({
        id: "excl-priv",
        visibility: "private",
        videoType: "free",
        contentType: "short",
      }),
      makeVideo({
        id: "excl-unl",
        visibility: "unlisted",
        videoType: "free",
        contentType: "short",
      }),
      makeVideo({
        id: "excl-blk",
        visibility: "public",
        isBlocked: true,
        videoType: "free",
        contentType: "short",
      }),
      makeVideo({
        id: "excl-corrupt-vis",
        visibility: "archived" as any,
        videoType: "free",
        contentType: "long",
      }),
      makeVideo({
        id: "excl-prem-nr",
        visibility: "public",
        videoType: "premium",
        contentType: "long",
        paymentStatus: "not_required",
      }),
      makeVideo({
        id: "excl-prem-pend",
        visibility: "public",
        videoType: "premium",
        contentType: "short",
        paymentStatus: "pending",
      }),
    ];

    const freeFeed = buildPublicFeedVideos(mixed, { videoType: "free" });
    assert.deepEqual(
      freeFeed.map((v) => v.id),
      ["pub-free-long", "pub-free-short"],
    );

    const premFeed = buildPublicFeedVideos(mixed, { videoType: "premium" });
    assert.deepEqual(
      premFeed.map((v) => v.id),
      ["pub-prem-paid-long", "pub-prem-paid-short"],
    );

    const shortsOnly = buildPublicFeedVideos(mixed, { contentType: "short" });
    assert.deepEqual(
      shortsOnly.map((v) => v.id),
      ["pub-free-short", "pub-prem-paid-short"],
    );

    const home = buildPublicHomeSections(mixed, mixed);
    assert.deepEqual(
      home.trendingVideos.map((v) => v.id),
      ["pub-free-short", "pub-prem-paid-short", "pub-prem-paid-long", "pub-free-long"],
    );
    assert.deepEqual(
      home.shortItems.map((s) => s.id),
      ["pub-free-short", "pub-prem-paid-short"],
    );
    assert.equal(parseCatalogViews("1,250 views"), 1250);
  });

  it("15. Step 3D-A: Live public fetchUploadedVideos filters out non-public/blocked/unknown-visibility/unpaid items and never caches them", async () => {
    api.videos.list = async () => ({
      success: true,
      videos: [
        {
          id: "live-ok-free",
          user_id: "FT111111",
          creator_name: "Creator One",
          title: "Eligible Free",
          video_type: "free",
          content_type: "long",
          payment_status: "not_required",
          visibility: "public",
        },
        {
          id: "live-ok-paid",
          user_id: "FT222222",
          creator_name: "Creator Two",
          title: "Eligible Paid Sponsor",
          video_type: "premium",
          content_type: "short",
          payment_status: "paid",
          visibility: "public",
        },
        {
          id: "live-bad-priv",
          user_id: "FT111111",
          title: "Leaked Private",
          video_type: "free",
          content_type: "long",
          payment_status: "not_required",
          visibility: "private",
        },
        {
          id: "live-bad-unl",
          user_id: "FT111111",
          title: "Leaked Unlisted",
          video_type: "free",
          content_type: "short",
          payment_status: "not_required",
          visibility: "unlisted",
        },
        {
          id: "live-bad-unknown-vis",
          user_id: "FT111111",
          title: "Unknown Vis",
          video_type: "free",
          content_type: "long",
          payment_status: "not_required",
          visibility: "draft_only",
        },
        {
          id: "live-bad-blocked",
          user_id: "FT111111",
          title: "Blocked Item",
          video_type: "free",
          content_type: "long",
          payment_status: "not_required",
          visibility: "public",
          is_blocked: 1,
        },
        {
          id: "live-bad-unpaid-sponsor",
          user_id: "FT111111",
          title: "Unpaid Sponsor",
          video_type: "premium",
          content_type: "long",
          payment_status: "not_required",
          visibility: "public",
        },
      ],
      total: 7,
    });

    const publicResults = await fetchUploadedVideos();
    assert.deepEqual(
      publicResults.map((v) => v.id),
      ["live-ok-free", "live-ok-paid"],
    );
    assert.deepEqual(
      getStoredVideos().map((v) => v.id),
      ["live-ok-free", "live-ok-paid"],
    );
  });

  it("16. Step 3D-A: Fail-closed visibility normalization, zero FT483921 mappers, and clean static/Shorts wiring on discovery pages", () => {
    // 1) Fail-closed stored visibility semantics
    assert.equal(resolveStoredVideoVisibility(undefined), "public");
    assert.equal(resolveStoredVideoVisibility(null), "public");
    assert.equal(resolveStoredVideoVisibility(""), "public");
    assert.equal(resolveStoredVideoVisibility("  PUBLIC "), "public");
    assert.equal(resolveStoredVideoVisibility("unlisted"), "unlisted");
    assert.equal(resolveStoredVideoVisibility("private"), "private");
    assert.equal(resolveStoredVideoVisibility("archived"), "private");
    assert.equal(resolveStoredVideoVisibility("hidden_legacy"), "private");

    // 2) Mappers fail closed on corrupted visibility and do NOT inject FT483921
    const mappedWatch = mapApiVideoToCatalogVideo({
      id: "vid-map-1",
      title: "Corrupt Vis",
      video_url: "/uploads/videos/a.mp4",
      visibility: "corrupt_status",
    });
    assert.equal(mappedWatch.visibility, "private");
    assert.equal(mappedWatch.userId, "");

    const mappedCatalog = convertUploadedToCatalogVideo(
      makeVideo({ id: "vid-cat-1", userId: "", visibility: "invalid_vis" as any }),
    );
    assert.equal(mappedCatalog.visibility, "private");
    assert.equal(mappedCatalog.userId, "");

    // Raw poisoned storage entry with corrupted visibility is rejected by findPublicCachedVideo
    storage.setItem(
      "facetube_uploaded_videos_v3",
      JSON.stringify([
        {
          id: "vid-poison-vis",
          title: "Corrupt Vis Cache",
          videoType: "free",
          paymentStatus: "not_required",
          visibility: "corrupted",
        },
      ]),
    );
    assert.equal(findPublicCachedVideo("vid-poison-vis"), undefined);

    // 3) Static source checks: public feeds have zero static mock imports, wire Shorts properly, and contain zero FT483921 fallbacks
    const publicDiscoveryFiles = [
      "src/routes/index.tsx",
      "src/routes/explore.tsx",
      "src/routes/shorts.tsx",
      "src/routes/short-videos.tsx",
      "src/routes/free-videos.tsx",
      "src/routes/premium-videos.tsx",
      "src/routes/watch.$videoId.tsx",
      "src/components/videohub/DashboardCategoriesSection.tsx",
      "src/components/videohub/ShortsShelf.tsx",
    ];
    for (const relPath of publicDiscoveryFiles) {
      const src = fs.readFileSync(path.resolve(process.cwd(), relPath), "utf8");
      assert.equal(
        /import\s+(?!type\b)[^;]*\b(allVideos|SHORTS_LIST|recommended|trending|recent|creators|seedVideos|staticShowcaseVideos)\b[^;]*from\s+["']@\/data\/(?:videos|shorts)["']/s.test(
          src,
        ) || /\b(allVideos|SHORTS_LIST|seedVideos|staticShowcaseVideos)\b/.test(src),
        false,
        `${relPath} must not reference static mock arrays/imports`,
      );
    }

    for (const relPath of [
      "src/routes/index.tsx",
      "src/routes/shorts.tsx",
      "src/routes/short-videos.tsx",
    ]) {
      const src = fs.readFileSync(path.resolve(process.cwd(), relPath), "utf8");
      assert.match(
        src,
        /fetchUploadedVideos\(\{\s*contentType:\s*["']short["']\s*\}\)/,
        `${relPath} must query Shorts via contentType: "short"`,
      );
    }

    for (const relPath of [
      "src/lib/watch-video.ts",
      "src/routes/shorts.tsx",
      "src/routes/watch.$videoId.tsx",
    ]) {
      const src = fs.readFileSync(path.resolve(process.cwd(), relPath), "utf8");
      assert.equal(
        src.includes("FT483921"),
        false,
        `${relPath} must not contain any FT483921 fallback`,
      );
    }
  });
});
