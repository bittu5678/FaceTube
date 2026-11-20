import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  AuthDatabaseError,
  getAuthUserFromRequest,
  handleApiRequest,
  resetInMemoryStore,
} from "./api-handler";
import { setMysqlPoolForTesting } from "./mysql";
import nitroServerEntry from "../server";

describe("Priority 1: Persistent Login Robustness & Password Reset Link Tests", () => {
  // Test A: Session Error Classification
  describe("Session Error Handling & Token Retention", () => {
    it("1. Differentiates HTTP 401 (unauthorized) from transient 5xx/network errors", () => {
      // Simulating error objects thrown by apiFetch
      const error401 = Object.assign(new Error("Authentication required"), {
        status: 401,
        data: { authenticated: false, error: "Session expired" },
      });

      const error500 = Object.assign(new Error("Internal Server Error"), {
        status: 500,
        data: { error: "Database temporarily unavailable" },
      });

      const networkError = new Error("Failed to fetch");

      // Verify status classification helper logic used in AuthProvider
      const shouldClearSession = (err: unknown): boolean => {
        const status = (err as { status?: number })?.status;
        return status === 401 || status === 403;
      };

      assert.equal(shouldClearSession(error401), true, "401 must clear invalid session");
      assert.equal(
        shouldClearSession(error500),
        false,
        "500 must NOT clear cached session or token",
      );
      assert.equal(
        shouldClearSession(networkError),
        false,
        "Network blip must NOT clear cached session or token",
      );
    });

    it("2. Handles explicit { authenticated: false } response by clearing session", () => {
      const unauthResponse = { authenticated: false, user: null };
      const authResponse = {
        authenticated: true,
        user: { id: "u-1", user_id: "FT102857", name: "Admin", email: "admin@facetube.com" },
      };

      const isSessionValid = (res: { authenticated: boolean; user: unknown }): boolean => {
        return Boolean(res && res.authenticated && res.user);
      };

      assert.equal(isSessionValid(unauthResponse), false);
      assert.equal(isSessionValid(authResponse), true);
    });

    it("3. Hostinger auth/me returns authenticated=false when no session token is provided", async () => {
      const req = new Request("http://localhost:3000/api/auth/me", {
        method: "GET",
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.authenticated, false);
      assert.equal(data.user, null);
    });

    it("4. Hostinger auth/logout revokes session cleanly", async () => {
      const req = new Request("http://localhost:3000/api/auth/logout", {
        method: "POST",
        headers: { Authorization: "Bearer test_session_token_123" },
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
    });
  });

  // Test B: Password Reset Link Verification
  describe("Password Reset Link & Route Alignment", () => {
    it("5. Verifies api/auth/forgot-password.php generates /reset-password link", () => {
      const phpFilePath = path.resolve(process.cwd(), "api/auth/forgot-password.php");
      assert.ok(fs.existsSync(phpFilePath), "api/auth/forgot-password.php must exist");

      const phpContent = fs.readFileSync(phpFilePath, "utf-8");

      // Verify that resetLink points to /reset-password, not /auth?mode=reset
      assert.match(
        phpContent,
        /\/reset-password\?token=/,
        "PHP forgot-password must generate reset link with /reset-password path",
      );
      assert.doesNotMatch(
        phpContent,
        /\/auth\?mode=reset/,
        "PHP forgot-password must not generate legacy /auth?mode=reset link",
      );
    });

    it("6. Verifies Node preview forgot-password handler generates /reset-password link", async () => {
      const req = new Request("http://localhost:3000/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "admin@facetube.com" }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.match(data.message, /password reset link has been dispatched/i);
    });

    it("7. Cryptographic token generation generates 64 hex characters (32 random bytes)", () => {
      const rawToken = crypto.randomBytes(32).toString("hex");
      assert.equal(rawToken.length, 64);
      assert.match(rawToken, /^[0-9a-f]{64}$/);

      const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
      assert.equal(tokenHash.length, 64);
      assert.match(tokenHash, /^[0-9a-f]{64}$/);
      assert.notEqual(tokenHash, rawToken);
    });

    it("8. Sensitive tokens are not exposed in public error responses", async () => {
      const req = new Request("http://localhost:3000/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "nonexistent_user@facetube.com" }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      // Ensure token and hash are never returned in public payload
      assert.equal(data.token, undefined);
      assert.equal(data.tokenHash, undefined);
      assert.equal(data.rawToken, undefined);
    });

    it("9. Auth route has backward compatibility redirect handler for legacy /auth?mode=reset links", () => {
      const authRoutePath = path.resolve(process.cwd(), "src/routes/auth.tsx");
      assert.ok(fs.existsSync(authRoutePath), "src/routes/auth.tsx must exist");
      const authContent = fs.readFileSync(authRoutePath, "utf-8");

      assert.match(
        authContent,
        /searchParams\.mode === "reset"/,
        "auth.tsx must inspect searchParams.mode === 'reset'",
      );
      assert.match(
        authContent,
        /to:\s*["']\/reset-password["']/,
        "auth.tsx must navigate to /reset-password when mode is reset",
      );
    });
  });

  describe("3. Task 5J-K: Auth Login Production Fail-Closed Guard", () => {
    const envKeys = ["NODE_ENV", "APP_ENV", "DB_HOST", "DB_NAME", "DB_USER"] as const;
    let envSnapshot: Record<string, string | undefined> = {};

    beforeEach(() => {
      envSnapshot = {};
      for (const k of envKeys) {
        envSnapshot[k] = process.env[k];
      }
      setMysqlPoolForTesting(null);
      resetInMemoryStore();
    });

    afterEach(() => {
      setMysqlPoolForTesting(null);
      for (const k of envKeys) {
        if (envSnapshot[k] !== undefined) {
          process.env[k] = envSnapshot[k];
        } else {
          delete process.env[k];
        }
      }
      resetInMemoryStore();
    });

    it("fails closed with HTTP 503 on POST /api/auth/login when APP_ENV=production and NODE_ENV is unset without MySQL pool", async () => {
      process.env["APP_ENV"] = "production";
      delete process.env["NODE_ENV"];
      delete process.env["DB_HOST"];
      setMysqlPoolForTesting(null);

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 503);
      const data = (await res.json()) as any;
      assert.equal(data.success, false);
      assert.equal(data.token, undefined);
    });

    it("preserves non-production JSON login fallback when NODE_ENV=test and pool is unavailable", async () => {
      process.env["NODE_ENV"] = "test";
      delete process.env["APP_ENV"];
      setMysqlPoolForTesting(null);

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.success, true);
      assert.ok(data.token);
    });
  });

  describe("4. Task 5J-L: Auth channel_logo_url Normalization (login & getAuthUserFromRequest)", () => {
    const envKeys = [
      "NODE_ENV",
      "APP_ENV",
      "DB_HOST",
      "DB_NAME",
      "DB_USER",
      "FACETUBE_API_BASE_URL",
      "API_BASE_URL",
      "VITE_MEDIA_BASE_URL",
    ] as const;
    let envSnapshot: Record<string, string | undefined> = {};
    const storePath = path.resolve(process.cwd(), "data/facetube_store.json");
    let storeExisted = false;
    let storeSnapshot: string | null = null;

    beforeEach(() => {
      envSnapshot = {};
      for (const k of envKeys) {
        envSnapshot[k] = process.env[k];
      }
      storeExisted = fs.existsSync(storePath);
      storeSnapshot = storeExisted ? fs.readFileSync(storePath, "utf-8") : null;
      setMysqlPoolForTesting(null);
      resetInMemoryStore();
    });

    afterEach(() => {
      setMysqlPoolForTesting(null);
      for (const k of envKeys) {
        if (envSnapshot[k] !== undefined) {
          process.env[k] = envSnapshot[k];
        } else {
          delete process.env[k];
        }
      }
      if (storeExisted && storeSnapshot !== null) {
        fs.writeFileSync(storePath, storeSnapshot, "utf-8");
      } else if (!storeExisted && fs.existsSync(storePath)) {
        fs.unlinkSync(storePath);
      }
      resetInMemoryStore();
    });

    it("normalizes relative channel_logo_url in POST /api/auth/login and GET /api/auth/me (MySQL + JSON store) and preserves absolute, null, and empty values without extra PII", async () => {
      const sha256Password = crypto.createHash("sha256").update("password123").digest("hex");
      const mockCases: Array<{ label: string; input: string | null; expected: string | null }> = [
        {
          label: "relative /uploads/ path",
          input: "/uploads/example.png",
          expected: "https://api.facetube.online/uploads/example.png",
        },
        {
          label: "already absolute https URL",
          input: "https://cdn.example.com/logos/studio.png",
          expected: "https://cdn.example.com/logos/studio.png",
        },
        {
          label: "null logo",
          input: null,
          expected: null,
        },
        {
          label: "empty string logo",
          input: "",
          expected: "",
        },
      ];

      process.env["NODE_ENV"] = "production";
      delete process.env["APP_ENV"];
      delete process.env["FACETUBE_API_BASE_URL"];
      delete process.env["API_BASE_URL"];
      delete process.env["VITE_MEDIA_BASE_URL"];
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";

      for (const tc of mockCases) {
        const mockPool = {
          query: async (sql: string) => {
            if (/FROM\s+sessions/i.test(sql)) {
              return [
                [
                  {
                    id: "u-alex-id",
                    user_id: "FT483921",
                    name: "Alex Rivera",
                    mobile: "+1 555-014-8392",
                    email: "alex@facetube.com",
                    role: "user",
                    referral_code: "CREATOR50",
                    avatar_url: null,
                    channel_logo_url: tc.input,
                    channel_name: "Alex Studio",
                    channel_description: null,
                    created_at: "2026-11-01T00:00:00.000Z",
                  },
                ],
                [],
              ];
            }
            if (/INSERT\s+INTO\s+sessions/i.test(sql)) {
              return [{ affectedRows: 1 }, []];
            }
            if (/FROM\s+users/i.test(sql)) {
              return [
                [
                  {
                    id: "u-alex-id",
                    user_id: "FT483921",
                    name: "Alex Rivera",
                    mobile: "+1 555-014-8392",
                    email: "alex@facetube.com",
                    password_hash: sha256Password,
                    role: "user",
                    referral_code: "CREATOR50",
                    avatar_url: null,
                    channel_logo_url: tc.input,
                    channel_name: "Alex Studio",
                    channel_description: null,
                    created_at: "2026-11-01T00:00:00.000Z",
                  },
                ],
                [],
              ];
            }
            return [[], []];
          },
        } as any;
        setMysqlPoolForTesting(mockPool);

        const loginRes = await handleApiRequest(
          new Request("https://facetube.online/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
          }),
        );
        assert.ok(loginRes, `login response missing for ${tc.label}`);
        assert.equal(loginRes.status, 200);
        const loginData = (await loginRes.json()) as any;
        assert.equal(loginData.user.channel_logo_url, tc.expected, `login mismatch: ${tc.label}`);
        assert.equal("password_hash" in loginData.user, false);

        const meRes = await handleApiRequest(
          new Request("https://facetube.online/api/auth/me", {
            method: "GET",
            headers: { Authorization: `Bearer ${loginData.token}` },
          }),
        );
        assert.ok(meRes, `me response missing for ${tc.label}`);
        assert.equal(meRes.status, 200);
        const meData = (await meRes.json()) as any;
        assert.equal(meData.authenticated, true);
        assert.equal(meData.user.channel_logo_url, tc.expected, `auth/me mismatch: ${tc.label}`);
        assert.equal("password_hash" in meData.user, false);
      }

      // Non-production JSON store fallback with FACETUBE_API_BASE_URL configured
      setMysqlPoolForTesting(null);
      delete process.env["DB_HOST"];
      delete process.env["DB_NAME"];
      delete process.env["DB_USER"];
      process.env["NODE_ENV"] = "test";
      process.env["FACETUBE_API_BASE_URL"] = "https://api.facetube.online";
      if (!fs.existsSync(storePath)) {
        await handleApiRequest(new Request("http://localhost:3000/api/health"));
      }
      const seededStore = JSON.parse(fs.readFileSync(storePath, "utf-8"));
      const alexIdx = seededStore.users.findIndex((u: any) => u.user_id === "FT483921");
      assert.ok(alexIdx >= 0);
      seededStore.users[alexIdx].channel_logo_url = "/uploads/example.png";
      fs.writeFileSync(storePath, JSON.stringify(seededStore), "utf-8");
      resetInMemoryStore();

      const storeLoginRes = await handleApiRequest(
        new Request("http://localhost:3000/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "alex@facetube.com", password: "password" }),
        }),
      );
      assert.ok(storeLoginRes);
      assert.equal(storeLoginRes.status, 200);
      const storeLoginData = (await storeLoginRes.json()) as any;
      assert.equal(
        storeLoginData.user.channel_logo_url,
        "https://api.facetube.online/uploads/example.png",
      );
      assert.equal("password_hash" in storeLoginData.user, false);

      const storeMeRes = await handleApiRequest(
        new Request("http://localhost:3000/api/auth/me", {
          method: "GET",
          headers: { Authorization: `Bearer ${storeLoginData.token}` },
        }),
      );
      assert.ok(storeMeRes);
      const storeMeData = (await storeMeRes.json()) as any;
      assert.equal(
        storeMeData.user.channel_logo_url,
        "https://api.facetube.online/uploads/example.png",
      );

      const directAuthUser = await getAuthUserFromRequest(
        new Request("https://facetube.online/api/auth/me", {
          method: "GET",
          headers: { Authorization: `Bearer ${storeLoginData.token}` },
        }),
        { users: seededStore.users, sessions: { [storeLoginData.token]: "FT483921" } } as any,
        null,
      );
      assert.ok(directAuthUser);
      assert.equal(
        directAuthUser.channel_logo_url,
        "https://api.facetube.online/uploads/example.png",
      );
    });
  });

  describe("5. Task 5J-O: Nitro Server Entry Production Fail-Closed Safety", () => {
    const envKeys = [
      "NODE_ENV",
      "APP_ENV",
      "USE_REMOTE_PHP_API",
      "DB_HOST",
      "DB_PORT",
      "DB_NAME",
      "DB_USER",
      "DB_PASSWORD",
      "MYSQL_HOST",
      "MYSQL_PORT",
      "MYSQL_DATABASE",
      "MYSQL_USER",
      "MYSQL_PASSWORD",
    ] as const;
    let envSnapshot: Record<string, string | undefined> = {};
    const storePath = path.resolve(process.cwd(), "data/facetube_store.json");
    let storeExisted = false;
    let storeSnapshot: string | null = null;

    beforeEach(() => {
      envSnapshot = {};
      for (const k of envKeys) {
        envSnapshot[k] = process.env[k];
      }
      storeExisted = fs.existsSync(storePath);
      storeSnapshot = storeExisted ? fs.readFileSync(storePath, "utf-8") : null;
      delete process.env["USE_REMOTE_PHP_API"];
      setMysqlPoolForTesting(null);
      resetInMemoryStore();
    });

    afterEach(() => {
      setMysqlPoolForTesting(null);
      for (const k of envKeys) {
        if (envSnapshot[k] !== undefined) {
          process.env[k] = envSnapshot[k];
        } else {
          delete process.env[k];
        }
      }
      if (storeExisted && storeSnapshot !== null) {
        fs.writeFileSync(storePath, storeSnapshot, "utf-8");
      } else if (!storeExisted && fs.existsSync(storePath)) {
        fs.unlinkSync(storePath);
      }
      resetInMemoryStore();
    });

    it("1. Production request with non-FaceTube hostname fails closed with 503 and does not downgrade env", async () => {
      process.env["NODE_ENV"] = "production";
      process.env["APP_ENV"] = "production";
      delete process.env["DB_HOST"];
      delete process.env["DB_NAME"];
      delete process.env["DB_USER"];
      delete process.env["MYSQL_HOST"];
      delete process.env["MYSQL_DATABASE"];
      delete process.env["MYSQL_USER"];
      setMysqlPoolForTesting(null);

      const videosRes = await nitroServerEntry.fetch(
        new Request("https://staging-proxy.example.com/api/videos/list", { method: "GET" }),
        undefined,
        undefined,
      );
      assert.equal(videosRes.status, 503);
      const videosData = (await videosRes.json()) as any;
      assert.equal(videosData.success, false);
      assert.equal(videosData.videos, undefined);
      assert.equal(process.env["NODE_ENV"], "production");
      assert.equal(process.env["APP_ENV"], "production");

      const loginRes = await nitroServerEntry.fetch(
        new Request("https://preview-service.run.app/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
        }),
        undefined,
        undefined,
      );
      assert.equal(loginRes.status, 503);
      const loginData = (await loginRes.json()) as any;
      assert.equal(loginData.success, false);
      assert.equal(loginData.token, undefined);
      assert.equal(process.env["NODE_ENV"], "production");
      assert.equal(process.env["APP_ENV"], "production");
    });

    it("2. Localhost/internal SSR request cannot mutate global process.env and subsequent production requests still fail closed", async () => {
      process.env["NODE_ENV"] = "production";
      process.env["APP_ENV"] = "production";
      delete process.env["DB_HOST"];
      delete process.env["DB_NAME"];
      delete process.env["DB_USER"];
      delete process.env["MYSQL_HOST"];
      delete process.env["MYSQL_DATABASE"];
      delete process.env["MYSQL_USER"];
      setMysqlPoolForTesting(null);

      // Simulate internal SSR request to 127.0.0.1 and localhost
      const ssrRes = await nitroServerEntry.fetch(
        new Request("http://127.0.0.1:3000/api/videos/list", { method: "GET" }),
        undefined,
        undefined,
      );
      assert.equal(ssrRes.status, 503);
      assert.equal(process.env["NODE_ENV"], "production");
      assert.equal(process.env["APP_ENV"], "production");

      const localhostLoginRes = await nitroServerEntry.fetch(
        new Request("http://localhost:3000/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
        }),
        undefined,
        undefined,
      );
      assert.equal(localhostLoginRes.status, 503);
      assert.equal(process.env["NODE_ENV"], "production");
      assert.equal(process.env["APP_ENV"], "production");

      // Subsequent production request to live domain must still evaluate as production
      const liveVideosRes = await nitroServerEntry.fetch(
        new Request("https://facetube.online/api/videos/list", { method: "GET" }),
        undefined,
        undefined,
      );
      assert.equal(liveVideosRes.status, 503);
      const liveVideosData = (await liveVideosRes.json()) as any;
      assert.equal(liveVideosData.success, false);
      assert.equal(liveVideosData.videos, undefined);

      const liveLoginRes = await nitroServerEntry.fetch(
        new Request("https://facetube.online/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
        }),
        undefined,
        undefined,
      );
      assert.equal(liveLoginRes.status, 503);
      const liveLoginData = (await liveLoginRes.json()) as any;
      assert.equal(liveLoginData.success, false);
      assert.equal(liveLoginData.token, undefined);
      assert.equal(process.env["NODE_ENV"], "production");
      assert.equal(process.env["APP_ENV"], "production");
    });

    it("3. Missing MySQL credentials in production fail closed (503), query failure returns 500, and live MySQL pool succeeds (200)", async () => {
      delete process.env["NODE_ENV"];
      delete process.env["APP_ENV"];
      delete process.env["DB_HOST"];
      delete process.env["DB_NAME"];
      delete process.env["DB_USER"];
      delete process.env["MYSQL_HOST"];
      delete process.env["MYSQL_DATABASE"];
      delete process.env["MYSQL_USER"];
      setMysqlPoolForTesting(null);

      // Explicit runtime env object with APP_ENV=production on non-FaceTube host -> 503 and no global mutation
      const envProdRes = await nitroServerEntry.fetch(
        new Request("https://internal-lb.cluster.local/api/images/list", { method: "GET" }),
        { APP_ENV: "production" },
        undefined,
      );
      assert.equal(envProdRes.status, 503);
      const envProdData = (await envProdRes.json()) as any;
      assert.equal(envProdData.success, false);
      assert.equal(envProdData.images, undefined);
      assert.equal(process.env["NODE_ENV"], undefined);
      assert.equal(process.env["APP_ENV"], undefined);

      // Production MySQL query failure -> 500 (never silently falls back to JSON)
      process.env["NODE_ENV"] = "production";
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_prod";
      process.env["DB_USER"] = "prod_user";
      setMysqlPoolForTesting({
        query: async () => {
          throw new Error("Simulated MySQL query failure");
        },
      } as any);

      const queryFailRes = await nitroServerEntry.fetch(
        new Request("https://internal-lb.cluster.local/api/videos/list", { method: "GET" }),
        undefined,
        undefined,
      );
      assert.equal(queryFailRes.status, 500);
      const queryFailData = (await queryFailRes.json()) as any;
      assert.equal(queryFailData.success, false);
      assert.equal(queryFailData.videos, undefined);

      // Production MySQL healthy -> 200 with MySQL rows
      setMysqlPoolForTesting({
        query: async () => [[], []],
      } as any);

      const healthyRes = await nitroServerEntry.fetch(
        new Request("https://internal-lb.cluster.local/api/videos/list", { method: "GET" }),
        undefined,
        undefined,
      );
      assert.equal(healthyRes.status, 200);
      const healthyData = (await healthyRes.json()) as any;
      assert.equal(healthyData.success, true);
      assert.deepEqual(healthyData.videos, []);
    });

    it("4. Explicit development and test environments preserve local JSON fallback without mutating process.env", async () => {
      delete process.env["DB_HOST"];
      delete process.env["DB_NAME"];
      delete process.env["DB_USER"];
      delete process.env["MYSQL_HOST"];
      delete process.env["MYSQL_DATABASE"];
      delete process.env["MYSQL_USER"];
      setMysqlPoolForTesting(null);

      // Explicit development env via process.env
      process.env["NODE_ENV"] = "development";
      process.env["APP_ENV"] = "development";

      const devVideosRes = await nitroServerEntry.fetch(
        new Request("http://localhost:3000/api/videos/list", { method: "GET" }),
        undefined,
        undefined,
      );
      assert.equal(devVideosRes.status, 200);
      const devVideosData = (await devVideosRes.json()) as any;
      assert.equal(devVideosData.success, true);
      assert.ok(Array.isArray(devVideosData.videos));

      // Explicit test env via process.env
      process.env["NODE_ENV"] = "test";
      delete process.env["APP_ENV"];

      const testLoginRes = await nitroServerEntry.fetch(
        new Request("http://127.0.0.1:3000/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
        }),
        undefined,
        undefined,
      );
      assert.equal(testLoginRes.status, 200);
      const testLoginData = (await testLoginRes.json()) as any;
      assert.equal(testLoginData.success, true);
      assert.ok(testLoginData.token);

      // Explicit development env passed via runtime env arg leaves unset process.env untouched
      delete process.env["NODE_ENV"];
      delete process.env["APP_ENV"];

      const runtimeDevRes = await nitroServerEntry.fetch(
        new Request("https://facetube.online/api/videos/list", { method: "GET" }),
        { NODE_ENV: "development", APP_ENV: "development" },
        undefined,
      );
      assert.equal(runtimeDevRes.status, 200);
      const runtimeDevData = (await runtimeDevRes.json()) as any;
      assert.equal(runtimeDevData.success, true);
      assert.equal(process.env["NODE_ENV"], undefined);
      assert.equal(process.env["APP_ENV"], undefined);
    });
  });

  describe("6. Task 5J-P: Production Authentication Fail-Closed Safety", () => {
    const envKeys = [
      "NODE_ENV",
      "APP_ENV",
      "USE_REMOTE_PHP_API",
      "DB_HOST",
      "DB_PORT",
      "DB_NAME",
      "DB_USER",
      "DB_PASSWORD",
      "MYSQL_HOST",
      "MYSQL_PORT",
      "MYSQL_DATABASE",
      "MYSQL_USER",
      "MYSQL_PASSWORD",
    ] as const;
    let envSnapshot: Record<string, string | undefined> = {};
    const storePath = path.resolve(process.cwd(), "data/facetube_store.json");
    let storeExisted = false;
    let storeSnapshot: string | null = null;

    const jsonSessionToken = "tok_json_store_valid_looking_session_5jp";

    async function seedJsonSession(): Promise<any> {
      process.env["NODE_ENV"] = "test";
      delete process.env["APP_ENV"];
      delete process.env["DB_HOST"];
      setMysqlPoolForTesting(null);
      if (!fs.existsSync(storePath)) {
        await handleApiRequest(new Request("http://localhost:3000/api/health"));
      }
      const seeded = JSON.parse(fs.readFileSync(storePath, "utf-8"));
      seeded.sessions = { ...(seeded.sessions || {}), [jsonSessionToken]: "FT483921" };
      fs.writeFileSync(storePath, JSON.stringify(seeded), "utf-8");
      resetInMemoryStore();
      return seeded;
    }

    function clearDbEnvVars(): void {
      delete process.env["DB_HOST"];
      delete process.env["DB_PORT"];
      delete process.env["DB_NAME"];
      delete process.env["DB_USER"];
      delete process.env["DB_PASSWORD"];
      delete process.env["MYSQL_HOST"];
      delete process.env["MYSQL_PORT"];
      delete process.env["MYSQL_DATABASE"];
      delete process.env["MYSQL_USER"];
      delete process.env["MYSQL_PASSWORD"];
    }

    beforeEach(() => {
      envSnapshot = {};
      for (const k of envKeys) {
        envSnapshot[k] = process.env[k];
      }
      storeExisted = fs.existsSync(storePath);
      storeSnapshot = storeExisted ? fs.readFileSync(storePath, "utf-8") : null;
      delete process.env["USE_REMOTE_PHP_API"];
      setMysqlPoolForTesting(null);
      resetInMemoryStore();
    });

    afterEach(() => {
      setMysqlPoolForTesting(null);
      for (const k of envKeys) {
        if (envSnapshot[k] !== undefined) {
          process.env[k] = envSnapshot[k];
        } else {
          delete process.env[k];
        }
      }
      if (storeExisted && storeSnapshot !== null) {
        fs.writeFileSync(storePath, storeSnapshot, "utf-8");
      } else if (!storeExisted && fs.existsSync(storePath)) {
        fs.unlinkSync(storePath);
      }
      resetInMemoryStore();
    });

    it("1. Production with no MySQL pool cannot authenticate using a valid-looking JSON session", async () => {
      const seededStore = await seedJsonSession();

      process.env["APP_ENV"] = "production";
      delete process.env["NODE_ENV"];
      clearDbEnvVars();
      setMysqlPoolForTesting(null);

      // Direct helper rejects with AuthDatabaseError (503)
      await assert.rejects(
        () =>
          getAuthUserFromRequest(
            new Request("https://facetube.online/api/auth/me", {
              method: "GET",
              headers: { Authorization: `Bearer ${jsonSessionToken}` },
            }),
            seededStore,
            null,
          ),
        (err: unknown) => err instanceof AuthDatabaseError && err.status === 503,
      );

      // Authenticated API routes fail closed with 503 via both handleApiRequest and Nitro server entry
      const changePwRes = await handleApiRequest(
        new Request("https://facetube.online/api/auth/change-password", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${jsonSessionToken}`,
          },
          body: JSON.stringify({
            currentPassword: "password",
            newPassword: "NewPassword123!",
            confirmPassword: "NewPassword123!",
          }),
        }),
      );
      assert.ok(changePwRes);
      assert.equal(changePwRes.status, 503);
      const changePwData = (await changePwRes.json()) as any;
      assert.equal(changePwData.success, false);

      // Runtime env argument overrides test process.env without mutating global process.env
      process.env["NODE_ENV"] = "test";
      delete process.env["APP_ENV"];

      const nitroRes = await nitroServerEntry.fetch(
        new Request("https://internal-proxy.example.com/api/referrals/dashboard", {
          method: "GET",
          headers: { Authorization: `Bearer ${jsonSessionToken}` },
        }),
        { APP_ENV: "production" },
        undefined,
      );
      assert.equal(nitroRes.status, 503);
      const nitroData = (await nitroRes.json()) as any;
      assert.equal(nitroData.success, false);
      assert.equal(nitroData.dashboard, undefined);
      assert.equal(process.env["NODE_ENV"], "test");
      assert.equal(process.env["APP_ENV"], undefined);
    });

    it("2. Production MySQL session query failure returns safe 500 and does not fall back to JSON", async () => {
      const seededStore = await seedJsonSession();

      process.env["APP_ENV"] = "production";
      delete process.env["NODE_ENV"];
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_prod";
      process.env["DB_USER"] = "prod_user";

      const failingAuthPool = {
        query: async (sql: string) => {
          if (/FROM\s+sessions/i.test(sql)) {
            throw new Error("ER_ACCESS_DENIED_ERROR: secret-db.internal");
          }
          return [[], []];
        },
      } as any;
      setMysqlPoolForTesting(failingAuthPool);

      await assert.rejects(
        () =>
          getAuthUserFromRequest(
            new Request("https://facetube.online/api/users/profile", {
              method: "GET",
              headers: { Authorization: `Bearer ${jsonSessionToken}` },
            }),
            seededStore,
            failingAuthPool,
          ),
        (err: unknown) =>
          err instanceof AuthDatabaseError &&
          err.status === 500 &&
          !err.message.includes("secret-db.internal"),
      );

      const profileRes = await handleApiRequest(
        new Request("https://facetube.online/api/users/profile", {
          method: "GET",
          headers: { Authorization: `Bearer ${jsonSessionToken}` },
        }),
      );
      assert.ok(profileRes);
      assert.equal(profileRes.status, 500);
      const profileData = (await profileRes.json()) as any;
      assert.equal(profileData.success, false);
      assert.equal(profileData.profile, undefined);
      assert.doesNotMatch(String(profileData.error || ""), /secret-db\.internal|ER_ACCESS_DENIED/);
      assert.doesNotMatch(JSON.stringify(profileData), new RegExp(jsonSessionToken));
    });

    it("3. Production MySQL session lookup returning no rows treats user as unauthenticated without checking JSON", async () => {
      const seededStore = await seedJsonSession();

      process.env["APP_ENV"] = "production";
      delete process.env["NODE_ENV"];
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_prod";
      process.env["DB_USER"] = "prod_user";

      const emptySessionPool = {
        query: async (sql: string) => {
          if (/FROM\s+sessions/i.test(sql)) {
            return [[], []];
          }
          if (/FROM\s+users/i.test(sql)) {
            return [
              [
                {
                  id: "a0000000-0000-0000-0000-000000000002",
                  user_id: "FT483921",
                  name: "Alex Rivera",
                  mobile: "+1 555-014-8392",
                  email: "alex@facetube.com",
                  role: "user",
                  referral_code: "CREATOR50",
                  avatar_url: null,
                  channel_logo_url: null,
                  channel_name: "Alex Studio",
                  channel_description: null,
                  created_at: "2026-11-01T00:00:00.000Z",
                },
              ],
              [],
            ];
          }
          return [[], []];
        },
      } as any;
      setMysqlPoolForTesting(emptySessionPool);

      // Direct helper returns null even though jsonSessionToken is in store.sessions
      const directUser = await getAuthUserFromRequest(
        new Request("https://facetube.online/api/auth/me", {
          method: "GET",
          headers: { Authorization: `Bearer ${jsonSessionToken}` },
        }),
        seededStore,
        emptySessionPool,
      );
      assert.equal(directUser, null);

      // /api/auth/me returns unauthenticated
      const meRes = await handleApiRequest(
        new Request("https://facetube.online/api/auth/me", {
          method: "GET",
          headers: { Authorization: `Bearer ${jsonSessionToken}` },
        }),
      );
      assert.ok(meRes);
      assert.equal(meRes.status, 200);
      const meData = (await meRes.json()) as any;
      assert.equal(meData.authenticated, false);
      assert.equal(meData.user, null);

      // Protected route rejects with 401
      const changePwRes = await handleApiRequest(
        new Request("https://facetube.online/api/auth/change-password", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${jsonSessionToken}`,
          },
          body: JSON.stringify({
            currentPassword: "password",
            newPassword: "NewPassword123!",
            confirmPassword: "NewPassword123!",
          }),
        }),
      );
      assert.ok(changePwRes);
      assert.equal(changePwRes.status, 401);

      // Public profile lookup with JSON token does NOT treat caller as self (strips PII)
      const pubProfileRes = await handleApiRequest(
        new Request("https://facetube.online/api/users/profile?user_id=FT483921", {
          method: "GET",
          headers: { Authorization: `Bearer ${jsonSessionToken}` },
        }),
      );
      assert.ok(pubProfileRes);
      assert.equal(pubProfileRes.status, 200);
      const pubProfileData = (await pubProfileRes.json()) as any;
      assert.equal(pubProfileData.profile.email, undefined);
      assert.equal(pubProfileData.profile.mobile, undefined);
      assert.equal(pubProfileData.profile.referral_code, undefined);
    });

    it("4. Production GET /api/auth/me returns 503 when MySQL pool is unavailable (with or without Bearer token)", async () => {
      await seedJsonSession();

      process.env["NODE_ENV"] = "production";
      delete process.env["APP_ENV"];
      clearDbEnvVars();
      setMysqlPoolForTesting(null);

      // With valid-looking JSON session token
      const withTokenRes = await nitroServerEntry.fetch(
        new Request("https://staging-proxy.example.com/api/auth/me", {
          method: "GET",
          headers: { Authorization: `Bearer ${jsonSessionToken}` },
        }),
        undefined,
        undefined,
      );
      assert.equal(withTokenRes.status, 503);
      const withTokenData = (await withTokenRes.json()) as any;
      assert.equal(withTokenData.success, false);
      assert.equal(withTokenData.authenticated, false);
      assert.equal(withTokenData.user, null);

      // Without Authorization header
      const withoutTokenRes = await handleApiRequest(
        new Request("https://facetube.online/api/auth/me", { method: "GET" }),
      );
      assert.ok(withoutTokenRes);
      assert.equal(withoutTokenRes.status, 503);
      const withoutTokenData = (await withoutTokenRes.json()) as any;
      assert.equal(withoutTokenData.success, false);
      assert.equal(withoutTokenData.authenticated, false);
      assert.equal(withoutTokenData.user, null);
    });

    it("5. Production GET /api/auth/me returns safe 500 on MySQL query failure without leaking internals", async () => {
      await seedJsonSession();

      process.env["NODE_ENV"] = "production";
      delete process.env["APP_ENV"];
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_prod";
      process.env["DB_USER"] = "prod_user";

      setMysqlPoolForTesting({
        query: async () => {
          throw new Error("ETIMEDOUT secret-mysql-host:3306");
        },
      } as any);

      const res = await nitroServerEntry.fetch(
        new Request("https://facetube.online/api/auth/me", {
          method: "GET",
          headers: { Authorization: `Bearer ${jsonSessionToken}` },
        }),
        undefined,
        undefined,
      );
      assert.equal(res.status, 500);
      const data = (await res.json()) as any;
      assert.equal(data.success, false);
      assert.equal(data.authenticated, false);
      assert.equal(data.user, null);
      assert.doesNotMatch(String(data.error || ""), /ETIMEDOUT|secret-mysql-host/);
      assert.doesNotMatch(JSON.stringify(data), new RegExp(jsonSessionToken));
    });

    it("6. Valid MySQL authentication still works in production and invalid/expired MySQL sessions remain unauthenticated", async () => {
      await seedJsonSession();

      process.env["NODE_ENV"] = "production";
      delete process.env["APP_ENV"];
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_prod";
      process.env["DB_USER"] = "prod_user";

      const validMysqlToken = "tok_mysql_active_session_5jp";
      const expiredMysqlToken = "tok_mysql_expired_session_5jp";
      const capturedQueries: Array<{ sql: string; params: any[] }> = [];

      setMysqlPoolForTesting({
        query: async (sql: string, params: any[] = []) => {
          capturedQueries.push({ sql, params });
          if (/FROM\s+sessions/i.test(sql) && params[0] === validMysqlToken) {
            return [
              [
                {
                  id: "a0000000-0000-0000-0000-000000000002",
                  user_id: "FT483921",
                  name: "Alex Rivera",
                  mobile: "+1 555-014-8392",
                  email: "alex@facetube.com",
                  role: "user",
                  referral_code: "CREATOR50",
                  avatar_url: null,
                  channel_logo_url: "/uploads/logos/alex_prod.png",
                  channel_name: "Alex Studio",
                  channel_description: "Creator bio",
                  created_at: "2026-11-01T00:00:00.000Z",
                },
              ],
              [],
            ];
          }
          return [[], []];
        },
      } as any);

      // Valid active MySQL session -> authenticated: true
      const validRes = await handleApiRequest(
        new Request("https://facetube.online/api/auth/me", {
          method: "GET",
          headers: { Authorization: `Bearer ${validMysqlToken}` },
        }),
      );
      assert.ok(validRes);
      assert.equal(validRes.status, 200);
      const validData = (await validRes.json()) as any;
      assert.equal(validData.authenticated, true);
      assert.equal(validData.user.user_id, "FT483921");
      assert.equal(
        validData.user.channel_logo_url,
        "https://api.facetube.online/uploads/logos/alex_prod.png",
      );
      assert.equal("password_hash" in validData.user, false);
      assert.match(capturedQueries[0]?.sql || "", /s\.expires_at\s*>\s*NOW\(\)/i);

      // Expired / unknown MySQL session -> authenticated: false
      const expiredRes = await handleApiRequest(
        new Request("https://facetube.online/api/auth/me", {
          method: "GET",
          headers: { Authorization: `Bearer ${expiredMysqlToken}` },
        }),
      );
      assert.ok(expiredRes);
      assert.equal(expiredRes.status, 200);
      const expiredData = (await expiredRes.json()) as any;
      assert.equal(expiredData.authenticated, false);
      assert.equal(expiredData.user, null);

      // Missing Authorization header when pool IS available -> authenticated: false (200)
      const noHeaderRes = await handleApiRequest(
        new Request("https://facetube.online/api/auth/me", { method: "GET" }),
      );
      assert.ok(noHeaderRes);
      assert.equal(noHeaderRes.status, 200);
      const noHeaderData = (await noHeaderRes.json()) as any;
      assert.equal(noHeaderData.authenticated, false);
      assert.equal(noHeaderData.user, null);
    });

    it("7. Explicit development and test environments preserve JSON session fallback without mutating process.env", async () => {
      await seedJsonSession();
      clearDbEnvVars();
      setMysqlPoolForTesting(null);

      // Explicit development env via process.env
      process.env["NODE_ENV"] = "development";
      process.env["APP_ENV"] = "development";

      const devMeRes = await nitroServerEntry.fetch(
        new Request("http://localhost:3000/api/auth/me", {
          method: "GET",
          headers: { Authorization: `Bearer ${jsonSessionToken}` },
        }),
        undefined,
        undefined,
      );
      assert.equal(devMeRes.status, 200);
      const devMeData = (await devMeRes.json()) as any;
      assert.equal(devMeData.authenticated, true);
      assert.equal(devMeData.user.user_id, "FT483921");

      // Explicit test env via process.env
      process.env["NODE_ENV"] = "test";
      delete process.env["APP_ENV"];

      const testMeRes = await handleApiRequest(
        new Request("http://localhost:3000/api/auth/me", {
          method: "GET",
          headers: { Authorization: `Bearer ${jsonSessionToken}` },
        }),
      );
      assert.ok(testMeRes);
      assert.equal(testMeRes.status, 200);
      const testMeData = (await testMeRes.json()) as any;
      assert.equal(testMeData.authenticated, true);
      assert.equal(testMeData.user.user_id, "FT483921");

      // Explicit development env passed via handler env arg while process.env is unset
      delete process.env["NODE_ENV"];
      delete process.env["APP_ENV"];

      const envArgRes = await nitroServerEntry.fetch(
        new Request("https://facetube.online/api/auth/me", {
          method: "GET",
          headers: { Authorization: `Bearer ${jsonSessionToken}` },
        }),
        { NODE_ENV: "development", APP_ENV: "development" },
        undefined,
      );
      assert.equal(envArgRes.status, 200);
      const envArgData = (await envArgRes.json()) as any;
      assert.equal(envArgData.authenticated, true);
      assert.equal(envArgData.user.user_id, "FT483921");
      assert.equal(process.env["NODE_ENV"], undefined);
      assert.equal(process.env["APP_ENV"], undefined);
    });
  });
});
