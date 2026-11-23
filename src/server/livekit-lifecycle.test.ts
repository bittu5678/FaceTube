import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  acquireInitialMediaTracksWithFallback,
  executeEndBroadcastOnce,
  runViewerRoomConnection,
  teardownBroadcasterSessionIdempotently,
  teardownViewerSession,
  unlockViewerAudioPlayback,
  type AudioElementLike,
  type MediaTrackLike,
  type RoomLike,
} from "../components/live/live-lifecycle-utils.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface MockTrack extends MediaTrackLike {
  kind: string;
  source?: string;
  stopCalls: number;
  detachCalls: number;
  attachCalls: number;
}

function createMockTrack(kind: string, source?: string): MockTrack {
  const track: MockTrack = {
    kind,
    ...(source !== undefined ? { source } : {}),
    stopCalls: 0,
    detachCalls: 0,
    attachCalls: 0,
    mediaStreamTrack: {
      readyState: "live",
      label: kind === "video" ? "Mock Camera" : "Mock Mic",
      getSettings: () => ({ deviceId: `${kind}-dev-1`, facingMode: "user" }),
    },
    attach: (el?: HTMLMediaElement) => {
      track.attachCalls += 1;
      if (el && kind === "audio") {
        (el as unknown as { srcObject: unknown }).srcObject = { track };
      }
      return el;
    },
    detach: () => {
      track.detachCalls += 1;
      return [];
    },
    stop: () => {
      track.stopCalls += 1;
      if (track.mediaStreamTrack) {
        track.mediaStreamTrack.readyState = "ended";
      }
    },
  };
  return track;
}

interface MockAudioEl extends AudioElementLike {
  pauseCalls: number;
  playCalls: number;
  playError: unknown;
}

function createMockAudioEl(playError: unknown = null): MockAudioEl {
  const el: MockAudioEl = {
    muted: false,
    srcObject: null,
    pauseCalls: 0,
    playCalls: 0,
    playError,
    pause: () => {
      el.pauseCalls += 1;
    },
    play: async () => {
      el.playCalls += 1;
      if (el.playError) {
        throw el.playError;
      }
    },
  };
  return el;
}

class MockRoom implements RoomLike<MockTrack> {
  id: string;
  canPlaybackAudio = true;
  connectCalls = 0;
  disconnectCalls = 0;
  startAudioCalls = 0;
  startAudioError: unknown = null;
  listeners = new Map<string, Set<(...args: any[]) => void>>();
  remoteParticipants = new Map();
  localParticipant = {
    trackPublications: new Map<unknown, { source?: unknown; track?: MockTrack | null }>(),
  };
  private connectImpl: () => Promise<void>;

  constructor(id: string, connectImpl?: () => Promise<void>) {
    this.id = id;
    this.connectImpl = connectImpl ?? (async () => {});
  }

  on(event: string, listener: (...args: any[]) => void) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    return this;
  }

  off(event: string, listener: (...args: any[]) => void) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, ...args: any[]) {
    for (const fn of this.listeners.get(event) ?? []) {
      fn(...args);
    }
  }

  async connect(_url: string, _token: string) {
    this.connectCalls += 1;
    await this.connectImpl();
  }

  disconnect() {
    this.disconnectCalls += 1;
  }

  async startAudio() {
    this.startAudioCalls += 1;
    if (this.startAudioError) {
      throw this.startAudioError;
    }
    this.canPlaybackAudio = true;
  }

  listenerCountTotal(): number {
    let total = 0;
    for (const set of this.listeners.values()) {
      total += set.size;
    }
    return total;
  }
}

const VIEWER_EVENTS = {
  ConnectionStateChanged: "connectionStateChanged",
  TrackSubscribed: "trackSubscribed",
  TrackUnsubscribed: "trackUnsubscribed",
  Disconnected: "disconnected",
  AudioPlaybackStatusChanged: "audioPlaybackStatusChanged",
};

function createViewerStateHarness(audioEl: MockAudioEl | null = createMockAudioEl()) {
  const refs = {
    sessionRunIdRef: { current: 0 },
    roomRef: { current: null as MockRoom | null },
    activeVideoTrackRef: { current: null as MockTrack | null },
    activeAudioTrackRef: { current: null as MockTrack | null },
    registeredListenersRef: { current: [] as Array<[string, (...args: any[]) => void]> },
    isMutedRef: { current: false },
  };
  const states = {
    connecting: false,
    connectionState: "disconnected",
    error: null as string | null,
    serverConfigured: true,
    hasRemoteVideo: false,
    hasRemoteAudio: false,
    isAudioBlocked: false,
    callbackEvents: [] as string[],
  };
  const callbacks = {
    onConnectingChange: (v: boolean) => {
      states.connecting = v;
      states.callbackEvents.push(`connecting:${v}`);
    },
    onConnectionStateChange: (v: string) => {
      states.connectionState = v;
      states.callbackEvents.push(`state:${v}`);
    },
    onErrorChange: (v: string | null) => {
      states.error = v;
      states.callbackEvents.push(`error:${v}`);
    },
    onServerConfiguredChange: (v: boolean) => {
      states.serverConfigured = v;
    },
    onRemoteVideoChange: (v: boolean) => {
      states.hasRemoteVideo = v;
    },
    onRemoteAudioChange: (v: boolean) => {
      states.hasRemoteAudio = v;
    },
    onAudioBlockedChange: (v: boolean) => {
      states.isAudioBlocked = v;
    },
  };
  return { refs, states, callbacks, audioEl };
}

describe("LiveKit Phase 3: Viewer & Broadcaster Lifecycle", () => {
  it("1. Viewer unmount while getStreamToken() is pending prevents room creation, connect, and stale state updates", async () => {
    const tokenDeferred = createDeferred<{
      success: boolean;
      token: string;
      url: string;
    }>();
    const harness = createViewerStateHarness();
    let roomsCreated = 0;

    const runPromise = runViewerRoomConnection<MockTrack, MockRoom, string>({
      streamId: "stream-a",
      disabled: false,
      isMockStream: false,
      refs: harness.refs,
      getToken: () => tokenDeferred.promise,
      createRoom: () => {
        roomsCreated += 1;
        return new MockRoom(`room-${roomsCreated}`);
      },
      events: VIEWER_EVENTS,
      disconnectedState: "disconnected",
      getVideoEl: () => null,
      getAudioEl: () => harness.audioEl,
      syncMediaTracks: () => ({
        videoChanged: false,
        nextVideoTrack: null,
        audioChanged: false,
        nextAudioTrack: null,
      }),
      callbacks: harness.callbacks,
    });

    // Unmount before token arrives
    harness.refs.sessionRunIdRef.current += 1;
    teardownViewerSession({ refs: harness.refs, audioEl: harness.audioEl });
    const callbacksBeforeResolve = harness.states.callbackEvents.length;

    tokenDeferred.resolve({
      success: true,
      token: "jwt-a",
      url: "wss://live.example.com",
    });
    await runPromise;

    assert.equal(roomsCreated, 0, "must not instantiate Room after unmount");
    assert.equal(harness.refs.roomRef.current, null);
    assert.equal(
      harness.states.callbackEvents.length,
      callbacksBeforeResolve,
      "stale token response must not mutate component state after unmount",
    );
  });

  it("2. Viewer streamId change while getStreamToken() is pending ignores old token and connects only latest stream", async () => {
    const tokenA = createDeferred<{ success: boolean; token: string; url: string }>();
    const tokenB = createDeferred<{ success: boolean; token: string; url: string }>();
    const harness = createViewerStateHarness();
    const createdRooms: MockRoom[] = [];

    const startStream = (id: string, getToken: () => Promise<any>) =>
      runViewerRoomConnection<MockTrack, MockRoom, string>({
        streamId: id,
        disabled: false,
        isMockStream: false,
        refs: harness.refs,
        getToken,
        createRoom: () => {
          const r = new MockRoom(`room-${id}`);
          createdRooms.push(r);
          return r;
        },
        events: VIEWER_EVENTS,
        disconnectedState: "disconnected",
        getVideoEl: () => null,
        getAudioEl: () => harness.audioEl,
        syncMediaTracks: () => ({
          videoChanged: false,
          nextVideoTrack: null,
          audioChanged: false,
          nextAudioTrack: null,
        }),
        callbacks: harness.callbacks,
      });

    const p1 = startStream("stream-A", () => tokenA.promise);
    const p2 = startStream("stream-B", () => tokenB.promise);

    // Stream B resolves first
    tokenB.resolve({ success: true, token: "jwt-b", url: "wss://live.example.com" });
    await p2;

    // Late stream A token resolves afterwards
    tokenA.resolve({ success: true, token: "jwt-a", url: "wss://live.example.com" });
    await p1;

    assert.equal(createdRooms.length, 1);
    assert.equal(createdRooms[0]?.id, "room-stream-B");
    assert.equal(createdRooms[0]?.connectCalls, 1);
    assert.equal(harness.refs.roomRef.current?.id, "room-stream-B");
    assert.equal(harness.states.error, null);
  });

  it("3. Stale room.connect() completion disconnects obsolete room once and preserves current stream state", async () => {
    const connectADeferred = createDeferred<void>();
    const roomA = new MockRoom("room-A", () => connectADeferred.promise);
    const roomB = new MockRoom("room-B");
    const harness = createViewerStateHarness();

    const startStream = (id: string, roomInstance: MockRoom) =>
      runViewerRoomConnection<MockTrack, MockRoom, string>({
        streamId: id,
        disabled: false,
        isMockStream: false,
        refs: harness.refs,
        getToken: async () => ({
          success: true,
          token: `jwt-${id}`,
          url: "wss://live.example.com",
        }),
        createRoom: () => roomInstance,
        events: VIEWER_EVENTS,
        disconnectedState: "disconnected",
        getVideoEl: () => null,
        getAudioEl: () => harness.audioEl,
        syncMediaTracks: () => ({
          videoChanged: false,
          nextVideoTrack: null,
          audioChanged: false,
          nextAudioTrack: null,
        }),
        callbacks: harness.callbacks,
      });

    const pA = startStream("stream-A", roomA);
    // Yield microtask so stream-A enters roomA.connect()
    await Promise.resolve();
    assert.equal(roomA.connectCalls, 1);

    // Switch to stream-B before stream-A finishes connecting
    const pB = startStream("stream-B", roomB);
    await pB;
    roomB.emit(VIEWER_EVENTS.ConnectionStateChanged, "connected");

    // Late stream-A connect finally rejects/resolves
    connectADeferred.reject(new Error("late failure from stream A"));
    await pA;

    assert.equal(roomA.disconnectCalls, 1, "obsolete room must be disconnected at most once");
    assert.equal(roomA.listenerCountTotal(), 0, "obsolete room listeners must be removed");
    assert.equal(harness.refs.roomRef.current, roomB, "active roomB ref must remain intact");
    assert.equal(harness.states.connectionState, "connected");
    assert.equal(
      harness.states.error,
      null,
      "late error from stream-A must not overwrite stream-B",
    );
  });

  it("4. Viewer room disconnect and unmount detach tracks, pause/clear audio, and remove all event listeners", async () => {
    const audioEl = createMockAudioEl();
    const harness = createViewerStateHarness(audioEl);
    const room = new MockRoom("room-clean");
    const videoTrack = createMockTrack("video", "camera");
    const audioTrack = createMockTrack("audio", "microphone");
    let attached = true;

    await runViewerRoomConnection<MockTrack, MockRoom, string>({
      streamId: "stream-clean",
      disabled: false,
      isMockStream: false,
      refs: harness.refs,
      getToken: async () => ({
        success: true,
        token: "jwt-clean",
        url: "wss://live.example.com",
      }),
      createRoom: () => room,
      events: VIEWER_EVENTS,
      disconnectedState: "disconnected",
      getVideoEl: () => null,
      getAudioEl: () => audioEl,
      syncMediaTracks: () => {
        if (!attached) {
          return {
            videoChanged: true,
            nextVideoTrack: null,
            audioChanged: true,
            nextAudioTrack: null,
          };
        }
        const vChanged = harness.refs.activeVideoTrackRef.current !== videoTrack;
        const aChanged = harness.refs.activeAudioTrackRef.current !== audioTrack;
        harness.refs.activeVideoTrackRef.current = videoTrack;
        harness.refs.activeAudioTrackRef.current = audioTrack;
        if (aChanged) {
          audioTrack.attach?.(audioEl as unknown as HTMLMediaElement);
        }
        return {
          videoChanged: vChanged,
          nextVideoTrack: videoTrack,
          audioChanged: aChanged,
          nextAudioTrack: audioTrack,
        };
      },
      callbacks: harness.callbacks,
    });

    assert.ok(room.listenerCountTotal() > 0);
    assert.ok(audioEl.srcObject !== null);

    // Simulate remote Disconnected event -> should detach tracks and pause/clear audio playback
    attached = false;
    const pauseCallsBeforeDisconnect = audioEl.pauseCalls;
    room.emit(VIEWER_EVENTS.Disconnected);
    assert.equal(audioEl.pauseCalls, pauseCallsBeforeDisconnect + 1);
    assert.equal(audioEl.srcObject, null);
    assert.equal(audioTrack.detachCalls, 1);
    assert.equal(videoTrack.detachCalls, 1);
    assert.equal(harness.states.hasRemoteAudio, false);
    assert.equal(harness.states.hasRemoteVideo, false);

    // Unmount teardown -> removes all listeners and disconnects once
    harness.refs.sessionRunIdRef.current += 1;
    teardownViewerSession({ refs: harness.refs, audioEl });
    assert.equal(room.listenerCountTotal(), 0, "all listeners must be removed via off()");
    assert.equal(room.disconnectCalls, 1);
  });

  it("5. Viewer autoplay blocked error triggers single-shot blocked indicator and recovers via user-triggered startAudio", async () => {
    const autoplayError = Object.assign(
      new Error("play() failed because the user didn't interact with the document first"),
      { name: "NotAllowedError" },
    );
    const audioEl = createMockAudioEl(autoplayError);
    const harness = createViewerStateHarness(audioEl);
    const room = new MockRoom("room-autoplay");
    room.canPlaybackAudio = false;
    const audioTrack = createMockTrack("audio", "microphone");

    await runViewerRoomConnection<MockTrack, MockRoom, string>({
      streamId: "stream-audio",
      disabled: false,
      isMockStream: false,
      refs: harness.refs,
      getToken: async () => ({
        success: true,
        token: "jwt-audio",
        url: "wss://live.example.com",
      }),
      createRoom: () => room,
      events: VIEWER_EVENTS,
      disconnectedState: "disconnected",
      getVideoEl: () => null,
      getAudioEl: () => audioEl,
      syncMediaTracks: () => {
        const audioChanged = harness.refs.activeAudioTrackRef.current !== audioTrack;
        harness.refs.activeAudioTrackRef.current = audioTrack;
        if (audioChanged) {
          audioTrack.attach?.(audioEl as unknown as HTMLMediaElement);
        }
        return {
          videoChanged: false,
          nextVideoTrack: null,
          audioChanged,
          nextAudioTrack: audioTrack,
        };
      },
      callbacks: harness.callbacks,
    });

    // Wait a microtask for attemptSingleAudioPlay promise
    await Promise.resolve();
    assert.equal(audioEl.playCalls, 1, "must attempt play() once without retry loop");
    assert.equal(
      harness.states.isAudioBlocked,
      true,
      "must surface blocked state for user recovery",
    );

    // User clicks Tap for Audio -> allow play & startAudio()
    audioEl.playError = null;
    const recovery = await unlockViewerAudioPlayback({
      room,
      audioEl,
      audioTrack,
    });
    assert.equal(room.startAudioCalls, 1);
    assert.equal(audioEl.playCalls, 2);
    assert.equal(recovery.unlocked, true);
    assert.equal(recovery.blocked, false);
  });

  it("6. Broadcaster initial camera device failure falls back cleanly, degrades to audio-only when missing, and never hides permission denial", async () => {
    // 6a. Stale exact camera deviceId fails -> falls back to default camera+mic
    const attemptsA: unknown[] = [];
    const fallbackTracksA = [createMockTrack("audio"), createMockTrack("video")];
    const resA = await acquireInitialMediaTracksWithFallback({
      createTracks: async (opts) => {
        attemptsA.push(opts);
        if (attemptsA.length === 1) {
          throw Object.assign(new Error("Requested device not found"), {
            name: "OverconstrainedError",
          });
        }
        return fallbackTracksA;
      },
      primaryOptions: {
        audio: { deviceId: { exact: "old-mic" } },
        video: { deviceId: { exact: "old-cam" } },
      },
      hasSpecificCameraId: true,
      hasSpecificMicId: true,
    });
    assert.equal(resA.cancelled, false);
    assert.equal(resA.mode, "full");
    assert.equal(resA.usedCameraFallback, true);
    assert.equal(attemptsA.length, 2);

    // 6b. No camera device on system -> falls back to audio-only without crashing
    const attemptsB: unknown[] = [];
    const audioOnlyTracks = [createMockTrack("audio")];
    const resB = await acquireInitialMediaTracksWithFallback({
      createTracks: async (opts) => {
        attemptsB.push(opts);
        if (opts.video !== false) {
          throw Object.assign(new Error("Requested device not found"), { name: "NotFoundError" });
        }
        return audioOnlyTracks;
      },
      primaryOptions: {
        audio: true,
        video: { facingMode: "user" },
      },
      hasSpecificCameraId: false,
      hasSpecificMicId: false,
    });
    assert.equal(resB.mode, "audio-only");
    assert.equal(resB.tracks.length, 1);
    assert.equal(resB.tracks[0]?.kind, "audio");

    // 6c. Permission denied -> MUST throw immediately and NOT attempt fallback
    let attemptsC = 0;
    await assert.rejects(
      () =>
        acquireInitialMediaTracksWithFallback({
          createTracks: async () => {
            attemptsC += 1;
            throw Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
          },
          primaryOptions: { audio: true, video: { facingMode: "user" } },
          hasSpecificCameraId: true,
          hasSpecificMicId: false,
        }),
      /permissions were denied/i,
    );
    assert.equal(attemptsC, 1, "permission denial must not retry/fallback");

    // 6d. Cancelled during createTracks -> stops acquired tracks immediately
    const orphanTrack = createMockTrack("video");
    let cancelled = false;
    const resD = await acquireInitialMediaTracksWithFallback({
      createTracks: async () => {
        cancelled = true;
        return [orphanTrack];
      },
      primaryOptions: { audio: true, video: true },
      hasSpecificCameraId: false,
      hasSpecificMicId: false,
      isCancelled: () => cancelled,
    });
    assert.equal(resD.cancelled, true);
    assert.equal(
      orphanTrack.stopCalls,
      1,
      "tracks resolved after cancel must be stopped immediately",
    );
  });

  it("7. Broadcaster teardown stops localTracks + room-published tracks, removes listeners, and is idempotent", () => {
    const room = new MockRoom("broadcaster-room");
    const dummyListener = () => {};
    room.on("disconnected", dummyListener);
    const registeredListenersRef = {
      current: [["disconnected", dummyListener]] as Array<[string, (...args: any[]) => void]>,
    };

    const initialAudio = createMockTrack("audio", "microphone");
    const initialVideo = createMockTrack("video", "camera");
    // Simulate a dynamically re-acquired camera track stored on localParticipant publications
    const reacquiredCamera = createMockTrack("video", "camera");
    room.localParticipant.trackPublications.set("camera", {
      source: "camera",
      track: reacquiredCamera,
    });

    const roomRef = { current: room as RoomLike<MockTrack> | null };
    const localTracksRef = { current: [initialAudio, initialVideo] };
    let screenStopCalls = 0;

    teardownBroadcasterSessionIdempotently({
      roomRef,
      localTracksRef,
      registeredListenersRef,
      stopScreenShareTrack: () => {
        screenStopCalls += 1;
      },
    });

    assert.equal(initialAudio.stopCalls, 1);
    assert.equal(initialVideo.stopCalls, 1);
    assert.equal(reacquiredCamera.stopCalls, 1, "room-published tracks must also be stopped");
    assert.equal(room.listenerCountTotal(), 0, "room listeners must be removed");
    assert.equal(room.disconnectCalls, 1);
    assert.equal(roomRef.current, null);
    assert.equal(localTracksRef.current.length, 0);

    // Calling teardown a second time (e.g., onClose + unmount) is safe & does not double-disconnect
    teardownBroadcasterSessionIdempotently({
      roomRef,
      localTracksRef,
      registeredListenersRef,
      stopScreenShareTrack: () => {
        screenStopCalls += 1;
      },
    });
    assert.equal(room.disconnectCalls, 1, "subsequent teardown must not double-disconnect room");
    assert.equal(screenStopCalls, 2);
  });

  it("8. Broadcaster confirmation avoids window.confirm and guards against duplicate endStream requests", async () => {
    const studioSource = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/live/LiveKitBroadcasterStudio.tsx"),
      "utf-8",
    );
    assert.doesNotMatch(
      studioSource,
      /\bwindow\.confirm\s*\(/,
      "Studio must use in-studio confirmation UI instead of window.confirm",
    );
    assert.match(studioSource, /showEndConfirm/);
    assert.match(studioSource, /End Live Broadcast\?/);

    const endApiDeferred = createDeferred<void>();
    let endApiCalls = 0;
    let cleanupCalls = 0;
    let successCalls = 0;
    const isEndingRef = { current: false };
    const hasEndedRef = { current: false };

    const first = executeEndBroadcastOnce({
      isEndingRef,
      hasEndedRef,
      onEndApi: async () => {
        endApiCalls += 1;
        await endApiDeferred.promise;
      },
      onCleanup: () => {
        cleanupCalls += 1;
      },
      onSuccess: () => {
        successCalls += 1;
      },
    });

    // Rapid second click while first endStream API call is still in-flight
    const duplicate = await executeEndBroadcastOnce({
      isEndingRef,
      hasEndedRef,
      onEndApi: async () => {
        endApiCalls += 1;
      },
      onCleanup: () => {
        cleanupCalls += 1;
      },
    });
    assert.equal(duplicate, "duplicate-ignored");
    assert.equal(endApiCalls, 1, "concurrent endStream calls must be blocked synchronously");

    endApiDeferred.resolve();
    const firstResult = await first;
    assert.equal(firstResult, "started-and-ended");
    assert.equal(cleanupCalls, 1);
    assert.equal(successCalls, 1);

    // Third call after broadcast already ended
    const afterEnd = await executeEndBroadcastOnce({
      isEndingRef,
      hasEndedRef,
      onEndApi: async () => {
        endApiCalls += 1;
      },
      onCleanup: () => {
        cleanupCalls += 1;
      },
    });
    assert.equal(afterEnd, "duplicate-ignored");
    assert.equal(endApiCalls, 1);
  });

  it("9. Preserves existing Broadcaster & Viewer static camera-switch and screen-share lifecycle invariants", () => {
    const studioSource = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/live/LiveKitBroadcasterStudio.tsx"),
      "utf-8",
    );
    const viewerSource = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/live/LiveKitViewerPlayer.tsx"),
      "utf-8",
    );

    // startBroadcasting must NOT depend on facingMode, selectedCameraId, or selectedMicId
    const startCbMatch = studioSource.match(
      /const startBroadcasting = useCallback\([\s\S]*?\n\s*\}, \[([^\]]*)\]\);/,
    );
    assert.ok(startCbMatch, "startBroadcasting useCallback dependency list must exist");
    const startDeps = startCbMatch[1] ?? "";
    assert.doesNotMatch(startDeps, /\bfacingMode\b/);
    assert.doesNotMatch(startDeps, /\bselectedCameraId\b/);
    assert.doesNotMatch(startDeps, /\bselectedMicId\b/);

    // Camera constraint pattern, cancellation guards, and screen share anchors
    assert.match(
      studioSource,
      /activeCameraId\s*\?\s*\{\s*deviceId:\s*\{\s*exact:\s*activeCameraId\s*\}\s*\}\s*:\s*\{\s*facingMode:\s*facingModeRef\.current\s*\}/,
    );
    assert.match(studioSource, /sessionRunIdRef\.current\s*!==\s*runId/);
    assert.match(studioSource, /isSwitchingCameraRef\.current/);
    assert.match(studioSource, /switchCameraWithFallback\(/);
    assert.match(studioSource, /switchVideoDeviceSafely\(/);
    assert.match(studioSource, /disabled=\{isSwitchingCamera \|\| isInitializing\}/);
    assert.match(studioSource, /toggleScreenShare/);
    assert.match(studioSource, /Share Screen/);
    assert.match(studioSource, /Stop Share/);
    assert.match(studioSource, /Sharing Screen/);
    assert.match(studioSource, /detectScreenShareSupport\(/);
    assert.match(studioSource, /startScreenShareSafely(?:<[^>]+>)?\(/);
    assert.match(studioSource, /stopScreenShareSafely(?:<[^>]+>)?\(/);
    assert.match(studioSource, /stopActiveScreenShareTrack\(/);
    assert.match(studioSource, /restoreCameraAfterScreenShare/);
    assert.match(studioSource, /RoomEvent\.LocalTrackUnpublished/);
    assert.match(studioSource, /Track\.Source\.ScreenShare/);
    assert.match(studioSource, /!isScreenSharing && facingMode === "user"/);

    // Viewer media sync & autoplay recovery anchors
    assert.match(viewerSource, /Track\.Source\.ScreenShare/);
    assert.match(viewerSource, /Track\.Source\.Camera/);
    assert.match(viewerSource, /syncRemoteMediaTracks/);
    assert.match(viewerSource, /Track\.Source\.Microphone/);
    assert.match(viewerSource, /RoomEvent\.AudioPlaybackStatusChanged/);
    assert.match(viewerSource, /Tap for Audio/);
  });
});
