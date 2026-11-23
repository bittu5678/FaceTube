import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import {
  AdMob,
  AdmobConsentStatus,
  BannerAdPosition,
  BannerAdSize,
  RewardAdPluginEvents,
  type AdMobRewardItem,
} from "@capacitor-community/admob";

/**
 * Official Google AdMob Sample Test Ad Unit IDs for Android (development/test ONLY):
 * https://developers.google.com/admob/android/test-ads
 */
export const ADMOB_TEST_IDS = {
  APP_ID: "ca-app-pub-3940256099942544~3347511713",
  BANNER: "ca-app-pub-3940256099942544/6300978111",
  INTERSTITIAL: "ca-app-pub-3940256099942544/1033173712",
  REWARDED: "ca-app-pub-3940256099942544/5224354917",
} as const;

const TEST_ADMOB_PREFIX_RE = /^ca-app-pub-3940256099942544(?:~|\/|$)/i;
const VALID_ADMOB_APP_ID_RE = /^ca-app-pub-\d{16}~\d{10}$/;
const VALID_ADMOB_AD_UNIT_ID_RE = /^ca-app-pub-\d{16}\/\d{10}$/;
const NON_PROD_ENVS = new Set(["development", "dev", "local", "test"]);

export interface AdMobRuntimeEnv {
  MODE?: string | undefined;
  DEV?: boolean | string | undefined;
  PROD?: boolean | string | undefined;
  APP_ENV?: string | undefined;
  NODE_ENV?: string | undefined;
  VITE_ADMOB_APP_ID?: string | undefined;
  VITE_ADMOB_BANNER_AD_UNIT_ID?: string | undefined;
  VITE_ADMOB_INTERSTITIAL_AD_UNIT_ID?: string | undefined;
  VITE_ADMOB_REWARDED_AD_UNIT_ID?: string | undefined;
}

export interface ResolvedAdMobConfig {
  valid: boolean;
  isProduction: boolean;
  isTesting: boolean;
  appId: string;
  bannerAdUnitId: string;
  interstitialAdUnitId: string;
  rewardedAdUnitId: string;
  error?: string;
}

function readClientAdMobEnv(): AdMobRuntimeEnv {
  const metaEnv =
    typeof import.meta !== "undefined"
      ? (import.meta.env as Record<string, unknown> | undefined)
      : undefined;
  const procEnv =
    typeof process !== "undefined" && process.env
      ? (process.env as Record<string, string | undefined>)
      : undefined;

  const readStr = (key: string): string | undefined => {
    const mVal = metaEnv?.[key];
    if (typeof mVal === "string") return mVal;
    const pVal = procEnv?.[key];
    if (typeof pVal === "string") return pVal;
    return undefined;
  };

  return {
    MODE: readStr("MODE"),
    DEV: typeof metaEnv?.["DEV"] === "boolean" ? (metaEnv["DEV"] as boolean) : undefined,
    PROD: typeof metaEnv?.["PROD"] === "boolean" ? (metaEnv["PROD"] as boolean) : undefined,
    APP_ENV: readStr("APP_ENV"),
    NODE_ENV: readStr("NODE_ENV"),
    VITE_ADMOB_APP_ID: readStr("VITE_ADMOB_APP_ID"),
    VITE_ADMOB_BANNER_AD_UNIT_ID: readStr("VITE_ADMOB_BANNER_AD_UNIT_ID"),
    VITE_ADMOB_INTERSTITIAL_AD_UNIT_ID: readStr("VITE_ADMOB_INTERSTITIAL_AD_UNIT_ID"),
    VITE_ADMOB_REWARDED_AD_UNIT_ID: readStr("VITE_ADMOB_REWARDED_AD_UNIT_ID"),
  };
}

export function isAdMobTestId(value: string): boolean {
  return TEST_ADMOB_PREFIX_RE.test(value.trim());
}

/**
 * Resolves AdMob App ID and Ad Unit IDs from environment/build variables.
 * - Development/Test: permits Google test IDs and enables testing flags.
 * - Production (and fail-closed ambiguous environments): requires valid non-test IDs
 *   and disables initializeForTesting / isTesting.
 */
export function resolveAdMobConfig(envOverride?: AdMobRuntimeEnv): ResolvedAdMobConfig {
  const env = envOverride ?? readClientAdMobEnv();
  const prodFlag = env.PROD === true || env.PROD === "true";
  const devFlag = env.DEV === true || env.DEV === "true";

  const mode = (env.MODE ?? "").trim().toLowerCase();
  const appEnv = (env.APP_ENV ?? "").trim().toLowerCase();
  const nodeEnv = (env.NODE_ENV ?? "").trim().toLowerCase();
  const present = [mode, appEnv, nodeEnv].filter((v) => v !== "");

  const hasProductionSignal = prodFlag || present.some((v) => v === "production");
  const allPresentNonProd =
    present.length > 0 ? present.every((v) => NON_PROD_ENVS.has(v)) : devFlag;
  const isProduction = hasProductionSignal || !allPresentNonProd;
  const isTesting = !isProduction;

  const rawAppId = (env.VITE_ADMOB_APP_ID ?? "").trim();
  const rawBanner = (env.VITE_ADMOB_BANNER_AD_UNIT_ID ?? "").trim();
  const rawInterstitial = (env.VITE_ADMOB_INTERSTITIAL_AD_UNIT_ID ?? "").trim();
  const rawRewarded = (env.VITE_ADMOB_REWARDED_AD_UNIT_ID ?? "").trim();

  if (!isProduction) {
    return {
      valid: true,
      isProduction: false,
      isTesting: true,
      appId: rawAppId || ADMOB_TEST_IDS.APP_ID,
      bannerAdUnitId: rawBanner || ADMOB_TEST_IDS.BANNER,
      interstitialAdUnitId: rawInterstitial || ADMOB_TEST_IDS.INTERSTITIAL,
      rewardedAdUnitId: rawRewarded || ADMOB_TEST_IDS.REWARDED,
    };
  }

  const missing: string[] = [];
  if (!rawAppId) missing.push("VITE_ADMOB_APP_ID");
  if (!rawBanner) missing.push("VITE_ADMOB_BANNER_AD_UNIT_ID");
  if (!rawInterstitial) missing.push("VITE_ADMOB_INTERSTITIAL_AD_UNIT_ID");
  if (!rawRewarded) missing.push("VITE_ADMOB_REWARDED_AD_UNIT_ID");

  if (missing.length > 0) {
    return {
      valid: false,
      isProduction: true,
      isTesting: false,
      appId: "",
      bannerAdUnitId: "",
      interstitialAdUnitId: "",
      rewardedAdUnitId: "",
      error: `Production AdMob configuration missing required environment variables: ${missing.join(", ")}.`,
    };
  }

  const allValues = [
    { key: "VITE_ADMOB_APP_ID", val: rawAppId, re: VALID_ADMOB_APP_ID_RE },
    { key: "VITE_ADMOB_BANNER_AD_UNIT_ID", val: rawBanner, re: VALID_ADMOB_AD_UNIT_ID_RE },
    {
      key: "VITE_ADMOB_INTERSTITIAL_AD_UNIT_ID",
      val: rawInterstitial,
      re: VALID_ADMOB_AD_UNIT_ID_RE,
    },
    { key: "VITE_ADMOB_REWARDED_AD_UNIT_ID", val: rawRewarded, re: VALID_ADMOB_AD_UNIT_ID_RE },
  ];

  for (const item of allValues) {
    if (isAdMobTestId(item.val)) {
      return {
        valid: false,
        isProduction: true,
        isTesting: false,
        appId: "",
        bannerAdUnitId: "",
        interstitialAdUnitId: "",
        rewardedAdUnitId: "",
        error: `Google reserved test AdMob ID cannot be used in production (${item.key}).`,
      };
    }
    if (!item.re.test(item.val)) {
      return {
        valid: false,
        isProduction: true,
        isTesting: false,
        appId: "",
        bannerAdUnitId: "",
        interstitialAdUnitId: "",
        rewardedAdUnitId: "",
        error: `Invalid production AdMob ID format for ${item.key}.`,
      };
    }
  }

  return {
    valid: true,
    isProduction: true,
    isTesting: false,
    appId: rawAppId,
    bannerAdUnitId: rawBanner,
    interstitialAdUnitId: rawInterstitial,
    rewardedAdUnitId: rawRewarded,
  };
}

export function requireAdMobConfig(envOverride?: AdMobRuntimeEnv): ResolvedAdMobConfig {
  const resolved = resolveAdMobConfig(envOverride);
  if (!resolved.valid) {
    throw new Error(resolved.error || "Invalid AdMob production configuration.");
  }
  return resolved;
}

export interface AdMobTestingBridge {
  isNativeAndroid?: () => boolean;
  adMob?: Partial<typeof AdMob>;
}

let testBridgeOverride: AdMobTestingBridge | null = null;

function getAdMobClient(): typeof AdMob {
  if (testBridgeOverride?.adMob) {
    return testBridgeOverride.adMob as typeof AdMob;
  }
  return AdMob;
}

export function setAdMobTestingBridge(override: AdMobTestingBridge | null): void {
  testBridgeOverride = override;
  resetAdMobStateForTests();
}

/**
 * Detects whether the current runtime environment is a native Android Capacitor app.
 * Returns false on Web browsers, iOS, and desktop PWAs.
 */
export function isNativeAndroid(): boolean {
  if (testBridgeOverride?.isNativeAndroid) {
    return testBridgeOverride.isNativeAndroid();
  }
  if (typeof window === "undefined") return false;
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
  } catch {
    return false;
  }
}

let isInitialized = false;
let initPromise: Promise<boolean> | null = null;
let consentChecked = false;
let canRequestAdsState = true;
let isBannerVisible = false;
let isBannerDesired = false;
let bannerRequestEpoch = 0;
let isInterstitialLoaded = false;
let isRewardedLoaded = false;
let isRewardedShowing = false;
let interstitialPreloadTimer: ReturnType<typeof setTimeout> | null = null;
let rewardedPreloadTimer: ReturnType<typeof setTimeout> | null = null;

export function canRequestAdMobAds(): boolean {
  return canRequestAdsState;
}

/**
 * Checks Google User Messaging Platform (UMP) consent status on native Android
 * and displays the GDPR/UMP consent form when required.
 * Fails gracefully if UMP is unconfigured or unavailable offline.
 */
export async function ensureAdMobConsent(): Promise<boolean> {
  if (!isNativeAndroid()) return false;
  if (consentChecked) return canRequestAdsState;

  const client = getAdMobClient();
  try {
    if (typeof client.requestConsentInfo !== "function") {
      consentChecked = true;
      canRequestAdsState = true;
      return true;
    }

    let consentInfo = await client.requestConsentInfo();
    if (
      consentInfo.isConsentFormAvailable &&
      consentInfo.status === AdmobConsentStatus.REQUIRED &&
      typeof client.showConsentForm === "function"
    ) {
      consentInfo = await client.showConsentForm();
    }

    canRequestAdsState = consentInfo.canRequestAds !== false;
    consentChecked = true;
    return canRequestAdsState;
  } catch (err) {
    // Allow non-EEA / pre-UMP builds to initialize safely if UMP check fails
    console.warn("[AdMob] UMP consent check unavailable or skipped:", err);
    consentChecked = true;
    canRequestAdsState = true;
    return true;
  }
}

/**
 * Opens Google's UMP Privacy Options form if available on native Android.
 */
export async function showAdMobPrivacyOptions(): Promise<boolean> {
  if (!isNativeAndroid()) return false;
  try {
    await getAdMobClient().showPrivacyOptionsForm();
    return true;
  } catch (err) {
    console.warn("[AdMob] Privacy options form unavailable:", err);
    return false;
  }
}

/**
 * Initializes Google Mobile Ads SDK strictly on native Android.
 * Runs UMP consent check, deduplicates concurrent initialization calls,
 * and fails safely if production configuration is missing or invalid.
 * Safe no-op on Web / PWA.
 */
export async function initializeAdMob(): Promise<boolean> {
  if (!isNativeAndroid()) return false;
  if (isInitialized) return canRequestAdsState;
  if (initPromise) return initPromise;

  const config = resolveAdMobConfig();
  if (!config.valid) {
    console.error("[AdMob] Initialization aborted:", config.error);
    return false;
  }

  initPromise = (async () => {
    try {
      const allowedByConsent = await ensureAdMobConsent();
      if (!allowedByConsent) {
        console.warn("[AdMob] Ad requests blocked by UMP consent status.");
        return false;
      }

      await getAdMobClient().initialize(
        config.isTesting
          ? {
              initializeForTesting: true,
              testingDevices: ["EMULATOR"],
            }
          : {
              initializeForTesting: false,
            },
      );
      isInitialized = true;
      console.info("[AdMob] Google Mobile Ads SDK initialized on Android");
      return true;
    } catch (err) {
      console.warn("[AdMob] Initialization skipped or failed:", err);
      return false;
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

/**
 * Shows an AdMob Banner Ad positioned at the bottom or top of the Android screen.
 * Automatically checks native Android platform, configuration validity, and guards against
 * fast unmount races where hideAdMobBanner() runs while showAdMobBanner() is still pending.
 */
export async function showAdMobBanner(options?: {
  position?: "TOP" | "BOTTOM";
  margin?: number;
}): Promise<boolean> {
  if (!isNativeAndroid()) return false;

  const config = resolveAdMobConfig();
  if (!config.valid) {
    console.error("[AdMob] Banner aborted:", config.error);
    return false;
  }

  const requestEpoch = ++bannerRequestEpoch;
  isBannerDesired = true;

  try {
    const initialized = await initializeAdMob();
    if (!initialized || !isBannerDesired || requestEpoch !== bannerRequestEpoch) {
      return false;
    }

    const position =
      options?.position === "TOP" ? BannerAdPosition.TOP_CENTER : BannerAdPosition.BOTTOM_CENTER;

    await getAdMobClient().showBanner({
      adId: config.bannerAdUnitId,
      adSize: BannerAdSize.BANNER,
      position,
      margin: options?.margin ?? 60, // Above bottom navigation bar on mobile
      isTesting: config.isTesting,
    });

    if (!isBannerDesired || requestEpoch !== bannerRequestEpoch) {
      await getAdMobClient()
        .hideBanner()
        .catch(() => {});
      isBannerVisible = false;
      return false;
    }

    isBannerVisible = true;
    return true;
  } catch (err) {
    console.warn("[AdMob] Failed to show Banner Ad:", err);
    isBannerVisible = false;
    return false;
  }
}

/**
 * Hides the active AdMob Banner ad (and cancels any pending banner show).
 */
export async function hideAdMobBanner(): Promise<void> {
  if (!isNativeAndroid()) return;
  isBannerDesired = false;
  bannerRequestEpoch += 1;
  if (!isBannerVisible) return;
  try {
    await getAdMobClient().hideBanner();
    isBannerVisible = false;
  } catch (err) {
    console.warn("[AdMob] Failed to hide Banner Ad:", err);
  }
}

/**
 * Destroys and removes the banner from view.
 */
export async function removeAdMobBanner(): Promise<void> {
  if (!isNativeAndroid()) return;
  isBannerDesired = false;
  bannerRequestEpoch += 1;
  try {
    await getAdMobClient().removeBanner();
    isBannerVisible = false;
  } catch (err) {
    console.warn("[AdMob] Failed to remove Banner Ad:", err);
  }
}

/**
 * Pre-loads an Interstitial ad in the background.
 */
export async function prepareInterstitialAd(): Promise<boolean> {
  if (!isNativeAndroid()) return false;

  const config = resolveAdMobConfig();
  if (!config.valid) {
    console.error("[AdMob] Interstitial preparation aborted:", config.error);
    isInterstitialLoaded = false;
    return false;
  }

  try {
    const initialized = await initializeAdMob();
    if (!initialized) return false;

    await getAdMobClient().prepareInterstitial({
      adId: config.interstitialAdUnitId,
      isTesting: config.isTesting,
    });
    isInterstitialLoaded = true;
    return true;
  } catch (err) {
    console.warn("[AdMob] Failed to prepare Interstitial Ad:", err);
    isInterstitialLoaded = false;
    return false;
  }
}

/**
 * Checks whether any HTML5 video is actively playing on the page.
 */
export function isAnyVideoPlaying(): boolean {
  if (typeof document === "undefined") return false;
  const videos = document.querySelectorAll("video");
  for (let i = 0; i < videos.length; i++) {
    const v = videos[i];
    if (v && !v.paused && !v.ended && v.readyState > 2) {
      return true;
    }
  }
  return false;
}

/**
 * Shows an Interstitial Ad on Android during natural navigation transitions.
 * STRICT POLICY: Skips showing if active video playback is detected.
 */
export async function showInterstitialAd(options?: { force?: boolean }): Promise<boolean> {
  if (!isNativeAndroid()) return false;

  const config = resolveAdMobConfig();
  if (!config.valid) {
    console.error("[AdMob] Interstitial Ad aborted:", config.error);
    isInterstitialLoaded = false;
    return false;
  }

  // Strict Policy Check: Do NOT interrupt active video playback
  if (!options?.force && isAnyVideoPlaying()) {
    console.info("[AdMob] Skipping Interstitial: Video playback in progress");
    return false;
  }

  try {
    const initialized = await initializeAdMob();
    if (!initialized) return false;

    if (!isInterstitialLoaded) {
      const prepared = await prepareInterstitialAd();
      if (!prepared) return false;
    }
    await getAdMobClient().showInterstitial();
    isInterstitialLoaded = false;
    // Pre-load next interstitial in background
    if (interstitialPreloadTimer) clearTimeout(interstitialPreloadTimer);
    interstitialPreloadTimer = setTimeout(() => {
      interstitialPreloadTimer = null;
      prepareInterstitialAd().catch(() => {});
    }, 15000);
    return true;
  } catch (err) {
    isInterstitialLoaded = false;
    console.warn("[AdMob] Failed to display Interstitial Ad:", err);
    return false;
  }
}

/**
 * Pre-loads a Rewarded Ad.
 */
export async function prepareRewardedAd(): Promise<boolean> {
  if (!isNativeAndroid()) return false;

  const config = resolveAdMobConfig();
  if (!config.valid) {
    console.error("[AdMob] Rewarded preparation aborted:", config.error);
    isRewardedLoaded = false;
    return false;
  }

  try {
    const initialized = await initializeAdMob();
    if (!initialized) return false;

    await getAdMobClient().prepareRewardVideoAd({
      adId: config.rewardedAdUnitId,
      isTesting: config.isTesting,
    });
    isRewardedLoaded = true;
    return true;
  } catch (err) {
    console.warn("[AdMob] Failed to prepare Rewarded Ad:", err);
    isRewardedLoaded = false;
    return false;
  }
}

export interface ShowRewardedOptions {
  userId?: string | null;
  rewardType?: string;
  onRewardEarned: (reward: AdMobRewardItem) => void;
  onDismissed?: () => void;
  onError?: (error: unknown) => void;
}

/**
 * Shows a user-initiated Rewarded Ad.
 * STRICT RULE: Only awards rewards upon genuine verified completion callback,
 * cleans up native event listeners on all exit paths, and resets stale state on errors.
 */
export async function showRewardedAd(options: ShowRewardedOptions): Promise<boolean> {
  if (!isNativeAndroid()) {
    options.onError?.(
      new Error("Rewarded ads are only available in the Android mobile application."),
    );
    return false;
  }

  if (isRewardedShowing) {
    options.onError?.(new Error("A rewarded ad is already being displayed."));
    return false;
  }

  const config = resolveAdMobConfig();
  if (!config.valid) {
    console.error("[AdMob] Rewarded Ad aborted:", config.error);
    options.onError?.(new Error(config.error || "Invalid AdMob production configuration."));
    return false;
  }

  const handles: PluginListenerHandle[] = [];
  let listenersCleaned = false;
  let dismissNotified = false;

  const cleanupListeners = () => {
    if (listenersCleaned) return;
    listenersCleaned = true;
    for (const h of handles) {
      Promise.resolve(h.remove()).catch(() => {});
    }
  };

  const notifyDismissedOnce = () => {
    if (dismissNotified) return;
    dismissNotified = true;
    options.onDismissed?.();
  };

  isRewardedShowing = true;
  const client = getAdMobClient();

  try {
    const initialized = await initializeAdMob();
    if (!initialized) {
      isRewardedShowing = false;
      options.onError?.(new Error("AdMob SDK could not be initialized."));
      return false;
    }
    if (!isRewardedLoaded) {
      const prepared = await prepareRewardedAd();
      if (!prepared) {
        isRewardedShowing = false;
        options.onError?.(new Error("Rewarded ad could not be prepared."));
        return false;
      }
    }

    handles.push(
      await (client.addListener as any)(
        RewardAdPluginEvents.Rewarded,
        (reward: AdMobRewardItem) => {
          options.onRewardEarned(reward);
        },
      ),
    );

    handles.push(
      await (client.addListener as any)(RewardAdPluginEvents.Dismissed, () => {
        cleanupListeners();
        isRewardedLoaded = false;
        isRewardedShowing = false;
        notifyDismissedOnce();
        // Prepare next reward in background
        if (rewardedPreloadTimer) clearTimeout(rewardedPreloadTimer);
        rewardedPreloadTimer = setTimeout(() => {
          rewardedPreloadTimer = null;
          prepareRewardedAd().catch(() => {});
        }, 10000);
      }),
    );

    handles.push(
      await (client.addListener as any)(RewardAdPluginEvents.FailedToShow, (error: unknown) => {
        cleanupListeners();
        isRewardedLoaded = false;
        isRewardedShowing = false;
        options.onError?.(error);
      }),
    );

    await client.showRewardVideoAd();
    return true;
  } catch (err: any) {
    cleanupListeners();
    isRewardedShowing = false;
    const errCode = String(err?.code || "").toUpperCase();
    const errMsg = String(err?.message || "").toLowerCase();

    if (errCode === "REWARDED_AD_CANCELLED" || errMsg.includes("dismissed before earning")) {
      isRewardedLoaded = false;
      notifyDismissedOnce();
      if (rewardedPreloadTimer) clearTimeout(rewardedPreloadTimer);
      rewardedPreloadTimer = setTimeout(() => {
        rewardedPreloadTimer = null;
        prepareRewardedAd().catch(() => {});
      }, 10000);
      return false;
    }

    if (errCode !== "REWARDED_AD_ALREADY_SHOWING") {
      isRewardedLoaded = false;
    }
    console.warn("[AdMob] Failed to display Rewarded Ad:", err);
    options.onError?.(err);
    return false;
  }
}

export function resetAdMobStateForTests(): void {
  if (interstitialPreloadTimer) {
    clearTimeout(interstitialPreloadTimer);
    interstitialPreloadTimer = null;
  }
  if (rewardedPreloadTimer) {
    clearTimeout(rewardedPreloadTimer);
    rewardedPreloadTimer = null;
  }
  isInitialized = false;
  initPromise = null;
  consentChecked = false;
  canRequestAdsState = true;
  isBannerVisible = false;
  isBannerDesired = false;
  bannerRequestEpoch = 0;
  isInterstitialLoaded = false;
  isRewardedLoaded = false;
  isRewardedShowing = false;
}
