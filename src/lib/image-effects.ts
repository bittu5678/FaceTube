/**
 * Non-destructive Image Effects & Filters for FaceTube Image Upload.
 * Live preview uses CSS filters; final export renders onto an offscreen canvas at full resolution.
 */

export type ImageFilterId = "original" | "bright" | "warm" | "cool" | "vintage" | "bw" | "sepia";

export interface ImageFilterOption {
  id: ImageFilterId;
  label: string;
  cssFilter: string;
}

export const IMAGE_FILTERS: ImageFilterOption[] = [
  { id: "original", label: "Original", cssFilter: "none" },
  { id: "bright", label: "Bright", cssFilter: "brightness(1.18) contrast(1.06)" },
  { id: "warm", label: "Warm", cssFilter: "sepia(0.25) saturate(1.25) brightness(1.05)" },
  {
    id: "cool",
    label: "Cool",
    cssFilter: "contrast(1.05) saturate(0.9) hue-rotate(-12deg) brightness(1.03)",
  },
  {
    id: "vintage",
    label: "Vintage",
    cssFilter: "sepia(0.45) contrast(0.92) brightness(0.95) saturate(0.85)",
  },
  { id: "bw", label: "Black & White", cssFilter: "grayscale(1) contrast(1.1)" },
  { id: "sepia", label: "Sepia", cssFilter: "sepia(0.85) contrast(1.05)" },
];

export function getImageFilterCss(filterId: ImageFilterId): string {
  return IMAGE_FILTERS.find((f) => f.id === filterId)?.cssFilter ?? "none";
}

/**
 * Renders the original image file with the selected CSS filter onto an offscreen canvas,
 * preserving natural aspect ratio and high quality. Returns the original file unchanged if "original".
 */
export async function renderFilteredImageToFile(
  originalFile: File,
  filterId: ImageFilterId,
): Promise<File> {
  if (filterId === "original") return originalFile;
  const cssFilter = getImageFilterCss(filterId);
  if (cssFilter === "none") return originalFile;

  return new Promise((resolve) => {
    const img = new window.Image();
    const objectUrl = URL.createObjectURL(originalFile);

    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          URL.revokeObjectURL(objectUrl);
          resolve(originalFile);
          return;
        }
        ctx.filter = cssFilter;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        const mimeType =
          originalFile.type === "image/png" || originalFile.type === "image/webp"
            ? originalFile.type
            : "image/jpeg";

        canvas.toBlob(
          (blob) => {
            URL.revokeObjectURL(objectUrl);
            if (!blob) {
              resolve(originalFile);
              return;
            }
            const ext =
              mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
            const baseName = originalFile.name.replace(/\.[^/.]+$/, "");
            resolve(new File([blob], `${baseName}_${filterId}.${ext}`, { type: mimeType }));
          },
          mimeType,
          0.92,
        );
      } catch {
        URL.revokeObjectURL(objectUrl);
        resolve(originalFile);
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(originalFile);
    };

    img.src = objectUrl;
  });
}

export interface CropCalculationResult {
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  targetWidth: number;
  targetHeight: number;
  isAlready9to16: boolean;
  aspectRatio: number;
}

/**
 * Calculates proportional center-crop box to transform an image of any dimensions
 * into strict 9:16 vertical aspect ratio without stretching or distortion.
 */
export function calculate9to16Crop(
  srcWidth: number,
  srcHeight: number,
  targetWidth = 1080,
  targetHeight = 1920,
): CropCalculationResult {
  if (srcWidth <= 0 || srcHeight <= 0) {
    return {
      cropX: 0,
      cropY: 0,
      cropWidth: targetWidth,
      cropHeight: targetHeight,
      targetWidth,
      targetHeight,
      isAlready9to16: false,
      aspectRatio: targetWidth / targetHeight,
    };
  }

  const currentRatio = srcWidth / srcHeight;
  const targetRatio = targetWidth / targetHeight; // 9 / 16 = 0.5625
  const isAlready9to16 = Math.abs(currentRatio - targetRatio) <= 0.01;

  let cropX = 0;
  let cropY = 0;
  let cropWidth = srcWidth;
  let cropHeight = srcHeight;

  if (currentRatio > targetRatio) {
    // Image is wider than 9:16 (landscape, square, etc.)
    // Full height, crop horizontal edges symmetrically (center-crop)
    cropHeight = srcHeight;
    cropWidth = Math.round(srcHeight * targetRatio);
    cropX = Math.max(0, Math.round((srcWidth - cropWidth) / 2));
    cropY = 0;
  } else if (currentRatio < targetRatio) {
    // Image is taller than 9:16 (ultra-tall portrait)
    // Full width, crop vertical edges symmetrically (center-crop)
    cropWidth = srcWidth;
    cropHeight = Math.round(srcWidth / targetRatio);
    cropX = 0;
    cropY = Math.max(0, Math.round((srcHeight - cropHeight) / 2));
  } else {
    // Already 9:16 ratio
    cropX = 0;
    cropY = 0;
    cropWidth = srcWidth;
    cropHeight = srcHeight;
  }

  return {
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    targetWidth,
    targetHeight,
    isAlready9to16,
    aspectRatio: targetRatio,
  };
}

/**
 * Proportional 9:16 Center-Crop & Resize Utility for HTML5 Canvas.
 * Automatically crops and resizes any selected image to exactly 1080x1920 (9:16)
 * without stretching, preserving subject clarity and exporting to high-quality JPEG/PNG/WebP.
 */
export async function cropAndResizeTo9to16(
  file: File,
  targetWidth = 1080,
  targetHeight = 1920,
): Promise<File> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return file;
  }

  return new Promise((resolve) => {
    const img = new window.Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      try {
        const srcW = img.naturalWidth;
        const srcH = img.naturalHeight;

        if (srcW <= 0 || srcH <= 0) {
          URL.revokeObjectURL(objectUrl);
          resolve(file);
          return;
        }

        const crop = calculate9to16Crop(srcW, srcH, targetWidth, targetHeight);

        // If the image is ALREADY exactly target dimensions (e.g. 1080x1920 portrait),
        // return the original file directly without unnecessary re-encoding.
        if (crop.isAlready9to16 && srcW === targetWidth && srcH === targetHeight) {
          URL.revokeObjectURL(objectUrl);
          resolve(file);
          return;
        }

        const canvas = document.createElement("canvas");
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          URL.revokeObjectURL(objectUrl);
          resolve(file);
          return;
        }

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";

        const mimeType =
          file.type === "image/png"
            ? "image/png"
            : file.type === "image/webp"
              ? "image/webp"
              : "image/jpeg";

        if (mimeType === "image/jpeg") {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, targetWidth, targetHeight);
        }

        ctx.drawImage(
          img,
          crop.cropX,
          crop.cropY,
          crop.cropWidth,
          crop.cropHeight,
          0,
          0,
          targetWidth,
          targetHeight,
        );

        canvas.toBlob(
          (blob) => {
            URL.revokeObjectURL(objectUrl);
            if (!blob) {
              resolve(file);
              return;
            }

            const ext =
              mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
            const baseName = file.name.replace(/\.[^/.]+$/, "");
            const newFileName = `${baseName}_9x16.${ext}`;
            const processedFile = new File([blob], newFileName, {
              type: mimeType,
              lastModified: Date.now(),
            });

            resolve(processedFile);
          },
          mimeType,
          0.92,
        );
      } catch (err) {
        URL.revokeObjectURL(objectUrl);
        console.error("Error cropping image to 9:16:", err);
        resolve(file);
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(file);
    };

    img.src = objectUrl;
  });
}

export interface SquareCropCalculationResult {
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  targetSize: number;
  isAlreadySquare: boolean;
}

/**
 * Calculates proportional 1:1 square center-crop box for channel logo uploads
 * without stretching or distortion.
 */
export function calculateSquareCrop(
  srcWidth: number,
  srcHeight: number,
  targetSize = 512,
): SquareCropCalculationResult {
  if (srcWidth <= 0 || srcHeight <= 0) {
    return {
      cropX: 0,
      cropY: 0,
      cropWidth: targetSize,
      cropHeight: targetSize,
      targetSize,
      isAlreadySquare: false,
    };
  }

  const side = Math.min(srcWidth, srcHeight);
  const cropX = Math.max(0, Math.round((srcWidth - side) / 2));
  const cropY = Math.max(0, Math.round((srcHeight - side) / 2));
  const isAlreadySquare = Math.abs(srcWidth - srcHeight) <= 1;

  return {
    cropX,
    cropY,
    cropWidth: side,
    cropHeight: side,
    targetSize,
    isAlreadySquare,
  };
}

/**
 * Proportional 1:1 Square Center-Crop & Resize Utility for Channel Logos.
 * Preserves PNG/WebP transparency and outputs a clean square logo image (default 512x512).
 */
export async function cropAndResizeToSquare(file: File, targetSize = 512): Promise<File> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return file;
  }

  return new Promise((resolve) => {
    const img = new window.Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      try {
        const srcW = img.naturalWidth;
        const srcH = img.naturalHeight;

        if (srcW <= 0 || srcH <= 0) {
          URL.revokeObjectURL(objectUrl);
          resolve(file);
          return;
        }

        const crop = calculateSquareCrop(srcW, srcH, targetSize);

        if (crop.isAlreadySquare && srcW <= targetSize && srcH <= targetSize) {
          URL.revokeObjectURL(objectUrl);
          resolve(file);
          return;
        }

        const outputSize = Math.min(targetSize, crop.cropWidth);
        const canvas = document.createElement("canvas");
        canvas.width = outputSize;
        canvas.height = outputSize;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          URL.revokeObjectURL(objectUrl);
          resolve(file);
          return;
        }

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";

        const mimeType =
          file.type === "image/png"
            ? "image/png"
            : file.type === "image/webp"
              ? "image/webp"
              : "image/jpeg";

        if (mimeType === "image/jpeg") {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, outputSize, outputSize);
        }

        ctx.drawImage(
          img,
          crop.cropX,
          crop.cropY,
          crop.cropWidth,
          crop.cropHeight,
          0,
          0,
          outputSize,
          outputSize,
        );

        canvas.toBlob(
          (blob) => {
            URL.revokeObjectURL(objectUrl);
            if (!blob) {
              resolve(file);
              return;
            }

            const ext =
              mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
            const baseName = file.name.replace(/\.[^/.]+$/, "");
            const newFileName = `${baseName}_logo.${ext}`;
            resolve(
              new File([blob], newFileName, {
                type: mimeType,
                lastModified: Date.now(),
              }),
            );
          },
          mimeType,
          0.92,
        );
      } catch (err) {
        URL.revokeObjectURL(objectUrl);
        console.error("Error cropping channel logo to square:", err);
        resolve(file);
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(file);
    };

    img.src = objectUrl;
  });
}

