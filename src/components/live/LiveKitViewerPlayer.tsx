import { useEffect, useRef, useState, useCallback } from "react";
import { Room, RoomEvent, Track, type RemoteTrack, ConnectionState } from "livekit-client";
import {
  Volume2,
  VolumeX,
  Maximize2,
  Minimize2,
  Radio,
  Users,
  AlertCircle,
  RefreshCw,
  VideoOff,
  Sparkles,
} from "lucide-react";
import { api } from "@/lib/api";
import {
  clearAudioElementPlayback,
  runViewerRoomConnection,
  teardownViewerSession,
  unlockViewerAudioPlayback,
  type RoomLike,
} from "./live-lifecycle-utils";

function isMockStreamId(id: string | undefined | null): boolean {
  if (!id) return true;
  const normalized = String(id).trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "live-default" ||
    normalized === "live_seed_001" ||
    /^live-\d+$/.test(normalized)
  );
}

export interface LiveKitViewerPlayerProps {
  streamId: string;
  streamTitle: string;
  isOwner?: boolean;
  disabled?: boolean;
  thumbnailUrl?: string;
  initialViewers?: number;
  onOpenStudio?: () => void;
  onEndBroadcast?: () => void;
}

export function LiveKitViewerPlayer({
  streamId,
  streamTitle,
  isOwner = false,
  disabled = false,
  thumbnailUrl,
  initialViewers = 0,
  onOpenStudio,
  onEndBroadcast,
}: LiveKitViewerPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const sessionRunIdRef = useRef(0);
  const roomRef = useRef<Room | null>(null);
  const activeVideoTrackRef = useRef<RemoteTrack | null>(null);
  const activeAudioTrackRef = useRef<RemoteTrack | null>(null);
  const registeredListenersRef = useRef<Array<[string, (...args: any[]) => void]>>([]);
  const isMutedRef = useRef(false);

  const [connectionState, setConnectionState] = useState<ConnectionState>(
    ConnectionState.Disconnected,
  );
  const [isConnecting, setIsConnecting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [serverConfigured, setServerConfigured] = useState<boolean>(true);
  const [hasRemoteVideo, setHasRemoteVideo] = useState(false);
  const [hasRemoteAudio, setHasRemoteAudio] = useState(false);
  const [isAudioBlocked, setIsAudioBlocked] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [viewerCount, setViewerCount] = useState<number>(initialViewers);

  useEffect(() => {
    setViewerCount(initialViewers);
  }, [streamId, initialViewers]);

  // Connect to LiveKit Room as Viewer with cancellation & stale-token guards
  const connectToRoom = useCallback(async () => {
    await runViewerRoomConnection<RemoteTrack, Room, ConnectionState>({
      streamId,
      disabled,
      isMockStream: isMockStreamId(streamId),
      refs: {
        sessionRunIdRef,
        roomRef,
        activeVideoTrackRef,
        activeAudioTrackRef,
        registeredListenersRef,
        isMutedRef,
      },
      getToken: (targetStreamId) =>
        api.live.getStreamToken({
          streamId: targetStreamId,
          role: "subscriber",
        }),
      createRoom: () =>
        new Room({
          adaptiveStream: true,
          dynacast: true,
        }),
      events: {
        ConnectionStateChanged: RoomEvent.ConnectionStateChanged,
        TrackSubscribed: RoomEvent.TrackSubscribed,
        TrackUnsubscribed: RoomEvent.TrackUnsubscribed,
        Disconnected: RoomEvent.Disconnected,
        AudioPlaybackStatusChanged: RoomEvent.AudioPlaybackStatusChanged,
      },
      disconnectedState: ConnectionState.Disconnected,
      getVideoEl: () => videoRef.current,
      getAudioEl: () => audioRef.current,
      syncMediaTracks: function syncRemoteMediaTracks(room: Room) {
        let screenShareTrack: RemoteTrack | null = null;
        let cameraTrack: RemoteTrack | null = null;
        let fallbackVideoTrack: RemoteTrack | null = null;
        let micAudioTrack: RemoteTrack | null = null;
        let fallbackAudioTrack: RemoteTrack | null = null;

        for (const participant of room.remoteParticipants.values()) {
          for (const pub of participant.trackPublications.values()) {
            if (!pub.isSubscribed || !pub.track) continue;
            if (pub.track.kind === Track.Kind.Video) {
              if (pub.source === Track.Source.ScreenShare && !screenShareTrack) {
                screenShareTrack = pub.track;
              } else if (pub.source === Track.Source.Camera && !cameraTrack) {
                cameraTrack = pub.track;
              } else if (!fallbackVideoTrack) {
                fallbackVideoTrack = pub.track;
              }
            } else if (pub.track.kind === Track.Kind.Audio) {
              if (pub.source === Track.Source.Microphone && !micAudioTrack) {
                micAudioTrack = pub.track;
              } else if (!fallbackAudioTrack) {
                fallbackAudioTrack = pub.track;
              }
            }
          }
        }

        const nextVideoTrack = screenShareTrack ?? cameraTrack ?? fallbackVideoTrack;
        const videoChanged = activeVideoTrackRef.current !== nextVideoTrack;
        if (videoChanged) {
          if (activeVideoTrackRef.current) {
            try {
              if (videoRef.current) {
                activeVideoTrackRef.current.detach(videoRef.current);
              } else {
                activeVideoTrackRef.current.detach();
              }
            } catch {
              // Ignore
            }
          }
          activeVideoTrackRef.current = nextVideoTrack;
          if (nextVideoTrack && videoRef.current) {
            nextVideoTrack.attach(videoRef.current);
          }
        }

        const nextAudioTrack = micAudioTrack ?? fallbackAudioTrack;
        const audioChanged = activeAudioTrackRef.current !== nextAudioTrack;
        if (audioChanged) {
          if (activeAudioTrackRef.current) {
            try {
              if (audioRef.current) {
                activeAudioTrackRef.current.detach(audioRef.current);
              } else {
                activeAudioTrackRef.current.detach();
              }
            } catch {
              // Ignore
            }
          }
          clearAudioElementPlayback(audioRef.current);
          activeAudioTrackRef.current = nextAudioTrack;
          if (nextAudioTrack && audioRef.current) {
            audioRef.current.muted = isMutedRef.current;
            nextAudioTrack.attach(audioRef.current);
          }
        }

        return {
          videoChanged,
          nextVideoTrack,
          audioChanged,
          nextAudioTrack,
        };
      },
      callbacks: {
        onConnectingChange: setIsConnecting,
        onConnectionStateChange: setConnectionState,
        onErrorChange: setErrorMessage,
        onServerConfiguredChange: setServerConfigured,
        onRemoteVideoChange: setHasRemoteVideo,
        onRemoteAudioChange: setHasRemoteAudio,
        onAudioBlockedChange: setIsAudioBlocked,
      },
    });
  }, [streamId, disabled]);

  // Periodic Viewer Presence Heartbeat
  useEffect(() => {
    if (disabled || !streamId || isMockStreamId(streamId)) return;

    let isMounted = true;
    const sendHeartbeat = async () => {
      try {
        const res = await api.live.heartbeat({
          streamId,
          role: "viewer",
        });
        if (isMounted && res.success && typeof res.active_viewers === "number") {
          setViewerCount(res.active_viewers);
        }
      } catch {
        // Fallback to initial
      }
    };

    sendHeartbeat();
    const interval = setInterval(sendHeartbeat, 30000); // every 30 seconds

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [streamId, disabled]);

  // Initiate connection when streamId/disabled changes and cancel pending work on teardown
  useEffect(() => {
    const videoEl = videoRef.current;
    const audioEl = audioRef.current;
    void connectToRoom();

    return () => {
      sessionRunIdRef.current += 1;
      teardownViewerSession({
        refs: {
          sessionRunIdRef,
          roomRef,
          activeVideoTrackRef,
          activeAudioTrackRef,
          registeredListenersRef,
          isMutedRef,
        },
        videoEl,
        audioEl,
      });
    };
  }, [connectToRoom]);

  // Explicit user-triggered audio recovery when browser autoplay blocks playback
  const handleEnableAudio = async () => {
    isMutedRef.current = false;
    setIsMuted(false);
    const result = await unlockViewerAudioPlayback({
      room: roomRef.current as unknown as RoomLike,
      audioEl: audioRef.current,
      audioTrack: activeAudioTrackRef.current,
    });
    setIsAudioBlocked(result.blocked);
  };

  // Audio mute/unmute control
  const toggleMute = async () => {
    const nextMuted = !isMuted;
    isMutedRef.current = nextMuted;
    setIsMuted(nextMuted);
    if (audioRef.current) {
      audioRef.current.muted = nextMuted;
    }
    if (nextMuted) {
      setIsAudioBlocked(false);
      return;
    }
    if (hasRemoteAudio) {
      const result = await unlockViewerAudioPlayback({
        room: roomRef.current as unknown as RoomLike,
        audioEl: audioRef.current,
        audioTrack: activeAudioTrackRef.current,
      });
      setIsAudioBlocked(result.blocked);
    }
  };

  // Fullscreen control
  const toggleFullscreen = async () => {
    if (!containerRef.current) return;
    try {
      if (!document.fullscreenElement) {
        await containerRef.current.requestFullscreen();
        setIsFullscreen(true);
      } else {
        await document.exitFullscreen();
        setIsFullscreen(false);
      }
    } catch {
      // Ignore fullscreen rejection
    }
  };

  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener("fullscreenchange", handleFsChange);
    return () => document.removeEventListener("fullscreenchange", handleFsChange);
  }, []);

  const isConnected = connectionState === ConnectionState.Connected;
  const isReconnecting = connectionState === ConnectionState.Reconnecting;

  return (
    <div
      ref={containerRef}
      className="relative aspect-video w-full rounded-2xl overflow-hidden bg-black shadow-lg ring-1 ring-border group select-none"
    >
      {/* Real WebRTC Video Track Element */}
      <video
        ref={videoRef}
        playsInline
        autoPlay
        muted={isMuted}
        className={`h-full w-full object-contain transition-opacity duration-300 ${
          hasRemoteVideo ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      />

      {/* Hidden Audio Element for Remote Sound Track */}
      <audio ref={audioRef} autoPlay playsInline muted={isMuted} />

      {/* Fallback Display When Waiting for Broadcaster Video */}
      {!hasRemoteVideo && (
        <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center bg-zinc-950">
          {thumbnailUrl ? (
            <img
              src={thumbnailUrl}
              alt={streamTitle}
              className="absolute inset-0 h-full w-full object-cover opacity-20 filter blur-sm"
            />
          ) : null}

          <div className="relative z-10 max-w-md space-y-3">
            {isConnecting || isReconnecting ? (
              <div className="flex flex-col items-center gap-3">
                <RefreshCw className="h-10 w-10 text-brand animate-spin" />
                <p className="text-sm font-bold text-white">
                  {isReconnecting
                    ? "Reconnecting to Live Broadcast..."
                    : "Connecting to WebRTC Live Room..."}
                </p>
                <p className="text-xs text-zinc-400">
                  Negotiating low-latency LiveKit media tracks
                </p>
              </div>
            ) : isConnected ? (
              <div className="flex flex-col items-center gap-3">
                <div className="h-12 w-12 rounded-full bg-red-600/20 text-red-500 grid place-items-center">
                  <Radio className="h-6 w-6 animate-pulse" />
                </div>
                <p className="text-sm font-bold text-white">Connected to Live Room</p>
                <p className="text-xs text-zinc-400">
                  Waiting for broadcaster to publish camera & microphone feed...
                </p>
                {isOwner && onOpenStudio && (
                  <button
                    type="button"
                    onClick={onOpenStudio}
                    className="mt-2 inline-flex items-center gap-2 rounded-full bg-brand px-4 py-2 text-xs font-bold text-white shadow-lift hover:bg-brand-dark transition active:scale-95"
                  >
                    <Radio className="h-3.5 w-3.5" />
                    Open Broadcaster Studio
                  </button>
                )}
              </div>
            ) : errorMessage ? (
              <div className="flex flex-col items-center gap-2">
                <AlertCircle className="h-9 w-9 text-amber-500" />
                <p className="text-sm font-bold text-white">Stream Connection Issue</p>
                <p className="text-xs text-zinc-400 font-mono max-w-xs">{errorMessage}</p>
                <button
                  type="button"
                  onClick={connectToRoom}
                  className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-secondary px-3.5 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary/80 transition"
                >
                  <RefreshCw className="h-3 w-3" /> Retry Connection
                </button>
              </div>
            ) : disabled ? (
              <div className="flex flex-col items-center gap-2">
                <Radio className="h-9 w-9 text-brand animate-pulse" />
                <p className="text-sm font-bold text-white">Broadcaster Studio Active</p>
                <p className="text-xs text-zinc-400">
                  Publishing live camera and microphone tracks from Studio.
                </p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <VideoOff className="h-9 w-9 text-zinc-600" />
                <p className="text-sm font-bold text-white">Live Broadcast Offline</p>
                <p className="text-xs text-zinc-400">
                  This broadcast is not currently streaming video.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Top Overlay Badges */}
      <div className="absolute top-3 left-3 flex items-center gap-2 z-20">
        <span
          className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-black uppercase tracking-wider text-white backdrop-blur-sm shadow-md ${
            hasRemoteVideo ? "bg-red-600/90 animate-pulse" : "bg-zinc-800/80"
          }`}
        >
          <span className={`h-2 w-2 rounded-full ${hasRemoteVideo ? "bg-white" : "bg-zinc-400"}`} />
          {hasRemoteVideo ? "Live WebRTC" : "Live Room"}
        </span>

        <span className="flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1 text-xs font-semibold text-white backdrop-blur-sm">
          <Users className="h-3.5 w-3.5 text-zinc-300" />
          <span>{viewerCount}</span>
        </span>

        {!serverConfigured && (
          <span className="hidden sm:inline-flex items-center gap-1 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 px-2.5 py-0.5 text-[10px] font-semibold backdrop-blur-sm">
            <Sparkles className="h-3 w-3" /> Dev Credentials Pending
          </span>
        )}

        {hasRemoteAudio && isAudioBlocked && !isMuted && (
          <button
            type="button"
            onClick={handleEnableAudio}
            aria-label="Enable stream audio playback"
            className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/90 hover:bg-amber-500 px-3 py-1 text-xs font-bold text-black backdrop-blur-sm shadow-md transition active:scale-95"
          >
            <Volume2 className="h-3.5 w-3.5" />
            <span>Tap for Audio</span>
          </button>
        )}
      </div>

      {/* Top Right Actions (Broadcaster Studio Quick Access if Stream Owner) */}
      {isOwner && (
        <div className="absolute top-3 right-3 flex items-center gap-2 z-20">
          {onOpenStudio && (
            <button
              type="button"
              onClick={onOpenStudio}
              className="inline-flex items-center gap-1.5 rounded-full bg-brand/90 hover:bg-brand px-3 py-1 text-xs font-bold text-white backdrop-blur-sm shadow-md transition active:scale-95"
            >
              <Radio className="h-3.5 w-3.5 animate-pulse" />
              <span>Studio</span>
            </button>
          )}
          {onEndBroadcast && (
            <button
              type="button"
              onClick={onEndBroadcast}
              className="inline-flex items-center gap-1.5 rounded-full bg-red-600/80 hover:bg-red-700 px-3 py-1 text-xs font-bold text-white backdrop-blur-sm shadow-md transition active:scale-95"
            >
              End Broadcast
            </button>
          )}
        </div>
      )}

      {/* Bottom Floating Control Bar (Fade on Hover/Touch) */}
      <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-3 flex items-center justify-between opacity-0 group-hover:opacity-100 transition-opacity duration-200 z-20">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={toggleMute}
            aria-label={isMuted ? "Unmute stream audio" : "Mute stream audio"}
            className="p-1.5 rounded-full bg-black/40 text-white hover:bg-black/60 transition"
          >
            {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </button>
          <span className="text-[11px] text-zinc-300 font-mono">
            {hasRemoteAudio
              ? isMuted
                ? "Muted"
                : isAudioBlocked
                  ? "Audio Paused (Tap for Audio)"
                  : "Live Audio"
              : "No Audio Feed"}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={connectToRoom}
            aria-label="Refresh WebRTC stream connection"
            className="p-1.5 rounded-full bg-black/40 text-white hover:bg-black/60 transition"
          >
            <RefreshCw className={`h-4 w-4 ${isConnecting ? "animate-spin" : ""}`} />
          </button>
          <button
            type="button"
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            className="p-1.5 rounded-full bg-black/40 text-white hover:bg-black/60 transition"
          >
            {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}
