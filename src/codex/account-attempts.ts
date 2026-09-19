import { createHash } from "node:crypto";
import type { CodexAuthContext, ResolveCodexAuthContextOptions } from "./auth-context";
import {
  CodexAccountCooldownError,
  CodexAuthContextError,
  CodexPoolAuthenticationError,
  resolveCodexAuthContext,
} from "./auth-context";
import { extractAccountId, extractEmail } from "../oauth/chatgpt";
import { nativeUserIdClaims } from "./reserve-availability";
import type { CodexAccountMode, OcxConfig } from "../types";

type Identity = { account?: string; user?: string; email?: string; bearerHash: string };

function identity(headers: Headers): Identity {
  const bearer = headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
  const claims = nativeUserIdClaims(bearer);
  return {
    account: headers.get("chatgpt-account-id") ?? extractAccountId(undefined, bearer),
    user: claims.conflict ? undefined : claims.userId,
    email: extractEmail(undefined, bearer)?.trim().toLowerCase(),
    bearerHash: createHash("sha256").update(bearer).digest("hex"),
  };
}

function sameIdentity(a: Identity, b: Identity): boolean {
  if (a.account !== b.account) return false;
  if (a.bearerHash === b.bearerHash) return true;
  if (!a.account) return false;
  if (a.user && b.user) return a.user === b.user;
  if (a.email && b.email) return a.email === b.email;
  return true;
}

/** One request owns its attempt budget. Cached percentages never spend it. */
export class CodexAccountAttempts {
  readonly excludedAccountIds = new Set<string>();
  callerAlreadyAttempted = false;
  private readonly identities: Identity[] = [];
  private readonly refreshed = new Set<string>();
  private readonly modelRetries = new Set<string>();
  private deadline: number | undefined;

  /** Do not persist these identity digests or expose them in request diagnostics. */
  visit(ctx: CodexAuthContext, headers: Headers): boolean {
    if (ctx.accountId) this.excludedAccountIds.add(ctx.accountId);
    else this.callerAlreadyAttempted = true;
    const next = identity(headers);
    if (this.identities.some(previous => sameIdentity(previous, next))) return false;
    this.identities.push(next);
    return true;
  }

  refreshOnce(ctx: CodexAuthContext): boolean {
    const key = ctx.accountId ?? "caller";
    if (this.refreshed.has(key)) return false;
    this.refreshed.add(key);
    return true;
  }

  retryModelOnce(ctx: CodexAuthContext): boolean {
    const key = ctx.accountId ?? "caller";
    if (this.modelRetries.has(key)) return false;
    this.modelRetries.add(key);
    return true;
  }

  async run<T>(parent: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const remaining = this.remainingMs();
    if (remaining === 0) throw new DOMException("Account recovery time limit reached", "TimeoutError");
    const timer = setTimeout(() => controller.abort(new DOMException("Account recovery time limit reached", "TimeoutError")), remaining);
    try { return await operation(AbortSignal.any([parent, controller.signal])); }
    finally { clearTimeout(timer); }
  }

  remainingMs(): number {
    this.deadline ??= Date.now() + 120_000;
    return Math.max(0, this.deadline - Date.now());
  }
}

/** A failed credential must not hide a later usable credential in the same Pool. */
export async function resolveAvailableCodexAuthContext(
  headers: Headers,
  config: OcxConfig,
  mode: CodexAccountMode,
  options: ResolveCodexAuthContextOptions = {},
): Promise<CodexAuthContext> {
  if (mode !== "pool" || options.accountId !== undefined) {
    return resolveCodexAuthContext(headers, config, mode, options);
  }
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)])
    : AbortSignal.timeout(120_000);
  const excluded = new Set(options.excludedAccountIds);
  let excludeAccountId = options.excludeAccountId;
  let allowQuotaProbe = false;
  let lastFailure: unknown;
  for (;;) {
    signal.throwIfAborted();
    try {
      return await resolveCodexAuthContext(headers, config, mode, {
        ...options, signal, excludeAccountId, excludedAccountIds: excluded, allowQuotaProbe,
      });
    } catch (error) {
      if (error instanceof CodexPoolAuthenticationError && !allowQuotaProbe) {
        allowQuotaProbe = true;
        continue;
      }
      if (error instanceof CodexPoolAuthenticationError && lastFailure) throw lastFailure;
      if (!(error instanceof CodexAuthContextError || error instanceof CodexAccountCooldownError)
        || !error.accountId || excluded.has(error.accountId)) throw error;
      lastFailure = error;
      excluded.add(error.accountId);
      excludeAccountId = error.accountId;
    }
  }
}
