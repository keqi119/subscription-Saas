import {
  DeliveryEvidenceMediaType,
  DeliveryEvidenceReviewStatus,
  DeliveryEvidenceStatus,
  DeliveryEvidenceType
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  DELIVERY_EVIDENCE_CHECKLIST_DEFINITIONS,
  DeliveryEvidenceService
} from "../src/delivery-evidence/delivery-evidence.service";

type TestEvidenceItem = Record<string, unknown> & {
  evidenceType: DeliveryEvidenceType;
  id: string;
};

type TestFileObject = Record<string, unknown> & {
  id: string;
  mimeType: string;
  originalName: string;
};

describe("DeliveryEvidenceService", () => {
  it("initializes singleton checklist items without duplicating four independent wheel evidence rows", async () => {
    const harness = createDeliveryEvidenceHarness();

    const checklist = await harness.service.initializeChecklist(harness.orderId, harness.handoverId);
    await harness.service.initializeChecklist(harness.orderId, harness.handoverId);

    expect(checklist.items).toHaveLength(DELIVERY_EVIDENCE_CHECKLIST_DEFINITIONS.length);
    expect(harness.state.items).toHaveLength(DELIVERY_EVIDENCE_CHECKLIST_DEFINITIONS.length);
    expect(wheelItems(harness.state.items).map((item) => item.evidenceType).sort()).toEqual([
      DeliveryEvidenceType.WHEEL_CLOSEUP_FRONT_LEFT,
      DeliveryEvidenceType.WHEEL_CLOSEUP_FRONT_RIGHT,
      DeliveryEvidenceType.WHEEL_CLOSEUP_REAR_LEFT,
      DeliveryEvidenceType.WHEEL_CLOSEUP_REAR_RIGHT
    ].sort());
  });

  it("allows multiple damage close-up evidence entries while singleton items stay unique", async () => {
    const harness = createDeliveryEvidenceHarness();
    await harness.service.initializeChecklist(harness.orderId, harness.handoverId);

    const firstFile = harness.addFile("damage-1.jpg", "image/jpeg");
    const first = await harness.service.addDamageCloseup({
      actorId: harness.userId,
      fileId: firstFile.id,
      handoverId: harness.handoverId,
      mediaType: DeliveryEvidenceMediaType.PHOTO,
      orderId: harness.orderId
    });
    await harness.service.approveEvidenceItem(first.id, harness.userId);

    const secondFile = harness.addFile("damage-2.jpg", "image/jpeg");
    await harness.service.addDamageCloseup({
      actorId: harness.userId,
      fileId: secondFile.id,
      handoverId: harness.handoverId,
      mediaType: DeliveryEvidenceMediaType.PHOTO,
      orderId: harness.orderId
    });

    const damageItems = harness.state.items.filter(
      (item) => item.evidenceType === DeliveryEvidenceType.DAMAGE_STATIC_CLOSEUP
    );
    expect(damageItems).toHaveLength(2);
  });

  it("blocks Stage 2 PDF and eSign readiness when required evidence is missing", async () => {
    const harness = createDeliveryEvidenceHarness();
    await harness.service.initializeChecklist(harness.orderId, harness.handoverId);

    const pdfReadiness = await harness.service.validateEvidenceReadyForStage2Pdf(
      harness.orderId,
      harness.handoverId
    );
    const esignReadiness = await harness.service.validateEvidenceReadyForStage2ESign(
      harness.orderId,
      harness.handoverId
    );

    expect(pdfReadiness.ready).toBe(false);
    expect(esignReadiness.ready).toBe(false);
    expect(pdfReadiness.blockingDetails).toContainEqual(expect.objectContaining({
      code: "HANDOVER_EVIDENCE_MISSING",
      evidenceType: DeliveryEvidenceType.CUSTOMER_WITH_VEHICLE_FRONT
    }));
  });

  it("allows field completeness while uploaded evidence is unreviewed but keeps ops review pending", async () => {
    const harness = createDeliveryEvidenceHarness();
    await uploadRequiredFileEvidence(harness);
    await harness.service.declareNoVisibleDamage(harness.orderId, harness.userId, harness.handoverId, "现场确认");

    const fieldReadiness = await harness.service.validateEvidenceReadyForStage2Pdf(
      harness.orderId,
      harness.handoverId
    );
    const opsReadiness = await harness.service.validateEvidenceReadyForOpsReview(
      harness.orderId,
      harness.handoverId
    );

    expect(fieldReadiness.ready).toBe(true);
    expect(opsReadiness.ready).toBe(false);
    expect(opsReadiness.blockingDetails).toContainEqual(expect.objectContaining({
      code: "HANDOVER_EVIDENCE_REVIEW_PENDING",
      evidenceType: DeliveryEvidenceType.CUSTOMER_WITH_VEHICLE_FRONT
    }));
  });

  it("blocks readiness when evidence is rejected and requires re-upload or re-review", async () => {
    const harness = createDeliveryEvidenceHarness();
    await harness.service.initializeChecklist(harness.orderId, harness.handoverId);
    const item = harness.findItem(DeliveryEvidenceType.CUSTOMER_WITH_VEHICLE_FRONT);
    const file = harness.addFile("customer-front.jpg", "image/jpeg");

    await harness.service.attachEvidenceFile(item.id, file.id, DeliveryEvidenceMediaType.PHOTO, harness.userId);
    await harness.service.rejectEvidenceItem(item.id, harness.userId, "画面不清晰");
    const readiness = await harness.service.validateEvidenceReadyForStage2Pdf(harness.orderId, harness.handoverId);

    expect(readiness.ready).toBe(false);
    expect(readiness.blockingDetails).toContainEqual(expect.objectContaining({
      code: "HANDOVER_EVIDENCE_REJECTED",
      evidenceType: DeliveryEvidenceType.CUSTOMER_WITH_VEHICLE_FRONT
    }));
  });

  it("keeps damage unresolved as a blocker even after all required file evidence is approved", async () => {
    const harness = createDeliveryEvidenceHarness();
    await approveRequiredFileEvidence(harness);

    const readiness = await harness.service.validateEvidenceReadyForDeliveryConfirmation(
      harness.orderId,
      harness.handoverId
    );

    expect(readiness.ready).toBe(false);
    expect(readiness.blockingDetails).toContainEqual(expect.objectContaining({
      code: "DAMAGE_EVIDENCE_MISSING"
    }));
  });

  it("blocks declared damage until at least one damage close-up is approved", async () => {
    const harness = createDeliveryEvidenceHarness();
    await approveRequiredFileEvidence(harness);

    await harness.service.declareDamage(harness.orderId, harness.userId, harness.handoverId);
    const missingCloseup = await harness.service.validateEvidenceReadyForDeliveryConfirmation(
      harness.orderId,
      harness.handoverId
    );

    expect(missingCloseup.ready).toBe(false);
    expect(missingCloseup.blockingDetails).toContainEqual(expect.objectContaining({
      code: "DAMAGE_EVIDENCE_MISSING"
    }));

    const file = harness.addFile("damage.jpg", "image/jpeg");
    const damageItem = harness.findItem(DeliveryEvidenceType.DAMAGE_STATIC_CLOSEUP);
    await harness.service.attachEvidenceFile(damageItem.id, file.id, DeliveryEvidenceMediaType.PHOTO, harness.userId);
    await harness.service.approveEvidenceItem(damageItem.id, harness.userId);
    const ready = await harness.service.validateEvidenceReadyForDeliveryConfirmation(
      harness.orderId,
      harness.handoverId
    );

    expect(ready.ready).toBe(true);
  });

  it("allows readiness when no visible damage is explicitly declared and audited", async () => {
    const harness = createDeliveryEvidenceHarness();
    await approveRequiredFileEvidence(harness);

    await harness.service.declareNoVisibleDamage(harness.orderId, harness.userId, harness.handoverId, "现场确认");
    const readiness = await harness.service.validateEvidenceReadyForDeliveryConfirmation(
      harness.orderId,
      harness.handoverId
    );

    expect(readiness.ready).toBe(true);
    expect(harness.findItem(DeliveryEvidenceType.NO_VISIBLE_DAMAGE_DECLARATION)).toMatchObject({
      declaredNoDamage: true,
      reviewStatus: DeliveryEvidenceReviewStatus.APPROVED,
      status: DeliveryEvidenceStatus.APPROVED
    });
  });

  it("retracts no-visible-damage declaration so damage evidence can resolve field readiness", async () => {
    const harness = createDeliveryEvidenceHarness();
    await uploadRequiredFileEvidence(harness);
    await harness.service.declareNoVisibleDamage(harness.orderId, harness.userId, harness.handoverId, "field confirmed");

    await harness.service.retractNoVisibleDamageDeclaration(harness.orderId, harness.userId, harness.handoverId);

    const declaration = harness.findItem(DeliveryEvidenceType.NO_VISIBLE_DAMAGE_DECLARATION);
    expect(declaration).toMatchObject({
      declaredNoDamage: null,
      reviewStatus: DeliveryEvidenceReviewStatus.NOT_STARTED,
      status: DeliveryEvidenceStatus.NOT_STARTED
    });

    const file = harness.addFile("damage.jpg", "image/jpeg");
    const damageItem = harness.findItem(DeliveryEvidenceType.DAMAGE_STATIC_CLOSEUP);
    await harness.service.attachEvidenceFile(damageItem.id, file.id, DeliveryEvidenceMediaType.PHOTO, harness.userId);
    const readiness = await harness.service.validateFieldEvidenceComplete(
      harness.orderId,
      harness.handoverId,
      { damageDeclared: true, noVisibleDamageDeclared: false }
    );

    expect(readiness.ready).toBe(true);
  });

  it("lets explicit field damage state override a stale no-visible-damage declaration during field completion", async () => {
    const harness = createDeliveryEvidenceHarness();
    await uploadRequiredFileEvidence(harness);
    await harness.service.declareNoVisibleDamage(harness.orderId, harness.userId, harness.handoverId, "field confirmed");

    const file = harness.addFile("damage.jpg", "image/jpeg");
    const damageItem = harness.findItem(DeliveryEvidenceType.DAMAGE_STATIC_CLOSEUP);
    await harness.service.attachEvidenceFile(damageItem.id, file.id, DeliveryEvidenceMediaType.PHOTO, harness.userId);
    const readiness = await harness.service.validateFieldEvidenceComplete(
      harness.orderId,
      harness.handoverId,
      { damageDeclared: true, noVisibleDamageDeclared: false }
    );

    expect(readiness.ready).toBe(true);
  });

  it("enforces media type requirements and links evidence files to FileObject safely", async () => {
    const harness = createDeliveryEvidenceHarness();
    await harness.service.initializeChecklist(harness.orderId, harness.handoverId);
    const photoOnly = harness.findItem(DeliveryEvidenceType.VEHICLE_FRONT);
    const wheel = harness.findItem(DeliveryEvidenceType.WHEEL_CLOSEUP_FRONT_LEFT);
    const videoFile = harness.addFile("wheel.mp4", "video/mp4");

    await expect(
      harness.service.attachEvidenceFile(photoOnly.id, videoFile.id, DeliveryEvidenceMediaType.VIDEO, harness.userId)
    ).rejects.toThrow("文件类型不符合该交付证据项要求");

    const linked = await harness.service.attachEvidenceFile(
      wheel.id,
      videoFile.id,
      DeliveryEvidenceMediaType.VIDEO,
      harness.userId
    );

    expect(linked.files).toEqual([
      expect.objectContaining({
        file: expect.objectContaining({
          id: videoFile.id,
          originalName: "wheel.mp4"
        }),
        fileId: videoFile.id,
        mediaType: DeliveryEvidenceMediaType.VIDEO
      })
    ]);
    expect(JSON.stringify(linked)).not.toContain("signUrl");
    expect(JSON.stringify(linked)).not.toContain("idCardNo");
  });
});

async function approveRequiredFileEvidence(harness: ReturnType<typeof createDeliveryEvidenceHarness>) {
  const items = await uploadRequiredFileEvidence(harness);
  for (const item of items) {
    await harness.service.approveEvidenceItem(item.id, harness.userId);
  }
}

async function uploadRequiredFileEvidence(harness: ReturnType<typeof createDeliveryEvidenceHarness>) {
  await harness.service.initializeChecklist(harness.orderId, harness.handoverId);
  const uploaded: TestEvidenceItem[] = [];
  for (const definition of DELIVERY_EVIDENCE_CHECKLIST_DEFINITIONS.filter((item) => item.isRequired)) {
    const item = harness.findItem(definition.evidenceType);
    const mediaType = definition.allowedMediaTypes[0];
    if (!mediaType) {
      throw new Error(`Missing media type for ${definition.evidenceType}`);
    }
    const extension = mediaType === DeliveryEvidenceMediaType.VIDEO ? "mp4" : "jpg";
    const mimeType = mediaType === DeliveryEvidenceMediaType.VIDEO ? "video/mp4" : "image/jpeg";
    const file = harness.addFile(`${definition.evidenceType}.${extension}`, mimeType);
    await harness.service.attachEvidenceFile(item.id, file.id, mediaType, harness.userId);
    uploaded.push(item);
  }
  return uploaded;
}

function createDeliveryEvidenceHarness() {
  const now = new Date("2026-07-21T06:00:00.000Z");
  const orderId = "order-1";
  const handoverId = "handover-1";
  const userId = "user-1";
  const state = {
    evidenceFiles: [] as Array<Record<string, unknown>>,
    files: [] as TestFileObject[],
    handover: {
      deletedAt: null,
      id: handoverId,
      orderId,
      vehicleDeliveryId: "delivery-1"
    },
    items: [] as TestEvidenceItem[],
    order: {
      deletedAt: null,
      id: orderId
    },
    vehicleDelivery: {
      deletedAt: null,
      id: "delivery-1",
      orderId
    }
  };

  const prisma = {
    fileObject: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        state.files.find((file) => file.id === where.id) ?? null
      )
    },
    subscriptionOrder: {
      findFirst: vi.fn(async () => state.order)
    },
    vehicleDelivery: {
      findUnique: vi.fn(async () => state.vehicleDelivery)
    },
    vehicleDeliveryEvidenceFile: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const evidenceFile = {
          createdAt: now,
          id: `evidence-file-${state.evidenceFiles.length + 1}`,
          metadata: null,
          uploadedAt: now,
          updatedAt: now,
          ...data
        };
        state.evidenceFiles.push(evidenceFile);
        return withFileRelations(evidenceFile, state);
      })
    },
    vehicleDeliveryEvidenceItem: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const item = {
          allowsMultiple: false,
          conditionKey: null,
          conditionValue: null,
          createdAt: now,
          declaredNoDamage: null,
          description: null,
          files: [],
          handoverId: readConnectId(data.handover) ?? data.handoverId ?? null,
          evidenceType: data.evidenceType as DeliveryEvidenceType,
          id: `evidence-item-${state.items.length + 1}`,
          isConditional: false,
          isRequired: false,
          metadata: null,
          orderId: readConnectId(data.order) ?? data.orderId,
          rejectionReason: null,
          reviewedAt: null,
          reviewedBy: null,
          reviewer: null,
          reviewStatus: DeliveryEvidenceReviewStatus.NOT_STARTED,
          status: DeliveryEvidenceStatus.NOT_STARTED,
          updatedAt: now,
          vehicleDeliveryId: readConnectId(data.vehicleDelivery) ?? data.vehicleDeliveryId ?? null,
          ...data
        } as TestEvidenceItem;
        delete item.handover;
        delete item.order;
        delete item.vehicleDelivery;
        state.items.push(item);
        return withItemRelations(item, state);
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        withItemRelations(state.items.find((item) => matchesWhere(item, where)) ?? null, state)
      ),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.items.filter((item) => matchesWhere(item, where)).map((item) => withItemRelations(item, state))
      ),
      update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
        const item = state.items.find((row) => row.id === where.id);
        if (!item) {
          throw new Error("Evidence item not found");
        }
        Object.assign(item, data, { updatedAt: now });
        return withItemRelations(item, state);
      })
    },
    vehicleDeliveryHandover: {
      findFirst: vi.fn(async () => state.handover)
    }
  };
  const service = new DeliveryEvidenceService(prisma as never);

  return {
    addFile(originalName: string, mimeType: string) {
      const file = {
        bucket: "application-materials",
        createdAt: now,
        id: `file-${state.files.length + 1}`,
        mimeType,
        objectKey: `delivery-evidence/${originalName}`,
        originalName,
        sizeBytes: 1024n,
        uploadedBy: userId
      } as TestFileObject;
      state.files.push(file);
      return file;
    },
    findItem(evidenceType: DeliveryEvidenceType) {
      const item = state.items.find((row) => row.evidenceType === evidenceType);
      if (!item) {
        throw new Error(`Missing item: ${evidenceType}`);
      }
      return item;
    },
    handoverId,
    orderId,
    prisma,
    service,
    state,
    userId
  };
}

function wheelItems(items: Array<Record<string, unknown>>) {
  const wheelTypes: DeliveryEvidenceType[] = [
    DeliveryEvidenceType.WHEEL_CLOSEUP_FRONT_LEFT,
    DeliveryEvidenceType.WHEEL_CLOSEUP_FRONT_RIGHT,
    DeliveryEvidenceType.WHEEL_CLOSEUP_REAR_LEFT,
    DeliveryEvidenceType.WHEEL_CLOSEUP_REAR_RIGHT
  ];
  return items.filter((item) =>
    wheelTypes.includes(item.evidenceType as DeliveryEvidenceType)
  );
}

function withItemRelations(item: Record<string, unknown> | null | undefined, state: {
  evidenceFiles: Array<Record<string, unknown>>;
  files: Array<Record<string, unknown>>;
}) {
  if (!item) {
    return null;
  }
  return {
    ...item,
    files: state.evidenceFiles
      .filter((file) => file.evidenceItemId === item.id)
      .map((file) => withFileRelations(file, state)),
    reviewer: item.reviewedBy ? { id: item.reviewedBy, name: "Admin", username: "admin" } : null
  };
}

function withFileRelations(file: Record<string, unknown>, state: {
  files: Array<Record<string, unknown>>;
}) {
  return {
    ...file,
    file: state.files.find((row) => row.id === file.fileId) ?? null,
    uploader: file.uploadedBy ? { id: file.uploadedBy, name: "Admin", username: "admin" } : null
  };
}

function matchesWhere(item: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "id") {
      return item.id === expected;
    }
    if (key === "orderId") {
      return item.orderId === expected;
    }
    if (key === "OR" && Array.isArray(expected)) {
      return expected.some((branch): boolean => matchesWhere(item, branch as Record<string, unknown>));
    }
    if (key === "handoverId") {
      return item.handoverId === expected;
    }
    return true;
  });
}

function readConnectId(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const connect = (value as { connect?: { id?: string } }).connect;
  return connect?.id;
}
