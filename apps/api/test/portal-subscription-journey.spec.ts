import "reflect-metadata";

import { NotFoundException, RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import {
  BillStatus,
  SubscriptionJourneyStatus,
  SubscriptionJourneyStepCode,
  SubscriptionJourneyStepStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { CustomerAuthGuard } from "../src/portal/portal-auth.guard";
import { PortalSubscriptionJourneyController } from "../src/subscription-journey/portal-subscription-journey.controller";
import { SubscriptionJourneyRepository } from "../src/subscription-journey/subscription-journey.repository";
import { SubscriptionJourneyService } from "../src/subscription-journey/subscription-journey.service";

describe("Portal subscription journey contract", () => {
  it.each([
    ["getByApplication", "by-application/:applicationId"],
    ["getByOrder", "by-order/:orderId"]
  ] as const)("exposes the guarded %s route", (method, path) => {
    const handler = PortalSubscriptionJourneyController.prototype[method];

    expect(Reflect.getMetadata(PATH_METADATA, PortalSubscriptionJourneyController)).toBe(
      "portal/subscription-journeys"
    );
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata("__guards__", PortalSubscriptionJourneyController)).toContain(
      CustomerAuthGuard
    );
  });

  it("scopes application lookup to the authenticated customer and redacts internals", async () => {
    const findFirst = vi.fn(async () => portalJourneyRow());
    const service = new SubscriptionJourneyService(
      {} as SubscriptionJourneyRepository,
      { subscriptionJourney: { findFirst } } as never
    );

    const result = await service.getPortalByApplication("application-1", currentCustomer());

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          application: { customerId: "customer-1" },
          applicationId: "application-1"
        }
      })
    );
    expect(result).toMatchObject({
      blockerText: null,
      currentStepCode: "CUSTOMER_PLAN_CONFIRMATION",
      finalPlanRevision: 3,
      links: {
        application: "/portal/applications/application-1",
        bills: ["/portal/bills/bill-1"],
        contract: "/portal/contracts/contract-1",
        order: "/portal/orders/order-1"
      },
      nextAction: {
        href: "/portal/applications/application-1",
        type: "CONFIRM_FINAL_PLAN"
      },
      status: "WAITING_CUSTOMER"
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(
      /customer-1|another-customer|decisionNotes|actorId|lastError|providerPayload|stack/i
    );
  });

  it("returns a generic not-found response when ownership does not match", async () => {
    const service = new SubscriptionJourneyService(
      {} as SubscriptionJourneyRepository,
      { subscriptionJourney: { findFirst: vi.fn(async () => null) } } as never
    );

    await expect(
      service.getPortalByOrder("another-order", currentCustomer())
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([
    [
      SubscriptionJourneyStatus.WAITING_MANUAL,
      SubscriptionJourneyStepStatus.WAITING_MANUAL,
      "平台正在完成材料、信用与押金审核。",
      null
    ],
    [
      SubscriptionJourneyStatus.WAITING_CUSTOMER,
      SubscriptionJourneyStepStatus.WAITING_CUSTOMER,
      "请补充申请资料后重新提交审核。",
      {
        href: "/portal/applications/application-1",
        label: "补充申请资料",
        type: "SUPPLEMENT_APPLICATION_MATERIALS"
      }
    ]
  ])(
    "projects application validation %s as a business wait",
    async (status, currentStepStatus, blockerText, nextAction) => {
      const findFirst = vi.fn(async () =>
        portalJourneyRow({
          currentStepCode: SubscriptionJourneyStepCode.APPLICATION_VALIDATION,
          currentStepStatus,
          status
        })
      );
      const service = new SubscriptionJourneyService(
        {} as SubscriptionJourneyRepository,
        { subscriptionJourney: { findFirst } } as never
      );

      await expect(
        service.getPortalByApplication("application-1", currentCustomer())
      ).resolves.toMatchObject({ blockerText, nextAction, status });
    }
  );
});

function currentCustomer() {
  return {
    accountStatus: "ACTIVE" as const,
    customerAccountId: "account-1",
    customerId: "customer-1",
    phone: "13800000000"
  };
}

function portalJourneyRow(overrides: Record<string, unknown> = {}) {
  return {
    application: {
      applicationNo: "APP-1",
      customerId: "customer-1",
      finalPlanRevision: 3,
      id: "application-1"
    },
    currentStepCode: SubscriptionJourneyStepCode.CUSTOMER_PLAN_CONFIRMATION,
    currentStepStatus: SubscriptionJourneyStepStatus.WAITING_CUSTOMER,
    id: "journey-1",
    order: {
      contractId: "contract-1",
      id: "order-1",
      orderNo: "ORD-1",
      receivableBills: [
        { billStatus: BillStatus.PENDING, id: "bill-1" }
      ]
    },
    status: SubscriptionJourneyStatus.WAITING_CUSTOMER,
    version: 4,
    ...overrides
  };
}
