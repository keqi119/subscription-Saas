import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/lib/api";
import {
  declareFieldHandoverNoVisibleDamage,
  getFieldHandoverLoginErrorMessage,
  getFieldHandoverSendCodeErrorMessage,
  getFieldHandoverReadiness,
  getFieldHandoverSession,
  getFieldHandoverWorkOrder,
  isFieldHandoverSessionExpired,
  isFieldHandoverUnauthorized,
  isValidFieldHandoverPhone,
  listFieldHandoverWorkOrders,
  loginFieldHandover,
  logoutFieldHandover,
  removeFieldHandoverEvidenceFile,
  sendFieldHandoverCode,
  startFieldHandoverWorkOrder,
  submitFieldHandoverEvidence,
  updateFieldHandoverFacts,
  uploadAndAttachFieldHandoverEvidenceFile
} from "../src/lib/field-handover-api";

const VALID_FIELD_PHONE = ["139", "0000", "1111"].join("");
const VALID_FIELD_CODE = ["654", "321"].join("");
const DEBUG_CODE_SHOULD_NOT_RENDER = ["123", "456"].join("");

describe("field handover API client", () => {
  afterEach(() => {
    vi.useRealTimers();
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

  it("uses field-session guarded action, upload, attach, readiness, and submit endpoints", async () => {
    const fetchMock = mockJsonSequence([
      { id: "work-order-1", status: "FIELD_IN_PROGRESS" },
      { id: "work-order-1", handoverMileageKm: 28600 },
      { fileCount: 1, id: "evidence-item-1", status: "UPLOADED" },
      { id: "work-order-1", noVisibleDamageDeclared: true },
      { blockingReasons: [], ready: true },
      { id: "work-order-1", status: "CUSTOMER_REVIEWING" }
    ]);
    const file = new File(["image"], "front.jpg", { type: "image/jpeg" });

    await startFieldHandoverWorkOrder("work-order-1");
    await updateFieldHandoverFacts("work-order-1", {
      accessoryChecklist: { chargingCable: true, keys: 2 },
      damageDeclared: false,
      energyLevelText: "80%",
      handoverMileageKm: 28600,
      noVisibleDamageDeclared: true
    });
    await uploadAndAttachFieldHandoverEvidenceFile("work-order-1", "evidence-item-1", file);
    await declareFieldHandoverNoVisibleDamage("work-order-1");
    await getFieldHandoverReadiness("work-order-1");
    await submitFieldHandoverEvidence("work-order-1");

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://localhost:3001/api/field/handover/work-orders/work-order-1/start",
      "http://localhost:3001/api/field/handover/work-orders/work-order-1/facts",
      "http://localhost:3001/api/field/handover/work-orders/work-order-1/evidence/evidence-item-1/upload",
      "http://localhost:3001/api/field/handover/work-orders/work-order-1/no-visible-damage",
      "http://localhost:3001/api/field/handover/work-orders/work-order-1/readiness",
      "http://localhost:3001/api/field/handover/work-orders/work-order-1/submit"
    ]);
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({ body: expect.any(FormData), credentials: "include", method: "POST" })
    );
    expect(JSON.stringify(fetchMock.mock.calls[2])).not.toContain("oss/internal");
  });

  it("uses the atomic upload/replace and remove endpoints for editable evidence", async () => {
    const fetchMock = mockJsonSequence([
      { fileCount: 1, id: "evidence-item-1", status: "UPLOADED" },
      { fileCount: 0, id: "evidence-item-1", status: "NOT_STARTED" }
    ]);
    const file = new File(["replacement"], "replacement.jpg", { type: "image/jpeg" });

    await uploadAndAttachFieldHandoverEvidenceFile(
      "work-order-1",
      "evidence-item-1",
      file,
      "evidence-file-old"
    );
    await removeFieldHandoverEvidenceFile("work-order-1", "evidence-item-1", "evidence-file-new");

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://localhost:3001/api/field/handover/work-orders/work-order-1/evidence/evidence-item-1/upload",
      "http://localhost:3001/api/field/handover/work-orders/work-order-1/evidence/evidence-item-1/files/evidence-file-new"
    ]);
    const uploadBody = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect((uploadBody.get("files") as File).name).toBe(file.name);
    expect(uploadBody.get("replaceEvidenceFileId")).toBe("evidence-file-old");
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ method: "DELETE" }));
  });

  it("keeps large evidence uploads alive beyond the default timeout and aborts at twenty minutes", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
      });
    }));
    const file = new File(["video"], "walkaround.mp4", { type: "video/mp4" });

    const request = uploadAndAttachFieldHandoverEvidenceFile(
      "work-order-1",
      "evidence-item-1",
      file
    );
    const rejection = expect(request).rejects.toBeInstanceOf(ApiError);

    await vi.advanceTimersByTimeAsync(15_001);
    expect(requestSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(20 * 60 * 1000 - 15_001);
    expect(requestSignal?.aborted).toBe(true);
    await rejection;
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

function mockJsonSequence(bodies: unknown[]) {
  const fetchMock = vi.fn().mockImplementation(() => {
    const body = bodies.shift() ?? {};
    return Promise.resolve(new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
      status: 200
    }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
