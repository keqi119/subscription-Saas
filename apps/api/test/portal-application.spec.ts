import {
  ApplicationActionType,
  ApplicationMaterialType,
  ApplicationSource,
  ApplicationStatus,
  CustomerProfileMaterialStatus,
  CustomerProfileMaterialType,
  DepositStatus,
  MaterialStatus,
  MonthlyFeeMode,
  OrderReviewStatus,
  OrderMileageReviewStatus,
  OrderStatus,
  PlanConfirmStatus,
  Prisma,
  ProductStatus,
  ProductType,
  ProductVersionStatus,
  RecordStatus,
  SalePriceStatus,
  SubscriptionPlanStatus,
  UserStatus,
  VehicleBatteryUsageType,
  VehicleHandoverType,
  VehicleHandoverWorkOrderStatus,
  VehicleStatus
} from "@prisma/client";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { TEST_MODEL_CODES } from "./helpers/vehicle-model-codes";

import { PortalApplicationService } from "../src/portal/portal-application.service";
import { PortalCatalogService } from "../src/portal/portal-catalog.service";

describe("PortalCatalogService", () => {
  it("lists public vehicles without internal asset fields", async () => {
    const prisma = createCatalogPrisma();
    const service = new PortalCatalogService(prisma as never);

    const rows = await service.listVehicles();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      available: true,
      brand: "NIO",
      displayName: "NIO ES6 ES6 2025款",
      statusLabel: "可申请"
    });
    expect(rows[0]).not.toHaveProperty("purchasePriceAmount");
    expect(rows[0]).not.toHaveProperty("vin");
    expect(rows[0]).not.toHaveProperty("plateNo");
    expect(rows[0]).not.toHaveProperty("currentSalePriceAmount");
  });

  it("returns active subscription plans for a public vehicle", async () => {
    const prisma = createCatalogPrisma();
    const service = new PortalCatalogService(prisma as never);

    const detail = await service.getVehicle("vehicle-1");

    expect(detail.subscriptionPlans).toHaveLength(1);
    expect(detail.subscriptionPlans[0]).toEqual(
      expect.objectContaining({
        canSubmit: true,
        depositDescription: "押金金额将根据审核结果最终确认。",
        monthlyFeeAmount: 735000,
        planId: "plan-1",
        planName: "安心订阅 12 个月"
      })
    );
  });
});

describe("PortalApplicationService", () => {
  it("sorts customer application actions before processing and terminal records", async () => {
    const harness = createPortalApplicationFixture();
    const upload = createApplication({
      id: "application-upload",
      applicationNo: "APP-UPLOAD",
      status: ApplicationStatus.NEED_MORE_INFO,
      updatedAt: new Date("2026-08-08T00:00:00Z")
    });
    const confirm = createApplication({
      ...readyFinalPlanApplication(),
      id: "application-confirm",
      applicationNo: "APP-CONFIRM",
      updatedAt: new Date("2026-08-09T00:00:00Z")
    });
    const processing = createApplication({
      id: "application-processing",
      applicationNo: "APP-PROCESSING",
      status: ApplicationStatus.SUBMITTED,
      updatedAt: new Date("2026-08-10T00:00:00Z")
    });
    const cancelled = createApplication({
      id: "application-cancelled",
      applicationNo: "APP-CANCELLED",
      status: ApplicationStatus.CANCELLED,
      updatedAt: new Date("2026-08-11T00:00:00Z")
    });
    vi.mocked(harness.prisma.application.findMany).mockResolvedValue([
      cancelled,
      processing,
      upload,
      confirm
    ] as never);

    const result = await harness.service.listApplications(currentCustomer("customer-1"));

    expect(result.map((item) => item.applicationNo)).toEqual([
      "APP-CONFIRM",
      "APP-UPLOAD",
      "APP-PROCESSING",
      "APP-CANCELLED"
    ]);
  });

  it("sinks an application whose latest order is terminal", async () => {
    const harness = createPortalApplicationFixture();
    const terminalOrderApplication = createApplication({
      ...readyFinalPlanApplication({ planConfirmStatus: PlanConfirmStatus.CONFIRMED }),
      id: "application-completed",
      orders: [{
        contractId: "contract-1",
        deletedAt: null,
        handoverWorkOrders: [],
        id: "order-completed",
        mileageReviews: [],
        orderNo: "ORD-COMPLETED",
        orderStatus: OrderStatus.COMPLETED
      }]
    });
    const processing = createApplication({
      id: "application-processing",
      status: ApplicationStatus.SUBMITTED
    });
    vi.mocked(harness.prisma.application.findMany).mockResolvedValue([
      terminalOrderApplication,
      processing
    ] as never);

    const result = await harness.service.listApplications(currentCustomer("customer-1"));
    expect(result.map((item) => item.id)).toEqual([
      "application-processing",
      "application-completed"
    ]);
  });

  it("sinks an application whose final plan was rejected", async () => {
    const harness = createPortalApplicationFixture();
    const rejectedPlan = createApplication({
      ...readyFinalPlanApplication({ planConfirmStatus: PlanConfirmStatus.REJECTED }),
      id: "application-plan-rejected",
      updatedAt: new Date("2026-08-11T00:00:00Z")
    });
    const processing = createApplication({
      id: "application-processing",
      status: ApplicationStatus.SUBMITTED,
      updatedAt: new Date("2026-08-10T00:00:00Z")
    });
    vi.mocked(harness.prisma.application.findMany).mockResolvedValue([
      rejectedPlan,
      processing
    ] as never);

    const result = await harness.service.listApplications(currentCustomer("customer-1"));
    expect(result.map((item) => item.id)).toEqual([
      "application-processing",
      "application-plan-rejected"
    ]);
  });

  it("creates a self-service application for the current customer without returning order data", async () => {
    const { customerService, prisma, service } = createPortalApplicationFixture();

    const result = await service.createApplication(
      {
        subscriptionPeriodMonths: 12,
        subscriptionPlanId: "plan-1",
        vehicleId: "vehicle-1"
      },
      currentCustomer("customer-1"),
      requestContext()
    );

    expect(customerService.createSelfServiceApplication).toHaveBeenCalledWith(
      {
        customerId: "customer-1",
        periodMonths: 12,
        subscriptionPlanId: "plan-1",
        vehicleId: "vehicle-1"
      },
      expect.objectContaining({ id: "user-1" }),
      requestContext()
    );
    expect(result).toEqual(
      expect.objectContaining({
        applicationId: "application-created",
        depositStatus: DepositStatus.PENDING_CONFIRM,
        materialComplete: false,
        status: ApplicationStatus.SUBMITTED
      })
    );
    expect(result.missingMaterials).toHaveLength(4);
    expect(result).not.toHaveProperty("orderId");
    expect(prisma.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "portal_self_service_application",
        operatorId: "account-1"
      })
    );
  });

  it("prechecks material completeness without creating an application", async () => {
    const { customerService, service } = createPortalApplicationFixture();

    const result = await service.precheckApplication(
      {
        subscriptionPeriodMonths: 12,
        subscriptionPlanId: "plan-1",
        vehicleId: "vehicle-1"
      },
      currentCustomer("customer-1")
    );

    expect(customerService.validateSelfServiceApplicationSelection).toHaveBeenCalledWith({
      periodMonths: 12,
      subscriptionPlanId: "plan-1",
      vehicleId: "vehicle-1"
    });
    expect(result).toMatchObject({
      canSubmit: true,
      materialComplete: false
    });
    expect(result.missingMaterials).toHaveLength(4);
    expect(customerService.createSelfServiceApplication).not.toHaveBeenCalled();
  });

  it("blocks self-service precheck when required application profile fields are incomplete", async () => {
    const { customerService, service } = createPortalApplicationFixture({
      customer: {
        profile: null
      }
    });

    const result = await service.precheckApplication(
      {
        subscriptionPeriodMonths: 12,
        subscriptionPlanId: "plan-1",
        vehicleId: "vehicle-1"
      },
      currentCustomer("customer-1")
    );

    expect(result).toMatchObject({
      canSubmit: false,
      profileComplete: false
    });
    expect(result.missingProfileFields.map((item) => item.key)).toEqual([
      "residenceProvince",
      "residenceCity",
      "residenceDistrict",
      "residenceDetail",
      "emergencyContactName",
      "emergencyContactMobile"
    ]);
    expect(result.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "COMPLETE_PROFILE",
          url: "/portal/me"
        })
      ])
    );
    expect(customerService.createSelfServiceApplication).not.toHaveBeenCalled();
  });

  it("blocks self-service application creation when application profile is incomplete", async () => {
    const { customerService, service } = createPortalApplicationFixture({
      customer: {
        profile: null
      }
    });

    await expect(
      service.createApplication(
        {
          subscriptionPeriodMonths: 12,
          subscriptionPlanId: "plan-1",
          vehicleId: "vehicle-1"
        },
        currentCustomer("customer-1"),
        requestContext()
      )
    ).rejects.toThrow("CUSTOMER_APPLICATION_PROFILE_INCOMPLETE");
    expect(customerService.createSelfServiceApplication).not.toHaveBeenCalled();
  });

  it("reuses customer profile materials for application review visibility", async () => {
    const profileMaterial = createProfileMaterial();
    const { prisma, service, tx } = createPortalApplicationFixture({
      profileMaterials: [profileMaterial]
    });

    await service.createApplication(
      {
        subscriptionPeriodMonths: 12,
        subscriptionPlanId: "plan-1",
        vehicleId: "vehicle-1"
      },
      currentCustomer("customer-1"),
      requestContext()
    );

    expect(prisma.customerProfileMaterial.findMany).toHaveBeenCalled();
    expect(tx.applicationMaterialGroup.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ materialType: ApplicationMaterialType.ID_CARD })
      })
    );
    expect(tx.fileObject.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          objectKey: profileMaterial.objectKey
        })
      })
    );
    expect(tx.applicationActionLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          comment: expect.stringContaining("客户资料中心")
        })
      })
    );
  });

  it("only returns applications owned by the current customer", async () => {
    const { service } = createPortalApplicationFixture();

    await expect(service.getApplication("application-1", currentCustomer("customer-other"))).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it("uploads materials through StorageService and does not expose object storage URLs", async () => {
    const { service, storageService } = createPortalApplicationFixture();

    const result = await service.uploadMaterial(
      "application-1",
      { materialType: "ID_CARD" },
      [
        {
          buffer: Buffer.from("hello"),
          mimetype: "text/plain",
          originalname: "id-card.txt",
          size: 5
        }
      ],
      currentCustomer("customer-1"),
      requestContext()
    );

    expect(storageService.putApplicationMaterial).toHaveBeenCalledWith(
      expect.objectContaining({ applicationId: "application-1", originalName: "id-card.txt" })
    );
    expect(result.files[0]).toEqual(
      expect.objectContaining({
        fileName: "id-card.txt",
        previewUrl: "/api/portal/applications/application-1/materials/material-file-1/preview"
      })
    );
    expect(result.files[0]).not.toHaveProperty("objectKey");
    expect(result.files[0]).not.toHaveProperty("bucket");
  });

  it("blocks material upload to another customer's application", async () => {
    const { service, storageService } = createPortalApplicationFixture();

    await expect(
      service.uploadMaterial(
        "application-1",
        { materialType: "ID_CARD" },
        [
          {
            buffer: Buffer.from("hello"),
            mimetype: "text/plain",
            originalname: "id-card.txt",
            size: 5
          }
        ],
        currentCustomer("customer-other"),
        requestContext()
      )
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(storageService.putApplicationMaterial).not.toHaveBeenCalled();
  });

  it("streams material previews only for the owning customer", async () => {
    const { service, storageService } = createPortalApplicationFixture();

    const preview = await service.previewMaterialFile(
      "application-1",
      "material-file-1",
      currentCustomer("customer-1")
    );

    expect(preview.filename).toBe("id-card.txt");
    expect(storageService.getObject).toHaveBeenCalledWith("application-materials", "materials/application-1/file.txt");

    await expect(
      service.previewMaterialFile("application-1", "material-file-1", currentCustomer("customer-other"))
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("cancels only mutable customer-owned applications", async () => {
    const { customerService, prisma, service } = createPortalApplicationFixture();

    const result = await service.cancelApplication("application-1", currentCustomer("customer-1"), requestContext());

    expect(customerService.cancelApplication).toHaveBeenCalledWith(
      "application-1",
      { comment: "客户从门户取消申请。" },
      expect.objectContaining({ id: "user-1" }),
      requestContext()
    );
    expect(result.status).toBe(ApplicationStatus.CANCELLED);
    expect(prisma.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "portal_self_service_application",
        operatorId: "account-1"
      })
    );
  });

  it("rejects customer cancellation after approval", async () => {
    const { service } = createPortalApplicationFixture({
      application: { status: ApplicationStatus.APPROVED }
    });

    await expect(
      service.cancelApplication("application-1", currentCustomer("customer-1"), requestContext())
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("returns a customer-readable progress timeline for the owning customer", async () => {
    const { service } = createPortalApplicationFixture({
      application: readyFinalPlanApplication()
    });

    const result = await service.getApplicationProgress("application-1", currentCustomer("customer-1"));

    expect(result).toEqual(
      expect.objectContaining({
        applicationId: "application-1",
        currentStep: "FINAL_PLAN",
        nextAction: "CONFIRM_FINAL_PLAN",
        overallStatus: "PENDING_CUSTOMER_CONFIRMATION"
      })
    );
    expect(result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "FINAL_PLAN", status: "CURRENT" })
      ])
    );
  });

  it("keeps a confirmed application at formal-order creation until an active order exists", async () => {
    const { service } = createPortalApplicationFixture({
      application: readyFinalPlanApplication({
        planConfirmStatus: PlanConfirmStatus.CONFIRMED,
        orders: [
          {
            deletedAt: new Date("2026-06-16T11:00:00.000Z"),
            orderStatus: OrderStatus.PENDING_CONTRACT
          }
        ]
      })
    });

    const progress = await service.getApplicationProgress("application-1", currentCustomer("customer-1"));
    const detail = await service.getApplication("application-1", currentCustomer("customer-1"));

    expect(progress).toEqual(
      expect.objectContaining({
        currentStep: "ORDER",
        nextAction: "WAIT_ORDER_CREATION",
        overallStatus: "PENDING_ORDER"
      })
    );
    expect(progress.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "ORDER", status: "CURRENT" }),
        expect.objectContaining({ key: "CONTRACT", status: "PENDING" })
      ])
    );
    expect(detail).toEqual(
      expect.objectContaining({
        nextStepHint: "已确认最终方案，等待平台生成正式订单。",
        ordersGenerated: false
      })
    );
  });

  it.each([
    [OrderStatus.PENDING_REVIEW, "ORDER", "CURRENT", "WAIT_REVIEW", "PENDING_ORDER"],
    [OrderStatus.PENDING_CUSTOMER_CONFIRMATION, "ORDER", "CURRENT", "WAIT_REVIEW", "PENDING_ORDER"],
    [OrderStatus.PENDING_CONTRACT, "CONTRACT", "CURRENT", "GO_CONTRACT", "PENDING_CONTRACT"],
    [OrderStatus.PENDING_SIGN, "CONTRACT", "CURRENT", "GO_CONTRACT", "PENDING_CONTRACT"],
    [OrderStatus.PENDING_PAYMENT, "PAYMENT", "CURRENT", "GO_PAYMENT", "PENDING_PAYMENT"],
    [OrderStatus.PENDING_VEHICLE, "DELIVERY", "CURRENT", "WAIT_DELIVERY", "PENDING_DELIVERY"],
    [OrderStatus.PENDING_DELIVERY, "DELIVERY", "CURRENT", "WAIT_DELIVERY", "PENDING_DELIVERY"],
    [OrderStatus.ACTIVE, "ACTIVE", "CURRENT", "NONE", "ACTIVE"],
    [OrderStatus.SUSPENDED, "ACTIVE", "CURRENT", "NONE", "SUSPENDED"],
    [OrderStatus.TERMINATED, "ACTIVE", "DONE", "NONE", "TERMINATED"],
    [OrderStatus.COMPLETED, "ACTIVE", "DONE", "NONE", "COMPLETED"],
    [OrderStatus.CANCELLED, "ORDER", "FAILED", "NONE", "CANCELLED"],
    [OrderStatus.REJECTED, "ORDER", "FAILED", "NONE", "REJECTED"]
  ])(
    "maps an active %s formal order to a consistent portal stage",
    async (orderStatus, expectedStep, expectedStepStatus, nextAction, overallStatus) => {
      const { service } = createPortalApplicationFixture({
        application: readyFinalPlanApplication({
          planConfirmStatus: PlanConfirmStatus.CONFIRMED,
          orders: [
            {
              deletedAt: new Date("2026-06-16T11:00:00.000Z"),
              orderStatus: OrderStatus.PENDING_CONTRACT
            },
            { deletedAt: null, orderStatus }
          ]
        })
      });

      const progress = await service.getApplicationProgress("application-1", currentCustomer("customer-1"));

      expect(progress).toEqual(expect.objectContaining({ currentStep: expectedStep, nextAction, overallStatus }));
      expect(progress.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: expectedStep, status: expectedStepStatus })
        ])
      );
    }
  );

  it("continues My Application guidance into an active mileage review", async () => {
    const { service } = createPortalApplicationFixture({
      application: readyFinalPlanApplication({
        planConfirmStatus: PlanConfirmStatus.CONFIRMED,
        orders: [
          {
            contractId: "contract-1",
            deletedAt: null,
            handoverWorkOrders: [],
            id: "order-1",
            mileageReviews: [
              {
                id: "review-1",
                status: OrderMileageReviewStatus.PENDING_SUBMISSION
              }
            ],
            orderNo: "ORD202608020001",
            orderStatus: OrderStatus.ACTIVE
          }
        ]
      })
    });

    const progress = await service.getApplicationProgress(
      "application-1",
      currentCustomer("customer-1")
    );

    expect(progress).toEqual(
      expect.objectContaining({
        nextAction: "SUBMIT_MILEAGE_REVIEW",
        nextActionTarget: {
          label: "提交本月里程",
          url: "/portal/mileage-reviews/review-1"
        },
        overallStatus: "ACTIVE"
      })
    );
  });

  it.each([
    [
      OrderStatus.PENDING_CONTRACT,
      "contract-1",
      [],
      { label: "去签署合同", url: "/portal/contracts/contract-1" }
    ],
    [
      OrderStatus.PENDING_PAYMENT,
      null,
      [],
      { label: "去支付", url: "/portal/bills?orderId=order-1" }
    ],
    [
      OrderStatus.ACTIVE,
      null,
      [],
      { label: "查看已交付订单", url: "/portal/orders/order-1" }
    ]
  ])(
    "returns a concrete portal action target for formal order status %s",
    async (orderStatus, contractId, handoverWorkOrders, expectedTarget) => {
      const { service } = createPortalApplicationFixture({
        application: readyFinalPlanApplication({
          planConfirmStatus: PlanConfirmStatus.CONFIRMED,
          orders: [
            {
              contractId,
              deletedAt: null,
              handoverWorkOrders,
              id: "order-1",
              orderNo: "ORD202608020001",
              orderStatus
            }
          ]
        })
      });

      const progress = await service.getApplicationProgress("application-1", currentCustomer("customer-1"));

      expect(progress.nextActionTarget).toEqual(expectedTarget);
    }
  );

  it.each([
    [
      VehicleHandoverWorkOrderStatus.ASSIGNED,
      { label: "查看交付进度", url: "/portal/orders/order-1" }
    ],
    [
      VehicleHandoverWorkOrderStatus.CUSTOMER_REVIEWING,
      { label: "处理车辆交接", url: "/portal/handover-reviews/handover-1" }
    ]
  ])(
    "uses the customer-visible handover target for delivery status %s",
    async (handoverStatus, expectedTarget) => {
      const { service } = createPortalApplicationFixture({
        application: readyFinalPlanApplication({
          planConfirmStatus: PlanConfirmStatus.CONFIRMED,
          orders: [
            {
              contractId: "contract-1",
              deletedAt: null,
              handoverWorkOrders: [
                {
                  handoverType: VehicleHandoverType.DELIVERY_OUTBOUND,
                  id: "handover-1",
                  status: handoverStatus
                }
              ],
              id: "order-1",
              orderNo: "ORD202608020001",
              orderStatus: OrderStatus.PENDING_DELIVERY
            }
          ]
        })
      });

      const progress = await service.getApplicationProgress("application-1", currentCustomer("customer-1"));

      expect(progress.nextActionTarget).toEqual(expectedTarget);
    }
  );

  it("blocks progress access to another customer's application", async () => {
    const { service } = createPortalApplicationFixture();

    await expect(
      service.getApplicationProgress("application-1", currentCustomer("customer-other"))
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("returns NOT_READY before the final plan has been generated", async () => {
    const { service } = createPortalApplicationFixture();

    const result = await service.getFinalPlan("application-1", currentCustomer("customer-1"));

    expect(result).toEqual(
      expect.objectContaining({
        applicationId: "application-1",
        finalPlanStatus: "NOT_READY",
        nextAction: "WAIT_REVIEW"
      })
    );
  });

  it("returns a safe final plan view without internal vehicle fields", async () => {
    const { service } = createPortalApplicationFixture({
      application: readyFinalPlanApplication()
    });

    const result = await service.getFinalPlan("application-1", currentCustomer("customer-1"));
    const serialized = JSON.stringify(result);

    expect(result).toEqual(
      expect.objectContaining({
        finalPlanStatus: "PENDING_CONFIRM",
        pricing: expect.objectContaining({
          finalDepositAmount: 300000,
          monthlyFeeAmount: 735000
        })
      })
    );
    expect(serialized).not.toContain("VIN1234567890");
    expect(serialized).not.toContain("沪A12345");
    expect(serialized).not.toContain("purchasePriceAmount");
    expect(serialized).not.toContain("currentSalePriceAmount");
  });

  it("confirms the customer's own final plan without creating an official order", async () => {
    const { application, customerService, prisma, service, tx } = createPortalApplicationFixture({
      application: readyFinalPlanApplication()
    });

    const result = await service.confirmFinalPlan(
      "application-1",
      { revision: 1 },
      currentCustomer("customer-1"),
      requestContext()
    );

    expect(result).toEqual(
      expect.objectContaining({
        finalPlanStatus: PlanConfirmStatus.CONFIRMED,
        nextAction: "WAIT_ORDER_CREATION",
        order: null
      })
    );
    expect(application.planConfirmStatus).toBe(PlanConfirmStatus.CONFIRMED);
    expect(application.finalPlanConfirmedAt).toBeInstanceOf(Date);
    expect(customerService.createOrderFromApplication).not.toHaveBeenCalled();
    expect(tx.applicationActionLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actionType: ApplicationActionType.APPROVE,
          comment: "客户确认最终方案"
        })
      })
    );
    expect(prisma.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "portal_application_final_plan",
        operatorId: "account-1"
      })
    );
  });

  it("rejects duplicate final plan confirmation", async () => {
    const { service } = createPortalApplicationFixture({
      application: readyFinalPlanApplication({
        finalPlanConfirmedAt: new Date("2026-06-16T11:00:00.000Z"),
        planConfirmStatus: PlanConfirmStatus.CONFIRMED
      })
    });

    await expect(
      service.confirmFinalPlan(
        "application-1",
        { revision: 1 },
        currentCustomer("customer-1"),
        requestContext()
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("blocks final plan confirmation for another customer's application", async () => {
    const { service } = createPortalApplicationFixture({
      application: readyFinalPlanApplication()
    });

    await expect(
      service.confirmFinalPlan(
        "application-1",
        { revision: 1 },
        currentCustomer("customer-other"),
        requestContext()
      )
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("requires and records the exact Journey final-plan revision", async () => {
    const harness = createPortalApplicationFixture({
      application: readyFinalPlanApplication({
        applicationSource: ApplicationSource.SALES_ASSISTED,
        finalPlanRevision: 2,
        subscriptionJourney: { id: "journey-1" }
      })
    });

    await expect(
      harness.service.confirmFinalPlan(
        "application-1",
        { revision: 1 },
        currentCustomer("customer-1"),
        requestContext()
      )
    ).rejects.toMatchObject({ code: "FINAL_PLAN_REVISION_STALE" });

    const result = await harness.service.confirmFinalPlan(
      "application-1",
      { revision: 2 },
      currentCustomer("customer-1"),
      requestContext()
    );

    expect(result).toMatchObject({
      finalPlanRevision: 2,
      finalPlanStatus: PlanConfirmStatus.CONFIRMED
    });
    expect(harness.application.customerConfirmedPlanRevision).toBe(2);
    expect(
      harness.customerService.recordJourneyCustomerPlanConfirmation
    ).toHaveBeenCalledWith(harness.tx, {
      applicationId: "application-1",
      revision: 2
    });
    expect(harness.tx.application.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { applicationSource: ApplicationSource.SELF_SERVICE },
            { subscriptionJourney: { isNot: null } }
          ]
        })
      })
    );
  });

  it("records customer final plan rejection without creating an official order", async () => {
    const { application, customerService, service } = createPortalApplicationFixture({
      application: readyFinalPlanApplication()
    });

    const result = await service.rejectFinalPlan(
      "application-1",
      { reason: "押金过高，暂不接受" },
      currentCustomer("customer-1"),
      requestContext()
    );

    expect(result).toEqual(
      expect.objectContaining({
        finalPlanStatus: PlanConfirmStatus.REJECTED,
        nextAction: "REJECTED",
        rejectedReason: "押金过高，暂不接受"
      })
    );
    expect(application.planConfirmStatus).toBe(PlanConfirmStatus.REJECTED);
    expect(application.rejectedReason).toBe("押金过高，暂不接受");
    expect(application.orders).toHaveLength(0);
    expect(customerService.createOrderFromApplication).not.toHaveBeenCalled();
  });
});

function createCatalogPrisma() {
  return {
    subscriptionPlan: {
      findMany: vi.fn(async () => [createPlan()])
    },
    vehicle: {
      findFirst: vi.fn(async () => createVehicle()),
      findMany: vi.fn(async () => [createVehicle()])
    }
  };
}

function createPortalApplicationFixture(
  overrides: {
    application?: Record<string, unknown>;
    customer?: Partial<PortalFixtureCustomer>;
    profileMaterials?: ReturnType<typeof createProfileMaterial>[];
  } = {}
) {
  const application = createApplication(overrides.application);
  const customer = createPortalFixtureCustomer(overrides.customer);
  const profileMaterials = overrides.profileMaterials ?? [];
  const users = [createUser()];
  const tx = createPortalTransaction(application);
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    application: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.id !== application.id || where.customerId !== application.customerId) {
          return null;
        }
        return application;
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        where.customerId === application.customerId ? [application] : []
      )
    },
    applicationMaterialFile: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const applicationFilter = where.application as { customerId?: string } | undefined;
        if (
          where.id !== "material-file-1" ||
          where.applicationId !== application.id ||
          applicationFilter?.customerId !== application.customerId
        ) {
          return null;
        }
        return {
          file: {
            bucket: "application-materials",
            objectKey: "materials/application-1/file.txt"
          },
          fileName: "id-card.txt",
          mimeType: "text/plain",
          sizeBytes: 5n
        };
      })
    },
    auditLog: vi.fn(),
    customer: {
      findFirst: vi.fn(async () => ({ ownerUserId: "user-1" })),
      findUnique: vi.fn(async ({ where }: { where: { id?: string } }) =>
        where.id === customer.id ? customer : null
      )
    },
    customerProfileMaterial: {
      findMany: vi.fn(async ({ select }: { select?: Record<string, boolean> } = {}) =>
        select
          ? profileMaterials.map((material) => ({
              deletedAt: material.deletedAt,
              materialStatus: material.materialStatus,
              materialType: material.materialType
            }))
          : profileMaterials
      )
    },
    user: {
      findFirst: vi.fn(async ({ where }: { where: { id?: string } }) =>
        users.find((user) => !where.id || user.id === where.id) ?? null
      )
    }
  };
  const auditService = {
    write: vi.fn(async (input: unknown) => prisma.auditLog(input))
  };
  const configService = {
    get: vi.fn(() => undefined)
  };
  const customerService = {
    cancelApplication: vi.fn(async () => {
      (application as { status: ApplicationStatus }).status = ApplicationStatus.CANCELLED;
      return application;
    }),
    createOrderFromApplication: vi.fn(),
    recordJourneyCustomerPlanConfirmation: vi.fn(async () => undefined),
    validateSelfServiceApplicationSelection: vi.fn(async () => ({})),
    createSelfServiceApplication: vi.fn(async () => ({
      applicationId: "application-created",
      applicationNo: "APP202606160001",
      depositStatus: DepositStatus.PENDING_CONFIRM,
      message: "申请已提交",
      status: ApplicationStatus.SUBMITTED,
      vehicleStatus: VehicleStatus.REVIEW_RESERVED
    }))
  };
  const storageService = {
    getObject: vi.fn(async () => ({
      contentLength: 5,
      contentType: "text/plain",
      stream: Readable.from(["hello"])
    })),
    putApplicationMaterial: vi.fn(async () => ({
      bucket: "application-materials",
      objectKey: "materials/application-1/file.txt",
      stored: { driver: "local", key: "materials/application-1/file.txt", size: 5 }
    }))
  };

  const service = new PortalApplicationService(
    auditService as never,
    configService as never,
    customerService as never,
    prisma as never,
    storageService as never
  );

  return { application, auditService, customerService, prisma, service, storageService, tx };
}

interface PortalFixtureCustomer {
  id: string;
  identity: {
    idCardNo: string | null;
  } | null;
  mobile: string;
  name: string;
  profile: {
    emergencyContactMobile: string;
    emergencyContactName: string;
    residenceAddress: string;
    residenceCity: string;
    residenceDetail: string;
    residenceDistrict: string;
    residenceProvince: string;
    updatedAt: Date;
  } | null;
  sourceChannel: string | null;
}

function createPortalFixtureCustomer(overrides: Partial<PortalFixtureCustomer> = {}): PortalFixtureCustomer {
  return {
    id: "customer-1",
    identity: {
      idCardNo: "11010519491231002X"
    },
    mobile: "13800000000",
    name: "测试客户",
    profile: {
      emergencyContactMobile: "13900000000",
      emergencyContactName: "王女士",
      residenceAddress: "上海市闵行区北翟路1554弄53号",
      residenceCity: "上海市",
      residenceDetail: "北翟路1554弄53号",
      residenceDistrict: "闵行区",
      residenceProvince: "上海市",
      updatedAt: new Date("2026-08-12T00:00:00.000Z")
    },
    sourceChannel: "portal",
    ...overrides
  };
}

function createPortalTransaction(application: ReturnType<typeof createApplication>) {
  const materialGroup = {
    createdAt: new Date("2026-06-16T10:00:00.000Z"),
    createdBy: "user-1",
    deletedAt: null,
    files: [
      {
        applicationId: application.id,
        createdAt: new Date("2026-06-16T10:00:00.000Z"),
        createdBy: "user-1",
        deletedAt: null,
        deletedBy: null,
        deleteReason: null,
        file: {
          bucket: "application-materials",
          id: "file-1",
          objectKey: "materials/application-1/file.txt",
          originalName: "id-card.txt"
        },
        fileId: "file-1",
        fileName: "id-card.txt",
        id: "material-file-1",
        isDeleted: false,
        materialGroupId: "material-group-1",
        materialType: "ID_CARD",
        mimeType: "text/plain",
        sizeBytes: 5n,
        updatedAt: new Date("2026-06-16T10:00:00.000Z"),
        updatedBy: "user-1",
        uploadedAt: new Date("2026-06-16T10:00:00.000Z"),
        uploadedBy: "user-1"
      }
    ],
    id: "material-group-1",
    materialName: "身份证",
    materialType: "ID_CARD",
    required: true,
    reviewComment: null,
    reviewedAt: null,
    reviewedBy: null,
    reviewStatus: MaterialStatus.PENDING,
    updatedAt: new Date("2026-06-16T10:00:00.000Z"),
    updatedBy: "user-1"
  };

  return {
    application: {
      findFirstOrThrow: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.id !== application.id || where.customerId !== application.customerId) {
          throw new Error("Application not found");
        }
        return application;
      }),
      updateMany: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: Record<string, unknown> }) => {
        if (
          where.id !== application.id ||
          where.customerId !== application.customerId ||
          where.planConfirmStatus !== application.planConfirmStatus ||
          (where.finalPlanRevision !== undefined &&
            where.finalPlanRevision !== application.finalPlanRevision)
        ) {
          return { count: 0 };
        }

        Object.assign(application, data);
        return { count: 1 };
      })
    },
    applicationActionLog: {
      create: vi.fn(async () => ({}))
    },
    applicationMaterialFile: {
      create: vi.fn(async () => materialGroup.files[0])
    },
    applicationMaterialGroup: {
      findUniqueOrThrow: vi.fn(async () => materialGroup),
      upsert: vi.fn(async () => materialGroup)
    },
    fileObject: {
      create: vi.fn(async () => ({
        bucket: "application-materials",
        id: "file-1",
        objectKey: "materials/application-1/file.txt",
        originalName: "id-card.txt"
      }))
    }
  };
}

function readyFinalPlanApplication(overrides: Record<string, unknown> = {}) {
  return {
    approvedAt: new Date("2026-06-16T10:30:00.000Z"),
    creditReviewStatus: OrderReviewStatus.APPROVED,
    depositStatus: DepositStatus.CONFIRMED,
    finalDepositAmount: 300000n,
    finalPeriodMonths: 12,
    finalPlanRevision: 1,
    finalPlanSnapshot: createFinalPlanSnapshot(),
    finalQuoteSnapshot: createFinalPlanSnapshot(),
    finalSubscriptionPlanId: "plan-1",
    finalVehicleBaseFeeAmount: 700000n,
    finalVehicleId: "vehicle-1",
    customerConfirmedPlanRevision: null,
    materialReviewStatus: OrderReviewStatus.APPROVED,
    planConfirmStatus: PlanConfirmStatus.PENDING,
    productReviewStatus: OrderReviewStatus.APPROVED,
    status: ApplicationStatus.APPROVED,
    vehicleReviewStatus: OrderReviewStatus.APPROVED,
    subscriptionJourney: null,
    ...overrides
  };
}

function createFinalPlanSnapshot() {
  return {
    applicationId: "application-1",
    applicationNo: "APP202606160001",
    applicationSource: ApplicationSource.SELF_SERVICE,
    customerId: "customer-1",
    depositAmount: 300000,
    depositStatus: DepositStatus.CONFIRMED,
    finalPlanConfirmedAt: null,
    packageSnapshot: {
      benefitPackage: { packageName: "基础权益包" },
      energyPackage: { packageName: "补能包" },
      mileagePackage: { packageName: "1500 公里" },
      pricing: {
        currentSalePriceAmount: 20000000,
        monthlyFeeAmount: 735000,
        vehicleBaseFeeAmount: 700000
      },
      subscriptionPlan: {
        planName: "安心订阅 12 个月",
        planNo: "PLAN001"
      },
      vehiclePackage: { packageName: "ES6 基础车包" }
    },
    periodMonths: 12,
    planConfirmStatus: PlanConfirmStatus.PENDING,
    pricing: {
      currentSalePriceAmount: 20000000,
      monthlyFeeAmount: 735000,
      vehicleBaseFeeAmount: 700000
    },
    subscriptionPlan: {
      planName: "安心订阅 12 个月",
      planNo: "PLAN001"
    },
    subscriptionPlanId: "plan-1",
    vehicleId: "vehicle-1",
    vehicleSnapshot: {
      assetLocation: "上海",
      batteryCapacityKwh: 75,
      batteryUsageType: VehicleBatteryUsageType.BUYOUT,
      batteryUsageTypeLabel: "电池买断",
      brand: "NIO",
      currentMileageKm: 12000,
      currentSalePriceAmount: 20000000,
      modelYear: 2025,
      plateNo: "沪A12345",
      purchasePriceAmount: 26000000,
      series: "ES6",
      vehicleModel: TEST_MODEL_CODES.ES6,
      vehicleNo: "VH001",
      vin: "VIN1234567890"
    }
  };
}

function createApplication(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-06-16T10:00:00.000Z");
  return {
    applicationNo: "APP202606160001",
    applicationSource: ApplicationSource.SELF_SERVICE,
    approvedAt: null,
    createdAt: now,
    createdBy: "user-1",
    creditReviewComment: null,
    creditReviewStatus: OrderReviewStatus.PENDING,
    customerConfirmedPlanRevision: null,
    customerId: "customer-1",
    customerSelectedSnapshot: null,
    deletedAt: null,
    depositRuleId: null,
    depositRuleSnapshot: null,
    depositStatus: DepositStatus.PENDING_CONFIRM,
    finalDepositAmount: null,
    finalPeriodMonths: null,
    finalPlanRevision: 0,
    finalPlanConfirmedAt: null,
    finalPlanSnapshot: null,
    finalQuoteSnapshot: null,
    finalSubscriptionPlanId: null,
    finalVehicleBaseFeeAmount: null,
    finalVehicleId: null,
    id: "application-1",
    intentPeriodMonths: 12,
    intentSnapshot: {
      depositDescription: "押金金额将根据审核结果最终确认。",
      packageSnapshot: {
        pricing: { monthlyFeeAmount: 735000 },
        subscriptionPlan: { planName: "安心订阅 12 个月" }
      },
      periodMonths: 12,
      subscriptionPlanId: "plan-1",
      vehicleId: "vehicle-1",
      vehicleSnapshot: {
        assetLocation: "上海",
        batteryCapacityKwh: 75,
        batteryUsageType: VehicleBatteryUsageType.BUYOUT,
        batteryUsageTypeLabel: "电池买断",
        brand: "NIO",
        currentMileageKm: 12000,
        plateNo: "沪A12345",
        series: "ES6",
        vehicleModel: TEST_MODEL_CODES.ES6,
        vin: "VIN1234567890"
      }
    },
    intentSubscriptionPlanId: "plan-1",
    intentVehicleBaseFeeAmount: 700000n,
    intentVehicleId: "vehicle-1",
    intendedModel: TEST_MODEL_CODES.ES6,
    intendedPeriodMonths: 12,
    materialGroups: [],
    materialReviewStatus: OrderReviewStatus.PENDING,
    orders: [],
    planConfirmStatus: PlanConfirmStatus.PENDING,
    productReviewStatus: OrderReviewStatus.PENDING,
    rejectedReason: null,
    salesUser: { id: "user-1", name: "Admin", username: "admin" },
    salesUserId: "user-1",
    softReservationExpiresAt: null,
    softReservedAt: now,
    softReservedVehicleId: "vehicle-1",
    status: ApplicationStatus.SUBMITTED,
    subscriptionJourney: null,
    submittedAt: now,
    updatedAt: now,
    updatedBy: "user-1",
    vehicleReviewStatus: OrderReviewStatus.PENDING,
    ...overrides
  };
}

function createVehicle() {
  const now = new Date("2026-06-16T10:00:00.000Z");
  return {
    acquisitionMode: "OWNED_CASH",
    assetLocation: "上海",
    batteryCapacityKwh: new Prisma.Decimal(75),
    batteryUsageType: VehicleBatteryUsageType.BUYOUT,
    brand: "NIO",
    createdAt: now,
    createdBy: "user-1",
    currentMileageKm: 12000,
    currentSalePriceAmount: 20000000n,
    currentSalePriceInitializedAt: now,
    currentSalePriceReviewedAt: now,
    deletedAt: null,
    id: "vehicle-1",
    latestRegistrationDate: null,
    model: "ES6",
    modelYear: 2025,
    nextSalePriceReviewAt: null,
    plateNo: "沪A12345",
    purchaseDate: null,
    purchasePriceAmount: 26000000n,
    registrationDate: null,
    remark: null,
    salePriceReinitRequiredAt: null,
    salePriceStatus: SalePriceStatus.EFFECTIVE,
    series: "ES6",
    status: VehicleStatus.AVAILABLE,
    updatedAt: now,
    updatedBy: "user-1",
    vehicleModel: TEST_MODEL_CODES.ES6,
    vehicleNo: "VH001",
    vin: "VIN1234567890"
  };
}

function createPlan() {
  const now = new Date("2026-06-16T10:00:00.000Z");
  const product = {
    deletedAt: null,
    id: "product-1",
    productType: ProductType.SUBSCRIPTION,
    status: ProductStatus.ACTIVE
  };
  const productVersion = {
    deletedAt: null,
    id: "version-1",
    productId: "product-1",
    status: ProductVersionStatus.ACTIVE
  };
  return {
    baseMonthlyFeeAmount: null,
    benefitPackage: {
      benefitCount: 1,
      benefitType: "POINTS",
      deletedAt: null,
      description: "基础权益",
      id: "benefit-package-1",
      packageName: "基础权益包",
      priceAmount: 5000n,
      productId: "product-1",
      productVersionId: "version-1",
      status: RecordStatus.ACTIVE
    },
    benefitPackageId: "benefit-package-1",
    createdAt: now,
    createdBy: "user-1",
    deletedAt: null,
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    effectiveTo: null,
    energyPackage: {
      deletedAt: null,
      id: "energy-package-1",
      monthlyEnergyCount: null,
      monthlyEnergyKwh: 100,
      packageName: "补能包",
      priceAmount: 20000n,
      productId: "product-1",
      productVersionId: "version-1",
      serviceDescription: null,
      status: RecordStatus.ACTIVE
    },
    energyPackageId: "energy-package-1",
    id: "plan-1",
    maxPeriodMonths: 24,
    mileagePackage: {
      deletedAt: null,
      id: "mileage-package-1",
      monthlyMileageKm: 1500,
      overMileageFeeAmount: 100n,
      packageName: "1500 公里",
      priceAmount: 10000n,
      productId: "product-1",
      productVersionId: "version-1",
      status: RecordStatus.ACTIVE
    },
    mileagePackageId: "mileage-package-1",
    minPeriodMonths: 12,
    monthlyFeeCapRate: null,
    monthlyFeeMode: MonthlyFeeMode.RATE_FORMULA,
    monthlyFeeRate: new Prisma.Decimal("0.035"),
    planName: "安心订阅 12 个月",
    planNo: "PLAN001",
    product,
    productId: "product-1",
    productVersion,
    productVersionId: "version-1",
    remark: null,
    status: SubscriptionPlanStatus.ACTIVE,
    updatedAt: now,
    updatedBy: "user-1",
    vehiclePackage: {
      deletedAt: null,
      id: "vehicle-package-1",
      monthlyFeeRate: new Prisma.Decimal("0.04"),
      packageName: "ES6 基础车包",
      productId: "product-1",
      productVersionId: "version-1",
      status: RecordStatus.ACTIVE,
      vehicleModel: TEST_MODEL_CODES.ES6
    },
    vehiclePackageId: "vehicle-package-1"
  };
}

function createProfileMaterial(overrides: Record<string, unknown> = {}) {
  return {
    bucket: "application-materials",
    createdAt: new Date("2026-06-16T09:00:00.000Z"),
    customerId: "customer-1",
    deletedAt: null,
    fileName: "id-front.png",
    fileSize: 128,
    id: "profile-material-1",
    materialStatus: CustomerProfileMaterialStatus.ACTIVE,
    materialType: CustomerProfileMaterialType.ID_CARD_FRONT,
    mimeType: "image/png",
    objectKey: "customer-profile-materials/customer-1/2026/id-front.png",
    originalName: "id-front.png",
    remark: null,
    snapshot: null,
    updatedAt: new Date("2026-06-16T09:00:00.000Z"),
    ...overrides
  };
}

function createUser() {
  return {
    id: "user-1",
    name: "Admin",
    status: UserStatus.ACTIVE,
    username: "admin"
  };
}

function currentCustomer(customerId: string) {
  return {
    accountStatus: "ACTIVE" as const,
    customerAccountId: "account-1",
    customerId,
    phone: "13800000000"
  };
}

function requestContext() {
  return {
    ipAddress: "127.0.0.1",
    userAgent: "vitest"
  };
}
