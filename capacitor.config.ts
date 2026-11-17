import type { CapacitorConfig } from "@capacitor/cli";

const appEnv = (process.env["APP_ENV"] || "").trim().toLowerCase();
const nodeEnv = (process.env["NODE_ENV"] || "").trim().toLowerCase();
const nonProdEnvs = new Set(["development", "dev", "local", "test"]);
const presentEnvs = [appEnv, nodeEnv].filter((v) => v !== "");
const isDevOrTest =
  appEnv !== "production" &&
  nodeEnv !== "production" &&
  presentEnvs.length > 0 &&
  presentEnvs.every((v) => nonProdEnvs.has(v));

const config: CapacitorConfig = {
  appId: "online.facetube.app",
  appName: "FaceTube",
  webDir: "android-shell",
  server: {
    url: "https://facetube.online",
    androidScheme: "https",
    cleartext: false,
    allowNavigation: ["facetube.online"],
    errorPath: "offline.html",
  },
  android: {
    minWebViewVersion: 90,
    useLegacyBridge: false,
    appendUserAgent: "FaceTubeAndroidApp/1.0",
  },
  plugins: {
    AdMob: {
      initializeForTesting: isDevOrTest,
    },
  },
};

export default config;
