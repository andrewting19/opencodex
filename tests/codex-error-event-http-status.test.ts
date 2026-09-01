import { describe, expect, test } from "bun:test";
import {
  httpStatusFromErrorEvent,
  httpStatusForRequestLogTerminal,
  inspectResponseLogSsePayload,
  type RequestLogContext,
} from "../src/server/request-log";
import { createSseInspector, terminalStatusFromParsed } from "../src/server/relay";
import { CYBER_POLICY_ERROR_CODE } from "../src/lib/errors";

// The Codex websocket transport accepts the upgrade and then delivers an HTTP-style
// rejection as an `error` frame. This is the shape observed live (2026-09-01) for an
// exhausted ChatGPT account; over HTTP SSE the same request is a plain 429 response.
const USAGE_LIMIT_FRAME = {
  type: "error",
  error: {
    type: "usage_limit_reached",
    message: "The usage limit has been reached",
    plan_type: "pro",
    resets_at: 1788748118,
    resets_in_seconds: 458416,
  },
  status_code: 429,
  headers: {
    "X-Codex-Primary-Used-Percent": "100",
    "X-Codex-Primary-Window-Minutes": "10080",
    "X-Codex-Primary-Reset-At": "1788748118",
    "X-Codex-Secondary-Reset-At": "",
  },
};

describe("httpStatusFromErrorEvent", () => {
  test("reads an integer 4xx/5xx status_code off an error event", () => {
    expect(httpStatusFromErrorEvent(USAGE_LIMIT_FRAME)).toBe(429);
    expect(httpStatusFromErrorEvent({ type: "error", status_code: 503 })).toBe(503);
  });

  test("ignores anything that is not an HTTP rejection", () => {
    expect(httpStatusFromErrorEvent({ type: "error", error: { message: "x" } })).toBeUndefined();
    expect(httpStatusFromErrorEvent({ type: "error", status_code: "429" })).toBeUndefined();
    expect(httpStatusFromErrorEvent({ type: "error", status_code: 200 })).toBeUndefined();
    expect(httpStatusFromErrorEvent({ type: "error", status_code: 429.5 })).toBeUndefined();
    expect(httpStatusFromErrorEvent({ type: "response.failed", status_code: 429 })).toBeUndefined();
    expect(httpStatusFromErrorEvent(null)).toBeUndefined();
    expect(httpStatusFromErrorEvent([USAGE_LIMIT_FRAME])).toBeUndefined();
  });
});

describe("terminalStatusFromParsed", () => {
  test("an error event standing in for an HTTP rejection is a failed terminal", () => {
    expect(terminalStatusFromParsed(USAGE_LIMIT_FRAME)).toBe("failed");
  });

  test("a bare error event without a status is still not a terminal", () => {
    expect(terminalStatusFromParsed({ type: "error", error: { message: "x" } })).toBeNull();
  });
});

describe("request log inspection of an error event", () => {
  test("captures the HTTP status and the embedded quota reset headers", () => {
    const logCtx: RequestLogContext = {};
    inspectResponseLogSsePayload(logCtx, JSON.stringify(USAGE_LIMIT_FRAME));
    expect(logCtx.terminalHttpStatus).toBe(429);
    expect(logCtx.terminalQuotaResetAt).toEqual(["1788748118"]);
    expect(logCtx.terminalQuotaRetryAfter).toBeUndefined();
    expect(logCtx.upstreamError).toBe("The usage limit has been reached");
    expect(httpStatusForRequestLogTerminal("failed", logCtx)).toBe(429);
  });

  test("lifts Retry-After case-insensitively", () => {
    const logCtx: RequestLogContext = {};
    inspectResponseLogSsePayload(logCtx, JSON.stringify({
      type: "error",
      error: { type: "rate_limit_error", message: "slow down" },
      status_code: 429,
      headers: { "retry-after": "17" },
    }));
    expect(logCtx.terminalHttpStatus).toBe(429);
    expect(logCtx.terminalQuotaRetryAfter).toBe("17");
    expect(logCtx.terminalQuotaResetAt).toBeUndefined();
  });

  test("a policy rejection keeps its 400 identity even with a status_code", () => {
    const logCtx: RequestLogContext = {};
    inspectResponseLogSsePayload(logCtx, JSON.stringify({
      type: "error",
      error: { code: CYBER_POLICY_ERROR_CODE, message: "blocked" },
      status_code: 429,
    }));
    expect(logCtx.terminalHttpStatus).toBe(400);
  });

  test("a bare error event leaves the terminal status unset, as before", () => {
    const logCtx: RequestLogContext = {};
    inspectResponseLogSsePayload(logCtx, JSON.stringify({ type: "error", error: { message: "x" } }));
    expect(logCtx.terminalHttpStatus).toBeUndefined();
    expect(logCtx.terminalQuotaResetAt).toBeUndefined();
  });
});

describe("SSE inspector", () => {
  test("reports a failed terminal with the rejection status instead of an EOF incomplete", () => {
    const logCtx: RequestLogContext = {};
    const terminals: Array<[string, number | undefined]> = [];
    const inspector = createSseInspector({
      onTerminal: (status, httpStatusOverride) => { terminals.push([status, httpStatusOverride]); },
      logCtx,
    });
    const encoder = new TextEncoder();
    inspector.feed(encoder.encode(`event: error\ndata: ${JSON.stringify(USAGE_LIMIT_FRAME)}\n\n`));
    inspector.finish();
    expect(inspector.reported()).toBe(true);
    expect(terminals).toEqual([["failed", 429]]);
    expect(logCtx.terminalHttpStatus).toBe(429);
    expect(logCtx.terminalSource).toBe("upstream");
    inspector.dispose();
  });

  test("a bare error event still leaves the terminal to the EOF path", () => {
    const terminals: string[] = [];
    const inspector = createSseInspector({
      onTerminal: status => { terminals.push(status); },
      logCtx: {},
    });
    inspector.feed(new TextEncoder().encode(`event: error\ndata: {"type":"error","error":{"message":"x"}}\n\n`));
    inspector.finish();
    expect(inspector.reported()).toBe(false);
    expect(terminals).toEqual([]);
    inspector.dispose();
  });
});
