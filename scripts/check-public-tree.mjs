#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Generic, non-private checks that are safe to publish in scanner source.
export const publicPatterns = [
  ['credential', /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|sk-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i],
  ['credential-assignment', /(?:password|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*["'][A-Za-z0-9_+/-]{20,}["']/i],
  ['internal-host', /\b(?:[a-z0-9-]+\.)+(?:lan|internal|local)\b(?![.\w-])/i],
  ['personal-email', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
];

// Decode string/regex escape sequences (\u{...}, \uXXXX, \xXX) anywhere,
// join every chain of adjacent quoted string literals (double, single or
// backtick) into one canonical double-quoted literal ("a" + 'b' + `c` ->
// "abc"), collapse single-character character classes ([a] -> a, [\-] -> -),
// strip remaining escape backslashes (\X -> X) and case-fold for comparison.
export function normalizeForScan(raw) {
  const pending = [String(raw)], seen = new Set(), values = [];
  const quoted = String.raw`("(?:\\[\s\S]|[^"\\\r\n])*"|'(?:\\[\s\S]|[^'\\\r\n])*'|\x60(?:\\[\s\S]|[^\x60\\])*\x60)`;
  const gap = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\r\n]*(?:\r?\n|$))*`;
  const pair = new RegExp(quoted + gap + '(?:\\+' + gap + ')?' + quoted, 'g');
  const joinLiterals = (_, left, right) => JSON.stringify(left.slice(1, -1) + right.slice(1, -1));
  while (pending.length) {
    let text = pending.pop(), previous;
    if (seen.has(text)) continue;
    seen.add(text);
    do {
      previous = text;
      text = text
        // Join valid quoted tokens before decoding their escaped newlines.
        .replace(pair, joinLiterals)
        .replace(/String\.fromCharCode\(\s*((?:(?:0x[0-9a-f]+|\d+)\s*,\s*)*(?:0x[0-9a-f]+|\d+))\s*\)/gi, (_, numbers) => JSON.stringify(numbers.split(',').map(value => String.fromCharCode(Number(value.trim()))).join('')))
        // Unicode code points end at U+10FFFF; invalid escapes stay literal.
        .replace(/\\u\{([0-9a-f]+)\}/gi, (match, value) => Number.parseInt(value, 16) <= 0x10ffff ? String.fromCodePoint(Number.parseInt(value, 16)) : match)
        .replace(/\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi, (_, u, x) => String.fromCodePoint(Number.parseInt(u || x, 16)))
        .replace(/\\([nrt])/g, (_, escape) => ({ n: '\n', r: '\r', t: '\t' })[escape])
        // NUL padding is not a candidate boundary until the final return.
        .replaceAll('\u0000', '')
        .replace(/\[(\\.|[^\\[\]])\]/gu, (_, character) => character)
        .replace(pair, joinLiterals)
        .replace(/\\([\s\S])/g, '$1');
    } while (text !== previous);
    values.push(text);
    // Base64 candidates must round-trip and decode to UTF-8 text. Four
    // characters are one encoding quantum, not an arbitrary scan budget.
    for (const match of text.matchAll(/[A-Za-z0-9+/]+={0,2}/g)) {
      const token = match[0];
      if (token.length < 4 || token.length % 4 === 1) continue;
      const bytes = Buffer.from(token, 'base64');
      if (bytes.toString('base64').replace(/=+$/, '') !== token.replace(/=+$/, '')) continue;
      try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replaceAll('\u0000', '');
        // eslint-disable-next-line no-control-regex -- Exclude binary ASCII controls, not text whitespace.
        if (decoded && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(decoded)) pending.push(decoded);
      } catch { /* Binary payloads are not text candidates. */ }
    }
  }
  // NUL marks independent decode candidates; callers scan each separately.
  return values.join('\u0000').toLowerCase();
}

const exampleEmail = /@(?:example\.(?:com|net|org)|(?:[a-z0-9-]+\.)*(?:example|invalid|test))$/i;

export function scanText(raw, policy, patterns = publicPatterns) {
  const findings = [];
  for (const text of normalizeForScan(raw).split('\u0000')) {
    for (const [kind, pattern] of patterns) {
      const matches = [...text.matchAll(new RegExp(pattern.source, pattern.flags + 'g'))];
      if (matches.some(match => !(kind === 'personal-email' && exampleEmail.test(match[0]))))
        findings.push({ kind });
    }
    for (const term of policy.bannedTerms ?? [])
      if (text.includes(String(term).toLowerCase())) findings.push({ kind: 'banned-term', term });
    for (const entry of policy.privatePatterns ?? []) {
      const re = new RegExp(entry.source, (entry.flags ?? '') + 'g');
      if (re.test(text)) findings.push({ kind: entry.kind });
    }
  }
  return [...new Map(findings.map(finding => [JSON.stringify(finding), finding])).values()];
}


const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function main() {
  const manifestBytes = execFileSync(process.execPath, ['scripts/export-manifest'], { cwd: root });
  const manifest = JSON.parse(manifestBytes);
  const policyPath = process.env.PUBLIC_SCAN_POLICY ?? join(root, 'internal', 'public-scan-policy.mjs');
  const policyApplied = existsSync(policyPath);
  const policyBytes = policyApplied ? readFileSync(policyPath) : null;
  const policy = policyApplied ? await import(pathToFileURL(resolve(policyPath)).href) : null;
  const findings = [];
  for (const file of manifest.files) {
    const absolute = join(root, file.path), bytes = readFileSync(absolute);
    if (!lstatSync(absolute).isFile() || bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error('Manifest bytes changed during scan');
    const text = file.path + '\n' + new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    for (const found of scanText(text, {})) findings.push({ path: file.path, sha256: file.sha256, ...found });
    for (const kind of policy?.scan(text) ?? []) findings.push({ path: file.path, sha256: file.sha256, kind });
  }
  // npm's payload must be a byte-identical subset of precisely the scanned tree.
  const pack = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' }))[0];
  const byPath = new Map(manifest.files.map(file => [file.path, file]));
  for (const file of pack.files) if (!byPath.has(file.path) || file.path.startsWith('internal/') || file.size !== byPath.get(file.path).bytes) findings.push({ kind: 'pack-outside-manifest', path: file.path });
  // Rehash after npm read to catch source mutation during the dry run.
  for (const file of manifest.files) if (hash(readFileSync(join(root, file.path))) !== file.sha256) throw new Error('Source changed during pack verification');
  console.log(JSON.stringify({ status: findings.length ? 'blocked' : policyApplied ? 'clear' : 'not-applied', manifestSha256: hash(manifestBytes), policySha256: policyBytes ? hash(Buffer.concat([policyBytes, policy.policyData ?? Buffer.alloc(0)])) : null, policyApplied, files: manifest.files.length, bytes: manifest.files.reduce((n, f) => n + f.bytes, 0), packFiles: pack.files.length, findings }, null, 2));
  if (findings.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
