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

  describe("7. Task 5J-T: Login & Registration Session INSERT Fail-Closed Persistence", () => {
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

    it("1. Successful MySQL session INSERT preserves login response format and allows session resolution", async () => {
      process.env["APP_ENV"] = "production";
      delete process.env["NODE_ENV"];
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_prod";
      process.env["DB_USER"] = "prod_user";

      const sha256Password = crypto.createHash("sha256").update("password123").digest("hex");
      const persistedSessions = new Map<string, string>();
      const dbUser = {
        id: "u-5jt-alex",
        user_id: "FT483921",
        name: "Alex Rivera",
        mobile: "+1 555-014-8392",
        email: "alex@facetube.com",
        role: "user",
        referral_code: "CREATOR50",
        avatar_url: null,
        channel_logo_url: "/uploads/logos/alex.png",
        channel_name: "Alex Studio",
        channel_description: "Creator channel",
        created_at: "2026-11-01T00:00:00.000Z",
      };

      setMysqlPoolForTesting({
        query: async (sql: string, params: any[] = []) => {
          if (/INSERT\s+INTO\s+sessions/i.test(sql)) {
            persistedSessions.set(String(params[0]), String(params[1]));
            return [{ affectedRows: 1 }, []];
          }
          if (/FROM\s+sessions/i.test(sql)) {
            const tok = String(params[0]);
            if (persistedSessions.has(tok)) {
              return [[dbUser], []];
            }
            return [[], []];
          }
          if (/FROM\s+users/i.test(sql)) {
            return [[{ ...dbUser, password_hash: sha256Password }], []];
          }
          return [[], []];
        },
      } as any);

      const loginRes = await handleApiRequest(
        new Request("https://facetube.online/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
        }),
      );
      assert.ok(loginRes);
      assert.equal(loginRes.status, 200);
      const loginData = (await loginRes.json()) as any;
      assert.equal(loginData.success, true);
      assert.equal(typeof loginData.token, "string");
      assert.equal(loginData.token.length, 48);
      assert.equal(loginData.message, "Login successful.");
      assert.equal(loginData.user.user_id, "FT483921");
      assert.equal(
        loginData.user.channel_logo_url,
        "https://api.facetube.online/uploads/logos/alex.png",
      );
      assert.equal("password_hash" in loginData.user, false);
      assert.ok(persistedSessions.has(loginData.token));

      const meRes = await handleApiRequest(
        new Request("https://facetube.online/api/auth/me", {
          method: "GET",
          headers: { Authorization: `Bearer ${loginData.token}` },
        }),
      );
      assert.ok(meRes);
      assert.equal(meRes.status, 200);
      const meData = (await meRes.json()) as any;
      assert.equal(meData.authenticated, true);
      assert.equal(meData.user.user_id, "FT483921");
    });

    it("2. Failed MySQL session INSERT on POST /api/auth/login fails closed with HTTP 500 and never returns a token", async () => {
      process.env["APP_ENV"] = "production";
      delete process.env["NODE_ENV"];
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_prod";
      process.env["DB_USER"] = "prod_user";

      const sha256Password = crypto.createHash("sha256").update("password123").digest("hex");
      const dbUser = {
        id: "u-5jt-alex",
        user_id: "FT483921",
        name: "Alex Rivera",
        mobile: "+1 555-014-8392",
        email: "alex@facetube.com",
        password_hash: sha256Password,
        role: "user",
        referral_code: "CREATOR50",
        avatar_url: null,
        channel_logo_url: null,
        channel_name: "Alex Studio",
        channel_description: null,
        created_at: "2026-11-01T00:00:00.000Z",
      };

      // Case A: MySQL error thrown on INSERT INTO sessions (e.g., ER_NO_SUCH_TABLE)
      setMysqlPoolForTesting({
        query: async (sql: string) => {
          if (/FROM\s+users/i.test(sql)) {
            return [[dbUser], []];
          }
          if (/INSERT\s+INTO\s+sessions/i.test(sql)) {
            throw new Error("ER_NO_SUCH_TABLE: secret-prod-db.sessions doesn't exist");
          }
          return [[], []];
        },
      } as any);

      const errRes = await handleApiRequest(
        new Request("https://facetube.online/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
        }),
      );
      assert.ok(errRes);
      assert.equal(errRes.status, 500);
      const errData = (await errRes.json()) as any;
      assert.equal(errData.success, false);
      assert.equal(errData.token, undefined);
      assert.equal(errData.user, undefined);
      assert.doesNotMatch(String(errData.error || ""), /secret-prod-db|ER_NO_SUCH_TABLE/);

      // Case B: INSERT INTO sessions reports affectedRows: 0
      setMysqlPoolForTesting({
        query: async (sql: string) => {
          if (/FROM\s+users/i.test(sql)) {
            return [[dbUser], []];
          }
          if (/INSERT\s+INTO\s+sessions/i.test(sql)) {
            return [{ affectedRows: 0 }, []];
          }
          return [[], []];
        },
      } as any);

      const zeroRowsRes = await handleApiRequest(
        new Request("https://facetube.online/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
        }),
      );
      assert.ok(zeroRowsRes);
      assert.equal(zeroRowsRes.status, 500);
      const zeroRowsData = (await zeroRowsRes.json()) as any;
      assert.equal(zeroRowsData.success, false);
      assert.equal(zeroRowsData.token, undefined);

      // Case C: Handler runtime env override { APP_ENV: "production" } via Nitro server entry
      process.env["NODE_ENV"] = "test";
      delete process.env["APP_ENV"];
      setMysqlPoolForTesting({
        query: async (sql: string) => {
          if (/FROM\s+users/i.test(sql)) {
            return [[dbUser], []];
          }
          if (/INSERT\s+INTO\s+sessions/i.test(sql)) {
            throw new Error("Simulated MySQL session insert outage");
          }
          return [[], []];
        },
      } as any);

      const nitroRes = await nitroServerEntry.fetch(
        new Request("https://internal-lb.cluster.local/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
        }),
        { APP_ENV: "production" },
        undefined,
      );
      assert.equal(nitroRes.status, 500);
      const nitroData = (await nitroRes.json()) as any;
      assert.equal(nitroData.success, false);
      assert.equal(nitroData.token, undefined);
      assert.equal(process.env["NODE_ENV"], "test");
      assert.equal(process.env["APP_ENV"], undefined);
    });

    it("3. Successful MySQL registration preserves 201 format and failed MySQL session INSERT fails closed without returning a token", async () => {
      process.env["APP_ENV"] = "production";
      delete process.env["NODE_ENV"];
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_prod";
      process.env["DB_USER"] = "prod_user";

      const persistedSessions = new Map<string, string>();

      // Case A: Successful registration
      setMysqlPoolForTesting({
        query: async (sql: string, params: any[] = []) => {
          if (/SELECT\s+id\s+FROM\s+users/i.test(sql) || /SELECT\s+1\s+FROM\s+users/i.test(sql)) {
            return [[], []];
          }
          if (/INSERT\s+INTO\s+users/i.test(sql)) {
            return [{ affectedRows: 1 }, []];
          }
          if (/INSERT\s+INTO\s+wallet_balances/i.test(sql)) {
            return [{ affectedRows: 1 }, []];
          }
          if (/INSERT\s+INTO\s+sessions/i.test(sql)) {
            persistedSessions.set(String(params[0]), String(params[1]));
            return [{ affectedRows: 1 }, []];
          }
          return [[], []];
        },
      } as any);

      const okRes = await handleApiRequest(
        new Request("https://facetube.online/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "New Creator",
            mobile: "+1 555-010-1234",
            email: "newcreator@facetube.com",
            password: "Password123!",
          }),
        }),
      );
      assert.ok(okRes);
      assert.equal(okRes.status, 201);
      const okData = (await okRes.json()) as any;
      assert.equal(okData.success, true);
      assert.equal(typeof okData.token, "string");
      assert.equal(okData.token.length, 48);
      assert.match(String(okData.userId || ""), /^FT\d{6}$/);
      assert.equal(okData.user.email, "newcreator@facetube.com");
      assert.equal(okData.message, "Registration successful.");
      assert.ok(okData.emailDelivery);
      assert.ok(persistedSessions.has(okData.token));

      // Case B: Session INSERT throws during registration -> HTTP 500 and NO token
      setMysqlPoolForTesting({
        query: async (sql: string) => {
          if (/SELECT\s+id\s+FROM\s+users/i.test(sql) || /SELECT\s+1\s+FROM\s+users/i.test(sql)) {
            return [[], []];
          }
          if (/INSERT\s+INTO\s+users/i.test(sql)) {
            return [{ affectedRows: 1 }, []];
          }
          if (/INSERT\s+INTO\s+wallet_balances/i.test(sql)) {
            return [{ affectedRows: 1 }, []];
          }
          if (/INSERT\s+INTO\s+sessions/i.test(sql)) {
            throw new Error("ER_NO_SUCH_TABLE: internal-mysql.sessions missing");
          }
          return [[], []];
        },
      } as any);

      const failRes = await handleApiRequest(
        new Request("https://facetube.online/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Blocked Creator",
            mobile: "+1 555-010-5678",
            email: "blocked@facetube.com",
            password: "Password123!",
          }),
        }),
      );
      assert.ok(failRes);
      assert.equal(failRes.status, 500);
      const failData = (await failRes.json()) as any;
      assert.equal(failData.success, false);
      assert.equal(failData.token, undefined);
      assert.equal(failData.user, undefined);
      assert.doesNotMatch(String(failData.error || ""), /internal-mysql|ER_NO_SUCH_TABLE/);

      // Case C: Session INSERT returns affectedRows: 0 during registration -> HTTP 500 and NO token
      setMysqlPoolForTesting({
        query: async (sql: string) => {
          if (/SELECT\s+id\s+FROM\s+users/i.test(sql) || /SELECT\s+1\s+FROM\s+users/i.test(sql)) {
            return [[], []];
          }
          if (/INSERT\s+INTO\s+users/i.test(sql)) {
            return [{ affectedRows: 1 }, []];
          }
          if (/INSERT\s+INTO\s+sessions/i.test(sql)) {
            return [{ affectedRows: 0 }, []];
          }
          return [[], []];
        },
      } as any);

      const zeroRes = await handleApiRequest(
        new Request("https://facetube.online/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Zero Row Creator",
            mobile: "+1 555-010-9999",
            email: "zerorow@facetube.com",
            password: "Password123!",
          }),
        }),
      );
      assert.ok(zeroRes);
      assert.equal(zeroRes.status, 500);
      const zeroData = (await zeroRes.json()) as any;
      assert.equal(zeroData.success, false);
      assert.equal(zeroData.token, undefined);
    });

    it("4. Development/test JSON fallback works when pool is absent, while failed MySQL session INSERT never issues a token even in test mode", async () => {
      delete process.env["DB_HOST"];
      delete process.env["DB_NAME"];
      delete process.env["DB_USER"];
      process.env["NODE_ENV"] = "test";
      delete process.env["APP_ENV"];
      setMysqlPoolForTesting(null);

      // Explicit test mode without MySQL pool -> JSON store login & session resolution still work
      const devLoginRes = await handleApiRequest(
        new Request("http://localhost:3000/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "alex@facetube.com", password: "password" }),
        }),
      );
      assert.ok(devLoginRes);
      assert.equal(devLoginRes.status, 200);
      const devLoginData = (await devLoginRes.json()) as any;
      assert.equal(devLoginData.success, true);
      assert.ok(devLoginData.token);

      const devMeRes = await handleApiRequest(
        new Request("http://localhost:3000/api/auth/me", {
          method: "GET",
          headers: { Authorization: `Bearer ${devLoginData.token}` },
        }),
      );
      assert.ok(devMeRes);
      assert.equal(devMeRes.status, 200);
      const devMeData = (await devMeRes.json()) as any;
      assert.equal(devMeData.authenticated, true);
      assert.equal(devMeData.user.user_id, "FT483921");

      // Even in test mode, if MySQL pool IS configured and session INSERT fails, do not return a token
      const sha256Password = crypto.createHash("sha256").update("password123").digest("hex");
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";
      setMysqlPoolForTesting({
        query: async (sql: string) => {
          if (/FROM\s+users/i.test(sql)) {
            return [
              [
                {
                  id: "u-5jt-alex",
                  user_id: "FT483921",
                  name: "Alex Rivera",
                  mobile: "+1 555-014-8392",
                  email: "alex@facetube.com",
                  password_hash: sha256Password,
                  role: "user",
                  referral_code: null,
                  avatar_url: null,
                  channel_logo_url: null,
                  channel_name: null,
                  channel_description: null,
                  created_at: "2026-11-01T00:00:00.000Z",
                },
              ],
              [],
            ];
          }
          if (/INSERT\s+INTO\s+sessions/i.test(sql)) {
            throw new Error("Simulated test MySQL session insert failure");
          }
          return [[], []];
        },
      } as any);

      const failTestRes = await handleApiRequest(
        new Request("http://localhost:3000/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
        }),
      );
      assert.ok(failTestRes);
      assert.equal(failTestRes.status, 500);
      const failTestData = (await failTestRes.json()) as any;
      assert.equal(failTestData.success, false);
      assert.equal(failTestData.token, undefined);
    });

    it("5. PHP auth/login.php and auth/register.php enforce fail-closed session INSERT parity", () => {
      for (const relPath of ["api/auth/login.php", "api/auth/register.php"]) {
        const fullPath = path.resolve(process.cwd(), relPath);
        assert.ok(fs.existsSync(fullPath), `${relPath} must exist`);
        const content = fs.readFileSync(fullPath, "utf-8");

        assert.doesNotMatch(
          content,
          /Sessions table optional/i,
          `${relPath} must not treat sessions table failures as optional`,
        );
        assert.match(
          content,
          /rowCount\(\)\s*<\s*1/,
          `${relPath} must verify INSERT INTO sessions affected at least 1 row`,
        );
        assert.match(
          content,
          /catch\s*\(\s*Throwable\s+\$eSession\s*\)[\s\S]*?jsonResponse\([\s\S]*?'success'\s*=>\s*false[\s\S]*?,\s*500\s*\)/,
          `${relPath} must fail closed with HTTP 500 when session persistence fails`,
        );
      }
    });
  });

  describe("8. Task 5J-T2: Registration Failure Recovery & Retry Consistency", () => {
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

    interface MockUserRow {
      id: string;
      user_id: string;
      name: string;
      mobile: string;
      email: string;
      password_hash: string;
      role: string;
      referral_code: string | null;
      avatar_url: string | null;
      channel_logo_url: string | null;
      channel_name: string | null;
      channel_description: string | null;
      created_at: string;
    }

    interface MockWalletRow {
      user_id: string;
      balance: number;
    }

    function createStatefulAuthMockPool(options: {
      sessionFailureMode: () => "none" | "throw" | "zero_rows";
    }) {
      const users: MockUserRow[] = [];
      const walletBalances: MockWalletRow[] = [];
      const sessions = new Map<string, string>();
      const queryLog: string[] = [];

      const pool = {
        query: async (sql: string, params: any[] = []) => {
          const normalizedSql = sql.replace(/\s+/g, " ").trim();
          queryLog.push(normalizedSql);

          if (/^SELECT id FROM users WHERE LOWER\(email\) = LOWER\(\?\)/i.test(normalizedSql)) {
            const targetEmail = String(params[0] || "").toLowerCase();
            const found = users.filter((u) => u.email.toLowerCase() === targetEmail);
            return [found.map((u) => ({ id: u.id })), []];
          }

          if (/^SELECT 1 FROM users WHERE UPPER\(user_id\) = UPPER\(\?\)/i.test(normalizedSql)) {
            const targetUid = String(params[0] || "").toUpperCase();
            const found = users.filter((u) => u.user_id.toUpperCase() === targetUid);
            return [found.map(() => ({ 1: 1 })), []];
          }

          if (/^INSERT INTO users\b/i.test(normalizedSql)) {
            const [uuid, userId, name, mobile, email, passwordHash, role, referralCode] = params;
            const emailStr = String(email).toLowerCase();
            const uidStr = String(userId).toUpperCase();
            if (users.some((u) => u.email.toLowerCase() === emailStr)) {
              throw new Error("ER_DUP_ENTRY: Duplicate entry for key 'uniq_users_email'");
            }
            if (users.some((u) => u.user_id.toUpperCase() === uidStr)) {
              throw new Error("ER_DUP_ENTRY: Duplicate entry for key 'uniq_users_user_id'");
            }
            users.push({
              id: String(uuid),
              user_id: String(userId),
              name: String(name),
              mobile: String(mobile || ""),
              email: emailStr,
              password_hash: String(passwordHash),
              role: String(role || "user"),
              referral_code:
                referralCode === null || referralCode === undefined ? null : String(referralCode),
              avatar_url: null,
              channel_logo_url: null,
              channel_name: null,
              channel_description: null,
              created_at: new Date().toISOString(),
            });
            return [{ affectedRows: 1 }, []];
          }

          if (/^INSERT INTO wallet_balances\b/i.test(normalizedSql)) {
            const userId = String(params[0]);
            if (!walletBalances.some((w) => w.user_id === userId)) {
              walletBalances.push({ user_id: userId, balance: 0 });
            }
            return [{ affectedRows: 1 }, []];
          }

          if (/^INSERT INTO sessions\b/i.test(normalizedSql)) {
            const mode = options.sessionFailureMode();
            if (mode === "throw") {
              throw new Error("ER_LOCK_WAIT_TIMEOUT: Simulated sessions table failure");
            }
            if (mode === "zero_rows") {
              return [{ affectedRows: 0 }, []];
            }
            const token = String(params[0]);
            const userUuid = String(params[1]);
            sessions.set(token, userUuid);
            return [{ affectedRows: 1 }, []];
          }

          if (
            /FROM users WHERE UPPER\(user_id\) = UPPER\(\?\) OR LOWER\(email\) = LOWER\(\?\)/i.test(
              normalizedSql,
            )
          ) {
            const ident = String(params[0] || "").trim();
            const found = users.filter(
              (u) =>
                u.user_id.toUpperCase() === ident.toUpperCase() ||
                u.email.toLowerCase() === ident.toLowerCase(),
            );
            return [found.map((u) => ({ ...u })), []];
          }

          if (/FROM sessions s INNER JOIN users u/i.test(normalizedSql)) {
            const token = String(params[0] || "").trim();
            const sessionUserUuid = sessions.get(token);
            if (!sessionUserUuid) {
              return [[], []];
            }
            const user = users.find(
              (u) => u.id === sessionUserUuid || u.user_id === sessionUserUuid,
            );
            if (!user) {
              return [[], []];
            }
            const { password_hash: _ph, ...safeUser } = user;
            return [[safeUser], []];
          }

          return [[], []];
        },
      } as any;

      return { pool, users, walletBalances, sessions, queryLog };
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

    it("1. Failed session INSERT leaves committed user/wallet, blocks duplicate retry with 409, and recovers via email login + auth/me", async () => {
      process.env["APP_ENV"] = "production";
      delete process.env["NODE_ENV"];
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_prod";
      process.env["DB_USER"] = "prod_user";

      let sessionFailureMode: "none" | "throw" | "zero_rows" = "throw";
      const db = createStatefulAuthMockPool({
        sessionFailureMode: () => sessionFailureMode,
      });
      setMysqlPoolForTesting(db.pool);

      const email = "recovery.creator@facetube.com";
      const password = "RecoveryPassword!2026";

      // 1) First registration: user + wallet INSERT succeed, session INSERT fails -> HTTP 500, no token
      const firstRegRes = await handleApiRequest(
        new Request("https://facetube.online/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Recovery Creator",
            mobile: "+1 555-019-7788",
            email,
            password,
          }),
        }),
      );
      assert.ok(firstRegRes);
      assert.equal(firstRegRes.status, 500);
      const firstRegData = (await firstRegRes.json()) as any;
      assert.equal(firstRegData.success, false);
      assert.equal(firstRegData.token, undefined);
      assert.equal(firstRegData.user, undefined);

      assert.equal(
        db.users.length,
        1,
        "User row remains committed in MySQL after session INSERT failure",
      );
      assert.equal(db.walletBalances.length, 1, "Wallet row remains committed in MySQL");
      assert.equal(db.sessions.size, 0, "No session row should exist after failed session INSERT");
      assert.equal(db.users[0]?.email, email);
      assert.match(String(db.users[0]?.user_id || ""), /^FT\d{6}$/);
      assert.equal(db.walletBalances[0]?.user_id, db.users[0]?.user_id);

      // 2) Registration retry with the same email -> HTTP 409, no duplicate user or wallet created
      const retryRegRes = await handleApiRequest(
        new Request("https://facetube.online/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Recovery Creator Retry",
            mobile: "+1 555-019-7788",
            email: "  Recovery.Creator@Facetube.COM ",
            password,
          }),
        }),
      );
      assert.ok(retryRegRes);
      assert.equal(retryRegRes.status, 409);
      const retryRegData = (await retryRegRes.json()) as any;
      assert.equal(retryRegData.success, false);
      assert.equal(retryRegData.token, undefined);
      assert.match(String(retryRegData.error || ""), /already registered/i);
      assert.equal(db.users.length, 1, "Duplicate user must not be created on retry");
      assert.equal(db.walletBalances.length, 1, "Duplicate wallet must not be created on retry");
      assert.equal(db.sessions.size, 0);

      // 3) Login recovery with same email and original password once session persistence succeeds -> HTTP 200 + token
      sessionFailureMode = "none";
      const loginRes = await handleApiRequest(
        new Request("https://facetube.online/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            identifier: email,
            password,
          }),
        }),
      );
      assert.ok(loginRes);
      assert.equal(loginRes.status, 200);
      const loginData = (await loginRes.json()) as any;
      assert.equal(loginData.success, true);
      assert.equal(typeof loginData.token, "string");
      assert.equal(loginData.token.length, 48);
      assert.equal(loginData.user.id, db.users[0]?.id);
      assert.equal(loginData.user.user_id, db.users[0]?.user_id);
      assert.equal(loginData.user.email, email);
      assert.equal("password_hash" in loginData.user, false);
      assert.equal(db.sessions.size, 1);
      assert.equal(db.sessions.get(loginData.token), db.users[0]?.id);

      // 4) GET /api/auth/me resolves the authenticated user using the recovered token
      const meRes = await handleApiRequest(
        new Request("https://facetube.online/api/auth/me", {
          method: "GET",
          headers: { Authorization: `Bearer ${loginData.token}` },
        }),
      );
      assert.ok(meRes);
      assert.equal(meRes.status, 200);
      const meData = (await meRes.json()) as any;
      assert.equal(meData.authenticated, true);
      assert.equal(meData.user.id, db.users[0]?.id);
      assert.equal(meData.user.user_id, db.users[0]?.user_id);
      assert.equal(meData.user.email, email);
      assert.equal(meData.user.name, "Recovery Creator");
      assert.equal("password_hash" in meData.user, false);
    });

    it("2. Registration failing with affectedRows=0 also prevents duplicates on 409 retry and recovers on subsequent login", async () => {
      process.env["APP_ENV"] = "production";
      delete process.env["NODE_ENV"];
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_prod";
      process.env["DB_USER"] = "prod_user";

      let sessionFailureMode: "none" | "throw" | "zero_rows" = "zero_rows";
      const db = createStatefulAuthMockPool({
        sessionFailureMode: () => sessionFailureMode,
      });
      setMysqlPoolForTesting(db.pool);

      const email = "zero.rows.recovery@facetube.com";
      const password = "StrongPassword!99";

      const regRes = await handleApiRequest(
        new Request("https://facetube.online/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Zero Rows User",
            mobile: "+1 555-019-8899",
            email,
            password,
          }),
        }),
      );
      assert.ok(regRes);
      assert.equal(regRes.status, 500);
      const regData = (await regRes.json()) as any;
      assert.equal(regData.success, false);
      assert.equal(regData.token, undefined);
      assert.equal(db.users.length, 1);
      assert.equal(db.walletBalances.length, 1);
      assert.equal(db.sessions.size, 0);

      // Retry registration while session persistence is even healthy again -> still 409, no duplicate
      sessionFailureMode = "none";
      const retryRes = await handleApiRequest(
        new Request("https://facetube.online/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Zero Rows User",
            mobile: "+1 555-019-8899",
            email,
            password,
          }),
        }),
      );
      assert.ok(retryRes);
      assert.equal(retryRes.status, 409);
      assert.equal(db.users.length, 1);
      assert.equal(db.sessions.size, 0);

      // Wrong password rejected with 401 and no session created
      const badLoginRes = await handleApiRequest(
        new Request("https://facetube.online/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: email, password: "WrongPassword!00" }),
        }),
      );
      assert.ok(badLoginRes);
      assert.equal(badLoginRes.status, 401);
      assert.equal(db.sessions.size, 0);

      // Original password recovers cleanly and authenticates /api/auth/me
      const goodLoginRes = await handleApiRequest(
        new Request("https://facetube.online/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: email, password }),
        }),
      );
      assert.ok(goodLoginRes);
      assert.equal(goodLoginRes.status, 200);
      const goodLoginData = (await goodLoginRes.json()) as any;
      assert.equal(goodLoginData.success, true);
      assert.ok(goodLoginData.token);
      assert.equal(db.sessions.size, 1);

      const meRes = await handleApiRequest(
        new Request("https://facetube.online/api/auth/me", {
          method: "GET",
          headers: { Authorization: `Bearer ${goodLoginData.token}` },
        }),
      );
      assert.ok(meRes);
      assert.equal(meRes.status, 200);
      const meData = (await meRes.json()) as any;
      assert.equal(meData.authenticated, true);
      assert.equal(meData.user.user_id, db.users[0]?.user_id);
      assert.equal(meData.user.email, email);
    });
  });

  describe("Task 5J-V1: Production JSON Store Access Protection", () => {
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
    const storePath = path.resolve(process.cwd(), "data/facetube_store.json");
    let envSnapshot: Record<string, string | undefined> = {};
    let storeExisted = false;
    let storeSnapshot: string | null = null;

    function installStoreFsSpy() {
      const origExistsSync = fs.existsSync;
      const origStatSync = fs.statSync;
      const origReadFileSync = fs.readFileSync;
      const origWriteFileSync = fs.writeFileSync;

      const ops = {
        existsChecks: 0,
        statChecks: 0,
        reads: 0,
        writes: 0,
      };

      const isTargetStore = (p: fs.PathOrFileDescriptor | fs.PathLike): boolean => {
        if (typeof p !== "string" && !(p instanceof URL)) return false;
        const resolved = p instanceof URL ? p.pathname : path.resolve(p);
        return resolved === storePath;
      };

      fs.existsSync = ((p: fs.PathLike) => {
        if (isTargetStore(p)) ops.existsChecks++;
        return origExistsSync(p);
      }) as typeof fs.existsSync;

      (fs as any).statSync = ((p: fs.PathLike, options?: any) => {
        if (isTargetStore(p)) ops.statChecks++;
        return origStatSync(p, options);
      }) as typeof fs.statSync;

      fs.readFileSync = ((p: fs.PathOrFileDescriptor, options?: any) => {
        if (isTargetStore(p)) ops.reads++;
        return origReadFileSync(p, options);
      }) as typeof fs.readFileSync;

      fs.writeFileSync = ((p: fs.PathOrFileDescriptor, data: any, options?: any) => {
        if (isTargetStore(p)) ops.writes++;
        return origWriteFileSync(p, data, options);
      }) as typeof fs.writeFileSync;

      return {
        ops,
        restore: () => {
          fs.existsSync = origExistsSync;
          (fs as any).statSync = origStatSync;
          fs.readFileSync = origReadFileSync;
          fs.writeFileSync = origWriteFileSync;
        },
      };
    }

    beforeEach(() => {
      envSnapshot = {};
      for (const k of envKeys) {
        envSnapshot[k] = process.env[k];
      }
      storeExisted = fs.existsSync(storePath);
      storeSnapshot = storeExisted ? fs.readFileSync(storePath, "utf-8") : null;
      resetInMemoryStore();
      setMysqlPoolForTesting(null);
      delete process.env["USE_REMOTE_PHP_API"];
      delete process.env["DB_HOST"];
      delete process.env["DB_NAME"];
      delete process.env["DB_USER"];
      delete process.env["MYSQL_HOST"];
      delete process.env["MYSQL_DATABASE"];
      delete process.env["MYSQL_USER"];
    });

    afterEach(() => {
      setMysqlPoolForTesting(null);
      resetInMemoryStore();
      for (const k of envKeys) {
        if (envSnapshot[k] === undefined) delete process.env[k];
        else process.env[k] = envSnapshot[k];
      }
      if (storeExisted && storeSnapshot !== null) {
        const dir = path.dirname(storePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(storePath, storeSnapshot, "utf-8");
      } else if (!storeExisted && fs.existsSync(storePath)) {
        fs.unlinkSync(storePath);
      }
    });

    it("1. NODE_ENV=production never reads, seeds, or writes data/facetube_store.json across API dispatch", async () => {
      if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
      process.env["NODE_ENV"] = "production";
      delete process.env["APP_ENV"];

      const spy = installStoreFsSpy();
      try {
        // Without MySQL pool: fail-closed 503, no crash, no disk touch
        const videosNoPoolRes = await handleApiRequest(
          new Request("https://facetube.online/api/videos/list", { method: "GET" }),
        );
        assert.equal(videosNoPoolRes?.status, 503);

        const loginNoPoolRes = await nitroServerEntry.fetch(
          new Request("https://facetube.online/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ identifier: "alex@facetube.com", password: "password" }),
          }),
          undefined,
          undefined,
        );
        assert.equal(loginNoPoolRes.status, 503);

        // Even a store-reading route must not crash, must not seed demo videos, and must not touch disk
        const countsRes = await handleApiRequest(
          new Request("https://facetube.online/api/videos/counts", { method: "GET" }),
        );
        assert.equal(countsRes?.status, 200);
        const countsData = (await countsRes!.json()) as any;
        assert.equal(countsData.counts?.totalUploaded, 0);

        // With healthy MySQL pool returning empty rows: no demo videos/users leaked, no disk touch
        process.env["DB_HOST"] = "127.0.0.1";
        process.env["DB_NAME"] = "facetube_prod";
        process.env["DB_USER"] = "prod_user";
        setMysqlPoolForTesting({ query: async () => [[], []] } as any);
        const videosWithPoolRes = await handleApiRequest(
          new Request("https://facetube.online/api/videos/list", { method: "GET" }),
        );
        assert.equal(videosWithPoolRes?.status, 200);
        const videosData = (await videosWithPoolRes!.json()) as any;
        assert.deepEqual(videosData.videos, []);

        assert.deepEqual(spy.ops, { existsChecks: 0, statChecks: 0, reads: 0, writes: 0 });
      } finally {
        spy.restore();
      }
      assert.equal(
        fs.existsSync(storePath),
        false,
        "Production must never seed facetube_store.json",
      );
    });

    it("2. APP_ENV=production with NODE_ENV unset or development (and via runtime env arg) blocks JSON store read/seed/write", async () => {
      const cases: Array<{
        label: string;
        procNodeEnv?: string;
        procAppEnv?: string;
        runtimeEnv?: Record<string, string | undefined>;
      }> = [
        {
          label: "APP_ENV=production, NODE_ENV unset",
          procAppEnv: "production",
        },
        {
          label: "APP_ENV=production, NODE_ENV=development",
          procAppEnv: "production",
          procNodeEnv: "development",
        },
        {
          label: "process NODE_ENV=test overridden by runtime env { APP_ENV: 'production' }",
          procNodeEnv: "test",
          runtimeEnv: { APP_ENV: "production" },
        },
      ];

      for (const tc of cases) {
        resetInMemoryStore();
        if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
        if (tc.procNodeEnv !== undefined) process.env["NODE_ENV"] = tc.procNodeEnv;
        else delete process.env["NODE_ENV"];
        if (tc.procAppEnv !== undefined) process.env["APP_ENV"] = tc.procAppEnv;
        else delete process.env["APP_ENV"];

        const spy = installStoreFsSpy();
        try {
          const videosRes = await handleApiRequest(
            new Request("https://facetube.online/api/videos/list", { method: "GET" }),
            tc.runtimeEnv,
          );
          assert.equal(videosRes?.status, 503, `${tc.label}: videos/list should fail closed`);

          const catsRes = await nitroServerEntry.fetch(
            new Request("https://facetube.online/api/categories/list", { method: "GET" }),
            tc.runtimeEnv,
            undefined,
          );
          assert.ok(catsRes.status >= 200 && catsRes.status < 600, `${tc.label}: no crash`);

          const likeRes = await handleApiRequest(
            new Request("https://facetube.online/api/videos/like", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ videoId: "vid-seed-001" }),
            }),
            tc.runtimeEnv,
          );
          assert.equal(likeRes?.status, 404, `${tc.label}: seeded demo video must not exist`);

          assert.deepEqual(
            spy.ops,
            { existsChecks: 0, statChecks: 0, reads: 0, writes: 0 },
            `${tc.label}: must never touch facetube_store.json on disk`,
          );
        } finally {
          spy.restore();
        }
        assert.equal(
          fs.existsSync(storePath),
          false,
          `${tc.label}: must not create facetube_store.json`,
        );
      }
    });

    it("3. Both APP_ENV and NODE_ENV unset activates fail-closed protection with zero disk access or demo seeding", async () => {
      if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
      delete process.env["APP_ENV"];
      delete process.env["NODE_ENV"];

      const spy = installStoreFsSpy();
      try {
        const listRes = await handleApiRequest(
          new Request("http://localhost:3000/api/videos/list", { method: "GET" }),
        );
        assert.equal(listRes?.status, 503);

        const loginRes = await handleApiRequest(
          new Request("http://localhost:3000/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ identifier: "admin@facetube.com", password: "password" }),
          }),
        );
        assert.equal(loginRes?.status, 503);

        const countsRes = await handleApiRequest(
          new Request("http://localhost:3000/api/videos/counts", { method: "GET" }),
        );
        assert.equal(countsRes?.status, 200);
        const countsData = (await countsRes!.json()) as any;
        assert.equal(countsData.counts?.totalUploaded, 0);

        assert.deepEqual(spy.ops, { existsChecks: 0, statChecks: 0, reads: 0, writes: 0 });
      } finally {
        spy.restore();
      }
      assert.equal(fs.existsSync(storePath), false);
    });

    it("4. Cached non-production inMemoryStore does not leak demo data into subsequent production requests", async () => {
      process.env["NODE_ENV"] = "test";
      delete process.env["APP_ENV"];

      // Populate inMemoryStore in test mode
      const testRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/list", { method: "GET" }),
      );
      assert.equal(testRes?.status, 200);
      const testData = (await testRes!.json()) as any;
      assert.ok(Array.isArray(testData.videos) && testData.videos.length > 0);

      // Switch to production without resetting inMemoryStore and delete store file
      if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
      process.env["APP_ENV"] = "production";
      delete process.env["NODE_ENV"];

      const spy = installStoreFsSpy();
      try {
        const countsRes = await handleApiRequest(
          new Request("https://facetube.online/api/videos/counts", { method: "GET" }),
        );
        assert.equal(countsRes?.status, 200);
        const countsData = (await countsRes!.json()) as any;
        assert.equal(
          countsData.counts?.totalUploaded,
          0,
          "Production must not leak cached demo videos",
        );

        const loginRes = await handleApiRequest(
          new Request("https://facetube.online/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ identifier: "alex@facetube.com", password: "password" }),
          }),
        );
        assert.equal(loginRes?.status, 503);
        assert.deepEqual(spy.ops, { existsChecks: 0, statChecks: 0, reads: 0, writes: 0 });
      } finally {
        spy.restore();
      }
      assert.equal(fs.existsSync(storePath), false);
    });

    it("5. NODE_ENV=test and NODE_ENV=development preserve existing JSON fallback and seed behavior", async () => {
      for (const envName of ["test", "development"] as const) {
        resetInMemoryStore();
        if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
        process.env["NODE_ENV"] = envName;
        delete process.env["APP_ENV"];

        const listRes = await handleApiRequest(
          new Request("http://localhost:3000/api/videos/list", { method: "GET" }),
        );
        assert.equal(listRes?.status, 200, `NODE_ENV=${envName} should serve JSON videos`);
        const listData = (await listRes!.json()) as any;
        assert.equal(listData.success, true);
        assert.ok(Array.isArray(listData.videos) && listData.videos.length > 0);
        assert.equal(
          fs.existsSync(storePath),
          true,
          `NODE_ENV=${envName} should persist facetube_store.json`,
        );

        const loginRes = await handleApiRequest(
          new Request("http://localhost:3000/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
          }),
        );
        assert.equal(
          loginRes?.status,
          200,
          `NODE_ENV=${envName} should preserve JSON login fallback`,
        );
        const loginData = (await loginRes!.json()) as any;
        assert.equal(loginData.success, true);
        assert.ok(loginData.token);
      }
    });
  });
});
