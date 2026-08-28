import { ConfigService } from "@nestjs/config";
import {
  ContractStatus,
  Prisma,
  SubscriptionChangeStatus,
  SubscriptionChangeType
} from "@prisma/client";
import { PermissionCode } from "@subscription-saas/shared";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AssetAccountingRepository } from "../src/asset-accounting/asset-accounting.repository";
import { AssetAccountingService } from "../src/asset-accounting/asset-accounting.service";
import { AssetFactsRepository } from "../src/asset-facts/asset-facts.repository";
import { AssetFactsService } from "../src/asset-facts/asset-facts.service";
import { AssetOperationsRepository } from "../src/asset-operations/asset-operations.repository";
import { AssetOperationsService } from "../src/asset-operations/asset-operations.service";
import { AuditService } from "../src/audit/audit.service";
import { HandoverWorkOrderService } from "../src/handover-work-order/handover-work-order.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { SubscriptionChangeConfig } from "../src/subscription-change/subscription-change.config";
import { SubscriptionEarlyTerminationChangeService } from "../src/subscription-change/subscription-early-termination-change.service";
import { SubscriptionClosureRepository } from "../src/subscription-closure/subscription-closure.repository";
import { SubscriptionClosureService } from "../src/subscription-closure/subscription-closure.service";
import { VehicleMileageRepository } from "../src/vehicle-mileage/vehicle-mileage.repository";
import { VehicleMileageService } from "../src/vehicle-mileage/vehicle-mileage.service";

const TEST_DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://subscription:subscription@127.0.0.1:55432/subscription_saas_codex?schema=public";

describe("early termination V2 change center with Closure authority", () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(new ConfigService({ DATABASE_URL: TEST_DATABASE_URL }));
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it("cancels before execution and executes a later change without stopping billing early", async () => {
    const fixture = await createFixture(prisma);
    const { audit, closure } = createClosure(prisma);
    let applicationNow = await databaseClock(prisma);
    const config: SubscriptionChangeConfig = {
      enabled: true,
      now: () => applicationNow,
      quoteValidityHours: 72
    };
    const artifactWriter = {
      writeGeneratedContractPdfArtifact: async (input: { renderModel: { contractId: string } }) => {
        const objectKey = `contracts/${input.renderModel.contractId}/generated/early-termination.pdf`;
        const file = await prisma.fileObject.create({
          data: {
            bucket: "test-contracts",
            mimeType: "application/pdf",
            objectKey,
            originalName: "early-termination.pdf",
            sizeBytes: 128n,
            uploadedBy: fixture.actorId
          }
        });
        return {
          bucket: file.bucket,
          diagnostics: {},
          fileId: file.id,
          mimeType: "application/pdf",
          objectKey,
          originalName: file.originalName,
          sizeBytes: 128
        };
      }
    };
    const service = new SubscriptionEarlyTerminationChangeService(
      prisma,
      closure,
      audit,
      config,
      artifactWriter as never,
      new ConfigService()
    );
    const actor = {
      id: fixture.actorId,
      menus: [],
      name: "Early termination operator",
      permissions: [
        PermissionCode.SUBSCRIPTION_CHANGE_CANCEL,
        PermissionCode.SUBSCRIPTION_CHANGE_EXECUTE,
        PermissionCode.SUBSCRIPTION_CHANGE_QUOTE,
        PermissionCode.SUBSCRIPTION_CHANGE_SUBMIT,
        PermissionCode.CONTRACT_GENERATE
      ],
      roles: ["SYSTEM_ADMIN"],
      username: fixture.username
    };
    const context = { ipAddress: "127.0.0.1", userAgent: "vitest-e2e" };
    try {
      const cancellable = await createDraftChange(prisma, fixture, fixture.tomorrowDate);
      const estimated = await service.createEstimate(
        cancellable.id,
        { idempotencyKey: "b8-estimate", version: 0 },
        actor,
        context
      );
      expect(estimated.estimate.futureBillBoundary).toMatchObject({
        billIds: [fixture.futureBillId],
        cancelOnlyAtExecution: true
      });
      await service.publishCustomerConfirmation(
        cancellable.id,
        { idempotencyKey: "b8-publish", version: 1 },
        actor,
        context
      );
      await service.decide(
        cancellable.id,
        {
          decision: "ACCEPT",
          idempotencyKey: "b8-accept",
          quoteId: cancellable.id,
          revision: estimated.estimate.revision,
          version: 2
        },
        { customerId: fixture.customerId },
        context
      );
      const agreement = await service.generate(
        cancellable.id,
        { idempotencyKey: "b8-generate", version: 3 },
        actor,
        context
      );
      await expect(
        service.generate(
          cancellable.id,
          { idempotencyKey: "b8-generate", version: 3 },
          actor,
          context
        )
      ).resolves.toMatchObject({ id: agreement.id, status: ContractStatus.GENERATED });
      await expect(
        prisma.subscriptionChangeOrder.findUniqueOrThrow({ where: { id: cancellable.id } })
      ).resolves.toMatchObject({
        status: SubscriptionChangeStatus.SIGNING_OR_PAYMENT,
        version: 4
      });
      await expect(billingTruth(prisma, fixture)).resolves.toMatchObject({
        billStatus: "PENDING",
        jobStatus: "PENDING",
        scheduleStatus: "ACTIVE"
      });

      await service.cancel(
        cancellable.id,
        { idempotencyKey: "b8-cancel", reason: "Customer withdrew request", version: 4 },
        actor,
        context
      );
      await expect(
        service.cancel(
          cancellable.id,
          { idempotencyKey: "b8-cancel", reason: "Customer withdrew request", version: 4 },
          actor,
          context
        )
      ).resolves.toMatchObject({ status: SubscriptionChangeStatus.CANCELLED, version: 5 });
      await expect(billingTruth(prisma, fixture)).resolves.toMatchObject({
        billStatus: "PENDING",
        jobStatus: "PENDING",
        scheduleStatus: "ACTIVE"
      });

      const executionClock = await databaseClock(prisma);
      const effectiveAt = new Date(executionClock.getTime() + 750);
      const initiated = await closure.initiateEarlyTermination({
        actorId: fixture.actorId,
        effectiveAt,
        evidence: [{ reference: "b8-execution-fixture", type: "CUSTOMER_REQUEST" }],
        idempotencyKey: "b8-direct-initiate",
        orderId: fixture.orderId,
        reason: "Customer confirmed governed early termination"
      });
      const executionChange = await createScheduledChange(prisma, fixture, {
        closureCaseId: initiated.closureCaseId
      });
      await expect(billingTruth(prisma, fixture)).resolves.toMatchObject({
        billStatus: "PENDING",
        jobStatus: "PENDING",
        scheduleStatus: "ACTIVE"
      });

      await waitForDatabaseClock(prisma, effectiveAt);
      applicationNow = await databaseClock(prisma);
      await expect(service.progress(executionChange.id)).resolves.toEqual({
        changeOrderId: executionChange.id,
        outcome: "EXECUTING"
      });
      const closureAgreement = await prisma.subscriptionClosureCurrentDocument.findUniqueOrThrow({
        include: {
          documentRevision: {
            include: {
              contractESignTask: true,
              signedFile: true,
              sourceFile: true
            }
          }
        },
        where: {
          closureCaseId_documentType: {
            closureCaseId: initiated.closureCaseId,
            documentType: "EARLY_TERMINATION_AGREEMENT"
          }
        }
      });
      expect(closureAgreement.documentRevision).toMatchObject({
        contractESignTask: {
          provider: "MOCK",
          signingStage: "STAGE3_SUBSCRIPTION_EXTENSION",
          taskStatus: "COMPLETED"
        },
        signedFile: { mimeType: "application/pdf" },
        sourceFile: { mimeType: "application/pdf" },
        stage: "ARCHIVED"
      });
      await expect(
        service.execute(
          executionChange.id,
          { idempotencyKey: "b8-execute", version: 0 },
          actor,
          context
        )
      ).resolves.toMatchObject({
        closureCaseId: initiated.closureCaseId,
        wrote: false
      });
      await expect(
        prisma.subscriptionChangeOrder.findUniqueOrThrow({ where: { id: executionChange.id } })
      ).resolves.toMatchObject({
        failureCode: null,
        status: SubscriptionChangeStatus.EXECUTING,
        version: 1
      });
      await expect(billingTruth(prisma, fixture)).resolves.toMatchObject({
        billStatus: "PENDING",
        jobStatus: "CANCELLED",
        scheduleStatus: "COMPLETED"
      });
      await expect(
        prisma.subscriptionClosureCase.findUniqueOrThrow({
          where: { id: initiated.closureCaseId }
        })
      ).resolves.toMatchObject({ status: "PREPARING_RETURN" });

      await markClosureOperationallyTerminated(prisma, initiated.closureCaseId);
      await expect(service.reconcile(executionChange.id)).resolves.toEqual({
        changeOrderId: executionChange.id,
        outcome: "COMPLETED"
      });
      await expect(
        prisma.subscriptionChangeOrder.findUniqueOrThrow({ where: { id: executionChange.id } })
      ).resolves.toMatchObject({ status: SubscriptionChangeStatus.COMPLETED, version: 2 });
    } finally {
      await cleanupFixture(prisma, fixture);
    }
  });

  it("moves a provider-backed agreement with current-fact drift to manual takeover without return leakage", async () => {
    const fixture = await createFixture(prisma);
    const { audit, closure } = createClosure(prisma);
    let applicationNow = await databaseClock(prisma);
    const service = new SubscriptionEarlyTerminationChangeService(
      prisma,
      closure,
      audit,
      {
        enabled: true,
        now: () => applicationNow,
        quoteValidityHours: 72
      },
      undefined,
      new ConfigService()
    );
    const actor = {
      id: fixture.actorId,
      menus: [],
      name: "Early termination operator",
      permissions: [
        PermissionCode.SUBSCRIPTION_CHANGE_CANCEL,
        PermissionCode.SUBSCRIPTION_CHANGE_EXECUTE
      ],
      roles: ["SYSTEM_ADMIN"],
      username: fixture.username
    };
    const context = { ipAddress: "127.0.0.1", userAgent: "vitest-e2e" };
    try {
      const effectiveAt = new Date(applicationNow.getTime() + 250);
      const initiated = await closure.initiateEarlyTermination({
        actorId: fixture.actorId,
        effectiveAt,
        evidence: [{ reference: "b8-provider-drift", type: "CUSTOMER_REQUEST" }],
        idempotencyKey: "b8-provider-drift-initiate",
        orderId: fixture.orderId,
        reason: "Customer confirmed governed early termination"
      });
      const change = await createScheduledChange(prisma, fixture, {
        closureCaseId: initiated.closureCaseId
      });
      const providerTask = await prisma.contractESignTask.findFirstOrThrow({
        where: {
          contractId: change.contractId!,
          signingStage: "STAGE3_SUBSCRIPTION_EXTENSION",
          taskStatus: "COMPLETED"
        }
      });
      await closure.archiveEarlyTerminationAgreement({
        actorId: fixture.actorId,
        agreementContractId: change.contractId!,
        closureCaseId: initiated.closureCaseId,
        idempotencyKey: `early-termination-change:${change.id}:agreement`,
        providerTaskId: providerTask.id
      });

      await prisma.vehicle.update({
        data: { status: "MAINTENANCE" },
        where: { id: fixture.vehicleId }
      });
      await waitForDatabaseClock(prisma, effectiveAt);
      applicationNow = await databaseClock(prisma);

      await expect(
        service.execute(
          change.id,
          { idempotencyKey: "b8-provider-drift-execute", version: 0 },
          actor,
          context
        )
      ).resolves.toMatchObject({
        closureCaseId: initiated.closureCaseId,
        outcome: "AGREEMENT_STALE"
      });
      await expect(
        prisma.subscriptionChangeOrder.findUniqueOrThrow({ where: { id: change.id } })
      ).resolves.toMatchObject({
        failureCode: "EARLY_TERMINATION_AGREEMENT_STALE",
        status: SubscriptionChangeStatus.MANUAL_TAKEOVER,
        version: 1
      });
      await expect(
        prisma.contractESignTask.findFirstOrThrow({
          where: {
            sourceId: initiated.closureCaseId,
            sourceType: "SUBSCRIPTION_EARLY_TERMINATION"
          }
        })
      ).resolves.toMatchObject({ taskStatus: "CANCELLED" });
      await expect(
        prisma.contractESignTask.findUniqueOrThrow({ where: { id: providerTask.id } })
      ).resolves.toMatchObject({ taskStatus: "COMPLETED" });
      await expect(
        prisma.vehicleReturn.count({ where: { orderId: fixture.orderId } })
      ).resolves.toBe(0);

      await expect(
        service.cancel(
          change.id,
          {
            idempotencyKey: "b8-provider-drift-cancel",
            reason: "Operator rejected the stale governed agreement",
            version: 1
          },
          actor,
          context
        )
      ).resolves.toMatchObject({ status: SubscriptionChangeStatus.CANCELLED, version: 2 });
      await expect(
        prisma.contract.findUniqueOrThrow({ where: { id: change.contractId! } })
      ).resolves.toMatchObject({ status: ContractStatus.ARCHIVED });
      await expect(
        prisma.vehicleReturn.count({ where: { orderId: fixture.orderId } })
      ).resolves.toBe(0);
    } finally {
      await cleanupFixture(prisma, fixture);
    }
  });
});

function createClosure(prisma: PrismaService) {
  const audit = new AuditService(prisma);
  const accounting = new AssetAccountingService(prisma, new AssetAccountingRepository(), audit);
  const operations = new AssetOperationsService(
    prisma,
    new AssetOperationsRepository(),
    audit,
    accounting
  );
  return {
    audit,
    closure: new SubscriptionClosureService(
      new SubscriptionClosureRepository(),
      new HandoverWorkOrderService(prisma, {} as never),
      operations,
      audit,
      prisma,
      new AssetFactsService(prisma, new AssetFactsRepository(), audit),
      accounting,
      new VehicleMileageService(prisma, new VehicleMileageRepository())
    )
  };
}

async function createDraftChange(
  prisma: PrismaService,
  fixture: EarlyTerminationFixture,
  effectiveDate: Date
) {
  return prisma.subscriptionChangeOrder.create({
    data: {
      changeNo: `CHG-B8-CANCEL-${randomUUID()}`,
      changeType: SubscriptionChangeType.EARLY_TERMINATION,
      completionDeadlineAt: fixture.futureEndDate,
      createdBy: fixture.actorId,
      earlyTerminationDetail: {
        create: {
          effectiveDate,
          reasonSnapshot: {
            evidence: [{ reference: "portal-request-b8", type: "CUSTOMER_REQUEST" }],
            reason: "Customer relocation"
          }
        }
      },
      orderId: fixture.orderId,
      sourceSegmentId: fixture.segmentId,
      status: SubscriptionChangeStatus.DRAFT,
      updatedBy: fixture.actorId
    }
  });
}

async function createScheduledChange(
  prisma: PrismaService,
  fixture: EarlyTerminationFixture,
  input: {
    closureCaseId: string;
  }
) {
  const changeOrderId = randomUUID();
  const sourceFile = await prisma.fileObject.create({
    data: {
      bucket: "test-contracts",
      mimeType: "application/pdf",
      objectKey: `contracts/${fixture.orderId}/generated/early-termination.pdf`,
      originalName: "generated-early-termination.pdf",
      sizeBytes: 192n,
      uploadedBy: fixture.actorId
    }
  });
  const signedFile = await prisma.fileObject.create({
    data: {
      bucket: "test-contracts",
      mimeType: "application/pdf",
      objectKey: `contracts/${fixture.orderId}/signed/early-termination.pdf`,
      originalName: "signed-early-termination.pdf",
      sizeBytes: 256n,
      uploadedBy: fixture.actorId
    }
  });
  const agreement = await prisma.contract.create({
    data: {
      archivedAt: new Date(),
      businessType: "SUBSCRIPTION",
      contractNo: `CON-B8-EXEC-${randomUUID()}`,
      contractSnapshot: {
        agreementFacts: {
          closureCaseId: input.closureCaseId,
          effectiveDate: fixture.todayDate.toISOString(),
          estimate: { revision: 1 },
          estimateRevision: 1,
          reason: "Customer confirmed governed early termination"
        },
        authority: "CUSTOMER_PROVIDER_ESIGN",
        changeOrderId,
        generatedPdfArtifact: {
          fileId: sourceFile.id,
          mimeType: sourceFile.mimeType,
          objectKey: sourceFile.objectKey
        },
        signedDocumentObjectKey: signedFile.objectKey
      },
      contractTitle: "B8 execution agreement",
      contractVersionId: fixture.contractVersionId,
      createdBy: fixture.actorId,
      customerId: fixture.customerId,
      fileId: signedFile.id,
      orderId: fixture.orderId,
      signedAt: new Date(),
      status: ContractStatus.ARCHIVED,
      updatedBy: fixture.actorId
    }
  });
  await prisma.contractESignTask.create({
    data: {
      completedAt: new Date(),
      contractId: agreement.id,
      createdBy: fixture.actorId,
      customerId: fixture.customerId,
      documentName: sourceFile.originalName,
      documentObjectKey: sourceFile.objectKey,
      documentType: "SUBSCRIPTION_EXTENSION_AGREEMENT",
      orderId: fixture.orderId,
      provider: "MOCK",
      providerEnvelopeId: `env-${randomUUID()}`,
      providerTaskId: `provider-${randomUUID()}`,
      signedDocumentObjectKey: signedFile.objectKey,
      signingStage: "STAGE3_SUBSCRIPTION_EXTENSION",
      sourceId: changeOrderId,
      sourceKey: `subscription-change:${changeOrderId}:esign:attempt:1`,
      sourceType: "EARLY_TERMINATION_SUPPLEMENT",
      taskNo: `ESG-B8-${randomUUID()}`,
      taskStatus: "COMPLETED",
      updatedBy: fixture.actorId
    }
  });
  return prisma.subscriptionChangeOrder.create({
    data: {
      id: changeOrderId,
      changeNo: `CHG-B8-EXEC-${randomUUID()}`,
      changeType: SubscriptionChangeType.EARLY_TERMINATION,
      completionDeadlineAt: fixture.futureEndDate,
      contractId: agreement.id,
      createdBy: fixture.actorId,
      earlyTerminationDetail: {
        create: {
          agreementContractId: agreement.id,
          closureCaseId: input.closureCaseId,
          effectiveDate: fixture.todayDate,
          estimatedSettlementRevision: 1,
          reasonSnapshot: {
            currentEstimate: { revision: 1 },
            reason: "Customer confirmed governed early termination"
          }
        }
      },
      orderId: fixture.orderId,
      sourceSegmentId: fixture.segmentId,
      status: SubscriptionChangeStatus.SCHEDULED,
      updatedBy: fixture.actorId
    }
  });
}

async function billingTruth(prisma: PrismaService, fixture: EarlyTerminationFixture) {
  const [bill, job, schedule] = await Promise.all([
    prisma.receivableBill.findUniqueOrThrow({ where: { id: fixture.futureBillId } }),
    prisma.subscriptionAutomationJob.findUniqueOrThrow({ where: { id: fixture.futureJobId } }),
    prisma.billingSchedule.findUniqueOrThrow({ where: { id: fixture.scheduleId } })
  ]);
  return {
    billStatus: bill.billStatus,
    jobStatus: job.jobStatus,
    scheduleStatus: schedule.status
  };
}

type EarlyTerminationFixture = Awaited<ReturnType<typeof createFixture>>;

async function createFixture(prisma: PrismaService) {
  const actorId = randomUUID();
  const contractId = randomUUID();
  const contractVersionId = randomUUID();
  const supplementContractVersionId = randomUUID();
  const customerId = randomUUID();
  const futureBillId = randomUUID();
  const futureJobId = randomUUID();
  const orderId = randomUUID();
  const scheduleId = randomUUID();
  const segmentId = randomUUID();
  const vehicleId = randomUUID();
  const username = `b8-${actorId}`;
  const now = await databaseClock(prisma);
  const todayDate = shanghaiBusinessDate(now, 0);
  const tomorrowDate = shanghaiBusinessDate(now, 1);
  const pastStartDate = shanghaiBusinessDate(now, -180);
  const futureEndDate = shanghaiBusinessDate(now, 180);
  const futurePeriodDate = shanghaiBusinessDate(now, 30);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "customer" ("id", "customer_no", "name", "mobile", "status", "created_at", "updated_at")
      VALUES (${customerId}::uuid, ${`CUSTB8${compact(customerId)}`}, 'B8 Early Termination', '13800000000', 'ACTIVE', clock_timestamp(), clock_timestamp())
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "user" ("id", "username", "name", "password_hash", "status", "created_at", "updated_at")
      VALUES (${actorId}::uuid, ${username}, 'B8 actor', 'not-used', 'ACTIVE', clock_timestamp(), clock_timestamp())
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "vehicle" ("id", "vehicle_no", "plate_no", "brand", "model_definition_id", "purchase_price_amount", "status", "created_at", "updated_at")
      VALUES (${vehicleId}::uuid, ${`VEHB8${compact(vehicleId)}`}, ${`沪B${compact(vehicleId).slice(0, 5)}`}, 'NIO', ${randomUUID()}::uuid, 20000000, 'LEASED', clock_timestamp(), clock_timestamp())
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "contract_version" (
        "id", "template_name", "version_no", "business_type", "template_type", "content_template",
        "effective_from", "status", "created_at", "updated_at"
      ) VALUES (
        ${contractVersionId}::uuid, ${`B8-${compact(contractVersionId)}`}, '1', 'SUBSCRIPTION',
        'SUBSCRIPTION_STANDARD', 'B8 test contract', ${pastStartDate}::date, 'ACTIVE',
        clock_timestamp(), clock_timestamp()
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "contract_version" (
        "id", "template_name", "version_no", "business_type", "template_type", "content_template",
        "effective_from", "status", "created_at", "updated_at"
      ) VALUES (
        ${supplementContractVersionId}::uuid,
        ${`B8-SUP-${compact(supplementContractVersionId)}`},
        '1', 'SUBSCRIPTION', 'SUBSCRIPTION_EXTENSION', 'B8 early termination supplement',
        ${pastStartDate}::date, 'ACTIVE', clock_timestamp(), clock_timestamp()
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "subscription_order" (
        "id", "order_no", "customer_id", "application_id", "quote_id", "vehicle_id",
        "product_id", "product_version_id", "vehicle_purchase_price_amount", "monthly_fee_amount",
        "deposit_amount", "period_months", "mileage_limit_km", "over_mileage_fee_amount",
        "model_definition_id_snapshot", "model_code_snapshot", "model_display_name_snapshot",
        "quote_snapshot", "final_plan_snapshot", "order_status", "start_date", "end_date",
        "actual_delivery_at", "created_by", "updated_by", "created_at", "updated_at"
      ) VALUES (
        ${orderId}::uuid, ${`ORDB8${compact(orderId)}`}, ${customerId}::uuid, ${randomUUID()}::uuid,
        ${randomUUID()}::uuid, ${vehicleId}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
        20000000, 100, 500, 12, 1500, 100, ${randomUUID()}::uuid, 'NIO_ET5_2024', 'NIO ET5',
        '{}'::jsonb, '{}'::jsonb, 'ACTIVE', ${pastStartDate}::date, ${futureEndDate}::date,
        clock_timestamp(), ${actorId}::uuid, ${actorId}::uuid, clock_timestamp(), clock_timestamp()
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "contract" (
        "id", "contract_no", "order_id", "customer_id", "business_type", "contract_version_id",
        "contract_title", "contract_snapshot", "status", "created_by", "updated_by", "created_at", "updated_at"
      ) VALUES (
        ${contractId}::uuid, ${`CONB8${compact(contractId)}`}, ${orderId}::uuid, ${customerId}::uuid,
        'SUBSCRIPTION', ${contractVersionId}::uuid, 'B8 base contract',
        '{"earlyTerminationFeeAmount":"300"}'::jsonb, 'SIGNED', ${actorId}::uuid,
        ${actorId}::uuid, clock_timestamp(), clock_timestamp()
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "subscription_order" SET "contract_id" = ${contractId}::uuid WHERE "id" = ${orderId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "lease" ("id", "order_id", "status", "activated_at", "created_by", "updated_by", "created_at", "updated_at")
      VALUES (${randomUUID()}::uuid, ${orderId}::uuid, 'ACTIVE', clock_timestamp(), ${actorId}::uuid, ${actorId}::uuid, clock_timestamp(), clock_timestamp())
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_schedule" (
        "id", "order_id", "status", "next_cycle_no", "next_period_start", "next_period_end",
        "next_generate_at", "created_at", "updated_at"
      ) VALUES (
        ${scheduleId}::uuid, ${orderId}::uuid, 'ACTIVE', 2, ${futurePeriodDate}::date,
        ${futureEndDate}::date, clock_timestamp(), clock_timestamp(), clock_timestamp()
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "subscription_contract_segment" (
        "id", "segment_no", "order_id", "segment_type", "sequence_no", "status", "start_date",
        "end_date", "monthly_fee_amount", "mileage_limit_km", "over_mileage_fee_amount",
        "plan_snapshot", "quote_snapshot", "contract_snapshot", "activated_at", "created_by", "created_at"
      ) VALUES (
        ${segmentId}::uuid, ${`SEGB8${compact(segmentId)}`}, ${orderId}::uuid, 'BASE', 1, 'ACTIVE',
        ${pastStartDate}::date, ${futureEndDate}::date, 100, 1500, 100, '{}'::jsonb, '{}'::jsonb,
        '{}'::jsonb, clock_timestamp(), ${actorId}::uuid, clock_timestamp()
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "receivable_bill" (
        "id", "bill_no", "order_id", "customer_id", "bill_type", "bill_status", "amount",
        "paid_amount", "remaining_amount", "due_date", "bill_period_start", "bill_period_end",
        "snapshot", "created_by", "created_at", "updated_at"
      ) VALUES (
        ${futureBillId}::uuid, ${`BILB8${compact(futureBillId)}`}, ${orderId}::uuid, ${customerId}::uuid,
        'MONTHLY_RENT', 'PENDING', 100, 0, 100, ${futurePeriodDate}::date, ${futurePeriodDate}::date,
        ${futureEndDate}::date, '{}'::jsonb, ${actorId}::uuid, clock_timestamp(), clock_timestamp()
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "subscription_automation_job" (
        "id", "billing_schedule_id", "order_id", "job_type", "job_status", "idempotency_key",
        "available_at", "payload", "created_at", "updated_at"
      ) VALUES (
        ${futureJobId}::uuid, ${scheduleId}::uuid, ${orderId}::uuid, 'GENERATE_MONTHLY_RENT_BILL',
        'PENDING', ${`b8-future:${futureJobId}`}, clock_timestamp(),
        ${JSON.stringify({ periodStart: dateOnly(futurePeriodDate) })}::jsonb,
        clock_timestamp(), clock_timestamp()
      )
    `);
  });
  return {
    actorId,
    contractId,
    contractVersionId,
    customerId,
    futureBillId,
    futureEndDate,
    futureJobId,
    orderId,
    scheduleId,
    segmentId,
    supplementContractVersionId,
    todayDate,
    tomorrowDate,
    username,
    vehicleId
  };
}

async function cleanupFixture(prisma: PrismaService, fixture: EarlyTerminationFixture) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    for (const table of [
      "audit_log",
      "contract_esign_callback_log",
      "subscription_closure_command_receipt",
      "subscription_closure_current_document",
      "subscription_closure_document_revision",
      "subscription_closure_event",
      "subscription_early_termination_change_detail",
      "subscription_change_order",
      "contract_esign_task",
      "subscription_closure_case",
      "vehicle_return_damage",
      "vehicle_return",
      "asset_work_order_event",
      "asset_work_order_evidence",
      "asset_work_order",
      "vehicle_handover_event",
      "vehicle_handover_work_order",
      "subscription_automation_job",
      "receivable_bill",
      "billing_schedule",
      "subscription_contract_segment",
      "lease"
    ]) {
      if (table === "audit_log") {
        await tx.$executeRawUnsafe(
          `DELETE FROM "${table}" WHERE "operator_id" = $1::uuid OR "entity_id" = $2::uuid`,
          fixture.actorId,
          fixture.orderId
        );
      } else if (table === "contract_esign_callback_log") {
        await tx.$executeRawUnsafe(
          `DELETE FROM "${table}" WHERE "task_id" IN (SELECT "id" FROM "contract_esign_task" WHERE "order_id" = $1::uuid)`,
          fixture.orderId
        );
      } else if (table.startsWith("subscription_closure_")) {
        const closureColumn =
          table === "subscription_closure_case" ? "order_id" : "closure_case_id";
        const clause =
          table === "subscription_closure_case"
            ? `"${closureColumn}" = $1::uuid`
            : `"${closureColumn}" IN (SELECT "id" FROM "subscription_closure_case" WHERE "order_id" = $1::uuid)`;
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE ${clause}`, fixture.orderId);
      } else if (table === "subscription_early_termination_change_detail") {
        await tx.$executeRawUnsafe(
          `DELETE FROM "${table}" WHERE "change_order_id" IN (SELECT "id" FROM "subscription_change_order" WHERE "order_id" = $1::uuid)`,
          fixture.orderId
        );
      } else if (table.startsWith("asset_work_order")) {
        const clause =
          table === "asset_work_order"
            ? `"order_id" = $1::uuid`
            : `"work_order_id" IN (SELECT "id" FROM "asset_work_order" WHERE "order_id" = $1::uuid)`;
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE ${clause}`, fixture.orderId);
      } else if (table.startsWith("vehicle_handover_")) {
        const clause =
          table === "vehicle_handover_work_order"
            ? `"order_id" = $1::uuid`
            : `"work_order_id" IN (SELECT "id" FROM "vehicle_handover_work_order" WHERE "order_id" = $1::uuid)`;
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE ${clause}`, fixture.orderId);
      } else {
        await tx.$executeRawUnsafe(
          `DELETE FROM "${table}" WHERE "order_id" = $1::uuid`,
          fixture.orderId
        );
      }
    }
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM "file_object" WHERE "uploaded_by" = ${fixture.actorId}::uuid`
    );
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM "contract" WHERE "order_id" = ${fixture.orderId}::uuid`
    );
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM "subscription_order" WHERE "id" = ${fixture.orderId}::uuid`
    );
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM "contract_version" WHERE "id" = ${fixture.contractVersionId}::uuid`
    );
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM "contract_version" WHERE "id" = ${fixture.supplementContractVersionId}::uuid`
    );
    await tx.$executeRaw(Prisma.sql`DELETE FROM "vehicle" WHERE "id" = ${fixture.vehicleId}::uuid`);
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM "customer" WHERE "id" = ${fixture.customerId}::uuid`
    );
    await tx.$executeRaw(Prisma.sql`DELETE FROM "user" WHERE "id" = ${fixture.actorId}::uuid`);
  });
}

async function databaseClock(prisma: PrismaService) {
  const rows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
  if (!rows[0]) throw new Error("B8_DATABASE_CLOCK_MISSING");
  return rows[0].now;
}

async function markClosureOperationallyTerminated(prisma: PrismaService, closureCaseId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw(Prisma.sql`
      UPDATE "subscription_closure_case"
      SET "status" = 'TERMINATED',
          "physical_controlled_at" = clock_timestamp(),
          "settled_at" = clock_timestamp(),
          "closed_at" = clock_timestamp(),
          "updated_at" = clock_timestamp()
      WHERE "id" = ${closureCaseId}::uuid
    `);
  });
}

async function waitForDatabaseClock(prisma: PrismaService, target: Date) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await databaseClock(prisma)).getTime() >= target.getTime()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("B8_DATABASE_CLOCK_DID_NOT_REACH_EFFECTIVE_TIME");
}

function shanghaiBusinessDate(now: Date, offsetDays: number) {
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1_000);
  return new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + offsetDays)
  );
}

function dateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

function compact(value: string) {
  return value.replaceAll("-", "").slice(0, 20);
}
