import { describe, it, expect } from "vitest";
import { receiptImageHeader, matchesDerivativeImages } from "../src/receipt-image";
import { imageHeader } from "./receipt-image-fixture";

describe("receipt image headers", () => {
  it.each(["png", "jpeg", "gif", "vp8", "vp8l", "vp8x"] as const)("parses %s dimensions", format => {
    const block = imageHeader(format, 1234, 567);
    expect(receiptImageHeader(block)).toEqual({ mediaType: block.mimeType, width: 1234, height: 567 });
  });
  it("handles multi-megabyte base64 without a regexp stack overflow", () => {
    const block = imageHeader("png", 2000, 1000);
    // Validate image parsing at a 5,000,000-character ASCII payload.
    block.data += "a".repeat(5_000_000);
    expect(receiptImageHeader(block)).toEqual({ mediaType: "image/png", width: 2000, height: 1000 });
  });
  it.each(["png", "jpeg", "gif", "vp8", "vp8l", "vp8x"] as const)("rejects truncated %s headers and incorrect declared media", format => {
    const block = imageHeader(format, 1234, 567);
    expect(receiptImageHeader({ ...block, data: Buffer.from(block.data, "base64").subarray(0, 9).toString("base64") })).toBeNull();
    expect(receiptImageHeader({ ...block, mimeType: "image/unknown-private-media" })).toBeNull();
    expect(receiptImageHeader({ ...block, sourceType: "url" })).toBeNull();
  });
  it.each(["", "a", "a===", "AA=A", "AA==\n", "!!!!", "AA-_", "AAAA="])("rejects malformed base64 %j", data => {
    expect(receiptImageHeader({ ...imageHeader("png", 1, 1), data })).toBeNull();
  });
  it("rejects zero dimensions and invalid magic/frame headers", () => {
    expect(receiptImageHeader(imageHeader("png", 0, 1))).toBeNull();
    for (const [format, offset] of [["png", 12], ["jpeg", 10], ["vp8", 23], ["vp8l", 20]] as const) {
      const block = imageHeader(format, 1234, 567); const b = Buffer.from(block.data, "base64"); b[offset] = 0;
      expect(receiptImageHeader({ ...block, data: b.toString("base64") })).toBeNull();
    }
  });
  it("rejects truncated or invalid WebP chunk extents", () => {
    const block = imageHeader("vp8x", 1234, 567); const b = Buffer.from(block.data, "base64");
    b.writeUInt32LE(100, 16);
    expect(receiptImageHeader({ ...block, data: b.toString("base64") })).toBeNull();
  });
  it("compares large PNG dimensions with exact integer cross-products", () => {
    // A portrait counterpart must also work; neither fixed-axis rounding is privileged.
    expect(matchesDerivativeImages([imageHeader("png", 1001, 2000)], [imageHeader("png", 500, 999)])).toBe(true);
    expect(matchesDerivativeImages([imageHeader("png", 0xffffffff, 0xfffffffd)], [imageHeader("png", 0xfffffffe, 0xfffffffc)])).toBe(true);
    expect(matchesDerivativeImages([imageHeader("png", 0xffffffff, 0xfffffffd)], [imageHeader("png", 0xfffffffe, 0xfffffffb)])).toBe(false);
  });
});
