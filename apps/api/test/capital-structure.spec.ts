import {
  AuditAction,
  FinancingAllocationStatus,
  FinancingCollateralType,
  FinancingInstrumentStatus,
  FinancingInstrumentType,
  FinancingRepaymentMethod,
  Prisma,
  SalePriceStatus,
  VehicleAcquisitionMode,
  VehicleAssetPoolStatus,
  VehicleAssetPoolType,
  VehicleAssetPoolVehicleStatus,
  VehicleBatteryUsageType,
  VehicleCapitalEventStatus,
  VehicleCapitalEventType,
  VehiclePoolAllocationMethod,
  VehicleStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { VehicleModel } from "./helpers/vehicle-model-codes";

import { FinancingService } from "../src/financing/financing.service";
import { VehicleAssetPoolService } from "../src/vehicle-asset-pool/vehicle-asset-pool.service";
import { VehicleService } from "../src/vehicle/vehicle.service";

describe("FinancingService vehicle capital structure backend", () => {
  it("creates a financing instrument and writes audit log", async () => {
    const harness = createFinancingHarness();

    const result = await harness.service.createInstrument(validInstrumentDto(), user, context);

    expect(result.instrumentNo).toMatch(/^FI\d{14}[A-Z0-9]{4}$/);
    expect(result.principalAmount).toBe(10000000);
    expect(harness.state.instruments).toHaveLength(1);
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.CREATE, entityType: "financing_instrument" })
    );
  });

  it("rejects principalAmount less than or equal to zero", async () => {
    const harness = createFinancingHarness();

    await expect(
      harness.service.createInstrument({ ...validInstrumentDto(), principalAmount: 0 }, user, context)
    ).rejects.toThrow("融资本金必须大于 0");
  });

  it("updates financing instrument fields and writes audit log", async () => {
    const instrument = makeInstrument();
    const harness = createFinancingHarness({ instruments: [instrument] });

    const result = await harness.service.updateInstrument(
      instrument.id,
      { annualRateBps: 680, lenderName: "新银行", remark: "调息" },
      user,
      context
    );

    expect(result.annualRateBps).toBe(680);
    expect(result.lenderName).toBe("新银行");
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.UPDATE, entityType: "financing_instrument" })
    );
  });

  it("settles a financing instrument and releases active allocations", async () => {
    const instrument = makeInstrument();
    const allocation = makeAllocation({ instrumentId: instrument.id });
    const harness = createFinancingHarness({ allocations: [allocation], instruments: [instrument] });

    const result = await harness.service.settleInstrument(
      instrument.id,
      { settledAt: "2028-07-01", remark: "提前结清" },
      user,
      context
    );

    expect(result.instrumentStatus).toBe(FinancingInstrumentStatus.SETTLED);
    expect(harness.state.allocations[0]?.allocationStatus).toBe(FinancingAllocationStatus.RELEASED);
    expect(harness.state.allocations[0]?.effectiveTo).toEqual(new Date("2028-07-01T00:00:00.000Z"));
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "financing_instrument_vehicle" })
    );
  });

  it("allocates a financing instrument to a vehicle", async () => {
    const instrument = makeInstrument();
    const harness = createFinancingHarness({ instruments: [instrument] });

    const result = await harness.service.allocateVehicle(
      instrument.id,
      {
        allocatedPrincipalAmount: 8000000,
        allocationRatioBps: 8000,
        effectiveFrom: "2026-07-01",
        vehicleId: "vehicle-1"
      },
      user,
      context
    );

    expect(result.allocationNo).toMatch(/^FIA\d{14}[A-Z0-9]{4}$/);
    expect(result.allocatedPrincipalAmount).toBe(8000000);
    expect(harness.state.allocations).toHaveLength(1);
  });

  it("rejects allocations that exceed instrument principalAmount", async () => {
    const instrument = makeInstrument({ principalAmount: 10000000n });
    const allocation = makeAllocation({
      allocatedPrincipalAmount: 9000000n,
      instrumentId: instrument.id
    });
    const harness = createFinancingHarness({ allocations: [allocation], instruments: [instrument] });

    await expect(
      harness.service.allocateVehicle(
        instrument.id,
        {
          allocatedPrincipalAmount: 2000000,
          effectiveFrom: "2026-07-01",
          vehicleId: "vehicle-2"
        },
        user,
        context
      )
    ).rejects.toThrow("分摊金额合计不能超过融资本金");
  });

  it("rejects duplicate active allocation for same instrument and vehicle", async () => {
    const instrument = makeInstrument();
    const allocation = makeAllocation({ instrumentId: instrument.id, vehicleId: "vehicle-1" });
    const harness = createFinancingHarness({ allocations: [allocation], instruments: [instrument] });

    await expect(
      harness.service.allocateVehicle(
        instrument.id,
        {
          allocatedPrincipalAmount: 1000000,
          effectiveFrom: "2026-07-01",
          vehicleId: "vehicle-1"
        },
        user,
        context
      )
    ).rejects.toThrow("已存在生效分摊");
  });

  it("returns financing instrument allocation balances in detail", async () => {
    const instrument = makeInstrument({ principalAmount: 10000000n });
    const activeAllocation = makeAllocation({ allocatedPrincipalAmount: 8000000n, instrumentId: instrument.id });
    const releasedAllocation = makeAllocation({
      allocatedPrincipalAmount: 1000000n,
      allocationStatus: FinancingAllocationStatus.RELEASED,
      id: "allocation-2",
      instrumentId: instrument.id,
      vehicleId: "vehicle-2"
    });
    const harness = createFinancingHarness({
      allocations: [activeAllocation, releasedAllocation],
      instruments: [instrument]
    });

    const detail = await harness.service.getInstrument(instrument.id);

    expect(detail.activeAllocatedPrincipalAmount).toBe(8000000);
    expect(detail.remainingPrincipalAmount).toBe(2000000);
  });

  it("releases a vehicle allocation", async () => {
    const instrument = makeInstrument();
    const allocation = makeAllocation({ instrumentId: instrument.id });
    const harness = createFinancingHarness({ allocations: [allocation], instruments: [instrument] });

    const result = await harness.service.releaseAllocation(
      instrument.id,
      allocation.id,
      { releasedAt: "2028-07-01", remark: "融资解除" },
      user,
      context
    );

    expect(result.allocationStatus).toBe(FinancingAllocationStatus.RELEASED);
    expect(result.effectiveTo).toEqual(new Date("2028-07-01T00:00:00.000Z"));
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "financing_instrument_vehicle" })
    );
  });

  it("returns financing instrument detail with vehicle allocations", async () => {
    const instrument = makeInstrument();
    const allocation = makeAllocation({ instrumentId: instrument.id });
    const harness = createFinancingHarness({ allocations: [allocation], instruments: [instrument] });

    const detail = await harness.service.getInstrument(instrument.id);

    expect(detail.vehicles).toHaveLength(1);
    expect(detail.vehicles[0]?.vehicle.vehicleNo).toBe("VEH20260602000000A1B2");
  });

  it("previews vehicle pool allocation by purchase price coverage without writing allocations", async () => {
    const instrument = makeInstrument({ principalAmount: 40000000n });
    const pool = makeAssetPool();
    const memberships = [
      makeAssetPoolMembership({ poolId: pool.id, vehicleId: "vehicle-1" }),
      makeAssetPoolMembership({ id: "membership-2", poolId: pool.id, vehicleId: "vehicle-2" })
    ];
    const harness = createFinancingHarness({ instruments: [instrument], poolMemberships: memberships, pools: [pool] });

    const preview = await harness.service.previewVehiclePoolAllocation(instrument.id, {
      allocationMethod: VehiclePoolAllocationMethod.UNIFORM_PURCHASE_PRICE_COVERAGE,
      coverageRateBps: 9000,
      effectiveFrom: "2026-07-01",
      poolId: pool.id
    });

    expect(preview.poolVehicleCount).toBe(2);
    expect(preview.allocatableVehicleCount).toBe(2);
    expect(preview.plannedAllocatedPrincipalAmount).toBe(24120000);
    expect(preview.exceedsRemainingPrincipalAmount).toBe(false);
    expect(harness.state.allocations).toHaveLength(0);
  });

  it("skips pool vehicles without purchase price in preview", async () => {
    const instrument = makeInstrument({ principalAmount: 40000000n });
    const pool = makeAssetPool();
    const vehicle = makeVehicle({ purchasePriceAmount: 0n });
    const harness = createFinancingHarness({
      instruments: [instrument],
      poolMemberships: [makeAssetPoolMembership({ poolId: pool.id, vehicleId: vehicle.id })],
      pools: [pool],
      vehicles: [vehicle]
    });

    const preview = await harness.service.previewVehiclePoolAllocation(instrument.id, {
      allocationMethod: VehiclePoolAllocationMethod.UNIFORM_PURCHASE_PRICE_COVERAGE,
      coverageRateBps: 9000,
      effectiveFrom: "2026-07-01",
      poolId: pool.id
    });

    expect(preview.allocatableVehicleCount).toBe(0);
    expect(preview.items[0]?.reason).toContain("采购价");
  });

  it("skips vehicles that already have active allocation under same instrument", async () => {
    const instrument = makeInstrument({ principalAmount: 40000000n });
    const pool = makeAssetPool();
    const allocation = makeAllocation({ instrumentId: instrument.id, vehicleId: "vehicle-1" });
    const harness = createFinancingHarness({
      allocations: [allocation],
      instruments: [instrument],
      poolMemberships: [makeAssetPoolMembership({ poolId: pool.id, vehicleId: "vehicle-1" })],
      pools: [pool]
    });

    const preview = await harness.service.previewVehiclePoolAllocation(instrument.id, {
      allocationMethod: VehiclePoolAllocationMethod.UNIFORM_PURCHASE_PRICE_COVERAGE,
      coverageRateBps: 9000,
      effectiveFrom: "2026-07-01",
      poolId: pool.id
    });

    expect(preview.allocatableVehicleCount).toBe(0);
    expect(preview.items[0]?.reason).toContain("生效分摊");
  });

  it("executes vehicle pool allocation and keeps capital events untouched", async () => {
    const instrument = makeInstrument({ principalAmount: 40000000n });
    const pool = makeAssetPool();
    const memberships = [
      makeAssetPoolMembership({ poolId: pool.id, vehicleId: "vehicle-1" }),
      makeAssetPoolMembership({ id: "membership-2", poolId: pool.id, vehicleId: "vehicle-2" })
    ];
    const harness = createFinancingHarness({ instruments: [instrument], poolMemberships: memberships, pools: [pool] });

    const result = await harness.service.executeVehiclePoolAllocation(
      instrument.id,
      {
        allocationMethod: VehiclePoolAllocationMethod.UNIFORM_PURCHASE_PRICE_COVERAGE,
        coverageRateBps: 9000,
        effectiveFrom: "2026-07-01",
        poolId: pool.id,
        remark: "pool allocation"
      },
      user,
      context
    );

    expect(result.createdCount).toBe(2);
    expect(harness.state.allocations).toHaveLength(2);
    expect(harness.state.capitalEvents).toHaveLength(0);
    expect(harness.state.allocations[0]?.snapshot).toMatchObject({
      vehicleAssetPoolAllocation: expect.objectContaining({ poolId: pool.id })
    });
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "financing_vehicle_pool_allocation" })
    );
  });

  it("rejects formal pool allocation when total exceeds remaining principal", async () => {
    const instrument = makeInstrument({ principalAmount: 10000000n });
    const pool = makeAssetPool();
    const harness = createFinancingHarness({
      allocations: [makeAllocation({ allocatedPrincipalAmount: 9000000n, instrumentId: instrument.id })],
      instruments: [instrument],
      poolMemberships: [makeAssetPoolMembership({ poolId: pool.id, vehicleId: "vehicle-2" })],
      pools: [pool]
    });

    await expect(
      harness.service.executeVehiclePoolAllocation(
        instrument.id,
        {
          allocationMethod: VehiclePoolAllocationMethod.UNIFORM_PURCHASE_PRICE_COVERAGE,
          coverageRateBps: 9000,
          effectiveFrom: "2026-07-01",
          poolId: pool.id
        },
        user,
        context
      )
    ).rejects.toThrow("剩余可分摊本金");
  });

  it("rejects unsupported vehicle pool allocation methods", async () => {
    const instrument = makeInstrument({ principalAmount: 40000000n });
    const pool = makeAssetPool();
    const harness = createFinancingHarness({ instruments: [instrument], pools: [pool] });

    await expect(
      harness.service.previewVehiclePoolAllocation(instrument.id, {
        allocationMethod: VehiclePoolAllocationMethod.EQUAL_AMOUNT,
        coverageRateBps: 9000,
        effectiveFrom: "2026-07-01",
        poolId: pool.id
      })
    ).rejects.toThrow("暂未实现");
  });
});

describe("VehicleAssetPoolService backend", () => {
  it("creates a vehicle asset pool and writes audit log", async () => {
    const harness = createAssetPoolHarness();

    const result = await harness.service.createPool(
      { poolName: "2026 ET5 financing pool", poolType: VehicleAssetPoolType.FINANCING },
      user,
      context
    );

    expect(result.poolNo).toMatch(/^VPOOL\d{14}[A-Z0-9]{4}$/);
    expect(harness.state.pools).toHaveLength(1);
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.CREATE, entityType: "vehicle_asset_pool" })
    );
  });

  it("updates a vehicle asset pool", async () => {
    const pool = makeAssetPool();
    const harness = createAssetPoolHarness({ pools: [pool] });

    const result = await harness.service.updatePool(pool.id, { poolName: "updated pool" }, user, context);

    expect(result.poolName).toBe("updated pool");
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.UPDATE, entityType: "vehicle_asset_pool" })
    );
  });

  it("archives a vehicle asset pool", async () => {
    const pool = makeAssetPool();
    const harness = createAssetPoolHarness({ pools: [pool] });

    const result = await harness.service.archivePool(pool.id, { remark: "archive" }, user, context);

    expect(result.poolStatus).toBe(VehicleAssetPoolStatus.ARCHIVED);
  });

  it("does not add vehicles to archived pools", async () => {
    const pool = makeAssetPool({ poolStatus: VehicleAssetPoolStatus.ARCHIVED });
    const harness = createAssetPoolHarness({ pools: [pool] });

    await expect(
      harness.service.addVehicleToPool(
        pool.id,
        { effectiveFrom: "2026-07-01", vehicleId: "vehicle-1" },
        user,
        context
      )
    ).rejects.toThrow("车辆池不是生效中状态");
  });

  it("adds a vehicle to pool and rejects duplicate active membership", async () => {
    const pool = makeAssetPool();
    const harness = createAssetPoolHarness({ pools: [pool] });

    await harness.service.addVehicleToPool(
      pool.id,
      { effectiveFrom: "2026-07-01", vehicleId: "vehicle-1" },
      user,
      context
    );

    await expect(
      harness.service.addVehicleToPool(
        pool.id,
        { effectiveFrom: "2026-07-01", vehicleId: "vehicle-1" },
        user,
        context
      )
    ).rejects.toThrow("重复加入");
  });

  it("batch adds vehicles and skips duplicates", async () => {
    const pool = makeAssetPool();
    const harness = createAssetPoolHarness({
      memberships: [makeAssetPoolMembership({ poolId: pool.id, vehicleId: "vehicle-1" })],
      pools: [pool]
    });

    const result = await harness.service.batchAddVehiclesToPool(
      pool.id,
      { effectiveFrom: "2026-07-01", vehicleIds: ["vehicle-1", "vehicle-2", "vehicle-2"] },
      user,
      context
    );

    expect(result.addedCount).toBe(1);
    expect(result.skippedCount).toBe(2);
    expect(harness.state.memberships).toHaveLength(2);
  });

  it("removes active pool membership", async () => {
    const pool = makeAssetPool();
    const membership = makeAssetPoolMembership({ poolId: pool.id });
    const harness = createAssetPoolHarness({ memberships: [membership], pools: [pool] });

    const result = await harness.service.removeVehicleFromPool(
      pool.id,
      membership.id,
      { effectiveTo: "2026-12-31" },
      user,
      context
    );

    expect(result.membershipStatus).toBe(VehicleAssetPoolVehicleStatus.REMOVED);
    expect(result.effectiveTo).toEqual(new Date("2026-12-31T00:00:00.000Z"));
  });

  it("returns pool detail with active vehicle totals", async () => {
    const pool = makeAssetPool();
    const harness = createAssetPoolHarness({
      memberships: [
        makeAssetPoolMembership({ poolId: pool.id, vehicleId: "vehicle-1" }),
        makeAssetPoolMembership({ id: "membership-2", poolId: pool.id, vehicleId: "vehicle-2" })
      ],
      pools: [pool]
    });

    const detail = await harness.service.getPool(pool.id);

    expect(detail.activeVehicleCount).toBe(2);
    expect(detail.purchasePriceAmountTotal).toBe(26800000);
    expect(detail.vehicles).toHaveLength(2);
  });
});

describe("VehicleService capital event and capital-structure preview", () => {
  it("creates a vehicle capital event and writes audit log", async () => {
    const instrument = makeInstrument();
    const harness = createVehicleCapitalHarness({ instruments: [instrument] });

    const result = await harness.service.createCapitalEvent(
      "vehicle-1",
      {
        debtPrincipalAmount: 10000000,
        effectiveFrom: "2026-07-01",
        eventType: VehicleCapitalEventType.ADD_DEBT_FINANCING,
        financingInstrumentId: instrument.id,
        remark: "融资租赁接入"
      },
      user,
      context
    );

    expect(result.eventNo).toMatch(/^VCE\d{14}[A-Z0-9]{4}$/);
    expect(result.eventType).toBe(VehicleCapitalEventType.ADD_DEBT_FINANCING);
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "vehicle_capital_event" })
    );
  });

  it("requires financingInstrumentId for financing capital events", async () => {
    const harness = createVehicleCapitalHarness();

    await expect(
      harness.service.createCapitalEvent(
        "vehicle-1",
        {
          effectiveFrom: "2026-07-01",
          eventType: VehicleCapitalEventType.ADD_DEBT_FINANCING
        },
        user,
        context
      )
    ).rejects.toThrow("融资类资本事件必须关联融资工具");
  });

  it("rejects duplicate active vehicle capital events", async () => {
    const instrument = makeInstrument();
    const event = makeCapitalEvent({
      debtPrincipalAmount: 10000000n,
      equityCapitalAmount: null,
      eventType: VehicleCapitalEventType.ADD_DEBT_FINANCING,
      financingInstrument: instrument,
      financingInstrumentId: instrument.id
    });
    const harness = createVehicleCapitalHarness({ events: [event], instruments: [instrument] });

    await expect(
      harness.service.createCapitalEvent(
        "vehicle-1",
        {
          debtPrincipalAmount: 10000000,
          effectiveFrom: "2026-07-01",
          eventType: VehicleCapitalEventType.ADD_DEBT_FINANCING,
          financingInstrumentId: instrument.id,
          remark: "重复补录"
        },
        user,
        context
      )
    ).rejects.toThrow("请勿重复补录");
  });

  it("lists vehicle capital events", async () => {
    const event = makeCapitalEvent();
    const harness = createVehicleCapitalHarness({ events: [event] });

    const result = await harness.service.listCapitalEvents("vehicle-1");

    expect(result).toHaveLength(1);
    expect(result[0]?.eventNo).toBe(event.eventNo);
  });

  it("updates a vehicle capital event and writes audit log", async () => {
    const event = makeCapitalEvent();
    const harness = createVehicleCapitalHarness({ events: [event] });

    const result = await harness.service.updateCapitalEvent(
      "vehicle-1",
      event.id,
      {
        effectiveFrom: "2026-08-01",
        equityCapitalAmount: 6000000,
        eventType: VehicleCapitalEventType.INITIAL_EQUITY_PURCHASE,
        remark: "更正自有资金金额"
      },
      user,
      context
    );

    expect(result.effectiveFrom).toEqual(new Date("2026-08-01T00:00:00.000Z"));
    expect(result.equityCapitalAmount).toBe(6000000);
    expect(result.remark).toBe("更正自有资金金额");
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.UPDATE, entityType: "vehicle_capital_event" })
    );
  });

  it("rejects editing a cancelled capital event", async () => {
    const event = makeCapitalEvent({ eventStatus: VehicleCapitalEventStatus.CANCELLED });
    const harness = createVehicleCapitalHarness({ events: [event] });

    await expect(
      harness.service.updateCapitalEvent(
        "vehicle-1",
        event.id,
        { effectiveFrom: "2026-08-01" },
        user,
        context
      )
    ).rejects.toThrow("不能编辑");
  });

  it("cancels a vehicle capital event", async () => {
    const event = makeCapitalEvent();
    const harness = createVehicleCapitalHarness({ events: [event] });

    const result = await harness.service.cancelCapitalEvent(
      "vehicle-1",
      event.id,
      { remark: "录入错误，作废" },
      user,
      context
    );

    expect(result.eventStatus).toBe(VehicleCapitalEventStatus.CANCELLED);
    expect(result.remark).toBe("录入错误，作废");
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.UPDATE, entityType: "vehicle_capital_event" })
    );
  });

  it("does not cancel a vehicle capital event twice", async () => {
    const event = makeCapitalEvent({ eventStatus: VehicleCapitalEventStatus.CANCELLED });
    const harness = createVehicleCapitalHarness({ events: [event] });

    await expect(
      harness.service.cancelCapitalEvent("vehicle-1", event.id, { remark: "重复作废" }, user, context)
    ).rejects.toThrow("不能重复作废");
  });

  it("returns capital structure preview with acquisition mode and debt basis", async () => {
    const instrument = makeInstrument({ annualRateBps: 600 });
    const allocation = makeAllocation({
      allocatedPrincipalAmount: 10000000n,
      instrument,
      instrumentId: instrument.id
    });
    const event = makeCapitalEvent({
      equityCapitalAmount: 5000000n,
      eventType: VehicleCapitalEventType.ADD_DEBT_FINANCING,
      financingInstrument: instrument,
      financingInstrumentId: instrument.id
    });
    const harness = createVehicleCapitalHarness({
      allocations: [allocation],
      events: [event],
      instruments: [instrument],
      vehicle: makeVehicle({ acquisitionMode: VehicleAcquisitionMode.OWNED_FINANCED })
    });

    const preview = await harness.service.getCapitalStructure("vehicle-1");

    expect(preview.acquisitionMode).toBe(VehicleAcquisitionMode.OWNED_FINANCED);
    expect(preview.debtPrincipalAmount).toBe(10000000);
    expect(preview.capitalCoverageRatio).toBe(15000000 / 16800000);
    expect(preview.annualDebtInterestAmount).toBe(600000);
    expect(preview.monthlyDebtInterestAmount).toBe(50000);
    expect(preview.roeDataReady).toBe(false);
    expect(preview.missingReasons).toContain("资本覆盖金额小于车辆采购价。");
  });

  it("ignores cancelled capital events in capital structure preview", async () => {
    const harness = createVehicleCapitalHarness({
      events: [makeCapitalEvent({ equityCapitalAmount: 5000000n, eventStatus: VehicleCapitalEventStatus.CANCELLED })]
    });

    const preview = await harness.service.getCapitalStructure("vehicle-1");

    expect(preview.activeCapitalEvents).toHaveLength(0);
    expect(preview.equityCapitalAmount).toBe(16800000);
    expect(preview.missingReasons).toContain("尚未录入资本事件。");
  });

  it("uses OWNED_CASH fallback but marks missing capital event", async () => {
    const harness = createVehicleCapitalHarness();

    const preview = await harness.service.getCapitalStructure("vehicle-1");

    expect(preview.acquisitionMode).toBe(VehicleAcquisitionMode.OWNED_CASH);
    expect(preview.equityCapitalAmount).toBe(16800000);
    expect(preview.debtPrincipalAmount).toBe(0);
    expect(preview.missingReasons).toContain("尚未录入资本事件。");
    expect(preview.roeDataReady).toBe(false);
  });
});

function createFinancingHarness(seed: {
  allocations?: ReturnType<typeof makeAllocation>[];
  instruments?: ReturnType<typeof makeInstrument>[];
  poolMemberships?: ReturnType<typeof makeAssetPoolMembership>[];
  pools?: ReturnType<typeof makeAssetPool>[];
  vehicles?: ReturnType<typeof makeVehicle>[];
} = {}) {
  const state = {
    allocations: seed.allocations ?? [],
    capitalEvents: [] as ReturnType<typeof makeCapitalEvent>[],
    instruments: seed.instruments ?? [],
    poolMemberships: seed.poolMemberships ?? [],
    pools: seed.pools ?? [],
    vehicles: seed.vehicles ?? [
      makeVehicle(),
      makeVehicle({ id: "vehicle-2", purchasePriceAmount: 10000000n, vehicleNo: "VEH20260602000000C3D4" })
    ]
  };
  const prisma = financingPrismaMock(state);
  const auditService = { write: vi.fn(async () => undefined) };

  return {
    auditService,
    prisma,
    service: new FinancingService(auditService as never, prisma as never),
    state
  };
}

function createVehicleCapitalHarness(seed: {
  allocations?: ReturnType<typeof makeAllocation>[];
  events?: ReturnType<typeof makeCapitalEvent>[];
  instruments?: ReturnType<typeof makeInstrument>[];
  vehicle?: ReturnType<typeof makeVehicle>;
} = {}) {
  const state = {
    allocations: seed.allocations ?? [],
    events: seed.events ?? [],
    instruments: seed.instruments ?? [],
    vehicle: seed.vehicle ?? makeVehicle()
  };
  const prisma = {
    financingInstrument: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        state.instruments.find((instrument) => instrument.id === where.id) ?? null
      )
    },
    financingInstrumentVehicle: {
      findMany: vi.fn(async () => state.allocations)
    },
    vehicle: {
      findUnique: vi.fn(async () => state.vehicle)
    },
    vehicleCapitalEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const instrument = state.instruments.find((item) => item.id === data.financingInstrumentId) ?? null;
        const event = makeCapitalEvent({
          ...data,
          financingInstrument: instrument,
          id: `event-${state.events.length + 1}`
        } as Partial<ReturnType<typeof makeCapitalEvent>>);
        state.events.push(event);
        return event;
      }),
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          state.events.find((event) => capitalEventMatchesWhere(event, where)) ?? null
      ),
      findMany: vi.fn(async ({ where }: { where?: { deletedAt?: null; eventStatus?: VehicleCapitalEventStatus; vehicleId?: string } } = {}) =>
        state.events.filter(
          (event) =>
            (where?.vehicleId === undefined || event.vehicleId === where.vehicleId) &&
            (where?.eventStatus === undefined || event.eventStatus === where.eventStatus) &&
            (where?.deletedAt === undefined || event.deletedAt === where.deletedAt)
        )
      ),
      update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
        const index = state.events.findIndex((event) => event.id === where.id);
        const instrument = state.instruments.find((item) => item.id === data.financingInstrumentId) ?? null;
        const next = makeCapitalEvent({
          ...state.events[index],
          ...data,
          financingInstrument: instrument,
          updatedAt: now
        } as Partial<ReturnType<typeof makeCapitalEvent>>);
        state.events[index] = next;
        return next;
      })
    }
  };
  const auditService = { write: vi.fn(async () => undefined) };

  return {
    auditService,
    prisma,
    service: new VehicleService(auditService as never, prisma as never),
    state
  };
}

function createAssetPoolHarness(seed: {
  memberships?: ReturnType<typeof makeAssetPoolMembership>[];
  pools?: ReturnType<typeof makeAssetPool>[];
  vehicles?: ReturnType<typeof makeVehicle>[];
} = {}) {
  const state = {
    memberships: seed.memberships ?? [],
    pools: seed.pools ?? [],
    vehicles: seed.vehicles ?? [makeVehicle(), makeVehicle({ id: "vehicle-2", purchasePriceAmount: 10000000n, vehicleNo: "VEH20260602000000C3D4" })]
  };
  const prisma = assetPoolPrismaMock(state);
  const auditService = { write: vi.fn(async () => undefined) };

  return {
    auditService,
    prisma,
    service: new VehicleAssetPoolService(auditService as never, prisma as never),
    state
  };
}

function financingPrismaMock(state: {
  allocations: ReturnType<typeof makeAllocation>[];
  capitalEvents: ReturnType<typeof makeCapitalEvent>[];
  instruments: ReturnType<typeof makeInstrument>[];
  poolMemberships: ReturnType<typeof makeAssetPoolMembership>[];
  pools: ReturnType<typeof makeAssetPool>[];
  vehicles: ReturnType<typeof makeVehicle>[];
}) {
  const prisma = {
    $transaction: vi.fn(async (callback: (tx: typeof prisma) => unknown) => callback(prisma)),
    financingInstrument: {
      count: vi.fn(async () => state.instruments.filter((instrument) => !instrument.deletedAt).length),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const instrument = makeInstrument({
          ...data,
          id: `instrument-${state.instruments.length + 1}`
        } as Partial<ReturnType<typeof makeInstrument>>);
        state.instruments.push(instrument);
        return instrument;
      }),
      findMany: vi.fn(async () => state.instruments.filter((instrument) => !instrument.deletedAt)),
      findUnique: vi.fn(async ({ include, where }: { include?: unknown; where: { id: string } }) => {
        const instrument = state.instruments.find((item) => item.id === where.id) ?? null;
        if (!instrument || !include) {
          return instrument;
        }
        return {
          ...instrument,
          capitalEvents: state.capitalEvents.filter((event) => event.financingInstrumentId === instrument.id),
          vehicles: state.allocations
            .filter((allocation) => allocation.instrumentId === instrument.id && !allocation.deletedAt)
            .map((allocation) => ({
              ...allocation,
              vehicle: state.vehicles.find((vehicle) => vehicle.id === allocation.vehicleId) ?? makeVehicle()
            }))
        };
      }),
      update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
        const index = state.instruments.findIndex((instrument) => instrument.id === where.id);
        const next = { ...state.instruments[index], ...data, updatedAt: now } as ReturnType<typeof makeInstrument>;
        state.instruments[index] = next;
        return next;
      })
    },
    financingInstrumentVehicle: {
      aggregate: vi.fn(async ({ where }: { where: { instrumentId: string } }) => ({
        _sum: {
          allocatedPrincipalAmount: state.allocations
            .filter(
              (allocation) =>
                allocation.instrumentId === where.instrumentId &&
                allocation.allocationStatus === FinancingAllocationStatus.ACTIVE &&
                !allocation.deletedAt
            )
            .reduce((total, allocation) => total + allocation.allocatedPrincipalAmount, 0n)
        }
      })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const allocation = makeAllocation({
          ...data,
          id: `allocation-${state.allocations.length + 1}`
        } as Partial<ReturnType<typeof makeAllocation>>);
        state.allocations.push(allocation);
        return allocation;
      }),
      findFirst: vi.fn(async ({ where }: { where: { id?: string; instrumentId: string; vehicleId?: string } }) =>
        state.allocations.find(
          (allocation) =>
            allocation.instrumentId === where.instrumentId &&
            (where.id === undefined || allocation.id === where.id) &&
            (where.vehicleId === undefined || allocation.vehicleId === where.vehicleId) &&
            allocation.allocationStatus === FinancingAllocationStatus.ACTIVE &&
            !allocation.deletedAt
        ) ?? null
      ),
      findMany: vi.fn(async ({ where }: { where: { instrumentId: string } }) =>
        state.allocations.filter(
          (allocation) =>
            allocation.instrumentId === where.instrumentId &&
            allocation.allocationStatus === FinancingAllocationStatus.ACTIVE &&
            !allocation.deletedAt
        )
      ),
      update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
        const index = state.allocations.findIndex((allocation) => allocation.id === where.id);
        const next = { ...state.allocations[index], ...data, updatedAt: now } as ReturnType<typeof makeAllocation>;
        state.allocations[index] = next;
        return next;
      }),
      updateMany: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { instrumentId: string } }) => {
        let count = 0;
        state.allocations = state.allocations.map((allocation) => {
          if (
            allocation.instrumentId !== where.instrumentId ||
            allocation.allocationStatus !== FinancingAllocationStatus.ACTIVE ||
            allocation.deletedAt
          ) {
            return allocation;
          }
          count += 1;
          return { ...allocation, ...data, updatedAt: now };
        });
        return { count };
      })
    },
    vehicleAssetPool: {
      findUnique: vi.fn(async ({ include, where }: { include?: unknown; where: { id: string } }) => {
        const pool = state.pools.find((item) => item.id === where.id) ?? null;
        if (!pool || !include) {
          return pool;
        }
        return {
          ...pool,
          vehicles: state.poolMemberships
            .filter(
              (membership) =>
                membership.poolId === pool.id &&
                membership.membershipStatus === VehicleAssetPoolVehicleStatus.ACTIVE &&
                !membership.deletedAt
            )
            .map((membership) => ({
              ...membership,
              vehicle: state.vehicles.find((vehicle) => vehicle.id === membership.vehicleId) ?? makeVehicle()
            }))
        };
      })
    },
    vehicle: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        state.vehicles.find((vehicle) => vehicle.id === where.id) ?? null
      )
    }
  };

  return prisma;
}

function assetPoolPrismaMock(state: {
  memberships: ReturnType<typeof makeAssetPoolMembership>[];
  pools: ReturnType<typeof makeAssetPool>[];
  vehicles: ReturnType<typeof makeVehicle>[];
}) {
  const prisma = {
    vehicle: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        state.vehicles.find((vehicle) => vehicle.id === where.id) ?? null
      )
    },
    vehicleAssetPool: {
      count: vi.fn(async () => state.pools.filter((pool) => !pool.deletedAt).length),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const pool = makeAssetPool({
          ...data,
          id: `pool-${state.pools.length + 1}`
        } as Partial<ReturnType<typeof makeAssetPool>>);
        state.pools.push(pool);
        return pool;
      }),
      findMany: vi.fn(async () =>
        state.pools
          .filter((pool) => !pool.deletedAt)
          .map((pool) => ({
            ...pool,
            vehicles: state.memberships
              .filter((membership) => membership.poolId === pool.id && !membership.deletedAt)
              .map((membership) => ({ membershipStatus: membership.membershipStatus }))
          }))
      ),
      findUnique: vi.fn(async ({ include, where }: { include?: unknown; where: { id: string } }) => {
        const pool = state.pools.find((item) => item.id === where.id) ?? null;
        if (!pool || !include) {
          return pool;
        }
        return {
          ...pool,
          vehicles: state.memberships
            .filter((membership) => membership.poolId === pool.id && !membership.deletedAt)
            .map((membership) => ({
              ...membership,
              vehicle: state.vehicles.find((vehicle) => vehicle.id === membership.vehicleId) ?? makeVehicle()
            }))
        };
      }),
      update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
        const index = state.pools.findIndex((pool) => pool.id === where.id);
        const next = { ...state.pools[index], ...data, updatedAt: now } as ReturnType<typeof makeAssetPool>;
        state.pools[index] = next;
        return next;
      })
    },
    vehicleAssetPoolVehicle: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const membership = makeAssetPoolMembership({
          ...data,
          id: `membership-${state.memberships.length + 1}`
        } as Partial<ReturnType<typeof makeAssetPoolMembership>>);
        state.memberships.push(membership);
        return membership;
      }),
      findFirst: vi.fn(
        async ({
          include,
          where
        }: {
          include?: unknown;
          where: { id?: string; membershipStatus?: VehicleAssetPoolVehicleStatus; poolId: string; vehicleId?: string };
        }) => {
          const membership =
            state.memberships.find(
              (item) =>
                item.poolId === where.poolId &&
                (where.id === undefined || item.id === where.id) &&
                (where.vehicleId === undefined || item.vehicleId === where.vehicleId) &&
                (where.membershipStatus === undefined || item.membershipStatus === where.membershipStatus) &&
                !item.deletedAt
            ) ?? null;
          if (!membership || !include) {
            return membership;
          }
          return {
            ...membership,
            vehicle: state.vehicles.find((vehicle) => vehicle.id === membership.vehicleId) ?? makeVehicle()
          };
        }
      ),
      update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
        const index = state.memberships.findIndex((membership) => membership.id === where.id);
        const next = {
          ...state.memberships[index],
          ...data,
          updatedAt: now
        } as ReturnType<typeof makeAssetPoolMembership>;
        state.memberships[index] = next;
        return next;
      })
    }
  };

  return prisma;
}

function validInstrumentDto() {
  return {
    annualRateBps: 650,
    collateralType: FinancingCollateralType.VEHICLE,
    contractNo: "FL-2026-001",
    instrumentType: FinancingInstrumentType.FINANCE_LEASE,
    lenderName: "某融资租赁公司",
    maturityDate: "2029-06-30",
    principalAmount: 10000000,
    remark: "ET5 融资租赁",
    repaymentMethod: FinancingRepaymentMethod.INTEREST_ONLY,
    startDate: "2026-07-01",
    termMonths: 36
  };
}

const now = new Date("2026-06-02T00:00:00.000Z");
const user = { id: "user-1", menus: [], name: "运营", permissions: [], roles: [], username: "op" };
const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };

function capitalEventMatchesWhere(event: ReturnType<typeof makeCapitalEvent>, where: Record<string, unknown>) {
  const eventRecord = event as unknown as Record<string, unknown>;

  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) {
      continue;
    }

    if (key === "OR") {
      const conditions = Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
      if (!conditions.some((condition) => capitalEventMatchesWhere(event, condition))) {
        return false;
      }
      continue;
    }

    if (!matchesWhereValue(eventRecord[key], value)) {
      return false;
    }
  }

  return true;
}

function matchesWhereValue(actual: unknown, expected: unknown): boolean {
  if (isObjectWithKey(expected, "not")) {
    return !valuesEqual(actual, expected.not);
  }
  if (isObjectWithKey(expected, "lte")) {
    return actual instanceof Date && expected.lte instanceof Date && actual.getTime() <= expected.lte.getTime();
  }
  if (isObjectWithKey(expected, "gte")) {
    return actual instanceof Date && expected.gte instanceof Date && actual.getTime() >= expected.gte.getTime();
  }

  return valuesEqual(actual, expected);
}

function valuesEqual(actual: unknown, expected: unknown): boolean {
  if (actual instanceof Date && expected instanceof Date) {
    return actual.getTime() === expected.getTime();
  }
  return actual === expected;
}

function isObjectWithKey<T extends string>(value: unknown, key: T): value is Record<T, unknown> {
  return Boolean(value && typeof value === "object" && key in value);
}

function makeInstrument(overrides: Partial<Prisma.FinancingInstrumentGetPayload<Record<string, never>>> = {}) {
  return {
    annualRateBps: 650,
    collateralType: FinancingCollateralType.VEHICLE,
    contractNo: "FL-2026-001",
    createdAt: now,
    createdBy: "user-1",
    deletedAt: null,
    id: "instrument-1",
    instrumentNo: "FI20260602000000A1B2",
    instrumentStatus: FinancingInstrumentStatus.ACTIVE,
    instrumentType: FinancingInstrumentType.FINANCE_LEASE,
    lenderName: "某融资租赁公司",
    maturityDate: new Date("2029-06-30T00:00:00.000Z"),
    principalAmount: 10000000n,
    remark: "ET5 融资租赁",
    repaymentMethod: FinancingRepaymentMethod.INTEREST_ONLY,
    snapshot: {},
    startDate: new Date("2026-07-01T00:00:00.000Z"),
    termMonths: 36,
    updatedAt: now,
    updatedBy: "user-1",
    ...overrides
  };
}

function makeAllocation(overrides: Partial<Prisma.FinancingInstrumentVehicleGetPayload<Record<string, never>>> & {
  instrument?: ReturnType<typeof makeInstrument>;
} = {}) {
  const instrument = overrides.instrument ?? makeInstrument({ id: overrides.instrumentId ?? "instrument-1" });
  return {
    allocatedPrincipalAmount: 8000000n,
    allocationNo: "FIA20260602000000A1B2",
    allocationRatioBps: 8000,
    allocationStatus: FinancingAllocationStatus.ACTIVE,
    createdAt: now,
    createdBy: "user-1",
    deletedAt: null,
    effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
    effectiveTo: null,
    id: "allocation-1",
    instrument,
    instrumentId: instrument.id,
    remark: null,
    snapshot: {},
    updatedAt: now,
    updatedBy: "user-1",
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function makeAssetPool(overrides: Partial<Prisma.VehicleAssetPoolGetPayload<Record<string, never>>> = {}) {
  return {
    createdAt: now,
    createdBy: "user-1",
    deletedAt: null,
    id: "pool-1",
    poolName: "2026 ET5 financing pool",
    poolNo: "VPOOL20260602000000A1B2",
    poolStatus: VehicleAssetPoolStatus.ACTIVE,
    poolType: VehicleAssetPoolType.FINANCING,
    purpose: "project financing",
    remark: null,
    snapshot: {},
    updatedAt: now,
    updatedBy: "user-1",
    ...overrides
  };
}

function makeAssetPoolMembership(
  overrides: Partial<Prisma.VehicleAssetPoolVehicleGetPayload<Record<string, never>>> = {}
) {
  return {
    createdAt: now,
    createdBy: "user-1",
    deletedAt: null,
    effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
    effectiveTo: null,
    id: "membership-1",
    membershipStatus: VehicleAssetPoolVehicleStatus.ACTIVE,
    poolId: "pool-1",
    remark: null,
    snapshot: {},
    updatedAt: now,
    updatedBy: "user-1",
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function makeCapitalEvent(overrides: Partial<Prisma.VehicleCapitalEventGetPayload<Record<string, never>>> & {
  financingInstrument?: ReturnType<typeof makeInstrument> | null;
} = {}) {
  return {
    acquisitionMode: null,
    createdAt: now,
    createdBy: "user-1",
    debtPrincipalAmount: overrides.debtPrincipalAmount ?? null,
    deletedAt: null,
    effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
    effectiveTo: null,
    equityCapitalAmount: overrides.equityCapitalAmount ?? 5000000n,
    eventNo: "VCE20260602000000A1B2",
    eventStatus: VehicleCapitalEventStatus.ACTIVE,
    eventType: VehicleCapitalEventType.INITIAL_EQUITY_PURCHASE,
    externalOwnerName: null,
    financingInstrument: overrides.financingInstrument ?? null,
    financingInstrumentId: null,
    id: "event-1",
    lessorName: null,
    managedOwnerName: null,
    remark: null,
    snapshot: {},
    updatedAt: now,
    updatedBy: "user-1",
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function makeVehicle(overrides: Partial<Prisma.VehicleGetPayload<Record<string, never>>> = {}) {
  return {
    acquisitionMode: VehicleAcquisitionMode.OWNED_CASH,
    assetLocation: null,
    batteryCapacityKwh: new Prisma.Decimal(75),
    batteryUsageType: VehicleBatteryUsageType.BUYOUT,
    brand: "NIO",
    createdAt: now,
    createdBy: "user-1",
    currentMileageKm: 0,
    currentSalePriceAmount: null,
    currentSalePriceInitializedAt: null,
    currentSalePriceReviewedAt: null,
    deletedAt: null,
    id: "vehicle-1",
    model: null,
    modelYear: null,
    nextSalePriceReviewAt: null,
    plateNo: null,
    purchaseDate: null,
    purchasePriceAmount: 16800000n,
    registrationDate: null,
    remark: null,
    salePriceHistories: [],
    salePriceReinitRequiredAt: null,
    salePriceStatus: SalePriceStatus.PENDING_INITIALIZE,
    series: null,
    status: VehicleStatus.DRAFT,
    updatedAt: now,
    updatedBy: "user-1",
    vehicleModel: VehicleModel.ET5,
    vehicleNo: "VEH20260602000000A1B2",
    vin: null,
    ...overrides
  };
}
