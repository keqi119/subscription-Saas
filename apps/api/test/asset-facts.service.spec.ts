import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import {
  AuditAction,
  ContractStatus,
  LeaseStatus,
  OrderStatus,
  Prisma,
  VehicleStatus,
  VehicleOwnershipPeriodEndReason,
  VehicleOwnershipPeriodStartReason,
  VehicleSubscriptionPeriodEndReason,
  VehicleSubscriptionPeriodStartReason,
  type VehicleOwnershipPeriod,
  type VehicleSubscriptionPeriod
} from "@prisma/client";
import { validateSync } from "class-validator";
import { describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit.service";
import {
  ASSET_FACT_CONFLICT_CODE,
  AssetFactsRepository
} from "../src/asset-facts/asset-facts.repository";
import {
  CloseOwnershipPeriodDto,
  CloseSubscriptionPeriodDto,
  OpenOwnershipPeriodDto,
  OpenSubscriptionPeriodDto
} from "../src/asset-facts/dto/asset-facts.dto";
import { ASSET_FACT_SERVICE_CODE, AssetFactsService } from "../src/asset-facts/asset-facts.service";
import type {
  CloseOwnershipPeriodInput,
  CloseSubscriptionPeriodInput,
  OpenOwnershipPeriodInput,
  OpenSubscriptionPeriodInput
} from "../src/asset-facts/asset-facts.types";
import type { PrismaService } from "../src/prisma/prisma.service";

const STARTED_AT = new Date("2026-08-01T00:00:00.000Z");
const ENDED_AT = new Date("2026-10-01T00:00:00.000Z");
const START_CONFIRMED_AT = new Date("2026-08-01T00:05:00.000Z");
const END_CONFIRMED_AT = new Date("2026-10-01T00:05:00.000Z");
const SERVICE_ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const SUBSCRIPTION_START_SOURCE_ID = "00000000-0000-4000-8000-000000000011";
const SUBSCRIPTION_END_SOURCE_ID = "00000000-0000-4000-8000-000000000012";
const OWNERSHIP_START_SOURCE_ID = "00000000-0000-4000-8000-000000000021";
const OWNERSHIP_END_SOURCE_ID = "00000000-0000-4000-8000-000000000022";

const SUBSCRIPTION_START_DRIFTS = [
  ["vehicleId", { vehicleId: "different-vehicle" }],
  ["orderId", { orderId: "different-order" }],
  ["contractId", { contractId: null }],
  ["contractSegmentId", { contractSegmentId: null }],
  ["customerId", { customerId: "different-customer" }],
  ["startedAt", { startedAt: new Date("2026-08-02T00:00:00.000Z") }],
  ["reason", { reason: VehicleSubscriptionPeriodStartReason.LEASE_ACTIVATED }],
  ["actorId", { actorId: "different-actor" }],
  ["confirmedAt", { confirmedAt: new Date("2026-08-01T00:06:00.000Z") }],
  ["snapshot", { snapshot: { deliveryId: "different-delivery", vehicleVin: "VIN-1" } }]
] satisfies ReadonlyArray<readonly [string, Partial<OpenSubscriptionPeriodInput>]>;

const SUBSCRIPTION_CLOSE_DRIFTS = [
  ["periodId", { periodId: "different-period" }],
  ["endedAt", { endedAt: new Date("2026-10-02T00:00:00.000Z") }],
  ["reason", { reason: VehicleSubscriptionPeriodEndReason.EARLY_TERMINATION }],
  ["actorId", { actorId: "different-actor" }],
  ["confirmedAt", { confirmedAt: new Date("2026-10-01T00:06:00.000Z") }],
  ["snapshot", { snapshot: { returnId: "different-return", vehicleVin: "VIN-1" } }]
] satisfies ReadonlyArray<readonly [string, Partial<CloseSubscriptionPeriodInput>]>;

const OWNERSHIP_START_DRIFTS = [
  ["vehicleId", { vehicleId: "different-vehicle" }],
  ["assetOwnerId", { assetOwnerId: "different-owner" }],
  ["startedAt", { startedAt: new Date("2026-08-02T00:00:00.000Z") }],
  ["reason", { reason: VehicleOwnershipPeriodStartReason.OWNERSHIP_TRANSFER }],
  ["actorId", { actorId: "different-actor" }],
  ["confirmedAt", { confirmedAt: new Date("2026-08-01T00:06:00.000Z") }],
  ["snapshot", { snapshot: { acquisitionId: "different-acquisition", ownerNo: "PLATFORM" } }]
] satisfies ReadonlyArray<readonly [string, Partial<OpenOwnershipPeriodInput>]>;

const OWNERSHIP_CLOSE_DRIFTS = [
  ["periodId", { periodId: "different-period" }],
  ["endedAt", { endedAt: new Date("2026-10-02T00:00:00.000Z") }],
  ["reason", { reason: VehicleOwnershipPeriodEndReason.DISPOSAL }],
  ["actorId", { actorId: "different-actor" }],
  ["confirmedAt", { confirmedAt: new Date("2026-10-01T00:06:00.000Z") }],
  ["snapshot", { snapshot: { transferId: "different-transfer" } }]
] satisfies ReadonlyArray<readonly [string, Partial<CloseOwnershipPeriodInput>]>;

const SUBSCRIPTION_START_SOURCE_VARIANTS = [
  [
    "type",
    { id: "source-1", key: "delivery:source-1:occupancy:v1", type: "DIFFERENT_SOURCE_TYPE" }
  ],
  ["id", { id: "different-source-id", key: "delivery:source-1:occupancy:v1", type: "DELIVERY" }],
  ["key", { id: "source-1", key: "different-source-key", type: "DELIVERY" }]
] as const;

const SUBSCRIPTION_CLOSE_SOURCE_VARIANTS = [
  [
    "type",
    {
      id: "source-2",
      key: "return:source-2:occupancy:v1",
      type: "DIFFERENT_SOURCE_TYPE"
    }
  ],
  [
    "id",
    {
      id: "different-source-id",
      key: "return:source-2:occupancy:v1",
      type: "VEHICLE_RETURN"
    }
  ],
  ["key", { id: "source-2", key: "different-source-key", type: "VEHICLE_RETURN" }]
] as const;

const OWNERSHIP_START_SOURCE_VARIANTS = [
  [
    "type",
    {
      id: "source-1",
      key: "acquisition:source-1:ownership:v1",
      type: "DIFFERENT_SOURCE_TYPE"
    }
  ],
  [
    "id",
    {
      id: "different-source-id",
      key: "acquisition:source-1:ownership:v1",
      type: "ACQUISITION"
    }
  ],
  ["key", { id: "source-1", key: "different-source-key", type: "ACQUISITION" }]
] as const;

const OWNERSHIP_CLOSE_SOURCE_VARIANTS = [
  [
    "type",
    {
      id: "source-2",
      key: "transfer:source-2:ownership:v1",
      type: "DIFFERENT_SOURCE_TYPE"
    }
  ],
  [
    "id",
    {
      id: "different-source-id",
      key: "transfer:source-2:ownership:v1",
      type: "OWNERSHIP_TRANSFER"
    }
  ],
  ["key", { id: "source-2", key: "different-source-key", type: "OWNERSHIP_TRANSFER" }]
] as const;

describe("AssetFactsRepository subscription period commands", () => {
  it("opens a subscription period from the caller's transaction", async () => {
    const harness = createHarness();

    const result = await new AssetFactsRepository().openSubscriptionPeriod(
      harness.tx,
      subscriptionOpenInput()
    );

    expect(result).toMatchObject({
      contractId: "contract-1",
      contractSegmentId: "segment-1",
      createdBy: "actor-1",
      customerId: "customer-1",
      endedAt: null,
      orderId: "order-1",
      startConfirmedAt: START_CONFIRMED_AT,
      startConfirmedBy: "actor-1",
      startReason: VehicleSubscriptionPeriodStartReason.DELIVERY_CONFIRMED,
      startSnapshot: { deliveryId: "delivery-1", vehicleVin: "VIN-1" },
      startSourceId: "source-1",
      startSourceKey: "delivery:source-1:occupancy:v1",
      startSourceType: "DELIVERY",
      startedAt: STARTED_AT,
      vehicleId: "vehicle-1"
    });
    expect(harness.subscriptionPeriods).toHaveLength(1);
  });

  it("returns the original subscription fact for an exact start source replay", async () => {
    const original = subscriptionRow();
    const harness = createHarness({ subscriptionPeriods: [original] });

    const result = await new AssetFactsRepository().openSubscriptionPeriod(
      harness.tx,
      subscriptionOpenInput()
    );

    expect(result).toBe(original);
    expect(harness.subscriptionPeriods).toEqual([original]);
  });

  it("normalizes subscription start snapshots to their JSONB storage form", async () => {
    const original = subscriptionRow({
      startSnapshot: {
        capturedAt: "2026-08-01T00:00:00.000Z",
        nested: { kept: true }
      }
    });
    const harness = createHarness({ subscriptionPeriods: [original] });

    const result = await new AssetFactsRepository().openSubscriptionPeriod(
      harness.tx,
      subscriptionOpenInput({ snapshot: storageEquivalentInputSnapshot() })
    );

    expect(result).toBe(original);
  });

  it.each(SUBSCRIPTION_START_DRIFTS)(
    "rejects subscription start source replay when %s drifts",
    async (_field, overrides) => {
      const harness = createHarness({ subscriptionPeriods: [subscriptionRow()] });

      await expectConflictCode(
        new AssetFactsRepository().openSubscriptionPeriod(
          harness.tx,
          subscriptionOpenInput(overrides)
        ),
        ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_START_SOURCE
      );
    }
  );

  it.each(SUBSCRIPTION_START_SOURCE_VARIANTS)(
    "treats a changed subscription start source %s as a distinct command identity",
    async (_field, source) => {
      const harness = createHarness({
        subscriptionPeriods: [
          subscriptionRow({
            endedAt: new Date("2026-07-31T00:00:00.000Z"),
            startedAt: new Date("2026-07-01T00:00:00.000Z")
          })
        ]
      });

      const result = await new AssetFactsRepository().openSubscriptionPeriod(
        harness.tx,
        subscriptionOpenInput({ source })
      );

      expect(result).toMatchObject({
        startSourceId: source.id,
        startSourceKey: source.key,
        startSourceType: source.type
      });
      expect(harness.subscriptionPeriods).toHaveLength(2);
    }
  );

  it("takes a transaction-scoped source lock before checking a subscription start replay", async () => {
    const original = subscriptionRow();
    const harness = createHarness({
      requireSubscriptionStartSourceLock: true,
      subscriptionPeriods: [original]
    });

    const result = await new AssetFactsRepository().openSubscriptionPeriod(
      harness.tx,
      subscriptionOpenInput()
    );

    expect(result).toBe(original);
  });

  it("rejects subscription start source reuse with a different payload", async () => {
    const harness = createHarness({
      subscriptionPeriods: [subscriptionRow({ vehicleId: "different-vehicle" })]
    });

    await expectConflictCode(
      new AssetFactsRepository().openSubscriptionPeriod(harness.tx, subscriptionOpenInput()),
      ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_START_SOURCE
    );
  });

  it.each(["vehicle", "order", "customer", "contract"] as const)(
    "does not replay a subscription fact whose %s aggregate is soft-deleted",
    async (aggregate) => {
      const harness = createHarness({
        createSubscriptionError: databaseConstraintError(
          "23505",
          "vehicle_subscription_period_start_source_key"
        ),
        deletedSubscriptionAggregate: aggregate,
        subscriptionPeriods: [subscriptionRow()]
      });

      await expectConflictCode(
        new AssetFactsRepository().openSubscriptionPeriod(harness.tx, subscriptionOpenInput()),
        ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_START_SOURCE
      );
    }
  );

  it("closes an open subscription period without replacing the fact", async () => {
    const original = subscriptionRow();
    const harness = createHarness({ subscriptionPeriods: [original] });

    const result = await new AssetFactsRepository().closeSubscriptionPeriod(
      harness.tx,
      subscriptionCloseInput()
    );

    expect(result).toMatchObject({
      endConfirmedAt: END_CONFIRMED_AT,
      endConfirmedBy: "actor-2",
      endReason: VehicleSubscriptionPeriodEndReason.RETURN_CONFIRMED,
      endSnapshot: { returnId: "return-1", vehicleVin: "VIN-1" },
      endSourceId: "source-2",
      endSourceKey: "return:source-2:occupancy:v1",
      endSourceType: "VEHICLE_RETURN",
      endedAt: ENDED_AT,
      id: original.id,
      startedAt: STARTED_AT
    });
    expect(harness.subscriptionPeriods).toHaveLength(1);
  });

  it("returns the original closed subscription fact for an exact end source replay", async () => {
    const original = closedSubscriptionRow();
    const harness = createHarness({ subscriptionPeriods: [original] });

    const result = await new AssetFactsRepository().closeSubscriptionPeriod(
      harness.tx,
      subscriptionCloseInput()
    );

    expect(result).toBe(original);
  });

  it("normalizes subscription close snapshots to their JSONB storage form", async () => {
    const original = closedSubscriptionRow({
      endSnapshot: {
        capturedAt: "2026-10-01T00:00:00.000Z",
        nested: { kept: true }
      }
    });
    const harness = createHarness({ subscriptionPeriods: [original] });

    const result = await new AssetFactsRepository().closeSubscriptionPeriod(
      harness.tx,
      subscriptionCloseInput({ snapshot: storageEquivalentCloseInputSnapshot() })
    );

    expect(result).toBe(original);
  });

  it.each(SUBSCRIPTION_CLOSE_DRIFTS)(
    "rejects subscription close replay when %s drifts",
    async (_field, overrides) => {
      const harness = createHarness({ subscriptionPeriods: [closedSubscriptionRow()] });

      await expectConflictCode(
        new AssetFactsRepository().closeSubscriptionPeriod(
          harness.tx,
          subscriptionCloseInput(overrides)
        ),
        ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_END_SOURCE
      );
    }
  );

  it.each(SUBSCRIPTION_CLOSE_SOURCE_VARIANTS)(
    "treats a changed subscription close source %s as a non-replay close",
    async (_field, source) => {
      const harness = createHarness({ subscriptionPeriods: [closedSubscriptionRow()] });

      await expectConflictCode(
        new AssetFactsRepository().closeSubscriptionPeriod(
          harness.tx,
          subscriptionCloseInput({ source })
        ),
        ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_CLOSE_REPLAY
      );
    }
  );

  it.each(["vehicle", "order", "customer", "contract"] as const)(
    "does not replay a subscription close whose %s aggregate is soft-deleted",
    async (aggregate) => {
      const harness = createHarness({
        deletedSubscriptionAggregate: aggregate,
        subscriptionPeriods: [closedSubscriptionRow()]
      });

      await expectConflictCode(
        new AssetFactsRepository().closeSubscriptionPeriod(harness.tx, subscriptionCloseInput()),
        ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_CLOSE_REPLAY
      );
    }
  );

  it("rejects subscription end source reuse with a different close payload", async () => {
    const harness = createHarness({
      subscriptionPeriods: [
        closedSubscriptionRow({ endSnapshot: { returnId: "different-return" } })
      ]
    });

    await expectConflictCode(
      new AssetFactsRepository().closeSubscriptionPeriod(harness.tx, subscriptionCloseInput()),
      ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_END_SOURCE
    );
  });

  it("rejects a second non-replay close command for a closed subscription period", async () => {
    const harness = createHarness({ subscriptionPeriods: [closedSubscriptionRow()] });

    await expectConflictCode(
      new AssetFactsRepository().closeSubscriptionPeriod(harness.tx, {
        ...subscriptionCloseInput(),
        source: {
          id: "source-3",
          key: "manual:source-3:occupancy:v1",
          type: "MANUAL_REPAIR"
        }
      }),
      ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_CLOSE_REPLAY
    );
  });
});

describe("AssetFactsRepository ownership period commands", () => {
  it("opens an ownership period from the caller's transaction", async () => {
    const harness = createHarness();

    const result = await new AssetFactsRepository().openOwnershipPeriod(
      harness.tx,
      ownershipOpenInput()
    );

    expect(result).toMatchObject({
      assetOwnerId: "owner-1",
      createdBy: "actor-1",
      endedAt: null,
      startConfirmedAt: START_CONFIRMED_AT,
      startConfirmedBy: "actor-1",
      startReason: VehicleOwnershipPeriodStartReason.INITIAL_ACQUISITION,
      startSnapshot: { acquisitionId: "acquisition-1", ownerNo: "PLATFORM" },
      startSourceId: "source-1",
      startSourceKey: "acquisition:source-1:ownership:v1",
      startSourceType: "ACQUISITION",
      startedAt: STARTED_AT,
      vehicleId: "vehicle-1"
    });
    expect(harness.ownershipPeriods).toHaveLength(1);
  });

  it("returns the original ownership fact for an exact start source replay", async () => {
    const original = ownershipRow();
    const harness = createHarness({ ownershipPeriods: [original] });

    const result = await new AssetFactsRepository().openOwnershipPeriod(
      harness.tx,
      ownershipOpenInput()
    );

    expect(result).toBe(original);
    expect(harness.ownershipPeriods).toEqual([original]);
  });

  it("normalizes ownership start snapshots to their JSONB storage form", async () => {
    const original = ownershipRow({
      startSnapshot: {
        capturedAt: "2026-08-01T00:00:00.000Z",
        nested: { kept: true }
      }
    });
    const harness = createHarness({ ownershipPeriods: [original] });

    const result = await new AssetFactsRepository().openOwnershipPeriod(
      harness.tx,
      ownershipOpenInput({ snapshot: storageEquivalentInputSnapshot() })
    );

    expect(result).toBe(original);
  });

  it.each(OWNERSHIP_START_DRIFTS)(
    "rejects ownership start source replay when %s drifts",
    async (_field, overrides) => {
      const harness = createHarness({ ownershipPeriods: [ownershipRow()] });

      await expectConflictCode(
        new AssetFactsRepository().openOwnershipPeriod(harness.tx, ownershipOpenInput(overrides)),
        ASSET_FACT_CONFLICT_CODE.OWNERSHIP_START_SOURCE
      );
    }
  );

  it.each(OWNERSHIP_START_SOURCE_VARIANTS)(
    "treats a changed ownership start source %s as a distinct command identity",
    async (_field, source) => {
      const harness = createHarness({
        ownershipPeriods: [
          ownershipRow({
            endedAt: new Date("2026-07-31T00:00:00.000Z"),
            startedAt: new Date("2026-07-01T00:00:00.000Z")
          })
        ]
      });

      const result = await new AssetFactsRepository().openOwnershipPeriod(
        harness.tx,
        ownershipOpenInput({ source })
      );

      expect(result).toMatchObject({
        startSourceId: source.id,
        startSourceKey: source.key,
        startSourceType: source.type
      });
      expect(harness.ownershipPeriods).toHaveLength(2);
    }
  );

  it("takes a transaction-scoped source lock before checking an ownership start replay", async () => {
    const original = ownershipRow();
    const harness = createHarness({
      ownershipPeriods: [original],
      requireOwnershipStartSourceLock: true
    });

    const result = await new AssetFactsRepository().openOwnershipPeriod(
      harness.tx,
      ownershipOpenInput()
    );

    expect(result).toBe(original);
  });

  it("rejects ownership start source reuse with a different payload", async () => {
    const harness = createHarness({
      ownershipPeriods: [ownershipRow({ assetOwnerId: "different-owner" })]
    });

    await expectConflictCode(
      new AssetFactsRepository().openOwnershipPeriod(harness.tx, ownershipOpenInput()),
      ASSET_FACT_CONFLICT_CODE.OWNERSHIP_START_SOURCE
    );
  });

  it("does not replay an ownership fact whose vehicle aggregate is soft-deleted", async () => {
    const harness = createHarness({
      createOwnershipError: databaseConstraintError(
        "23505",
        "vehicle_ownership_period_start_source_key"
      ),
      deletedOwnershipVehicle: true,
      ownershipPeriods: [ownershipRow()]
    });

    await expectConflictCode(
      new AssetFactsRepository().openOwnershipPeriod(harness.tx, ownershipOpenInput()),
      ASSET_FACT_CONFLICT_CODE.OWNERSHIP_START_SOURCE
    );
  });

  it("closes an open ownership period without replacing the fact", async () => {
    const original = ownershipRow();
    const harness = createHarness({ ownershipPeriods: [original] });

    const result = await new AssetFactsRepository().closeOwnershipPeriod(
      harness.tx,
      ownershipCloseInput()
    );

    expect(result).toMatchObject({
      endConfirmedAt: END_CONFIRMED_AT,
      endConfirmedBy: "actor-2",
      endReason: VehicleOwnershipPeriodEndReason.OWNERSHIP_TRANSFER,
      endSnapshot: { transferId: "transfer-1" },
      endSourceId: "source-2",
      endSourceKey: "transfer:source-2:ownership:v1",
      endSourceType: "OWNERSHIP_TRANSFER",
      endedAt: ENDED_AT,
      id: original.id,
      startedAt: STARTED_AT
    });
    expect(harness.ownershipPeriods).toHaveLength(1);
  });

  it("returns the original closed ownership fact for an exact end source replay", async () => {
    const original = closedOwnershipRow();
    const harness = createHarness({ ownershipPeriods: [original] });

    const result = await new AssetFactsRepository().closeOwnershipPeriod(
      harness.tx,
      ownershipCloseInput()
    );

    expect(result).toBe(original);
  });

  it("normalizes ownership close snapshots to their JSONB storage form", async () => {
    const original = closedOwnershipRow({
      endSnapshot: {
        capturedAt: "2026-10-01T00:00:00.000Z",
        nested: { kept: true }
      }
    });
    const harness = createHarness({ ownershipPeriods: [original] });

    const result = await new AssetFactsRepository().closeOwnershipPeriod(
      harness.tx,
      ownershipCloseInput({ snapshot: storageEquivalentCloseInputSnapshot() })
    );

    expect(result).toBe(original);
  });

  it.each(OWNERSHIP_CLOSE_DRIFTS)(
    "rejects ownership close replay when %s drifts",
    async (_field, overrides) => {
      const harness = createHarness({ ownershipPeriods: [closedOwnershipRow()] });

      await expectConflictCode(
        new AssetFactsRepository().closeOwnershipPeriod(harness.tx, ownershipCloseInput(overrides)),
        ASSET_FACT_CONFLICT_CODE.OWNERSHIP_END_SOURCE
      );
    }
  );

  it.each(OWNERSHIP_CLOSE_SOURCE_VARIANTS)(
    "treats a changed ownership close source %s as a non-replay close",
    async (_field, source) => {
      const harness = createHarness({ ownershipPeriods: [closedOwnershipRow()] });

      await expectConflictCode(
        new AssetFactsRepository().closeOwnershipPeriod(
          harness.tx,
          ownershipCloseInput({ source })
        ),
        ASSET_FACT_CONFLICT_CODE.OWNERSHIP_CLOSE_REPLAY
      );
    }
  );

  it("does not replay an ownership close whose vehicle aggregate is soft-deleted", async () => {
    const harness = createHarness({
      deletedOwnershipVehicle: true,
      ownershipPeriods: [closedOwnershipRow()]
    });

    await expectConflictCode(
      new AssetFactsRepository().closeOwnershipPeriod(harness.tx, ownershipCloseInput()),
      ASSET_FACT_CONFLICT_CODE.OWNERSHIP_CLOSE_REPLAY
    );
  });

  it("rejects ownership end source reuse with a different close payload", async () => {
    const harness = createHarness({
      ownershipPeriods: [closedOwnershipRow({ endedAt: new Date("2026-10-02T00:00:00.000Z") })]
    });

    await expectConflictCode(
      new AssetFactsRepository().closeOwnershipPeriod(harness.tx, ownershipCloseInput()),
      ASSET_FACT_CONFLICT_CODE.OWNERSHIP_END_SOURCE
    );
  });

  it("rejects a second non-replay close command for a closed ownership period", async () => {
    const harness = createHarness({ ownershipPeriods: [closedOwnershipRow()] });

    await expectConflictCode(
      new AssetFactsRepository().closeOwnershipPeriod(harness.tx, {
        ...ownershipCloseInput(),
        source: {
          id: "source-3",
          key: "manual:source-3:ownership:v1",
          type: "MANUAL_REPAIR"
        }
      }),
      ASSET_FACT_CONFLICT_CODE.OWNERSHIP_CLOSE_REPLAY
    );
  });
});

describe("AssetFactsRepository database conflict normalization", () => {
  it.each([
    [
      "vehicle_subscription_period_start_source_key",
      ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_START_SOURCE
    ],
    [
      "vehicle_subscription_period_one_open_per_vehicle_uidx",
      ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_OPEN_VEHICLE
    ],
    [
      "vehicle_subscription_period_one_open_per_order_uidx",
      ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_OPEN_ORDER
    ],
    ["vehicle_subscription_period_no_overlap_excl", ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_OVERLAP],
    ["vehicle_subscription_period_end_after_start_chk", ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_RANGE]
  ])("maps subscription constraint %s", async (constraint, expectedCode) => {
    const harness = createHarness({
      createSubscriptionError: databaseConstraintError(
        constraint.endsWith("_excl") ? "23P01" : constraint.endsWith("_chk") ? "23514" : "23505",
        constraint
      )
    });

    await expectConflictCode(
      new AssetFactsRepository().openSubscriptionPeriod(harness.tx, subscriptionOpenInput()),
      expectedCode
    );
  });

  it.each([
    ["vehicle_ownership_period_start_source_key", ASSET_FACT_CONFLICT_CODE.OWNERSHIP_START_SOURCE],
    [
      "vehicle_ownership_period_one_open_per_vehicle_uidx",
      ASSET_FACT_CONFLICT_CODE.OWNERSHIP_OPEN_VEHICLE
    ],
    ["vehicle_ownership_period_no_overlap_excl", ASSET_FACT_CONFLICT_CODE.OWNERSHIP_OVERLAP],
    ["vehicle_ownership_period_end_after_start_chk", ASSET_FACT_CONFLICT_CODE.OWNERSHIP_RANGE]
  ])("maps ownership constraint %s", async (constraint, expectedCode) => {
    const harness = createHarness({
      createOwnershipError: databaseConstraintError(
        constraint.endsWith("_excl") ? "23P01" : constraint.endsWith("_chk") ? "23514" : "23505",
        constraint
      )
    });

    await expectConflictCode(
      new AssetFactsRepository().openOwnershipPeriod(harness.tx, ownershipOpenInput()),
      expectedCode
    );
  });

  it("maps the subscription end-source unique constraint during close", async () => {
    const harness = createHarness({
      subscriptionPeriods: [subscriptionRow()],
      updateSubscriptionError: databaseConstraintError(
        "23505",
        "vehicle_subscription_period_end_source_key"
      )
    });

    await expectConflictCode(
      new AssetFactsRepository().closeSubscriptionPeriod(harness.tx, subscriptionCloseInput()),
      ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_END_SOURCE
    );
  });

  it("maps the ownership end-source unique constraint during close", async () => {
    const harness = createHarness({
      ownershipPeriods: [ownershipRow()],
      updateOwnershipError: databaseConstraintError(
        "23505",
        "vehicle_ownership_period_end_source_key"
      )
    });

    await expectConflictCode(
      new AssetFactsRepository().closeOwnershipPeriod(harness.tx, ownershipCloseInput()),
      ASSET_FACT_CONFLICT_CODE.OWNERSHIP_END_SOURCE
    );
  });

  it("preserves a subscription constraint conflict without querying an aborted transaction", async () => {
    const harness = createHarness({
      abortSubscriptionTransactionAfterWriteError: true,
      createSubscriptionError: databaseConstraintError(
        "23P01",
        "vehicle_subscription_period_no_overlap_excl"
      )
    });

    await expectConflictCode(
      new AssetFactsRepository().openSubscriptionPeriod(harness.tx, subscriptionOpenInput()),
      ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_OVERLAP
    );
  });

  it("preserves an ownership constraint conflict without querying an aborted transaction", async () => {
    const harness = createHarness({
      abortOwnershipTransactionAfterWriteError: true,
      createOwnershipError: databaseConstraintError(
        "23P01",
        "vehicle_ownership_period_no_overlap_excl"
      )
    });

    await expectConflictCode(
      new AssetFactsRepository().openOwnershipPeriod(harness.tx, ownershipOpenInput()),
      ASSET_FACT_CONFLICT_CODE.OWNERSHIP_OVERLAP
    );
  });
});

describe("AssetFactsRepository transaction contract", () => {
  it("snapshots a direct caller source before a deferred advisory query", async () => {
    const row = subscriptionRow();
    const harness = createHarness({ subscriptionPeriods: [row] });
    const repository = new AssetFactsRepository();
    const originalSource = {
      id: "source-deferred-a",
      key: "return:source-deferred-a:occupancy:v1",
      type: "VEHICLE_RETURN"
    };
    const lockedSource = { ...originalSource };
    const advisoryQueryPending = deferred<void>();
    const releaseAdvisoryQuery = deferred<void>();
    const originalQuery = harness.tx.$queryRaw.bind(harness.tx);
    (harness.tx as unknown as { $queryRaw: (query: Prisma.Sql) => Promise<unknown[]> }).$queryRaw =
      async (query) => {
        const result = originalQuery(query) as Promise<unknown[]>;
        if (query.sql.includes("pg_advisory_xact_lock")) {
          advisoryQueryPending.resolve();
          await releaseAdvisoryQuery.promise;
        }
        return result;
      };
    const capabilityPromise = repository.prepareCallerOwnedCommand(
      harness.tx,
      "subscription",
      "end",
      originalSource
    );
    await advisoryQueryPending.promise;
    Object.assign(originalSource, {
      id: "source-deferred-b",
      key: "return:source-deferred-b:occupancy:v1",
      type: "MUTATED_RETURN"
    });
    releaseAdvisoryQuery.resolve();
    const capability = await capabilityPromise;

    await expectConflictCode(
      repository.closeSubscriptionPeriod(
        harness.tx,
        subscriptionCloseInput({ source: originalSource }),
        capability
      ),
      ASSET_FACT_CONFLICT_CODE.CALLER_CAPABILITY_INVALID
    );
    expect(row.endedAt).toBeNull();
    expect(
      harness.rawQueries.find(({ sql }) => sql.includes("pg_advisory_xact_lock"))?.values[0]
    ).toContain(lockedSource.id);
  });

  it("consumes one prepared subscription-close capability and rejects reuse", async () => {
    const harness = createHarness({ subscriptionPeriods: [subscriptionRow()] });
    const repository = new AssetFactsRepository();
    const command = subscriptionCloseInput();
    const capability = await repository.prepareCallerOwnedCommand(
      harness.tx,
      "subscription",
      "end",
      command.source
    );

    await repository.closeSubscriptionPeriod(harness.tx, command, capability);
    await expectConflictCode(
      repository.closeSubscriptionPeriod(harness.tx, command, capability),
      ASSET_FACT_CONFLICT_CODE.CALLER_CAPABILITY_INVALID
    );
  });

  it("consumes a repository capability before throwing snapshot normalization", async () => {
    const row = subscriptionRow();
    const harness = createHarness({ subscriptionPeriods: [row] });
    const repository = new AssetFactsRepository();
    const command = subscriptionCloseInput();
    const capability = await repository.prepareCallerOwnedCommand(
      harness.tx,
      "subscription",
      "end",
      command.source
    );
    const malformed = Object.defineProperty({ ...command }, "snapshot", {
      get() {
        throw new TypeError("throwing fact snapshot getter");
      }
    }) as typeof command;

    await expect(
      repository.closeSubscriptionPeriod(harness.tx, malformed, capability)
    ).rejects.toThrow("throwing fact snapshot getter");
    await expectConflictCode(
      repository.closeSubscriptionPeriod(harness.tx, command, capability),
      ASSET_FACT_CONFLICT_CODE.CALLER_CAPABILITY_INVALID
    );
    expect(row.endedAt).toBeNull();
  });

  it("rejects forged, foreign-repository, wrong-transaction, and wrong-source fact capabilities", async () => {
    const harness = createHarness({ subscriptionPeriods: [subscriptionRow()] });
    const repository = new AssetFactsRepository();
    const command = subscriptionCloseInput();
    const capability = await repository.prepareCallerOwnedCommand(
      harness.tx,
      "subscription",
      "end",
      command.source
    );
    const otherHarness = createHarness({ subscriptionPeriods: [subscriptionRow()] });

    for (const [target, tx, candidate, input] of [
      [repository, harness.tx, Object.freeze({}), command],
      [new AssetFactsRepository(), harness.tx, capability, command],
      [repository, otherHarness.tx, capability, command],
      [
        repository,
        harness.tx,
        await repository.prepareCallerOwnedCommand(
          harness.tx,
          "subscription",
          "end",
          command.source
        ),
        { ...command, source: { ...command.source, key: "different-source" } }
      ]
    ] as const) {
      await expectConflictCode(
        target.closeSubscriptionPeriod(tx, input, candidate as never),
        ASSET_FACT_CONFLICT_CODE.CALLER_CAPABILITY_INVALID
      );
    }
  });

  it("rejects a root Prisma client passed in place of an interactive transaction", async () => {
    const harness = createHarness({
      subscriptionPeriods: [subscriptionRow()],
      transactionIds: ["root-autocommit-1", "root-autocommit-2"]
    });

    await expectConflictCode(
      new AssetFactsRepository().openSubscriptionPeriod(harness.tx, subscriptionOpenInput()),
      "ASSET_FACT_TRANSACTION_CONTRACT_VIOLATION"
    );
  });

  it("rejects a transaction whose PostgreSQL isolation is not READ COMMITTED", async () => {
    const harness = createHarness({
      isolationLevel: "serializable",
      subscriptionPeriods: [subscriptionRow()]
    });

    await expectConflictCode(
      new AssetFactsRepository().openSubscriptionPeriod(harness.tx, subscriptionOpenInput()),
      "ASSET_FACT_TRANSACTION_CONTRACT_VIOLATION"
    );
  });
});

describe("Asset fact command DTO validation", () => {
  it("rejects malformed dates and reasons before a command reaches the service", () => {
    const dto = plainToInstance(CloseSubscriptionPeriodDto, {
      confirmedAt: "not-a-date",
      endedAt: "also-not-a-date",
      periodId: "not-a-uuid",
      reason: "NOT_A_SUBSCRIPTION_END_REASON",
      snapshot: [],
      source: {
        id: "not-a-uuid",
        key: "",
        type: ""
      }
    });

    const invalidProperties = validateSync(dto)
      .map(({ property }) => property)
      .sort();

    expect(invalidProperties).toEqual([
      "confirmedAt",
      "endedAt",
      "periodId",
      "reason",
      "snapshot",
      "source"
    ]);
  });

  it.each([
    [
      OpenSubscriptionPeriodDto,
      serviceSubscriptionOpenDto({
        contractId: "00000000-0000-4000-8000-000000000103",
        contractSegmentId: "00000000-0000-4000-8000-000000000104",
        customerId: "00000000-0000-4000-8000-000000000102",
        orderId: "00000000-0000-4000-8000-000000000101",
        vehicleId: "00000000-0000-4000-8000-000000000100"
      })
    ],
    [
      CloseSubscriptionPeriodDto,
      serviceSubscriptionCloseDto("00000000-0000-4000-8000-000000000105")
    ],
    [
      OpenOwnershipPeriodDto,
      serviceOwnershipOpenDto({
        assetOwnerId: "00000000-0000-4000-8000-000000000107",
        vehicleId: "00000000-0000-4000-8000-000000000106"
      })
    ],
    [CloseOwnershipPeriodDto, serviceOwnershipCloseDto("00000000-0000-4000-8000-000000000108")]
  ])("accepts a valid %s command payload", (Dto, payload) => {
    expect(validateSync(plainToInstance(Dto as new () => object, payload) as object)).toEqual([]);
  });
});

describe("AssetFactsService audited commands", () => {
  it("snapshots the outer caller source before a deferred advisory query", async () => {
    const row = subscriptionRow();
    const harness = createServiceHarness({ subscriptionPeriods: [row] });
    const originalSource = {
      id: "source-service-deferred-a",
      key: "return:source-service-deferred-a:occupancy:v1",
      type: "VEHICLE_RETURN"
    };
    const dto = serviceSubscriptionCloseDto("subscription-period-1", {
      source: originalSource
    });
    const advisoryQueryPending = deferred<void>();
    const releaseAdvisoryQuery = deferred<void>();
    const originalQuery = harness.tx.$queryRaw.bind(harness.tx);
    (harness.tx as unknown as { $queryRaw: (query: Prisma.Sql) => Promise<unknown[]> }).$queryRaw =
      async (query) => {
        const result = originalQuery(query) as Promise<unknown[]>;
        if (query.sql.includes("pg_advisory_xact_lock")) {
          advisoryQueryPending.resolve();
          await releaseAdvisoryQuery.promise;
        }
        return result;
      };
    const capabilityPromise = harness.service.prepareCallerOwnedTransaction(
      harness.tx,
      "subscription",
      "end",
      originalSource
    );
    await advisoryQueryPending.promise;
    Object.assign(originalSource, {
      id: "source-service-deferred-b",
      key: "return:source-service-deferred-b:occupancy:v1",
      type: "MUTATED_RETURN"
    });
    releaseAdvisoryQuery.resolve();
    const capability = await capabilityPromise;

    await expectConflictCode(
      harness.service.closeSubscriptionPeriodInTransaction(
        harness.tx,
        dto,
        serviceContext(),
        capability
      ),
      ASSET_FACT_SERVICE_CODE.CALLER_CAPABILITY_INVALID
    );
    expect(row.endedAt).toBeNull();
    expect(harness.auditLogs).toHaveLength(0);
  });

  it("uses one caller-owned close capability without opening a nested transaction", async () => {
    const harness = createServiceHarness({ subscriptionPeriods: [subscriptionRow()] });
    const dto = serviceSubscriptionCloseDto("subscription-period-1");
    const capability = await harness.service.prepareCallerOwnedTransaction(
      harness.tx,
      "subscription",
      "end",
      dto.source
    );

    await harness.service.closeSubscriptionPeriodInTransaction(
      harness.tx,
      dto,
      serviceContext(),
      capability
    );

    expect(harness.transactionOptions).toEqual([]);
    expect(harness.auditLogs).toHaveLength(1);
    expect(
      harness.rawQueries
        .filter(({ sql }) => sql.includes(" FOR "))
        .map(({ sql }) => sql.match(/FROM "([a-z_]+)"/)?.[1])
    ).toEqual([
      "subscription_order",
      "vehicle",
      "contract",
      "subscription_contract_segment",
      "vehicle_subscription_period",
      "customer"
    ]);
    expect(
      harness.rawQueries
        .filter(({ sql }) => sql.includes(" FOR "))
        .every(({ sql }) => sql.includes("NOWAIT"))
    ).toBe(true);
    await expectConflictCode(
      harness.service.closeSubscriptionPeriodInTransaction(
        harness.tx,
        dto,
        serviceContext(),
        capability
      ),
      ASSET_FACT_SERVICE_CODE.CALLER_CAPABILITY_INVALID
    );
  });

  it("consumes a service capability before reading a throwing source", async () => {
    const row = subscriptionRow();
    const harness = createServiceHarness({ subscriptionPeriods: [row] });
    const dto = serviceSubscriptionCloseDto("subscription-period-1");
    const capability = await harness.service.prepareCallerOwnedTransaction(
      harness.tx,
      "subscription",
      "end",
      dto.source
    );
    const malformed = Object.defineProperty({ ...dto }, "source", {
      get() {
        throw new TypeError("throwing fact service source getter");
      }
    }) as typeof dto;

    await expect(
      harness.service.closeSubscriptionPeriodInTransaction(
        harness.tx,
        malformed,
        serviceContext(),
        capability
      )
    ).rejects.toThrow("throwing fact service source getter");
    await expectConflictCode(
      harness.service.closeSubscriptionPeriodInTransaction(
        harness.tx,
        dto,
        serviceContext(),
        capability
      ),
      ASSET_FACT_SERVICE_CODE.CALLER_CAPABILITY_INVALID
    );
    expect(row.endedAt).toBeNull();
    expect(harness.auditLogs).toHaveLength(0);
  });

  it("opens every command in an explicit Prisma READ COMMITTED transaction", async () => {
    const harness = createServiceHarness();

    await harness.service.openSubscriptionPeriod(serviceSubscriptionOpenDto(), serviceContext());

    expect(harness.transactionOptions).toEqual([
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    ]);
  });

  it("captures authoritative live aggregate identities without trusting caller snapshot fields", async () => {
    const harness = createServiceHarness();

    const opened = await harness.service.openSubscriptionPeriod(
      serviceSubscriptionOpenDto({
        snapshot: {
          contractId: "spoofed-contract",
          customerId: "spoofed-customer",
          note: "operator supplied description",
          orderId: "spoofed-order",
          vehicleId: "spoofed-vehicle"
        }
      }),
      serviceContext()
    );

    expect(opened.startSnapshot).toEqual({
      authority: {
        contract: {
          contractNo: "CONTRACT-1",
          customerId: "customer-1",
          id: "contract-1",
          orderId: "order-1",
          status: ContractStatus.ARCHIVED
        },
        contractSegment: {
          endDate: "2026-10-31",
          id: "segment-1",
          orderId: "order-1",
          segmentNo: "SEGMENT-1",
          sourceContractId: "contract-1",
          startDate: "2026-08-01",
          status: "ACTIVE"
        },
        customer: {
          customerNo: "CUSTOMER-1",
          id: "customer-1",
          name: "Stage 1C Customer",
          status: "ACTIVE"
        },
        order: {
          contractId: "contract-1",
          customerId: "customer-1",
          id: "order-1",
          orderNo: "ORDER-1",
          orderStatus: OrderStatus.ACTIVE,
          vehicleId: "vehicle-1"
        },
        vehicle: {
          id: "vehicle-1",
          plateNo: "沪A00001",
          status: VehicleStatus.LEASED,
          vehicleNo: "VEHICLE-1",
          vin: "VIN-1"
        }
      },
      metadata: {
        contractId: "spoofed-contract",
        customerId: "spoofed-customer",
        note: "operator supplied description",
        orderId: "spoofed-order",
        vehicleId: "spoofed-vehicle"
      }
    });
    expect(opened.vehicleId).toBe("vehicle-1");
    expect(opened.orderId).toBe("order-1");
    expect(opened.customerId).toBe("customer-1");
    expect(opened.contractId).toBe("contract-1");
    expect(harness.auditLogs).toMatchObject([
      {
        afterSnapshot: {
          startSnapshot: {
            authority: {
              contractSegment: {
                endDate: "2026-10-31",
                startDate: "2026-08-01",
                status: "ACTIVE"
              }
            }
          }
        }
      }
    ]);
  });

  it.each([
    [
      "cancelled",
      (segment: ServiceContractSegmentRecord) => {
        segment.status = "CANCELLED";
      }
    ],
    [
      "before its inclusive UTC start day",
      (segment: ServiceContractSegmentRecord) => {
        segment.startDate = new Date("2026-08-02T00:00:00.000Z");
      }
    ],
    [
      "after its inclusive UTC end day",
      (segment: ServiceContractSegmentRecord) => {
        segment.endDate = new Date("2026-07-31T00:00:00.000Z");
      }
    ]
  ] as const)("rejects a selected contract segment that is %s", async (_case, mutate) => {
    const harness = createServiceHarness();
    mutate(harness.records.contractSegments.get("segment-1")!);

    await expectServiceError(
      harness.service.openSubscriptionPeriod(serviceSubscriptionOpenDto(), serviceContext()),
      ConflictException,
      "ASSET_FACT_CONTRACT_SEGMENT_INVALID"
    );
    expect(harness.subscriptionPeriods).toEqual([]);
    expect(harness.auditLogs).toEqual([]);
  });

  it.each([
    ["start", "2026-08-01T23:59:59.999Z", "2026-08-02T00:00:00.000Z"],
    ["end", "2026-10-31T23:59:59.999Z", "2026-11-01T00:00:00.000Z"]
  ] as const)(
    "accepts the exact inclusive UTC %s boundary day for a selected contract segment",
    async (_boundary, startedAt, confirmedAt) => {
      const harness = createServiceHarness();

      const fact = await harness.service.openSubscriptionPeriod(
        serviceSubscriptionOpenDto({ confirmedAt, startedAt }),
        serviceContext()
      );

      expect(fact.startSnapshot).toMatchObject({
        authority: {
          contractSegment: {
            endDate: "2026-10-31",
            startDate: "2026-08-01",
            status: "ACTIVE"
          }
        }
      });
      expect(harness.subscriptionPeriods).toHaveLength(1);
      expect(harness.auditLogs).toHaveLength(1);
    }
  );

  it("returns the original fact without a second audit for unchanged valid segment authority replay", async () => {
    const harness = createServiceHarness();
    const dto = serviceSubscriptionOpenDto();

    const original = await harness.service.openSubscriptionPeriod(dto, serviceContext());
    const replay = await harness.service.openSubscriptionPeriod(dto, serviceContext());

    expect(replay.id).toBe(original.id);
    expect(harness.subscriptionPeriods).toHaveLength(1);
    expect(harness.auditLogs).toHaveLength(1);
  });

  it("fails a replay closed when selected segment authority changed but remains valid", async () => {
    const harness = createServiceHarness();
    const dto = serviceSubscriptionOpenDto();
    const original = await harness.service.openSubscriptionPeriod(dto, serviceContext());
    harness.records.contractSegments.get("segment-1")!.endDate = new Date(
      "2026-11-30T00:00:00.000Z"
    );

    await expectServiceError(
      harness.service.openSubscriptionPeriod(dto, serviceContext()),
      ConflictException,
      ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_START_SOURCE
    );
    expect(harness.subscriptionPeriods).toEqual([original]);
    expect(harness.auditLogs).toHaveLength(1);
  });

  it("fails a replay closed when selected segment authority becomes invalid", async () => {
    const harness = createServiceHarness();
    const dto = serviceSubscriptionOpenDto();
    const original = await harness.service.openSubscriptionPeriod(dto, serviceContext());
    harness.records.contractSegments.get("segment-1")!.status = "CANCELLED";

    await expectServiceError(
      harness.service.openSubscriptionPeriod(dto, serviceContext()),
      ConflictException,
      "ASSET_FACT_CONTRACT_SEGMENT_INVALID"
    );
    expect(harness.subscriptionPeriods).toEqual([original]);
    expect(harness.auditLogs).toHaveLength(1);
  });

  it.each([
    ["vehicle", ASSET_FACT_SERVICE_CODE.VEHICLE_NOT_FOUND],
    ["order", ASSET_FACT_SERVICE_CODE.ORDER_NOT_FOUND],
    ["customer", ASSET_FACT_SERVICE_CODE.CUSTOMER_NOT_FOUND],
    ["contract", ASSET_FACT_SERVICE_CODE.CONTRACT_NOT_FOUND],
    ["contractSegment", ASSET_FACT_SERVICE_CODE.CONTRACT_SEGMENT_NOT_FOUND]
  ] as const)("rejects a missing or soft-deleted %s reference", async (reference, code) => {
    const harness = createServiceHarness();
    softDeleteServiceReference(harness.records, reference);

    await expectServiceError(
      harness.service.openSubscriptionPeriod(serviceSubscriptionOpenDto(), serviceContext()),
      NotFoundException,
      code
    );
    expect(harness.auditLogs).toEqual([]);
  });

  it("rejects a missing asset owner reference", async () => {
    const harness = createServiceHarness();
    harness.records.assetOwners.clear();

    await expectServiceError(
      harness.service.openOwnershipPeriod(serviceOwnershipOpenDto(), serviceContext()),
      NotFoundException,
      ASSET_FACT_SERVICE_CODE.ASSET_OWNER_NOT_FOUND
    );
  });

  it.each([
    [
      "order vehicle",
      (records: ServiceRecords) => {
        records.orders.get("order-1")!.vehicleId = "vehicle-2";
      }
    ],
    [
      "order customer",
      (records: ServiceRecords) => {
        records.orders.get("order-1")!.customerId = "customer-2";
      }
    ],
    [
      "contract order",
      (records: ServiceRecords) => {
        records.contracts.get("contract-1")!.orderId = "order-2";
      }
    ],
    [
      "contract customer",
      (records: ServiceRecords) => {
        records.contracts.get("contract-1")!.customerId = "customer-2";
      }
    ],
    [
      "segment order",
      (records: ServiceRecords) => {
        records.contractSegments.get("segment-1")!.orderId = "order-2";
      }
    ],
    [
      "segment contract",
      (records: ServiceRecords) => {
        records.contractSegments.get("segment-1")!.sourceContractId = "contract-2";
      }
    ]
  ] as const)("rejects inconsistent %s aggregate identity", async (_case, corrupt) => {
    const harness = createServiceHarness();
    corrupt(harness.records);

    await expectServiceError(
      harness.service.openSubscriptionPeriod(serviceSubscriptionOpenDto(), serviceContext()),
      ConflictException,
      ASSET_FACT_SERVICE_CODE.SUBSCRIPTION_AGGREGATE_MISMATCH
    );
    expect(harness.auditLogs).toEqual([]);
  });

  it("rejects an invalid close range and a confirmation before the end instant", async () => {
    const harness = createServiceHarness({ subscriptionPeriods: [subscriptionRow()] });

    await expectServiceError(
      harness.service.closeSubscriptionPeriod(
        serviceSubscriptionCloseDto("subscription-period-1", {
          endedAt: STARTED_AT.toISOString()
        }),
        serviceContext()
      ),
      BadRequestException,
      ASSET_FACT_SERVICE_CODE.INVALID_TIME_RANGE
    );
    await expectServiceError(
      harness.service.closeSubscriptionPeriod(
        serviceSubscriptionCloseDto("subscription-period-1", {
          confirmedAt: "2026-09-30T23:59:59.999Z"
        }),
        serviceContext()
      ),
      BadRequestException,
      ASSET_FACT_SERVICE_CODE.INVALID_CONFIRMATION_TIME
    );
    expect(harness.auditLogs).toEqual([]);
  });

  it("rejects a confirmation before an opened period starts", async () => {
    const harness = createServiceHarness();

    await expectServiceError(
      harness.service.openSubscriptionPeriod(
        serviceSubscriptionOpenDto({ confirmedAt: "2026-07-31T23:59:59.999Z" }),
        serviceContext()
      ),
      BadRequestException,
      ASSET_FACT_SERVICE_CODE.INVALID_CONFIRMATION_TIME
    );
    expect(harness.transactionOptions).toEqual([]);
  });

  it.each([
    ["subscription", "NOT_A_SUBSCRIPTION_REASON"],
    ["ownership", "NOT_AN_OWNERSHIP_REASON"]
  ] as const)("rejects an illegal %s start reason at the domain boundary", async (kind, reason) => {
    const harness = createServiceHarness();
    const command =
      kind === "subscription"
        ? harness.service.openSubscriptionPeriod(
            serviceSubscriptionOpenDto({
              reason: reason as VehicleSubscriptionPeriodStartReason
            }),
            serviceContext()
          )
        : harness.service.openOwnershipPeriod(
            serviceOwnershipOpenDto({ reason: reason as VehicleOwnershipPeriodStartReason }),
            serviceContext()
          );

    await expectServiceError(
      command,
      BadRequestException,
      ASSET_FACT_SERVICE_CODE.INVALID_START_REASON
    );
    expect(harness.transactionOptions).toEqual([]);
  });

  it.each([
    ["subscription", "NOT_A_SUBSCRIPTION_REASON"],
    ["ownership", "NOT_AN_OWNERSHIP_REASON"]
  ] as const)("rejects an illegal %s close reason at the domain boundary", async (kind, reason) => {
    const harness = createServiceHarness({
      ownershipPeriods: [ownershipRow()],
      subscriptionPeriods: [subscriptionRow()]
    });
    const command =
      kind === "subscription"
        ? harness.service.closeSubscriptionPeriod(
            serviceSubscriptionCloseDto("subscription-period-1", {
              reason: reason as VehicleSubscriptionPeriodEndReason
            }),
            serviceContext()
          )
        : harness.service.closeOwnershipPeriod(
            serviceOwnershipCloseDto("ownership-period-1", {
              reason: reason as VehicleOwnershipPeriodEndReason
            }),
            serviceContext()
          );

    await expectServiceError(
      command,
      BadRequestException,
      ASSET_FACT_SERVICE_CODE.INVALID_END_REASON
    );
  });

  it("audits each new fact and first successful close once, then skips exact replays", async () => {
    const harness = createServiceHarness();
    const subscriptionOpen = serviceSubscriptionOpenDto();
    const ownershipOpen = serviceOwnershipOpenDto({
      snapshot: { assetOwnerId: "spoofed-owner", vehicleId: "spoofed-vehicle" }
    });

    const subscription = await harness.service.openSubscriptionPeriod(
      subscriptionOpen,
      serviceContext()
    );
    const ownership = await harness.service.openOwnershipPeriod(ownershipOpen, serviceContext());
    const subscriptionClose = serviceSubscriptionCloseDto(subscription.id, {
      snapshot: { orderId: "spoofed-order", vehicleId: "spoofed-vehicle" }
    });
    const ownershipClose = serviceOwnershipCloseDto(ownership.id, {
      snapshot: { assetOwnerId: "spoofed-owner", vehicleId: "spoofed-vehicle" }
    });
    const closedSubscription = await harness.service.closeSubscriptionPeriod(
      subscriptionClose,
      serviceContext()
    );
    const closedOwnership = await harness.service.closeOwnershipPeriod(
      ownershipClose,
      serviceContext()
    );

    expect(ownership.startSnapshot).toMatchObject({
      authority: {
        assetOwner: { id: "owner-1", ownerNo: "OWNER-1" },
        vehicle: { id: "vehicle-1", vehicleNo: "VEHICLE-1" }
      },
      metadata: { assetOwnerId: "spoofed-owner", vehicleId: "spoofed-vehicle" }
    });
    expect(closedSubscription.endSnapshot).toMatchObject({
      authority: {
        customer: { id: "customer-1" },
        order: { id: "order-1" },
        vehicle: { id: "vehicle-1" }
      },
      metadata: { orderId: "spoofed-order", vehicleId: "spoofed-vehicle" }
    });
    expect(closedOwnership.endSnapshot).toMatchObject({
      authority: {
        assetOwner: { id: "owner-1" },
        vehicle: { id: "vehicle-1" }
      },
      metadata: { assetOwnerId: "spoofed-owner", vehicleId: "spoofed-vehicle" }
    });

    expect(
      harness.auditLogs.map(({ action, entityId, entityType }) => ({
        action,
        entityId,
        entityType
      }))
    ).toEqual([
      {
        action: AuditAction.CREATE,
        entityId: subscription.id,
        entityType: "vehicle_subscription_period"
      },
      {
        action: AuditAction.CREATE,
        entityId: ownership.id,
        entityType: "vehicle_ownership_period"
      },
      {
        action: AuditAction.UPDATE,
        entityId: subscription.id,
        entityType: "vehicle_subscription_period"
      },
      {
        action: AuditAction.UPDATE,
        entityId: ownership.id,
        entityType: "vehicle_ownership_period"
      }
    ]);

    await harness.service.openSubscriptionPeriod(subscriptionOpen, serviceContext());
    await harness.service.openOwnershipPeriod(ownershipOpen, serviceContext());
    await harness.service.closeSubscriptionPeriod(subscriptionClose, serviceContext());
    await harness.service.closeOwnershipPeriod(ownershipClose, serviceContext());

    expect(harness.auditLogs).toHaveLength(4);
  });

  it("serializes concurrent exact start replay and commits only one audit row", async () => {
    const harness = createServiceHarness();
    const dto = serviceSubscriptionOpenDto();

    const [first, second] = await Promise.all([
      harness.service.openSubscriptionPeriod(dto, serviceContext()),
      harness.service.openSubscriptionPeriod(dto, serviceContext())
    ]);

    expect(second.id).toBe(first.id);
    expect(harness.subscriptionPeriods).toHaveLength(1);
    expect(harness.auditLogs).toHaveLength(1);
  });

  it.each([
    [
      "direct PostgreSQL adapter error",
      {
        code: "55P03",
        message: "could not obtain lock with secret connection details"
      }
    ],
    [
      "Prisma raw-query wrapper",
      {
        code: "P2010",
        meta: {
          driverAdapterError: {
            cause: {
              originalCode: "55P03",
              originalMessage: "could not obtain lock with secret connection details"
            }
          }
        }
      }
    ]
  ] as const)("maps a %s to the stable authority-busy conflict", async (_case, lockError) => {
    const harness = createServiceHarness({ authorityLockError: lockError });

    try {
      await harness.service.openSubscriptionPeriod(serviceSubscriptionOpenDto(), serviceContext());
      throw new Error("Expected the authority lock to fail fast.");
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toEqual({
        code: "ASSET_FACT_AUTHORITY_BUSY",
        message: "Asset fact authority is being updated. Review the current state and retry."
      });
      expect(JSON.stringify((error as ConflictException).getResponse())).not.toContain("secret");
      expect(JSON.stringify((error as ConflictException).getResponse())).not.toContain("55P03");
    }
    expect(harness.subscriptionPeriods).toEqual([]);
    expect(harness.auditLogs).toEqual([]);
  });

  it.each([
    ["message", { code: "UNRELATED_DATABASE_ERROR", message: "55P03" }],
    ["payload", { code: "UNRELATED_DATABASE_ERROR", payload: "55P03" }],
    [
      "nested payload",
      {
        code: "UNRELATED_DATABASE_ERROR",
        payload: { code: "55P03" }
      }
    ]
  ] as const)("rethrows an unrelated error with 55P03 in its %s", async (_case, lockError) => {
    const harness = createServiceHarness({ authorityLockError: lockError });

    await expect(
      harness.service.openSubscriptionPeriod(serviceSubscriptionOpenDto(), serviceContext())
    ).rejects.toBe(lockError);
    expect(harness.subscriptionPeriods).toEqual([]);
    expect(harness.auditLogs).toEqual([]);
  });
});

describe("AssetFactsService read projections", () => {
  it("discovers occupancy-compatible order and lease facts for a vehicle without a current subscription", async () => {
    const harness = createServiceHarness();
    harness.records.orders.get("order-1")!.orderStatus = OrderStatus.ACTIVE;
    harness.records.vehicles.get("vehicle-1")!.status = VehicleStatus.LEASED;
    harness.records.leases.get("order-1")!.status = LeaseStatus.ACTIVE;

    const projection = await harness.service.getByVehicle("vehicle-1");

    expect(projection.runtime).toEqual({
      leaseStatus: LeaseStatus.ACTIVE,
      orderStatus: OrderStatus.ACTIVE,
      vehicleStatus: VehicleStatus.LEASED
    });
    expect(projection.discrepancyFlags).toEqual([
      "ORDER_WITHOUT_CURRENT_SUBSCRIPTION",
      "LEASE_WITHOUT_CURRENT_SUBSCRIPTION",
      "VEHICLE_WITHOUT_CURRENT_SUBSCRIPTION"
    ]);
  });

  it("flags an occupancy-compatible lease even when its vehicle order status is not compatible", async () => {
    const harness = createServiceHarness();
    harness.records.orders.get("order-1")!.orderStatus = OrderStatus.CANCELLED;
    harness.records.vehicles.get("vehicle-1")!.status = VehicleStatus.AVAILABLE;
    harness.records.leases.get("order-1")!.status = LeaseStatus.ACTIVE;

    const projection = await harness.service.getByVehicle("vehicle-1");

    expect(projection.runtime).toEqual({
      leaseStatus: LeaseStatus.ACTIVE,
      orderStatus: OrderStatus.CANCELLED,
      vehicleStatus: VehicleStatus.AVAILABLE
    });
    expect(projection.discrepancyFlags).toEqual(["LEASE_WITHOUT_CURRENT_SUBSCRIPTION"]);
  });

  it("flags a current vehicle subscription whose order belongs to another customer", async () => {
    const current = subscriptionRow({ customerId: "customer-2" });
    const harness = createServiceHarness({ subscriptionPeriods: [current] });

    const projection = await harness.service.getByVehicle("vehicle-1");

    expect(projection.discrepancyFlags).toContain("OPEN_SUBSCRIPTION_ORDER_CUSTOMER_MISMATCH");
  });

  it("returns vehicle current/history source identity and deterministic runtime discrepancy flags", async () => {
    const current = subscriptionRow({
      customerId: "customer-2",
      id: "subscription-current",
      orderId: "order-2",
      vehicleId: "vehicle-1"
    });
    const historical = closedSubscriptionRow({
      endedAt: new Date("2026-07-01T00:00:00.000Z"),
      id: "subscription-history",
      startedAt: new Date("2026-06-01T00:00:00.000Z")
    });
    const currentOwnership = ownershipRow({ id: "ownership-current" });
    const historicalOwnership = closedOwnershipRow({
      endedAt: new Date("2026-05-01T00:00:00.000Z"),
      id: "ownership-history",
      startedAt: new Date("2026-04-01T00:00:00.000Z")
    });
    const harness = createServiceHarness({
      ownershipPeriods: [historicalOwnership, currentOwnership],
      subscriptionPeriods: [historical, current]
    });
    harness.records.vehicles.get("vehicle-1")!.status = VehicleStatus.AVAILABLE;
    harness.records.orders.set("order-2", {
      contractId: null,
      customerId: "customer-2",
      deletedAt: null,
      id: "order-2",
      orderNo: "ORDER-2",
      orderStatus: OrderStatus.CANCELLED,
      vehicleId: "vehicle-2"
    });

    const projection = await harness.service.getByVehicle("vehicle-1");

    expect(projection.subscription.current).toMatchObject({
      id: "subscription-current",
      start: {
        reason: VehicleSubscriptionPeriodStartReason.DELIVERY_CONFIRMED,
        source: {
          id: "source-1",
          key: "delivery:source-1:occupancy:v1",
          type: "DELIVERY"
        }
      }
    });
    expect(projection.subscription.history.map(({ id }) => id)).toEqual(["subscription-history"]);
    expect(projection.ownership.current).toMatchObject({
      assetOwnerId: "owner-1",
      id: "ownership-current",
      start: {
        source: {
          id: "source-1",
          key: "acquisition:source-1:ownership:v1",
          type: "ACQUISITION"
        }
      }
    });
    expect(projection.ownership.history.map(({ id }) => id)).toEqual(["ownership-history"]);
    expect(projection.discrepancyFlags).toEqual([
      "OPEN_SUBSCRIPTION_ORDER_VEHICLE_MISMATCH",
      "OPEN_SUBSCRIPTION_ORDER_STATUS_MISMATCH",
      "OPEN_SUBSCRIPTION_LEASE_MISSING",
      "OPEN_SUBSCRIPTION_VEHICLE_STATUS_MISMATCH"
    ]);
  });

  it("returns order current/history source identity and missing-period flags in stable order", async () => {
    const harness = createServiceHarness();
    harness.records.orders.get("order-1")!.orderStatus = OrderStatus.ACTIVE;
    harness.records.vehicles.get("vehicle-1")!.status = VehicleStatus.LEASED;
    harness.records.leases.get("order-1")!.status = LeaseStatus.ACTIVE;

    const projection = await harness.service.getByOrder("order-1");

    expect(projection.subscription).toEqual({ current: null, history: [] });
    expect(projection.runtime).toEqual({
      leaseStatus: LeaseStatus.ACTIVE,
      orderStatus: OrderStatus.ACTIVE,
      vehicleStatus: VehicleStatus.LEASED
    });
    expect(projection.discrepancyFlags).toEqual([
      "ORDER_WITHOUT_CURRENT_SUBSCRIPTION",
      "LEASE_WITHOUT_CURRENT_SUBSCRIPTION",
      "VEHICLE_WITHOUT_CURRENT_SUBSCRIPTION"
    ]);
  });
});

function subscriptionOpenInput(
  overrides: Partial<OpenSubscriptionPeriodInput> = {}
): OpenSubscriptionPeriodInput {
  return {
    actorId: "actor-1",
    confirmedAt: START_CONFIRMED_AT,
    contractId: "contract-1",
    contractSegmentId: "segment-1",
    customerId: "customer-1",
    reason: VehicleSubscriptionPeriodStartReason.DELIVERY_CONFIRMED,
    snapshot: Object.freeze({ deliveryId: "delivery-1", vehicleVin: "VIN-1" }),
    source: Object.freeze({
      id: "source-1",
      key: "delivery:source-1:occupancy:v1",
      type: "DELIVERY"
    }),
    startedAt: STARTED_AT,
    orderId: "order-1",
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function subscriptionCloseInput(
  overrides: Partial<CloseSubscriptionPeriodInput> = {}
): CloseSubscriptionPeriodInput {
  return {
    actorId: "actor-2",
    confirmedAt: END_CONFIRMED_AT,
    endedAt: ENDED_AT,
    periodId: "subscription-period-1",
    reason: VehicleSubscriptionPeriodEndReason.RETURN_CONFIRMED,
    snapshot: Object.freeze({ returnId: "return-1", vehicleVin: "VIN-1" }),
    source: Object.freeze({
      id: "source-2",
      key: "return:source-2:occupancy:v1",
      type: "VEHICLE_RETURN"
    }),
    ...overrides
  };
}

function ownershipOpenInput(
  overrides: Partial<OpenOwnershipPeriodInput> = {}
): OpenOwnershipPeriodInput {
  return {
    actorId: "actor-1",
    assetOwnerId: "owner-1",
    confirmedAt: START_CONFIRMED_AT,
    reason: VehicleOwnershipPeriodStartReason.INITIAL_ACQUISITION,
    snapshot: Object.freeze({ acquisitionId: "acquisition-1", ownerNo: "PLATFORM" }),
    source: Object.freeze({
      id: "source-1",
      key: "acquisition:source-1:ownership:v1",
      type: "ACQUISITION"
    }),
    startedAt: STARTED_AT,
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function ownershipCloseInput(
  overrides: Partial<CloseOwnershipPeriodInput> = {}
): CloseOwnershipPeriodInput {
  return {
    actorId: "actor-2",
    confirmedAt: END_CONFIRMED_AT,
    endedAt: ENDED_AT,
    periodId: "ownership-period-1",
    reason: VehicleOwnershipPeriodEndReason.OWNERSHIP_TRANSFER,
    snapshot: Object.freeze({ transferId: "transfer-1" }),
    source: Object.freeze({
      id: "source-2",
      key: "transfer:source-2:ownership:v1",
      type: "OWNERSHIP_TRANSFER"
    }),
    ...overrides
  };
}

function subscriptionRow(
  overrides: Partial<VehicleSubscriptionPeriod> = {}
): VehicleSubscriptionPeriod {
  return {
    contractId: "contract-1",
    contractSegmentId: "segment-1",
    createdAt: new Date("2026-08-01T00:05:01.000Z"),
    createdBy: "actor-1",
    customerId: "customer-1",
    endConfirmedAt: null,
    endConfirmedBy: null,
    endReason: null,
    endSnapshot: null,
    endSourceId: null,
    endSourceKey: null,
    endSourceType: null,
    endedAt: null,
    id: "subscription-period-1",
    orderId: "order-1",
    startConfirmedAt: START_CONFIRMED_AT,
    startConfirmedBy: "actor-1",
    startReason: VehicleSubscriptionPeriodStartReason.DELIVERY_CONFIRMED,
    startSnapshot: { deliveryId: "delivery-1", vehicleVin: "VIN-1" },
    startSourceId: "source-1",
    startSourceKey: "delivery:source-1:occupancy:v1",
    startSourceType: "DELIVERY",
    startedAt: STARTED_AT,
    updatedAt: new Date("2026-08-01T00:05:01.000Z"),
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function closedSubscriptionRow(
  overrides: Partial<VehicleSubscriptionPeriod> = {}
): VehicleSubscriptionPeriod {
  return subscriptionRow({
    endConfirmedAt: END_CONFIRMED_AT,
    endConfirmedBy: "actor-2",
    endReason: VehicleSubscriptionPeriodEndReason.RETURN_CONFIRMED,
    endSnapshot: { returnId: "return-1", vehicleVin: "VIN-1" },
    endSourceId: "source-2",
    endSourceKey: "return:source-2:occupancy:v1",
    endSourceType: "VEHICLE_RETURN",
    endedAt: ENDED_AT,
    ...overrides
  });
}

function ownershipRow(overrides: Partial<VehicleOwnershipPeriod> = {}): VehicleOwnershipPeriod {
  return {
    assetOwnerId: "owner-1",
    createdAt: new Date("2026-08-01T00:05:01.000Z"),
    createdBy: "actor-1",
    endConfirmedAt: null,
    endConfirmedBy: null,
    endReason: null,
    endSnapshot: null,
    endSourceId: null,
    endSourceKey: null,
    endSourceType: null,
    endedAt: null,
    id: "ownership-period-1",
    startConfirmedAt: START_CONFIRMED_AT,
    startConfirmedBy: "actor-1",
    startReason: VehicleOwnershipPeriodStartReason.INITIAL_ACQUISITION,
    startSnapshot: { acquisitionId: "acquisition-1", ownerNo: "PLATFORM" },
    startSourceId: "source-1",
    startSourceKey: "acquisition:source-1:ownership:v1",
    startSourceType: "ACQUISITION",
    startedAt: STARTED_AT,
    updatedAt: new Date("2026-08-01T00:05:01.000Z"),
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function closedOwnershipRow(
  overrides: Partial<VehicleOwnershipPeriod> = {}
): VehicleOwnershipPeriod {
  return ownershipRow({
    endConfirmedAt: END_CONFIRMED_AT,
    endConfirmedBy: "actor-2",
    endReason: VehicleOwnershipPeriodEndReason.OWNERSHIP_TRANSFER,
    endSnapshot: { transferId: "transfer-1" },
    endSourceId: "source-2",
    endSourceKey: "transfer:source-2:ownership:v1",
    endSourceType: "OWNERSHIP_TRANSFER",
    endedAt: ENDED_AT,
    ...overrides
  });
}

type HarnessOptions = {
  abortOwnershipTransactionAfterWriteError?: boolean;
  abortSubscriptionTransactionAfterWriteError?: boolean;
  createOwnershipError?: unknown;
  createSubscriptionError?: unknown;
  deletedOwnershipVehicle?: boolean;
  deletedSubscriptionAggregate?: "contract" | "customer" | "order" | "vehicle";
  isolationLevel?: string;
  ownershipPeriods?: VehicleOwnershipPeriod[];
  requireOwnershipStartSourceLock?: boolean;
  requireSubscriptionStartSourceLock?: boolean;
  subscriptionPeriods?: VehicleSubscriptionPeriod[];
  transactionIds?: readonly [string, string];
  updateOwnershipError?: unknown;
  updateSubscriptionError?: unknown;
};

function createHarness(options: HarnessOptions = {}) {
  const subscriptionPeriods = [...(options.subscriptionPeriods ?? [])];
  const ownershipPeriods = [...(options.ownershipPeriods ?? [])];
  let ownershipTransactionAborted = false;
  let subscriptionTransactionAborted = false;
  let ownershipStartSourceLocked = false;
  let subscriptionStartSourceLocked = false;
  let transactionProbeCount = 0;
  const rawQueries: Array<{ sql: string; values: readonly unknown[] }> = [];

  const tx = {
    $queryRaw: async (query: Prisma.Sql) => {
      rawQueries.push({ sql: query.sql, values: query.values });
      if (query.sql.includes("txid_current()")) {
        const transactionIds = options.transactionIds ?? [
          "interactive-transaction",
          "interactive-transaction"
        ];
        const transactionId = transactionIds[Math.min(transactionProbeCount, 1)];
        transactionProbeCount += 1;
        return query.sql.includes("current_setting('transaction_isolation')")
          ? [{ isolationLevel: options.isolationLevel ?? "read committed", transactionId }]
          : [{ transactionId }];
      }
      if (
        (options.requireOwnershipStartSourceLock || options.requireSubscriptionStartSourceLock) &&
        !query.sql.includes('SELECT TRUE AS "locked" FROM pg_advisory_xact_lock')
      ) {
        throw new Error("Source lock query must return a Prisma-supported scalar");
      }
      ownershipStartSourceLocked = true;
      subscriptionStartSourceLocked = true;
      return [{ locked: true }];
    },
    vehicleOwnershipPeriod: {
      create: async ({ data }: { data: Prisma.VehicleOwnershipPeriodUncheckedCreateInput }) => {
        if (options.createOwnershipError) {
          ownershipTransactionAborted = options.abortOwnershipTransactionAfterWriteError ?? false;
          throw options.createOwnershipError;
        }
        const row = ownershipRow({
          assetOwnerId: data.assetOwnerId,
          createdBy: data.createdBy ?? null,
          id: `ownership-period-${ownershipPeriods.length + 1}`,
          startConfirmedAt: toNullableDate(data.startConfirmedAt),
          startConfirmedBy: data.startConfirmedBy ?? null,
          startReason: data.startReason,
          startSnapshot: data.startSnapshot as Prisma.JsonValue,
          startSourceId: data.startSourceId,
          startSourceKey: data.startSourceKey,
          startSourceType: data.startSourceType,
          startedAt: toDate(data.startedAt),
          vehicleId: data.vehicleId
        });
        ownershipPeriods.push(row);
        return row;
      },
      findFirst: async ({ where }: { where: Prisma.VehicleOwnershipPeriodWhereInput }) => {
        if (ownershipTransactionAborted) throw abortedTransactionError();
        if (options.requireOwnershipStartSourceLock && !ownershipStartSourceLocked) {
          throw new Error("Ownership start source identity was read before it was locked");
        }
        if (
          options.deletedOwnershipVehicle &&
          where.vehicle &&
          typeof where.vehicle === "object" &&
          "deletedAt" in where.vehicle
        ) {
          return null;
        }
        return ownershipPeriods.find((row) => matchesOwnership(row, where)) ?? null;
      },
      updateMany: async ({
        data,
        where
      }: {
        data: Prisma.VehicleOwnershipPeriodUpdateManyMutationInput;
        where: Prisma.VehicleOwnershipPeriodWhereInput;
      }) => {
        if (options.updateOwnershipError) throw options.updateOwnershipError;
        const row = ownershipPeriods.find((candidate) => matchesOwnership(candidate, where));
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }
    },
    vehicleSubscriptionPeriod: {
      create: async ({ data }: { data: Prisma.VehicleSubscriptionPeriodUncheckedCreateInput }) => {
        if (options.createSubscriptionError) {
          subscriptionTransactionAborted =
            options.abortSubscriptionTransactionAfterWriteError ?? false;
          throw options.createSubscriptionError;
        }
        const row = subscriptionRow({
          contractId: data.contractId ?? null,
          contractSegmentId: data.contractSegmentId ?? null,
          createdBy: data.createdBy ?? null,
          customerId: data.customerId,
          id: `subscription-period-${subscriptionPeriods.length + 1}`,
          orderId: data.orderId,
          startConfirmedAt: toNullableDate(data.startConfirmedAt),
          startConfirmedBy: data.startConfirmedBy ?? null,
          startReason: data.startReason,
          startSnapshot: data.startSnapshot as Prisma.JsonValue,
          startSourceId: data.startSourceId,
          startSourceKey: data.startSourceKey,
          startSourceType: data.startSourceType,
          startedAt: toDate(data.startedAt),
          vehicleId: data.vehicleId
        });
        subscriptionPeriods.push(row);
        return row;
      },
      findFirst: async ({ where }: { where: Prisma.VehicleSubscriptionPeriodWhereInput }) => {
        if (subscriptionTransactionAborted) throw abortedTransactionError();
        if (options.requireSubscriptionStartSourceLock && !subscriptionStartSourceLocked) {
          throw new Error("Subscription start source identity was read before it was locked");
        }
        if (softDeletedSubscriptionAggregateMatches(where, options.deletedSubscriptionAggregate)) {
          return null;
        }
        return subscriptionPeriods.find((row) => matchesSubscription(row, where)) ?? null;
      },
      updateMany: async ({
        data,
        where
      }: {
        data: Prisma.VehicleSubscriptionPeriodUpdateManyMutationInput;
        where: Prisma.VehicleSubscriptionPeriodWhereInput;
      }) => {
        if (options.updateSubscriptionError) throw options.updateSubscriptionError;
        const row = subscriptionPeriods.find((candidate) => matchesSubscription(candidate, where));
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }
    }
  } as unknown as Prisma.TransactionClient;

  return { ownershipPeriods, rawQueries, subscriptionPeriods, tx };
}

function matchesSubscription(
  row: VehicleSubscriptionPeriod,
  where: Prisma.VehicleSubscriptionPeriodWhereInput
) {
  return (
    matchesScalar(row.id, where.id) &&
    matchesScalar(row.startSourceType, where.startSourceType) &&
    matchesScalar(row.startSourceId, where.startSourceId) &&
    matchesScalar(row.startSourceKey, where.startSourceKey) &&
    matchesScalar(row.endSourceType, where.endSourceType) &&
    matchesScalar(row.endSourceId, where.endSourceId) &&
    matchesScalar(row.endSourceKey, where.endSourceKey) &&
    matchesScalar(row.endedAt, where.endedAt)
  );
}

function matchesOwnership(
  row: VehicleOwnershipPeriod,
  where: Prisma.VehicleOwnershipPeriodWhereInput
) {
  return (
    matchesScalar(row.id, where.id) &&
    matchesScalar(row.startSourceType, where.startSourceType) &&
    matchesScalar(row.startSourceId, where.startSourceId) &&
    matchesScalar(row.startSourceKey, where.startSourceKey) &&
    matchesScalar(row.endSourceType, where.endSourceType) &&
    matchesScalar(row.endSourceId, where.endSourceId) &&
    matchesScalar(row.endSourceKey, where.endSourceKey) &&
    matchesScalar(row.endedAt, where.endedAt)
  );
}

function matchesScalar(actual: unknown, filter: unknown) {
  if (filter === undefined) return true;
  if (filter instanceof Date && actual instanceof Date) {
    return filter.getTime() === actual.getTime();
  }
  return actual === filter;
}

function toDate(value: Date | string) {
  return value instanceof Date ? value : new Date(value);
}

function toNullableDate(value: Date | string | null | undefined) {
  return value == null ? null : toDate(value);
}

function softDeletedSubscriptionAggregateMatches(
  where: Prisma.VehicleSubscriptionPeriodWhereInput,
  aggregate: HarnessOptions["deletedSubscriptionAggregate"]
) {
  if (!aggregate) return false;
  return hasDeletedAtRelationFilter(where, aggregate);
}

function hasDeletedAtRelationFilter(value: unknown, relationName: string): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const relation = record[relationName];
  if (relation && typeof relation === "object" && containsDeletedAtFilter(relation)) {
    return true;
  }
  return Object.values(record).some((child) => hasDeletedAtRelationFilter(child, relationName));
}

function containsDeletedAtFilter(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if ("deletedAt" in record) return true;
  return Object.values(record).some(containsDeletedAtFilter);
}

function databaseConstraintError(code: string, constraintName: string) {
  if (code === "23505") {
    const fieldsByConstraint: Readonly<Record<string, string[]>> = {
      vehicle_ownership_period_end_source_key: [
        "end_source_type",
        "end_source_id",
        "end_source_key"
      ],
      vehicle_ownership_period_one_open_per_vehicle_uidx: ["vehicle_id"],
      vehicle_ownership_period_start_source_key: [
        "start_source_type",
        "start_source_id",
        "start_source_key"
      ],
      vehicle_subscription_period_end_source_key: [
        "end_source_type",
        "end_source_id",
        "end_source_key"
      ],
      vehicle_subscription_period_one_open_per_order_uidx: ["order_id"],
      vehicle_subscription_period_one_open_per_vehicle_uidx: ["vehicle_id"],
      vehicle_subscription_period_start_source_key: [
        "start_source_type",
        "start_source_id",
        "start_source_key"
      ]
    };
    return {
      code: "P2002",
      meta: {
        driverAdapterError: {
          cause: {
            constraint: { fields: fieldsByConstraint[constraintName] },
            kind: "UniqueConstraintViolation",
            originalCode: code
          }
        }
      }
    };
  }
  const message = `database write violates constraint "${constraintName}"`;
  return {
    cause: { code, message },
    message,
    name: "DriverAdapterError"
  };
}

function abortedTransactionError() {
  return {
    code: "P2010",
    meta: { driverAdapterError: { cause: { originalCode: "25P02" } } }
  };
}

function storageEquivalentInputSnapshot(): Prisma.InputJsonObject {
  return {
    capturedAt: new Date("2026-08-01T00:00:00.000Z"),
    nested: { kept: true, omitted: undefined }
  };
}

function storageEquivalentCloseInputSnapshot(): Prisma.InputJsonObject {
  return {
    capturedAt: new Date("2026-10-01T00:00:00.000Z"),
    nested: { kept: true, omitted: undefined }
  };
}

async function expectConflictCode(promise: Promise<unknown>, expectedCode: string) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({ code: expectedCode });
    return;
  }
  throw new Error(`Expected conflict code ${expectedCode}`);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

type ServiceVehicleRecord = {
  deletedAt: Date | null;
  id: string;
  plateNo: string | null;
  status: VehicleStatus;
  vehicleNo: string;
  vin: string | null;
};

type ServiceOrderRecord = {
  contractId: string | null;
  customerId: string;
  deletedAt: Date | null;
  id: string;
  orderNo: string;
  orderStatus: OrderStatus;
  vehicleId: string | null;
};

type ServiceCustomerRecord = {
  customerNo: string;
  deletedAt: Date | null;
  id: string;
  name: string;
  status: string;
};

type ServiceContractRecord = {
  contractNo: string;
  customerId: string;
  deletedAt: Date | null;
  id: string;
  orderId: string;
  status: ContractStatus;
};

type ServiceContractSegmentRecord = {
  endDate: Date;
  id: string;
  orderId: string;
  segmentNo: string;
  sourceContractId: string | null;
  startDate: Date;
  status: string;
};

type ServiceAssetOwnerRecord = {
  id: string;
  name: string;
  ownerNo: string;
  ownerType: string;
  status: string;
};

type ServiceLeaseRecord = {
  activatedAt: Date | null;
  deletedAt: Date | null;
  id: string;
  orderId: string;
  status: LeaseStatus;
};

type ServiceRecords = {
  assetOwners: Map<string, ServiceAssetOwnerRecord>;
  contractSegments: Map<string, ServiceContractSegmentRecord>;
  contracts: Map<string, ServiceContractRecord>;
  customers: Map<string, ServiceCustomerRecord>;
  leases: Map<string, ServiceLeaseRecord>;
  orders: Map<string, ServiceOrderRecord>;
  vehicles: Map<string, ServiceVehicleRecord>;
};

type ServiceHarnessOptions = {
  authorityLockError?: unknown;
  ownershipPeriods?: VehicleOwnershipPeriod[];
  subscriptionPeriods?: VehicleSubscriptionPeriod[];
};

function createServiceHarness(options: ServiceHarnessOptions = {}) {
  const repositoryHarness = createHarness(options);
  const records = createServiceRecords();
  const auditLogs: Array<{
    action: AuditAction;
    entityId?: string | null;
    entityType: string;
    [key: string]: unknown;
  }> = [];
  const transactionOptions: Array<{ isolationLevel?: Prisma.TransactionIsolationLevel }> = [];
  const sharedTx = repositoryHarness.tx as unknown as Record<string, unknown>;
  const subscriptionDelegate = sharedTx.vehicleSubscriptionPeriod as Record<string, unknown>;
  const ownershipDelegate = sharedTx.vehicleOwnershipPeriod as Record<string, unknown>;
  subscriptionDelegate.findMany = async ({
    where
  }: {
    where: { orderId?: string; vehicleId?: string };
  }) =>
    repositoryHarness.subscriptionPeriods.filter(
      (row) =>
        (where.orderId === undefined || row.orderId === where.orderId) &&
        (where.vehicleId === undefined || row.vehicleId === where.vehicleId)
    );
  ownershipDelegate.findMany = async ({ where }: { where: { vehicleId?: string } }) =>
    repositoryHarness.ownershipPeriods.filter(
      (row) => where.vehicleId === undefined || row.vehicleId === where.vehicleId
    );

  const aggregateDelegates = {
    assetOwner: {
      findFirst: async ({ where }: { where: { id?: string } }) =>
        findServiceRecord(records.assetOwners, where.id)
    },
    auditLog: {
      create: async ({ data }: { data: (typeof auditLogs)[number] }) => {
        auditLogs.push(data);
        return { ...data, id: `audit-${auditLogs.length}` };
      }
    },
    contract: {
      findFirst: async ({ where }: { where: { deletedAt?: null; id?: string } }) =>
        findServiceRecord(records.contracts, where.id, where.deletedAt === null)
    },
    customer: {
      findFirst: async ({ where }: { where: { deletedAt?: null; id?: string } }) =>
        findServiceRecord(records.customers, where.id, where.deletedAt === null)
    },
    lease: {
      findFirst: async ({ where }: { where: { deletedAt?: null; orderId?: string } }) => {
        const lease = where.orderId ? (records.leases.get(where.orderId) ?? null) : null;
        return where.deletedAt === null && lease?.deletedAt ? null : lease;
      },
      findMany: async ({ where }: { where: { deletedAt?: null; orderId?: { in?: string[] } } }) =>
        [...records.leases.values()]
          .filter(
            (lease) =>
              (where.deletedAt !== null || lease.deletedAt === null) &&
              (where.orderId?.in === undefined || where.orderId.in.includes(lease.orderId))
          )
          .sort((left, right) => {
            const activated =
              (right.activatedAt?.getTime() ?? 0) - (left.activatedAt?.getTime() ?? 0);
            return activated === 0 ? left.id.localeCompare(right.id) : activated;
          })
    },
    subscriptionContractSegment: {
      findFirst: async ({ where }: { where: { id?: string } }) =>
        findServiceRecord(records.contractSegments, where.id)
    },
    subscriptionOrder: {
      findFirst: async ({ where }: { where: { deletedAt?: null; id?: string } }) =>
        findServiceRecord(records.orders, where.id, where.deletedAt === null),
      findMany: async ({
        where
      }: {
        where: {
          deletedAt?: null;
          orderStatus?: { in?: OrderStatus[] };
          vehicleId?: string;
        };
      }) =>
        [...records.orders.values()]
          .filter(
            (order) =>
              (where.deletedAt !== null || order.deletedAt === null) &&
              (where.vehicleId === undefined || order.vehicleId === where.vehicleId) &&
              (where.orderStatus?.in === undefined ||
                where.orderStatus.in.includes(order.orderStatus))
          )
          .sort(
            (left, right) =>
              left.orderNo.localeCompare(right.orderNo) || left.id.localeCompare(right.id)
          )
    },
    vehicle: {
      findFirst: async ({ where }: { where: { deletedAt?: null; id?: string } }) =>
        findServiceRecord(records.vehicles, where.id, where.deletedAt === null)
    }
  };
  Object.assign(sharedTx, aggregateDelegates);

  let transactionSequence = 0;
  const lockTails = new Map<string, Promise<void>>();
  const acquireSourceLock = async (lockKey: string) => {
    const previous = lockTails.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    lockTails.set(lockKey, next);
    await previous;
    return () => {
      release();
      if (lockTails.get(lockKey) === next) lockTails.delete(lockKey);
    };
  };

  const prisma = {
    ...aggregateDelegates,
    auditLog: {
      create: async () => {
        throw new Error("Asset fact audits must use the command transaction client.");
      }
    },
    vehicleOwnershipPeriod: ownershipDelegate,
    vehicleSubscriptionPeriod: subscriptionDelegate,
    $transaction: async <T>(
      work: (tx: Prisma.TransactionClient) => Promise<T>,
      transactionOption?: { isolationLevel?: Prisma.TransactionIsolationLevel }
    ) => {
      transactionOptions.push(transactionOption ?? {});
      transactionSequence += 1;
      const transactionId = `service-transaction-${transactionSequence}`;
      const heldSourceLocks = new Map<string, () => void>();
      const tx = {
        ...sharedTx,
        $queryRaw: async (query: Prisma.Sql) => {
          if (query.sql.includes("txid_current()")) {
            return query.sql.includes("current_setting('transaction_isolation')")
              ? [{ isolationLevel: "read committed", transactionId }]
              : [{ transactionId }];
          }
          if (query.sql.includes("pg_advisory_xact_lock")) {
            const lockKey = String(query.values[0]);
            if (!heldSourceLocks.has(lockKey)) {
              heldSourceLocks.set(lockKey, await acquireSourceLock(lockKey));
            }
            return [{ locked: true }];
          }
          if (query.sql.includes("FOR SHARE") && options.authorityLockError) {
            throw options.authorityLockError;
          }
          return [];
        }
      } as unknown as Prisma.TransactionClient;
      try {
        return await work(tx);
      } finally {
        for (const releaseSourceLock of [...heldSourceLocks.values()].reverse()) {
          releaseSourceLock();
        }
      }
    }
  } as unknown as PrismaService;
  const service = new AssetFactsService(
    prisma,
    new AssetFactsRepository(),
    new AuditService(prisma)
  );

  return {
    auditLogs,
    ownershipPeriods: repositoryHarness.ownershipPeriods,
    records,
    rawQueries: repositoryHarness.rawQueries,
    service,
    subscriptionPeriods: repositoryHarness.subscriptionPeriods,
    tx: repositoryHarness.tx,
    transactionOptions
  };
}

function createServiceRecords(): ServiceRecords {
  return {
    assetOwners: new Map([
      [
        "owner-1",
        {
          id: "owner-1",
          name: "Platform Asset Owner",
          ownerNo: "OWNER-1",
          ownerType: "PLATFORM",
          status: "ACTIVE"
        }
      ]
    ]),
    contractSegments: new Map([
      [
        "segment-1",
        {
          endDate: new Date("2026-10-31T00:00:00.000Z"),
          id: "segment-1",
          orderId: "order-1",
          segmentNo: "SEGMENT-1",
          sourceContractId: "contract-1",
          startDate: new Date("2026-08-01T00:00:00.000Z"),
          status: "ACTIVE"
        }
      ]
    ]),
    contracts: new Map([
      [
        "contract-1",
        {
          contractNo: "CONTRACT-1",
          customerId: "customer-1",
          deletedAt: null,
          id: "contract-1",
          orderId: "order-1",
          status: ContractStatus.ARCHIVED
        }
      ]
    ]),
    customers: new Map([
      [
        "customer-1",
        {
          customerNo: "CUSTOMER-1",
          deletedAt: null,
          id: "customer-1",
          name: "Stage 1C Customer",
          status: "ACTIVE"
        }
      ]
    ]),
    leases: new Map([
      [
        "order-1",
        {
          activatedAt: STARTED_AT,
          deletedAt: null,
          id: "lease-1",
          orderId: "order-1",
          status: LeaseStatus.ACTIVE
        }
      ]
    ]),
    orders: new Map([
      [
        "order-1",
        {
          contractId: "contract-1",
          customerId: "customer-1",
          deletedAt: null,
          id: "order-1",
          orderNo: "ORDER-1",
          orderStatus: OrderStatus.ACTIVE,
          vehicleId: "vehicle-1"
        }
      ]
    ]),
    vehicles: new Map([
      [
        "vehicle-1",
        {
          deletedAt: null,
          id: "vehicle-1",
          plateNo: "沪A00001",
          status: VehicleStatus.LEASED,
          vehicleNo: "VEHICLE-1",
          vin: "VIN-1"
        }
      ],
      [
        "vehicle-2",
        {
          deletedAt: null,
          id: "vehicle-2",
          plateNo: "沪A00002",
          status: VehicleStatus.AVAILABLE,
          vehicleNo: "VEHICLE-2",
          vin: "VIN-2"
        }
      ]
    ])
  };
}

function findServiceRecord<T>(
  records: Map<string, T>,
  id: string | undefined,
  requireLive = false
) {
  const record = id ? (records.get(id) ?? null) : null;
  const deletedAt = (record as { deletedAt?: Date | null } | null)?.deletedAt;
  return requireLive && deletedAt ? null : record;
}

function softDeleteServiceReference(
  records: ServiceRecords,
  reference: "contract" | "contractSegment" | "customer" | "order" | "vehicle"
) {
  if (reference === "contractSegment") {
    records.contractSegments.clear();
  } else if (reference === "contract") {
    records.contracts.get("contract-1")!.deletedAt = new Date();
  } else if (reference === "customer") {
    records.customers.get("customer-1")!.deletedAt = new Date();
  } else if (reference === "order") {
    records.orders.get("order-1")!.deletedAt = new Date();
  } else {
    records.vehicles.get("vehicle-1")!.deletedAt = new Date();
  }
}

function serviceSubscriptionOpenDto(
  overrides: Partial<OpenSubscriptionPeriodDto> = {}
): OpenSubscriptionPeriodDto {
  return {
    confirmedAt: START_CONFIRMED_AT.toISOString(),
    contractId: "contract-1",
    contractSegmentId: "segment-1",
    customerId: "customer-1",
    orderId: "order-1",
    reason: VehicleSubscriptionPeriodStartReason.DELIVERY_CONFIRMED,
    snapshot: { note: "Stage 1C subscription start" },
    source: {
      id: SUBSCRIPTION_START_SOURCE_ID,
      key: "delivery:source-1:occupancy:v1",
      type: "DELIVERY"
    },
    startedAt: STARTED_AT.toISOString(),
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function serviceSubscriptionCloseDto(
  periodId: string,
  overrides: Partial<CloseSubscriptionPeriodDto> = {}
): CloseSubscriptionPeriodDto {
  return {
    confirmedAt: END_CONFIRMED_AT.toISOString(),
    endedAt: ENDED_AT.toISOString(),
    periodId,
    reason: VehicleSubscriptionPeriodEndReason.RETURN_CONFIRMED,
    snapshot: { note: "Stage 1C subscription close" },
    source: {
      id: SUBSCRIPTION_END_SOURCE_ID,
      key: "return:source-2:occupancy:v1",
      type: "VEHICLE_RETURN"
    },
    ...overrides
  };
}

function serviceOwnershipOpenDto(
  overrides: Partial<OpenOwnershipPeriodDto> = {}
): OpenOwnershipPeriodDto {
  return {
    assetOwnerId: "owner-1",
    confirmedAt: START_CONFIRMED_AT.toISOString(),
    reason: VehicleOwnershipPeriodStartReason.INITIAL_ACQUISITION,
    snapshot: { note: "Stage 1C ownership start" },
    source: {
      id: OWNERSHIP_START_SOURCE_ID,
      key: "acquisition:source-1:ownership:v1",
      type: "ACQUISITION"
    },
    startedAt: STARTED_AT.toISOString(),
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function serviceOwnershipCloseDto(
  periodId: string,
  overrides: Partial<CloseOwnershipPeriodDto> = {}
): CloseOwnershipPeriodDto {
  return {
    confirmedAt: END_CONFIRMED_AT.toISOString(),
    endedAt: ENDED_AT.toISOString(),
    periodId,
    reason: VehicleOwnershipPeriodEndReason.OWNERSHIP_TRANSFER,
    snapshot: { note: "Stage 1C ownership close" },
    source: {
      id: OWNERSHIP_END_SOURCE_ID,
      key: "transfer:source-2:ownership:v1",
      type: "OWNERSHIP_TRANSFER"
    },
    ...overrides
  };
}

function serviceContext() {
  return {
    actorId: SERVICE_ACTOR_ID,
    ipAddress: "127.0.0.1",
    userAgent: "asset-facts-service-test"
  };
}

async function expectServiceError(
  promise: Promise<unknown>,
  ErrorType: typeof BadRequestException | typeof ConflictException | typeof NotFoundException,
  code: string
) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ErrorType);
    expect((error as BadRequestException).getResponse()).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected service error ${code}`);
}
