/** Header-only image dimensions for receipt qualification; no image bytes are logged.
 * This checks format/dimension headers, not pixel decoding, checksums or content
 * identity. The receipt boundary guards CLI denial/loss, not adversarial swaps.
 */
export interface ReceiptImageHeader {
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  width: number;
  height: number;
}

export function receiptImageHeader(block: any): ReceiptImageHeader | null {
  const data = block?.data;
  if (block?.sourceType !== "base64" || typeof data !== "string" || data.length % 4 !== 0) return null;
  // A repeated capture-group regexp over large image data overflows V8's
  // regexp stack. Validate the alphabet in one linear scan, without a size cap.
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  if (/[^A-Za-z0-9+/]/.test(data.slice(0, data.length - padding))) return null;
  const b = Buffer.from(data, "base64");
  let mediaType: ReceiptImageHeader["mediaType"] | undefined;
  let width = 0, height = 0;
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) &&
      b.readUInt32BE(8) === 13 && b.toString("ascii", 12, 16) === "IHDR") {
    mediaType = "image/png"; width = b.readUInt32BE(16); height = b.readUInt32BE(20);
  } else if (b.length >= 10 && (b.toString("ascii", 0, 6) === "GIF87a" || b.toString("ascii", 0, 6) === "GIF89a")) {
    mediaType = "image/gif"; width = b.readUInt16LE(6); height = b.readUInt16LE(8);
  } else if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    mediaType = "image/webp";
    if (b.length < 20) return null;
    const riffEnd = b.readUInt32LE(4) + 8;
    const chunkLength = b.readUInt32LE(16);
    if (riffEnd > b.length || 20 + chunkLength + (chunkLength % 2) > riffEnd) return null;
    const kind = b.toString("ascii", 12, 16);
    if (kind === "VP8X" && b.length >= 30 && b.readUInt32LE(16) >= 10) {
      width = 1 + b.readUIntLE(24, 3); height = 1 + b.readUIntLE(27, 3);
    } else if (kind === "VP8L" && b.length >= 25 && b.readUInt32LE(16) >= 5 && b[20] === 0x2f) {
      const bits = b.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (kind === "VP8 " && b.length >= 30 && b.readUInt32LE(16) >= 10 &&
      b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a && (b[20] & 1) === 0) {
      width = b.readUInt16LE(26) & 0x3fff; height = b.readUInt16LE(28) & 0x3fff;
    }
  } else if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    mediaType = "image/jpeg";
    let i = 2;
    while (i < b.length) {
      if (b[i++] !== 0xff) break;
      while (i < b.length && b[i] === 0xff) i++;
      if (i >= b.length) break;
      const marker = b[i++];
      if (marker === 0xd9 || marker === 0xda || marker === 0x00) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (i + 2 > b.length) break;
      const length = b.readUInt16BE(i);
      if (length < 2 || i + length > b.length) break;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        if (length >= 8) { height = b.readUInt16BE(i + 3); width = b.readUInt16BE(i + 5); }
        break;
      }
      i += length;
    }
  }
  return mediaType && block.mimeType === mediaType && width > 0 && height > 0
    ? { mediaType, width, height } : null;
}

export function matchesDerivativeImages(expected: any[], observed: any[]): boolean {
  if (expected.length !== observed.length) return false;
  let images = 0;
  for (let i = 0; i < expected.length; i++) {
    const a = expected[i], b = observed[i];
    if (a?.type !== b?.type) return false;
    if (a.type === "text") {
      if (typeof a.text !== "string" || a.text !== b.text) return false;
    } else if (a.type === "image") {
      const x = receiptImageHeader(a), y = receiptImageHeader(b);
      if (!x || !y || y.width > x.width || y.height > x.height) return false;
      // Fit-inside fixes one dimension and rounds the other to the nearest
      // integer: cross-product error cannot exceed half that fixed dimension.
      // Test both possible fixed axes, using integers to avoid division drift.
      // PNG dimensions can make these products exceed Number.MAX_SAFE_INTEGER.
      const difference = BigInt(y.width) * BigInt(x.height) - BigInt(y.height) * BigInt(x.width);
      const delta = difference < 0n ? -difference : difference;
      if (2n * delta > BigInt(Math.max(x.width, x.height))) return false;
      images++;
    } else return false;
  }
  // The CLI cannot originate image content; its denial/loss changes kinds or
  // accompanying text. This is not a defense against adversarial image swapping.
  return images > 0;
}
