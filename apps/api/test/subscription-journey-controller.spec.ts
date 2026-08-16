import "reflect-metadata";

import { RequestMethod, ValidationPipe } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { PermissionCode } from "@subscription-saas/shared";
import { describe, expect, it, vi } from "vitest";

import { REQUIRED_PERMISSIONS_KEY } from "../src/auth/auth.decorators";
import { SubscriptionJourneyController } from "../src/subscription-journey/subscription-journey.controller";
import {
  DeliveryEvidenceDecisionDto,
  FinalPlanDecisionDto
} from "../src/subscription-journey/subscription-journey.dto";

describe("SubscriptionJourneyController contract", () => {
  it.each([
    ["getByApplication", "by-application/:applicationId", RequestMethod.GET, PermissionCode.SUBSCRIPTION_JOURNEY_VIEW],
    ["getByOrder", "by-order/:orderId", RequestMethod.GET, PermissionCode.SUBSCRIPTION_JOURNEY_VIEW],
    ["list", "/", RequestMethod.GET, PermissionCode.SUBSCRIPTION_JOURNEY_VIEW],
    ["metrics", "metrics", RequestMethod.GET, PermissionCode.SUBSCRIPTION_JOURNEY_VIEW],
    ["decideFinalPlan", ":id/final-plan-decision", RequestMethod.POST, PermissionCode.SUBSCRIPTION_JOURNEY_PLAN_DECIDE],
    ["allocateVehicle", ":id/vehicle-allocation", RequestMethod.POST, PermissionCode.SUBSCRIPTION_JOURNEY_VEHICLE_ALLOCATE],
    ["decideDeliveryEvidence", ":id/delivery-evidence-decision", RequestMethod.POST, PermissionCode.SUBSCRIPTION_JOURNEY_DELIVERY_EVIDENCE_DECIDE],
    ["retry", ":id/retry", RequestMethod.POST, PermissionCode.SUBSCRIPTION_JOURNEY_RECOVER],
    ["pause", ":id/pause", RequestMethod.POST, PermissionCode.SUBSCRIPTION_JOURNEY_RECOVER],
    ["resume", ":id/resume", RequestMethod.POST, PermissionCode.SUBSCRIPTION_JOURNEY_RECOVER],
    ["cancel", ":id/cancel", RequestMethod.POST, PermissionCode.SUBSCRIPTION_JOURNEY_CANCEL]
  ] as const)("guards %s with its exact permission", (method, path, requestMethod, permission) => {
    const handler = SubscriptionJourneyController.prototype[method];

    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(requestMethod);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([
      permission
    ]);
  });

  it("rejects unknown and cross-task decision fields", async () => {
    const pipe = new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true
    });

    await expect(
      pipe.transform(
        { manifestHash: "a".repeat(64), version: 1, workOrderId: "0798f776-261b-4a73-818b-d822f2315c89" },
        { metatype: FinalPlanDecisionDto, type: "body" }
      )
    ).rejects.toThrow();
  });

  it("requires a non-empty rejection reason for evidence rejection", async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true });

    await expect(
      pipe.transform(
        {
          decision: "REJECTED",
          manifestHash: `sha256:${"a".repeat(64)}`,
          notes: "",
          version: 1,
          workOrderId: "0798f776-261b-4a73-818b-d822f2315c89"
        },
        { metatype: DeliveryEvidenceDecisionDto, type: "body" }
      )
    ).rejects.toThrow();
  });

  it("accepts the canonical sha256 delivery-evidence manifest hash", async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true });
    const manifestHash = `sha256:${"a".repeat(64)}`;

    await expect(
      pipe.transform(
        {
          decision: "APPROVED",
          manifestHash,
          version: 41,
          workOrderId: "0798f776-261b-4a73-818b-d822f2315c89"
        },
        { metatype: DeliveryEvidenceDecisionDto, type: "body" }
      )
    ).resolves.toMatchObject({ manifestHash });
  });

  it("rejects a bare delivery-evidence manifest digest", async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true });

    await expect(
      pipe.transform(
        {
          decision: "APPROVED",
          manifestHash: "a".repeat(64),
          version: 41,
          workOrderId: "0798f776-261b-4a73-818b-d822f2315c89"
        },
        { metatype: DeliveryEvidenceDecisionDto, type: "body" }
      )
    ).rejects.toThrow();
  });

  it("delegates an application lookup with the authenticated user", async () => {
    const service = { getByApplication: vi.fn(async () => ({ id: "journey-1" })) };
    const controller = new SubscriptionJourneyController(service as never);
    const request = { user: { id: "user-1", permissions: [], roles: [] } };

    await controller.getByApplication("application-1", request as never);

    expect(service.getByApplication).toHaveBeenCalledWith(
      "application-1",
      request.user
    );
  });
});
