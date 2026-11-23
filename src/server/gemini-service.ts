import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { GoogleGenAI } from "@google/genai";

export const DEFAULT_GEMINI_MODEL = "gemini-4-hydrogen";
export const DEFAULT_GEMINI_TIMEOUT_MS = 20_000;
export const MAX_INLINE_VIDEO_METADATA_BYTES = 12 * 1024 * 1024; // 12 MB
export const MAX_INLINE_VIDEO_SUMMARY_BYTES = 15 * 1024 * 1024; // 15 MB

const PROHIBITED_DEPRECATED_MODEL_PREFIXES = [
  "gemini-1.0",
  "gemini-1.5",
  "gemini-2.0",
  "gemini-2.5",
  "gemini-pro",
];

const SUPPORTED_GEMINI_VIDEO_MIMES = new Set([
  "video/mp4",
  "video/mpeg",
  "video/mpg",
  "video/mov",
  "video/quicktime",
  "video/avi",
  "video/x-flv",
  "video/webm",
  "video/wmv",
  "video/3gpp",
]);

const VIDEO_EXT_TO_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpg",
  ".mov": "video/quicktime",
  ".avi": "video/avi",
  ".flv": "video/x-flv",
  ".webm": "video/webm",
  ".wmv": "video/wmv",
  ".3gp": "video/3gpp",
  ".3gpp": "video/3gpp",
};

export interface GeminiInteractionsClientLike {
  interactions: {
    create(params: Record<string, unknown>): Promise<{
      id?: string;
      status?: string;
      output_text?: string;
      steps?: Array<{
        type?: string;
        content?: Array<{ type?: string; text?: string }>;
        error?: { message?: string; code?: string | number };
      }>;
      errors?: Array<{ message?: string; code?: string | number }>;
    }>;
  };
}

let testClientOverride: GeminiInteractionsClientLike | null = null;

export function setGeminiClientForTesting(client: GeminiInteractionsClientLike | null): void {
  testClientOverride = client;
}

export class GeminiServiceError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "GeminiServiceError";
    this.status = status;
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Configuration & Sanitization Helpers                                       */
/* -------------------------------------------------------------------------- */

function readServerEnv(env: Record<string, string | undefined> | undefined, key: string): string {
  const val = env?.[key] ?? process.env[key] ?? "";
  return String(val)
    .replace(/^["']|["']$/g, "")
    .trim();
}

export function resolveGeminiConfig(env?: Record<string, string | undefined> | undefined): {
  apiKey: string;
  model: string;
  timeoutMs: number;
  configured: boolean;
} {
  const apiKey = readServerEnv(env, "GEMINI_API_KEY");
  const rawModel = readServerEnv(env, "GEMINI_MODEL");
  const lowerModel = rawModel.toLowerCase();

  let model = DEFAULT_GEMINI_MODEL;
  if (
    rawModel &&
    !PROHIBITED_DEPRECATED_MODEL_PREFIXES.some((prefix) => lowerModel.startsWith(prefix))
  ) {
    model = rawModel;
  }

  const parsedTimeout = Number.parseInt(readServerEnv(env, "GEMINI_TIMEOUT_MS"), 10);
  const timeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout >= 3000 && parsedTimeout <= 60_000
      ? parsedTimeout
      : DEFAULT_GEMINI_TIMEOUT_MS;

  return {
    apiKey,
    model,
    timeoutMs,
    configured: apiKey.length > 0 || testClientOverride !== null,
  };
}

export function sanitizeGeminiErrorMessage(raw: unknown, apiKey?: string): string {
  let msg = raw instanceof Error ? raw.message : String(raw || "AI service error");
  if (apiKey && apiKey.length >= 6) {
    msg = msg.split(apiKey).join("[REDACTED]");
  }
  msg = msg
    .replace(/AIza[0-9A-Za-z_-]{16,}/g, "[REDACTED_KEY]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/(GEMINI_API_KEY|apiKey|api_key)\s*[:=]\s*["']?[^\s"',}]+["']?/gi, "$1=[REDACTED]");

  const compact = msg.replace(/\s+/g, " ").trim();
  if (!compact) return "AI request could not be completed.";
  return compact.length > 260 ? `${compact.slice(0, 257)}...` : compact;
}

function getClientOrThrow(env?: Record<string, string | undefined> | undefined): {
  client: GeminiInteractionsClientLike;
  model: string;
  timeoutMs: number;
  apiKey: string;
} {
  const cfg = resolveGeminiConfig(env);
  if (testClientOverride) {
    return {
      client: testClientOverride,
      model: cfg.model,
      timeoutMs: cfg.timeoutMs,
      apiKey: cfg.apiKey,
    };
  }
  if (!cfg.apiKey) {
    throw new GeminiServiceError(
      503,
      "AI_NOT_CONFIGURED",
      "Gemini AI is not configured on this server. Set GEMINI_API_KEY on the Node server environment to enable AI features.",
    );
  }
  const client = new GoogleGenAI({
    apiKey: cfg.apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  }) as unknown as GeminiInteractionsClientLike;

  return {
    client,
    model: cfg.model,
    timeoutMs: cfg.timeoutMs,
    apiKey: cfg.apiKey,
  };
}

/* -------------------------------------------------------------------------- */
/* Sliding-Window Per-User / Per-IP Rate Limiter                              */
/* -------------------------------------------------------------------------- */

const rateBuckets = new Map<string, number[]>();

export function resetAiRateLimitsForTesting(): void {
  rateBuckets.clear();
}

export function checkAiRateLimit(params: {
  bucket: "video-metadata" | "video-summary" | "chat" | "recommendations";
  subjectKey: string;
  limit: number;
  windowMs: number;
}): { allowed: boolean; retryAfterSec: number; remaining: number } {
  const now = Date.now();
  const key = `${params.bucket}:${params.subjectKey}`;
  const cutoff = now - params.windowMs;
  const timestamps = (rateBuckets.get(key) || []).filter((ts) => ts > cutoff);

  if (timestamps.length >= params.limit) {
    const oldest = timestamps[0] ?? now;
    const retryAfterSec = Math.max(1, Math.ceil((oldest + params.windowMs - now) / 1000));
    rateBuckets.set(key, timestamps);
    return { allowed: false, retryAfterSec, remaining: 0 };
  }

  timestamps.push(now);
  rateBuckets.set(key, timestamps);
  return {
    allowed: true,
    retryAfterSec: 0,
    remaining: Math.max(0, params.limit - timestamps.length),
  };
}

/* -------------------------------------------------------------------------- */
/* Interactions API Execution, Timeout & Text/JSON Extraction                 */
/* -------------------------------------------------------------------------- */

function extractInteractionText(interaction: {
  output_text?: string;
  steps?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
}): string {
  if (typeof interaction.output_text === "string" && interaction.output_text.trim()) {
    return interaction.output_text.trim();
  }
  if (Array.isArray(interaction.steps)) {
    for (let i = interaction.steps.length - 1; i >= 0; i--) {
      const step = interaction.steps[i];
      if (!step || step.type !== "model_output" || !Array.isArray(step.content)) continue;
      const texts = step.content
        .filter((c) => c && c.type === "text" && typeof c.text === "string")
        .map((c) => c.text!.trim())
        .filter(Boolean);
      if (texts.length > 0) {
        return texts.join("\n").trim();
      }
    }
  }
  return "";
}

function parseJsonFromModelText<T>(rawText: string): T | null {
  if (!rawText) return null;
  const trimmed = rawText.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // Strip markdown code fences if model returned fenced JSON
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch && fenceMatch[1]) {
      try {
        return JSON.parse(fenceMatch[1].trim()) as T;
      } catch {
        // Fall through
      }
    }
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function runInteractionWithTimeout(params: {
  env?: Record<string, string | undefined> | undefined;
  request: Record<string, unknown>;
  timeoutMsOverride?: number | undefined;
}): Promise<{
  text: string;
  model: string;
}> {
  const { client, model, timeoutMs, apiKey } = getClientOrThrow(params.env);
  const effectiveTimeout = params.timeoutMsOverride ?? timeoutMs;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const interactionPromise = client.interactions.create({
      model,
      store: false,
      generation_config: {
        thinking_level: "low",
      },
      ...params.request,
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new GeminiServiceError(
            504,
            "AI_TIMEOUT",
            "Gemini AI request timed out. Please try again shortly.",
          ),
        );
      }, effectiveTimeout);
    });

    const interaction = await Promise.race([interactionPromise, timeoutPromise]);
    if (interaction?.errors && interaction.errors.length > 0) {
      const errMsg = interaction.errors[0]?.message || "AI interaction returned an error.";
      throw new GeminiServiceError(
        502,
        "AI_UPSTREAM_ERROR",
        sanitizeGeminiErrorMessage(errMsg, apiKey),
      );
    }

    const text = extractInteractionText(interaction || {});
    if (!text) {
      throw new GeminiServiceError(
        502,
        "AI_EMPTY_RESPONSE",
        "Gemini AI did not return any readable output. Please try again.",
      );
    }

    return { text, model };
  } catch (err: any) {
    if (err instanceof GeminiServiceError) {
      throw err;
    }

    const rawStatus = Number(err?.status ?? err?.statusCode ?? err?.code ?? 0);
    const rawMsg = sanitizeGeminiErrorMessage(err?.message || err, apiKey);

    if (rawStatus === 429 || /rate limit|quota|resource_exhausted|429/i.test(rawMsg)) {
      throw new GeminiServiceError(
        429,
        "AI_RATE_LIMITED",
        "AI request quota or rate limit was reached. Please wait a moment and try again.",
      );
    }
    if (
      rawStatus === 401 ||
      rawStatus === 403 ||
      /api key not valid|unauthorized|permission/i.test(rawMsg)
    ) {
      throw new GeminiServiceError(
        503,
        "AI_AUTH_ERROR",
        "Gemini AI service credentials could not be verified on the server.",
      );
    }
    if (/timeout|timed out|abort/i.test(rawMsg)) {
      throw new GeminiServiceError(
        504,
        "AI_TIMEOUT",
        "Gemini AI request timed out. Please try again shortly.",
      );
    }
    throw new GeminiServiceError(
      502,
      "AI_UPSTREAM_ERROR",
      "Gemini AI could not complete the request right now. Please try again.",
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/* Accessible Video Content Resolution (Local Uploads & Safe Remote Fetch)    */
/* -------------------------------------------------------------------------- */

function normalizeVideoMimeType(
  rawMime: string | null | undefined,
  filePathOrUrl?: string,
): string {
  const clean = String(rawMime || "")
    .split(";")[0]
    ?.trim()
    .toLowerCase();
  if (clean === "video/quicktime") return "video/mov";
  if (clean && SUPPORTED_GEMINI_VIDEO_MIMES.has(clean)) {
    return clean;
  }
  if (filePathOrUrl) {
    const ext = path.extname(filePathOrUrl.split("?")[0] || "").toLowerCase();
    const mapped = VIDEO_EXT_TO_MIME[ext];
    if (mapped) {
      return mapped === "video/quicktime" ? "video/mov" : mapped;
    }
  }
  return "";
}

function isBlockedPrivateIp(ip: string): boolean {
  const clean = ip
    .replace(/^\[|\]$/g, "")
    .trim()
    .toLowerCase();
  if (!clean) return true;
  if (net.isIPv4(clean)) {
    const parts = clean.split(".").map((n) => Number.parseInt(n, 10));
    const [a, b] = parts;
    if (a === undefined || b === undefined) return true;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (net.isIPv6(clean)) {
    if (
      clean === "::1" ||
      clean === "::" ||
      clean.startsWith("fe80:") ||
      clean.startsWith("fc") ||
      clean.startsWith("fd")
    ) {
      return true;
    }
    return false;
  }
  return false;
}

function validateSafeRemoteVideoUrl(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    const host = parsed.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal")
    ) {
      return null;
    }
    if (net.isIP(host) && isBlockedPrivateIp(host)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function loadAccessibleVideoBytes(params: {
  videoUrl: string;
  maxBytes: number;
  uploadsRootDir?: string;
}): Promise<{
  base64: string;
  mimeType: string;
  byteLength: number;
  source: "local_disk" | "remote_url";
}> {
  const rawUrl = String(params.videoUrl || "").trim();
  if (!rawUrl) {
    throw new GeminiServiceError(
      422,
      "VIDEO_UNAVAILABLE",
      "No video media source is available to analyze.",
    );
  }

  // Case 1: Local /uploads/... path on disk (or facetube.online/uploads/... pointing to same uploads tree if present locally)
  let localRelPath = "";
  if (rawUrl.startsWith("/uploads/")) {
    localRelPath = rawUrl.replace(/^\/uploads\/?/, "");
  } else {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.pathname.startsWith("/uploads/")) {
        const candidateHost = parsed.hostname.toLowerCase();
        if (
          candidateHost === "localhost" ||
          candidateHost === "127.0.0.1" ||
          candidateHost === "api.facetube.online" ||
          candidateHost === "facetube.online" ||
          candidateHost === "www.facetube.online"
        ) {
          localRelPath = parsed.pathname.replace(/^\/uploads\/?/, "");
        }
      }
    } catch {
      // Not an absolute URL
    }
  }

  if (localRelPath) {
    const uploadsRoot = path.resolve(params.uploadsRootDir || path.join(process.cwd(), "uploads"));
    const decodedRel = decodeURIComponent(localRelPath);
    const fullPath = path.resolve(uploadsRoot, decodedRel);
    if (fullPath !== uploadsRoot && !fullPath.startsWith(`${uploadsRoot}${path.sep}`)) {
      throw new GeminiServiceError(403, "VIDEO_PATH_FORBIDDEN", "Invalid video media path.");
    }

    try {
      const stat = await fs.promises.stat(fullPath);
      if (!stat.isFile()) {
        throw new GeminiServiceError(
          422,
          "VIDEO_UNAVAILABLE",
          "Video file is not available on server storage.",
        );
      }
      if (stat.size <= 0) {
        throw new GeminiServiceError(
          422,
          "VIDEO_UNAVAILABLE",
          "Video file is empty and cannot be analyzed.",
        );
      }
      if (stat.size > params.maxBytes) {
        const maxMb = Math.round(params.maxBytes / (1024 * 1024));
        throw new GeminiServiceError(
          422,
          "VIDEO_TOO_LARGE",
          `Video file (${(stat.size / (1024 * 1024)).toFixed(1)} MB) exceeds the ${maxMb} MB inline AI analysis limit.`,
        );
      }
      const mimeType = normalizeVideoMimeType(undefined, fullPath);
      if (!mimeType) {
        throw new GeminiServiceError(
          422,
          "VIDEO_UNSUPPORTED_FORMAT",
          "This video file format is not supported for AI content analysis. Supported formats: MP4, WebM, MOV, MPEG, 3GPP.",
        );
      }
      const buf = await fs.promises.readFile(fullPath);
      return {
        base64: buf.toString("base64"),
        mimeType,
        byteLength: buf.byteLength,
        source: "local_disk",
      };
    } catch (err: any) {
      if (err instanceof GeminiServiceError) throw err;
      // If file isn't on local disk and rawUrl was a remote URL, fall through to remote fetch below
      if (!rawUrl.startsWith("http://") && !rawUrl.startsWith("https://")) {
        throw new GeminiServiceError(
          422,
          "VIDEO_UNAVAILABLE",
          "The video file is unavailable on this server for AI content analysis.",
        );
      }
    }
  }

  // Case 2: Validated external HTTP(S) media URL with strict byte cap and timeout
  const safeUrl = validateSafeRemoteVideoUrl(rawUrl);
  if (!safeUrl) {
    throw new GeminiServiceError(
      422,
      "VIDEO_UNAVAILABLE",
      "The video source URL is unavailable or cannot be fetched safely for AI analysis.",
    );
  }

  const controller = new AbortController();
  const fetchTimeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(safeUrl.toString(), {
      method: "GET",
      signal: controller.signal,
      redirect: "follow",
    });

    if (!res.ok) {
      throw new GeminiServiceError(
        422,
        "VIDEO_UNAVAILABLE",
        "The video source could not be accessed for AI analysis.",
      );
    }

    const contentLengthHeader = Number.parseInt(res.headers.get("content-length") || "", 10);
    if (Number.isFinite(contentLengthHeader) && contentLengthHeader > params.maxBytes) {
      controller.abort();
      const maxMb = Math.round(params.maxBytes / (1024 * 1024));
      throw new GeminiServiceError(
        422,
        "VIDEO_TOO_LARGE",
        `Video size exceeds the ${maxMb} MB inline AI analysis limit.`,
      );
    }

    const headerMime = res.headers.get("content-type") || "";
    if (
      headerMime &&
      !headerMime.toLowerCase().includes("video/") &&
      !headerMime.toLowerCase().includes("application/octet-stream")
    ) {
      throw new GeminiServiceError(
        422,
        "VIDEO_UNSUPPORTED_FORMAT",
        "The video URL did not return a supported video media stream.",
      );
    }

    const mimeType = normalizeVideoMimeType(headerMime, safeUrl.pathname);
    if (!mimeType) {
      throw new GeminiServiceError(
        422,
        "VIDEO_UNSUPPORTED_FORMAT",
        "This video format is not supported for AI content analysis. Supported formats: MP4, WebM, MOV, MPEG, 3GPP.",
      );
    }

    if (!res.body) {
      throw new GeminiServiceError(
        422,
        "VIDEO_UNAVAILABLE",
        "Video stream returned an empty response.",
      );
    }

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > params.maxBytes) {
          controller.abort();
          const maxMb = Math.round(params.maxBytes / (1024 * 1024));
          throw new GeminiServiceError(
            422,
            "VIDEO_TOO_LARGE",
            `Video stream exceeds the ${maxMb} MB inline AI analysis limit.`,
          );
        }
        chunks.push(value);
      }
    }

    if (totalBytes <= 0) {
      throw new GeminiServiceError(
        422,
        "VIDEO_UNAVAILABLE",
        "Video stream is empty and cannot be summarized.",
      );
    }

    const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    return {
      base64: merged.toString("base64"),
      mimeType,
      byteLength: merged.byteLength,
      source: "remote_url",
    };
  } catch (err: any) {
    if (err instanceof GeminiServiceError) throw err;
    throw new GeminiServiceError(
      422,
      "VIDEO_UNAVAILABLE",
      "The video source could not be accessed right now for AI analysis.",
    );
  } finally {
    clearTimeout(fetchTimeout);
  }
}

/* -------------------------------------------------------------------------- */
/* Feature 1: AI Video Title, Description & Tags Generator                    */
/* -------------------------------------------------------------------------- */

export interface GenerateVideoMetadataInput {
  env?: Record<string, string | undefined> | undefined;
  titleDraft?: string | undefined;
  descriptionDraft?: string | undefined;
  category?: string | undefined;
  contentType?: "short" | "long" | undefined;
  fileName?: string | undefined;
  duration?: string | undefined;
  visibility?: "public" | "unlisted" | "private" | undefined;
  videoBase64?: string | undefined;
  videoMimeType?: string | undefined;
  videoUrl?: string | undefined;
  aiConsent?: boolean | undefined;
}

export interface GenerateVideoMetadataResult {
  title: string;
  description: string;
  tags: string[];
  analysisMode: "video_content" | "metadata_only";
  model: string;
}

export async function generateVideoMetadataSuggestions(
  input: GenerateVideoMetadataInput,
): Promise<GenerateVideoMetadataResult> {
  const titleDraft = String(input.titleDraft || "")
    .trim()
    .slice(0, 160);
  const descriptionDraft = String(input.descriptionDraft || "")
    .trim()
    .slice(0, 1500);
  const category = String(input.category || "General")
    .trim()
    .slice(0, 60);
  const contentType = input.contentType === "short" ? "short" : "long";
  const fileName = String(input.fileName || "")
    .trim()
    .slice(0, 140);
  const duration = String(input.duration || "")
    .trim()
    .slice(0, 30);

  let inlineVideo: { base64: string; mimeType: string } | null = null;

  if (input.videoBase64 && typeof input.videoBase64 === "string") {
    if (!input.aiConsent) {
      throw new GeminiServiceError(
        400,
        "AI_CONSENT_REQUIRED",
        "Please confirm AI analysis consent before sending video content to Gemini.",
      );
    }
    const cleanBase64 = input.videoBase64.replace(/^data:[^;]+;base64,/i, "").trim();
    const estimatedBytes = Math.floor((cleanBase64.length * 3) / 4);
    if (estimatedBytes <= 0) {
      throw new GeminiServiceError(
        400,
        "INVALID_VIDEO_PAYLOAD",
        "Provided video payload is empty.",
      );
    }
    if (estimatedBytes > MAX_INLINE_VIDEO_METADATA_BYTES) {
      throw new GeminiServiceError(
        422,
        "VIDEO_TOO_LARGE",
        "Video clip exceeds the 12 MB inline AI analysis limit. You can still generate suggestions from your draft metadata.",
      );
    }
    const mimeType = normalizeVideoMimeType(input.videoMimeType, fileName);
    if (!mimeType) {
      throw new GeminiServiceError(
        422,
        "VIDEO_UNSUPPORTED_FORMAT",
        "Unsupported video format for AI content analysis. Supported formats: MP4, WebM, MOV, MPEG, 3GPP.",
      );
    }
    inlineVideo = { base64: cleanBase64, mimeType };
  } else if (input.videoUrl && input.aiConsent) {
    const loaded = await loadAccessibleVideoBytes({
      videoUrl: input.videoUrl,
      maxBytes: MAX_INLINE_VIDEO_METADATA_BYTES,
    });
    inlineVideo = { base64: loaded.base64, mimeType: loaded.mimeType };
  }

  if (!inlineVideo && !titleDraft && !descriptionDraft && !fileName) {
    throw new GeminiServiceError(
      400,
      "METADATA_INPUT_REQUIRED",
      "Provide a draft title, description, filename, or consented video clip so AI can generate suggestions.",
    );
  }

  const prompt = [
    "You are helping a FaceTube creator write accurate, engaging video metadata.",
    inlineVideo
      ? "Analyze the attached video frames/audio directly and combine with any creator draft notes below."
      : "No raw video stream was uploaded; base your suggestions strictly on the verified creator metadata below without inventing fake facts or metrics.",
    `Creator context:`,
    `- Format: ${contentType === "short" ? "Short video (vertical <60s)" : "Long-form video"}`,
    `- Category: ${category}`,
    duration ? `- Duration: ${duration}` : "",
    fileName ? `- File name: ${fileName}` : "",
    titleDraft ? `- Current title draft: ${titleDraft}` : "",
    descriptionDraft ? `- Current description draft: ${descriptionDraft}` : "",
    "",
    "Requirements:",
    "- title: clear, compelling, honest title under 90 characters (no clickbait lies).",
    "- description: structured, helpful FaceTube video description (2-4 concise paragraphs or bullets, under 900 chars).",
    "- tags: 4 to 8 concise lowercase/titlecase search tags (no # prefix, max 30 chars each).",
    "Return valid JSON matching the requested schema.",
  ]
    .filter(Boolean)
    .join("\n");

  const interactionInput = inlineVideo
    ? [
        { type: "video", data: inlineVideo.base64, mime_type: inlineVideo.mimeType },
        { type: "text", text: prompt },
      ]
    : prompt;

  const { text, model } = await runInteractionWithTimeout({
    env: input.env,
    request: {
      system_instruction:
        "You are FaceTube's creator metadata assistant. Produce concise, truthful video titles, descriptions, and tags as strict JSON.",
      input: interactionInput,
      response_format: {
        type: "object",
        properties: {
          title: { type: "string", description: "Suggested video title under 90 characters." },
          description: {
            type: "string",
            description: "Suggested video description under 900 characters.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "4 to 8 relevant tags without #.",
          },
        },
        required: ["title", "description", "tags"],
      },
    },
  });

  const parsed = parseJsonFromModelText<{
    title?: string;
    description?: string;
    tags?: unknown[];
  }>(text);

  const suggestedTitle = String(parsed?.title || titleDraft || "Untitled Video")
    .trim()
    .slice(0, 120);
  const suggestedDescription = String(parsed?.description || descriptionDraft || text)
    .trim()
    .slice(0, 2000);
  const rawTags = Array.isArray(parsed?.tags) ? parsed.tags : [];
  const seenTags = new Set<string>();
  const cleanTags: string[] = [];
  for (const t of rawTags) {
    const cleaned = String(t || "")
      .replace(/^#+/, "")
      .trim()
      .slice(0, 35);
    if (!cleaned) continue;
    const norm = cleaned.toLowerCase();
    if (seenTags.has(norm)) continue;
    seenTags.add(norm);
    cleanTags.push(cleaned);
    if (cleanTags.length >= 8) break;
  }

  return {
    title: suggestedTitle,
    description: suggestedDescription,
    tags: cleanTags,
    analysisMode: inlineVideo ? "video_content" : "metadata_only",
    model,
  };
}

/* -------------------------------------------------------------------------- */
/* Feature 2: AI Video Summary                                                */
/* -------------------------------------------------------------------------- */

export interface SummarizeVideoInput {
  env?: Record<string, string | undefined> | undefined;
  videoId: string;
  title: string;
  description?: string | undefined;
  category?: string | undefined;
  duration?: string | undefined;
  videoUrl: string;
  visibility: "public" | "unlisted" | "private";
  aiConsent?: boolean | undefined;
  uploadsRootDir?: string | undefined;
}

export interface SummarizeVideoResult {
  videoId: string;
  title: string;
  shortSummary: string;
  keyPoints: string[];
  analysisMode: "video_content";
  model: string;
}

export async function summarizeVideoContent(
  input: SummarizeVideoInput,
): Promise<SummarizeVideoResult> {
  if ((input.visibility === "private" || input.visibility === "unlisted") && !input.aiConsent) {
    throw new GeminiServiceError(
      400,
      "AI_CONSENT_REQUIRED",
      "This video is not public. Explicit consent is required before sending its content for AI summarization.",
    );
  }

  // Strictly load actual video bytes; never fabricate a summary if inaccessible/unsupported/too large.
  const loaded = await loadAccessibleVideoBytes({
    videoUrl: input.videoUrl,
    maxBytes: MAX_INLINE_VIDEO_SUMMARY_BYTES,
    ...(input.uploadsRootDir ? { uploadsRootDir: input.uploadsRootDir } : {}),
  });

  const prompt = [
    "Watch and listen carefully to the attached video and summarize ONLY what is actually shown or spoken in the video.",
    `Video title: ${String(input.title || "FaceTube Video").slice(0, 140)}`,
    input.category ? `Category: ${String(input.category).slice(0, 60)}` : "",
    input.duration ? `Duration: ${String(input.duration).slice(0, 30)}` : "",
    "",
    "Requirements:",
    "- shortSummary: 2-3 clear sentences summarizing the video accurately.",
    "- keyPoints: 3 to 5 concise bullet points capturing the main topics, steps, or takeaways from the video itself.",
    "- Never invent details not present in the video.",
  ]
    .filter(Boolean)
    .join("\n");

  const { text, model } = await runInteractionWithTimeout({
    env: input.env,
    request: {
      system_instruction:
        "You summarize uploaded FaceTube videos accurately from actual video content. Never fabricate events or claims not present in the video.",
      input: [
        { type: "video", data: loaded.base64, mime_type: loaded.mimeType },
        { type: "text", text: prompt },
      ],
      response_format: {
        type: "object",
        properties: {
          shortSummary: { type: "string", description: "Concise 2-3 sentence summary." },
          keyPoints: {
            type: "array",
            items: { type: "string" },
            description: "3 to 5 key takeaways observed in the video.",
          },
        },
        required: ["shortSummary", "keyPoints"],
      },
    },
  });

  const parsed = parseJsonFromModelText<{ shortSummary?: string; keyPoints?: unknown[] }>(text);
  const shortSummary = String(parsed?.shortSummary || text || "")
    .trim()
    .slice(0, 1200);
  const keyPoints = (Array.isArray(parsed?.keyPoints) ? parsed.keyPoints : [])
    .map((p) =>
      String(p || "")
        .trim()
        .slice(0, 240),
    )
    .filter(Boolean)
    .slice(0, 6);

  if (!shortSummary) {
    throw new GeminiServiceError(
      502,
      "AI_EMPTY_RESPONSE",
      "Could not extract a summary from the video content.",
    );
  }

  return {
    videoId: input.videoId,
    title: input.title,
    shortSummary,
    keyPoints,
    analysisMode: "video_content",
    model,
  };
}

/* -------------------------------------------------------------------------- */
/* Feature 3: FaceTube AI Chatbot (Verified Platform Knowledge)               */
/* -------------------------------------------------------------------------- */

const FACETUBE_VERIFIED_SYSTEM_INSTRUCTION = `
You are the FaceTube Help Assistant for authenticated FaceTube users.

Verified FaceTube platform facts:
1. Video Uploads (/upload):
   - Free Video Upload: ₹0 fee (Short <60s 9:16 vertical or Long 16:9), supports single or bulk upload.
   - Sponsor Video Upload (Monetized): ₹6 verified via Razorpay checkout, requires voluntary promotion consent.
   - Ad Video Campaign: Boost an uploaded video for 7 Days (₹100), 15 Days (₹200), 1 Month (₹300), or 1 Year (₹3,000) via Razorpay.
   - Image Upload: JPG/PNG/WEBP automatically formatted to 9:16 vertical.
   - Visibility choices: Public (in feeds & search), Unlisted (link access), Private (only creator/admin).
   - Channel Logo (/profile or /settings): Supports square 1:1 images (such as 512x512).
2. Discovery & Playback:
   - Home (/), Shorts (/shorts), Explore (/explore), Watch (/watch/<id>), Watch History (/history), Live Streams (/live).
   - Live streaming uses LiveKit rooms with broadcaster studio and viewer playback.
3. Monetization, Wallet, Referrals & Subscriptions:
   - Dashboard (/dashboard) and Earnings (/earnings) show wallet balance, referral income, global/AdSense/AdMob/affiliate earnings, and withdrawal requests (requires verified Personal & Bank KYC).
   - Referrals (/referrals) tracks a user's multi-level referral network.
   - Subscriber Plans (/subscribe) and My Subscriptions (/my-subscriptions) handle paid memberships and refund requests.
   - Help Center (/help) provides FAQ and contact options.

Strict safety & truthfulness rules:
- You are an informational assistant ONLY. You CANNOT execute payments, uploads, withdrawals, KYC approvals, password resets, or database/account modifications. Never claim you performed or initiated any backend action; instead explain the exact FaceTube page and steps for the user to do it themselves.
- Never reveal, invent, or guess private data about other users, internal credentials, API keys, or unverified metrics.
- If a user asks about something outside FaceTube or unverified internal details, clearly state what is outside verified FaceTube documentation.
- Keep answers concise, friendly, structured, and accurate.
`.trim();

export interface ChatTurnInput {
  role: "user" | "assistant";
  text: string;
}

export interface RunChatbotTurnInput {
  env?: Record<string, string | undefined> | undefined;
  message: string;
  history?: ChatTurnInput[] | undefined;
  userContext: {
    displayName: string;
    role: "admin" | "user";
  };
}

export async function runFaceTubeChatbotTurn(input: RunChatbotTurnInput): Promise<{
  reply: string;
  model: string;
}> {
  const cleanMessage = String(input.message || "").trim();
  if (!cleanMessage) {
    throw new GeminiServiceError(
      400,
      "EMPTY_CHAT_MESSAGE",
      "Please enter a message to ask the assistant.",
    );
  }
  if (cleanMessage.length > 1500) {
    throw new GeminiServiceError(
      400,
      "CHAT_MESSAGE_TOO_LONG",
      "Message cannot exceed 1,500 characters.",
    );
  }

  const rawHistory = Array.isArray(input.history) ? input.history.slice(-10) : [];
  const steps: Array<{
    type: "user_input" | "model_output";
    content: Array<{ type: "text"; text: string }>;
  }> = [];

  for (const turn of rawHistory) {
    if (!turn || typeof turn.text !== "string") continue;
    const text = turn.text.trim().slice(0, 1200);
    if (!text) continue;
    steps.push({
      type: turn.role === "assistant" ? "model_output" : "user_input",
      content: [{ type: "text", text }],
    });
  }

  steps.push({
    type: "user_input",
    content: [{ type: "text", text: cleanMessage }],
  });

  const safeName = String(input.userContext.displayName || "FaceTube User")
    .replace(/[\r\n]/g, " ")
    .trim()
    .slice(0, 60);

  const systemInstruction = `${FACETUBE_VERIFIED_SYSTEM_INSTRUCTION}\n\nSigned-in viewer context: displayName="${safeName}", role="${input.userContext.role}". Do not share private details.`;

  const { text, model } = await runInteractionWithTimeout({
    env: input.env,
    request: {
      system_instruction: systemInstruction,
      input: steps,
    },
  });

  return {
    reply: text.trim().slice(0, 4000),
    model,
  };
}

/* -------------------------------------------------------------------------- */
/* Feature 4: AI-Powered Personalized Video Recommendations                   */
/* -------------------------------------------------------------------------- */

export interface RecommendationCandidateVideo {
  id: string;
  userId: string;
  creatorName: string;
  channelName: string;
  channelLogoUrl: string | null;
  title: string;
  description: string;
  videoUrl: string;
  thumbnailUrl: string;
  videoType: "free" | "premium";
  contentType: "short" | "long";
  category: string;
  duration: string;
  views: number;
  likes: number;
  paymentStatus: string;
  isPromoted: boolean;
  visibility: "public" | "unlisted" | "private";
  createdAt: string;
  updatedAt: string;
}

export interface RankedRecommendationItem {
  video: RecommendationCandidateVideo;
  reason: string;
}

export interface PersonalizedRecommendationsResult {
  source: "gemini" | "fallback";
  fallbackUsed: boolean;
  model: string | null;
  items: RankedRecommendationItem[];
}

function scoreCandidateDeterministically(
  candidate: RecommendationCandidateVideo,
  signals: {
    watchedCategories: Map<string, number>;
    likedCategories: Map<string, number>;
    preferredCategories: Set<string>;
    watchedCreators: Set<string>;
  },
): { score: number; reason: string } {
  const catLower = candidate.category.toLowerCase();
  const creatorLower = (candidate.channelName || candidate.creatorName || "").toLowerCase();

  let score = 0;
  let reason = `Popular in ${candidate.category}`;

  const likedWeight = signals.likedCategories.get(catLower) || 0;
  const watchedWeight = signals.watchedCategories.get(catLower) || 0;
  if (likedWeight > 0) {
    score += likedWeight * 40;
    reason = `Matches ${candidate.category} videos you liked`;
  } else if (watchedWeight > 0) {
    score += watchedWeight * 25;
    reason = `Based on your ${candidate.category} watch history`;
  } else if (signals.preferredCategories.has(catLower)) {
    score += 20;
    reason = `Matches your selected ${candidate.category} interest`;
  }

  if (creatorLower && signals.watchedCreators.has(creatorLower)) {
    score += 18;
    reason = `From ${candidate.channelName || candidate.creatorName}`;
  }

  if (candidate.isPromoted) {
    score += 12;
  }

  score += Math.min(20, Math.log10(Math.max(1, candidate.views + 1)) * 4);
  score += Math.min(10, Math.log10(Math.max(1, candidate.likes + 1)) * 3);

  const createdMs = Date.parse(candidate.createdAt || "") || 0;
  const ageDays =
    createdMs > 0 ? Math.max(0, (Date.now() - createdMs) / (1000 * 60 * 60 * 24)) : 90;
  score += Math.max(0, 10 - ageDays * 0.15);

  return { score, reason };
}

export async function rankPersonalizedRecommendations(params: {
  env?: Record<string, string | undefined> | undefined;
  candidates: RecommendationCandidateVideo[];
  watchedVideos: RecommendationCandidateVideo[];
  likedVideos: RecommendationCandidateVideo[];
  preferredCategories?: string[] | undefined;
  limit: number;
}): Promise<PersonalizedRecommendationsResult> {
  const limit = Math.max(1, Math.min(24, params.limit || 12));
  if (params.candidates.length === 0) {
    return {
      source: "fallback",
      fallbackUsed: false,
      model: null,
      items: [],
    };
  }

  const watchedCategories = new Map<string, number>();
  const likedCategories = new Map<string, number>();
  const watchedCreators = new Set<string>();
  const preferredCategories = new Set<string>(
    (params.preferredCategories || []).map((c) => String(c).trim().toLowerCase()).filter(Boolean),
  );

  for (const w of params.watchedVideos) {
    const cat = (w.category || "").trim().toLowerCase();
    if (cat) watchedCategories.set(cat, (watchedCategories.get(cat) || 0) + 1);
    const ch = (w.channelName || w.creatorName || "").trim().toLowerCase();
    if (ch) watchedCreators.add(ch);
  }
  for (const l of params.likedVideos) {
    const cat = (l.category || "").trim().toLowerCase();
    if (cat) likedCategories.set(cat, (likedCategories.get(cat) || 0) + 1);
    const ch = (l.channelName || l.creatorName || "").trim().toLowerCase();
    if (ch) watchedCreators.add(ch);
  }

  const deterministicRanked = [...params.candidates]
    .map((candidate) => ({
      video: candidate,
      ...scoreCandidateDeterministically(candidate, {
        watchedCategories,
        likedCategories,
        preferredCategories,
        watchedCreators,
      }),
    }))
    .sort((a, b) => b.score - a.score);

  const fallbackResult = (): PersonalizedRecommendationsResult => ({
    source: "fallback",
    fallbackUsed: true,
    model: null,
    items: deterministicRanked.slice(0, limit).map(({ video, reason }) => ({ video, reason })),
  });

  const cfg = resolveGeminiConfig(params.env);
  if (!cfg.configured || params.candidates.length < 2) {
    return fallbackResult();
  }

  // Cap candidate payload sent to Gemini to top 30 pre-scored real catalog items
  const shortlist = deterministicRanked.slice(0, 30).map((entry) => entry.video);
  const candidateMap = new Map<string, RecommendationCandidateVideo>(
    shortlist.map((v) => [v.id, v]),
  );

  const compactCandidates = shortlist.map((v) => ({
    id: v.id,
    title: v.title.slice(0, 90),
    category: v.category,
    channel: (v.channelName || v.creatorName).slice(0, 50),
    contentType: v.contentType,
    views: v.views,
    likes: v.likes,
    isPromoted: v.isPromoted,
  }));

  const prompt = [
    "Rank up to " + limit + " recommended videos ONLY from the provided candidate list.",
    "Rules:",
    "- You MUST select video IDs strictly from the candidate list below. NEVER invent or modify an ID.",
    "- Prioritize matching the viewer's watched/liked categories and creators when available, while maintaining good diversity and quality.",
    "- Write a short, truthful reason (< 70 chars) referencing only the real category, channel, or popularity.",
    "",
    `Viewer signals (anonymized):`,
    `- Recently watched titles/categories: ${
      params.watchedVideos.length > 0
        ? params.watchedVideos
            .slice(0, 8)
            .map((v) => `${v.title.slice(0, 50)} (${v.category})`)
            .join("; ")
        : "none yet"
    }`,
    `- Liked categories: ${
      likedCategories.size > 0 ? Array.from(likedCategories.keys()).join(", ") : "none yet"
    }`,
    `- Preferred categories: ${
      preferredCategories.size > 0 ? Array.from(preferredCategories).join(", ") : "none specified"
    }`,
    "",
    `Candidates JSON:\n${JSON.stringify(compactCandidates)}`,
  ].join("\n");

  try {
    const { text, model } = await runInteractionWithTimeout({
      env: params.env,
      timeoutMsOverride: Math.min(cfg.timeoutMs, 10_000),
      request: {
        system_instruction:
          "You rank FaceTube candidate videos for personalized discovery. Never invent video IDs or metrics.",
        input: prompt,
        response_format: {
          type: "object",
          properties: {
            recommendations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  reason: { type: "string" },
                },
                required: ["id", "reason"],
              },
            },
          },
          required: ["recommendations"],
        },
      },
    });

    const parsed = parseJsonFromModelText<{
      recommendations?: Array<{ id?: unknown; reason?: unknown }>;
    }>(text);

    if (!parsed || !Array.isArray(parsed.recommendations)) {
      return fallbackResult();
    }

    const usedIds = new Set<string>();
    const rankedItems: RankedRecommendationItem[] = [];

    for (const rec of parsed.recommendations) {
      const id = String(rec?.id || "").trim();
      const matched = candidateMap.get(id);
      if (!matched || usedIds.has(id)) continue; // Drop hallucinated or duplicate IDs
      usedIds.add(id);
      const reason =
        String(rec?.reason || "")
          .trim()
          .slice(0, 90) || `Recommended in ${matched.category}`;
      rankedItems.push({ video: matched, reason });
      if (rankedItems.length >= limit) break;
    }

    if (rankedItems.length === 0) {
      return fallbackResult();
    }

    // Fill remaining slots with deterministic real candidates if Gemini returned fewer than requested
    for (const entry of deterministicRanked) {
      if (rankedItems.length >= limit) break;
      if (usedIds.has(entry.video.id)) continue;
      usedIds.add(entry.video.id);
      rankedItems.push({ video: entry.video, reason: entry.reason });
    }

    return {
      source: "gemini",
      fallbackUsed: false,
      model,
      items: rankedItems,
    };
  } catch {
    return fallbackResult();
  }
}
