/**
 * FaceTube - Google AdSense Website Integration Configuration
 *
 * Secure client-side configuration for Google AdSense ad units, publisher identity,
 * and site verification. All credentials use environment variables with safe fallbacks.
 *
 * Note: Ad impressions and clicks are NEVER treated as confirmed financial earnings.
 * Only verified, finalized reports from Google AdSense statements are recorded to the ledger.
 */

export interface AdSenseConfig {
  /** Google AdSense Publisher ID (format: ca-pub-XXXXXXXXXXXXXXXX) */
  clientId: string;
  /** Watch page horizontal banner ad slot ID */
  slotWatchBanner: string;
  /** Watch page and catalog sidebar rectangle ad slot ID */
  slotSidebar: string;
  /** Home and explore feed inline ad slot ID */
  slotFeed: string;
  /** Whether AdSense publisher ID is configured with a valid format */
  isConfigured: boolean;
  /** Whether AdSense ads are active */
  isEnabled: boolean;
  /** Whether the app is running in local development mode */
  isDev: boolean;
}

/**
 * Validates Google AdSense Publisher Client ID format.
 * Must match 'ca-pub-' followed by 16 numeric digits.
 */
export function isValidAdSenseClientId(clientId: string | null | undefined): boolean {
  if (!clientId || typeof clientId !== "string") return false;
  const clean = clientId.trim();
  // Standard format: ca-pub-1234567890123456
  return /^ca-pub-\d{16}$/.test(clean);
}

/**
 * Returns the current Google AdSense configuration from Vite environment variables.
 */
export function getAdSenseConfig(): AdSenseConfig {
  const env = typeof import.meta !== "undefined" ? import.meta.env : undefined;
  const procEnv = typeof process !== "undefined" && process?.env ? process.env : undefined;

  const clientId = (
    env?.["VITE_ADSENSE_CLIENT_ID"] ||
    procEnv?.["VITE_ADSENSE_CLIENT_ID"] ||
    ""
  ).trim();
  const slotWatchBanner = (
    env?.["VITE_ADSENSE_SLOT_WATCH_BANNER"] ||
    procEnv?.["VITE_ADSENSE_SLOT_WATCH_BANNER"] ||
    ""
  ).trim();
  const slotSidebar = (
    env?.["VITE_ADSENSE_SLOT_SIDEBAR"] ||
    procEnv?.["VITE_ADSENSE_SLOT_SIDEBAR"] ||
    ""
  ).trim();
  const slotFeed = (
    env?.["VITE_ADSENSE_SLOT_FEED"] ||
    procEnv?.["VITE_ADSENSE_SLOT_FEED"] ||
    ""
  ).trim();
  const isEnabledExplicit =
    env?.["VITE_ADSENSE_ENABLED"] === "true" || procEnv?.["VITE_ADSENSE_ENABLED"] === "true";

  const isDev = Boolean(env?.DEV || procEnv?.["NODE_ENV"] !== "production");
  const isConfigured = isValidAdSenseClientId(clientId);
  const isEnabled = isConfigured || (isDev && Boolean(clientId));

  return {
    clientId,
    slotWatchBanner,
    slotSidebar,
    slotFeed,
    isConfigured,
    isEnabled: isEnabled || isEnabledExplicit,
    isDev,
  };
}

/**
 * Generates the standard Google ads.txt record line for FaceTube.
 */
export function generateAdsTxtLine(clientId?: string): string {
  const cleanId = (clientId || getAdSenseConfig().clientId).replace(/^ca-/, "");
  const pubId = cleanId.startsWith("pub-") ? cleanId : `pub-0000000000000000`;
  return `google.com, ${pubId}, DIRECT, f08c47fec0942fa0`;
}
