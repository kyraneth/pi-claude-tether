import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildRateLimitPayload,
  rateLimitIdentity,
  withAccount,
  allowUsageCredits,
  isOverageBilled,
  rateLimitHeaders,
} from "../src/rate-limit";

// Synthetic overage event for the UI contract.
const OVER_CREDITS = {
  status: "allowed_warning",
  resetsAt: 1700001000,
  rateLimitType: "overage",
  utilization: 1.01,
  isUsingOverage: false,
  surpassedThreshold: 1,
};

describe("buildRateLimitPayload", () => {
  it("forwards utilization and surpassedThreshold, which used to be dropped", () => {
    const payload = buildRateLimitPayload(OVER_CREDITS, 1_700_000_000);
    expect(payload.utilization).toBe(1.01);
    expect(payload.surpassedThreshold).toBe(1);
  });

  it("keeps the fields the UI already relied on", () => {
    const payload = buildRateLimitPayload(OVER_CREDITS, 1_700_000_000);
    expect(payload).toMatchObject({
      status: "allowed_warning",
      resetsAt: 1700001000,
      rateLimitType: "overage",
      observedAt: 1_700_000_000,
    });
  });

  it("normalises isUsingOverage to a real boolean", () => {
    // The CLI sends a boolean, but a truthy non-boolean must not leak through
    // as one — the UI branches on it to warn about paid usage.
    expect(buildRateLimitPayload({ isUsingOverage: true }).isUsingOverage).toBe(
      true,
    );
    expect(
      buildRateLimitPayload({ isUsingOverage: "yes" }).isUsingOverage,
    ).toBe(false);
    expect(buildRateLimitPayload({}).isUsingOverage).toBe(false);
  });

  it("returns null rather than a bogus number for missing metrics", () => {
    // surpassedThreshold is absent until a threshold is actually crossed, and
    // `undefined` must not render as 0% — that reads as "plenty of room left".
    const payload = buildRateLimitPayload({ rateLimitType: "five_hour" });
    expect(payload.utilization).toBeNull();
    expect(payload.surpassedThreshold).toBeNull();
  });

  it("rejects non-finite and non-numeric metrics", () => {
    for (const bad of [NaN, Infinity, "1.01", null, {}]) {
      expect(
        buildRateLimitPayload({ utilization: bad }).utilization,
      ).toBeNull();
    }
  });

  it("carries a utilization of 0 through, which is meaningfully different from unknown", () => {
    expect(buildRateLimitPayload({ utilization: 0 }).utilization).toBe(0);
  });
});

describe("rateLimitIdentity", () => {
  const at = (seconds: number) => buildRateLimitPayload(OVER_CREDITS, seconds);

  it("ignores observedAt, so a repeated event is not a change", () => {
    // The CLI re-sends this every turn with a fresh timestamp. Treating that
    // as a change would rewrite the host's status constantly.
    expect(rateLimitIdentity(at(1000))).toBe(rateLimitIdentity(at(2000)));
  });

  it("changes when utilization moves", () => {
    const before = rateLimitIdentity(at(1000));
    const after = rateLimitIdentity(
      buildRateLimitPayload({ ...OVER_CREDITS, utilization: 1.4 }, 1000),
    );
    expect(after).not.toBe(before);
  });

  it("changes when the window itself changes", () => {
    const fiveHour = rateLimitIdentity(
      buildRateLimitPayload({ ...OVER_CREDITS, rateLimitType: "five_hour" }),
    );
    expect(fiveHour).not.toBe(rateLimitIdentity(at(1000)));
  });
});

describe("allowUsageCredits", () => {
  beforeEach(() => {
    vi.stubEnv("PI_CLAUDE_CLI_ALLOW_USAGE_CREDITS", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is off unless explicitly opted in", () => {
    expect(allowUsageCredits()).toBe(false);
    vi.stubEnv("PI_CLAUDE_CLI_ALLOW_USAGE_CREDITS", "0");
    expect(allowUsageCredits()).toBe(false);
  });

  it('is on for exactly "1"', () => {
    vi.stubEnv("PI_CLAUDE_CLI_ALLOW_USAGE_CREDITS", "1");
    expect(allowUsageCredits()).toBe(true);
  });

  it("rejects broader truthy spellings", () => {
    for (const value of ["true", "yes", "TRUE", "on"]) {
      vi.stubEnv("PI_CLAUDE_CLI_ALLOW_USAGE_CREDITS", value);
      expect(allowUsageCredits()).toBe(false);
    }
  });
});

describe("isOverageBilled", () => {
  it("is true only when the CLI says isUsingOverage", () => {
    expect(isOverageBilled({ isUsingOverage: true })).toBe(true);
    expect(isOverageBilled({ isUsingOverage: false })).toBe(false);
    // rateLimitType "overage" alone is the approaching window, not proof
    // this turn was billed to credits (cf. the OVER_CREDITS fixture).
    expect(isOverageBilled({ rateLimitType: "overage" })).toBe(false);
    expect(isOverageBilled({ isUsingOverage: "yes" })).toBe(false);
    expect(isOverageBilled({})).toBe(false);
    expect(isOverageBilled(undefined)).toBe(false);
    expect(isOverageBilled("overage")).toBe(false);
  });
});

describe("rateLimitHeaders", () => {
  it("maps the single-window event onto the unified family", () => {
    // Exact elidickinson/pi-claude-bridge 0.9.3 shape (rateLimitResponse):
    // status, reset, verbatim representative-claim, the reported window's
    // utilization/reset pair, and the overage status. No per-window
    // status, no inferred percentages.
    expect(
      rateLimitHeaders({
        status: "allowed",
        resetsAt: 1788331200,
        rateLimitType: "five_hour",
        utilization: 0.12,
        overageStatus: "rejected",
        isUsingOverage: false,
      }),
    ).toEqual({
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-reset": "1788331200",
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
      "anthropic-ratelimit-unified-5h-utilization": "0.12",
      "anthropic-ratelimit-unified-5h-reset": "1788331200",
      "anthropic-ratelimit-unified-overage-status": "rejected",
    });
  });

  it("maps the overage window onto the overage headers", () => {
    expect(
      rateLimitHeaders({
        status: "allowed_warning",
        resetsAt: 1700001000,
        rateLimitType: "overage",
        utilization: 1.01,
        isUsingOverage: true,
      }),
    ).toEqual({
      "anthropic-ratelimit-unified-status": "allowed_warning",
      "anthropic-ratelimit-unified-reset": "1700001000",
      "anthropic-ratelimit-unified-representative-claim": "overage",
      "anthropic-ratelimit-unified-overage-utilization": "1.01",
      "anthropic-ratelimit-unified-overage-reset": "1700001000",
    });
  });

  it("maps the seven-day windows onto their triplets", () => {
    expect(
      rateLimitHeaders({
        status: "rejected",
        resetsAt: 1788331200,
        rateLimitType: "seven_day",
        utilization: 1.01,
        isUsingOverage: false,
      }),
    ).toMatchObject({
      "anthropic-ratelimit-unified-representative-claim": "seven_day",
      "anthropic-ratelimit-unified-7d-utilization": "1.01",
      "anthropic-ratelimit-unified-7d-reset": "1788331200",
    });
    expect(
      rateLimitHeaders({
        status: "allowed",
        resetsAt: 1788331200,
        rateLimitType: "seven_day_overage_included",
        utilization: 0.55,
      }),
    ).toMatchObject({
      "anthropic-ratelimit-unified-7d_oi-utilization": "0.55",
      "anthropic-ratelimit-unified-7d_oi-reset": "1788331200",
    });
  });

  it("omits absent numerics instead of zeroing them", () => {
    expect(
      rateLimitHeaders({ status: "allowed", rateLimitType: "seven_day" }),
    ).toEqual({
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-representative-claim": "seven_day",
    });
  });

  it("ignores unknown windows and non-finite values", () => {
    expect(rateLimitHeaders({})).toEqual({});
    expect(
      rateLimitHeaders({
        status: "allowed",
        resetsAt: NaN,
        rateLimitType: "weekly_scoped",
        utilization: "1.01",
      }),
    ).toEqual({
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-representative-claim": "weekly_scoped",
    });
  });
});

describe("withAccount", () => {
  it("leaves single-profile payloads untouched", () => {
    const payload = buildRateLimitPayload(OVER_CREDITS, 1000);
    expect(withAccount(payload, undefined)).toBe(payload);
    expect("account" in withAccount(payload, undefined)).toBe(false);
  });

  it("carries the account name, never the path", () => {
    const payload = withAccount(buildRateLimitPayload(OVER_CREDITS, 1000), "b");
    expect(payload.account).toBe("b");
    expect(JSON.stringify(payload)).not.toContain("claude-config");
  });
});
