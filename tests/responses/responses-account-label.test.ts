import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fallbackCodexAccountLogLabel } from "../../src/codex/account-label";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountQuota, getAccountQuota, updateAccountQuota } from "../../src/codex/auth-api";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/main-account";
import {
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  getCodexUpstreamHealth,
  recordCodexUpstreamOutcome,
} from "../../src/codex/routing";
import type { RequestLogContext } from "../../src/server/request-log";
import { handleResponses } from "../../src/server/responses";
import { handleResponsesCompact } from "../../src/server/responses/compact";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { CodexWsMetadata } from "../../src/server/responses/codex-ws-metadata";
import { applyAccountQuotaFromUpstreamHeaders, getAccountQuotaHistory } from "../../src/codex/quota";

const originalFetch = globalThis.fetch;
let releaseSpendHome: (() => void) | undefined;

// Taken only by callbacks that physically dispatch, after withPoolHome installs their home.
const takeSpendHome = (): void => { releaseSpendHome = acquireOwnedSpendHome(); };

function poolConfig(accountIds: string[]): OcxConfig {
  return {
    defaultProvider: "openai",
    activeCodexAccountId: accountIds[0],
    autoSwitchThreshold: 0,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    codexAccounts: accountIds.map(id => ({
      id,
      email: `${id}@example.test`,
      isMain: false,
      chatgptAccountId: `${id}_chatgpt`,
    })),
  } as OcxConfig;
}

function completedResponse(id: string): Response {
  return Response.json({
    id,
    status: "completed",
    output: [],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  });
}

function request(): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.5", input: "hello", stream: false }),
  });
}

function savePoolCredential(id: string): void {
  saveCodexAccountCredential(id, {
    accessToken: `${id}-access-token`,
    refreshToken: `${id}-refresh-token`,
    expiresAt: Date.now() + 300_000,
    chatgptAccountId: `${id}_chatgpt`,
  });
}

async function withPoolHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "ocx-responses-account-label-"));
  const previousOpencodexHome = process.env.OPENCODEX_HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountQuota();
  try {
    return await run(home);
  } finally {
    // Released before the helper removes or restores the home so its lease cannot outlive it.
    releaseSpendHome?.();
    releaseSpendHome = undefined;
    globalThis.fetch = originalFetch;
    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    clearAccountQuota();
    removeTreeWithRetry(home);
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Responses account usage attribution", () => {
  test("interleaved old WS metadata cannot overwrite a newer account observation", async () => {
    await withPoolHome(async () => {
      const old = new CodexWsMetadata(headers => applyAccountQuotaFromUpstreamHeaders("observed-account", headers));
      old.commit();
      old.consume({ type: "codex.rate_limits", rate_limits: { primary: { used_percent: 10, reset_at: 1900000000 } } }, 100);
      updateAccountQuota("observed-account", 90);
      const before = { ...getAccountQuota("observed-account")! };
      old.consume({ type: "codex.response.metadata", headers: { "x-models-etag": "changed" } }, 100);
      old.consume({ type: "codex.rate_limits", metered_limit_name: "codex_bengalfox", rate_limits: { primary: { used_percent: 1 } } }, 100);
      expect(getAccountQuota("observed-account")).toEqual(before);
      old.consume({ type: "codex.rate_limits", rate_limits: { primary: { used_percent: 91 } } }, 100);
      expect(getAccountQuota("observed-account")?.weeklyPercent).toBe(91);
      expect(getAccountQuota("observed-account")?.weeklyResetAt).toBeUndefined();
      old.finish();
    });
  });

  test("immediate WS quota observation preserves disjoint windows and credits-only interleaving", async () => {
    await withPoolHome(async () => {
      const { setAccountQuotaFromParsed } = await import("../../src/codex/quota");
      const owner = new CodexWsMetadata(headers => applyAccountQuotaFromUpstreamHeaders("window-account", headers));
      owner.consume({ type: "codex.rate_limits", rate_limits: {
        primary: { used_percent: 100, window_minutes: 300, reset_at: 1900000000 },
        secondary: { used_percent: 20, window_minutes: 10080 },
      } }, 100);
      setAccountQuotaFromParsed("window-account", { resetCredits: 3 });
      owner.consume({ type: "codex.rate_limits", rate_limits: { secondary: { used_percent: 21, window_minutes: 10080 } } }, 100);
      owner.finish();
      expect(getAccountQuota("window-account")).toMatchObject({ shortPercent: 100, shortWindowSeconds: 18000, weeklyPercent: 21, resetCredits: 3 });
    });
  });

  test("WS prelude and final quota stay with the selected pool or main-pool account", async () => {
    const originalWebSocket = globalThis.WebSocket;
    try {
      await withPoolHome(async home => {
        takeSpendHome();
        writeFileSync(join(home, "auth.json"), JSON.stringify({
          tokens: { access_token: "main-access-token", account_id: "main-account" },
        }));
        savePoolCredential("pool-ws");
        class MetadataSocket {
          listeners = new Map<string, Array<(event: unknown) => void>>();
          constructor() { queueMicrotask(() => this.emit("open", {})); }
          addEventListener(type: string, listener: (event: unknown) => void) {
            this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
          }
          removeEventListener(type: string, listener: (event: unknown) => void) {
            this.listeners.set(type, (this.listeners.get(type) ?? []).filter(value => value !== listener));
          }
          emit(type: string, event: unknown) {
            for (const listener of this.listeners.get(type) ?? []) listener(event);
          }
          send() {
            queueMicrotask(() => {
              const payload = (value: unknown) => this.emit("message", { data: JSON.stringify(value) });
              const quota = (percent: number) => payload({ type: "codex.rate_limits", rate_limits: {
                primary: { used_percent: percent, window_minutes: 10080, reset_at: 1900000000 },
              } });
              quota(10);
              payload({ type: "response.created", response: { id: "quota-response" } });
              quota(20);
              payload({ type: "response.completed", response: { id: "quota-response", status: "completed", output: [] } });
            });
          }
          close() { this.emit("close", {}); }
        }
        globalThis.WebSocket = MetadataSocket as unknown as typeof WebSocket;
        globalThis.fetch = (async () => { throw new Error("unexpected HTTP request"); }) as typeof fetch;
        for (const accountId of ["pool-ws", MAIN_CODEX_ACCOUNT_ID]) {
          clearAccountQuota();
          updateAccountQuota(accountId, 0);
          updateAccountQuota("untouched-account", 7);
          const config = poolConfig(accountId === MAIN_CODEX_ACCOUNT_ID ? [] : [accountId]);
          config.activeCodexAccountId = accountId;
          const req = new Request("http://localhost/v1/responses", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "gpt-5.5", input: "hello", stream: true }),
          });
          const response = await handleResponses(req, config, { model: "", provider: "" }, {
            codexWsRuntimeIdentity: "1.4.0",
          });
          expect(response.status).toBe(200);
          expect(response.headers.get("x-codex-primary-used-percent")).toBe("10");
          await response.text();
          expect(getAccountQuota(accountId)?.weeklyPercent).toBe(20);
          expect(getAccountQuota("untouched-account")?.weeklyPercent).toBe(7);
          expect(getAccountQuotaHistory(accountId).observations.map(row => row.windows[0].usedPercent))
            .toEqual(accountId === MAIN_CODEX_ACCOUNT_ID ? [] : [10, 20]);
        }
      });
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });

  test("late WS quota from a replaced pool credential cannot repopulate cleared state", async () => {
    const originalWebSocket = globalThis.WebSocket;
    let releaseFinalQuota!: () => void;
    const finalQuotaAllowed = new Promise<void>(resolve => { releaseFinalQuota = resolve; });
    try {
      await withPoolHome(async () => {
        takeSpendHome();
        savePoolCredential("pool-ws-replaced");
        class MetadataSocket {
          listeners = new Map<string, Array<(event: unknown) => void>>();
          constructor() { queueMicrotask(() => this.emit("open", {})); }
          addEventListener(type: string, listener: (event: unknown) => void) {
            this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
          }
          removeEventListener(type: string, listener: (event: unknown) => void) {
            this.listeners.set(type, (this.listeners.get(type) ?? []).filter(value => value !== listener));
          }
          emit(type: string, event: unknown) {
            for (const listener of this.listeners.get(type) ?? []) listener(event);
          }
          send() {
            const payload = (value: unknown) => this.emit("message", { data: JSON.stringify(value) });
            queueMicrotask(() => {
              payload({ type: "codex.rate_limits", rate_limits: {
                primary: { used_percent: 10, window_minutes: 10080 },
              } });
              payload({ type: "response.created", response: { id: "quota-response" } });
              void finalQuotaAllowed.then(() => {
                payload({ type: "codex.rate_limits", rate_limits: {
                  primary: { used_percent: 100, window_minutes: 10080 },
                } });
                payload({ type: "response.completed", response: { id: "quota-response", status: "completed", output: [] } });
              });
            });
          }
          close() { this.emit("close", {}); }
        }
        globalThis.WebSocket = MetadataSocket as unknown as typeof WebSocket;
        globalThis.fetch = (async () => { throw new Error("unexpected HTTP request"); }) as typeof fetch;
        const response = await handleResponses(new Request("http://localhost/v1/responses", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-5.5", input: "hello", stream: true }),
        }), poolConfig(["pool-ws-replaced"]), { model: "", provider: "" }, {
          codexWsRuntimeIdentity: "1.4.0",
        });
        expect(getAccountQuota("pool-ws-replaced")?.weeklyPercent).toBe(10);
        expect(getAccountQuotaHistory("pool-ws-replaced").observations.map(row => row.windows[0].usedPercent)).toEqual([10]);

        savePoolCredential("pool-ws-replaced");
        clearAccountQuota("pool-ws-replaced");
        releaseFinalQuota();
        await response.text();

        expect(getAccountQuota("pool-ws-replaced")).toBeNull();
        expect(getAccountQuotaHistory("pool-ws-replaced").observations).toEqual([]);
      });
    } finally {
      releaseFinalQuota();
      globalThis.WebSocket = originalWebSocket;
    }
  });

  test("main-pool and legacy added accounts carry their effective labels", async () => {
    await withPoolHome(async home => {
      takeSpendHome();
      writeFileSync(join(home, "auth.json"), JSON.stringify({
        tokens: { access_token: "main-access-token", account_id: "main-account" },
      }));
      updateAccountQuota(MAIN_CODEX_ACCOUNT_ID, 0);
      globalThis.fetch = (async () => completedResponse("main-response")) as typeof fetch;

      const mainConfig = poolConfig([]);
      mainConfig.activeCodexAccountId = MAIN_CODEX_ACCOUNT_ID;
      const mainLog: RequestLogContext = { model: "", provider: "" };
      expect((await handleResponses(request(), mainConfig, mainLog, {})).status).toBe(200);
      expect(mainLog.accountLogLabel).toBe("main");
      expect(mainLog.activeAttempt?.accountLogLabel).toBe("main");

      const poolConfigValue = poolConfig(["pool-a"]);
      savePoolCredential("pool-a");
      updateAccountQuota("pool-a", 0);
      const poolLog: RequestLogContext = { model: "", provider: "" };
      expect((await handleResponses(request(), poolConfigValue, poolLog, {})).status).toBe(200);
      expect(poolLog.accountLogLabel).toBe(fallbackCodexAccountLogLabel("pool-a"));
      expect(poolLog.activeAttempt?.accountLogLabel).toBe(fallbackCodexAccountLogLabel("pool-a"));
    });
  });

  test("a pre-stream quota retry updates attribution to the serving alternate account", async () => {
    await withPoolHome(async () => {
      takeSpendHome();
      const config = poolConfig(["pool-a", "pool-b"]);
      for (const id of ["pool-a", "pool-b"]) {
        savePoolCredential(id);
        updateAccountQuota(id, id === "pool-a" ? 10 : 20);
      }
      const bearers: string[] = [];
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const bearer = new Headers(init?.headers).get("authorization") ?? "";
        bearers.push(bearer);
        if (bearers.length === 1) {
          return Response.json({ error: { message: "rate limited" } }, {
            status: 429,
            headers: { "retry-after": "42" },
          });
        }
        return completedResponse("pool-b-response");
      }) as typeof fetch;

      const logCtx: RequestLogContext = { model: "", provider: "" };
      const response = await handleResponses(request(), config, logCtx, {});

      expect(response.status).toBe(200);
      expect(bearers).toEqual(["Bearer pool-a-access-token", "Bearer pool-b-access-token"]);
      expect(logCtx.accountLogLabel).toBe(fallbackCodexAccountLogLabel("pool-b"));
      expect(logCtx.activeAttempt?.accountLogLabel).toBe(fallbackCodexAccountLogLabel("pool-b"));
    });
  });

  test("a quota message wrapped in HTTP 502 cools the account and retries an alternate", async () => {
    await withPoolHome(async () => {
      takeSpendHome();
      const config = poolConfig(["pool-a", "pool-b"]);
      for (const id of ["pool-a", "pool-b"]) {
        savePoolCredential(id);
        updateAccountQuota(id, id === "pool-a" ? 10 : 20);
      }
      const bearers: string[] = [];
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const bearer = new Headers(init?.headers).get("authorization") ?? "";
        bearers.push(bearer);
        if (bearer === "Bearer pool-a-access-token") {
          return Response.json({ error: { message: "The usage limit has been reached" } }, {
            status: 502,
          });
        }
        return completedResponse("pool-b-response");
      }) as typeof fetch;

      const response = await handleResponses(request(), config, { model: "", provider: "" }, {});

      expect(response.status).toBe(200);
      expect(bearers).toEqual([
        "Bearer pool-a-access-token",
        "Bearer pool-a-access-token",
        "Bearer pool-a-access-token",
        "Bearer pool-b-access-token",
      ]);
      expect(getCodexUpstreamHealth("pool-a")).toMatchObject({
        lastFailureStatus: 429,
        cooldownSource: "default",
      });
      expect(getCodexUpstreamHealth("pool-a")?.cooldownUntil).toBeGreaterThan(Date.now());
    });
  });

  // Pool health reads a 429 as the account saying it is out of quota. The replay refusal wears
  // the same status but no upstream produced it, so recording it would cool a credential that
  // refused nothing -- and the cooldown outlives the request that invented it.
  test("a refused reset replay is not quota evidence and invites no client retry", async () => {
    await withPoolHome(async () => {
      takeSpendHome();
      const config = poolConfig(["pool-a"]);
      savePoolCredential("pool-a");
      updateAccountQuota("pool-a", 10);
      let sends = 0;
      globalThis.fetch = (async () => {
        sends += 1;
        throw Object.assign(new Error("The socket connection was closed unexpectedly."), { code: "ECONNRESET" });
      }) as typeof fetch;

      const response = await handleResponses(request(), config, { model: "", provider: "" }, {});

      expect(response.status).toBe(429);
      expect(sends).toBe(1);
      expect((await response.json() as { error?: { code?: string } }).error?.code)
        .toBe("upstream_reset_replay_refused");
      expect(response.headers.get("Retry-After")).toBeNull();
      expect(getCodexUpstreamHealth("pool-a")?.lastFailureStatus).toBeUndefined();
      expect(getCodexUpstreamHealth("pool-a")?.cooldownUntil).toBeUndefined();
    });
  });

  test("a wrapped quota failure cools a sole account when no alternate exists", async () => {
    await withPoolHome(async () => {
      takeSpendHome();
      const config = poolConfig(["pool-a"]);
      savePoolCredential("pool-a");
      updateAccountQuota("pool-a", 10);
      let sends = 0;
      globalThis.fetch = (async () => {
        sends += 1;
        return Response.json({ error: { message: "The usage limit has been reached" } }, {
          status: 502,
        });
      }) as typeof fetch;

      const response = await handleResponses(request(), config, { model: "", provider: "" }, {});

      expect(response.status).toBe(502);
      expect(sends).toBe(3);
      expect(getCodexUpstreamHealth("pool-a")).toMatchObject({
        cooldownSource: "default",
      });
      expect(getCodexUpstreamHealth("pool-a")?.cooldownUntil).toBeGreaterThan(Date.now());
    });
  });
});

describe("request-owned Codex account recovery", () => {
  for (const healthyIndex of [0, 1, 2]) {
    test(`finds healthy account ${healthyIndex + 1} when every cache says exhausted`, async () => {
      await withPoolHome(async () => {
        takeSpendHome();
        const ids = ["recovery-a", "recovery-b", "recovery-c"];
        const config = poolConfig(ids);
        config.accountPoolStrategy = "fill-first";
        ids.forEach(id => { savePoolCredential(id); updateAccountQuota(id, 100, undefined, 100); });
        const sends: string[] = [];
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input).includes("wham")) throw new Error("quota refresh unavailable");
          const account = new Headers(init?.headers).get("chatgpt-account-id")!;
          sends.push(account);
          return account === `${ids[healthyIndex]}_chatgpt` ? completedResponse("recovered")
            : Response.json({ error: { code: "usage_limit_reached", message: "usage limit reached" } }, { status: 429 });
        }) as typeof fetch;
        const response = await handleResponses(request(), config, { model: "", provider: "" });
        expect(response.status).toBe(200);
        expect(sends).toEqual(ids.slice(0, healthyIndex + 1).map(id => `${id}_chatgpt`));
      });
    });
  }

  test("tries each account once when all accounts reject the request", async () => {
    await withPoolHome(async () => {
      takeSpendHome();
      const ids = ["recovery-a", "recovery-b", "recovery-c"];
      const config = poolConfig(ids);
      config.accountPoolStrategy = "fill-first";
      ids.forEach(id => { savePoolCredential(id); updateAccountQuota(id, 0); });
      const sends: string[] = [];
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        sends.push(new Headers(init?.headers).get("chatgpt-account-id")!);
        return Response.json({ error: { message: "usage limit reached" } }, { status: 429 });
      }) as typeof fetch;
      const response = await handleResponses(request(), config, { model: "", provider: "" });
      expect(response.status).toBe(429);
      expect(sends).toEqual(ids.map(id => `${id}_chatgpt`));
    });
  });

  for (const committed of [false, true]) {
    test(`${committed ? "keeps" : "recovers"} a quota SSE failure ${committed ? "after" : "before"} output`, async () => {
      await withPoolHome(async () => {
        takeSpendHome();
        const ids = ["stream-a", "stream-b", "stream-c"];
        const config = poolConfig(ids);
        config.accountPoolStrategy = "fill-first";
        ids.forEach(id => { savePoolCredential(id); updateAccountQuota(id, 0); });
        const sends: string[] = [];
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
          const id = new Headers(init?.headers).get("chatgpt-account-id")!;
          sends.push(id);
          if (id === "stream-c_chatgpt") return completedResponse("recovered");
          const events: unknown[] = [{ type: "response.created", response: { id: "failed-turn" } }];
          if (committed) events.push({ type: "response.output_item.added", item: { type: "function_call", name: "write_file", call_id: "call_1", arguments: "{}" } });
          events.push({ type: "response.failed", response: { status: "failed", error: { code: "usage_limit_reached", message: "usage limit reached" } } });
          return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
        }) as typeof fetch;
        const response = await handleResponses(request(), config, { model: "", provider: "" });
        await response.text();
        expect(sends).toEqual((committed ? ids.slice(0, 1) : ids).map(id => `${id}_chatgpt`));
        expect(response.status).toBe(200);
      });
    });
  }

  test("does not send twice to duplicate stored subscriptions", async () => {
    await withPoolHome(async () => {
      takeSpendHome();
      const ids = ["duplicate-a", "duplicate-b", "healthy-c"];
      const config = poolConfig(ids);
      config.accountPoolStrategy = "fill-first";
      ids.forEach(id => { savePoolCredential(id); updateAccountQuota(id, 0); });
      saveCodexAccountCredential("duplicate-b", {
        accessToken: "duplicate-rotated-token", refreshToken: "duplicate-refresh", expiresAt: Date.now() + 300_000,
        chatgptAccountId: "duplicate-a_chatgpt",
      });
      const sends: string[] = [];
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const id = new Headers(init?.headers).get("chatgpt-account-id")!;
        sends.push(id);
        return id === "healthy-c_chatgpt" ? completedResponse("recovered")
          : Response.json({ error: { message: "usage limit reached" } }, { status: 429 });
      }) as typeof fetch;
      const response = await handleResponses(request(), config, { model: "", provider: "" });
      expect(response.status).toBe(200);
      expect(sends).toEqual(["duplicate-a_chatgpt", "healthy-c_chatgpt"]);
    });
  });
});

test("a request-owned main credential can fail over through the full Pool", async () => {
  await withPoolHome(async () => {
    takeSpendHome();
    const config = poolConfig(["caller-a", "caller-b"]);
    config.accountPoolStrategy = "fill-first";
    config.activeCodexAccountId = MAIN_CODEX_ACCOUNT_ID;
    config.activeCodexAccountPinned = MAIN_CODEX_ACCOUNT_ID;
    updateAccountQuota(MAIN_CODEX_ACCOUNT_ID, 0);
    for (const id of ["caller-a", "caller-b"]) { savePoolCredential(id); updateAccountQuota(id, 0); }
    const sends: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const account = new Headers(init?.headers).get("chatgpt-account-id")!;
      sends.push(account);
      return account === "caller-b_chatgpt" ? completedResponse("recovered")
        : Response.json({ error: { message: "usage limit reached" } }, { status: 429 });
    }) as typeof fetch;
    const req = request();
    req.headers.set("authorization", "Bearer caller-owned-access");
    req.headers.set("chatgpt-account-id", "caller-owned-chatgpt");
    const response = await handleResponses(req, config, { model: "", provider: "" });
    expect(response.status).toBe(200);
    expect(sends).toEqual(["caller-owned-chatgpt", "caller-a_chatgpt", "caller-b_chatgpt"]);
  });
});

test("each account can refresh its own token before recovery reaches the third account", async () => {
  await withPoolHome(async () => {
    takeSpendHome();
    const ids = ["refresh-a", "refresh-b", "refresh-c"];
    const config = poolConfig(ids);
    config.accountPoolStrategy = "fill-first";
    ids.forEach(id => { savePoolCredential(id); updateAccountQuota(id, 0); });
    const sends: string[] = [];
    const refreshes: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/oauth/token")) {
        const grant = new URLSearchParams(String(init?.body)).get("refresh_token")!;
        refreshes.push(grant);
        const id = grant.replace(/-refresh-token$/, "");
        return Response.json({ access_token: `${id}-renewed`, refresh_token: grant, expires_in: 3600 });
      }
      const auth = new Headers(init?.headers).get("authorization")!;
      sends.push(auth);
      if (auth === "Bearer refresh-c-access-token") return completedResponse("recovered");
      return Response.json({ error: { message: auth.endsWith("renewed") ? "usage limit reached" : "invalid token" } }, { status: auth.endsWith("renewed") ? 429 : 401 });
    }) as typeof fetch;
    const response = await handleResponses(request(), config, { model: "", provider: "" });
    expect(response.status).toBe(200);
    expect(sends).toEqual(["Bearer refresh-a-access-token", "Bearer refresh-a-renewed", "Bearer refresh-b-access-token", "Bearer refresh-b-renewed", "Bearer refresh-c-access-token"]);
    expect(refreshes).toEqual(["refresh-a-refresh-token", "refresh-b-refresh-token"]);
  });
});

test("recovery can probe an untried account with a due reset-derived cooldown", async () => {
  await withPoolHome(async () => {
    takeSpendHome();
    const ids = ["probe-a", "probe-b", "probe-c"];
    const config = poolConfig(ids);
    config.accountPoolStrategy = "fill-first";
    ids.forEach(id => { savePoolCredential(id); updateAccountQuota(id, 0); });
    recordCodexUpstreamOutcome(config, "probe-c", 429, {
      now: Date.now() - 6 * 60_000, resetAt: String(Math.floor(Date.now() / 1000) + 3600), modelId: "gpt-5.5",
    });
    const sends: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const account = new Headers(init?.headers).get("chatgpt-account-id")!;
      sends.push(account);
      return account === "probe-c_chatgpt" ? completedResponse("recovered")
        : Response.json({ error: { message: "usage limit reached" } }, { status: 429 });
    }) as typeof fetch;
    const response = await handleResponses(request(), config, { model: "", provider: "" });
    expect(response.status).toBe(200);
    expect(sends).toEqual(ids.map(id => `${id}_chatgpt`));
  });
});

for (const status of [429, 502]) {
  test(`native compaction reaches the third account after ${status} quota failures`, async () => {
    await withPoolHome(async () => {
      takeSpendHome();
      const ids = ["compact-a", "compact-b", "compact-c"];
      const config = poolConfig(ids);
      config.accountPoolStrategy = "fill-first";
      ids.forEach(id => { savePoolCredential(id); updateAccountQuota(id, 100); });
      const sends: string[] = [];
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const account = new Headers(init?.headers).get("chatgpt-account-id")!;
        sends.push(account);
        return account === "compact-c_chatgpt" ? completedResponse("compacted")
          : Response.json({ error: { message: "usage limit reached" } }, { status });
      }) as typeof fetch;
      const req = new Request("http://localhost/v1/responses/compact", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-5.5", input: "hello" }) });
      const response = await handleResponsesCompact(req, config, { model: "", provider: "" });
      expect(response.status).toBe(200);
      expect(sends).toEqual((status === 502 ? [ids[0], ids[0], ...ids] : ids).map(id => `${id}_chatgpt`));
    });
  });
}
