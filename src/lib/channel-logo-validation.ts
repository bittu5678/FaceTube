export const CHANNEL_LOGO_MAX_BYTES = 10 * 1024 * 1024; // 10MB
export const CHANNEL_LOGO_MAX_DIMENSION = 4096;
export const CHANNEL_LOGO_ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
] as const;
export const CHANNEL_LOGO_ALLOWED_EXTENSIONS = ["jpg", "jpeg", "png", "webp"] as const;

export interface ChannelLogoFileLike {
  name?: string;
  type?: string;
  size: number;
}

export interface ChannelLogoValidationResult {
  valid: boolean;
  error?: string;
}

export function validateChannelLogoFile(file: ChannelLogoFileLike): ChannelLogoValidationResult {
  const mime = String(file.type || "")
    .trim()
    .toLowerCase();
  const fileName = String(file.name || "").trim();
  const extMatch = fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  const ext = extMatch?.[1] ?? "";

  const hasAllowedMime = (CHANNEL_LOGO_ALLOWED_MIME_TYPES as readonly string[]).includes(mime);
  const hasAllowedExt = (CHANNEL_LOGO_ALLOWED_EXTENSIONS as readonly string[]).includes(ext);

  if (mime) {
    if (!hasAllowedMime) {
      return {
        valid: false,
        error: "Please upload a JPG, PNG, or WEBP image for channel logo.",
      };
    }
    if (ext && !hasAllowedExt) {
      return {
        valid: false,
        error: "Please upload a JPG, PNG, or WEBP image for channel logo.",
      };
    }
  } else if (!hasAllowedExt) {
    return {
      valid: false,
      error: "Please upload a JPG, PNG, or WEBP image for channel logo.",
    };
  }

  if (!Number.isFinite(file.size) || file.size <= 0) {
    return {
      valid: false,
      error: "Channel logo image file is empty.",
    };
  }

  if (file.size > CHANNEL_LOGO_MAX_BYTES) {
    return {
      valid: false,
      error: "Image file size cannot exceed 10MB.",
    };
  }

  return { valid: true };
}

export function validateChannelLogoDimensions(
  width: number,
  height: number,
): ChannelLogoValidationResult {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return {
      valid: false,
      error: "Invalid channel logo image dimensions.",
    };
  }

  if (width > CHANNEL_LOGO_MAX_DIMENSION || height > CHANNEL_LOGO_MAX_DIMENSION) {
    return {
      valid: false,
      error: `Channel logo dimensions exceed maximum allowed size (${CHANNEL_LOGO_MAX_DIMENSION}x${CHANNEL_LOGO_MAX_DIMENSION}). Current dimensions: ${width}x${height}.`,
    };
  }

  const ratio = width / height;
  if (Math.abs(ratio - 1.0) > 0.08) {
    return {
      valid: false,
      error: `Channel logo must be a square (1:1) image (e.g. 512x512). Current dimensions: ${width}x${height}.`,
    };
  }

  return { valid: true };
}

export function buildImageUploadRequest(
  processedFile: File,
  purpose: "default" | "channel_logo" = "default",
): { endpoint: string; formData: FormData } {
  const formData = new FormData();
  if (purpose === "channel_logo") {
    // Append purpose BEFORE binary file field and include query parameter so PHP/Node always receive it
    formData.append("purpose", "channel_logo");
    formData.append("image", processedFile);
    return {
      endpoint: "/uploads/image.php?purpose=channel_logo",
      formData,
    };
  }

  formData.append("image", processedFile);
  return {
    endpoint: "/uploads/image.php",
    formData,
  };
}

export function parseImageDimensionsFromBytes(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  if (!bytes || bytes.length < 12) return null;

  // PNG: 8-byte signature + IHDR chunk (width at 16..19, height at 20..23 big-endian)
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[12] === 0x49 &&
    bytes[13] === 0x48 &&
    bytes[14] === 0x44 &&
    bytes[15] === 0x52
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    if (width > 0 && height > 0) return { width, height };
  }

  // WEBP: RIFF....WEBP followed by VP8 / VP8L / VP8X
  if (
    bytes.length >= 30 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    const c0 = bytes[12];
    const c1 = bytes[13];
    const c2 = bytes[14];
    const c3 = bytes[15];
    // VP8X (extended): width-1 at 24..26 (24-bit LE), height-1 at 27..29 (24-bit LE)
    if (c0 === 0x56 && c1 === 0x50 && c2 === 0x38 && c3 === 0x58 && bytes.length >= 30) {
      const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
      const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
      return { width, height };
    }
    // VP8L (lossless): signature byte 0x2f at offset 20, packed 14-bit width-1 & height-1 at 21..24
    if (
      c0 === 0x56 &&
      c1 === 0x50 &&
      c2 === 0x38 &&
      c3 === 0x4c &&
      bytes.length >= 25 &&
      bytes[20] === 0x2f
    ) {
      const b0 = bytes[21]!;
      const b1 = bytes[22]!;
      const b2 = bytes[23]!;
      const b3 = bytes[24]!;
      const width = 1 + (b0 | ((b1 & 0x3f) << 8));
      const height = 1 + (((b1 & 0xc0) >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10));
      return { width, height };
    }
    // VP8 (lossy): frame start code 0x9d 0x01 0x2a at offset 23..25, width/height 16-bit LE at 26..29
    if (
      c0 === 0x56 &&
      c1 === 0x50 &&
      c2 === 0x38 &&
      c3 === 0x20 &&
      bytes.length >= 30 &&
      bytes[23] === 0x9d &&
      bytes[24] === 0x01 &&
      bytes[25] === 0x2a
    ) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const width = view.getUint16(26, true) & 0x3fff;
      const height = view.getUint16(28, true) & 0x3fff;
      if (width > 0 && height > 0) return { width, height };
    }
  }

  // JPEG: SOI (0xFF 0xD8), walk markers until SOF0..SOF3/SOF5..SOF7/SOF9..SOF11/SOF13..SOF15
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      while (offset < bytes.length && bytes[offset] === 0xff) {
        offset += 1;
      }
      if (offset >= bytes.length) break;
      const marker = bytes[offset]!;
      offset += 1;

      if (marker === 0xd9 || marker === 0xda) break; // EOI or SOS
      if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        continue;
      }
      if (offset + 1 >= bytes.length) break;
      const segmentLen = (bytes[offset]! << 8) | bytes[offset + 1]!;
      if (segmentLen < 2) break;

      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSof && offset + 7 < bytes.length) {
        const height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!;
        const width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
        if (width > 0 && height > 0) return { width, height };
      }

      offset += segmentLen;
    }
  }

  return null;
}
