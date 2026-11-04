#!/usr/bin/env node
// Resolve the owned Pi engine for PCC fixtures.
//
// The owned engine is the npm-installed devDependency
// `@earendil-works/pi-coding-agent`: public module resolution plus that
// package's `bin` field. `<cli> --version` must equal that SDK's package
// version. Missing or mismatched engine fails with a named cause
// ([owned-pi-engine-unavailable] / [owned-pi-engine-version-mismatch]).
// There is no `which pi` fallback and no skip.
//
// An explicit override (`--pi-bin <path>` or `PI_BIN` in the environment)
// is allowed only after the same `--version` check against the owned SDK
// version.
//
// Usage:
//   node scripts/resolve-pi-cli.mjs [--pi-bin <path>] [--package-dir <dir>]
// Prints the resolved absolute CLI path to stdout (single line), or with
// --json the {cli, version} pair from the same owned SDK authority.
// Diagnostics and named-cause errors go to stderr; non-zero exit on failure.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OWNED_NAME = "@earendil-works/pi-coding-agent";
const CAUSE_UNAVAILABLE = "owned-pi-engine-unavailable";
const CAUSE_MISMATCH = "owned-pi-engine-version-mismatch";

function fail(cause, message) {
  process.stderr.write(`resolve-pi-cli: error [${cause}]: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { piBin: null, packageDir: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--pi-bin") {
      out.piBin = argv[++i] ?? null;
    } else if (arg.startsWith("--pi-bin=")) {
      out.piBin = arg.slice("--pi-bin=".length);
    } else if (arg === "--package-dir") {
      out.packageDir = argv[++i] ?? null;
    } else if (arg.startsWith("--package-dir=")) {
      out.packageDir = arg.slice("--package-dir=".length);
    } else if (arg === "--json") {
      out.json = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: node scripts/resolve-pi-cli.mjs [--pi-bin <path>] [--package-dir <dir>] [--json]\n",
      );
      process.exit(0);
    } else {
      fail(CAUSE_UNAVAILABLE, `unknown argument: ${arg}`);
    }
  }
  return out;
}

function defaultPackageDir() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function findOwnedManifest(packageDir) {
  // Public module resolution without relying on the SDK's `exports` map
  // (which does not expose `./package.json`): walk up from the package
  // dir, checking each `node_modules/@earendil-works/pi-coding-agent`.
  let directory = resolve(packageDir);
  for (;;) {
    const candidate = join(
      directory,
      "node_modules",
      ...OWNED_NAME.split("/"),
      "package.json",
    );
    try {
      const text = readFileSync(candidate, "utf8");
      const manifest = JSON.parse(text);
      if (manifest?.name === OWNED_NAME) return candidate;
    } catch {
      // Not here; keep walking.
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function resolveOwnedManifest(packageDir, explicitPackageDir) {
  let manifestPath = findOwnedManifest(packageDir);
  if (!manifestPath && !explicitPackageDir) {
    // Fallback: resolve the package entry (allowed by `exports`) from the
    // helper's own location, then walk up to the owning manifest.
    try {
      let directory = dirname(fileURLToPath(import.meta.resolve(OWNED_NAME)));
      for (;;) {
        const candidate = join(directory, "package.json");
        try {
          const manifest = JSON.parse(readFileSync(candidate, "utf8"));
          if (manifest?.name === OWNED_NAME) {
            manifestPath = candidate;
            break;
          }
        } catch {
          // Keep walking.
        }
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    } catch {
      // Reported below as unavailable.
    }
  }
  if (!manifestPath) {
    fail(
      CAUSE_UNAVAILABLE,
      `cannot resolve ${OWNED_NAME} from ${packageDir}: no node_modules copy found`,
    );
  }
  let sdk = null;
  try {
    sdk = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(
      CAUSE_UNAVAILABLE,
      `cannot read owned SDK manifest at ${manifestPath}: ${error.message}`,
    );
  }
  if (sdk?.name !== OWNED_NAME) {
    fail(
      CAUSE_UNAVAILABLE,
      `resolved manifest at ${manifestPath} names ${sdk?.name ?? "nothing"}`,
    );
  }
  if (typeof sdk?.version !== "string" || !sdk.version) {
    fail(
      CAUSE_UNAVAILABLE,
      `owned SDK manifest at ${manifestPath} has no version`,
    );
  }
  const bin = typeof sdk.bin === "string" ? sdk.bin : sdk.bin?.pi;
  if (typeof bin !== "string" || !bin) {
    fail(
      CAUSE_UNAVAILABLE,
      `owned SDK package.bin.pi is missing in ${manifestPath}`,
    );
  }
  let cli = null;
  try {
    cli = realpathSync(join(dirname(manifestPath), bin));
  } catch (error) {
    fail(
      CAUSE_UNAVAILABLE,
      `owned SDK CLI not found under ${dirname(manifestPath)}: ${error.message}`,
    );
  }
  return { manifestPath, version: sdk.version, cli };
}

function isJsCli(cliPath) {
  return /\.m?c?js$/.test(cliPath);
}

function cliVersion(cliPath) {
  // JS CLIs run through the current Node (quiet, no inherited stderr);
  // native binaries run directly. No `which pi` fallback anywhere.
  const options = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
  try {
    if (isJsCli(cliPath)) {
      return execFileSync(
        process.execPath,
        [cliPath, "--version"],
        options,
      ).trim();
    }
    return execFileSync(cliPath, ["--version"], options).trim();
  } catch (error) {
    fail(
      CAUSE_UNAVAILABLE,
      `cannot run '${cliPath} --version': ${error.message}`,
    );
  }
  return null;
}

const args = parseArgs(process.argv.slice(2));
const packageDir = args.packageDir
  ? resolve(args.packageDir)
  : defaultPackageDir();
const owned = resolveOwnedManifest(packageDir, Boolean(args.packageDir));

const overrideRaw = args.piBin ?? process.env.PI_BIN ?? "";
const override = overrideRaw.trim();
if (override) {
  const overridePath = override.startsWith("/") ? override : resolve(override);
  if (!existsSync(overridePath)) {
    fail(CAUSE_UNAVAILABLE, `explicit PI_BIN/--pi-bin not found: ${override}`);
  }
  let canonical = overridePath;
  try {
    canonical = realpathSync(overridePath);
  } catch {
    canonical = overridePath;
  }
  const reported = cliVersion(canonical);
  if (reported !== owned.version) {
    fail(
      CAUSE_MISMATCH,
      `explicit PI_BIN/--pi-bin ${canonical} reports '${reported}', owned ${OWNED_NAME} is ${owned.version} (from ${owned.manifestPath})`,
    );
  }
  process.stdout.write(
    args.json
      ? `${JSON.stringify({ cli: canonical, version: owned.version })}\n`
      : `${canonical}\n`,
  );
  process.exit(0);
}

if (!existsSync(owned.cli)) {
  fail(CAUSE_UNAVAILABLE, `owned SDK CLI missing at ${owned.cli}`);
}
const reported = cliVersion(owned.cli);
if (reported !== owned.version) {
  fail(
    CAUSE_MISMATCH,
    `owned CLI ${owned.cli} reports '${reported}', SDK manifest ${owned.manifestPath} says ${owned.version}`,
  );
}
process.stdout.write(
  args.json
    ? `${JSON.stringify({ cli: owned.cli, version: owned.version })}\n`
    : `${owned.cli}\n`,
);
