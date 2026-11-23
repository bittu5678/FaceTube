import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  handleApiRequest,
  resetStoreForTests,
  resolveTrustedRequestCountryCode,
  isTrustedCloudflareIp,
} from "./api-handler";
import { setMysqlPoolForTesting } from "./mysql";
import { normalizeCountryCode, getCountryName, UNKNOWN_COUNTRY_CODE } from "../lib/countries";

const TEST_KEY_ID = "rzp_test_CountryCounts";
const TEST_SECRET = "test_secret_country_counts_987654321";

const DEV_ENV = {
  APP_ENV: "test",
  NODE_ENV: "test",
  RAZORPAY_KEY_ID: TEST_KEY_ID,
  RAZORPAY_KEY_SECRET: TEST_SECRET,
  RAZORPAY_SKIP_REMOTE_CHECK: "true",
};

let tempDataDir = "";
let previousDataDir: string | undefined;

async function withMockMysqlPool<T>(mockPool: any, fn: () => Promise<T>): Promise<T> {
  const prevHost = process.env["DB_HOST"];
  const prevName = process.env["DB_NAME"];
  const prevUser = process.env["DB_USER"];
  process.env["DB_HOST"] = "127.0.0.1";
  process.env["DB_NAME"] = "facetube_test";
  process.env["DB_USER"] = "facetube_test";
  setMysqlPoolForTesting(mockPool);
  try {
    return await fn();
  } finally {
    setMysqlPoolForTesting(null);
    if (prevHost === undefined) delete process.env["DB_HOST"];
    else process.env["DB_HOST"] = prevHost;
    if (prevName === undefined) delete process.env["DB_NAME"];
    else process.env["DB_NAME"] = prevName;
    if (prevUser === undefined) delete process.env["DB_USER"];
    else process.env["DB_USER"] = prevUser;
  }
}

function getTempStorePath(): string {
  return path.join(tempDataDir, "facetube_store.json");
}

function readTempStore(): any {
  return JSON.parse(fs.readFileSync(getTempStorePath(), "utf8"));
}

function writeTempStore(store: any): void {
  fs.writeFileSync(getTempStorePath(), JSON.stringify(store, null, 2), "utf8");
}

async function loginAs(
  identifier: string,
  password: string,
  env: Record<string, string | undefined> = DEV_ENV,
): Promise<{ token: string; userId: string }> {
  const res = await handleApiRequest(
    new Request("http://localhost:3000/api/auth/login.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier, password }),
    }),
    env,
  );
  assert.ok(res);
  assert.equal(res.status, 200, `Login for ${identifier} should succeed`);
  const data = await res.json();
  return {
    token: String(data.token),
    userId: String(data.user?.user_id || data.user?.userId || ""),
  };
}

async function createVerifiedPayment(params: {
  token: string;
  userId: string;
  purpose: "premium_video_upload" | "ads_promotion";
  videoId?: string;
  planId?: "plan-7-days" | "plan-15-days" | "plan-monthly" | "plan-yearly";
  amount: number;
}): Promise<{ orderId: string; paymentId: string }> {
  const orderRes = await handleApiRequest(
    new Request("http://localhost:3000/api/payments/create-order", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.token}`,
      },
      body: JSON.stringify({
        purpose: params.purpose,
        userId: params.userId,
        videoId: params.videoId,
        planId: params.planId,
      }),
    }),
    DEV_ENV,
  );
  assert.ok(orderRes);
  assert.equal(orderRes.status, 200);
  const orderBody = await orderRes.json();
  const orderId = String(orderBody.orderId);
  const paymentId = `pay_cc_${params.purpose}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const signature = crypto
    .createHmac("sha256", TEST_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");

  const verifyRes = await handleApiRequest(
    new Request("http://localhost:3000/api/payments/verify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.token}`,
      },
      body: JSON.stringify({
        orderId,
        paymentId,
        signature,
        userId: params.userId,
        purpose: params.purpose,
        videoId: params.videoId,
        planId: params.planId,
        amount: params.amount,
      }),
    }),
    DEV_ENV,
  );
  assert.ok(verifyRes);
  assert.equal(verifyRes.status, 200);
  const verifyBody = await verifyRes.json();
  assert.equal(verifyBody.verified, true);
  return { orderId, paymentId };
}

async function createVideoRequest(params: {
  token: string;
  userId: string;
  id: string;
  videoType?: "free" | "premium";
  visibility?: "public" | "unlisted" | "private";
  paymentId?: string;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  remoteAddress?: string;
}): Promise<Response> {
  const res = await handleApiRequest(
    new Request("http://localhost:3000/api/videos/create.php", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.token}`,
        ...(params.headers || {}),
      },
      body: JSON.stringify({
        id: params.id,
        user_id: params.userId,
        title: `Video ${params.id}`,
        description: "Test video description",
        video_url: "https://cdn.example.com/test.mp4",
        video_type: params.videoType || "free",
        content_type: "long",
        category: "Coding",
        duration: "03:15",
        ...(params.visibility ? { visibility: params.visibility } : {}),
        ...(params.paymentId ? { payment_id: params.paymentId } : {}),
        ...(params.extraBody || {}),
      }),
    }),
    params.env || DEV_ENV,
    params.remoteAddress !== undefined ? { remoteAddress: params.remoteAddress } : undefined,
  );
  assert.ok(res);
  return res;
}

describe("Admin Country-wise Video Counts & Trusted Country Capture", () => {
  beforeEach(() => {
    previousDataDir = process.env["FACETUBE_DATA_DIR"];
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-country-test-"));
    process.env["FACETUBE_DATA_DIR"] = tempDataDir;
    setMysqlPoolForTesting(null);
    resetStoreForTests();
  });

  afterEach(() => {
    setMysqlPoolForTesting(null);
    if (previousDataDir === undefined) {
      delete process.env["FACETUBE_DATA_DIR"];
    } else {
      process.env["FACETUBE_DATA_DIR"] = previousDataDir;
    }
    if (tempDataDir && fs.existsSync(tempDataDir)) {
      fs.rmSync(tempDataDir, { recursive: true, force: true });
    }
  });

  it("1. Normalizes valid ISO 3166-1 alpha-2 codes to uppercase", () => {
    assert.equal(normalizeCountryCode("in"), "IN");
    assert.equal(normalizeCountryCode(" us "), "US");
    assert.equal(normalizeCountryCode("Gb"), "GB");
    assert.equal(getCountryName("in"), "India");
    assert.equal(getCountryName("US"), "United States");
  });

  it("2. Maps invalid, blank, or Cloudflare special codes (XX, T1) to UNKNOWN", () => {
    for (const bad of ["", "   ", null, undefined, "XX", "T1", "ZZ", "123", "India", "IND"]) {
      assert.equal(normalizeCountryCode(bad), UNKNOWN_COUNTRY_CODE);
    }
    assert.equal(getCountryName("UNKNOWN"), "Unknown / Unassigned");
    assert.equal(getCountryName("XX"), "Unknown / Unassigned");
  });

  it("3. Ignores untrusted client headers (X-Forwarded-For, X-Country, spoofed CF-IPCountry) and payload country fields", async () => {
    const alex = await loginAs("alex@facetube.com", "password");
    const res = await createVideoRequest({
      token: alex.token,
      userId: alex.userId,
      id: "vid-untrusted-headers",
      headers: {
        "CF-IPCountry": "US",
        "X-Forwarded-For": "8.8.8.8",
        "X-Country": "DE",
        "X-Client-Country": "JP",
      },
      extraBody: {
        country: "IN",
        countryCode: "GB",
        country_code: "FR",
      },
      remoteAddress: "203.0.113.50",
    });

    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.video.countryCode, "UNKNOWN");
    assert.equal(body.video.country_code, "UNKNOWN");
  });

  it("4. Accepts CF-IPCountry only when verified behind trusted Cloudflare peer IP, IPv4-mapped IPv6, IPv6, origin secret, or explicit trusted proxy", async () => {
    assert.equal(isTrustedCloudflareIp("173.245.48.10"), true);
    assert.equal(isTrustedCloudflareIp("::ffff:104.16.12.34"), true);
    assert.equal(isTrustedCloudflareIp("2606:4700:4700::1111"), true);
    assert.equal(isTrustedCloudflareIp("203.0.113.10"), false);

    // 4a. Cloudflare peer IP via requestMeta
    const reqCfPeer = new Request("http://localhost:3000/api/videos/create.php", {
      method: "POST",
      headers: { "CF-IPCountry": "in" },
    });
    assert.equal(
      resolveTrustedRequestCountryCode(reqCfPeer, DEV_ENV, { remoteAddress: "104.24.10.5" }),
      "IN",
    );

    // 4b. Cloudflare IPv4-mapped IPv6 peer + XX special code -> UNKNOWN
    const reqCfSpecial = new Request("http://localhost:3000/api/videos/create.php", {
      method: "POST",
      headers: { "CF-IPCountry": "XX" },
    });
    assert.equal(
      resolveTrustedRequestCountryCode(reqCfSpecial, DEV_ENV, {
        remoteAddress: "::ffff:172.64.5.10",
      }),
      "UNKNOWN",
    );

    // 4c. Origin secret header
    const reqOriginSecret = new Request("http://localhost:3000/api/videos/create.php", {
      method: "POST",
      headers: {
        "CF-IPCountry": "ca",
        "X-CF-Origin-Secret": "super-secret-cf-token",
      },
    });
    assert.equal(
      resolveTrustedRequestCountryCode(
        reqOriginSecret,
        { ...DEV_ENV, CLOUDFLARE_ORIGIN_SECRET: "super-secret-cf-token" },
        { remoteAddress: "127.0.0.1" },
      ),
      "CA",
    );

    // 4d. Explicit trusted proxy + CF-Ray
    const reqTrustedProxy = new Request("http://localhost:3000/api/videos/create.php", {
      method: "POST",
      headers: {
        "CF-IPCountry": "sg",
        "CF-Ray": "89abcdef01234567-SIN",
      },
    });
    assert.equal(
      resolveTrustedRequestCountryCode(
        reqTrustedProxy,
        {
          ...DEV_ENV,
          TRUST_CLOUDFLARE_PROXY: "true",
          TRUSTED_PROXY_IPS: "10.0.0.0/8",
        },
        { remoteAddress: "10.12.34.56" },
      ),
      "SG",
    );

    // Trusted proxy without CF-Ray is rejected
    const reqTrustedProxyNoRay = new Request("http://localhost:3000/api/videos/create.php", {
      method: "POST",
      headers: { "CF-IPCountry": "sg" },
    });
    assert.equal(
      resolveTrustedRequestCountryCode(
        reqTrustedProxyNoRay,
        {
          ...DEV_ENV,
          TRUST_CLOUDFLARE_PROXY: "true",
          TRUSTED_PROXY_IPS: "10.0.0.0/8",
        },
        { remoteAddress: "10.12.34.56" },
      ),
      "UNKNOWN",
    );
  });

  it("5. Preserves original video country_code on metadata updates in both Store and MySQL modes", async () => {
    const alex = await loginAs("alex@facetube.com", "password");

    // Create originally from India via trusted Cloudflare peer
    const createRes = await createVideoRequest({
      token: alex.token,
      userId: alex.userId,
      id: "vid-preserve-country",
      headers: { "CF-IPCountry": "IN" },
      remoteAddress: "104.16.1.2",
    });
    assert.equal(createRes.status, 201);
    const createdBody = await createRes.json();
    assert.equal(createdBody.video.countryCode, "IN");

    // Later update same video from Germany / untrusted request — original IN must remain untouched
    const updateRes = await createVideoRequest({
      token: alex.token,
      userId: alex.userId,
      id: "vid-preserve-country",
      headers: { "CF-IPCountry": "DE" },
      remoteAddress: "104.16.1.3",
    });
    assert.equal(updateRes.status, 201);
    const updatedBody = await updateRes.json();
    assert.equal(updatedBody.video.countryCode, "IN");

    const storeAfter = readTempStore();
    const stored = storeAfter.videos.find((v: any) => v.id === "vid-preserve-country");
    assert.equal(stored.country_code, "IN");

    // Verify MySQL path omits country_code from ON DUPLICATE KEY UPDATE and preserves existing NULL/IN
    const executedQueries: Array<{ sql: string; params: any[] }> = [];
    const mockConn = {
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {},
      query: async (sql: string, params: any[] = []) => {
        executedQueries.push({ sql, params });
        if (sql.includes("FROM uploaded_videos") && sql.includes("FOR UPDATE")) {
          return [
            [
              {
                id: "vid-mysql-existing",
                user_id: alex.userId,
                visibility: "public",
                payment_status: "not_required",
                payment_id: null,
                payment_amount: 0,
                is_promoted: 0,
                views: 10,
                likes: 2,
                created_at: "2026-01-01T00:00:00.000Z",
                country_code: null, // historical row
              },
            ],
          ];
        }
        return [[]];
      },
    };
    const mockPool: any = {
      query: async (sql: string, params: any[] = []) => {
        if (sql.includes("FROM sessions s")) {
          return [
            [
              {
                id: "a0000000-0000-0000-0000-000000000002",
                user_id: alex.userId,
                name: "Alex Rivera",
                mobile: "+1 555-014-8392",
                email: "alex@facetube.com",
                role: "user",
                referral_code: "CREATOR50",
                created_at: "2026-01-01T00:00:00.000Z",
              },
            ],
          ];
        }
        if (sql.includes("INFORMATION_SCHEMA.COLUMNS")) {
          return [[{ "1": 1 }]];
        }
        return [[]];
      },
      getConnection: async () => mockConn,
    };
    await withMockMysqlPool(mockPool, async () => {
      const mysqlUpdateRes = await createVideoRequest({
        token: alex.token,
        userId: alex.userId,
        id: "vid-mysql-existing",
        headers: { "CF-IPCountry": "US" },
        remoteAddress: "104.16.1.3",
      });
      assert.equal(mysqlUpdateRes.status, 201);
      const mysqlUpdateBody = await mysqlUpdateRes.json();
      assert.equal(mysqlUpdateBody.video.countryCode, "UNKNOWN");

      const insertQuery = executedQueries.find((q) =>
        q.sql.includes("INSERT INTO uploaded_videos"),
      );
      assert.ok(insertQuery);
      const onDupPart = insertQuery.sql.split("ON DUPLICATE KEY UPDATE")[1] || "";
      assert.equal(onDupPart.includes("country_code"), false);
    });
  });

  it("6-11 & 15. Aggregates countries accurately with all locked business rules & reconciles summary", async () => {
    const admin = await loginAs("admin@facetube.com", "password");
    const alex = await loginAs("alex@facetube.com", "password");

    // Start from a clean videos array in temp store for exact arithmetic verification
    const store = readTempStore();
    store.videos = [];
    writeTempStore(store);

    // 1. IN: free public, not blocked, active ad promotion
    const r1 = await createVideoRequest({
      token: alex.token,
      userId: alex.userId,
      id: "vid-in-free-public-ad",
      videoType: "free",
      visibility: "public",
      headers: { "CF-IPCountry": "IN" },
      remoteAddress: "104.16.1.1",
    });
    assert.equal(r1.status, 201);

    // 2. IN: free unlisted, blocked
    const r2 = await createVideoRequest({
      token: alex.token,
      userId: alex.userId,
      id: "vid-in-free-unlisted-blocked",
      videoType: "free",
      visibility: "unlisted",
      headers: { "CF-IPCountry": "IN" },
      remoteAddress: "104.16.1.1",
    });
    assert.equal(r2.status, 201);

    // 3. IN: premium paid, private visibility
    const paidInPay = await createVerifiedPayment({
      token: alex.token,
      userId: alex.userId,
      purpose: "premium_video_upload",
      videoId: "vid-in-premium-paid-private",
      amount: 6,
    });
    const r3 = await createVideoRequest({
      token: alex.token,
      userId: alex.userId,
      id: "vid-in-premium-paid-private",
      videoType: "premium",
      visibility: "private",
      paymentId: paidInPay.paymentId,
      headers: { "CF-IPCountry": "IN" },
      remoteAddress: "104.16.1.1",
    });
    assert.equal(r3.status, 201);

    // 4. US: premium paid, blocked + active ad
    const paidUsPay = await createVerifiedPayment({
      token: alex.token,
      userId: alex.userId,
      purpose: "premium_video_upload",
      videoId: "vid-us-premium-paid-blocked-ad",
      amount: 6,
    });
    const r4 = await createVideoRequest({
      token: alex.token,
      userId: alex.userId,
      id: "vid-us-premium-paid-blocked-ad",
      videoType: "premium",
      visibility: "public",
      paymentId: paidUsPay.paymentId,
      headers: { "CF-IPCountry": "US" },
      remoteAddress: "104.16.1.2",
    });
    assert.equal(r4.status, 201);

    // Block vid-in-free-unlisted-blocked and vid-us-premium-paid-blocked-ad via admin endpoint
    for (const blockId of ["vid-in-free-unlisted-blocked", "vid-us-premium-paid-blocked-ad"]) {
      const bRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/videos.php", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${admin.token}`,
          },
          body: JSON.stringify({ videoId: blockId, isBlocked: true }),
        }),
        DEV_ENV,
      );
      assert.ok(bRes && bRes.status === 200);
    }

    // Add historical null/blank/invalid videos, expired ad, and pending/failed premium rows directly in temp store
    const updatedStore = readTempStore();
    const futureIso = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
    const pastIso = new Date(Date.now() - 2 * 86400 * 1000).toISOString();

    const inFreeAdRow = updatedStore.videos.find((v: any) => v.id === "vid-in-free-public-ad");
    inFreeAdRow.is_promoted = true;
    inFreeAdRow.promotion_expires_at = futureIso;

    const usPremBlockedAdRow = updatedStore.videos.find(
      (v: any) => v.id === "vid-us-premium-paid-blocked-ad",
    );
    usPremBlockedAdRow.is_promoted = true;
    usPremBlockedAdRow.promotion_expires_at = futureIso;

    updatedStore.videos.push(
      // Historical NULL / missing country -> UNKNOWN (eligible free, expired ad -> activeAds=0)
      {
        id: "vid-hist-null",
        user_id: alex.userId,
        creator_name: "Alex Rivera",
        title: "Historical Null",
        description: "",
        video_url: "https://cdn.example.com/h1.mp4",
        thumbnail_url: "https://cdn.example.com/h1.jpg",
        video_type: "free",
        content_type: "long",
        category: "Coding",
        duration: "1:00",
        views: 0,
        likes: 0,
        payment_status: "not_required",
        payment_amount: 0,
        is_promoted: true,
        promotion_expires_at: pastIso, // expired ad must NOT count as active ad
        visibility: "public",
        created_at: pastIso,
        updated_at: pastIso,
      },
      // Blank country -> UNKNOWN (eligible free)
      {
        id: "vid-hist-blank",
        user_id: alex.userId,
        creator_name: "Alex Rivera",
        title: "Historical Blank",
        description: "",
        video_url: "https://cdn.example.com/h2.mp4",
        thumbnail_url: "https://cdn.example.com/h2.jpg",
        video_type: "free",
        content_type: "short",
        category: "Coding",
        duration: "0:30",
        views: 0,
        likes: 0,
        payment_status: "not_required",
        payment_amount: 0,
        is_promoted: false,
        visibility: "private",
        country_code: "   ",
        created_at: pastIso,
        updated_at: pastIso,
      },
      // Pending premium -> MUST BE EXCLUDED
      {
        id: "vid-in-premium-pending",
        user_id: alex.userId,
        creator_name: "Alex Rivera",
        title: "Pending Premium",
        description: "",
        video_url: "https://cdn.example.com/p1.mp4",
        thumbnail_url: "https://cdn.example.com/p1.jpg",
        video_type: "premium",
        content_type: "long",
        category: "Coding",
        duration: "2:00",
        views: 0,
        likes: 0,
        payment_status: "pending",
        payment_amount: 6,
        is_promoted: false,
        visibility: "public",
        country_code: "IN",
        created_at: pastIso,
        updated_at: pastIso,
      },
      // Failed premium -> MUST BE EXCLUDED
      {
        id: "vid-us-premium-failed",
        user_id: alex.userId,
        creator_name: "Alex Rivera",
        title: "Failed Premium",
        description: "",
        video_url: "https://cdn.example.com/p2.mp4",
        thumbnail_url: "https://cdn.example.com/p2.jpg",
        video_type: "premium",
        content_type: "long",
        category: "Coding",
        duration: "2:00",
        views: 0,
        likes: 0,
        payment_status: "failed",
        payment_amount: 6,
        is_promoted: false,
        visibility: "public",
        country_code: "US",
        created_at: pastIso,
        updated_at: pastIso,
      },
    );
    writeTempStore(updatedStore);

    const analyticsRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/video-country-counts.php", {
        method: "GET",
        headers: { Authorization: `Bearer ${admin.token}` },
      }),
      DEV_ENV,
    );
    assert.ok(analyticsRes);
    assert.equal(analyticsRes.status, 200);
    const analytics = await analyticsRes.json();

    assert.equal(analytics.success, true);
    assert.equal(analytics.migrationPending, false);
    assert.equal(analytics.countries.length, 3);

    const byCode = new Map<string, any>(analytics.countries.map((c: any) => [c.countryCode, c]));

    // IN: 2 free (public + unlisted blocked) + 1 paid premium (private) = 3 total; 1 active ad; 1 blocked
    assert.deepEqual(byCode.get("IN"), {
      countryCode: "IN",
      countryName: "India",
      totalVideos: 3,
      freeVideos: 2,
      premiumVideos: 1,
      activeAdsVideos: 1,
      blockedVideos: 1,
    });

    // UNKNOWN: 2 historical free (public expired ad + private blank country) = 2 total; 0 active ads; 0 blocked
    assert.deepEqual(byCode.get("UNKNOWN"), {
      countryCode: "UNKNOWN",
      countryName: "Unknown / Unassigned",
      totalVideos: 2,
      freeVideos: 2,
      premiumVideos: 0,
      activeAdsVideos: 0,
      blockedVideos: 0,
    });

    // US: 1 paid premium (blocked + active ad) = 1 total (failed premium excluded)
    assert.deepEqual(byCode.get("US"), {
      countryCode: "US",
      countryName: "United States",
      totalVideos: 1,
      freeVideos: 0,
      premiumVideos: 1,
      activeAdsVideos: 1,
      blockedVideos: 1,
    });

    // Verify Free + Premium = Total per country and in summary; Active Ads NOT added to totalVideos
    let sumTotal = 0;
    let sumFree = 0;
    let sumPrem = 0;
    let sumAds = 0;
    let sumBlocked = 0;
    for (const row of analytics.countries) {
      assert.equal(row.freeVideos + row.premiumVideos, row.totalVideos);
      sumTotal += row.totalVideos;
      sumFree += row.freeVideos;
      sumPrem += row.premiumVideos;
      sumAds += row.activeAdsVideos;
      sumBlocked += row.blockedVideos;
    }

    assert.deepEqual(analytics.summary, {
      totalCountries: 2, // IN and US (UNKNOWN excluded from identified country count)
      hasUnknown: true,
      unknownVideos: 2,
      totalVideos: sumTotal,
      freeVideos: sumFree,
      premiumVideos: sumPrem,
      activeAdsVideos: sumAds,
      blockedVideos: sumBlocked,
    });
    assert.equal(analytics.summary.totalVideos, 6);
    assert.equal(analytics.summary.freeVideos, 4);
    assert.equal(analytics.summary.premiumVideos, 2);
    assert.equal(analytics.summary.activeAdsVideos, 2);
    assert.equal(analytics.summary.blockedVideos, 2);
  });

  it("12 & 13. Uses single-table GROUP BY SQL in MySQL mode (no 1:N join duplication) and matches Store parity, plus handles pre-migration schema", async () => {
    const capturedSql: string[] = [];
    const makeMockPool = (hasCountryCol: boolean) => ({
      query: async (sql: string) => {
        capturedSql.push(sql);
        if (sql.includes("FROM sessions s")) {
          return [
            [
              {
                id: "a0000000-0000-0000-0000-000000000001",
                user_id: "FT102857",
                name: "FaceTube Administrator",
                mobile: "+1 555-019-2834",
                email: "admin@facetube.com",
                role: "admin",
                referral_code: "FTVIP",
                created_at: "2026-01-01T00:00:00.000Z",
              },
            ],
          ];
        }
        if (sql.includes("INFORMATION_SCHEMA.COLUMNS")) {
          return [hasCountryCol ? [{ "1": 1 }] : []];
        }
        if (sql.includes("FROM uploaded_videos") && sql.includes("GROUP BY")) {
          if (!hasCountryCol) {
            return [
              [
                {
                  country_code: "UNKNOWN",
                  total_videos: 6,
                  free_videos: 4,
                  premium_videos: 2,
                  active_ads_videos: 2,
                  blocked_videos: 2,
                },
              ],
            ];
          }
          return [
            [
              {
                country_code: "IN",
                total_videos: 3,
                free_videos: 2,
                premium_videos: 1,
                active_ads_videos: 1,
                blocked_videos: 1,
              },
              {
                country_code: "UNKNOWN",
                total_videos: 2,
                free_videos: 2,
                premium_videos: 0,
                active_ads_videos: 0,
                blocked_videos: 0,
              },
              {
                country_code: "US",
                total_videos: 1,
                free_videos: 0,
                premium_videos: 1,
                active_ads_videos: 1,
                blocked_videos: 1,
              },
            ],
          ];
        }
        return [[]];
      },
    });

    await withMockMysqlPool(makeMockPool(true), async () => {
      const resMigrated = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/video-country-counts.php", {
          method: "GET",
          headers: { Authorization: "Bearer any-admin-token" },
        }),
        { APP_ENV: "production", NODE_ENV: "production" },
      );
      assert.ok(resMigrated);
      assert.equal(resMigrated.status, 200);
      const bodyMigrated = await resMigrated.json();
      assert.equal(bodyMigrated.migrationPending, false);
      assert.equal(bodyMigrated.summary.totalVideos, 6);
      assert.equal(bodyMigrated.summary.totalCountries, 2);

      const aggSql = capturedSql.find((s) => s.includes("GROUP BY")) || "";
      assert.equal(/\bJOIN\b/i.test(aggSql), false, "SQL must not JOIN 1:N tables");
      assert.equal(aggSql.includes("payment_status"), true);
    });

    // Pre-migration compatibility check
    await withMockMysqlPool(makeMockPool(false), async () => {
      const resPreMigration = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/video-country-counts.php", {
          method: "GET",
          headers: { Authorization: "Bearer any-admin-token" },
        }),
        { APP_ENV: "production", NODE_ENV: "production" },
      );
      assert.ok(resPreMigration);
      assert.equal(resPreMigration.status, 200);
      const bodyPreMigration = await resPreMigration.json();
      assert.equal(bodyPreMigration.migrationPending, true);
      assert.equal(bodyPreMigration.summary.totalCountries, 0);
      assert.equal(bodyPreMigration.summary.unknownVideos, 6);
    });
  });

  it("14. Enforces auth (401 unauthenticated, 403 non-admin, 405 non-GET, 503/500 DB errors)", async () => {
    const alex = await loginAs("alex@facetube.com", "password");
    const admin = await loginAs("admin@facetube.com", "password");

    // 405 on POST
    const postRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/video-country-counts.php", {
        method: "POST",
        headers: { Authorization: `Bearer ${admin.token}` },
      }),
      DEV_ENV,
    );
    assert.ok(postRes);
    assert.equal(postRes.status, 405);

    // 401 unauthenticated
    const unauthRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/video-country-counts.php", { method: "GET" }),
      DEV_ENV,
    );
    assert.ok(unauthRes);
    assert.equal(unauthRes.status, 401);

    // 403 non-admin user
    const userRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/video-country-counts.php", {
        method: "GET",
        headers: { Authorization: `Bearer ${alex.token}` },
      }),
      DEV_ENV,
    );
    assert.ok(userRes);
    assert.equal(userRes.status, 403);

    // 503 in production when pool is null
    setMysqlPoolForTesting(null);
    const prodNoDbRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/video-country-counts.php", {
        method: "GET",
        headers: { Authorization: `Bearer ${admin.token}` },
      }),
      { APP_ENV: "production", NODE_ENV: "production" },
    );
    assert.ok(prodNoDbRes);
    assert.equal(prodNoDbRes.status, 503);

    // 503 when MySQL connection becomes unavailable during query
    await withMockMysqlPool(
      {
        query: async (sql: string) => {
          if (sql.includes("FROM sessions s")) {
            return [
              [
                {
                  id: "a0000000-0000-0000-0000-000000000001",
                  user_id: "FT102857",
                  name: "FaceTube Administrator",
                  mobile: "+1 555-019-2834",
                  email: "admin@facetube.com",
                  role: "admin",
                  referral_code: "FTVIP",
                  created_at: "2026-01-01T00:00:00.000Z",
                },
              ],
            ];
          }
          if (sql.includes("INFORMATION_SCHEMA.COLUMNS")) {
            return [[{ "1": 1 }]];
          }
          const err: any = new Error("Connection refused");
          err.code = "ECONNREFUSED";
          throw err;
        },
      },
      async () => {
        const connErrRes = await handleApiRequest(
          new Request("http://localhost:3000/api/admin/video-country-counts.php", {
            method: "GET",
            headers: { Authorization: "Bearer prod-admin-token" },
          }),
          { APP_ENV: "production", NODE_ENV: "production" },
        );
        assert.ok(connErrRes);
        assert.equal(connErrRes.status, 503);
      },
    );

    // 500 on unexpected non-connection SQL error
    await withMockMysqlPool(
      {
        query: async (sql: string) => {
          if (sql.includes("FROM sessions s")) {
            return [
              [
                {
                  id: "a0000000-0000-0000-0000-000000000001",
                  user_id: "FT102857",
                  name: "FaceTube Administrator",
                  mobile: "+1 555-019-2834",
                  email: "admin@facetube.com",
                  role: "admin",
                  referral_code: "FTVIP",
                  created_at: "2026-01-01T00:00:00.000Z",
                },
              ],
            ];
          }
          if (sql.includes("INFORMATION_SCHEMA.COLUMNS")) {
            return [[{ "1": 1 }]];
          }
          throw new Error("Syntax error near GROUP BY");
        },
      },
      async () => {
        const sqlErrRes = await handleApiRequest(
          new Request("http://localhost:3000/api/admin/video-country-counts.php", {
            method: "GET",
            headers: { Authorization: "Bearer prod-admin-token" },
          }),
          { APP_ENV: "production", NODE_ENV: "production" },
        );
        assert.ok(sqlErrRes);
        assert.equal(sqlErrRes.status, 500);
      },
    );
  });
});
