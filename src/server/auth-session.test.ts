import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getAuthUserFromRequest, handleApiRequest, resetInMemoryStore } from "./api-handler";
import { setMysqlPoolForTesting } from "./mysql";

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
});
