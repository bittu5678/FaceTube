import { useEffect, useRef, useState, useCallback } from "react";
import {
  Room,
  RoomEvent,
  Track,
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

  const [connectionState, setConnectionState] = useState<ConnectionState>(
    ConnectionState.Disconnected,
  );
  const [isInitializing, setIsInitializing] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);

  // Audio / Video control states
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [facingMode, setFacingMode] = useState<"user" | "environment">("user");
  const [availableCameras, setAvailableCameras] = useState<MediaDeviceInfo[]>([]);
  const [availableMics, setAvailableMics] = useState<MediaDeviceInfo[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string>("");
  const [selectedMicId, setSelectedMicId] = useState<string>("");
  const [showSettings, setShowSettings] = useState(false);

  // Stats and timing
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [viewerCount, setViewerCount] = useState(1);
  const [isEndingStream, setIsEndingStream] = useState(false);

  // Enumerate hardware devices
  const updateDeviceList = useCallback(async () => {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices.filter((d) => d.kind === "videoinput");
      const mics = devices.filter((d) => d.kind === "audioinput");
      setAvailableCameras(cameras);
      setAvailableMics(mics);
      if (cameras[0] && !selectedCameraId) setSelectedCameraId(cameras[0].deviceId);
      if (mics[0] && !selectedMicId) setSelectedMicId(mics[0].deviceId);
    } catch (_e) {
      // Ignore
    }
  }, [selectedCameraId, selectedMicId]);

  // Clean up all local media hardware tracks
  const stopLocalTracks = useCallback(() => {
    for (const track of localTracksRef.current) {
      try {
        track.stop();
        track.detach();
      } catch (_e) {
        // Ignore
      }
    }
    localTracksRef.current = [];
  }, []);

  // Initialize Broadcaster: Obtain JWT Token, capture local tracks, publish to LiveKit Room
  const startBroadcasting = useCallback(async () => {
    if (!streamId) return;

    setIsInitializing(true);
    setPermissionError(null);

    try {
      // 1. Fetch Publisher JWT Token with Broadcaster VideoGrants
      const tokenRes = await api.live.getStreamToken({
        streamId,
        role: "publisher",
      });

      if (!tokenRes.success || !tokenRes.token) {
        throw new Error(
          (tokenRes as any)?.error ||
            "Failed to acquire broadcaster publishing token. You must be the stream owner.",
        );
      }

      // 2. Request camera & microphone permissions and create local media tracks
      let tracks: LocalTrack[] = [];
      try {
        tracks = await createLocalTracks({
          audio: selectedMicId ? { deviceId: { exact: selectedMicId } } : true,
          video: {
            resolution: VideoPresets.h720.resolution,
            facingMode,
            ...(selectedCameraId ? { deviceId: { exact: selectedCameraId } } : {}),
          },
        });
      } catch (mediaErr: any) {
        const errName = mediaErr?.name || "";
        if (errName === "NotAllowedError" || errName === "PermissionDeniedError") {
          throw new Error(
            "Camera & microphone permissions were denied. Please allow access in browser settings.",
          );
        } else if (errName === "NotFoundError" || errName === "DevicesNotFoundError") {
          throw new Error("No camera or microphone device was found on this system.");
        } else if (errName === "NotReadableError" || errName === "TrackStartError") {
          throw new Error("Your camera or microphone is already in use by another application.");
        } else {
          throw new Error(mediaErr?.message || "Failed to access camera and microphone.");
        }
      }

      localTracksRef.current = tracks;

      // Attach local video track to creator's preview screen
      const videoTrack = tracks.find((t) => t.kind === Track.Kind.Video) as
        LocalVideoTrack | undefined;
      if (videoTrack && localVideoRef.current) {
        videoTrack.attach(localVideoRef.current);
      }

      // 3. Connect to LiveKit Room as Authoritative Publisher
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
      });
      roomRef.current = room;

      room.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
        setConnectionState(state);
      });

      room.on(RoomEvent.Disconnected, () => {
        setConnectionState(ConnectionState.Disconnected);
      });

      await room.connect(tokenRes.url, tokenRes.token);

      // 4. Publish real camera and microphone tracks into the LiveKit Room
      for (const track of tracks) {
        await room.localParticipant.publishTrack(track);
      }

      toast.success("🔴 Live broadcast is active! Streaming video & audio to FaceTube.");
      await updateDeviceList();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setPermissionError(msg);
      toast.error(msg);
      stopLocalTracks();
    } finally {
      setIsInitializing(false);
    }
  }, [streamId, facingMode, selectedCameraId, selectedMicId, stopLocalTracks, updateDeviceList]);

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
    setCameraEnabled(nextState);
    if (roomRef.current) {
      try {
        await roomRef.current.localParticipant.setCameraEnabled(nextState);
      } catch (_e) {
        // Fallback
      }
    } else {
      const videoTrack = localTracksRef.current.find((t) => t.kind === Track.Kind.Video) as
        LocalVideoTrack | undefined;
      if (videoTrack) {
        if (nextState) videoTrack.unmute();
        else videoTrack.mute();
      }
    }
  };

  // Flip Mobile Camera (Front / Rear)
  const flipCamera = async () => {
    const newMode = facingMode === "user" ? "environment" : "user";
    setFacingMode(newMode);

    const videoTrack = localTracksRef.current.find((t) => t.kind === Track.Kind.Video) as
      LocalVideoTrack | undefined;
    if (videoTrack) {
      try {
        await videoTrack.restartTrack({ facingMode: newMode });
        if (localVideoRef.current) {
          videoTrack.attach(localVideoRef.current);
        }
        toast.info(`Switched to ${newMode === "user" ? "front" : "rear"} camera`);
      } catch (e: any) {
        toast.error("Failed to switch camera mode.");
      }
    }
  };

  // Switch video input device
  const handleDeviceChange = async (kind: "video" | "audio", deviceId: string) => {
    if (kind === "video") {
      setSelectedCameraId(deviceId);
      const videoTrack = localTracksRef.current.find((t) => t.kind === Track.Kind.Video) as
        LocalVideoTrack | undefined;
      if (videoTrack) {
        try {
          await videoTrack.restartTrack({ deviceId: { exact: deviceId } });
          if (localVideoRef.current) videoTrack.attach(localVideoRef.current);
        } catch (_e) {
          toast.error("Could not switch video source.");
        }
      }
    } else {
      setSelectedMicId(deviceId);
      const audioTrack = localTracksRef.current.find((t) => t.kind === Track.Kind.Audio) as
        LocalAudioTrack | undefined;
      if (audioTrack) {
        try {
          await audioTrack.restartTrack({ deviceId: { exact: deviceId } });
        } catch (_e) {
          toast.error("Could not switch microphone source.");
        }
      }
    }
  };

  // End Live Broadcast
  const handleEndBroadcast = async () => {
    if (isEndingStream) return;
    const confirmEnd = window.confirm(
      "Are you sure you want to end this live broadcast for all viewers?",
    );
    if (!confirmEnd) return;

    setIsEndingStream(true);
    try {
      await api.live.endStream({ streamId });
      toast.success("Broadcast ended successfully. Stream has concluded.");

      stopLocalTracks();
      if (roomRef.current) {
        roomRef.current.disconnect();
        roomRef.current = null;
      }
      onStreamEnded();
      onClose();
    } catch (err: any) {
      toast.error(err?.message || "Failed to end stream on server.");
    } finally {
      setIsEndingStream(false);
    }
  };

  // Lifecycle initialization & teardown on modal open/close
  useEffect(() => {
    if (isOpen) {
      setDurationSeconds(0);
      startBroadcasting();
    } else {
      stopLocalTracks();
      if (roomRef.current) {
        roomRef.current.disconnect();
        roomRef.current = null;
      }
    }

    return () => {
      stopLocalTracks();
      if (roomRef.current) {
        roomRef.current.disconnect();
        roomRef.current = null;
      }
    };
  }, [isOpen, startBroadcasting, stopLocalTracks]);

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
            className={`h-full w-full object-contain ${facingMode === "user" ? "scale-x-[-1]" : ""} ${
              cameraEnabled ? "opacity-100" : "opacity-0"
            }`}
          />

          {/* Camera Off Placeholder */}
          {!cameraEnabled && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-zinc-900 text-zinc-400">
              <VideoOff className="h-14 w-14 opacity-50" />
              <p className="text-sm font-semibold text-zinc-300">Camera is paused</p>
              <p className="text-xs text-zinc-500">Viewers cannot see your video feed</p>
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
        </div>

        {/* Broadcaster Bottom Control Console */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-zinc-800 bg-zinc-900/80 backdrop-blur-sm shrink-0">
          <div className="flex items-center gap-3">
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
              className="flex items-center gap-2 rounded-full bg-zinc-800 px-3.5 py-2 text-xs font-bold text-white hover:bg-zinc-700 transition"
              title="Flip camera (Front / Rear)"
            >
              <SwitchCamera className="h-4 w-4" />
              <span className="hidden sm:inline">Flip Camera</span>
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
