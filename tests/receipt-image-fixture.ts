/** Synthetic header fixtures, not decoded-image/content-integrity proofs. */
export function imageHeader(format: "png" | "jpeg" | "gif" | "vp8" | "vp8l" | "vp8x", width: number, height: number, variant = 0) {
  let b: Buffer;
  let mimeType: string;
  if (format === "png") {
    b = Buffer.alloc(33); Buffer.from([137,80,78,71,13,10,26,10]).copy(b);
    b.writeUInt32BE(13, 8); b.write("IHDR", 12); b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
    mimeType = "image/png";
  } else if (format === "jpeg") {
    b = Buffer.from([0xff,0xd8,0xff,0xe0,0,3,variant,0xff,0xc0,0,11,8,0,0,0,0,1,1,0x11,0,0xff,0xd9]);
    b.writeUInt16BE(height, 12); b.writeUInt16BE(width, 14); mimeType = "image/jpeg";
  } else if (format === "gif") {
    b = Buffer.alloc(14); b.write("GIF89a"); b.writeUInt16LE(width, 6); b.writeUInt16LE(height, 8); mimeType = "image/gif";
  } else {
    b = Buffer.alloc(format === "vp8l" ? 26 : 30);
    b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WEBP", 8);
    b.write(format === "vp8" ? "VP8 " : format === "vp8l" ? "VP8L" : "VP8X", 12);
    b.writeUInt32LE(format === "vp8l" ? 5 : 10, 16);
    if (format === "vp8") {
      b[23] = 0x9d; b[24] = 1; b[25] = 0x2a; b.writeUInt16LE(width, 26); b.writeUInt16LE(height, 28);
    } else if (format === "vp8l") {
      b[20] = 0x2f; b.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 21);
    } else { b.writeUIntLE(width - 1, 24, 3); b.writeUIntLE(height - 1, 27, 3); }
    mimeType = "image/webp";
  }
  if (format !== "jpeg") b[b.length - 1] ^= variant;
  return { type: "image" as const, sourceType: "base64", data: b.toString("base64"), mimeType };
}

export function apiImage(block: ReturnType<typeof imageHeader>) {
  return { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } };
}
