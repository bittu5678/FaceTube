import type {
  WatchTimeHeartbeatRequest,
  WatchTimeHeartbeatResponse,
  WatchTimeSessionResponse,
} from "./api";

export type WatchTimeEventType = WatchTimeHeartbeatRequest["event_type"];

export interface WatchTimeTrackerDeps {
  videoId: string;
  isAuthenticated: boolean;
  startSession: (videoId: string) => Promise<WatchTimeSessionResponse>;
  sendHeartbeat: (
    payload: WatchTimeHeartbeatRequest,
    options?: { keepalive?: boolean },
  ) => Promise<WatchTimeHeartbeatResponse>;
  nowMs?: () => number;
  isPageVisible?: () => boolean;
  setIntervalFn?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (id: ReturnType<typeof setInterval>) => void;
  onServerUpdate?: (response: WatchTimeHeartbeatResponse) => void;
}

const DEFAULT_HEARTBEAT_INTERVAL_SEC = 15;
const DEFAULT_MAX_DELTA_SEC = 30;
const TERMINAL_HEARTBEAT_CODES = new Set([
  "SESSION_ENDED",
  "SESSION_EXPIRED",
  "SESSION_CAP_REACHED",
  "DAILY_VIDEO_CAP_REACHED",
  "IDEMPOTENCY_CONFLICT",
]);

function generateIdempotencyKey(seq: number, nowMs: number): string {
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : Math.random().toString(36).slice(2, 12);
  return `wt_${seq}_${Math.floor(nowMs)}_${rand}`.slice(0, 100);
}

function extractErrorMeta(err: unknown): { status?: number; code?: string } {
  if (!err || typeof err !== "object") return {};
  const anyErr = err as { status?: unknown; data?: unknown; code?: unknown };
  const status = typeof anyErr.status === "number" ? anyErr.status : undefined;
  let code = typeof anyErr.code === "string" ? anyErr.code : undefined;
  if (!code && anyErr.data && typeof anyErr.data === "object") {
    const dataCode = (anyErr.data as { code?: unknown }).code;
    if (typeof dataCode === "string") code = dataCode;
  }
  return {
    ...(status !== undefined ? { status } : {}),
    ...(code ? { code: code.toUpperCase() } : {}),
  };
}

function isTerminalError(err: unknown): boolean {
  const { status, code } = extractErrorMeta(err);
  if (code === "TRANSACTION_CONFLICT") {
    return false;
  }
  if (code && TERMINAL_HEARTBEAT_CODES.has(code)) {
    return true;
  }
  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 429) {
    return true;
  }
  if (status === 409) {
    return true;
  }
  return false;
}

export class WatchTimeTracker {
  private readonly videoId: string;
  private readonly isAuthenticated: boolean;
  private readonly startSessionFn: WatchTimeTrackerDeps["startSession"];
  private readonly sendHeartbeatFn: WatchTimeTrackerDeps["sendHeartbeat"];
  private readonly nowMs: () => number;
  private readonly isPageVisibleFn: () => boolean;
  private readonly setIntervalFn: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearIntervalFn: (id: ReturnType<typeof setInterval>) => void;
  private readonly onServerUpdate: ((response: WatchTimeHeartbeatResponse) => void) | undefined;

  private sessionId: string | null = null;
  private sessionPromise: Promise<string | null> | null = null;
  private sessionTerminated = false;
  private destroyed = false;

  private heartbeatIntervalSec = DEFAULT_HEARTBEAT_INTERVAL_SEC;
  private maxDeltaSec = DEFAULT_MAX_DELTA_SEC;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  private playing = false;
  private buffering = false;
  private ended = false;
  private visible: boolean;

  private activeSegmentStartMs: number | null = null;
  private accumulatedMs = 0;
  private latestPositionSec = 0;
  private seq = 0;
  private sessionStartedClientMs: number | null = null;
  private lastSuccessfulHeartbeatMs: number | null = null;

  private pendingRetryPayload: WatchTimeHeartbeatRequest | null = null;
  private flushInFlight: Promise<void> | null = null;

  constructor(deps: WatchTimeTrackerDeps) {
    this.videoId = String(deps.videoId || "").trim();
    this.isAuthenticated = Boolean(deps.isAuthenticated);
    this.startSessionFn = deps.startSession;
    this.sendHeartbeatFn = deps.sendHeartbeat;
    this.nowMs = deps.nowMs ?? (() => Date.now());
    this.isPageVisibleFn =
      deps.isPageVisible ??
      (() => (typeof document === "undefined" ? true : document.visibilityState !== "hidden"));
    this.setIntervalFn = deps.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
    this.clearIntervalFn = deps.clearIntervalFn ?? ((id) => clearInterval(id));
    this.onServerUpdate = deps.onServerUpdate;
    this.visible = this.isPageVisibleFn();
  }

  public isEnabled(): boolean {
    return this.isAuthenticated && this.videoId.length > 0 && !this.destroyed;
  }

  public getStateSnapshot() {
    return {
      sessionId: this.sessionId,
      seq: this.seq,
      accumulatedMs: this.getLiveAccumulatedMs(),
      hasPendingRetry: this.pendingRetryPayload !== null,
      playing: this.playing,
      buffering: this.buffering,
      visible: this.visible,
      ended: this.ended,
      sessionTerminated: this.sessionTerminated,
      destroyed: this.destroyed,
    };
  }

  private get isActivelyCounting(): boolean {
    return this.playing && !this.buffering && !this.ended && this.visible && !this.destroyed;
  }

  private getLiveAccumulatedMs(): number {
    if (this.activeSegmentStartMs === null) {
      return this.accumulatedMs;
    }
    const elapsed = Math.max(0, this.nowMs() - this.activeSegmentStartMs);
    return this.accumulatedMs + elapsed;
  }

  private commitActiveSegment(): void {
    if (this.activeSegmentStartMs === null) return;
    const elapsed = Math.max(0, this.nowMs() - this.activeSegmentStartMs);
    this.accumulatedMs += elapsed;
    this.activeSegmentStartMs = null;
  }

  private syncCountingSegment(): void {
    if (!this.isEnabled() || this.sessionTerminated) {
      this.commitActiveSegment();
      return;
    }

    if (this.isActivelyCounting) {
      if (this.activeSegmentStartMs === null) {
        this.activeSegmentStartMs = this.nowMs();
      }
      this.ensureSessionStarted();
      this.ensureIntervalStarted();
    } else {
      this.commitActiveSegment();
      this.stopInterval();
    }
  }

  private ensureIntervalStarted(): void {
    if (this.intervalHandle !== null || this.destroyed) return;
    const intervalMs = Math.max(5000, this.heartbeatIntervalSec * 1000);
    this.intervalHandle = this.setIntervalFn(() => {
      void this.tick();
    }, intervalMs);
  }

  private stopInterval(): void {
    if (this.intervalHandle !== null) {
      this.clearIntervalFn(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  private ensureSessionStarted(): Promise<string | null> {
    if (!this.isAuthenticated || !this.videoId || this.sessionTerminated) {
      return Promise.resolve(null);
    }
    if (this.sessionId) {
      return Promise.resolve(this.sessionId);
    }
    if (this.sessionPromise) {
      return this.sessionPromise;
    }

    const requestStartedMs = this.nowMs();
    this.sessionPromise = this.startSessionFn(this.videoId)
      .then((res) => {
        if (!res || !res.success || (!res.session_id && !res.sessionId)) {
          this.sessionTerminated = true;
          return null;
        }
        const sid = String(res.session_id || res.sessionId || "").trim();
        if (!sid) {
          this.sessionTerminated = true;
          return null;
        }
        this.sessionId = sid;
        this.sessionStartedClientMs = requestStartedMs;
        if (
          typeof res.heartbeat_interval_seconds === "number" &&
          res.heartbeat_interval_seconds >= 5
        ) {
          this.heartbeatIntervalSec = res.heartbeat_interval_seconds;
        }
        if (typeof res.max_delta_seconds === "number" && res.max_delta_seconds >= 1) {
          this.maxDeltaSec = res.max_delta_seconds;
        }
        return sid;
      })
      .catch((err) => {
        if (isTerminalError(err)) {
          this.sessionTerminated = true;
        }
        return null;
      })
      .finally(() => {
        this.sessionPromise = null;
      });

    return this.sessionPromise;
  }

  public updatePosition(positionSeconds: number): void {
    if (Number.isFinite(positionSeconds) && positionSeconds >= 0) {
      this.latestPositionSec = Math.min(86400, Math.floor(positionSeconds));
    }
  }

  public setPlaying(playing: boolean, positionSeconds?: number): Promise<void> {
    if (positionSeconds !== undefined) {
      this.updatePosition(positionSeconds);
    }
    if (!this.isEnabled()) return Promise.resolve();

    if (playing) {
      // Allow replaying a video cleanly after an earlier session ended
      if (this.ended || (this.sessionTerminated && !this.sessionId && !this.pendingRetryPayload)) {
        this.resetSessionStateForReplay();
      }
      this.ended = false;
      this.playing = true;
      this.buffering = false;
      this.visible = this.isPageVisibleFn();
      this.syncCountingSegment();
      return Promise.resolve();
    }

    this.playing = false;
    this.syncCountingSegment();
    return this.flush("pause");
  }

  public setBuffering(buffering: boolean, positionSeconds?: number): void {
    if (positionSeconds !== undefined) {
      this.updatePosition(positionSeconds);
    }
    if (!this.isEnabled()) return;
    this.buffering = buffering;
    this.syncCountingSegment();
  }

  public setVisible(visible: boolean, positionSeconds?: number): Promise<void> {
    if (positionSeconds !== undefined) {
      this.updatePosition(positionSeconds);
    }
    if (!this.isEnabled()) return Promise.resolve();

    const wasVisible = this.visible;
    this.visible = visible;
    this.syncCountingSegment();

    if (wasVisible && !visible) {
      return this.flush("hidden");
    }
    return Promise.resolve();
  }

  public handleEnded(positionSeconds?: number): Promise<void> {
    if (positionSeconds !== undefined) {
      this.updatePosition(positionSeconds);
    }
    if (!this.isEnabled()) return Promise.resolve();

    this.playing = false;
    this.buffering = false;
    this.ended = true;
    this.syncCountingSegment();
    return this.flush("ended").finally(() => {
      this.sessionTerminated = true;
    });
  }

  public flushOnUnload(positionSeconds?: number): Promise<void> {
    if (positionSeconds !== undefined) {
      this.updatePosition(positionSeconds);
    }
    if (!this.isAuthenticated || !this.videoId) return Promise.resolve();
    this.playing = false;
    this.buffering = false;
    this.syncCountingSegment();
    return this.flush("unload", { keepalive: true });
  }

  public async tick(): Promise<void> {
    if (!this.isEnabled() || this.sessionTerminated) return;
    if (this.isActivelyCounting) {
      // Snapshot active segment up to now before starting next segment
      this.commitActiveSegment();
      this.activeSegmentStartMs = this.nowMs();
    }
    if (this.pendingRetryPayload || this.accumulatedMs >= 1000) {
      await this.flush("heartbeat");
    }
  }

  private resetSessionStateForReplay(): void {
    this.sessionId = null;
    this.sessionPromise = null;
    this.sessionTerminated = false;
    this.seq = 0;
    this.pendingRetryPayload = null;
    this.accumulatedMs = 0;
    this.activeSegmentStartMs = null;
    this.sessionStartedClientMs = null;
    this.lastSuccessfulHeartbeatMs = null;
  }

  private computeFlushDeltaSeconds(wholeSeconds: number): number {
    const baselineMs = this.lastSuccessfulHeartbeatMs ?? this.sessionStartedClientMs;
    if (baselineMs === null) {
      return Math.min(this.maxDeltaSec, wholeSeconds);
    }
    const wallElapsedSec = Math.max(0, Math.floor((this.nowMs() - baselineMs) / 1000));
    const maxWallAllowed = wallElapsedSec + 4;
    return Math.min(this.maxDeltaSec, wholeSeconds, maxWallAllowed);
  }

  public flush(eventType: WatchTimeEventType, options?: { keepalive?: boolean }): Promise<void> {
    if (!this.isAuthenticated || !this.videoId) {
      return Promise.resolve();
    }

    // Synchronous keepalive fast-path for unload/pagehide when session is already ready
    if (
      options?.keepalive &&
      !this.flushInFlight &&
      !this.pendingRetryPayload &&
      !this.sessionTerminated &&
      this.sessionId
    ) {
      this.commitActiveSegment();
      const wholeSeconds = Math.floor(this.accumulatedMs / 1000);
      const deltaSeconds = this.computeFlushDeltaSeconds(wholeSeconds);
      if (deltaSeconds >= 1) {
        this.accumulatedMs = Math.min(999, Math.max(0, this.accumulatedMs - deltaSeconds * 1000));
        this.seq += 1;
        const payload: WatchTimeHeartbeatRequest = {
          session_id: this.sessionId,
          seq: this.seq,
          idempotency_key: generateIdempotencyKey(this.seq, this.nowMs()),
          delta_seconds: deltaSeconds,
          position_seconds: this.latestPositionSec,
          event_type: eventType,
          client_timestamp: new Date(this.nowMs()).toISOString(),
        };
        const p = this.dispatchPayload(payload, options).then((ok) => {
          if (!ok && !this.sessionTerminated) {
            this.pendingRetryPayload = payload;
          }
        });
        this.flushInFlight = p.finally(() => {
          if (this.flushInFlight === p) {
            this.flushInFlight = null;
          }
        });
        return this.flushInFlight;
      }
      return Promise.resolve();
    }

    const executeFlush = async (): Promise<void> => {
      if (this.isActivelyCounting) {
        this.commitActiveSegment();
        if (!this.destroyed && eventType === "heartbeat") {
          this.activeSegmentStartMs = this.nowMs();
        }
      } else {
        this.commitActiveSegment();
      }

      // First retry any exact previously-failed event using its original seq & idempotency_key
      if (this.pendingRetryPayload) {
        const retryOk = await this.dispatchPayload(this.pendingRetryPayload, options);
        if (!retryOk) {
          return;
        }
        this.pendingRetryPayload = null;
        // Wait for the next interval unless terminating/pausing/hiding so wall-clock elapsed remains valid
        if (eventType === "heartbeat") {
          this.accumulatedMs = 0;
          return;
        }
      }

      if (this.sessionTerminated) {
        return;
      }

      const wholeSeconds = Math.floor(this.accumulatedMs / 1000);
      if (wholeSeconds < 1) {
        return;
      }

      // Never start a brand new session solely to report an unload if one was never created
      if (!this.sessionId && !this.sessionPromise) {
        return;
      }

      const sid = await this.ensureSessionStarted();
      if (!sid) {
        return;
      }

      const deltaSeconds = this.computeFlushDeltaSeconds(wholeSeconds);
      if (deltaSeconds < 1) {
        return;
      }
      // Consume whole deltaSeconds and retain only sub-second precision (< 1000ms)
      this.accumulatedMs = Math.min(999, Math.max(0, this.accumulatedMs - deltaSeconds * 1000));

      this.seq += 1;
      const payload: WatchTimeHeartbeatRequest = {
        session_id: sid,
        seq: this.seq,
        idempotency_key: generateIdempotencyKey(this.seq, this.nowMs()),
        delta_seconds: deltaSeconds,
        position_seconds: this.latestPositionSec,
        event_type: eventType,
        client_timestamp: new Date(this.nowMs()).toISOString(),
      };

      const ok = await this.dispatchPayload(payload, options);
      if (!ok && !this.sessionTerminated) {
        this.pendingRetryPayload = payload;
      }
    };

    const nextFlush = (this.flushInFlight ?? Promise.resolve()).then(executeFlush, executeFlush);
    this.flushInFlight = nextFlush.finally(() => {
      if (this.flushInFlight === nextFlush) {
        this.flushInFlight = null;
      }
    });
    return this.flushInFlight;
  }

  private async dispatchPayload(
    payload: WatchTimeHeartbeatRequest,
    options?: { keepalive?: boolean },
  ): Promise<boolean> {
    try {
      const response = await this.sendHeartbeatFn(payload, options);
      if (response && response.success) {
        this.lastSuccessfulHeartbeatMs = this.nowMs();
        this.onServerUpdate?.(response);
        if (response.status === "ended" && payload.event_type !== "ended") {
          this.sessionTerminated = true;
        }
        return true;
      }
      if (response && response.code && TERMINAL_HEARTBEAT_CODES.has(response.code.toUpperCase())) {
        this.sessionTerminated = true;
        this.pendingRetryPayload = null;
        return true;
      }
      return false;
    } catch (err) {
      if (isTerminalError(err)) {
        this.sessionTerminated = true;
        this.pendingRetryPayload = null;
        return true;
      }
      return false;
    }
  }

  public destroy(): Promise<void> {
    if (this.destroyed) {
      return this.flushInFlight ?? Promise.resolve();
    }
    this.stopInterval();
    const p = this.flushOnUnload();
    this.destroyed = true;
    this.playing = false;
    this.buffering = false;
    return p;
  }
}

export function createWatchTimeTracker(deps: WatchTimeTrackerDeps): WatchTimeTracker {
  return new WatchTimeTracker(deps);
}
