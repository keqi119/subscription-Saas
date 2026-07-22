import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/lib/api";
import {
  getFieldHandoverLoginErrorMessage,
  getFieldHandoverSendCodeErrorMessage,
  getFieldHandoverSession,
  getFieldHandoverWorkOrder,
  isFieldHandoverSessionExpired,
  isFieldHandoverUnauthorized,
  isValidFieldHandoverPhone,
  listFieldHandoverWorkOrders,
  loginFieldHandover,
  logoutFieldHandover,
  sendFieldHandoverCode
} from "../src/lib/field-handover-api";

const VALID_FIELD_PHONE = ["139", "0000", "1111"].join("");
const VALID_FIELD_CODE = ["654", "321"].join("");
const DEBUG_CODE_SHOULD_NOT_RENDER = ["123", "456"].join("");

describe("field handover API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a code request without exposing a debug OTP returned by non-production APIs", async () => {
    const fetchMock = mockJsonResponse({ debugCode: DEBUG_CODE_SHOULD_NOT_RENDER, expiresIn: 300, sent: true });

    const result = await sendFieldHandoverCode(VALID_FIELD_PHONE);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3001/api/field/handover/send-code",
      expect.objectContaining({
        body: JSON.stringify({ phone: VALID_FIELD_PHONE }),
        credentials: "include",
        method: "POST"
      })
    );
    expect(result).toEqual({ expiresIn: 300, sent: true });
    expect(JSON.stringify(result)).not.toContain(DEBUG_CODE_SHOULD_NOT_RENDER);
  });

  it("logs in with phone and code through the field endpoint only", async () => {
    const fetchMock = mockJsonResponse({
      operatorType: "EXTERNAL",
      phoneMasked: "139****1111"
    });

    const result = await loginFieldHandover(VALID_FIELD_PHONE, VALID_FIELD_CODE);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3001/api/field/handover/login",
      expect.objectContaining({
        body: JSON.stringify({ code: VALID_FIELD_CODE, phone: VALID_FIELD_PHONE }),
        credentials: "include",
        method: "POST"
      })
    );
    expect(result).toEqual({ operatorType: "EXTERNAL", phoneMasked: "139****1111" });
    expect(JSON.stringify(result)).not.toMatch(/token|cookie|access_token/i);
  });

  it("uses field session, list, detail, and logout endpoints with cookies included", async () => {
    const fetchMock = mockJsonResponse({ authenticated: true, phoneMasked: "139****1111", taskCount: 1 });

    await getFieldHandoverSession();
    await listFieldHandoverWorkOrders();
    await getFieldHandoverWorkOrder("task/with space");
    await logoutFieldHandover();

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://localhost:3001/api/field/handover/session",
      "http://localhost:3001/api/field/handover/work-orders",
      "http://localhost:3001/api/field/handover/work-orders/task%2Fwith%20space",
      "http://localhost:3001/api/field/handover/logout"
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("method");
    expect(fetchMock.mock.calls[3]?.[1]).toEqual(
      expect.objectContaining({ credentials: "include", method: "POST" })
    );
  });

  it("normalizes validation, rate-limit, login, and unauthorized errors", () => {
    expect(isValidFieldHandoverPhone(VALID_FIELD_PHONE)).toBe(true);
    expect(isValidFieldHandoverPhone("12345")).toBe(false);
    expect(getFieldHandoverSendCodeErrorMessage(new ApiError("Too Many Requests", 429))).toBe(
      "验证码发送过于频繁，请稍后再试"
    );
    expect(getFieldHandoverSendCodeErrorMessage(new ApiError("Internal Server Error", 500))).toBe(
      "验证码发送失败，请稍后重试"
    );
    expect(getFieldHandoverLoginErrorMessage(new ApiError("Verification code is invalid.", 401))).toBe(
      "验证码错误或已过期，请重新获取"
    );
    expect(isFieldHandoverUnauthorized(new ApiError("Unauthorized", 401))).toBe(true);
    expect(isFieldHandoverUnauthorized(new ApiError("Forbidden", 403))).toBe(false);
    expect(isFieldHandoverSessionExpired(new ApiError("Missing field operator session.", 401))).toBe(true);
    expect(isFieldHandoverSessionExpired(new ApiError("No access to this field handover work order.", 401))).toBe(false);
  });
});

function mockJsonResponse(body: unknown) {
  const fetchMock = vi.fn().mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
      status: 200
    }))
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
