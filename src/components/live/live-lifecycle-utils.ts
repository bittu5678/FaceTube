export interface MediaTrackLike {
  kind?: string;
  source?: string;
  isMuted?: boolean;
  mediaStreamTrack?: {
    readyState?: string;
    label?: string;
    getSettings?: () => { deviceId?: string; facingMode?: string };
  };
  attach?: (element?: HTMLMediaElement) => unknown;
  detach?: (element?: HTMLMediaElement) => unknown;
  stop?: () => void;
  mute?: () => void;
  unmute?: () => void;
}

export interface PublicationLike<TTrack extends MediaTrackLike = MediaTrackLike> {
  source?: unknown;
  isSubscribed?: boolean;
  track?: TTrack | null;
}

export interface ParticipantLike<TTrack extends MediaTrackLike = MediaTrackLike> {
  trackPublications?: Map<unknown, PublicationLike<TTrack>> | Iterable<PublicationLike<TTrack>>;
}

export interface AudioElementLike {
  muted: boolean;
  srcObject?: unknown;
  pause: () => void;
  play: () => Promise<void> | void;
}

export interface RoomLike<TTrack extends MediaTrackLike = MediaTrackLike> {
  state?: unknown;
  canPlaybackAudio?: boolean;
  remoteParticipants?: Map<unknown, ParticipantLike<any>>;
  localParticipant?: {
    trackPublications?: Map<unknown, PublicationLike<any>>;
    publishTrack?: (track: any) => Promise<unknown>;
    setCameraEnabled?: (enabled: boolean) => Promise<unknown>;
    setMicrophoneEnabled?: (enabled: boolean) => Promise<unknown>;
    getTrackPublication?: (source: any) => PublicationLike<any> | undefined;
  };
  on: (event: any, listener: (...args: any[]) => void) => unknown;
  off?: (event: any, listener: (...args: any[]) => void) => unknown;
  removeListener?: (event: any, listener: (...args: any[]) => void) => unknown;
  connect: (url: string, token: string) => Promise<void>;
  disconnect: () => Promise<void> | void;
  startAudio?: () => Promise<void>;
}

export function stopAndDetachTrackSafely(
  track: MediaTrackLike | null | undefined,
  element?: HTMLMediaElement | AudioElementLike | null,
): void {
  if (!track) return;
  try {
    if (element) {
      track.detach?.(element as HTMLMediaElement);
    } else {
      track.detach?.();
    }
  } catch {
    // Ignore track detach cleanup errors
  }
  try {
    track.stop?.();
  } catch {
    // Ignore track stop cleanup errors
  }
}

export function clearAudioElementPlayback(audioEl: AudioElementLike | null | undefined): void {
  if (!audioEl) return;
  try {
    audioEl.pause();
  } catch {
    // Ignore pause errors in non-DOM/mock environments
  }
  try {
    audioEl.srcObject = null;
  } catch {
    // Ignore srcObject reset errors
  }
}

export function removeRoomListeners(
  room: Pick<RoomLike, "off" | "removeListener"> | null | undefined,
  listeners: Array<[string, (...args: any[]) => void]>,
): void {
  if (!room || listeners.length === 0) return;
  for (const [event, handler] of listeners) {
    try {
      if (typeof room.off === "function") {
        room.off(event, handler);
      } else if (typeof room.removeListener === "function") {
        room.removeListener(event, handler);
      }
    } catch {
      // Ignore listener teardown errors
    }
  }
}

export function collectParticipantTracks<TTrack extends MediaTrackLike>(
  participant: ParticipantLike<TTrack> | null | undefined,
): TTrack[] {
  if (!participant?.trackPublications) return [];
  const tracks: TTrack[] = [];
  const entries =
    participant.trackPublications instanceof Map
      ? participant.trackPublications.values()
      : participant.trackPublications;
  for (const pub of entries) {
    if (pub?.track) {
      tracks.push(pub.track);
    }
  }
  return tracks;
}

export function isAutoplayBlockedError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return typeof err === "string" && /notallowederror|autoplay|user gesture/i.test(err);
  }
  const name = "name" in err ? String((err as { name?: unknown }).name || "") : "";
  const msg = "message" in err ? String((err as { message?: unknown }).message || "") : "";
  return (
    name === "NotAllowedError" || /notallowederror|didn't interact|user gesture|autoplay/i.test(msg)
  );
}

export async function attemptSingleAudioPlay(
  audioEl: AudioElementLike | null | undefined,
  options: { isMuted: boolean },
): Promise<{ played: boolean; blocked: boolean }> {
  if (!audioEl) {
    return { played: false, blocked: false };
  }
  audioEl.muted = options.isMuted;
  if (options.isMuted) {
    return { played: false, blocked: false };
  }
  try {
    await audioEl.play();
    return { played: true, blocked: false };
  } catch (err) {
    if (isAutoplayBlockedError(err)) {
      return { played: false, blocked: true };
    }
    return { played: false, blocked: false };
  }
}

export async function unlockViewerAudioPlayback(params: {
  room: RoomLike | null | undefined;
  audioEl: AudioElementLike | null | undefined;
  audioTrack?: MediaTrackLike | null | undefined;
}): Promise<{ unlocked: boolean; blocked: boolean }> {
  const { room, audioEl, audioTrack } = params;

  if (audioEl) {
    audioEl.muted = false;
    if (audioTrack && !audioEl.srcObject) {
      try {
        audioTrack.attach?.(audioEl as unknown as HTMLMediaElement);
      } catch {
        // Ignore re-attach error
      }
    }
  }

  let startAudioBlocked = false;
  if (room && typeof room.startAudio === "function") {
    try {
      await room.startAudio();
    } catch (err) {
      if (isAutoplayBlockedError(err)) {
        startAudioBlocked = true;
      }
    }
    if (room.canPlaybackAudio === false) {
      startAudioBlocked = true;
    }
  }

  if (audioEl) {
    const playRes = await attemptSingleAudioPlay(audioEl, { isMuted: false });
    if (playRes.blocked) {
      return { unlocked: false, blocked: true };
    }
  }

  return {
    unlocked: !startAudioBlocked,
    blocked: startAudioBlocked,
  };
}

export interface MediaErrorClassification {
  name: string;
  isPermissionDenied: boolean;
  isNotFound: boolean;
  isOverconstrained: boolean;
  isBusy: boolean;
  userMessage: string;
}

export function classifyInitialMediaError(err: unknown): MediaErrorClassification {
  const name =
    typeof err === "object" && err !== null && "name" in err
      ? String((err as { name?: unknown }).name || "")
      : "";
  const rawMessage =
    err instanceof Error
      ? err.message
      : typeof err === "object" && err !== null && "message" in err
        ? String((err as { message?: unknown }).message || "")
        : String(err || "");

  const isPermissionDenied =
    name === "NotAllowedError" ||
    name === "PermissionDeniedError" ||
    /permission.*denied|notallowederror/i.test(rawMessage);
  const isNotFound = name === "NotFoundError" || name === "DevicesNotFoundError";
  const isOverconstrained =
    name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError";
  const isBusy = name === "NotReadableError" || name === "TrackStartError" || name === "AbortError";

  let userMessage = rawMessage || "Failed to access camera and microphone.";
  if (isPermissionDenied) {
    userMessage =
      "Camera & microphone permissions were denied. Please allow access in browser settings.";
  } else if (isNotFound) {
    userMessage = "No camera or microphone device was found on this system.";
  } else if (isOverconstrained) {
    userMessage = "The selected camera or microphone constraints are not supported on this device.";
  } else if (isBusy) {
    userMessage = "Your camera or microphone is already in use by another application.";
  }

  return {
    name,
    isPermissionDenied,
    isNotFound,
    isOverconstrained,
    isBusy,
    userMessage,
  };
}

export interface InitialTrackAttemptOptions {
  audio: boolean | Record<string, unknown>;
  video: boolean | Record<string, unknown>;
}

export interface AcquireInitialTracksParams<TTrack extends MediaTrackLike> {
  createTracks: (options: InitialTrackAttemptOptions) => Promise<TTrack[]>;
  primaryOptions: InitialTrackAttemptOptions;
  hasSpecificCameraId: boolean;
  hasSpecificMicId: boolean;
  resolution?: unknown;
  isCancelled?: () => boolean;
}

export interface AcquireInitialTracksResult<TTrack extends MediaTrackLike> {
  cancelled: boolean;
  tracks: TTrack[];
  mode: "full" | "audio-only";
  usedCameraFallback: boolean;
  usedMicFallback: boolean;
  notice?: string;
}

function stopTrackList(tracks: MediaTrackLike[]): void {
  for (const track of tracks) {
    stopAndDetachTrackSafely(track);
  }
}

export async function acquireInitialMediaTracksWithFallback<TTrack extends MediaTrackLike>({
  createTracks,
  primaryOptions,
  hasSpecificCameraId,
  hasSpecificMicId,
  resolution,
  isCancelled,
}: AcquireInitialTracksParams<TTrack>): Promise<AcquireInitialTracksResult<TTrack>> {
  const cancelledResult: AcquireInitialTracksResult<TTrack> = {
    cancelled: true,
    tracks: [],
    mode: "full",
    usedCameraFallback: false,
    usedMicFallback: false,
  };

  if (isCancelled?.()) return cancelledResult;

  const videoResolution = resolution ? { resolution } : {};

  // 1. Primary attempt with the exact user/default preferences
  let primaryError: unknown = null;
  try {
    const tracks = await createTracks(primaryOptions);
    if (isCancelled?.()) {
      stopTrackList(tracks);
      return cancelledResult;
    }
    return {
      cancelled: false,
      tracks,
      mode: "full",
      usedCameraFallback: false,
      usedMicFallback: false,
    };
  } catch (err) {
    primaryError = err;
  }

  if (isCancelled?.()) return cancelledResult;

  const primaryClass = classifyInitialMediaError(primaryError);
  if (primaryClass.isPermissionDenied) {
    throw new Error(primaryClass.userMessage);
  }

  // 2. Fallback A: retry without pinned exact deviceId / facingMode constraints
  if (
    hasSpecificCameraId ||
    hasSpecificMicId ||
    primaryClass.isOverconstrained ||
    primaryClass.isNotFound
  ) {
    try {
      const genericVideo: Record<string, unknown> = { ...videoResolution };
      const tracks = await createTracks({
        audio: true,
        video: Object.keys(genericVideo).length > 0 ? genericVideo : true,
      });
      if (isCancelled?.()) {
        stopTrackList(tracks);
        return cancelledResult;
      }
      return {
        cancelled: false,
        tracks,
        mode: "full",
        usedCameraFallback:
          hasSpecificCameraId || primaryClass.isOverconstrained || primaryClass.isNotFound,
        usedMicFallback: hasSpecificMicId,
        notice: hasSpecificCameraId
          ? "Selected camera was unavailable. Switched to your default camera."
          : hasSpecificMicId
            ? "Selected microphone was unavailable. Switched to your default microphone."
            : "Camera constraints adjusted to default device settings.",
      };
    } catch (fallbackErr) {
      if (isCancelled?.()) return cancelledResult;
      const fallbackClass = classifyInitialMediaError(fallbackErr);
      if (fallbackClass.isPermissionDenied) {
        throw new Error(fallbackClass.userMessage);
      }
      primaryError = fallbackErr;
    }
  }

  // 3. Fallback B: camera unavailable/missing/busy -> try audio-only so studio does not crash
  const latestClass = classifyInitialMediaError(primaryError);
  if (latestClass.isNotFound || latestClass.isOverconstrained || latestClass.isBusy) {
    const audioCandidates: Array<{
      options: InitialTrackAttemptOptions;
      usedMicFallback: boolean;
    }> = [];
    if (hasSpecificMicId && typeof primaryOptions.audio === "object") {
      audioCandidates.push({
        options: { audio: primaryOptions.audio, video: false },
        usedMicFallback: false,
      });
    }
    audioCandidates.push({
      options: { audio: true, video: false },
      usedMicFallback: hasSpecificMicId,
    });

    for (const candidate of audioCandidates) {
      if (isCancelled?.()) return cancelledResult;
      try {
        const audioTracks = await createTracks(candidate.options);
        if (isCancelled?.()) {
          stopTrackList(audioTracks);
          return cancelledResult;
        }
        return {
          cancelled: false,
          tracks: audioTracks,
          mode: "audio-only",
          usedCameraFallback: true,
          usedMicFallback: candidate.usedMicFallback,
          notice: latestClass.isBusy
            ? "Camera is busy in another app. Continuing in audio-only mode."
            : "No usable camera detected. Continuing broadcast in audio-only mode.",
        };
      } catch (audioErr) {
        if (isCancelled?.()) return cancelledResult;
        const audioClass = classifyInitialMediaError(audioErr);
        if (audioClass.isPermissionDenied) {
          throw new Error(audioClass.userMessage);
        }
        primaryError = audioErr;
      }
    }
  }

  throw new Error(classifyInitialMediaError(primaryError).userMessage);
}

export interface EndBroadcastExecutionParams {
  isEndingRef: { current: boolean };
  hasEndedRef?: { current: boolean };
  onEndApi: () => Promise<unknown>;
  onCleanup: () => void;
  onSuccess?: () => void;
  onError?: (err: unknown) => void;
}

export async function executeEndBroadcastOnce({
  isEndingRef,
  hasEndedRef,
  onEndApi,
  onCleanup,
  onSuccess,
  onError,
}: EndBroadcastExecutionParams): Promise<"started-and-ended" | "duplicate-ignored" | "failed"> {
  if (isEndingRef.current || hasEndedRef?.current) {
    return "duplicate-ignored";
  }

  isEndingRef.current = true;
  try {
    await onEndApi();
    if (hasEndedRef) {
      hasEndedRef.current = true;
    }
    onCleanup();
    onSuccess?.();
    return "started-and-ended";
  } catch (err) {
    onError?.(err);
    return "failed";
  } finally {
    isEndingRef.current = false;
  }
}

export interface BroadcasterTeardownParams<TTrack extends MediaTrackLike> {
  roomRef: { current: RoomLike<TTrack> | null };
  localTracksRef: { current: TTrack[] };
  registeredListenersRef: { current: Array<[string, (...args: any[]) => void]> };
  stopScreenShareTrack?: () => void;
  stopPublishedScreenShare?: (
    participant: NonNullable<RoomLike<TTrack>["localParticipant"]>,
  ) => void;
  localVideoEl?: HTMLMediaElement | null;
}

export function teardownBroadcasterSessionIdempotently<TTrack extends MediaTrackLike>({
  roomRef,
  localTracksRef,
  registeredListenersRef,
  stopScreenShareTrack,
  stopPublishedScreenShare,
  localVideoEl,
}: BroadcasterTeardownParams<TTrack>): void {
  stopScreenShareTrack?.();

  const room = roomRef.current;
  roomRef.current = null;

  const seenTracks = new Set<MediaTrackLike>();
  for (const track of localTracksRef.current) {
    seenTracks.add(track);
    stopAndDetachTrackSafely(track, localVideoEl);
  }
  localTracksRef.current = [];

  if (room) {
    if (room.localParticipant) {
      try {
        stopPublishedScreenShare?.(room.localParticipant);
      } catch {
        // Ignore screen share teardown error
      }
      for (const pubTrack of collectParticipantTracks(room.localParticipant)) {
        if (!seenTracks.has(pubTrack)) {
          seenTracks.add(pubTrack);
          stopAndDetachTrackSafely(pubTrack, localVideoEl);
        }
      }
    }

    const listeners = registeredListenersRef.current.splice(0);
    removeRoomListeners(room, listeners);

    try {
      void room.disconnect();
    } catch {
      // Ignore disconnect error
    }
  } else {
    registeredListenersRef.current = [];
  }

  if (localVideoEl) {
    try {
      localVideoEl.srcObject = null;
    } catch {
      // Ignore video srcObject cleanup error
    }
  }
}

export interface ViewerSessionRefs<TTrack extends MediaTrackLike, TRoom extends RoomLike<TTrack>> {
  sessionRunIdRef: { current: number };
  roomRef: { current: TRoom | null };
  activeVideoTrackRef: { current: TTrack | null };
  activeAudioTrackRef: { current: TTrack | null };
  registeredListenersRef: { current: Array<[string, (...args: any[]) => void]> };
  isMutedRef?: { current: boolean };
}

export interface ViewerTeardownOptions<
  TTrack extends MediaTrackLike,
  TRoom extends RoomLike<TTrack>,
> {
  refs: ViewerSessionRefs<TTrack, TRoom>;
  videoEl?: HTMLMediaElement | null;
  audioEl?: AudioElementLike | null;
}

const tornDownRooms = new WeakSet<object>();

export function detachTrackSafely(
  track: MediaTrackLike | null | undefined,
  element?: HTMLMediaElement | AudioElementLike | null,
): void {
  if (!track) return;
  try {
    if (element) {
      track.detach?.(element as HTMLMediaElement);
    } else {
      track.detach?.();
    }
  } catch {
    // Ignore track detach cleanup errors
  }
}

export function teardownViewerSession<
  TTrack extends MediaTrackLike,
  TRoom extends RoomLike<TTrack>,
>({ refs, videoEl, audioEl }: ViewerTeardownOptions<TTrack, TRoom>): void {
  const { roomRef, activeVideoTrackRef, activeAudioTrackRef, registeredListenersRef } = refs;

  if (activeVideoTrackRef.current) {
    detachTrackSafely(activeVideoTrackRef.current, videoEl);
    activeVideoTrackRef.current = null;
  }
  if (activeAudioTrackRef.current) {
    detachTrackSafely(activeAudioTrackRef.current, audioEl);
    activeAudioTrackRef.current = null;
  }

  clearAudioElementPlayback(audioEl);
  if (videoEl) {
    try {
      videoEl.srcObject = null;
    } catch {
      // Ignore video srcObject cleanup error
    }
  }

  const room = roomRef.current;
  roomRef.current = null;
  const listeners = registeredListenersRef.current.splice(0);
  if (room) {
    removeRoomListeners(room, listeners);
    if (!tornDownRooms.has(room)) {
      tornDownRooms.add(room);
      try {
        void room.disconnect();
      } catch {
        // Ignore disconnect error
      }
    }
  }
}

export interface RunViewerConnectionParams<
  TTrack extends MediaTrackLike,
  TRoom extends RoomLike<TTrack>,
  TConnectionState = unknown,
> {
  streamId: string;
  disabled: boolean;
  isMockStream: boolean;
  refs: ViewerSessionRefs<TTrack, TRoom>;
  getToken: (streamId: string) => Promise<{
    success?: boolean;
    token?: string;
    url?: string;
    server_configured?: boolean;
  }>;
  createRoom: () => TRoom;
  events: {
    ConnectionStateChanged: string;
    TrackSubscribed: string;
    TrackUnsubscribed: string;
    Disconnected: string;
    AudioPlaybackStatusChanged: string;
  };
  disconnectedState: TConnectionState;
  getVideoEl: () => HTMLMediaElement | null;
  getAudioEl: () => AudioElementLike | null;
  syncMediaTracks: (room: TRoom) => {
    videoChanged: boolean;
    nextVideoTrack: TTrack | null;
    audioChanged: boolean;
    nextAudioTrack: TTrack | null;
  };
  callbacks: {
    onConnectingChange: (connecting: boolean) => void;
    onConnectionStateChange: (state: TConnectionState) => void;
    onErrorChange: (message: string | null) => void;
    onServerConfiguredChange: (configured: boolean) => void;
    onRemoteVideoChange: (hasVideo: boolean) => void;
    onRemoteAudioChange: (hasAudio: boolean) => void;
    onAudioBlockedChange: (blocked: boolean) => void;
  };
}

export async function runViewerRoomConnection<
  TTrack extends MediaTrackLike,
  TRoom extends RoomLike<TTrack>,
  TConnectionState = unknown,
>(params: RunViewerConnectionParams<TTrack, TRoom, TConnectionState>): Promise<void> {
  const {
    streamId,
    disabled,
    isMockStream,
    refs,
    getToken,
    createRoom,
    events,
    disconnectedState,
    getVideoEl,
    getAudioEl,
    syncMediaTracks,
    callbacks,
  } = params;

  const runId = ++refs.sessionRunIdRef.current;
  const isStale = () => refs.sessionRunIdRef.current !== runId;

  teardownViewerSession({
    refs,
    videoEl: getVideoEl(),
    audioEl: getAudioEl(),
  });
  callbacks.onRemoteVideoChange(false);
  callbacks.onRemoteAudioChange(false);
  callbacks.onAudioBlockedChange(false);

  if (disabled || !streamId || isMockStream) {
    callbacks.onConnectingChange(false);
    callbacks.onErrorChange(null);
    callbacks.onConnectionStateChange(disconnectedState);
    return;
  }

  callbacks.onConnectingChange(true);
  callbacks.onErrorChange(null);

  let localRoom: TRoom | null = null;
  const localListeners: Array<[string, (...args: any[]) => void]> = [];

  const cleanupStaleRoom = (roomToCleanup: TRoom | null) => {
    if (!roomToCleanup) return;
    removeRoomListeners(roomToCleanup, localListeners.splice(0));
    if (refs.roomRef.current === roomToCleanup) {
      refs.roomRef.current = null;
    }
    if (!tornDownRooms.has(roomToCleanup)) {
      tornDownRooms.add(roomToCleanup);
      try {
        void roomToCleanup.disconnect();
      } catch {
        // Ignore stale disconnect errors
      }
    }
  };

  try {
    const tokenRes = await getToken(streamId);
    if (isStale()) return;

    if (!tokenRes.success || !tokenRes.token || !tokenRes.url) {
      throw new Error("Failed to acquire live stream access token from server.");
    }

    callbacks.onServerConfiguredChange(tokenRes.server_configured !== false);

    localRoom = createRoom();
    if (isStale()) {
      cleanupStaleRoom(localRoom);
      return;
    }
    tornDownRooms.delete(localRoom);
    refs.roomRef.current = localRoom;

    const applyTrackSync = () => {
      if (isStale() || !localRoom) return;
      const { nextVideoTrack, audioChanged, nextAudioTrack } = syncMediaTracks(localRoom);
      callbacks.onRemoteVideoChange(Boolean(nextVideoTrack));
      callbacks.onRemoteAudioChange(Boolean(nextAudioTrack));

      if (!nextAudioTrack) {
        clearAudioElementPlayback(getAudioEl());
        callbacks.onAudioBlockedChange(false);
        return;
      }

      if (audioChanged) {
        const audioEl = getAudioEl();
        const isMuted = Boolean(refs.isMutedRef?.current);
        void attemptSingleAudioPlay(audioEl, { isMuted }).then((res) => {
          if (isStale()) return;
          if (res.blocked || (localRoom?.canPlaybackAudio === false && !isMuted)) {
            callbacks.onAudioBlockedChange(true);
          } else if (res.played) {
            callbacks.onAudioBlockedChange(false);
          }
        });
      }
    };

    const register = (event: string, handler: (...args: any[]) => void) => {
      localListeners.push([event, handler]);
      refs.registeredListenersRef.current.push([event, handler]);
      localRoom!.on(event, handler);
    };

    register(events.ConnectionStateChanged, (state: TConnectionState) => {
      if (isStale()) return;
      callbacks.onConnectionStateChange(state);
    });

    register(events.TrackSubscribed, () => {
      if (isStale()) return;
      applyTrackSync();
    });

    register(events.TrackUnsubscribed, (track: TTrack) => {
      if (isStale()) return;
      if (refs.activeVideoTrackRef.current === track) {
        try {
          const videoEl = getVideoEl();
          if (videoEl) track.detach?.(videoEl);
          else track.detach?.();
        } catch {
          // Ignore detach error
        }
        refs.activeVideoTrackRef.current = null;
      }
      if (refs.activeAudioTrackRef.current === track) {
        const audioEl = getAudioEl();
        try {
          if (audioEl) track.detach?.(audioEl as unknown as HTMLMediaElement);
          else track.detach?.();
        } catch {
          // Ignore detach error
        }
        clearAudioElementPlayback(audioEl);
        refs.activeAudioTrackRef.current = null;
      }
      applyTrackSync();
    });

    register(events.AudioPlaybackStatusChanged, (canPlayback?: boolean) => {
      if (isStale() || !localRoom) return;
      const playbackAllowed =
        typeof canPlayback === "boolean" ? canPlayback : localRoom.canPlaybackAudio !== false;
      const hasAudio = Boolean(refs.activeAudioTrackRef.current);
      const isMuted = Boolean(refs.isMutedRef?.current);
      if (!playbackAllowed && hasAudio && !isMuted) {
        callbacks.onAudioBlockedChange(true);
      } else if (playbackAllowed) {
        callbacks.onAudioBlockedChange(false);
      }
    });

    register(events.Disconnected, () => {
      if (isStale()) return;
      if (refs.activeVideoTrackRef.current) {
        try {
          const videoEl = getVideoEl();
          if (videoEl) refs.activeVideoTrackRef.current.detach?.(videoEl);
          else refs.activeVideoTrackRef.current.detach?.();
        } catch {
          // Ignore
        }
        refs.activeVideoTrackRef.current = null;
      }
      if (refs.activeAudioTrackRef.current) {
        const audioEl = getAudioEl();
        try {
          if (audioEl)
            refs.activeAudioTrackRef.current.detach?.(audioEl as unknown as HTMLMediaElement);
          else refs.activeAudioTrackRef.current.detach?.();
        } catch {
          // Ignore
        }
        refs.activeAudioTrackRef.current = null;
      }
      clearAudioElementPlayback(getAudioEl());
      callbacks.onConnectionStateChange(disconnectedState);
      callbacks.onRemoteVideoChange(false);
      callbacks.onRemoteAudioChange(false);
      callbacks.onAudioBlockedChange(false);
    });

    await localRoom.connect(tokenRes.url, tokenRes.token);

    if (isStale()) {
      cleanupStaleRoom(localRoom);
      return;
    }

    applyTrackSync();
    if (
      localRoom.canPlaybackAudio === false &&
      refs.activeAudioTrackRef.current &&
      !refs.isMutedRef?.current
    ) {
      callbacks.onAudioBlockedChange(true);
    }
  } catch (err: unknown) {
    cleanupStaleRoom(localRoom);
    if (isStale()) return;
    const msg = err instanceof Error ? err.message : String(err);
    callbacks.onErrorChange(msg);
    callbacks.onConnectionStateChange(disconnectedState);
    callbacks.onRemoteVideoChange(false);
    callbacks.onRemoteAudioChange(false);
    callbacks.onAudioBlockedChange(false);
  } finally {
    if (!isStale()) {
      callbacks.onConnectingChange(false);
    }
  }
}
