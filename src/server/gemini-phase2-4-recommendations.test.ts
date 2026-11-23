import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  handleApiRequest,
  normalizeRecommendationMediaUrl,
  RECOMMENDATION_CATALOG_PAGE_SIZE,
  RECOMMENDATION_MAX_MEMORY_CANDIDATES,
  RECOMMENDATION_MAX_SCAN_PAGES,
  resetAiSchemaCacheForTesting,
  resetInMemoryStore,
} from "./api-handler.ts";
import { setMysqlPoolForTesting } from "./mysql.ts";
import {
  resetAiRateLimitsForTesting,
  setGeminiClientForTesting,
  type GeminiInteractionsClientLike,
} from "./gemini-service.ts";

const USER_TOKEN = "p24-user-token";

interface MockPoolLike {
  query(sql: string, params?: unknown[]): Promise<unknown[]>;
}

interface RecommendationTestItem {
  id: string;
  videoUrl: string;
  video_url: string;
  thumbnailUrl: string;
  thumbnail_url: string;
  channelLogoUrl: string | null;
  channel_logo_url: string | null;
}

interface RecommendationTestResponse {
  success: boolean;
  source?: string;
  fallbackUsed?: boolean;
  recommendations: RecommendationTestItem[];
}

async function readRecommendationsJson(res: Response | null): Promise<RecommendationTestResponse> {
  if (!res) {
    assert.fail("Expected handleApiRequest to return a Response");
  }
  assert.equal(res.status, 200);
  const parsed: unknown = await res.json();
  if (!parsed || typeof parsed !== "object") {
    assert.fail("Expected JSON object response from recommendations endpoint");
  }
  const obj = parsed as Partial<RecommendationTestResponse>;
  assert.ok(Array.isArray(obj.recommendations), "Expected recommendations array in response");
  return {
    success: Boolean(obj.success),
    ...(typeof obj.source === "string" ? { source: obj.source } : {}),
    ...(typeof obj.fallbackUsed === "boolean" ? { fallbackUsed: obj.fallbackUsed } : {}),
    recommendations: obj.recommendations,
  };
}

function installMockPool(pool: MockPoolLike): () => void {
  const prevHost = process.env["DB_HOST"];
  const prevName = process.env["DB_NAME"];
  const prevUser = process.env["DB_USER"];
  process.env["DB_HOST"] = "127.0.0.1";
  process.env["DB_NAME"] = "facetube_test";
  process.env["DB_USER"] = "facetube_test";
  resetAiSchemaCacheForTesting();
  setMysqlPoolForTesting(pool);

  return () => {
    resetAiSchemaCacheForTesting();
    setMysqlPoolForTesting(null);
    if (prevHost === undefined) delete process.env["DB_HOST"];
    else process.env["DB_HOST"] = prevHost;
    if (prevName === undefined) delete process.env["DB_NAME"];
    else process.env["DB_NAME"] = prevName;
    if (prevUser === undefined) delete process.env["DB_USER"];
    else process.env["DB_USER"] = prevUser;
  };
}

function makeProdEnv(
  overrides?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    APP_ENV: "production",
    NODE_ENV: "production",
    GEMINI_API_KEY: "AIzaSyMockPhase24Recommendations000",
    GEMINI_MODEL: "gemini-4-hydrogen",
    GEMINI_TIMEOUT_MS: "5000",
    ...overrides,
  };
}

interface CatalogQueryRecord {
  sql: string;
  limit?: number;
  offset?: number;
}

function createPaginatedMockPool(options: {
  videos: Array<Record<string, unknown>>;
  likesByUser?: Record<string, string[]>;
}) {
  const videos = options.videos;
  const likesByUser = options.likesByUser ?? {};
  const catalogPageQueries: CatalogQueryRecord[] = [];
  const signalLookupQueries: string[] = [];
  const affinityQueries: string[] = [];

  const isRowEligible = (v: Record<string, unknown>) => {
    const blocked = Number(v["is_blocked"] ?? 0) !== 0;
    const vis =
      String(v["visibility"] ?? "public")
        .trim()
        .toLowerCase() || "public";
    const vType = String(v["video_type"] ?? "free")
      .trim()
      .toLowerCase();
    const pStatus =
      String(v["payment_status"] ?? "")
        .trim()
        .toLowerCase() || (vType === "free" ? "not_required" : "pending");
    const payOk =
      (vType === "free" && (pStatus === "not_required" || pStatus === "paid")) ||
      (vType === "premium" && pStatus === "paid");
    return !blocked && vis === "public" && payOk;
  };

  const pool = {
    catalogPageQueries,
    signalLookupQueries,
    affinityQueries,
    async query(sql: string, params: unknown[] = []): Promise<unknown[]> {
      const normalized = sql.replace(/\s+/g, " ").trim();

      if (normalized.includes("FROM INFORMATION_SCHEMA.TABLES")) {
        return [[{ TABLE_NAME: "uploaded_videos" }, { TABLE_NAME: "video_likes" }]];
      }

      if (normalized.includes("FROM INFORMATION_SCHEMA.COLUMNS")) {
        return [
          ["is_blocked", "visibility", "likes", "views"].map((col) => ({
            TABLE_NAME: "uploaded_videos",
            COLUMN_NAME: col,
          })),
        ];
      }

      if (normalized.includes("FROM sessions s") && normalized.includes("INNER JOIN users u")) {
        if (String(params[0] || "") === USER_TOKEN) {
          return [
            [
              {
                id: "usr-p24",
                user_id: "FT240001",
                name: "Catalog Tester",
                mobile: "9999900240",
                email: "tester24@example.com",
                role: "user",
                channel_name: "Tester Studio",
              },
            ],
          ];
        }
        return [[]];
      }

      if (normalized.includes("FROM video_likes")) {
        const uid = String(params[0] || "").toUpperCase();
        const likedIds = likesByUser[uid] || [];
        return [likedIds.map((video_id) => ({ video_id }))];
      }

      if (normalized.includes("FROM uploaded_videos v")) {
        let filtered = videos.filter(isRowEligible);
        let cursor = 0;

        // Targeted signal ID lookup: WHERE ... AND v.id IN (?, ...) LIMIT ?
        const inMatch = normalized.match(/AND v\.id IN \(([^)]+)\)/);
        const inPlaceholderList = inMatch?.[1];
        if (inPlaceholderList) {
          signalLookupQueries.push(normalized);
          const count = inPlaceholderList.split(",").length;
          const ids = new Set(params.slice(0, count).map(String));
          const limit = Number(params[count] ?? count);
          const matched = filtered.filter((v) => ids.has(String(v["id"]))).slice(0, limit);
          return [matched];
        }

        if (normalized.includes("AND v.id <> ?")) {
          const excluded = String(params[cursor++] ?? "");
          filtered = filtered.filter((v) => String(v["id"]) !== excluded);
        }

        // Deep-catalog affinity fallback query: AND LOWER(v.category) IN (...) ... LIMIT 50
        const catInMatch = normalized.match(/AND LOWER\(v\.category\) IN \(([^)]+)\)/);
        const catPlaceholderList = catInMatch?.[1];
        if (catPlaceholderList) {
          affinityQueries.push(normalized);
          const count = catPlaceholderList.split(",").length;
          const cats = new Set(
            params.slice(cursor, cursor + count).map((c) => String(c).trim().toLowerCase()),
          );
          const sorted = [...filtered]
            .filter((v) =>
              cats.has(
                String(v["category"] ?? "")
                  .trim()
                  .toLowerCase(),
              ),
            )
            .sort((a, b) => {
              const promoDiff =
                Number(Boolean(b["is_promoted"])) - Number(Boolean(a["is_promoted"]));
              if (promoDiff !== 0) return promoDiff;
              const dateDiff = String(b["created_at"] ?? "").localeCompare(
                String(a["created_at"] ?? ""),
              );
              if (dateDiff !== 0) return dateDiff;
              return String(b["id"] ?? "").localeCompare(String(a["id"] ?? ""));
            });
          return [sorted.slice(0, 50)];
        }

        // Paginated catalog scan: ORDER BY v.created_at DESC, v.id DESC LIMIT ? OFFSET ?
        const limit = Number(params[cursor++] ?? 100);
        const offset = Number(params[cursor++] ?? 0);
        catalogPageQueries.push({ sql: normalized, limit, offset });

        const sorted = [...filtered].sort((a, b) => {
          const dateDiff = String(b["created_at"] ?? "").localeCompare(
            String(a["created_at"] ?? ""),
          );
          if (dateDiff !== 0) return dateDiff;
          return String(b["id"] ?? "").localeCompare(String(a["id"] ?? ""));
        });
        return [sorted.slice(offset, offset + limit)];
      }

      return [[]];
    },
  };

  return pool;
}

function makeCatalogVideo(
  index: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  // Higher index -> older timestamp so index 0 is newest and index >= 100 sits past old LIMIT 100
  const baseTime = Date.UTC(2026, 0, 1, 0, 0, 0) + (5000 - index) * 60_000;
  const iso = new Date(baseTime).toISOString();
  const defaultId = `vid-${String(index).padStart(4, "0")}`;
  const overrideId = overrides["id"];
  const id = typeof overrideId === "string" && overrideId.trim() ? overrideId.trim() : defaultId;
  return {
    id,
    user_id: "FT100001",
    creator_name: "Creator",
    creator_channel_name: "Creator Studio",
    creator_channel_logo_url: "/uploads/logos/creator.png",
    title: `Catalog Video ${index}`,
    description: "Catalog test item",
    video_url: `/uploads/videos/${id}.mp4`,
    thumbnail_url: `/uploads/thumbs/${id}.jpg`,
    video_type: "free",
    content_type: "long",
    category: "Music",
    duration: "3:00",
    views: 5,
    likes: 1,
    payment_status: "not_required",
    is_promoted: 0,
    is_blocked: 0,
    visibility: "public",
    created_at: iso,
    updated_at: iso,
    ...overrides,
  };
}

test("recommendations paginate beyond the first 100 videos, bound memory, preserve privacy/eligibility, and include older relevant videos", async () => {
  resetAiRateLimitsForTesting();

  const videos: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 245; i++) {
    videos.push(makeCatalogVideo(i, { category: "Gaming", views: 2 }));
  }

  // Row 245 (page 3, well past old LIMIT 100): excluded video that user watched
  videos.push(
    makeCatalogVideo(245, {
      id: "vid-watched-old",
      category: "Science",
      title: "Older Watched Science Video",
    }),
  );

  // Row 246 (page 3, well past old LIMIT 100): high-affinity Science match that MUST appear
  videos.push(
    makeCatalogVideo(246, {
      id: "vid-older-gem",
      category: "Science",
      title: "Deep Catalog Science Breakthrough",
      views: 50000,
      likes: 4200,
      is_promoted: 1,
      promotion_expires_at: "2099-01-01T00:00:00.000Z",
    }),
  );

  // Ineligible older/newer rows that MUST NEVER leak even when matching Science
  videos.push(
    makeCatalogVideo(247, {
      id: "vid-private-science",
      category: "Science",
      visibility: "private",
      views: 999999,
      title: "Private Secret Science",
    }),
    makeCatalogVideo(248, {
      id: "vid-blocked-science",
      category: "Science",
      is_blocked: 1,
      views: 999999,
      title: "Blocked Science",
    }),
    makeCatalogVideo(249, {
      id: "vid-unpaid-premium",
      category: "Science",
      video_type: "premium",
      payment_status: "pending",
      views: 999999,
      title: "Unpaid Premium Science",
    }),
  );

  const pool = createPaginatedMockPool({
    videos,
    likesByUser: { FT240001: ["vid-watched-old"] },
  });
  const restorePool = installMockPool(pool);

  let observedCandidateCount = 0;
  let observedOlderGemInShortlist = false;
  let observedPrivateLeak = false;
  let createCalled = false;
  let createError: unknown = null;

  const mockGeminiClient: GeminiInteractionsClientLike = {
    interactions: {
      async create(params) {
        createCalled = true;
        try {
          const inputText = String(params?.["input"] ?? "");
          const match = inputText.match(
            /^<untrusted_candidate_catalog>\n([\s\S]*?)\n<\/untrusted_candidate_catalog>/m,
          );
          if (match && match[1]) {
            const shortlist = JSON.parse(match[1]) as Array<{ id: string }>;
            observedCandidateCount = shortlist.length;
            observedOlderGemInShortlist = shortlist.some((c) => c.id === "vid-older-gem");
            observedPrivateLeak = shortlist.some(
              (c) =>
                c.id === "vid-private-science" ||
                c.id === "vid-blocked-science" ||
                c.id === "vid-unpaid-premium" ||
                c.id === "vid-watched-old",
            );
          }
        } catch (err) {
          createError = err;
        }
        return {
          output_text: JSON.stringify({
            recommendations: [
              { id: "vid-older-gem", reason: "Matches your Science watch and like history" },
              { id: "vid-0000", reason: "Popular recent upload" },
            ],
          }),
        };
      },
    },
  };
  setGeminiClientForTesting(mockGeminiClient);

  try {
    const req = new Request("https://facetube.online/api/ai/recommendations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${USER_TOKEN}`,
      },
      body: JSON.stringify({
        excludeVideoId: "vid-watched-old",
        watchedVideoIds: ["vid-watched-old"],
        preferredCategories: ["Science"],
        limit: 8,
      }),
    });

    const res = await handleApiRequest(req, makeProdEnv());
    const data = await readRecommendationsJson(res);

    assert.equal(data.success, true);
    assert.equal(createCalled, true, `createError=${String(createError)}`);
    assert.equal(createError, null);
    assert.equal(data.source, "gemini");
    assert.equal(pool.signalLookupQueries.length, 1);
    assert.equal(pool.catalogPageQueries.length, 3);
    assert.deepEqual(
      pool.catalogPageQueries.map((q) => [q.limit, q.offset]),
      [
        [RECOMMENDATION_CATALOG_PAGE_SIZE, 0],
        [RECOMMENDATION_CATALOG_PAGE_SIZE, 100],
        [RECOMMENDATION_CATALOG_PAGE_SIZE, 200],
      ],
    );

    assert.ok(
      observedCandidateCount > 0 && observedCandidateCount <= 30,
      "Gemini shortlist is non-empty and stays bounded to <= 30 items",
    );
    assert.equal(observedOlderGemInShortlist, true);
    assert.equal(observedPrivateLeak, false);

    const recIds = data.recommendations.map((r) => r.id);
    assert.equal(recIds.includes("vid-older-gem"), true);
    assert.equal(recIds.includes("vid-watched-old"), false);
    assert.equal(recIds.includes("vid-private-science"), false);
    assert.equal(recIds.includes("vid-blocked-science"), false);
    assert.equal(recIds.includes("vid-unpaid-premium"), false);

    // Relative URLs on vid-older-gem normalized to configured production API origin
    const olderGem = data.recommendations.find((r) => r.id === "vid-older-gem");
    assert.ok(olderGem, "Expected vid-older-gem in recommendations");
    assert.equal(olderGem.videoUrl, "https://api.facetube.online/uploads/videos/vid-older-gem.mp4");
    assert.equal(
      olderGem.video_url,
      "https://api.facetube.online/uploads/videos/vid-older-gem.mp4",
    );
    assert.equal(
      olderGem.thumbnailUrl,
      "https://api.facetube.online/uploads/thumbs/vid-older-gem.jpg",
    );
    assert.equal(
      olderGem.thumbnail_url,
      "https://api.facetube.online/uploads/thumbs/vid-older-gem.jpg",
    );
    assert.equal(olderGem.channelLogoUrl, "https://api.facetube.online/uploads/logos/creator.png");
    assert.equal(
      olderGem.channel_logo_url,
      "https://api.facetube.online/uploads/logos/creator.png",
    );
  } finally {
    setGeminiClientForTesting(null);
    restorePool();
  }
});

test("deterministic fallback surfaces older catalog videos past 100 rows when Gemini is unavailable", async () => {
  resetAiRateLimitsForTesting();

  const videos: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 160; i++) {
    videos.push(makeCatalogVideo(i, { category: "Travel", views: 10 }));
  }
  videos.push(
    makeCatalogVideo(160, {
      id: "vid-older-fallback",
      category: "Cooking",
      title: "Older Chef Special",
      views: 80000,
      likes: 6500,
      is_promoted: 1,
      promotion_expires_at: "2099-01-01T00:00:00.000Z",
    }),
  );

  const pool = createPaginatedMockPool({ videos });
  const restorePool = installMockPool(pool);

  try {
    const req = new Request("https://facetube.online/api/ai/recommendations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preferredCategories: ["Cooking"],
        limit: 5,
      }),
    });

    const res = await handleApiRequest(req, makeProdEnv({ GEMINI_API_KEY: "" }));
    const data = await readRecommendationsJson(res);

    assert.equal(data.success, true);
    assert.equal(data.source, "fallback");
    assert.equal(data.fallbackUsed, true);
    assert.equal(pool.catalogPageQueries.length, 2);
    assert.equal(data.recommendations[0]?.id, "vid-older-fallback");
  } finally {
    restorePool();
  }
});

test("deep catalogs exceeding scan ceiling cap pagination at max pages and invoke bounded affinity fallback", async () => {
  resetAiRateLimitsForTesting();

  const totalRows = RECOMMENDATION_MAX_SCAN_PAGES * RECOMMENDATION_CATALOG_PAGE_SIZE + 120;
  const videos: Array<Record<string, unknown>> = [];
  for (let i = 0; i < totalRows; i++) {
    videos.push(makeCatalogVideo(i, { category: "Music", views: 10 }));
  }

  // Place a high-affinity Documentary video beyond the 2,000-row scan ceiling
  const deepIndex = totalRows - 5;
  videos[deepIndex] = makeCatalogVideo(deepIndex, {
    id: "vid-deep-affinity",
    category: "Documentary",
    title: "Very Deep Documentary Gem",
    views: 95000,
    likes: 7000,
    is_promoted: 1,
    promotion_expires_at: "2099-01-01T00:00:00.000Z",
  });

  const pool = createPaginatedMockPool({ videos });
  const restorePool = installMockPool(pool);

  try {
    const req = new Request("https://facetube.online/api/ai/recommendations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preferredCategories: ["Documentary"],
        limit: 6,
      }),
    });

    const res = await handleApiRequest(req, makeProdEnv({ GEMINI_API_KEY: "" }));
    const data = await readRecommendationsJson(res);

    assert.equal(data.success, true);
    assert.equal(pool.catalogPageQueries.length, RECOMMENDATION_MAX_SCAN_PAGES);
    assert.equal(pool.affinityQueries.length, 1);
    assert.ok(RECOMMENDATION_MAX_MEMORY_CANDIDATES <= 120);
    assert.equal(
      data.recommendations.some((r) => r.id === "vid-deep-affinity"),
      true,
    );
  } finally {
    restorePool();
  }
});

test("normalizeRecommendationMediaUrl converts relative paths, preserves trusted HTTPS URLs, and rejects unsafe or untrusted URLs", () => {
  const prodEnv = makeProdEnv();
  const prodReq = new Request("https://facetube.online/api/ai/recommendations");

  // 1. Valid relative paths resolve to default configured production API origin
  assert.equal(
    normalizeRecommendationMediaUrl("/uploads/videos/demo.mp4", "video", prodReq, prodEnv, true),
    "https://api.facetube.online/uploads/videos/demo.mp4",
  );
  assert.equal(
    normalizeRecommendationMediaUrl(
      "uploads/thumbs/thumb.jpg",
      "thumbnail",
      prodReq,
      prodEnv,
      true,
    ),
    "https://api.facetube.online/uploads/thumbs/thumb.jpg",
  );

  // 2. Respects configured VITE_API_BASE_URL / VITE_MEDIA_BASE_URL / FACETUBE_API_BASE_URL without inventing origins
  const customEnv = makeProdEnv({ VITE_API_BASE_URL: "https://media.example.org/api" });
  assert.equal(
    normalizeRecommendationMediaUrl(
      "/uploads/videos/custom.mp4",
      "video",
      prodReq,
      customEnv,
      true,
    ),
    "https://media.example.org/uploads/videos/custom.mp4",
  );
  assert.equal(
    normalizeRecommendationMediaUrl(
      "https://media.example.org/uploads/thumbs/custom.jpg",
      "thumbnail",
      prodReq,
      customEnv,
      true,
    ),
    "https://media.example.org/uploads/thumbs/custom.jpg",
  );

  // 3. Non-production local dev fallback uses request origin when no media env base is configured
  const devReq = new Request("http://127.0.0.1:3000/api/ai/recommendations");
  const devEnv = { NODE_ENV: "development" };
  assert.equal(
    normalizeRecommendationMediaUrl("/uploads/videos/local.mp4", "video", devReq, devEnv, false),
    "http://127.0.0.1:3000/uploads/videos/local.mp4",
  );

  // 4. Preserves valid HTTPS URLs on trusted application/catalog origins
  assert.equal(
    normalizeRecommendationMediaUrl(
      "https://api.facetube.online/uploads/videos/ok.mp4",
      "video",
      prodReq,
      prodEnv,
      true,
    ),
    "https://api.facetube.online/uploads/videos/ok.mp4",
  );
  assert.equal(
    normalizeRecommendationMediaUrl(
      "https://images.unsplash.com/photo-12345?w=800",
      "thumbnail",
      prodReq,
      prodEnv,
      true,
    ),
    "https://images.unsplash.com/photo-12345?w=800",
  );
  assert.equal(
    normalizeRecommendationMediaUrl(
      "https://vjs.zencdn.net/v/oceans.mp4",
      "video",
      prodReq,
      prodEnv,
      true,
    ),
    "https://vjs.zencdn.net/v/oceans.mp4",
  );

  // 5. Rejects unsafe schemes, credentials, protocol-relative URLs, path traversal, internal/metadata IPs, and untrusted origins
  const rejectedInputs = [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "data:image/svg+xml,<svg onload=alert(1)>",
    "blob:https://facetube.online/123",
    "file:///etc/passwd",
    "ftp://api.facetube.online/uploads/a.mp4",
    "//evil.example.com/payload.mp4",
    "https://user:pass@api.facetube.online/uploads/a.mp4",
    "/uploads/../../etc/passwd",
    "/uploads/%2e%2e/secret.mp4",
    "uploads\\videos\\win.mp4",
    "http://api.facetube.online/uploads/insecure.mp4",
    "http://evil.example.com/a.mp4",
    "https://127.0.0.1/uploads/a.mp4",
    "https://169.254.169.254/latest/meta-data/",
    "https://10.0.0.5/internal.mp4",
    "https://untrusted-cdn.example.net/video.mp4",
    "not a valid url with spaces",
    "undefined",
    "null",
    "",
  ];

  for (const bad of rejectedInputs) {
    assert.equal(
      normalizeRecommendationMediaUrl(bad, "video", prodReq, prodEnv, true),
      null,
      `Expected URL to be rejected: ${bad}`,
    );
  }
});

test("recommendations endpoint sanitizes unsafe/untrusted media URLs while keeping normalized safe URLs", async () => {
  resetAiRateLimitsForTesting();

  const pool = createPaginatedMockPool({
    videos: [
      makeCatalogVideo(1, {
        id: "vid-safe-relative",
        title: "Safe Relative",
        video_url: "/uploads/videos/safe.mp4",
        thumbnail_url: "uploads/thumbs/safe.jpg",
        creator_channel_logo_url: "https://api.facetube.online/uploads/logos/safe.png",
      }),
      makeCatalogVideo(2, {
        id: "vid-unsafe-media",
        title: "Unsafe Media Sanitized",
        video_url: "javascript:alert(document.domain)",
        thumbnail_url: "https://untrusted-evil.example/thumb.jpg",
        creator_channel_logo_url: "https://user:secret@api.facetube.online/logo.png",
      }),
    ],
  });
  const restorePool = installMockPool(pool);

  try {
    const req = new Request("https://facetube.online/api/ai/recommendations", {
      method: "GET",
    });
    const res = await handleApiRequest(req, makeProdEnv({ GEMINI_API_KEY: "" }));
    const data = await readRecommendationsJson(res);
    assert.equal(data.recommendations.length, 2);

    const safe = data.recommendations.find((r) => r.id === "vid-safe-relative");
    assert.ok(safe, "Expected vid-safe-relative in recommendations");
    assert.equal(safe.videoUrl, "https://api.facetube.online/uploads/videos/safe.mp4");
    assert.equal(safe.thumbnailUrl, "https://api.facetube.online/uploads/thumbs/safe.jpg");
    assert.equal(safe.channelLogoUrl, "https://api.facetube.online/uploads/logos/safe.png");

    const unsafe = data.recommendations.find((r) => r.id === "vid-unsafe-media");
    assert.ok(unsafe, "Expected vid-unsafe-media in recommendations");
    assert.equal(unsafe.videoUrl, "");
    assert.equal(unsafe.video_url, "");
    assert.equal(unsafe.thumbnailUrl, "");
    assert.equal(unsafe.thumbnail_url, "");
    assert.equal(unsafe.channelLogoUrl, null);
    assert.equal(unsafe.channel_logo_url, null);
  } finally {
    restorePool();
  }
});

test("local JSON fallback enforces fail-closed AI visibility and blocks missing, null, empty, unknown, unlisted, and private videos", async () => {
  resetAiRateLimitsForTesting();
  resetInMemoryStore();

  const prevDataDir = process.env["FACETUBE_DATA_DIR"];
  const prevDbHost = process.env["DB_HOST"];
  const prevMysqlHost = process.env["MYSQL_HOST"];
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "facetube-p24-local-"));

  const baseDate = "2026-01-15T12:00:00.000Z";
  const makeLocalStoreVideo = (id: string, visibility: unknown) => ({
    id,
    user_id: "FT100001",
    creator_name: "Local Creator",
    title: `Video ${id}`,
    description: "Local fallback visibility check",
    video_url: `/uploads/videos/${id}.mp4`,
    thumbnail_url: `/uploads/thumbs/${id}.jpg`,
    video_type: "free",
    content_type: "long",
    category: "Coding",
    duration: "03:00",
    views: 500,
    likes: 40,
    payment_status: "not_required",
    is_promoted: false,
    ...(visibility !== Symbol.for("omit") ? { visibility } : {}),
    created_at: baseDate,
    updated_at: baseDate,
  });

  try {
    const storePayload = {
      users: [],
      sessions: {},
      videos: [
        makeLocalStoreVideo("vid-local-public", "public"),
        makeLocalStoreVideo("vid-local-public-ws", "  PUBLIC  "),
        makeLocalStoreVideo("vid-local-private", "private"),
        makeLocalStoreVideo("vid-local-unlisted", "unlisted"),
        makeLocalStoreVideo("vid-local-empty", ""),
        makeLocalStoreVideo("vid-local-whitespace", "   "),
        makeLocalStoreVideo("vid-local-null", null),
        makeLocalStoreVideo("vid-local-unknown", "internal_draft"),
        makeLocalStoreVideo("vid-local-missing", Symbol.for("omit")),
      ],
      comments: [],
      images: [],
      payoutBatches: [],
      personalKyc: {},
      bankKyc: {},
      kycAuditLog: [],
      certificates: {},
      wallets: {},
      walletTransactions: [],
      categories: [],
      adsenseStatements: [],
      admobStatements: [],
      affiliateNetworks: [],
      affiliateClicks: [],
      affiliateConversions: [],
      affiliateAuditLog: [],
      liveStreams: [],
      liveChatMessages: [],
      subscriberPlans: [],
      userSubscriptions: [],
      paymentOrders: [],
      subscriptionRefundRequests: [],
      channelSubscriptions: [],
    };

    await fs.promises.writeFile(
      path.join(tmpDir, "facetube_store.json"),
      JSON.stringify(storePayload, null, 2),
      "utf-8",
    );

    process.env["FACETUBE_DATA_DIR"] = tmpDir;
    delete process.env["DB_HOST"];
    delete process.env["MYSQL_HOST"];
    setMysqlPoolForTesting(null);
    resetInMemoryStore();

    const req = new Request("http://127.0.0.1:3000/api/ai/recommendations?limit=24", {
      method: "GET",
    });
    const res = await handleApiRequest(req, { NODE_ENV: "development" });
    const data = await readRecommendationsJson(res);

    assert.equal(data.success, true);
    const ids = data.recommendations.map((r) => r.id).sort();
    assert.deepEqual(ids, ["vid-local-public", "vid-local-public-ws"]);
  } finally {
    resetInMemoryStore();
    if (prevDataDir === undefined) delete process.env["FACETUBE_DATA_DIR"];
    else process.env["FACETUBE_DATA_DIR"] = prevDataDir;
    if (prevDbHost === undefined) delete process.env["DB_HOST"];
    else process.env["DB_HOST"] = prevDbHost;
    if (prevMysqlHost === undefined) delete process.env["MYSQL_HOST"];
    else process.env["MYSQL_HOST"] = prevMysqlHost;
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
    resetAiRateLimitsForTesting();
  }
});
