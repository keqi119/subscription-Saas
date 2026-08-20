import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  assertAccountingPeriod,
  assertAssetAccountingSource,
  assertVehicleCostAmountCents,
  canonicalAssetAccountingJson,
  hashBusinessExceptionSnapshot,
  summarizeVehicleCostEntries
} from "../src/asset-accounting/asset-accounting.domain";
import type {
  AssetAccountingSource,
  VehicleCostLedgerEntrySnapshot
} from "../src/asset-accounting/asset-accounting.types";

const source: AssetAccountingSource = {
  type: "asset-work-order",
  id: "00000000-0000-0000-0000-000000000001",
  key: "cost-append-1"
};

describe("asset accounting canonical snapshots", () => {
  it("sorts object keys, converts Date and BigInt, omits undefined, and keeps arrays ordered", () => {
    expect(
      canonicalAssetAccountingJson({
        z: undefined,
        b: 2n,
        a: new Date("2026-08-20T12:34:56.000Z"),
        items: ["second", "first"]
      })
    ).toBe('{"a":"2026-08-20T12:34:56.000Z","b":"2","items":["second","first"]}');
  });

  it("rejects cyclic values, non-finite numbers, and non-object roots", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => canonicalAssetAccountingJson(cyclic)).toThrow(/cycle/i);
    expect(() => canonicalAssetAccountingJson({ value: Number.NaN })).toThrow(/finite/i);
    expect(() => canonicalAssetAccountingJson({ value: Number.POSITIVE_INFINITY })).toThrow(
      /finite/i
    );
    expect(() => canonicalAssetAccountingJson(null)).toThrow(/root/i);
    expect(() => canonicalAssetAccountingJson("snapshot")).toThrow(/root/i);
    expect(() => canonicalAssetAccountingJson([])).toThrow(/root/i);
  });

  it("hashes the canonical representation with stable lowercase SHA-256", () => {
    const first = hashBusinessExceptionSnapshot({ b: 2, a: 1n });
    const second = hashBusinessExceptionSnapshot({ a: 1n, b: 2 });

    expect(first).toBe(second);
    expect(first).toBe(createHash("sha256").update('{"a":"1","b":2}').digest("hex"));
    expect(hashBusinessExceptionSnapshot({ a: 2 })).not.toBe(
      hashBusinessExceptionSnapshot({ a: 1 })
    );
  });
});

describe("asset accounting validation", () => {
  it("validates a nonblank stable source triple", () => {
    expect(assertAssetAccountingSource(source)).toBeUndefined();
    expect(() => assertAssetAccountingSource({ ...source, type: " " })).toThrow(/source/i);
    expect(() => assertAssetAccountingSource({ ...source, id: "" })).toThrow(/source/i);
    expect(() => assertAssetAccountingSource({ ...source, key: "\t" })).toThrow(/source/i);
  });

  it("validates nonzero integer cents and YYYY-MM accounting periods", () => {
    expect(assertVehicleCostAmountCents(1n)).toBeUndefined();
    expect(assertVehicleCostAmountCents(-1n)).toBeUndefined();
    expect(() => assertVehicleCostAmountCents(0n)).toThrow(/amount/i);
    expect(() => assertVehicleCostAmountCents(1.5 as unknown as bigint)).toThrow(/amount/i);
    expect(assertAccountingPeriod("2026-08")).toBeUndefined();
    expect(() => assertAccountingPeriod("2026-8")).toThrow(/period/i);
    expect(() => assertAccountingPeriod("2026-13")).toThrow(/period/i);
  });
});

describe("vehicle cost summaries", () => {
  it("keeps action, responsibility, and category buckets distinct and applies reversal signs", () => {
    const entries: VehicleCostLedgerEntrySnapshot[] = [
      {
        id: "original",
        vehicleId: "vehicle-1",
        entryKind: "ORIGINAL",
        actionType: "ACTUAL_COST",
        costCategory: "REPAIR",
        amountCents: 500n,
        responsiblePartyType: "CUSTOMER",
        responsiblePartyId: "customer-1",
        occurredOn: new Date("2026-08-20T00:00:00.000Z"),
        accountingPeriod: "2026-08",
        reversalOfEntryId: null
      },
      {
        id: "reversal",
        vehicleId: "vehicle-1",
        entryKind: "REVERSAL",
        actionType: "ACTUAL_COST",
        costCategory: "REPAIR",
        amountCents: 500n,
        responsiblePartyType: "CUSTOMER",
        responsiblePartyId: "customer-1",
        occurredOn: new Date("2026-08-20T00:00:00.000Z"),
        accountingPeriod: "2026-08",
        reversalOfEntryId: "original"
      },
      {
        id: "recovery",
        vehicleId: "vehicle-1",
        entryKind: "ORIGINAL",
        actionType: "RECOVERY_RECEIVED",
        costCategory: "REPAIR",
        amountCents: 200n,
        responsiblePartyType: "CUSTOMER",
        responsiblePartyId: "customer-1",
        occurredOn: new Date("2026-08-20T00:00:00.000Z"),
        accountingPeriod: "2026-08",
        reversalOfEntryId: null
      }
    ];

    const summary = summarizeVehicleCostEntries(entries);

    expect(summary.totalAmountCents).toBe(200n);
    expect(summary.byActionType.ACTUAL_COST.amountCents).toBe(0n);
    expect(summary.byActionType.RECOVERY_RECEIVED.amountCents).toBe(200n);
    expect(summary.byResponsibility.CUSTOMER.amountCents).toBe(200n);
    expect(summary.byCategory.REPAIR.amountCents).toBe(200n);
    expect(summary.byActionType.ACTUAL_COST).not.toBe(summary.byActionType.RECOVERY_RECEIVED);
  });
});
