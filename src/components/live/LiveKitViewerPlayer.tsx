import { useEffect, useRef, useState, useCallback } from "react";
import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteParticipant,
  ConnectionState,
} from "livekit-client";
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
  initialViewers = 1,
  onOpenStudio,
  onEndBroadcast,
}: LiveKitViewerPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const roomRef = useRef<Room | null>(null);
  const activeVideoTrackRef = useRef<RemoteTrack | null>(null);
  const activeAudioTrackRef = useRef<RemoteTrack | null>(null);

  const [connectionState, setConnectionState] = useState<ConnectionState>(
    ConnectionState.Disconnected,
  );
  const [isConnecting, setIsConnecting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [serverConfigured, setServerConfigured] = useState<boolean>(true);
  const [hasRemoteVideo, setHasRemoteVideo] = useState(false);
  const [hasRemoteAudio, setHasRemoteAudio] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [viewerCount, setViewerCount] = useState<number>(initialViewers);

  // Connect to LiveKit Room as Viewer
  const connectToRoom = useCallback(async () => {
    // Clean up existing room if any
    if (roomRef.current) {
      try {
        roomRef.current.disconnect();
      } catch (_e) {
        // Ignore
      }
      roomRef.current = null;
    }

    if (disabled || !streamId || isMockStreamId(streamId)) {
      setIsConnecting(false);
      setConnectionState(ConnectionState.Disconnected);
      return;
    }

    setIsConnecting(true);
    setErrorMessage(null);

    try {
      // 1. Fetch Subscriber JWT token from authoritative backend
      const tokenRes = await api.live.getStreamToken({
        streamId,
        role: "subscriber",
      });

      if (!tokenRes.success || !tokenRes.token) {
        throw new Error("Failed to acquire live stream access token from server.");
      }

      setServerConfigured(tokenRes.server_configured !== false);

      // 2. Instantiate LiveKit Room with WebRTC adaptive streaming enabled
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
      });
      roomRef.current = room;

      // Track Connection State Changes
      room.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
        setConnectionState(state);
      });

      // Handle Remote Track Subscriptions
      room.on(
        RoomEvent.TrackSubscribed,
        (track: RemoteTrack, _publication: any, _participant: RemoteParticipant) => {
          if (track.kind === Track.Kind.Video && videoRef.current) {
            activeVideoTrackRef.current = track;
            track.attach(videoRef.current);
            setHasRemoteVideo(true);
          } else if (track.kind === Track.Kind.Audio && audioRef.current) {
            activeAudioTrackRef.current = track;
            track.attach(audioRef.current);
            setHasRemoteAudio(true);
          }
        },
      );

      // Handle Remote Track Unsubscriptions
      room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        try {
          track.detach();
        } catch (_e) {
          // Ignore
        }
        if (track.kind === Track.Kind.Video) {
          setHasRemoteVideo(false);
          activeVideoTrackRef.current = null;
        } else if (track.kind === Track.Kind.Audio) {
          setHasRemoteAudio(false);
          activeAudioTrackRef.current = null;
        }
      });

      // Handle Disconnections
      room.on(RoomEvent.Disconnected, () => {
        setConnectionState(ConnectionState.Disconnected);
        setHasRemoteVideo(false);
        setHasRemoteAudio(false);
      });

      // 3. Connect WebRTC signaling and media peer connection
      await room.connect(tokenRes.url, tokenRes.token);

      // Attach any tracks that were already published before this viewer connected
      for (const participant of room.remoteParticipants.values()) {
        for (const pub of participant.trackPublications.values()) {
          if (pub.isSubscribed && pub.track) {
            if (pub.track.kind === Track.Kind.Video && videoRef.current) {
              activeVideoTrackRef.current = pub.track;
              pub.track.attach(videoRef.current);
              setHasRemoteVideo(true);
            } else if (pub.track.kind === Track.Kind.Audio && audioRef.current) {
              activeAudioTrackRef.current = pub.track;
              pub.track.attach(audioRef.current);
              setHasRemoteAudio(true);
            }
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg);
      setConnectionState(ConnectionState.Disconnected);
    } finally {
      setIsConnecting(false);
    }
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
      } catch (_e) {
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

  // Initiate connection when streamId changes
  useEffect(() => {
    connectToRoom();

    return () => {
      if (roomRef.current) {
        try {
          if (activeVideoTrackRef.current) activeVideoTrackRef.current.detach();
          if (activeAudioTrackRef.current) activeAudioTrackRef.current.detach();
          roomRef.current.disconnect();
        } catch (_e) {
          // Ignore cleanup errors
        }
        roomRef.current = null;
      }
    };
  }, [connectToRoom]);

  // Audio mute/unmute control
  const toggleMute = () => {
    if (audioRef.current) {
      audioRef.current.muted = !isMuted;
      setIsMuted(!isMuted);
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
    } catch (_e) {
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
      <audio ref={audioRef} autoPlay playsInline />

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
            {hasRemoteAudio ? (isMuted ? "Muted" : "Live Audio") : "No Audio Feed"}
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
