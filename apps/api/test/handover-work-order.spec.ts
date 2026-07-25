import { BadRequestException, ConflictException, UnauthorizedException } from "@nestjs/common";
import { ContractStatus } from "@prisma/client";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { buildDeliveryHandoverEvidencePackage } from "../src/delivery-handover/delivery-handover-evidence-manifest";
import { HandoverWorkOrderService } from "../src/handover-work-order/handover-work-order.service";

describe("HandoverWorkOrderService", () => {
  it("creates one active delivery-outbound work order, links Stage 2 handover, and initializes evidence checklist", async () => {
    const harness = createHandoverWorkOrderHarness();

    const workOrder = await harness.service.createDraft(harness.orderId, "DELIVERY_OUTBOUND", harness.admin.id);

    expect(workOrder).toMatchObject({
      handoverId: "handover-1",
      handoverType: "DELIVERY_OUTBOUND",
      orderId: harness.orderId,
      status: "DRAFT",
      vehicleDeliveryId: "delivery-1"
    });
    expect(harness.evidenceService.initializeChecklist).toHaveBeenCalledWith(
      harness.orderId,
      "handover-1",
      expect.any(Object)
    );

    await expect(
      harness.service.createDraft(harness.orderId, "DELIVERY_OUTBOUND", harness.admin.id)
    ).rejects.toThrow("进行中的交付工单");

    await harness.service.voidOrCancel(workOrder.id, "CANCELLED", harness.admin.id, "重新派单");
    const replacement = await harness.service.createDraft(harness.orderId, "DELIVERY_OUTBOUND", harness.admin.id);
    expect(replacement.id).toBe("work-order-2");
  });

  it("maps serializable create conflicts to a retryable domain conflict", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.prisma.$transaction.mockRejectedValueOnce({ code: "P2034" });

    await expect(
      harness.service.createDraft(harness.orderId, "DELIVERY_OUTBOUND", harness.admin.id)
    ).rejects.toBeInstanceOf(ConflictException);
    expect(harness.handoverService.getOrCreateDraftHandover).not.toHaveBeenCalled();
    expect(harness.evidenceService.initializeChecklist).not.toHaveBeenCalled();
  });

  it("assigns internal and external operators without storing plaintext external tokens", async () => {
    const harness = createHandoverWorkOrderHarness();
    const draft = await harness.service.createDraft(harness.orderId, "DELIVERY_OUTBOUND", harness.admin.id);

    const internal = await harness.service.assignInternalOperator(draft.id, harness.internalUser.id, harness.admin.id);
    expect(internal).toMatchObject({
      assignedInternalUserId: harness.internalUser.id,
      operatorType: "INTERNAL",
      status: "ASSIGNED"
    });

    const external = await harness.service.assignExternalOperator(
      draft.id,
      {
        expiresAt: new Date("2026-07-28T08:00:00.000Z"),
        name: "临时交付员",
        organization: "外包交付合作方",
        phone: "13900001111"
      },
      harness.admin.id
    );

    expect(external.accessToken).toMatch(/^[A-Za-z0-9_-]{30,}$/);
    expect(harness.state.workOrders[0]!.accessTokenHash).toBeTruthy();
    expect(harness.state.workOrders[0]!.accessTokenHash).not.toBe(external.accessToken);
    expect(JSON.stringify(harness.state.workOrders[0]!)).not.toContain(external.accessToken);
  });

  it("verifies external access, updates access timestamps, and returns only a limited masked task view", async () => {
    const harness = createHandoverWorkOrderHarness();
    const draft = await harness.service.createDraft(harness.orderId, "DELIVERY_OUTBOUND", harness.admin.id);
    const assigned = await harness.service.assignExternalOperator(
      draft.id,
      {
        expiresAt: new Date("2026-07-28T08:00:00.000Z"),
        name: "临时交付员",
        phone: "13900001111"
      },
      harness.admin.id
    );

    const view = await harness.service.verifyExternalAccess(assigned.accessToken);

    expect(view).toMatchObject({
      id: draft.id,
      orderNo: "ORD202607210001",
      status: "ASSIGNED"
    });
    expect(view.customer.mobileMasked).toBe("186****0212");
    expect(view.vehicle.vinSuffix).toBe("888888");
    expect(harness.state.workOrders[0]!.firstAccessedAt).toBeInstanceOf(Date);
    expect(harness.state.workOrders[0]!.lastAccessedAt).toBeInstanceOf(Date);

    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("TEST_ID_CARD_SHOULD_NOT_LEAK");
    expect(serialized).not.toContain("18616570212");
    expect(serialized).not.toContain("monthlyFeeAmount");
    expect(serialized).not.toContain("contractId");
    expect(serialized).not.toContain("signUrl");
  });

  it("rejects revoked and expired external tokens", async () => {
    const harness = createHandoverWorkOrderHarness();
    const draft = await harness.service.createDraft(harness.orderId, "DELIVERY_OUTBOUND", harness.admin.id);
    const assigned = await harness.service.assignExternalOperator(
      draft.id,
      {
        expiresAt: new Date("2026-07-28T08:00:00.000Z"),
        name: "临时交付员",
        phone: "13900001111"
      },
      harness.admin.id
    );

    await harness.service.revokeExternalAccess(draft.id, harness.admin.id);
    await expect(harness.service.verifyExternalAccess(assigned.accessToken)).rejects.toThrow(UnauthorizedException);

    const expiredHarness = createHandoverWorkOrderHarness();
    const expiredDraft = await expiredHarness.service.createDraft(
      expiredHarness.orderId,
      "DELIVERY_OUTBOUND",
      expiredHarness.admin.id
    );
    const expired = await expiredHarness.service.assignExternalOperator(
      expiredDraft.id,
      {
        expiresAt: new Date("2026-07-20T08:00:00.000Z"),
        name: "临时交付员",
        phone: "13900001111"
      },
      expiredHarness.admin.id
    );
    await expect(expiredHarness.service.verifyExternalAccess(expired.accessToken)).rejects.toThrow(UnauthorizedException);
  });

  it("rejects an external token when it is revoked or reassigned during access refresh", async () => {
    const harness = createHandoverWorkOrderHarness();
    const draft = await harness.service.createDraft(harness.orderId, "DELIVERY_OUTBOUND", harness.admin.id);
    const assigned = await harness.service.assignExternalOperator(
      draft.id,
      { name: "External field operator", phone: "13900001111" },
      harness.admin.id
    );
    harness.prisma.vehicleHandoverWorkOrder.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(harness.service.verifyExternalAccess(assigned.accessToken)).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });

  it("rejects an external token revoked after the conditional access refresh", async () => {
    const harness = createHandoverWorkOrderHarness();
    const draft = await harness.service.createDraft(harness.orderId, "DELIVERY_OUTBOUND", harness.admin.id);
    const assigned = await harness.service.assignExternalOperator(
      draft.id,
      { name: "External field operator", phone: "13900001111" },
      harness.admin.id
    );
    harness.prisma.vehicleHandoverWorkOrder.findUnique.mockImplementationOnce(async () => {
      Object.assign(harness.state.workOrders[0]!, {
        accessTokenRevokedAt: harness.now,
        reviewVersion: 2
      });
      return harness.state.workOrders[0]!;
    });

    await expect(harness.service.verifyExternalAccess(assigned.accessToken)).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });

  it("lists only active external work orders assigned to the field operator phone with safe summaries", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push(
      {
        ...baseWorkOrder(harness),
        accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
        deliveryLocation: "上海市测试交付点",
        externalOperatorName: "现场交付员",
        externalOperatorPhone: "13800000000",
        id: "work-order-visible-late",
        operatorType: "EXTERNAL",
        scheduledAt: new Date("2026-07-23T02:00:00.000Z"),
        status: "ASSIGNED"
      },
      {
        ...baseWorkOrder(harness),
        accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
        deliveryLocation: "上海市测试交付点",
        externalOperatorName: "现场交付员",
        externalOperatorPhone: "13800000000",
        id: "work-order-visible-early",
        operatorType: "EXTERNAL",
        scheduledAt: new Date("2026-07-22T02:00:00.000Z"),
        status: "FIELD_IN_PROGRESS"
      },
      {
        ...baseWorkOrder(harness),
        accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
        externalOperatorPhone: "13900000000",
        id: "work-order-other-phone",
        operatorType: "EXTERNAL",
        status: "ASSIGNED"
      },
      {
        ...baseWorkOrder(harness),
        accessTokenExpiresAt: new Date("2026-07-20T08:00:00.000Z"),
        externalOperatorPhone: "13800000000",
        id: "work-order-expired",
        operatorType: "EXTERNAL",
        status: "ASSIGNED"
      },
      {
        ...baseWorkOrder(harness),
        accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
        accessTokenRevokedAt: harness.now,
        externalOperatorPhone: "13800000000",
        id: "work-order-revoked",
        operatorType: "EXTERNAL",
        status: "ASSIGNED"
      },
      {
        ...baseWorkOrder(harness),
        accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
        externalOperatorPhone: "13800000000",
        id: "work-order-completed",
        operatorType: "EXTERNAL",
        status: "FIELD_COMPLETED"
      }
    );

    const list = await harness.service.listFieldAccessibleWorkOrders("+86 138-0000-0000");

    expect(list.map((item) => item.id)).toEqual(["work-order-visible-early", "work-order-visible-late"]);
    expect(list[0]).toMatchObject({
      customer: {
        mobileMasked: "186****0212"
      },
      evidenceProgress: {
        uploaded: 1
      },
      orderNo: "ORD202607210001",
      vehicle: {
        vinSuffix: "888888"
      }
    });

    const serialized = JSON.stringify(list);
    expect(serialized).not.toContain("TEST_ID_CARD_SHOULD_NOT_LEAK");
    expect(serialized).not.toContain("18616570212");
    expect(serialized).not.toContain("monthlyFeeAmount");
    expect(serialized).not.toContain("contractId");
    expect(serialized).not.toContain("signUrl");
    expect(serialized).not.toContain("oss/internal/evidence.jpg");
  });

  it("returns an empty field work-order list when no active task is assigned to the phone", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push(
      {
        ...baseWorkOrder(harness),
        accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
        externalOperatorPhone: "13900000000",
        id: "work-order-other-phone",
        operatorType: "EXTERNAL",
        status: "ASSIGNED"
      },
      {
        ...baseWorkOrder(harness),
        accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
        externalOperatorPhone: "13800000000",
        id: "work-order-cancelled",
        operatorType: "EXTERNAL",
        status: "CANCELLED"
      },
      {
        ...baseWorkOrder(harness),
        accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
        externalOperatorPhone: "13800000000",
        id: "work-order-ops-reviewed",
        operatorType: "EXTERNAL",
        status: "OPS_REVIEWED"
      }
    );

    await expect(harness.service.listFieldAccessibleWorkOrders("13800000000")).resolves.toEqual([]);
  });

  it("returns safe field task detail only for the assigned phone", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.evidenceService.setChecklist({
      blockingReasons: [],
      items: [
        {
          allowedMediaTypes: ["PHOTO"],
          evidenceType: "VEHICLE_FRONT",
          fileRequired: true,
          files: [
            {
              file: {
                id: "file-1",
                mimeType: "image/jpeg",
                objectKey: "oss/internal/evidence.jpg",
                originalName: "front.jpg",
                sizeBytes: 1024
              },
              fileId: "file-1",
              id: "evidence-file-1",
              mediaType: "PHOTO",
              objectKey: "oss/internal/evidence.jpg",
              uploadedAt: harness.now,
              uploadedBy: { id: "user-admin" }
            }
          ],
          id: "evidence-item-1",
          isConditional: false,
          isRequired: true,
          orderId: harness.orderId,
          requirementLevel: "REQUIRED",
          reviewStatus: "PENDING",
          status: "UPLOADED",
          title: "车辆车头正面"
        }
      ],
      ready: false
    });
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      accessoryChecklist: { chargingCable: true, keys: 2 },
      deliveryLocation: "上海市测试交付点",
      energyLevelText: "80%",
      externalOperatorPhone: "13800000000",
      fieldNotes: "客户现场确认车辆外观",
      fuelLevelText: null,
      handoverMileageKm: 28500,
      id: "work-order-visible",
      noVisibleDamageDeclared: true,
      operatorType: "EXTERNAL",
      status: "FIELD_IN_PROGRESS"
    });

    const detail = await harness.service.getFieldAccessibleWorkOrder("work-order-visible", "13800000000");

    expect(detail).toMatchObject({
      fieldFacts: {
        energyLevelText: "80%",
        handoverMileageKm: 28500,
        noVisibleDamageDeclared: true
      },
      id: "work-order-visible",
      orderNo: "ORD202607210001"
    });
    expect(detail.evidenceChecklist.items[0]).toMatchObject({
      fileCount: 1,
      files: [
        {
          file: {
            id: "file-1",
            mimeType: "image/jpeg",
            originalName: "front.jpg",
            sizeBytes: 1024
          },
          mediaType: "PHOTO"
        }
      ]
    });
    expect(JSON.stringify(detail)).not.toContain("oss/internal/evidence.jpg");

    await expect(
      harness.service.getFieldAccessibleWorkOrder("work-order-visible", "13900000000")
    ).rejects.toThrow(UnauthorizedException);
  });

  it("allows a field session to start and update only its assigned work order", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      externalOperatorPhone: "13800000000",
      id: "work-order-visible",
      operatorType: "EXTERNAL",
      status: "ASSIGNED"
    });

    const started = await harness.service.startFieldAccessibleWorkOrder(
      "work-order-visible",
      "13800000000",
      "field-session-1"
    );
    const updated = await harness.service.updateFieldAccessibleFacts(
      "work-order-visible",
      "13800000000",
      {
        accessoryChecklist: { chargingCable: true, keys: 2 },
        damageDeclared: false,
        energyLevelText: "80%",
        handoverMileageKm: 28600,
        noVisibleDamageDeclared: true
      },
      "field-session-1"
    );

    expect(started).toMatchObject({ status: "FIELD_IN_PROGRESS" });
    expect(updated).toMatchObject({
      accessoryChecklist: { chargingCable: true, keys: 2 },
      energyLevelText: "80%",
      handoverMileageKm: 28600,
      noVisibleDamageDeclared: true
    });
    await harness.service.updateFieldAccessibleFacts(
      "work-order-visible",
      "13800000000",
      { handoverMileageKm: 28700 },
      "field-session-1"
    );
    expect(harness.state.workOrders[0]!).toMatchObject({
      energyLevelText: "80%",
      handoverMileageKm: 28700
    });
    await expect(
      harness.service.updateFieldAccessibleFacts("work-order-visible", "13900000000", { handoverMileageKm: 1 })
    ).rejects.toThrow(UnauthorizedException);
  });

  it("atomically uploads and attaches evidence through field-session ownership without exposing storage fields", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      externalOperatorPhone: "13800000000",
      id: "work-order-visible",
      operatorType: "EXTERNAL",
      status: "FIELD_IN_PROGRESS"
    });
    harness.state.evidenceItems.push({
      handoverId: "handover-1",
      id: "evidence-item-owned",
      orderId: harness.orderId
    });

    const attached = await harness.service.uploadAndAttachFieldAccessibleEvidenceFile(
      "work-order-visible",
      "13800000000",
      "evidence-item-owned",
      [uploadFile("front.jpg", "image/jpeg")],
      {},
      "field-session-1"
    );

    expect(JSON.stringify(attached)).not.toContain("delivery-evidence/work-order-visible");
    expect(harness.storageService.putDeliveryEvidenceFile).toHaveBeenCalledWith(
      expect.objectContaining({
        originalName: "front.jpg",
        workOrderId: "work-order-visible"
      })
    );
    expect(harness.artifactService.prepareUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        evidenceType: "VEHICLE_FRONT",
        mediaType: "PHOTO"
      })
    );
    expect(harness.storageService.putDeliveryEvidenceDerivativeFromPath).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "PHOTO_PREVIEW",
        workOrderId: "work-order-visible"
      })
    );
    expect(harness.evidenceService.attachEvidenceFile).toHaveBeenCalledWith(
      "evidence-item-owned",
      "file-1",
      "PHOTO",
      undefined,
      expect.any(Object),
      "field-session-1",
      expect.objectContaining({
        photoPreviewFileId: "file-2",
        processingStatus: "READY",
        sourceSha256: expect.stringMatching(/^sha256:/)
      })
    );
    expect(attached).toMatchObject({ id: "evidence-item-owned", status: "UPLOADED" });
    await expect(
      harness.service.uploadAndAttachFieldAccessibleEvidenceFile(
        "work-order-visible",
        "13900000000",
        "evidence-item-owned",
        [uploadFile("unauthorized.jpg", "image/jpeg")],
        {},
        "other-field-session"
      )
    ).rejects.toThrow(UnauthorizedException);
  });

  it("uploads and replaces singleton evidence through one field operation", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      externalOperatorPhone: "13800000000",
      id: "work-order-visible",
      operatorType: "EXTERNAL",
      status: "FIELD_IN_PROGRESS"
    });
    harness.state.evidenceItems.push({
      handoverId: "handover-1",
      id: "evidence-item-owned",
      orderId: harness.orderId
    });

    const result = await harness.service.uploadAndAttachFieldAccessibleEvidenceFile(
      "work-order-visible",
      "13800000000",
      "evidence-item-owned",
      [uploadFile("front-replacement.jpg", "image/jpeg")],
      { replaceEvidenceFileId: "evidence-file-original" },
      "field-session-1"
    );

    expect(harness.evidenceService.replaceEvidenceFile).toHaveBeenCalledWith(
      "evidence-item-owned",
      "evidence-file-original",
      "file-1",
      "PHOTO",
      undefined,
      expect.any(Object),
      "field-session-1",
      expect.objectContaining({ processingStatus: "READY" })
    );
    expect(result).toMatchObject({ id: "evidence-item-owned", status: "UPLOADED" });
    expect(harness.state.events).toContainEqual(expect.objectContaining({
      eventType: "EVIDENCE_FILE_REPLACED"
    }));
  });

  it("uses the disk-backed storage path for field evidence uploads", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      externalOperatorPhone: "13800000000",
      id: "work-order-visible",
      operatorType: "EXTERNAL",
      status: "FIELD_IN_PROGRESS"
    });
    harness.state.evidenceItems.push({
      handoverId: "handover-1",
      id: "evidence-item-owned",
      orderId: harness.orderId
    });

    await harness.service.uploadAndAttachFieldAccessibleEvidenceFile(
      "work-order-visible",
      "13800000000",
      "evidence-item-owned",
      [{
        mimetype: "video/mp4",
        originalname: "walkaround.mp4",
        path: "C:/tmp/nonexistent-multer-upload.tmp",
        size: 1024
      }],
      {},
      "field-session-1"
    );

    expect(harness.storageService.putDeliveryEvidenceFileFromPath).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: "C:/tmp/nonexistent-multer-upload.tmp",
        sizeBytes: 1024
      })
    );
    expect(harness.storageService.putDeliveryEvidenceFile).not.toHaveBeenCalled();
  });

  it("enforces 10 MiB photo and 300 MiB video upload limits before storage", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      externalOperatorPhone: "13800000000",
      id: "work-order-visible",
      operatorType: "EXTERNAL",
      status: "FIELD_IN_PROGRESS"
    });
    harness.state.evidenceItems.push({
      handoverId: "handover-1",
      id: "evidence-item-owned",
      orderId: harness.orderId
    });

    await harness.service.uploadAndAttachFieldAccessibleEvidenceFile(
      "work-order-visible",
      "13800000000",
      "evidence-item-owned",
      [uploadFile("photo-at-limit.jpg", "image/jpeg", 10 * 1024 * 1024)],
      {},
      "field-session-1"
    );
    await harness.service.uploadAndAttachFieldAccessibleEvidenceFile(
      "work-order-visible",
      "13800000000",
      "evidence-item-owned",
      [uploadFile("video-at-limit.mp4", "video/mp4", 300 * 1024 * 1024)],
      {},
      "field-session-1"
    );
    harness.storageService.putDeliveryEvidenceFile.mockClear();
    await expect(
      harness.service.uploadAndAttachFieldAccessibleEvidenceFile(
        "work-order-visible",
        "13800000000",
        "evidence-item-owned",
        [uploadFile("photo-over-limit.jpg", "image/jpeg", 10 * 1024 * 1024 + 1)],
        {},
        "field-session-1"
      )
    ).rejects.toThrow("图片不能超过 10MB");
    await expect(
      harness.service.uploadAndAttachFieldAccessibleEvidenceFile(
        "work-order-visible",
        "13800000000",
        "evidence-item-owned",
        [uploadFile("video-over-limit.mp4", "video/mp4", 300 * 1024 * 1024 + 1)],
        {},
        "field-session-1"
      )
    ).rejects.toThrow("视频不能超过 300MB");
    expect(harness.storageService.putDeliveryEvidenceFile).not.toHaveBeenCalled();
  });

  it("accepts iPhone HEIC and MOV files when the browser omits MIME types", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      externalOperatorPhone: "13800000000",
      id: "work-order-visible",
      operatorType: "EXTERNAL",
      status: "FIELD_IN_PROGRESS"
    });
    harness.state.evidenceItems.push({
      handoverId: "handover-1",
      id: "evidence-item-owned",
      orderId: harness.orderId
    });

    await harness.service.uploadAndAttachFieldAccessibleEvidenceFile(
      "work-order-visible",
      "13800000000",
      "evidence-item-owned",
      [uploadFile("vehicle-front.heic", "")],
      {},
      "field-session-1"
    );
    await harness.service.uploadAndAttachFieldAccessibleEvidenceFile(
      "work-order-visible",
      "13800000000",
      "evidence-item-owned",
      [uploadFile("vehicle-walkaround.mov", "")],
      {},
      "field-session-1"
    );

    expect(harness.storageService.putDeliveryEvidenceFile).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ contentType: "image/heic", originalName: "vehicle-front.heic" })
    );
    expect(harness.storageService.putDeliveryEvidenceFile).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ contentType: "video/quicktime", originalName: "vehicle-walkaround.mov" })
    );
    expect(harness.evidenceService.attachEvidenceFile).toHaveBeenNthCalledWith(
      1,
      "evidence-item-owned",
      "file-1",
      "PHOTO",
      undefined,
      expect.any(Object),
      "field-session-1",
      expect.objectContaining({ photoPreviewFileId: "file-2" })
    );
    expect(harness.evidenceService.attachEvidenceFile).toHaveBeenNthCalledWith(
      2,
      "evidence-item-owned",
      "file-3",
      "VIDEO",
      undefined,
      expect.any(Object),
      "field-session-1",
      expect.objectContaining({ videoFrameFileIds: ["file-4"] })
    );
  });

  it("rolls back the upload relation and removes only the new object when audit persistence fails", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      externalOperatorPhone: "13800000000",
      id: "work-order-visible",
      operatorType: "EXTERNAL",
      status: "FIELD_IN_PROGRESS"
    });
    harness.state.evidenceItems.push({
      handoverId: "handover-1",
      id: "evidence-item-owned",
      orderId: harness.orderId
    });
    harness.prisma.vehicleHandoverEvent.create.mockRejectedValueOnce(new Error("audit unavailable"));

    await expect(
      harness.service.uploadAndAttachFieldAccessibleEvidenceFile(
        "work-order-visible",
        "13800000000",
        "evidence-item-owned",
        [uploadFile("front.jpg", "image/jpeg")],
        {},
        "field-session-1"
      )
    ).rejects.toThrow("audit unavailable");

    expect(harness.state.fileObjects).toEqual([]);
    expect(harness.state.workOrders[0]?.reviewVersion).toBe(0);
    expect(harness.storageService.deleteObject).toHaveBeenCalledWith(
      "application-materials",
      expect.stringContaining("delivery-evidence/work-order-visible")
    );
  });

  it("rejects a stale concurrent upload before linking the stored object", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      externalOperatorPhone: "13800000000",
      id: "work-order-visible",
      operatorType: "EXTERNAL",
      status: "FIELD_IN_PROGRESS"
    });
    harness.state.evidenceItems.push({
      handoverId: "handover-1",
      id: "evidence-item-owned",
      orderId: harness.orderId
    });
    harness.prisma.vehicleHandoverWorkOrder.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      harness.service.uploadAndAttachFieldAccessibleEvidenceFile(
        "work-order-visible",
        "13800000000",
        "evidence-item-owned",
        [uploadFile("front.jpg", "image/jpeg")],
        {},
        "field-session-1"
      )
    ).rejects.toThrow(ConflictException);

    expect(harness.evidenceService.attachEvidenceFile).not.toHaveBeenCalled();
    expect(harness.state.fileObjects).toEqual([]);
    expect(harness.storageService.deleteObject).toHaveBeenCalledTimes(2);
  });

  it("requires evidence files to remain ACTIVE before previewing or downloading them", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      id: "work-order-visible",
      status: "FIELD_IN_PROGRESS"
    });

    await expect(
      harness.service.previewEvidenceFile("work-order-visible", "evidence-file-removed")
    ).rejects.toThrow();

    expect(harness.prisma.vehicleDeliveryEvidenceFile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "evidence-file-removed",
          lifecycleStatus: "ACTIVE"
        })
      })
    );
  });

  it("repairs historical evidence artifacts once and verifies derivative file objects before treating them as ready", async () => {
    const harness = createHandoverWorkOrderHarness();
    const workOrder = {
      ...baseWorkOrder(harness),
      id: "work-order-visible",
      status: "FIELD_IN_PROGRESS"
    };
    const evidenceFile = {
      evidenceItem: {
        evidenceType: "VEHICLE_FRONT",
        handoverId: "handover-1",
        orderId: harness.orderId
      },
      file: {
        bucket: "application-materials",
        mimeType: "image/jpeg",
        objectKey: "delivery-evidence/legacy/front.jpg",
        originalName: "legacy-front.jpg",
        sizeBytes: 5n
      },
      id: "evidence-file-legacy",
      lifecycleStatus: "ACTIVE",
      mediaType: "PHOTO",
      metadata: null
    };
    harness.state.workOrders.push(workOrder);
    harness.state.evidenceFiles.push(evidenceFile);

    const repaired = await harness.service.prepareExistingEvidenceFileArtifacts(
      workOrder.id,
      evidenceFile.id,
      harness.admin.id
    );

    expect(repaired).toMatchObject({
      alreadyReady: false,
      evidenceFileId: evidenceFile.id,
      processingStatus: "READY"
    });
    expect(harness.storageService.getObject).toHaveBeenCalledWith(
      "application-materials",
      "delivery-evidence/legacy/front.jpg"
    );
    expect(harness.artifactService.prepareUpload).toHaveBeenCalledTimes(1);
    expect(harness.state.fileObjects).toHaveLength(1);
    expect(evidenceFile.metadata).toMatchObject({
      photoPreviewFileId: "file-1",
      processingStatus: "READY"
    });

    const second = await harness.service.prepareExistingEvidenceFileArtifacts(
      workOrder.id,
      evidenceFile.id,
      harness.admin.id
    );
    expect(second).toMatchObject({
      evidenceFileId: evidenceFile.id,
      processingStatus: "READY"
    });
    expect(harness.artifactService.prepareUpload).toHaveBeenCalledTimes(1);

    harness.state.fileObjects.splice(0);
    await harness.service.prepareExistingEvidenceFileArtifacts(
      workOrder.id,
      evidenceFile.id,
      harness.admin.id
    );
    expect(harness.artifactService.prepareUpload).toHaveBeenCalledTimes(2);
  });

  it("rejects the legacy external file-id binding route before evidence can bypass artifact processing", async () => {
    const harness = createHandoverWorkOrderHarness();
    const draft = await harness.service.createDraft(harness.orderId, "DELIVERY_OUTBOUND", harness.admin.id);
    const assigned = await harness.service.assignExternalOperator(
      draft.id,
      {
        expiresAt: new Date("2026-07-28T08:00:00.000Z"),
        name: "External field operator",
        phone: "13900001111"
      },
      harness.admin.id
    );

    await expect(harness.service.attachEvidenceFileWithExternalToken(
      assigned.accessToken,
      "evidence-item-owned",
      { fileId: "unsafe-existing-file", mediaType: "PHOTO" }
    )).rejects.toThrow(BadRequestException);
    expect(harness.evidenceService.attachEvidenceFile).not.toHaveBeenCalled();
  });

  it("records legacy token operators as display names instead of UUID actor ids", async () => {
    const harness = createHandoverWorkOrderHarness();
    const draft = await harness.service.createDraft(harness.orderId, "DELIVERY_OUTBOUND", harness.admin.id);
    const assigned = await harness.service.assignExternalOperator(
      draft.id,
      {
        name: "External field operator",
        phone: "13900001111"
      },
      harness.admin.id
    );

    await harness.service.startFieldWorkByToken(assigned.accessToken);

    expect(harness.state.events).toContainEqual(expect.objectContaining({
      actorDisplay: "External field operator",
      actorId: null,
      eventType: "FIELD_STARTED"
    }));
  });

  it("rejects SVG and mismatched active-content MIME types before storage", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      externalOperatorPhone: "13800000000",
      id: "work-order-visible",
      operatorType: "EXTERNAL",
      status: "FIELD_IN_PROGRESS"
    });
    harness.state.evidenceItems.push({
      handoverId: "handover-1",
      id: "evidence-item-owned",
      orderId: harness.orderId
    });

    await expect(
      harness.service.uploadAndAttachFieldAccessibleEvidenceFile(
        "work-order-visible",
        "13800000000",
        "evidence-item-owned",
        [uploadFile("active.svg", "image/svg+xml")],
        {},
        "field-session-1"
      )
    ).rejects.toThrow("现场证据仅支持安全的图片或视频文件");
    await expect(
      harness.service.uploadAndAttachFieldAccessibleEvidenceFile(
        "work-order-visible",
        "13800000000",
        "evidence-item-owned",
        [uploadFile("disguised.jpg", "text/html")],
        {},
        "field-session-1"
      )
    ).rejects.toThrow("现场证据仅支持安全的图片或视频文件");
    expect(harness.storageService.putDeliveryEvidenceFile).not.toHaveBeenCalled();
  });

  it("declares no visible damage and submits field evidence without Stage 2 side effects", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      accessoryChecklist: { chargingCable: true, keys: 2 },
      energyLevelText: "80%",
      externalOperatorPhone: "13800000000",
      handoverMileageKm: 28600,
      id: "work-order-visible",
      operatorType: "EXTERNAL",
      status: "FIELD_IN_PROGRESS"
    });

    await harness.service.declareFieldAccessibleNoVisibleDamage(
      "work-order-visible",
      "13800000000",
      "现场确认"
    );
    const submitted = await harness.service.submitFieldAccessibleEvidence(
      "work-order-visible",
      "13800000000",
      "field-session-1"
    );

    expect(harness.evidenceService.declareNoVisibleDamage).toHaveBeenCalledWith(
      harness.orderId,
      undefined,
      "handover-1",
      "现场确认",
      expect.any(Object)
    );
    expect(submitted).toMatchObject({
      fieldSubmittedAt: expect.any(Date),
      status: "CUSTOMER_REVIEWING"
    });
    expect(harness.handoverService.assertDeliveryCanBeConfirmed).not.toHaveBeenCalled();
    expect(harness.handoverService.isDeliveryReady).not.toHaveBeenCalled();
  });

  it("returns field-session readiness blockers for incomplete facts or damage close-up evidence", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.evidenceService.setFieldReadiness({
      blockingDetails: [],
      blockingReasons: ["请上传损伤/瑕疵近拍"],
      handoverId: "handover-1",
      orderId: harness.orderId,
      ready: false
    });
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      accessoryChecklist: { chargingCable: true, keys: 2 },
      damageDeclared: true,
      energyLevelText: "80%",
      externalOperatorPhone: "13800000000",
      handoverMileageKm: 28600,
      id: "work-order-visible",
      noVisibleDamageDeclared: false,
      operatorType: "EXTERNAL",
      status: "FIELD_IN_PROGRESS"
    });

    const readiness = await harness.service.getFieldAccessibleReadiness("work-order-visible", "13800000000");

    expect(readiness.ready).toBe(false);
    expect(readiness.blockingReasons).toContain("请上传损伤/瑕疵近拍");
  });

  it("retracts a stale no-visible-damage declaration when field work switches to damage", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      accessoryChecklist: { chargingCable: true, keys: 2 },
      damageDeclared: false,
      energyLevelText: "80%",
      externalOperatorPhone: "13800000000",
      handoverMileageKm: 28600,
      id: "work-order-visible",
      noVisibleDamageDeclared: true,
      operatorType: "EXTERNAL",
      status: "FIELD_IN_PROGRESS"
    });

    const updated = await harness.service.updateFieldAccessibleFacts(
      "work-order-visible",
      "13800000000",
      {
        damageDeclared: true,
        noVisibleDamageDeclared: false
      },
      "field-session-1"
    );

    expect(updated).toMatchObject({
      damageDeclared: true,
      noVisibleDamageDeclared: false
    });
    expect(harness.evidenceService.retractNoVisibleDamageDeclaration).toHaveBeenCalledWith(
      harness.orderId,
      "field-session-1",
      "handover-1",
      expect.any(Object)
    );
  });

  it("requires field facts, evidence completeness, and a resolved damage state before customer review", async () => {
    const harness = createHandoverWorkOrderHarness();
    const draft = await harness.service.createDraft(harness.orderId, "DELIVERY_OUTBOUND", harness.admin.id);
    await harness.service.assignInternalOperator(draft.id, harness.internalUser.id, harness.admin.id);
    await harness.service.startFieldWork(draft.id, harness.internalUser.id);

    await expect(harness.service.submitEvidence(draft.id, harness.internalUser.id)).rejects.toThrow(BadRequestException);

    await harness.service.updateFieldFacts(draft.id, {
      accessoryChecklist: { chargingCable: true, keys: 2 },
      deliveryLocation: "上海市测试交付点",
      energyLevelText: "80%",
      handoverMileageKm: 28500,
      noVisibleDamageDeclared: true
    }, harness.internalUser.id);

    harness.evidenceService.setFieldComplete(false);
    await expect(harness.service.submitEvidence(draft.id, harness.internalUser.id)).rejects.toThrow("证据尚未完整");

    harness.evidenceService.setFieldComplete(true);
    const submitted = await harness.service.submitEvidence(draft.id, harness.internalUser.id);
    expect(submitted).toMatchObject({
      fieldSubmittedAt: expect.any(Date),
      status: "CUSTOMER_REVIEWING"
    });
    expect(harness.evidenceService.assertFieldEvidenceComplete).toHaveBeenCalledWith(
      harness.orderId,
      "handover-1",
      expect.objectContaining({ noVisibleDamageDeclared: true })
    );
  });

  it("allows customer no-objection confirmation to unlock Stage 2 PDF/eSign while ops review remains non-blocking", async () => {
    const harness = createReadyForCustomerReviewHarness();

    await expect(harness.service.assertReadyForStage2Pdf(harness.orderId)).rejects.toThrow("客户尚未确认");

    const manifestHash = (await harness.service.getCurrentEvidencePackage("work-order-1")).manifestHash;
    const confirmed = await harness.service.customerConfirmNoObjection(
      "work-order-1",
      "customer-1",
      manifestHash
    );
    expect(confirmed).toMatchObject({
      customerConfirmedAt: expect.any(Date),
      status: "CUSTOMER_CONFIRMED"
    });

    await expect(harness.service.markOpsReviewPending("work-order-1", harness.admin.id)).rejects.toThrow(
      BadRequestException
    );

    await harness.service.markCustomerSigned("work-order-1", new Date("2026-07-21T04:10:00.000Z"), harness.admin.id);
    await harness.service.markOpsReviewPending("work-order-1", harness.admin.id);
    await expect(harness.service.assertReadyForStage2Pdf(harness.orderId)).resolves.toBeUndefined();
    await expect(harness.service.assertReadyForStage2ESign(harness.orderId)).resolves.toBeUndefined();

    await harness.service.markOpsReviewRejected("work-order-1", harness.admin.id, "抽检后补材料");
    await expect(harness.service.assertReadyForStage2ESign(harness.orderId)).resolves.toBeUndefined();
  });

  it("blocks ops review pending before post-signing work-order states", async () => {
    const blockedStatuses = [
      "DRAFT",
      "ASSIGNED",
      "FIELD_IN_PROGRESS",
      "EVIDENCE_SUBMITTED",
      "CUSTOMER_REVIEWING",
      "CUSTOMER_CONFIRMED",
      "CUSTOMER_OBJECTED",
      "VOIDED",
      "FAILED",
      "CANCELLED"
    ];

    for (const status of blockedStatuses) {
      const harness = createConfirmedWorkOrderHarness();
      Object.assign(harness.state.workOrders[0]!, { status });

      await expect(harness.service.markOpsReviewPending("work-order-1", harness.admin.id)).rejects.toThrow(
        BadRequestException
      );
    }
  });

  it("rejects ops review decisions unless the work order is pending ops review", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push(baseWorkOrder(harness));

    await expect(
      harness.service.markOpsReviewApproved("work-order-1", harness.admin.id)
    ).rejects.toThrow(BadRequestException);
    await expect(
      harness.service.markOpsReviewRejected("work-order-1", harness.admin.id)
    ).rejects.toThrow(BadRequestException);
  });

  it("allows ops review pending after customer signing, platform seal, or field completion", async () => {
    const allowedStatuses = ["CUSTOMER_SIGNED", "PLATFORM_SEALED", "FIELD_COMPLETED", "OPS_REVIEW_PENDING", "OPS_REVIEWED"];

    for (const status of allowedStatuses) {
      const harness = createConfirmedWorkOrderHarness();
      Object.assign(harness.state.workOrders[0]!, {
        fieldCompletedAt: harness.now,
        opsReviewStatus: status === "OPS_REVIEW_PENDING" ? "PENDING" : "NOT_REQUIRED",
        status
      });

      const updated = await harness.service.markOpsReviewPending("work-order-1", harness.admin.id);

      expect(updated).toMatchObject({
        opsReviewStatus: "PENDING",
        status: "OPS_REVIEW_PENDING"
      });
    }
  });

  it("blocks Stage 2 signing when the customer objects or the work order is cancelled", async () => {
    const harness = createReadyForCustomerReviewHarness();

    await harness.service.customerObject("work-order-1", "customer-1", "车辆外观有异议");

    await expect(harness.service.assertReadyForStage2ESign(harness.orderId)).rejects.toThrow("客户存在异议");
    expect(harness.state.workOrders[0]!).toMatchObject({
      customerObjectionReason: "车辆外观有异议",
      status: "CUSTOMER_OBJECTED"
    });

    const cancelledHarness = createReadyForCustomerReviewHarness();
    await cancelledHarness.service.voidOrCancel("work-order-1", "CANCELLED", cancelledHarness.admin.id, "取消测试");
    await expect(cancelledHarness.service.assertReadyForStage2Pdf(cancelledHarness.orderId)).rejects.toThrow("交付工单已终止");
  });

  it("requires Admin intervention before an objected handover can be resubmitted to customer review", async () => {
    const harness = createReadyForCustomerReviewHarness();
    Object.assign(harness.state.workOrders[0]!, {
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      externalOperatorPhone: "13800000000",
      operatorType: "EXTERNAL"
    });

    await harness.service.customerObject("work-order-1", "customer-1", "车辆外观有异议", "右前轮毂需复核");

    await expect(
      harness.service.submitFieldAccessibleEvidence("work-order-1", "13800000000", "field-session-1")
    ).rejects.toThrow(BadRequestException);

    await harness.service.acknowledgeCustomerObjection("work-order-1", harness.admin.id, "已受理");
    await harness.service.requestCustomerObjectionResubmission("work-order-1", harness.admin.id, {
      note: "请现场重拍右前轮毂",
      targetEvidenceItemIds: [],
      targetFieldKeys: ["fieldNotes"]
    });

    await expect(
      harness.service.submitFieldAccessibleEvidence("work-order-1", "13800000000", "field-session-1")
    ).rejects.toThrow("请至少更新一项后台要求复检的现场资料");

    await harness.service.updateFieldAccessibleFacts(
      "work-order-1",
      "13800000000",
      { fieldNotes: "右前轮毂已完成复检" },
      "field-session-1"
    );

    const resubmitted = await harness.service.submitFieldAccessibleEvidence(
      "work-order-1",
      "13800000000",
      "field-session-1"
    );
    expect(resubmitted).toMatchObject({
      customerObjectedAt: expect.any(Date),
      customerObjectionReason: "车辆外观有异议",
      status: "CUSTOMER_OBJECTED"
    });
    expect(resubmitted.metadata).toMatchObject({
      handoverReviewAdminStatus: "RESUBMITTED_PENDING_ADMIN"
    });
    expect(resubmitted).toMatchObject({
      adminReviewStatus: "RESUBMITTED_PENDING_ADMIN"
    });
    await expect(harness.service.assertReadyForStage2Pdf(harness.orderId)).rejects.toThrow("现场资料已重新提交");
    await expect(harness.service.customerConfirmNoObjection(
      "work-order-1",
      "customer-1",
      `sha256:${"0".repeat(64)}`
    )).rejects.toThrow(
      "客户已提交异议"
    );

    await harness.service.sendCustomerObjectionBackToReview(
      "work-order-1",
      harness.admin.id,
      "已送回客户复核"
    );

    expect(harness.state.workOrders[0]!).toMatchObject({
      customerObjectedAt: null,
      customerObjectionReason: null,
      status: "CUSTOMER_REVIEWING"
    });
    expect(harness.state.reviewAttempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attemptNo: 1,
          customerObjectionReason: "车辆外观有异议",
          status: "RESUBMITTED_PENDING_ADMIN"
        }),
        expect.objectContaining({
          attemptNo: 2,
          status: "CUSTOMER_REVIEWING"
        })
      ])
    );
    const refreshedManifestHash =
      (await harness.service.getCurrentEvidencePackage("work-order-1")).manifestHash;
    await expect(harness.service.customerConfirmNoObjection(
      "work-order-1",
      "customer-1",
      refreshedManifestHash
    )).resolves.toMatchObject({
      status: "CUSTOMER_CONFIRMED"
    });
    expect(harness.state.events.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      "CUSTOMER_OBJECTED",
      "OBJECTION_ACKNOWLEDGED",
      "RESUBMISSION_REQUESTED",
      "FIELD_FACTS_UPDATED",
      "FIELD_RESUBMITTED",
      "SENT_BACK_TO_CUSTOMER_REVIEW",
      "CUSTOMER_CONFIRMED"
    ]));
  });

  it("rejects skipped, repeated, and regressive objection transitions", async () => {
    const harness = createReadyForCustomerReviewHarness();
    Object.assign(harness.state.workOrders[0]!, {
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      externalOperatorPhone: "13800000000",
      operatorType: "EXTERNAL"
    });
    await harness.service.customerObject("work-order-1", "customer-1", "车辆外观有异议");

    await expect(
      harness.service.requestCustomerObjectionResubmission("work-order-1", harness.admin.id, {
        note: "请重检",
        targetEvidenceItemIds: [],
        targetFieldKeys: []
      })
    ).rejects.toThrow("请先受理客户异议");

    await harness.service.acknowledgeCustomerObjection("work-order-1", harness.admin.id, "已受理");
    await expect(
      harness.service.acknowledgeCustomerObjection("work-order-1", harness.admin.id, "重复受理")
    ).rejects.toThrow("当前异议状态不能重复受理");
    await expect(
      harness.service.sendCustomerObjectionBackToReview("work-order-1", harness.admin.id, "跳步送回")
    ).rejects.toThrow("现场资料重新提交后，后台才能送回客户复核");
  });

  it("normalizes legacy customer-reviewing objections when Admin requests field resubmission", async () => {
    const harness = createReadyForCustomerReviewHarness();
    Object.assign(harness.state.workOrders[0]!, {
      adminReviewStatus: "ACKNOWLEDGED",
      customerObjectedAt: harness.now,
      customerObjectionReason: "legacy objection",
      status: "CUSTOMER_REVIEWING"
    });

    const requested = await harness.service.requestCustomerObjectionResubmission(
      "work-order-1",
      harness.admin.id,
      {
        note: "recheck legacy objection",
        targetEvidenceItemIds: [],
        targetFieldKeys: ["fieldNotes"]
      }
    );

    expect(requested).toMatchObject({
      fieldResubmissionRequested: true,
      status: "CUSTOMER_OBJECTED"
    });
  });

  it("allows field edits for legacy active objections with resubmission already requested", async () => {
    const harness = createReadyForCustomerReviewHarness();
    Object.assign(harness.state.workOrders[0]!, {
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      adminReviewStatus: "RESUBMISSION_REQUESTED",
      customerObjectedAt: harness.now,
      customerObjectionReason: "legacy objection",
      externalOperatorPhone: "13800000000",
      operatorType: "EXTERNAL",
      status: "CUSTOMER_REVIEWING"
    });

    await expect(
      harness.service.updateFieldAccessibleFacts(
        "work-order-1",
        "13800000000",
        { fieldNotes: "legacy recheck updated" },
        "field-session-1"
      )
    ).resolves.toMatchObject({
      fieldNotes: "legacy recheck updated",
      status: "CUSTOMER_REVIEWING"
    });
  });

  it("returns recheck guidance before a legacy objection recheck is resubmitted", async () => {
    const harness = createReadyForCustomerReviewHarness();
    Object.assign(harness.state.workOrders[0]!, {
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      externalOperatorPhone: "13800000000",
      operatorType: "EXTERNAL"
    });
    harness.evidenceService.setChecklist({
      blockingReasons: [],
      items: [
        {
          evidenceType: "FRONT_INTERIOR",
          files: [],
          id: "evidence-item-front-interior",
          isRequired: true,
          reviewStatus: "PENDING",
          status: "UPLOADED",
          title: "前排内饰"
        }
      ],
      ready: false
    });

    await harness.service.customerObject(
      "work-order-1",
      "customer-1",
      "损伤不认可",
      "驾驶位座椅内饰有烫伤未标记"
    );
    await harness.service.acknowledgeCustomerObjection("work-order-1", harness.admin.id, "已受理");
    await harness.service.requestCustomerObjectionResubmission("work-order-1", harness.admin.id, {
      note: "客户异议，请重新车检",
      targetEvidenceItemIds: ["evidence-item-front-interior"],
      targetFieldKeys: ["damageDeclared", "noVisibleDamageDeclared"]
    });

    Object.assign(harness.state.workOrders[0]!, { status: "CUSTOMER_REVIEWING" });

    const detail = await harness.service.getFieldAccessibleWorkOrder("work-order-1", "13800000000");

    expect(detail.reviewContext).toMatchObject({
      adminNote: "客户异议，请重新车检",
      customerObjectionDetails: "驾驶位座椅内饰有烫伤未标记",
      customerObjectionReason: "损伤不认可",
      requestedEvidenceItems: [
        {
          id: "evidence-item-front-interior",
          title: "前排内饰"
        }
      ],
      requestedFieldKeys: ["damageDeclared", "noVisibleDamageDeclared"]
    });
  });

  it("rejects stale objection transitions without writing an audit event", async () => {
    const harness = createReadyForCustomerReviewHarness();
    await harness.service.customerObject("work-order-1", "customer-1", "车辆外观有异议");
    const eventCount = harness.state.events.length;
    harness.prisma.vehicleHandoverWorkOrder.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      harness.service.acknowledgeCustomerObjection("work-order-1", harness.admin.id)
    ).rejects.toThrow("交接复核状态已更新，请刷新后重试");

    expect(harness.state.events).toHaveLength(eventCount);
    expect(harness.state.workOrders[0]?.adminReviewStatus).toBe("NONE");
  });

  it("lists only actionable customer objections in the Admin review queue", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push(
      {
        ...baseWorkOrder(harness),
        adminReviewStatus: "ACKNOWLEDGED",
        customerObjectedAt: harness.now,
        customerObjectionReason: "车辆外观",
        id: "work-order-objected",
        status: "CUSTOMER_OBJECTED"
      },
      {
        ...baseWorkOrder(harness),
        adminReviewStatus: "RESOLVED",
        customerConfirmedAt: harness.now,
        id: "work-order-confirmed",
        status: "CUSTOMER_CONFIRMED"
      }
    );

    const queue = await harness.service.listAdminReviewQueue();

    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      id: "work-order-objected",
      objection: { reason: "车辆外观" }
    });
  });

  it("keeps field completion tied to customer signing and delivery confirmation tied to completed Stage 2 signing", async () => {
    const harness = createConfirmedWorkOrderHarness();

    await expect(harness.service.assertDeliveryCanBeConfirmed(harness.orderId)).rejects.toThrow(BadRequestException);

    await harness.service.markCustomerSigned("work-order-1", new Date("2026-07-21T04:10:00.000Z"), harness.admin.id);
    expect(harness.state.workOrders[0]!).toMatchObject({
      fieldCompletedAt: expect.any(Date),
      status: "CUSTOMER_SIGNED"
    });
    await expect(harness.service.assertDeliveryCanBeConfirmed(harness.orderId)).rejects.toThrow(BadRequestException);

    harness.state.handover.status = "SIGNED";
    harness.state.handover.archiveStatus = "FAILED";
    await harness.service.markPlatformSealed("work-order-1", new Date("2026-07-21T04:12:00.000Z"), harness.admin.id);
    await expect(harness.service.assertDeliveryCanBeConfirmed(harness.orderId)).resolves.toBeUndefined();
    await harness.service.markFieldCompleted("work-order-1", new Date("2026-07-21T04:15:00.000Z"), harness.admin.id);
    expect(harness.state.events.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      "CUSTOMER_SIGNED",
      "PLATFORM_SEALED",
      "FIELD_COMPLETED"
    ]));
  });

  it("rejects signing and completion state jumps from a draft work order", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push(baseWorkOrder(harness));

    await expect(
      harness.service.markCustomerSigned("work-order-1", harness.now, harness.admin.id)
    ).rejects.toThrow(BadRequestException);
    await expect(
      harness.service.markPlatformSealed("work-order-1", harness.now, harness.admin.id)
    ).rejects.toThrow(BadRequestException);
    await expect(
      harness.service.markFieldCompleted("work-order-1", harness.now, harness.admin.id)
    ).rejects.toThrow(BadRequestException);
  });

  it("requires an explicit customer-signed state before platform sealing", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      status: "SIGNING"
    });

    await expect(
      harness.service.markPlatformSealed("work-order-1", harness.now, harness.admin.id)
    ).rejects.toThrow(BadRequestException);
    expect(harness.state.events).toEqual([]);
  });
});

function createReadyForCustomerReviewHarness() {
  const harness = createHandoverWorkOrderHarness();
  harness.state.workOrders.push({
    ...baseWorkOrder(harness),
    accessoryChecklist: { chargingCable: true, keys: 2 },
    energyLevelText: "80%",
    fieldSubmittedAt: harness.now,
    handoverMileageKm: 28500,
    noVisibleDamageDeclared: true,
    status: "CUSTOMER_REVIEWING"
  });
  return harness;
}

function createConfirmedWorkOrderHarness() {
  const harness = createReadyForCustomerReviewHarness();
  Object.assign(harness.state.workOrders[0]!, {
    customerConfirmedAt: harness.now,
    status: "CUSTOMER_CONFIRMED"
  });
  const evidencePackage = buildDeliveryHandoverEvidencePackage({
    evidenceChecklist: harness.evidenceService.getCurrentChecklist(),
    handoverId: "handover-1",
    orderId: harness.orderId,
    workOrderId: "work-order-1"
  });
  harness.state.reviewAttempts.push({
    attemptNo: 1,
    evidenceSnapshot: {
      evidencePackage: {
        manifest: evidencePackage.manifest,
        manifestHash: evidencePackage.manifestHash,
        stats: evidencePackage.stats
      }
    },
    handoverId: "handover-1",
    id: "review-attempt-confirmed",
    orderId: harness.orderId,
    status: "CUSTOMER_CONFIRMED",
    workOrderId: "work-order-1"
  });
  return harness;
}

function baseWorkOrder(harness: ReturnType<typeof createHandoverWorkOrderHarness>) {
  return {
    accessTokenExpiresAt: null,
    accessTokenHash: null,
    accessTokenRevokedAt: null,
    adminReviewStatus: "NONE",
    accessoryChecklist: null,
    assignedInternalUserId: null,
    createdAt: harness.now,
    customerConfirmedAt: null,
    customerObjectedAt: null,
    customerObjectionReason: null,
    customerReviewStartedAt: null,
    damageDeclared: null,
    deliveryLocation: null,
    energyLevelText: null,
    externalOperatorName: null,
    externalOperatorOrganization: null,
    externalOperatorPhone: null,
    fieldCompletedAt: null,
    fieldNotes: null,
    fieldStartedAt: null,
    fieldSubmittedAt: null,
    firstAccessedAt: null,
    fuelLevelText: null,
    handoverId: "handover-1",
    handoverMileageKm: null,
    handoverType: "DELIVERY_OUTBOUND",
    id: "work-order-1",
    lastAccessedAt: null,
    metadata: null,
    noVisibleDamageDeclared: null,
    operatorType: "INTERNAL",
    opsReviewNotes: null,
    opsReviewStatus: "NOT_REQUIRED",
    opsReviewedAt: null,
    opsReviewedBy: null,
    orderId: harness.orderId,
    reviewVersion: 0,
    scheduledAt: null,
    status: "DRAFT",
    updatedAt: harness.now,
    vehicleDeliveryId: "delivery-1"
  };
}

function createHandoverWorkOrderHarness() {
  const now = new Date("2026-07-21T08:00:00.000Z");
  const orderId = "order-1";
  const admin = { id: "admin-1" };
  const internalUser = { id: "user-field-1" };
  const state = {
    handover: {
      archiveStatus: "NOT_STARTED",
      deletedAt: null,
      id: "handover-1",
      orderId,
      signedObjectKey: null,
      status: "DRAFT",
      vehicleDeliveryId: "delivery-1"
    },
    order: {
      contract: {
        deletedAt: null,
        id: "contract-stage1",
        status: ContractStatus.SIGNED
      },
      contractId: "contract-stage1",
      customer: {
        id: "customer-1",
        idCardNo: "TEST_ID_CARD_SHOULD_NOT_LEAK",
        mobile: "18616570212",
        name: "李柯"
      },
      customerId: "customer-1",
      deletedAt: null,
      id: orderId,
      monthlyFeeAmount: 399900n,
      orderNo: "ORD202607210001",
      vehicle: {
        brand: "Tesla",
        deletedAt: null,
        id: "vehicle-1",
        model: "Model 3",
        plateNo: "沪A12345",
        vin: "LFPH3AC12N123888888"
      },
      vehicleId: "vehicle-1"
    },
    users: [
      { deletedAt: null, id: admin.id, name: "管理员" },
      { deletedAt: null, id: internalUser.id, name: "内部交付员" }
    ],
    vehicleDelivery: {
      deletedAt: null,
      deliveryLocation: "上海市测试交付点",
      id: "delivery-1",
      orderId,
      scheduledAt: new Date("2026-07-22T02:00:00.000Z")
    },
    evidenceItems: [] as Array<Record<string, unknown>>,
    evidenceFiles: [] as Array<Record<string, unknown>>,
    events: [] as Array<Record<string, unknown>>,
    fileObjects: [] as Array<Record<string, unknown>>,
    reviewAttempts: [] as Array<Record<string, unknown>>,
    workOrders: [] as Array<Record<string, unknown>>
  };
  const evidenceService = createEvidenceService();
  const handoverService = {
    getOrCreateDraftHandover: vi.fn(async () => state.handover),
    isDeliveryReady: vi.fn(),
    assertDeliveryCanBeConfirmed: vi.fn(async () => {
      if (state.handover.status !== "SIGNED" && state.handover.status !== "ARCHIVED") {
        throw new BadRequestException("交付交接确认书尚未完成签署。");
      }
    })
  };
  const prisma = {
    subscriptionOrder: {
      findFirst: vi.fn(async () => state.order),
      findUnique: vi.fn(async () => state.order)
    },
    user: {
      findFirst: vi.fn(async ({ where }: { where: { id?: string } }) =>
        state.users.find((user) => user.id === where.id && user.deletedAt === null) ?? null
      )
    },
    vehicleDelivery: {
      findUnique: vi.fn(async () => state.vehicleDelivery)
    },
    fileObject: {
      count: vi.fn(async ({ where }: { where: { id?: { in?: string[] } } }) => {
        const ids = where.id?.in ?? [];
        return state.fileObjects.filter((fileObject) => ids.includes(String(fileObject.id))).length;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const fileObject = {
          ...data,
          id: `file-${state.fileObjects.length + 1}`
        };
        state.fileObjects.push(fileObject);
        return fileObject;
      })
    },
    vehicleDeliveryEvidenceItem: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.evidenceItems.find((item) => matchesEvidenceItemWhere(item, where)) ?? null
      )
    },
    vehicleDeliveryEvidenceFile: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.evidenceFiles.find((file) =>
          (!where.id || file.id === where.id) &&
          (!where.lifecycleStatus || file.lifecycleStatus === where.lifecycleStatus)
        ) ?? null
      ),
      update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id?: string } }) => {
        const evidenceFile = state.evidenceFiles.find((row) => row.id === where.id);
        if (!evidenceFile) {
          throw new Error("evidence file not found");
        }
        Object.assign(evidenceFile, data);
        return evidenceFile;
      })
    },
    vehicleHandoverWorkOrder: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const workOrder = {
          ...baseWorkOrder({ now, orderId } as ReturnType<typeof createHandoverWorkOrderHarness>),
          ...data,
          id: `work-order-${state.workOrders.length + 1}`
        };
        state.workOrders.push(workOrder);
        return workOrder;
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.workOrders.find((workOrder) => matchesWorkOrderWhere(workOrder, where)) ?? null
      ),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.workOrders.filter((workOrder) => matchesWorkOrderWhere(workOrder, where))
      ),
      findUnique: vi.fn(async ({ where }: { where: { id?: string } }) =>
        state.workOrders.find((workOrder) => workOrder.id === where.id) ?? null
      ),
      update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id?: string } }) => {
        const workOrder = state.workOrders.find((row) => row.id === where.id);
        if (!workOrder) {
          throw new Error("work order not found");
        }
        Object.assign(workOrder, applyAtomicUpdates(workOrder, data), { updatedAt: now });
        return workOrder;
      }),
      updateMany: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: Record<string, unknown> }) => {
        const rows = state.workOrders.filter((workOrder) => matchesWorkOrderWhere(workOrder, where));
        for (const workOrder of rows) {
          Object.assign(workOrder, applyAtomicUpdates(workOrder, data), { updatedAt: now });
        }
        return { count: rows.length };
      })
    },
    vehicleHandoverEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const event = {
          ...data,
          createdAt: now,
          id: `handover-event-${state.events.length + 1}`
        };
        state.events.push(event);
        return event;
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.events.filter((event) => matchesHandoverEventWhere(event, where))
      )
    },
    vehicleHandoverReviewAttempt: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const attempt = {
          ...data,
          createdAt: now,
          id: `review-attempt-${state.reviewAttempts.length + 1}`,
          updatedAt: now
        };
        state.reviewAttempts.push(attempt);
        return attempt;
      }),
      findFirst: vi.fn(async ({ orderBy, where }: { orderBy?: Record<string, string>; where: Record<string, unknown> }) => {
        const rows = state.reviewAttempts.filter((attempt) => matchesReviewAttemptWhere(attempt, where));
        return sortReviewAttempts(rows, orderBy)[0] ?? null;
      }),
      findMany: vi.fn(async ({ orderBy, where }: { orderBy?: Record<string, string>; where: Record<string, unknown> }) =>
        sortReviewAttempts(state.reviewAttempts.filter((attempt) => matchesReviewAttemptWhere(attempt, where)), orderBy)
      ),
      update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id?: string } }) => {
        const attempt = state.reviewAttempts.find((row) => row.id === where.id);
        if (!attempt) {
          throw new Error("review attempt not found");
        }
        Object.assign(attempt, data, { updatedAt: now });
        return attempt;
      })
    },
    $transaction: vi.fn(async (callback: (client: unknown) => Promise<unknown>) => {
      const snapshots = {
        events: structuredClone(state.events),
        evidenceFiles: structuredClone(state.evidenceFiles),
        fileObjects: structuredClone(state.fileObjects),
        reviewAttempts: structuredClone(state.reviewAttempts),
        workOrders: structuredClone(state.workOrders)
      };
      try {
        return await callback(prisma);
      } catch (error) {
        state.events.splice(0, state.events.length, ...snapshots.events);
        state.evidenceFiles.splice(0, state.evidenceFiles.length, ...snapshots.evidenceFiles);
        state.fileObjects.splice(0, state.fileObjects.length, ...snapshots.fileObjects);
        state.reviewAttempts.splice(0, state.reviewAttempts.length, ...snapshots.reviewAttempts);
        state.workOrders.splice(0, state.workOrders.length, ...snapshots.workOrders);
        throw error;
      }
    })
  };
  const storageService = {
    deleteObject: vi.fn(async () => undefined),
    getObject: vi.fn(async () => ({
      contentLength: 5,
      contentType: "image/jpeg",
      stream: Readable.from([Buffer.from("photo")])
    })),
    putDeliveryEvidenceDerivativeFromPath: vi.fn(async (input: Record<string, unknown>) => ({
      bucket: "application-materials",
      objectKey: `delivery-evidence/${input.workOrderId}/2026/derivatives/preview.jpg`,
      stored: { driver: "local", key: "local-derivative-key", size: input.sizeBytes }
    })),
    putDeliveryEvidenceFileFromPath: vi.fn(async (input: Record<string, unknown>) => ({
      bucket: "application-materials",
      objectKey: `delivery-evidence/${input.workOrderId}/2026/video.mp4`,
      stored: { driver: "local", key: "local-stream-key", size: input.sizeBytes }
    })),
    putDeliveryEvidenceFile: vi.fn(async (input: Record<string, unknown>) => ({
      bucket: "application-materials",
      objectKey: `delivery-evidence/${input.workOrderId}/2026/front.jpg`,
      stored: { driver: "local", key: "local-key", size: 5 }
    }))
  };
  const artifactService = {
    prepareUpload: vi.fn(async (input: {
      file: { mimetype?: string; originalname?: string; size: number };
      mediaType: "PHOTO" | "VIDEO";
    }) => {
      const extension = input.file.originalname?.split(".").pop()?.toLowerCase();
      const detectedMimeType = input.mediaType === "PHOTO"
        ? extension === "heic"
          ? "image/heic"
          : extension === "heif"
            ? "image/heif"
            : input.file.mimetype || "image/jpeg"
        : extension === "mov"
          ? "video/quicktime"
          : extension === "m4v"
            ? "video/x-m4v"
            : input.file.mimetype || "video/mp4";
      return {
        cleanup: vi.fn(async () => undefined),
        derivatives: input.mediaType === "PHOTO"
          ? [{
              contentType: "image/jpeg",
              filePath: "C:/tmp/stage2-photo-preview.jpg",
              kind: "PHOTO_PREVIEW",
              originalName: "front-preview.jpg",
              sizeBytes: 8
            }]
          : [{
              contentType: "image/jpeg",
              filePath: "C:/tmp/stage2-video-frame-01.jpg",
              kind: "VIDEO_FRAME",
              originalName: "video-frame-01.jpg",
              sizeBytes: 8
            }],
        metadata: {
          artifactVersion: 1,
          detectedCodec: input.mediaType === "VIDEO" ? "h264" : null,
          detectedMimeType,
          processedAt: "2026-07-25T00:00:00.000Z",
          processingStatus: "READY",
          sourceSha256: `sha256:${"a".repeat(64)}`,
          sourceSizeBytes: input.file.size,
          videoDurationMs: input.mediaType === "VIDEO" ? 1_000 : null
        }
      };
    })
  };
  const service = new HandoverWorkOrderService(
    prisma as never,
    evidenceService as never,
    handoverService as never,
    storageService as never,
    undefined,
    undefined,
    artifactService as never
  );

  return {
    admin,
    artifactService,
    evidenceService,
    handoverService,
    internalUser,
    now,
    orderId,
    prisma,
    service,
    state
    ,
    storageService
  };
}

function createEvidenceService() {
  let fieldComplete = true;
  let fieldReadiness: Record<string, unknown> = {
    blockingDetails: [],
    blockingReasons: [],
    handoverId: "handover-1",
    orderId: "order-1",
    ready: true
  };
  let checklist: Record<string, unknown> = {
    blockingReasons: [],
    items: [
      {
        evidenceType: "VEHICLE_FRONT",
        files: [{
          file: {
            id: "file-default",
            mimeType: "image/jpeg",
            originalName: "front.jpg",
            sizeBytes: 1024
          },
          fileId: "file-default",
          id: "evidence-file-default",
          mediaType: "PHOTO",
          metadata: {
            artifactVersion: 1,
            detectedMimeType: "image/jpeg",
            photoPreviewFileId: "preview-file-default",
            processedAt: "2026-07-22T08:00:00.000Z",
            processingStatus: "READY",
            sourceSha256: `sha256:${"1".repeat(64)}`,
            sourceSizeBytes: 1024,
            videoDurationMs: null,
            videoFrameFileIds: []
          },
          objectKey: "oss/internal/evidence.jpg",
          uploadedAt: new Date("2026-07-22T08:00:00.000Z")
        }],
        id: "evidence-item-default",
        isRequired: true,
        reviewStatus: "PENDING",
        status: "UPLOADED",
        title: "车辆车头正面"
      },
      {
        evidenceType: "VEHICLE_REAR",
        files: [],
        id: "evidence-item-missing",
        isRequired: true,
        reviewStatus: "NOT_STARTED",
        status: "NOT_STARTED",
        title: "车辆车尾正面"
      }
    ],
    ready: false
  };
  return {
    assertFieldEvidenceComplete: vi.fn(async () => {
      if (!fieldComplete) {
        throw new BadRequestException("证据尚未完整");
      }
    }),
    attachEvidenceFile: vi.fn(async (itemId: string) => ({
      fileCount: 1,
      id: itemId,
      status: "UPLOADED"
    })),
    declareNoVisibleDamage: vi.fn(async () => ({
      declaredNoDamage: true,
      evidenceType: "NO_VISIBLE_DAMAGE_DECLARATION",
      status: "APPROVED"
    })),
    getChecklist: vi.fn(async () => checklist),
    getCurrentChecklist() {
      return checklist;
    },
    initializeChecklist: vi.fn(async () => ({ items: [] })),
    removeEvidenceFile: vi.fn(async (itemId: string) => ({
      fileCount: 0,
      id: itemId,
      status: "NOT_STARTED"
    })),
    replaceEvidenceFile: vi.fn(async (itemId: string) => ({
      fileCount: 1,
      id: itemId,
      status: "UPLOADED"
    })),
    retractNoVisibleDamageDeclaration: vi.fn(async () => null),
    validateEvidenceFileMutation: vi.fn(async (itemId: string) => ({
      allowsMultiple: false,
      currentFileCount: 1,
      evidenceType: "VEHICLE_FRONT",
      itemId
    })),
    validateFieldEvidenceComplete: vi.fn(async () => fieldReadiness),
    setChecklist(value: Record<string, unknown>) {
      checklist = value;
    },
    setFieldComplete(value: boolean) {
      fieldComplete = value;
    },
    setFieldReadiness(value: Record<string, unknown>) {
      fieldReadiness = value;
    }
  };
}

function matchesEvidenceItemWhere(item: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "OR") {
      return (expected as Array<Record<string, unknown>>).some((branch) => matchesEvidenceItemWhere(item, branch));
    }
    return item[key] === expected;
  });
}

function matchesWorkOrderWhere(workOrder: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "OR") {
      return (expected as Array<Record<string, unknown>>).some((branch) => matchesWorkOrderWhere(workOrder, branch));
    }
    if (key === "id") {
      return workOrder.id === expected;
    }
    if (key === "orderId") {
      return workOrder.orderId === expected;
    }
    if (key === "operatorType") {
      return workOrder.operatorType === expected;
    }
    if (key === "externalOperatorPhone") {
      return workOrder.externalOperatorPhone === expected;
    }
    if (key === "accessTokenRevokedAt") {
      return workOrder.accessTokenRevokedAt === expected;
    }
    if (key === "accessTokenExpiresAt" && expected === null) {
      return workOrder.accessTokenExpiresAt === null;
    }
    if (key === "accessTokenExpiresAt" && expected && typeof expected === "object" && "gt" in expected) {
      const expiresAt = workOrder.accessTokenExpiresAt as Date | null | undefined;
      return Boolean(expiresAt && expiresAt.getTime() > (expected.gt as Date).getTime());
    }
    if (key === "accessTokenHash") {
      return workOrder.accessTokenHash === expected;
    }
    if (key === "status" && expected && typeof expected === "object" && "notIn" in expected) {
      return !(expected.notIn as unknown[]).includes(workOrder.status);
    }
    if (key === "status") {
      return workOrder.status === expected;
    }
    if (key === "customerObjectedAt" && expected && typeof expected === "object" && "not" in expected) {
      return expected.not === null ? workOrder.customerObjectedAt !== null : true;
    }
    if (key === "handoverType") {
      return workOrder.handoverType === expected;
    }
    if (key === "adminReviewStatus") {
      return workOrder.adminReviewStatus === expected;
    }
    if (key === "reviewVersion") {
      return workOrder.reviewVersion === expected;
    }
    return true;
  });
}

function matchesHandoverEventWhere(event: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => event[key] === expected);
}

function applyAtomicUpdates(
  current: Record<string, unknown>,
  data: Record<string, unknown>
): Record<string, unknown> {
  const next = { ...data };
  const reviewVersion = data.reviewVersion;
  if (reviewVersion && typeof reviewVersion === "object" && "increment" in reviewVersion) {
    next.reviewVersion = Number(current.reviewVersion ?? 0) + Number(reviewVersion.increment);
  }
  return next;
}

function matchesReviewAttemptWhere(attempt: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "workOrderId") {
      return attempt.workOrderId === expected;
    }
    if (key === "id") {
      return attempt.id === expected;
    }
    return true;
  });
}

function sortReviewAttempts(rows: Array<Record<string, unknown>>, orderBy?: Record<string, string>) {
  const direction = orderBy?.attemptNo === "desc" ? -1 : 1;
  return [...rows].sort((left, right) => {
    const leftNo = typeof left.attemptNo === "number" ? left.attemptNo : 0;
    const rightNo = typeof right.attemptNo === "number" ? right.attemptNo : 0;
    return (leftNo - rightNo) * direction;
  });
}

function uploadFile(originalname: string, mimetype: string, size = 5) {
  return {
    buffer: Buffer.from("image"),
    mimetype,
    originalname,
    size
  };
}
