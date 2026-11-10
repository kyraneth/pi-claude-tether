import { createHash } from "node:crypto";
import type { HandoffResult } from "./handoff-broker.js";

/** Official Claude Code 2.1.284/2.1.311/2.1.321 error codec: 10,000 UTF-16 units,
 * with a 1,024-unit no-truncation allowance. These are vendor constants,
 * not adapter limits. The middle is replaced by the exact counted marker.
 * Qualified against native receipt hashes and real Pi; never applies to
 * successes, images, unknown parts, or arbitrary same-ID replacement text.
 */
const ERROR_KEEP = 10_000;
const ERROR_ALLOWANCE = 1_024;
const marker = /\n\n\.\.\. \[(\d+) characters truncated\] \.\.\.\n\n/g;
export type ErrorTruncation = {
  rule: "claude-error-middle-v1";
  evidence: "declared-lossy";
  modelVisibility: "middle-omitted";
  originalChars: number;
  omittedChars: number;
  omittedSha256: string;
};

function projection(text: string): { echo: string; evidence: ErrorTruncation } | undefined {
  if (text.length <= ERROR_KEEP + ERROR_ALLOWANCE) return;
  let head = text.slice(0, ERROR_KEEP / 2);
  let tail = text.slice(-ERROR_KEEP / 2);
  // The official client does not bisect surrogate pairs at either edge.
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
  const omitted = text.slice(head.length, text.length - tail.length);
  let count = omitted.length;
  // The native codec carries forward counts from already-truncated text.
  const middle = text.slice(ERROR_KEEP / 2, text.length - ERROR_KEEP / 2);
  for (const match of middle.matchAll(marker)) {
    // The native codec only carries decimal counts of at most 15 digits.
    const n = match[1].length <= 15 ? Number(match[1]) : NaN;
    if (Number.isSafeInteger(n) && n >= match[0].length) count += n - match[0].length;
  }
  return {
    echo: `${head}\n\n... [${count} characters truncated] ...\n\n${tail}`,
    evidence: { rule: "claude-error-middle-v1", evidence: "declared-lossy",
      modelVisibility: "middle-omitted", originalChars: text.length,
      omittedChars: omitted.length,
      omittedSha256: createHash("sha256").update(omitted).digest("hex") },
  };
}

/** Positional verification, not global marker replacement. Surviving bytes,
 * status, part kinds and the native omission count must all agree. The model
 * sees the explicit native marker; the ledger separately discloses the loss.
 */
export function errorTruncation(result: HandoffResult, echo: unknown): ErrorTruncation | undefined {
  if (!result.isError || typeof echo !== "string" || !result.content.length ||
      !result.content.every(part => part.type === "text" && typeof part.text === "string")) return;
  const text = result.content.map(part => (part as { text: string }).text).join("\n");
  for (const candidate of [text, text.trim()]) {
    const projected = projection(candidate);
    if (projected?.echo === echo) return projected.evidence;
  }
}
