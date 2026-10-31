import { describe, expect, test } from "bun:test";
import { httpStatusForRequestLogTerminal, inspectResponseLogJson, inspectResponseLogSsePayload, type RequestLogContext } from "../src/server/request-log";
import { httpStatusFromErrorEvent } from "../src/server/request-log-terminal-status";
import { createSseInspector } from "../src/server/relay";
import { CYBER_POLICY_ERROR_CODE } from "../src/lib/errors";

// Fork patch 1. The shape observed live (2026-09-01) for an exhausted ChatGPT account over the
// Codex WebSocket transport after the response was committed; over HTTP SSE the same request is a
// plain 429 response.
const USAGE_LIMIT_FRAME = {
  type: "error",
  error: { type: "usage_limit_reached", message: "The usage limit has been reached", plan_type: "pro", resets_at: 1788748118 },
  status_code: 429,
  headers: { "X-Codex-Primary-Used-Percent": "100", "X-Codex-Primary-Reset-At": "1788748118", "X-Codex-Secondary-Reset-At": "" },
};

describe("httpStatusFromErrorEvent", () => {
  test("reads a quota status off an error frame wrapper", () => {
    expect(httpStatusFromErrorEvent(USAGE_LIMIT_FRAME)).toBe(429);
    expect(httpStatusFromErrorEvent({ type: "error", status_code: 402 })).toBe(402);
    expect(httpStatusFromErrorEvent({ type: "error", status: 429 })).toBe(429);
  });
  test("leaves every other frame to upstream handling", () => {
    expect(httpStatusFromErrorEvent({ type: "error", error: { message: "x" } })).toBeUndefined();
    expect(httpStatusFromErrorEvent({ type: "error", status_code: 401 })).toBeUndefined();
    expect(httpStatusFromErrorEvent({ type: "error", status_code: 503 })).toBeUndefined();
    expect(httpStatusFromErrorEvent({ type: "error", status_code: "429" })).toBeUndefined();
    expect(httpStatusFromErrorEvent({ type: "error", status: 429, status_code: 429 })).toBeUndefined();
    expect(httpStatusFromErrorEvent({ type: "response.failed", status_code: 429 })).toBeUndefined();
    expect(httpStatusFromErrorEvent([USAGE_LIMIT_FRAME])).toBeUndefined();
  });
});

describe("request log inspection", () => {
  test("captures the quota status and the embedded reset headers", () => {
    const logCtx: RequestLogContext = {};
    inspectResponseLogSsePayload(logCtx, JSON.stringify(USAGE_LIMIT_FRAME));
    expect(logCtx.terminalHttpStatus).toBe(429);
    expect(logCtx.terminalQuotaResetAt).toEqual(["1788748118"]);
    expect(logCtx.terminalQuotaRetryAfter).toBeUndefined();
    // The EOF path ends such a turn as incomplete; quota must survive that mapping.
    expect(httpStatusForRequestLogTerminal("incomplete", logCtx)).toBe(429);
  });
  test("lifts Retry-After case-insensitively", () => {
    const logCtx: RequestLogContext = {};
    inspectResponseLogSsePayload(logCtx, JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" }, status_code: 429, headers: { "Retry-After": "17" } }));
    expect(logCtx.terminalHttpStatus).toBe(429);
    expect(logCtx.terminalQuotaRetryAfter).toBe("17");
  });
  test("a policy rejection keeps its 400 identity", () => {
    const logCtx: RequestLogContext = {};
    inspectResponseLogSsePayload(logCtx, JSON.stringify({ type: "error", error: { code: CYBER_POLICY_ERROR_CODE, message: "blocked" }, status_code: 429 }));
    expect(logCtx.terminalHttpStatus).toBe(400);
  });
  test("stays provisional: a genuine terminal still replaces it", () => {
    const logCtx: RequestLogContext = {};
    inspectResponseLogJson(logCtx, JSON.stringify(USAGE_LIMIT_FRAME));
    inspectResponseLogJson(logCtx, JSON.stringify({ type: "response.completed", response: { id: "r", status: "completed" } }));
    expect(logCtx.terminalHttpStatus).toBeUndefined();
  });
});

describe("SSE inspector", () => {
  test("leaves the terminal to the EOF path, which then reads quota", () => {
    const logCtx: RequestLogContext = {};
    const inspector = createSseInspector({ onTerminal: () => {}, logCtx });
    inspector.feed(new TextEncoder().encode(`event: error\ndata: ${JSON.stringify(USAGE_LIMIT_FRAME)}\n\n`));
    inspector.finish();
    expect(inspector.reported()).toBe(false);
    expect(logCtx.terminalHttpStatus).toBe(429);
    inspector.dispose();
  });
});
