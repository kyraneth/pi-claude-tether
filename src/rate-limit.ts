/**
 * Account rate-limit state, shaped for the host's status channel.
 *
 * The CLI emits a `rate_limit_event` per turn describing ONE window: the first
 * one whose warning threshold has been crossed, walking
 * `5h -> 7d -> 7d_oi -> overage`. So the reported window is the binding
 * constraint, not an arbitrary pick — and there is no way to see all four at
 * once from this stream. A front-end that wants "which limit will stop me, how
 * close am I, and when does it reset" has everything it needs; one that wants
 * a full dashboard does not, and should not pretend otherwise.
 *
 * Kept pure and separate from `index.ts` so the payload contract is testable
 * without a pi runtime.
 */

/** What the host receives under the `claude-rate-limit` status key. */
export interface RateLimitPayload {
  status: unknown;
  resetsAt: unknown;
  rateLimitType: unknown;
  overageStatus: unknown;
  isUsingOverage: boolean;
  /** Fraction of the window consumed: 1.01 means 101%, i.e. over. */
  utilization: number | null;
  /** Which warning step tripped, when one has. */
  surpassedThreshold: number | null;
  /** Account name, present only when multiple profiles are declared. */
  account?: string;
  observedAt: number;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function buildRateLimitPayload(
  info: Record<string, unknown>,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): RateLimitPayload {
  return {
    status: info.status,
    resetsAt: info.resetsAt,
    rateLimitType: info.rateLimitType,
    overageStatus: info.overageStatus,
    isUsingOverage: info.isUsingOverage === true,
    // Preserve these when supplied. Retained/live streams can omit them;
    // null means unavailable, not a fabricated allowance percentage.
    utilization: num(info.utilization),
    surpassedThreshold: num(info.surpassedThreshold),
    observedAt: nowSeconds,
  };
}

/**
 * Opt-in to allow turns billed to usage credits/overage (default: fail
 * them). Same name as dmmulroy/pi-claude-cli and @pi-plugins/claude-cli,
 * where PI_CLAUDE_CLI_ALLOW_USAGE_CREDITS=1 likewise continues after an
 * overage charge instead of stopping the call.
 */
export function allowUsageCredits(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (env.PI_CLAUDE_CLI_ALLOW_USAGE_CREDITS ?? "") === "1";
}

/**
 * True when the CLI reports this turn was billed to overage/usage credits.
 * The CLI's own field; anything else (absent, false, truthy non-boolean)
 * means plan billing, never an inferred allowance percentage.
 */
export function isOverageBilled(info: unknown): boolean {
  return (
    !!info &&
    typeof info === "object" &&
    (info as { isUsingOverage?: unknown }).isUsingOverage === true
  );
}

/**
 * The CLI's single-window rate-limit state as `anthropic-ratelimit-unified-*`
 * response headers, for Pi's after_provider_response (the provider-call
 * options.onResponse hook).
 *
 * Exact shape of elidickinson/pi-claude-bridge 0.9.3's passthrough
 * (`package/src/rate-limit.ts` rateLimitResponse: status, reset,
 * representative-claim, overage-status/reset, per-window utilization/reset
 * triplets), so quota extensions that read the built-in anthropic
 * provider's headers accept this provider without other changes. The
 * bridge's SDK event carries several windows at once; the CLI's
 * stream-json event carries one, so the single reported window supplies
 * its window's pair. Only observed values travel: absent numerics are
 * omitted, never zeroed. Header values are strings, as ProviderResponse
 * headers require.
 */
export function rateLimitHeaders(
  info: Record<string, unknown>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 ? value : undefined;
  const num = (value: unknown): string | undefined =>
    typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : undefined;
  const set = (name: string, value: string | undefined): void => {
    if (value !== undefined)
      headers[`anthropic-ratelimit-unified-${name}`] = value;
  };
  set("status", text(info.status));
  set("reset", num(info.resetsAt));
  // The window-agnostic claim, verbatim ("five_hour", "seven_day",
  // "overage"): clients do time math on the window triplets, not this.
  set("representative-claim", text(info.rateLimitType));
  set("overage-status", text(info.overageStatus));
  // Claude Code's own window-name table (bridge 0.9.3 rate-limit.ts):
  // five_hour → 5h, seven_day → 7d, seven_day_overage_included → 7d_oi.
  // "seven_day_oi" is accepted defensively (never observed on the wire).
  // The single reported window supplies its own utilization/reset pair;
  // for the overage window those are the overage-* headers.
  const rateLimitType = text(info.rateLimitType);
  const abbreviation =
    rateLimitType === "five_hour"
      ? "5h"
      : rateLimitType === "seven_day"
        ? "7d"
        : rateLimitType === "seven_day_overage_included" ||
            rateLimitType === "seven_day_oi"
          ? "7d_oi"
          : rateLimitType === "overage"
            ? "overage"
            : undefined;
  if (abbreviation !== undefined) {
    set(`${abbreviation}-utilization`, num(info.utilization));
    set(`${abbreviation}-reset`, num(info.resetsAt));
  }
  return headers;
}
/**
 * Attach the answering account to a rate-limit status payload.
 *
 * Single-profile payloads are returned untouched (no account key at all);
 * only the name travels, never the config path.
 */
export function withAccount(
  payload: RateLimitPayload,
  account?: string,
): RateLimitPayload {
  if (account === undefined) return payload;
  return { ...payload, account };
}

/**
 * Identity of a payload ignoring `observedAt`, for change detection.
 *
 * The event repeats every turn with a fresh timestamp; pushing that verbatim
 * would rewrite the host's status constantly and make anything rendering it
 * flicker. Comparing everything EXCEPT the timestamp is what makes the push
 * "on change" rather than "on turn".
 */
export function rateLimitIdentity(payload: RateLimitPayload): string {
  const { observedAt: _observedAt, ...rest } = payload;
  return JSON.stringify(rest);
}
