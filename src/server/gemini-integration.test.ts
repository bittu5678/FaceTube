import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { handleApiRequest } from "./api-handler.ts";
import { setMysqlPoolForTesting } from "./mysql.ts";
import {
  resetAiRateLimitsForTesting,
  setGeminiClientForTesting,
  type GeminiInteractionsClientLike,
} from "./gemini-service.ts";

const VALID_TOKEN = "test-gemini-session-token-123";
const OTHER_TOKEN = "test-gemini-other-user-token-456";
const FAKE_SECRET_KEY = "AIzaSyTestSecretKeyNeverExpose998877";

function installMockPool(pool: any): () => void {
  const prevHost = process.env["DB_HOST"];
  const prevName = process.env["DB_NAME"];
  const prevUser = process.env["DB_USER"];
  process.env["DB_HOST"] = "127.0.0.1";
  process.env["DB_NAME"] = "facetube_test";
  process.env["DB_USER"] = "facetube_test";
  setMysqlPoolForTesting(pool);

  return () => {
    setMysqlPoolForTesting(null);
    if (prevHost === undefined) delete process.env["DB_HOST"];
    else process.env["DB_HOST"] = prevHost;
    if (prevName === undefined) delete process.env["DB_NAME"];
    else process.env["DB_NAME"] = prevName;
    if (prevUser === undefined) delete process.env["DB_USER"];
    else process.env["DB_USER"] = prevUser;
  };
}

function makeBaseEnv(
  overrides?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    APP_ENV: "production",
    NODE_ENV: "production",
    GEMINI_API_KEY: FAKE_SECRET_KEY,
    GEMINI_MODEL: "gemini-4-hydrogen",
    GEMINI_TIMEOUT_MS: "5000",
    ...overrides,
  };
}

function createMockPool(options?: {
  videos?: Array<Record<string, any>>;
  likesByUser?: Record<string, string[]>;
}) {
  const videos = options?.videos || [
    {
      id: "vid-public-1",
      user_id: "FT100001",
      creator_name: "Code Studio",
      creator_channel_name: "Code Studio",
      creator_channel_logo_url: null,
      title: "React 19 Patterns",
      description: "Clean hooks and state design",
      video_url: "/uploads/videos/nonexistent-public-1.mp4",
      thumbnail_url: "/uploads/thumbs/1.jpg",
      video_type: "free",
      content_type: "long",
      category: "Coding",
      duration: "10:12",
      views: 1200,
      likes: 95,
      payment_status: "not_required",
      is_promoted: 0,
      visibility: "public",
      is_blocked: 0,
      promotion_expires_at: null,
      created_at: "2026-01-10T10:00:00.000Z",
      updated_at: "2026-01-10T10:00:00.000Z",
    },
    {
      id: "vid-public-2",
      user_id: "FT100002",
      creator_name: "Chef Priya",
      creator_channel_name: "Chef Priya",
      creator_channel_logo_url: null,
      title: "15-Min Masala Pasta",
      description: "Quick dinner recipe",
      video_url: "/uploads/videos/nonexistent-public-2.mp4",
      thumbnail_url: "/uploads/thumbs/2.jpg",
      video_type: "free",
      content_type: "short",
      category: "Cooking",
      duration: "0:55",
      views: 4200,
      likes: 340,
      payment_status: "not_required",
      is_promoted: 1,
      visibility: "public",
      is_blocked: 0,
      promotion_expires_at: "2099-01-01T00:00:00.000Z",
      created_at: "2026-01-11T10:00:00.000Z",
      updated_at: "2026-01-11T10:00:00.000Z",
    },
    {
      id: "vid-private-1",
      user_id: "FT100001",
      creator_name: "Code Studio",
      title: "Private Draft",
      description: "Internal draft",
      video_url: "/uploads/videos/private-draft.mp4",
      thumbnail_url: "",
      video_type: "free",
      content_type: "long",
      category: "Coding",
      duration: "05:00",
      views: 2,
      likes: 0,
      payment_status: "not_required",
      is_promoted: 0,
      visibility: "private",
      is_blocked: 0,
    },
    {
      id: "vid-unpaid-sponsor-1",
      user_id: "FT100001",
      creator_name: "Code Studio",
      title: "Unpaid Sponsor Video",
      description: "Awaiting checkout",
      video_url: "/uploads/videos/unpaid-sponsor.mp4",
      thumbnail_url: "",
      video_type: "premium",
      content_type: "long",
      category: "Business",
      duration: "08:00",
      views: 0,
      likes: 0,
      payment_status: "pending",
      is_promoted: 0,
      visibility: "public",
      is_blocked: 0,
    },
    {
      id: "vid-blocked-1",
      user_id: "FT100002",
      creator_name: "Chef Priya",
      title: "Moderated Video",
      description: "Blocked",
      video_url: "/uploads/videos/blocked.mp4",
      thumbnail_url: "",
      video_type: "free",
      content_type: "long",
      category: "Cooking",
      duration: "03:00",
      views: 10,
      likes: 0,
      payment_status: "not_required",
      is_promoted: 0,
      visibility: "public",
      is_blocked: 1,
    },
  ];

  const writeCalls: string[] = [];

  const pool = {
    writeCalls,
    async query(sql: string, params: any[] = []) {
      const normalized = sql.replace(/\s+/g, " ").trim();

      if (normalized.includes("FROM sessions s") && normalized.includes("INNER JOIN users u")) {
        const tok = String(params[0] || "");
        if (tok === VALID_TOKEN) {
          return [
            [
              {
                id: "usr-1",
                user_id: "FT100001",
                name: "Creator One",
                mobile: "9999900001",
                email: "creator1@example.com",
                role: "user",
                referral_code: null,
                avatar_url: null,
                channel_logo_url: null,
                channel_name: "Code Studio",
                channel_description: null,
                created_at: "2026-01-01T00:00:00.000Z",
              },
            ],
          ];
        }
        if (tok === OTHER_TOKEN) {
          return [
            [
              {
                id: "usr-2",
                user_id: "FT100002",
                name: "Other User",
                mobile: "9999900002",
                email: "other@example.com",
                role: "user",
                referral_code: null,
                avatar_url: null,
                channel_logo_url: null,
                channel_name: "Chef Priya",
                channel_description: null,
                created_at: "2026-01-01T00:00:00.000Z",
              },
            ],
          ];
        }
        return [[]];
      }

      if (normalized.includes("FROM uploaded_videos") && normalized.includes("WHERE id = ?")) {
        const id = String(params[0] || "");
        const match = videos.find((v) => v["id"] === id);
        return [match ? [match] : []];
      }

      if (
        normalized.includes("FROM uploaded_videos v") &&
        normalized.includes("COALESCE(v.is_blocked, 0) = 0")
      ) {
        const eligible = videos.filter(
          (v) =>
            !v["is_blocked"] &&
            (v["visibility"] || "public") === "public" &&
            ((v["video_type"] === "free" &&
              (v["payment_status"] === "not_required" || v["payment_status"] === "paid")) ||
              (v["video_type"] === "premium" && v["payment_status"] === "paid")),
        );
        return [eligible];
      }

      if (normalized.includes("FROM video_likes")) {
        const uid = String(params[0] || "").toUpperCase();
        const liked = options?.likesByUser?.[uid] || [];
        return [liked.map((video_id) => ({ video_id }))];
      }

      if (/^\s*(UPDATE|INSERT|DELETE)\b/i.test(normalized)) {
        writeCalls.push(normalized);
      }

      return [[]];
    },
  };

  return pool;
}

test("1. Missing GEMINI_API_KEY fails safely for AI endpoints and falls back for recommendations", async () => {
  resetAiRateLimitsForTesting();
  setGeminiClientForTesting(null);
  const pool = createMockPool();
  const restorePool = installMockPool(pool);

  try {
    const env = makeBaseEnv({ GEMINI_API_KEY: "" });

    const chatRes = await handleApiRequest(
      new Request("http://localhost:3000/api/ai/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${VALID_TOKEN}`,
        },
        body: JSON.stringify({ message: "How do I upload a video?" }),
      }),
      env,
    );
    assert.equal(chatRes?.status, 503);
    const chatJson = (await chatRes!.json()) as any;
    assert.equal(chatJson.success, false);
    assert.equal(chatJson.code, "AI_NOT_CONFIGURED");

    const recRes = await handleApiRequest(
      new Request("http://localhost:3000/api/ai/recommendations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 5 }),
      }),
      env,
    );
    assert.equal(recRes?.status, 200);
    const recJson = (await recRes!.json()) as any;
    assert.equal(recJson.success, true);
    assert.equal(recJson.source, "fallback");
    assert.equal(recJson.fallbackUsed, true);
    assert.equal(recJson.recommendations.length, 2);
  } finally {
    restorePool();
    setGeminiClientForTesting(null);
    resetAiRateLimitsForTesting();
  }
});

test("2. Authentication and access control block unauthorized users on chat, metadata, and private/blocked/unpaid summaries", async () => {
  resetAiRateLimitsForTesting();
  setGeminiClientForTesting(null);
  const pool = createMockPool();
  const restorePool = installMockPool(pool);

  try {
    const env = makeBaseEnv();

    // Unauthenticated chat -> 401
    const unauthChat = await handleApiRequest(
      new Request("http://localhost:3000/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Hello" }),
      }),
      env,
    );
    assert.equal(unauthChat?.status, 401);

    // Unauthenticated metadata -> 401
    const unauthMeta = await handleApiRequest(
      new Request("http://localhost:3000/api/ai/video-metadata", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ titleDraft: "Test" }),
      }),
      env,
    );
    assert.equal(unauthMeta?.status, 401);

    // Unauthenticated private video summary -> 401
    const unauthPrivSum = await handleApiRequest(
      new Request("http://localhost:3000/api/ai/video-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: "vid-private-1", aiConsent: true }),
      }),
      env,
    );
    assert.equal(unauthPrivSum?.status, 401);

    // Non-owner private video summary -> 403
    const otherPrivSum = await handleApiRequest(
      new Request("http://localhost:3000/api/ai/video-summary", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OTHER_TOKEN}`,
        },
        body: JSON.stringify({ videoId: "vid-private-1", aiConsent: true }),
      }),
      env,
    );
    assert.equal(otherPrivSum?.status, 403);

    // Non-owner unpaid Sponsor video summary -> 403
    const otherUnpaidSum = await handleApiRequest(
      new Request("http://localhost:3000/api/ai/video-summary", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OTHER_TOKEN}`,
        },
        body: JSON.stringify({ videoId: "vid-unpaid-sponsor-1", aiConsent: true }),
      }),
      env,
    );
    assert.equal(otherUnpaidSum?.status, 403);

    // Blocked video summary -> 403
    const blockedSum = await handleApiRequest(
      new Request("http://localhost:3000/api/ai/video-summary", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${VALID_TOKEN}`,
        },
        body: JSON.stringify({ videoId: "vid-blocked-1", aiConsent: true }),
      }),
      env,
    );
    assert.equal(blockedSum?.status, 403);

    // Owner private video summary without explicit aiConsent -> 400
    const ownerNoConsentSum = await handleApiRequest(
      new Request("http://localhost:3000/api/ai/video-summary", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${VALID_TOKEN}`,
        },
        body: JSON.stringify({ videoId: "vid-private-1", aiConsent: false }),
      }),
      env,
    );
    assert.equal(ownerNoConsentSum?.status, 400);
    assert.equal(((await ownerNoConsentSum!.json()) as any).code, "AI_CONSENT_REQUIRED");
  } finally {
    restorePool();
    resetAiRateLimitsForTesting();
  }
});

test("3. Video Title & Description Generator supports draft & consented video content without overwriting DB", async () => {
  resetAiRateLimitsForTesting();
  const capturedRequests: Array<Record<string, unknown>> = [];
  const mockClient: GeminiInteractionsClientLike = {
    interactions: {
      async create(params) {
        capturedRequests.push(params);
        return {
          id: "int-meta-1",
          status: "completed",
          output_text: JSON.stringify({
            title: "Build Clean React 19 Apps Faster",
            description: "Learn practical React 19 patterns for clean state and hooks.",
            tags: ["react", "typescript", "coding"],
          }),
        };
      },
    },
  };
  setGeminiClientForTesting(mockClient);
  const pool = createMockPool();
  const restorePool = installMockPool(pool);

  try {
    const env = makeBaseEnv();

    // Reject inline video bytes when aiConsent !== true
    const noConsentRes = await handleApiRequest(
      new Request("http://localhost:3000/api/ai/video-metadata", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${VALID_TOKEN}`,
        },
        body: JSON.stringify({
          titleDraft: "React tutorial",
          videoBase64: Buffer.from("fake-mp4-bytes").toString("base64"),
          videoMimeType: "video/mp4",
          aiConsent: false,
        }),
      }),
      env,
    );
    assert.equal(noConsentRes?.status, 400);

    // Valid consented video content generation
    const okRes = await handleApiRequest(
      new Request("http://localhost:3000/api/ai/video-metadata", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${VALID_TOKEN}`,
        },
        body: JSON.stringify({
          titleDraft: "React 19",
          category: "Coding",
          contentType: "long",
          fileName: "react19.mp4",
          videoBase64: Buffer.from("00000018ftypmp42").toString("base64"),
          videoMimeType: "video/mp4",
          aiConsent: true,
        }),
      }),
      env,
    );
    assert.equal(okRes?.status, 200);
    const json = (await okRes!.json()) as any;
    assert.equal(json.success, true);
    assert.equal(json.suggestions.title, "Build Clean React 19 Apps Faster");
    assert.equal(json.suggestions.analysisMode, "video_content");
    assert.equal(json.suggestions.applied, false);
    assert.deepEqual(json.suggestions.tags, ["react", "typescript", "coding"]);
    assert.equal(pool.writeCalls.length, 0);

    // Verify Gemini Interactions API was called with gemini-4-hydrogen & store: false
    assert.equal(capturedRequests.length, 1);
    assert.equal(capturedRequests[0]?.["model"], "gemini-4-hydrogen");
    assert.equal(capturedRequests[0]?.["store"], false);
    assert.ok(Array.isArray(capturedRequests[0]?.["input"]));
  } finally {
    restorePool();
    setGeminiClientForTesting(null);
    resetAiRateLimitsForTesting();
  }
});

test("4. Video Summary safely rejects unavailable/unsupported/oversized videos and summarizes accessible video bytes", async () => {
  resetAiRateLimitsForTesting();
  const uploadsVideoDir = path.resolve(process.cwd(), "uploads", "videos");
  await fs.promises.mkdir(uploadsVideoDir, { recursive: true });

  const validFileName = `test-gemini-summary-${Date.now()}.mp4`;
  const invalidExtName = `test-gemini-summary-${Date.now()}.mkv`;
  const bigFileName = `test-gemini-big-${Date.now()}.mp4`;
  const validPath = path.join(uploadsVideoDir, validFileName);
  const invalidExtPath = path.join(uploadsVideoDir, invalidExtName);
  const bigPath = path.join(uploadsVideoDir, bigFileName);

  await fs.promises.writeFile(validPath, Buffer.from("00000018ftypmp42testvideo"));
  await fs.promises.writeFile(invalidExtPath, Buffer.from("matroska-test"));
  // Sparse 16MB file without actually writing 16MB of data unnecessarily
  const bigHandle = await fs.promises.open(bigPath, "w");
  await bigHandle.truncate(16 * 1024 * 1024);
  await bigHandle.close();

  const mockClient: GeminiInteractionsClientLike = {
    interactions: {
      async create() {
        return {
          id: "int-sum-1",
          status: "completed",
          output_text: JSON.stringify({
            shortSummary: "This video demonstrates setting up React hooks cleanly.",
            keyPoints: ["Explains state initialization", "Shows cleanup pattern"],
          }),
        };
      },
    },
  };
  setGeminiClientForTesting(mockClient);

  const pool = createMockPool({
    videos: [
      {
        id: "vid-missing",
        user_id: "FT100001",
        title: "Missing File",
        video_url: "/uploads/videos/definitely-missing-file-999.mp4",
        video_type: "free",
        payment_status: "not_required",
        visibility: "public",
        is_blocked: 0,
      },
      {
        id: "vid-mkv",
        user_id: "FT100001",
        title: "Unsupported Format",
        video_url: `/uploads/videos/${invalidExtName}`,
        video_type: "free",
        payment_status: "not_required",
        visibility: "public",
        is_blocked: 0,
      },
      {
        id: "vid-big",
        user_id: "FT100001",
        title: "Huge Video",
        video_url: `/uploads/videos/${bigFileName}`,
        video_type: "free",
        payment_status: "not_required",
        visibility: "public",
        is_blocked: 0,
      },
      {
        id: "vid-valid",
        user_id: "FT100001",
        title: "Valid Clip",
        video_url: `/uploads/videos/${validFileName}`,
        video_type: "free",
        payment_status: "not_required",
        visibility: "public",
        is_blocked: 0,
      },
    ],
  });
  const restorePool = installMockPool(pool);

  try {
    const env = makeBaseEnv();

    const missingRes = await handleApiRequest(
      new Request("http://localhost:3000/api/ai/video-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: "vid-missing" }),
      }),
      env,
    );
    assert.equal(missingRes?.status, 422);
    assert.equal(((await missingRes!.json()) as any).code, "VIDEO_UNAVAILABLE");

    const mkvRes = await handleApiRequest(
      new Request("http://localhost:3000/api/ai/video-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: "vid-mkv" }),
      }),
      env,
    );
    assert.equal(mkvRes?.status, 422);
    assert.equal(((await mkvRes!.json()) as any).code, "VIDEO_UNSUPPORTED_FORMAT");

    const bigRes = await handleApiRequest(
      new Request("http://localhost:3000/api/ai/video-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: "vid-big" }),
      }),
      env,
    );
    assert.equal(bigRes?.status, 422);
    assert.equal(((await bigRes!.json()) as any).code, "VIDEO_TOO_LARGE");

    const okRes = await handleApiRequest(
      new Request("http://localhost:3000/api/ai/video-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: "vid-valid" }),
      }),
      env,
    );
    assert.equal(okRes?.status, 200);
    const okJson = (await okRes!.json()) as any;
    assert.equal(okJson.success, true);
    assert.equal(okJson.summary.analysisMode, "video_content");
    assert.equal(okJson.summary.keyPoints.length, 2);
  } finally {
    restorePool();
    setGeminiClientForTesting(null);
    resetAiRateLimitsForTesting();
    await fs.promises.rm(validPath, { force: true });
    await fs.promises.rm(invalidExtPath, { force: true });
    await fs.promises.rm(bigPath, { force: true });
  }
});

test("5. Chatbot handles multi-turn history safely, blocks invalid input, enforces rate limits, and never leaks GEMINI_API_KEY", async () => {
  resetAiRateLimitsForTesting();
  let lastPayload: Record<string, unknown> | null = null;
  const mockClient: GeminiInteractionsClientLike = {
    interactions: {
      async create(params) {
        lastPayload = params;
        if (String(JSON.stringify(params["input"])).includes("TRIGGER_SECRET_ERR")) {
          throw new Error(`Upstream failed for key ${FAKE_SECRET_KEY}`);
        }
        if (String(JSON.stringify(params["input"])).includes("TRIGGER_429")) {
          const e: any = new Error("Rate limit exceeded");
          e.status = 429;
          throw e;
        }
        return {
          id: "int-chat-1",
          status: "completed",
          output_text: "Go to Upload > Free Video Upload to publish a video with ₹0 fee.",
        };
      },
    },
  };
  setGeminiClientForTesting(mockClient);
  const pool = createMockPool();
  const restorePool = installMockPool(pool);

  try {
    const env = makeBaseEnv();

    // Empty message -> 400
    const emptyRes = await handleApiRequest(
      new Request("http://localhost:3000/api/ai/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${VALID_TOKEN}`,
        },
        body: JSON.stringify({ message: "   " }),
      }),
      env,
    );
    assert.equal(emptyRes?.status, 400);

    // Valid multi-turn chat -> 200, no PII leaked into system instruction
    const chatRes = await handleApiRequest(
      new Request("http://localhost:3000/api/ai/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${VALID_TOKEN}`,
        },
        body: JSON.stringify({
          message: "How do I upload for free?",
          history: [
            { role: "user", text: "Hi" },
            { role: "assistant", text: "Hello! How can I help with FaceTube?" },
          ],
        }),
      }),
      env,
    );
    assert.equal(chatRes?.status, 200);
    const chatJson = (await chatRes!.json()) as any;
    assert.equal(chatJson.success, true);
    assert.equal(chatJson.informationalOnly, true);
    const sysInst = String(lastPayload?.["system_instruction"] || "");
    assert.equal(sysInst.includes("creator1@example.com"), false);
    assert.equal(sysInst.includes("9999900001"), false);
    assert.equal(sysInst.includes(FAKE_SECRET_KEY), false);

    // Error redaction check -> GEMINI_API_KEY never exposed
    const leakTestRes = await handleApiRequest(
      new Request("http://localhost:3000/api/ai/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${VALID_TOKEN}`,
        },
        body: JSON.stringify({ message: "TRIGGER_SECRET_ERR" }),
      }),
      env,
    );
    const leakText = await leakTestRes!.text();
    assert.equal(leakText.includes(FAKE_SECRET_KEY), false);

    // Upstream 429 mapped cleanly
    const upstream429Res = await handleApiRequest(
      new Request("http://localhost:3000/api/ai/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${VALID_TOKEN}`,
        },
        body: JSON.stringify({ message: "TRIGGER_429" }),
      }),
      env,
    );
    assert.equal(upstream429Res?.status, 429);

    // Per-user rate limit check (after 30 calls within window, 31st returns 429)
    let hitRateLimit = false;
    for (let i = 0; i < 32; i++) {
      const r = await handleApiRequest(
        new Request("http://localhost:3000/api/ai/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${VALID_TOKEN}`,
          },
          body: JSON.stringify({ message: `Ping ${i}` }),
        }),
        env,
      );
      if (r?.status === 429) {
        hitRateLimit = true;
        assert.ok(r.headers.get("Retry-After"));
        break;
      }
    }
    assert.equal(hitRateLimit, true);
  } finally {
    restorePool();
    setGeminiClientForTesting(null);
    resetAiRateLimitsForTesting();
  }
});

test("6. Timeout handling returns 504 without leaking secrets", async () => {
  resetAiRateLimitsForTesting();
  const slowClient: GeminiInteractionsClientLike = {
    interactions: {
      async create() {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { output_text: "too late" };
      },
    },
  };
  setGeminiClientForTesting(slowClient);
  const pool = createMockPool();
  const restorePool = installMockPool(pool);

  try {
    const { runFaceTubeChatbotTurn } = await import("./gemini-service.ts");
    const abortClient: GeminiInteractionsClientLike = {
      interactions: {
        async create() {
          throw new Error("Request aborted due to upstream timeout");
        },
      },
    };
    setGeminiClientForTesting(abortClient);
    await assert.rejects(
      () =>
        runFaceTubeChatbotTurn({
          env: makeBaseEnv(),
          message: "Hello",
          userContext: { displayName: "Creator", role: "user" },
        }),
      (err: any) => err?.status === 504 && err?.code === "AI_TIMEOUT",
    );
  } finally {
    restorePool();
    setGeminiClientForTesting(null);
    resetAiRateLimitsForTesting();
  }
});

test("7. Recommendations filter out blocked/private/unpaid videos and drop fabricated IDs", async () => {
  resetAiRateLimitsForTesting();
  const mockClient: GeminiInteractionsClientLike = {
    interactions: {
      async create() {
        return {
          id: "int-rec-1",
          status: "completed",
          output_text: JSON.stringify({
            recommendations: [
              { id: "vid-fabricated-999", reason: "Fake video ID" },
              { id: "vid-private-1", reason: "Should not be selectable" },
              { id: "vid-public-1", reason: "Matches Coding videos you liked" },
              { id: "vid-public-2", reason: "Trending in Cooking" },
            ],
          }),
        };
      },
    },
  };
  setGeminiClientForTesting(mockClient);
  const pool = createMockPool({
    likesByUser: { FT100001: ["vid-public-1"] },
  });
  const restorePool = installMockPool(pool);

  try {
    const res = await handleApiRequest(
      new Request("http://localhost:3000/api/ai/recommendations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${VALID_TOKEN}`,
        },
        body: JSON.stringify({
          watchedVideoIds: ["vid-public-1", "vid-nonexistent-999"],
          limit: 10,
        }),
      }),
      makeBaseEnv(),
    );
    assert.equal(res?.status, 200);
    const json = (await res!.json()) as any;
    assert.equal(json.success, true);
    assert.equal(json.source, "gemini");
    const ids = json.recommendations.map((v: any) => v.id);
    assert.deepEqual(ids, ["vid-public-1", "vid-public-2"]);
    assert.equal(ids.includes("vid-fabricated-999"), false);
    assert.equal(ids.includes("vid-private-1"), false);
    assert.equal(ids.includes("vid-blocked-1"), false);
    assert.equal(ids.includes("vid-unpaid-sponsor-1"), false);
  } finally {
    restorePool();
    setGeminiClientForTesting(null);
    resetAiRateLimitsForTesting();
  }
});

test("8. Client source files never reference GEMINI_API_KEY or @google/genai", async () => {
  const clientDirs = [
    path.resolve(process.cwd(), "src/components"),
    path.resolve(process.cwd(), "src/routes"),
    path.resolve(process.cwd(), "src/lib"),
  ];
  for (const dir of clientDirs) {
    const entries = await fs.promises.readdir(dir, { recursive: true });
    for (const rel of entries) {
      const full = path.join(dir, String(rel));
      const stat = await fs.promises.stat(full);
      if (!stat.isFile()) continue;
      const content = await fs.promises.readFile(full, "utf8");
      assert.equal(
        content.includes("GEMINI_API_KEY"),
        false,
        `Client file ${full} must never reference GEMINI_API_KEY`,
      );
      assert.equal(
        content.includes("@google/genai"),
        false,
        `Client file ${full} must never import @google/genai`,
      );
    }
  }

  // Verify data/facetube_store.json SHA-256 baseline was never modified
  const storeBytes = await fs.promises.readFile(
    path.resolve(process.cwd(), "data/facetube_store.json"),
  );
  const hash = crypto.createHash("sha256").update(storeBytes).digest("hex");
  assert.equal(hash, "3ba92d2829c327131f47d043acf480fcc902c4e33309bf25e24234341458d15c");
});
