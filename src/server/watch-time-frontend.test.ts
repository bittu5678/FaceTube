import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createWatchTimeTracker } from "../lib/watch-time-tracker.ts";
import {
  buildWatchTimeDashboardViewState,
  formatWatchDurationCompact,
  formatWatchGrowthBadge,
  formatWatchTimeHours,
} from "../lib/watch-time-analytics.ts";
import type {
  WatchTimeAnalyticsResponse,
  WatchTimeHeartbeatRequest,
  WatchTimeHeartbeatResponse,
} from "../lib/api.ts";
import { handleApiRequest } from "./api-handler.ts";

describe("FaceTube Watch Time Frontend, Dashboard Analytics & Red Play Icon Suite", () => {
  it("1. Guest exclusion: never calls session or heartbeat endpoints for unauthenticated viewers", async () => {
    let now = 1_700_000_000_000;
    let startCalls = 0;
    let heartbeatCalls = 0;

    const tracker = createWatchTimeTracker({
      videoId: "vid_guest_1",
      isAuthenticated: false,
      nowMs: () => now,
      isPageVisible: () => true,
      startSession: async () => {
        startCalls += 1;
        return {
          success: true,
          session_id: "should_not_happen",
          video_id: "vid_guest_1",
          content_type: "long",
          is_self_watch: false,
          heartbeat_interval_seconds: 15,
          max_delta_seconds: 30,
          expires_at: new Date(now + 86400_000).toISOString(),
        };
      },
      sendHeartbeat: async () => {
        heartbeatCalls += 1;
        return {
          success: true,
          session_id: "should_not_happen",
          credited_seconds: 0,
          total_watched_seconds: 0,
          is_qualified: false,
          status: "active",
        };
      },
    });

    await tracker.setPlaying(true, 0);
    now += 20_000;
    await tracker.tick();
    await tracker.setVisible(false, 20);
    await tracker.setPlaying(false, 20);
    await tracker.handleEnded(30);
    await tracker.destroy();

    assert.equal(startCalls, 0);
    assert.equal(heartbeatCalls, 0);
    assert.equal(tracker.getStateSnapshot().accumulatedMs, 0);
  });

  it("2. Counts only genuine active visible playback and ignores paused, buffering, and hidden time", async () => {
    let now = 1_700_000_000_000;
    const sentPayloads: Array<{
      payload: WatchTimeHeartbeatRequest;
      keepalive?: boolean | undefined;
    }> = [];

    const tracker = createWatchTimeTracker({
      videoId: "vid_active_1",
      isAuthenticated: true,
      nowMs: () => now,
      isPageVisible: () => true,
      setIntervalFn: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
      startSession: async (videoId) => ({
        success: true,
        session_id: "sess_active_1",
        video_id: videoId,
        content_type: "long",
        is_self_watch: false,
        heartbeat_interval_seconds: 15,
        max_delta_seconds: 30,
        expires_at: new Date(now + 86400_000).toISOString(),
      }),
      sendHeartbeat: async (payload, options) => {
        sentPayloads.push({ payload, keepalive: options?.keepalive });
        return {
          success: true,
          session_id: payload.session_id,
          seq: payload.seq,
          credited_seconds: payload.delta_seconds,
          total_watched_seconds: payload.delta_seconds,
          is_qualified: true,
          status:
            payload.event_type === "ended" || payload.event_type === "unload"
              ? "ended"
              : "active",
        };
      },
    });

    // Play 6s -> pause for 60s (must not count paused time)
    await tracker.setPlaying(true, 0);
    now += 6_000;
    await tracker.setPlaying(false, 6);

    assert.equal(sentPayloads.length, 1);
    assert.equal(sentPayloads[0]?.payload.event_type, "pause");
    assert.equal(sentPayloads[0]?.payload.delta_seconds, 6);
    assert.equal(sentPayloads[0]?.payload.seq, 1);

    // Stay paused for 60 seconds
    now += 60_000;

    // Resume playing for 5s, buffer for 30s (must not count buffering), play 5s more, then hide tab (must flush 10s, not count hidden 45s)
    await tracker.setPlaying(true, 6);
    now += 5_000;
    tracker.setBuffering(true, 11);
    now += 30_000; // buffering time
    tracker.setBuffering(false, 11);
    now += 5_000;
    await tracker.setVisible(false, 16);

    assert.equal(sentPayloads.length, 2);
    assert.equal(sentPayloads[1]?.payload.event_type, "hidden");
    assert.equal(sentPayloads[1]?.payload.delta_seconds, 10);
    assert.equal(sentPayloads[1]?.payload.seq, 2);

    // Stay hidden for 45 seconds (background tab time must not count)
    now += 45_000;
    await tracker.setVisible(true, 16);

    // Play 4 more seconds and unload -> must flush 4s with keepalive: true
    now += 4_000;
    await tracker.destroy();

    assert.equal(sentPayloads.length, 3);
    assert.equal(sentPayloads[2]?.payload.event_type, "unload");
    assert.equal(sentPayloads[2]?.payload.delta_seconds, 4);
    assert.equal(sentPayloads[2]?.payload.seq, 3);
    assert.equal(sentPayloads[2]?.keepalive, true);
  });

  it("3. Retries failed heartbeats with identical seq & idempotency_key without double counting and stops on terminal errors", async () => {
    let now = 1_700_000_000_000;
    const attempts: WatchTimeHeartbeatRequest[] = [];
    let failFirst = true;

    const tracker = createWatchTimeTracker({
      videoId: "vid_retry_1",
      isAuthenticated: true,
      nowMs: () => now,
      isPageVisible: () => true,
      setIntervalFn: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
      startSession: async (videoId) => ({
        success: true,
        session_id: "sess_retry_1",
        video_id: videoId,
        content_type: "long",
        is_self_watch: false,
        heartbeat_interval_seconds: 15,
        max_delta_seconds: 30,
        expires_at: new Date(now + 86400_000).toISOString(),
      }),
      sendHeartbeat: async (payload): Promise<WatchTimeHeartbeatResponse> => {
        attempts.push(payload);
        if (failFirst) {
          failFirst = false;
          const err = new Error("Temporary server 503") as Error & { status?: number };
          err.status = 503;
          throw err;
        }
        return {
          success: true,
          deduplicated: attempts.length === 2,
          session_id: payload.session_id,
          seq: payload.seq,
          credited_seconds: payload.delta_seconds,
          total_watched_seconds: payload.delta_seconds,
          is_qualified: true,
          status: "active",
        };
      },
    });

    await tracker.setPlaying(true, 0);
    now += 15_000;
    await tracker.tick();

    assert.equal(attempts.length, 1);
    assert.equal(tracker.getStateSnapshot().hasPendingRetry, true);

    // Next tick retries exact seq=1 & idempotency_key and does NOT double-send a second heartbeat in the same tick
    now += 15_000;
    await tracker.tick();

    assert.equal(attempts.length, 2);
    assert.equal(attempts[1]?.seq, attempts[0]?.seq);
    assert.equal(attempts[1]?.idempotency_key, attempts[0]?.idempotency_key);
    assert.equal(attempts[1]?.delta_seconds, attempts[0]?.delta_seconds);
    assert.equal(attempts[1]?.client_timestamp, attempts[0]?.client_timestamp);
    assert.equal(tracker.getStateSnapshot().hasPendingRetry, false);

    // Next tick sends seq=2 with wall-clock-safe delta (15s since retry success)
    now += 15_000;
    await tracker.tick();
    assert.equal(attempts.length, 3);
    assert.equal(attempts[2]?.seq, 2);
    assert.equal(attempts[2]?.delta_seconds, 15);
    assert.notEqual(attempts[2]?.idempotency_key, attempts[0]?.idempotency_key);

    await tracker.destroy();
  });

  it("4. Formats Dashboard analytics states accurately: empty data, no prior baseline, and real backend data", () => {
    // A. Empty data
    const emptyRes: WatchTimeAnalyticsResponse = {
      success: true,
      creator_user_id: "FT_CREATOR_1",
      period: "7D",
      days: 7,
      timezone: "UTC",
      has_data: false,
      summary: {
        total_watched_seconds: 0,
        total_hours: 0,
        qualified_watched_seconds: 0,
        qualified_sessions: 0,
        avg_view_duration_seconds: 0,
        avg_view_duration_formatted: "0m 0s",
        previous_period_watched_seconds: 0,
        growth_percent: null,
      },
      lifetime: {
        total_watched_seconds: 0,
        total_hours: 0,
        qualified_watched_seconds: 0,
        qualified_sessions: 0,
        avg_view_duration_seconds: 0,
        avg_view_duration_formatted: "0m 0s",
      },
      history: [
        {
          date: "2026-11-21",
          day: "Sat",
          watched_seconds: 0,
          hours: 0,
          qualified_watched_seconds: 0,
          qualified_sessions: 0,
        },
      ],
      top_videos: [],
    };
    const emptyView = buildWatchTimeDashboardViewState(emptyRes);
    assert.equal(emptyView.hasData, false);
    assert.equal(emptyView.hoursLabel, "0 hrs");
    assert.equal(emptyView.avgViewDurationLabel, "No data yet");
    assert.equal(emptyView.growthLabel, "No prior baseline");
    assert.deepEqual(emptyView.history, []);

    // B. Real data with no prior baseline (growth_percent: null)
    const noBaselineRes: WatchTimeAnalyticsResponse = {
      ...emptyRes,
      has_data: true,
      summary: {
        total_watched_seconds: 5400, // 1.5 hrs
        total_hours: 1.5,
        qualified_watched_seconds: 5400,
        qualified_sessions: 10,
        avg_view_duration_seconds: 540,
        avg_view_duration_formatted: "9m 0s",
        previous_period_watched_seconds: 0,
        growth_percent: null,
      },
      history: [
        {
          date: "2026-11-27",
          day: "Fri",
          watched_seconds: 5400,
          hours: 1.5,
          qualified_watched_seconds: 5400,
          qualified_sessions: 10,
        },
      ],
    };
    const noBaselineView = buildWatchTimeDashboardViewState(noBaselineRes);
    assert.equal(noBaselineView.hasData, true);
    assert.equal(noBaselineView.hoursLabel, "1.5 hrs");
    assert.equal(noBaselineView.avgViewDurationLabel, "9m 0s");
    assert.equal(noBaselineView.growthLabel, "No prior baseline");
    assert.equal(noBaselineView.history.length, 1);

    // C. Real data with positive growth & sub-0.01 edge formatting
    assert.equal(formatWatchTimeHours(0), "0 hrs");
    assert.equal(formatWatchTimeHours(10), "< 0.01 hrs");
    assert.equal(formatWatchTimeHours(9000), "2.5 hrs");
    assert.equal(formatWatchDurationCompact(522), "8m 42s");
    assert.equal(formatWatchDurationCompact(3720), "1h 2m");
    assert.deepEqual(formatWatchGrowthBadge(24.5), { label: "+24.5%", direction: "positive" });
    assert.deepEqual(formatWatchGrowthBadge(-12.3), { label: "-12.3%", direction: "negative" });
    assert.deepEqual(formatWatchGrowthBadge(null), {
      label: "No prior baseline",
      direction: "neutral",
    });
  });

  it("5. End-to-end backend integration: WatchTimeTracker -> handleApiRequest -> Dashboard analytics returns real hours & AVD", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wt-frontend-e2e-"));
    const prevDataDir = process.env["FACETUBE_DATA_DIR"];
    process.env["FACETUBE_DATA_DIR"] = tmpDir;

    try {
      const creatorId = "FT_CREATOR_E2E";
      const viewerId = "FT_VIEWER_E2E";
      const creatorToken = "tok_" + crypto.randomBytes(8).toString("hex");
      const viewerToken = "tok_" + crypto.randomBytes(8).toString("hex");
      const nowSec = Math.floor(Date.now() / 1000);
      const videoId = "vid_e2e_long_1";

      await fs.writeFile(
        path.join(tmpDir, "facetube_store.json"),
        JSON.stringify({
          users: [
            { id: "u_c", user_id: creatorId, name: "Creator E2E", email: "c@e2e.test", role: "user" },
            { id: "u_v", user_id: viewerId, name: "Viewer E2E", email: "v@e2e.test", role: "user" },
          ],
          sessions: [
            { token: creatorToken, userId: creatorId, email: "c@e2e.test", createdAt: new Date().toISOString() },
            { token: viewerToken, userId: viewerId, email: "v@e2e.test", createdAt: new Date().toISOString() },
          ],
          videos: [
            {
              id: videoId,
              user_id: creatorId,
              title: "E2E Real Watch Time Video",
              video_type: "free",
              content_type: "long",
              duration: "10:00",
              visibility: "public",
              payment_status: "not_required",
              is_blocked: 0,
            },
          ],
          images: [],
          transactions: [],
          watchSessions: [],
          watchTimeEvents: [],
          videoWatchDaily: [],
        }),
        "utf8",
      );

      let simulatedEpoch = nowSec - 100;
      const env = {
        NODE_ENV: "development",
        APP_ENV: "development",
        FACETUBE_DATA_DIR: tmpDir,
        __TEST_NOW_EPOCH: String(simulatedEpoch),
      };

      const callApi = async <T>(
        endpoint: string,
        token: string,
        init?: RequestInit,
      ): Promise<T> => {
        env.__TEST_NOW_EPOCH = String(simulatedEpoch);
        const req = new Request(`http://localhost:3000/api${endpoint}`, {
          ...init,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
        });
        const res = await handleApiRequest(req, env);
        return (await res.json()) as T;
      };

      const tracker = createWatchTimeTracker({
        videoId,
        isAuthenticated: true,
        nowMs: () => simulatedEpoch * 1000,
        isPageVisible: () => true,
        setIntervalFn: () => 1 as unknown as ReturnType<typeof setInterval>,
        clearIntervalFn: () => {},
        startSession: (id) =>
          callApi("/watch-time/session.php", viewerToken, {
            method: "POST",
            body: JSON.stringify({ video_id: id }),
          }),
        sendHeartbeat: (payload, opts) =>
          callApi("/watch-time/heartbeat.php", viewerToken, {
            method: "POST",
            body: JSON.stringify(payload),
            ...(opts?.keepalive ? { keepalive: true } : {}),
          }),
      });

      await tracker.setPlaying(true, 0);
      simulatedEpoch += 15;
      await tracker.tick();
      simulatedEpoch += 15;
      await tracker.handleEnded(30);

      const analytics = await callApi<WatchTimeAnalyticsResponse>(
        `/watch-time/analytics.php?user_id=${creatorId}&period=7D`,
        creatorToken,
        { method: "GET" },
      );

      assert.equal(analytics.success, true);
      assert.equal(analytics.has_data, true);
      assert.equal(analytics.summary.total_watched_seconds, 30);
      assert.equal(analytics.summary.qualified_sessions, 1);
      assert.equal(analytics.summary.avg_view_duration_seconds, 30);
      assert.equal(analytics.summary.avg_view_duration_formatted, "0m 30s");
      assert.equal(analytics.summary.growth_percent, null);

      const viewState = buildWatchTimeDashboardViewState(analytics);
      assert.equal(viewState.hasData, true);
      assert.equal(viewState.hoursLabel, "0.01 hrs");
      assert.equal(viewState.avgViewDurationLabel, "0m 30s");
      assert.equal(viewState.growthLabel, "No prior baseline");
    } finally {
      if (prevDataDir === undefined) {
        delete process.env["FACETUBE_DATA_DIR"];
      } else {
        process.env["FACETUBE_DATA_DIR"] = prevDataDir;
      }
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("6. Source verification: Dashboard removes hardcoded fake metrics & players preserve turquoise background with red play triangle", async () => {
    const [dashboardSrc, playerSrc, shortsSrc, watchSrc] = await Promise.all([
      fs.readFile(path.resolve(process.cwd(), "src/routes/dashboard.tsx"), "utf8"),
      fs.readFile(
        path.resolve(process.cwd(), "src/components/videohub/FaceTubeVideoPlayer.tsx"),
        "utf8",
      ),
      fs.readFile(path.resolve(process.cwd(), "src/routes/shorts.tsx"), "utf8"),
      fs.readFile(path.resolve(process.cwd(), "src/routes/watch.$videoId.tsx"), "utf8"),
    ]);

    // No hardcoded Watch Time strings or static array
    assert.equal(dashboardSrc.includes("WATCH_TIME_CHART_DATA"), false);
    assert.equal(dashboardSrc.includes("4,660 hrs"), false);
    assert.equal(dashboardSrc.includes("+18.4%"), false);
    assert.equal(dashboardSrc.includes("8m 42s"), false);

    // Real analytics wiring + empty/baseline messages
    assert.ok(dashboardSrc.includes("api.watchTime.getAnalytics"));
    assert.ok(dashboardSrc.includes("buildWatchTimeDashboardViewState"));
    assert.ok(dashboardSrc.includes("No data yet"));

    // Watch time tracker integrated into long video player and Shorts player
    assert.ok(playerSrc.includes("useWatchTimeTracker"));
    assert.ok(shortsSrc.includes("useWatchTimeTracker"));
    assert.ok(watchSrc.includes("videoId={video.id}"));

    // Task 2: Play icon changed ONLY to red while turquoise background & original dimensions/alignment stay intact
    assert.ok(
      playerSrc.includes(
        'className="grid h-14 w-14 sm:h-16 sm:w-16 place-items-center rounded-full bg-[#00D6C9] text-zinc-950 shadow-lift ring-1 ring-white/25 transition hover:bg-[#00B8AD] active:bg-[#00B8AD] hover:scale-105 active:scale-95 cursor-pointer"',
      ),
    );
    assert.ok(
      playerSrc.includes(
        '<Play className="h-6 w-6 sm:h-7 sm:w-7 translate-x-[1.5px] fill-current text-red-600" />',
      ),
    );
    assert.ok(
      shortsSrc.includes(
        'className="grid h-16 w-16 place-items-center rounded-full bg-[#00D6C9] text-zinc-950 shadow-2xl ring-1 ring-white/25 transition hover:bg-[#00B8AD] active:bg-[#00B8AD] animate-in fade-in zoom-in pointer-events-none"',
      ),
    );
    assert.ok(
      shortsSrc.includes(
        '<Play className="h-8 w-8 translate-x-0.5 fill-current text-red-600" />',
      ),
    );
  });
});
