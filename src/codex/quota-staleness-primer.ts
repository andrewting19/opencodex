import { registerStateSweepAfterTick } from "../lib/state-store-sweeper";
import type { OcxConfig } from "../types";

/**
 * Periodic, staleness-aware Codex pool quota primer.
 *
 * The defect this closes: pool quota was only re-read at startup, on subagent
 * spawn, on management mutations, and pre-route ONLY when the selected account
 * had no stored quota at all. A stored-but-stale "exhausted" reading therefore
 * never expired on its own: after an early window reset (a consumed reset credit,
 * for example), the dashboard kept reporting "no usage" and rotation kept the
 * account cooled for days, because the 5-minute POOL_CACHE_TTL was only honored
 * by callers that never ran on a timer.
 *
 * The fix drives the EXISTING primeCodexPoolQuotas helper from the 60 s state-sweep
 * tick. That helper is single-flight, returns before any upstream I/O when the
 * provider is not in pool mode, and refreshes only rows older than
 * POOL_CACHE_TTL - the budget its own comment already declares ("one WHAM call
 * per account per TTL window"). Steady-state upstream cost is unchanged; stale
 * exhaustion now self-heals within ~6 minutes with no traffic, dashboard, or
 * operator action.
 */
export function registerCodexQuotaStalenessPrimer(config: OcxConfig): () => void {
  return registerStateSweepAfterTick({
    name: "codex-quota-staleness-primer",
    afterTick: () => {
      // Dynamic import mirrors the startup prime call site in server/index.ts.
      // Priming is best-effort: a failed poll must not surface anywhere.
      void import("./auth-api")
        .then(({ primeCodexPoolQuotas }) => primeCodexPoolQuotas(config, "staleness-poll"))
        .catch(() => {});
    },
  });
}
