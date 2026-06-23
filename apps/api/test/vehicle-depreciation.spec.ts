import fs from "node:fs";
import path from "node:path";

import { BadRequestException } from "@nestjs/common";
import {
  VehicleDepreciationMethod,
  VehicleDepreciationPolicyStatus,
  VehicleDepreciationRecordSource,
  VehicleDepreciationRecordStatus,
  VehicleDepreciationScheduleStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { VehicleDepreciationService } from "../src/vehicle-depreciation/vehicle-depreciation.service";

describe("VehicleDepreciationService policy, schedule, and record foundation", () => {
  it("creates a DRAFT STRAIGHT_LINE policy", async () => {
    const { prisma, service, user } = createHarness();

    const policy = await service.createPolicy(
      "vehicle-1",
      {
        depreciationBasisAmount: 12000000,
        depreciationMethod: VehicleDepreciationMethod.STRAIGHT_LINE,
        depreciationStartDate: "2026-07-15",
        policyNo: "VDP-001",
        residualValueAmount: 2400000,
        usefulLifeMonths: 48
      },
      user
    );

    expect(policy).toMatchObject({
      depreciationMethod: VehicleDepreciationMethod.STRAIGHT_LINE,
      monthlyDepreciationAmount: 200000,
      policyNo: "VDP-001",
      policyStatus: VehicleDepreciationPolicyStatus.DRAFT,
      usefulLifeMonths: 48
    });
    expect(prisma.vehicleDepreciationPolicy.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          depreciationEndDate: new Date("2030-06-30T00:00:00.000Z"),
          policyStatus: VehicleDepreciationPolicyStatus.DRAFT,
          vehicleId: "vehicle-1"
        })
      })
    );
  });

  it("rejects STRAIGHT_LINE without usefulLifeMonths", async () => {
    const { service, user } = createHarness();

    await expect(
      service.createPolicy(
        "vehicle-1",
        {
          depreciationBasisAmount: 12000000,
          depreciationMethod: VehicleDepreciationMethod.STRAIGHT_LINE,
          depreciationStartDate: "2026-07-01",
          residualValueAmount: 2400000
        },
        user
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects STRAIGHT_LINE when residual is not below basis", async () => {
    const { service, user } = createHarness();

    await expect(
      service.createPolicy(
        "vehicle-1",
        {
          depreciationBasisAmount: 12000000,
          depreciationMethod: VehicleDepreciationMethod.STRAIGHT_LINE,
          depreciationStartDate: "2026-07-01",
          residualValueAmount: 12000000,
          usefulLifeMonths: 48
        },
        user
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("activates a policy and prevents two ACTIVE policies on the same vehicle", async () => {
    const { prisma, service, user } = createHarness();

    const activated = await service.activatePolicy("policy-1", user);
    expect(activated.policyStatus).toBe(VehicleDepreciationPolicyStatus.ACTIVE);

    prisma.vehicleDepreciationPolicy.count.mockResolvedValueOnce(1);
    await expect(service.activatePolicy("policy-1", user)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("allows NONE and MANUAL policies to activate without schedule generation", async () => {
    for (const method of [VehicleDepreciationMethod.NONE, VehicleDepreciationMethod.MANUAL]) {
      const { prisma, service, user } = createHarness({ method, usefulLifeMonths: null });

      const activated = await service.activatePolicy("policy-1", user);
      const generated = await service.generateSchedules("policy-1", { dryRun: false }, user);

      expect(activated.policyStatus).toBe(VehicleDepreciationPolicyStatus.ACTIVE);
      expect(generated).toMatchObject({ generatedCount: 0, skippedCount: 0 });
      expect(prisma.vehicleDepreciationSchedule.create).not.toHaveBeenCalled();
    }
  });

  it("dry-runs STRAIGHT_LINE schedules without writing", async () => {
    const { prisma, service, user } = createHarness({
      depreciationBasisAmount: 1000n,
      residualValueAmount: 0n,
      usefulLifeMonths: 3
    });

    const result = await service.generateSchedules("policy-1", { dryRun: true }, user);

    expect(result).toMatchObject({
      dryRun: true,
      generatedCount: 0,
      skippedCount: 0
    });
    expect(result.schedules).toHaveLength(3);
    expect(prisma.vehicleDepreciationSchedule.create).not.toHaveBeenCalled();
  });

  it("generates STRAIGHT_LINE schedules with final-period rounding remainder", async () => {
    const { prisma, service, user } = createHarness({
      depreciationBasisAmount: 1000n,
      residualValueAmount: 0n,
      usefulLifeMonths: 3
    });

    const result = await service.generateSchedules("policy-1", { dryRun: false }, user);
    const amounts = result.schedules.map((schedule) => schedule.scheduledAmount);

    expect(result.generatedCount).toBe(3);
    expect(amounts).toEqual([333, 333, 334]);
    expect(amounts.reduce((sum, amount) => sum + amount, 0)).toBe(1000);
    expect(prisma.vehicleDepreciationSchedule.create).toHaveBeenCalledTimes(3);
  });

  it("skips existing policy + costPeriod when generating schedules", async () => {
    const existing = createSchedule({ costPeriod: "2026-07" });
    const { prisma, service, user } = createHarness({
      existingSchedules: [existing],
      usefulLifeMonths: 2
    });

    const result = await service.generateSchedules("policy-1", { dryRun: false }, user);

    expect(result.generatedCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(prisma.vehicleDepreciationSchedule.create).toHaveBeenCalledTimes(1);
  });

  it("confirms a schedule and creates a scheduled depreciation record", async () => {
    const schedule = createSchedule();
    const { prisma, service, user } = createHarness({ existingSchedules: [schedule] });

    const result = await service.confirmSchedule("schedule-1", {}, user);

    expect(result.scheduleStatus).toBe(VehicleDepreciationScheduleStatus.CONFIRMED);
    expect(prisma.vehicleDepreciationRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          depreciationAmount: schedule.scheduledAmount,
          recordSource: VehicleDepreciationRecordSource.SCHEDULED,
          recordStatus: VehicleDepreciationRecordStatus.CONFIRMED,
          scheduleId: "schedule-1"
        })
      })
    );
  });

  it("blocks schedule void when a confirmed or locked record is linked", async () => {
    const schedule = createSchedule({ scheduleStatus: VehicleDepreciationScheduleStatus.CONFIRMED });
    const record = createRecord({
      recordStatus: VehicleDepreciationRecordStatus.CONFIRMED,
      scheduleId: schedule.id
    });
    const { service, user } = createHarness({ existingRecords: [record], existingSchedules: [schedule] });

    await expect(service.voidSchedule("schedule-1", {}, user)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("creates manual depreciation records for MANUAL policies", async () => {
    const { prisma, service, user } = createHarness({
      method: VehicleDepreciationMethod.MANUAL,
      usefulLifeMonths: null
    });

    const record = await service.createRecord(
      "policy-1",
      {
        costPeriod: "2026-07",
        depreciationAmount: 88000,
        periodEnd: "2026-07-31",
        periodStart: "2026-07-01",
        recordSource: VehicleDepreciationRecordSource.MANUAL
      },
      user
    );

    expect(record).toMatchObject({
      depreciationAmount: 88000,
      recordSource: VehicleDepreciationRecordSource.MANUAL,
      recordStatus: VehicleDepreciationRecordStatus.DRAFT
    });
    expect(prisma.vehicleDepreciationRecord.create).toHaveBeenCalled();
  });

  it("prevents amount changes after a record is CONFIRMED", async () => {
    const record = createRecord({ recordStatus: VehicleDepreciationRecordStatus.CONFIRMED });
    const { service, user } = createHarness({ existingRecords: [record] });

    await expect(
      service.updateRecord("record-1", { depreciationAmount: 90000 }, user)
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("voids and locks schedules and records", async () => {
    const schedule = createSchedule();
    const record = createRecord({ recordStatus: VehicleDepreciationRecordStatus.DRAFT });
    const { service, user } = createHarness({
      existingRecords: [record],
      existingSchedules: [schedule]
    });

    const voidedSchedule = await service.voidSchedule("schedule-1", {}, user);
    expect(voidedSchedule.scheduleStatus).toBe(VehicleDepreciationScheduleStatus.VOIDED);

    const freshSchedule = createSchedule();
    const lockHarness = createHarness({ existingRecords: [record], existingSchedules: [freshSchedule] });
    const lockedSchedule = await lockHarness.service.lockSchedule("schedule-1", {}, lockHarness.user);
    expect(lockedSchedule.scheduleStatus).toBe(VehicleDepreciationScheduleStatus.LOCKED);

    const voidedRecord = await service.voidRecord("record-1", {}, user);
    expect(voidedRecord.recordStatus).toBe(VehicleDepreciationRecordStatus.VOIDED);

    const recordLockHarness = createHarness({ existingRecords: [record] });
    const lockedRecord = await recordLockHarness.service.lockRecord("record-1", {}, recordLockHarness.user);
    expect(lockedRecord.recordStatus).toBe(VehicleDepreciationRecordStatus.LOCKED);
  });

  it("keeps legacy cost profile fallback while allowing report service to read depreciation records", () => {
    const reportSource = fs.readFileSync(
      path.resolve(__dirname, "../src/report/report.service.ts"),
      "utf8"
    );

    expect(reportSource).toContain("VehicleAssetCostProfile");
    expect(reportSource).toContain("vehicleDepreciationPolicy");
    expect(reportSource).toContain("vehicleDepreciationRecord");
    expect(reportSource).toContain("DEPRECIATION_SOURCE_LEGACY_COST_PROFILE");
  });
});

function createHarness(options: {
  depreciationBasisAmount?: bigint;
  existingRecords?: ReturnType<typeof createRecord>[];
  existingSchedules?: ReturnType<typeof createSchedule>[];
  method?: VehicleDepreciationMethod;
  residualValueAmount?: bigint;
  usefulLifeMonths?: number | null;
} = {}) {
  let policy = createPolicy(options);
  const schedules = [...(options.existingSchedules ?? [])];
  const records = [...(options.existingRecords ?? [])];
  const prisma = {
    vehicle: {
      findFirst: vi.fn(async () => vehicleBrief())
    },
    vehicleDepreciationPolicy: {
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        policy = {
          ...policy,
          ...data,
          records: [],
          schedules: [],
          vehicle: vehicleBrief()
        } as ReturnType<typeof createPolicy>;
        return policy;
      }),
      findFirst: vi.fn(async () => withPolicyRelations(policy, schedules, records)),
      findMany: vi.fn(async () => [withPolicyRelations(policy, schedules, records)]),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        policy = {
          ...policy,
          ...data,
          vehicle: vehicleBrief()
        } as ReturnType<typeof createPolicy>;
        return withPolicyRelations(policy, schedules, records);
      })
    },
    vehicleDepreciationRecord: {
      count: vi.fn(async () => records.length),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const record = {
          ...createRecord(),
          ...data,
          id: `record-${records.length + 1}`,
          policy: policySummary(policy),
          schedule: data.scheduleId ? { id: data.scheduleId as string, scheduleNo: "VDS001" } : null,
          vehicle: vehicleBrief()
        } as ReturnType<typeof createRecord>;
        records.push(record);
        return record;
      }),
      findFirst: vi.fn(async () => withRecordRelations(records[0] ?? createRecord(), policy)),
      findMany: vi.fn(async () => records.map((record) => withRecordRelations(record, policy))),
      update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
        const index = Math.max(
          0,
          records.findIndex((record) => record.id === where.id)
        );
        const current = records[index] ?? createRecord();
        const updated = {
          ...current,
          ...data
        } as ReturnType<typeof createRecord>;
        records[index] = updated;
        return withRecordRelations(updated, policy);
      })
    },
    vehicleDepreciationSchedule: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const schedule = {
          ...createSchedule(),
          ...data,
          id: `schedule-${schedules.length + 1}`,
          policy: policySummary(policy),
          records: [],
          vehicle: vehicleBrief()
        } as ReturnType<typeof createSchedule>;
        schedules.push(schedule);
        return schedule;
      }),
      findFirst: vi.fn(async () => withScheduleRelations(schedules[0] ?? createSchedule(), policy, records)),
      findMany: vi.fn(async ({ where }: { where?: { costPeriod?: { in?: string[] } } } = {}) => {
        const periods = where?.costPeriod?.in;
        const filtered = periods ? schedules.filter((schedule) => periods.includes(schedule.costPeriod)) : schedules;
        return filtered.map((schedule) => withScheduleRelations(schedule, policy, records));
      }),
      update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
        const index = Math.max(
          0,
          schedules.findIndex((schedule) => schedule.id === where.id)
        );
        const current = schedules[index] ?? createSchedule();
        const updated = {
          ...current,
          ...data
        } as ReturnType<typeof createSchedule>;
        schedules[index] = updated;
        return withScheduleRelations(updated, policy, records);
      })
    }
  };
  const service = new VehicleDepreciationService(prisma as never);
  const user = {
    id: "user-1",
    menus: [],
    name: "Admin",
    permissions: [],
    roles: [],
    username: "admin"
  };

  return { prisma, service, user };
}

function createPolicy(options: {
  depreciationBasisAmount?: bigint;
  method?: VehicleDepreciationMethod;
  residualValueAmount?: bigint;
  usefulLifeMonths?: number | null;
} = {}) {
  const now = new Date("2026-06-23T08:00:00.000Z");
  const method = options.method ?? VehicleDepreciationMethod.STRAIGHT_LINE;
  const usefulLifeMonths = options.usefulLifeMonths === undefined ? 3 : options.usefulLifeMonths;
  return {
    activatedAt: null,
    archivedAt: null,
    assetCostProfileId: null,
    basisSource: "PURCHASE_COST",
    createdAt: now,
    createdBy: "user-1",
    currency: "CNY",
    deletedAt: null,
    depreciationBasisAmount: options.depreciationBasisAmount ?? 1200000n,
    depreciationEndDate: usefulLifeMonths
      ? new Date("2026-09-30T00:00:00.000Z")
      : null,
    depreciationMethod: method,
    depreciationStartDate: new Date("2026-07-15T00:00:00.000Z"),
    id: "policy-1",
    monthlyDepreciationAmount:
      method === VehicleDepreciationMethod.NONE
        ? 0n
        : method === VehicleDepreciationMethod.MANUAL || !usefulLifeMonths
          ? null
          : ((options.depreciationBasisAmount ?? 1200000n) - (options.residualValueAmount ?? 0n)) /
            BigInt(usefulLifeMonths),
    policyNo: "VDP001",
    policyStatus: VehicleDepreciationPolicyStatus.DRAFT,
    records: [],
    remark: null,
    residualValueAmount: options.residualValueAmount ?? 0n,
    schedules: [],
    snapshot: null,
    suspendedAt: null,
    terminatedAt: null,
    updatedAt: now,
    updatedBy: "user-1",
    usefulLifeMonths,
    vehicle: vehicleBrief(),
    vehicleId: "vehicle-1"
  };
}

function createSchedule(options: {
  costPeriod?: string;
  scheduleStatus?: VehicleDepreciationScheduleStatus;
} = {}) {
  const now = new Date("2026-06-23T08:00:00.000Z");
  const costPeriod = options.costPeriod ?? "2026-07";
  return {
    confirmedAt: null,
    costPeriod,
    createdAt: now,
    createdBy: "user-1",
    currency: "CNY",
    deletedAt: null,
    generatedAt: now,
    id: "schedule-1",
    lockedAt: null,
    periodEnd: new Date(`${costPeriod}-31T00:00:00.000Z`),
    periodStart: new Date(`${costPeriod}-01T00:00:00.000Z`),
    policy: { depreciationMethod: VehicleDepreciationMethod.STRAIGHT_LINE, id: "policy-1", policyNo: "VDP001" },
    policyId: "policy-1",
    records: [],
    remark: null,
    scheduleNo: "VDS001",
    scheduleStatus: options.scheduleStatus ?? VehicleDepreciationScheduleStatus.SCHEDULED,
    scheduledAmount: 400000n,
    snapshot: null,
    updatedAt: now,
    updatedBy: "user-1",
    vehicle: vehicleBrief(),
    vehicleId: "vehicle-1",
    voidedAt: null
  };
}

function createRecord(options: {
  recordStatus?: VehicleDepreciationRecordStatus;
  scheduleId?: string | null;
} = {}) {
  const now = new Date("2026-06-23T08:00:00.000Z");
  return {
    confirmedAt: null,
    costPeriod: "2026-07",
    createdAt: now,
    createdBy: "user-1",
    currency: "CNY",
    deletedAt: null,
    depreciationAmount: 400000n,
    id: "record-1",
    lockedAt: null,
    periodEnd: new Date("2026-07-31T00:00:00.000Z"),
    periodStart: new Date("2026-07-01T00:00:00.000Z"),
    policy: { depreciationMethod: VehicleDepreciationMethod.STRAIGHT_LINE, id: "policy-1", policyNo: "VDP001" },
    policyId: "policy-1",
    recordNo: "VDR001",
    recordSource: options.scheduleId ? VehicleDepreciationRecordSource.SCHEDULED : VehicleDepreciationRecordSource.MANUAL,
    recordStatus: options.recordStatus ?? VehicleDepreciationRecordStatus.DRAFT,
    remark: null,
    schedule: options.scheduleId ? { id: options.scheduleId, scheduleNo: "VDS001" } : null,
    scheduleId: options.scheduleId ?? null,
    snapshot: null,
    updatedAt: now,
    updatedBy: "user-1",
    vehicle: vehicleBrief(),
    vehicleId: "vehicle-1",
    voidedAt: null
  };
}

function withPolicyRelations(
  policy: ReturnType<typeof createPolicy>,
  schedules: ReturnType<typeof createSchedule>[],
  records: ReturnType<typeof createRecord>[]
) {
  return {
    ...policy,
    records,
    schedules,
    vehicle: vehicleBrief()
  };
}

function withScheduleRelations(
  schedule: ReturnType<typeof createSchedule>,
  policy: ReturnType<typeof createPolicy>,
  records: ReturnType<typeof createRecord>[]
) {
  return {
    ...schedule,
    policy: policySummary(policy),
    records: records.filter((record) => record.scheduleId === schedule.id),
    vehicle: vehicleBrief()
  };
}

function withRecordRelations(record: ReturnType<typeof createRecord>, policy: ReturnType<typeof createPolicy>) {
  return {
    ...record,
    policy: policySummary(policy),
    vehicle: vehicleBrief()
  };
}

function policySummary(policy: ReturnType<typeof createPolicy>) {
  return {
    depreciationMethod: policy.depreciationMethod,
    id: policy.id,
    policyNo: policy.policyNo
  };
}

function vehicleBrief() {
  return {
    brand: "NIO",
    id: "vehicle-1",
    model: "ES6",
    plateNo: "沪A12345",
    purchasePriceAmount: 1200000n,
    series: "ES6",
    vehicleNo: "VH001"
  };
}
