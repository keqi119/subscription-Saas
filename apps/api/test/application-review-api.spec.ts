import {
  ApplicationMaterialType,
  ApplicationSource,
  ApplicationStatus,
  CustomerGrade,
  CustomerStatus,
  DepositStatus,
  MaterialStatus,
  MonthlyFeeMode,
  NotificationType,
  OrderReviewStatus,
  OrderSource,
  OrderStatus,
  PlanConfirmStatus,
  Prisma,
  ProductStatus,
  ProductType,
  ProductVersionStatus,
  QuoteStatus,
  RecordStatus,
  RiskResultDecision,
  SalePriceStatus,
  SubscriptionPlanStatus,
  SubscriptionJourneyStepCode,
  VehicleBatteryUsageType,
  VehicleStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { CustomerService } from "../src/customer/customer.service";
import { VehicleAvailabilityPurpose } from "../src/asset-operations/vehicle-availability";

interface ApprovalRiskInput {
  applicationId: string;
  approvedAt: Date;
  customerId: string;
  grade: CustomerGrade;
  maxVehiclePurchasePriceAmount?: number;
  operatorId: string;
  remark?: string;
  riskScore?: number;
}

describe("application self-service review APIs", () => {
  it("returns self-service pending applications in the review queue", async () => {
    const harness = createApplicationReviewHarness();

    const queue = await harness.service.listApplicationReviewQueue(harness.user);

    expect(queue).toHaveLength(1);
    expect(queue[0]).toEqual(
      expect.objectContaining({
        applicationSource: ApplicationSource.SELF_SERVICE,
        id: harness.application.id,
        materialReviewStatus: OrderReviewStatus.PENDING
      })
    );
    expect(harness.prisma.application.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          applicationSource: ApplicationSource.SELF_SERVICE,
          orders: { none: { deletedAt: null } }
        })
      })
    );
  });

  it.each([
    [ApplicationStatus.DRAFT, null, "CURRENT"],
    [
      ApplicationStatus.SUBMITTED,
      {
        capturedAt: "2026-06-05T09:00:00.000Z",
        customerId: "customer-1",
        emergencyContactMobile: "13900000000",
        emergencyContactName: "王女士",
        idCardNo: "11010519491231002X",
        mobile: "13800000000",
        name: "测试客户",
        residenceAddress: "上海市闵行区北翟路1554弄53号",
        residenceCity: "上海市",
        residenceDetail: "北翟路1554弄53号",
        residenceDistrict: "闵行区",
        residenceProvince: "上海市",
        snapshotVersion: 1,
        source: "CUSTOMER_PORTAL_PROFILE"
      },
      "SNAPSHOT"
    ],
    [ApplicationStatus.SUBMITTED, null, "HISTORICAL_CURRENT_FALLBACK"]
  ] as const)(
    "exposes %s application profile data from %s as %s",
    async (status, customerProfileSnapshot, expectedSource) => {
      const harness = createApplicationReviewHarness({
        application: { customerProfileSnapshot, status }
      });

      await expect(
        harness.service.getApplication(harness.application.id, harness.user)
      ).resolves.toMatchObject({
        customerProfileDisplaySource: expectedSource,
        customerProfileReadiness: { complete: true, missingFields: [] },
        customerProfileSnapshot:
          expectedSource === "SNAPSHOT"
            ? expect.objectContaining({ snapshotVersion: 1 })
            : null,
        customerProfileUpdatedAt:
          expectedSource === "SNAPSHOT"
            ? "2026-06-05T09:00:00.000Z"
            : "2026-06-05T10:00:00.000Z"
      });
    }
  );

  it("allows an incomplete customer to have a sales-assisted draft", async () => {
    const harness = createApplicationReviewHarness({
      customer: {
        identity: null,
        mobile: "138",
        profile: null,
        name: ""
      }
    });

    await expect(
      harness.service.createApplication(
        {
          customerId: "customer-1",
          intendedModel: "ET5"
        },
        harness.user,
        harness.context
      )
    ).resolves.toMatchObject({ status: ApplicationStatus.DRAFT });
    expect(harness.tx.customerIdentity.upsert).not.toHaveBeenCalled();
    expect(harness.tx.application.create).toHaveBeenCalled();
  });

  it("blocks assisted application submission when customer identity profile is incomplete", async () => {
    const harness = createApplicationReviewHarness({
      customer: {
        identity: null,
        mobile: "138",
        name: "",
        profile: null
      },
      application: {
        materialGroups: approvedRequiredMaterialGroups(
          new Date("2026-06-05T10:00:00.000Z")
        ),
        status: ApplicationStatus.DRAFT
      }
    });

    await expect(
      harness.service.submitApplication(
        harness.application.id,
        {},
        harness.user,
        harness.context
      )
    ).rejects.toThrow("CUSTOMER_APPLICATION_PROFILE_INCOMPLETE");
    expect(harness.tx.application.update).not.toHaveBeenCalled();
  });

  it("publishes the assisted application signal inside its submit transaction", async () => {
    const harness = createApplicationReviewHarness({
      application: {
        applicationSource: ApplicationSource.SALES_ASSISTED,
        materialGroups: approvedRequiredMaterialGroups(
          new Date("2026-06-05T10:00:00.000Z")
        ),
        status: ApplicationStatus.DRAFT
      }
    });

    await harness.service.submitApplication(
      harness.application.id,
      {},
      harness.user,
      harness.context
    );

    expect(harness.journeySignal.record).toHaveBeenCalledWith(harness.tx, {
      applicationId: harness.application.id,
      eventKey: `application:${harness.application.id}:submitted`,
      payload: { source: ApplicationSource.SALES_ASSISTED },
      type: "APPLICATION_SUBMITTED"
    });
    expect(harness.tx.application.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          customerProfileSnapshot: expect.objectContaining({ snapshotVersion: 1 })
        })
      })
    );
  });

  it("increments the customer profile snapshot after a need-more-info resubmission", async () => {
    const harness = createApplicationReviewHarness({
      application: {
        customerProfileSnapshot: {
          snapshotVersion: 1,
          source: "CUSTOMER_PORTAL_PROFILE"
        },
        materialGroups: approvedRequiredMaterialGroups(
          new Date("2026-06-05T10:00:00.000Z")
        ),
        status: ApplicationStatus.NEED_MORE_INFO
      }
    });

    await harness.service.submitApplication(
      harness.application.id,
      {},
      harness.user,
      harness.context
    );

    expect(harness.tx.application.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          customerProfileSnapshot: expect.objectContaining({ snapshotVersion: 2 })
        })
      })
    );
  });

  it("publishes a versioned validation fact after a need-more-info resubmission", async () => {
    const harness = createApplicationReviewHarness({
      application: {
        customerProfileSnapshot: {
          snapshotVersion: 1,
          source: "CUSTOMER_PORTAL_PROFILE"
        },
        materialGroups: approvedRequiredMaterialGroups(
          new Date("2026-06-05T10:00:00.000Z")
        ),
        status: ApplicationStatus.NEED_MORE_INFO
      }
    });

    await harness.service.submitApplication(
      harness.application.id,
      {},
      harness.user,
      harness.context
    );

    expect(harness.state.application.journeyFactVersion).toBe(1);
    expect(harness.journeySignal.record).toHaveBeenCalledWith(harness.tx, {
      applicationId: harness.application.id,
      eventKey: "application:application-1:facts:application:application-action-1",
      payload: {
        factType: "application",
        factVersion: 1,
        sourceActionId: "application-action-1",
        targetStepCode: "APPLICATION_VALIDATION"
      },
      type: "APPLICATION_FACTS_CHANGED"
    });
    expect(harness.journeySignal.record).not.toHaveBeenCalledWith(
      harness.tx,
      expect.objectContaining({
        eventKey: "application:application-1:submitted",
        type: "APPLICATION_SUBMITTED"
      })
    );
  });

  it("publishes the need-more-info review as a versioned validation fact", async () => {
    const harness = createApplicationReviewHarness();

    await harness.service.reviewApplication(
      harness.application.id,
      "material",
      { action: OrderReviewStatus.NEED_MORE_INFO, comment: "请补充身份证反面" },
      harness.user,
      harness.context
    );

    expect(harness.state.application.journeyFactVersion).toBe(1);
    expect(harness.journeySignal.record).toHaveBeenCalledWith(harness.tx, {
      applicationId: harness.application.id,
      eventKey: "application:application-1:facts:material:application-action-1",
      payload: {
        factType: "material",
        factVersion: 1,
        sourceActionId: "application-action-1",
        targetStepCode: "APPLICATION_VALIDATION"
      },
      type: "APPLICATION_FACTS_CHANGED"
    });
  });

  it("publishes a general supplement request as a versioned validation fact", async () => {
    const harness = createApplicationReviewHarness();

    await harness.service.needMoreInfo(
      harness.application.id,
      { comment: "请补充最新居住证明" },
      harness.user,
      harness.context
    );

    expect(harness.state.application.journeyFactVersion).toBe(1);
    expect(harness.journeySignal.record).toHaveBeenCalledWith(harness.tx, {
      applicationId: harness.application.id,
      eventKey: "application:application-1:facts:material:application-action-1",
      payload: {
        factType: "material",
        factVersion: 1,
        sourceActionId: "application-action-1",
        targetStepCode: "APPLICATION_VALIDATION"
      },
      type: "APPLICATION_FACTS_CHANGED"
    });
  });

  it("approves material review status", async () => {
    const harness = createApplicationReviewHarness();

    const application = await harness.service.reviewApplication(
      harness.application.id,
      "material",
      { action: OrderReviewStatus.APPROVED, comment: "材料齐全" },
      harness.user,
      harness.context
    );

    expect(application).toEqual(
      expect.objectContaining({ materialReviewStatus: OrderReviewStatus.APPROVED })
    );
    expect(harness.state.application.materialReviewStatus).toBe(OrderReviewStatus.APPROVED);
  });

  it("approves credit review and confirms deposit by customer grade", async () => {
    const harness = createApplicationReviewHarness();

    const application = await harness.service.reviewApplication(
      harness.application.id,
      "credit",
      {
        action: OrderReviewStatus.APPROVED,
        comment: "资质通过",
        customerGrade: CustomerGrade.A
      },
      harness.user,
      harness.context
    );

    expect(application).toEqual(
      expect.objectContaining({
        creditReviewStatus: OrderReviewStatus.APPROVED,
        customerGrade: CustomerGrade.A,
        depositStatus: DepositStatus.CONFIRMED,
        finalDepositAmount: 300000
      })
    );
    expect(harness.state.customer.grade).toBe(CustomerGrade.A);
    expect(harness.state.application.depositRuleSnapshot).toEqual(
      expect.objectContaining({
        depositAmount: 300000,
        status: DepositStatus.CONFIRMED
      })
    );
    expect(harness.journeySignal.record).toHaveBeenCalledWith(harness.tx, {
      applicationId: harness.application.id,
      eventKey:
        "application:application-1:facts:credit:application-action-1",
      payload: {
        factType: "credit",
        factVersion: 1,
        sourceActionId: "application-action-1",
        targetStepCode: "APPLICATION_VALIDATION"
      },
      type: "APPLICATION_FACTS_CHANGED"
    });
  });

  it("increments one application fact version for each committed review mutation", async () => {
    const harness = createApplicationReviewHarness();

    await harness.service.reviewApplication(
      harness.application.id,
      "material",
      { action: OrderReviewStatus.APPROVED },
      harness.user,
      harness.context
    );
    await harness.service.reviewApplication(
      harness.application.id,
      "credit",
      { action: OrderReviewStatus.APPROVED, customerGrade: CustomerGrade.A },
      harness.user,
      harness.context
    );

    expect(harness.state.application.journeyFactVersion).toBe(2);
    expect(harness.journeySignal.record).toHaveBeenNthCalledWith(1, harness.tx, {
      applicationId: harness.application.id,
      eventKey: "application:application-1:facts:material:application-action-1",
      payload: {
        factType: "material",
        factVersion: 1,
        sourceActionId: "application-action-1",
        targetStepCode: "APPLICATION_VALIDATION"
      },
      type: "APPLICATION_FACTS_CHANGED"
    });
    expect(harness.journeySignal.record).toHaveBeenNthCalledWith(2, harness.tx, {
      applicationId: harness.application.id,
      eventKey: "application:application-1:facts:credit:application-action-1",
      payload: {
        factType: "credit",
        factVersion: 2,
        sourceActionId: "application-action-1",
        targetStepCode: "APPLICATION_VALIDATION"
      },
      type: "APPLICATION_FACTS_CHANGED"
    });
  });

  it("saves rating, score, vehicle price, deposit, and comments through the shared approval flow", async () => {
    const harness = createApplicationReviewHarness({
      application: {
        materialGroups: approvedRequiredMaterialGroups(new Date("2026-06-05T10:00:00.000Z")),
        materialReviewStatus: OrderReviewStatus.APPROVED
      }
    });

    const application = await harness.service.approveApplication(
      harness.application.id,
      {
        comment: "资质通过",
        grade: CustomerGrade.B,
        maxVehiclePurchasePriceAmount: 26000000,
        riskScore: 720
      },
      harness.user,
      harness.context
    );

    expect(application).toEqual(
      expect.objectContaining({
        creditReviewComment: "资质通过",
        creditReviewStatus: OrderReviewStatus.APPROVED,
        customerGrade: CustomerGrade.B,
        depositStatus: DepositStatus.CONFIRMED,
        finalDepositAmount: 300000
      })
    );
    expect(harness.state.customer).toEqual(
      expect.objectContaining({
        grade: CustomerGrade.B,
        riskScore: 720,
        status: CustomerStatus.APPROVED
      })
    );
    expect(harness.state.application.depositRuleSnapshot).toEqual(
      expect.objectContaining({
        defaultRate: 0.1,
        depositAmount: 300000,
        grade: CustomerGrade.B,
        maxVehiclePurchasePriceAmount: 26000000,
        riskScore: 720,
        status: DepositStatus.CONFIRMED
      })
    );
    expect(harness.riskService.createApprovalRiskResult).toHaveBeenCalledWith(
      harness.tx,
      expect.objectContaining({
        grade: CustomerGrade.B,
        maxVehiclePurchasePriceAmount: 26000000,
        remark: "资质通过",
        riskScore: 720
      })
    );
  });

  it("rejects credit review and releases the review-reserved vehicle", async () => {
    const harness = createApplicationReviewHarness();

    const application = await harness.service.reviewApplication(
      harness.application.id,
      "credit",
      { action: OrderReviewStatus.REJECTED, comment: "资质未通过" },
      harness.user,
      harness.context
    );

    expect(application).toEqual(
      expect.objectContaining({
        creditReviewStatus: OrderReviewStatus.REJECTED,
        softReservationExpiresAt: null,
        softReservedAt: null,
        softReservedVehicleId: null,
        status: ApplicationStatus.REJECTED
      })
    );
    expect(harness.state.vehicleStatus).toBe(VehicleStatus.AVAILABLE);
    expect(harness.journeySignal.terminateApplication).toHaveBeenCalledWith(
      harness.tx,
      {
        actionId: "application-action-1",
        applicationId: harness.application.id,
        factVersion: 1,
        outcome: "REJECTED",
        reason: "资质未通过"
      }
    );
  });

  it("cancels an application, releases its review-reserved vehicle, and terminates its journey", async () => {
    const harness = createApplicationReviewHarness();

    const application = await harness.service.cancelApplication(
      harness.application.id,
      { reason: "客户撤销申请" },
      harness.user,
      harness.context
    );

    expect(application).toEqual(
      expect.objectContaining({
        softReservationExpiresAt: null,
        softReservedAt: null,
        softReservedVehicleId: null,
        status: ApplicationStatus.CANCELLED
      })
    );
    expect(harness.state.vehicleStatus).toBe(VehicleStatus.AVAILABLE);
    expect(harness.journeySignal.terminateApplication).toHaveBeenCalledWith(
      harness.tx,
      {
        actionId: "application-action-1",
        applicationId: harness.application.id,
        factVersion: 1,
        outcome: "CANCELLED",
        reason: "客户撤销申请"
      }
    );
  });

  it("approves product review and writes final plan fields", async () => {
    const harness = createApplicationReviewHarness();

    const application = await harness.service.reviewApplication(
      harness.application.id,
      "product",
      { action: OrderReviewStatus.APPROVED, comment: "产品匹配" },
      harness.user,
      harness.context
    );

    expect(application).toEqual(
      expect.objectContaining({
        finalPeriodMonths: 12,
        finalSubscriptionPlanId: harness.plan.id,
        finalVehicleBaseFeeAmount: 700000,
        finalVehicleId: harness.vehicle.id,
        productReviewStatus: OrderReviewStatus.APPROVED
      })
    );
  });

  it("rejects product review and releases the review-reserved vehicle", async () => {
    const harness = createApplicationReviewHarness();

    const application = await harness.service.reviewApplication(
      harness.application.id,
      "product",
      { action: OrderReviewStatus.REJECTED, comment: "产品不匹配" },
      harness.user,
      harness.context
    );

    expect(application.productReviewStatus).toBe(OrderReviewStatus.REJECTED);
    expect(application.status).toBe(ApplicationStatus.REJECTED);
    expect(harness.state.vehicleStatus).toBe(VehicleStatus.AVAILABLE);
  });

  it("approves vehicle review and keeps the vehicle review-reserved", async () => {
    const harness = createApplicationReviewHarness({
      application: {
        finalSubscriptionPlanId: "plan-1",
        productReviewStatus: OrderReviewStatus.APPROVED
      }
    });

    const application = await harness.service.reviewApplication(
      harness.application.id,
      "vehicle",
      { action: OrderReviewStatus.APPROVED, comment: "库存通过" },
      harness.user,
      harness.context
    );

    expect(application).toEqual(
      expect.objectContaining({
        finalVehicleId: harness.vehicle.id,
        vehicleReviewStatus: OrderReviewStatus.APPROVED
      })
    );
    expect(harness.state.vehicleStatus).toBe(VehicleStatus.REVIEW_RESERVED);
  });

  it("rejects vehicle review and releases the review-reserved vehicle", async () => {
    const harness = createApplicationReviewHarness();

    const application = await harness.service.reviewApplication(
      harness.application.id,
      "vehicle",
      { action: OrderReviewStatus.REJECTED, comment: "库存不足" },
      harness.user,
      harness.context
    );

    expect(application.vehicleReviewStatus).toBe(OrderReviewStatus.REJECTED);
    expect(application.status).toBe(ApplicationStatus.REJECTED);
    expect(harness.state.vehicleStatus).toBe(VehicleStatus.AVAILABLE);
  });

  it("finalizes after material and credit approval, then auto-approves product and vehicle reviews", async () => {
    const harness = createApplicationReviewHarness({
      application: {
        creditReviewStatus: OrderReviewStatus.APPROVED,
        depositStatus: DepositStatus.CONFIRMED,
        finalDepositAmount: 300000n,
        materialReviewStatus: OrderReviewStatus.APPROVED,
        productReviewStatus: OrderReviewStatus.PENDING,
        vehicleReviewStatus: OrderReviewStatus.PENDING
      }
    });

    const application = await harness.service.finalizeApplicationPlan(
      harness.application.id,
      harness.user,
      harness.context
    );

    expect(application).toEqual(
      expect.objectContaining({
        finalPlanSnapshot: expect.objectContaining({
          depositAmount: 300000,
          finalPlanConfirmedAt: null,
          planConfirmStatus: PlanConfirmStatus.PENDING,
          subscriptionPlanId: harness.plan.id,
          vehicleId: harness.vehicle.id
        }),
        finalPlanConfirmedAt: null,
        planConfirmStatus: PlanConfirmStatus.PENDING,
        productReviewStatus: OrderReviewStatus.APPROVED,
        status: ApplicationStatus.APPROVED
      })
    );
    expect(application.vehicleReviewStatus).toBe(OrderReviewStatus.APPROVED);
    expect(harness.notificationService.notifyCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          aggregateNo: "APP202606050001",
          applicationNo: "APP202606050001",
          plateNo: "沪A00001"
        }),
        notificationType: NotificationType.FINAL_PLAN_PENDING
      })
    );
  });

  it("publishes revision one only after atomically holding the final vehicle", async () => {
    const harness = createApplicationReviewHarness({
      application: readyToFinalizeApplication()
    });

    const application = await harness.service.applyJourneyFinalPlanDecision(
      harness.tx as never,
      harness.application.id,
      {
        finalPeriodMonths: 12,
        finalSubscriptionPlanId: harness.plan.id,
        finalVehicleId: harness.vehicle.id
      },
      harness.user,
      harness.context
    );

    expect(application).toEqual(
      expect.objectContaining({
        customerConfirmedPlanRevision: null,
        finalPlanCommercialHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        finalPlanRevision: 1,
        planConfirmStatus: PlanConfirmStatus.PENDING,
        productReviewStatus: OrderReviewStatus.APPROVED,
        softReservedVehicleId: harness.vehicle.id,
        vehicleReviewStatus: OrderReviewStatus.APPROVED
      })
    );
    expect(application.finalPlanSnapshot).toEqual(
      expect.objectContaining({ finalPlanRevision: 1 })
    );
    expect(
      harness.journeySignal.completeFinalPlanAndVehicleAllocation
    ).toHaveBeenCalledWith(
      harness.tx,
      {
        actorId: harness.user.id,
        applicationId: harness.application.id,
        finalPlanCommercialHash: application.finalPlanCommercialHash,
        finalPlanRevision: 1,
        vehicleId: harness.vehicle.id
      }
    );
    expect(harness.journeySignal.completeManualDecision).not.toHaveBeenCalled();
    expect(harness.state.vehicleStatus).toBe(VehicleStatus.REVIEW_RESERVED);
  });

  it("soft-reserves an available assisted-sale vehicle before publishing the plan", async () => {
    const harness = createApplicationReviewHarness({
      application: {
        ...readyToFinalizeApplication(),
        applicationSource: ApplicationSource.SALES_ASSISTED,
        softReservedAt: null,
        softReservedVehicleId: null
      },
      vehicle: { status: VehicleStatus.AVAILABLE }
    });

    const application = await harness.service.applyJourneyFinalPlanDecision(
      harness.tx as never,
      harness.application.id,
      {
        finalPeriodMonths: 12,
        finalSubscriptionPlanId: harness.plan.id,
        finalVehicleId: harness.vehicle.id
      },
      harness.user,
      harness.context
    );

    expect(harness.tx.vehicle.updateMany).toHaveBeenCalledWith({
      data: { status: VehicleStatus.REVIEW_RESERVED, updatedBy: harness.user.id },
      where: {
        deletedAt: null,
        id: harness.vehicle.id,
        status: VehicleStatus.AVAILABLE
      }
    });
    expect(application).toEqual(
      expect.objectContaining({
        softReservedVehicleId: harness.vehicle.id,
        vehicleReviewStatus: OrderReviewStatus.APPROVED
      })
    );
    expect(application.finalPlanSnapshot).toEqual(
      expect.objectContaining({
        vehicleSnapshot: expect.objectContaining({
          status: VehicleStatus.REVIEW_RESERVED
        })
      })
    );
  });

  it("does not republish an assisted plan when the legacy route observes its hold", async () => {
    const harness = createApplicationReviewHarness({
      application: {
        ...readyToFinalizeApplication(),
        applicationSource: ApplicationSource.SALES_ASSISTED,
        softReservationExpiresAt: null,
        softReservedAt: null,
        softReservedVehicleId: null
      },
      vehicle: { status: VehicleStatus.AVAILABLE }
    });
    const planned = await harness.service.applyJourneyFinalPlanDecision(
      harness.tx as never,
      harness.application.id,
      {
        finalPeriodMonths: 12,
        finalSubscriptionPlanId: harness.plan.id,
        finalVehicleId: harness.vehicle.id
      },
      harness.user,
      harness.context
    );
    await harness.tx.application.update({
      data: {
        customerConfirmedPlanRevision: planned.finalPlanRevision,
        planConfirmStatus: PlanConfirmStatus.CONFIRMED
      }
    });

    const result = await harness.service.allocateJourneyVehicle(
      harness.tx as never,
      harness.application.id,
      harness.vehicle.id,
      harness.user,
      harness.context
    );

    expect(result.requiresCustomerReconfirmation).toBe(false);
    expect(result.application.finalPlanRevision).toBe(1);
    expect(
      harness.journeySignal.requireCustomerReconfirmationAfterManualDecision
    ).not.toHaveBeenCalled();
  });

  it("rolls back the plan and vehicle hold when Journey publication fails", async () => {
    const harness = createApplicationReviewHarness({
      application: {
        ...readyToFinalizeApplication(),
        applicationSource: ApplicationSource.SALES_ASSISTED,
        softReservationExpiresAt: null,
        softReservedAt: null,
        softReservedVehicleId: null
      },
      vehicle: { status: VehicleStatus.AVAILABLE }
    });
    harness.journeySignal.completeFinalPlanAndVehicleAllocation.mockRejectedValueOnce(
      new Error("simulated journey failure")
    );

    await expect(
      harness.prisma.$transaction((tx: typeof harness.tx) =>
        harness.service.applyJourneyFinalPlanDecision(
          tx as never,
          harness.application.id,
          {
            finalPeriodMonths: 12,
            finalSubscriptionPlanId: harness.plan.id,
            finalVehicleId: harness.vehicle.id
          },
          harness.user,
          harness.context
        )
      )
    ).rejects.toThrow("simulated journey failure");

    expect(harness.state.application).toEqual(
      expect.objectContaining({
        finalPlanCommercialHash: null,
        finalPlanRevision: 0,
        softReservedVehicleId: null,
        vehicleReviewStatus: OrderReviewStatus.PENDING
      })
    );
    expect(harness.state.vehicleStatus).toBe(VehicleStatus.AVAILABLE);
  });

  it("allows only the first competing application to publish one vehicle", async () => {
    const harness = createApplicationReviewHarness({
      application: {
        ...readyToFinalizeApplication(),
        applicationSource: ApplicationSource.SALES_ASSISTED,
        softReservationExpiresAt: null,
        softReservedAt: null,
        softReservedVehicleId: null
      },
      vehicle: { status: VehicleStatus.AVAILABLE }
    });

    await harness.prisma.$transaction((tx: typeof harness.tx) =>
      harness.service.applyJourneyFinalPlanDecision(
        tx as never,
        harness.application.id,
        {
          finalPeriodMonths: 12,
          finalSubscriptionPlanId: harness.plan.id,
          finalVehicleId: harness.vehicle.id
        },
        harness.user,
        harness.context
      )
    );
    harness.state.application = makeApplication(
      new Date("2026-06-05T10:00:00.000Z"),
      {
        ...readyToFinalizeApplication(),
        applicationNo: "APP202606050002",
        applicationSource: ApplicationSource.SALES_ASSISTED,
        id: "application-2",
        softReservationExpiresAt: null,
        softReservedAt: null,
        softReservedVehicleId: null
      }
    );

    await expect(
      harness.prisma.$transaction((tx: typeof harness.tx) =>
        harness.service.applyJourneyFinalPlanDecision(
          tx as never,
          harness.state.application.id,
          {
            finalPeriodMonths: 12,
            finalSubscriptionPlanId: harness.plan.id,
            finalVehicleId: harness.vehicle.id
          },
          harness.user,
          harness.context
        )
      )
    ).rejects.toMatchObject({
      code: "JOURNEY_APPLICATION_VEHICLE_UNAVAILABLE"
    });
    expect(harness.state.vehicleStatus).toBe(VehicleStatus.REVIEW_RESERVED);
    expect(
      harness.journeySignal.completeFinalPlanAndVehicleAllocation
    ).toHaveBeenCalledOnce();
  });

  it("keeps the existing finalize endpoint as the journey final-plan decision entry", async () => {
    const harness = createApplicationReviewHarness({
      application: readyToFinalizeApplication(),
      journeyStep: SubscriptionJourneyStepCode.FINAL_PLAN_DECISION
    });

    const application = await harness.service.finalizeApplicationPlan(
      harness.application.id,
      harness.user,
      harness.context
    );

    expect(application).toEqual(
      expect.objectContaining({
        finalPlanRevision: 1,
        vehicleReviewStatus: OrderReviewStatus.APPROVED
      })
    );
    expect(
      harness.journeySignal.completeFinalPlanAndVehicleAllocation
    ).toHaveBeenCalledOnce();
    expect(harness.journeySignal.completeManualDecision).not.toHaveBeenCalled();
  });

  it("rejects journey vehicle allocation before exact customer confirmation", async () => {
    const harness = createApplicationReviewHarness({
      application: readyToFinalizeApplication()
    });
    await harness.service.applyJourneyFinalPlanDecision(
      harness.tx as never,
      harness.application.id,
      {},
      harness.user,
      harness.context
    );

    await expect(
      harness.service.allocateJourneyVehicle(
        harness.tx as never,
        harness.application.id,
        harness.vehicle.id,
        harness.user,
        harness.context
      )
    ).rejects.toMatchObject({
      code: "JOURNEY_CUSTOMER_PLAN_CONFIRMATION_REQUIRED"
    });
  });

  it("allocates a compatible confirmed vehicle once and completes the manual task", async () => {
    const harness = createApplicationReviewHarness({
      application: readyToFinalizeApplication()
    });
    const planned = await harness.service.applyJourneyFinalPlanDecision(
      harness.tx as never,
      harness.application.id,
      {},
      harness.user,
      harness.context
    );
    await harness.tx.application.update({
      data: {
        customerConfirmedPlanRevision: planned.finalPlanRevision,
        planConfirmStatus: PlanConfirmStatus.CONFIRMED
      }
    });

    const result = await harness.service.allocateJourneyVehicle(
      harness.tx as never,
      harness.application.id,
      harness.vehicle.id,
      harness.user,
      harness.context
    );

    expect(result.requiresCustomerReconfirmation).toBe(false);
    expect(result.application).toEqual(
      expect.objectContaining({
        customerConfirmedPlanRevision: 1,
        finalPlanRevision: 1,
        vehicleReviewStatus: OrderReviewStatus.APPROVED
      })
    );
    expect(harness.journeySignal.completeManualDecision).toHaveBeenLastCalledWith(
      harness.tx,
      {
        actorId: harness.user.id,
        applicationId: harness.application.id,
        expectedStepCode: "FINAL_VEHICLE_ALLOCATION",
        payload: {
          finalPlanRevision: 1,
          vehicleId: harness.vehicle.id
        }
      }
    );
    expect(harness.state.vehicleStatus).toBe(VehicleStatus.REVIEW_RESERVED);
  });

  it("does not request customer reconfirmation after JSONB only reorders final-plan keys", async () => {
    const harness = createApplicationReviewHarness({
      application: readyToFinalizeApplication()
    });
    const planned = await harness.service.applyJourneyFinalPlanDecision(
      harness.tx as never,
      harness.application.id,
      {},
      harness.user,
      harness.context
    );
    const reorderedSnapshot = Object.fromEntries(
      Object.entries(planned.finalPlanSnapshot as Record<string, unknown>).reverse()
    );
    await harness.tx.application.update({
      data: {
        customerConfirmedPlanRevision: planned.finalPlanRevision,
        finalPlanSnapshot: reorderedSnapshot,
        planConfirmStatus: PlanConfirmStatus.CONFIRMED
      }
    });

    const result = await harness.service.allocateJourneyVehicle(
      harness.tx as never,
      harness.application.id,
      harness.vehicle.id,
      harness.user,
      harness.context
    );

    expect(result.requiresCustomerReconfirmation).toBe(false);
    expect(result.application).toEqual(
      expect.objectContaining({
        customerConfirmedPlanRevision: 1,
        finalPlanRevision: 1,
        planConfirmStatus: PlanConfirmStatus.CONFIRMED
      })
    );
    expect(
      harness.journeySignal.requireCustomerReconfirmationAfterManualDecision
    ).not.toHaveBeenCalled();
  });

  it("keeps the existing vehicle-review endpoint as the journey allocation entry", async () => {
    const harness = createApplicationReviewHarness({
      application: readyToFinalizeApplication()
    });
    const planned = await harness.service.applyJourneyFinalPlanDecision(
      harness.tx as never,
      harness.application.id,
      {},
      harness.user,
      harness.context
    );
    await harness.tx.application.update({
      data: {
        customerConfirmedPlanRevision: planned.finalPlanRevision,
        planConfirmStatus: PlanConfirmStatus.CONFIRMED
      }
    });
    harness.state.journeyStep =
      SubscriptionJourneyStepCode.FINAL_VEHICLE_ALLOCATION;

    const application = await harness.service.reviewApplication(
      harness.application.id,
      "vehicle" as never,
      {
        finalVehicleId: harness.vehicle.id,
        status: OrderReviewStatus.APPROVED
      },
      harness.user,
      harness.context
    );

    expect(application).toEqual(
      expect.objectContaining({
        finalPlanRevision: 1,
        vehicleReviewStatus: OrderReviewStatus.APPROVED
      })
    );
    expect(harness.journeySignal.completeManualDecision).toHaveBeenCalledOnce();
  });

  it("keeps the allocated vehicle held while changed terms wait for reconfirmation", async () => {
    const harness = createApplicationReviewHarness({
      application: readyToFinalizeApplication()
    });
    const planned = await harness.service.applyJourneyFinalPlanDecision(
      harness.tx as never,
      harness.application.id,
      {},
      harness.user,
      harness.context
    );
    await harness.tx.application.update({
      data: {
        customerConfirmedPlanRevision: planned.finalPlanRevision,
        planConfirmStatus: PlanConfirmStatus.CONFIRMED
      }
    });
    harness.vehicle.currentSalePriceAmount += 100000n;

    const result = await harness.service.allocateJourneyVehicle(
      harness.tx as never,
      harness.application.id,
      harness.vehicle.id,
      harness.user,
      harness.context
    );

    expect(result.requiresCustomerReconfirmation).toBe(true);
    expect(result.application).toEqual(
      expect.objectContaining({
        customerConfirmedPlanRevision: null,
        finalPlanRevision: 2,
        planConfirmStatus: PlanConfirmStatus.PENDING,
        softReservedVehicleId: harness.vehicle.id,
        vehicleReviewStatus: OrderReviewStatus.APPROVED
      })
    );
    expect(harness.state.vehicleStatus).toBe(VehicleStatus.REVIEW_RESERVED);
    expect(
      harness.journeySignal.requireCustomerReconfirmationAfterManualDecision
    ).toHaveBeenCalledWith(harness.tx, {
      actorId: harness.user.id,
      applicationId: harness.application.id,
      finalPlanRevision: 2,
      vehicleId: harness.vehicle.id
    });
    expect(harness.journeySignal.completeManualDecision).not.toHaveBeenCalled();
  });

  it("transfers the review hold to a different available final vehicle before reconfirmation", async () => {
    const harness = createApplicationReviewHarness({
      application: readyToFinalizeApplication()
    });
    const planned = await harness.service.applyJourneyFinalPlanDecision(
      harness.tx as never,
      harness.application.id,
      {},
      harness.user,
      harness.context
    );
    await harness.tx.application.update({
      data: {
        customerConfirmedPlanRevision: planned.finalPlanRevision,
        planConfirmStatus: PlanConfirmStatus.CONFIRMED,
        softReservedVehicleId: "vehicle-old"
      }
    });
    harness.state.vehicleStatus = VehicleStatus.AVAILABLE;
    harness.vehicle.currentSalePriceAmount += 100000n;
    harness.tx.vehicle.findUnique.mockImplementation(
      async (...args: unknown[]) =>
        (args[0] as { where: { id: string } }).where.id === "vehicle-old"
          ? {
              ...harness.vehicle,
              id: "vehicle-old",
              status: VehicleStatus.REVIEW_RESERVED
            }
          : { ...harness.vehicle, status: harness.state.vehicleStatus }
    );

    const result = await harness.service.allocateJourneyVehicle(
      harness.tx as never,
      harness.application.id,
      harness.vehicle.id,
      harness.user,
      harness.context
    );

    expect(result.requiresCustomerReconfirmation).toBe(true);
    expect(result.application).toEqual(
      expect.objectContaining({
        softReservedVehicleId: harness.vehicle.id,
        vehicleReviewStatus: OrderReviewStatus.APPROVED
      })
    );
    expect(harness.tx.vehicle.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: VehicleStatus.REVIEW_RESERVED }),
        where: expect.objectContaining({
          id: harness.vehicle.id,
          status: VehicleStatus.AVAILABLE
        })
      })
    );
    expect(harness.tx.vehicle.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: VehicleStatus.AVAILABLE }),
        where: { id: "vehicle-old" }
      })
    );
  });

  it("does not release the previous hold when the new final vehicle is unavailable", async () => {
    const harness = createApplicationReviewHarness({
      application: readyToFinalizeApplication()
    });
    const planned = await harness.service.applyJourneyFinalPlanDecision(
      harness.tx as never,
      harness.application.id,
      {},
      harness.user,
      harness.context
    );
    await harness.tx.application.update({
      data: {
        customerConfirmedPlanRevision: planned.finalPlanRevision,
        planConfirmStatus: PlanConfirmStatus.CONFIRMED,
        softReservedVehicleId: "vehicle-old"
      }
    });
    harness.state.vehicleStatus = VehicleStatus.RESERVED;
    harness.tx.vehicle.findUnique.mockImplementation(
      async (...args: unknown[]) =>
        (args[0] as { where: { id: string } }).where.id === "vehicle-old"
          ? {
              ...harness.vehicle,
              id: "vehicle-old",
              status: VehicleStatus.REVIEW_RESERVED
            }
          : { ...harness.vehicle, status: harness.state.vehicleStatus }
    );

    await expect(
      harness.service.allocateJourneyVehicle(
        harness.tx as never,
        harness.application.id,
        harness.vehicle.id,
        harness.user,
        harness.context
      )
    ).rejects.toMatchObject({
      code: "JOURNEY_APPLICATION_VEHICLE_UNAVAILABLE"
    });

    expect(harness.tx.vehicle.update).not.toHaveBeenCalled();
    expect(harness.state.application.softReservedVehicleId).toBe("vehicle-old");
  });

  it("rejects finalizing when the selected plan is inactive", async () => {
    const harness = createApplicationReviewHarness({
      application: readyToFinalizeApplication(),
      plan: { status: SubscriptionPlanStatus.INACTIVE }
    });

    await expect(
      harness.service.finalizeApplicationPlan(
        harness.application.id,
        harness.user,
        harness.context
      )
    ).rejects.toThrow("所选订阅套餐当前不可用");

    expect(harness.state.application.productReviewStatus).toBe(OrderReviewStatus.PENDING);
    expect(harness.state.application.vehicleReviewStatus).toBe(OrderReviewStatus.PENDING);
  });

  it("rejects finalizing when the vehicle is no longer review-reserved by the application", async () => {
    const harness = createApplicationReviewHarness({
      application: readyToFinalizeApplication(),
      vehicle: { status: VehicleStatus.AVAILABLE }
    });

    await expect(
      harness.service.finalizeApplicationPlan(
        harness.application.id,
        harness.user,
        harness.context
      )
    ).rejects.toThrow("当前车辆不再处于审核占用状态，请重新选择车辆。");

    expect(harness.state.application.productReviewStatus).toBe(OrderReviewStatus.PENDING);
    expect(harness.state.application.vehicleReviewStatus).toBe(OrderReviewStatus.PENDING);
  });

  it("creates an official quote and order, then locks the vehicle as reserved", async () => {
    const harness = createApplicationReviewHarness({
      application: readyToCreateOrderApplication(),
      vehicle: {
        modelDefinition: {
          displayName: "NIO ET5 Final Plan",
          id: "model-et5",
          modelCode: "NIO_ET5"
        },
        modelDefinitionId: "model-et5"
      }
    });

    const result = await harness.service.createOrderFromApplication(
      harness.application.id,
      harness.user,
      harness.context
    );

    expect(result).toEqual(
      expect.objectContaining({
        orderId: "order-1",
        orderStatus: OrderStatus.PENDING_CONTRACT,
        quoteId: "quote-1",
        vehicleStatus: VehicleStatus.RESERVED
      })
    );
    expect(harness.tx.subscriptionQuote.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          depositAmount: 300000n,
          modelCodeSnapshot: "NIO_ET5",
          modelDefinitionIdSnapshot: "model-et5",
          modelDisplayNameSnapshot: "NIO ET5 Final Plan",
          status: QuoteStatus.CONFIRMED,
          subscriptionPlanId: harness.plan.id,
          vehicleId: harness.vehicle.id
        })
      })
    );
    expect(harness.tx.subscriptionOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          depositAmount: 300000n,
          finalDepositAmount: 300000n,
          modelCodeSnapshot: "NIO_ET5",
          modelDefinitionIdSnapshot: "model-et5",
          modelDisplayNameSnapshot: "NIO ET5 Final Plan",
          orderSource: OrderSource.CUSTOMER_SELF_SERVICE,
          orderStatus: OrderStatus.PENDING_CONTRACT,
          quoteId: "quote-1",
          vehicleId: harness.vehicle.id
        })
      })
    );
    expect(harness.state.vehicleStatus).toBe(VehicleStatus.RESERVED);
    expect(harness.assetOperationsService.assertVehicleAvailable).toHaveBeenCalledWith(
      harness.tx,
      harness.vehicle.id,
      VehicleAvailabilityPurpose.ALLOCATION,
      expect.any(Date),
      VehicleStatus.AVAILABLE
    );
  });

  it("creates and reuses a journey order in the caller transaction", async () => {
    const harness = createApplicationReviewHarness({
      application: {
        ...readyToCreateOrderApplication(),
        customerConfirmedPlanRevision: 1,
        finalPlanRevision: 1
      }
    });

    const first = await harness.service.createOrderFromApplicationInTransaction(
      harness.tx as never,
      harness.application.id,
      harness.user,
      harness.context
    );
    const second = await harness.service.createOrderFromApplicationInTransaction(
      harness.tx as never,
      harness.application.id,
      harness.user,
      harness.context
    );

    expect(first.id).toBe("order-1");
    expect(second.id).toBe(first.id);
    expect(harness.tx.subscriptionQuote.create).toHaveBeenCalledOnce();
    expect(harness.tx.subscriptionOrder.create).toHaveBeenCalledOnce();
    expect(harness.prisma.$transaction).not.toHaveBeenCalled();
    expect(harness.state.vehicleStatus).toBe(VehicleStatus.RESERVED);
    expect(harness.assetOperationsService.assertVehicleAvailable).toHaveBeenCalledWith(
      harness.tx,
      harness.vehicle.id,
      VehicleAvailabilityPurpose.ALLOCATION,
      expect.any(Date),
      VehicleStatus.AVAILABLE
    );
  });

  it("rejects a stale confirmed plan revision before journey order creation", async () => {
    const harness = createApplicationReviewHarness({
      application: {
        ...readyToCreateOrderApplication(),
        customerConfirmedPlanRevision: 1,
        finalPlanRevision: 2
      }
    });

    await expect(
      harness.service.createOrderFromApplicationInTransaction(
        harness.tx as never,
        harness.application.id,
        harness.user,
        harness.context
      )
    ).rejects.toMatchObject({ code: "FINAL_PLAN_REVISION_STALE" });
    expect(harness.tx.subscriptionOrder.create).not.toHaveBeenCalled();
  });

  it("rejects a journey order without a concrete allocated vehicle", async () => {
    const harness = createApplicationReviewHarness({
      application: {
        ...readyToCreateOrderApplication(),
        customerConfirmedPlanRevision: 1,
        finalPlanRevision: 1,
        softReservedVehicleId: null
      }
    });

    await expect(
      harness.service.createOrderFromApplicationInTransaction(
        harness.tx as never,
        harness.application.id,
        harness.user,
        harness.context
      )
    ).rejects.toMatchObject({ code: "JOURNEY_APPLICATION_VEHICLE_UNAVAILABLE" });
    expect(harness.tx.subscriptionOrder.create).not.toHaveBeenCalled();
  });

  it("rejects a non-subscription product before journey order creation", async () => {
    const harness = createApplicationReviewHarness({
      application: {
        ...readyToCreateOrderApplication(),
        customerConfirmedPlanRevision: 1,
        finalPlanRevision: 1
      },
      plan: {
        product: {
          deletedAt: null,
          id: "product-1",
          name: "Rent to own",
          productNo: "RTO001",
          productType: ProductType.RENT_TO_OWN,
          status: ProductStatus.ACTIVE
        }
      }
    });

    await expect(
      harness.service.createOrderFromApplicationInTransaction(
        harness.tx as never,
        harness.application.id,
        harness.user,
        harness.context
      )
    ).rejects.toMatchObject({ code: "JOURNEY_APPLICATION_PRODUCT_INVALID" });
    expect(harness.tx.subscriptionOrder.create).not.toHaveBeenCalled();
  });

  it("disallows duplicate order creation for an application", async () => {
    const harness = createApplicationReviewHarness({
      application: {
        ...readyToCreateOrderApplication(),
        orders: [
          {
            deletedAt: null,
            id: "order-existing",
            orderNo: "ORD202606050001",
            orderStatus: OrderStatus.PENDING_CONTRACT
          }
        ]
      }
    });

    await expect(
      harness.service.createOrderFromApplication(
        harness.application.id,
        harness.user,
        harness.context
      )
    ).rejects.toThrow("该进件已生成订单，请勿重复处理。");

    expect(harness.tx.subscriptionOrder.create).not.toHaveBeenCalled();
  });

  it("keeps sales-assisted applications out of the self-service review queue", async () => {
    const harness = createApplicationReviewHarness({
      application: {
        applicationSource: ApplicationSource.SALES_ASSISTED
      }
    });

    await harness.service.listApplicationReviewQueue(harness.user);

    expect(harness.prisma.application.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          applicationSource: ApplicationSource.SELF_SERVICE
        })
      })
    );
  });
});

function createApplicationReviewHarness(overrides: {
  application?: Record<string, unknown>;
  customer?: Record<string, unknown>;
  journeyStep?: SubscriptionJourneyStepCode;
  plan?: Record<string, unknown> & { vehiclePackage?: Record<string, unknown> };
  vehicle?: Record<string, unknown>;
} = {}) {
  const now = new Date("2026-06-05T10:00:00.000Z");
  const user = {
    id: "00000000-0000-4000-8000-000000000001",
    menus: [],
    name: "Admin",
    permissions: ["application:review", "order:create", "quote:create"],
    roles: ["ADMIN"],
    username: "admin"
  };
  const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };
  const state: {
    application: ReturnType<typeof makeApplication>;
    customer: ReturnType<typeof makeCustomer>;
    journeyStep?: SubscriptionJourneyStepCode;
    vehicleStatus: VehicleStatus;
  } = {
    application: makeApplication(now, overrides.application),
    customer: makeCustomer(now, overrides.customer),
    journeyStep: overrides.journeyStep,
    vehicleStatus: VehicleStatus.REVIEW_RESERVED
  };
  const vehicle = makeVehicle(now, { status: state.vehicleStatus, ...overrides.vehicle });
  state.vehicleStatus = vehicle.status;
  const plan = makePlan(now, overrides.plan);
  let createdOrder: Record<string, unknown> | null = null;

  const tx = {
    $queryRaw: vi.fn(async () => [{ id: state.application.id }]),
    application: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.application = makeApplication(now, {
          ...state.application,
          ...data,
          createdAt: now,
          id: "application-created",
          status: data.status ?? ApplicationStatus.DRAFT
        });
        return state.application;
      }),
      findUniqueOrThrow: vi.fn(async () => state.application),
      findUnique: vi.fn(async () => state.application),
      update: vi.fn(async ({ data, select }: { data: Record<string, unknown>; select?: Record<string, boolean> }) => {
        const nextData = { ...data };
        const factVersion = data.journeyFactVersion;
        if (
          typeof factVersion === "object" &&
          factVersion !== null &&
          "increment" in factVersion
        ) {
          nextData.journeyFactVersion =
            Number(state.application.journeyFactVersion) +
            Number((factVersion as { increment: number }).increment);
        }
        state.application = makeApplication(now, { ...state.application, ...nextData });
        if (!select) return state.application;
        return Object.fromEntries(
          Object.entries(select)
            .filter(([, included]) => included)
            .map(([key]) => [key, state.application[key as keyof typeof state.application]])
        );
      })
    },
    applicationActionLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...data,
        id: "application-action-1"
      }))
    },
    customer: {
      findUnique: vi.fn(async () => state.customer),
      findUniqueOrThrow: vi.fn(async () => state.customer),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.customer = { ...state.customer, ...data };
        return state.customer;
      })
    },
    customerIdentity: {
      upsert: vi.fn(async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
        state.customer = {
          ...state.customer,
          identity: {
            ...(state.customer.identity ?? {}),
            ...create,
            ...update
          }
        };
        state.application = makeApplication(now, {
          ...state.application,
          customer: makeCustomerForApplication({
            identity: state.customer.identity,
            mobile: state.customer.mobile,
            name: state.customer.name
          })
        });
        return state.customer.identity;
      })
    },
    depositRule: {
      findFirst: vi.fn(async () => ({
        createdAt: now,
        createdBy: user.id,
        customerRatio: null,
        defaultRate: new Prisma.Decimal("0.100000"),
        deletedAt: null,
        depositAmount: 300000n,
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        effectiveTo: null,
        grade: CustomerGrade.A,
        id: "deposit-rule-1",
        status: RecordStatus.ACTIVE,
        updatedAt: now,
        updatedBy: user.id
      }))
    },
    subscriptionOrder: {
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        createdOrder = {
          ...data,
          createdAt: now,
          deletedAt: null,
          id: "order-1",
          orderNo: "ORD202606050001",
          updatedAt: now
        };
        state.application = makeApplication(now, {
          ...state.application,
          orders: [
            {
              deletedAt: null,
              id: "order-1",
              orderNo: "ORD202606050001",
              orderStatus: data.orderStatus
            }
          ]
        });
        return createdOrder;
      }),
      findUnique: vi.fn(async () => createdOrder)
    },
    subscriptionJourney: {
      findUnique: vi.fn(async () =>
        state.journeyStep
          ? { currentStepCode: state.journeyStep, id: "journey-1" }
          : null
      )
    },
    subscriptionPlan: {
      findUnique: vi.fn(async () => plan)
    },
    subscriptionQuote: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...data,
        createdAt: now,
        deletedAt: null,
        id: "quote-1",
        quoteNo: "QUO202606050001",
        updatedAt: now
      }))
    },
    vehicle: {
      findUnique: vi.fn(async () => ({ ...vehicle, status: state.vehicleStatus })),
      findUniqueOrThrow: vi.fn(async () => ({ ...vehicle, status: state.vehicleStatus })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.vehicleStatus = data.status as VehicleStatus;
        return { ...vehicle, status: state.vehicleStatus, updatedBy: data.updatedBy };
      }),
      updateMany: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: Record<string, unknown> }) => {
        if (state.vehicleStatus !== where.status) {
          return { count: 0 };
        }
        state.vehicleStatus = data.status as VehicleStatus;
        return { count: 1 };
      })
    }
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => {
      const applicationBefore = state.application;
      const vehicleStatusBefore = state.vehicleStatus;
      try {
        return await callback(tx);
      } catch (error) {
        state.application = applicationBefore;
        state.vehicleStatus = vehicleStatusBefore;
        throw error;
      }
    }),
    application: {
      findMany: vi.fn(async () =>
        state.application.applicationSource === ApplicationSource.SELF_SERVICE
          ? [state.application]
          : []
      ),
      findUnique: vi.fn(async () => state.application)
    },
    customer: {
      findUnique: vi.fn(async () => state.customer)
    }
  };
  const auditService = { write: vi.fn(async () => undefined) };
  const journeySignal = {
    completeFinalPlanAndVehicleAllocation: vi.fn(async () => undefined),
    completeManualDecision: vi.fn(async () => undefined),
    record: vi.fn(async () => undefined),
    requireCustomerReconfirmationAfterManualDecision: vi.fn(
      async () => undefined
    ),
    terminateApplication: vi.fn(async () => undefined)
  };
  const riskService = {
    createApprovalRiskResult: vi.fn(async (_tx: typeof tx, input: ApprovalRiskInput) => ({
      applicationId: input.applicationId,
      approvedAt: input.approvedAt,
      approvedBy: input.operatorId,
      approvedDepositAmount: 300000n,
      approver: {
        id: user.id,
        name: user.name,
        username: user.username
      },
      createdAt: now,
      customerId: input.customerId,
      defaultRate: new Prisma.Decimal("0.100000"),
      grade: input.grade,
      id: "risk-result-1",
      maxVehiclePurchasePriceAmount:
        input.maxVehiclePurchasePriceAmount === undefined
          ? null
          : BigInt(input.maxVehiclePurchasePriceAmount),
      remark: input.remark ?? null,
      result: RiskResultDecision.APPROVED,
      score: input.riskScore ?? null,
      updatedAt: now
    }))
  };
  const notificationService = { notifyCustomer: vi.fn(async () => []) };
  const assetOperationsService = {
    assertVehicleAvailable: vi.fn(async () => undefined)
  };
  const service = new CustomerService(
    auditService as never,
    prisma as never,
    riskService as never,
    {} as never,
    notificationService as never,
    journeySignal as never,
    assetOperationsService as never
  );

  return {
    application: state.application,
    assetOperationsService,
    auditService,
    context,
    journeySignal,
    notificationService,
    plan,
    prisma,
    riskService,
    service,
    state,
    tx,
    user,
    vehicle
  };
}

function readyToFinalizeApplication() {
  return {
    creditReviewStatus: OrderReviewStatus.APPROVED,
    customerGrade: CustomerGrade.A,
    depositRuleId: "deposit-rule-1",
    depositRuleSnapshot: { depositAmount: 300000 },
    depositStatus: DepositStatus.CONFIRMED,
    finalDepositAmount: 300000n,
    materialReviewStatus: OrderReviewStatus.APPROVED,
    productReviewStatus: OrderReviewStatus.PENDING,
    vehicleReviewStatus: OrderReviewStatus.PENDING
  };
}

function approvedRequiredMaterialGroups(now: Date) {
  const operator = {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Admin",
    username: "admin"
  };

  return [
    ApplicationMaterialType.ID_CARD,
    ApplicationMaterialType.DRIVER_LICENSE,
    ApplicationMaterialType.CREDIT_AUTH
  ].map((materialType, index) => {
    const id = `material-group-${index + 1}`;

    return {
      applicationId: "application-1",
      createdAt: now,
      createdBy: operator.id,
      deletedAt: null,
      files: [
        {
          applicationId: "application-1",
          createdAt: now,
          createdBy: operator.id,
          deletedAt: null,
          deleteReason: null,
          deleter: null,
          fileId: `file-${index + 1}`,
          fileName: `material-${index + 1}.png`,
          id: `material-file-${index + 1}`,
          isDeleted: false,
          materialGroupId: id,
          materialType,
          mimeType: "image/png",
          sizeBytes: 1024n,
          updatedAt: now,
          updatedBy: operator.id,
          uploadedAt: now,
          uploadedBy: operator.id,
          uploader: operator
        }
      ],
      id,
      materialName: null,
      materialType,
      required: true,
      reviewComment: "已通过",
      reviewedAt: now,
      reviewedBy: operator.id,
      reviewer: operator,
      reviewStatus: MaterialStatus.APPROVED,
      updatedAt: now,
      updatedBy: operator.id
    };
  });
}

function readyToCreateOrderApplication() {
  return {
    approvedAt: new Date("2026-06-05T10:30:00.000Z"),
    creditReviewStatus: OrderReviewStatus.APPROVED,
    customerGrade: CustomerGrade.A,
    depositRuleId: "deposit-rule-1",
    depositRuleSnapshot: { depositAmount: 300000 },
    depositStatus: DepositStatus.CONFIRMED,
    finalDepositAmount: 300000n,
    finalPeriodMonths: 12,
    finalPlanConfirmedAt: new Date("2026-06-05T10:40:00.000Z"),
    finalPlanSnapshot: {
      depositAmount: 300000,
      subscriptionPlanId: "plan-1",
      vehicleId: "vehicle-1"
    },
    finalSubscriptionPlanId: "plan-1",
    finalVehicleBaseFeeAmount: 700000n,
    finalVehicleId: "vehicle-1",
    materialReviewStatus: OrderReviewStatus.APPROVED,
    planConfirmStatus: PlanConfirmStatus.CONFIRMED,
    productReviewStatus: OrderReviewStatus.APPROVED,
    status: ApplicationStatus.APPROVED,
    vehicleReviewStatus: OrderReviewStatus.APPROVED
  };
}

function makeApplication(now: Date, overrides: Record<string, unknown> = {}) {
  return {
    actionLogs: [],
    applicationNo: "APP202606050001",
    applicationSource: ApplicationSource.SELF_SERVICE,
    approvedAt: null,
    createdAt: now,
    createdBy: "00000000-0000-4000-8000-000000000001",
    creditReviewComment: null,
    creditReviewStatus: OrderReviewStatus.PENDING,
    customer: makeCustomerForApplication(),
    customerGrade: null,
    customerId: "customer-1",
    customerSelectedSnapshot: {
      periodMonths: 12,
      subscriptionPlanId: "plan-1",
      vehicleId: "vehicle-1"
    },
    customerProfileSnapshot: null,
    deletedAt: null,
    depositRuleId: null,
    depositRuleSnapshot: null,
    depositStatus: DepositStatus.PENDING_CONFIRM,
    finalDepositAmount: null,
    finalPeriodMonths: null,
    finalPlanCommercialHash: null,
    finalPlanConfirmedAt: null,
    finalPlanRevision: 0,
    customerConfirmedPlanRevision: null,
    finalPlanSnapshot: null,
    finalQuoteSnapshot: null,
    finalSubscriptionPlanId: null,
    finalVehicleBaseFeeAmount: null,
    finalVehicleId: null,
    id: "application-1",
    intentPeriodMonths: 12,
    intentSnapshot: {
      periodMonths: 12,
      subscriptionPlanId: "plan-1",
      vehicleId: "vehicle-1"
    },
    intentSubscriptionPlanId: "plan-1",
    intentVehicleBaseFeeAmount: 700000n,
    intentVehicleId: "vehicle-1",
    intendedModel: "NIO_ET5",
    intendedPeriodMonths: 12,
    journeyFactVersion: 0,
    materialGroups: [],
    materialReviewStatus: OrderReviewStatus.PENDING,
    materials: [],
    orders: [],
    planConfirmStatus: PlanConfirmStatus.PENDING,
    productReviewStatus: OrderReviewStatus.PENDING,
    rejectedReason: null,
    riskResults: [],
    salesUser: {
      id: "00000000-0000-4000-8000-000000000001",
      name: "Admin",
      username: "admin"
    },
    salesUserId: "00000000-0000-4000-8000-000000000001",
    softReservationExpiresAt: new Date("2026-06-06T10:00:00.000Z"),
    softReservedAt: now,
    softReservedVehicleId: "vehicle-1",
    status: ApplicationStatus.SUBMITTED,
    submittedAt: now,
    updatedAt: now,
    updatedBy: "00000000-0000-4000-8000-000000000001",
    vehicleReviewStatus: OrderReviewStatus.PENDING,
    ...overrides
  };
}

function makeCustomer(now: Date, overrides: Record<string, unknown> = {}) {
  return {
    applications: [],
    createdAt: now,
    createdBy: "00000000-0000-4000-8000-000000000001",
    customerNo: "CUS202606050001",
    customerType: "PERSONAL",
    deletedAt: null,
    grade: null as CustomerGrade | null,
    id: "customer-1",
    identity: {
      idCardNo: "11010519491231002X"
    },
    mobile: "13800000000",
    name: "测试客户",
    ownerUser: null,
    ownerUserId: null,
    profile: completeCustomerProfile(now),
    riskScore: null,
    sourceChannel: null,
    status: CustomerStatus.PENDING_APPLICATION,
    updatedAt: now,
    updatedBy: "00000000-0000-4000-8000-000000000001",
    ...overrides
  };
}

function makeCustomerForApplication(overrides: Record<string, unknown> = {}) {
  return {
    customerNo: "CUS202606050001",
    id: "customer-1",
    identity: { idCardNo: "11010519491231002X" },
    mobile: "13800000000",
    name: "测试客户",
    ownerUserId: null,
    profile: completeCustomerProfile(new Date("2026-06-05T10:00:00.000Z")),
    sourceChannel: null,
    status: CustomerStatus.PENDING_APPLICATION,
    ...overrides
  };
}

function completeCustomerProfile(now: Date) {
  return {
    emergencyContactMobile: "13900000000",
    emergencyContactName: "王女士",
    residenceAddress: "上海市闵行区北翟路1554弄53号",
    residenceCity: "上海市",
    residenceDetail: "北翟路1554弄53号",
    residenceDistrict: "闵行区",
    residenceProvince: "上海市",
    updatedAt: now
  };
}

function makeVehicle(now: Date, overrides: Record<string, unknown> = {}) {
  return {
    assetLocation: "上海",
    batteryCapacityKwh: new Prisma.Decimal(75),
    batteryUsageType: VehicleBatteryUsageType.BUYOUT,
    brand: "NIO",
    createdAt: now,
    createdBy: "00000000-0000-4000-8000-000000000001",
    currentMileageKm: 12000,
    currentSalePriceAmount: 20000000n,
    currentSalePriceInitializedAt: now,
    currentSalePriceReviewedAt: now,
    deletedAt: null,
    id: "vehicle-1",
    model: "ET5",
    modelDefinition: {
      displayName: "NIO ET5",
      id: "model-et5",
      modelCode: "NIO_ET5"
    },
    modelDefinitionId: "model-et5",
    modelYear: 2024,
    nextSalePriceReviewAt: null,
    plateNo: "沪A00001",
    purchaseDate: now,
    purchasePriceAmount: 18000000n,
    registrationDate: null,
    remark: null,
    salePriceReinitRequiredAt: null,
    salePriceStatus: SalePriceStatus.EFFECTIVE,
    series: "ET5",
    status: VehicleStatus.REVIEW_RESERVED,
    updatedAt: now,
    updatedBy: "00000000-0000-4000-8000-000000000001",
    vehicleNo: "VEH202606050001",
    vin: "VIN202606050001",
    ...overrides
  };
}

function makePlan(now: Date, overrides: Record<string, unknown> & { vehiclePackage?: Record<string, unknown> } = {}) {
  const { vehiclePackage: vehiclePackageOverrides, ...planOverrides } = overrides;
  const product = {
    deletedAt: null,
    id: "product-1",
    name: "订阅产品",
    productNo: "PROD001",
    productType: ProductType.SUBSCRIPTION,
    status: ProductStatus.ACTIVE
  };
  const productVersion = {
    deletedAt: null,
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    effectiveTo: null,
    id: "product-version-1",
    productId: product.id,
    status: ProductVersionStatus.ACTIVE,
    versionNo: "V1"
  };
  const packageBase = {
    createdAt: now,
    createdBy: "00000000-0000-4000-8000-000000000001",
    deletedAt: null,
    product,
    productId: product.id,
    productVersion,
    productVersionId: productVersion.id,
    remark: null,
    status: RecordStatus.ACTIVE,
    updatedAt: now,
    updatedBy: "00000000-0000-4000-8000-000000000001"
  };

  return {
    baseMonthlyFeeAmount: null,
    benefitPackage: null,
    benefitPackageId: null,
    createdAt: now,
    createdBy: "00000000-0000-4000-8000-000000000001",
    deletedAt: null,
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    effectiveTo: null,
    energyPackage: {
      ...packageBase,
      id: "energy-package-1",
      monthlyEnergyCount: 6,
      monthlyEnergyKwh: null,
      packageName: "补能包",
      packageNo: "ENE001",
      priceAmount: 80000n,
      serviceDescription: null,
      stationScope: null
    },
    energyPackageId: "energy-package-1",
    id: "plan-1",
    maxPeriodMonths: 36,
    mileagePackage: {
      ...packageBase,
      id: "mileage-package-1",
      monthlyMileageKm: 1500,
      overMileageFeeAmount: 100n,
      packageName: "里程包",
      packageNo: "MIL001",
      priceAmount: 120000n
    },
    mileagePackageId: "mileage-package-1",
    minPeriodMonths: 6,
    monthlyFeeCapRate: null,
    monthlyFeeMode: MonthlyFeeMode.RATE_FORMULA,
    monthlyFeeRate: new Prisma.Decimal("0.035"),
    planName: "12期套餐",
    planNo: "PLAN001",
    product,
    productId: product.id,
    productVersion,
    productVersionId: productVersion.id,
    remark: null,
    status: SubscriptionPlanStatus.ACTIVE,
    updatedAt: now,
    updatedBy: "00000000-0000-4000-8000-000000000001",
    vehiclePackage: {
      ...packageBase,
      brand: "NIO",
      configName: "标准",
      id: "vehicle-package-1",
      maxPeriodMonths: 36,
      maxPurchasePriceAmount: null,
      minPeriodMonths: 6,
      minPurchasePriceAmount: null,
      monthlyFeeRate: new Prisma.Decimal("0.035"),
      packageName: "车型包",
      packageNo: "VEH001",
      series: "ET5",
      modelDefinition: {
        displayName: "NIO ET5",
        id: "model-et5",
        modelCode: "NIO_ET5"
      },
      modelDefinitionId: "model-et5",
      modelMembers: [
        {
          modelDefinitionId:
            (vehiclePackageOverrides?.modelDefinitionId as string | undefined) ?? "model-et5"
        }
      ],
      vehicleModelName: "ET5",
      ...vehiclePackageOverrides
    },
    vehiclePackageId: "vehicle-package-1",
    ...planOverrides
  };
}
