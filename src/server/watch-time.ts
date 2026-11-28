import crypto from "node:crypto";
import type { Pool, PoolConnection } from "mysql2/promise";
import type { AuthUser, AuthResult, ServerStore } from "./api-handler.ts";

// ==============================================================================
// Canonical Watch Time Constants (Must match api/watch-time/_shared.php 1:1)
// ==============================================================================
export const WT_HEARTBEAT_INTERVAL_SEC = 15;
export const WT_MAX_DELTA_SEC = 30;
export const WT_MIN_QUALIFIED_WATCH_SECONDS = 3;
export const WT_SESSION_TTL_SECONDS = 86400; // 24 hours
export const WT_WALL_CLOCK_JITTER_TOLERANCE_SEC = 5;
export const WT_MAX_FUTURE_CLIENT_SKEW_SEC = 300;
export const WT_SHORT_SESSION_CAP_MAX_SEC = 180;
export const WT_SHORT_SESSION_CAP_MIN_SEC = 60;
export const WT_SHORT_DAILY_CAP_SEC = 300;
export const WT_LONG_SESSION_CAP_MAX_SEC = 14400;
export const WT_LONG_SESSION_CAP_MIN_SEC = 300;
export const WT_LONG_SESSION_CAP_UNKNOWN_DURATION_SEC = 3600;
export const WT_LONG_DAILY_CAP_SEC = 14400;
export const WT_GLOBAL_60S_VELOCITY_CAP_SEC = 75;
export const WT_GLOBAL_3600S_VELOCITY_CAP_SEC = 4200;
export const WT_MAX_CONCURRENT_ACTIVE_SESSIONS = 2;
export const WT_MAX_SESSIONS_PER_MINUTE = 30;
export const WT_SUPERSEDED_FLUSH_WINDOW_SEC = 120;

export const WT_VALID_EVENT_TYPES = ["heartbeat", "pause", "hidden", "ended", "unload"] as const;
export type WatchTimeEventType = (typeof WT_VALID_EVENT_TYPES)[number];

export function parseStrictInt(raw: unknown): number | null {
  if (typeof raw === "boolean" || raw === null || raw === undefined) return null;
  if (typeof raw === "number") {
    return Number.isInteger(raw) ? raw : null;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!/^-?\d+$/.test(trimmed)) return null;
    const n = Number.parseInt(trimmed, 10);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

export interface WatchSessionRecord {
  id: string;
  viewer_user_id: string;
  video_id: string;
  creator_user_id: string;
  content_type: "short" | "long";
  video_duration_seconds: number;
  is_self_watch: number;
  status: "active" | "ended";
  close_reason: "ended" | "unload" | "superseded" | "expired" | "cap_reached" | null;
  superseded_grace_used: number;
  total_watched_seconds: number;
  is_qualified: number;
  qualified_watch_date: string | null;
  last_seq: number;
  last_position_seconds: number;
  expires_at: string;
  started_at: string;
  last_heartbeat_at: string;
  ended_at: string | null;
  updated_at: string;
}

export interface WatchTimeEventRecord {
  id: number;
  session_id: string;
  viewer_user_id: string;
  video_id: string;
  seq: number;
  idempotency_key: string;
  event_type: WatchTimeEventType;
  watched_seconds: number;
  position_seconds: number;
  client_event_at: string | null;
  watch_date: string;
  primary_date_seconds: number;
  split_prev_date: string | null;
  split_prev_seconds: number;
  created_at: string;
}

export interface VideoWatchDailyRecord {
  watch_date: string;
  creator_user_id: string;
  video_id: string;
  total_watched_seconds: number;
  qualified_watched_seconds: number;
  qualified_sessions: number;
  updated_at: string;
}

export interface WatchTimeSlice {
  watchDate: string;
  seconds: number;
}

export interface WatchTimeHandlerContext {
  route: string;
  method: string;
  url: URL;
  request: Request;
  store: ServerStore;
  pool: Pool | null;
  isProduction: boolean;
  authUser: AuthUser | null;
  requireAuth: (authUser: AuthUser | null, requestedUserId?: string | null) => AuthResult;
  jsonResponse: (data: unknown, status?: number) => Response;
  saveStore: (store: ServerStore) => void;
  nowEpochSec?: number | undefined;
}

// ==============================================================================
// In-Process Async Mutex for Dev JSON ServerStore Concurrency Parity
// ==============================================================================
const storeMutexQueues = new Map<string, Promise<void>>();

async function withStoreLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = storeMutexQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prev.then(() => next);
  storeMutexQueues.set(key, chained);

  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (storeMutexQueues.get(key) === chained) {
      storeMutexQueues.delete(key);
    }
  }
}

// ==============================================================================
// Pure Helpers (Shared Validation, UTC Date Math, Duration & AVD Formatting)
// ==============================================================================
export function parseVideoDurationSeconds(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.min(86400, Math.floor(raw));
  }
  const clean = String(raw ?? "").trim();
  if (!clean) return 0;
  if (/^\d+$/.test(clean)) {
    return Math.min(86400, Math.max(0, parseInt(clean, 10)));
  }
  const parts = clean.split(":").map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return 0;
  if (parts.length === 2) {
    return Math.min(86400, Math.floor(parts[0]! * 60 + parts[1]!));
  }
  if (parts.length === 3) {
    return Math.min(86400, Math.floor(parts[0]! * 3600 + parts[1]! * 60 + parts[2]!));
  }
  return 0;
}

export function computeSessionCapSeconds(
  contentType: "short" | "long",
  durationSeconds: number,
): number {
  if (contentType === "short") {
    return durationSeconds > 0
      ? Math.min(
          WT_SHORT_SESSION_CAP_MAX_SEC,
          Math.max(WT_SHORT_SESSION_CAP_MIN_SEC, durationSeconds * 3),
        )
      : WT_SHORT_SESSION_CAP_MAX_SEC;
  }
  return durationSeconds > 0
    ? Math.min(
        WT_LONG_SESSION_CAP_MAX_SEC,
        Math.max(WT_LONG_SESSION_CAP_MIN_SEC, durationSeconds * 2),
      )
    : WT_LONG_SESSION_CAP_UNKNOWN_DURATION_SEC;
}

export function getDailyVideoCapSeconds(contentType: "short" | "long"): number {
  return contentType === "short" ? WT_SHORT_DAILY_CAP_SEC : WT_LONG_DAILY_CAP_SEC;
}

export function toMysqlUtcDatetime(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().slice(0, 19).replace("T", " ");
}

export function parseUtcDatetimeToEpoch(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    if (raw > 1e12) return Math.floor(raw / 1000);
    if (raw > 0) return Math.floor(raw);
    return null;
  }
  if (raw instanceof Date) {
    const ms = raw.getTime();
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }
  const str = String(raw).trim();
  if (!str) return null;
  if (/^\d{10,13}$/.test(str)) {
    const num = Number(str);
    return num > 1e12 ? Math.floor(num / 1000) : Math.floor(num);
  }
  const normalized =
    str.includes("T") || str.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(str)
      ? str
      : str.replace(" ", "T") + "Z";
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export function formatUtcDate(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().slice(0, 10);
}

/**
 * Splits a playback interval [segmentEndEpoch - deltaSeconds, segmentEndEpoch] across
 * UTC calendar midnight (00:00:00Z). Because deltaSeconds <= 30, a chunk spans at most 2 days.
 */
export function splitWatchSecondsAcrossUtcMidnight(
  segmentEndEpoch: number,
  deltaSeconds: number,
): {
  watchDate: string;
  primaryDateSeconds: number;
  splitPrevDate: string | null;
  splitPrevSeconds: number;
  slices: WatchTimeSlice[];
} {
  const segmentStartEpoch = segmentEndEpoch - deltaSeconds;
  const startDate = formatUtcDate(segmentStartEpoch);
  const endDate = formatUtcDate(segmentEndEpoch);

  if (startDate === endDate) {
    return {
      watchDate: endDate,
      primaryDateSeconds: deltaSeconds,
      splitPrevDate: null,
      splitPrevSeconds: 0,
      slices: [{ watchDate: endDate, seconds: deltaSeconds }],
    };
  }

  const endMidnightEpoch = Math.floor(Date.parse(`${endDate}T00:00:00Z`) / 1000);
  const day1Seconds = Math.max(0, Math.min(deltaSeconds, endMidnightEpoch - segmentStartEpoch));
  const day2Seconds = Math.max(0, deltaSeconds - day1Seconds);

  const slices: WatchTimeSlice[] = [];
  if (day1Seconds > 0) {
    slices.push({ watchDate: startDate, seconds: day1Seconds });
  }
  if (day2Seconds > 0) {
    slices.push({ watchDate: endDate, seconds: day2Seconds });
  }

  return {
    watchDate: endDate,
    primaryDateSeconds: day2Seconds,
    splitPrevDate: day1Seconds > 0 ? startDate : null,
    splitPrevSeconds: day1Seconds,
    slices,
  };
}

export function formatDurationCompact(totalSeconds: number): string {
  const secs = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(secs / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  const remSecs = secs % 60;
  if (hours > 0) {
    return `${hours}h ${mins}m ${remSecs}s`;
  }
  return `${mins}m ${remSecs}s`;
}

export function computeAverageViewDurationSeconds(
  qualifiedWatchedSeconds: number,
  qualifiedSessions: number,
): number {
  if (!Number.isFinite(qualifiedSessions) || qualifiedSessions <= 0) {
    return 0;
  }
  if (!Number.isFinite(qualifiedWatchedSeconds) || qualifiedWatchedSeconds <= 0) {
    return 0;
  }
  return Math.round(qualifiedWatchedSeconds / qualifiedSessions);
}

function resolveStoredVisibilityFailClosed(value: unknown): "public" | "unlisted" | "private" {
  if (value === null || value === undefined) return "public";
  const clean = String(value).trim().toLowerCase();
  if (clean === "") return "public";
  if (clean === "public" || clean === "unlisted" || clean === "private") {
    return clean;
  }
  return "private";
}

function isMysqlConnectionUnavailableError(err: unknown): boolean {
  const anyErr = err as { code?: string; errno?: number; message?: string } | null;
  const code = String(anyErr?.code || "");
  const errno = Number(anyErr?.errno || 0);
  const msg = String(anyErr?.message || "");
  return (
    code.startsWith("08") ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "PROTOCOL_CONNECTION_LOST" ||
    [1040, 1042, 1053, 1129, 1203, 1927, 2002, 2003, 2005, 2006, 2013, 2026].includes(errno) ||
    /server has gone away|lost connection|connection refused|connection timed out|too many connections/i.test(
      msg,
    )
  );
}

function isDuplicateKeyError(err: unknown): boolean {
  const anyErr = err as { code?: string; errno?: number; sqlState?: string } | null;
  return anyErr?.code === "ER_DUP_ENTRY" || anyErr?.errno === 1062 || anyErr?.sqlState === "23000";
}

function isRetryableTransactionError(err: unknown): boolean {
  const anyErr = err as {
    code?: string;
    errno?: number;
    sqlState?: string;
    message?: string;
  } | null;
  const code = String(anyErr?.code || "");
  const errno = Number(anyErr?.errno || 0);
  const sqlState = String(anyErr?.sqlState || "");
  const msg = String(anyErr?.message || "");
  return (
    code === "ER_LOCK_DEADLOCK" ||
    code === "ER_LOCK_WAIT_TIMEOUT" ||
    errno === 1213 ||
    errno === 1205 ||
    sqlState === "40001" ||
    /Deadlock found|Lock wait timeout/i.test(msg)
  );
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeMysqlRollback(conn: PoolConnection): Promise<void> {
  try {
    await conn.rollback();
  } catch {
    // Ignore rollback failure
  }
}

async function readJsonPayload(request: Request): Promise<Record<string, any> | null> {
  try {
    const raw = await request.text();
    if (!raw || !raw.trim()) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, any>;
  } catch {
    return null;
  }
}

function ensureStoreWatchCollections(store: ServerStore): {
  watchSessions: WatchSessionRecord[];
  watchTimeEvents: WatchTimeEventRecord[];
  videoWatchDaily: VideoWatchDailyRecord[];
} {
  if (!Array.isArray(store.watchSessions)) store.watchSessions = [];
  if (!Array.isArray(store.watchTimeEvents)) store.watchTimeEvents = [];
  if (!Array.isArray(store.videoWatchDaily)) store.videoWatchDaily = [];
  return {
    watchSessions: store.watchSessions,
    watchTimeEvents: store.watchTimeEvents,
    videoWatchDaily: store.videoWatchDaily,
  };
}

// ==============================================================================
// Route Dispatcher
// ==============================================================================
export async function handleWatchTimeRoute(ctx: WatchTimeHandlerContext): Promise<Response | null> {
  const { route } = ctx;
  if (route === "watch-time/session") {
    return handleStartWatchSession(ctx);
  }
  if (route === "watch-time/heartbeat") {
    return handleWatchHeartbeat(ctx);
  }
  if (route === "watch-time/analytics") {
    return handleWatchAnalytics(ctx);
  }
  return null;
}

// ==============================================================================
// 1. POST /api/watch-time/session
// ==============================================================================
async function handleStartWatchSession(ctx: WatchTimeHandlerContext): Promise<Response> {
  const { method, request, store, pool, isProduction, authUser, jsonResponse, saveStore } = ctx;
  if (method !== "POST") {
    return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
  }

  if (isProduction && !pool) {
    return jsonResponse(
      {
        success: false,
        error: "Database connection unavailable in production environment.",
      },
      503,
    );
  }

  if (!authUser || !authUser.user_id) {
    return jsonResponse(
      {
        success: false,
        error: "Authentication required. Please provide a valid Bearer session token.",
      },
      401,
    );
  }

  const payload = await readJsonPayload(request);
  if (payload === null) {
    return jsonResponse({ success: false, error: "Invalid JSON request body." }, 400);
  }

  const videoId = String(payload["video_id"] ?? payload["videoId"] ?? "").trim();
  if (!videoId) {
    return jsonResponse({ success: false, error: "video_id is required." }, 400);
  }

  const viewerUserId = String(authUser.user_id).trim();
  const isAdmin =
    String(authUser.role || "")
      .trim()
      .toLowerCase() === "admin";
  const nowEpoch = ctx.nowEpochSec ?? Math.floor(Date.now() / 1000);
  const nowSql = toMysqlUtcDatetime(nowEpoch);
  const expiresSql = toMysqlUtcDatetime(nowEpoch + WT_SESSION_TTL_SECONDS);
  const minWindowSql = toMysqlUtcDatetime(nowEpoch - 60);

  if (pool) {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let conn: PoolConnection | null = null;
      try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        // 0. Lock authenticated viewer's users row first (strict hierarchy: users -> watch_sessions)
        const [uLockRows]: any = await conn.query(
          `SELECT id FROM users WHERE user_id = ? FOR UPDATE`,
          [viewerUserId],
        );
        if (!Array.isArray(uLockRows) || uLockRows.length === 0) {
          await safeMysqlRollback(conn);
          return jsonResponse(
            {
              success: false,
              error: "Authentication required. Viewer account not found.",
            },
            401,
          );
        }

        // 1. Resolve authoritative video metadata and enforce access authorization parity with videos/get
        const [vRows]: any = await conn.query(
          `SELECT id, user_id, video_type, content_type, duration, visibility, payment_status, is_blocked
           FROM uploaded_videos
           WHERE id = ?
           LIMIT 1`,
          [videoId],
        );
        if (!Array.isArray(vRows) || vRows.length === 0) {
          await safeMysqlRollback(conn);
          return jsonResponse({ success: false, error: "Video not found." }, 404);
        }
        const video = vRows[0];
        if (video.is_blocked) {
          await safeMysqlRollback(conn);
          return jsonResponse(
            {
              success: false,
              error: "This video has been blocked by administrators for content moderation.",
            },
            403,
          );
        }

        const creatorUserId = String(video.user_id || "").trim();
        const isOwner =
          creatorUserId.toUpperCase() === viewerUserId.toUpperCase() ||
          (Boolean(authUser.id) &&
            creatorUserId.toUpperCase() === String(authUser.id).trim().toUpperCase());
        const visibility = resolveStoredVisibilityFailClosed(video.visibility);
        const vType = String(video.video_type || "free")
          .trim()
          .toLowerCase();
        const pStatus =
          String(video.payment_status || "")
            .trim()
            .toLowerCase() || (vType === "free" ? "not_required" : "pending");
        const isPaymentEligible =
          (vType === "free" && (pStatus === "not_required" || pStatus === "paid")) ||
          (vType === "premium" && pStatus === "paid");

        if (visibility === "private" && !isOwner && !isAdmin) {
          await safeMysqlRollback(conn);
          return jsonResponse(
            {
              success: false,
              error:
                "Unauthorized: This private video is only accessible to its creator or administrators.",
            },
            403,
          );
        }
        if (!isPaymentEligible && !isOwner && !isAdmin) {
          await safeMysqlRollback(conn);
          return jsonResponse(
            {
              success: false,
              error:
                "Unauthorized: Unpaid Sponsor videos are only accessible to their creator or administrators.",
            },
            403,
          );
        }

        // 2. Per-viewer session creation rate limit (30/min) under viewer lock
        const [rateRows]: any = await conn.query(
          `SELECT COUNT(*) AS cnt
           FROM watch_sessions
           WHERE viewer_user_id = ?
             AND started_at >= ?`,
          [viewerUserId, minWindowSql],
        );
        if (Number(rateRows?.[0]?.cnt || 0) >= WT_MAX_SESSIONS_PER_MINUTE) {
          await safeMysqlRollback(conn);
          return jsonResponse(
            {
              success: false,
              code: "SESSION_RATE_LIMIT",
              error: "Too many watch sessions started. Please wait before starting another.",
            },
            429,
          );
        }

        // 3. Expire stale sessions and supersede prior active sessions (preserving 1 grace flush)
        await conn.query(
          `UPDATE watch_sessions
           SET status = 'ended', close_reason = 'expired', ended_at = COALESCE(ended_at, ?)
           WHERE viewer_user_id = ?
             AND status = 'active'
             AND expires_at <= ?`,
          [nowSql, viewerUserId, nowSql],
        );

        await conn.query(
          `UPDATE watch_sessions
           SET status = 'ended', close_reason = 'superseded', ended_at = COALESCE(ended_at, ?)
           WHERE viewer_user_id = ?
             AND video_id = ?
             AND status = 'active'`,
          [nowSql, viewerUserId, videoId],
        );

        const [activeRows]: any = await conn.query(
          `SELECT id
           FROM watch_sessions
           WHERE viewer_user_id = ?
             AND status = 'active'
           ORDER BY last_heartbeat_at ASC, started_at ASC
           FOR UPDATE`,
          [viewerUserId],
        );
        const activeList = Array.isArray(activeRows) ? activeRows : [];
        if (activeList.length >= WT_MAX_CONCURRENT_ACTIVE_SESSIONS) {
          const overflowCount = activeList.length - WT_MAX_CONCURRENT_ACTIVE_SESSIONS + 1;
          const toCloseIds = activeList.slice(0, overflowCount).map((r: any) => String(r.id));
          if (toCloseIds.length > 0) {
            const placeholders = toCloseIds.map(() => "?").join(", ");
            await conn.query(
              `UPDATE watch_sessions
               SET status = 'ended', close_reason = 'superseded', ended_at = COALESCE(ended_at, ?)
               WHERE id IN (${placeholders})`,
              [nowSql, ...toCloseIds],
            );
          }
        }

        // 4. Insert new server-minted watch session
        const sessionId = `ws_${crypto.randomBytes(16).toString("hex")}`;
        const contentType: "short" | "long" =
          String(video.content_type || "long")
            .trim()
            .toLowerCase() === "short"
            ? "short"
            : "long";
        const durationSec = parseVideoDurationSeconds(video.duration);
        const isSelfWatch = isOwner ? 1 : 0;

        await conn.query(
          `INSERT INTO watch_sessions (
             id, viewer_user_id, video_id, creator_user_id, content_type,
             video_duration_seconds, is_self_watch, status, close_reason,
             superseded_grace_used, total_watched_seconds, is_qualified,
             qualified_watch_date, last_seq, last_position_seconds,
             expires_at, started_at, last_heartbeat_at, ended_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, 0, 0, 0, NULL, 0, 0, ?, ?, ?, NULL)`,
          [
            sessionId,
            viewerUserId,
            videoId,
            creatorUserId,
            contentType,
            durationSec,
            isSelfWatch,
            expiresSql,
            nowSql,
            nowSql,
          ],
        );

        await conn.commit();

        return jsonResponse(
          {
            success: true,
            session_id: sessionId,
            sessionId,
            video_id: videoId,
            content_type: contentType,
            is_self_watch: Boolean(isSelfWatch),
            heartbeat_interval_seconds: WT_HEARTBEAT_INTERVAL_SEC,
            max_delta_seconds: WT_MAX_DELTA_SEC,
            expires_at: new Date((nowEpoch + WT_SESSION_TTL_SECONDS) * 1000).toISOString(),
          },
          201,
        );
      } catch (err) {
        if (conn) await safeMysqlRollback(conn);
        if (isRetryableTransactionError(err)) {
          if (attempt < maxAttempts) {
            await sleepMs(20 * attempt);
            continue;
          }
          return jsonResponse(
            {
              success: false,
              code: "TRANSACTION_CONFLICT",
              error: "Temporary transaction conflict while starting watch session. Please retry.",
            },
            409,
          );
        }
        if (isMysqlConnectionUnavailableError(err)) {
          return jsonResponse(
            {
              success: false,
              error: "Database connection unavailable while starting watch session.",
            },
            503,
          );
        }
        return jsonResponse(
          { success: false, error: "Database error while starting watch session." },
          500,
        );
      } finally {
        if (conn) conn.release();
      }
    }
  }

  // Dev/Test JSON ServerStore fallback with per-viewer mutex
  return withStoreLock(`viewer:${viewerUserId.toUpperCase()}`, async () => {
    const video = store.videos.find((v) => v.id === videoId);
    if (!video) {
      return jsonResponse({ success: false, error: "Video not found." }, 404);
    }
    if (video.is_blocked) {
      return jsonResponse(
        {
          success: false,
          error: "This video has been blocked by administrators for content moderation.",
        },
        403,
      );
    }

    const creatorUserId = String(video.user_id || "").trim();
    const isOwner =
      creatorUserId.toUpperCase() === viewerUserId.toUpperCase() ||
      (Boolean(authUser.id) &&
        creatorUserId.toUpperCase() === String(authUser.id).trim().toUpperCase());
    const visibility = resolveStoredVisibilityFailClosed(video.visibility);
    const vType = String(video.video_type || "free")
      .trim()
      .toLowerCase();
    const pStatus =
      String(video.payment_status || "")
        .trim()
        .toLowerCase() || (vType === "free" ? "not_required" : "pending");
    const isPaymentEligible =
      (vType === "free" && (pStatus === "not_required" || pStatus === "paid")) ||
      (vType === "premium" && pStatus === "paid");

    if (visibility === "private" && !isOwner && !isAdmin) {
      return jsonResponse(
        {
          success: false,
          error:
            "Unauthorized: This private video is only accessible to its creator or administrators.",
        },
        403,
      );
    }
    if (!isPaymentEligible && !isOwner && !isAdmin) {
      return jsonResponse(
        {
          success: false,
          error:
            "Unauthorized: Unpaid Sponsor videos are only accessible to their creator or administrators.",
        },
        403,
      );
    }

    const { watchSessions } = ensureStoreWatchCollections(store);

    // Rate limit 30 sessions/min
    const recentCount = watchSessions.filter((s) => {
      if (s.viewer_user_id.toUpperCase() !== viewerUserId.toUpperCase()) return false;
      const started = parseUtcDatetimeToEpoch(s.started_at) ?? 0;
      return started >= nowEpoch - 60;
    }).length;
    if (recentCount >= WT_MAX_SESSIONS_PER_MINUTE) {
      return jsonResponse(
        {
          success: false,
          code: "SESSION_RATE_LIMIT",
          error: "Too many watch sessions started. Please wait before starting another.",
        },
        429,
      );
    }

    // Expire and supersede old active sessions
    for (const s of watchSessions) {
      if (s.viewer_user_id.toUpperCase() !== viewerUserId.toUpperCase() || s.status !== "active") {
        continue;
      }
      const exp = parseUtcDatetimeToEpoch(s.expires_at) ?? 0;
      if (exp <= nowEpoch) {
        s.status = "ended";
        s.close_reason = "expired";
        s.ended_at = s.ended_at || nowSql;
        s.updated_at = nowSql;
      } else if (s.video_id === videoId) {
        s.status = "ended";
        s.close_reason = "superseded";
        s.ended_at = s.ended_at || nowSql;
        s.updated_at = nowSql;
      }
    }

    const remainingActive = watchSessions
      .filter(
        (s) =>
          s.viewer_user_id.toUpperCase() === viewerUserId.toUpperCase() && s.status === "active",
      )
      .sort((a, b) => {
        const ta = parseUtcDatetimeToEpoch(a.last_heartbeat_at) ?? 0;
        const tb = parseUtcDatetimeToEpoch(b.last_heartbeat_at) ?? 0;
        return ta - tb;
      });
    if (remainingActive.length >= WT_MAX_CONCURRENT_ACTIVE_SESSIONS) {
      const overflowCount = remainingActive.length - WT_MAX_CONCURRENT_ACTIVE_SESSIONS + 1;
      for (let i = 0; i < overflowCount; i++) {
        const victim = remainingActive[i];
        if (victim) {
          victim.status = "ended";
          victim.close_reason = "superseded";
          victim.ended_at = victim.ended_at || nowSql;
          victim.updated_at = nowSql;
        }
      }
    }

    const sessionId = `ws_${crypto.randomBytes(16).toString("hex")}`;
    const contentType: "short" | "long" =
      String(video.content_type || "long")
        .trim()
        .toLowerCase() === "short"
        ? "short"
        : "long";
    const durationSec = parseVideoDurationSeconds(video.duration);
    const isSelfWatch = isOwner ? 1 : 0;

    watchSessions.push({
      id: sessionId,
      viewer_user_id: viewerUserId,
      video_id: videoId,
      creator_user_id: creatorUserId,
      content_type: contentType,
      video_duration_seconds: durationSec,
      is_self_watch: isSelfWatch,
      status: "active",
      close_reason: null,
      superseded_grace_used: 0,
      total_watched_seconds: 0,
      is_qualified: 0,
      qualified_watch_date: null,
      last_seq: 0,
      last_position_seconds: 0,
      expires_at: expiresSql,
      started_at: nowSql,
      last_heartbeat_at: nowSql,
      ended_at: null,
      updated_at: nowSql,
    });
    saveStore(store);

    return jsonResponse(
      {
        success: true,
        session_id: sessionId,
        sessionId,
        video_id: videoId,
        content_type: contentType,
        is_self_watch: Boolean(isSelfWatch),
        heartbeat_interval_seconds: WT_HEARTBEAT_INTERVAL_SEC,
        max_delta_seconds: WT_MAX_DELTA_SEC,
        expires_at: new Date((nowEpoch + WT_SESSION_TTL_SECONDS) * 1000).toISOString(),
      },
      201,
    );
  });
}

// ==============================================================================
// 2. POST /api/watch-time/heartbeat
// ==============================================================================
async function handleWatchHeartbeat(ctx: WatchTimeHandlerContext): Promise<Response> {
  const { method, request, store, pool, isProduction, authUser, jsonResponse, saveStore } = ctx;
  if (method !== "POST") {
    return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
  }

  if (isProduction && !pool) {
    return jsonResponse(
      { success: false, error: "Database connection unavailable in production environment." },
      503,
    );
  }

  if (!authUser || !authUser.user_id) {
    return jsonResponse(
      {
        success: false,
        error: "Authentication required. Please provide a valid Bearer session token.",
      },
      401,
    );
  }

  const payload = await readJsonPayload(request);
  if (payload === null) {
    return jsonResponse({ success: false, error: "Invalid JSON request body." }, 400);
  }

  const sessionId = String(payload["session_id"] ?? payload["sessionId"] ?? "").trim();
  const idempotencyKey = String(
    payload["idempotency_key"] ?? payload["idempotencyKey"] ?? "",
  ).trim();
  const rawSeq = payload["seq"];
  const rawDelta = payload["delta_seconds"] ?? payload["deltaSeconds"];
  const rawPos = payload["position_seconds"] ?? payload["positionSeconds"] ?? 0;
  const rawEventType = String(payload["event_type"] ?? payload["eventType"] ?? "heartbeat")
    .trim()
    .toLowerCase();
  const rawClientTs =
    payload["client_timestamp"] ?? payload["clientTimestamp"] ?? payload["client_event_at"];

  if (!sessionId) {
    return jsonResponse({ success: false, error: "session_id is required." }, 400);
  }
  if (
    !idempotencyKey ||
    idempotencyKey.length > 100 ||
    !/^[A-Za-z0-9_.:-]+$/.test(idempotencyKey)
  ) {
    return jsonResponse(
      { success: false, error: "Valid idempotency_key (1-100 safe chars) is required." },
      400,
    );
  }

  const seq = parseStrictInt(rawSeq);
  if (seq === null || seq < 1) {
    return jsonResponse({ success: false, error: "seq must be a positive integer >= 1." }, 400);
  }

  const deltaSeconds = parseStrictInt(rawDelta);
  if (deltaSeconds === null || deltaSeconds < 1 || deltaSeconds > WT_MAX_DELTA_SEC) {
    return jsonResponse(
      {
        success: false,
        error: `delta_seconds must be an integer between 1 and ${WT_MAX_DELTA_SEC}.`,
      },
      400,
    );
  }

  if (!WT_VALID_EVENT_TYPES.includes(rawEventType as WatchTimeEventType)) {
    return jsonResponse({ success: false, error: "Invalid event_type." }, 400);
  }
  const eventType = rawEventType as WatchTimeEventType;

  const positionNum = Number(rawPos);
  const positionSeconds =
    Number.isFinite(positionNum) && positionNum >= 0 ? Math.min(86400, Math.floor(positionNum)) : 0;

  let parsedClientEpoch: number | null = null;
  if (rawClientTs !== undefined && rawClientTs !== null && String(rawClientTs).trim() !== "") {
    parsedClientEpoch = parseUtcDatetimeToEpoch(rawClientTs);
    if (parsedClientEpoch === null) {
      return jsonResponse({ success: false, error: "Invalid client_timestamp format." }, 400);
    }
  }

  const viewerUserId = String(authUser.user_id).trim();
  const nowEpoch = ctx.nowEpochSec ?? Math.floor(Date.now() / 1000);
  const nowSql = toMysqlUtcDatetime(nowEpoch);

  if (parsedClientEpoch !== null && parsedClientEpoch > nowEpoch + WT_MAX_FUTURE_CLIENT_SKEW_SEC) {
    return jsonResponse(
      {
        success: false,
        code: "INVALID_CLIENT_TIMESTAMP",
        error: "client_timestamp cannot be significantly in the future.",
      },
      400,
    );
  }

  if (pool) {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let conn: PoolConnection | null = null;
      try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        // 0. Acquire authenticated viewer's users row lock first (strict hierarchy: users -> watch_sessions -> events/daily)
        const [uLockRows]: any = await conn.query(
          `SELECT id FROM users WHERE user_id = ? FOR UPDATE`,
          [viewerUserId],
        );
        if (!Array.isArray(uLockRows) || uLockRows.length === 0) {
          await safeMysqlRollback(conn);
          return jsonResponse(
            {
              success: false,
              error: "Authentication required. Viewer account not found.",
            },
            401,
          );
        }

        // 1. Acquire exclusive row lock on watch_sessions
        const [sRows]: any = await conn.query(
          `SELECT * FROM watch_sessions WHERE id = ? FOR UPDATE`,
          [sessionId],
        );
        if (!Array.isArray(sRows) || sRows.length === 0) {
          await safeMysqlRollback(conn);
          return jsonResponse({ success: false, error: "Watch session not found." }, 404);
        }
        const session = sRows[0];

        if (
          String(session.viewer_user_id || "")
            .trim()
            .toUpperCase() !== viewerUserId.toUpperCase()
        ) {
          await safeMysqlRollback(conn);
          return jsonResponse(
            { success: false, error: "Unauthorized: Watch session belongs to another user." },
            403,
          );
        }

        // 2. Atomic idempotency check under viewer + session locks
        const [dupRows]: any = await conn.query(
          `SELECT id, session_id, seq, event_type, watched_seconds
           FROM watch_time_events
           WHERE idempotency_key = ?
           LIMIT 1`,
          [idempotencyKey],
        );
        if (Array.isArray(dupRows) && dupRows.length > 0) {
          const dup = dupRows[0];
          if (String(dup.session_id || "") !== sessionId) {
            await safeMysqlRollback(conn);
            return jsonResponse(
              {
                success: false,
                code: "IDEMPOTENCY_CONFLICT",
                error: "Idempotency key was already used for a different watch session.",
              },
              409,
            );
          }
          if (
            Number(dup.seq || 0) !== seq ||
            Number(dup.watched_seconds || 0) !== deltaSeconds ||
            String(dup.event_type || "")
              .trim()
              .toLowerCase() !== eventType
          ) {
            await safeMysqlRollback(conn);
            return jsonResponse(
              {
                success: false,
                code: "IDEMPOTENCY_CONFLICT",
                error: "Idempotency key conflict: parameters do not match original event.",
              },
              409,
            );
          }
          await conn.commit();
          return jsonResponse({
            success: true,
            deduplicated: true,
            session_id: sessionId,
            credited_seconds: 0,
            total_watched_seconds: Number(session.total_watched_seconds || 0),
            is_qualified: Boolean(session.is_qualified),
            status: session.status,
          });
        }

        // 3. Check duplicate seq with different idempotency_key
        const [seqRows]: any = await conn.query(
          `SELECT id FROM watch_time_events WHERE session_id = ? AND seq = ? LIMIT 1`,
          [sessionId, seq],
        );
        if (Array.isArray(seqRows) && seqRows.length > 0) {
          await safeMysqlRollback(conn);
          return jsonResponse(
            {
              success: false,
              code: "SEQUENCE_CONFLICT",
              error: "Sequence number already processed with a different idempotency_key.",
            },
            409,
          );
        }

        const lastSeq = Number(session.last_seq || 0);
        if (seq <= lastSeq) {
          await safeMysqlRollback(conn);
          return jsonResponse(
            {
              success: false,
              code: "SEQUENCE_CONFLICT",
              error: "Sequence number must be greater than last committed sequence.",
            },
            409,
          );
        }

        const startedEpoch = parseUtcDatetimeToEpoch(session.started_at) ?? nowEpoch;
        const lastHbEpoch = parseUtcDatetimeToEpoch(session.last_heartbeat_at) ?? startedEpoch;
        const expiresEpoch =
          parseUtcDatetimeToEpoch(session.expires_at) ?? startedEpoch + WT_SESSION_TTL_SECONDS;
        const endedEpoch = parseUtcDatetimeToEpoch(session.ended_at);

        // 4. Hard session expiry check
        if (nowEpoch > expiresEpoch) {
          if (session.status === "active") {
            await conn.query(
              `UPDATE watch_sessions
               SET status = 'ended', close_reason = 'expired', ended_at = COALESCE(ended_at, ?)
               WHERE id = ?`,
              [nowSql, sessionId],
            );
            await conn.commit();
          } else {
            await safeMysqlRollback(conn);
          }
          return jsonResponse(
            {
              success: false,
              code: "SESSION_EXPIRED",
              error: "Watch session has expired.",
            },
            409,
          );
        }

        // 5. Status & bounded one-time superseded grace flush check
        let markSupersededGraceUsed = Boolean(session.superseded_grace_used);
        let isSupersededGrace = false;
        if (session.status === "ended") {
          const canUseSupersededGrace =
            session.close_reason === "superseded" &&
            !markSupersededGraceUsed &&
            seq === lastSeq + 1 &&
            endedEpoch !== null &&
            nowEpoch <= endedEpoch + WT_SUPERSEDED_FLUSH_WINDOW_SEC &&
            (parsedClientEpoch === null ||
              parsedClientEpoch <= endedEpoch + WT_WALL_CLOCK_JITTER_TOLERANCE_SEC);

          if (!canUseSupersededGrace) {
            await safeMysqlRollback(conn);
            return jsonResponse(
              {
                success: false,
                code: "SESSION_ENDED",
                error: "Watch session has already ended.",
              },
              409,
            );
          }
          isSupersededGrace = true;
          markSupersededGraceUsed = true;
        }

        // 6. Bound untrusted client timestamp and validate wall-clock elapsed limits
        if (
          parsedClientEpoch !== null &&
          parsedClientEpoch < startedEpoch - WT_WALL_CLOCK_JITTER_TOLERANCE_SEC
        ) {
          await safeMysqlRollback(conn);
          return jsonResponse(
            {
              success: false,
              code: "INVALID_CLIENT_TIMESTAMP",
              error: "client_timestamp precedes session start.",
            },
            400,
          );
        }

        let segmentEndEpoch = nowEpoch;
        if (isSupersededGrace && endedEpoch !== null) {
          segmentEndEpoch =
            parsedClientEpoch !== null
              ? Math.min(endedEpoch, nowEpoch, Math.max(startedEpoch, parsedClientEpoch))
              : Math.min(endedEpoch, nowEpoch);

          if (endedEpoch - lastHbEpoch < deltaSeconds) {
            await safeMysqlRollback(conn);
            return jsonResponse(
              {
                success: false,
                code: "DELTA_EXCEEDS_ELAPSED_TIME",
                error: "delta_seconds exceeds elapsed time before session ended.",
              },
              400,
            );
          }

          if (
            parsedClientEpoch !== null &&
            segmentEndEpoch - lastHbEpoch + WT_WALL_CLOCK_JITTER_TOLERANCE_SEC < deltaSeconds
          ) {
            await safeMysqlRollback(conn);
            return jsonResponse(
              {
                success: false,
                code: "DELTA_EXCEEDS_ELAPSED_TIME",
                error: "delta_seconds exceeds elapsed time since last heartbeat.",
              },
              400,
            );
          }
        } else {
          if (parsedClientEpoch !== null) {
            segmentEndEpoch = Math.min(nowEpoch, Math.max(startedEpoch, parsedClientEpoch));
            if (segmentEndEpoch - lastHbEpoch + WT_WALL_CLOCK_JITTER_TOLERANCE_SEC < deltaSeconds) {
              await safeMysqlRollback(conn);
              return jsonResponse(
                {
                  success: false,
                  code: "DELTA_EXCEEDS_ELAPSED_TIME",
                  error: "delta_seconds exceeds elapsed time since last heartbeat.",
                },
                400,
              );
            }
          }

          if (nowEpoch - lastHbEpoch + WT_WALL_CLOCK_JITTER_TOLERANCE_SEC < deltaSeconds) {
            await safeMysqlRollback(conn);
            return jsonResponse(
              {
                success: false,
                code: "DELTA_EXCEEDS_ELAPSED_TIME",
                error: "delta_seconds exceeds server wall-clock elapsed time.",
              },
              400,
            );
          }
        }

        // 7. Session cap check
        const contentType: "short" | "long" =
          String(session.content_type || "long")
            .trim()
            .toLowerCase() === "short"
            ? "short"
            : "long";
        const durationSec = Number(session.video_duration_seconds || 0);
        const sessionCap = computeSessionCapSeconds(contentType, durationSec);
        const prevTotal = Number(session.total_watched_seconds || 0);

        if (prevTotal + deltaSeconds > sessionCap) {
          await safeMysqlRollback(conn);
          return jsonResponse(
            {
              success: false,
              code: "SESSION_CAP_REACHED",
              error: "Maximum watch-time cap reached for this session.",
            },
            429,
          );
        }

        // 8. Global viewer velocity limits (60s and 3600s windows) under viewer lock
        const [vel60Rows]: any = await conn.query(
          `SELECT COALESCE(SUM(watched_seconds), 0) AS total_sec
           FROM watch_time_events
           WHERE viewer_user_id = ?
             AND created_at >= ?`,
          [viewerUserId, toMysqlUtcDatetime(nowEpoch - 60)],
        );
        if (
          Number(vel60Rows?.[0]?.total_sec || 0) + deltaSeconds >
          WT_GLOBAL_60S_VELOCITY_CAP_SEC
        ) {
          await safeMysqlRollback(conn);
          return jsonResponse(
            {
              success: false,
              code: "VIEWER_VELOCITY_LIMIT",
              error: "Watch-time velocity limit exceeded (60s window).",
            },
            429,
          );
        }

        const [vel3600Rows]: any = await conn.query(
          `SELECT COALESCE(SUM(watched_seconds), 0) AS total_sec
           FROM watch_time_events
           WHERE viewer_user_id = ?
             AND created_at >= ?`,
          [viewerUserId, toMysqlUtcDatetime(nowEpoch - 3600)],
        );
        if (
          Number(vel3600Rows?.[0]?.total_sec || 0) + deltaSeconds >
          WT_GLOBAL_3600S_VELOCITY_CAP_SEC
        ) {
          await safeMysqlRollback(conn);
          return jsonResponse(
            {
              success: false,
              code: "VIEWER_HOURLY_LIMIT",
              error: "Hourly viewer watch-time limit exceeded.",
            },
            429,
          );
        }

        // 9. UTC midnight boundary split & per-(viewer, video, UTC date) daily caps under viewer lock
        const split = splitWatchSecondsAcrossUtcMidnight(segmentEndEpoch, deltaSeconds);
        const dailyCap = getDailyVideoCapSeconds(contentType);

        for (const slice of split.slices) {
          const [dayRows]: any = await conn.query(
            `SELECT COALESCE(
               SUM(CASE WHEN watch_date = ? THEN primary_date_seconds ELSE 0 END) +
               SUM(CASE WHEN split_prev_date = ? THEN split_prev_seconds ELSE 0 END),
               0
             ) AS day_sec
             FROM watch_time_events
             WHERE viewer_user_id = ?
               AND video_id = ?
               AND (watch_date = ? OR split_prev_date = ?)`,
            [
              slice.watchDate,
              slice.watchDate,
              viewerUserId,
              session.video_id,
              slice.watchDate,
              slice.watchDate,
            ],
          );
          if (Number(dayRows?.[0]?.day_sec || 0) + slice.seconds > dailyCap) {
            await safeMysqlRollback(conn);
            return jsonResponse(
              {
                success: false,
                code: "DAILY_VIDEO_CAP_REACHED",
                error: "Daily per-video watch-time cap reached for this viewer.",
              },
              429,
            );
          }
        }

        // 10. Qualification transition (exactly once per non-self session >= 3s)
        const isSelfWatch = Boolean(session.is_self_watch);
        const wasQualified = Number(session.is_qualified || 0) === 1;
        const newTotal = prevTotal + deltaSeconds;
        const newlyQualified =
          !isSelfWatch && !wasQualified && newTotal >= WT_MIN_QUALIFIED_WATCH_SECONDS;

        let qualifiedWatchDate: string | null = session.qualified_watch_date
          ? formatUtcDate(parseUtcDatetimeToEpoch(session.qualified_watch_date) ?? nowEpoch)
          : null;
        if (newlyQualified) {
          if (
            split.splitPrevDate &&
            split.splitPrevSeconds > 0 &&
            prevTotal + split.splitPrevSeconds >= WT_MIN_QUALIFIED_WATCH_SECONDS
          ) {
            qualifiedWatchDate = split.splitPrevDate;
          } else {
            qualifiedWatchDate = split.watchDate;
          }
        }

        const clientEventSql =
          parsedClientEpoch !== null ? toMysqlUtcDatetime(segmentEndEpoch) : null;

        try {
          await conn.query(
            `INSERT INTO watch_time_events (
             session_id, viewer_user_id, video_id, seq, idempotency_key,
             event_type, watched_seconds, position_seconds, client_event_at,
             watch_date, primary_date_seconds, split_prev_date, split_prev_seconds,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              sessionId,
              viewerUserId,
              session.video_id,
              seq,
              idempotencyKey,
              eventType,
              deltaSeconds,
              positionSeconds,
              clientEventSql,
              split.watchDate,
              split.primaryDateSeconds,
              split.splitPrevDate,
              split.splitPrevSeconds,
              nowSql,
            ],
          );
        } catch (insErr) {
          if (isDuplicateKeyError(insErr)) {
            await safeMysqlRollback(conn);
            return jsonResponse(
              {
                success: false,
                code: "SEQUENCE_CONFLICT",
                error: "Duplicate sequence or idempotency key conflict.",
              },
              409,
            );
          }
          throw insErr;
        }

        const nextStatus: "active" | "ended" =
          session.status === "ended" || eventType === "ended" || eventType === "unload"
            ? "ended"
            : "active";
        const nextCloseReason =
          session.status === "ended"
            ? session.close_reason
            : eventType === "ended" || eventType === "unload"
              ? eventType
              : null;
        const nextEndedAt =
          session.status === "ended" ? session.ended_at : nextStatus === "ended" ? nowSql : null;
        const nextIsQualified = wasQualified || newlyQualified ? 1 : 0;

        await conn.query(
          `UPDATE watch_sessions
         SET total_watched_seconds = ?,
             is_qualified = ?,
             qualified_watch_date = ?,
             last_seq = ?,
             last_position_seconds = ?,
             last_heartbeat_at = ?,
             status = ?,
             close_reason = ?,
             ended_at = ?,
             superseded_grace_used = ?
         WHERE id = ?`,
          [
            newTotal,
            nextIsQualified,
            qualifiedWatchDate,
            seq,
            positionSeconds,
            nowSql,
            nextStatus,
            nextCloseReason,
            nextEndedAt,
            markSupersededGraceUsed ? 1 : 0,
            sessionId,
          ],
        );

        // 11. Atomic daily rollup updates (self-watches excluded from creator watch-time metrics)
        if (!isSelfWatch) {
          for (const slice of split.slices) {
            let sliceQualifiedSec = 0;
            let sliceQualifiedCount = 0;

            if (wasQualified) {
              sliceQualifiedSec = slice.seconds;
            } else if (newlyQualified) {
              if (slice.watchDate === qualifiedWatchDate) {
                sliceQualifiedCount = 1;
                if (split.slices.length === 2 && qualifiedWatchDate === split.watchDate) {
                  sliceQualifiedSec = newTotal;
                } else {
                  sliceQualifiedSec = prevTotal + slice.seconds;
                }
              } else if (
                split.slices.length === 2 &&
                qualifiedWatchDate === split.splitPrevDate &&
                slice.watchDate === split.watchDate
              ) {
                sliceQualifiedSec = slice.seconds;
              }
            }

            await conn.query(
              `INSERT INTO video_watch_daily (
               watch_date, creator_user_id, video_id,
               total_watched_seconds, qualified_watched_seconds, qualified_sessions
             ) VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               total_watched_seconds = total_watched_seconds + VALUES(total_watched_seconds),
               qualified_watched_seconds = qualified_watched_seconds + VALUES(qualified_watched_seconds),
               qualified_sessions = qualified_sessions + VALUES(qualified_sessions)`,
              [
                slice.watchDate,
                session.creator_user_id,
                session.video_id,
                slice.seconds,
                sliceQualifiedSec,
                sliceQualifiedCount,
              ],
            );
          }
        }

        await conn.commit();

        return jsonResponse({
          success: true,
          deduplicated: false,
          session_id: sessionId,
          seq,
          credited_seconds: deltaSeconds,
          total_watched_seconds: newTotal,
          is_qualified: Boolean(nextIsQualified),
          status: nextStatus,
        });
      } catch (err) {
        if (conn) await safeMysqlRollback(conn);
        if (isRetryableTransactionError(err)) {
          if (attempt < maxAttempts) {
            await sleepMs(20 * attempt);
            continue;
          }
          return jsonResponse(
            {
              success: false,
              code: "TRANSACTION_CONFLICT",
              error: "Temporary transaction conflict while recording watch time. Please retry.",
            },
            409,
          );
        }
        if (isMysqlConnectionUnavailableError(err)) {
          return jsonResponse(
            {
              success: false,
              error: "Database connection unavailable while recording watch time.",
            },
            503,
          );
        }
        return jsonResponse(
          { success: false, error: "Database error while recording watch time." },
          500,
        );
      } finally {
        if (conn) conn.release();
      }
    }
  }

  // Dev/Test JSON ServerStore fallback with strict viewer -> session lock hierarchy parity
  return withStoreLock(`viewer:${viewerUserId.toUpperCase()}`, async () =>
    withStoreLock(`session:${sessionId}`, async () => {
      const { watchSessions, watchTimeEvents, videoWatchDaily } =
        ensureStoreWatchCollections(store);

      const session = watchSessions.find((s) => s.id === sessionId);
      if (!session) {
        return jsonResponse({ success: false, error: "Watch session not found." }, 404);
      }
      if (session.viewer_user_id.toUpperCase() !== viewerUserId.toUpperCase()) {
        return jsonResponse(
          { success: false, error: "Unauthorized: Watch session belongs to another user." },
          403,
        );
      }

      const dupByIdem = watchTimeEvents.find((e) => e.idempotency_key === idempotencyKey);
      if (dupByIdem) {
        if (dupByIdem.session_id !== sessionId) {
          return jsonResponse(
            {
              success: false,
              code: "IDEMPOTENCY_CONFLICT",
              error: "Idempotency key was already used for a different watch session.",
            },
            409,
          );
        }
        if (
          dupByIdem.seq !== seq ||
          dupByIdem.watched_seconds !== deltaSeconds ||
          dupByIdem.event_type !== eventType
        ) {
          return jsonResponse(
            {
              success: false,
              code: "IDEMPOTENCY_CONFLICT",
              error: "Idempotency key conflict: parameters do not match original event.",
            },
            409,
          );
        }
        return jsonResponse({
          success: true,
          deduplicated: true,
          session_id: sessionId,
          credited_seconds: 0,
          total_watched_seconds: session.total_watched_seconds,
          is_qualified: Boolean(session.is_qualified),
          status: session.status,
        });
      }

      if (watchTimeEvents.some((e) => e.session_id === sessionId && e.seq === seq)) {
        return jsonResponse(
          {
            success: false,
            code: "SEQUENCE_CONFLICT",
            error: "Sequence number already processed with a different idempotency_key.",
          },
          409,
        );
      }

      if (seq <= session.last_seq) {
        return jsonResponse(
          {
            success: false,
            code: "SEQUENCE_CONFLICT",
            error: "Sequence number must be greater than last committed sequence.",
          },
          409,
        );
      }

      const startedEpoch = parseUtcDatetimeToEpoch(session.started_at) ?? nowEpoch;
      const lastHbEpoch = parseUtcDatetimeToEpoch(session.last_heartbeat_at) ?? startedEpoch;
      const expiresEpoch =
        parseUtcDatetimeToEpoch(session.expires_at) ?? startedEpoch + WT_SESSION_TTL_SECONDS;
      const endedEpoch = parseUtcDatetimeToEpoch(session.ended_at);

      if (nowEpoch > expiresEpoch) {
        if (session.status === "active") {
          session.status = "ended";
          session.close_reason = "expired";
          session.ended_at = session.ended_at || nowSql;
          session.updated_at = nowSql;
          saveStore(store);
        }
        return jsonResponse(
          {
            success: false,
            code: "SESSION_EXPIRED",
            error: "Watch session has expired.",
          },
          409,
        );
      }

      let markSupersededGraceUsed = Boolean(session.superseded_grace_used);
      let isSupersededGrace = false;
      if (session.status === "ended") {
        const canUseSupersededGrace =
          session.close_reason === "superseded" &&
          !markSupersededGraceUsed &&
          seq === session.last_seq + 1 &&
          endedEpoch !== null &&
          nowEpoch <= endedEpoch + WT_SUPERSEDED_FLUSH_WINDOW_SEC &&
          (parsedClientEpoch === null ||
            parsedClientEpoch <= endedEpoch + WT_WALL_CLOCK_JITTER_TOLERANCE_SEC);

        if (!canUseSupersededGrace) {
          return jsonResponse(
            {
              success: false,
              code: "SESSION_ENDED",
              error: "Watch session has already ended.",
            },
            409,
          );
        }
        isSupersededGrace = true;
        markSupersededGraceUsed = true;
      }

      if (
        parsedClientEpoch !== null &&
        parsedClientEpoch < startedEpoch - WT_WALL_CLOCK_JITTER_TOLERANCE_SEC
      ) {
        return jsonResponse(
          {
            success: false,
            code: "INVALID_CLIENT_TIMESTAMP",
            error: "client_timestamp precedes session start.",
          },
          400,
        );
      }

      let segmentEndEpoch = nowEpoch;
      if (isSupersededGrace && endedEpoch !== null) {
        segmentEndEpoch =
          parsedClientEpoch !== null
            ? Math.min(endedEpoch, nowEpoch, Math.max(startedEpoch, parsedClientEpoch))
            : Math.min(endedEpoch, nowEpoch);

        if (endedEpoch - lastHbEpoch < deltaSeconds) {
          return jsonResponse(
            {
              success: false,
              code: "DELTA_EXCEEDS_ELAPSED_TIME",
              error: "delta_seconds exceeds elapsed time before session ended.",
            },
            400,
          );
        }

        if (
          parsedClientEpoch !== null &&
          segmentEndEpoch - lastHbEpoch + WT_WALL_CLOCK_JITTER_TOLERANCE_SEC < deltaSeconds
        ) {
          return jsonResponse(
            {
              success: false,
              code: "DELTA_EXCEEDS_ELAPSED_TIME",
              error: "delta_seconds exceeds elapsed time since last heartbeat.",
            },
            400,
          );
        }
      } else {
        if (parsedClientEpoch !== null) {
          segmentEndEpoch = Math.min(nowEpoch, Math.max(startedEpoch, parsedClientEpoch));
          if (segmentEndEpoch - lastHbEpoch + WT_WALL_CLOCK_JITTER_TOLERANCE_SEC < deltaSeconds) {
            return jsonResponse(
              {
                success: false,
                code: "DELTA_EXCEEDS_ELAPSED_TIME",
                error: "delta_seconds exceeds elapsed time since last heartbeat.",
              },
              400,
            );
          }
        }

        if (nowEpoch - lastHbEpoch + WT_WALL_CLOCK_JITTER_TOLERANCE_SEC < deltaSeconds) {
          return jsonResponse(
            {
              success: false,
              code: "DELTA_EXCEEDS_ELAPSED_TIME",
              error: "delta_seconds exceeds server wall-clock elapsed time.",
            },
            400,
          );
        }
      }

      const sessionCap = computeSessionCapSeconds(
        session.content_type,
        session.video_duration_seconds,
      );
      if (session.total_watched_seconds + deltaSeconds > sessionCap) {
        return jsonResponse(
          {
            success: false,
            code: "SESSION_CAP_REACHED",
            error: "Maximum watch-time cap reached for this session.",
          },
          429,
        );
      }

      let sum60 = 0;
      let sum3600 = 0;
      for (const ev of watchTimeEvents) {
        if (ev.viewer_user_id.toUpperCase() !== viewerUserId.toUpperCase()) continue;
        const createdEp = parseUtcDatetimeToEpoch(ev.created_at) ?? 0;
        if (createdEp >= nowEpoch - 60) sum60 += ev.watched_seconds;
        if (createdEp >= nowEpoch - 3600) sum3600 += ev.watched_seconds;
      }
      if (sum60 + deltaSeconds > WT_GLOBAL_60S_VELOCITY_CAP_SEC) {
        return jsonResponse(
          {
            success: false,
            code: "VIEWER_VELOCITY_LIMIT",
            error: "Watch-time velocity limit exceeded (60s window).",
          },
          429,
        );
      }
      if (sum3600 + deltaSeconds > WT_GLOBAL_3600S_VELOCITY_CAP_SEC) {
        return jsonResponse(
          {
            success: false,
            code: "VIEWER_HOURLY_LIMIT",
            error: "Hourly viewer watch-time limit exceeded.",
          },
          429,
        );
      }

      const split = splitWatchSecondsAcrossUtcMidnight(segmentEndEpoch, deltaSeconds);
      const dailyCap = getDailyVideoCapSeconds(session.content_type);
      for (const slice of split.slices) {
        let daySum = 0;
        for (const ev of watchTimeEvents) {
          if (
            ev.viewer_user_id.toUpperCase() === viewerUserId.toUpperCase() &&
            ev.video_id === session.video_id
          ) {
            if (ev.watch_date === slice.watchDate) daySum += ev.primary_date_seconds;
            if (ev.split_prev_date === slice.watchDate) daySum += ev.split_prev_seconds;
          }
        }
        if (daySum + slice.seconds > dailyCap) {
          return jsonResponse(
            {
              success: false,
              code: "DAILY_VIDEO_CAP_REACHED",
              error: "Daily per-video watch-time cap reached for this viewer.",
            },
            429,
          );
        }
      }

      const prevTotal = session.total_watched_seconds;
      const newTotal = prevTotal + deltaSeconds;
      const isSelfWatch = Boolean(session.is_self_watch);
      const wasQualified = session.is_qualified === 1;
      const newlyQualified =
        !isSelfWatch && !wasQualified && newTotal >= WT_MIN_QUALIFIED_WATCH_SECONDS;

      let qualifiedWatchDate = session.qualified_watch_date;
      if (newlyQualified) {
        if (
          split.splitPrevDate &&
          split.splitPrevSeconds > 0 &&
          prevTotal + split.splitPrevSeconds >= WT_MIN_QUALIFIED_WATCH_SECONDS
        ) {
          qualifiedWatchDate = split.splitPrevDate;
        } else {
          qualifiedWatchDate = split.watchDate;
        }
      }

      const nextEventId = watchTimeEvents.reduce((m, e) => Math.max(m, e.id), 0) + 1;
      watchTimeEvents.push({
        id: nextEventId,
        session_id: sessionId,
        viewer_user_id: viewerUserId,
        video_id: session.video_id,
        seq,
        idempotency_key: idempotencyKey,
        event_type: eventType,
        watched_seconds: deltaSeconds,
        position_seconds: positionSeconds,
        client_event_at: parsedClientEpoch !== null ? toMysqlUtcDatetime(segmentEndEpoch) : null,
        watch_date: split.watchDate,
        primary_date_seconds: split.primaryDateSeconds,
        split_prev_date: split.splitPrevDate,
        split_prev_seconds: split.splitPrevSeconds,
        created_at: nowSql,
      });

      const nextStatus: "active" | "ended" =
        session.status === "ended" || eventType === "ended" || eventType === "unload"
          ? "ended"
          : "active";
      session.total_watched_seconds = newTotal;
      session.is_qualified = wasQualified || newlyQualified ? 1 : 0;
      session.qualified_watch_date = qualifiedWatchDate;
      session.last_seq = seq;
      session.last_position_seconds = positionSeconds;
      session.last_heartbeat_at = nowSql;
      session.updated_at = nowSql;
      if (session.status !== "ended" && nextStatus === "ended") {
        session.status = "ended";
        session.close_reason = eventType === "unload" ? "unload" : "ended";
        session.ended_at = nowSql;
      }
      session.superseded_grace_used = markSupersededGraceUsed ? 1 : 0;

      if (!isSelfWatch) {
        for (const slice of split.slices) {
          let sliceQualifiedSec = 0;
          let sliceQualifiedCount = 0;

          if (wasQualified) {
            sliceQualifiedSec = slice.seconds;
          } else if (newlyQualified) {
            if (slice.watchDate === qualifiedWatchDate) {
              sliceQualifiedCount = 1;
              if (split.slices.length === 2 && qualifiedWatchDate === split.watchDate) {
                sliceQualifiedSec = newTotal;
              } else {
                sliceQualifiedSec = prevTotal + slice.seconds;
              }
            } else if (
              split.slices.length === 2 &&
              qualifiedWatchDate === split.splitPrevDate &&
              slice.watchDate === split.watchDate
            ) {
              sliceQualifiedSec = slice.seconds;
            }
          }

          let dailyRow = videoWatchDaily.find(
            (r) => r.watch_date === slice.watchDate && r.video_id === session.video_id,
          );
          if (!dailyRow) {
            dailyRow = {
              watch_date: slice.watchDate,
              creator_user_id: session.creator_user_id,
              video_id: session.video_id,
              total_watched_seconds: 0,
              qualified_watched_seconds: 0,
              qualified_sessions: 0,
              updated_at: nowSql,
            };
            videoWatchDaily.push(dailyRow);
          }
          dailyRow.total_watched_seconds += slice.seconds;
          dailyRow.qualified_watched_seconds += sliceQualifiedSec;
          dailyRow.qualified_sessions += sliceQualifiedCount;
          dailyRow.updated_at = nowSql;
        }
      }

      saveStore(store);

      return jsonResponse({
        success: true,
        deduplicated: false,
        session_id: sessionId,
        seq,
        credited_seconds: deltaSeconds,
        total_watched_seconds: newTotal,
        is_qualified: Boolean(session.is_qualified),
        status: nextStatus,
      });
    }),
  );
}

// ==============================================================================
// 3. GET /api/watch-time/analytics
// ==============================================================================
async function handleWatchAnalytics(ctx: WatchTimeHandlerContext): Promise<Response> {
  const { method, url, store, pool, isProduction, authUser, requireAuth, jsonResponse } = ctx;
  if (method !== "GET") {
    return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
  }

  if (isProduction && !pool) {
    return jsonResponse(
      {
        success: false,
        error: "Database connection unavailable. Persistent database storage is required.",
      },
      503,
    );
  }

  const qUserId = url.searchParams.get("user_id") || url.searchParams.get("userId");
  const auth = requireAuth(authUser, qUserId);
  if (!auth.success) {
    return auth.response;
  }
  let creatorUserId = auth.effectiveUserId;

  // Canonicalize creator user_id if UUID or casing difference was passed
  if (pool) {
    try {
      const [uRows]: any = await pool.query(
        `SELECT user_id FROM users WHERE UPPER(user_id) = UPPER(?) OR UPPER(id) = UPPER(?) LIMIT 1`,
        [creatorUserId, creatorUserId],
      );
      if (Array.isArray(uRows) && uRows.length > 0 && uRows[0].user_id) {
        creatorUserId = String(uRows[0].user_id).trim();
      }
    } catch (err) {
      if (isMysqlConnectionUnavailableError(err)) {
        return jsonResponse({ success: false, error: "Database connection unavailable." }, 503);
      }
    }
  } else {
    const uMatch = store.users.find(
      (u) =>
        u.user_id.toUpperCase() === creatorUserId.toUpperCase() ||
        u.id.toUpperCase() === creatorUserId.toUpperCase(),
    );
    if (uMatch?.user_id) {
      creatorUserId = uMatch.user_id;
    }
  }

  const rawPeriod = String(url.searchParams.get("period") || "")
    .trim()
    .toUpperCase();
  const rawDays = parseInt(url.searchParams.get("days") || "0", 10);

  let period: "7D" | "28D" | "30D" | "90D" | "12M" = "7D";
  let days = 7;

  if (rawPeriod === "7D" || rawDays === 7) {
    period = "7D";
    days = 7;
  } else if (rawPeriod === "28D" || rawDays === 28) {
    period = "28D";
    days = 28;
  } else if (rawPeriod === "30D" || rawDays === 30) {
    period = "30D";
    days = 30;
  } else if (rawPeriod === "90D" || rawDays === 90) {
    period = "90D";
    days = 90;
  } else if (rawPeriod === "12M" || rawDays >= 365) {
    period = "12M";
    days = 365;
  } else if (rawDays > 0) {
    days = Math.max(7, Math.min(365, rawDays));
    period =
      days <= 7 ? "7D" : days === 28 ? "28D" : days <= 30 ? "30D" : days <= 90 ? "90D" : "12M";
  }

  const nowEpoch = ctx.nowEpochSec ?? Math.floor(Date.now() / 1000);
  const todayUtcDate = formatUtcDate(nowEpoch);
  const currentStartEpoch = nowEpoch - (days - 1) * 86400;
  const currentStartDate = formatUtcDate(currentStartEpoch);
  const prevEndDate = formatUtcDate(currentStartEpoch - 86400);
  const prevStartDate = formatUtcDate(currentStartEpoch - days * 86400);

  // Build zero-filled UTC buckets
  const timelineMap: Record<
    string,
    {
      date: string;
      day: string;
      watched_seconds: number;
      hours: number;
      qualified_watched_seconds: number;
      qualified_sessions: number;
    }
  > = {};

  if (period === "12M") {
    const nowDt = new Date(nowEpoch * 1000);
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(nowDt.getUTCFullYear(), nowDt.getUTCMonth() - i, 1));
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const label = d.toLocaleDateString("en-US", {
        month: "short",
        year: "2-digit",
        timeZone: "UTC",
      });
      timelineMap[key] = {
        date: key,
        day: label,
        watched_seconds: 0,
        hours: 0,
        qualified_watched_seconds: 0,
        qualified_sessions: 0,
      };
    }
  } else {
    for (let i = days - 1; i >= 0; i--) {
      const dEpoch = nowEpoch - i * 86400;
      const d = new Date(dEpoch * 1000);
      const key = formatUtcDate(dEpoch);
      const label =
        days <= 7
          ? d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })
          : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
      timelineMap[key] = {
        date: key,
        day: label,
        watched_seconds: 0,
        hours: 0,
        qualified_watched_seconds: 0,
        qualified_sessions: 0,
      };
    }
  }

  let currTotalSec = 0;
  let currQualifiedSec = 0;
  let currQualifiedSessions = 0;
  let prevTotalSec = 0;
  let lifetimeTotalSec = 0;
  let lifetimeQualifiedSec = 0;
  let lifetimeQualifiedSessions = 0;
  const topVideos: Array<{
    video_id: string;
    title: string;
    content_type: "short" | "long";
    total_watched_seconds: number;
    hours: number;
    qualified_watched_seconds: number;
    qualified_sessions: number;
    avg_view_duration_seconds: number;
    avg_view_duration_formatted: string;
  }> = [];

  if (pool) {
    try {
      const [lifeRows]: any = await pool.query(
        `SELECT
           COALESCE(SUM(total_watched_seconds), 0) AS total_sec,
           COALESCE(SUM(qualified_watched_seconds), 0) AS qual_sec,
           COALESCE(SUM(qualified_sessions), 0) AS qual_sessions
         FROM video_watch_daily
         WHERE UPPER(creator_user_id) = UPPER(?)`,
        [creatorUserId],
      );
      lifetimeTotalSec = Number(lifeRows?.[0]?.total_sec || 0);
      lifetimeQualifiedSec = Number(lifeRows?.[0]?.qual_sec || 0);
      lifetimeQualifiedSessions = Number(lifeRows?.[0]?.qual_sessions || 0);

      if (period === "12M") {
        const nowDt = new Date(nowEpoch * 1000);
        const startMonthDate = formatUtcDate(
          Math.floor(Date.UTC(nowDt.getUTCFullYear(), nowDt.getUTCMonth() - 11, 1) / 1000),
        );
        const prev12MStartDate = formatUtcDate(
          Math.floor(Date.UTC(nowDt.getUTCFullYear(), nowDt.getUTCMonth() - 23, 1) / 1000),
        );
        const prev12MEndDate = formatUtcDate(
          Math.floor(Date.UTC(nowDt.getUTCFullYear(), nowDt.getUTCMonth() - 11, 0) / 1000),
        );

        const [bucketRows]: any = await pool.query(
          `SELECT
             DATE_FORMAT(watch_date, '%Y-%m') AS period_key,
             COALESCE(SUM(total_watched_seconds), 0) AS total_sec,
             COALESCE(SUM(qualified_watched_seconds), 0) AS qual_sec,
             COALESCE(SUM(qualified_sessions), 0) AS qual_sessions
           FROM video_watch_daily
           WHERE UPPER(creator_user_id) = UPPER(?)
             AND watch_date >= ?
             AND watch_date <= ?
           GROUP BY DATE_FORMAT(watch_date, '%Y-%m')
           ORDER BY period_key ASC`,
          [creatorUserId, startMonthDate, todayUtcDate],
        );
        for (const r of Array.isArray(bucketRows) ? bucketRows : []) {
          const k = String(r.period_key || "");
          const sec = Number(r.total_sec || 0);
          const qSec = Number(r.qual_sec || 0);
          const qSess = Number(r.qual_sessions || 0);
          currTotalSec += sec;
          currQualifiedSec += qSec;
          currQualifiedSessions += qSess;
          if (timelineMap[k]) {
            timelineMap[k].watched_seconds = sec;
            timelineMap[k].hours = Number((sec / 3600).toFixed(2));
            timelineMap[k].qualified_watched_seconds = qSec;
            timelineMap[k].qualified_sessions = qSess;
          }
        }

        const [prevRows]: any = await pool.query(
          `SELECT COALESCE(SUM(total_watched_seconds), 0) AS total_sec
           FROM video_watch_daily
           WHERE UPPER(creator_user_id) = UPPER(?)
             AND watch_date >= ?
             AND watch_date <= ?`,
          [creatorUserId, prev12MStartDate, prev12MEndDate],
        );
        prevTotalSec = Number(prevRows?.[0]?.total_sec || 0);

        const [topRows]: any = await pool.query(
          `SELECT
             d.video_id,
             COALESCE(v.title, d.video_id) AS title,
             COALESCE(v.content_type, 'long') AS content_type,
             COALESCE(SUM(d.total_watched_seconds), 0) AS total_sec,
             COALESCE(SUM(d.qualified_watched_seconds), 0) AS qual_sec,
             COALESCE(SUM(d.qualified_sessions), 0) AS qual_sessions
           FROM video_watch_daily d
           LEFT JOIN uploaded_videos v ON v.id = d.video_id
           WHERE UPPER(d.creator_user_id) = UPPER(?)
             AND d.watch_date >= ?
             AND d.watch_date <= ?
           GROUP BY d.video_id, v.title, v.content_type
           ORDER BY total_sec DESC
           LIMIT 10`,
          [creatorUserId, startMonthDate, todayUtcDate],
        );
        for (const r of Array.isArray(topRows) ? topRows : []) {
          const sec = Number(r.total_sec || 0);
          const qSec = Number(r.qual_sec || 0);
          const qSess = Number(r.qual_sessions || 0);
          const avgSec = computeAverageViewDurationSeconds(qSec, qSess);
          topVideos.push({
            video_id: String(r.video_id),
            title: String(r.title || r.video_id),
            content_type: String(r.content_type).toLowerCase() === "short" ? "short" : "long",
            total_watched_seconds: sec,
            hours: Number((sec / 3600).toFixed(2)),
            qualified_watched_seconds: qSec,
            qualified_sessions: qSess,
            avg_view_duration_seconds: avgSec,
            avg_view_duration_formatted: formatDurationCompact(avgSec),
          });
        }
      } else {
        const [bucketRows]: any = await pool.query(
          `SELECT
             DATE_FORMAT(watch_date, '%Y-%m-%d') AS period_key,
             COALESCE(SUM(total_watched_seconds), 0) AS total_sec,
             COALESCE(SUM(qualified_watched_seconds), 0) AS qual_sec,
             COALESCE(SUM(qualified_sessions), 0) AS qual_sessions
           FROM video_watch_daily
           WHERE UPPER(creator_user_id) = UPPER(?)
             AND watch_date >= ?
             AND watch_date <= ?
           GROUP BY DATE_FORMAT(watch_date, '%Y-%m-%d')
           ORDER BY period_key ASC`,
          [creatorUserId, currentStartDate, todayUtcDate],
        );
        for (const r of Array.isArray(bucketRows) ? bucketRows : []) {
          const k = String(r.period_key || "");
          const sec = Number(r.total_sec || 0);
          const qSec = Number(r.qual_sec || 0);
          const qSess = Number(r.qual_sessions || 0);
          currTotalSec += sec;
          currQualifiedSec += qSec;
          currQualifiedSessions += qSess;
          if (timelineMap[k]) {
            timelineMap[k].watched_seconds = sec;
            timelineMap[k].hours = Number((sec / 3600).toFixed(2));
            timelineMap[k].qualified_watched_seconds = qSec;
            timelineMap[k].qualified_sessions = qSess;
          }
        }

        const [prevRows]: any = await pool.query(
          `SELECT COALESCE(SUM(total_watched_seconds), 0) AS total_sec
           FROM video_watch_daily
           WHERE UPPER(creator_user_id) = UPPER(?)
             AND watch_date >= ?
             AND watch_date <= ?`,
          [creatorUserId, prevStartDate, prevEndDate],
        );
        prevTotalSec = Number(prevRows?.[0]?.total_sec || 0);

        const [topRows]: any = await pool.query(
          `SELECT
             d.video_id,
             COALESCE(v.title, d.video_id) AS title,
             COALESCE(v.content_type, 'long') AS content_type,
             COALESCE(SUM(d.total_watched_seconds), 0) AS total_sec,
             COALESCE(SUM(d.qualified_watched_seconds), 0) AS qual_sec,
             COALESCE(SUM(d.qualified_sessions), 0) AS qual_sessions
           FROM video_watch_daily d
           LEFT JOIN uploaded_videos v ON v.id = d.video_id
           WHERE UPPER(d.creator_user_id) = UPPER(?)
             AND d.watch_date >= ?
             AND d.watch_date <= ?
           GROUP BY d.video_id, v.title, v.content_type
           ORDER BY total_sec DESC
           LIMIT 10`,
          [creatorUserId, currentStartDate, todayUtcDate],
        );
        for (const r of Array.isArray(topRows) ? topRows : []) {
          const sec = Number(r.total_sec || 0);
          const qSec = Number(r.qual_sec || 0);
          const qSess = Number(r.qual_sessions || 0);
          const avgSec = computeAverageViewDurationSeconds(qSec, qSess);
          topVideos.push({
            video_id: String(r.video_id),
            title: String(r.title || r.video_id),
            content_type: String(r.content_type).toLowerCase() === "short" ? "short" : "long",
            total_watched_seconds: sec,
            hours: Number((sec / 3600).toFixed(2)),
            qualified_watched_seconds: qSec,
            qualified_sessions: qSess,
            avg_view_duration_seconds: avgSec,
            avg_view_duration_formatted: formatDurationCompact(avgSec),
          });
        }
      }
    } catch (err) {
      if (isMysqlConnectionUnavailableError(err)) {
        return jsonResponse(
          { success: false, error: "Database connection unavailable while querying analytics." },
          503,
        );
      }
      return jsonResponse(
        { success: false, error: "Database error while querying watch-time analytics." },
        500,
      );
    }
  } else {
    const { videoWatchDaily } = ensureStoreWatchCollections(store);
    const creatorRows = videoWatchDaily.filter(
      (r) => r.creator_user_id.toUpperCase() === creatorUserId.toUpperCase(),
    );

    const nowDt = new Date(nowEpoch * 1000);
    const startDateFilter =
      period === "12M"
        ? formatUtcDate(
            Math.floor(Date.UTC(nowDt.getUTCFullYear(), nowDt.getUTCMonth() - 11, 1) / 1000),
          )
        : currentStartDate;
    const prevStartFilter =
      period === "12M"
        ? formatUtcDate(
            Math.floor(Date.UTC(nowDt.getUTCFullYear(), nowDt.getUTCMonth() - 23, 1) / 1000),
          )
        : prevStartDate;
    const prevEndFilter =
      period === "12M"
        ? formatUtcDate(
            Math.floor(Date.UTC(nowDt.getUTCFullYear(), nowDt.getUTCMonth() - 11, 0) / 1000),
          )
        : prevEndDate;

    const videoAgg = new Map<string, { total: number; qualSec: number; qualSess: number }>();

    for (const r of creatorRows) {
      lifetimeTotalSec += r.total_watched_seconds;
      lifetimeQualifiedSec += r.qualified_watched_seconds;
      lifetimeQualifiedSessions += r.qualified_sessions;

      if (r.watch_date >= prevStartFilter && r.watch_date <= prevEndFilter) {
        prevTotalSec += r.total_watched_seconds;
      }

      if (r.watch_date >= startDateFilter && r.watch_date <= todayUtcDate) {
        currTotalSec += r.total_watched_seconds;
        currQualifiedSec += r.qualified_watched_seconds;
        currQualifiedSessions += r.qualified_sessions;

        const key = period === "12M" ? r.watch_date.slice(0, 7) : r.watch_date;
        if (timelineMap[key]) {
          timelineMap[key].watched_seconds += r.total_watched_seconds;
          timelineMap[key].hours = Number((timelineMap[key].watched_seconds / 3600).toFixed(2));
          timelineMap[key].qualified_watched_seconds += r.qualified_watched_seconds;
          timelineMap[key].qualified_sessions += r.qualified_sessions;
        }

        const existing = videoAgg.get(r.video_id) ?? { total: 0, qualSec: 0, qualSess: 0 };
        existing.total += r.total_watched_seconds;
        existing.qualSec += r.qualified_watched_seconds;
        existing.qualSess += r.qualified_sessions;
        videoAgg.set(r.video_id, existing);
      }
    }

    const sortedVideos = Array.from(videoAgg.entries())
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 10);
    for (const [vidId, agg] of sortedVideos) {
      const vidMeta = store.videos.find((v) => v.id === vidId);
      const avgSec = computeAverageViewDurationSeconds(agg.qualSec, agg.qualSess);
      topVideos.push({
        video_id: vidId,
        title: vidMeta?.title || vidId,
        content_type: vidMeta?.content_type === "short" ? "short" : "long",
        total_watched_seconds: agg.total,
        hours: Number((agg.total / 3600).toFixed(2)),
        qualified_watched_seconds: agg.qualSec,
        qualified_sessions: agg.qualSess,
        avg_view_duration_seconds: avgSec,
        avg_view_duration_formatted: formatDurationCompact(avgSec),
      });
    }
  }

  const periodAvgSec = computeAverageViewDurationSeconds(currQualifiedSec, currQualifiedSessions);
  const lifetimeAvgSec = computeAverageViewDurationSeconds(
    lifetimeQualifiedSec,
    lifetimeQualifiedSessions,
  );
  const growthPercent =
    prevTotalSec > 0
      ? Number((((currTotalSec - prevTotalSec) / prevTotalSec) * 100).toFixed(1))
      : null;

  return jsonResponse({
    success: true,
    creator_user_id: creatorUserId,
    period,
    days,
    timezone: "UTC",
    has_data: lifetimeTotalSec > 0,
    summary: {
      total_watched_seconds: currTotalSec,
      total_hours: Number((currTotalSec / 3600).toFixed(2)),
      qualified_watched_seconds: currQualifiedSec,
      qualified_sessions: currQualifiedSessions,
      avg_view_duration_seconds: periodAvgSec,
      avg_view_duration_formatted: formatDurationCompact(periodAvgSec),
      previous_period_watched_seconds: prevTotalSec,
      growth_percent: growthPercent,
    },
    lifetime: {
      total_watched_seconds: lifetimeTotalSec,
      total_hours: Number((lifetimeTotalSec / 3600).toFixed(2)),
      qualified_watched_seconds: lifetimeQualifiedSec,
      qualified_sessions: lifetimeQualifiedSessions,
      avg_view_duration_seconds: lifetimeAvgSec,
      avg_view_duration_formatted: formatDurationCompact(lifetimeAvgSec),
    },
    history: Object.values(timelineMap),
    top_videos: topVideos,
  });
}
