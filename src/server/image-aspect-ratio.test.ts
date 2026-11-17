import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calculate9to16Crop } from "../lib/image-effects.ts";

describe("FaceTube: Image Upload Aspect Ratio (Strict 9:16) Tests", () => {
  const TARGET_WIDTH = 1080;
  const TARGET_HEIGHT = 1920;
  const TARGET_RATIO = TARGET_WIDTH / TARGET_HEIGHT; // 0.5625 (9:16)
  const TOLERANCE = 0.08; // backend tolerance from api/uploads/image.php line 49

  // Helper simulating the exact PHP backend validation logic in api/uploads/image.php
  function validateBackendImageRatio(
    width: number,
    height: number,
  ): {
    valid: boolean;
    ratio: number;
    targetRatio: number;
    error?: string;
  } {
    if (width <= 0 || height <= 0) {
      return { valid: false, ratio: 0, targetRatio: 9 / 16, error: "Invalid dimensions" };
    }
    const ratio = width / height;
    const target = 9 / 16;
    if (Math.abs(ratio - target) > TOLERANCE) {
      return {
        valid: false,
        ratio,
        targetRatio: target,
        error: `Image must strictly be in 9:16 vertical aspect ratio (e.g. 1080x1920). Current dimensions: ${width}x${height}.`,
      };
    }
    return { valid: true, ratio, targetRatio: target };
  }

  // Test Case 1: 640×360 landscape image -> crop and upload as 9:16
  describe("Test Case 1: 640×360 Landscape Image", () => {
    it("correctly calculates proportional center-crop to 9:16 without distortion", () => {
      const srcW = 640;
      const srcH = 360;
      const crop = calculate9to16Crop(srcW, srcH, TARGET_WIDTH, TARGET_HEIGHT);

      // Landscape: image is wider than 9:16 (ratio 1.777 > 0.5625)
      assert.equal(
        crop.isAlready9to16,
        false,
        "Landscape image must not be flagged as already 9:16",
      );
      assert.equal(crop.cropHeight, 360, "Must preserve full height of source image");
      // Crop width = round(360 * 9 / 16) = 203
      assert.equal(crop.cropWidth, Math.round(360 * (9 / 16)), "Crop width must be 203px");
      // Crop X = (640 - 203) / 2 = 219 (symmetrically centered)
      assert.equal(
        crop.cropX,
        Math.round((640 - crop.cropWidth) / 2),
        "Crop must be centered horizontally",
      );
      assert.equal(crop.cropY, 0, "Vertical offset must be 0 for landscape");

      // Target canvas output
      assert.equal(crop.targetWidth, 1080, "Target width must be 1080");
      assert.equal(crop.targetHeight, 1920, "Target height must be 1920");

      // Verify the resulting target output satisfies backend validation
      const backendCheck = validateBackendImageRatio(crop.targetWidth, crop.targetHeight);
      assert.equal(backendCheck.valid, true, "Target 1080x1920 must pass backend ratio check");
      assert.equal(backendCheck.ratio, 9 / 16, "Aspect ratio must be exact 9:16 (0.5625)");
    });
  });

  // Test Case 2: 1080×1920 portrait image -> upload successfully without unnecessary cropping
  describe("Test Case 2: 1080×1920 Portrait Image", () => {
    it("detects exact 9:16 portrait image and preserves full dimensions without cropping", () => {
      const srcW = 1080;
      const srcH = 1920;
      const crop = calculate9to16Crop(srcW, srcH, TARGET_WIDTH, TARGET_HEIGHT);

      assert.equal(crop.isAlready9to16, true, "1080x1920 must be recognized as already 9:16");
      assert.equal(crop.cropX, 0, "Must not offset horizontally");
      assert.equal(crop.cropY, 0, "Must not offset vertically");
      assert.equal(crop.cropWidth, 1080, "Must keep full 1080 width");
      assert.equal(crop.cropHeight, 1920, "Must keep full 1920 height");
      assert.equal(crop.targetWidth, 1080);
      assert.equal(crop.targetHeight, 1920);

      const backendCheck = validateBackendImageRatio(crop.targetWidth, crop.targetHeight);
      assert.equal(backendCheck.valid, true, "1080x1920 must pass backend ratio check");
    });
  });

  // Test Case 3: 1000×1000 square image -> crop and upload as 9:16
  describe("Test Case 3: 1000×1000 Square Image", () => {
    it("correctly center-crops square image to 9:16 without distortion", () => {
      const srcW = 1000;
      const srcH = 1000;
      const crop = calculate9to16Crop(srcW, srcH, TARGET_WIDTH, TARGET_HEIGHT);

      assert.equal(crop.isAlready9to16, false, "Square image must not be flagged as already 9:16");
      assert.equal(crop.cropHeight, 1000, "Must preserve full height of square image");
      // Crop width = round(1000 * 9 / 16) = 563
      assert.equal(crop.cropWidth, Math.round(1000 * (9 / 16)), "Crop width must be 563px");
      // Crop X = (1000 - 563) / 2 = 219 (symmetrically centered)
      assert.equal(
        crop.cropX,
        Math.round((1000 - crop.cropWidth) / 2),
        "Crop must be centered horizontally",
      );
      assert.equal(crop.cropY, 0, "Vertical offset must be 0");

      assert.equal(crop.targetWidth, 1080);
      assert.equal(crop.targetHeight, 1920);

      const backendCheck = validateBackendImageRatio(crop.targetWidth, crop.targetHeight);
      assert.equal(backendCheck.valid, true, "Target 1080x1920 must pass backend ratio check");
      assert.equal(backendCheck.ratio, 9 / 16);
    });
  });

  // Test Case 4: Verify the actual uploaded file dimensions are exactly 9:16
  describe("Test Case 4: Output Dimensions Strict 9:16 Verification", () => {
    it("ensures all cropped image variants produce exactly 1080x1920 (ratio 0.5625)", () => {
      const testInputs = [
        { width: 640, height: 360, label: "Landscape 16:9" },
        { width: 1920, height: 1080, label: "Full HD Landscape" },
        { width: 1000, height: 1000, label: "Square 1:1" },
        { width: 720, height: 1280, label: "HD Vertical 9:16" },
        { width: 500, height: 1200, label: "Ultra-tall Portrait" },
      ];

      for (const input of testInputs) {
        const crop = calculate9to16Crop(input.width, input.height, TARGET_WIDTH, TARGET_HEIGHT);
        assert.equal(crop.targetWidth, 1080, `${input.label} must produce targetWidth 1080`);
        assert.equal(crop.targetHeight, 1920, `${input.label} must produce targetHeight 1920`);
        const ratio = crop.targetWidth / crop.targetHeight;
        assert.equal(ratio, TARGET_RATIO, `${input.label} ratio must equal exactly 9/16`);
        assert.ok(Math.abs(ratio - TARGET_RATIO) <= 0.0001);
      }
    });
  });

  // Test Case 5: Confirm existing backend still rejects images that bypass frontend processing
  describe("Test Case 5: Backend Rejection of Bypassed Images", () => {
    it("rejects 640x360 landscape image that bypasses frontend cropping", () => {
      const check = validateBackendImageRatio(640, 360);
      assert.equal(check.valid, false, "Backend must reject uncropped 640x360 image");
      assert.ok(check.error?.includes("Image must strictly be in 9:16 vertical aspect ratio"));
      assert.ok(check.error?.includes("640x360"));
      assert.ok(Math.abs(check.ratio - TARGET_RATIO) > TOLERANCE);
    });

    it("rejects 1000x1000 square image that bypasses frontend cropping", () => {
      const check = validateBackendImageRatio(1000, 1000);
      assert.equal(check.valid, false, "Backend must reject uncropped 1000x1000 image");
      assert.ok(check.error?.includes("Image must strictly be in 9:16 vertical aspect ratio"));
      assert.ok(check.error?.includes("1000x1000"));
      assert.ok(Math.abs(check.ratio - TARGET_RATIO) > TOLERANCE);
    });

    it("rejects 1920x1080 landscape image that bypasses frontend cropping", () => {
      const check = validateBackendImageRatio(1920, 1080);
      assert.equal(check.valid, false, "Backend must reject uncropped 1920x1080 image");
      assert.ok(check.error?.includes("Image must strictly be in 9:16 vertical aspect ratio"));
    });

    it("accepts authentic 1080x1920 image when processed or compliant", () => {
      const check = validateBackendImageRatio(1080, 1920);
      assert.equal(check.valid, true, "Backend must accept 1080x1920 image");
      assert.equal(check.error, undefined);
    });
  });
});
