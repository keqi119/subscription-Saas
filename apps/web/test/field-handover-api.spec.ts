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

  it("uses field-session guarded action, update, attach, readiness, and submit endpoints", async () => {
    const fetchMock = mockJsonSequence([
      { id: "work-order-1", status: "FIELD_IN_PROGRESS" },
      { id: "work-order-1", handoverMileageKm: 28600 },
      { id: "work-order-1", noVisibleDamageDeclared: true },
      { blockingReasons: [], ready: true },
      { id: "work-order-1", status: "CUSTOMER_REVIEWING" }
    ]);

    await startFieldHandoverWorkOrder("work-order-1");
    await updateFieldHandoverFacts("work-order-1", {
      accessoryChecklist: { chargingCable: true, keys: 2 },
      damageDeclared: false,
      energyLevelText: "80%",
      handoverMileageKm: 28600,
      noVisibleDamageDeclared: true
    });
    await declareFieldHandoverNoVisibleDamage("work-order-1");
    await getFieldHandoverReadiness("work-order-1");
    await submitFieldHandoverEvidence("work-order-1");

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://localhost:3001/api/field/handover/work-orders/work-order-1/start",
      "http://localhost:3001/api/field/handover/work-orders/work-order-1/facts",
      "http://localhost:3001/api/field/handover/work-orders/work-order-1/no-visible-damage",
      "http://localhost:3001/api/field/handover/work-orders/work-order-1/readiness",
      "http://localhost:3001/api/field/handover/work-orders/work-order-1/submit"
    ]);
  });

  it("uploads evidence with cookies and reports progress", async () => {
    const xhrMock = installMockXmlHttpRequest();
    const onProgress = vi.fn();
    const file = new File(["replacement"], "replacement.jpg", { type: "image/jpeg" });

    const request = uploadAndAttachFieldHandoverEvidenceFile(
      "work-order-1",
      "evidence-item-1",
      file,
      { onProgress, replaceEvidenceFileId: "evidence-file-old" }
    );
    const xhr = xhrMock.latest();
    xhr.emitProgress(5, 10);
    xhr.complete(200, { fileCount: 1, id: "evidence-item-1", status: "UPLOADED" });

    await expect(request).resolves.toMatchObject({ status: "UPLOADED" });
    expect(xhr).toMatchObject({
      method: "POST",
      timeout: 20 * 60 * 1000,
      url: "http://localhost:3001/api/field/handover/work-orders/work-order-1/evidence/evidence-item-1/upload",
      withCredentials: true
    });
    const uploadBody = xhr.body as FormData;
    expect((uploadBody.get("files") as File).name).toBe(file.name);
    expect(uploadBody.get("replaceEvidenceFileId")).toBe("evidence-file-old");
    expect(onProgress).toHaveBeenCalledWith({ loadedBytes: 5, percent: 50, totalBytes: 10 });
    expect(JSON.stringify(xhr)).not.toContain("oss/internal");
  });

  it("aborts an evidence upload from the caller signal", async () => {
    installMockXmlHttpRequest();
    const controller = new AbortController();
    const file = new File(["video"], "walkaround.mp4", { type: "video/mp4" });

    const request = uploadAndAttachFieldHandoverEvidenceFile(
      "work-order-1",
      "evidence-item-1",
      file,
      { signal: controller.signal }
    );
    controller.abort();

    await expect(request).rejects.toMatchObject({ message: "上传已取消。", status: 0 });
  });

  it("uses safe API, network, and timeout errors for evidence uploads", async () => {
    const xhrMock = installMockXmlHttpRequest();
    const file = new File(["image"], "front.jpg", { type: "image/jpeg" });

    const apiFailure = uploadAndAttachFieldHandoverEvidenceFile("work-order-1", "evidence-item-1", file);
    xhrMock.latest().complete(422, { internal: "oss/internal", message: "Unsupported evidence file" });
    await expect(apiFailure).rejects.toMatchObject({ message: "Unsupported evidence file", status: 422 });

    const networkFailure = uploadAndAttachFieldHandoverEvidenceFile("work-order-1", "evidence-item-1", file);
    xhrMock.latest().emitNetworkError();
    await expect(networkFailure).rejects.toMatchObject({ message: "上传失败，请检查网络后重试。", status: 0 });

    const timeoutFailure = uploadAndAttachFieldHandoverEvidenceFile("work-order-1", "evidence-item-1", file);
    xhrMock.latest().emitTimeout();
    await expect(timeoutFailure).rejects.toMatchObject({ message: "上传超时，请检查网络后重试。", status: 0 });
  });

  it("rejects malformed successful upload responses with a safe error", async () => {
    const xhrMock = installMockXmlHttpRequest();
    const request = uploadAndAttachFieldHandoverEvidenceFile(
      "work-order-1",
      "evidence-item-1",
      new File(["image"], "front.jpg", { type: "image/jpeg" })
    );
    xhrMock.latest().complete(200, { internal: "oss/internal" });

    await expect(request).rejects.toMatchObject({ message: "上传失败，请稍后重试。", status: 200 });
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

class MockXMLHttpRequest {
  static instances: MockXMLHttpRequest[] = [];

  body: Document | XMLHttpRequestBodyInit | null = null;
  method = "";
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onload: (() => void) | null = null;
  onloadend: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  responseText = "";
  status = 0;
  statusText = "";
  timeout = 0;
  upload = {
    onprogress: null as ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null
  };
  url = "";
  withCredentials = false;

  constructor() {
    MockXMLHttpRequest.instances.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  send(body: Document | XMLHttpRequestBodyInit | null) {
    this.body = body;
  }

  abort() {
    this.onabort?.();
    this.onloadend?.();
  }

  complete(status: number, body: unknown, statusText = "") {
    this.status = status;
    this.statusText = statusText;
    this.responseText = typeof body === "string" ? body : JSON.stringify(body);
    this.onload?.();
    this.onloadend?.();
  }

  emitNetworkError() {
    this.onerror?.();
    this.onloadend?.();
  }

  emitProgress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }

  emitTimeout() {
    this.ontimeout?.();
    this.onloadend?.();
  }
}

function installMockXmlHttpRequest() {
  MockXMLHttpRequest.instances = [];
  vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

  return {
    latest() {
      const request = MockXMLHttpRequest.instances.at(-1);
      if (!request) {
        throw new Error("Expected an XMLHttpRequest instance.");
      }
      return request;
    }
  };
}
