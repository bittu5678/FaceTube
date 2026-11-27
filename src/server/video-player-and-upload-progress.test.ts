import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  clampSeekTime,
  computeFittedVideoBox,
  computeResponsivePlayerDimensions,
  computeSwipeSeekTime,
  getPlayerContainerClass,
  getPlayerIntrinsicContainerStyle,
  getShortsStageCardClass,
  getUploadPreviewVideoClass,
  resolveEffectiveVideoDimensions,
  resolvePlayerAspectMode,
} from "../lib/video-player-layout.ts";
import {
  computeOverallBatchProgress,
  computeUploadProgressFromEvent,
  createUploadProgressTracker,
  formatRemainingTime,
  formatUploadedTotalPair,
  getUploadFileIdentityKey,
  type UploadProgressSnapshot,
} from "../lib/upload-progress.ts";
import { uploadVideoWithProgress, type XMLHttpRequestLike } from "../lib/api.ts";
import { uploadSingleBulkVideoItem, type BulkUploadProgressState } from "../lib/video-service.ts";

class MockUploadEventTarget {
  private listeners = new Map<string, Array<(ev: any) => void>>();

  addEventListener(type: string, listener: (ev: any) => void) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  emit(type: string, event: any = {}) {
    for (const fn of this.listeners.get(type) ?? []) {
      fn(event);
    }
  }
}

class MockXMLHttpRequest implements XMLHttpRequestLike {
  upload = new MockUploadEventTarget();
  readyState = 0;
  status = 0;
  statusText = "";
  responseText = "";
  method = "";
  url = "";
  headers: Record<string, string> = {};
  sentBody: unknown = null;
  aborted = false;
  private listeners = new Map<string, Array<() => void>>();

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
    this.readyState = 1;
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  send(body?: unknown) {
    this.sentBody = body;
  }

  abort() {
    this.aborted = true;
    this.readyState = 4;
    this.emit("abort");
  }

  addEventListener(type: string, listener: () => void) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  emit(type: string) {
    for (const fn of this.listeners.get(type) ?? []) {
      fn();
    }
  }
}

describe("Video Player Aspect Ratio & Real-Time Upload Progress Regression Suite", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("Task 1: Standard 16:9 Video Player & 9:16 Shorts Aspect Ratio", () => {
    it("1. Normal videos default to responsive 16:9 container classes and preserve 9:16 for Shorts", () => {
      assert.equal(resolvePlayerAspectMode(undefined), "standard");
      assert.equal(resolvePlayerAspectMode("long"), "standard");
      assert.equal(resolvePlayerAspectMode("short"), "short");

      const normalClass = getPlayerContainerClass("standard", false);
      assert.ok(normalClass.includes("aspect-video"));
      assert.ok(normalClass.includes("w-full"));

      const shortPlayerClass = getPlayerContainerClass("short", false);
      assert.ok(shortPlayerClass.includes("aspect-[9/16]"));

      const fullscreenClass = getPlayerContainerClass("standard", true);
      assert.equal(fullscreenClass, "h-full w-full rounded-none");

      const shortsStageClass = getShortsStageCardClass();
      assert.ok(shortsStageClass.includes("aspect-[9/16]"));
      assert.ok(
        shortsStageClass.includes("calc((100vh-160px)*9/16)"),
        "Shorts card width must scale against viewport height so 9:16 ratio never breaks on shorter screens",
      );

      assert.ok(getUploadPreviewVideoClass("long").includes("aspect-video"));
      assert.ok(getUploadPreviewVideoClass("long").includes("object-contain"));
      assert.ok(getUploadPreviewVideoClass("short").includes("aspect-[9/16]"));
      assert.ok(getUploadPreviewVideoClass("short").includes("object-contain"));
    });

    it("2. Supports 1280x720 and 1920x1080 without stretching or distorting aspect ratio", () => {
      const box720 = computeFittedVideoBox(1280, 720, 1280, 720, 0, "standard");
      assert.ok(box720);
      assert.equal(Math.round(box720.baseWidth), 1280);
      assert.equal(Math.round(box720.baseHeight), 720);
      assert.ok(Math.abs(box720.baseWidth / box720.baseHeight - 16 / 9) < 0.0001);

      // Tablet / Mobile 16:9 container playing 1920x1080 source
      const mobileW = 360;
      const mobileH = 202.5;
      const box1080Mobile = computeFittedVideoBox(mobileW, mobileH, 1920, 1080, 0, "standard");
      assert.ok(box1080Mobile);
      assert.ok(
        Math.abs(box1080Mobile.baseWidth / box1080Mobile.baseHeight - 1920 / 1080) < 0.0001,
      );
      assert.ok(box1080Mobile.baseWidth <= mobileW + 0.01);
      assert.ok(box1080Mobile.baseHeight <= mobileH + 0.01);

      // Non-16:9 video (e.g. 9:16 vertical 1080x1920) inside a 16:9 container must letterbox without stretching
      const verticalInStandard = computeFittedVideoBox(960, 540, 1080, 1920, 0, "standard");
      assert.ok(verticalInStandard);
      assert.ok(
        Math.abs(verticalInStandard.baseWidth / verticalInStandard.baseHeight - 9 / 16) < 0.0001,
      );
      assert.equal(Math.round(verticalInStandard.baseHeight), 540);
      assert.ok(verticalInStandard.baseWidth < 960);

      // 90deg quarter-turn rotation keeps visual bounds inside container
      const rotated = computeFittedVideoBox(960, 540, 1920, 1080, 90, "standard");
      assert.ok(rotated);
      assert.ok(rotated.visualWidth <= 960.01);
      assert.ok(rotated.visualHeight <= 540.01);
      assert.ok(Math.abs(rotated.baseWidth / rotated.baseHeight - 16 / 9) < 0.0001);
    });

    it("3. Player components & routes preserve object-contain, controls, auth, and 9:16 Shorts behavior", async () => {
      const playerSrc = await fs.readFile(
        path.resolve(process.cwd(), "src/components/videohub/FaceTubeVideoPlayer.tsx"),
        "utf8",
      );
      const watchSrc = await fs.readFile(
        path.resolve(process.cwd(), "src/routes/watch.$videoId.tsx"),
        "utf8",
      );
      const shortsSrc = await fs.readFile(
        path.resolve(process.cwd(), "src/routes/shorts.tsx"),
        "utf8",
      );

      assert.ok(playerSrc.includes("object-contain"));
      assert.ok(playerSrc.includes("FaceTube Player"));
      assert.ok(playerSrc.includes("toggleFullscreen"));
      assert.ok(playerSrc.includes("cyclePlaybackSpeed"));
      assert.ok(playerSrc.includes("getPlayerContainerClass"));
      assert.ok(playerSrc.includes("getPlayerIntrinsicContainerStyle"));

      assert.ok(watchSrc.includes("resolveWatchVideo"));
      assert.ok(watchSrc.includes("contentType="));
      assert.ok(
        watchSrc.includes("pt-0 pb-24 sm:px-6"),
        "Watch page main must start at top (pt-0) immediately below Navbar",
      );
      assert.ok(
        !watchSrc.includes("sm:pt-3"),
        "Unnecessary top padding above watch player must be removed",
      );
      assert.ok(
        !watchSrc.includes(
          'className="mx-auto w-full overflow-hidden rounded-2xl bg-black shadow-lift"',
        ),
        "Outer full-width bg-black wrapper must not add black pillar space around intrinsic player",
      );

      assert.ok(shortsSrc.includes("getShortsStageCardClass"));
      assert.ok(shortsSrc.includes("object-contain"));
      assert.ok(
        !shortsSrc.includes("w-2/3 animate-pulse"),
        "Hardcoded fake Shorts progress bar must be removed",
      );
    });

    it("4. Intrinsic container sizing supports portrait 9:16, landscape 16:9, square 1:1, ultrawide, rotation, fullscreen, and metadata fallback", () => {
      // Metadata not yet loaded -> null (falls back safely to getPlayerContainerClass)
      assert.equal(resolveEffectiveVideoDimensions(0, 0, 0), null);
      assert.equal(getPlayerIntrinsicContainerStyle(0, 0, 0, false), null);
      assert.equal(getPlayerIntrinsicContainerStyle(-100, 720, 0, false), null);
      assert.equal(getPlayerIntrinsicContainerStyle(Number.NaN, 1080, 0, false), null);

      // Portrait 9:16 (1080x1920)
      const portraitStyle = getPlayerIntrinsicContainerStyle(1080, 1920, 0, false);
      assert.deepEqual(portraitStyle, {
        width: "min(100%, calc(80vh * 1080 / 1920))",
        maxWidth: "100%",
        aspectRatio: "1080 / 1920",
      });
      // Desktop 80vh=720px -> 405x720; Mobile 360px wide -> 360x640
      const portraitDesktopFit = computeFittedVideoBox(405, 720, 1080, 1920, 0, "standard");
      assert.ok(portraitDesktopFit);
      assert.equal(Math.round(portraitDesktopFit.baseWidth), 405);
      assert.equal(Math.round(portraitDesktopFit.baseHeight), 720);

      // Landscape 16:9 (1920x1080)
      const landscapeStyle = getPlayerIntrinsicContainerStyle(1920, 1080, 0, false);
      assert.deepEqual(landscapeStyle, {
        width: "min(100%, calc(80vh * 1920 / 1080))",
        maxWidth: "100%",
        aspectRatio: "1920 / 1080",
      });

      // Square 1:1 (1080x1080)
      const squareStyle = getPlayerIntrinsicContainerStyle(1080, 1080, 0, false);
      assert.deepEqual(squareStyle, {
        width: "min(100%, calc(80vh * 1080 / 1080))",
        maxWidth: "100%",
        aspectRatio: "1080 / 1080",
      });
      const squareMobileFit = computeFittedVideoBox(358, 358, 1080, 1080, 0, "standard");
      assert.ok(squareMobileFit);
      assert.equal(Math.round(squareMobileFit.baseWidth), 358);
      assert.equal(Math.round(squareMobileFit.baseHeight), 358);

      // Ultrawide 21:9 (2560x1080) -> exact 21:9 height with zero black bars above/below
      const ultrawideStyle = getPlayerIntrinsicContainerStyle(2560, 1080, 0, false);
      assert.deepEqual(ultrawideStyle, {
        width: "min(100%, calc(80vh * 2560 / 1080))",
        maxWidth: "100%",
        aspectRatio: "2560 / 1080",
      });
      const ultrawideDesktopFit = computeFittedVideoBox(960, 405, 2560, 1080, 0, "standard");
      assert.ok(ultrawideDesktopFit);
      assert.equal(Math.round(ultrawideDesktopFit.baseWidth), 960);
      assert.equal(Math.round(ultrawideDesktopFit.baseHeight), 405);

      // Quarter-turn rotations (90° and 270°) swap width & height cleanly; 180° keeps original
      const rotated90Style = getPlayerIntrinsicContainerStyle(1920, 1080, 90, false);
      assert.deepEqual(rotated90Style, {
        width: "min(100%, calc(80vh * 1080 / 1920))",
        maxWidth: "100%",
        aspectRatio: "1080 / 1920",
      });
      const rotated270Style = getPlayerIntrinsicContainerStyle(1080, 1920, -90, false);
      assert.deepEqual(rotated270Style, {
        width: "min(100%, calc(80vh * 1920 / 1080))",
        maxWidth: "100%",
        aspectRatio: "1920 / 1080",
      });
      const rotated180Style = getPlayerIntrinsicContainerStyle(1920, 1080, 180, false);
      assert.deepEqual(rotated180Style, landscapeStyle);

      // Rotated 90° video inside matching rotated container fills 100% without clipping or bars
      const rotatedFit = computeFittedVideoBox(405, 720, 1920, 1080, 90, "standard");
      assert.ok(rotatedFit);
      assert.equal(Math.round(rotatedFit.visualWidth), 405);
      assert.equal(Math.round(rotatedFit.visualHeight), 720);

      // Fullscreen disables intrinsic constraint so viewport-filling class applies
      assert.equal(getPlayerIntrinsicContainerStyle(1920, 1080, 0, true), null);
      assert.equal(getPlayerContainerClass("standard", true), "h-full w-full rounded-none");
    });

    it("5. Responsive Watch player matrix passes at 360px, 390px, 768px, 1024px, 1366px, and 1920px for landscape, portrait, square, rotation, and fullscreen", async () => {
      const viewports = [
        { width: 360, height: 800, label: "Small mobile (360px)" },
        { width: 390, height: 844, label: "Large mobile (390px)" },
        { width: 768, height: 1024, label: "Tablet portrait (768px)" },
        { width: 1024, height: 768, label: "Tablet landscape / small laptop (1024px)" },
        { width: 1366, height: 768, label: "Laptop (1366px)" },
        { width: 1920, height: 1080, label: "Desktop monitor (1920px)" },
      ];

      for (const vp of viewports) {
        // Landscape 16:9 (1920x1080)
        const landscape = computeResponsivePlayerDimensions(
          vp.width,
          vp.height,
          1920,
          1080,
          0,
          false,
        );
        assert.ok(landscape, `${vp.label} landscape should compute`);
        assert.ok(landscape.containerWidth <= vp.width + 0.01);
        assert.ok(landscape.containerHeight <= vp.height * 0.8 + 0.01);
        assert.ok(Math.abs(landscape.videoWidth / landscape.videoHeight - 16 / 9) < 0.001);
        assert.equal(Math.round(landscape.videoWidth), Math.round(landscape.containerWidth));
        assert.equal(Math.round(landscape.videoHeight), Math.round(landscape.containerHeight));
        assert.equal(landscape.isEdgeToEdgeMobile, vp.width < 640);

        // Portrait 9:16 (1080x1920)
        const portrait = computeResponsivePlayerDimensions(
          vp.width,
          vp.height,
          1080,
          1920,
          0,
          false,
        );
        assert.ok(portrait, `${vp.label} portrait should compute`);
        assert.ok(portrait.containerWidth <= vp.width + 0.01);
        assert.ok(portrait.containerHeight <= vp.height * 0.8 + 0.01);
        assert.ok(Math.abs(portrait.videoWidth / portrait.videoHeight - 9 / 16) < 0.001);
        assert.equal(Math.round(portrait.videoWidth), Math.round(portrait.containerWidth));
        assert.equal(Math.round(portrait.videoHeight), Math.round(portrait.containerHeight));

        // Square 1:1 (1080x1080)
        const square = computeResponsivePlayerDimensions(vp.width, vp.height, 1080, 1080, 0, false);
        assert.ok(square, `${vp.label} square should compute`);
        assert.ok(square.containerHeight <= vp.height * 0.8 + 0.01);
        assert.ok(Math.abs(square.videoWidth / square.videoHeight - 1) < 0.001);

        // Quarter-turn rotated 90deg landscape becomes portrait cleanly without clipping
        const rotated90 = computeResponsivePlayerDimensions(
          vp.width,
          vp.height,
          1920,
          1080,
          90,
          false,
        );
        assert.ok(rotated90);
        assert.ok(rotated90.videoWidth <= rotated90.containerWidth + 0.01);
        assert.ok(rotated90.videoHeight <= rotated90.containerHeight + 0.01);

        // Fullscreen fills viewport bounds cleanly while preserving video aspect ratio
        const fsLandscape = computeResponsivePlayerDimensions(
          vp.width,
          vp.height,
          1920,
          1080,
          0,
          true,
        );
        assert.ok(fsLandscape);
        assert.equal(fsLandscape.containerWidth, vp.width);
        assert.equal(fsLandscape.containerHeight, vp.height);
        assert.ok(fsLandscape.videoWidth <= vp.width + 0.01);
        assert.ok(fsLandscape.videoHeight <= vp.height + 0.01);
      }

      // Swipe-to-seek & skip clamping math
      assert.equal(clampSeekTime(-5, 120), 0);
      assert.equal(clampSeekTime(150, 120), 120);
      assert.equal(clampSeekTime(Number.NaN, 120), 0);
      assert.equal(computeSwipeSeekTime(20, 180, 360, 120), 50);
      assert.equal(computeSwipeSeekTime(10, -300, 360, 120), 0);
      assert.equal(computeSwipeSeekTime(110, 300, 360, 120), 120);

      // Verify responsive HUD, edge-to-edge mobile framing, ±10s skip, settings drawer & WebKit fullscreen in source
      const playerSrc = await fs.readFile(
        path.resolve(process.cwd(), "src/components/videohub/FaceTubeVideoPlayer.tsx"),
        "utf8",
      );
      const watchSrc = await fs.readFile(
        path.resolve(process.cwd(), "src/routes/watch.$videoId.tsx"),
        "utf8",
      );

      assert.ok(playerSrc.includes("rounded-none sm:rounded-2xl"));
      assert.ok(playerSrc.includes("Skip back 10 seconds"));
      assert.ok(playerSrc.includes("Skip forward 10 seconds"));
      assert.ok(playerSrc.includes("Player settings and transform tools"));
      assert.ok(playerSrc.includes("renderBackCategoryToolbarRow"));
      assert.ok(playerSrc.includes("Video zoom, rotation, and playback speed controls"));
      assert.ok(
        playerSrc.includes(
          "min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        ),
      );
      assert.ok(playerSrc.includes("webkitfullscreenchange"));
      assert.ok(playerSrc.includes("webkitEnterFullscreen"));
      assert.ok(playerSrc.includes("computeSwipeSeekTime"));
      assert.ok(watchSrc.includes("-mx-4 w-[calc(100%+2rem)] sm:mx-0 sm:w-full"));
      assert.ok(watchSrc.includes('category={video.category || "General"}'));
      assert.ok(
        !watchSrc.includes("Back Navigation & Category Bar below player"),
        "Watch page must not render a duplicate Back/Category row separate from player toolbar",
      );
    });

    it("6. Global watch layout applies consistently across video types (portrait, landscape, square, ultrawide), categories, and entry routes", async () => {
      const [playerSrc, watchSrc, cardSrc, freeSrc, premiumSrc, adsSrc, watchLaterSrc, likedSrc] =
        await Promise.all([
          fs.readFile(
            path.resolve(process.cwd(), "src/components/videohub/FaceTubeVideoPlayer.tsx"),
            "utf8",
          ),
          fs.readFile(path.resolve(process.cwd(), "src/routes/watch.$videoId.tsx"), "utf8"),
          fs.readFile(path.resolve(process.cwd(), "src/components/videohub/VideoCard.tsx"), "utf8"),
          fs.readFile(path.resolve(process.cwd(), "src/routes/free-videos.tsx"), "utf8"),
          fs.readFile(path.resolve(process.cwd(), "src/routes/premium-videos.tsx"), "utf8"),
          fs.readFile(path.resolve(process.cwd(), "src/routes/advertisement-videos.tsx"), "utf8"),
          fs.readFile(path.resolve(process.cwd(), "src/routes/watch-later.tsx"), "utf8"),
          fs.readFile(path.resolve(process.cwd(), "src/routes/liked-videos.tsx"), "utf8"),
        ]);

      // All watch entry points route to shared /watch/$videoId component
      for (const entrySrc of [cardSrc, freeSrc, premiumSrc, adsSrc, watchLaterSrc, likedSrc]) {
        assert.ok(entrySrc.includes('"/watch/$videoId"'));
      }

      // watch.$videoId.tsx renders shared FaceTubeVideoPlayer with key={video.id}, category fallback, and onBack for every video
      assert.ok(watchSrc.includes("<FaceTubeVideoPlayer"));
      assert.ok(watchSrc.includes("key={video.id}"));
      assert.ok(watchSrc.includes('category={video.category || "General"}'));
      assert.ok(watchSrc.includes("onBack={handleBack}"));

      // Shared FaceTubeVideoPlayer resets speed/tools cleanly across video switches and renders single unified row outside fullscreen
      assert.ok(playerSrc.includes("setPlaybackSpeed(1)"));
      assert.ok(playerSrc.includes("{!isFullscreen && renderBackCategoryToolbarRow(true)}"));
      assert.ok(playerSrc.includes("{isFullscreen && ("));

      // Main Play button uses Electric Cyan/Turquoise (#00D6C9) with darker hover/pressed (#00B8AD) & dark icon, while preserving red scrubber
      const shortsSrc = await fs.readFile(
        path.resolve(process.cwd(), "src/routes/shorts.tsx"),
        "utf8",
      );
      assert.ok(playerSrc.includes("bg-[#00D6C9] text-zinc-950"));
      assert.ok(playerSrc.includes("hover:bg-[#00B8AD] active:bg-[#00B8AD]"));
      assert.ok(playerSrc.includes("h-full bg-brand transition-all duration-75"));
      assert.ok(shortsSrc.includes("bg-[#00D6C9] text-zinc-950"));

      // Verify both "short" (9:16 portrait) and "standard" (16:9 landscape, 1:1 square, 21:9 ultrawide) compute valid non-clipping dimensions at all 6 viewports
      const samples = [
        { mode: "short" as const, w: 720, h: 1280, label: "Portrait Short" },
        { mode: "standard" as const, w: 1920, h: 1080, label: "Landscape HD" },
        { mode: "standard" as const, w: 1080, h: 1080, label: "Square" },
        { mode: "standard" as const, w: 2560, h: 1080, label: "Ultrawide" },
      ];
      for (const vp of [
        [360, 800],
        [390, 844],
        [768, 1024],
        [1024, 768],
        [1366, 768],
        [1920, 1080],
      ] as const) {
        for (const s of samples) {
          const box = computeResponsivePlayerDimensions(vp[0], vp[1], s.w, s.h, 0, false, s.mode);
          assert.ok(box, `${s.label} @ ${vp[0]}x${vp[1]}`);
          assert.ok(box.containerWidth <= vp[0] + 0.01);
          assert.ok(box.containerHeight <= vp[1] * 0.8 + 0.01);
          assert.ok(Math.abs(box.videoWidth / box.videoHeight - s.w / s.h) < 0.001);
        }
      }
    });
  });

  describe("Task 2: Real-Time Upload Progress, Byte Display, ETA, States & Duplicate-Safe Retry", () => {
    it("4. Computes real percentage (never 100% before transfer completes), byte pair, and remaining time", () => {
      const total = 100 * 1024 * 1024; // 100 MB
      const tracker = createUploadProgressTracker(0);

      // Initial sample at t=10s: 20 MB uploaded (2 MB/s)
      const s1 = computeUploadProgressFromEvent(
        tracker,
        { loaded: 20 * 1024 * 1024, total, lengthComputable: true },
        10_000,
      );
      assert.equal(s1.stage, "uploading");
      assert.equal(s1.percentage, 20);
      assert.equal(s1.isIndeterminate, false);
      assert.equal(formatUploadedTotalPair(s1.loadedBytes, s1.totalBytes), "20 MB / 100 MB");
      assert.equal(
        formatRemainingTime(s1.estimatedRemainingSeconds),
        "Approximately 40 seconds remaining",
      );

      // Second sample at t=20s: 45 MB uploaded (2.5 MB/s instantaneous -> smoothed)
      const s2 = computeUploadProgressFromEvent(
        tracker,
        { loaded: 45 * 1024 * 1024, total, lengthComputable: true },
        20_000,
      );
      assert.equal(s2.stage, "uploading");
      assert.equal(s2.percentage, 45);
      assert.equal(formatUploadedTotalPair(s2.loadedBytes, s2.totalBytes), "45 MB / 100 MB");
      assert.ok(s2.estimatedRemainingSeconds !== null && s2.estimatedRemainingSeconds > 0);
      assert.ok(formatRemainingTime(s2.estimatedRemainingSeconds)?.includes("remaining"));

      // Near-complete 99.8% must stay strictly < 100% until loaded === total
      const sNearDone = computeUploadProgressFromEvent(
        tracker,
        { loaded: total - 1024, total, lengthComputable: true },
        35_000,
      );
      assert.equal(sNearDone.stage, "uploading");
      assert.equal(sNearDone.percentage, 99);

      // Actual transfer finished (loaded === total) -> 100% upload_completed
      const sDone = computeUploadProgressFromEvent(
        tracker,
        { loaded: total, total, lengthComputable: true },
        36_000,
      );
      assert.equal(sDone.stage, "upload_completed");
      assert.equal(sDone.percentage, 100);
      assert.equal(sDone.estimatedRemainingSeconds, 0);
    });

    it("5. Returns honest indeterminate progress when lengthComputable is false or total is 0", () => {
      const tracker = createUploadProgressTracker(0);
      const indet = computeUploadProgressFromEvent(
        tracker,
        { loaded: 5 * 1024 * 1024, total: 0, lengthComputable: false },
        5_000,
      );
      assert.equal(indet.stage, "uploading");
      assert.equal(indet.isIndeterminate, true);
      assert.equal(indet.percentage, null);
      assert.equal(indet.estimatedRemainingSeconds, null);
      assert.equal(formatRemainingTime(indet.estimatedRemainingSeconds), null);
      assert.equal(formatUploadedTotalPair(indet.loadedBytes, indet.totalBytes), "5 MB uploaded");
    });

    it("6. uploadVideoWithProgress tracks real XHR upload events -> upload_completed -> server_processing", async () => {
      let mockXhr!: MockXMLHttpRequest;
      const seenSnapshots: UploadProgressSnapshot[] = [];
      const fileBytes = new Uint8Array(1000);
      const file = new File([fileBytes], "lesson.mp4", { type: "video/mp4" });

      const promise = uploadVideoWithProgress(file, {
        baseUrlOverride: "http://localhost:3000/api",
        xhrFactory: () => {
          mockXhr = new MockXMLHttpRequest();
          return mockXhr;
        },
        onProgress: (snap) => seenSnapshots.push(snap),
      });

      assert.equal(mockXhr.method, "POST");
      assert.equal(mockXhr.url, "http://localhost:3000/api/uploads/video.php");
      assert.ok(mockXhr.sentBody instanceof FormData);

      // Emit real byte progress 25% -> 75% -> upload load -> server response
      mockXhr.upload.emit("progress", { loaded: 250, total: 1000, lengthComputable: true });
      mockXhr.upload.emit("progress", { loaded: 750, total: 1000, lengthComputable: true });
      assert.ok(seenSnapshots.some((s) => s.stage === "uploading" && s.percentage === 25));
      assert.ok(seenSnapshots.some((s) => s.stage === "uploading" && s.percentage === 75));
      assert.equal(
        seenSnapshots.some((s) => s.percentage === 100),
        false,
        "Must not report 100% before transfer completes",
      );

      mockXhr.upload.emit("load");
      mockXhr.readyState = 2;
      mockXhr.emit("readystatechange");

      mockXhr.readyState = 4;
      mockXhr.status = 201;
      mockXhr.responseText = JSON.stringify({
        success: true,
        url: "/uploads/videos/lesson.mp4",
        fileName: "lesson.mp4",
        format: "mp4",
      });
      mockXhr.emit("load");

      const result = await promise;
      assert.equal(result.success, true);
      assert.equal(result.url, "/uploads/videos/lesson.mp4");
      assert.ok(seenSnapshots.some((s) => s.stage === "upload_completed" && s.percentage === 100));
      assert.ok(seenSnapshots.some((s) => s.stage === "server_processing" && s.percentage === 100));
    });

    it("7. uploadVideoWithProgress transitions to failed state on HTTP/network error", async () => {
      let mockXhr!: MockXMLHttpRequest;
      const seenSnapshots: UploadProgressSnapshot[] = [];
      const file = new File([new Uint8Array(500)], "broken.mp4", { type: "video/mp4" });

      const promise = uploadVideoWithProgress(file, {
        baseUrlOverride: "http://localhost:3000/api",
        xhrFactory: () => {
          mockXhr = new MockXMLHttpRequest();
          return mockXhr;
        },
        onProgress: (snap) => seenSnapshots.push(snap),
      });

      mockXhr.upload.emit("progress", { loaded: 200, total: 500, lengthComputable: true });
      mockXhr.readyState = 4;
      mockXhr.status = 413;
      mockXhr.responseText = JSON.stringify({ error: "Video exceeds 150MB upload limit." });
      mockXhr.emit("load");

      await assert.rejects(() => promise, /150MB/);
      const last = seenSnapshots.at(-1);
      assert.equal(last?.stage, "failed");
      assert.ok(last?.errorMessage?.includes("150MB"));
    });

    it("8. Bulk queue aggregates multi-file progress and retries failed items without duplicate video uploads", async () => {
      const batch = computeOverallBatchProgress([
        {
          fileSize: 100 * 1024 * 1024,
          status: "success",
          uploadStage: "completed",
          loadedBytes: 100 * 1024 * 1024,
          totalBytes: 100 * 1024 * 1024,
        },
        {
          fileSize: 100 * 1024 * 1024,
          status: "uploading",
          uploadStage: "uploading",
          loadedBytes: 50 * 1024 * 1024,
          totalBytes: 100 * 1024 * 1024,
          bytesPerSecond: 5 * 1024 * 1024,
        },
        {
          fileSize: 50 * 1024 * 1024,
          status: "queued",
        },
      ]);
      assert.equal(batch.totalFiles, 3);
      assert.equal(batch.completedFiles, 1);
      assert.equal(batch.activeFiles, 1);
      assert.equal(batch.totalBytes, 250 * 1024 * 1024);
      assert.equal(batch.uploadedBytes, 150 * 1024 * 1024);
      assert.equal(batch.percentage, 60);
      assert.equal(batch.estimatedRemainingSeconds, 20);

      // Test duplicate-safe retry via uploadSingleBulkVideoItem cachedVideoUrl
      let videoUploadHits = 0;
      let createHits = 0;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/uploads/video.php")) {
          videoUploadHits += 1;
          return new Response(
            JSON.stringify({ success: true, url: "/uploads/videos/bulk_retry.mp4", format: "mp4" }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/videos/create.php")) {
          createHits += 1;
          if (createHits === 1) {
            return new Response(JSON.stringify({ error: "Temporary DB timeout" }), {
              status: 503,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(
            JSON.stringify({
              success: true,
              video: { id: "vid-retried-1", video_url: "/uploads/videos/bulk_retry.mp4" },
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      }) as typeof fetch;

      const file = new File(["video-bytes"], "retry_clip.mp4", { type: "video/mp4" });
      const states1: BulkUploadProgressState[] = [];
      await assert.rejects(
        () =>
          uploadSingleBulkVideoItem(
            {
              id: "bulk-retry-1",
              file,
              title: "Retry Clip",
              description: "",
              contentType: "long",
              category: "Coding",
              thumbnailUrl: "/uploads/images/cover.jpg",
            },
            { userId: "FT483921", creatorName: "Alex Rivera" },
            (st) => states1.push(st),
          ),
        /Temporary DB timeout/,
      );
      assert.equal(videoUploadHits, 1);
      const cachedUrl = states1.find((s) => s.uploadedVideoUrl)?.uploadedVideoUrl;
      assert.equal(cachedUrl, "/uploads/videos/bulk_retry.mp4");

      // Retry passing cachedVideoUrl -> must NOT call /uploads/video.php a second time
      const states2: BulkUploadProgressState[] = [];
      const retried = await uploadSingleBulkVideoItem(
        {
          id: "bulk-retry-1",
          file,
          title: "Retry Clip",
          description: "",
          contentType: "long",
          category: "Coding",
          thumbnailUrl: "/uploads/images/cover.jpg",
          cachedVideoUrl: cachedUrl,
        },
        { userId: "FT483921", creatorName: "Alex Rivera" },
        (st) => states2.push(st),
      );
      assert.equal(videoUploadHits, 1, "Retry with cachedVideoUrl must not re-upload video file");
      assert.equal(retried.id, "vid-retried-1");
      assert.equal(states2.at(-1)?.uploadStage, "completed");
      assert.ok(getUploadFileIdentityKey(file).includes("retry_clip.mp4"));
    });

    it("9. upload.tsx and ads-promotions.tsx do not hardcode fake step percentages", async () => {
      const uploadSrc = await fs.readFile(
        path.resolve(process.cwd(), "src/routes/upload.tsx"),
        "utf8",
      );
      const adsSrc = await fs.readFile(
        path.resolve(process.cwd(), "src/routes/ads-promotions.tsx"),
        "utf8",
      );

      assert.ok(!uploadSrc.includes("progress: 15"), "Fake progress: 15 must be removed");
      assert.ok(!uploadSrc.includes("progress: 35"), "Fake progress: 35 must be removed");
      assert.ok(!uploadSrc.includes("progress: 65"), "Fake progress: 65 must be removed");
      assert.ok(!uploadSrc.includes("progress: 80"), "Fake progress: 80 must be removed");
      assert.ok(!uploadSrc.includes("progress: 85"), "Fake progress: 85 must be removed");
      assert.ok(uploadSrc.includes("UploadProgressPanel"));
      assert.ok(uploadSrc.includes("computeOverallBatchProgress"));
      assert.ok(adsSrc.includes("UploadProgressPanel"));
    });
  });
});
