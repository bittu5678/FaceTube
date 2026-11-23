import { useEffect, useRef, useState, useCallback } from "react";
import {
  Room,
  RoomEvent,
  Track,
  TrackEvent,
  VideoPresets,
  createLocalTracks,
  type LocalTrack,
  type LocalVideoTrack,
  type LocalAudioTrack,
  ConnectionState,
} from "livekit-client";
import {
  Mic,
  MicOff,
  Video as VideoIcon,
  VideoOff,
  SwitchCamera,
  ScreenShare,
  ScreenShareOff,
  X,
  Radio,
  Users,
  AlertTriangle,
  StopCircle,
  Settings,
  Clock,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import {
  detectScreenShareSupport,
  inferFacingModeFromCamera,
  startScreenShareSafely,
  stopScreenShareSafely,
  switchCameraWithFallback,
  switchVideoDeviceSafely,
  type CameraFacingMode,
  type ScreenShareTrackLike,
} from "./live-camera-utils";
import {
  acquireInitialMediaTracksWithFallback,
  executeEndBroadcastOnce,
  teardownBroadcasterSessionIdempotently,
  type RoomLike,
} from "./live-lifecycle-utils";

export interface LiveKitBroadcasterStudioProps {
  streamId: string;
  streamTitle: string;
  isOpen: boolean;
  onClose: () => void;
  onStreamEnded: () => void;
}

export function LiveKitBroadcasterStudio({
  streamId,
  streamTitle,
  isOpen,
  onClose,
  onStreamEnded,
}: LiveKitBroadcasterStudioProps) {
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const roomRef = useRef<Room | null>(null);
  const localTracksRef = useRef<LocalTrack[]>([]);
  const registeredRoomListenersRef = useRef<Array<[string, (...args: any[]) => void]>>([]);
  const sessionRunIdRef = useRef(0);
  const isSwitchingCameraRef = useRef(false);
  const isTogglingScreenShareRef = useRef(false);
  const isScreenSharingRef = useRef(false);
  const screenShareTrackRef = useRef<ScreenShareTrackLike | null>(null);
  const screenShareCleanupListenerRef = useRef<(() => void) | null>(null);
  const wasCameraEnabledBeforeScreenShareRef = useRef<boolean | null>(null);
  const handleBrowserScreenShareEndedRef = useRef<() => Promise<void> | void>(() => {});
  const isEndingStreamRef = useRef(false);
  const hasEndedStreamRef = useRef(false);

  const [connectionState, setConnectionState] = useState<ConnectionState>(
    ConnectionState.Disconnected,
  );
  const [isInitializing, setIsInitializing] = useState(false);
  const [isSwitchingCamera, setIsSwitchingCamera] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isTogglingScreenShare, setIsTogglingScreenShare] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [audioOnlyMode, setAudioOnlyMode] = useState(false);

  // Audio / Video control states
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const cameraEnabledRef = useRef(true);
  const [facingMode, setFacingMode] = useState<CameraFacingMode>("user");
  const facingModeRef = useRef<CameraFacingMode>("user");
  const [availableCameras, setAvailableCameras] = useState<MediaDeviceInfo[]>([]);
  const [availableMics, setAvailableMics] = useState<MediaDeviceInfo[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string>("");
  const selectedCameraIdRef = useRef<string>("");
  const [selectedMicId, setSelectedMicId] = useState<string>("");
  const selectedMicIdRef = useRef<string>("");
  const [showSettings, setShowSettings] = useState(false);
  const [showEndConfirm, setShowEndConfirm] = useState(false);

  // Stats and timing
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [viewerCount, setViewerCount] = useState(1);
  const [isEndingStream, setIsEndingStream] = useState(false);

  const screenShareSupport = detectScreenShareSupport();

  const updateFacingMode = useCallback((nextMode: CameraFacingMode) => {
    facingModeRef.current = nextMode;
    setFacingMode(nextMode);
  }, []);

  const updateCameraEnabledState = useCallback((enabled: boolean) => {
    cameraEnabledRef.current = enabled;
    setCameraEnabled(enabled);
  }, []);

  const updateScreenSharingState = useCallback((active: boolean) => {
    isScreenSharingRef.current = active;
    setIsScreenSharing(active);
  }, []);

  const updateSelectedCameraId = useCallback((deviceId: string) => {
    selectedCameraIdRef.current = deviceId;
    setSelectedCameraId(deviceId);
  }, []);

  const updateSelectedMicId = useCallback((deviceId: string) => {
    selectedMicIdRef.current = deviceId;
    setSelectedMicId(deviceId);
  }, []);

  // Enumerate hardware devices without triggering broadcast re-initialization
  const updateDeviceList = useCallback(
    async (preferredCameraId?: string, preferredMicId?: string) => {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cameras = devices.filter((d) => d.kind === "videoinput");
        const mics = devices.filter((d) => d.kind === "audioinput");
        setAvailableCameras(cameras);
        setAvailableMics(mics);

        const currentCameraStillAvailable =
          Boolean(selectedCameraIdRef.current) &&
          cameras.some((c) => c.deviceId === selectedCameraIdRef.current);
        const nextCameraId =
          preferredCameraId ||
          (currentCameraStillAvailable ? selectedCameraIdRef.current : cameras[0]?.deviceId || "");
        updateSelectedCameraId(nextCameraId);

        const currentMicStillAvailable =
          Boolean(selectedMicIdRef.current) &&
          mics.some((m) => m.deviceId === selectedMicIdRef.current);
        const nextMicId =
          preferredMicId ||
          (currentMicStillAvailable ? selectedMicIdRef.current : mics[0]?.deviceId || "");
        updateSelectedMicId(nextMicId);
      } catch {
        // Ignore enumeration errors
      }
    },
    [updateSelectedCameraId, updateSelectedMicId],
  );

  const clearScreenShareCleanupListener = useCallback(() => {
    if (screenShareCleanupListenerRef.current) {
      try {
        screenShareCleanupListenerRef.current();
      } catch {
        // Ignore
      }
      screenShareCleanupListenerRef.current = null;
    }
  }, []);

  const stopActiveScreenShareTrack = useCallback(() => {
    clearScreenShareCleanupListener();
    if (screenShareTrackRef.current) {
      try {
        screenShareTrackRef.current.detach?.();
      } catch {
        // Ignore
      }
      try {
        screenShareTrackRef.current.stop?.();
      } catch {
        // Ignore
      }
      screenShareTrackRef.current = null;
    }
    wasCameraEnabledBeforeScreenShareRef.current = null;
    updateScreenSharingState(false);
  }, [clearScreenShareCleanupListener, updateScreenSharingState]);

  // Clean up all local media hardware tracks idempotently (including room-managed tracks)
  const stopLocalTracks = useCallback(() => {
    stopActiveScreenShareTrack();
    const seen = new Set<LocalTrack>();
    for (const track of localTracksRef.current) {
      seen.add(track);
      try {
        track.stop();
        track.detach();
      } catch {
        // Ignore
      }
    }
    localTracksRef.current = [];
    const localParticipant = roomRef.current?.localParticipant;
    if (localParticipant?.trackPublications) {
      for (const pub of localParticipant.trackPublications.values()) {
        if (pub.track && !seen.has(pub.track as LocalTrack)) {
          try {
            pub.track.stop();
            pub.track.detach();
          } catch {
            // Ignore
          }
        }
      }
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
  }, [stopActiveScreenShareTrack]);

  const disconnectRoom = useCallback(() => {
    teardownBroadcasterSessionIdempotently<LocalTrack>({
      roomRef: roomRef as unknown as { current: RoomLike<LocalTrack> | null },
      localTracksRef,
      registeredListenersRef: registeredRoomListenersRef,
      stopScreenShareTrack: stopActiveScreenShareTrack,
      stopPublishedScreenShare: (participant) => {
        void stopScreenShareSafely<Track.Source, LocalTrack>({
          participant: participant as unknown as Room["localParticipant"],
          screenShareSource: Track.Source.ScreenShare,
          screenAudioSource: Track.Source.ScreenShareAudio,
        });
      },
      localVideoEl: localVideoRef.current,
    });
  }, [stopActiveScreenShareTrack]);

  // Initialize Broadcaster: Obtain JWT Token, capture local tracks, publish to LiveKit Room
  const startBroadcasting = useCallback(async () => {
    if (!streamId) return;

    const runId = ++sessionRunIdRef.current;
    hasEndedStreamRef.current = false;
    setShowEndConfirm(false);
    stopLocalTracks();
    disconnectRoom();

    setIsInitializing(true);
    setPermissionError(null);
    setAudioOnlyMode(false);

    try {
      // 1. Fetch Publisher JWT Token with Broadcaster VideoGrants
      const tokenRes = await api.live.getStreamToken({
        streamId,
        role: "publisher",
      });

      if (sessionRunIdRef.current !== runId) return;

      if (!tokenRes.success || !tokenRes.token) {
        throw new Error(
          (tokenRes as { error?: string })?.error ||
            "Failed to acquire broadcaster publishing token. You must be the stream owner.",
        );
      }

      // 2. Request camera & microphone permissions with safe device fallback (never falls back on NotAllowedError)
      const activeCameraId = selectedCameraIdRef.current;
      const activeMicId = selectedMicIdRef.current;
      const acquisition = await acquireInitialMediaTracksWithFallback<LocalTrack>({
        createTracks: (options) =>
          createLocalTracks(options as Parameters<typeof createLocalTracks>[0]),
        primaryOptions: {
          audio: activeMicId ? { deviceId: { exact: activeMicId } } : true,
          video: {
            resolution: VideoPresets.h720.resolution,
            ...(activeCameraId
              ? { deviceId: { exact: activeCameraId } }
              : { facingMode: facingModeRef.current }),
          },
        },
        hasSpecificCameraId: Boolean(activeCameraId),
        hasSpecificMicId: Boolean(activeMicId),
        resolution: VideoPresets.h720.resolution,
        isCancelled: () => sessionRunIdRef.current !== runId,
      });

      if (acquisition.cancelled || sessionRunIdRef.current !== runId) {
        return;
      }

      const tracks = acquisition.tracks;
      localTracksRef.current = tracks;

      // Attach local video track to creator's preview screen
      const videoTrack = tracks.find((t) => t.kind === Track.Kind.Video) as
        LocalVideoTrack | undefined;
      const audioTrack = tracks.find((t) => t.kind === Track.Kind.Audio) as
        LocalAudioTrack | undefined;

      if (videoTrack) {
        setAudioOnlyMode(false);
        updateCameraEnabledState(true);
        if (localVideoRef.current) {
          videoTrack.attach(localVideoRef.current);
        }
      } else {
        setAudioOnlyMode(true);
        updateCameraEnabledState(false);
      }

      const activeVideoSettings = videoTrack?.mediaStreamTrack?.getSettings?.() ?? {};
      const activeAudioSettings = audioTrack?.mediaStreamTrack?.getSettings?.() ?? {};
      if (acquisition.usedCameraFallback && !activeVideoSettings.deviceId) {
        updateSelectedCameraId("");
      }
      if (acquisition.usedMicFallback && !activeAudioSettings.deviceId) {
        updateSelectedMicId("");
      }

      if (videoTrack) {
        const inferredMode = inferFacingModeFromCamera(
          activeVideoSettings,
          videoTrack.mediaStreamTrack?.label,
          facingModeRef.current,
        );
        updateFacingMode(inferredMode);
      }

      // 3. Connect to LiveKit Room as Authoritative Publisher
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
      });
      roomRef.current = room;

      const registerRoomListener = (event: RoomEvent, handler: (...args: any[]) => void) => {
        registeredRoomListenersRef.current.push([event, handler]);
        room.on(event, handler);
      };

      registerRoomListener(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
        if (sessionRunIdRef.current !== runId) return;
        setConnectionState(state);
      });

      registerRoomListener(RoomEvent.LocalTrackUnpublished, (publication) => {
        if (sessionRunIdRef.current !== runId) return;
        if (publication?.source === Track.Source.ScreenShare && isScreenSharingRef.current) {
          void handleBrowserScreenShareEndedRef.current();
        }
      });

      registerRoomListener(RoomEvent.Disconnected, () => {
        if (sessionRunIdRef.current !== runId) return;
        setConnectionState(ConnectionState.Disconnected);
        stopActiveScreenShareTrack();
      });

      await room.connect(tokenRes.url, tokenRes.token);

      if (sessionRunIdRef.current !== runId) {
        disconnectRoom();
        return;
      }

      // 4. Publish real camera and/or microphone tracks into the LiveKit Room
      for (const track of tracks) {
        await room.localParticipant.publishTrack(track);
      }

      if (sessionRunIdRef.current !== runId) {
        disconnectRoom();
        return;
      }

      if (acquisition.mode === "audio-only") {
        toast.info(acquisition.notice || "Camera unavailable. Continuing in audio-only mode.");
      } else {
        toast.success("🔴 Live broadcast is active! Streaming video & audio to FaceTube.");
        if (acquisition.notice) {
          toast.info(acquisition.notice);
        }
      }
      await updateDeviceList(activeVideoSettings.deviceId, activeAudioSettings.deviceId);
    } catch (err: unknown) {
      if (sessionRunIdRef.current !== runId) return;
      const msg = err instanceof Error ? err.message : String(err);
      setPermissionError(msg);
      toast.error(msg);
      stopLocalTracks();
      disconnectRoom();
    } finally {
      if (sessionRunIdRef.current === runId) {
        setIsInitializing(false);
      }
    }
  }, [
    streamId,
    stopLocalTracks,
    stopActiveScreenShareTrack,
    disconnectRoom,
    updateDeviceList,
    updateFacingMode,
    updateCameraEnabledState,
    updateSelectedCameraId,
    updateSelectedMicId,
  ]);

  // Periodic Broadcaster Heartbeat & Presence
  useEffect(() => {
    if (!isOpen || !streamId) return;

    let isMounted = true;
    const sendBroadcasterPing = async () => {
      try {
        const res = await api.live.heartbeat({
          streamId,
          role: "broadcaster",
        });
        if (isMounted && res.success && typeof res.active_viewers === "number") {
          setViewerCount(res.active_viewers);
        }
      } catch (_e) {
        // Fallback
      }
    };

    sendBroadcasterPing();
    const heartbeatTimer = setInterval(sendBroadcasterPing, 15000); // every 15s

    return () => {
      isMounted = false;
      clearInterval(heartbeatTimer);
    };
  }, [isOpen, streamId]);

  // Live broadcast duration timer
  useEffect(() => {
    if (!isOpen || connectionState !== ConnectionState.Connected) return;

    const timer = setInterval(() => {
      setDurationSeconds((s) => s + 1);
    }, 1000);

    return () => clearInterval(timer);
  }, [isOpen, connectionState]);

  // Toggle Microphone
  const toggleMicrophone = async () => {
    const nextState = !micEnabled;
    setMicEnabled(nextState);
    if (roomRef.current) {
      try {
        await roomRef.current.localParticipant.setMicrophoneEnabled(nextState);
      } catch (_e) {
        // Fallback
      }
    } else {
      const audioTrack = localTracksRef.current.find((t) => t.kind === Track.Kind.Audio) as
        LocalAudioTrack | undefined;
      if (audioTrack) {
        if (nextState) audioTrack.unmute();
        else audioTrack.mute();
      }
    }
  };

  // Toggle Camera
  const toggleCamera = async () => {
    const nextState = !cameraEnabled;
    updateCameraEnabledState(nextState);
    if (isScreenSharingRef.current) {
      wasCameraEnabledBeforeScreenShareRef.current = nextState;
    }
    if (roomRef.current) {
      try {
        await roomRef.current.localParticipant.setCameraEnabled(nextState);
        if (nextState) {
          const camTrack = getActiveVideoTrack();
          if (!camTrack) {
            updateCameraEnabledState(false);
            toast.error("No usable camera device was found.");
            return;
          }
          setAudioOnlyMode(false);
          if (localVideoRef.current && !isScreenSharingRef.current) {
            camTrack.attach(localVideoRef.current);
          }
        }
      } catch {
        updateCameraEnabledState(!nextState);
        toast.error(
          "Camera could not be enabled. Check browser permissions or device availability.",
        );
      }
    } else {
      const videoTrack = localTracksRef.current.find((t) => t.kind === Track.Kind.Video) as
        LocalVideoTrack | undefined;
      if (videoTrack) {
        if (nextState) videoTrack.unmute();
        else videoTrack.mute();
      } else if (nextState) {
        updateCameraEnabledState(false);
        toast.error("No usable camera device was found.");
      }
    }
  };

  const getActiveVideoTrack = useCallback((): LocalVideoTrack | undefined => {
    const pubTrack = roomRef.current?.localParticipant?.getTrackPublication(Track.Source.Camera)
      ?.track as LocalVideoTrack | undefined;
    if (pubTrack && pubTrack.mediaStreamTrack?.readyState !== "ended") {
      return pubTrack;
    }
    const refTrack = localTracksRef.current.find((t) => t.kind === Track.Kind.Video) as
      LocalVideoTrack | undefined;
    return refTrack ?? pubTrack;
  }, []);

  // Restore camera preview and previous publishing state after screen sharing stops
  const restoreCameraAfterScreenShare = useCallback(async () => {
    clearScreenShareCleanupListener();
    if (screenShareTrackRef.current) {
      try {
        if (localVideoRef.current) {
          screenShareTrackRef.current.detach?.(localVideoRef.current);
        } else {
          screenShareTrackRef.current.detach?.();
        }
      } catch (_e) {
        // Ignore
      }
      screenShareTrackRef.current = null;
    }

    const shouldRestoreCamera =
      wasCameraEnabledBeforeScreenShareRef.current !== null
        ? wasCameraEnabledBeforeScreenShareRef.current
        : cameraEnabledRef.current;
    wasCameraEnabledBeforeScreenShareRef.current = null;
    updateScreenSharingState(false);

    if (shouldRestoreCamera) {
      const room = roomRef.current;
      if (room && room.state === ConnectionState.Connected) {
        const camPub = room.localParticipant.getTrackPublication(Track.Source.Camera);
        const camReadyState = camPub?.track?.mediaStreamTrack?.readyState;
        if (!camPub?.track || camPub.isMuted || camPub.track.isMuted || camReadyState === "ended") {
          try {
            await room.localParticipant.setCameraEnabled(true);
          } catch (_e) {
            // Keep studio active even if camera device could not immediately re-acquire
          }
        }
      }
      updateCameraEnabledState(true);
      const camTrack = getActiveVideoTrack();
      if (camTrack && localVideoRef.current && !camTrack.isMuted) {
        try {
          camTrack.attach(localVideoRef.current);
        } catch (_e) {
          // Ignore attach error
        }
      }
    } else {
      updateCameraEnabledState(false);
    }
  }, [
    clearScreenShareCleanupListener,
    getActiveVideoTrack,
    updateCameraEnabledState,
    updateScreenSharingState,
  ]);

  const handleBrowserScreenShareEnded = useCallback(async () => {
    if (!isScreenSharingRef.current) return;
    if (isTogglingScreenShareRef.current) return;

    isTogglingScreenShareRef.current = true;
    setIsTogglingScreenShare(true);
    try {
      await stopScreenShareSafely<Track.Source, LocalTrack>({
        participant: roomRef.current?.localParticipant,
        screenShareSource: Track.Source.ScreenShare,
        screenAudioSource: Track.Source.ScreenShareAudio,
      });
      await restoreCameraAfterScreenShare();
      toast.info("Screen sharing stopped.");
    } finally {
      isTogglingScreenShareRef.current = false;
      setIsTogglingScreenShare(false);
    }
  }, [restoreCameraAfterScreenShare]);

  useEffect(() => {
    handleBrowserScreenShareEndedRef.current = handleBrowserScreenShareEnded;
  }, [handleBrowserScreenShareEnded]);

  // Start / Stop Screen Sharing without disconnecting the LiveKit room
  const toggleScreenShare = async () => {
    if (isTogglingScreenShareRef.current || isInitializing) return;

    if (isScreenSharingRef.current) {
      isTogglingScreenShareRef.current = true;
      setIsTogglingScreenShare(true);
      try {
        await stopScreenShareSafely<Track.Source, LocalTrack>({
          participant: roomRef.current?.localParticipant,
          screenShareSource: Track.Source.ScreenShare,
          screenAudioSource: Track.Source.ScreenShareAudio,
        });
        await restoreCameraAfterScreenShare();
        toast.info("Screen sharing stopped.");
      } finally {
        isTogglingScreenShareRef.current = false;
        setIsTogglingScreenShare(false);
      }
      return;
    }

    const support = detectScreenShareSupport();
    if (!support.supported) {
      toast.error(support.message);
      return;
    }

    const room = roomRef.current;
    if (!room || room.state !== ConnectionState.Connected) {
      toast.error("Connect to the live room before sharing your screen.");
      return;
    }

    const runId = sessionRunIdRef.current;
    const previousCameraEnabled = cameraEnabledRef.current;
    isTogglingScreenShareRef.current = true;
    setIsTogglingScreenShare(true);

    try {
      const result = await startScreenShareSafely<Track.Source, LocalTrack>({
        participant: room.localParticipant,
        screenShareSource: Track.Source.ScreenShare,
        screenAudioSource: Track.Source.ScreenShareAudio,
      });

      if (sessionRunIdRef.current !== runId) {
        await stopScreenShareSafely<Track.Source, LocalTrack>({
          participant: room.localParticipant,
          screenShareSource: Track.Source.ScreenShare,
          screenAudioSource: Track.Source.ScreenShareAudio,
        });
        return;
      }

      if (!result.success || !result.publication?.track) {
        if (result.reason === "cancelled") {
          toast.info(result.message);
        } else {
          toast.error(result.message);
        }
        return;
      }

      if (wasCameraEnabledBeforeScreenShareRef.current === null) {
        wasCameraEnabledBeforeScreenShareRef.current = previousCameraEnabled;
      }

      const screenTrack = result.publication.track;
      screenShareTrackRef.current = screenTrack;
      updateScreenSharingState(true);

      const camTrack = getActiveVideoTrack();
      if (camTrack && localVideoRef.current) {
        try {
          camTrack.detach(localVideoRef.current);
        } catch (_e) {
          // Ignore detach error
        }
      }
      if (localVideoRef.current) {
        try {
          screenTrack.attach?.(localVideoRef.current);
        } catch (_e) {
          // Ignore attach error
        }
      }

      clearScreenShareCleanupListener();
      const onBrowserEnded = () => {
        void handleBrowserScreenShareEndedRef.current();
      };
      screenTrack.mediaStreamTrack?.addEventListener?.("ended", onBrowserEnded);
      screenTrack.on?.(TrackEvent.Ended, onBrowserEnded);
      screenShareCleanupListenerRef.current = () => {
        screenTrack.mediaStreamTrack?.removeEventListener?.("ended", onBrowserEnded);
        screenTrack.off?.(TrackEvent.Ended, onBrowserEnded);
      };

      if (!result.alreadyActive) {
        toast.success(result.message);
      }
    } finally {
      isTogglingScreenShareRef.current = false;
      setIsTogglingScreenShare(false);
    }
  };

  // Flip Mobile Camera (Front / Rear) in-place without disconnecting the LiveKit room
  const flipCamera = async () => {
    if (isSwitchingCameraRef.current || isInitializing) return;

    const videoTrack = getActiveVideoTrack();
    if (!videoTrack) {
      toast.error("Camera is not active yet. Please wait for the studio to connect.");
      return;
    }

    const previousMode = facingModeRef.current;
    const targetMode: CameraFacingMode = previousMode === "user" ? "environment" : "user";

    isSwitchingCameraRef.current = true;
    setIsSwitchingCamera(true);

    try {
      const result = await switchCameraWithFallback({
        videoTrack,
        targetMode,
        previousMode,
        previousDeviceId: selectedCameraIdRef.current,
        resolution: VideoPresets.h720.resolution,
        enumerateCameras: async () => {
          if (!navigator.mediaDevices?.enumerateDevices) return [];
          const devices = await navigator.mediaDevices.enumerateDevices();
          return devices.filter((d) => d.kind === "videoinput");
        },
      });

      updateFacingMode(result.facingMode);
      if (result.deviceId) {
        updateSelectedCameraId(result.deviceId);
      }

      if (result.success) {
        if (localVideoRef.current && !videoTrack.isMuted && !isScreenSharingRef.current) {
          videoTrack.attach(localVideoRef.current);
        }
        await updateDeviceList(result.deviceId);
        toast.info(result.message);
      } else {
        if (
          result.restoredPrevious &&
          localVideoRef.current &&
          !videoTrack.isMuted &&
          !isScreenSharingRef.current
        ) {
          videoTrack.attach(localVideoRef.current);
        }
        if (result.reason === "unavailable") {
          toast.info(result.message);
        } else {
          toast.error(result.message);
        }
      }
    } finally {
      isSwitchingCameraRef.current = false;
      setIsSwitchingCamera(false);
    }
  };

  // Switch video or audio input device in-place without disconnecting the LiveKit room
  const handleDeviceChange = async (kind: "video" | "audio", deviceId: string) => {
    if (!deviceId) return;

    if (kind === "video") {
      if (isSwitchingCameraRef.current || isInitializing) return;
      const videoTrack = getActiveVideoTrack();
      if (!videoTrack) {
        updateSelectedCameraId(deviceId);
        return;
      }

      isSwitchingCameraRef.current = true;
      setIsSwitchingCamera(true);
      const previousDeviceId = selectedCameraIdRef.current;
      const previousMode = facingModeRef.current;
      const targetDeviceLabel = availableCameras.find((cam) => cam.deviceId === deviceId)?.label;

      try {
        const result = await switchVideoDeviceSafely({
          videoTrack,
          deviceId,
          previousDeviceId,
          previousMode,
          resolution: VideoPresets.h720.resolution,
          deviceLabel: targetDeviceLabel,
        });

        updateSelectedCameraId(result.deviceId);
        updateFacingMode(result.facingMode);

        if (result.success) {
          if (localVideoRef.current && !videoTrack.isMuted && !isScreenSharingRef.current) {
            videoTrack.attach(localVideoRef.current);
          }
        } else {
          if (
            result.restoredPrevious &&
            localVideoRef.current &&
            !videoTrack.isMuted &&
            !isScreenSharingRef.current
          ) {
            videoTrack.attach(localVideoRef.current);
          }
          toast.error(result.message);
        }
      } finally {
        isSwitchingCameraRef.current = false;
        setIsSwitchingCamera(false);
      }
    } else {
      const previousMicId = selectedMicIdRef.current;
      updateSelectedMicId(deviceId);
      const audioTrack = localTracksRef.current.find((t) => t.kind === Track.Kind.Audio) as
        LocalAudioTrack | undefined;
      if (audioTrack) {
        try {
          await audioTrack.restartTrack({ deviceId: { exact: deviceId } });
        } catch (_e) {
          updateSelectedMicId(previousMicId);
          toast.error("Could not switch microphone source.");
        }
      }
    }
  };

  // Open in-studio End Broadcast confirmation (replaces window.confirm)
  const handleEndBroadcast = () => {
    if (isEndingStreamRef.current || hasEndedStreamRef.current) return;
    setShowEndConfirm(true);
  };

  const confirmEndBroadcast = async () => {
    if (isEndingStreamRef.current || hasEndedStreamRef.current) return;
    setIsEndingStream(true);
    await executeEndBroadcastOnce({
      isEndingRef: isEndingStreamRef,
      hasEndedRef: hasEndedStreamRef,
      onEndApi: () => api.live.endStream({ streamId }),
      onCleanup: () => {
        setShowEndConfirm(false);
        sessionRunIdRef.current += 1;
        stopLocalTracks();
        disconnectRoom();
      },
      onSuccess: () => {
        toast.success("Broadcast ended successfully. Stream has concluded.");
        onStreamEnded();
        onClose();
      },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : "Failed to end stream on server.";
        toast.error(msg || "Failed to end stream on server.");
      },
    });
    setIsEndingStream(false);
  };

  // Lifecycle initialization & idempotent teardown on modal open/close/unmount
  useEffect(() => {
    if (isOpen) {
      setDurationSeconds(0);
      void startBroadcasting();
    } else {
      setShowEndConfirm(false);
      sessionRunIdRef.current += 1;
      stopLocalTracks();
      disconnectRoom();
    }

    return () => {
      sessionRunIdRef.current += 1;
      stopLocalTracks();
      disconnectRoom();
    };
  }, [isOpen, startBroadcasting, stopLocalTracks, disconnectRoom]);

  if (!isOpen) return null;

  // Format seconds to HH:MM:SS or MM:SS
  const formatDuration = (totalSeconds: number) => {
    const hrs = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    if (hrs > 0) {
      return `${hrs.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
    }
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-3 sm:p-6 backdrop-blur-md animate-in fade-in">
      <div className="relative flex flex-col w-full max-w-4xl h-[90vh] max-h-[780px] rounded-3xl border border-zinc-800 bg-zinc-950 text-white shadow-2xl overflow-hidden">
        {/* Header Bar */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-800 bg-zinc-900/60 backdrop-blur-sm shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 rounded-full bg-red-600 px-3 py-1 text-xs font-black uppercase tracking-wider text-white shadow-sm animate-pulse">
              <Radio className="h-3.5 w-3.5" />
              <span>Studio Live</span>
            </div>
            <div className="min-w-0">
              <h2 className="text-sm sm:text-base font-extrabold truncate max-w-xs sm:max-w-md">
                {streamTitle}
              </h2>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowSettings((s) => !s)}
              className="p-2 rounded-full bg-zinc-800 text-zinc-300 hover:text-white hover:bg-zinc-700 transition"
              aria-label="Studio hardware settings"
            >
              <Settings className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-full bg-zinc-800 text-zinc-300 hover:text-white hover:bg-zinc-700 transition"
              aria-label="Close studio preview"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Studio Viewport Area */}
        <div className="relative flex-1 bg-black overflow-hidden grid place-items-center">
          {/* Real Local Video Stream */}
          <video
            ref={localVideoRef}
            playsInline
            autoPlay
            muted
            className={`h-full w-full object-contain ${
              !isScreenSharing && facingMode === "user" ? "scale-x-[-1]" : ""
            } ${cameraEnabled || isScreenSharing ? "opacity-100" : "opacity-0"}`}
          />

          {/* Camera Off / Audio-Only Placeholder */}
          {!cameraEnabled && !isScreenSharing && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-zinc-900 text-zinc-400">
              <VideoOff className="h-14 w-14 opacity-50" />
              <p className="text-sm font-semibold text-zinc-300">
                {audioOnlyMode ? "Audio-only broadcast active" : "Camera is paused"}
              </p>
              <p className="text-xs text-zinc-500">
                {audioOnlyMode
                  ? "No usable camera was found — streaming microphone audio"
                  : "Viewers cannot see your video feed"}
              </p>
            </div>
          )}

          {/* Permission / Initialization Overlay */}
          {permissionError && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center p-6 text-center bg-zinc-950/95 space-y-3">
              <AlertTriangle className="h-12 w-12 text-amber-500" />
              <h3 className="text-base font-bold text-white">Media Access Required</h3>
              <p className="text-xs text-zinc-300 max-w-sm">{permissionError}</p>
              <button
                type="button"
                onClick={startBroadcasting}
                className="rounded-full bg-brand px-5 py-2 text-xs font-bold text-white shadow-lift hover:bg-brand-dark transition"
              >
                Grant Permissions & Retry
              </button>
            </div>
          )}

          {/* Initializing Spinner */}
          {isInitializing && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/80 backdrop-blur-sm">
              <Radio className="h-10 w-10 text-brand animate-pulse" />
              <p className="text-sm font-bold text-white">Connecting Media Tracks...</p>
              <p className="text-xs text-zinc-400">Initializing LiveKit WebRTC peer connection</p>
            </div>
          )}

          {/* Broadcast HUD Indicators */}
          <div className="absolute top-4 left-4 flex items-center gap-2 z-20">
            <span className="flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1 text-xs font-bold text-white backdrop-blur-md border border-white/10">
              <Clock className="h-3.5 w-3.5 text-red-500" />
              <span className="font-mono">{formatDuration(durationSeconds)}</span>
            </span>

            <span className="flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1 text-xs font-bold text-white backdrop-blur-md border border-white/10">
              <Users className="h-3.5 w-3.5 text-zinc-300" />
              <span>{viewerCount} viewers</span>
            </span>

            {isScreenSharing && (
              <span className="flex items-center gap-1.5 rounded-full bg-brand/90 px-3 py-1 text-xs font-bold text-white backdrop-blur-md border border-white/15 shadow-sm">
                <ScreenShare className="h-3.5 w-3.5" />
                <span>Sharing Screen</span>
              </span>
            )}
          </div>

          {/* Settings Overlay Drawer */}
          {showSettings && (
            <div className="absolute top-4 right-4 z-30 w-72 rounded-2xl border border-zinc-800 bg-zinc-900/95 p-4 shadow-xl backdrop-blur-md space-y-3 animate-in fade-in">
              <div className="flex items-center justify-between pb-2 border-b border-zinc-800">
                <span className="text-xs font-bold text-white">Hardware Devices</span>
                <button
                  type="button"
                  onClick={() => setShowSettings(false)}
                  className="text-zinc-400 hover:text-white"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* Camera Selector */}
              <div className="space-y-1">
                <label className="text-[11px] font-semibold text-zinc-400">Camera Source</label>
                <select
                  value={selectedCameraId}
                  onChange={(e) => handleDeviceChange("video", e.target.value)}
                  className="w-full rounded-xl border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs text-white outline-none"
                >
                  {availableCameras.length > 0 ? (
                    availableCameras.map((cam, idx) => (
                      <option key={cam.deviceId || idx} value={cam.deviceId}>
                        {cam.label || `Camera ${idx + 1}`}
                      </option>
                    ))
                  ) : (
                    <option value="">Default WebRTC Camera</option>
                  )}
                </select>
              </div>

              {/* Microphone Selector */}
              <div className="space-y-1">
                <label className="text-[11px] font-semibold text-zinc-400">Microphone Source</label>
                <select
                  value={selectedMicId}
                  onChange={(e) => handleDeviceChange("audio", e.target.value)}
                  className="w-full rounded-xl border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs text-white outline-none"
                >
                  {availableMics.length > 0 ? (
                    availableMics.map((mic, idx) => (
                      <option key={mic.deviceId || idx} value={mic.deviceId}>
                        {mic.label || `Microphone ${idx + 1}`}
                      </option>
                    ))
                  ) : (
                    <option value="">Default Audio Input</option>
                  )}
                </select>
              </div>

              <div className="pt-1 text-[10px] text-zinc-400">
                <p>LiveKit SFU auto-adapts bitrate dynamically to viewer bandwidth.</p>
              </div>
            </div>
          )}

          {/* In-Studio End Broadcast Confirmation Modal */}
          {showEndConfirm && (
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="end-broadcast-confirm-title"
              className="absolute inset-0 z-40 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm animate-in fade-in"
            >
              <div className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl space-y-4">
                <div className="flex items-start gap-3">
                  <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-red-600/20 text-red-500">
                    <AlertTriangle className="h-5 w-5" />
                  </div>
                  <div className="space-y-1">
                    <h3 id="end-broadcast-confirm-title" className="text-sm font-bold text-white">
                      End Live Broadcast?
                    </h3>
                    <p className="text-xs text-zinc-400 leading-relaxed">
                      Are you sure you want to end this live broadcast for all viewers?
                    </p>
                  </div>
                </div>
                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setShowEndConfirm(false)}
                    disabled={isEndingStream}
                    className="rounded-full bg-zinc-800 px-4 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-700 transition disabled:opacity-50"
                  >
                    Keep Streaming
                  </button>
                  <button
                    type="button"
                    onClick={confirmEndBroadcast}
                    disabled={isEndingStream}
                    className="rounded-full bg-red-600 px-4 py-1.5 text-xs font-extrabold text-white hover:bg-red-700 transition disabled:opacity-50"
                  >
                    {isEndingStream ? "Concluding..." : "End Broadcast"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Broadcaster Bottom Control Console */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 sm:px-6 py-4 border-t border-zinc-800 bg-zinc-900/80 backdrop-blur-sm shrink-0">
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            {/* Microphone Toggle */}
            <button
              type="button"
              onClick={toggleMicrophone}
              className={`flex items-center gap-2 rounded-full px-4 py-2 text-xs font-bold transition shadow-sm ${
                micEnabled
                  ? "bg-zinc-800 text-white hover:bg-zinc-700"
                  : "bg-red-600 text-white hover:bg-red-700"
              }`}
            >
              {micEnabled ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
              <span className="hidden sm:inline">{micEnabled ? "Mute Mic" : "Unmute Mic"}</span>
            </button>

            {/* Camera Toggle */}
            <button
              type="button"
              onClick={toggleCamera}
              className={`flex items-center gap-2 rounded-full px-4 py-2 text-xs font-bold transition shadow-sm ${
                cameraEnabled
                  ? "bg-zinc-800 text-white hover:bg-zinc-700"
                  : "bg-red-600 text-white hover:bg-red-700"
              }`}
            >
              {cameraEnabled ? <VideoIcon className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
              <span className="hidden sm:inline">{cameraEnabled ? "Stop Cam" : "Start Cam"}</span>
            </button>

            {/* Mobile Camera Flip (Front/Rear) */}
            <button
              type="button"
              onClick={flipCamera}
              disabled={isSwitchingCamera || isInitializing}
              className="flex items-center gap-2 rounded-full bg-zinc-800 px-3.5 py-2 text-xs font-bold text-white hover:bg-zinc-700 transition disabled:opacity-50"
              title="Flip camera (Front / Rear)"
            >
              <SwitchCamera className="h-4 w-4" />
              <span className="hidden sm:inline">Flip Camera</span>
            </button>

            {/* Screen Share Toggle */}
            <button
              type="button"
              onClick={toggleScreenShare}
              disabled={isTogglingScreenShare || isInitializing}
              className={`flex items-center gap-2 rounded-full px-3.5 py-2 text-xs font-bold transition shadow-sm disabled:opacity-50 ${
                isScreenSharing
                  ? "bg-brand text-white hover:bg-brand-dark"
                  : screenShareSupport.supported
                    ? "bg-zinc-800 text-white hover:bg-zinc-700"
                    : "bg-zinc-800/60 text-zinc-400 hover:bg-zinc-800"
              }`}
              title={
                isScreenSharing
                  ? "Stop sharing screen"
                  : screenShareSupport.supported
                    ? "Share your screen, window, or browser tab"
                    : screenShareSupport.message
              }
            >
              {isScreenSharing ? (
                <ScreenShareOff className="h-4 w-4" />
              ) : (
                <ScreenShare className="h-4 w-4" />
              )}
              <span className="hidden sm:inline">
                {isScreenSharing ? "Stop Share" : "Share Screen"}
              </span>
            </button>
          </div>

          {/* End Broadcast Action */}
          <div>
            <button
              type="button"
              onClick={handleEndBroadcast}
              disabled={isEndingStream}
              className="inline-flex items-center gap-2 rounded-full bg-red-600 hover:bg-red-700 px-5 py-2 text-xs font-extrabold text-white shadow-lift transition active:scale-95 disabled:opacity-50"
            >
              <StopCircle className="h-4 w-4" />
              <span>{isEndingStream ? "Concluding..." : "End Broadcast"}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
