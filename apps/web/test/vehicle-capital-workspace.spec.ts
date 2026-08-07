import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  VEHICLE_CAPITAL_SECTIONS,
  capitalEventFieldVisibility,
  getCapitalWorkspaceActions,
  summarizeFinancingAllocations
} from "../src/lib/vehicle-capital-workspace";

const repoRoot = join(__dirname, "..", "..", "..");

describe("vehicle capital workspace model", () => {
  it("defines the exact five secondary sections", () => {
    expect(VEHICLE_CAPITAL_SECTIONS.map(({ key }) => key)).toEqual([
      "overview",
      "events",
      "allocations",
      "revenue-rules",
      "revenue-preview"
    ]);
  });

  it.each([
    [
      "INITIAL_EQUITY_PURCHASE",
      {
        showAcquisitionMode: true,
        showDebtAmount: false,
        showEquityAmount: true,
        showFinancingInstrument: false,
        showLessor: false,
        showManagedOwner: false
      }
    ],
    [
      "ADD_DEBT_FINANCING",
      {
        showAcquisitionMode: false,
        showDebtAmount: true,
        showEquityAmount: false,
        showFinancingInstrument: true,
        showLessor: false,
        showManagedOwner: false
      }
    ],
    [
      "FINANCING_RELEASE",
      {
        showAcquisitionMode: false,
        showDebtAmount: false,
        showEquityAmount: false,
        showFinancingInstrument: true,
        showLessor: false,
        showManagedOwner: false
      }
    ],
    [
      "LEASE_IN",
      {
        showAcquisitionMode: true,
        showDebtAmount: false,
        showEquityAmount: false,
        showFinancingInstrument: false,
        showLessor: true,
        showManagedOwner: false
      }
    ],
    [
      "MANAGED_IN",
      {
        showAcquisitionMode: true,
        showDebtAmount: false,
        showEquityAmount: false,
        showFinancingInstrument: false,
        showLessor: false,
        showManagedOwner: true
      }
    ],
    [
      "OTHER",
      {
        showAcquisitionMode: true,
        showDebtAmount: true,
        showEquityAmount: true,
        showFinancingInstrument: true,
        showLessor: false,
        showManagedOwner: false
      }
    ]
  ])("keeps the existing %s field rules", (eventType, expected) => {
    expect(capitalEventFieldVisibility(eventType)).toEqual(expected);
  });

  it("keeps missing financing allocations distinct from an actual zero total", () => {
    expect(summarizeFinancingAllocations([])).toEqual({
      allocatedPrincipalAmount: null,
      allocationCount: 0,
      allocationRatioBps: null
    });
    expect(
      summarizeFinancingAllocations([
        {
          allocatedPrincipalAmount: 0,
          allocationRatioBps: 0,
          id: "allocation-1"
        }
      ])
    ).toEqual({
      allocatedPrincipalAmount: 0,
      allocationCount: 1,
      allocationRatioBps: 0
    });
  });

  it("derives actions only from exact capital and revenue-share permissions", () => {
    expect(
      getCapitalWorkspaceActions(
        new Set(["capital_structure:view", "capital_structure:manage", "revenue_share:view"])
      )
    ).toEqual({
      canManageCapitalEvents: true,
      canManageRevenueShareRules: false,
      canPreviewRevenueShare: true,
      canViewCapitalStructure: true,
      canViewRevenueShareRules: true
    });
  });

  it("keeps allocation repair explicit and revenue preview read-only", () => {
    const source = readFileSync(
      join(repoRoot, "apps/web/src/components/vehicle-workspace/vehicle-capital-tab.tsx"),
      "utf8"
    );

    expect(source).toContain("待补录资本事件");
    expect(source).toContain("仅试算，不生成结算单或付款记录");
    expect(source).toContain("/capital-events");
    expect(source).toContain("/revenue-share-rules");
    expect(source).toContain("/revenue-share-preview");
    expect(source).not.toContain("/settlements");
    expect(source).not.toContain("/payments");
    expect(source).not.toContain("/financing-instruments\",");
  });
});
