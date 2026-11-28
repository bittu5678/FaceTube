import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleApiRequest, resetInMemoryStore } from "./api-handler.ts";
import { setMysqlPoolForTesting } from "./mysql.ts";
import {
  splitWatchSecondsAcrossUtcMidnight,
  computeAverageViewDurationSeconds,
} from "./watch-time.ts";

describe("FaceTube Phase 2: Watch Time Tracking Backend Tests", () => {
  let tempDataDir = "";
  let prevDataDirEnv: string | undefined;
  let adminToken = "";
  let alexToken = "";
  let mayaToken = "";

  const alexUserId = "FT483921";
  const mayaUserId = "FT900431";

  const publicLongVideoId = "vid-seed-002"; // Owned by Alex (FT483921), long
  const publicShortVideoId = "vid-seed-001"; // Owned by Alex (FT483921), short (0:42)
  const mayaLongVideoId = "vid-seed-004"; // Owned by Maya (FT900431), premium paid
  const blockedVideoId = "vid-wt-blocked";
  const privateVideoId = "vid-wt-private";
  const unpaidPremiumVideoId = "vid-wt-unpaid";

  function envAt(epochSec?: number): Record<string, string | undefined> {
    const base: Record<string, string | undefined> = {
      APP_ENV: "development",
      NODE_ENV: "test",
    };
    if (epochSec !== undefined) {
      base["__TEST_NOW_EPOCH"] = String(epochSec);
    }
    return base;
  }

  function seedTempStore(): void {
    const storeFile = path.join(tempDataDir, "facetube_store.json");
    const raw = fs.readFileSync(path.resolve(process.cwd(), "data/facetube_store.json"), "utf-8");
    const store = JSON.parse(raw);

    // Ensure test special videos exist inside isolated temp store only
    const extraVideos = [
      {
        id: blockedVideoId,
        user_id: alexUserId,
        creator_name: "Alex Rivera",
        title: "Blocked Test Video",
        description: "",
        video_url: "https://example.com/blocked.mp4",
        thumbnail_url: "",
        video_type: "free",
        content_type: "long",
        category: "Coding",
        duration: "5:00",
        views: 10,
        likes: 0,
        payment_status: "not_required",
        payment_amount: 0,
        is_promoted: false,
        visibility: "public",
        is_blocked: true,
        block_reason: "Policy violation",
        created_at: "2026-11-01 00:00:00",
        updated_at: "2026-11-01 00:00:00",
      },
      {
        id: privateVideoId,
        user_id: alexUserId,
        creator_name: "Alex Rivera",
        title: "Private Test Video",
        description: "",
        video_url: "https://example.com/private.mp4",
        thumbnail_url: "",
        video_type: "free",
        content_type: "long",
        category: "Coding",
        duration: "5:00",
        views: 10,
        likes: 0,
        payment_status: "not_required",
        payment_amount: 0,
        is_promoted: false,
        visibility: "private",
        is_blocked: false,
        created_at: "2026-11-01 00:00:00",
        updated_at: "2026-11-01 00:00:00",
      },
      {
        id: unpaidPremiumVideoId,
        user_id: alexUserId,
        creator_name: "Alex Rivera",
        title: "Unpaid Sponsor Video",
        description: "",
        video_url: "https://example.com/unpaid.mp4",
        thumbnail_url: "",
        video_type: "premium",
        content_type: "long",
        category: "Coding",
        duration: "5:00",
        views: 10,
        likes: 0,
        payment_status: "pending",
        payment_amount: 6,
        is_promoted: false,
        visibility: "public",
        is_blocked: false,
        created_at: "2026-11-01 00:00:00",
        updated_at: "2026-11-01 00:00:00",
      },
    ];
    store.videos = [
      ...store.videos.filter(
        (v: any) => ![blockedVideoId, privateVideoId, unpaidPremiumVideoId].includes(v.id),
      ),
      ...extraVideos,
    ];
    store.watchSessions = [];
    store.watchTimeEvents = [];
    store.videoWatchDaily = [];
    fs.writeFileSync(storeFile, JSON.stringify(store, null, 2), "utf-8");
    resetInMemoryStore();
  }

  before(async () => {
    setMysqlPoolForTesting(null);
    prevDataDirEnv = process.env["FACETUBE_DATA_DIR"];
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-wt-test-"));
    process.env["FACETUBE_DATA_DIR"] = tempDataDir;
    seedTempStore();

    const login = async (identifier: string, password: string) => {
      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/auth/login.php", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier, password }),
        }),
        envAt(),
      );
      assert.ok(res);
      const data = (await res.json()) as any;
      assert.ok(data.token, `Login must succeed for ${identifier}`);
      return String(data.token);
    };

    adminToken = await login("admin@facetube.com", "password");
    alexToken = await login("alex@facetube.com", "password123");
    mayaToken = await login("maya@facetube.com", "password123");
  });

  after(() => {
    setMysqlPoolForTesting(null);
    if (prevDataDirEnv === undefined) {
      delete process.env["FACETUBE_DATA_DIR"];
    } else {
      process.env["FACETUBE_DATA_DIR"] = prevDataDirEnv;
    }
    resetInMemoryStore();
    if (tempDataDir && fs.existsSync(tempDataDir)) {
      fs.rmSync(tempDataDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    setMysqlPoolForTesting(null);
    const storeFile = path.join(tempDataDir, "facetube_store.json");
    const store = JSON.parse(fs.readFileSync(storeFile, "utf-8"));
    store.watchSessions = [];
    store.watchTimeEvents = [];
    store.videoWatchDaily = [];
    fs.writeFileSync(storeFile, JSON.stringify(store, null, 2), "utf-8");
    resetInMemoryStore();
  });

  async function startSession(
    token: string | null,
    videoId: string,
    epochSec?: number,
  ): Promise<{ status: number; data: any }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token !== null) headers["Authorization"] = `Bearer ${token}`;
    const res = await handleApiRequest(
      new Request("http://localhost:3000/api/watch-time/session.php", {
        method: "POST",
        headers,
        body: JSON.stringify({ video_id: videoId }),
      }),
      envAt(epochSec),
    );
    assert.ok(res);
    return { status: res.status, data: await res.json() };
  }

  async function sendHeartbeat(
    token: string | null,
    body: Record<string, any>,
    epochSec?: number,
  ): Promise<{ status: number; data: any }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token !== null) headers["Authorization"] = `Bearer ${token}`;
    const res = await handleApiRequest(
      new Request("http://localhost:3000/api/watch-time/heartbeat.php", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
      envAt(epochSec),
    );
    assert.ok(res);
    return { status: res.status, data: await res.json() };
  }

  async function getAnalytics(
    token: string | null,
    query = "",
    epochSec?: number,
  ): Promise<{ status: number; data: any }> {
    const headers: Record<string, string> = {};
    if (token !== null) headers["Authorization"] = `Bearer ${token}`;
    const res = await handleApiRequest(
      new Request(`http://localhost:3000/api/watch-time/analytics.php${query}`, {
        method: "GET",
        headers,
      }),
      envAt(epochSec),
    );
    assert.ok(res);
    return { status: res.status, data: await res.json() };
  }

  it("1. Preserves guest video playback & views while enforcing 401 on watch-time endpoints", async () => {
    // Guest can still play public video and increment views via videos/get.php
    const guestVideoRes = await handleApiRequest(
      new Request(`http://localhost:3000/api/videos/get.php?id=${publicLongVideoId}`, {
        method: "GET",
      }),
      envAt(),
    );
    assert.ok(guestVideoRes);
    assert.equal(guestVideoRes.status, 200);
    const guestVideoData = (await guestVideoRes.json()) as any;
    assert.equal(guestVideoData.success, true);

    // Guests cannot start watch sessions, send heartbeats, or read analytics
    const sRes = await startSession(null, publicLongVideoId);
    assert.equal(sRes.status, 401);

    const hRes = await sendHeartbeat(null, {
      session_id: "ws_fake",
      seq: 1,
      idempotency_key: "k1",
      delta_seconds: 10,
    });
    assert.equal(hRes.status, 401);

    const aRes = await getAnalytics(null);
    assert.equal(aRes.status, 401);

    // Malformed auth header is rejected with 401
    const malRes = await handleApiRequest(
      new Request("http://localhost:3000/api/watch-time/analytics.php", {
        method: "GET",
        headers: { Authorization: "Basic malformed" },
      }),
      envAt(),
    );
    assert.ok(malRes);
    assert.equal(malRes.status, 401);
  });

  it("2. Enforces video authorization & cross-user ownership isolation", async () => {
    assert.equal((await startSession(mayaToken, blockedVideoId)).status, 403);
    assert.equal((await startSession(mayaToken, privateVideoId)).status, 403);
    assert.equal((await startSession(mayaToken, unpaidPremiumVideoId)).status, 403);

    // Maya starts valid session on Alex's public video
    const t0 = 1795824000; // 2026-11-28T00:00:00Z
    const s = await startSession(mayaToken, publicLongVideoId, t0);
    assert.equal(s.status, 201);

    // Alex cannot send heartbeat to Maya's watch session
    const hijacked = await sendHeartbeat(
      alexToken,
      {
        session_id: s.data.session_id,
        seq: 1,
        idempotency_key: "hijack_1",
        delta_seconds: 10,
      },
      t0 + 10,
    );
    assert.equal(hijacked.status, 403);

    // Maya cannot query Alex's analytics, Admin can
    assert.equal((await getAnalytics(mayaToken, `?user_id=${alexUserId}`)).status, 403);
    assert.equal((await getAnalytics(adminToken, `?user_id=${alexUserId}`)).status, 200);
  });

  it("3. Validates untrusted timestamps, wall-clock bounds, session expiry & invalid payloads", async () => {
    const t0 = 1795824000;
    const s = await startSession(mayaToken, publicLongVideoId, t0);
    assert.equal(s.status, 201);
    const sid = s.data.session_id;

    // Out-of-range delta_seconds
    assert.equal(
      (
        await sendHeartbeat(
          mayaToken,
          { session_id: sid, seq: 1, idempotency_key: "d0", delta_seconds: 0 },
          t0 + 5,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await sendHeartbeat(
          mayaToken,
          { session_id: sid, seq: 1, idempotency_key: "d31", delta_seconds: 31 },
          t0 + 35,
        )
      ).status,
      400,
    );

    // Claiming 20s watch time when only 2s elapsed since start
    const fast = await sendHeartbeat(
      mayaToken,
      { session_id: sid, seq: 1, idempotency_key: "fast", delta_seconds: 20 },
      t0 + 2,
    );
    assert.equal(fast.status, 400);
    assert.equal(fast.data.code, "DELTA_EXCEEDS_ELAPSED_TIME");

    // Client timestamp in the future
    const futureTs = await sendHeartbeat(
      mayaToken,
      {
        session_id: sid,
        seq: 1,
        idempotency_key: "future",
        delta_seconds: 10,
        client_timestamp: new Date((t0 + 600) * 1000).toISOString(),
      },
      t0 + 10,
    );
    assert.equal(futureTs.status, 400);
    assert.equal(futureTs.data.code, "INVALID_CLIENT_TIMESTAMP");

    // Client timestamp preceding session start
    const preTs = await sendHeartbeat(
      mayaToken,
      {
        session_id: sid,
        seq: 1,
        idempotency_key: "pre",
        delta_seconds: 10,
        client_timestamp: new Date((t0 - 120) * 1000).toISOString(),
      },
      t0 + 10,
    );
    assert.equal(preTs.status, 400);
    assert.equal(preTs.data.code, "INVALID_CLIENT_TIMESTAMP");

    // Expired session after 24h TTL
    const expired = await sendHeartbeat(
      mayaToken,
      { session_id: sid, seq: 1, idempotency_key: "exp", delta_seconds: 10 },
      t0 + 86401,
    );
    assert.equal(expired.status, 409);
    assert.equal(expired.data.code, "SESSION_EXPIRED");
  });

  it("4. Prevents concurrent heartbeat double-counting with atomic locking, seq, and idempotency", async () => {
    const t0 = 1795824000;
    const s = await startSession(mayaToken, publicLongVideoId, t0);
    const sid = s.data.session_id;

    // 5 concurrent identical retries (same idempotency_key & seq)
    const retries = await Promise.all(
      Array.from({ length: 5 }, () =>
        sendHeartbeat(
          mayaToken,
          { session_id: sid, seq: 1, idempotency_key: "same_idem_1", delta_seconds: 15 },
          t0 + 15,
        ),
      ),
    );
    const freshCredits = retries.filter((r) => r.status === 200 && r.data.deduplicated === false);
    const dedupedCredits = retries.filter((r) => r.status === 200 && r.data.deduplicated === true);
    assert.equal(freshCredits.length, 1);
    assert.equal(dedupedCredits.length, 4);

    // 2 concurrent conflicting requests for seq=2 with different idempotency keys
    const conflicts = await Promise.all([
      sendHeartbeat(
        mayaToken,
        { session_id: sid, seq: 2, idempotency_key: "race_a", delta_seconds: 10 },
        t0 + 25,
      ),
      sendHeartbeat(
        mayaToken,
        { session_id: sid, seq: 2, idempotency_key: "race_b", delta_seconds: 10 },
        t0 + 25,
      ),
    ]);
    assert.equal(conflicts.filter((r) => r.status === 200).length, 1);
    assert.equal(conflicts.filter((r) => r.status === 409).length, 1);

    // Stale seq=1 rejected
    const stale = await sendHeartbeat(
      mayaToken,
      { session_id: sid, seq: 1, idempotency_key: "stale_seq_diff_key", delta_seconds: 5 },
      t0 + 30,
    );
    assert.equal(stale.status, 409);

    const analytics = await getAnalytics(alexToken, "?period=7D", t0 + 30);
    assert.equal(analytics.status, 200);
    assert.equal(analytics.data.summary.total_watched_seconds, 25);
    assert.equal(analytics.data.summary.qualified_sessions, 1);
  });

  it("5. Preserves pending valid chunk when session is superseded by a new video", async () => {
    const t0 = 1795824000;
    const s1 = await startSession(mayaToken, publicLongVideoId, t0);
    const sid1 = s1.data.session_id;

    // 10s heartbeat on video 1
    assert.equal(
      (
        await sendHeartbeat(
          mayaToken,
          { session_id: sid1, seq: 1, idempotency_key: "s1_1", delta_seconds: 10 },
          t0 + 10,
        )
      ).status,
      200,
    );

    // User switches across 2 other videos before video 1's final 8s flush lands (max 2 active -> supersedes sid1)
    const s2 = await startSession(mayaToken, publicShortVideoId, t0 + 18);
    assert.equal(s2.status, 201);
    const s3 = await startSession(mayaToken, mayaLongVideoId, t0 + 18);
    assert.equal(s3.status, 201);

    // Delayed final pending chunk for sid1 arrives at t0 + 19 with client_timestamp = t0 + 18
    const graceFlush = await sendHeartbeat(
      mayaToken,
      {
        session_id: sid1,
        seq: 2,
        idempotency_key: "s1_final",
        delta_seconds: 8,
        event_type: "unload",
        client_timestamp: new Date((t0 + 18) * 1000).toISOString(),
      },
      t0 + 19,
    );
    assert.equal(graceFlush.status, 200);
    assert.equal(graceFlush.data.total_watched_seconds, 18);

    // Second chunk after superseded grace is consumed must be rejected
    const extra = await sendHeartbeat(
      mayaToken,
      { session_id: sid1, seq: 3, idempotency_key: "s1_extra", delta_seconds: 5 },
      t0 + 25,
    );
    assert.equal(extra.status, 409);
    assert.equal(extra.data.code, "SESSION_ENDED");
  });

  it("6. Splits watch seconds accurately across UTC midnight boundaries", async () => {
    // 2026-11-27T23:59:50Z -> 2026-11-28T00:00:05Z (15s: 10s Nov 27 + 5s Nov 28)
    const startEpoch = Math.floor(Date.parse("2026-11-27T23:59:50Z") / 1000);
    const hbEpoch = Math.floor(Date.parse("2026-11-28T00:00:05Z") / 1000);

    const directSplit = splitWatchSecondsAcrossUtcMidnight(hbEpoch, 15);
    assert.equal(directSplit.watchDate, "2026-11-28");
    assert.equal(directSplit.primaryDateSeconds, 5);
    assert.equal(directSplit.splitPrevDate, "2026-11-27");
    assert.equal(directSplit.splitPrevSeconds, 10);

    const s = await startSession(mayaToken, publicLongVideoId, startEpoch);
    const hb = await sendHeartbeat(
      mayaToken,
      { session_id: s.data.session_id, seq: 1, idempotency_key: "mid_1", delta_seconds: 15 },
      hbEpoch,
    );
    assert.equal(hb.status, 200);

    const analytics = await getAnalytics(alexToken, "?period=7D", hbEpoch);
    assert.equal(analytics.status, 200);
    const day27 = analytics.data.history.find((h: any) => h.date === "2026-11-27");
    const day28 = analytics.data.history.find((h: any) => h.date === "2026-11-28");
    assert.equal(day27?.watched_seconds, 10);
    assert.equal(day27?.qualified_sessions, 1); // crossed >= 3s on Nov 27
    assert.equal(day28?.watched_seconds, 5);
    assert.equal(day28?.qualified_sessions, 0);
  });

  it("7. Calculates Average View Duration as qualified_watched_seconds / qualified_sessions and excludes unqualified & self-watch", async () => {
    const t0 = 1795824000;
    const storeFile = path.join(tempDataDir, "facetube_store.json");
    const storeBefore = JSON.parse(fs.readFileSync(storeFile, "utf-8"));
    const viewsBefore = storeBefore.videos.find((v: any) => v.id === publicLongVideoId)?.views;
    assert.equal(typeof viewsBefore, "number");

    // 2 unqualified bounce sessions by Maya (1s and 2s -> total 3s, 0 qualified)
    const u1 = await startSession(mayaToken, publicLongVideoId, t0);
    await sendHeartbeat(
      mayaToken,
      {
        session_id: u1.data.session_id,
        seq: 1,
        idempotency_key: "u1",
        delta_seconds: 1,
        event_type: "ended",
      },
      t0 + 2,
    );
    const u2 = await startSession(mayaToken, publicLongVideoId, t0 + 10);
    await sendHeartbeat(
      mayaToken,
      {
        session_id: u2.data.session_id,
        seq: 1,
        idempotency_key: "u2",
        delta_seconds: 2,
        event_type: "ended",
      },
      t0 + 12,
    );

    // Empty qualified check -> AVD must be 0 even though unqualified watch seconds = 3
    const preQual = await getAnalytics(alexToken, "?period=7D", t0 + 15);
    assert.equal(preQual.data.summary.total_watched_seconds, 3);
    assert.equal(preQual.data.summary.qualified_watched_seconds, 0);
    assert.equal(preQual.data.summary.qualified_sessions, 0);
    assert.equal(preQual.data.summary.avg_view_duration_seconds, 0);
    assert.equal(preQual.data.summary.growth_percent, null);
    assert.equal(computeAverageViewDurationSeconds(0, 0), 0);

    // Self-watch by Alex (creator) -> excluded from creator analytics
    const selfSess = await startSession(alexToken, publicLongVideoId, t0 + 20);
    assert.equal(selfSess.data.is_self_watch, true);
    await sendHeartbeat(
      alexToken,
      { session_id: selfSess.data.session_id, seq: 1, idempotency_key: "self1", delta_seconds: 20 },
      t0 + 40,
    );

    // 2 qualified sessions: 20s by Maya + 40s by Admin -> avg = 30s
    const q1 = await startSession(mayaToken, publicLongVideoId, t0 + 100);
    await sendHeartbeat(
      mayaToken,
      {
        session_id: q1.data.session_id,
        seq: 1,
        idempotency_key: "q1",
        delta_seconds: 20,
        event_type: "ended",
      },
      t0 + 120,
    );

    const q2 = await startSession(adminToken, publicLongVideoId, t0 + 200);
    await sendHeartbeat(
      adminToken,
      { session_id: q2.data.session_id, seq: 1, idempotency_key: "q2_1", delta_seconds: 20 },
      t0 + 220,
    );
    await sendHeartbeat(
      adminToken,
      {
        session_id: q2.data.session_id,
        seq: 2,
        idempotency_key: "q2_2",
        delta_seconds: 20,
        event_type: "ended",
      },
      t0 + 240,
    );

    const postQual = await getAnalytics(alexToken, "?period=7D", t0 + 250);
    assert.equal(postQual.data.summary.total_watched_seconds, 63); // 3 unqualified + 60 qualified (self excluded)
    assert.equal(postQual.data.summary.qualified_watched_seconds, 60);
    assert.equal(postQual.data.summary.qualified_sessions, 2);
    assert.equal(postQual.data.summary.avg_view_duration_seconds, 30);
    assert.equal(postQual.data.summary.avg_view_duration_formatted, "0m 30s");

    // Verify uploaded_videos.views was NOT modified by watch-time endpoints
    const store = JSON.parse(fs.readFileSync(storeFile, "utf-8"));
    const vid = store.videos.find((v: any) => v.id === publicLongVideoId);
    assert.equal(vid.views, viewsBefore);
  });

  it("8. Enforces Shorts loop session cap, global 60s velocity limit, and does not leak data across creators", async () => {
    const t0 = 1795824000;
    // Short vid-seed-001 duration=0:42 (42s) -> session cap = min(180, 42*3) = 126s
    const shortSess = await startSession(mayaToken, publicShortVideoId, t0);
    const sid = shortSess.data.session_id;

    // Attempt > 75s inside 60s window triggers VIEWER_VELOCITY_LIMIT (429)
    await sendHeartbeat(
      mayaToken,
      { session_id: sid, seq: 1, idempotency_key: "v1", delta_seconds: 30 },
      t0 + 30,
    );
    await sendHeartbeat(
      mayaToken,
      { session_id: sid, seq: 2, idempotency_key: "v2", delta_seconds: 30 },
      t0 + 60,
    );
    const velBlocked = await sendHeartbeat(
      mayaToken,
      { session_id: sid, seq: 3, idempotency_key: "v3", delta_seconds: 20 },
      t0 + 80,
    );
    assert.equal(velBlocked.status, 429);
    assert.equal(velBlocked.data.code, "VIEWER_VELOCITY_LIMIT");

    // Continue at valid pace until exceeding 126s Short session cap
    assert.equal(
      (
        await sendHeartbeat(
          mayaToken,
          { session_id: sid, seq: 3, idempotency_key: "v3_ok", delta_seconds: 30 },
          t0 + 130,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await sendHeartbeat(
          mayaToken,
          { session_id: sid, seq: 4, idempotency_key: "v4_ok", delta_seconds: 30 },
          t0 + 160,
        )
      ).status,
      200,
    ); // total = 120s
    const shortCapHit = await sendHeartbeat(
      mayaToken,
      { session_id: sid, seq: 5, idempotency_key: "v5_cap", delta_seconds: 10 },
      t0 + 170,
    );
    assert.equal(shortCapHit.status, 429);
    assert.equal(shortCapHit.data.code, "SESSION_CAP_REACHED");

    // Maya's own creator analytics must be empty (has_data: false)
    const mayaAnalytics = await getAnalytics(mayaToken, "?period=7D", t0 + 170);
    assert.equal(mayaAnalytics.status, 200);
    assert.equal(mayaAnalytics.data.has_data, false);
    assert.equal(mayaAnalytics.data.summary.total_hours, 0);
    assert.equal(mayaAnalytics.data.summary.avg_view_duration_seconds, 0);

    // Maya's video (vid-seed-006) watched by Alex credits Maya only
    const sMayaVid = await startSession(alexToken, mayaLongVideoId, t0 + 200);
    assert.equal(sMayaVid.status, 201);
    assert.equal(
      (
        await sendHeartbeat(
          alexToken,
          {
            session_id: sMayaVid.data.session_id,
            seq: 1,
            idempotency_key: "m_1",
            delta_seconds: 12,
          },
          t0 + 215,
        )
      ).status,
      200,
    );
    const mayaAfter = await getAnalytics(mayaToken, "?period=7D", t0 + 215);
    assert.equal(mayaAfter.data.has_data, true);
    assert.equal(mayaAfter.data.summary.total_watched_seconds, 12);
    assert.equal(mayaAfter.data.summary.qualified_sessions, 1);
  });

  it("9. Executes MySQL transaction with strict users -> watch_sessions FOR UPDATE lock order, commit, and release via Mock Pool", async () => {
    const queriesExecuted: string[] = [];
    let txBegun = false;
    let txCommitted = false;
    let released = false;

    const nowEpoch = 1795824000;
    const mockConn = {
      async beginTransaction() {
        txBegun = true;
      },
      async query(sql: string) {
        queriesExecuted.push(sql);
        if (sql.includes("FROM users WHERE user_id = ? FOR UPDATE")) {
          return [[{ id: "a0000000-0000-0000-0000-000000000003" }]];
        }
        if (sql.includes("FROM watch_sessions WHERE id = ? FOR UPDATE")) {
          return [
            [
              {
                id: "ws_mysql_test",
                viewer_user_id: mayaUserId,
                video_id: publicLongVideoId,
                creator_user_id: alexUserId,
                content_type: "long",
                video_duration_seconds: 600,
                is_self_watch: 0,
                status: "active",
                close_reason: null,
                superseded_grace_used: 0,
                total_watched_seconds: 0,
                is_qualified: 0,
                qualified_watch_date: null,
                last_seq: 0,
                last_position_seconds: 0,
                started_at: "2026-11-28 00:00:00",
                last_heartbeat_at: "2026-11-28 00:00:00",
                expires_at: "2026-11-29 00:00:00",
                ended_at: null,
              },
            ],
          ];
        }
        if (sql.includes("FROM watch_time_events WHERE idempotency_key")) return [[]];
        if (sql.includes("FROM watch_time_events WHERE session_id = ? AND seq = ?")) return [[]];
        if (sql.includes("SUM(watched_seconds)")) return [[{ total_sec: 0 }]];
        if (sql.includes("day_sec")) return [[{ day_sec: 0 }]];
        return [{ affectedRows: 1 }];
      },
      async commit() {
        txCommitted = true;
      },
      async rollback() {},
      release() {
        released = true;
      },
    };

    const mockPool = {
      async query(sql: string) {
        if (sql.includes("FROM sessions s")) {
          return [
            [
              {
                id: "a0000000-0000-0000-0000-000000000003",
                user_id: mayaUserId,
                name: "Maya Lin",
                mobile: "+1 555-019-0043",
                email: "maya@facetube.com",
                role: "user",
                referral_code: "FT483921",
                created_at: "2026-11-01 00:00:00",
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
    process.env["DB_USER"] = "facetube_user";

    setMysqlPoolForTesting(mockPool);
    try {
      const res = await sendHeartbeat(
        mayaToken,
        {
          session_id: "ws_mysql_test",
          seq: 1,
          idempotency_key: "mysql_idem_1",
          delta_seconds: 15,
          position_seconds: 15,
        },
        nowEpoch + 15,
      );

      assert.equal(res.status, 200);
      assert.equal(res.data.credited_seconds, 15);
      assert.equal(txBegun, true);
      assert.equal(txCommitted, true);
      assert.equal(released, true);

      const userLockIdx = queriesExecuted.findIndex((q) =>
        q.includes("FROM users WHERE user_id = ? FOR UPDATE"),
      );
      const sessLockIdx = queriesExecuted.findIndex((q) =>
        q.includes("FROM watch_sessions WHERE id = ? FOR UPDATE"),
      );
      assert.ok(userLockIdx >= 0, "Expected SELECT id FROM users WHERE user_id = ? FOR UPDATE");
      assert.ok(
        sessLockIdx > userLockIdx,
        "users row FOR UPDATE lock must be acquired before watch_sessions FOR UPDATE",
      );
      assert.ok(queriesExecuted.some((q) => q.includes("INSERT INTO watch_time_events")));
      assert.ok(queriesExecuted.some((q) => q.includes("INSERT INTO video_watch_daily")));
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

  it("10. Serializes concurrent session creation under zero, one, and two active sessions without exceeding limits", async () => {
    const t0 = 1795824000;
    const storeFile = path.join(tempDataDir, "facetube_store.json");

    // Case A: 0 active rows, concurrent starts on the SAME video -> only 1 active session remains
    const sameVidBurst = await Promise.all([
      startSession(mayaToken, publicLongVideoId, t0),
      startSession(mayaToken, publicLongVideoId, t0),
    ]);
    assert.equal(sameVidBurst.filter((r) => r.status === 201).length, 2);
    let store = JSON.parse(fs.readFileSync(storeFile, "utf-8"));
    let mayaActive = store.watchSessions.filter(
      (s: any) => s.viewer_user_id === mayaUserId && s.status === "active",
    );
    assert.equal(mayaActive.length, 1);

    // Reset watchSessions for Case B: 0 active rows, concurrent starts on 3 DIFFERENT videos -> max 2 active
    store.watchSessions = [];
    fs.writeFileSync(storeFile, JSON.stringify(store, null, 2), "utf-8");
    resetInMemoryStore();

    const threeDiffBurst = await Promise.all([
      startSession(mayaToken, publicLongVideoId, t0 + 10),
      startSession(mayaToken, publicShortVideoId, t0 + 10),
      startSession(mayaToken, mayaLongVideoId, t0 + 10),
    ]);
    assert.equal(threeDiffBurst.filter((r) => r.status === 201).length, 3);
    store = JSON.parse(fs.readFileSync(storeFile, "utf-8"));
    mayaActive = store.watchSessions.filter(
      (s: any) => s.viewer_user_id === mayaUserId && s.status === "active",
    );
    assert.equal(mayaActive.length, 2);

    // Reset watchSessions for Case C: 1 existing active session on Video A, then concurrent starts on Video B & C -> max 2 active
    store.watchSessions = [];
    fs.writeFileSync(storeFile, JSON.stringify(store, null, 2), "utf-8");
    resetInMemoryStore();

    const baseA = await startSession(mayaToken, publicLongVideoId, t0 + 20);
    assert.equal(baseA.status, 201);
    const twoMoreBurst = await Promise.all([
      startSession(mayaToken, publicShortVideoId, t0 + 21),
      startSession(mayaToken, mayaLongVideoId, t0 + 21),
    ]);
    assert.equal(twoMoreBurst.filter((r) => r.status === 201).length, 2);
    store = JSON.parse(fs.readFileSync(storeFile, "utf-8"));
    mayaActive = store.watchSessions.filter(
      (s: any) => s.viewer_user_id === mayaUserId && s.status === "active",
    );
    assert.equal(mayaActive.length, 2);

    // Case D (Mock MySQL): startSession acquires users ... FOR UPDATE before watch_sessions and retries 1213 deadlocks -> 409 TRANSACTION_CONFLICT
    const prevDbHost = process.env["DB_HOST"];
    const prevDbName = process.env["DB_NAME"];
    const prevDbUser = process.env["DB_USER"];
    process.env["DB_HOST"] = "127.0.0.1";
    process.env["DB_NAME"] = "facetube_test";
    process.env["DB_USER"] = "facetube_user";

    const sessQueries: string[] = [];
    let attemptCount = 0;
    const mockAuthQuery = async (sql: string) => {
      if (sql.includes("FROM sessions s")) {
        return [
          [
            {
              id: "a0000000-0000-0000-0000-000000000003",
              user_id: mayaUserId,
              name: "Maya Lin",
              mobile: "+1 555-019-0043",
              email: "maya@facetube.com",
              role: "user",
              referral_code: "FT483921",
              created_at: "2026-11-01 00:00:00",
            },
          ],
        ];
      }
      return [[]];
    };

    try {
      setMysqlPoolForTesting({
        query: mockAuthQuery,
        async getConnection() {
          return {
            async beginTransaction() {},
            async query(sql: string) {
              sessQueries.push(sql);
              if (sql.includes("FROM users WHERE user_id = ? FOR UPDATE")) {
                attemptCount++;
                if (attemptCount === 1) {
                  const err: any = new Error("Deadlock found when trying to get lock");
                  err.errno = 1213;
                  err.code = "ER_LOCK_DEADLOCK";
                  throw err;
                }
                return [[{ id: "a0000000-0000-0000-0000-000000000003" }]];
              }
              if (sql.includes("FROM uploaded_videos")) {
                return [
                  [
                    {
                      id: publicLongVideoId,
                      user_id: alexUserId,
                      video_type: "free",
                      content_type: "long",
                      duration: "10:00",
                      visibility: "public",
                      payment_status: "not_required",
                      is_blocked: 0,
                    },
                  ],
                ];
              }
              if (sql.includes("COUNT(*) AS cnt")) return [[{ cnt: 0 }]];
              if (sql.includes("FROM watch_sessions") && sql.includes("FOR UPDATE")) return [[]];
              return [{ affectedRows: 1 }];
            },
            async commit() {},
            async rollback() {},
            release() {},
          };
        },
      });
      const retrySuccess = await startSession(mayaToken, publicLongVideoId, t0 + 30);
      assert.equal(retrySuccess.status, 201);
      assert.equal(attemptCount, 2);
      const uIdx = sessQueries.findIndex((q) =>
        q.includes("FROM users WHERE user_id = ? FOR UPDATE"),
      );
      const wsIdx = sessQueries.findIndex((q) => q.includes("FROM watch_sessions"));
      assert.ok(uIdx >= 0 && wsIdx > uIdx);

      // Exhaust all 3 attempts with 1213 -> 409 TRANSACTION_CONFLICT
      let exhaustedCalls = 0;
      setMysqlPoolForTesting({
        query: mockAuthQuery,
        async getConnection() {
          return {
            async beginTransaction() {},
            async query() {
              exhaustedCalls++;
              const err: any = new Error("Lock wait timeout exceeded");
              err.errno = 1205;
              err.code = "ER_LOCK_WAIT_TIMEOUT";
              throw err;
            },
            async commit() {},
            async rollback() {},
            release() {},
          };
        },
      });
      const exhaustedRes = await startSession(mayaToken, publicLongVideoId, t0 + 35);
      assert.equal(exhaustedRes.status, 409);
      assert.equal(exhaustedRes.data.code, "TRANSACTION_CONFLICT");
      assert.equal(exhaustedCalls, 3);
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

  it("11. Enforces cross-session velocity & daily caps under concurrent heartbeats (Dev Store + Mock MySQL viewer lock)", async () => {
    const t0 = 1795824000;

    // A. Dev Store: 2 distinct active sessions for Maya (long + short) hitting 75s/60s cap concurrently
    const sA = await startSession(mayaToken, publicLongVideoId, t0);
    const sB = await startSession(mayaToken, publicShortVideoId, t0);
    assert.equal(sA.status, 201);
    assert.equal(sB.status, 201);

    // Seed 50s already watched in window (25s + 25s)
    assert.equal(
      (
        await sendHeartbeat(
          mayaToken,
          { session_id: sA.data.session_id, seq: 1, idempotency_key: "conc_a1", delta_seconds: 25 },
          t0 + 25,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await sendHeartbeat(
          mayaToken,
          { session_id: sB.data.session_id, seq: 1, idempotency_key: "conc_b1", delta_seconds: 25 },
          t0 + 25,
        )
      ).status,
      200,
    );

    // Two concurrent heartbeats of 25s each (50 + 25 + 25 = 100 > 75) -> only 1 succeeds, 1 gets 429
    const velRace = await Promise.all([
      sendHeartbeat(
        mayaToken,
        { session_id: sA.data.session_id, seq: 2, idempotency_key: "conc_a2", delta_seconds: 25 },
        t0 + 50,
      ),
      sendHeartbeat(
        mayaToken,
        { session_id: sB.data.session_id, seq: 2, idempotency_key: "conc_b2", delta_seconds: 25 },
        t0 + 50,
      ),
    ]);
    assert.equal(velRace.filter((r) => r.status === 200).length, 1);
    const velRejected = velRace.filter((r) => r.status === 429);
    assert.equal(velRejected.length, 1);
    assert.equal(velRejected[0]?.data.code, "VIEWER_VELOCITY_LIMIT");

    // B. Dev Store: Concurrent superseded-grace + new-session heartbeats on same Short video cannot exceed 300s/day
    const storeFile = path.join(tempDataDir, "facetube_store.json");
    const store = JSON.parse(fs.readFileSync(storeFile, "utf-8"));
    store.watchSessions = [];
    store.watchTimeEvents = [];
    store.videoWatchDaily = [];
    fs.writeFileSync(storeFile, JSON.stringify(store, null, 2), "utf-8");
    resetInMemoryStore();

    // Advance Maya's Short watch time to 290s across 3 sessions spaced outside 60s window
    const dayT0 = t0;
    const sh1 = await startSession(mayaToken, publicShortVideoId, dayT0);
    for (let i = 1; i <= 4; i++) {
      assert.equal(
        (
          await sendHeartbeat(
            mayaToken,
            {
              session_id: sh1.data.session_id,
              seq: i,
              idempotency_key: `sh1_${i}`,
              delta_seconds: 30,
            },
            dayT0 + i * 65,
          )
        ).status,
        200,
      );
    }
    const sh2 = await startSession(mayaToken, publicShortVideoId, dayT0 + 300);
    for (let i = 1; i <= 4; i++) {
      assert.equal(
        (
          await sendHeartbeat(
            mayaToken,
            {
              session_id: sh2.data.session_id,
              seq: i,
              idempotency_key: `sh2_${i}`,
              delta_seconds: 30,
            },
            dayT0 + 300 + i * 65,
          )
        ).status,
        200,
      );
    }
    const sh3 = await startSession(mayaToken, publicShortVideoId, dayT0 + 600);
    for (let i = 1; i <= 2; i++) {
      assert.equal(
        (
          await sendHeartbeat(
            mayaToken,
            {
              session_id: sh3.data.session_id,
              seq: i,
              idempotency_key: `sh3_${i}`,
              delta_seconds: 25,
            },
            dayT0 + 600 + i * 65,
          )
        ).status,
        200,
      );
    }
    // Total on publicShortVideoId = 120 + 120 + 50 = 290s; start sh4 at dayT0 + 760 (supersedes sh3)
    const sh4 = await startSession(mayaToken, publicShortVideoId, dayT0 + 760);
    assert.equal(sh4.status, 201);
    const dailyRace = await Promise.all([
      sendHeartbeat(
        mayaToken,
        {
          session_id: sh3.data.session_id,
          seq: 3,
          idempotency_key: "sh3_grace",
          delta_seconds: 10,
          event_type: "unload",
          client_timestamp: new Date((dayT0 + 760) * 1000).toISOString(),
        },
        dayT0 + 765,
      ),
      sendHeartbeat(
        mayaToken,
        {
          session_id: sh4.data.session_id,
          seq: 1,
          idempotency_key: "sh4_1",
          delta_seconds: 10,
        },
        dayT0 + 770,
      ),
    ]);
    assert.equal(dailyRace.filter((r) => r.status === 200).length, 1);
    const dailyCapHit = dailyRace.filter((r) => r.status === 429);
    assert.equal(dailyCapHit.length, 1);
    assert.equal(dailyCapHit[0]?.data.code, "DAILY_VIDEO_CAP_REACHED");

    // C. Labeled MOCK MySQL concurrency & deadlock retry test (no live MySQL server in container):
    // Verifies users ... FOR UPDATE serializes two concurrent MySQL transactions on different watch_sessions rows,
    // and verifies bounded retry on errno 1213 deadlock -> 409 TRANSACTION_CONFLICT when exhausted.
    let viewerLockChain = Promise.resolve();
    const committedEvents: Array<{ viewer: string; watched: number }> = [
      { viewer: mayaUserId, watched: 50 },
    ];
    const mockSessions: Record<string, any> = {
      ws_mock_a: {
        id: "ws_mock_a",
        viewer_user_id: mayaUserId,
        video_id: publicLongVideoId,
        creator_user_id: alexUserId,
        content_type: "long",
        video_duration_seconds: 600,
        is_self_watch: 0,
        status: "active",
        close_reason: null,
        superseded_grace_used: 0,
        total_watched_seconds: 25,
        is_qualified: 1,
        qualified_watch_date: "2026-11-28",
        last_seq: 1,
        last_position_seconds: 25,
        started_at: "2026-11-28 00:00:00",
        last_heartbeat_at: "2026-11-28 00:00:25",
        expires_at: "2026-11-29 00:00:00",
        ended_at: null,
      },
      ws_mock_b: {
        id: "ws_mock_b",
        viewer_user_id: mayaUserId,
        video_id: publicShortVideoId,
        creator_user_id: alexUserId,
        content_type: "short",
        video_duration_seconds: 42,
        is_self_watch: 0,
        status: "active",
        close_reason: null,
        superseded_grace_used: 0,
        total_watched_seconds: 25,
        is_qualified: 1,
        qualified_watch_date: "2026-11-28",
        last_seq: 1,
        last_position_seconds: 25,
        started_at: "2026-11-28 00:00:00",
        last_heartbeat_at: "2026-11-28 00:00:25",
        expires_at: "2026-11-29 00:00:00",
        ended_at: null,
      },
    };
    const lockOrderLog: string[] = [];

    const createMockConn = () => {
      let txRelease: (() => void) | null = null;
      let pendingEvent: { viewer: string; watched: number } | null = null;
      return {
        async beginTransaction() {},
        async query(sql: string, params: any[] = []) {
          if (sql.includes("FROM users WHERE user_id = ? FOR UPDATE")) {
            let resolveNext!: () => void;
            const prev = viewerLockChain;
            viewerLockChain = new Promise<void>((res) => {
              resolveNext = res;
            });
            await prev;
            txRelease = resolveNext;
            lockOrderLog.push(`users:${params[0]}`);
            return [[{ id: "a0000000-0000-0000-0000-000000000003" }]];
          }
          if (sql.includes("FROM watch_sessions WHERE id = ? FOR UPDATE")) {
            lockOrderLog.push(`session:${params[0]}`);
            return [[{ ...mockSessions[String(params[0])] }]];
          }
          if (sql.includes("FROM watch_time_events WHERE idempotency_key")) return [[]];
          if (sql.includes("FROM watch_time_events WHERE session_id = ? AND seq = ?")) return [[]];
          if (sql.includes("SUM(watched_seconds)")) {
            const sum = committedEvents.reduce((acc, e) => acc + e.watched, 0);
            return [[{ total_sec: sum }]];
          }
          if (sql.includes("day_sec")) return [[{ day_sec: 25 }]];
          if (sql.includes("INSERT INTO watch_time_events")) {
            pendingEvent = { viewer: mayaUserId, watched: Number(params[6] || 0) };
            return [{ affectedRows: 1 }];
          }
          return [{ affectedRows: 1 }];
        },
        async commit() {
          if (pendingEvent) {
            committedEvents.push(pendingEvent);
            pendingEvent = null;
          }
          if (txRelease) {
            const rel = txRelease;
            txRelease = null;
            rel();
          }
        },
        async rollback() {
          pendingEvent = null;
          if (txRelease) {
            const rel = txRelease;
            txRelease = null;
            rel();
          }
        },
        release() {
          if (txRelease) {
            const rel = txRelease;
            txRelease = null;
            rel();
          }
        },
      };
    };

    const mockPool = {
      async query(sql: string) {
        if (sql.includes("FROM sessions s")) {
          return [
            [
              {
                id: "a0000000-0000-0000-0000-000000000003",
                user_id: mayaUserId,
                name: "Maya Lin",
                mobile: "+1 555-019-0043",
                email: "maya@facetube.com",
                role: "user",
                referral_code: "FT483921",
                created_at: "2026-11-01 00:00:00",
              },
            ],
          ];
        }
        return [[]];
      },
      async getConnection() {
        return createMockConn();
      },
    };

    const prevDbHost = process.env["DB_HOST"];
    const prevDbName = process.env["DB_NAME"];
    const prevDbUser = process.env["DB_USER"];
    process.env["DB_HOST"] = "127.0.0.1";
    process.env["DB_NAME"] = "facetube_test";
    process.env["DB_USER"] = "facetube_user";

    setMysqlPoolForTesting(mockPool);
    try {
      const mysqlRace = await Promise.all([
        sendHeartbeat(
          mayaToken,
          { session_id: "ws_mock_a", seq: 2, idempotency_key: "m_race_a", delta_seconds: 25 },
          t0 + 50,
        ),
        sendHeartbeat(
          mayaToken,
          { session_id: "ws_mock_b", seq: 2, idempotency_key: "m_race_b", delta_seconds: 25 },
          t0 + 50,
        ),
      ]);
      assert.equal(mysqlRace.filter((r) => r.status === 200).length, 1);
      assert.equal(mysqlRace.filter((r) => r.status === 429).length, 1);
      assert.deepEqual(lockOrderLog, [
        `users:${mayaUserId}`,
        "session:ws_mock_a",
        `users:${mayaUserId}`,
        "session:ws_mock_b",
      ]);

      // Deadlock 1213 bounded retry: fails 3 times -> returns 409 TRANSACTION_CONFLICT
      let deadlockAttempts = 0;
      setMysqlPoolForTesting({
        ...mockPool,
        async getConnection() {
          return {
            async beginTransaction() {},
            async query() {
              deadlockAttempts++;
              const err: any = new Error("Deadlock found when trying to get lock");
              err.errno = 1213;
              err.code = "ER_LOCK_DEADLOCK";
              throw err;
            },
            async commit() {},
            async rollback() {},
            release() {},
          };
        },
      });
      const conflictRes = await sendHeartbeat(
        mayaToken,
        { session_id: "ws_mock_a", seq: 3, idempotency_key: "m_deadlock", delta_seconds: 5 },
        t0 + 60,
      );
      assert.equal(conflictRes.status, 409);
      assert.equal(conflictRes.data.code, "TRANSACTION_CONFLICT");
      assert.equal(deadlockAttempts, 3);
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

  it("12. Bounds superseded grace flush window (120s), clamps to ended_at, blocks omitted/stacked jitter, and blocks 0s/2s qualification", async () => {
    const storeFile = path.join(tempDataDir, "facetube_store.json");

    // A. Valid flush within 120s clamps segmentEndEpoch to ended_at (across UTC midnight)
    const endEpoch = Math.floor(Date.parse("2026-11-27T23:59:58Z") / 1000);
    const startEpoch = endEpoch - 10; // 23:59:48Z
    const sClamp = await startSession(mayaToken, publicLongVideoId, startEpoch);
    // Supersede sClamp at 23:59:58Z by starting a new session on the same video
    await startSession(mayaToken, publicLongVideoId, endEpoch);

    const storeAfterSup = JSON.parse(fs.readFileSync(storeFile, "utf-8"));
    const clampSessRow = storeAfterSup.watchSessions.find(
      (s: any) => s.id === sClamp.data.session_id,
    );
    assert.equal(clampSessRow?.status, "ended");
    assert.equal(clampSessRow?.close_reason, "superseded");

    // Arrives at 00:00:15Z (within 120s) with client_timestamp = 00:00:01Z -> clamped to 23:59:58Z
    const clampedRes = await sendHeartbeat(
      mayaToken,
      {
        session_id: sClamp.data.session_id,
        seq: 1,
        idempotency_key: "grace_clamp_utc",
        delta_seconds: 8,
        event_type: "unload",
        client_timestamp: "2026-11-28T00:00:01Z",
      },
      endEpoch + 17,
    );
    assert.equal(clampedRes.status, 200);
    const analyticsClamp = await getAnalytics(alexToken, "?period=7D", endEpoch + 20);
    const nov27 = analyticsClamp.data.history.find((h: any) => h.date === "2026-11-27");
    const nov28 = analyticsClamp.data.history.find((h: any) => h.date === "2026-11-28");
    assert.equal(nov27?.watched_seconds, 8);
    assert.equal(nov28?.watched_seconds, 0);

    // B. Omitted client_timestamp fails when endedEpoch - lastHbEpoch < deltaSeconds, and clamps to ended_at when valid
    const t0 = 1795824000;
    const sOmit = await startSession(mayaToken, publicLongVideoId, t0);
    await startSession(mayaToken, publicLongVideoId, t0 + 5); // superseded at t0+5 (only 5s elapsed before end)
    const omitTooLong = await sendHeartbeat(
      mayaToken,
      {
        session_id: sOmit.data.session_id,
        seq: 1,
        idempotency_key: "omit_too_long",
        delta_seconds: 10,
      },
      t0 + 20,
    );
    assert.equal(omitTooLong.status, 400);
    assert.equal(omitTooLong.data.code, "DELTA_EXCEEDS_ELAPSED_TIME");

    const omitEndEpoch = Math.floor(Date.parse("2026-11-27T23:59:59Z") / 1000);
    const sOmitValid = await startSession(mayaToken, publicLongVideoId, omitEndEpoch - 6);
    await startSession(mayaToken, publicLongVideoId, omitEndEpoch); // superseded at 23:59:59Z
    const omitValidRes = await sendHeartbeat(
      mayaToken,
      {
        session_id: sOmitValid.data.session_id,
        seq: 1,
        idempotency_key: "omit_valid_clamp",
        delta_seconds: 6,
      },
      omitEndEpoch + 15, // arrives at 00:00:14Z without client_timestamp -> must clamp to 23:59:59Z (Nov 27)
    );
    assert.equal(omitValidRes.status, 200);
    const analyticsOmit = await getAnalytics(alexToken, "?period=7D", omitEndEpoch + 20);
    assert.equal(
      analyticsOmit.data.history.find((h: any) => h.date === "2026-11-27")?.watched_seconds,
      14, // 8s from subcase A + 6s from subcase B
    );
    assert.equal(
      analyticsOmit.data.history.find((h: any) => h.date === "2026-11-28")?.watched_seconds,
      0,
    );

    // C. Arrival > 120s after ended_at is rejected with 409 SESSION_ENDED
    const sLate = await startSession(mayaToken, publicLongVideoId, t0 + 100);
    await startSession(mayaToken, publicLongVideoId, t0 + 115);
    const tooLate = await sendHeartbeat(
      mayaToken,
      {
        session_id: sLate.data.session_id,
        seq: 1,
        idempotency_key: "grace_121s",
        delta_seconds: 10,
        client_timestamp: new Date((t0 + 115) * 1000).toISOString(),
      },
      t0 + 115 + 121,
    );
    assert.equal(tooLate.status, 409);
    assert.equal(tooLate.data.code, "SESSION_ENDED");

    // D. Fast clock (endedEpoch + 4s) cannot stack +5s jitter on top of ended_at (ended=t0+210, delta=12)
    const sStack = await startSession(mayaToken, publicLongVideoId, t0 + 200);
    await startSession(mayaToken, publicLongVideoId, t0 + 210);
    const stackedRes = await sendHeartbeat(
      mayaToken,
      {
        session_id: sStack.data.session_id,
        seq: 1,
        idempotency_key: "grace_stack",
        delta_seconds: 12,
        client_timestamp: new Date((t0 + 214) * 1000).toISOString(),
      },
      t0 + 215,
    );
    assert.equal(stackedRes.status, 400);
    assert.equal(stackedRes.data.code, "DELTA_EXCEEDS_ELAPSED_TIME");

    // E. Concurrent grace flush race: different keys -> 1 succeeds & 1 fails; identical keys -> 1 fresh & rest deduplicated
    const sRace = await startSession(mayaToken, publicLongVideoId, t0 + 300);
    await startSession(mayaToken, publicLongVideoId, t0 + 310);
    const graceRace = await Promise.all([
      sendHeartbeat(
        mayaToken,
        {
          session_id: sRace.data.session_id,
          seq: 1,
          idempotency_key: "grace_race_a",
          delta_seconds: 10,
          client_timestamp: new Date((t0 + 310) * 1000).toISOString(),
        },
        t0 + 315,
      ),
      sendHeartbeat(
        mayaToken,
        {
          session_id: sRace.data.session_id,
          seq: 1,
          idempotency_key: "grace_race_b",
          delta_seconds: 10,
          client_timestamp: new Date((t0 + 310) * 1000).toISOString(),
        },
        t0 + 315,
      ),
    ]);
    assert.equal(graceRace.filter((r) => r.status === 200).length, 1);
    assert.equal(graceRace.filter((r) => r.status === 409).length, 1);

    const sRaceIdem = await startSession(mayaToken, publicLongVideoId, t0 + 350);
    await startSession(mayaToken, publicLongVideoId, t0 + 360);
    const graceIdemRetries = await Promise.all(
      Array.from({ length: 3 }, () =>
        sendHeartbeat(
          mayaToken,
          {
            session_id: sRaceIdem.data.session_id,
            seq: 1,
            idempotency_key: "grace_race_same",
            delta_seconds: 10,
            client_timestamp: new Date((t0 + 360) * 1000).toISOString(),
          },
          t0 + 365,
        ),
      ),
    );
    assert.equal(
      graceIdemRetries.filter((r) => r.status === 200 && r.data.deduplicated === false).length,
      1,
    );
    assert.equal(
      graceIdemRetries.filter((r) => r.status === 200 && r.data.deduplicated === true).length,
      2,
    );

    // F. 0-second (ended_at === started_at) and 2-second superseded sessions cannot claim 3s or qualify
    const sZero = await startSession(mayaToken, publicLongVideoId, t0 + 400);
    await startSession(mayaToken, publicLongVideoId, t0 + 400);
    const zeroClaim = await sendHeartbeat(
      mayaToken,
      {
        session_id: sZero.data.session_id,
        seq: 1,
        idempotency_key: "zero_claim",
        delta_seconds: 3,
        client_timestamp: new Date((t0 + 404) * 1000).toISOString(),
      },
      t0 + 405,
    );
    assert.equal(zeroClaim.status, 400);
    assert.equal(zeroClaim.data.code, "DELTA_EXCEEDS_ELAPSED_TIME");

    const sTwo = await startSession(mayaToken, publicLongVideoId, t0 + 500);
    await startSession(mayaToken, publicLongVideoId, t0 + 502);
    const twoClaim3 = await sendHeartbeat(
      mayaToken,
      {
        session_id: sTwo.data.session_id,
        seq: 1,
        idempotency_key: "two_claim_3",
        delta_seconds: 3,
        client_timestamp: new Date((t0 + 505) * 1000).toISOString(),
      },
      t0 + 506,
    );
    assert.equal(twoClaim3.status, 400);
    assert.equal(twoClaim3.data.code, "DELTA_EXCEEDS_ELAPSED_TIME");

    const twoClaim2 = await sendHeartbeat(
      mayaToken,
      {
        session_id: sTwo.data.session_id,
        seq: 1,
        idempotency_key: "two_claim_2",
        delta_seconds: 2,
      },
      t0 + 506,
    );
    assert.equal(twoClaim2.status, 200);
    assert.equal(twoClaim2.data.is_qualified, false);
  });

  it("13. Rejects boolean seq/delta_seconds and cross-session/mismatched idempotency_key reuse while preserving safe retries", async () => {
    const t0 = 1795824000;
    const s1 = await startSession(mayaToken, publicLongVideoId, t0);
    const s2 = await startSession(mayaToken, publicShortVideoId, t0);

    // Reject boolean true/false for seq and delta_seconds
    for (const badPayload of [
      { session_id: s1.data.session_id, seq: true, idempotency_key: "b1", delta_seconds: 10 },
      { session_id: s1.data.session_id, seq: false, idempotency_key: "b2", delta_seconds: 10 },
      { session_id: s1.data.session_id, seq: 1, idempotency_key: "b3", delta_seconds: true },
      { session_id: s1.data.session_id, seq: 1, idempotency_key: "b4", delta_seconds: false },
    ]) {
      const badRes = await sendHeartbeat(mayaToken, badPayload, t0 + 15);
      assert.equal(badRes.status, 400);
    }

    // Valid first heartbeat on s1
    const ok1 = await sendHeartbeat(
      mayaToken,
      {
        session_id: s1.data.session_id,
        seq: 1,
        idempotency_key: "shared_idem_key",
        delta_seconds: 10,
      },
      t0 + 15,
    );
    assert.equal(ok1.status, 200);
    assert.equal(ok1.data.deduplicated, false);

    // Safe identical retry on same session -> 200 deduplicated: true
    const retryOk = await sendHeartbeat(
      mayaToken,
      {
        session_id: s1.data.session_id,
        seq: 1,
        idempotency_key: "shared_idem_key",
        delta_seconds: 10,
      },
      t0 + 16,
    );
    assert.equal(retryOk.status, 200);
    assert.equal(retryOk.data.deduplicated, true);

    // Reusing same idempotency_key on different session -> 409 IDEMPOTENCY_CONFLICT
    const crossSession = await sendHeartbeat(
      mayaToken,
      {
        session_id: s2.data.session_id,
        seq: 1,
        idempotency_key: "shared_idem_key",
        delta_seconds: 10,
      },
      t0 + 20,
    );
    assert.equal(crossSession.status, 409);
    assert.equal(crossSession.data.code, "IDEMPOTENCY_CONFLICT");

    // Reusing same idempotency_key on same session with mismatched delta_seconds/seq/event_type -> 409 IDEMPOTENCY_CONFLICT
    const mismatchDelta = await sendHeartbeat(
      mayaToken,
      {
        session_id: s1.data.session_id,
        seq: 1,
        idempotency_key: "shared_idem_key",
        delta_seconds: 15,
      },
      t0 + 20,
    );
    assert.equal(mismatchDelta.status, 409);
    assert.equal(mismatchDelta.data.code, "IDEMPOTENCY_CONFLICT");

    const mismatchEvent = await sendHeartbeat(
      mayaToken,
      {
        session_id: s1.data.session_id,
        seq: 1,
        idempotency_key: "shared_idem_key",
        delta_seconds: 10,
        event_type: "pause",
      },
      t0 + 20,
    );
    assert.equal(mismatchEvent.status, 409);
    assert.equal(mismatchEvent.data.code, "IDEMPOTENCY_CONFLICT");
  });
});
