import { useEffect } from "react";
import { getAdSenseConfig } from "@/lib/adsense-config";

/**
 * Loads the official Google AdSense script into the document head
 * only when a valid publisher ID (ca-pub-XXXXXXXXXXXXXXXX) is configured.
 *
 * Avoids redundant script injections and prevents blocking browser render.
 */
export function AdSenseScript() {
  const config = getAdSenseConfig();

  useEffect(() => {
    if (!config.clientId || !config.clientId.startsWith("ca-pub-")) {
      return;
    }

    const scriptId = "google-adsense-script";
    if (
      document.getElementById(scriptId) ||
      document.querySelector('script[src*="pagead2.googlesyndication.com"]')
    ) {
      return;
    }

    try {
      const script = document.createElement("script");
      script.id = scriptId;
      script.async = true;
      script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(config.clientId)}`;
      script.crossOrigin = "anonymous";
      document.head.appendChild(script);
    } catch (err) {
      console.warn("[FaceTube] Could not inject Google AdSense script:", err);
    }
  }, [config.clientId]);

  return null;
}
