import { ConfigService } from "@nestjs/config";
import { ApplicationSource, Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import { AssetAccountingRepository } from "../../src/asset-accounting/asset-accounting.repository";
import { AssetAccountingService } from "../../src/asset-accounting/asset-accounting.service";
import { AssetFactsRepository } from "../../src/asset-facts/asset-facts.repository";
import { AssetFactsService } from "../../src/asset-facts/asset-facts.service";
import { AssetOperationsRepository } from "../../src/asset-operations/asset-operations.repository";
import { AssetOperationsService } from "../../src/asset-operations/asset-operations.service";
import { AuditService } from "../../src/audit/audit.service";
import { AutoDebitScheduler } from "../../src/auto-debit/auto-debit.scheduler";
import { BillingAutomationRepository } from "../../src/billing-automation/billing-automation.repository";
import { BillingAutomationService } from "../../src/billing-automation/billing-automation.service";
import {
  DELIVERY_EVIDENCE_CHECKLIST_DEFINITIONS,
  DeliveryEvidenceService
} from "../../src/delivery-evidence/delivery-evidence.service";
import { FinanceService } from "../../src/finance/finance.service";
import { DeliveryHandoverService } from "../../src/delivery-handover/delivery-handover.service";
import { HandoverWorkOrderService } from "../../src/handover-work-order/handover-work-order.service";
import { Stage2HandoverRegistrationExceptionService } from "../../src/handover-work-order/stage2-handover-registration-exception.service";
import { LeaseActivationEngine } from "../../src/lease/lease-activation.engine";
import { MileageReviewRepository } from "../../src/mileage-review/mileage-review.repository";
import { MileageReviewService } from "../../src/mileage-review/mileage-review.service";
import { OrderEntitlementService } from "../../src/order/order-entitlement.service";
import { PrismaService } from "../../src/prisma/prisma.service";
import { ContractSegmentService } from "../../src/subscription-change/contract-segment.service";
import { SubscriptionJourneyRuntimeConfig } from "../../src/subscription-journey/subscription-journey.config";
import { SubscriptionJourneyHandlers } from "../../src/subscription-journey/subscription-journey.handlers";
import { SubscriptionJourneyRepository } from "../../src/subscription-journey/subscription-journey.repository";
import { SubscriptionJourneyService } from "../../src/subscription-journey/subscription-journey.service";
import { SubscriptionJourneyWorker } from "../../src/subscription-journey/subscription-journey.worker";
import { VehicleMileageService } from "../../src/vehicle-mileage/vehicle-mileage.service";
import { insertRuntimeContract, insertRuntimeOrderGraph } from "./runtime-domain-fixture";

// Caller supplies its Launcher-owned suite client. No connection, environment,
// lifecycle, provider or storage access is introduced by this helper. Earlier
// approval/signing/manual-review facts are synthetic inputs, not producer proof.
export function activationServices(
  prisma: PrismaService,
  repository = new SubscriptionJourneyRepository()
) {
  const audit = new AuditService(prisma);
  const evidence = new DeliveryEvidenceService(prisma);
  const accounting = new AssetAccountingService(prisma, new AssetAccountingRepository(), audit);
  const registration = new Stage2HandoverRegistrationExceptionService(prisma, accounting);
  const handover = new HandoverWorkOrderService(
    prisma,
    evidence,
    new DeliveryHandoverService(prisma, evidence),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    registration
  );
  const finance = new FinanceService(audit, prisma);
  const segments = new ContractSegmentService(prisma);
  const assets = new AssetOperationsService(prisma, new AssetOperationsRepository(), audit);
  const engine = new LeaseActivationEngine(
    audit,
    prisma,
    new AssetFactsService(prisma, new AssetFactsRepository(), audit),
    segments,
    undefined,
    evidence,
    new BillingAutomationService(
      prisma,
      new BillingAutomationRepository(prisma),
      finance,
      new AutoDebitScheduler(),
      segments
    ),
    finance,
    handover,
    new VehicleMileageService(prisma),
    new MileageReviewService(prisma, new MileageReviewRepository(prisma)),
    new OrderEntitlementService(),
    repository,
    assets
  );
  const service = new SubscriptionJourneyService(
    repository,
    prisma,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    engine
  );
  const worker = new SubscriptionJourneyWorker(
    prisma,
    repository,
    new SubscriptionJourneyHandlers(service),
    service,
    new SubscriptionJourneyRuntimeConfig(new ConfigService({}))
  );
  return { engine, evidence, finance, handover, repository, service, worker };
}

export async function prepareActivation(
  prisma: PrismaService,
  source: ApplicationSource = "SELF_SERVICE"
) {
  const ids = {
    actorId: randomUUID(),
    applicationId: randomUUID(),
    contractId: randomUUID(),
    customerId: randomUUID(),
    handoverContractId: randomUUID(),
    orderId: randomUUID(),
    vehicleId: randomUUID()
  };
  const services = activationServices(prisma);
  const activatedAt = new Date("2026-09-01T02:00:00.000Z");
  await prisma.$transaction(
    async (tx) => {
      await insertRuntimeOrderGraph(tx, {
        ...ids,
        label: "B4-ACTIVATION",
        salesUserId: ids.actorId
      });
      await tx.application.update({
        data: { applicationSource: source, finalPlanRevision: 1 },
        where: { id: ids.applicationId }
      });
      await tx.vehicle.update({ data: { status: "RESERVED" }, where: { id: ids.vehicleId } });
      await tx.vehicleDocument.create({
        data: {
          documentType: "VEHICLE_LICENSE",
          fileName: "synthetic-license.pdf",
          fileSize: 100,
          mimeType: "application/pdf",
          objectKey: `b4/${ids.vehicleId}/license.pdf`,
          vehicleId: ids.vehicleId
        }
      });
      // Create stage 2 first because the reusable contract fixture links its
      // contract to the order; stage 1 must remain the formal order contract.
      for (const contractId of [ids.handoverContractId, ids.contractId]) {
        await insertRuntimeContract(tx, { ...ids, contractId, label: "B4-ARCHIVED" });
        const file = await syntheticFile(tx, ids.actorId, "application/pdf");
        await tx.contract.update({ data: { fileId: file.id }, where: { id: contractId } });
      }
      await tx.subscriptionOrder.update({
        data: {
          finalPlanSnapshot: { mileagePackage: { monthlyMileageKm: 1500 } },
          orderSource: source === "SELF_SERVICE" ? "CUSTOMER_SELF_SERVICE" : "SALES_ASSISTED",
          orderStatus: "PENDING_DELIVERY"
        },
        where: { id: ids.orderId }
      });
      for (const policyType of ["COMPULSORY_TRAFFIC", "COMMERCIAL"] as const) {
        await tx.vehicleInsurancePolicy.create({
          data: {
            effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
            effectiveTo: new Date("2027-01-01T00:00:00.000Z"),
            policyNo: `B4-${randomUUID()}`,
            policyType,
            vehicleId: ids.vehicleId
          }
        });
      }
      await tx.vehicleInspection.create({ data: { orderId: ids.orderId, status: "PASSED" } });
    },
    { timeout: 60_000 }
  );
  const delivery = await prisma.vehicleDelivery.create({
    data: {
      customerId: ids.customerId,
      customerIdentityConfirmed: true,
      deliveryNo: `B4-${randomUUID()}`,
      deliveryStatus: "READY",
      handoverDocumentsConfirmed: true,
      orderId: ids.orderId,
      vehicleId: ids.vehicleId,
      vehiclePhotosConfirmed: true,
      vehiclePreparedConfirmed: true
    }
  });
  const stage2 = await prisma.contract.findUniqueOrThrow({ where: { id: ids.handoverContractId } });
  const signedFile = await prisma.fileObject.findUniqueOrThrow({ where: { id: stage2.fileId! } });
  const sourceFile = await syntheticFile(prisma, ids.actorId, "application/pdf");
  const handover = await prisma.vehicleDeliveryHandover.create({
    data: {
      archiveStatus: "ARCHIVED",
      archivedAt: activatedAt,
      completedAt: activatedAt,
      customerSignedAt: activatedAt,
      handoverContractId: ids.handoverContractId,
      orderId: ids.orderId,
      platformSignedAt: activatedAt,
      signedDocumentFileId: stage2.fileId,
      signedObjectKey: signedFile.objectKey,
      signedPdfHash: "b".repeat(64),
      sourceDocumentFileId: sourceFile.id,
      sourceObjectKey: sourceFile.objectKey,
      sourcePdfHash: sourceFile.contentSha256,
      stage1ContractId: ids.contractId,
      status: "ARCHIVED",
      vehicleDeliveryId: delivery.id
    }
  });
  const workOrder = await prisma.vehicleHandoverWorkOrder.create({
    data: {
      accessoryItems: [
        { code: "CHARGER", name: "Charger", quantity: 1, remark: null, state: "PRESENT" }
      ],
      assignedInternalUserId: ids.actorId,
      customerConfirmedAt: activatedAt,
      damageDeclared: false,
      energyLevelText: "80%",
      fieldCompletedAt: activatedAt,
      handoverId: handover.id,
      handoverMileageKm: 1200,
      handoverType: "DELIVERY_OUTBOUND",
      keyState: "COMPLETE",
      noVisibleDamageDeclared: true,
      opsReviewedAt: activatedAt,
      opsReviewedBy: ids.actorId,
      opsReviewStatus: "APPROVED",
      orderId: ids.orderId,
      primaryKeyCount: 1,
      registrationDocumentState: "HANDED_OVER",
      spareKeyCount: 1,
      status: "OPS_REVIEWED",
      vehicleConditionConfirmed: true,
      vehicleDeliveryId: delivery.id
    }
  });
  await services.evidence.initializeChecklist(ids.orderId, handover.id);
  const items = await prisma.vehicleDeliveryEvidenceItem.findMany({
    where: { handoverId: handover.id }
  });
  for (const item of items) {
    const definition = DELIVERY_EVIDENCE_CHECKLIST_DEFINITIONS.find(
      (row) => row.evidenceType === item.evidenceType
    )!;
    if (definition.isRequired) {
      const mediaType = definition.allowedMediaTypes[0]!;
      const file = await syntheticFile(
        prisma,
        ids.actorId,
        mediaType === "VIDEO" ? "video/mp4" : "image/jpeg"
      );
      const derivativeCount =
        mediaType === "PHOTO" ? 1 : item.evidenceType === "WALKAROUND_VIDEO" ? 4 : 2;
      const derivativeIds: string[] = [];
      for (let index = 0; index < derivativeCount; index += 1) {
        derivativeIds.push((await syntheticFile(prisma, ids.actorId, "image/jpeg")).id);
      }
      // Synthetic archived media remains a fixture boundary; the real attachment
      // service verifies its metadata and the existence/type of every derivative.
      await services.evidence.attachEvidenceFile(
        item.id,
        file.id,
        mediaType,
        ids.actorId,
        prisma,
        ids.actorId,
        {
          artifactVersion: 1,
          detectedCodec: mediaType === "VIDEO" ? "h264" : null,
          detectedMimeType: file.mimeType,
          photoPreviewFileId: mediaType === "PHOTO" ? derivativeIds[0]! : null,
          processedAt: activatedAt.toISOString(),
          processingStatus: "READY",
          sourceSha256: `sha256:${file.contentSha256}`,
          sourceSizeBytes: Number(file.sizeBytes),
          videoDurationMs: mediaType === "VIDEO" ? 12_000 : null,
          videoFrameFileIds: mediaType === "VIDEO" ? derivativeIds : []
        }
      );
    }
    if (definition.isRequired || item.evidenceType === "NO_VISIBLE_DAMAGE_DECLARATION") {
      await prisma.vehicleDeliveryEvidenceItem.update({
        data: {
          declaredNoDamage: item.evidenceType === "NO_VISIBLE_DAMAGE_DECLARATION" ? true : null,
          reviewedAt: activatedAt,
          reviewedBy: ids.actorId,
          reviewStatus: "APPROVED",
          status: "APPROVED"
        },
        where: { id: item.id }
      });
    }
  }
  const evidencePackage = await services.handover.getCurrentEvidencePackage(workOrder.id);
  const manifestHash = evidencePackage.manifestHash.replace(/^sha256:/, "");
  const taskNo = `B4${randomUUID().replaceAll("-", "")}`;
  const task = await prisma.contractESignTask.create({
    data: {
      completedAt: activatedAt,
      contractId: ids.handoverContractId,
      customerId: ids.customerId,
      documentType: "DELIVERY_HANDOVER",
      orderId: ids.orderId,
      provider: "MOCK",
      signedDocumentObjectKey: signedFile.objectKey,
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      taskNo,
      taskStatus: "COMPLETED",
      requestSnapshot: {
        artifactVersion: 1,
        contractId: ids.handoverContractId,
        handoverId: handover.id,
        manifestHash,
        sourceDocumentFileId: sourceFile.id,
        sourcePdfHash: sourceFile.contentSha256
      },
      signers: {
        create: [
          {
            customerId: ids.customerId,
            documentType: "DELIVERY_HANDOVER",
            providerActionType: "CUSTOMER_MANUAL_SIGN",
            providerTransactionId: `${taskNo.slice(0, 30)}H1`,
            required: true,
            signedAt: activatedAt,
            signerStatus: "SIGNED",
            signerType: "CUSTOMER",
            slotId: "STAGE2_HANDOVER_CUSTOMER"
          },
          {
            documentType: "DELIVERY_HANDOVER",
            providerActionType: "PLATFORM_AUTO_SEAL",
            providerTransactionId: `${taskNo.slice(0, 30)}H2`,
            required: true,
            signedAt: activatedAt,
            signerStatus: "SIGNED",
            signerType: "PLATFORM",
            slotId: "STAGE2_HANDOVER_PLATFORM"
          }
        ]
      }
    }
  });
  await prisma.vehicleHandoverReviewAttempt.create({
    data: {
      attemptNo: 1,
      customerConfirmedAt: activatedAt,
      evidenceSnapshot: { evidencePackage: { manifestHash: evidencePackage.manifestHash } },
      handoverId: handover.id,
      orderId: ids.orderId,
      status: "CUSTOMER_CONFIRMED",
      workOrderId: workOrder.id
    }
  });
  await prisma.vehicleDeliveryHandover.update({
    data: { handoverESignTaskId: task.id, manifestHash },
    where: { id: handover.id }
  });
  await prisma.vehicleHandoverWorkOrder.update({
    data: { metadata: { journeyEvidenceManifestHash: evidencePackage.manifestHash } },
    where: { id: workOrder.id }
  });
  for (const [billType, amount] of [
    ["DEPOSIT", 100000n],
    ["FIRST_MONTHLY_FEE", 10000n]
  ] as const) {
    const bill = await prisma.receivableBill.create({
      data: {
        amount,
        billNo: `B4-${randomUUID()}`,
        billType,
        customerId: ids.customerId,
        dueDate: activatedAt,
        orderId: ids.orderId,
        remainingAmount: amount
      }
    });
    const payment = await prisma.paymentOrder.create({
      data: {
        amount,
        customerId: ids.customerId,
        items: { create: { amount, billId: bill.id } },
        orderId: ids.orderId,
        paymentChannel: "MOCK",
        paymentOrderNo: `B4-${randomUUID()}`,
        provider: "MOCK",
        providerTradeNo: `b4-${randomUUID()}`
      }
    });
    await services.finance.settlePaymentOrder({
      operatorId: ids.actorId,
      paidAmount: amount,
      paidAt: activatedAt,
      paymentOrderId: payment.id,
      providerTransactionId: `b4-${randomUUID()}`
    });
  }
  const journey = await prisma.subscriptionJourney.create({
    data: {
      applicationId: ids.applicationId,
      currentStepCode: "AUTHORITATIVE_ACTIVATION",
      orderId: ids.orderId,
      steps: { create: { code: "AUTHORITATIVE_ACTIVATION" } }
    },
    include: { steps: true }
  });
  const job = await prisma.$transaction((tx) =>
    services.repository.enqueueJob(tx, {
      availableAt: new Date("2000-01-01T00:00:00.000Z"),
      jobType: "ACTIVATE_SUBSCRIPTION",
      journeyId: journey.id,
      payload: {
        applicationId: ids.applicationId,
        finalPlanRevision: 1,
        orderId: ids.orderId,
        stepCode: "AUTHORITATIVE_ACTIVATION"
      },
      sourceKey: `journey:${journey.id}:step:AUTHORITATIVE_ACTIVATION:revision:1`,
      stepId: journey.steps[0]!.id
    })
  );
  // This is a real gate evaluation, including current field evidence, exact
  // customer confirmation manifest, archived files and settled initial bills.
  await services.handover.assertDeliveryCanBeConfirmed(ids.orderId, handover.id);
  expect(await services.engine.evaluate(ids.orderId)).toMatchObject({
    canActivate: true,
    missingConditions: []
  });
  return {
    ...ids,
    ...services,
    activatedAt,
    deliveryId: delivery.id,
    handoverId: handover.id,
    jobId: job.id,
    journeyId: journey.id,
    stepId: journey.steps[0]!.id
  };
}

async function syntheticFile(
  db: Prisma.TransactionClient | PrismaService,
  actorId: string,
  mimeType: string
) {
  return db.fileObject.create({
    data: {
      bucket: "synthetic-b4",
      contentSha256: "b".repeat(64),
      mimeType,
      objectKey: `b4/${randomUUID()}`,
      originalName: "synthetic-evidence",
      sizeBytes: 100n,
      uploadedBy: actorId
    }
  });
}

export async function activationTruth(
  prisma: PrismaService,
  h: Awaited<ReturnType<typeof prepareActivation>>
) {
  const orderBy = { id: "asc" as const };
  const where = { orderId: h.orderId };
  const [
    order,
    contract,
    vehicle,
    delivery,
    leases,
    segments,
    periods,
    schedules,
    accounts,
    grants,
    readings,
    reviews,
    audits,
    journey,
    events,
    bills,
    payments,
    writeOffs
  ] = await Promise.all([
    prisma.subscriptionOrder.findUniqueOrThrow({ where: { id: h.orderId } }),
    prisma.contract.findUniqueOrThrow({ where: { id: h.contractId } }),
    prisma.vehicle.findUniqueOrThrow({ where: { id: h.vehicleId } }),
    prisma.vehicleDelivery.findUniqueOrThrow({ where }),
    prisma.lease.findMany({ orderBy, where }),
    prisma.subscriptionContractSegment.findMany({ orderBy, where }),
    prisma.vehicleSubscriptionPeriod.findMany({ orderBy, where }),
    prisma.billingSchedule.findMany({ orderBy, where }),
    prisma.orderEntitlementAccount.findMany({ orderBy, where }),
    prisma.orderEntitlementGrant.findMany({ orderBy, where }),
    prisma.vehicleMileageReading.findMany({ orderBy, where }),
    prisma.orderMileageReview.findMany({ orderBy, where }),
    prisma.auditLog.findMany({
      orderBy,
      where: { entityType: "subscription_activation", operatorId: h.actorId }
    }),
    prisma.subscriptionJourney.findUniqueOrThrow({
      include: { steps: { orderBy } },
      where: { id: h.journeyId }
    }),
    prisma.subscriptionJourneyEvent.findMany({ orderBy, where: { journeyId: h.journeyId } }),
    prisma.receivableBill.findMany({ orderBy, where }),
    prisma.paymentRecord.findMany({ orderBy, where }),
    prisma.paymentWriteOff.findMany({ orderBy, where })
  ]);
  return {
    order,
    contract,
    vehicle,
    delivery,
    leases,
    segments,
    periods,
    schedules,
    accounts,
    grants,
    readings,
    reviews,
    audits,
    journey,
    events,
    bills,
    payments,
    writeOffs
  };
}

export function expectActivated(facts: Awaited<ReturnType<typeof activationTruth>>) {
  expect(facts.order.orderStatus).toBe("ACTIVE");
  expect(facts.contract.status).toBe("ARCHIVED");
  expect(facts.vehicle.status).toBe("LEASED");
  expect(facts.delivery.deliveryStatus).toBe("DELIVERED");
  expect(facts.journey).toMatchObject({ currentStepStatus: "COMPLETED", status: "COMPLETED" });
  expect(facts.journey.steps).toEqual([
    expect.objectContaining({ code: "AUTHORITATIVE_ACTIVATION", status: "COMPLETED" })
  ]);
  expect(facts.leases).toEqual([expect.objectContaining({ status: "ACTIVE" })]);
  expect(facts.segments).toEqual([expect.objectContaining({ segmentType: "BASE" })]);
  expect(facts.periods).toEqual([
    expect.objectContaining({ endedAt: null, contractSegmentId: facts.segments[0]!.id })
  ]);
  expect(facts.schedules).toHaveLength(1);
  expect(facts.accounts).toEqual([expect.objectContaining({ accountStatus: "ACTIVE" })]);
  expect(facts.grants).toEqual([
    expect.objectContaining({
      accountId: facts.accounts[0]!.id,
      entitlementType: "MILEAGE",
      grantPeriodStart: facts.accounts[0]!.periodStart,
      grantPeriodEnd: facts.accounts[0]!.periodEnd,
      orderId: facts.order.id,
      remainingAmount: new Prisma.Decimal(1500),
      totalAmount: new Prisma.Decimal(1500),
      unit: "KM",
      usedAmount: new Prisma.Decimal(0)
    })
  ]);
  expect(facts.readings).toHaveLength(1);
  expect(facts.reviews).toHaveLength(1);
  expect(facts.audits).toHaveLength(1);
  expect(facts.events).toHaveLength(2);
  expect(facts.events.map(({ eventType }) => eventType).sort()).toEqual([
    "JOURNEY_COMPLETED",
    "STEP_COMPLETED"
  ]);
  expect(facts.audits[0]?.afterSnapshot).toMatchObject({
    baseSegmentId: facts.segments[0]!.id,
    leaseId: facts.leases[0]!.id,
    orderId: facts.order.id,
    subscriptionPeriodId: facts.periods[0]!.id
  });
  expect(facts.bills).toHaveLength(2);
  expect(
    facts.bills.every((bill) => bill.billStatus === "PAID" && bill.remainingAmount === 0n)
  ).toBe(true);
  expect(facts.payments).toHaveLength(2);
  expect(facts.writeOffs).toHaveLength(2);
}
