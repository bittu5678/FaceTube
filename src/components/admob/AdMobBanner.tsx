import { useEffect } from "react";
import { isNativeAndroid, showAdMobBanner, hideAdMobBanner } from "@/lib/admob-service";

interface AdMobBannerProps {
  position?: "TOP" | "BOTTOM";
  margin?: number;
  className?: string;
}

/**
 * Android-Only AdMob Banner Component.
 * Automatically handles lifecycle (show on mount, hide on unmount).
 * Renders absolutely nothing in Web browsers, iOS, or PWAs to avoid visual disruption.
 */
export function AdMobBanner({
  position = "BOTTOM",
  margin = 64,
  className = "",
}: AdMobBannerProps) {
  useEffect(() => {
    if (!isNativeAndroid()) return;

    showAdMobBanner({ position, margin });

    return () => {
      hideAdMobBanner();
    };
  }, [position, margin]);

  // Renders no HTML in the DOM (AdMob creates native Android View overlay)
  if (!isNativeAndroid()) {
    return null;
  }

  return (
    <div
      aria-hidden="true"
      className={`admob-native-banner-spacer pointer-events-none ${className}`}
    />
  );
}
