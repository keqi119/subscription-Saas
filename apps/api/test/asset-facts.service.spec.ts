import { ConflictException } from "@nestjs/common";
import {
  Prisma,
  VehicleOwnershipPeriodEndReason,
  VehicleOwnershipPeriodStartReason,
  VehicleSubscriptionPeriodEndReason,
  VehicleSubscriptionPeriodStartReason,
  type VehicleOwnershipPeriod,
  type VehicleSubscriptionPeriod
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  ASSET_FACT_CONFLICT_CODE,
  AssetFactsRepository
} from "../src/asset-facts/asset-facts.repository";
import type {
  CloseOwnershipPeriodInput,
  CloseSubscriptionPeriodInput,
  OpenOwnershipPeriodInput,
  OpenSubscriptionPeriodInput
} from "../src/asset-facts/asset-facts.types";

const STARTED_AT = new Date("2026-08-01T00:00:00.000Z");
const ENDED_AT = new Date("2026-10-01T00:00:00.000Z");
const START_CONFIRMED_AT = new Date("2026-08-01T00:05:00.000Z");
const END_CONFIRMED_AT = new Date("2026-10-01T00:05:00.000Z");

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

  const tx = {
    $queryRaw: async (query: Prisma.Sql) => {
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

  return { ownershipPeriods, subscriptionPeriods, tx };
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
