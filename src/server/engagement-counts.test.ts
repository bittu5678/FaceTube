import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  convertUploadedToCatalogVideo,
  convertVideoToShortItem,
  fetchUploadedVideos,
  getStoredVideos,
  type UploadedVideo,
} from "../lib/video-service.ts";
import { fetchUploadedImages, getStoredImages } from "../lib/image-service.ts";
import { api } from "../lib/api.ts";
import { mapApiVideoToCatalogVideo, resolveWatchVideo } from "../lib/watch-video.ts";
import { handleApiRequest, resetInMemoryStore } from "./api-handler.ts";
import { setMysqlPoolForTesting } from "./mysql.ts";

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

function makeUploadedVideo(overrides: Partial<UploadedVideo> = {}): UploadedVideo {
  return {
    id: "vid-default",
    userId: "FT100001",
    creatorName: "Real Creator",
    channelName: "Real Channel",
    title: "Real Uploaded Video",
    description: "Actual video description",
    videoUrl: "https://cdn.example.com/video.mp4",
    thumbnailUrl: "https://cdn.example.com/thumb.jpg",
    videoType: "free",
    contentType: "long",
    category: "Coding",
    duration: "04:10",
    views: 0,
    likes: 0,
    paymentStatus: "not_required",
    paymentAmount: 0,
    isPromoted: false,
    visibility: "public",
    createdAt: "2026-11-22T00:00:00.000Z",
    updatedAt: "2026-11-22T00:00:00.000Z",
    ...overrides,
  };
}

describe("FaceTube Real Engagement Counts & Zero-Demo Regression Suite", () => {
  const prevWindow = (globalThis as any).window;
  const prevLocalStorage = (globalThis as any).localStorage;
  const prevFetch = globalThis.fetch;

  beforeEach(() => {
    const storage = createMemoryStorage();
    (globalThis as any).window = {};
    (globalThis as any).localStorage = storage;
  });

  afterEach(() => {
    (globalThis as any).window = prevWindow;
    (globalThis as any).localStorage = prevLocalStorage;
    globalThis.fetch = prevFetch;
  });

  it("1. Maps each video's own views and likes strictly by its own ID and preserves genuine 0", () => {
    const zeroVideo = mapApiVideoToCatalogVideo({
      id: "vid-zero-1",
      title: "Brand New Upload",
      channel_name: "New Channel",
      views: 0,
      likes: 0,
      video_type: "free",
      content_type: "long",
      visibility: "public",
    });

    const activeVideo = mapApiVideoToCatalogVideo({
      id: "vid-active-2",
      title: "Popular Upload",
      channel_name: "Active Channel",
      views: 4219,
      likes: 317,
      video_type: "free",
      content_type: "long",
      visibility: "public",
    });

    assert.equal(zeroVideo.id, "vid-zero-1");
    assert.equal(zeroVideo.views, "0 views");
    assert.equal(zeroVideo.viewsCount, 0);
    assert.equal(zeroVideo.likes, 0);

    assert.equal(activeVideo.id, "vid-active-2");
    assert.equal(activeVideo.views, "4,219 views");
    assert.equal(activeVideo.viewsCount, 4219);
    assert.equal(activeVideo.likes, 317);

    const uploadedZero = convertUploadedToCatalogVideo(
      makeUploadedVideo({ id: "up-zero", views: 0, likes: 0 }),
    );
    const uploadedActive = convertUploadedToCatalogVideo(
      makeUploadedVideo({ id: "up-active", views: 88, likes: 12 }),
    );

    assert.equal(uploadedZero.viewsCount, 0);
    assert.equal(uploadedZero.likes, 0);
    assert.equal(uploadedActive.viewsCount, 88);
    assert.equal(uploadedActive.likes, 12);
  });

  it("2. convertVideoToShortItem never invents 1.2K likes, 48 comments, or 16 shares and isolates counts per ID", () => {
    const zeroShort = convertVideoToShortItem(
      makeUploadedVideo({
        id: "short-zero",
        contentType: "short",
        duration: "0:30",
        views: 0,
        likes: 0,
      }),
    );

    const activeShort = convertVideoToShortItem(
      makeUploadedVideo({
        id: "short-active",
        contentType: "short",
        duration: "0:45",
        views: 950,
        likes: 41,
      }),
    );

    assert.equal(zeroShort.id, "short-zero");
    assert.equal(zeroShort.views, "0 views");
    assert.equal(zeroShort.viewsCount, 0);
    assert.equal(zeroShort.likes, "0");
    assert.equal(zeroShort.likesCount, 0);
    assert.equal(zeroShort.comments, "0");
    assert.equal(zeroShort.commentsCount, 0);
    assert.equal(zeroShort.shares, "");

    assert.equal(activeShort.id, "short-active");
    assert.equal(activeShort.views, "950 views");
    assert.equal(activeShort.viewsCount, 950);
    assert.equal(activeShort.likes, "41");
    assert.equal(activeShort.likesCount, 41);
    assert.equal(activeShort.comments, "0");
    assert.equal(activeShort.shares, "");
  });

  it("3. Empty backend and empty storage return [] with zero demo video or demo image leakage", async () => {
    assert.deepEqual(getStoredVideos(), []);
    assert.deepEqual(getStoredImages(), []);

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/videos/list")) {
        return new Response(JSON.stringify({ success: true, videos: [], total: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/images/list")) {
        return new Response(JSON.stringify({ success: true, images: [], total: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as typeof fetch;

    const videos = await fetchUploadedVideos();
    const images = await fetchUploadedImages();
    assert.deepEqual(videos, []);
    assert.deepEqual(images, []);
  });

  describe("4. Production UI Source Audit (No Hardcoded/Demo Engagement Counts)", () => {
    const readSrc = (relPath: string) =>
      fs.readFileSync(path.resolve(process.cwd(), relPath), "utf8");

    it("removes all hardcoded demo counts, fake comments, and fake notifications from UI routes & components", () => {
      const uiFiles = [
        "src/routes/watch.$videoId.tsx",
        "src/routes/shorts.tsx",
        "src/routes/short-videos.tsx",
        "src/routes/live-videos.tsx",
        "src/routes/live.tsx",
        "src/components/live/LiveKitViewerPlayer.tsx",
        "src/routes/liked-videos.tsx",
        "src/routes/watch-later.tsx",
        "src/routes/history.tsx",
        "src/routes/subscriptions.tsx",
        "src/routes/admin.tsx",
        "src/components/videohub/Navbar.tsx",
      ];

      const forbiddenPatterns: Array<[RegExp, string]> = [
        [/"23K"|"24K"/, 'hardcoded "23K"/"24K" like count'],
        [/\+\s*1282\b/, "hardcoded + 1282 comment offset"],
        [/280\.4K|34\.2K|37\.0K/, "hardcoded 280.4K / 34.2K / 37.0K stats"],
        [/₹655\.00|₹340\.50/, "hardcoded ₹655.00 / ₹340.50 demo payout"],
        [/\b1,840\b/, "hardcoded 1,840 peak concurrent viewers"],
        [/Aria Kapoor|Jordan Cole|Sara Connor|Marcus Bell|Elena Rostova/, "hardcoded demo names"],
        [/INITIAL_NOTIFICATIONS/, "hardcoded INITIAL_NOTIFICATIONS array"],
        [/progressPct\s*=\s*\[85,\s*45/, "hardcoded watch history progress percentages"],
      ];

      for (const file of uiFiles) {
        const src = readSrc(file);
        for (const [pattern, label] of forbiddenPatterns) {
          assert.equal(pattern.test(src), false, `${file} must not contain ${label} (${pattern})`);
        }
      }
    });

    it("wires real per-video likes & comments APIs in watch.$videoId.tsx and shorts.tsx and preserves 0 viewer counts", () => {
      const watchSrc = readSrc("src/routes/watch.$videoId.tsx");
      assert.match(
        watchSrc,
        /api\.videos\s*\.\s*like\s*\(/,
        "watch route must call api.videos.like",
      );
      assert.match(
        watchSrc,
        /api\.comments\s*\.\s*list\s*\(/,
        "watch route must call api.comments.list",
      );
      assert.match(
        watchSrc,
        /api\.comments\s*\.\s*create\s*\(/,
        "watch route must call api.comments.create",
      );
      assert.ok(
        watchSrc.includes("likeCount.toLocaleString()"),
        "watch route must display real likeCount",
      );

      const shortsSrc = readSrc("src/routes/shorts.tsx");
      assert.match(
        shortsSrc,
        /api\.videos\s*\.\s*like\s*\(/,
        "shorts route must call api.videos.like",
      );
      assert.match(
        shortsSrc,
        /api\.comments\s*\.\s*list\s*\(/,
        "shorts route must call api.comments.list",
      );
      assert.match(
        shortsSrc,
        /api\.comments\s*\.\s*create\s*\(/,
        "shorts route must call api.comments.create",
      );

      for (const liveFile of [
        "src/routes/live-videos.tsx",
        "src/routes/live.tsx",
        "src/components/live/LiveKitViewerPlayer.tsx",
      ]) {
        const src = readSrc(liveFile);
        assert.equal(
          /viewers_count\s*\|\|\s*1\b|initialViewers\s*=\s*1\b|viewersCount\s*\|\|\s*1\b/.test(src),
          false,
          `${liveFile} must not default viewer counts to 1`,
        );
      }
    });

    it("removes static allVideos/creators/recommended imports from liked-videos, watch-later, history, subscriptions, admin, and Navbar", () => {
      for (const file of [
        "src/routes/liked-videos.tsx",
        "src/routes/watch-later.tsx",
        "src/routes/history.tsx",
        "src/routes/subscriptions.tsx",
        "src/routes/admin.tsx",
        "src/components/videohub/Navbar.tsx",
      ]) {
        const src = readSrc(file);
        assert.equal(
          /import\s+(?!type\b)[^;]*\b(allVideos|recommended|creators)\b[^;]*from\s+["']@\/data\/videos["']/s.test(
            src,
          ),
          false,
          `${file} must not import static demo arrays from @/data/videos`,
        );
      }
    });
  });

  describe("5. Backend API Per-Video Engagement Isolation", () => {
    let tempDataDir = "";
    let prevDataDirEnv: string | undefined;

    const testEnv = { APP_ENV: "development", NODE_ENV: "test" };

    before(() => {
      setMysqlPoolForTesting(null);
      prevDataDirEnv = process.env["FACETUBE_DATA_DIR"];
      tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-eng-test-"));
      process.env["FACETUBE_DATA_DIR"] = tempDataDir;

      const storeData = {
        users: [
          {
            id: 1,
            user_id: "FT111111",
            full_name: "Creator One",
            email: "creator1@facetube.test",
            channel_name: "Channel One",
            role: "user",
          },
        ],
        videos: [
          {
            id: "vid-eng-alpha",
            user_id: "FT111111",
            creator_name: "Creator One",
            title: "Alpha Video",
            description: "Alpha",
            video_url: "https://cdn.example.com/alpha.mp4",
            thumbnail_url: "https://cdn.example.com/alpha.jpg",
            video_type: "free",
            content_type: "long",
            category: "Coding",
            duration: "03:00",
            views: 0,
            likes: 0,
            payment_status: "not_required",
            payment_amount: 0,
            is_promoted: false,
            visibility: "public",
            is_blocked: false,
            created_at: "2026-11-25 10:00:00",
            updated_at: "2026-11-25 10:00:00",
          },
          {
            id: "vid-eng-beta",
            user_id: "FT111111",
            creator_name: "Creator One",
            title: "Beta Video",
            description: "Beta",
            video_url: "https://cdn.example.com/beta.mp4",
            thumbnail_url: "https://cdn.example.com/beta.jpg",
            video_type: "free",
            content_type: "short",
            category: "Coding",
            duration: "00:35",
            views: 14,
            likes: 5,
            payment_status: "not_required",
            payment_amount: 0,
            is_promoted: false,
            visibility: "public",
            is_blocked: false,
            created_at: "2026-11-25 11:00:00",
            updated_at: "2026-11-25 11:00:00",
          },
        ],
        comments: [
          {
            id: "cmt-beta-1",
            video_id: "vid-eng-beta",
            user_id: "FT111111",
            user_name: "Channel One",
            avatar_url: "",
            comment: "Beta comment only",
            created_at: "2026-11-25T11:05:00.000Z",
          },
        ],
        images: [],
        wallets: [],
        transactions: [],
        liveStreams: [],
        liveChatMessages: [],
        watchSessions: [],
        watchTimeEvents: [],
        videoWatchDaily: [],
      };

      fs.writeFileSync(
        path.join(tempDataDir, "facetube_store.json"),
        JSON.stringify(storeData, null, 2),
        "utf-8",
      );
      resetInMemoryStore();
    });

    after(() => {
      resetInMemoryStore();
      if (prevDataDirEnv === undefined) {
        delete process.env["FACETUBE_DATA_DIR"];
      } else {
        process.env["FACETUBE_DATA_DIR"] = prevDataDirEnv;
      }
      if (tempDataDir && fs.existsSync(tempDataDir)) {
        fs.rmSync(tempDataDir, { recursive: true, force: true });
      }
    });

    it("returns and updates likes, views, and comments strictly by each video's own ID", async () => {
      // List endpoint returns exact DB/store counts per video ID
      const listRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/list.php"),
        testEnv,
      );
      assert.ok(listRes);
      const listJson = (await listRes.json()) as { success: boolean; videos: any[] };
      assert.equal(listJson.success, true);

      const alphaListed = listJson.videos.find((v) => v.id === "vid-eng-alpha");
      const betaListed = listJson.videos.find((v) => v.id === "vid-eng-beta");
      assert.equal(alphaListed?.views, 0);
      assert.equal(alphaListed?.likes, 0);
      assert.equal(betaListed?.views, 14);
      assert.equal(betaListed?.likes, 5);

      // Alpha initially has 0 comments; Beta has 1 comment
      const alphaCmtRes = await handleApiRequest(
        new Request("http://localhost:3000/api/comments/list.php?videoId=vid-eng-alpha"),
        testEnv,
      );
      assert.ok(alphaCmtRes);
      const alphaCmtJson = (await alphaCmtRes.json()) as { comments: any[]; total: number };
      assert.equal(alphaCmtJson.total, 0);
      assert.equal(alphaCmtJson.comments.length, 0);

      const betaCmtRes = await handleApiRequest(
        new Request("http://localhost:3000/api/comments/list.php?videoId=vid-eng-beta"),
        testEnv,
      );
      assert.ok(betaCmtRes);
      const betaCmtJson = (await betaCmtRes.json()) as { comments: any[]; total: number };
      assert.equal(betaCmtJson.total, 1);
      assert.equal(betaCmtJson.comments[0]?.comment, "Beta comment only");

      // Liking Beta increments Beta from 5 -> 6 without affecting Alpha (still 0)
      const likeBetaRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/like.php", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoId: "vid-eng-beta", userId: "FT111111" }),
        }),
        testEnv,
      );
      assert.ok(likeBetaRes);
      const likeBetaJson = (await likeBetaRes.json()) as { success: boolean; likes: number };
      assert.equal(likeBetaJson.success, true);
      assert.equal(likeBetaJson.likes, 6);

      // Creating a comment on Alpha leaves Beta at 1 comment
      const createCmtRes = await handleApiRequest(
        new Request("http://localhost:3000/api/comments/create.php", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            videoId: "vid-eng-alpha",
            userId: "FT111111",
            userName: "Channel One",
            comment: "First real comment on Alpha",
          }),
        }),
        testEnv,
      );
      assert.ok(createCmtRes);
      const createCmtJson = (await createCmtRes.json()) as { success: boolean };
      assert.equal(createCmtJson.success, true);

      const alphaCmtAfter = await (await handleApiRequest(
        new Request("http://localhost:3000/api/comments/list.php?videoId=vid-eng-alpha"),
        testEnv,
      ))!.json();
      const betaCmtAfter = await (await handleApiRequest(
        new Request("http://localhost:3000/api/comments/list.php?videoId=vid-eng-beta"),
        testEnv,
      ))!.json();
      assert.equal((alphaCmtAfter as any).total, 1);
      assert.equal((betaCmtAfter as any).total, 1);

      const alphaAfterRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/list.php"),
        testEnv,
      );
      const alphaAfterJson = (await alphaAfterRes!.json()) as { videos: any[] };
      const alphaFinal = alphaAfterJson.videos.find((v) => v.id === "vid-eng-alpha");
      const betaFinal = alphaAfterJson.videos.find((v) => v.id === "vid-eng-beta");
      assert.equal(alphaFinal?.likes, 0);
      assert.equal(betaFinal?.likes, 6);
    });
  });

  describe("Critical engagement fixes regression suite", () => {
    let tempDataDir = "";
    const prevDataDirEnv = process.env["FACETUBE_DATA_DIR"];
    const testEnv = { APP_ENV: "development", NODE_ENV: "test" };
    const prodEnv = { APP_ENV: "production", NODE_ENV: "production" };
    const originalApiGet = api.videos.get;

    beforeEach(() => {
      setMysqlPoolForTesting(null);
      resetInMemoryStore();
      tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-eng-fixes-"));
      process.env["FACETUBE_DATA_DIR"] = tempDataDir;

      const storeData = {
        users: [
          {
            id: "u-viewer-a",
            user_id: "FT111111",
            name: "Viewer Alpha",
            mobile: "9000000001",
            email: "viewer-a@example.com",
            password_hash: "hash",
            role: "user",
            referral_code: null,
            channel_name: "Channel One",
            created_at: "2026-11-22T00:00:00.000Z",
          },
          {
            id: "u-viewer-b",
            user_id: "FT222222",
            name: "Viewer Beta",
            mobile: "9000000002",
            email: "viewer-b@example.com",
            password_hash: "hash",
            role: "user",
            referral_code: null,
            channel_name: "Channel Two",
            created_at: "2026-11-22T00:00:00.000Z",
          },
        ],
        sessions: {
          "tok-viewer-a": "FT111111",
          "tok-viewer-b": "FT222222",
        },
        videos: [
          {
            id: "vid-fix-long",
            user_id: "FT111111",
            creator_name: "Channel One",
            title: "Long Fix Video",
            description: "Long video",
            video_url: "https://cdn.example.com/long.mp4",
            thumbnail_url: "https://cdn.example.com/long.jpg",
            video_type: "free",
            content_type: "long",
            category: "Coding",
            duration: "03:00",
            views: 10,
            likes: 1,
            payment_status: "not_required",
            payment_amount: 0,
            is_promoted: false,
            visibility: "public",
            created_at: "2026-11-22T00:00:00.000Z",
            updated_at: "2026-11-22T00:00:00.000Z",
          },
          {
            id: "vid-fix-short",
            user_id: "FT222222",
            creator_name: "Channel Two",
            title: "Short Fix Video",
            description: "Short video",
            video_url: "https://cdn.example.com/short.mp4",
            thumbnail_url: "https://cdn.example.com/short.jpg",
            video_type: "free",
            content_type: "short",
            category: "Music",
            duration: "00:30",
            views: 5,
            likes: 1,
            payment_status: "not_required",
            payment_amount: 0,
            is_promoted: false,
            visibility: "public",
            created_at: "2026-11-22T00:00:00.000Z",
            updated_at: "2026-11-22T00:00:00.000Z",
          },
          {
            id: "vid-fix-zero",
            user_id: "FT222222",
            creator_name: "Channel Two",
            title: "Zero Likes Video",
            description: "Starts with 0 likes",
            video_url: "https://cdn.example.com/zero.mp4",
            thumbnail_url: "https://cdn.example.com/zero.jpg",
            video_type: "free",
            content_type: "long",
            category: "Coding",
            duration: "02:00",
            views: 0,
            likes: 0,
            payment_status: "not_required",
            payment_amount: 0,
            is_promoted: false,
            visibility: "public",
            created_at: "2026-11-22T00:00:00.000Z",
            updated_at: "2026-11-22T00:00:00.000Z",
          },
        ],
        videoLikes: [
          {
            id: 1,
            video_id: "vid-fix-long",
            user_id: "FT111111",
            created_at: "2026-11-22T00:00:00.000Z",
          },
          {
            id: 2,
            video_id: "vid-fix-short",
            user_id: "FT111111",
            created_at: "2026-11-22T00:00:00.000Z",
          },
        ],
        comments: [],
        images: [],
        wallets: {},
        walletTransactions: [],
        channelSubscriptions: [],
        liveStreams: [],
        liveChatMessages: [],
        watchSessions: [],
        watchTimeEvents: [],
        videoWatchDaily: [],
      };

      fs.writeFileSync(
        path.join(tempDataDir, "facetube_store.json"),
        JSON.stringify(storeData, null, 2),
        "utf-8",
      );
      resetInMemoryStore();
    });

    afterEach(() => {
      api.videos.get = originalApiGet;
      setMysqlPoolForTesting(null);
      resetInMemoryStore();
      if (prevDataDirEnv === undefined) {
        delete process.env["FACETUBE_DATA_DIR"];
      } else {
        process.env["FACETUBE_DATA_DIR"] = prevDataDirEnv;
      }
      if (tempDataDir && fs.existsSync(tempDataDir)) {
        fs.rmSync(tempDataDir, { recursive: true, force: true });
      }
    });

    it("Fix 1: watch.$videoId.tsx immediately resets subscribed, subscriberCount, and isSelfChannel when video or creatorUserId changes (even when creatorUserId is missing)", () => {
      const watchSrc = fs.readFileSync(
        path.resolve(process.cwd(), "src/routes/watch.$videoId.tsx"),
        "utf8",
      );
      const resetEffectMatch = watchSrc.match(
        /useEffect\(\(\)\s*=>\s*\{([\s\S]*?)api\.channel\s*\.getStatus\(creatorUserId\)/,
      );
      assert.ok(
        resetEffectMatch?.[1],
        "Expected creator channel status useEffect in watch.$videoId.tsx",
      );
      const beforeGuard = resetEffectMatch[1].split("if (!video || !creatorUserId)")[0] ?? "";
      assert.ok(beforeGuard.includes("setSubscribed(false);"));
      assert.ok(beforeGuard.includes("setSubscriberCount(null);"));
      assert.ok(beforeGuard.includes("setIsSelfChannel(false);"));
      assert.ok(beforeGuard.includes("setIsSubscribing(false);"));
    });

    it("Fix 2: returns viewer-specific viewerLiked/liked from videos/get & videos/list without inferring from total likes, and prevents reload Like->Unlike inversion", async () => {
      // Unauthenticated visitor sees viewerLiked=false even though likes=1
      const unauthGet = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/get.php?id=vid-fix-long"),
        testEnv,
      );
      const unauthGetJson = (await unauthGet!.json()) as { video: any };
      assert.equal(unauthGetJson.video.likes, 1);
      assert.equal(unauthGetJson.video.viewerLiked, false);
      assert.equal(unauthGetJson.video.liked, false);
      assert.equal(unauthGetJson.video.views, 11);

      // Authenticated viewer A (already liked) gets viewerLiked=true without double view increment when skipView=1
      const viewerAGet = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/get.php?id=vid-fix-long&skipView=1", {
          headers: { Authorization: "Bearer tok-viewer-a" },
        }),
        testEnv,
      );
      const viewerAGetJson = (await viewerAGet!.json()) as { video: any };
      assert.equal(viewerAGetJson.video.viewerLiked, true);
      assert.equal(viewerAGetJson.video.liked, true);
      assert.equal(viewerAGetJson.video.views, 11);

      // Authenticated viewer B (has NOT liked) gets viewerLiked=false even though likes=1
      const viewerBGet = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/get.php?id=vid-fix-long&skipView=1", {
          headers: { Authorization: "Bearer tok-viewer-b" },
        }),
        testEnv,
      );
      const viewerBGetJson = (await viewerBGet!.json()) as { video: any };
      assert.equal(viewerBGetJson.video.viewerLiked, false);
      assert.equal(viewerBGetJson.video.liked, false);

      // Shorts list hydrates viewerLiked per authenticated user
      const shortsListA = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/list.php?contentType=short", {
          headers: { Authorization: "Bearer tok-viewer-a" },
        }),
        testEnv,
      );
      const shortsListAJson = (await shortsListA!.json()) as { videos: any[] };
      assert.equal(shortsListAJson.videos[0]?.id, "vid-fix-short");
      assert.equal(shortsListAJson.videos[0]?.viewerLiked, true);

      const shortsListUnauth = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/list.php?contentType=short"),
        testEnv,
      );
      const shortsListUnauthJson = (await shortsListUnauth!.json()) as { videos: any[] };
      assert.equal(shortsListUnauthJson.videos[0]?.viewerLiked, false);

      // Frontend mappers preserve explicit viewerLiked and never infer from total likes
      const mappedUnlikedWithHighCount = mapApiVideoToCatalogVideo({
        id: "vid-mapped-1",
        title: "High Likes Unliked",
        likes: 99,
        views: 500,
      });
      assert.equal(mappedUnlikedWithHighCount.liked, false);
      assert.equal(mappedUnlikedWithHighCount.viewerLiked, false);

      const mappedLiked = mapApiVideoToCatalogVideo(viewerAGetJson.video);
      assert.equal(mappedLiked.liked, true);
      assert.equal(mappedLiked.viewerLiked, true);

      const shortMapped = convertVideoToShortItem(
        makeUploadedVideo({ id: "s-liked", likes: 5, viewerLiked: true, liked: true }),
      );
      assert.equal(shortMapped.liked, true);
      assert.equal(shortMapped.viewerLiked, true);

      // Reloading then toggling Like on an already-liked video unlikes (1 -> 0) instead of double-liking
      const reloadToggleRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/like.php", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer tok-viewer-a",
          },
          body: JSON.stringify({ videoId: "vid-fix-long", userId: "FT111111" }),
        }),
        testEnv,
      );
      const reloadToggleJson = (await reloadToggleRes!.json()) as {
        success: boolean;
        liked: boolean;
        likes: number;
      };
      assert.equal(reloadToggleJson.success, true);
      assert.equal(reloadToggleJson.liked, false);
      assert.equal(reloadToggleJson.likes, 0);
    });

    it("Fix 3 (Store & Auth): toggles Like/Unlike, prevents duplicates and negative counts, and blocks cross-user spoofing", async () => {
      // Cross-user spoofing rejected with 403
      const spoofRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/like.php", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer tok-viewer-a",
          },
          body: JSON.stringify({ videoId: "vid-fix-zero", userId: "FT222222" }),
        }),
        testEnv,
      );
      assert.equal(spoofRes?.status, 403);

      // Missing video returns 404
      const missingRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/like.php", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer tok-viewer-a",
          },
          body: JSON.stringify({ videoId: "vid-does-not-exist", userId: "FT111111" }),
        }),
        testEnv,
      );
      assert.equal(missingRes?.status, 404);

      // Like 0 -> 1, then Unlike 1 -> 0 (never negative)
      const like1 = await (await handleApiRequest(
        new Request("http://localhost:3000/api/videos/like.php", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer tok-viewer-b",
          },
          body: JSON.stringify({ videoId: "vid-fix-zero", userId: "FT222222" }),
        }),
        testEnv,
      ))!.json();
      assert.deepEqual(like1, { success: true, liked: true, likes: 1 });

      const unlike1 = await (await handleApiRequest(
        new Request("http://localhost:3000/api/videos/like.php", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer tok-viewer-b",
          },
          body: JSON.stringify({ videoId: "vid-fix-zero", userId: "FT222222" }),
        }),
        testEnv,
      ))!.json();
      assert.deepEqual(unlike1, { success: true, liked: false, likes: 0 });
    });

    it("Fix 3 (Production MySQL): supports videos stored in MySQL, toggles Like/Unlike safely, hydrates viewerLiked, and rejects unauth with 401", async () => {
      const prevDbHost = process.env["DB_HOST"];
      const prevDbName = process.env["DB_NAME"];
      const prevDbUser = process.env["DB_USER"];
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "facetube_test_user";

      const mysqlVideos = new Map<string, any>([
        [
          "mysql-vid-1",
          {
            id: "mysql-vid-1",
            user_id: "FT999999",
            creator_name: "MySQL Creator",
            title: "MySQL Only Video",
            description: "Stored strictly in MySQL",
            video_url: "https://cdn.example.com/mysql.mp4",
            thumbnail_url: "https://cdn.example.com/mysql.jpg",
            video_type: "free",
            content_type: "long",
            category: "Coding",
            duration: "05:00",
            views: 20,
            likes: 10,
            payment_status: "not_required",
            payment_amount: 0,
            is_promoted: 0,
            visibility: "public",
            is_blocked: 0,
            created_at: "2026-11-22T00:00:00.000Z",
            updated_at: "2026-11-22T00:00:00.000Z",
          },
        ],
      ]);
      const mysqlLikes = new Map<string, { id: number; video_id: string; user_id: string }>();
      let nextLikeId = 1;

      const handleQuery = async (sql: string, params: any[] = []) => {
        if (sql.includes("FROM sessions") || sql.includes("sessions")) {
          if (params[0] === "prod-tok-1") {
            return [[{ id: "u-prod-1", user_id: "FT333333", role: "user", name: "Prod Viewer" }]];
          }
          return [[]];
        }
        if (sql.includes("FROM users")) {
          if (String(params[0] || "").toUpperCase() === "FT333333") {
            return [[{ id: "u-prod-1", user_id: "FT333333", role: "user", name: "Prod Viewer" }]];
          }
          return [[]];
        }
        if (sql.includes("FROM uploaded_videos v") && sql.includes("WHERE v.id = ?")) {
          const row = mysqlVideos.get(String(params[0]));
          return [row ? [{ ...row }] : []];
        }
        if (
          sql.includes("SELECT id, user_id, likes, is_blocked") &&
          sql.includes("FROM uploaded_videos")
        ) {
          const row = mysqlVideos.get(String(params[0]));
          return [row ? [{ ...row }] : []];
        }
        if (sql.includes("SELECT id FROM video_likes")) {
          const vid = String(params[0]);
          const uid = String(params[1] || "").toUpperCase();
          const match = Array.from(mysqlLikes.values()).find(
            (l) => l.video_id === vid && l.user_id.toUpperCase() === uid,
          );
          return [match ? [{ id: match.id }] : []];
        }
        if (sql.startsWith("INSERT INTO video_likes")) {
          const vid = String(params[0]);
          const uid = String(params[1]);
          const key = `${vid}::${uid.toUpperCase()}`;
          if (mysqlLikes.has(key)) {
            throw new Error("Duplicate entry for uniq_video_user_like");
          }
          mysqlLikes.set(key, { id: nextLikeId++, video_id: vid, user_id: uid });
          return [{ affectedRows: 1 }];
        }
        if (sql.startsWith("DELETE FROM video_likes")) {
          const vid = String(params[0]);
          const uid = String(params[1] || "").toUpperCase();
          mysqlLikes.delete(`${vid}::${uid}`);
          return [{ affectedRows: 1 }];
        }
        if (
          sql.includes("UPDATE uploaded_videos SET likes = GREATEST(0, COALESCE(likes, 0) - 1)")
        ) {
          const row = mysqlVideos.get(String(params[0]));
          if (row) row.likes = Math.max(0, Number(row.likes) - 1);
          return [{ affectedRows: 1 }];
        }
        if (sql.includes("UPDATE uploaded_videos SET likes = COALESCE(likes, 0) + 1")) {
          const row = mysqlVideos.get(String(params[0]));
          if (row) row.likes = Number(row.likes) + 1;
          return [{ affectedRows: 1 }];
        }
        if (sql.includes("SELECT likes FROM uploaded_videos")) {
          const row = mysqlVideos.get(String(params[0]));
          return [row ? [{ likes: row.likes }] : []];
        }
        return [[]];
      };

      setMysqlPoolForTesting({
        query: handleQuery,
        getConnection: async () => ({
          query: handleQuery,
          beginTransaction: async () => {},
          commit: async () => {},
          rollback: async () => {},
          release: () => {},
        }),
      } as any);

      try {
        // Unauthenticated like on existing production MySQL video returns 401
        const unauthLikeRes = await handleApiRequest(
          new Request("https://facetube.online/api/videos/like.php", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ videoId: "mysql-vid-1" }),
          }),
          prodEnv,
        );
        assert.equal(unauthLikeRes?.status, 401);
        assert.equal(mysqlVideos.get("mysql-vid-1").likes, 10);

        // Authenticated Like increments 10 -> 11 and sets video_likes row
        const likeRes = await handleApiRequest(
          new Request("https://facetube.online/api/videos/like.php", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer prod-tok-1",
            },
            body: JSON.stringify({ videoId: "mysql-vid-1", userId: "FT333333" }),
          }),
          prodEnv,
        );
        assert.equal(likeRes?.status, 200);
        assert.deepEqual(await likeRes!.json(), { success: true, liked: true, likes: 11 });

        // videos/get for this MySQL video hydrates viewerLiked: true
        const getAfterLike = await (await handleApiRequest(
          new Request("https://facetube.online/api/videos/get.php?id=mysql-vid-1&skipView=1", {
            headers: { Authorization: "Bearer prod-tok-1" },
          }),
          prodEnv,
        ))!.json();
        assert.equal((getAfterLike as any).video.viewerLiked, true);
        assert.equal((getAfterLike as any).video.likes, 11);

        // Second Like toggles to Unlike (11 -> 10)
        const unlikeRes = await handleApiRequest(
          new Request("https://facetube.online/api/videos/like.php", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer prod-tok-1",
            },
            body: JSON.stringify({ videoId: "mysql-vid-1", userId: "FT333333" }),
          }),
          prodEnv,
        );
        assert.deepEqual(await unlikeRes!.json(), { success: true, liked: false, likes: 10 });
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

    it("Fix 4: resolveWatchVideo never returns staticShowcaseVideos or hardcoded demo view counts after HTTP 404", async () => {
      api.videos.get = async () => {
        throw Object.assign(new Error("Video not found"), { status: 404 });
      };

      const showcaseResV1 = await resolveWatchVideo("v1");
      assert.deepEqual(showcaseResV1, { status: "not_found" });

      const showcaseResV2 = await resolveWatchVideo("v2");
      assert.deepEqual(showcaseResV2, { status: "not_found" });

      const missingRes = await resolveWatchVideo("missing-prod-video-id");
      assert.deepEqual(missingRes, { status: "not_found" });
    });
  });
});
