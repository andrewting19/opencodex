/**
 * Timing contract shared by the credential refresh, the WHAM quota request, and the
 * 401-recovery budget (#3019).
 *
 * A leaf on purpose: `auth-api.ts` imports the recovery store to claim and settle, so the
 * recovery store cannot import `auth-api.ts` back for the WHAM timeout. Both of them, and
 * `account-store.ts`, import this instead.
 *
 * These were three inline literals in three files. The lease has to outlast the operations
 * it fences — a lease that expires mid-refresh admits a second claim for a lineage that is
 * already being refreshed — so it is derived here rather than restated as a round number
 * that drifts away from what it covers.
 */

/** The refresh flight's own `AbortSignal.timeout` ceiling. */
export const CODEX_REFRESH_FLIGHT_CEILING_MS = 30_000;

/** Deadline for one `backend-api/wham/usage` request. */
export const WHAM_REQUEST_TIMEOUT_MS = 8_000;

/**
 * How long a recovery claim stays valid without settlement.
 *
 * The sequence a claim covers is: WHAM request → refresh → WHAM replay. Both quota legs sit
 * inside the lease, which is why the request timeout is counted twice.
 */
export const QUOTA_RECOVERY_LEASE_MS =
  CODEX_REFRESH_FLIGHT_CEILING_MS + WHAM_REQUEST_TIMEOUT_MS * 2;

/**
 * How old a stored Codex quota row may get before a reader treats it as stale
 * and a primer pass may re-fetch it.
 *
 * Declared here, in the leaf that both auth-api.ts and the pre-route selector can
 * import, because the primers and the staleness checks must not drift to
 * different thresholds - the same class of defect as the header/WHAM window
 * mismatch this file exists to fence.
 */
export const CODEX_POOL_QUOTA_STALE_MS = 5 * 60_000;
