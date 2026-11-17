import React, { useEffect, useRef, useState } from "react";
import { getAdSenseConfig } from "@/lib/adsense-config";
import { Info, Sparkles } from "lucide-react";

declare global {
  interface Window {
    adsbygoogle?: Array<Record<string, unknown>>;
  }
}

export type AdSlotType = "watch-banner" | "sidebar" | "feed";

export interface AdSenseAdProps {
  /** Target placement slot type */
  slotType: AdSlotType;
  /** Explicit Google AdSense ad unit slot ID override */
  slotId?: string | undefined;
  /** Google AdSense ad format */
  format?: "auto" | "rectangle" | "horizontal" | "vertical" | undefined;
  /** Whether the ad unit is full-width responsive (default: true) */
  fullWidthResponsive?: boolean | undefined;
  /** Optional custom class name */
  className?: string | undefined;
  /** Optional custom label above ad (default: "Advertisement") */
  label?: string | undefined;
}

export function AdSenseAd({
  slotType,
  slotId: explicitSlotId,
  format = "auto",
  fullWidthResponsive = true,
  className = "",
  label = "Advertisement",
}: AdSenseAdProps) {
  const adRef = useRef<HTMLModElement | null>(null);
  const [adPushed, setAdPushed] = useState(false);
  const [adError, setAdError] = useState<string | null>(null);

  const config = getAdSenseConfig();

  // Resolve slot ID from explicit prop or environment mapping
  let slotId = explicitSlotId;
  if (!slotId) {
    if (slotType === "watch-banner") slotId = config.slotWatchBanner;
    else if (slotType === "sidebar") slotId = config.slotSidebar;
    else if (slotType === "feed") slotId = config.slotFeed;
  }

  const isLiveConfigured = config.isConfigured && Boolean(slotId);

  useEffect(() => {
    // Only attempt to push real ad unit if client ID and slot ID are configured
    if (!isLiveConfigured || adPushed) return;

    try {
      if (typeof window !== "undefined") {
        window.adsbygoogle = window.adsbygoogle || [];
        window.adsbygoogle.push({});
        setAdPushed(true);
      }
    } catch (err: unknown) {
      // Ad blocker, network restriction, or duplicate push - fail safe without crashing UI
      const msg = err instanceof Error ? err.message : String(err);
      setAdError(msg);
    }
  }, [isLiveConfigured, adPushed]);

  // If live configured, render official Google AdSense ins tag
  if (isLiveConfigured) {
    return (
      <div
        className={`my-4 overflow-hidden rounded-xl border border-border/40 bg-secondary/10 p-2.5 transition-all ${className}`}
      >
        <div className="mb-1.5 flex items-center justify-between text-[10px] font-semibold tracking-wider text-muted-foreground/70 uppercase">
          <span>{label}</span>
          <span className="text-[9px] text-muted-foreground/50">Google AdSense</span>
        </div>
        <div className="flex justify-center overflow-hidden">
          <ins
            ref={adRef}
            className="adsbygoogle block w-full text-center"
            style={{ display: "block", minHeight: slotType === "watch-banner" ? "90px" : "100px" }}
            data-ad-client={config.clientId}
            data-ad-slot={slotId}
            data-ad-format={format}
            data-full-width-responsive={fullWidthResponsive ? "true" : "false"}
          />
        </div>
        {adError && (
          <p className="mt-1 text-[10px] text-muted-foreground/40 text-center">
            Ad unavailable (AdBlock active or pending AdSense domain approval)
          </p>
        )}
      </div>
    );
  }

  // In development mode or unconfigured staging, display an informative developer placement guide
  if (config.isDev) {
    return (
      <div
        className={`my-4 rounded-xl border border-dashed border-amber-500/30 bg-amber-500/5 p-4 text-center transition-all ${className}`}
      >
        <div className="flex items-center justify-between border-b border-amber-500/20 pb-2 mb-2 text-[10px] font-bold uppercase tracking-wider text-amber-500">
          <span className="flex items-center gap-1.5">
            <Sparkles className="h-3 w-3" />
            <span>Google AdSense Slot — {slotType.toUpperCase()}</span>
          </span>
          <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-semibold text-amber-400">
            Preview Placeholder
          </span>
        </div>
        <div className="py-2 text-xs text-muted-foreground">
          <p className="font-semibold text-foreground/80">
            Ad placement ready for approved AdSense campaigns
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground/80 flex items-center justify-center gap-1">
            <Info className="h-3 w-3 inline text-amber-400 shrink-0" />
            <span>
              Configure <code className="font-mono text-amber-400">VITE_ADSENSE_CLIENT_ID</code> and{" "}
              <code className="font-mono text-amber-400">
                {slotType === "watch-banner"
                  ? "VITE_ADSENSE_SLOT_WATCH_BANNER"
                  : slotType === "sidebar"
                    ? "VITE_ADSENSE_SLOT_SIDEBAR"
                    : "VITE_ADSENSE_SLOT_FEED"}
              </code>{" "}
              in <code className="font-mono text-foreground">.env</code>.
            </span>
          </p>
        </div>
        <div className="mt-2 text-[10px] text-muted-foreground/60 border-t border-amber-500/10 pt-1.5">
          AdSense Policy Compliance: Non-disruptive, positioned outside video player chrome.
        </div>
      </div>
    );
  }

  // In production if no Publisher ID is set, cleanly return null to prevent visual clutter
  return null;
}
