import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import {
  buildImageUploadRequest,
  CHANNEL_LOGO_MAX_BYTES,
  parseImageDimensionsFromBytes,
  validateChannelLogoDimensions,
  validateChannelLogoFile,
} from "../lib/channel-logo-validation.ts";
import { calculate9to16Crop, calculateSquareCrop } from "../lib/image-effects.ts";
import { handleApiRequest } from "./api-handler.ts";
import { setMysqlPoolForTesting } from "./mysql.ts";

function makePngWithDimensions(width: number, height: number): Uint8Array<ArrayBuffer> {
  const buf = Buffer.alloc(33);
  // PNG signature
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  // IHDR chunk length = 13
  buf.writeUInt32BE(13, 8);
  Buffer.from("IHDR", "ascii").copy(buf, 12);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8; // bit depth
  buf[25] = 6; // RGBA
  return new Uint8Array(buf);
}

function makeJpegWithDimensions(width: number, height: number): Uint8Array<ArrayBuffer> {
  // Minimal SOI + SOF0 marker segment with dimensions
  return new Uint8Array([
    0xff,
    0xd8, // SOI
    0xff,
    0xc0, // SOF0
    0x00,
    0x11, // length = 17
    0x08, // precision
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03, // components
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
    0xff,
    0xd9, // EOI
  ]);
}

function makeWebpVp8xWithDimensions(width: number, height: number): Uint8Array<ArrayBuffer> {
  const buf = Buffer.alloc(30);
  Buffer.from("RIFF", "ascii").copy(buf, 0);
  buf.writeUInt32LE(22, 4);
  Buffer.from("WEBP", "ascii").copy(buf, 8);
  Buffer.from("VP8X", "ascii").copy(buf, 12);
  buf.writeUInt32LE(10, 16);
  const wMinus1 = width - 1;
  const hMinus1 = height - 1;
  buf[24] = wMinus1 & 0xff;
  buf[25] = (wMinus1 >> 8) & 0xff;
  buf[26] = (wMinus1 >> 16) & 0xff;
  buf[27] = hMinus1 & 0xff;
  buf[28] = (hMinus1 >> 8) & 0xff;
  buf[29] = (hMinus1 >> 16) & 0xff;
  return new Uint8Array(buf);
}

function createSignedTestToken(userId: string): string {
  const secret = process.env["AUTH_SECRET"] || "facetube-jwt-secret-key-2026-production";
  const payload = Buffer.from(
    JSON.stringify({
      id: "usr-logo-test-1",
      user_id: userId,
      role: "user",
      email: "creator@facetube.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

describe("FaceTube Channel Logo Aspect Ratio & Upload Validation", () => {
  const createdFiles: string[] = [];

  after(() => {
    setMysqlPoolForTesting(null);
    for (const relPath of createdFiles) {
      const fullPath = path.resolve(process.cwd(), relPath.replace(/^\/+/, ""));
      if (fs.existsSync(fullPath)) {
        try {
          fs.unlinkSync(fullPath);
        } catch {
          // ignore cleanup failure
        }
      }
    }
  });

  it("1. Accepts 512x512 and other reasonable square dimensions for Channel Logo", () => {
    for (const size of [128, 256, 512, 640, 1024, 1080]) {
      const dimCheck = validateChannelLogoDimensions(size, size);
      assert.equal(dimCheck.valid, true, `${size}x${size} square logo must be accepted`);

      const pngDims = parseImageDimensionsFromBytes(makePngWithDimensions(size, size));
      assert.deepEqual(pngDims, { width: size, height: size });

      const jpgDims = parseImageDimensionsFromBytes(makeJpegWithDimensions(size, size));
      assert.deepEqual(jpgDims, { width: size, height: size });

      const webpDims = parseImageDimensionsFromBytes(makeWebpVp8xWithDimensions(size, size));
      assert.deepEqual(webpDims, { width: size, height: size });
    }

    // Also verifies non-square raw ratio fails with dedicated Channel Logo error (not 9:16 message)
    const vertical = validateChannelLogoDimensions(1080, 1920);
    assert.equal(vertical.valid, false);
    assert.match(vertical.error || "", /square \(1:1\)/i);
    assert.doesNotMatch(vertical.error || "", /9:16 vertical aspect ratio/i);

    const oversizeDim = validateChannelLogoDimensions(5000, 5000);
    assert.equal(oversizeDim.valid, false);
    assert.match(oversizeDim.error || "", /4096x4096/);
  });

  it("2. Rejects invalid file types and oversized files according to existing limits", () => {
    assert.equal(
      validateChannelLogoFile({ name: "logo.png", type: "image/png", size: 250_000 }).valid,
      true,
    );
    assert.equal(
      validateChannelLogoFile({ name: "logo.jpg", type: "image/jpeg", size: 250_000 }).valid,
      true,
    );
    assert.equal(
      validateChannelLogoFile({ name: "logo.webp", type: "image/webp", size: 250_000 }).valid,
      true,
    );

    const gifRes = validateChannelLogoFile({ name: "logo.gif", type: "image/gif", size: 1000 });
    assert.equal(gifRes.valid, false);
    assert.match(gifRes.error || "", /JPG, PNG, or WEBP/i);

    const svgRes = validateChannelLogoFile({
      name: "logo.svg",
      type: "image/svg+xml",
      size: 1000,
    });
    assert.equal(svgRes.valid, false);

    const pdfRes = validateChannelLogoFile({
      name: "doc.pdf",
      type: "application/pdf",
      size: 1000,
    });
    assert.equal(pdfRes.valid, false);

    const emptyRes = validateChannelLogoFile({
      name: "empty.png",
      type: "image/png",
      size: 0,
    });
    assert.equal(emptyRes.valid, false);

    const oversizedRes = validateChannelLogoFile({
      name: "huge.png",
      type: "image/png",
      size: CHANNEL_LOGO_MAX_BYTES + 1,
    });
    assert.equal(oversizedRes.valid, false);
    assert.match(oversizedRes.error || "", /10MB/);
  });

  it("3. Keeps Channel Logo upload request distinct from default 9:16 upload and preserves 9:16 validation", () => {
    const logoFile = new File([makePngWithDimensions(512, 512)], "avatar.png", {
      type: "image/png",
    });
    const logoReq = buildImageUploadRequest(logoFile, "channel_logo");
    assert.equal(logoReq.endpoint, "/uploads/image.php?purpose=channel_logo");
    const logoFormKeys = Array.from(logoReq.formData.keys());
    assert.deepEqual(logoFormKeys, ["purpose", "image"]);
    assert.equal(logoReq.formData.get("purpose"), "channel_logo");

    const stdFile = new File([makePngWithDimensions(1080, 1920)], "post.png", {
      type: "image/png",
    });
    const stdReq = buildImageUploadRequest(stdFile, "default");
    assert.equal(stdReq.endpoint, "/uploads/image.php");
    assert.equal(stdReq.formData.get("purpose"), null);

    // Client crop helpers remain cleanly separated
    const sqCrop = calculateSquareCrop(512, 512, 512);
    assert.equal(sqCrop.isAlreadySquare, true);
    assert.equal(sqCrop.targetSize, 512);

    const crop916 = calculate9to16Crop(512, 512);
    assert.equal(crop916.isAlready9to16, false);
    assert.equal(crop916.targetWidth, 1080);
    assert.equal(crop916.targetHeight, 1920);

    // PHP endpoint separates channel_logo square check from strict 9:16 branch
    const imagePhp = fs.readFileSync(path.resolve(process.cwd(), "api/uploads/image.php"), "utf-8");
    assert.match(
      imagePhp,
      /\$rawPostPurpose\s*!==\s*''\s*\?\s*\$rawPostPurpose\s*:\s*\(\$rawGetPurpose/,
    );
    assert.match(imagePhp, /if\s*\(\$isChannelLogo\)\s*\{[\s\S]*?Channel logo must be a square/);
    assert.match(
      imagePhp,
      /\}\s*else\s*\{\s*\/\/\s*Enforce 9:16 aspect ratio for standard image uploads[\s\S]*?strictly be in 9:16 vertical aspect ratio/,
    );
  });

  it("4. End-to-end Node upload (512x512 & 1024x1024 accepted, invalid/oversized/non-square rejected) + Save Changes flow", async () => {
    const prodTestEnv = {
      APP_ENV: "production",
      NODE_ENV: "test",
    };

    let savedLogoUrl: string | null = "/uploads/logos/initial.png";
    let savedChannelName = "Initial Channel";
    let savedChannelDesc: string | null = "Initial Bio";

    const mockPool = {
      query: async (sql: string, params: unknown[] = []) => {
        if (/SELECT[\s\S]*FROM\s+sessions\s+s[\s\S]*INNER\s+JOIN\s+users\s+u/i.test(sql)) {
          return [
            [
              {
                id: "usr-logo-test-1",
                user_id: "FT900001",
                name: "Test Creator",
                mobile: "+1 555-010-9001",
                email: "creator@facetube.com",
                role: "user",
                referral_code: "TEST9001",
                avatar_url: null,
                channel_logo_url: savedLogoUrl,
                channel_name: savedChannelName,
                channel_description: savedChannelDesc,
                created_at: new Date().toISOString(),
              },
            ],
            [],
          ];
        }
        if (/SELECT[\s\S]*FROM\s+users[\s\S]*LIMIT 1/i.test(sql)) {
          if (
            /channel_logo_url,\s*channel_name,\s*channel_description/i.test(sql) &&
            !/id,\s*user_id/i.test(sql)
          ) {
            return [
              [
                {
                  channel_logo_url: savedLogoUrl,
                  channel_name: savedChannelName,
                  channel_description: savedChannelDesc,
                },
              ],
              [],
            ];
          }
          return [
            [
              {
                id: "usr-logo-test-1",
                user_id: "FT900001",
                name: "Test Creator",
                email: "creator@facetube.com",
                role: "user",
                channel_logo_url: savedLogoUrl,
                channel_name: savedChannelName,
                channel_description: savedChannelDesc,
              },
            ],
            [],
          ];
        }
        if (/UPDATE\s+users\s+SET/i.test(sql)) {
          let idx = 0;
          if (/channel_logo_url\s*=\s*\?/i.test(sql)) {
            savedLogoUrl = (params[idx++] as string | null) ?? null;
          }
          if (/channel_name\s*=\s*\?/i.test(sql)) {
            savedChannelName = String(params[idx++] || savedChannelName);
          }
          if (/channel_description\s*=\s*\?/i.test(sql)) {
            savedChannelDesc = (params[idx++] as string | null) ?? null;
          }
          return [{ affectedRows: 1 }, []];
        }
        return [[], []];
      },
    };

    const prevDbHost = process.env["DB_HOST"];
    const prevDbName = process.env["DB_NAME"];
    const prevDbUser = process.env["DB_USER"];
    process.env["DB_HOST"] = "127.0.0.1";
    process.env["DB_NAME"] = "facetube_test";
    process.env["DB_USER"] = "test_user";
    setMysqlPoolForTesting(mockPool as any);

    try {
      const token = createSignedTestToken("FT900001");

      // 4a. Upload 512x512 PNG via ?purpose=channel_logo (even without FormData purpose field!)
      const fd512 = new FormData();
      fd512.append(
        "image",
        new File([makePngWithDimensions(512, 512)], "logo512.png", { type: "image/png" }),
      );
      const res512 = await handleApiRequest(
        new Request("http://localhost:3000/api/uploads/image.php?purpose=channel_logo", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: fd512,
        }),
        prodTestEnv,
      );
      assert.ok(res512);
      assert.equal(res512.status, 201);
      const data512 = (await res512.json()) as any;
      assert.equal(data512.success, true);
      assert.match(data512.url, /^\/uploads\/logos\/logo_.*\.png$/);
      createdFiles.push(data512.url);

      // 4b. Upload 1024x1024 WEBP channel logo
      const fd1024 = new FormData();
      fd1024.append("purpose", "channel_logo");
      fd1024.append(
        "image",
        new File([makeWebpVp8xWithDimensions(1024, 1024)], "logo1024.webp", { type: "image/webp" }),
      );
      const res1024 = await handleApiRequest(
        new Request("http://localhost:3000/api/uploads/image.php?purpose=channel_logo", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: fd1024,
        }),
        prodTestEnv,
      );
      assert.ok(res1024);
      assert.equal(res1024.status, 201);
      const data1024 = (await res1024.json()) as any;
      assert.match(data1024.url, /^\/uploads\/logos\/logo_.*\.webp$/);
      createdFiles.push(data1024.url);

      // 4c. Reject invalid file extension (.gif)
      const fdGif = new FormData();
      fdGif.append("purpose", "channel_logo");
      fdGif.append(
        "image",
        new File([new Uint8Array(Buffer.from("GIF89a"))], "bad.gif", { type: "image/gif" }),
      );
      const resGif = await handleApiRequest(
        new Request("http://localhost:3000/api/uploads/image.php?purpose=channel_logo", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: fdGif,
        }),
        prodTestEnv,
      );
      assert.ok(resGif);
      assert.equal(resGif.status, 400);

      // 4d. Reject oversized channel logo (> 10MB)
      const hugePng = new Uint8Array(CHANNEL_LOGO_MAX_BYTES + 1024);
      hugePng.set(makePngWithDimensions(512, 512), 0);
      const fdHuge = new FormData();
      fdHuge.append("purpose", "channel_logo");
      fdHuge.append("image", new File([hugePng], "huge.png", { type: "image/png" }));
      const resHuge = await handleApiRequest(
        new Request("http://localhost:3000/api/uploads/image.php?purpose=channel_logo", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: fdHuge,
        }),
        prodTestEnv,
      );
      assert.ok(resHuge);
      assert.equal(resHuge.status, 400);

      // 4e. Reject raw 9:16 vertical image if sent directly as channel_logo
      const fdRect = new FormData();
      fdRect.append("purpose", "channel_logo");
      fdRect.append(
        "image",
        new File([makePngWithDimensions(1080, 1920)], "vertical.png", { type: "image/png" }),
      );
      const resRect = await handleApiRequest(
        new Request("http://localhost:3000/api/uploads/image.php?purpose=channel_logo", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: fdRect,
        }),
        prodTestEnv,
      );
      assert.ok(resRect);
      assert.equal(resRect.status, 400);
      const rectData = (await resRect.json()) as any;
      assert.match(rectData.error || "", /square \(1:1\)/i);

      // 4f. Default standard 9:16 upload remains intact (/uploads/images/)
      const fdStd916 = new FormData();
      fdStd916.append(
        "image",
        new File([makePngWithDimensions(1080, 1920)], "story916.png", { type: "image/png" }),
      );
      const resStd916 = await handleApiRequest(
        new Request("http://localhost:3000/api/uploads/image.php", {
          method: "POST",
          body: fdStd916,
        }),
        prodTestEnv,
      );
      assert.ok(resStd916);
      assert.equal(resStd916.status, 201);
      const stdData = (await resStd916.json()) as any;
      assert.match(stdData.url, /^\/uploads\/images\/img_.*\.png$/);
      createdFiles.push(stdData.url);

      // 4g. Save Changes flow persists uploaded 512x512 logo URL + channel branding
      const saveRes = await handleApiRequest(
        new Request("http://localhost:3000/api/users/channel-logo.php", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            userId: "FT900001",
            channelLogoUrl: data512.url,
            channelName: "Square Studio",
            channelDescription: "Updated channel bio",
          }),
        }),
        prodTestEnv,
      );
      assert.ok(saveRes);
      assert.equal(saveRes.status, 200);
      const saveData = (await saveRes.json()) as any;
      assert.equal(saveData.success, true);
      assert.equal(saveData.channel_logo_url, data512.url);
      assert.equal(saveData.channel_name, "Square Studio");
      assert.equal(saveData.channel_description, "Updated channel bio");
    } finally {
      if (prevDbHost !== undefined) process.env["DB_HOST"] = prevDbHost;
      else delete process.env["DB_HOST"];
      if (prevDbName !== undefined) process.env["DB_NAME"] = prevDbName;
      else delete process.env["DB_NAME"];
      if (prevDbUser !== undefined) process.env["DB_USER"] = prevDbUser;
      else delete process.env["DB_USER"];
      setMysqlPoolForTesting(null);
    }
  });
});
