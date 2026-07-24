import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, apiFetch } from "../src/lib/api";

describe("apiFetch browser resilience", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not add a JSON content type to bodyless GET requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
      status: 200
    }));
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/field/handover/session");

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).has("Content-Type")).toBe(false);
  });

  it("keeps the JSON content type for requests with a JSON body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
      status: 200
    }));
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/field/handover/login", {
      body: JSON.stringify({ code: "654321", phone: "13900001111" }),
      method: "POST"
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
  });

  it("aborts a stalled request and returns a retryable timeout error", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = apiFetch("/field/handover/session", { timeoutMs: 50 });
    const rejection = expect(request).rejects.toEqual(
      expect.objectContaining<ApiError>({
        message: "请求超时，请检查网络后重试。",
        status: 0
      })
    );

    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(true);
  });
});
