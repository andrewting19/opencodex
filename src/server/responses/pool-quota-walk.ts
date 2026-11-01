import type { CodexAuthContext } from "../../codex/auth-context";
import { wasPermanentAccountRefusal } from "../../oauth/account-auto-pause";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { isRateLimitOrQuotaFailureMessage, upstreamErrorMessageFromPayload } from "../../lib/errors";
import type { OcxProviderConfig } from "../../types";
import type { RequestLogContext } from "../request-log";
import {
  isCodexWsPreOutputRefusal,
  isCodexWsUpstreamResponse,
  markCodexWsPreOutputRefusal,
  restoreCodexWsPreOutputRefusal,
} from "./codex-ws-wire";
import { preflightComboStreamResponse } from "./combo-stream-preflight";
import { clearCodexModelDenialEvidence, recordCodexModelDenialEvidence } from "../../codex/model-entitlements";
import { wasAccountAutoPaused } from "../../oauth/account-auto-pause";
import {
  codexPoolAccountModel400Denial,
  shouldRetryCodexPoolAccountQuota,
  shouldRetryCodexPoolAccountTransient,
} from "./core-codex-account";

/**
 * Fork patch 5: one request's walk across Pool accounts after quota refusals.
 *
 * Each refused account is cooled before the next selection, so the walk needs no exclusion list.
 * It still remembers what it tried: each account (and the caller's own credential) once, one
 * token refresh per account, and a two-minute limit. Transient 5xx and gated 400 keep
 * upstream's one-move bound; only quota refusals continue the walk.
 */
export class PoolQuotaWalk {
  private readonly tried = new Set<string>();
  private readonly refreshed = new Set<string>();
  private readonly deadline = Date.now() + 120_000;
  /** True after the first move: later moves may pass a spent move budget. */
  continuing = false;

  private static key(accountId: string | null | undefined): string { return accountId ?? "caller"; }

  callerTried(): boolean { return this.tried.has("caller"); }
  markTried(accountId: string | null | undefined): void { this.tried.add(PoolQuotaWalk.key(accountId)); }
  mayRefresh(authCtx: CodexAuthContext): boolean { return !this.refreshed.has(PoolQuotaWalk.key(authCtx.accountId)); }
  markRefreshed(authCtx: CodexAuthContext): void { this.refreshed.add(PoolQuotaWalk.key(authCtx.accountId)); }
  /** A walk step's refresh replay keeps one send even when the base allowance is spent. */
  replayFloor(): number { return this.continuing ? 1 : 0; }

  mayContinue(quotaRefusal: boolean, next: CodexAuthContext, aborted: boolean): boolean {
    return quotaRefusal && !("fixedAccount" in next && next.fixedAccount) && !aborted
      && Date.now() < this.deadline && !this.tried.has(PoolQuotaWalk.key(next.accountId));
  }

  /** The next account answered with its own expired token: refresh it once. */
  nextNeedsRefresh(response: Response, next: CodexAuthContext): boolean {
    return response.status === 401 && !wasPermanentAccountRefusal(response)
      && (next.kind === "pool" || next.kind === "main-pool") && this.mayRefresh(next);
  }
}

/** A request-owned main credential in Pool mode may start the walk; exact selectors and Reserve stay. */
export function callerMainMayWalk(
  authCtx: CodexAuthContext,
  route: { codexAccountMode?: string; codexAccountId?: string; provider: OcxProviderConfig },
): boolean {
  return authCtx.kind === "main" && route.codexAccountMode === "pool" && route.codexAccountId === undefined
    && !authCtx.reserveAuthorization && isCanonicalOpenAiForwardProvider(route.provider);
}

/**
 * A quota failure inside an HTTP event stream before any output is the same refusal as an HTTP
 * 429. Only lifecycle events are inspected; the first output or tool event commits the stream.
 * WebSocket upstreams keep metadata keyed by their Response and own their pre-output recovery.
 *
 * A failed preflight becomes a held projection (the same hold 2.95 uses for WebSocket refusals):
 * if no account move replaces it, the Pool block restores the original stream byte for byte, so
 * the client and the terminal recorder see exactly what upstream sent.
 */
export async function preflightPoolQuotaStream(
  response: Response,
  authCtx: CodexAuthContext,
  logCtx: Pick<RequestLogContext, "model" | "provider">,
  requestsStream: boolean,
  signal: AbortSignal,
): Promise<Response> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!response.ok || !response.body || isCodexWsUpstreamResponse(response) || isCodexWsPreOutputRefusal(response)
    || ("fixedAccount" in authCtx && authCtx.fixedAccount === true)
    || !(contentType.includes("text/event-stream") || (!contentType && requestsStream))) return response;
  const preflightLog: RequestLogContext = { model: logCtx.model, provider: logCtx.provider };
  const [probeBody, heldBody] = response.body.tee();
  const init = { status: response.status, statusText: response.statusText, headers: response.headers };
  const preflight = await preflightComboStreamResponse(new Response(probeBody, init), preflightLog, payload => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const type = (payload as { type?: unknown }).type;
    const message = upstreamErrorMessageFromPayload(payload);
    return (type === "error" || type === "response.failed" || type === "response.incomplete")
      && message !== undefined && isRateLimitOrQuotaFailureMessage(message);
  }, { allowMissingContentType: !contentType && requestsStream, replayReadErrors: true, signal });
  if (preflight.kind === "failed") {
    const original = new Response(heldBody, init);
    heldStreams.set(preflight.response, original);
    markCodexWsPreOutputRefusal(preflight.response, () => original);
    return preflight.response;
  }
  void heldBody.cancel().catch(() => undefined);
  return preflight.response;
}

const heldStreams = new WeakMap<Response, Response>();

/** After an account move replaced a held projection, release the original stream it kept. */
export function releasePoolQuotaStreamHold(projection: Response): void {
  if (!heldStreams.has(projection)) return;
  heldStreams.delete(projection);
  void restoreCodexWsPreOutputRefusal(projection).body?.cancel().catch(() => undefined);
}

/**
 * The Pool outcome a walk step acts on, moved here from passthrough-dispatch.ts unchanged for
 * stored accounts. A request-owned caller credential (`main`) only walks on quota.
 */
export async function classifyPoolWalkOutcome(
  response: Response,
  authCtx: Extract<CodexAuthContext, { kind: "pool" | "main-pool" | "main" }>,
  routeModelId: string,
  parsedModelId: string | undefined,
  signal: AbortSignal | undefined,
): Promise<number | undefined> {
  const callerMain = authCtx.kind === "main";
  // A success is the freshest evidence there is about this pair, and it outranks any earlier
  // refusal: whatever the entitlement was when upstream declined, it is not that now. Both
  // ids are cleared because the wire model can differ from the routed one.
  if (response.ok && authCtx.kind !== "main") {
    const generation = authCtx.kind === "pool" ? authCtx.generation : undefined;
    clearCodexModelDenialEvidence(authCtx.accountId, routeModelId, generation);
    clearCodexModelDenialEvidence(authCtx.accountId, parsedModelId, generation);
  }
  const model400Denial = authCtx.kind === "main" ? undefined
    : await codexPoolAccountModel400Denial(response, routeModelId, signal, parsedModelId);
  const fixedAccount = authCtx.kind !== "main" && authCtx.fixedAccount === true;
  if (wasAccountAutoPaused(response) && !callerMain) return response.status;
  if (model400Denial !== undefined && authCtx.kind !== "main") {
    // Spend this refusal on more than one retry. It is the account's own authenticated
    // answer about this model, and the roster cache that selection otherwise reads expires
    // five minutes after a catalog sync fills it -- so without remembering this, the next
    // request selects the same account on quota alone and takes the same 400 (#4906).
    recordCodexModelDenialEvidence(authCtx.accountId, model400Denial,
      authCtx.kind === "pool" ? authCtx.generation : undefined);
    return 400;
  }
  if (!fixedAccount && await shouldRetryCodexPoolAccountQuota(response, signal)) {
    // Pre-stream only: once SSE has begun, mid-stream quota stays terminal.
    // ChatGPT sometimes wraps quota exhaustion in a generic 5xx. Normalize only
    // body-confirmed cases to quota evidence so cooldown and rotation both apply.
    return response.status >= 500 ? 429 : response.status;
  }
  // A plain transient 5xx the same-account retry layer could not absorb. Keep the real
  // status so it records as transient rather than quota.
  if (!fixedAccount && !callerMain && shouldRetryCodexPoolAccountTransient(response)) return response.status;
  return undefined;
}
