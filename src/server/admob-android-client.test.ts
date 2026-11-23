import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AdmobConsentStatus, RewardAdPluginEvents } from "@capacitor-community/admob";
import {
  ADMOB_TEST_IDS,
  canRequestAdMobAds,
  hideAdMobBanner,
  initializeAdMob,
  isNativeAndroid,
  prepareInterstitialAd,
  prepareRewardedAd,
  requireAdMobConfig,
  resetAdMobStateForTests,
  resolveAdMobConfig,
  setAdMobTestingBridge,
  showAdMobBanner,
  showAdMobPrivacyOptions,
  showInterstitialAd,
  showRewardedAd,
} from "../lib/admob-service.ts";

describe("AdMob Android Phase 1 — Build Readiness & Client Integration Audit", () => {
  const prevNodeEnv = process.env["NODE_ENV"];
  const prevAppEnv = process.env["APP_ENV"];

  beforeEach(() => {
    process.env["NODE_ENV"] = "test";
    process.env["APP_ENV"] = "test";
    setAdMobTestingBridge(null);
    resetAdMobStateForTests();
  });

  afterEach(() => {
    setAdMobTestingBridge(null);
    resetAdMobStateForTests();
    if (prevNodeEnv === undefined) delete process.env["NODE_ENV"];
    else process.env["NODE_ENV"] = prevNodeEnv;
    if (prevAppEnv === undefined) delete process.env["APP_ENV"];
    else process.env["APP_ENV"] = prevAppEnv;
  });

  it("1. AndroidManifest.xml declares AdMob placeholder plus Internet, Network, and LiveKit Camera/Audio permissions", () => {
    const manifest = fs.readFileSync(
      path.resolve(process.cwd(), "android/app/src/main/AndroidManifest.xml"),
      "utf8",
    );

    assert.ok(manifest.includes("com.google.android.gms.ads.APPLICATION_ID"));
    assert.ok(manifest.includes("${admobApplicationId}"));
    assert.ok(!manifest.includes("3940256099942544"));

    for (const perm of [
      "android.permission.INTERNET",
      "android.permission.ACCESS_NETWORK_STATE",
      "android.permission.CAMERA",
      "android.permission.RECORD_AUDIO",
      "android.permission.MODIFY_AUDIO_SETTINGS",
    ]) {
      assert.ok(manifest.includes(perm), `Manifest must declare ${perm}`);
    }

    assert.ok(manifest.includes('android:name="android.hardware.camera" android:required="false"'));
    assert.ok(
      manifest.includes('android:name="android.hardware.microphone" android:required="false"'),
    );
  });

  it("2. Capacitor and Gradle configurations preserve appId, AdMob plugin wiring, and release safety gate", () => {
    const capConfig = fs.readFileSync(path.resolve(process.cwd(), "capacitor.config.ts"), "utf8");
    const appGradle = fs.readFileSync(
      path.resolve(process.cwd(), "android/app/build.gradle"),
      "utf8",
    );
    const capGradle = fs.readFileSync(
      path.resolve(process.cwd(), "android/app/capacitor.build.gradle"),
      "utf8",
    );
    const capSettings = fs.readFileSync(
      path.resolve(process.cwd(), "android/capacitor.settings.gradle"),
      "utf8",
    );

    assert.ok(capConfig.includes('appId: "online.facetube.app"'));
    assert.ok(!capConfig.includes("initializeForTesting: true"));
    assert.ok(appGradle.includes('applicationId "online.facetube.app"'));
    assert.ok(appGradle.includes("admobApplicationId"));
    assert.ok(appGradle.includes("GradleException"));
    assert.ok(appGradle.includes('project.findProperty("VITE_ADMOB_APP_ID")'));
    assert.ok(capGradle.includes("JavaVersion.VERSION_21"));
    assert.ok(capGradle.includes("implementation project(':capacitor-community-admob')"));
    assert.ok(capSettings.includes("include ':capacitor-community-admob'"));
  });

  it("3. Deduplicates concurrent initializeAdMob calls and handles UMP consent gating safely", async () => {
    let initCalls = 0;
    let consentFormCalls = 0;

    setAdMobTestingBridge({
      isNativeAndroid: () => true,
      adMob: {
        requestConsentInfo: async () => ({
          status: AdmobConsentStatus.REQUIRED,
          isConsentFormAvailable: true,
          canRequestAds: false,
          privacyOptionsRequirementStatus: "REQUIRED" as any,
        }),
        showConsentForm: async () => {
          consentFormCalls += 1;
          return {
            status: AdmobConsentStatus.OBTAINED,
            canRequestAds: true,
            privacyOptionsRequirementStatus: "REQUIRED" as any,
          };
        },
        showPrivacyOptionsForm: async () => {},
        initialize: async () => {
          initCalls += 1;
          await new Promise((r) => setTimeout(r, 10));
        },
      },
    });

    assert.equal(isNativeAndroid(), true);
    const [r1, r2] = await Promise.all([initializeAdMob(), initializeAdMob()]);
    assert.equal(r1, true);
    assert.equal(r2, true);
    assert.equal(consentFormCalls, 1);
    assert.equal(initCalls, 1);
    assert.equal(canRequestAdMobAds(), true);
    assert.equal(await showAdMobPrivacyOptions(), true);

    // Blocks ad requests when UMP reports canRequestAds: false
    setAdMobTestingBridge({
      isNativeAndroid: () => true,
      adMob: {
        requestConsentInfo: async () => ({
          status: AdmobConsentStatus.REQUIRED,
          isConsentFormAvailable: true,
          canRequestAds: false,
          privacyOptionsRequirementStatus: "REQUIRED" as any,
        }),
        showConsentForm: async () => ({
          status: AdmobConsentStatus.REQUIRED,
          canRequestAds: false,
          privacyOptionsRequirementStatus: "REQUIRED" as any,
        }),
        initialize: async () => {
          throw new Error("Should not initialize when consent blocks ads");
        },
      },
    });

    assert.equal(await initializeAdMob(), false);
    assert.equal(canRequestAdMobAds(), false);
  });

  it("4. Prevents banner unmount race from leaving a sticky overlay after navigation", async () => {
    let showBannerCount = 0;
    let hideBannerCount = 0;
    let resolveShow!: () => void;

    setAdMobTestingBridge({
      isNativeAndroid: () => true,
      adMob: {
        requestConsentInfo: async () => ({
          status: AdmobConsentStatus.NOT_REQUIRED,
          isConsentFormAvailable: false,
          canRequestAds: true,
          privacyOptionsRequirementStatus: "NOT_REQUIRED" as any,
        }),
        initialize: async () => {},
        showBanner: async () => {
          showBannerCount += 1;
          await new Promise<void>((resolve) => {
            resolveShow = resolve;
          });
        },
        hideBanner: async () => {
          hideBannerCount += 1;
        },
      },
    });

    const showPromise = showAdMobBanner({ position: "BOTTOM", margin: 64 });
    await new Promise((r) => setTimeout(r, 10));
    await hideAdMobBanner();
    resolveShow();
    const shown = await showPromise;

    assert.equal(showBannerCount, 1);
    assert.equal(hideBannerCount, 1);
    assert.equal(shown, false);
  });

  it("5. Resets interstitial state on show error and cleans up rewarded listeners across all paths", async () => {
    let prepareInterstitialCount = 0;
    let failFirstShow = true;
    const listeners = new Map<string, Set<(arg: any) => void>>();
    let activeListenerCount = 0;

    setAdMobTestingBridge({
      isNativeAndroid: () => true,
      adMob: {
        requestConsentInfo: async () => ({
          status: AdmobConsentStatus.NOT_REQUIRED,
          isConsentFormAvailable: false,
          canRequestAds: true,
          privacyOptionsRequirementStatus: "NOT_REQUIRED" as any,
        }),
        initialize: async () => {},
        prepareInterstitial: async () => {
          prepareInterstitialCount += 1;
          return { adUnitId: ADMOB_TEST_IDS.INTERSTITIAL };
        },
        showInterstitial: async () => {
          if (failFirstShow) {
            failFirstShow = false;
            throw new Error("AD_EXPIRED");
          }
        },
        prepareRewardVideoAd: async () => ({ adUnitId: ADMOB_TEST_IDS.REWARDED }),
        addListener: (async (event: string, fn: (arg: any) => void) => {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event)!.add(fn);
          activeListenerCount += 1;
          return {
            remove: async () => {
              if (listeners.get(event)?.delete(fn)) {
                activeListenerCount -= 1;
              }
            },
          };
        }) as any,
        showRewardVideoAd: async () => {
          const err: any = new Error("Rewarded ad dismissed before earning a reward.");
          err.code = "REWARDED_AD_CANCELLED";
          throw err;
        },
      },
    });

    assert.equal(await prepareInterstitialAd(), true);
    assert.equal(await showInterstitialAd({ force: true }), false);
    // Second call must re-prepare instead of getting stuck with stale loaded flag
    assert.equal(await showInterstitialAd({ force: true }), true);
    assert.equal(prepareInterstitialCount, 2);

    // Rewarded early cancellation calls onDismissed once, not onError, and removes all listeners
    let rewardCount = 0;
    let dismissCount = 0;
    let errorCount = 0;
    assert.equal(await prepareRewardedAd(), true);
    const res = await showRewardedAd({
      onRewardEarned: () => {
        rewardCount += 1;
      },
      onDismissed: () => {
        dismissCount += 1;
      },
      onError: () => {
        errorCount += 1;
      },
    });
    assert.equal(res, false);
    assert.equal(rewardCount, 0);
    assert.equal(dismissCount, 1);
    assert.equal(errorCount, 0);
    assert.equal(activeListenerCount, 0);

    // Non-cancelled native failure triggers onError once and cleans listeners
    setAdMobTestingBridge({
      isNativeAndroid: () => true,
      adMob: {
        requestConsentInfo: async () => ({
          status: AdmobConsentStatus.NOT_REQUIRED,
          isConsentFormAvailable: false,
          canRequestAds: true,
          privacyOptionsRequirementStatus: "NOT_REQUIRED" as any,
        }),
        initialize: async () => {},
        prepareRewardVideoAd: async () => ({ adUnitId: ADMOB_TEST_IDS.REWARDED }),
        addListener: (async (event: string, fn: (arg: any) => void) => {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event)!.add(fn);
          activeListenerCount += 1;
          return {
            remove: async () => {
              if (listeners.get(event)?.delete(fn)) {
                activeListenerCount -= 1;
              }
            },
          };
        }) as any,
        showRewardVideoAd: async () => {
          for (const fn of listeners.get(RewardAdPluginEvents.Rewarded) || []) {
            fn({ type: "coins", amount: 1 });
          }
          return { type: "coins", amount: 1 };
        },
      },
    });

    await showRewardedAd({
      onRewardEarned: () => {
        rewardCount += 1;
      },
      onDismissed: () => {
        dismissCount += 1;
      },
      onError: () => {
        errorCount += 1;
      },
    });
    assert.equal(rewardCount, 1);
    for (const fn of listeners.get(RewardAdPluginEvents.Dismissed) || []) {
      fn({});
    }
    assert.equal(dismissCount, 2);
    assert.equal(activeListenerCount, 0);

    // Production fail-closed validation remains intact
    const prod = resolveAdMobConfig({ MODE: "production", PROD: true });
    assert.equal(prod.valid, false);
    assert.throws(() => requireAdMobConfig({ MODE: "production", PROD: true }));
  });
});
