import {
  ApplicationStatus,
  BusinessType,
  ContractStatus,
  DepositStatus,
  LeaseStatus,
  OrderStatus,
  ProductStatus,
  QuoteStatus,
  VehicleDamageLevel,
  VehicleDamageResponsibleParty,
  VehicleDamageType,
  VehicleMileageSourceType,
  VehicleReturnStatus,
  VehicleReturnType,
  VehicleStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { OrderService } from "../src/order/order.service";

describe("vehicle return inspection workflow", () => {
  it("rejects prepare-return when the order is not ACTIVE", async () => {
    const harness = createReturnHarness();
    harness.state.orderStatus = OrderStatus.PENDING_DELIVERY;

    await expect(
      harness.service.prepareReturn(
        harness.orderId,
        validPrepareReturnDto(),
        harness.user,
        harness.context
      )
    ).rejects.toThrow("订单尚未起租，不能退车");
  });

  it("rejects prepare-return when the vehicle is not LEASED", async () => {
    const harness = createReturnHarness();
    harness.state.vehicleStatus = VehicleStatus.RETURNED;

    await expect(
      harness.service.prepareReturn(
        harness.orderId,
        validPrepareReturnDto(),
        harness.user,
        harness.context
      )
    ).rejects.toThrow("车辆状态不是已出租，不能退车");
  });

  it("prepare-return creates a READY return record", async () => {
    const harness = createReturnHarness();

    const vehicleReturn = (await harness.service.prepareReturn(
      harness.orderId,
      validPrepareReturnDto({ returnLocation: "静安旺旺大厦" }),
      harness.user,
      harness.context
    )) as {
      returnLocation: string;
      returnStatus: VehicleReturnStatus;
      returnType: VehicleReturnType;
    };

    expect(vehicleReturn.returnStatus).toBe(VehicleReturnStatus.READY);
    expect(vehicleReturn.returnType).toBe(VehicleReturnType.NORMAL_RETURN);
    expect(vehicleReturn.returnLocation).toBe("静安旺旺大厦");
    expect(harness.tx.vehicleReturn.create).toHaveBeenCalledTimes(1);
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: "CREATE", entityType: "vehicle_return" }),
      harness.tx
    );
  });

  it("routes an expiry-managed physical receipt through closure orchestration without final settlement", async () => {
    const harness = createReturnHarness();
    harness.state.orderStatus = OrderStatus.PENDING_RETURN;
    harness.state.returnRecord = {
      ...buildReadyReturn(harness),
      returnStatus: VehicleReturnStatus.PENDING
    };

    await harness.service.prepareReturn(
      harness.orderId,
      validPrepareReturnDto(),
      harness.user,
      harness.context
    );
    expect(harness.closureService.prepareManagedReturnInTransaction).toHaveBeenCalledWith(
      harness.tx,
      expect.objectContaining({
        actorId: harness.user.id,
        orderId: harness.orderId
      })
    );
    expect(harness.closureService.completeManagedReturnInTransaction).toHaveBeenCalledWith(
      harness.tx,
      expect.objectContaining({
        returnLocation: "静安旺旺大厦",
        vehicleReturnId: "return-1"
      }),
      harness.managedReturnCapability
    );
    await harness.service.confirmReturn(
      harness.orderId,
      validConfirmReturnDto(),
      harness.user,
      harness.context
    );

    expect(harness.closureService.confirmManagedPhysicalReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: harness.user.id,
        orderId: harness.orderId,
        physicalControlMode: "VOLUNTARY_RETURN"
      }),
      harness.context
    );
    expect(harness.state.orderStatus).toBe(OrderStatus.RETURNED_PENDING_SETTLEMENT);
    expect(harness.state.leaseStatus).toBe(LeaseStatus.COMPLETED);
    expect(harness.state.vehicleStatus).toBe(VehicleStatus.RETURNED);
    expect(harness.tx.subscriptionOrder.update).not.toHaveBeenCalled();
  });

  it("preserves legacy unmanaged PENDING_RETURN scheduling when no P0 marker exists", async () => {
    const harness = createReturnHarness();
    harness.state.orderStatus = OrderStatus.PENDING_RETURN;
    harness.state.returnRecord = {
      ...buildReadyReturn(harness),
      returnStatus: VehicleReturnStatus.PENDING
    };
    harness.closureService.prepareManagedReturnInTransaction.mockResolvedValueOnce(null);

    await expect(
      harness.service.prepareReturn(
        harness.orderId,
        validPrepareReturnDto({ returnLocation: "legacy return center" }),
        harness.user,
        harness.context
      )
    ).resolves.toMatchObject({ returnLocation: "legacy return center" });

    expect(harness.tx.vehicleReturn.update).toHaveBeenCalledTimes(1);
    expect(harness.closureService.completeManagedReturnInTransaction).not.toHaveBeenCalled();
  });

  it("fails closed when an authoritative P0 marker has missing managed links", async () => {
    const harness = createReturnHarness();
    harness.state.orderStatus = OrderStatus.PENDING_RETURN;
    harness.state.returnRecord = {
      ...buildReadyReturn(harness),
      returnStatus: VehicleReturnStatus.PENDING
    };
    harness.closureService.prepareManagedReturnInTransaction.mockRejectedValueOnce({
      response: { code: "SUBSCRIPTION_CLOSURE_MANAGED_RETURN_AUTHORITY_NOT_FOUND" },
      status: 409
    });

    await expect(
      harness.service.prepareReturn(
        harness.orderId,
        validPrepareReturnDto(),
        harness.user,
        harness.context
      )
    ).rejects.toMatchObject({
      response: { code: "SUBSCRIPTION_CLOSURE_MANAGED_RETURN_AUTHORITY_NOT_FOUND" },
      status: 409
    });

    expect(harness.tx.vehicleReturn.update).not.toHaveBeenCalled();
  });

  it("rolls back the managed return and specialist update when its audit fails", async () => {
    const harness = createReturnHarness();
    harness.state.orderStatus = OrderStatus.PENDING_RETURN;
    harness.state.returnRecord = {
      ...buildReadyReturn(harness),
      returnLocation: "original center",
      returnStatus: VehicleReturnStatus.PENDING
    };
    harness.auditService.write.mockRejectedValueOnce(new Error("AUDIT_FAILPOINT"));

    await expect(
      harness.service.prepareReturn(
        harness.orderId,
        validPrepareReturnDto({ returnLocation: "new center" }),
        harness.user,
        harness.context
      )
    ).rejects.toThrow("AUDIT_FAILPOINT");

    expect(harness.state.returnRecord).toMatchObject({
      returnLocation: "original center",
      returnStatus: VehicleReturnStatus.PENDING
    });
  });

  it("prepare-return updates the existing READY return record instead of creating another one", async () => {
    const harness = createReturnHarness();

    await harness.service.prepareReturn(
      harness.orderId,
      validPrepareReturnDto(),
      harness.user,
      harness.context
    );
    await harness.service.prepareReturn(
      harness.orderId,
      validPrepareReturnDto({ returnLocation: "徐汇退车中心", remark: "改约" }),
      harness.user,
      harness.context
    );

    expect(harness.tx.vehicleReturn.create).toHaveBeenCalledTimes(1);
    expect(harness.tx.vehicleReturn.update).toHaveBeenCalledTimes(1);
    expect(harness.state.returnRecord?.returnLocation).toBe("徐汇退车中心");
    expect(harness.state.returnRecord?.remark).toBe("改约");
  });

  it("confirm-return requires a READY return record", async () => {
    const harness = createReturnHarness();

    await expect(
      harness.service.confirmReturn(
        harness.orderId,
        validConfirmReturnDto(),
        harness.user,
        harness.context
      )
    ).rejects.toThrow("请先准备退车验收。");
  });

  it("confirm-return completes a normal return and moves the vehicle to RETURNED", async () => {
    const harness = createReturnHarness();
    harness.state.returnRecord = buildReadyReturn(harness);

    const vehicleReturn = (await harness.service.confirmReturn(
      harness.orderId,
      validConfirmReturnDto({ maintenanceRequired: false }),
      harness.user,
      harness.context
    )) as {
      returnMileageKm: number;
      returnStatus: VehicleReturnStatus;
      returnedAt: string;
    };

    expect(vehicleReturn.returnStatus).toBe(VehicleReturnStatus.CONFIRMED);
    expect(vehicleReturn.returnMileageKm).toBe(32000);
    expect(vehicleReturn.returnedAt).toBe("2026-06-20T03:00:00.000Z");
    expect(harness.state.actualReturnAt?.toISOString()).toBe("2026-06-20T03:00:00.000Z");
    expect(harness.state.orderStatus).toBe(OrderStatus.COMPLETED);
    expect(harness.state.vehicleStatus).toBe(VehicleStatus.RETURNED);
    expect(harness.state.vehicleCurrentMileageKm).toBe(32000);
    expect(harness.state.salePriceReinitRequiredAt).toBeInstanceOf(Date);
    expect(harness.vehicleMileageService.appendConfirmedReading).toHaveBeenCalledWith(
      harness.tx,
      expect.objectContaining({
        confirmedBy: harness.user.id,
        mileageKm: 32000,
        orderId: harness.orderId,
        recordedAt: new Date("2026-06-20T03:00:00.000Z"),
        sourceRecordId: "return-1",
        sourceType: VehicleMileageSourceType.RETURN_CONFIRMATION,
        vehicleId: harness.vehicleId
      })
    );

    const auditEntityTypes = harness.auditService.write.mock.calls.map(
      ([entry]) => entry.entityType
    );
    expect(auditEntityTypes).toEqual(
      expect.arrayContaining(["subscription_order", "vehicle_return", "vehicle"])
    );
  });

  it("rolls back return completion when the lease terminal transition loses its race", async () => {
    const harness = createReturnHarness();
    harness.state.returnRecord = buildReadyReturn(harness);
    harness.state.leaseUpdateCount = 0;

    await expect(
      harness.service.confirmReturn(
        harness.orderId,
        validConfirmReturnDto(),
        harness.user,
        harness.context
      )
    ).rejects.toThrow("租约状态已变化");

    expect(harness.tx.vehicle.update).not.toHaveBeenCalled();
  });

  it("confirm-return terminates the order for early termination", async () => {
    const harness = createReturnHarness();
    harness.state.returnRecord = buildReadyReturn(harness, {
      returnType: VehicleReturnType.EARLY_TERMINATION
    });

    await harness.service.confirmReturn(
      harness.orderId,
      validConfirmReturnDto({ returnType: VehicleReturnType.EARLY_TERMINATION }),
      harness.user,
      harness.context
    );

    expect(harness.state.orderStatus).toBe(OrderStatus.TERMINATED);
  });

  it("confirm-return moves the vehicle to MAINTENANCE when maintenance is required", async () => {
    const harness = createReturnHarness();
    harness.state.returnRecord = buildReadyReturn(harness);

    await harness.service.confirmReturn(
      harness.orderId,
      validConfirmReturnDto({ maintenanceRequired: true }),
      harness.user,
      harness.context
    );

    expect(harness.state.vehicleStatus).toBe(VehicleStatus.MAINTENANCE);
  });

  it("rejects mileage below the latest active ledger reading even when it exceeds the old delivery row", async () => {
    const harness = createReturnHarness();
    harness.state.returnRecord = buildReadyReturn(harness);
    harness.state.vehicleCurrentMileageKm = 31000;

    await expect(
      harness.service.confirmReturn(
        harness.orderId,
        validConfirmReturnDto({ returnMileageKm: 30000 }),
        harness.user,
        harness.context
      )
    ).rejects.toThrow("cannot be below");

    expect(harness.state.actualReturnAt).toBeNull();
    expect(harness.state.vehicleCurrentMileageKm).toBe(31000);
  });

  it("confirm-return records damage and moves the vehicle to MAINTENANCE for medium or severe damage", async () => {
    const harness = createReturnHarness();
    harness.state.returnRecord = buildReadyReturn(harness);

    const vehicleReturn = (await harness.service.confirmReturn(
      harness.orderId,
      validConfirmReturnDto({
        damages: [
          {
            damageLevel: VehicleDamageLevel.MEDIUM,
            damageType: VehicleDamageType.EXTERIOR,
            description: "右后门划痕",
            estimatedRepairAmount: 80000,
            photoUrls: [],
            responsibleParty: VehicleDamageResponsibleParty.CUSTOMER
          }
        ],
        maintenanceRequired: false
      }),
      harness.user,
      harness.context
    )) as { damages: Array<{ estimatedRepairAmount: number; status: string }> };

    expect(harness.state.vehicleStatus).toBe(VehicleStatus.MAINTENANCE);
    expect(harness.state.createdDamages).toHaveLength(1);
    expect(harness.state.createdDamages[0]?.estimatedRepairAmount).toBe(80000n);
    expect(vehicleReturn.damages[0]?.estimatedRepairAmount).toBe(80000);
    expect(vehicleReturn.damages[0]?.status).toBe("RECORDED");
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: "CREATE", entityType: "vehicle_return_damage" })
    );
  });

  it("rejects repeated confirm-return", async () => {
    const harness = createReturnHarness();
    harness.state.returnRecord = buildReadyReturn(harness);

    await harness.service.confirmReturn(
      harness.orderId,
      validConfirmReturnDto(),
      harness.user,
      harness.context
    );

    await expect(
      harness.service.confirmReturn(
        harness.orderId,
        validConfirmReturnDto(),
        harness.user,
        harness.context
      )
    ).rejects.toThrow("该订单已完成退车，不能重复退车。");
  });
});

function validPrepareReturnDto(overrides: Record<string, unknown> = {}) {
  return {
    remark: "客户预约退车",
    returnLocation: "静安旺旺大厦",
    returnType: VehicleReturnType.NORMAL_RETURN,
    scheduledAt: "2026-06-20T10:00:00+08:00",
    ...overrides
  };
}

function validConfirmReturnDto(overrides: Record<string, unknown> = {}) {
  return {
    batteryCheckedConfirmed: true,
    chargingEquipmentReturnedConfirmed: true,
    cleaningRequired: false,
    customerItemsClearedConfirmed: true,
    damages: [],
    exteriorCheckedConfirmed: true,
    interiorCheckedConfirmed: true,
    keysReturnedConfirmed: true,
    maintenanceRequired: false,
    mileageConfirmed: true,
    remark: "退车验收完成",
    returnMileageKm: 32000,
    returnType: VehicleReturnType.NORMAL_RETURN,
    returnedAt: "2026-06-20T11:00:00+08:00",
    vehicleDocumentsReturnedConfirmed: true,
    violationCheckedConfirmed: true,
    ...overrides
  };
}

function createReturnHarness() {
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
  const managedReturnCapability = Object.freeze({ kind: "managed-return" });
  const state: {
    actualDeliveryAt: Date | null;
    actualReturnAt: Date | null;
    createdDamages: Array<Record<string, unknown>>;
    leaseStatus: LeaseStatus;
    leaseUpdateCount: number;
    orderStatus: OrderStatus;
    returnRecord: Record<string, unknown> | null;
    salePriceReinitRequiredAt: Date | null;
    vehicleCurrentMileageKm: number;
    vehicleStatus: VehicleStatus;
  } = {
    actualDeliveryAt: new Date("2026-06-10T03:00:00.000Z"),
    actualReturnAt: null,
    createdDamages: [],
    leaseStatus: LeaseStatus.ACTIVE,
    leaseUpdateCount: 1,
    orderStatus: OrderStatus.ACTIVE,
    returnRecord: null,
    salePriceReinitRequiredAt: null,
    vehicleCurrentMileageKm: 28500,
    vehicleStatus: VehicleStatus.LEASED
  };

  function buildVehicle() {
    return {
      brand: "NIO",
      createdAt: now,
      currentMileageKm: state.vehicleCurrentMileageKm,
      currentSalePriceAmount: 10000000n,
      deletedAt: null,
      id: vehicleId,
      model: "ET5",
      purchasePriceAmount: 12000000n,
      salePriceReinitRequiredAt: state.salePriceReinitRequiredAt,
      status: state.vehicleStatus,
      updatedAt: now,
      vehicleNo: "VEH2026060600001",
      vin: "VIN202606060000001"
    };
  }

  function buildOrder() {
    return {
      actualDeliveryAt: state.actualDeliveryAt,
      actualReturnAt: state.actualReturnAt,
      application: {
        applicationNo: "APP202606060001",
        id: "application-1",
        salesUserId: user.id,
        status: ApplicationStatus.APPROVED
      },
      applicationId: "application-1",
      businessType: BusinessType.SUBSCRIPTION,
      changes: [],
      contract: { id: "contract-1", status: ContractStatus.SIGNED },
      contractId: "contract-1",
      contracts: [{ id: "contract-1", status: ContractStatus.SIGNED }],
      createdAt: now,
      createdBy: user.id,
      customer: { grade: "A", id: customerId, mobile: "13800000000", name: "测试客户" },
      customerId,
      deletedAt: null,
      depositAmount: 500000n,
      depositStatus: DepositStatus.CONFIRMED,
      endDate: null,
      energyLimitCount: null,
      energyLimitKwh: null,
      finalDepositAmount: 500000n,
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

  function buildReturn() {
    return state.returnRecord
      ? {
          ...state.returnRecord,
          customer: { id: customerId, mobile: "13800000000", name: "测试客户" },
          damages: state.createdDamages,
          vehicle: buildVehicle()
        }
      : null;
  }

  const tx = {
    lease: {
      findUnique: vi.fn(async () => ({
        activatedAt: state.actualDeliveryAt,
        id: "lease-1",
        orderId,
        status: state.leaseStatus,
        updatedBy: user.id
      })),
      updateMany: vi.fn(async ({ data }) => {
        if (state.leaseUpdateCount !== 1) return { count: state.leaseUpdateCount };
        state.leaseStatus = data.status;
        return { count: 1 };
      })
    },
    subscriptionOrder: {
      update: vi.fn(async ({ data }) => {
        applyDefined(state, {
          actualReturnAt: data.actualReturnAt,
          orderStatus: data.orderStatus
        });
        return buildOrder();
      })
    },
    vehicle: {
      findUnique: vi.fn(async () => buildVehicle()),
      update: vi.fn(async ({ data }) => {
        applyDefined(state, {
          salePriceReinitRequiredAt: data.salePriceReinitRequiredAt,
          vehicleCurrentMileageKm: data.currentMileageKm,
          vehicleStatus: data.status
        });
        return buildVehicle();
      })
    },
    vehicleReturn: {
      create: vi.fn(async ({ data }) => {
        state.returnRecord = {
          batteryCheckedConfirmed: false,
          chargingEquipmentReturnedConfirmed: false,
          checklistSnapshot: null,
          cleaningRequired: false,
          createdAt: now,
          createdBy: user.id,
          customerId,
          customerItemsClearedConfirmed: false,
          damageFound: false,
          deletedAt: null,
          exteriorCheckedConfirmed: false,
          id: "return-1",
          interiorCheckedConfirmed: false,
          keysReturnedConfirmed: false,
          maintenanceRequired: false,
          mileageConfirmed: false,
          orderId,
          returnMileageKm: null,
          returnedAt: null,
          updatedAt: now,
          vehicleDocumentsReturnedConfirmed: false,
          vehicleId,
          violationCheckedConfirmed: false,
          ...data
        };
        return buildReturn();
      }),
      findUnique: vi.fn(async () => buildReturn()),
      findUniqueOrThrow: vi.fn(async () => {
        const vehicleReturn = buildReturn();
        if (!vehicleReturn) {
          throw new Error("Return not found");
        }
        return vehicleReturn;
      }),
      update: vi.fn(async ({ data }) => {
        if (!state.returnRecord) {
          throw new Error("Return not found");
        }
        applyDefined(state.returnRecord, data);
        state.returnRecord.updatedAt = now;
        return buildReturn();
      })
    },
    vehicleReturnDamage: {
      create: vi.fn(async ({ data }) => {
        const damage = {
          ...data,
          createdAt: now,
          deletedAt: null,
          id: `damage-${state.createdDamages.length + 1}`,
          updatedAt: now
        };
        state.createdDamages.push(damage);
        return damage;
      })
    }
  };

  const prisma = {
    $transaction: vi.fn(async (callback) => {
      const snapshot = structuredClone(state);
      try {
        return await callback(tx);
      } catch (error) {
        Object.assign(state, snapshot);
        throw error;
      }
    }),
    subscriptionOrder: {
      findUnique: vi.fn(async () => buildOrder())
    },
    vehicleDelivery: {
      findUnique: vi.fn(async () => ({
        handoverMileageKm: 28500,
        orderId,
        vehicleId
      }))
    },
    vehicleReturn: {
      findUnique: vi.fn(async () => buildReturn())
    }
  };
  const auditService = {
    write: vi.fn(async (entry: Record<string, unknown>) => {
      void entry;
    })
  };
  const vehicleMileageService = {
    appendConfirmedReading: vi.fn(async (_db, input) => {
      if (input.mileageKm < state.vehicleCurrentMileageKm) {
        throw new Error("Vehicle mileage cannot be below the latest confirmed reading.");
      }
      state.vehicleCurrentMileageKm = input.mileageKm;
      state.salePriceReinitRequiredAt = new Date();
      return {
        id: "return-mileage-reading-1",
        ...input
      };
    })
  };
  const closureService = {
    confirmManagedPhysicalReceipt: vi.fn(async () => {
      if (state.orderStatus !== OrderStatus.PENDING_RETURN || !state.returnRecord) return null;
      state.actualReturnAt = new Date("2026-06-20T03:00:00.000Z");
      state.orderStatus = OrderStatus.RETURNED_PENDING_SETTLEMENT;
      state.leaseStatus = LeaseStatus.COMPLETED;
      state.vehicleStatus = VehicleStatus.RETURNED;
      applyDefined(state.returnRecord, {
        returnMileageKm: 32000,
        returnedAt: state.actualReturnAt,
        returnStatus: VehicleReturnStatus.CONFIRMED
      });
      return { vehicleReturnId: "return-1" };
    }),
    completeManagedReturnInTransaction: vi.fn(async () => ({
      handoverWorkOrderId: "return-handover-1"
    })),
    prepareManagedReturnInTransaction: vi.fn(async () =>
      state.orderStatus === OrderStatus.PENDING_RETURN ? managedReturnCapability : null
    )
  };
  const service = new OrderService(
    auditService as never,
    prisma as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    vehicleMileageService as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    closureService as never
  );

  return {
    auditService,
    closureService,
    context,
    customerId,
    orderId,
    managedReturnCapability,
    prisma,
    service,
    state,
    tx,
    user,
    vehicleId,
    vehicleMileageService
  };
}

function buildReadyReturn(
  harness: ReturnType<typeof createReturnHarness>,
  overrides: Record<string, unknown> = {}
) {
  const now = new Date("2026-06-06T08:00:00.000Z");
  return {
    batteryCheckedConfirmed: false,
    chargingEquipmentReturnedConfirmed: false,
    checklistSnapshot: null,
    cleaningRequired: false,
    createdAt: now,
    createdBy: harness.user.id,
    customerId: harness.customerId,
    customerItemsClearedConfirmed: false,
    damageFound: false,
    deletedAt: null,
    exteriorCheckedConfirmed: false,
    id: "return-1",
    interiorCheckedConfirmed: false,
    keysReturnedConfirmed: false,
    maintenanceRequired: false,
    mileageConfirmed: false,
    orderId: harness.orderId,
    remark: "客户预约退车",
    returnLocation: "静安旺旺大厦",
    returnMileageKm: null,
    returnNo: "RET2026060600001",
    returnStatus: VehicleReturnStatus.READY,
    returnType: VehicleReturnType.NORMAL_RETURN,
    returnedAt: null,
    scheduledAt: new Date("2026-06-20T02:00:00.000Z"),
    updatedAt: now,
    updatedBy: harness.user.id,
    vehicleDocumentsReturnedConfirmed: false,
    vehicleId: harness.vehicleId,
    violationCheckedConfirmed: false,
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
