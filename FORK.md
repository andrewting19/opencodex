# opencodex fork: local patch stack

Fork of https://github.com/lidge-jun/opencodex maintained at
https://github.com/andrewting19/opencodex. Product branch: fork/main.
The main branch mirrors upstream so upgrade diffs stay one command away.

## Why this fork exists

Five fixes matter for multi-account operation and are not upstream:

1. In-stream error frames are HTTP rejections (relay.ts, request-log.ts,
   responses/core.ts, tests/codex-error-event-http-status.test.ts).
   Over the responses_websockets transport the backend can deliver a quota
   rejection as an error frame carrying status_code and headers instead of an
   HTTP 429. Before this patch the relay treated it as no terminal: the turn
   logged as 502, the account-health recorder counted an incomplete success,
   so an exhausted account never entered cooldown and was re-selected every
   turn. The patch maps the frame to its HTTP status and forwards the embedded
   Retry-After / x-codex-*-reset-at hints to the cooldown recorder.

2. Stale pool quota self-heals (quota-staleness-primer.ts new file; edits in
   auth-api.ts, auth-context.ts, quota-recovery-timing.ts, server/index.ts).
   primeCodexPoolQuotas only ran at startup, on subagent spawn, on management
   mutations, and pre-route when the selected account had NO stored quota, so
   a stored 100% reading never expired. After an early quota-window reset (a
   consumed reset credit, a plan change) the dashboard kept reporting no usage
   on accounts that still had quota and rotation kept them cooled. The patch
   runs the existing single-flight prime from the 60 second state-sweep tick,
   fires the pre-route and main-account primers on stale rows as well as
   missing ones, and shares one staleness constant, CODEX_POOL_QUOTA_STALE_MS,
   between writers and readers.

3. Prefer a distinct caller credential over an exhausted Pool selection
   (`auth-context.ts`). A request-owned main login is outside stored Pool selection.
   A fresh 100% reading or a due cooldown probe must not send that request to an
   exhausted stored account while the caller can serve it. This applies before
   dispatch and keeps exact selectors, identity checks, independent quota scopes,
   entitlement checks, and existing cooldown state.

4. Remove obsolete quota windows after a complete usage refresh (`quota.ts`,
   `auth-api.ts`). The old merge kept a 100% monthly window after OpenAI changed
   an account to a weekly window. This made a usable account appear exhausted.
   A complete WHAM response now replaces the standard windows for both main and
   stored accounts. Partial headers, incomplete responses, and credits-only
   responses still preserve known windows. Tests cover third-account selection,
   main policy evidence, and real monthly and five-hour exhaustion.

5. Request-owned account recovery and quota observation order (`account-attempts.ts`,
   `auth-context.ts`, `routing.ts`, `quota.ts`, and Responses/compact handlers).
   Recovery considers every distinct eligible account before returning a quota error.
   Token refresh is bounded per account. Cached percentages only affect ordering.
   Caller-owned credentials remain private to the request. HTTP and WebSocket quota
   failures can recover before output; tool or output events end that recovery window.
   Weekly, monthly, and short windows retain separate observation times. Delayed usage
   polls cannot replace newer quota evidence. Pauses, exact selectors, Reserve policy,
   explicit Retry-After, credential generations, and probe leases remain enforced.
   Client turn checkpoints are required for recovery after output has started.

## Rebase procedure after each upstream release

1. git fetch upstream --tags
2. git log --oneline upstream/vX.Y.Z..fork/main  (the commits above are the whole stack)
3. git checkout -B fork/main upstream/vX.Y.Z
4. git cherry-pick the stack commits, oldest first.
5. Anchors if conflicts appear: POOL_CACHE_TTL and the primeMain guard line
   if (getAccountQuota(MAIN_CODEX_ACCOUNT_ID)) return; in src/codex/auth-api.ts;
   the Lazy prime block in src/codex/auth-context.ts; the worker registration
   beside registerCodexQuotaAutoRefreshWorker in src/server/index.ts; and
   case error in terminalStatusFromParsed in src/server/relay.ts.
6. Verify: bun test on tests/codex-integration/codex-quota-prime.test.ts,
   codex-auth-context.test.ts, and tests/codex-error-event-http-status.test.ts;
   bun x tsc --noEmit.
7. git push -f origin fork/main
8. Deploy, then confirm ~/.opencodex/codex-quota-cache.json refreshes itself
   within about 6 minutes of boot with no traffic.

## Deploying to a machine

The runtime is a global npm install of the @bitkyc08/opencodex package:

- Tarball (recommended): from a prepared checkout run bun run build:gui to
  build dashboard assets, then npm pack. Install on the target with
  npm i -g ./opencodex-VERSION.tgz and restart via ocx service or
  ocx restart. The same artifact runs everywhere.
- Git install: npm i -g github:andrewting19/opencodex#fork/main (runs the
  prepare hook; needs bun on the target).

Local state under ~/.opencodex (accounts, config, quota cache) is untouched by
either path. The patch stack is tied to version numbers only through the
anchors above; re-check them after every upstream release.
