import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { handleApiRequest, resetInMemoryStore } from "./api-handler.ts";
import { setMysqlPoolForTesting } from "./mysql.ts";

async function callApi(req: Request, env?: Record<string, string | undefined>): Promise<Response> {
  const res = await handleApiRequest(req, env);
  assert.ok(res, "handleApiRequest returned null");
  return res;
}

function encryptForTest(plaintext: string, secretKey: string) {
  const key = crypto.createHash("sha256").update(secretKey).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  return {
    encrypted_refresh_token: encrypted,
    refresh_token_iv: iv.toString("hex"),
    refresh_token_tag: tag,
  };
}

describe("FaceTube Company AdMob Reporting API v1 (Step 9C Phase 2 — Staging Only) Test Suite", () => {
  const storePath = path.resolve(process.cwd(), "data/facetube_store.json");
  let initialStoreSnapshot = "";

  let adminSessionToken = "";
  let userSessionToken = "";
  const adminUserId = "FT102857";

  const testEncryptionKey = "facetube-test-admob-reporting-aes-256-gcm-key-2026!";
  const validPublisherId = "pub-1234567890123456";
  const validFaceTubeAppId = "ca-app-pub-1234567890123456~9876543210";
  const otherAppId = "ca-app-pub-1234567890123456~1111111111";

  const originalFetch = globalThis.fetch;
  const originalEnv: Record<string, string | undefined> = {
    ADMOB_OAUTH_CLIENT_ID: process.env["ADMOB_OAUTH_CLIENT_ID"],
    ADMOB_OAUTH_CLIENT_SECRET: process.env["ADMOB_OAUTH_CLIENT_SECRET"],
    ADMOB_ENCRYPTION_KEY: process.env["ADMOB_ENCRYPTION_KEY"],
    ADMOB_APP_ID: process.env["ADMOB_APP_ID"],
    NODE_ENV: process.env["NODE_ENV"],
    APP_ENV: process.env["APP_ENV"],
    DB_HOST: process.env["DB_HOST"],
    DB_NAME: process.env["DB_NAME"],
    DB_USER: process.env["DB_USER"],
  };

  function restoreEnv() {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
  }

  function resetToBaseTestEnv() {
    process.env["NODE_ENV"] = "test";
    delete process.env["APP_ENV"];
    delete process.env["DB_HOST"];
    delete process.env["DB_NAME"];
    delete process.env["DB_USER"];
    process.env["ADMOB_OAUTH_CLIENT_ID"] = "test-admob-client-id.apps.googleusercontent.com";
    process.env["ADMOB_OAUTH_CLIENT_SECRET"] = "test-admob-client-secret";
    process.env["ADMOB_ENCRYPTION_KEY"] = testEncryptionKey;
    process.env["ADMOB_APP_ID"] = validFaceTubeAppId;
  }

  function seedLocalConnectedOauth(overrideCurrency = "INR") {
    const store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    const enc = encryptForTest("1//mock-valid-refresh-token-xyz", testEncryptionKey);
    store.admobOauth = {
      id: 1,
      publisher_id: validPublisherId,
      account_name: "FaceTube Production AdMob",
      currency_code: overrideCurrency,
      ...enc,
      is_active: 1,
      connected_by: adminUserId,
      connected_at: "2026-10-01T00:00:00.000Z",
      updated_at: "2026-10-01T00:00:00.000Z",
    };
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
  }

  function readStoreJson() {
    return JSON.parse(fs.readFileSync(storePath, "utf-8"));
  }

  before(async () => {
    initialStoreSnapshot = fs.readFileSync(storePath, "utf-8");
    resetToBaseTestEnv();

    const adminLoginRes = await callApi(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: "admin@facetube.com",
          password: "password123",
        }),
      }),
    );
    const adminData = (await adminLoginRes.json()) as any;
    assert.ok(adminData.token, "Admin login must return session token");
    adminSessionToken = adminData.token;

    const userLoginRes = await callApi(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: "alex@facetube.com",
          password: "password123",
        }),
      }),
    );
    const userData = (await userLoginRes.json()) as any;
    assert.ok(userData.token, "Regular user login must return session token");
    userSessionToken = userData.token;

    // Update snapshot after login so active test session tokens are preserved cleanly
    initialStoreSnapshot = fs.readFileSync(storePath, "utf-8");
  });

  after(() => {
    globalThis.fetch = originalFetch;
    setMysqlPoolForTesting(null);
    restoreEnv();
    if (initialStoreSnapshot) {
      fs.writeFileSync(storePath, initialStoreSnapshot);
    }
  });

  // --------------------------------------------------------------------------
  // 1. RBAC & Fail-Closed Production Guards
  // --------------------------------------------------------------------------
  describe("1. RBAC & Fail-Closed Production Guards", () => {
    it("rejects unauthenticated requests with HTTP 401 on reports, sync-report, and verify-report", async () => {
      const r1 = await callApi(new Request("http://localhost:3000/api/admin/admob/reports"));
      assert.equal(r1.status, 401);

      const r2 = await callApi(
        new Request("http://localhost:3000/api/admin/admob/sync-report", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reportMonth: "2026-10" }),
        }),
      );
      assert.equal(r2.status, 401);

      const r3 = await callApi(
        new Request("http://localhost:3000/api/admin/admob/verify-report", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reportMonth: "2026-10" }),
        }),
      );
      assert.equal(r3.status, 401);
    });

    it("rejects non-admin users with HTTP 403 on reports, sync-report, and verify-report", async () => {
      const r1 = await callApi(
        new Request("http://localhost:3000/api/admin/admob/reports", {
          headers: { Authorization: `Bearer ${userSessionToken}` },
        }),
      );
      assert.equal(r1.status, 403);

      const r2 = await callApi(
        new Request("http://localhost:3000/api/admin/admob/sync-report", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userSessionToken}`,
          },
          body: JSON.stringify({ reportMonth: "2026-10" }),
        }),
      );
      assert.equal(r2.status, 403);

      const r3 = await callApi(
        new Request("http://localhost:3000/api/admin/admob/verify-report", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userSessionToken}`,
          },
          body: JSON.stringify({ reportMonth: "2026-10" }),
        }),
      );
      assert.equal(r3.status, 403);
    });

    it("fails closed with HTTP 503 in production when MySQL pool is unavailable", async () => {
      process.env["NODE_ENV"] = "production";
      setMysqlPoolForTesting(null);
      try {
        const r1 = await callApi(
          new Request("http://localhost:3000/api/admin/admob/reports", {
            headers: { Authorization: `Bearer ${adminSessionToken}` },
          }),
        );
        assert.equal(r1.status, 503);

        const r2 = await callApi(
          new Request("http://localhost:3000/api/admin/admob/sync-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ reportMonth: "2026-10" }),
          }),
        );
        assert.equal(r2.status, 503);

        const r3 = await callApi(
          new Request("http://localhost:3000/api/admin/admob/verify-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ reportMonth: "2026-10" }),
          }),
        );
        assert.equal(r3.status, 503);
      } finally {
        resetToBaseTestEnv();
      }
    });
  });

  // --------------------------------------------------------------------------
  // 2. FaceTube Android App ID Enforcement
  // --------------------------------------------------------------------------
  describe("2. Strict FaceTube Android App Scope Enforcement", () => {
    it("rejects missing, reserved test, malformed, or caller-mismatched ADMOB_APP_ID", async () => {
      seedLocalConnectedOauth();
      try {
        // Missing ADMOB_APP_ID -> 500
        delete process.env["ADMOB_APP_ID"];
        const missingRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/sync-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ reportMonth: "2026-10" }),
          }),
        );
        assert.equal(missingRes.status, 500);

        // Google reserved test App ID -> 400
        process.env["ADMOB_APP_ID"] = "ca-app-pub-3940256099942544~3347511713";
        const testIdRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/sync-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ reportMonth: "2026-10" }),
          }),
        );
        assert.equal(testIdRes.status, 400);

        // Malformed App ID -> 400
        process.env["ADMOB_APP_ID"] = "invalid-app-id";
        const badFormatRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/sync-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ reportMonth: "2026-10" }),
          }),
        );
        assert.equal(badFormatRes.status, 400);

        // Valid configured ID, but caller attempts to query a different appId -> 400
        process.env["ADMOB_APP_ID"] = validFaceTubeAppId;
        const mismatchRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/sync-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ reportMonth: "2026-10", appId: otherAppId }),
          }),
        );
        assert.equal(mismatchRes.status, 400);
        const mismatchData = (await mismatchRes.json()) as any;
        assert.ok(mismatchData.error.includes("FaceTube Android app ID"));
      } finally {
        resetToBaseTestEnv();
        fs.writeFileSync(storePath, initialStoreSnapshot);
      }
    });

    it("aborts with HTTP 422 if Google returns an unexpected non-FaceTube APP row", async () => {
      seedLocalConnectedOauth();
      let capturedReportBody: any = null;

      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "https://oauth2.googleapis.com/token") {
          return new Response(
            JSON.stringify({ access_token: "ya29.mock-access-token", expires_in: 3600 }),
            {
              status: 200,
            },
          );
        }
        if (url === `https://admob.googleapis.com/v1/accounts/${validPublisherId}`) {
          return new Response(
            JSON.stringify({
              name: `accounts/${validPublisherId}`,
              publisherId: validPublisherId,
              reportingTimeZone: "Asia/Kolkata",
              currencyCode: "INR",
            }),
            { status: 200 },
          );
        }
        if (
          url ===
          `https://admob.googleapis.com/v1/accounts/${validPublisherId}/networkReport:generate`
        ) {
          capturedReportBody = JSON.parse(String(init?.body || "{}"));
          return new Response(
            JSON.stringify([
              {
                header: {
                  localizationSettings: { currencyCode: "INR", languageCode: "en-US" },
                },
              },
              {
                row: {
                  dimensionValues: { APP: { value: otherAppId, displayLabel: "Rogue App" } },
                  metricValues: {
                    ESTIMATED_EARNINGS: { microsValue: "5000000" },
                    IMPRESSIONS: { integerValue: "100" },
                  },
                },
              },
            ]),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      }) as typeof fetch;

      try {
        const res = await callApi(
          new Request("http://localhost:3000/api/admin/admob/sync-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ reportMonth: "2026-10" }),
          }),
        );
        assert.equal(res.status, 422);
        const body = (await res.json()) as any;
        assert.ok(body.error.includes("non-FaceTube app row"));

        // Verify outgoing request strictly included APP dimension and filter for validFaceTubeAppId
        assert.deepEqual(capturedReportBody.reportSpec.dimensions, ["APP"]);
        assert.deepEqual(capturedReportBody.reportSpec.dimensionFilters, [
          {
            dimension: "APP",
            matchesAny: { values: [validFaceTubeAppId] },
          },
        ]);

        const storeAfter = readStoreJson();
        assert.equal((storeAfter.admobReportSnapshots || []).length, 0);
      } finally {
        globalThis.fetch = originalFetch;
        fs.writeFileSync(storePath, initialStoreSnapshot);
      }
    });
  });

  // --------------------------------------------------------------------------
  // 3. Live INR Currency Verification & Safe Failure Behavior
  // --------------------------------------------------------------------------
  describe("3. Strict Live INR Currency Verification (No Silent Assumptions, No FX)", () => {
    it("aborts with HTTP 422 when Google PublisherAccount omits currencyCode (even if local cache says INR)", async () => {
      seedLocalConnectedOauth("INR");
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "https://oauth2.googleapis.com/token") {
          return new Response(JSON.stringify({ access_token: "ya29.mock", expires_in: 3600 }), {
            status: 200,
          });
        }
        if (url === `https://admob.googleapis.com/v1/accounts/${validPublisherId}`) {
          return new Response(
            JSON.stringify({
              name: `accounts/${validPublisherId}`,
              publisherId: validPublisherId,
              reportingTimeZone: "Asia/Kolkata",
            }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      }) as typeof fetch;

      try {
        const res = await callApi(
          new Request("http://localhost:3000/api/admin/admob/sync-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ reportMonth: "2026-10" }),
          }),
        );
        assert.equal(res.status, 422);
        const data = (await res.json()) as any;
        assert.ok(data.error.includes("Refusing to assume INR"));
        assert.equal((readStoreJson().admobReportSnapshots || []).length, 0);
      } finally {
        globalThis.fetch = originalFetch;
        fs.writeFileSync(storePath, initialStoreSnapshot);
      }
    });

    it("aborts with HTTP 422 when Google PublisherAccount currencyCode is USD (no unauthorized FX conversion)", async () => {
      seedLocalConnectedOauth("INR");
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "https://oauth2.googleapis.com/token") {
          return new Response(JSON.stringify({ access_token: "ya29.mock", expires_in: 3600 }), {
            status: 200,
          });
        }
        if (url === `https://admob.googleapis.com/v1/accounts/${validPublisherId}`) {
          return new Response(
            JSON.stringify({
              name: `accounts/${validPublisherId}`,
              publisherId: validPublisherId,
              reportingTimeZone: "America/Los_Angeles",
              currencyCode: "USD",
            }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      }) as typeof fetch;

      try {
        const res = await callApi(
          new Request("http://localhost:3000/api/admin/admob/sync-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ reportMonth: "2026-10" }),
          }),
        );
        assert.equal(res.status, 422);
        const data = (await res.json()) as any;
        assert.ok(data.error.includes("USD"));
        assert.ok(data.error.includes("FX conversion is not authorized"));
        assert.equal((readStoreJson().admobReportSnapshots || []).length, 0);
      } finally {
        globalThis.fetch = originalFetch;
        fs.writeFileSync(storePath, initialStoreSnapshot);
      }
    });

    it("aborts with HTTP 422 when networkReport header omits or mismatches INR currencyCode", async () => {
      seedLocalConnectedOauth("INR");
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "https://oauth2.googleapis.com/token") {
          return new Response(JSON.stringify({ access_token: "ya29.mock", expires_in: 3600 }), {
            status: 200,
          });
        }
        if (url === `https://admob.googleapis.com/v1/accounts/${validPublisherId}`) {
          return new Response(
            JSON.stringify({
              publisherId: validPublisherId,
              reportingTimeZone: "Asia/Kolkata",
              currencyCode: "INR",
            }),
            { status: 200 },
          );
        }
        if (
          url ===
          `https://admob.googleapis.com/v1/accounts/${validPublisherId}/networkReport:generate`
        ) {
          return new Response(
            JSON.stringify([{ header: { localizationSettings: { languageCode: "en-US" } } }]),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      }) as typeof fetch;

      try {
        const res = await callApi(
          new Request("http://localhost:3000/api/admin/admob/sync-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ reportMonth: "2026-10" }),
          }),
        );
        assert.equal(res.status, 422);
        const data = (await res.json()) as any;
        assert.ok(data.error.includes("Refusing to assume INR"));
        assert.equal((readStoreJson().admobReportSnapshots || []).length, 0);
      } finally {
        globalThis.fetch = originalFetch;
        fs.writeFileSync(storePath, initialStoreSnapshot);
      }
    });
  });

  // --------------------------------------------------------------------------
  // 4. Token Refresh & invalid_grant Revocation Handling
  // --------------------------------------------------------------------------
  describe("4. OAuth Token Refresh & invalid_grant Handling", () => {
    it("deactivates stored OAuth credential and returns HTTP 401 when Google returns invalid_grant", async () => {
      seedLocalConnectedOauth();
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "https://oauth2.googleapis.com/token") {
          return new Response(
            JSON.stringify({
              error: "invalid_grant",
              error_description: "Token has been expired or revoked.",
            }),
            { status: 400 },
          );
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      }) as typeof fetch;

      try {
        const res = await callApi(
          new Request("http://localhost:3000/api/admin/admob/sync-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ reportMonth: "2026-10" }),
          }),
        );
        assert.equal(res.status, 401);
        const data = (await res.json()) as any;
        assert.ok(data.error.includes("invalid_grant"));
        assert.equal(data.access_token, undefined);
        assert.equal(data.refresh_token, undefined);

        const storeAfter = readStoreJson();
        assert.equal(storeAfter.admobOauth.is_active, 0);
      } finally {
        globalThis.fetch = originalFetch;
        fs.writeFileSync(storePath, initialStoreSnapshot);
      }
    });
  });

  // --------------------------------------------------------------------------
  // 5. Idempotent Staging Sync, Micros Precision, Closed-Month Verification & Wallet Isolation
  // --------------------------------------------------------------------------
  describe("5. Idempotent Staging Sync, Micros Conversion, Closed-Month Verification & Zero Wallet Impact", () => {
    it("syncs idempotently into staging, converts micros accurately, enforces closed-month verification, and never credits wallets/ledger", async () => {
      seedLocalConnectedOauth();
      const beforeStore = readStoreJson();
      const initialWalletsJson = JSON.stringify(beforeStore.wallets);
      const initialWalletTxJson = JSON.stringify(beforeStore.walletTransactions);
      const initialStatementsJson = JSON.stringify(beforeStore.admobStatements);

      let apiEarningsMicros = "1234567890"; // 1234.567890 INR
      let apiImpressions = "42500";
      let tokenCallBody = "";

      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "https://oauth2.googleapis.com/token") {
          tokenCallBody = String(init?.body || "");
          return new Response(
            JSON.stringify({ access_token: "ya29.fresh-access", expires_in: 3600 }),
            {
              status: 200,
            },
          );
        }
        if (url === `https://admob.googleapis.com/v1/accounts/${validPublisherId}`) {
          return new Response(
            JSON.stringify({
              name: `accounts/${validPublisherId}`,
              publisherId: validPublisherId,
              reportingTimeZone: "Asia/Kolkata",
              currencyCode: "INR",
            }),
            { status: 200 },
          );
        }
        if (
          url ===
          `https://admob.googleapis.com/v1/accounts/${validPublisherId}/networkReport:generate`
        ) {
          return new Response(
            JSON.stringify([
              {
                header: {
                  dateRange: {
                    startDate: { year: 2026, month: 10, day: 1 },
                    endDate: { year: 2026, month: 10, day: 31 },
                  },
                  localizationSettings: { currencyCode: "INR", languageCode: "en-US" },
                },
              },
              {
                row: {
                  dimensionValues: {
                    APP: { value: validFaceTubeAppId, displayLabel: "FaceTube Android" },
                  },
                  metricValues: {
                    ESTIMATED_EARNINGS: { microsValue: apiEarningsMicros },
                    IMPRESSIONS: { integerValue: apiImpressions },
                    CLICKS: { integerValue: "850" },
                    AD_REQUESTS: { integerValue: "50000" },
                    MATCHED_REQUESTS: { integerValue: "45000" },
                  },
                },
              },
              {
                footer: { matchingRowCount: "1" },
              },
            ]),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      }) as typeof fetch;

      try {
        const istParts = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Kolkata",
          year: "numeric",
          month: "2-digit",
        }).formatToParts(new Date());
        const istYear = Number(istParts.find((p) => p.type === "year")?.value || "2026");
        const istMonth = Number(istParts.find((p) => p.type === "month")?.value || "11");
        const openMonth = `${istYear}-${String(istMonth).padStart(2, "0")}`;
        const prevDate = new Date(Date.UTC(istYear, istMonth - 2, 1));
        const closedMonth = `${prevDate.getUTCFullYear()}-${String(prevDate.getUTCMonth() + 1).padStart(2, "0")}`;

        // Sync #1 for closed month
        const sync1 = await callApi(
          new Request("http://localhost:3000/api/admin/admob/sync-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ reportMonth: closedMonth }),
          }),
        );
        assert.equal(sync1.status, 200);
        const s1Data = (await sync1.json()) as any;
        assert.equal(s1Data.success, true);
        assert.equal(s1Data.walletCredited, false);
        assert.equal(s1Data.ledgerPosted, false);
        assert.equal(s1Data.companyOwnership, "100% FaceTube");
        assert.equal(s1Data.snapshot.estimated_earnings, "1234.567890");
        assert.equal(s1Data.snapshot.currency_code, "INR");
        assert.equal(s1Data.snapshot.app_id, validFaceTubeAppId);
        assert.equal(s1Data.snapshot.ownership_scope, "COMPANY_100_PERCENT");
        assert.equal(s1Data.snapshot.status, "staged_estimated");
        assert.equal(s1Data.snapshot.sync_count, 1);

        // Verify decrypted refresh token was sent to Google OAuth endpoint
        assert.ok(tokenCallBody.includes("grant_type=refresh_token"));
        assert.ok(tokenCallBody.includes("refresh_token=1%2F%2Fmock-valid-refresh-token-xyz"));

        // Sync #2 for same month updates existing snapshot cleanly without duplicating rows
        apiEarningsMicros = "2500000000"; // 2500.000000 INR
        apiImpressions = "61000";
        const sync2 = await callApi(
          new Request("http://localhost:3000/api/admin/admob/sync-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ reportMonth: closedMonth }),
          }),
        );
        assert.equal(sync2.status, 200);
        const s2Data = (await sync2.json()) as any;
        assert.equal(s2Data.snapshot.estimated_earnings, "2500.000000");
        assert.equal(s2Data.snapshot.impressions, 61000);
        assert.equal(s2Data.snapshot.sync_count, 2);

        // List snapshots -> strictly 1 idempotent row
        const listRes = await callApi(
          new Request(`http://localhost:3000/api/admin/admob/reports?reportMonth=${closedMonth}`, {
            headers: { Authorization: `Bearer ${adminSessionToken}` },
          }),
        );
        assert.equal(listRes.status, 200);
        const listData = (await listRes.json()) as any;
        assert.equal(listData.count, 1);
        assert.equal(listData.snapshots[0].estimated_earnings, "2500.000000");

        // Sync current open month and confirm verify-report rejects unclosed month
        const syncOpen = await callApi(
          new Request("http://localhost:3000/api/admin/admob/sync-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ reportMonth: openMonth }),
          }),
        );
        assert.equal(syncOpen.status, 200);

        const verifyOpen = await callApi(
          new Request("http://localhost:3000/api/admin/admob/verify-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ reportMonth: openMonth, verificationNotes: "Should fail" }),
          }),
        );
        assert.equal(verifyOpen.status, 400);
        const verifyOpenData = (await verifyOpen.json()) as any;
        assert.ok(verifyOpenData.error.includes("has not closed yet"));

        // Verify closed month -> transitions to verified_finalized
        const verifyClosed = await callApi(
          new Request("http://localhost:3000/api/admin/admob/verify-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({
              reportMonth: closedMonth,
              verificationNotes: "Matched October Google payment statement",
            }),
          }),
        );
        assert.equal(verifyClosed.status, 200);
        const verifiedData = (await verifyClosed.json()) as any;
        assert.equal(verifiedData.success, true);
        assert.equal(verifiedData.walletCredited, false);
        assert.equal(verifiedData.ledgerPosted, false);
        assert.equal(verifiedData.snapshot.status, "verified_finalized");
        assert.equal(verifiedData.snapshot.verified_by, adminUserId);
        assert.equal(
          verifiedData.snapshot.verification_notes,
          "Matched October Google payment statement",
        );

        // Subsequent sync on verified_finalized month -> HTTP 409 blocked
        const resyncAfterVerify = await callApi(
          new Request("http://localhost:3000/api/admin/admob/sync-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ reportMonth: closedMonth }),
          }),
        );
        assert.equal(resyncAfterVerify.status, 409);

        // Duplicate verification on verified_finalized month -> HTTP 409 blocked
        const duplicateVerify = await callApi(
          new Request("http://localhost:3000/api/admin/admob/verify-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ reportMonth: closedMonth }),
          }),
        );
        assert.equal(duplicateVerify.status, 409);

        // CRITICAL ACCOUNTING CHECK: zero changes to wallets, walletTransactions, or admobStatements
        const afterStore = readStoreJson();
        assert.equal(JSON.stringify(afterStore.wallets), initialWalletsJson);
        assert.equal(JSON.stringify(afterStore.walletTransactions), initialWalletTxJson);
        assert.equal(JSON.stringify(afterStore.admobStatements), initialStatementsJson);
      } finally {
        globalThis.fetch = originalFetch;
        fs.writeFileSync(storePath, initialStoreSnapshot);
      }
    });
  });

  // --------------------------------------------------------------------------
  // 6. MySQL Production Transaction & Isolation Verification
  // --------------------------------------------------------------------------
  describe("6. MySQL Staging Path & Zero Wallet/Ledger Query Isolation", () => {
    it("uses FOR UPDATE transactional upsert on admob_report_snapshots and issues ZERO queries to wallet_balances or income_ledger", async () => {
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_production";
      process.env["DB_USER"] = "admin_user";
      process.env["NODE_ENV"] = "production";

      const enc = encryptForTest("1//mysql-refresh-token", testEncryptionKey);
      const executedSql: string[] = [];
      let snapshotRow: any = null;

      const mockConn = {
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        release: () => {},
        query: async (sql: string, params?: any[]) => {
          executedSql.push(sql);
          if (sql.includes("FROM admob_report_snapshots") && sql.includes("FOR UPDATE")) {
            return [snapshotRow ? [snapshotRow] : []];
          }
          if (sql.includes("INSERT INTO admob_report_snapshots")) {
            snapshotRow = {
              id: 101,
              publisher_id: params?.[0],
              app_id: params?.[1],
              report_month: params?.[2],
              period_start: params?.[3],
              period_end: params?.[4],
              reporting_time_zone: params?.[5],
              currency_code: "INR",
              estimated_earnings_micros: params?.[6],
              estimated_earnings: params?.[7],
              impressions: params?.[8],
              clicks: params?.[9],
              ad_requests: params?.[10],
              matched_requests: params?.[11],
              ownership_scope: "COMPANY_100_PERCENT",
              status: "staged_estimated",
              sync_count: 1,
              synced_by: params?.[12],
              synced_at: "2026-11-22 10:00:00",
              verified_by: null,
              verified_at: null,
              verification_notes: null,
            };
            return [{ affectedRows: 1, insertId: 101 }];
          }
          if (sql.includes("UPDATE admob_report_snapshots SET status = 'verified_finalized'")) {
            snapshotRow = {
              ...snapshotRow,
              status: "verified_finalized",
              verified_by: params?.[0],
              verified_at: "2026-11-22 10:05:00",
              verification_notes: params?.[1],
            };
            return [{ affectedRows: 1 }];
          }
          if (sql.includes("FROM admob_report_snapshots WHERE")) {
            return [snapshotRow ? [snapshotRow] : []];
          }
          return [[]];
        },
      };

      const adminHash = crypto.createHash("sha256").update(adminSessionToken).digest("hex");
      const mockPool = {
        getConnection: async () => mockConn,
        query: async (sql: string, _params?: any[]) => {
          executedSql.push(sql);
          // Auth check query
          if (sql.includes("FROM sessions") && sql.includes("JOIN users")) {
            return [
              [
                {
                  id: adminUserId,
                  user_id: adminUserId,
                  name: "FaceTube Admin",
                  email: "admin@facetube.com",
                  role: "admin",
                  status: "active",
                  session_hash: adminHash,
                },
              ],
            ];
          }
          if (sql.includes("FROM admob_oauth_credentials")) {
            return [
              [
                {
                  id: 7,
                  publisher_id: validPublisherId,
                  account_name: "FaceTube Production AdMob",
                  currency_code: "INR",
                  ...enc,
                  is_active: 1,
                },
              ],
            ];
          }
          if (sql.includes("FROM admob_report_snapshots")) {
            return [snapshotRow ? [snapshotRow] : []];
          }
          return [[]];
        },
      };

      setMysqlPoolForTesting(mockPool);

      globalThis.fetch = (async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "https://oauth2.googleapis.com/token") {
          return new Response(
            JSON.stringify({ access_token: "ya29.mysql-access", expires_in: 3600 }),
            {
              status: 200,
            },
          );
        }
        if (url === `https://admob.googleapis.com/v1/accounts/${validPublisherId}`) {
          return new Response(
            JSON.stringify({
              publisherId: validPublisherId,
              reportingTimeZone: "Asia/Kolkata",
              currencyCode: "INR",
            }),
            { status: 200 },
          );
        }
        if (
          url ===
          `https://admob.googleapis.com/v1/accounts/${validPublisherId}/networkReport:generate`
        ) {
          return new Response(
            JSON.stringify([
              { header: { localizationSettings: { currencyCode: "INR", languageCode: "en-US" } } },
              {
                row: {
                  dimensionValues: { APP: { value: validFaceTubeAppId } },
                  metricValues: {
                    ESTIMATED_EARNINGS: { microsValue: "987654321" },
                    IMPRESSIONS: { integerValue: "10000" },
                    CLICKS: { integerValue: "200" },
                    AD_REQUESTS: { integerValue: "12000" },
                    MATCHED_REQUESTS: { integerValue: "11000" },
                  },
                },
              },
            ]),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      }) as typeof fetch;

      try {
        const syncRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/sync-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ reportMonth: "2026-10" }),
          }),
        );
        assert.equal(syncRes.status, 200);
        const syncData = (await syncRes.json()) as any;
        assert.equal(syncData.snapshot.estimated_earnings, "987.654321");
        assert.equal(syncData.walletCredited, false);
        assert.equal(syncData.ledgerPosted, false);

        const listRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/reports", {
            headers: { Authorization: `Bearer ${adminSessionToken}` },
          }),
        );
        assert.equal(listRes.status, 200);
        const listData = (await listRes.json()) as any;
        assert.equal(listData.count, 1);

        const verifyRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/verify-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ reportMonth: "2026-10", verificationNotes: "Verified INR" }),
          }),
        );
        assert.equal(verifyRes.status, 200);
        const verifyData = (await verifyRes.json()) as any;
        assert.equal(verifyData.snapshot.status, "verified_finalized");

        // Ensure NO query ever touched wallet_balances, income_ledger, or admob_monthly_statements
        const joinedSql = executedSql.join("\n").toLowerCase();
        assert.ok(
          !joinedSql.includes("wallet_balances"),
          "Must never query or mutate wallet_balances",
        );
        assert.ok(!joinedSql.includes("income_ledger"), "Must never query or mutate income_ledger");
        assert.ok(
          !joinedSql.includes("admob_monthly_statements"),
          "Must never query or mutate manual admob_monthly_statements",
        );
        assert.ok(
          executedSql.some((q) => q.includes("FOR UPDATE")),
          "Must use row-level FOR UPDATE lock during staging upsert/verify",
        );
      } finally {
        globalThis.fetch = originalFetch;
        setMysqlPoolForTesting(null);
        resetToBaseTestEnv();
      }
    });
  });

  // --------------------------------------------------------------------------
  // 7. Static PHP Parity & OAuth Redirect URI Non-Modification Verification
  // --------------------------------------------------------------------------
  describe("7. PHP Parity & OAuth Redirect URI Non-Modification Checks", () => {
    it("confirms PHP reporting endpoints and SQL migration enforce company-only staging and zero wallet/ledger mutations", () => {
      const files = [
        "database/migrations/20261123_admob_report_staging.sql",
        "api/admin/admob/admob-reporting.php",
        "api/admin/admob/sync-report.php",
        "api/admin/admob/reports.php",
        "api/admin/admob/verify-report.php",
      ];

      for (const rel of files) {
        const abs = path.resolve(process.cwd(), rel);
        assert.ok(fs.existsSync(abs), `Missing required file: ${rel}`);
      }

      const phpSync = fs.readFileSync(
        path.resolve(process.cwd(), "api/admin/admob/sync-report.php"),
        "utf-8",
      );
      const phpVerify = fs.readFileSync(
        path.resolve(process.cwd(), "api/admin/admob/verify-report.php"),
        "utf-8",
      );
      const phpHelper = fs.readFileSync(
        path.resolve(process.cwd(), "api/admin/admob/admob-reporting.php"),
        "utf-8",
      );

      for (const content of [phpSync, phpVerify, phpHelper]) {
        assert.ok(!content.includes("UPDATE wallet_balances"), "Must never update wallet_balances");
        assert.ok(
          !content.includes("INSERT INTO income_ledger"),
          "Must never insert into income_ledger",
        );
        assert.ok(
          !content.includes("require_once __DIR__ . '/../record-admob-earning"),
          "Must never invoke record-admob-earning.php",
        );
      }

      // Confirm OAuth redirect URI defaults were NOT altered
      const admobCryptoPhp = fs.readFileSync(
        path.resolve(process.cwd(), "api/admin/admob/admob-crypto.php"),
        "utf-8",
      );
      assert.ok(
        admobCryptoPhp.includes("'/api/admin/admob/oauth-callback'"),
        "PHP OAuth default redirect URI must remain untouched",
      );

      const apiHandlerTs = fs.readFileSync(
        path.resolve(process.cwd(), "src/server/api-handler.ts"),
        "utf-8",
      );
      assert.ok(
        apiHandlerTs.includes('"https://facetube.online/api/admin/admob/oauth-callback"'),
        "Node.js OAuth default redirect URI must remain untouched",
      );
    });
  });

  // --------------------------------------------------------------------------
  // 8. Phase 2.1 Medium A: Publisher ID & App ID Scoping in verify-report
  // --------------------------------------------------------------------------
  describe("8. Publisher ID & App ID Scoping in verify-report (Phase 2.1 Medium A)", () => {
    it("rejects verification (HTTP 403) when snapshot belongs to another publisher and requires active OAuth + configured App ID", async () => {
      const otherPublisherId = "pub-9999888877776666";
      seedLocalConnectedOauth("INR");
      try {
        // Seed snapshot belonging to a DIFFERENT publisher for closed month 2026-10
        const store = readStoreJson();
        store.admobReportSnapshots = [
          {
            id: 1,
            publisher_id: otherPublisherId,
            app_id: validFaceTubeAppId,
            report_month: "2026-10",
            period_start: "2026-10-01",
            period_end: "2026-10-31",
            reporting_time_zone: "Asia/Kolkata",
            currency_code: "INR",
            estimated_earnings_micros: "5000000",
            estimated_earnings: "5.000000",
            impressions: 100,
            clicks: 2,
            ad_requests: 120,
            matched_requests: 110,
            ownership_scope: "COMPANY_100_PERCENT",
            status: "staged_estimated",
            sync_count: 1,
            synced_by: adminUserId,
            synced_at: "2026-11-01T00:00:00.000Z",
            verified_by: null,
            verified_at: null,
            verification_notes: null,
          },
        ];
        fs.writeFileSync(storePath, JSON.stringify(store, null, 2));

        // 1. Cross-publisher snapshot cannot be verified by active validPublisherId -> 403
        const crossPubRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/verify-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ reportMonth: "2026-10" }),
          }),
        );
        assert.equal(crossPubRes.status, 403);
        const crossPubData = (await crossPubRes.json()) as any;
        assert.ok(crossPubData.error.includes("different publisher account"));
        assert.equal(readStoreJson().admobReportSnapshots[0].status, "staged_estimated");

        // 2. Caller passing another publisherId explicitly -> 403
        const bodyMismatchRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/verify-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ reportMonth: "2026-10", publisherId: otherPublisherId }),
          }),
        );
        assert.equal(bodyMismatchRes.status, 403);

        // 3. No snapshot for month at all -> 404
        const missingMonthRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/verify-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ reportMonth: "2026-09" }),
          }),
        );
        assert.equal(missingMonthRes.status, 404);

        // 4. Caller passing mismatched appId -> 400
        const appMismatchRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/verify-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ reportMonth: "2026-10", appId: otherAppId }),
          }),
        );
        assert.equal(appMismatchRes.status, 400);

        // 5. Missing ADMOB_APP_ID on verify-report -> 500
        delete process.env["ADMOB_APP_ID"];
        const missingAppEnvRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/verify-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ reportMonth: "2026-10" }),
          }),
        );
        assert.equal(missingAppEnvRes.status, 500);
        process.env["ADMOB_APP_ID"] = validFaceTubeAppId;

        // 6. Disconnected AdMob OAuth -> 409 on verify-report
        const disconnStore = readStoreJson();
        disconnStore.admobOauth.is_active = 0;
        fs.writeFileSync(storePath, JSON.stringify(disconnStore, null, 2));
        const disconnRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/verify-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ reportMonth: "2026-10" }),
          }),
        );
        assert.equal(disconnRes.status, 409);
      } finally {
        resetToBaseTestEnv();
        fs.writeFileSync(storePath, initialStoreSnapshot);
      }
    });

    it("enforces publisher/app/month scoping in MySQL verify-report and PHP verify-report.php parity", async () => {
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_production";
      process.env["DB_USER"] = "admin_user";
      process.env["NODE_ENV"] = "production";

      const enc = encryptForTest("1//mysql-refresh-token", testEncryptionKey);
      const adminHash = crypto.createHash("sha256").update(adminSessionToken).digest("hex");
      const otherPublisherId = "pub-8888777766665555";
      const capturedQueries: Array<{ sql: string; params?: any[] | undefined }> = [];

      const mockConn = {
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        release: () => {},
        query: async (sql: string, params?: any[]) => {
          capturedQueries.push({ sql, params });
          if (
            sql.includes("FROM admob_report_snapshots") &&
            sql.includes("publisher_id = ?") &&
            sql.includes("FOR UPDATE")
          ) {
            return [[]];
          }
          if (sql.includes("FROM admob_report_snapshots WHERE app_id = ? AND report_month = ?")) {
            return [[{ id: 10, publisher_id: otherPublisherId }]];
          }
          return [[]];
        },
      };

      const mockPool = {
        getConnection: async () => mockConn,
        query: async (sql: string, params?: any[]) => {
          capturedQueries.push({ sql, params });
          if (sql.includes("FROM sessions") && sql.includes("JOIN users")) {
            return [
              [
                {
                  id: adminUserId,
                  user_id: adminUserId,
                  name: "FaceTube Admin",
                  email: "admin@facetube.com",
                  role: "admin",
                  status: "active",
                  session_hash: adminHash,
                },
              ],
            ];
          }
          if (sql.includes("FROM admob_oauth_credentials")) {
            return [
              [
                {
                  id: 1,
                  publisher_id: validPublisherId,
                  currency_code: "INR",
                  ...enc,
                  is_active: 1,
                },
              ],
            ];
          }
          return [[]];
        },
      };

      setMysqlPoolForTesting(mockPool);
      try {
        const res = await callApi(
          new Request("http://localhost:3000/api/admin/admob/verify-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ reportMonth: "2026-10" }),
          }),
        );
        assert.equal(res.status, 403);
        const scopedLockQuery = capturedQueries.find(
          (q) =>
            q.sql.includes("FROM admob_report_snapshots") &&
            q.sql.includes("publisher_id = ?") &&
            q.sql.includes("app_id = ?") &&
            q.sql.includes("report_month = ?") &&
            q.sql.includes("FOR UPDATE"),
        );
        assert.ok(
          scopedLockQuery,
          "MySQL verify-report must lock by (publisher_id, app_id, report_month)",
        );
        assert.deepEqual(scopedLockQuery.params, [validPublisherId, validFaceTubeAppId, "2026-10"]);

        // Static PHP parity checks for verify-report.php & sync-report.php
        const phpVerify = fs.readFileSync(
          path.resolve(process.cwd(), "api/admin/admob/verify-report.php"),
          "utf-8",
        );
        assert.ok(
          phpVerify.includes("FROM admob_oauth_credentials") &&
            phpVerify.includes("WHERE is_active = 1"),
          "PHP verify-report must resolve active publisher_id from admob_oauth_credentials",
        );
        assert.ok(
          phpVerify.includes("WHERE publisher_id = ? AND app_id = ? AND report_month = ?") &&
            phpVerify.includes("FOR UPDATE"),
          "PHP verify-report must scope snapshot lookup by (publisher_id, app_id, report_month) FOR UPDATE",
        );
        const phpSync = fs.readFileSync(
          path.resolve(process.cwd(), "api/admin/admob/sync-report.php"),
          "utf-8",
        );
        assert.ok(
          phpSync.includes("getAdmobOAuthConfig()") && phpSync.includes("isConfigured"),
          "PHP sync-report must pre-validate OAuth client configuration before running",
        );
      } finally {
        setMysqlPoolForTesting(null);
        resetToBaseTestEnv();
      }
    });
  });

  // --------------------------------------------------------------------------
  // 9. Phase 2.1 Medium B: Concurrent Sync & Retryable DB Error Handling
  // --------------------------------------------------------------------------
  describe("9. Concurrent First-Time Sync & MySQL Duplicate/Deadlock Retry Handling", () => {
    it("converges simultaneous local first-time sync requests onto a single snapshot without 500 or duplicates", async () => {
      seedLocalConnectedOauth("INR");
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "https://oauth2.googleapis.com/token") {
          return new Response(
            JSON.stringify({ access_token: "ya29.concurrent", expires_in: 3600 }),
            {
              status: 200,
            },
          );
        }
        if (url === `https://admob.googleapis.com/v1/accounts/${validPublisherId}`) {
          return new Response(
            JSON.stringify({
              publisherId: validPublisherId,
              reportingTimeZone: "Asia/Kolkata",
              currencyCode: "INR",
            }),
            { status: 200 },
          );
        }
        if (
          url ===
          `https://admob.googleapis.com/v1/accounts/${validPublisherId}/networkReport:generate`
        ) {
          return new Response(
            JSON.stringify([
              { header: { localizationSettings: { currencyCode: "INR" } } },
              {
                row: {
                  dimensionValues: { APP: { value: validFaceTubeAppId } },
                  metricValues: {
                    ESTIMATED_EARNINGS: { microsValue: "150000000" },
                    IMPRESSIONS: { integerValue: "5000" },
                  },
                },
              },
            ]),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as typeof fetch;

      try {
        const responses = await Promise.all([
          callApi(
            new Request("http://localhost:3000/api/admin/admob/sync-report", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${adminSessionToken}`,
              },
              body: JSON.stringify({ reportMonth: "2026-10" }),
            }),
          ),
          callApi(
            new Request("http://localhost:3000/api/admin/admob/sync-report", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${adminSessionToken}`,
              },
              body: JSON.stringify({ reportMonth: "2026-10" }),
            }),
          ),
        ]);

        assert.equal(responses[0].status, 200);
        assert.equal(responses[1].status, 200);
        const storeAfter = readStoreJson();
        assert.equal((storeAfter.admobReportSnapshots || []).length, 1);
        assert.equal(storeAfter.admobReportSnapshots[0].estimated_earnings, "150.000000");
      } finally {
        globalThis.fetch = originalFetch;
        fs.writeFileSync(storePath, initialStoreSnapshot);
      }
    });

    it("retries MySQL 1062 (ER_DUP_ENTRY) / 1213 (ER_LOCK_DEADLOCK) cleanly and returns 409 (never 500) if retries exhaust", async () => {
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_production";
      process.env["DB_USER"] = "admin_user";
      process.env["NODE_ENV"] = "production";

      const enc = encryptForTest("1//mysql-refresh-token", testEncryptionKey);
      const adminHash = crypto.createHash("sha256").update(adminSessionToken).digest("hex");

      globalThis.fetch = (async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "https://oauth2.googleapis.com/token") {
          return new Response(JSON.stringify({ access_token: "ya29.retry", expires_in: 3600 }), {
            status: 200,
          });
        }
        if (url === `https://admob.googleapis.com/v1/accounts/${validPublisherId}`) {
          return new Response(
            JSON.stringify({
              publisherId: validPublisherId,
              reportingTimeZone: "Asia/Kolkata",
              currencyCode: "INR",
            }),
            { status: 200 },
          );
        }
        if (
          url ===
          `https://admob.googleapis.com/v1/accounts/${validPublisherId}/networkReport:generate`
        ) {
          return new Response(
            JSON.stringify([
              { header: { localizationSettings: { currencyCode: "INR" } } },
              {
                row: {
                  dimensionValues: { APP: { value: validFaceTubeAppId } },
                  metricValues: {
                    ESTIMATED_EARNINGS: { microsValue: "333000000" },
                    IMPRESSIONS: { integerValue: "900" },
                  },
                },
              },
            ]),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as typeof fetch;

      try {
        // Case A: Attempt 1 INSERT hits ER_DUP_ENTRY (1062) because peer inserted first; Attempt 2 retries & updates cleanly
        let snapshotRow: any = null;
        let dupAttempt = 0;
        let rollbackCount = 0;

        const dupConn = {
          beginTransaction: async () => {},
          commit: async () => {},
          rollback: async () => {
            rollbackCount++;
          },
          release: () => {},
          query: async (sql: string, params?: any[]) => {
            if (sql.includes("FROM admob_report_snapshots") && sql.includes("FOR UPDATE")) {
              return [snapshotRow ? [snapshotRow] : []];
            }
            if (sql.includes("INSERT INTO admob_report_snapshots")) {
              dupAttempt++;
              if (dupAttempt === 1) {
                // Simulate concurrent peer committing just before our INSERT
                snapshotRow = {
                  id: 55,
                  publisher_id: validPublisherId,
                  app_id: validFaceTubeAppId,
                  report_month: "2026-10",
                  period_start: "2026-10-01",
                  period_end: "2026-10-31",
                  reporting_time_zone: "Asia/Kolkata",
                  currency_code: "INR",
                  estimated_earnings_micros: "333000000",
                  estimated_earnings: "333.000000",
                  impressions: 900,
                  clicks: 0,
                  ad_requests: 0,
                  matched_requests: 0,
                  ownership_scope: "COMPANY_100_PERCENT",
                  status: "staged_estimated",
                  sync_count: 1,
                };
                const err: any = new Error(
                  "Duplicate entry for key uniq_admob_snapshot_pub_app_month",
                );
                err.code = "ER_DUP_ENTRY";
                err.errno = 1062;
                throw err;
              }
            }
            if (sql.includes("UPDATE admob_report_snapshots SET period_start = ?")) {
              snapshotRow = {
                ...snapshotRow,
                estimated_earnings_micros: params?.[3],
                estimated_earnings: params?.[4],
                sync_count: Number(snapshotRow.sync_count || 1) + 1,
              };
              return [{ affectedRows: 1 }];
            }
            if (sql.includes("FROM admob_report_snapshots WHERE")) {
              return [snapshotRow ? [snapshotRow] : []];
            }
            return [[]];
          },
        };

        setMysqlPoolForTesting({
          getConnection: async () => dupConn,
          query: async (sql: string) => {
            if (sql.includes("FROM sessions") && sql.includes("JOIN users")) {
              return [
                [
                  {
                    id: adminUserId,
                    user_id: adminUserId,
                    name: "FaceTube Admin",
                    email: "admin@facetube.com",
                    role: "admin",
                    status: "active",
                    session_hash: adminHash,
                  },
                ],
              ];
            }
            if (sql.includes("FROM admob_oauth_credentials")) {
              return [
                [
                  {
                    id: 1,
                    publisher_id: validPublisherId,
                    currency_code: "INR",
                    ...enc,
                    is_active: 1,
                  },
                ],
              ];
            }
            return [[]];
          },
        });

        const retrySuccessRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/sync-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ reportMonth: "2026-10" }),
          }),
        );
        assert.equal(retrySuccessRes.status, 200);
        const retrySuccessData = (await retrySuccessRes.json()) as any;
        assert.equal(retrySuccessData.snapshot.sync_count, 2);
        assert.equal(rollbackCount, 1);

        // Case B: All 3 attempts hit ER_LOCK_DEADLOCK (1213) -> controlled HTTP 409 (never 500)
        let deadlockAttempts = 0;
        const deadlockConn = {
          beginTransaction: async () => {},
          commit: async () => {},
          rollback: async () => {},
          release: () => {},
          query: async (sql: string) => {
            if (sql.includes("FROM admob_report_snapshots") && sql.includes("FOR UPDATE")) {
              deadlockAttempts++;
              const err: any = new Error("Deadlock found when trying to get lock");
              err.code = "ER_LOCK_DEADLOCK";
              err.errno = 1213;
              throw err;
            }
            return [[]];
          },
        };

        setMysqlPoolForTesting({
          getConnection: async () => deadlockConn,
          query: async (sql: string) => {
            if (sql.includes("FROM sessions") && sql.includes("JOIN users")) {
              return [
                [
                  {
                    id: adminUserId,
                    user_id: adminUserId,
                    name: "FaceTube Admin",
                    email: "admin@facetube.com",
                    role: "admin",
                    status: "active",
                    session_hash: adminHash,
                  },
                ],
              ];
            }
            if (sql.includes("FROM admob_oauth_credentials")) {
              return [
                [
                  {
                    id: 1,
                    publisher_id: validPublisherId,
                    currency_code: "INR",
                    ...enc,
                    is_active: 1,
                  },
                ],
              ];
            }
            return [[]];
          },
        });

        const exhaustedRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/sync-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ reportMonth: "2026-10" }),
          }),
        );
        assert.equal(exhaustedRes.status, 409);
        assert.equal(deadlockAttempts, 3);
      } finally {
        globalThis.fetch = originalFetch;
        setMysqlPoolForTesting(null);
        resetToBaseTestEnv();
      }
    });
  });

  // --------------------------------------------------------------------------
  // 10. Phase 2.1 Low A & B: Case-Insensitive Admin Role & Strict JSON Parity
  // --------------------------------------------------------------------------
  describe("10. Case-Insensitive Admin Roles & Strict JSON Validation", () => {
    it("allows Admin/ADMIN/trimmed-admin roles and rejects Moderator/creator roles across all 3 routes", async () => {
      seedLocalConnectedOauth("INR");
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "https://oauth2.googleapis.com/token") {
          return new Response(JSON.stringify({ access_token: "ya29.role", expires_in: 3600 }), {
            status: 200,
          });
        }
        if (url === `https://admob.googleapis.com/v1/accounts/${validPublisherId}`) {
          return new Response(
            JSON.stringify({
              publisherId: validPublisherId,
              reportingTimeZone: "Asia/Kolkata",
              currencyCode: "INR",
            }),
            { status: 200 },
          );
        }
        if (
          url ===
          `https://admob.googleapis.com/v1/accounts/${validPublisherId}/networkReport:generate`
        ) {
          return new Response(
            JSON.stringify([{ header: { localizationSettings: { currencyCode: "INR" } } }]),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as typeof fetch;

      try {
        for (const { role: allowedRole, month } of [
          { role: "Admin", month: "2026-08" },
          { role: "ADMIN", month: "2026-09" },
          { role: " admin ", month: "2026-10" },
        ]) {
          const store = readStoreJson();
          const tok = `tok-role-${allowedRole.trim()}`;
          const uid = `FT_ROLE_${allowedRole.trim().toUpperCase()}`;
          store.users.push({
            id: uid,
            user_id: uid,
            name: "Role Test Admin",
            email: `${uid.toLowerCase()}@facetube.com`,
            role: allowedRole,
            created_at: "2026-10-01T00:00:00.000Z",
          });
          store.sessions[tok] = uid;
          fs.writeFileSync(storePath, JSON.stringify(store, null, 2));

          const listRes = await callApi(
            new Request("http://localhost:3000/api/admin/admob/reports", {
              headers: { Authorization: `Bearer ${tok}` },
            }),
          );
          assert.equal(listRes.status, 200, `Role '${allowedRole}' should access /reports`);

          const syncRes = await callApi(
            new Request("http://localhost:3000/api/admin/admob/sync-report", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${tok}`,
              },
              body: JSON.stringify({ reportMonth: month }),
            }),
          );
          assert.equal(syncRes.status, 200, `Role '${allowedRole}' should access /sync-report`);

          const verifyRes = await callApi(
            new Request("http://localhost:3000/api/admin/admob/verify-report", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${tok}`,
              },
              body: JSON.stringify({ reportMonth: month }),
            }),
          );
          assert.equal(
            verifyRes.status,
            200,
            `Role '${allowedRole}' should pass Admin auth on /verify-report`,
          );
        }

        // Non-admin custom role must get 403
        const modStore = readStoreJson();
        modStore.users.push({
          id: "FT_MOD_1",
          user_id: "FT_MOD_1",
          name: "Moderator User",
          email: "mod@facetube.com",
          role: "Moderator",
          created_at: "2026-10-01T00:00:00.000Z",
        });
        modStore.sessions["tok-moderator"] = "FT_MOD_1";
        fs.writeFileSync(storePath, JSON.stringify(modStore, null, 2));

        const modReports = await callApi(
          new Request("http://localhost:3000/api/admin/admob/reports", {
            headers: { Authorization: `Bearer tok-moderator` },
          }),
        );
        assert.equal(modReports.status, 403);
      } finally {
        globalThis.fetch = originalFetch;
        fs.writeFileSync(storePath, initialStoreSnapshot);
      }
    });

    it("rejects malformed non-empty JSON bodies with HTTP 400 and supports empty body on sync-report", async () => {
      seedLocalConnectedOauth("INR");
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "https://oauth2.googleapis.com/token") {
          return new Response(JSON.stringify({ access_token: "ya29.json", expires_in: 3600 }), {
            status: 200,
          });
        }
        if (url === `https://admob.googleapis.com/v1/accounts/${validPublisherId}`) {
          return new Response(
            JSON.stringify({
              publisherId: validPublisherId,
              reportingTimeZone: "Asia/Kolkata",
              currencyCode: "INR",
            }),
            { status: 200 },
          );
        }
        if (
          url ===
          `https://admob.googleapis.com/v1/accounts/${validPublisherId}/networkReport:generate`
        ) {
          return new Response(
            JSON.stringify([{ header: { localizationSettings: { currencyCode: "INR" } } }]),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as typeof fetch;

      try {
        // Malformed JSON -> 400 on both sync-report and verify-report
        const badSync = await callApi(
          new Request("http://localhost:3000/api/admin/admob/sync-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: "{not-valid-json",
          }),
        );
        assert.equal(badSync.status, 400);

        const arrayVerify = await callApi(
          new Request("http://localhost:3000/api/admin/admob/verify-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: '["not-an-object"]',
          }),
        );
        assert.equal(arrayVerify.status, 400);

        // Empty body allowed on sync-report (omitted reportMonth resolves automatically)
        const emptySync = await callApi(
          new Request("http://localhost:3000/api/admin/admob/sync-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: "",
          }),
        );
        assert.equal(emptySync.status, 200);

        // Static PHP parity check for readStrictAdmobJsonPayload
        const phpHelper = fs.readFileSync(
          path.resolve(process.cwd(), "api/admin/admob/admob-reporting.php"),
          "utf-8",
        );
        const phpSync = fs.readFileSync(
          path.resolve(process.cwd(), "api/admin/admob/sync-report.php"),
          "utf-8",
        );
        const phpVerify = fs.readFileSync(
          path.resolve(process.cwd(), "api/admin/admob/verify-report.php"),
          "utf-8",
        );
        assert.ok(phpHelper.includes("function readStrictAdmobJsonPayload"));
        assert.ok(phpSync.includes("readStrictAdmobJsonPayload()"));
        assert.ok(phpVerify.includes("readStrictAdmobJsonPayload()"));
      } finally {
        globalThis.fetch = originalFetch;
        fs.writeFileSync(storePath, initialStoreSnapshot);
      }
    });
  });

  // --------------------------------------------------------------------------
  // 11. Phase 2.1 Low C: Reporting Timezone Validation & Month Boundaries
  // --------------------------------------------------------------------------
  describe("11. Fail-Closed Reporting Timezone Validation & Month-Boundary Resolution", () => {
    it("fails closed with HTTP 422 (no silent UTC fallback, zero staging writes) when Google returns an invalid reportingTimeZone", async () => {
      seedLocalConnectedOauth("INR");
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "https://oauth2.googleapis.com/token") {
          return new Response(JSON.stringify({ access_token: "ya29.tz", expires_in: 3600 }), {
            status: 200,
          });
        }
        if (url === `https://admob.googleapis.com/v1/accounts/${validPublisherId}`) {
          return new Response(
            JSON.stringify({
              publisherId: validPublisherId,
              reportingTimeZone: "Invalid/Fake_Timezone",
              currencyCode: "INR",
            }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as typeof fetch;

      try {
        const res = await callApi(
          new Request("http://localhost:3000/api/admin/admob/sync-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ reportMonth: "2026-10" }),
          }),
        );
        assert.equal(res.status, 422);
        const data = (await res.json()) as any;
        assert.ok(data.error.includes("invalid reportingTimeZone"));
        assert.ok(data.error.includes("Refusing to fall back silently to UTC"));
        assert.equal((readStoreJson().admobReportSnapshots || []).length, 0);
      } finally {
        globalThis.fetch = originalFetch;
        fs.writeFileSync(storePath, initialStoreSnapshot);
      }
    });

    it("resolves omitted reportMonth using verified Google reportingTimeZone and fails closed (422) on verify-report if stored timezone is invalid or missing", async () => {
      seedLocalConnectedOauth("INR");
      const targetTz = "Pacific/Kiritimati";
      const expectedParts = new Intl.DateTimeFormat("en-CA", {
        timeZone: targetTz,
        year: "numeric",
        month: "2-digit",
      }).formatToParts(new Date());
      const expectedMonth = `${expectedParts.find((p) => p.type === "year")?.value}-${expectedParts.find((p) => p.type === "month")?.value}`;

      globalThis.fetch = (async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "https://oauth2.googleapis.com/token") {
          return new Response(JSON.stringify({ access_token: "ya29.tz2", expires_in: 3600 }), {
            status: 200,
          });
        }
        if (url === `https://admob.googleapis.com/v1/accounts/${validPublisherId}`) {
          return new Response(
            JSON.stringify({
              publisherId: validPublisherId,
              reportingTimeZone: targetTz,
              currencyCode: "INR",
            }),
            { status: 200 },
          );
        }
        if (
          url ===
          `https://admob.googleapis.com/v1/accounts/${validPublisherId}/networkReport:generate`
        ) {
          return new Response(
            JSON.stringify([{ header: { localizationSettings: { currencyCode: "INR" } } }]),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as typeof fetch;

      try {
        // Omitted reportMonth resolves in Pacific/Kiritimati
        const res = await callApi(
          new Request("http://localhost:3000/api/admin/admob/sync-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({}),
          }),
        );
        assert.equal(res.status, 200);
        const data = (await res.json()) as any;
        assert.equal(data.snapshot.report_month, expectedMonth);
        assert.equal(data.snapshot.reporting_time_zone, targetTz);

        // Corrupt stored reporting_time_zone on a closed snapshot -> verify-report must fail closed 422 (never fall back to UTC)
        const store = readStoreJson();
        store.admobReportSnapshots.push({
          id: 99,
          publisher_id: validPublisherId,
          app_id: validFaceTubeAppId,
          report_month: "2026-10",
          period_start: "2026-10-01",
          period_end: "2026-10-31",
          reporting_time_zone: "Corrupt/Zone",
          currency_code: "INR",
          estimated_earnings_micros: "1000000",
          estimated_earnings: "1.000000",
          impressions: 10,
          clicks: 0,
          ad_requests: 10,
          matched_requests: 10,
          ownership_scope: "COMPANY_100_PERCENT",
          status: "staged_estimated",
          sync_count: 1,
          synced_by: adminUserId,
          synced_at: "2026-11-01T00:00:00.000Z",
        });
        fs.writeFileSync(storePath, JSON.stringify(store, null, 2));

        const verifyBadTz = await callApi(
          new Request("http://localhost:3000/api/admin/admob/verify-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ reportMonth: "2026-10" }),
          }),
        );
        assert.equal(verifyBadTz.status, 422);
      } finally {
        globalThis.fetch = originalFetch;
        fs.writeFileSync(storePath, initialStoreSnapshot);
      }
    });
  });

  // --------------------------------------------------------------------------
  // 12. Phase 2.1 Low E: 64-bit+ Micros Precision & Overflow Safety
  // --------------------------------------------------------------------------
  describe("12. Monetary Micros Precision & Overflow Safety", () => {
    it("formats micros values exceeding Number.MAX_SAFE_INTEGER accurately with BigInt and matches PHP string-decimal helpers", async () => {
      seedLocalConnectedOauth("INR");
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "https://oauth2.googleapis.com/token") {
          return new Response(JSON.stringify({ access_token: "ya29.bigint", expires_in: 3600 }), {
            status: 200,
          });
        }
        if (url === `https://admob.googleapis.com/v1/accounts/${validPublisherId}`) {
          return new Response(
            JSON.stringify({
              publisherId: validPublisherId,
              reportingTimeZone: "Asia/Kolkata",
              currencyCode: "INR",
            }),
            { status: 200 },
          );
        }
        if (
          url ===
          `https://admob.googleapis.com/v1/accounts/${validPublisherId}/networkReport:generate`
        ) {
          return new Response(
            JSON.stringify([
              { header: { localizationSettings: { currencyCode: "INR" } } },
              {
                row: {
                  dimensionValues: { APP: { value: validFaceTubeAppId } },
                  metricValues: {
                    // > Number.MAX_SAFE_INTEGER (9,007,199,254,740,991)
                    ESTIMATED_EARNINGS: { microsValue: "9007199254740995123" },
                    IMPRESSIONS: { integerValue: "100" },
                  },
                },
              },
              {
                row: {
                  dimensionValues: { APP: { value: validFaceTubeAppId } },
                  metricValues: {
                    ESTIMATED_EARNINGS: { microsValue: "4000000" },
                    IMPRESSIONS: { integerValue: "50" },
                  },
                },
              },
            ]),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as typeof fetch;

      try {
        const res = await callApi(
          new Request("http://localhost:3000/api/admin/admob/sync-report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ reportMonth: "2026-10" }),
          }),
        );
        assert.equal(res.status, 200);
        const data = (await res.json()) as any;
        assert.equal(data.snapshot.estimated_earnings_micros, "9007199254744995123");
        assert.equal(data.snapshot.estimated_earnings, "9007199254744.995123");

        // Verify PHP uses zero-overflow decimal string math
        const phpHelper = fs.readFileSync(
          path.resolve(process.cwd(), "api/admin/admob/admob-reporting.php"),
          "utf-8",
        );
        assert.ok(phpHelper.includes("function addAdmobIntegerStrings"));
        assert.ok(phpHelper.includes("function formatAdmobMicrosToDecimal"));
      } finally {
        globalThis.fetch = originalFetch;
        fs.writeFileSync(storePath, initialStoreSnapshot);
      }
    });
  });

  // --------------------------------------------------------------------------
  // 13. Phase 2.1 Low D: Admin UI Improvements Verification
  // --------------------------------------------------------------------------
  describe("13. Admin UI Verification Notes, 6-Decimal Precision, Error Display & Open-Month Guard", () => {
    it("enforces full 6-decimal display, verificationNotes input, explicit status error state, and open-month button disable in admin.tsx", () => {
      const adminTsx = fs.readFileSync(
        path.resolve(process.cwd(), "src/routes/admin.tsx"),
        "utf-8",
      );

      assert.ok(
        adminTsx.includes("formatAdmobInrExact"),
        "Admin UI must format INR earnings using full-precision helper",
      );
      assert.ok(
        !adminTsx.includes("Number(snap.estimated_earnings || 0).toFixed(2)"),
        "Admin UI must NOT truncate staged INR earnings to 2 decimal places",
      );
      assert.ok(
        adminTsx.includes("admobVerifyNotes") &&
          adminTsx.includes("verificationNotes: trimmedNotes"),
        "Admin UI must provide optional verificationNotes input and forward it to verifyReport",
      );
      assert.ok(
        adminTsx.includes("isAdmobMonthClosed") && adminTsx.includes("Month Open (Wait for Close)"),
        "Admin UI must disable verification for open/current/future months",
      );
      assert.ok(
        adminTsx.includes("admobStatusError") && adminTsx.includes("OAuth Status Error"),
        "Admin UI must surface getStatus() errors explicitly instead of silently showing disconnected",
      );
      assert.ok(
        adminTsx.includes("Staged (Estimated)") &&
          adminTsx.includes("Verified (Finalized — No Payout)"),
        "Admin UI must clearly distinguish Staged (Estimated) vs Verified (Finalized — No Payout)",
      );
    });
  });

  // --------------------------------------------------------------------------
  // 14. Phase 2.2 Fix 1: AdMob Reports List Scoping (Publisher ID + App ID)
  // --------------------------------------------------------------------------
  describe("14. AdMob Reports List Scoping by Active Publisher ID & FaceTube App ID (Phase 2.2)", () => {
    it("scopes local JSON /api/admin/admob/reports strictly to active publisher_id and configured ADMOB_APP_ID", async () => {
      const otherPublisherId = "pub-9999888877776666";
      seedLocalConnectedOauth("INR");

      try {
        const store = readStoreJson();
        store.admobReportSnapshots = [
          {
            id: 1,
            publisher_id: validPublisherId,
            app_id: validFaceTubeAppId,
            report_month: "2026-10",
            period_start: "2026-10-01",
            period_end: "2026-10-31",
            reporting_time_zone: "Asia/Kolkata",
            currency_code: "INR",
            estimated_earnings_micros: "15000000",
            estimated_earnings: "15.000000",
            impressions: 500,
            clicks: 10,
            ad_requests: 600,
            matched_requests: 550,
            ownership_scope: "COMPANY_100_PERCENT",
            status: "staged_estimated",
            sync_count: 1,
            synced_by: adminUserId,
            synced_at: "2026-11-01T00:00:00.000Z",
          },
          {
            id: 2,
            publisher_id: validPublisherId,
            app_id: validFaceTubeAppId,
            report_month: "2026-09",
            period_start: "2026-09-01",
            period_end: "2026-09-30",
            reporting_time_zone: "Asia/Kolkata",
            currency_code: "INR",
            estimated_earnings_micros: "25000000",
            estimated_earnings: "25.000000",
            impressions: 800,
            clicks: 20,
            ad_requests: 900,
            matched_requests: 850,
            ownership_scope: "COMPANY_100_PERCENT",
            status: "verified_finalized",
            sync_count: 2,
            synced_by: adminUserId,
            synced_at: "2026-10-01T00:00:00.000Z",
          },
          {
            id: 3,
            publisher_id: otherPublisherId,
            app_id: validFaceTubeAppId,
            report_month: "2026-10",
            period_start: "2026-10-01",
            period_end: "2026-10-31",
            reporting_time_zone: "Asia/Kolkata",
            currency_code: "INR",
            estimated_earnings_micros: "99000000",
            estimated_earnings: "99.000000",
            impressions: 9000,
            clicks: 90,
            ad_requests: 9500,
            matched_requests: 9200,
            ownership_scope: "COMPANY_100_PERCENT",
            status: "staged_estimated",
            sync_count: 1,
            synced_by: adminUserId,
            synced_at: "2026-11-01T00:00:00.000Z",
          },
          {
            id: 4,
            publisher_id: validPublisherId,
            app_id: otherAppId,
            report_month: "2026-10",
            period_start: "2026-10-01",
            period_end: "2026-10-31",
            reporting_time_zone: "Asia/Kolkata",
            currency_code: "INR",
            estimated_earnings_micros: "77000000",
            estimated_earnings: "77.000000",
            impressions: 7000,
            clicks: 70,
            ad_requests: 7500,
            matched_requests: 7200,
            ownership_scope: "COMPANY_100_PERCENT",
            status: "staged_estimated",
            sync_count: 1,
            synced_by: adminUserId,
            synced_at: "2026-11-01T00:00:00.000Z",
          },
        ];
        fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
        resetInMemoryStore();

        const listAllRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/reports", {
            headers: { Authorization: `Bearer ${adminSessionToken}` },
          }),
        );
        assert.equal(listAllRes.status, 200);
        const listAllData = (await listAllRes.json()) as any;
        assert.equal(listAllData.success, true);
        assert.equal(listAllData.count, 2);
        assert.equal(listAllData.snapshots.length, 2);
        assert.ok(
          listAllData.snapshots.every(
            (s: any) => s.publisher_id === validPublisherId && s.app_id === validFaceTubeAppId,
          ),
          "Must only return snapshots for active publisher_id and configured ADMOB_APP_ID",
        );

        // Filtered by reportMonth still excludes other publisher & other app
        const listMonthRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/reports?reportMonth=2026-10", {
            headers: { Authorization: `Bearer ${adminSessionToken}` },
          }),
        );
        assert.equal(listMonthRes.status, 200);
        const listMonthData = (await listMonthRes.json()) as any;
        assert.equal(listMonthData.count, 1);
        assert.equal(listMonthData.snapshots[0].id, 1);

        // Disconnected OAuth returns safe 200 empty state (connected: false) and exposes ZERO snapshots
        const disconnStore = readStoreJson();
        disconnStore.admobOauth = null;
        fs.writeFileSync(storePath, JSON.stringify(disconnStore, null, 2));
        resetInMemoryStore();

        const disconnectedRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/reports", {
            headers: { Authorization: `Bearer ${adminSessionToken}` },
          }),
        );
        assert.equal(disconnectedRes.status, 200);
        const disconnectedData = (await disconnectedRes.json()) as any;
        assert.equal(disconnectedData.success, true);
        assert.equal(disconnectedData.connected, false);
        assert.equal(disconnectedData.count, 0);
        assert.deepEqual(disconnectedData.snapshots, []);

        // Reserved test publisher ID in active credentials fails closed with HTTP 400
        const badPubStore = readStoreJson();
        badPubStore.admobOauth = {
          id: 2,
          publisher_id: "pub-3940256099942544",
          is_active: 1,
        };
        fs.writeFileSync(storePath, JSON.stringify(badPubStore, null, 2));
        resetInMemoryStore();

        const badPubRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/reports", {
            headers: { Authorization: `Bearer ${adminSessionToken}` },
          }),
        );
        assert.equal(badPubRes.status, 400);

        // Missing or test ADMOB_APP_ID fails closed (500 / 400)
        seedLocalConnectedOauth("INR");
        resetInMemoryStore();
        delete process.env["ADMOB_APP_ID"];
        const missingAppRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/reports", {
            headers: { Authorization: `Bearer ${adminSessionToken}` },
          }),
        );
        assert.equal(missingAppRes.status, 500);

        process.env["ADMOB_APP_ID"] = "ca-app-pub-3940256099942544~3347511713";
        const testAppRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/reports", {
            headers: { Authorization: `Bearer ${adminSessionToken}` },
          }),
        );
        assert.equal(testAppRes.status, 400);
      } finally {
        resetToBaseTestEnv();
        fs.writeFileSync(storePath, initialStoreSnapshot);
        resetInMemoryStore();
      }
    });

    it("enforces WHERE publisher_id = ? AND app_id = ? in MySQL reports route and handles disconnected/invalid publisher safely", async () => {
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_production";
      process.env["DB_USER"] = "admin_user";
      process.env["NODE_ENV"] = "production";

      const adminHash = crypto.createHash("sha256").update(adminSessionToken).digest("hex");
      const capturedQueries: Array<{ sql: string; params: any[] }> = [];
      let activeCredRow: any = { id: 1, publisher_id: validPublisherId, is_active: 1 };

      setMysqlPoolForTesting({
        query: async (sql: string, params: any[] = []) => {
          capturedQueries.push({ sql, params });
          if (sql.includes("FROM sessions") && sql.includes("JOIN users")) {
            return [
              [
                {
                  id: adminUserId,
                  user_id: adminUserId,
                  name: "FaceTube Admin",
                  email: "admin@facetube.com",
                  role: "admin",
                  status: "active",
                  session_hash: adminHash,
                },
              ],
            ];
          }
          if (sql.includes("FROM admob_oauth_credentials")) {
            return [activeCredRow ? [activeCredRow] : []];
          }
          if (sql.includes("FROM admob_report_snapshots")) {
            return [
              [
                {
                  id: 10,
                  publisher_id: validPublisherId,
                  app_id: validFaceTubeAppId,
                  report_month: "2026-10",
                  currency_code: "INR",
                  estimated_earnings: "100.000000",
                  status: "staged_estimated",
                },
              ],
            ];
          }
          return [[]];
        },
      });

      try {
        // Connected MySQL query binds [activePublisherId, appId]
        const res = await callApi(
          new Request("http://localhost:3000/api/admin/admob/reports", {
            headers: { Authorization: `Bearer ${adminSessionToken}` },
          }),
        );
        assert.equal(res.status, 200);
        const snapQuery = capturedQueries.find((q) =>
          q.sql.includes("FROM admob_report_snapshots"),
        );
        assert.ok(snapQuery, "Expected MySQL query against admob_report_snapshots");
        assert.ok(
          snapQuery.sql.includes("WHERE publisher_id = ? AND app_id = ?"),
          "MySQL reports query must scope by publisher_id and app_id",
        );
        assert.deepEqual(snapQuery.params, [validPublisherId, validFaceTubeAppId]);

        // Filtered by reportMonth binds [activePublisherId, appId, reportMonth]
        capturedQueries.length = 0;
        const monthRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/reports?reportMonth=2026-10", {
            headers: { Authorization: `Bearer ${adminSessionToken}` },
          }),
        );
        assert.equal(monthRes.status, 200);
        const monthQuery = capturedQueries.find((q) =>
          q.sql.includes("FROM admob_report_snapshots"),
        );
        assert.ok(
          monthQuery?.sql.includes("WHERE publisher_id = ? AND app_id = ? AND report_month = ?"),
        );
        assert.deepEqual(monthQuery?.params, [validPublisherId, validFaceTubeAppId, "2026-10"]);

        // Disconnected OAuth in MySQL -> 200 empty array, ZERO snapshot queries
        capturedQueries.length = 0;
        activeCredRow = null;
        const discRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/reports", {
            headers: { Authorization: `Bearer ${adminSessionToken}` },
          }),
        );
        assert.equal(discRes.status, 200);
        const discData = (await discRes.json()) as any;
        assert.equal(discData.connected, false);
        assert.equal(discData.count, 0);
        assert.ok(
          !capturedQueries.some((q) => q.sql.includes("FROM admob_report_snapshots")),
          "Must not query snapshots when AdMob OAuth is disconnected",
        );

        // Invalid active publisher in MySQL -> 400, ZERO snapshot queries
        capturedQueries.length = 0;
        activeCredRow = { id: 2, publisher_id: "pub-3940256099942544", is_active: 1 };
        const invalidPubRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/reports", {
            headers: { Authorization: `Bearer ${adminSessionToken}` },
          }),
        );
        assert.equal(invalidPubRes.status, 400);
        assert.ok(
          !capturedQueries.some((q) => q.sql.includes("FROM admob_report_snapshots")),
          "Must not query snapshots when connected publisher_id is invalid/test ID",
        );
      } finally {
        setMysqlPoolForTesting(null);
        resetToBaseTestEnv();
      }
    });

    it("confirms PHP api/admin/admob/reports.php mirrors publisher_id + app_id scoping and disconnected handling", () => {
      const phpReports = fs.readFileSync(
        path.resolve(process.cwd(), "api/admin/admob/reports.php"),
        "utf-8",
      );

      assert.ok(phpReports.includes("resolveFaceTubeAdmobAppId(null)"));
      assert.ok(phpReports.includes("FROM admob_oauth_credentials"));
      assert.ok(phpReports.includes("'connected' => false"));
      assert.ok(phpReports.includes("pub-3940256099942544"));
      assert.ok(phpReports.includes("WHERE publisher_id = ? AND app_id = ? AND report_month = ?"));
      assert.ok(phpReports.includes("WHERE publisher_id = ? AND app_id = ?"));
      assert.ok(!phpReports.includes("UPDATE wallet_balances"));
      assert.ok(!phpReports.includes("INSERT INTO income_ledger"));
      assert.ok(!phpReports.includes("record-admob-earning"));
    });
  });

  // --------------------------------------------------------------------------
  // 15. Phase 2.2 Fix 2: Admin UI Reporting Timezone Guard (No Silent UTC Fallback)
  // --------------------------------------------------------------------------
  describe("15. Admin UI Reporting Timezone Guard (Phase 2.2)", () => {
    it("disables verification and shows explicit reason when reporting_time_zone is missing or invalid (no UTC fallback)", () => {
      const adminTsx = fs.readFileSync(
        path.resolve(process.cwd(), "src/routes/admin.tsx"),
        "utf-8",
      );

      assert.ok(
        !adminTsx.includes('reporting_time_zone || "UTC"') &&
          !adminTsx.includes('reportingTimeZone || "UTC"'),
        "Admin UI must never silently default missing reporting_time_zone to UTC",
      );
      assert.ok(
        adminTsx.includes("getAdmobMonthCloseState") &&
          adminTsx.includes("isTimezoneError") &&
          adminTsx.includes(
            "Missing reporting timezone metadata; cannot verify month-end close safely.",
          ) &&
          adminTsx.includes("Timezone Metadata Required") &&
          adminTsx.includes("{closeState.reason}"),
        "Admin UI must expose explicit timezone guard state, disabled button label, and user-facing reason",
      );
      assert.ok(
        adminTsx.includes("const isAdmobMonthClosed =") &&
          adminTsx.includes("getAdmobMonthCloseState(reportMonth, reportingTimeZone).isClosed"),
        "isAdmobMonthClosed must delegate to getAdmobMonthCloseState",
      );
    });
  });
});
