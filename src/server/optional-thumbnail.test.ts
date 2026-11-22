import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { handleApiRequest } from "./api-handler.ts";
import {
  getCategoryFallbackThumbnail,
  resolveVideoThumbnail,
  sanitizeOptionalThumbnailUrl,
  validateOptionalThumbnailFile,
} from "../lib/thumbnail-service.ts";
import {
  recordNewVideoUpload,
  uploadSingleBulkVideoItem,
  validateVideoFileForUpload,
} from "../lib/video-service.ts";

describe("Task 14: Optional Video Thumbnail (Cover Image) Regression Suite", () => {
  let userToken = "";
  const createdDiskFiles: string[] = [];
  const originalFetch = globalThis.fetch;

  before(async () => {
    const loginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
    });
    const loginRes = await handleApiRequest(loginReq);
    assert.ok(loginRes, "User login request must return a response");
    const data = await loginRes.json();
    assert.ok(data.token, "User login must return a session token");
    userToken = data.token;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    while (createdDiskFiles.length > 0) {
      const target = createdDiskFiles.pop();
      if (target) {
        await fs.rm(target, { force: true }).catch(() => undefined);
      }
    }
  });

  describe("1. Optional Thumbnail Validation & Sanitization Helpers", () => {
    it("accepts undefined or null thumbnail without error", () => {
      assert.deepEqual(validateOptionalThumbnailFile(undefined), { valid: true });
      assert.deepEqual(validateOptionalThumbnailFile(null), { valid: true });
    });

    it("accepts valid JPG, PNG, and WEBP custom cover image files within 25MB", () => {
      const jpg = new File(["img"], "cover.jpg", { type: "image/jpeg" });
      const png = new File(["img"], "cover.png", { type: "image/png" });
      const webp = new File(["img"], "cover.webp", { type: "image/webp" });

      assert.equal(validateOptionalThumbnailFile(jpg).valid, true);
      assert.equal(validateOptionalThumbnailFile(png).valid, true);
      assert.equal(validateOptionalThumbnailFile(webp).valid, true);
    });

    it("rejects invalid custom thumbnail files (empty, oversized >25MB, or non-image)", () => {
      const emptyImg = new File([], "empty.jpg", { type: "image/jpeg" });
      assert.equal(validateOptionalThumbnailFile(emptyImg).valid, false);

      const exeFile = new File(["bin"], "malware.exe", { type: "application/x-msdownload" });
      assert.equal(validateOptionalThumbnailFile(exeFile).valid, false);

      const videoAsCover = new File(["vid"], "clip.mp4", { type: "video/mp4" });
      assert.equal(validateOptionalThumbnailFile(videoAsCover).valid, false);

      const oversized = {
        name: "huge.png",
        size: 26 * 1024 * 1024,
        type: "image/png",
      } as unknown as File;
      assert.equal(validateOptionalThumbnailFile(oversized).valid, false);
    });

    it("sanitizes empty, nullish, literal 'null'/'undefined', and non-string thumbnail values", () => {
      assert.equal(sanitizeOptionalThumbnailUrl(undefined), "");
      assert.equal(sanitizeOptionalThumbnailUrl(null), "");
      assert.equal(sanitizeOptionalThumbnailUrl(""), "");
      assert.equal(sanitizeOptionalThumbnailUrl("   "), "");
      assert.equal(sanitizeOptionalThumbnailUrl("null"), "");
      assert.equal(sanitizeOptionalThumbnailUrl("UNDEFINED"), "");
      assert.equal(sanitizeOptionalThumbnailUrl("NaN"), "");
      assert.equal(sanitizeOptionalThumbnailUrl("[object Object]"), "");
      assert.equal(sanitizeOptionalThumbnailUrl({ url: "bad" }), "");
      assert.equal(
        sanitizeOptionalThumbnailUrl("  /uploads/images/custom.jpg  "),
        "/uploads/images/custom.jpg",
      );
    });

    it("resolves missing thumbnail to real category fallback URL", () => {
      const codingFallback = getCategoryFallbackThumbnail("Coding");
      assert.equal(
        resolveVideoThumbnail({ thumbnailUrl: null, category: "Coding" }),
        codingFallback,
      );
      assert.equal(
        resolveVideoThumbnail({ thumbnailUrl: "null", category: "Coding" }),
        codingFallback,
      );
      assert.equal(
        resolveVideoThumbnail({ thumbnailUrl: "/uploads/images/cover.jpg", category: "Coding" }),
        "/uploads/images/cover.jpg",
      );
    });
  });

  describe("2. Upload Form UI Inspection (No Required Star / Non-blocking Optional Field)", () => {
    it("marks Thumbnail (Cover Image) as optional with no (*) star or required attribute while preserving required video fields", async () => {
      const uploadSource = await fs.readFile(
        path.resolve(process.cwd(), "src/routes/upload.tsx"),
        "utf8",
      );

      // Required fields remain marked with *
      assert.ok(uploadSource.includes('Video Title <span className="text-brand">*</span>'));
      assert.ok(uploadSource.includes('Video Category <span className="text-brand">*</span>'));
      assert.ok(uploadSource.includes('Select Video Format <span className="text-brand">*</span>'));

      // Both single upload forms expose optional Thumbnail (Cover Image) without required *
      const optionalLabelMatches = uploadSource.match(/Thumbnail \(Cover Image\)/g) || [];
      assert.ok(
        optionalLabelMatches.length >= 2,
        "Expected optional Thumbnail (Cover Image) UI in Free and Sponsor video upload forms",
      );

      // No label containing Thumbnail or Cover Image may include a required * span
      const labelBlocks = uploadSource.match(/<label[\s\S]*?<\/label>/g) || [];
      for (const block of labelBlocks) {
        if (/Thumbnail|Cover Image/i.test(block)) {
          assert.ok(
            !block.includes(">*<") && !block.includes("text-brand"),
            `Thumbnail/Cover Image label must not show a required (*): ${block}`,
          );
          assert.ok(
            !/\brequired\b/.test(block),
            `Thumbnail/Cover Image label block must not enforce required attribute: ${block}`,
          );
        }
      }

      // No file input accepting images for thumbnail may have the HTML required attribute
      assert.ok(
        !/<input[^>]*accept="image\/jpeg,image\/png,image\/webp"[^>]*\brequired\b/i.test(
          uploadSource,
        ),
        "Thumbnail file inputs must never have HTML required attribute",
      );
    });
  });

  describe("3. Backend /api/videos/create Runtime Tests (Optional Thumbnail & Validation)", () => {
    it("succeeds (201) when thumbnail_url is omitted, null, whitespace, 'null', or non-string, using category fallback", async () => {
      const variants: Array<{ label: string; extra: Record<string, unknown> }> = [
        { label: "omitted", extra: {} },
        { label: "null", extra: { thumbnail_url: null } },
        { label: "empty-string", extra: { thumbnail_url: "" } },
        { label: "whitespace", extra: { thumbnail_url: "   " } },
        { label: "literal-null", extra: { thumbnail_url: "null" } },
        { label: "literal-undefined", extra: { thumbnail_url: "undefined" } },
        { label: "non-string-object", extra: { thumbnail_url: { invalid: true } } },
      ];

      const expectedFallback = getCategoryFallbackThumbnail("Education");

      for (const variant of variants) {
        const vidId = `opt-thumb-${variant.label}-${Date.now()}`;
        const req = new Request("http://localhost:3000/api/videos/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({
            id: vidId,
            user_id: "FT483921",
            creator_name: "Alex Rivera",
            title: `Video Without Thumbnail (${variant.label})`,
            description: "Testing optional thumbnail acceptance",
            video_url: "/uploads/videos/sample_optional_thumb.mp4",
            video_type: "free",
            content_type: "long",
            category: "Education",
            duration: "3:15",
            ...variant.extra,
          }),
        });

        const res = await handleApiRequest(req);
        assert.ok(res, `Response expected for ${variant.label}`);
        assert.equal(res.status, 201, `Expected 201 Created for ${variant.label}`);
        const body = await res.json();
        assert.equal(body.success, true);
        assert.equal(body.video.id, vidId);
        assert.equal(body.video.thumbnail_url, expectedFallback);
      }
    });

    it("succeeds (201) and preserves custom thumbnail URL when provided", async () => {
      const vidId = `custom-thumb-url-${Date.now()}`;
      const customUrl = "/uploads/images/custom_cover_sample.jpg";

      const req = new Request("http://localhost:3000/api/videos/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          id: vidId,
          user_id: "FT483921",
          creator_name: "Alex Rivera",
          title: "Video With Custom Cover Image",
          description: "Testing custom cover preservation",
          video_url: "/uploads/videos/sample_custom_thumb.mp4",
          thumbnail_url: customUrl,
          video_type: "free",
          content_type: "short",
          category: "Coding",
          duration: "0:40",
        }),
      });

      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.video.thumbnail_url, customUrl);
    });

    it("processes base64 data:image thumbnail to disk cleanly when supplied", async () => {
      const vidId = `b64-thumb-${Date.now()}`;
      // Minimal 1x1 PNG bytes encoded as base64
      const tinyBase64 =
        "data:image/jpeg;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

      const req = new Request("http://localhost:3000/api/videos/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          id: vidId,
          user_id: "FT483921",
          creator_name: "Alex Rivera",
          title: "Video With Captured Base64 Cover",
          video_url: "/uploads/videos/sample_b64.mp4",
          thumbnail_url: tinyBase64,
          video_type: "free",
          content_type: "long",
          category: "Music",
        }),
      });

      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.video.thumbnail_url, `/uploads/images/thumb_${vidId}.jpg`);

      const savedPath = path.resolve(process.cwd(), "uploads", "images", `thumb_${vidId}.jpg`);
      createdDiskFiles.push(savedPath);
      const stat = await fs.stat(savedPath);
      assert.ok(stat.size > 0, "Saved thumbnail image file must be non-empty");
    });

    it("still rejects missing required title and video_url with HTTP 400", async () => {
      const noTitleReq = new Request("http://localhost:3000/api/videos/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          user_id: "FT483921",
          title: "   ",
          video_url: "/uploads/videos/sample.mp4",
        }),
      });
      const noTitleRes = await handleApiRequest(noTitleReq);
      assert.ok(noTitleRes);
      assert.equal(noTitleRes.status, 400);

      const noVideoReq = new Request("http://localhost:3000/api/videos/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          user_id: "FT483921",
          title: "Missing Video URL",
          video_url: "",
        }),
      });
      const noVideoRes = await handleApiRequest(noVideoReq);
      assert.ok(noVideoRes);
      assert.equal(noVideoRes.status, 400);
    });
  });

  describe("4. Client Video Service Helpers & API Contract Compatibility", () => {
    it("recordNewVideoUpload succeeds without thumbnailUrl and preserves API payload schema", async () => {
      let capturedUrl = "";
      let capturedPayload: Record<string, unknown> | null = null;

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedPayload = JSON.parse(String(init?.body || "{}"));
        return new Response(
          JSON.stringify({
            success: true,
            video: {
              id: capturedPayload?.["id"],
              thumbnail_url: capturedPayload?.["thumbnail_url"],
            },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch;

      const result = await recordNewVideoUpload({
        userId: "FT483921",
        creatorName: "Alex Rivera",
        title: "No Cover Video",
        description: "Uploaded without custom cover",
        videoUrl: "/uploads/videos/no_cover.mp4",
        thumbnailUrl: null,
        videoType: "free",
        contentType: "long",
        category: "Coding",
      });

      assert.ok(capturedUrl.endsWith("/videos/create.php"));
      assert.ok(capturedPayload);
      assert.equal(capturedPayload["thumbnail_url"], getCategoryFallbackThumbnail("Coding"));
      assert.equal(result.thumbnailUrl, getCategoryFallbackThumbnail("Coding"));
    });

    it("recordNewVideoUpload preserves custom thumbnailUrl and rejects missing videoUrl", async () => {
      let capturedPayload: Record<string, unknown> | null = null;

      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedPayload = JSON.parse(String(init?.body || "{}"));
        return new Response(
          JSON.stringify({
            success: true,
            video: {
              id: capturedPayload?.["id"],
              thumbnail_url: capturedPayload?.["thumbnail_url"],
            },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch;

      const customCover = "/uploads/images/my_cover_9_16.jpg";
      const result = await recordNewVideoUpload({
        userId: "FT483921",
        creatorName: "Alex Rivera",
        title: "Custom Cover Video",
        description: "With custom cover",
        videoUrl: "/uploads/videos/with_cover.mp4",
        thumbnailUrl: customCover,
        videoType: "free",
        contentType: "short",
        category: "Coding",
      });

      assert.equal(capturedPayload?.["thumbnail_url"], customCover);
      assert.equal(result.thumbnailUrl, customCover);

      await assert.rejects(
        () =>
          recordNewVideoUpload({
            userId: "FT483921",
            creatorName: "Alex Rivera",
            title: "Missing Video",
            description: "",
            videoUrl: "",
            videoType: "free",
            contentType: "short",
          }),
        /videoUrl is missing/i,
      );
    });

    it("uploadSingleBulkVideoItem succeeds both without and with a custom thumbnail file", async () => {
      const seenEndpoints: string[] = [];
      let lastCreateBody: Record<string, unknown> | null = null;

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        seenEndpoints.push(url);
        if (url.endsWith("/uploads/video.php")) {
          return new Response(
            JSON.stringify({ success: true, url: "/uploads/videos/bulk_vid.mp4", format: "mp4" }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/uploads/image.php")) {
          return new Response(
            JSON.stringify({ success: true, url: "/uploads/images/bulk_custom_cover.jpg" }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/videos/create.php")) {
          lastCreateBody = JSON.parse(String(init?.body || "{}"));
          return new Response(
            JSON.stringify({ success: true, video: { id: lastCreateBody?.["id"] } }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      }) as typeof fetch;

      // Case A: Without custom thumbnail
      const noThumbResult = await uploadSingleBulkVideoItem(
        {
          id: "item-no-thumb",
          file: new File(["video-bytes"], "lesson1.mp4", { type: "video/mp4" }),
          title: "Lesson 1",
          description: "",
          contentType: "long",
          category: "Education",
        },
        { userId: "FT483921", creatorName: "Alex Rivera" },
      );
      assert.equal(noThumbResult.thumbnailUrl, getCategoryFallbackThumbnail("Education"));
      assert.ok(seenEndpoints.some((u) => u.endsWith("/uploads/video.php")));
      assert.ok(seenEndpoints.some((u) => u.endsWith("/videos/create.php")));

      // Case B: With custom thumbnail file (uploads image & sends URL to create)
      seenEndpoints.length = 0;
      const withThumbResult = await uploadSingleBulkVideoItem(
        {
          id: "item-with-thumb",
          file: new File(["video-bytes"], "lesson2.mp4", { type: "video/mp4" }),
          title: "Lesson 2",
          description: "",
          contentType: "short",
          category: "Coding",
          customThumbnailFile: new File(["img-bytes"], "cover.jpg", { type: "image/jpeg" }),
        },
        { userId: "FT483921", creatorName: "Alex Rivera" },
      );
      assert.ok(seenEndpoints.some((u) => u.endsWith("/uploads/image.php")));
      assert.equal(withThumbResult.thumbnailUrl, "/uploads/images/bulk_custom_cover.jpg");
      assert.equal(lastCreateBody?.["thumbnail_url"], "/uploads/images/bulk_custom_cover.jpg");
    });
  });

  describe("5. Video Upload Validation, Security & PHP Parity Preservation", () => {
    it("continues rejecting invalid video files on client and server /api/uploads/video", async () => {
      const badFile = new File(["not a video"], "trojan.exe", { type: "application/x-msdownload" });
      assert.equal(validateVideoFileForUpload(badFile).valid, false);

      const formBad = new FormData();
      formBad.append("video", badFile);
      const resBad = await handleApiRequest(
        new Request("http://localhost:3000/api/uploads/video", { method: "POST", body: formBad }),
      );
      assert.ok(resBad);
      assert.equal(resBad.status, 400);

      const formEmpty = new FormData();
      formEmpty.append("video", new File([], "empty.mp4", { type: "video/mp4" }));
      const resEmpty = await handleApiRequest(
        new Request("http://localhost:3000/api/uploads/video", { method: "POST", body: formEmpty }),
      );
      assert.ok(resEmpty);
      assert.equal(resEmpty.status, 400);

      const resMissing = await handleApiRequest(
        new Request("http://localhost:3000/api/uploads/video", {
          method: "POST",
          body: new FormData(),
        }),
      );
      assert.ok(resMissing);
      assert.equal(resMissing.status, 400);
    });

    it("ensures api/videos/create.php sanitizes optional thumbnail_url and keeps required checks", async () => {
      const phpSource = await fs.readFile(
        path.resolve(process.cwd(), "api/videos/create.php"),
        "utf8",
      );
      assert.ok(phpSource.includes("is_string($rawThumbnailUrl)"));
      assert.ok(phpSource.includes("['null', 'undefined', 'nan']"));
      assert.ok(phpSource.includes("if (empty($title))"));
      assert.ok(phpSource.includes("if (empty($videoUrl))"));
      assert.ok(phpSource.includes("if (empty($thumbnailUrl)"));
    });
  });
});
