import {
  ApplicationStatus,
  BusinessType,
  ContractStatus,
  DeliveryHandoverArchiveStatus,
  DeliveryHandoverStatus,
  DeliveryStatus,
  DepositStatus,
  ESignDocumentType,
  ESignProviderActionType,
  ESignProviderType,
  ESignSignerStatus,
  ESignSignerType,
  ESignSigningStage,
  ESignSlotId,
  ESignTaskStatus,
  OrderStatus,
  ProductStatus,
  QuoteStatus,
  SalePriceStatus,
  VehicleInsurancePolicyStatus,
  VehicleInsurancePolicyType,
  VehicleStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { DELIVERY_HANDOVER_ARCHIVE_BLOCKS_DELIVERY_CONFIRMATION } from "../src/delivery-handover/delivery-handover.service";
import { OrderService } from "../src/order/order.service";

describe("vehicle delivery handover workflow", () => {
  it("rejects prepare and confirm when the contract is not signed", async () => {
    const harness = createDeliveryHarness();
    harness.state.contractStatus = ContractStatus.GENERATED;
    harness.state.delivery = buildReadyDelivery(harness);

    await expect(
      harness.service.prepareDelivery(harness.orderId, validPrepareDto(), harness.user, harness.context)
    ).rejects.toThrow("合同尚未签署");

    await expect(
      harness.service.confirmDelivery(harness.orderId, validConfirmDto(), harness.user, harness.context)
    ).rejects.toThrow("合同尚未签署");
  });

  it("rejects confirm when the vehicle is not reserved", async () => {
    const harness = createDeliveryHarness();
    harness.state.vehicleStatus = VehicleStatus.AVAILABLE;
    harness.state.delivery = buildReadyDelivery(harness);

    await expect(
      harness.service.confirmDelivery(harness.orderId, validConfirmDto(), harness.user, harness.context)
    ).rejects.toThrow("交付前车辆必须处于“签约锁定（RESERVED）”状态。");
  });

  it("rejects confirm when deposit or first monthly fee is not confirmed", async () => {
    const harness = createDeliveryHarness();
    harness.state.delivery = buildReadyDelivery(harness, { depositReceivedConfirmed: false });

    await expect(
      harness.service.confirmDelivery(harness.orderId, validConfirmDto(), harness.user, harness.context)
    ).rejects.toThrow("押金尚未确认收取");

    harness.state.delivery = buildReadyDelivery(harness, { firstMonthlyFeeReceivedConfirmed: false });

    await expect(
      harness.service.confirmDelivery(harness.orderId, validConfirmDto(), harness.user, harness.context)
    ).rejects.toThrow("首期月费尚未确认收取");
  });

  it("rejects confirm when insurance is not manually confirmed or policy coverage is expired", async () => {
    const harness = createDeliveryHarness();
    harness.state.delivery = buildReadyDelivery(harness, { insuranceValidConfirmed: false });

    await expect(
      harness.service.confirmDelivery(harness.orderId, validConfirmDto(), harness.user, harness.context)
    ).rejects.toThrow("保险人工核验尚未确认");

    harness.state.delivery = buildReadyDelivery(harness);
    harness.state.insurancePolicies = harness.state.insurancePolicies.map((policy) => ({
      ...policy,
      effectiveTo: new Date("2026-06-09T00:00:00.000Z")
    }));

    await expect(
      harness.service.confirmDelivery(harness.orderId, validConfirmDto(), harness.user, harness.context)
    ).rejects.toThrow("车辆保险未生效或已过期，不能交付。");
  });

  it("rejects confirm when the vehicle is not prepared", async () => {
    const harness = createDeliveryHarness();
    harness.state.delivery = buildReadyDelivery(harness, { vehiclePreparedConfirmed: false });

    await expect(
      harness.service.confirmDelivery(harness.orderId, validConfirmDto(), harness.user, harness.context)
    ).rejects.toThrow("车辆尚未整备");
  });

  it("rejects confirm when the Stage 2 handover record is missing", async () => {
    const harness = createDeliveryHarness();
    harness.state.delivery = buildReadyDelivery(harness);
    harness.state.handover = null;

    await expect(
      harness.service.confirmDelivery(harness.orderId, validConfirmDto(), harness.user, harness.context)
    ).rejects.toThrow("交付交接确认书尚未完成签署");

    expect(harness.state.orderStatus).toBe(OrderStatus.PENDING_PAYMENT);
    expect(harness.state.actualDeliveryAt).toBeNull();
    expect(harness.state.vehicleStatus).toBe(VehicleStatus.RESERVED);
  });

  it("rejects confirm when the Stage 2 handover is not signed", async () => {
    const harness = createDeliveryHarness();
    harness.state.delivery = buildReadyDelivery(harness);
    harness.state.handover = buildHandoverRecord(harness, {
      archiveStatus: "NOT_STARTED",
      completedAt: null,
      status: "PENDING_CUSTOMER_SIGNATURE"
    });

    await expect(
      harness.service.confirmDelivery(harness.orderId, validConfirmDto(), harness.user, harness.context)
    ).rejects.toThrow("交付交接确认书尚未完成签署");
  });

  it.each([
    {
      mutate: (handover: ReturnType<typeof buildHandoverRecord>) => {
        handover.platformSignedAt = null;
        handover.handoverESignTask.signers[1].signedAt = null;
        handover.handoverESignTask.signers[1].signerStatus =
          ESignSignerStatus.PENDING;
      },
      name: "only the customer signer is signed"
    },
    {
      mutate: (handover: ReturnType<typeof buildHandoverRecord>) => {
        handover.customerSignedAt = null;
        handover.handoverESignTask.signers[0].signedAt = null;
        handover.handoverESignTask.signers[0].signerStatus =
          ESignSignerStatus.PENDING;
      },
      name: "only the platform signer is signed"
    },
    {
      mutate: (handover: ReturnType<typeof buildHandoverRecord>) => {
        handover.handoverESignTask.signers.push({
          ...handover.handoverESignTask.signers[1],
          id: "stage2-extra-signer"
        });
      },
      name: "an extra signer row exists"
    },
    {
      mutate: (handover: ReturnType<typeof buildHandoverRecord>) => {
        handover.handoverESignTask.signers[1].deletedAt =
          new Date("2026-06-09T04:30:00.000Z");
      },
      name: "a required signer row is deleted"
    }
  ])("rejects confirm when $name", async ({ mutate }) => {
    const harness = createDeliveryHarness();
    harness.state.delivery = buildReadyDelivery(harness);
    const handover = buildHandoverRecord(harness);
    mutate(handover);
    harness.state.handover = handover;

    await expect(
      harness.service.confirmDelivery(
        harness.orderId,
        validConfirmDto(),
        harness.user,
        harness.context
      )
    ).rejects.toThrow();

    expectNoDeliveryConfirmationSideEffects(harness);
  });

  it.each([
    {
      mutate: (handover: ReturnType<typeof buildHandoverRecord>) => {
        handover.handoverESignTask.requestSnapshot.sourcePdfHash =
          "d".repeat(64);
      },
      name: "source hash"
    },
    {
      mutate: (handover: ReturnType<typeof buildHandoverRecord>) => {
        handover.handoverESignTask.requestSnapshot.manifestHash =
          "e".repeat(64);
      },
      name: "manifest"
    },
    {
      mutate: (handover: ReturnType<typeof buildHandoverRecord>) => {
        handover.handoverESignTask.contractId = "contract-stage2-other";
      },
      name: "contract pointer"
    },
    {
      mutate: (handover: ReturnType<typeof buildHandoverRecord>) => {
        handover.handoverESignTask.signedDocumentObjectKey =
          "contracts/handover-1/other-signed.pdf";
      },
      name: "signed provider artifact"
    }
  ])("rejects confirm when Stage 2 $name identity mismatches", async ({ mutate }) => {
    const harness = createDeliveryHarness();
    harness.state.delivery = buildReadyDelivery(harness);
    const handover = buildHandoverRecord(harness);
    mutate(handover);
    harness.state.handover = handover;

    await expect(
      harness.service.confirmDelivery(
        harness.orderId,
        validConfirmDto(),
        harness.user,
        harness.context
      )
    ).rejects.toThrow();

    expectNoDeliveryConfirmationSideEffects(harness);
  });

  it("blocks a signed shell when the required signed artifact is missing", async () => {
    const harness = createDeliveryHarness();
    harness.state.delivery = buildReadyDelivery(harness);
    harness.state.handover = buildHandoverRecord(harness, {
      archiveStatus: DeliveryHandoverArchiveStatus.FAILED,
      archivedAt: null,
      signedDocumentFileId: null,
      signedObjectKey: null,
      signedPdfHash: null,
      status: DeliveryHandoverStatus.SIGNED
    });

    await expect(
      harness.service.confirmDelivery(
        harness.orderId,
        validConfirmDto(),
        harness.user,
        harness.context
      )
    ).rejects.toThrow();

    expectNoDeliveryConfirmationSideEffects(harness);
  });

  it.each([
    {
      mutate: (harness: ReturnType<typeof createDeliveryHarness>) => {
        harness.state.fileObjects = harness.state.fileObjects.filter(
          (file) => file.id !== "source-file-1"
        );
      },
      name: "source PDF FileObject is missing"
    },
    {
      mutate: (harness: ReturnType<typeof createDeliveryHarness>) => {
        harness.state.fileObjects = harness.state.fileObjects.filter(
          (file) => file.id !== "signed-file-1"
        );
      },
      name: "signed PDF FileObject is missing"
    },
    {
      mutate: (harness: ReturnType<typeof createDeliveryHarness>) => {
        const signedFile = harness.state.fileObjects.find(
          (file) => file.id === "signed-file-1"
        );
        if (signedFile) {
          signedFile.objectKey = "contracts/handover-1/wrong-signed.pdf";
        }
      },
      name: "signed PDF object identity mismatches"
    }
  ])("rejects confirm when the $name", async ({ mutate }) => {
    const harness = createDeliveryHarness();
    harness.state.delivery = buildReadyDelivery(harness);
    harness.state.handover = buildHandoverRecord(harness);
    mutate(harness);

    await expect(
      harness.service.confirmDelivery(
        harness.orderId,
        validConfirmDto(),
        harness.user,
        harness.context
      )
    ).rejects.toThrow();

    expectNoDeliveryConfirmationSideEffects(harness);
  });

  it("keeps archive failure non-blocking only when the signed artifact is complete", async () => {
    const harness = createDeliveryHarness();
    harness.state.delivery = buildReadyDelivery(harness);
    harness.state.handover = buildHandoverRecord(harness, {
      archiveStatus: DeliveryHandoverArchiveStatus.FAILED,
      archivedAt: null,
      failureReason: "temporary provider filing timeout",
      status: DeliveryHandoverStatus.SIGNED
    });

    const check = (await harness.service.getDeliveryCheck(harness.orderId, harness.user)) as {
      canConfirmDelivery: boolean;
      handoverArchiveWarning: string | null;
      handoverArchived: boolean;
      handoverReady: boolean;
    };

    expect(DELIVERY_HANDOVER_ARCHIVE_BLOCKS_DELIVERY_CONFIRMATION).toBe(false);
    expect(check.handoverReady).toBe(true);
    expect(check.handoverArchived).toBe(false);
    expect(check.handoverArchiveWarning).toContain(
      "temporary provider filing timeout"
    );
    expect(check.canConfirmDelivery).toBe(true);

    await expect(
      harness.service.confirmDelivery(harness.orderId, validConfirmDto(), harness.user, harness.context)
    ).resolves.toMatchObject({ deliveryStatus: DeliveryStatus.DELIVERED });
  });

  it("does not confirm delivery merely because the complete Stage 2 state exists", async () => {
    const harness = createDeliveryHarness();
    harness.state.delivery = buildReadyDelivery(harness);
    harness.state.handover = buildHandoverRecord(harness);

    const check = (await harness.service.getDeliveryCheck(
      harness.orderId,
      harness.user
    )) as { canConfirmDelivery: boolean };

    expect(check.canConfirmDelivery).toBe(true);
    expect(harness.state.actualDeliveryAt).toBeNull();
    expect(harness.state.orderStatus).not.toBe(OrderStatus.ACTIVE);
    expect(harness.state.vehicleStatus).toBe(VehicleStatus.RESERVED);
    expect(harness.tx.vehicleDelivery.update).not.toHaveBeenCalled();
    expect(harness.tx.subscriptionOrder.update).not.toHaveBeenCalled();
    expect(harness.tx.vehicle.update).not.toHaveBeenCalled();
  });

  it.each([
    {
      mutate: (harness: ReturnType<typeof createDeliveryHarness>) => {
        const handover = harness.state.handover as ReturnType<
          typeof buildHandoverRecord
        >;
        handover.handoverESignTask.signers[0].signerStatus =
          ESignSignerStatus.REJECTED;
        handover.handoverESignTask.signers[0].signedAt = null;
      },
      name: "customer signer"
    },
    {
      mutate: (harness: ReturnType<typeof createDeliveryHarness>) => {
        const handover = harness.state.handover as ReturnType<
          typeof buildHandoverRecord
        >;
        handover.sourceObjectKey =
          "contracts/handover-1/replaced-source.pdf";
      },
      name: "source artifact identity"
    },
    {
      mutate: (harness: ReturnType<typeof createDeliveryHarness>) => {
        harness.state.workOrderObjected = true;
      },
      name: "customer objection"
    },
    {
      mutate: (harness: ReturnType<typeof createDeliveryHarness>) => {
        harness.state.evidenceReadiness = buildEvidenceReadiness(harness, {
          blockingReasons: ["Current delivery evidence is no longer ready."],
          ready: false
        });
      },
      name: "delivery evidence"
    }
  ])(
    "rechecks the current $name inside the delivery transaction",
    async ({ mutate }) => {
      const harness = createDeliveryHarness();
      harness.state.delivery = buildReadyDelivery(harness);
      harness.state.beforeTransaction = async () => mutate(harness);

      await expect(
        harness.service.confirmDelivery(
          harness.orderId,
          validConfirmDto(),
          harness.user,
          harness.context
        )
      ).rejects.toThrow();

      expect(harness.tx.subscriptionOrder.findUnique).toHaveBeenCalled();
      expect(harness.tx.vehicleDelivery.findUnique).toHaveBeenCalled();
      expect(harness.tx.vehicleDeliveryHandover.findFirst).toHaveBeenCalled();
      expect(
        harness.deliveryEvidenceService
          .validateEvidenceReadyForDeliveryConfirmation
      ).toHaveBeenLastCalledWith(
        harness.orderId,
        "handover-1",
        undefined,
        harness.tx
      );
      expect(
        harness.handoverWorkOrderService.assertReadyForStage2ESign
      ).toHaveBeenLastCalledWith(
        harness.orderId,
        "handover-1",
        harness.tx
      );
      expect(harness.prisma.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        { isolationLevel: "ReadCommitted" }
      );
      expectNoDeliveryConfirmationSideEffects(harness);
    }
  );

  it.each([
    {
      childLock: "contract_esign_signer",
      expectedLockedRows: 3,
      insert: (harness: ReturnType<typeof createDeliveryHarness>) => {
        const handover = harness.state.handover as ReturnType<
          typeof buildHandoverRecord
        >;
        handover.handoverESignTask.signers.push({
          ...buildStage2DeliverySigner("PLATFORM"),
          id: "stage2-concurrent-extra-signer"
        });
      },
      name: "third signer"
    },
    {
      childLock: "vehicle_delivery_evidence_file",
      expectedLockedRows: 1,
      insert: (harness: ReturnType<typeof createDeliveryHarness>) => {
        harness.state.evidenceFileIds.push(
          "concurrent-evidence-file"
        );
        harness.state.currentEvidenceManifestHash = "d".repeat(64);
      },
      name: "evidence file"
    }
  ])(
    "sees and blocks a committed child-only $name insert between the first and parent locks",
    async ({ childLock, expectedLockedRows, insert }) => {
      const harness = createDeliveryHarness();
      harness.state.delivery = buildReadyDelivery(harness);
      harness.state.afterFirstGateParentLock = async () => {
        expect(harness.state.gateLockOrder).toEqual([
          "subscription_order"
        ]);
        insert(harness);
      };

      await expect(
        harness.service.confirmDelivery(
          harness.orderId,
          validConfirmDto(),
          harness.user,
          harness.context
        )
      ).rejects.toThrow();

      expect(
        harness.state.gateLockRowCounts.get(childLock)
      ).toBe(expectedLockedRows);
      expect(harness.prisma.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        { isolationLevel: "ReadCommitted" }
      );
      expectNoDeliveryConfirmationSideEffects(harness);
    }
  );

  it("holds every mutable delivery gate row across gate reads and the first delivery write", async () => {
    const harness = createDeliveryHarness();
    harness.state.delivery = buildReadyDelivery(harness);
    const committedRevocations: string[] = [];
    const blockedRevocations: string[] = [];
    const attempts = [
      {
        lock: "contract_esign_signer",
        mutate: () => {
          const handover = harness.state.handover as ReturnType<
            typeof buildHandoverRecord
          >;
          handover.handoverESignTask.signers[0].signerStatus =
            ESignSignerStatus.REJECTED;
        },
        name: "signer"
      },
      {
        lock: "vehicle_handover_work_order",
        mutate: () => {
          harness.state.workOrderObjected = true;
        },
        name: "work-order objection"
      },
      {
        lock: "vehicle_delivery_evidence_item",
        mutate: () => {
          harness.state.evidenceReadiness = buildEvidenceReadiness(harness, {
            blockingReasons: ["Concurrent evidence revocation committed."],
            ready: false
          });
        },
        name: "evidence parent"
      },
      {
        lock: "file_object",
        mutate: () => {
          const sourceFile = harness.state.fileObjects.find(
            (file) => file.id === "source-file-1"
          );
          if (sourceFile) {
            sourceFile.objectKey =
              "contracts/handover-1/concurrent-source.pdf";
          }
        },
        name: "source FileObject"
      }
    ];
    harness.state.beforeFirstDeliveryWrite = async () => {
      expect(harness.tx.subscriptionOrder.findUnique).toHaveBeenCalled();
      expect(harness.tx.vehicleDelivery.findUnique).toHaveBeenCalled();
      expect(harness.tx.vehicleDeliveryHandover.findFirst).toHaveBeenCalled();
      expect(
        harness.deliveryEvidenceService
          .validateEvidenceReadyForDeliveryConfirmation
      ).toHaveBeenLastCalledWith(
        harness.orderId,
        "handover-1",
        undefined,
        harness.tx
      );
      expect(
        harness.handoverWorkOrderService.assertDeliveryCanBeConfirmed
      ).toHaveBeenLastCalledWith(
        harness.orderId,
        "handover-1",
        harness.tx
      );
      for (const attempt of attempts) {
        if (harness.state.activeGateLocks.has(attempt.lock)) {
          blockedRevocations.push(attempt.name);
        } else {
          attempt.mutate();
          committedRevocations.push(attempt.name);
        }
      }
    };

    await expect(
      harness.service.confirmDelivery(
        harness.orderId,
        validConfirmDto(),
        harness.user,
        harness.context
      )
    ).resolves.toMatchObject({
      deliveryStatus: DeliveryStatus.DELIVERED
    });

    expect(committedRevocations).toEqual([]);
    expect(blockedRevocations).toEqual(attempts.map((attempt) => attempt.name));
    expect(harness.state.gateLockOrder).toEqual([
      "subscription_order",
      "vehicle",
      "vehicle_insurance_policy",
      "vehicle_delivery",
      "order_change",
      "contract",
      "contract_esign_task",
      "contract_esign_signer",
      "vehicle_delivery_handover",
      "vehicle_handover_work_order",
      "vehicle_handover_review_attempt",
      "vehicle_delivery_evidence_item",
      "vehicle_delivery_evidence_file",
      "file_object"
    ]);
  });

  it("rejects confirm when required delivery evidence is not approved", async () => {
    const harness = createDeliveryHarness();
    harness.state.delivery = buildReadyDelivery(harness);
    harness.state.evidenceReadiness = buildEvidenceReadiness(harness, {
      blockingReasons: ["客户与车辆正面合影 尚未上传。"],
      ready: false
    });

    await expect(
      harness.service.confirmDelivery(harness.orderId, validConfirmDto(), harness.user, harness.context)
    ).rejects.toThrow("客户与车辆正面合影 尚未上传");
  });

  it("prepare-delivery creates a READY delivery record", async () => {
    const harness = createDeliveryHarness();

    const delivery = (await harness.service.prepareDelivery(
      harness.orderId,
      validPrepareDto({ deliveryLocation: "静安旺旺大厦" }),
      harness.user,
      harness.context
    )) as { deliveryLocation: string; deliveryStatus: DeliveryStatus };

    expect(delivery.deliveryStatus).toBe(DeliveryStatus.READY);
    expect(delivery.deliveryLocation).toBe("静安旺旺大厦");
    expect(harness.state.orderStatus).toBe(OrderStatus.PENDING_DELIVERY);
    expect(harness.tx.vehicleDelivery.create).toHaveBeenCalledTimes(1);
  });

  it("blocks delivery when commercial insurance does not cover the delivery date", async () => {
    const harness = createDeliveryHarness();
    harness.state.insurancePolicies = [
      buildInsurancePolicy(harness, {
        policyType: VehicleInsurancePolicyType.COMPULSORY_TRAFFIC
      })
    ];

    const initialCheck = (await harness.service.getDeliveryCheck(harness.orderId, harness.user)) as {
      blockingReasons: string[];
      canPrepareDelivery: boolean;
      insuranceCoverage: {
        commercialCovered: boolean;
        compulsoryTrafficCovered: boolean;
      };
      insuranceValid: boolean;
    };

    expect(initialCheck.canPrepareDelivery).toBe(false);
    expect(initialCheck.insuranceValid).toBe(false);
    expect(initialCheck.insuranceCoverage).toMatchObject({
      commercialCovered: false,
      compulsoryTrafficCovered: true
    });
    expect(initialCheck.blockingReasons).toContain("商业险未覆盖计划交付日");

    await expect(
      harness.service.prepareDelivery(harness.orderId, validPrepareDto(), harness.user, harness.context)
    ).rejects.toThrow("商业险未覆盖计划交付日");
  });

  it("blocks delivery when compulsory insurance does not cover the delivery date", async () => {
    const harness = createDeliveryHarness();
    harness.state.insurancePolicies = [
      buildInsurancePolicy(harness, {
        policyType: VehicleInsurancePolicyType.COMMERCIAL
      })
    ];

    const check = (await harness.service.getDeliveryCheck(harness.orderId, harness.user)) as {
      blockingReasons: string[];
      canPrepareDelivery: boolean;
      insuranceCoverage: {
        commercialCovered: boolean;
        compulsoryTrafficCovered: boolean;
      };
      insuranceValid: boolean;
    };

    expect(check.insuranceValid).toBe(false);
    expect(check.canPrepareDelivery).toBe(false);
    expect(check.insuranceCoverage).toMatchObject({
      commercialCovered: true,
      compulsoryTrafficCovered: false
    });
    expect(check.blockingReasons).toContain("交强险未覆盖计划交付日");
  });

  it("accepts active compulsory and commercial policies covering the delivery date", async () => {
    const harness = createDeliveryHarness();

    const check = (await harness.service.getDeliveryCheck(harness.orderId, harness.user)) as {
      canPrepareDelivery: boolean;
      insuranceCoverage: {
        commercialCovered: boolean;
        compulsoryTrafficCovered: boolean;
        evaluatedAt: Date;
      };
      insuranceValid: boolean;
    };

    expect(check.insuranceValid).toBe(true);
    expect(check.canPrepareDelivery).toBe(true);
    expect(check.insuranceCoverage).toMatchObject({
      commercialCovered: true,
      compulsoryTrafficCovered: true,
      evaluatedAt: new Date("2026-06-06T08:00:00.000Z")
    });
  });

  it("does not count a NOT_EFFECTIVE policy toward delivery coverage", async () => {
    const harness = createDeliveryHarness();
    harness.state.insurancePolicies = harness.state.insurancePolicies.map((policy) =>
      policy.policyType === VehicleInsurancePolicyType.COMMERCIAL
        ? { ...policy, policyStatus: VehicleInsurancePolicyStatus.NOT_EFFECTIVE }
        : policy
    );

    const check = (await harness.service.getDeliveryCheck(harness.orderId, harness.user)) as {
      blockingReasons: string[];
      insuranceCoverage: {
        commercialCovered: boolean;
        compulsoryTrafficCovered: boolean;
      };
      insuranceValid: boolean;
    };

    expect(check.insuranceValid).toBe(false);
    expect(check.insuranceCoverage).toMatchObject({
      commercialCovered: false,
      compulsoryTrafficCovered: true
    });
    expect(check.blockingReasons).toContain("商业险未覆盖计划交付日");
  });

  it("treats zero required deposit as automatically satisfied for delivery readiness", async () => {
    const harness = createDeliveryHarness();
    harness.state.depositAmount = 0n;
    harness.state.depositStatus = DepositStatus.PENDING_CONFIRM;
    harness.state.finalDepositAmount = 0n;

    const check = (await harness.service.getDeliveryCheck(harness.orderId, harness.user)) as {
      blockingReasons: string[];
      depositReceivedConfirmed: boolean;
    };

    expect(check.depositReceivedConfirmed).toBe(true);
    expect(check.blockingReasons.some((reason) => reason.includes("押金"))).toBe(false);

    const delivery = (await harness.service.prepareDelivery(
      harness.orderId,
      validPrepareDto({ depositReceivedConfirmed: false }),
      harness.user,
      harness.context
    )) as { depositReceivedConfirmed: boolean };

    expect(delivery.depositReceivedConfirmed).toBe(true);
  });

  it("prepare-delivery updates the existing delivery record instead of creating another one", async () => {
    const harness = createDeliveryHarness();

    await harness.service.prepareDelivery(
      harness.orderId,
      validPrepareDto({ deliveryLocation: "静安旺旺大厦" }),
      harness.user,
      harness.context
    );
    await harness.service.prepareDelivery(
      harness.orderId,
      validPrepareDto({ deliveryLocation: "徐汇交付中心", remark: "改约" }),
      harness.user,
      harness.context
    );

    expect(harness.tx.vehicleDelivery.create).toHaveBeenCalledTimes(1);
    expect(harness.tx.vehicleDelivery.update).toHaveBeenCalledTimes(1);
    expect(harness.state.delivery?.deliveryLocation).toBe("徐汇交付中心");
    expect(harness.state.delivery?.remark).toBe("改约");
  });

  it("confirm-delivery completes delivery, activates the order, leases the vehicle, and writes audit logs", async () => {
    const harness = createDeliveryHarness();
    harness.state.delivery = buildReadyDelivery(harness);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T04:00:00.000Z"));

    let delivery!: {
      deliveredAt: string;
      deliveryStatus: DeliveryStatus;
      handoverMileageKm: number;
    };
    try {
      delivery = (await harness.service.confirmDelivery(
        harness.orderId,
        validConfirmDto(),
        harness.user,
        harness.context
      )) as typeof delivery;
    } finally {
      vi.useRealTimers();
    }

    expect(delivery.deliveryStatus).toBe(DeliveryStatus.DELIVERED);
    expect(delivery.handoverMileageKm).toBe(28500);
    expect(delivery.deliveredAt).toBe("2026-06-10T04:00:00.000Z");
    expect(harness.state.orderStatus).toBe(OrderStatus.ACTIVE);
    expect(harness.state.actualDeliveryAt?.toISOString()).toBe("2026-06-10T04:00:00.000Z");
    expect(harness.state.vehicleStatus).toBe(VehicleStatus.LEASED);

    const auditEntityTypes = harness.auditService.write.mock.calls.map(([entry]) => entry.entityType);
    expect(auditEntityTypes).toEqual(expect.arrayContaining(["subscription_order", "vehicle_delivery", "vehicle"]));
  });

  it("rejects repeated confirm-delivery", async () => {
    const harness = createDeliveryHarness();
    harness.state.delivery = buildReadyDelivery(harness);

    await harness.service.confirmDelivery(harness.orderId, validConfirmDto(), harness.user, harness.context);

    await expect(
      harness.service.confirmDelivery(harness.orderId, validConfirmDto(), harness.user, harness.context)
    ).rejects.toThrow("该订单已完成交付，不能重复确认。");
  });

  it("delivery-check treats delivered orders as completed instead of pre-delivery blocked", async () => {
    const harness = createDeliveryHarness();
    harness.state.actualDeliveryAt = new Date("2026-06-10T03:00:00.000Z");
    harness.state.orderStatus = OrderStatus.ACTIVE;
    harness.state.vehicleStatus = VehicleStatus.LEASED;
    harness.state.delivery = buildReadyDelivery(harness, {
      deliveredAt: new Date("2026-06-10T03:00:00.000Z"),
      deliveryStatus: DeliveryStatus.DELIVERED,
      handoverMileageKm: 28500
    });

    const check = (await harness.service.getDeliveryCheck(harness.orderId, harness.user)) as {
      alreadyDelivered: boolean;
      blockingReasons: string[];
      canConfirmDelivery: boolean;
      canPrepareDelivery: boolean;
      deliveryStatus: DeliveryStatus;
      vehicleStatus: VehicleStatus;
    };

    expect(check.alreadyDelivered).toBe(true);
    expect(check.deliveryStatus).toBe(DeliveryStatus.DELIVERED);
    expect(check.vehicleStatus).toBe(VehicleStatus.LEASED);
    expect(check.canPrepareDelivery).toBe(false);
    expect(check.canConfirmDelivery).toBe(false);
    expect(check.blockingReasons).toEqual([]);
  });

  it("delivery-check still returns normal blockers when delivery has not been prepared", async () => {
    const harness = createDeliveryHarness();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));

    try {
      const check = (await harness.service.getDeliveryCheck(harness.orderId, harness.user)) as {
        alreadyDelivered: boolean;
        blockingReasons: string[];
        canConfirmDelivery: boolean;
        canPrepareDelivery: boolean;
        deliveryStatus: DeliveryStatus | null;
      };

      expect(check.alreadyDelivered).toBe(false);
      expect(check.deliveryStatus).toBeNull();
      expect(check.canPrepareDelivery).toBe(true);
      expect(check.canConfirmDelivery).toBe(false);
      expect(check.blockingReasons).toEqual(expect.arrayContaining(["请先准备交付", "押金尚未确认收取"]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivery-check keeps READY orders confirmable", async () => {
    const harness = createDeliveryHarness();
    harness.state.delivery = buildReadyDelivery(harness);

    const check = (await harness.service.getDeliveryCheck(harness.orderId, harness.user)) as {
      alreadyDelivered: boolean;
      blockingReasons: string[];
      canConfirmDelivery: boolean;
      deliveryStatus: DeliveryStatus;
    };

    expect(check.alreadyDelivered).toBe(false);
    expect(check.deliveryStatus).toBe(DeliveryStatus.READY);
    expect(check.canConfirmDelivery).toBe(true);
    expect(check.blockingReasons).toEqual([]);
  });
});

function validPrepareDto(overrides: Record<string, unknown> = {}) {
  return {
    customerIdentityConfirmed: true,
    deliveryLocation: "静安旺旺大厦",
    depositReceivedConfirmed: true,
    firstMonthlyFeeReceivedConfirmed: true,
    handoverDocumentsConfirmed: true,
    insuranceValidConfirmed: true,
    remark: "线下交付预约",
    scheduledAt: "2026-06-10T10:00:00+08:00",
    vehiclePhotosConfirmed: true,
    vehiclePreparedConfirmed: true,
    ...overrides
  };
}

function validConfirmDto() {
  return {
    deliveredAt: "2026-06-10T11:00:00+08:00",
    handoverMileageKm: 28500,
    remark: "客户已签收"
  };
}

function createDeliveryHarness() {
  const now = new Date("2026-06-06T08:00:00.000Z");
  const orderId = "order-1";
  const vehicleId = "vehicle-1";
  const customerId = "customer-1";
  const user = {
    id: "user-1",
    menus: [],
    name: "Admin",
    permissions: [],
    roles: ["ADMIN"],
    username: "admin"
  };
  const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };
  const state: {
    activeGateLocks: Set<string>;
    actualDeliveryAt: Date | null;
    afterFirstGateParentLock: null | (() => Promise<void> | void);
    beforeTransaction: null | (() => Promise<void> | void);
    beforeFirstDeliveryWrite: null | (() => Promise<void> | void);
    contractStatus: ContractStatus;
    currentEvidenceManifestHash: string;
    delivery: Record<string, unknown> | null;
    depositAmount: bigint;
    depositStatus: DepositStatus;
    evidenceReadiness: ReturnType<typeof buildEvidenceReadiness>;
    evidenceFileIds: string[];
    fileObjects: Array<Record<string, unknown>>;
    finalDepositAmount: bigint | null;
    insurancePolicies: Array<Record<string, unknown>>;
    orderStatus: OrderStatus;
    vehicleStatus: VehicleStatus;
    handover: Record<string, unknown> | null;
    gateLockOrder: string[];
    gateLockRowCounts: Map<string, number>;
    transactionGateSnapshot: null | {
      currentEvidenceManifestHash: string;
      evidenceFileIds: string[];
      evidenceReadiness: ReturnType<typeof buildEvidenceReadiness>;
      fileObjects: Array<Record<string, unknown>>;
      handover: Record<string, unknown> | null;
      workOrderObjected: boolean;
    };
    transactionIsolationLevel: null | string;
    workOrderObjected: boolean;
  } = {
    activeGateLocks: new Set(),
    actualDeliveryAt: null,
    afterFirstGateParentLock: null,
    beforeTransaction: null,
    beforeFirstDeliveryWrite: null,
    contractStatus: ContractStatus.SIGNED,
    currentEvidenceManifestHash: "a".repeat(64),
    delivery: null,
    depositAmount: 500000n,
    depositStatus: DepositStatus.CONFIRMED,
    evidenceReadiness: buildEvidenceReadiness({ orderId }),
    evidenceFileIds: [],
    fileObjects: [
      {
        id: "source-file-1",
        mimeType: "application/pdf",
        objectKey: "contracts/handover-1/source.pdf",
        sizeBytes: 1024n
      },
      {
        id: "signed-file-1",
        mimeType: "application/pdf",
        objectKey: "contracts/handover-1/signed.pdf",
        sizeBytes: 2048n
      }
    ],
    finalDepositAmount: 500000n,
    gateLockOrder: [],
    gateLockRowCounts: new Map(),
    handover: null,
    insurancePolicies: [
      {
        deletedAt: null,
        effectiveFrom: new Date("2026-06-01T00:00:00.000Z"),
        effectiveTo: new Date("2030-12-31T00:00:00.000Z"),
        id: "policy-compulsory",
        policyStatus: VehicleInsurancePolicyStatus.ACTIVE,
        policyType: VehicleInsurancePolicyType.COMPULSORY_TRAFFIC
      },
      {
        deletedAt: null,
        effectiveFrom: new Date("2026-06-01T00:00:00.000Z"),
        effectiveTo: new Date("2030-12-31T00:00:00.000Z"),
        id: "policy-commercial",
        policyStatus: VehicleInsurancePolicyStatus.ACTIVE,
        policyType: VehicleInsurancePolicyType.COMMERCIAL
      }
    ],
    orderStatus: OrderStatus.PENDING_PAYMENT,
    transactionGateSnapshot: null,
    transactionIsolationLevel: null,
    vehicleStatus: VehicleStatus.RESERVED,
    workOrderObjected: false
  };
  state.handover = buildHandoverRecord({ orderId, user });

  function buildVehicle() {
    return {
      brand: "NIO",
      createdAt: now,
      currentSalePriceAmount: 10000000n,
      deletedAt: null,
      id: vehicleId,
      insurancePolicies: state.insurancePolicies,
      model: "ET5",
      purchasePriceAmount: 12000000n,
      salePriceStatus: SalePriceStatus.EFFECTIVE,
      status: state.vehicleStatus,
      updatedAt: now,
      vehicleNo: "VEH2026060600001",
      vin: "VIN202606060000001"
    };
  }

  function buildContract() {
    return {
      archivedAt: null,
      businessType: BusinessType.SUBSCRIPTION,
      contractNo: "CON2026060600001",
      contractSnapshot: {},
      contractTitle: "订阅合同",
      contractVersionId: "contract-version-1",
      createdAt: now,
      customerId,
      deletedAt: null,
      fileId: null,
      id: "contract-1",
      orderId,
      signedAt: state.contractStatus === ContractStatus.SIGNED ? new Date("2026-06-09T02:00:00.000Z") : null,
      status: state.contractStatus,
      updatedAt: now
    };
  }

  function buildOrder() {
    const contract = buildContract();
    return {
      actualDeliveryAt: state.actualDeliveryAt,
      application: {
        applicationNo: "APP202606060001",
        id: "application-1",
        salesUserId: user.id,
        status: ApplicationStatus.APPROVED
      },
      applicationId: "application-1",
      businessType: BusinessType.SUBSCRIPTION,
      changes: [],
      contract,
      contractId: contract.id,
      contracts: [contract],
      createdAt: now,
      createdBy: user.id,
      customer: { grade: "A", id: customerId, mobile: "13800000000", name: "测试客户" },
      customerId,
      deletedAt: null,
      depositAmount: state.depositAmount,
      depositStatus: state.depositStatus,
      endDate: null,
      energyLimitCount: null,
      energyLimitKwh: null,
      finalDepositAmount: state.finalDepositAmount,
      id: orderId,
      mileageLimitKm: 1500,
      monthlyFeeAmount: 300000n,
      orderNo: "ORD2026060600001",
      orderSource: "SALES_ASSISTED",
      orderStatus: state.orderStatus,
      overMileageFeeAmount: 100n,
      periodMonths: 12,
      productId: "product-1",
      productVersion: {
        product: { productType: BusinessType.SUBSCRIPTION, status: ProductStatus.ACTIVE }
      },
      productVersionId: "product-version-1",
      quote: { id: "quote-1", quoteNo: "QUO2026060600001", status: QuoteStatus.CONFIRMED },
      quoteId: "quote-1",
      quoteSnapshot: {},
      riskResult: null,
      riskResultId: null,
      startDate: null,
      updatedAt: now,
      updatedBy: user.id,
      vehicle: buildVehicle(),
      vehicleId,
      vehicleModel: "ET5",
      vehiclePurchasePriceAmount: 10000000n
    };
  }

  function buildDelivery() {
    return state.delivery ? { ...state.delivery, customer: { id: customerId, mobile: "13800000000", name: "测试客户" }, vehicle: buildVehicle() } : null;
  }

  function readTransactionGateState() {
    return state.transactionIsolationLevel === "Serializable" &&
      state.transactionGateSnapshot
      ? state.transactionGateSnapshot
      : state;
  }

  const tx = {
    $queryRaw: vi.fn(async (query: unknown) => {
      const text = readPrismaSqlText(query);
      const marker =
        /delivery-gate-lock:([a-z_]+)/.exec(text)?.[1] ?? null;
      if (
        !state.transactionGateSnapshot &&
        state.transactionIsolationLevel === "Serializable"
      ) {
        state.transactionGateSnapshot = structuredClone({
          currentEvidenceManifestHash:
            state.currentEvidenceManifestHash,
          evidenceFileIds: state.evidenceFileIds,
          evidenceReadiness: state.evidenceReadiness,
          fileObjects: state.fileObjects,
          handover: state.handover,
          workOrderObjected: state.workOrderObjected
        });
      }
      if (
        marker &&
        text.includes(`"${marker}"`) &&
        /\bFOR\s+UPDATE\b/i.test(text)
      ) {
        state.activeGateLocks.add(marker);
        state.gateLockOrder.push(marker);
      }
      if (marker === "contract_esign_signer") {
        const handover = readTransactionGateState()
          .handover as ReturnType<typeof buildHandoverRecord> | null;
        state.gateLockRowCounts.set(
          marker,
          handover?.handoverESignTask.signers.length ?? 0
        );
      }
      if (marker === "vehicle_delivery_evidence_file") {
        state.gateLockRowCounts.set(
          marker,
          readTransactionGateState().evidenceFileIds.length
        );
      }
      if (marker === "subscription_order") {
        const afterFirstGateParentLock =
          state.afterFirstGateParentLock;
        state.afterFirstGateParentLock = null;
        await afterFirstGateParentLock?.();
      }
      return [];
    }),
    fileObject: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string } }) =>
        readTransactionGateState().fileObjects.find(
          (file) => file.id === where.id
        ) ?? null
      )
    },
    subscriptionOrder: {
      count: vi.fn(async () => 0),
      findUnique: vi.fn(async () => buildOrder()),
      update: vi.fn(async ({ data }) => {
        applyDefined(state, {
          actualDeliveryAt: data.actualDeliveryAt,
          orderStatus: data.orderStatus
        });
        return buildOrder();
      })
    },
    vehicle: {
      findUnique: vi.fn(async () => buildVehicle()),
      update: vi.fn(async ({ data }) => {
        applyDefined(state, { vehicleStatus: data.status });
        return buildVehicle();
      })
    },
    vehicleDelivery: {
      create: vi.fn(async ({ data }) => {
        state.delivery = {
          ...data,
          createdAt: now,
          deletedAt: null,
          deliveredAt: null,
          handoverMileageKm: null,
          id: "delivery-1",
          updatedAt: now
        };
        return buildDelivery();
      }),
      findUnique: vi.fn(async () => buildDelivery()),
      update: vi.fn(async ({ data }) => {
        if (!state.delivery) {
          throw new Error("Delivery not found");
        }
        const beforeFirstDeliveryWrite = state.beforeFirstDeliveryWrite;
        state.beforeFirstDeliveryWrite = null;
        await beforeFirstDeliveryWrite?.();
        applyDefined(state.delivery, data);
        state.delivery.updatedAt = now;
        return buildDelivery();
      })
    },
    vehicleDeliveryHandover: {
      findFirst: vi.fn(
        async () => readTransactionGateState().handover
      )
    }
  };

  const prisma = {
    $transaction: vi.fn(async (
      callback,
      options?: { isolationLevel?: string }
    ) => {
      state.transactionGateSnapshot = null;
      state.transactionIsolationLevel =
        options?.isolationLevel ?? null;
      await state.beforeTransaction?.();
      return callback(tx);
    }),
    fileObject: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string } }) =>
        state.fileObjects.find((file) => file.id === where.id) ?? null
      )
    },
    subscriptionOrder: {
      findUnique: vi.fn(async () => buildOrder())
    },
    vehicleDeliveryHandover: {
      findFirst: vi.fn(async () => state.handover)
    },
    vehicleDelivery: {
      findUnique: vi.fn(async () => buildDelivery())
    }
  };
  const auditService = {
    write: vi.fn(async (entry: Record<string, unknown>) => {
      void entry;
    })
  };
  const deliveryEvidenceService = {
    validateEvidenceReadyForDeliveryConfirmation: vi.fn(
      async (
        _orderId: string,
        _handoverId?: string | null,
        _fieldState?: unknown,
        db?: unknown
      ) => db === tx
        ? readTransactionGateState().evidenceReadiness
        : state.evidenceReadiness
    )
  };
  const handoverWorkOrderService = {
    assertDeliveryCanBeConfirmed: vi.fn(async (
      _orderId: string,
      _handoverId?: string | null,
      db?: unknown
    ) => {
      const gateState = db === tx
        ? readTransactionGateState()
        : state;
      const handover = gateState.handover as ReturnType<
        typeof buildHandoverRecord
      > | null;
      if (gateState.workOrderObjected) {
        throw new Error("The customer has an active handover objection.");
      }
      if (
        handover?.manifestHash !==
        gateState.currentEvidenceManifestHash
      ) {
        throw new Error(
          "Current evidence does not match the signed source manifest."
        );
      }
    }),
    assertReadyForStage2ESign: vi.fn(async (
      _orderId: string,
      _handoverId?: string | null,
      db?: unknown
    ) => {
      const gateState = db === tx
        ? readTransactionGateState()
        : state;
      const handover = gateState.handover as ReturnType<
        typeof buildHandoverRecord
      > | null;
      if (gateState.workOrderObjected) {
        throw new Error("The customer has an active handover objection.");
      }
      if (
        handover?.manifestHash !==
        gateState.currentEvidenceManifestHash
      ) {
        throw new Error(
          "Current evidence does not match the signed source manifest."
        );
      }
    })
  };
  const service = new OrderService(
    auditService as never,
    prisma as never,
    undefined,
    undefined,
    undefined,
    deliveryEvidenceService as never,
    handoverWorkOrderService as never
  );

  return {
    auditService,
    context,
    customerId,
    deliveryEvidenceService,
    handoverWorkOrderService,
    orderId,
    prisma,
    service,
    state,
    tx,
    user,
    vehicleId
  };
}

function buildEvidenceReadiness(
  harness: { orderId: string },
  overrides: Partial<{
    blockingReasons: string[];
    ready: boolean;
  }> = {}
) {
  const ready = overrides.ready ?? true;
  const blockingReasons = overrides.blockingReasons ?? [];
  return {
    blockingDetails: blockingReasons.map((message) => ({
      code: "HANDOVER_EVIDENCE_MISSING" as const,
      message
    })),
    blockingReasons,
    handoverId: "handover-1",
    orderId: harness.orderId,
    ready
  };
}

function buildHandoverRecord(
  harness: Pick<ReturnType<typeof createDeliveryHarness>, "orderId" | "user">,
  overrides: Record<string, unknown> = {}
) {
  const now = new Date("2026-06-06T08:00:00.000Z");
  const sourcePdfHash = "b".repeat(64);
  const manifestHash = "a".repeat(64);
  const signedPdfHash = "c".repeat(64);
  const signedObjectKey = "contracts/handover-1/signed.pdf";
  const stage2Task = {
    completedAt:
      new Date("2026-06-09T04:10:00.000Z") as Date | null,
    contractId: "handover-contract-1",
    customerId: "customer-1",
    deletedAt: null,
    documentType: ESignDocumentType.DELIVERY_HANDOVER,
    id: "handover-task-1",
    orderId: harness.orderId,
    provider: ESignProviderType.FADADA,
    providerTaskId: "STAGE2CUSTOMERH1",
    requestSnapshot: {
      artifactVersion: 1,
      contractId: "handover-contract-1",
      handoverId: "handover-1",
      manifestHash,
      sourceDocumentFileId: "source-file-1",
      sourcePdfHash
    },
    signedDocumentObjectKey: signedObjectKey,
    signers: [
      buildStage2DeliverySigner("CUSTOMER"),
      buildStage2DeliverySigner("PLATFORM")
    ] as [
      ReturnType<typeof buildStage2DeliverySigner>,
      ReturnType<typeof buildStage2DeliverySigner>
    ],
    signingStage: ESignSigningStage.STAGE2_DELIVERY_HANDOVER,
    taskNo: "ESGSTAGE2",
    taskStatus: ESignTaskStatus.COMPLETED as ESignTaskStatus
  };
  return {
    archiveStatus: DeliveryHandoverArchiveStatus.ARCHIVED,
    archivedAt: new Date("2026-06-09T04:20:00.000Z"),
    artifactVersion: 1,
    cancelledAt: null,
    completedAt:
      new Date("2026-06-09T04:10:00.000Z") as Date | null,
    createdAt: now,
    createdBy: harness.user.id,
    customerSignedAt:
      new Date("2026-06-09T04:00:00.000Z") as Date | null,
    deletedAt: null as Date | null,
    failedAt: null,
    failureReason: null,
    handoverContract: {
      deletedAt: null,
      fileId: "source-file-1",
      id: "handover-contract-1",
      status: ContractStatus.SIGNED
    },
    handoverContractId: "handover-contract-1",
    handoverESignTask: stage2Task,
    handoverESignTaskId: "handover-task-1",
    id: "handover-1",
    manifestHash,
    metadata: {},
    orderId: harness.orderId,
    platformSignedAt:
      new Date("2026-06-09T04:10:00.000Z") as Date | null,
    signedDocumentFileId: "signed-file-1",
    signedObjectKey,
    signedPdfHash,
    snapshot: {},
    sourceDocumentFileId: "source-file-1",
    sourceObjectKey: "contracts/handover-1/source.pdf",
    sourcePdfHash,
    stage1ContractId: "contract-1",
    status: DeliveryHandoverStatus.ARCHIVED as DeliveryHandoverStatus,
    updatedAt: now,
    updatedBy: harness.user.id,
    vehicleDeliveryId: "delivery-1",
    ...overrides
  };
}

function buildStage2DeliverySigner(type: "CUSTOMER" | "PLATFORM") {
  const customer = type === "CUSTOMER";
  return {
    customerId: customer ? "customer-1" : null,
    deletedAt: null as Date | null,
    documentType: ESignDocumentType.DELIVERY_HANDOVER,
    id: customer ? "stage2-customer-signer" : "stage2-platform-signer",
    providerActionType: customer
      ? ESignProviderActionType.CUSTOMER_MANUAL_SIGN
      : ESignProviderActionType.PLATFORM_AUTO_SEAL,
    providerTransactionId: customer
      ? "STAGE2CUSTOMERH1"
      : "STAGE2PLATFORMH2",
    required: true,
    signedAt: new Date("2026-06-09T04:10:00.000Z") as Date | null,
    signerStatus: ESignSignerStatus.SIGNED as ESignSignerStatus,
    signerType: customer
      ? ESignSignerType.CUSTOMER
      : ESignSignerType.PLATFORM,
    slotId: customer
      ? ESignSlotId.STAGE2_HANDOVER_CUSTOMER
      : ESignSlotId.STAGE2_HANDOVER_PLATFORM,
    taskId: "handover-task-1"
  };
}

function buildReadyDelivery(
  harness: ReturnType<typeof createDeliveryHarness>,
  overrides: Record<string, unknown> = {}
) {
  const now = new Date("2026-06-06T08:00:00.000Z");
  return {
    checklistSnapshot: {},
    contractSignedConfirmed: true,
    createdAt: now,
    createdBy: harness.user.id,
    customerId: harness.customerId,
    deletedAt: null,
    deliveredAt: null,
    deliveryLocation: "静安旺旺大厦",
    deliveryNo: "DLV2026060600001",
    deliveryStatus: DeliveryStatus.READY,
    depositReceivedConfirmed: true,
    firstMonthlyFeeReceivedConfirmed: true,
    handoverDocumentsConfirmed: true,
    handoverMileageKm: null,
    id: "delivery-1",
    insuranceValidConfirmed: true,
    orderId: harness.orderId,
    remark: "线下交付预约",
    scheduledAt: new Date("2026-06-10T02:00:00.000Z"),
    updatedAt: now,
    updatedBy: harness.user.id,
    vehicleId: harness.vehicleId,
    vehiclePhotosConfirmed: true,
    vehiclePreparedConfirmed: true,
    customerIdentityConfirmed: true,
    ...overrides
  };
}

function buildInsurancePolicy(
  harness: ReturnType<typeof createDeliveryHarness>,
  overrides: Record<string, unknown> = {}
) {
  const now = new Date("2026-06-06T08:00:00.000Z");
  return {
    createdAt: now,
    createdBy: harness.user.id,
    currency: "CNY",
    deletedAt: null,
    effectiveFrom: new Date("2026-06-01T00:00:00.000Z"),
    effectiveTo: new Date("2030-12-31T00:00:00.000Z"),
    id: `policy-${harness.state.insurancePolicies.length + 1}`,
    insuredAmount: null,
    insuredName: null,
    insurerName: "Test Insurance",
    policyHolderName: null,
    policyNo: `POLICY-${harness.state.insurancePolicies.length + 1}`,
    policyStatus: VehicleInsurancePolicyStatus.ACTIVE,
    policyType: "COMPULSORY_TRAFFIC",
    premiumAmount: null,
    remark: null,
    renewalReminderAt: null,
    snapshot: null,
    updatedAt: now,
    updatedBy: harness.user.id,
    vehicleId: harness.vehicleId,
    ...overrides
  };
}

function applyDefined(target: object, data: Record<string, unknown>) {
  const record = target as Record<string, unknown>;
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      record[key] = value;
    }
  }
}

function readPrismaSqlText(query: unknown) {
  if (
    query &&
    typeof query === "object" &&
    "strings" in query &&
    Array.isArray(query.strings)
  ) {
    return query.strings.join("?");
  }
  return String(query);
}

function expectNoDeliveryConfirmationSideEffects(
  harness: ReturnType<typeof createDeliveryHarness>
) {
  expect(harness.state.actualDeliveryAt).toBeNull();
  expect(harness.state.orderStatus).not.toBe(OrderStatus.ACTIVE);
  expect(harness.state.vehicleStatus).toBe(VehicleStatus.RESERVED);
  expect(harness.tx.vehicleDelivery.update).not.toHaveBeenCalled();
  expect(harness.tx.subscriptionOrder.update).not.toHaveBeenCalled();
  expect(harness.tx.vehicle.update).not.toHaveBeenCalled();
}
