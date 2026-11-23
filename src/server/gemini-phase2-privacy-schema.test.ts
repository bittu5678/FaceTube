import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { handleApiRequest, resetAiSchemaCacheForTesting } from "./api-handler.ts";
import { setMysqlPoolForTesting } from "./mysql.ts";
import {
  resetAiRateLimitsForTesting,
  setGeminiClientForTesting,
  type GeminiInteractionsClientLike,
} from "./gemini-service.ts";

const OWNER_TOKEN = "p22-owner-token";
const OTHER_USER_TOKEN = "p22-other-user-token";
const ADMIN_TOKEN = "p22-admin-token";
const EMPTY_ID_USER_TOKEN = "p22-empty-id-user-token";

interface SchemaConfig {
  tables?: string[];
  uploadedVideosColumns?: string[];
  throwOnSchemaCheck?: boolean;
}

function installMockPool(pool: any): () => void {
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

function makeEnv(): Record<string, string | undefined> {
  return {
    APP_ENV: "production",
    NODE_ENV: "production",
    GEMINI_API_KEY: "AIzaSyMockPrivacySchemaTestKey000111",
    GEMINI_MODEL: "gemini-4-hydrogen",
    GEMINI_TIMEOUT_MS: "5000",
  };
}

function createSchemaAwareMockPool(options?: {
  videos?: Array<Record<string, any>>;
  schema?: SchemaConfig;
  likesByUser?: Record<string, string[]>;
}) {
  const schemaTables = options?.schema?.tables ?? ["uploaded_videos", "video_likes"];
  const uploadedVideosCols = options?.schema?.uploadedVideosColumns ?? [
    "is_blocked",
    "visibility",
    "likes",
    "views",
  ];
  const videos = options?.videos ?? [];
  const executedQueries: string[] = [];

  const pool = {
    executedQueries,
    schemaQueryCount: 0,
    videoQueryCount: 0,
    videoLikesQueryCount: 0,
    async query(sql: string, params: any[] = []) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      executedQueries.push(normalized);

      if (normalized.includes("FROM INFORMATION_SCHEMA.TABLES")) {
        pool.schemaQueryCount++;
        if (options?.schema?.throwOnSchemaCheck) {
          throw new Error("ER_TABLEACCESS_DENIED_ERROR: schema access denied at /var/db/secret");
        }
        return [schemaTables.map((t) => ({ TABLE_NAME: t }))];
      }

      if (normalized.includes("FROM INFORMATION_SCHEMA.COLUMNS")) {
        pool.schemaQueryCount++;
        if (options?.schema?.throwOnSchemaCheck) {
          throw new Error("ER_TABLEACCESS_DENIED_ERROR: schema access denied at /var/db/secret");
        }
        return [
          uploadedVideosCols.map((c) => ({
            TABLE_NAME: "uploaded_videos",
            COLUMN_NAME: c,
          })),
        ];
      }

      if (normalized.includes("FROM sessions s") && normalized.includes("INNER JOIN users u")) {
        const tok = String(params[0] || "");
        if (tok === OWNER_TOKEN) {
          return [
            [
              {
                id: "usr-owner",
                user_id: "FT100001",
                name: "Video Owner",
                mobile: "9999900001",
                email: "owner@example.com",
                role: "user",
                channel_name: "Owner Studio",
              },
            ],
          ];
        }
        if (tok === OTHER_USER_TOKEN) {
          return [
            [
              {
                id: "usr-other",
                user_id: "FT100002",
                name: "Other Viewer",
                mobile: "9999900002",
                email: "other@example.com",
                role: "user",
                channel_name: "Other Channel",
              },
            ],
          ];
        }
        if (tok === ADMIN_TOKEN) {
          return [
            [
              {
                id: "usr-admin",
                user_id: "FT102857",
                name: "Admin User",
                mobile: "9999900000",
                email: "admin@example.com",
                role: "admin",
                channel_name: "Admin",
              },
            ],
          ];
        }
        if (tok === EMPTY_ID_USER_TOKEN) {
          return [
            [
              {
                id: "",
                user_id: "",
                name: "Corrupt Session User",
                mobile: "000",
                email: "corrupt@example.com",
                role: "user",
              },
            ],
          ];
        }
        return [[]];
      }

      if (normalized.includes("FROM uploaded_videos") && normalized.includes("WHERE id = ?")) {
        pool.videoQueryCount++;
        const id = String(params[0] || "");
        const found = videos.find((v) => v["id"] === id);
        return [found ? [found] : []];
      }

      if (normalized.includes("FROM uploaded_videos v")) {
        pool.videoQueryCount++;
        const hasLikes = uploadedVideosCols.includes("likes");
        const hasViews = uploadedVideosCols.includes("views");
        const eligible = videos
          .filter(
            (v) =>
              !v["is_blocked"] &&
              v["visibility"] === "public" &&
              ((v["video_type"] === "free" &&
                (v["payment_status"] === "not_required" || v["payment_status"] === "paid")) ||
                (v["video_type"] === "premium" && v["payment_status"] === "paid")),
          )
          .map((v) => ({
            ...v,
            likes: hasLikes ? (v["likes"] ?? 0) : 0,
            views: hasViews ? (v["views"] ?? 0) : 0,
          }));
        return [eligible];
      }

      if (normalized.includes("FROM video_likes")) {
        pool.videoLikesQueryCount++;
        const uid = String(params[0] || "").toUpperCase();
        const liked = options?.likesByUser?.[uid] || [];
        return [liked.map((video_id) => ({ video_id }))];
      }

      return [[]];
    },
  };

  return pool;
}

test("Phase 2.2 Task 1: Video Summary authorization blocks unlisted & private videos even with spoofed aiConsent, allows owner/admin, and fails closed", async () => {
  resetAiRateLimitsForTesting();
  const uploadsVideoDir = path.resolve(process.cwd(), "uploads", "videos");
  await fs.promises.mkdir(uploadsVideoDir, { recursive: true });
  const testFileName = `p22-privacy-${Date.now()}.mp4`;
  const testFilePath = path.join(uploadsVideoDir, testFileName);
  await fs.promises.writeFile(testFilePath, Buffer.from("00000018ftypmp42privacytest"));

  const mockClient: GeminiInteractionsClientLike = {
    interactions: {
      async create() {
        return {
          id: "int-p22-sum",
          status: "completed",
          output_text: JSON.stringify({
            shortSummary: "Verified video summary content.",
            keyPoints: ["Point one", "Point two"],
          }),
        };
      },
    },
  };
  setGeminiClientForTesting(mockClient);

  const videos = [
    {
      id: "vid-public",
      user_id: "FT100001",
      title: "Public Launch Video",
      description: "Public desc",
      video_url: `/uploads/videos/${testFileName}`,
      video_type: "free",
      payment_status: "not_required",
      visibility: "public",
      is_blocked: 0,
    },
    {
      id: "vid-unlisted",
      user_id: "FT100001",
      title: "Secret Unlisted Demo Title",
      description: "Internal unlisted notes",
      video_url: `/uploads/videos/${testFileName}`,
      video_type: "free",
      payment_status: "not_required",
      visibility: "unlisted",
      is_blocked: 0,
    },
    {
      id: "vid-private",
      user_id: "FT100001",
      title: "Confidential Private Strategy",
      description: "Top secret private notes",
      video_url: `/uploads/videos/${testFileName}`,
      video_type: "free",
      payment_status: "not_required",
      visibility: "private",
      is_blocked: 0,
    },
    {
      id: "vid-unknown-vis",
      user_id: "FT100001",
      title: "Unknown Visibility Video",
      description: "Should fail closed",
      video_url: `/uploads/videos/${testFileName}`,
      video_type: "free",
      payment_status: "not_required",
      visibility: "",
      is_blocked: 0,
    },
    {
      id: "vid-missing-owner",
      user_id: "",
      title: "Orphan Private Video",
      description: "Missing user_id should fail closed for non-admin",
      video_url: `/uploads/videos/${testFileName}`,
      video_type: "free",
      payment_status: "not_required",
      visibility: "private",
      is_blocked: 0,
    },
    {
      id: "vid-unlisted-blocked",
      user_id: "FT100001",
      title: "Blocked Unlisted Video",
      description: "Moderated",
      video_url: `/uploads/videos/${testFileName}`,
      video_type: "free",
      payment_status: "not_required",
      visibility: "unlisted",
      is_blocked: 1,
    },
  ];

  const pool = createSchemaAwareMockPool({ videos });
  const restorePool = installMockPool(pool);

  const postSummary = (videoId: string, opts?: { token?: string; aiConsent?: boolean }) =>
    handleApiRequest(
      new Request("https://facetube.online/api/ai/video-summary", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(opts?.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        },
        body: JSON.stringify({
          videoId,
          ...(opts?.aiConsent !== undefined ? { aiConsent: opts.aiConsent } : {}),
        }),
      }),
      makeEnv(),
    );

  try {
    // 1. Public video remains summarizable under existing rules
    const pubAnon = await postSummary("vid-public");
    assert.equal(pubAnon?.status, 200);

    // 2. Unlisted video: unauthenticated + spoofed aiConsent: true -> 401, no private/unlisted metadata leaked
    const unlAnon = await postSummary("vid-unlisted", { aiConsent: true });
    assert.equal(unlAnon?.status, 401);
    const unlAnonText = await unlAnon!.text();
    assert.equal(/unlisted|private|Secret Unlisted/i.test(unlAnonText), false);

    // 3. Unlisted video: authenticated non-owner + spoofed aiConsent: true -> 403, no metadata leaked
    const unlOther = await postSummary("vid-unlisted", {
      token: OTHER_USER_TOKEN,
      aiConsent: true,
    });
    assert.equal(unlOther?.status, 403);
    const unlOtherText = await unlOther!.text();
    assert.equal(/unlisted|private|Secret Unlisted/i.test(unlOtherText), false);

    // 4. Unlisted video: owner without consent -> 400 AI_CONSENT_REQUIRED; owner with consent -> 200
    const unlOwnerNoConsent = await postSummary("vid-unlisted", {
      token: OWNER_TOKEN,
      aiConsent: false,
    });
    assert.equal(unlOwnerNoConsent?.status, 400);
    assert.equal(((await unlOwnerNoConsent!.json()) as any).code, "AI_CONSENT_REQUIRED");

    const unlOwnerOk = await postSummary("vid-unlisted", {
      token: OWNER_TOKEN,
      aiConsent: true,
    });
    assert.equal(unlOwnerOk?.status, 200);

    // 5. Unlisted video: authorized admin with consent -> 200
    const unlAdminOk = await postSummary("vid-unlisted", {
      token: ADMIN_TOKEN,
      aiConsent: true,
    });
    assert.equal(unlAdminOk?.status, 200);

    // 6. Private video: unauthenticated & non-owner with spoofed aiConsent: true -> 401/403, no "private" or title leaked
    const privAnon = await postSummary("vid-private", { aiConsent: true });
    assert.equal(privAnon?.status, 401);
    assert.equal(/private|Confidential/i.test(await privAnon!.text()), false);

    const privOther = await postSummary("vid-private", {
      token: OTHER_USER_TOKEN,
      aiConsent: true,
    });
    assert.equal(privOther?.status, 403);
    assert.equal(/private|Confidential/i.test(await privOther!.text()), false);

    // 7. Private video: owner & admin allowed with consent
    const privOwnerOk = await postSummary("vid-private", {
      token: OWNER_TOKEN,
      aiConsent: true,
    });
    assert.equal(privOwnerOk?.status, 200);

    const privAdminOk = await postSummary("vid-private", {
      token: ADMIN_TOKEN,
      aiConsent: true,
    });
    assert.equal(privAdminOk?.status, 200);

    // 8. Empty/unknown visibility fails closed (not treated as public)
    const unknownVisOther = await postSummary("vid-unknown-vis", {
      token: OTHER_USER_TOKEN,
      aiConsent: true,
    });
    assert.equal(unknownVisOther?.status, 403);

    // 9. Missing video user_id fails closed even if user session somehow has empty id
    const missingOwnerAttempt = await postSummary("vid-missing-owner", {
      token: EMPTY_ID_USER_TOKEN,
      aiConsent: true,
    });
    assert.equal(missingOwnerAttempt?.status, 403);

    // 10. Blocked unlisted video: non-owner gets generic 403 without leaking blocked/unlisted status; owner gets blocked 403
    const blockedUnlOther = await postSummary("vid-unlisted-blocked", {
      token: OTHER_USER_TOKEN,
      aiConsent: true,
    });
    assert.equal(blockedUnlOther?.status, 403);
    const blockedUnlOtherText = await blockedUnlOther!.text();
    assert.equal(/blocked|unlisted|Blocked Unlisted/i.test(blockedUnlOtherText), false);

    const blockedUnlOwner = await postSummary("vid-unlisted-blocked", {
      token: OWNER_TOKEN,
      aiConsent: true,
    });
    assert.equal(blockedUnlOwner?.status, 403);
  } finally {
    restorePool();
    setGeminiClientForTesting(null);
    resetAiRateLimitsForTesting();
    await fs.promises.rm(testFilePath, { force: true });
  }
});

test("Phase 2.2 Task 2: Missing required security columns/tables fail closed with 503 across AI endpoints", async () => {
  resetAiRateLimitsForTesting();
  setGeminiClientForTesting({
    interactions: {
      async create() {
        return { output_text: "{}" };
      },
    },
  });

  const missingSchemas: Array<{ label: string; schema: SchemaConfig }> = [
    {
      label: "missing uploaded_videos.is_blocked",
      schema: {
        tables: ["uploaded_videos", "video_likes"],
        uploadedVideosColumns: ["visibility", "likes", "views"],
      },
    },
    {
      label: "missing uploaded_videos.visibility",
      schema: {
        tables: ["uploaded_videos", "video_likes"],
        uploadedVideosColumns: ["is_blocked", "likes", "views"],
      },
    },
    {
      label: "missing uploaded_videos table",
      schema: {
        tables: ["video_likes"],
        uploadedVideosColumns: [],
      },
    },
    {
      label: "INFORMATION_SCHEMA query failure",
      schema: {
        throwOnSchemaCheck: true,
      },
    },
  ];

  const origConsoleError = console.error;
  console.error = () => {};
  try {
    for (const item of missingSchemas) {
      const pool = createSchemaAwareMockPool({
        schema: item.schema,
        videos: [
          {
            id: "vid-1",
            user_id: "FT100001",
            title: "Should Never Be Read",
            video_url: "/uploads/videos/any.mp4",
            video_type: "free",
            payment_status: "not_required",
            visibility: "public",
            is_blocked: 0,
          },
        ],
      });
      const restore = installMockPool(pool);
      try {
        // 1. /api/ai/video-summary -> 503
        const sumRes = await handleApiRequest(
          new Request("https://facetube.online/api/ai/video-summary", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${OWNER_TOKEN}`,
            },
            body: JSON.stringify({ videoId: "vid-1", aiConsent: true }),
          }),
          makeEnv(),
        );
        assert.equal(sumRes?.status, 503, `${item.label}: video-summary must return 503`);
        const sumJson = (await sumRes!.json()) as any;
        assert.equal(sumJson.code, "AI_SCHEMA_UNAVAILABLE");
        assert.equal(/ER_|SELECT|uploaded_videos/i.test(JSON.stringify(sumJson)), false);

        // 2. /api/ai/recommendations -> 503
        const recRes = await handleApiRequest(
          new Request("https://facetube.online/api/ai/recommendations", {
            method: "GET",
          }),
          makeEnv(),
        );
        assert.equal(recRes?.status, 503, `${item.label}: recommendations must return 503`);
        assert.equal(((await recRes!.json()) as any).code, "AI_SCHEMA_UNAVAILABLE");

        // 3. /api/ai/video-metadata (with videoId) -> 503
        const metaRes = await handleApiRequest(
          new Request("https://facetube.online/api/ai/video-metadata", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${OWNER_TOKEN}`,
            },
            body: JSON.stringify({ videoId: "vid-1", titleDraft: "Test" }),
          }),
          makeEnv(),
        );
        assert.equal(metaRes?.status, 503, `${item.label}: video-metadata must return 503`);
        assert.equal(((await metaRes!.json()) as any).code, "AI_SCHEMA_UNAVAILABLE");

        // Must never execute queries against uploaded_videos when required schema check fails
        assert.equal(pool.videoQueryCount, 0, `${item.label}: must not query uploaded_videos`);
      } finally {
        restore();
      }
    }
  } finally {
    console.error = origConsoleError;
    setGeminiClientForTesting(null);
    resetAiRateLimitsForTesting();
  }
});

test("Phase 2.2 Task 2: Optional likes/views/video_likes absence degrades safely and schema checks are cached per pool", async () => {
  resetAiRateLimitsForTesting();
  setGeminiClientForTesting({
    interactions: {
      async create() {
        return {
          output_text: JSON.stringify({
            recommendations: [{ id: "vid-public-1", reason: "Trending coding video" }],
          }),
        };
      },
    },
  });

  // Optional columns `likes`, `views`, and optional table `video_likes` all missing,
  // while required security columns `is_blocked` and `visibility` exist.
  const pool = createSchemaAwareMockPool({
    schema: {
      tables: ["uploaded_videos"],
      uploadedVideosColumns: ["is_blocked", "visibility"],
    },
    videos: [
      {
        id: "vid-public-1",
        user_id: "FT100001",
        creator_name: "Owner Studio",
        title: "Safe Public Video",
        description: "Desc",
        video_url: "/uploads/videos/safe.mp4",
        thumbnail_url: "",
        video_type: "free",
        content_type: "long",
        category: "Coding",
        duration: "05:00",
        payment_status: "not_required",
        is_promoted: 0,
        visibility: "public",
        is_blocked: 0,
      },
    ],
  });
  const restore = installMockPool(pool);

  try {
    const res1 = await handleApiRequest(
      new Request("https://facetube.online/api/ai/recommendations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OWNER_TOKEN}`,
        },
        body: JSON.stringify({ limit: 5 }),
      }),
      makeEnv(),
    );
    assert.equal(res1?.status, 200);
    const json1 = (await res1!.json()) as any;
    assert.equal(json1.success, true);
    assert.equal(json1.recommendations.length, 1);
    assert.equal(json1.recommendations[0].likes, 0);
    assert.equal(json1.recommendations[0].views, 0);

    // Must not attempt querying absent `video_likes` table
    assert.equal(pool.videoLikesQueryCount, 0);
    // Schema check ran 2 queries once (TABLES + COLUMNS)
    const initialSchemaQueries = pool.schemaQueryCount;
    assert.equal(initialSchemaQueries, 2);
    // Verify the SELECT SQL itself replaced missing v.likes / v.views with 0 AS likes / 0 AS views
    const recSql = pool.executedQueries.find((q) => q.includes("FROM uploaded_videos v"));
    assert.ok(recSql);
    assert.match(recSql, /\b0 AS views\b/);
    assert.match(recSql, /\b0 AS likes\b/);

    // Second request on the same pool must reuse cached schema without extra INFORMATION_SCHEMA queries
    const res2 = await handleApiRequest(
      new Request("https://facetube.online/api/ai/recommendations", {
        method: "GET",
      }),
      makeEnv(),
    );
    assert.equal(res2?.status, 200);
    assert.equal(pool.schemaQueryCount, initialSchemaQueries);
  } finally {
    restore();
    setGeminiClientForTesting(null);
    resetAiRateLimitsForTesting();
  }
});
