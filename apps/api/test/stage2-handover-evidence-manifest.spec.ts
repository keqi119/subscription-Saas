import { describe, expect, it } from "vitest";

import {
  buildDeliveryHandoverEvidencePackage,
  STAGE2_EVIDENCE_ARTIFACT_NOT_READY
} from "../src/delivery-handover/delivery-handover-evidence-manifest";
import {
  buildBoundHandoverFactSnapshot,
  buildPhysicalHandoverFactSnapshot
} from "../src/handover-work-order/handover-explicit-facts";

describe("Stage 2 handover evidence manifest", () => {
  it("produces the same canonical manifest hash regardless of checklist query order", () => {
    const checklist = createChecklist();
    const reversed = { items: [...checklist.items].reverse() };

    const first = buildDeliveryHandoverEvidencePackage({
      ...createHandoverFactBinding(),
      evidenceChecklist: checklist,
      handoverId: "handover-1",
      orderId: "order-1",
      workOrderId: "work-order-1"
    });
    const second = buildDeliveryHandoverEvidencePackage({
      ...createHandoverFactBinding(),
      evidenceChecklist: reversed,
      handoverId: "handover-1",
      orderId: "order-1",
      workOrderId: "work-order-1"
    });

    expect(first.manifest).toEqual(second.manifest);
    expect(first.manifestHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.manifestHash).toBe(second.manifestHash);
    expect(first.manifest.files.map((file) => file.evidenceFileId)).toEqual([
      "evidence-photo-1",
      "evidence-video-1"
    ]);
    expect(first.stats).toEqual({
      fileCount: 2,
      photoCount: 1,
      videoCount: 1
    });
  });

  it("includes every source file exactly once with immutable source and derivative identifiers", () => {
    const result = buildDeliveryHandoverEvidencePackage({
      ...createHandoverFactBinding(),
      evidenceChecklist: createChecklist(),
      handoverId: "handover-1",
      orderId: "order-1",
      workOrderId: "work-order-1"
    });

    expect(result.manifest.files).toEqual([
      expect.objectContaining({
        derivativeFileIds: ["preview-photo-1"],
        evidenceFileId: "evidence-photo-1",
        evidenceType: "VEHICLE_FRONT",
        fileId: "source-photo-1",
        mediaType: "PHOTO",
        sourceSha256: `sha256:${"a".repeat(64)}`,
        sourceSizeBytes: 2048
      }),
      expect.objectContaining({
        derivativeFileIds: ["frame-video-1-a", "frame-video-1-b", "frame-video-1-c", "frame-video-1-d"],
        evidenceFileId: "evidence-video-1",
        evidenceType: "WALKAROUND_VIDEO",
        fileId: "source-video-1",
        mediaType: "VIDEO",
        sourceSha256: `sha256:${"b".repeat(64)}`,
        videoDurationMs: 12_500
      })
    ]);
    expect(new Set(result.manifest.files.map((file) => file.evidenceFileId)).size).toBe(2);
  });

  it("changes the customer-confirmed manifest when an explicit handover fact changes", () => {
    const firstBinding = createHandoverFactBinding();
    const physical = buildPhysicalHandoverFactSnapshot({
      ...firstBinding.handoverFacts,
      primaryKeyCount: 2
    });
    const changed = buildBoundHandoverFactSnapshot(physical.snapshot, null);
    const first = buildDeliveryHandoverEvidencePackage({
      ...firstBinding,
      evidenceChecklist: createChecklist(),
      handoverId: "handover-1",
      orderId: "order-1",
      workOrderId: "work-order-1"
    });
    const second = buildDeliveryHandoverEvidencePackage({
      evidenceChecklist: createChecklist(),
      handoverFactHash: changed.hash,
      handoverFacts: changed.snapshot,
      handoverId: "handover-1",
      orderId: "order-1",
      workOrderId: "work-order-1"
    });

    expect(second.manifest.handoverFacts.primaryKeyCount).toBe(2);
    expect(second.manifestHash).not.toBe(first.manifestHash);
  });

  it.each([
    {
      evidenceType: "VEHICLE_FRONT",
      mutate: (metadata: Record<string, unknown>) => delete metadata.sourceSha256,
      reason: "source SHA-256"
    },
    {
      evidenceType: "VEHICLE_FRONT",
      mutate: (metadata: Record<string, unknown>) => delete metadata.photoPreviewFileId,
      reason: "photo preview"
    },
    {
      evidenceType: "WALKAROUND_VIDEO",
      mutate: (metadata: Record<string, unknown>) => {
        metadata.videoFrameFileIds = ["frame-video-1-a"];
      },
      reason: "video keyframes"
    }
  ])("fails closed when $reason is missing", ({ evidenceType, mutate }) => {
    const checklist = createChecklist();
    const target = checklist.items.find((item) => item.evidenceType === evidenceType) ?? checklist.items[0];
    mutate(target!.files[0]!.metadata);

    expect(() => buildDeliveryHandoverEvidencePackage({
      ...createHandoverFactBinding(),
      evidenceChecklist: checklist,
      handoverId: "handover-1",
      orderId: "order-1",
      workOrderId: "work-order-1"
    })).toThrow(STAGE2_EVIDENCE_ARTIFACT_NOT_READY);
  });
});

function createHandoverFactBinding() {
  const physical = buildPhysicalHandoverFactSnapshot({
    accessoryItems: [{ code: "CHARGING_CABLE", name: "Charging cable", quantity: 1, state: "PRESENT" }],
    handoverFactRevision: 1,
    keyState: "COMPLETE",
    primaryKeyCount: 1,
    registrationDocumentState: "HANDED_OVER",
    spareKeyCount: 1,
    vehicleConditionConfirmed: true
  });
  const bound = buildBoundHandoverFactSnapshot(physical.snapshot, null);
  return { handoverFactHash: bound.hash, handoverFacts: bound.snapshot };
}

function createChecklist() {
  return {
    items: [
      {
        evidenceType: "WALKAROUND_VIDEO",
        files: [
          {
            file: {
              id: "source-video-1",
              mimeType: "video/mp4",
              originalName: "walkaround.mp4",
              sizeBytes: 8_192
            },
            fileId: "source-video-1",
            id: "evidence-video-1",
            mediaType: "VIDEO",
            metadata: {
              artifactVersion: 1,
              detectedMimeType: "video/mp4",
              processedAt: "2026-07-25T01:00:00.000Z",
              processingStatus: "READY",
              sourceSha256: `sha256:${"b".repeat(64)}`,
              sourceSizeBytes: 8_192,
              videoDurationMs: 12_500,
              videoFrameFileIds: [
                "frame-video-1-a",
                "frame-video-1-b",
                "frame-video-1-c",
                "frame-video-1-d"
              ]
            },
            uploadedAt: "2026-07-25T00:02:00.000Z"
          }
        ],
        id: "item-video",
        title: "车辆环绕视频"
      },
      {
        evidenceType: "VEHICLE_FRONT",
        files: [
          {
            file: {
              id: "source-photo-1",
              mimeType: "image/jpeg",
              originalName: "front.jpg",
              sizeBytes: 2_048
            },
            fileId: "source-photo-1",
            id: "evidence-photo-1",
            mediaType: "PHOTO",
            metadata: {
              artifactVersion: 1,
              detectedMimeType: "image/jpeg",
              photoPreviewFileId: "preview-photo-1",
              processedAt: "2026-07-25T01:00:00.000Z",
              processingStatus: "READY",
              sourceSha256: `sha256:${"a".repeat(64)}`,
              sourceSizeBytes: 2_048,
              videoDurationMs: null,
              videoFrameFileIds: []
            },
            uploadedAt: "2026-07-25T00:01:00.000Z"
          }
        ],
        id: "item-photo",
        title: "车辆车头正面"
      }
    ]
  };
}
