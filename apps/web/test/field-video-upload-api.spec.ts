import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFieldVideoUploadSession,
  getFieldVideoUploadSession,
  uploadFieldVideoPart
} from "../src/lib/field-video-upload-api";

describe("field video upload API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("whitelists public session fields and drops OSS-like response fields", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            bucket: "secret",
            chunkSizeBytes: 8,
            completedPartNumbers: [1],
            evidenceItemId: "item-1",
            evidenceTitle: "车辆环绕视频",
            expiresAt: "2026-08-16T00:00:00.000Z",
            fileName: "IMG_0284.MOV",
            objectKey: "secret-key",
            ossUploadId: "secret-upload",
            sessionId: "session-1",
            sizeBytes: 11,
            status: "UPLOADING",
            totalParts: 2,
            uploadedBytes: 8,
            workOrderId: "work-order-1"
          }),
          { status: 200 }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    const session = await createFieldVideoUploadSession("work-order-1", "item-1", {
      fileName: "IMG_0284.MOV",
      fingerprintSha256: "a".repeat(64),
      lastModifiedMs: 1,
      mimeType: "video/quicktime",
      sizeBytes: 11
    });

    expect(session).toEqual({
      chunkSizeBytes: 8,
      completedPartNumbers: [1],
      evidenceItemId: "item-1",
      evidenceTitle: "车辆环绕视频",
      expiresAt: "2026-08-16T00:00:00.000Z",
      fileName: "IMG_0284.MOV",
      sessionId: "session-1",
      sizeBytes: 11,
      status: "UPLOADING",
      totalParts: 2,
      uploadedBytes: 8,
      workOrderId: "work-order-1"
    });
    expect(JSON.stringify(session)).not.toMatch(/bucket|objectKey|ossUploadId/);
  });

  it("rejects malformed successful session responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ sessionId: "session-1" }), { status: 200 }))
    );

    await expect(getFieldVideoUploadSession("work-order-1", "item-1", "session-1")).rejects.toThrow(
      "VIDEO_UPLOAD_RESPONSE_INVALID"
    );
  });

  it("uploads one part with SHA header, credentials, progress, and cancellation", async () => {
    const requests = installMockXmlHttpRequest();
    const onProgress = vi.fn();
    const controller = new AbortController();
    const pending = uploadFieldVideoPart({
      blob: new Blob(["chunk"]),
      evidenceItemId: "item-1",
      onProgress,
      partNumber: 2,
      sessionId: "session-1",
      sha256: "a".repeat(64),
      signal: controller.signal,
      workOrderId: "work-order-1"
    });
    const request = requests.latest();

    request.emitProgress(3, 5);
    request.complete(201, {
      completedAt: "2026-08-15T00:00:00.000Z",
      etag: "must-not-leak",
      partNumber: 2,
      sizeBytes: 5
    });

    await expect(pending).resolves.toEqual({
      completedAt: "2026-08-15T00:00:00.000Z",
      partNumber: 2,
      sizeBytes: 5
    });
    expect(request.headers["X-Chunk-SHA256"]).toBe("a".repeat(64));
    expect(request.withCredentials).toBe(true);
    expect(onProgress).toHaveBeenCalledWith({ loadedBytes: 3, totalBytes: 5 });
  });
});

class MockXMLHttpRequest {
  static instances: MockXMLHttpRequest[] = [];
  headers: Record<string, string> = {};
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onload: (() => void) | null = null;
  onloadend: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  responseText = "";
  status = 0;
  timeout = 0;
  upload = { onprogress: null as ((event: { loaded: number; total: number }) => void) | null };
  withCredentials = false;

  constructor() {
    MockXMLHttpRequest.instances.push(this);
  }

  abort() {
    this.onabort?.();
    this.onloadend?.();
  }
  complete(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
    this.onloadend?.();
  }
  emitProgress(loaded: number, total: number) {
    this.upload.onprogress?.({ loaded, total });
  }
  open() {}
  send() {}
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
}

function installMockXmlHttpRequest() {
  MockXMLHttpRequest.instances = [];
  vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
  return {
    latest() {
      const request = MockXMLHttpRequest.instances.at(-1);
      if (!request) throw new Error("Expected XHR");
      return request;
    }
  };
}
