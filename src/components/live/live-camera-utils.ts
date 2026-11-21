export type CameraFacingMode = "user" | "environment";

export interface CameraDeviceLike {
  deviceId: string;
  kind?: string;
  label?: string;
}

export interface VideoTrackSettingsLike {
  deviceId?: string;
  facingMode?: string;
}

export interface VideoTrackAdapter {
  isMuted?: boolean;
  mediaStreamTrack?: {
    getSettings?: () => VideoTrackSettingsLike;
    label?: string;
    readyState?: string;
  };
  restartTrack: (options: Record<string, unknown>) => Promise<void>;
  setDeviceId?: (deviceId: ConstrainDOMString) => Promise<boolean>;
}

export interface SwitchCameraParams {
  videoTrack: VideoTrackAdapter | null | undefined;
  targetMode: CameraFacingMode;
  previousMode: CameraFacingMode;
  previousDeviceId?: string | undefined;
  resolution?: unknown;
  enumerateCameras?: (() => Promise<CameraDeviceLike[]>) | undefined;
}

export interface SwitchCameraResult {
  success: boolean;
  facingMode: CameraFacingMode;
  deviceId: string;
  restoredPrevious?: boolean;
  reason?: "no-track" | "unavailable" | "permission" | "busy" | "failed";
  message: string;
}

export interface SwitchVideoDeviceParams {
  videoTrack: VideoTrackAdapter | null | undefined;
  deviceId: string;
  previousDeviceId?: string | undefined;
  previousMode: CameraFacingMode;
  resolution?: unknown;
  deviceLabel?: string | undefined;
}

export interface SwitchVideoDeviceResult {
  success: boolean;
  deviceId: string;
  facingMode: CameraFacingMode;
  restoredPrevious?: boolean;
  reason?: "no-track" | "unavailable" | "permission" | "busy" | "failed";
  message: string;
}

const REAR_LABEL_REGEX = /\b(back|rear|environment|world)\b|facing\s*back|traseira|trasera|rück/i;
const FRONT_LABEL_REGEX = /\b(front|user|selfie|facetime)\b|facing\s*front|frontal/i;
const SECONDARY_REAR_REGEX = /\b(ultra|wide|telephoto|macro|depth|ir|tof)\b/i;

export function isRearCameraLabel(label?: string): boolean {
  if (!label) return false;
  return REAR_LABEL_REGEX.test(label) && !FRONT_LABEL_REGEX.test(label);
}

export function isFrontCameraLabel(label?: string): boolean {
  if (!label) return false;
  return FRONT_LABEL_REGEX.test(label) && !REAR_LABEL_REGEX.test(label);
}

export function inferFacingModeFromCamera(
  settings?: VideoTrackSettingsLike | null,
  label?: string,
  fallback: CameraFacingMode = "user",
): CameraFacingMode {
  const raw = typeof settings?.facingMode === "string" ? settings.facingMode.toLowerCase() : "";
  if (raw === "environment") return "environment";
  if (raw === "user") return "user";
  if (isRearCameraLabel(label)) return "environment";
  if (isFrontCameraLabel(label)) return "user";
  return fallback;
}

export function selectCameraCandidate(
  cameras: CameraDeviceLike[],
  targetMode: CameraFacingMode,
  currentDeviceId?: string,
): { device: CameraDeviceLike | null; matchedByLabel: boolean } {
  const videoInputs = cameras.filter(
    (cam) => Boolean(cam.deviceId) && (cam.kind === undefined || cam.kind === "videoinput"),
  );

  if (videoInputs.length === 0) {
    return { device: null, matchedByLabel: false };
  }

  const labelMatcher = targetMode === "environment" ? isRearCameraLabel : isFrontCameraLabel;
  const labelMatches = videoInputs.filter((cam) => labelMatcher(cam.label));

  if (labelMatches.length > 0) {
    const nonCurrentMatches = labelMatches.filter((cam) => cam.deviceId !== currentDeviceId);
    const pool = nonCurrentMatches.length > 0 ? nonCurrentMatches : labelMatches;
    const primaryMatch =
      targetMode === "environment"
        ? (pool.find((cam) => !SECONDARY_REAR_REGEX.test(cam.label || "")) ?? pool[0])
        : pool[0];
    return { device: primaryMatch ?? null, matchedByLabel: Boolean(primaryMatch) };
  }

  // Fallback when labels are generic or redacted: pick another distinct videoinput device if >= 2 exist
  if (videoInputs.length >= 2) {
    const alternate = videoInputs.find((cam) => cam.deviceId !== currentDeviceId);
    if (alternate) {
      return { device: alternate, matchedByLabel: false };
    }
  }

  return { device: null, matchedByLabel: false };
}

export function classifyCameraError(
  err: unknown,
  targetMode?: CameraFacingMode,
): {
  kind: "permission" | "unavailable" | "busy" | "overconstrained" | "unknown";
  message: string;
} {
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

  if (
    name === "NotAllowedError" ||
    name === "PermissionDeniedError" ||
    /permission|denied/i.test(rawMessage)
  ) {
    return {
      kind: "permission",
      message: "Camera permission was denied. Please allow camera access in browser settings.",
    };
  }

  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return {
      kind: "unavailable",
      message:
        targetMode === "environment"
          ? "Back camera is not available on this device."
          : targetMode === "user"
            ? "Front camera is not available on this device."
            : "No camera device was found on this device.",
    };
  }

  if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
    return {
      kind: "overconstrained",
      message:
        targetMode === "environment"
          ? "Back camera is not supported on this device."
          : targetMode === "user"
            ? "Front camera is not supported on this device."
            : "The selected camera is not supported on this device.",
    };
  }

  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return {
      kind: "busy",
      message: "Camera is busy or currently in use by another application.",
    };
  }

  return {
    kind: "unknown",
    message: rawMessage || "Failed to switch camera.",
  };
}

function didCameraSwitch(
  afterSettings: VideoTrackSettingsLike,
  afterLabel: string,
  targetMode: CameraFacingMode,
  beforeDeviceId: string,
  expectedDeviceId?: string,
): boolean {
  const afterFacing =
    typeof afterSettings.facingMode === "string" ? afterSettings.facingMode.toLowerCase() : "";
  if (afterFacing === targetMode) {
    return true;
  }
  if (targetMode === "environment" && isRearCameraLabel(afterLabel)) {
    return true;
  }
  if (targetMode === "user" && isFrontCameraLabel(afterLabel)) {
    return true;
  }
  if (expectedDeviceId && afterSettings.deviceId === expectedDeviceId) {
    return true;
  }
  if (beforeDeviceId && afterSettings.deviceId && afterSettings.deviceId !== beforeDeviceId) {
    return true;
  }
  return false;
}

export async function switchCameraWithFallback({
  videoTrack,
  targetMode,
  previousMode,
  previousDeviceId = "",
  resolution,
  enumerateCameras,
}: SwitchCameraParams): Promise<SwitchCameraResult> {
  if (!videoTrack) {
    return {
      success: false,
      facingMode: previousMode,
      deviceId: previousDeviceId,
      reason: "no-track",
      message: "Camera is not active yet. Start your camera before switching.",
    };
  }

  const beforeSettings = videoTrack.mediaStreamTrack?.getSettings?.() ?? {};
  const beforeDeviceId = beforeSettings.deviceId || previousDeviceId || "";
  const beforeLabel = videoTrack.mediaStreamTrack?.label || "";

  let cameras: CameraDeviceLike[] = [];
  if (enumerateCameras) {
    try {
      cameras = (await enumerateCameras()).filter(
        (d) => d.kind === undefined || d.kind === "videoinput",
      );
    } catch {
      cameras = [];
    }
  }

  // If only 1 camera is present on the device, fail gracefully without interrupting the active track
  if (cameras.length === 1) {
    const onlyCamera = cameras[0];
    const onlyLabel = onlyCamera?.label || beforeLabel;
    const onlyIsRear = beforeSettings.facingMode === "environment" || isRearCameraLabel(onlyLabel);
    if (targetMode === "environment" && !onlyIsRear) {
      return {
        success: false,
        facingMode: previousMode,
        deviceId: beforeDeviceId,
        reason: "unavailable",
        message: "Back camera is not available on this device.",
      };
    }
    if (targetMode === "user" && onlyIsRear && !isFrontCameraLabel(onlyLabel)) {
      return {
        success: false,
        facingMode: previousMode,
        deviceId: beforeDeviceId,
        reason: "unavailable",
        message: "Front camera is not available on this device.",
      };
    }
  }

  const { device: candidateDevice, matchedByLabel } = selectCameraCandidate(
    cameras,
    targetMode,
    beforeDeviceId,
  );

  // If track is currently muted/paused, queue device change if a distinct target device is known
  if (videoTrack.isMuted && videoTrack.setDeviceId) {
    if (!candidateDevice) {
      return {
        success: false,
        facingMode: previousMode,
        deviceId: beforeDeviceId,
        reason: "unavailable",
        message:
          targetMode === "environment"
            ? "Back camera is not available on this device."
            : "Front camera is not available on this device.",
      };
    }
    await videoTrack.setDeviceId({ exact: candidateDevice.deviceId });
    return {
      success: true,
      facingMode: targetMode,
      deviceId: candidateDevice.deviceId,
      message: `Switched to ${targetMode === "user" ? "front" : "rear"} camera`,
    };
  }

  const resConstraint = resolution ? { resolution } : {};
  const attempts: Array<{
    options: Record<string, unknown>;
    expectedDeviceId?: string;
    requireVerifiedSwitch: boolean;
  }> = [
    // 1. Exact facingMode works across Android Chrome & iOS Safari and selects the primary front/rear lens
    {
      options: { facingMode: { exact: targetMode }, ...resConstraint },
      requireVerifiedSwitch: Boolean(
        candidateDevice && candidateDevice.deviceId !== beforeDeviceId,
      ),
    },
  ];

  // 2. Explicit deviceId fallback (crucial for Android WebViews / desktops where exact facingMode fails or stays on default camera)
  if (candidateDevice) {
    attempts.push({
      options: { deviceId: { exact: candidateDevice.deviceId }, ...resConstraint },
      expectedDeviceId: candidateDevice.deviceId,
      requireVerifiedSwitch: !matchedByLabel && cameras.length < 2,
    });
    if (resolution) {
      attempts.push({
        options: { deviceId: { exact: candidateDevice.deviceId } },
        expectedDeviceId: candidateDevice.deviceId,
        requireVerifiedSwitch: false,
      });
    }
  }

  // 3. Soft facingMode fallback when enumerateDevices could not list devices
  if (cameras.length === 0) {
    attempts.push({
      options: { facingMode: targetMode, ...resConstraint },
      requireVerifiedSwitch: true,
    });
  }

  let attemptedRestart = false;
  let lastError: unknown = null;

  for (const attempt of attempts) {
    attemptedRestart = true;
    try {
      await videoTrack.restartTrack(attempt.options);
      const afterSettings = videoTrack.mediaStreamTrack?.getSettings?.() ?? {};
      const afterLabel = videoTrack.mediaStreamTrack?.label || candidateDevice?.label || "";

      if (
        attempt.requireVerifiedSwitch &&
        !didCameraSwitch(
          afterSettings,
          afterLabel,
          targetMode,
          beforeDeviceId,
          attempt.expectedDeviceId,
        )
      ) {
        lastError = Object.assign(new Error("Camera did not switch to requested facingMode."), {
          name: "OverconstrainedError",
        });
        continue;
      }

      const resolvedDeviceId = afterSettings.deviceId || attempt.expectedDeviceId || beforeDeviceId;
      const resolvedMode = inferFacingModeFromCamera(afterSettings, afterLabel, targetMode);

      return {
        success: true,
        facingMode: resolvedMode,
        deviceId: resolvedDeviceId,
        message: `Switched to ${targetMode === "user" ? "front" : "rear"} camera`,
      };
    } catch (err) {
      lastError = err;
      const classified = classifyCameraError(err, targetMode);
      // Permission denial should stop immediately without retrying other camera constraints
      if (classified.kind === "permission") {
        return {
          success: false,
          facingMode: previousMode,
          deviceId: beforeDeviceId,
          restoredPrevious: false,
          reason: "permission",
          message: classified.message,
        };
      }
    }
  }

  // All switch attempts failed: restore previous camera so active broadcast doesn't remain black/stopped
  const classified = classifyCameraError(lastError, targetMode);
  let restoredPrevious = false;
  if (attemptedRestart) {
    try {
      const restoreOptions: Record<string, unknown> = beforeDeviceId
        ? { deviceId: { exact: beforeDeviceId }, ...resConstraint }
        : { facingMode: previousMode, ...resConstraint };
      await videoTrack.restartTrack(restoreOptions);
      restoredPrevious = true;
    } catch {
      restoredPrevious = false;
    }
  }

  const reason =
    classified.kind === "unavailable" || classified.kind === "overconstrained"
      ? "unavailable"
      : classified.kind === "busy"
        ? "busy"
        : "failed";

  return {
    success: false,
    facingMode: previousMode,
    deviceId: beforeDeviceId,
    restoredPrevious,
    reason,
    message:
      reason === "unavailable"
        ? classified.message
        : restoredPrevious
          ? `${classified.message} Kept your previous camera active.`
          : classified.message,
  };
}

export async function switchVideoDeviceSafely({
  videoTrack,
  deviceId,
  previousDeviceId = "",
  previousMode,
  resolution,
  deviceLabel,
}: SwitchVideoDeviceParams): Promise<SwitchVideoDeviceResult> {
  if (!videoTrack) {
    return {
      success: false,
      deviceId: previousDeviceId,
      facingMode: previousMode,
      reason: "no-track",
      message: "Camera is not active yet.",
    };
  }

  const beforeSettings = videoTrack.mediaStreamTrack?.getSettings?.() ?? {};
  const fallbackDeviceId = beforeSettings.deviceId || previousDeviceId || "";
  const resConstraint = resolution ? { resolution } : {};

  try {
    await videoTrack.restartTrack({ deviceId: { exact: deviceId }, ...resConstraint });
    const afterSettings = videoTrack.mediaStreamTrack?.getSettings?.() ?? {};
    const afterLabel = videoTrack.mediaStreamTrack?.label || deviceLabel || "";
    return {
      success: true,
      deviceId: afterSettings.deviceId || deviceId,
      facingMode: inferFacingModeFromCamera(afterSettings, afterLabel, previousMode),
      message: "Switched video source.",
    };
  } catch (err) {
    const classified = classifyCameraError(err);
    if (classified.kind === "permission") {
      return {
        success: false,
        deviceId: fallbackDeviceId,
        facingMode: previousMode,
        restoredPrevious: false,
        reason: "permission",
        message: classified.message,
      };
    }

    let restoredPrevious = false;
    try {
      const restoreOpts: Record<string, unknown> = fallbackDeviceId
        ? { deviceId: { exact: fallbackDeviceId }, ...resConstraint }
        : { facingMode: previousMode, ...resConstraint };
      await videoTrack.restartTrack(restoreOpts);
      restoredPrevious = true;
    } catch {
      restoredPrevious = false;
    }

    return {
      success: false,
      deviceId: fallbackDeviceId,
      facingMode: previousMode,
      restoredPrevious,
      reason: classified.kind === "busy" ? "busy" : "failed",
      message: restoredPrevious
        ? "Could not switch video source. Kept previous camera active."
        : "Could not switch video source.",
    };
  }
}

export interface ScreenShareSupportEnv {
  mediaDevices?: { getDisplayMedia?: unknown } | null | undefined;
  userAgent?: string | undefined;
  isSecureContext?: boolean | undefined;
  isNativeCapacitorAndroid?: boolean | undefined;
}

export interface ScreenShareSupportResult {
  supported: boolean;
  isNativeAndroidWebView: boolean;
  reason: "supported" | "insecure-context" | "native-android-unsupported" | "unsupported-browser";
  message: string;
}

export interface ScreenShareTrackLike {
  kind?: string;
  source?: unknown;
  isMuted?: boolean;
  mediaStreamTrack?: {
    readyState?: string;
    addEventListener?(event: string, listener: () => void): void;
    removeEventListener?(event: string, listener: () => void): void;
  };
  on?(event: string, listener: () => void): void;
  off?(event: string, listener: () => void): void;
  attach?(element: HTMLVideoElement): void;
  detach?(element?: HTMLVideoElement): void;
  stop?(): void;
}

export interface ScreenSharePublicationLike<
  TTrack extends ScreenShareTrackLike = ScreenShareTrackLike,
> {
  track?: TTrack | undefined;
}

export interface ScreenShareParticipantAdapter<
  TSource = unknown,
  TTrack extends ScreenShareTrackLike = ScreenShareTrackLike,
> {
  getTrackPublication(source: TSource): ScreenSharePublicationLike<TTrack> | undefined;
  setScreenShareEnabled(
    enabled: boolean,
    options?: Record<string, unknown>,
  ): Promise<ScreenSharePublicationLike<TTrack> | undefined>;
  unpublishTrack?(track: TTrack, stopOnUnpublish?: boolean): Promise<unknown>;
}

export interface StartScreenShareResult<
  TTrack extends ScreenShareTrackLike = ScreenShareTrackLike,
> {
  success: boolean;
  active: boolean;
  alreadyActive?: boolean;
  publication?: ScreenSharePublicationLike<TTrack> | undefined;
  reason?: "unsupported" | "not-connected" | "cancelled" | "permission" | "unavailable" | "failed";
  message: string;
}

export interface StopScreenShareResult {
  success: boolean;
  active: false;
  stoppedTracks: number;
}

export function detectScreenShareSupport(env?: ScreenShareSupportEnv): ScreenShareSupportResult {
  const ua = env?.userAgent ?? (typeof navigator !== "undefined" ? navigator.userAgent || "" : "");
  const isNativeAndroidWebView = Boolean(
    env?.isNativeCapacitorAndroid || /FaceTubeAndroidApp\//i.test(ua),
  );
  const isSecure =
    env?.isSecureContext !== undefined
      ? env.isSecureContext
      : typeof window !== "undefined"
        ? window.isSecureContext
        : true;

  if (isSecure === false) {
    return {
      supported: false,
      isNativeAndroidWebView,
      reason: "insecure-context",
      message: "Screen sharing requires a secure HTTPS connection.",
    };
  }

  const mediaDevices =
    env && "mediaDevices" in env
      ? env.mediaDevices
      : typeof navigator !== "undefined"
        ? navigator.mediaDevices
        : undefined;

  const hasGetDisplayMedia = typeof mediaDevices?.getDisplayMedia === "function";

  if (!hasGetDisplayMedia) {
    if (isNativeAndroidWebView) {
      return {
        supported: false,
        isNativeAndroidWebView: true,
        reason: "native-android-unsupported",
        message:
          "Screen sharing is not supported inside the Android app WebView yet. Use a supported desktop or mobile browser.",
      };
    }

    return {
      supported: false,
      isNativeAndroidWebView: false,
      reason: "unsupported-browser",
      message: "Screen sharing is not supported on this browser or device.",
    };
  }

  return {
    supported: true,
    isNativeAndroidWebView,
    reason: "supported",
    message: "",
  };
}

export function classifyScreenShareError(err: unknown): {
  kind: "cancelled" | "permission" | "unsupported" | "unavailable" | "failed";
  message: string;
} {
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

  if (name === "AbortError" || /cancel/i.test(rawMessage)) {
    return {
      kind: "cancelled",
      message: "Screen share selection was cancelled.",
    };
  }

  if (
    name === "NotAllowedError" ||
    name === "PermissionDeniedError" ||
    /permission|denied/i.test(rawMessage)
  ) {
    return {
      kind: "permission",
      message: "Screen sharing permission was denied or cancelled.",
    };
  }

  if (
    name === "NotSupportedError" ||
    name === "DeviceUnsupportedError" ||
    name === "TypeError" ||
    /getDisplayMedia\s+not\s+supported|not\s+supported/i.test(rawMessage)
  ) {
    return {
      kind: "unsupported",
      message: "Screen sharing is not supported by this browser or device.",
    };
  }

  if (
    name === "NotFoundError" ||
    name === "OverconstrainedError" ||
    name === "ConstraintNotSatisfiedError"
  ) {
    return {
      kind: "unavailable",
      message: "No shareable screen, window, or browser tab was found.",
    };
  }

  if (name === "NotReadableError" || name === "TrackStartError") {
    return {
      kind: "failed",
      message: "Could not capture the selected screen. It may be busy or protected.",
    };
  }

  return {
    kind: "failed",
    message: rawMessage || "Could not start screen sharing.",
  };
}

export async function startScreenShareSafely<
  TSource = unknown,
  TTrack extends ScreenShareTrackLike = ScreenShareTrackLike,
>(params: {
  participant: ScreenShareParticipantAdapter<TSource, TTrack> | null | undefined;
  screenShareSource: TSource;
  screenAudioSource?: TSource | undefined;
  supportEnv?: ScreenShareSupportEnv | undefined;
}): Promise<StartScreenShareResult<TTrack>> {
  const { participant, screenShareSource, screenAudioSource, supportEnv } = params;

  const support = detectScreenShareSupport(supportEnv);
  if (!support.supported) {
    return {
      success: false,
      active: false,
      reason: "unsupported",
      message: support.message,
    };
  }

  if (!participant) {
    return {
      success: false,
      active: false,
      reason: "not-connected",
      message: "Connect to the live room before sharing your screen.",
    };
  }

  // Prevent duplicate screen tracks if one is already published and live
  const existingPub = participant.getTrackPublication(screenShareSource);
  if (existingPub?.track && existingPub.track.mediaStreamTrack?.readyState !== "ended") {
    return {
      success: true,
      active: true,
      alreadyActive: true,
      publication: existingPub,
      message: "Screen sharing is already active.",
    };
  }

  // Clean up any stale ended screen track before starting fresh
  if (existingPub?.track) {
    await stopScreenShareSafely({
      participant,
      screenShareSource,
      screenAudioSource,
    });
  }

  const attemptOptions: Array<Record<string, unknown>> = [
    {
      audio: true,
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include",
    },
    {
      audio: false,
    },
  ];

  let lastError: unknown = null;

  for (let idx = 0; idx < attemptOptions.length; idx += 1) {
    const opts = attemptOptions[idx];
    try {
      const pub = await participant.setScreenShareEnabled(true, opts);
      const resolvedPub = pub ?? participant.getTrackPublication(screenShareSource);

      if (!resolvedPub?.track) {
        await stopScreenShareSafely({
          participant,
          screenShareSource,
          screenAudioSource,
        });
        return {
          success: false,
          active: false,
          reason: "failed",
          message: "Screen share track could not be started.",
        };
      }

      return {
        success: true,
        active: true,
        alreadyActive: false,
        publication: resolvedPub,
        message: "Screen sharing started. Viewers can now see your shared screen.",
      };
    } catch (err) {
      lastError = err;
      const classified = classifyScreenShareError(err);
      // Do not retry if user cancelled or denied permission
      if (classified.kind === "cancelled" || classified.kind === "permission") {
        return {
          success: false,
          active: false,
          reason: classified.kind,
          message: classified.message,
        };
      }
      // Only fall back to { audio: false } when initial options failed with constraint/support issues
      if (idx === 0 && (classified.kind === "unsupported" || classified.kind === "unavailable")) {
        continue;
      }
      break;
    }
  }

  const classified = classifyScreenShareError(lastError);
  return {
    success: false,
    active: false,
    reason: classified.kind,
    message: classified.message,
  };
}

export async function stopScreenShareSafely<
  TSource = unknown,
  TTrack extends ScreenShareTrackLike = ScreenShareTrackLike,
>(params: {
  participant: ScreenShareParticipantAdapter<TSource, TTrack> | null | undefined;
  screenShareSource: TSource;
  screenAudioSource?: TSource | undefined;
}): Promise<StopScreenShareResult> {
  const { participant, screenShareSource, screenAudioSource } = params;
  if (!participant) {
    return { success: true, active: false, stoppedTracks: 0 };
  }

  let stoppedTracks = 0;

  try {
    await participant.setScreenShareEnabled(false);
  } catch {
    // Continue defensive track cleanup below
  }

  const sources = [screenShareSource, screenAudioSource].filter(
    (s) => s !== undefined && s !== null,
  );
  for (const source of sources) {
    const pub = participant.getTrackPublication(source);
    if (pub?.track) {
      stoppedTracks += 1;
      try {
        pub.track.detach?.();
      } catch {
        // Ignore
      }
      try {
        if (participant.unpublishTrack) {
          await participant.unpublishTrack(pub.track, true);
        }
      } catch {
        // Ignore
      }
      try {
        pub.track.stop?.();
      } catch {
        // Ignore
      }
    }
  }

  return {
    success: true,
    active: false,
    stoppedTracks,
  };
}
