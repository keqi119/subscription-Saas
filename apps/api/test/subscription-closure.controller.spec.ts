import "reflect-metadata";

import { RequestMethod, ValidationPipe } from "@nestjs/common";
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { PermissionCode } from "@subscription-saas/shared";
import { describe, expect, it, vi } from "vitest";

import { REQUIRED_PERMISSIONS_KEY } from "../src/auth/auth.decorators";
import { AuthModule } from "../src/auth/auth.module";
import { SubscriptionClosureController } from "../src/subscription-closure/subscription-closure.controller";
import {
  ConfirmClosurePhysicalReceiptDto,
  InitiateEarlyTerminationDto,
  ManagedSettlementDto
} from "../src/subscription-closure/subscription-closure.dto";
import { SubscriptionClosureModule } from "../src/subscription-closure/subscription-closure.module";

describe("SubscriptionClosureController governed boundary", () => {
  it("owns its authentication guards through an explicit module import", () => {
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, SubscriptionClosureModule)).toContain(
      AuthModule
    );
  });

  it.each([
    ["getCase", ":id", RequestMethod.GET, [PermissionCode.SUBSCRIPTION_CLOSURE_VIEW]],
    [
      "getByOrder",
      "by-order/:orderId",
      RequestMethod.GET,
      [PermissionCode.SUBSCRIPTION_CLOSURE_VIEW]
    ],
    ["listCases", "/", RequestMethod.GET, [PermissionCode.SUBSCRIPTION_CLOSURE_VIEW]],
    [
      "confirmPhysicalReceipt",
      "orders/:orderId/physical-receipt",
      RequestMethod.POST,
      [PermissionCode.SUBSCRIPTION_CLOSURE_RECEIVE]
    ],
    [
      "cancelReturnManifestSigning",
      ":id/return-manifest-signing/cancel",
      RequestMethod.POST,
      [PermissionCode.SUBSCRIPTION_CLOSURE_RECEIVE]
    ],
    [
      "recordInspection",
      ":id/inspection",
      RequestMethod.POST,
      [PermissionCode.SUBSCRIPTION_CLOSURE_INSPECT]
    ],
    [
      "releaseInventory",
      ":id/inventory-release",
      RequestMethod.POST,
      [PermissionCode.SUBSCRIPTION_CLOSURE_SETTLE]
    ],
    [
      "proposeSettlement",
      ":id/settlements/propose",
      RequestMethod.POST,
      [PermissionCode.SUBSCRIPTION_CLOSURE_SETTLE]
    ],
    [
      "finalizeSettlement",
      ":id/settlements/finalize",
      RequestMethod.POST,
      [PermissionCode.SUBSCRIPTION_CLOSURE_SETTLE]
    ],
    [
      "settle",
      ":id/settlements/settle",
      RequestMethod.POST,
      [PermissionCode.SUBSCRIPTION_CLOSURE_SETTLE]
    ],
    [
      "recordCustomerNoResponse",
      ":id/customer-no-response",
      RequestMethod.POST,
      [PermissionCode.SUBSCRIPTION_CLOSURE_SETTLE]
    ],
    [
      "decideChargeDispute",
      ":id/disputes/:disputeId/decision",
      RequestMethod.POST,
      [PermissionCode.SUBSCRIPTION_CLOSURE_SETTLE]
    ],
    [
      "requestClosureApproval",
      ":id/approval-requests",
      RequestMethod.POST,
      [PermissionCode.BUSINESS_EXCEPTION_REQUEST]
    ],
    [
      "decideClosureApproval",
      ":id/approvals/:approvalId/decision",
      RequestMethod.POST,
      [PermissionCode.BUSINESS_EXCEPTION_APPROVE]
    ],
    [
      "actOnRecovery",
      ":id/recovery/actions",
      RequestMethod.POST,
      [PermissionCode.SUBSCRIPTION_RECOVERY_ASSESS]
    ],
    [
      "requestRecoveryApproval",
      ":id/recovery/approval-requests",
      RequestMethod.POST,
      [PermissionCode.SUBSCRIPTION_RECOVERY_ASSESS]
    ],
    [
      "decideRecoveryApproval",
      ":id/recovery/approvals/:approvalId/decision",
      RequestMethod.POST,
      [PermissionCode.SUBSCRIPTION_RECOVERY_APPROVE]
    ],
    [
      "executeRecovery",
      ":id/recovery/execute",
      RequestMethod.POST,
      [PermissionCode.SUBSCRIPTION_RECOVERY_EXECUTE]
    ],
    [
      "recordRecoveryExecution",
      ":id/recovery/execution-records",
      RequestMethod.POST,
      [PermissionCode.SUBSCRIPTION_RECOVERY_EXECUTE]
    ],
    [
      "initiateEarlyTermination",
      "early-terminations",
      RequestMethod.POST,
      [
        PermissionCode.SUBSCRIPTION_CLOSURE_PREPARE,
        PermissionCode.SUBSCRIPTION_EARLY_TERMINATION_CREATE
      ]
    ],
    [
      "cancelEarlyTermination",
      ":id/early-termination/cancel",
      RequestMethod.POST,
      [
        PermissionCode.SUBSCRIPTION_CLOSURE_PREPARE,
        PermissionCode.SUBSCRIPTION_EARLY_TERMINATION_CREATE
      ]
    ],
    [
      "executeEarlyTermination",
      ":id/early-termination/execute",
      RequestMethod.POST,
      [PermissionCode.SUBSCRIPTION_EARLY_TERMINATION_EXECUTE]
    ]
  ] as const)(
    "guards %s with its exact permission set",
    (method, path, requestMethod, permissions) => {
      const handler = SubscriptionClosureController.prototype[method];
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(requestMethod);
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual(permissions);
    }
  );

  it("exposes no accidental mutation handler", () => {
    const handlers = Object.getOwnPropertyNames(SubscriptionClosureController.prototype)
      .filter((name) => name !== "constructor")
      .sort();
    expect(handlers).toEqual([
      "actOnRecovery",
      "cancelEarlyTermination",
      "cancelReturnManifestSigning",
      "captureReturnChecklist",
      "completeOperations",
      "confirmPhysicalReceipt",
      "confirmReturnDelta",
      "createPricing",
      "decideChargeDispute",
      "decideClosureApproval",
      "decideRecoveryApproval",
      "downloadEvidencePackage",
      "downloadReturnEvidence",
      "executeEarlyTermination",
      "executeRecovery",
      "exportEvidencePackage",
      "finalizeSettlement",
      "generateReturnDelta",
      "getByOrder",
      "getCase",
      "governance",
      "initiateEarlyTermination",
      "listCases",
      "packages",
      "previewReturnEvidence",
      "previewSignedReturnManifest",
      "proposeSettlement",
      "recordCustomerNoResponse",
      "recordDisposition",
      "recordInspection",
      "recordLegalCollectionEvent",
      "recordRecoveryExecution",
      "releaseInventory",
      "requestClosureApproval",
      "requestRecoveryApproval",
      "settle",
      "transferLegalCollection",
      "uploadFinancialProof",
      "uploadReturnEvidence"
    ]);
  });

  it("rejects unknown authority, unsafe cents, dates, nesting, and source tuples", async () => {
    const pipe = strictPipe();
    await expect(
      transform(pipe, InitiateEarlyTerminationDto, {
        effectiveAt: "2026-08-24T00:00:00.000Z",
        evidence: [],
        idempotencyKey: "early-1",
        orderId: "00000000-0000-4000-8000-000000000001",
        reason: "customer request",
        source: { id: "00000000-0000-4000-8000-000000000001", key: "forbidden", type: "CLIENT" }
      })
    ).rejects.toThrow();
    await expect(
      transform(pipe, ManagedSettlementDto, {
        idempotencyKey: "settlement-1",
        occurredAt: "not-a-date",
        totalCents: "100"
      })
    ).rejects.toThrow();
    await expect(
      transform(pipe, ConfirmClosurePhysicalReceiptDto, {
        checklist: deeplyNested(34),
        damages: [
          {
            damageLevel: "MINOR",
            damageType: "SCRATCH",
            description: "x",
            estimatedRepairAmount: "01"
          }
        ],
        physicalControlMode: "VOLUNTARY_RETURN",
        returnMileageKm: 1,
        returnType: "NORMAL_RETURN",
        returnedAt: "2026-08-24T00:00:00.000Z"
      })
    ).rejects.toThrow();
  });

  it("derives actor and aggregate identities from authentication and route params", async () => {
    const service = { initiateEarlyTermination: vi.fn(async () => ({ closureCaseId: "case" })) };
    const controller = new SubscriptionClosureController(
      service as never,
      {} as never,
      {
        get: vi.fn(() => "true")
      } as never
    );
    const request = {
      headers: { "user-agent": "test" },
      ip: "127.0.0.1",
      user: { id: "00000000-0000-4000-8000-000000000009", permissions: [], roles: [] }
    };
    await controller.initiateEarlyTermination(
      {
        effectiveAt: "2026-08-24T00:00:00.000Z",
        evidence: [],
        idempotencyKey: "early-1",
        orderId: "00000000-0000-4000-8000-000000000001",
        reason: "customer request"
      },
      request as never
    );
    expect(service.initiateEarlyTermination).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: request.user.id,
        orderId: "00000000-0000-4000-8000-000000000001"
      })
    );
  });

  it("fails closed for the legacy Closure early-termination route when the exact flag is off", async () => {
    const service = { initiateEarlyTermination: vi.fn() };
    const controller = new SubscriptionClosureController(
      service as never,
      {} as never,
      {
        get: vi.fn(() => "false")
      } as never
    );

    expect(() =>
      controller.initiateEarlyTermination(
        {
          effectiveAt: "2026-08-24T00:00:00.000Z",
          evidence: [],
          idempotencyKey: "early-disabled",
          orderId: "00000000-0000-4000-8000-000000000001",
          reason: "customer request"
        },
        { user: { id: "00000000-0000-4000-8000-000000000009" } } as never
      )
    ).toThrowError(expect.objectContaining({ status: 503 }));
    expect(service.initiateEarlyTermination).not.toHaveBeenCalled();
  });
});

function strictPipe() {
  return new ValidationPipe({ forbidNonWhitelisted: true, transform: true, whitelist: true });
}

function transform(pipe: ValidationPipe, metatype: new () => object, value: unknown) {
  return pipe.transform(value, { metatype, type: "body" });
}

function deeplyNested(depth: number): unknown {
  let value: unknown = true;
  for (let index = 0; index < depth; index += 1) value = { next: value };
  return value;
}
