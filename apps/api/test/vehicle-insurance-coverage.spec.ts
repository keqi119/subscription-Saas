import {
  VehicleInsurancePolicyStatus,
  VehicleInsurancePolicyType
} from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  type InsurancePolicyCoverageInput,
  resolveVehicleInsuranceCoverage
} from "../src/common/vehicle-insurance-coverage";

const evaluationDate = new Date("2026-07-24T12:00:00.000Z");

function policy(
  id: string,
  policyType: VehicleInsurancePolicyType,
  overrides: Partial<InsurancePolicyCoverageInput> = {}
): InsurancePolicyCoverageInput {
  return {
    deletedAt: null,
    effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
    effectiveTo: new Date("2026-07-31T00:00:00.000Z"),
    id,
    policyStatus: VehicleInsurancePolicyStatus.ACTIVE,
    policyType,
    ...overrides
  };
}

describe("resolveVehicleInsuranceCoverage", () => {
  it("requires both compulsory and commercial active coverage", () => {
    const result = resolveVehicleInsuranceCoverage(
      [
        policy("compulsory", VehicleInsurancePolicyType.COMPULSORY_TRAFFIC),
        policy("commercial", VehicleInsurancePolicyType.COMMERCIAL)
      ],
      evaluationDate
    );

    expect(result.covered).toBe(true);
    expect(result.compulsoryTraffic).toMatchObject({
      covered: true,
      policyId: "compulsory"
    });
    expect(result.commercial).toMatchObject({
      covered: true,
      policyId: "commercial"
    });
  });

  it.each([
    VehicleInsurancePolicyStatus.NOT_EFFECTIVE,
    VehicleInsurancePolicyStatus.EXPIRED,
    VehicleInsurancePolicyStatus.CANCELLED,
    VehicleInsurancePolicyStatus.PENDING_RENEWAL,
    VehicleInsurancePolicyStatus.ARCHIVED
  ])("does not count %s policies", (policyStatus) => {
    const result = resolveVehicleInsuranceCoverage(
      [
        policy("compulsory", VehicleInsurancePolicyType.COMPULSORY_TRAFFIC, {
          policyStatus
        }),
        policy("commercial", VehicleInsurancePolicyType.COMMERCIAL)
      ],
      evaluationDate
    );

    expect(result.covered).toBe(false);
    expect(result.compulsoryTraffic).toEqual({
      covered: false,
      effectiveFrom: null,
      effectiveTo: null,
      policyId: null
    });
  });

  it.each([
    {
      policies: [policy("compulsory", VehicleInsurancePolicyType.COMPULSORY_TRAFFIC)],
      missingType: "commercial"
    },
    {
      policies: [policy("commercial", VehicleInsurancePolicyType.COMMERCIAL)],
      missingType: "compulsoryTraffic"
    },
    {
      policies: [policy("other", VehicleInsurancePolicyType.OTHER)],
      missingType: "both"
    }
  ])("does not accept incomplete coverage: $missingType", ({ policies }) => {
    const result = resolveVehicleInsuranceCoverage(policies, evaluationDate);

    expect(result.covered).toBe(false);
  });

  it("ignores deleted policies", () => {
    const result = resolveVehicleInsuranceCoverage(
      [
        policy("compulsory", VehicleInsurancePolicyType.COMPULSORY_TRAFFIC, {
          deletedAt: new Date("2026-07-10T00:00:00.000Z")
        }),
        policy("commercial", VehicleInsurancePolicyType.COMMERCIAL)
      ],
      evaluationDate
    );

    expect(result.compulsoryTraffic.covered).toBe(false);
  });

  it.each([
    {
      effectiveFrom: new Date("2026-06-01T00:00:00.000Z"),
      effectiveTo: new Date("2026-07-23T00:00:00.000Z"),
      label: "expired date range"
    },
    {
      effectiveFrom: new Date("2026-07-25T00:00:00.000Z"),
      effectiveTo: new Date("2026-08-31T00:00:00.000Z"),
      label: "future date range"
    }
  ])("ignores $label", ({ effectiveFrom, effectiveTo }) => {
    const result = resolveVehicleInsuranceCoverage(
      [
        policy("compulsory", VehicleInsurancePolicyType.COMPULSORY_TRAFFIC, {
          effectiveFrom,
          effectiveTo
        }),
        policy("commercial", VehicleInsurancePolicyType.COMMERCIAL)
      ],
      evaluationDate
    );

    expect(result.compulsoryTraffic.covered).toBe(false);
  });

  it.each([
    new Date("2026-07-24T23:59:59.999Z"),
    new Date("2026-07-31T23:59:59.999Z")
  ])("uses inclusive UTC date endpoints for %s", (date) => {
    const result = resolveVehicleInsuranceCoverage(
      [
        policy("compulsory", VehicleInsurancePolicyType.COMPULSORY_TRAFFIC, {
          effectiveFrom: new Date("2026-07-24T00:00:00.000Z")
        }),
        policy("commercial", VehicleInsurancePolicyType.COMMERCIAL)
      ],
      date
    );

    expect(result.covered).toBe(true);
  });

  it("selects deterministically by latest start, latest end, then stable id", () => {
    const policies = [
      policy("older-start", VehicleInsurancePolicyType.COMPULSORY_TRAFFIC, {
        effectiveFrom: new Date("2026-06-01T00:00:00.000Z"),
        effectiveTo: new Date("2026-12-31T00:00:00.000Z")
      }),
      policy("shorter-end", VehicleInsurancePolicyType.COMPULSORY_TRAFFIC, {
        effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
        effectiveTo: new Date("2026-08-01T00:00:00.000Z")
      }),
      policy("z-stable", VehicleInsurancePolicyType.COMPULSORY_TRAFFIC, {
        effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
        effectiveTo: new Date("2026-09-01T00:00:00.000Z")
      }),
      policy("a-stable", VehicleInsurancePolicyType.COMPULSORY_TRAFFIC, {
        effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
        effectiveTo: new Date("2026-09-01T00:00:00.000Z")
      }),
      policy("commercial", VehicleInsurancePolicyType.COMMERCIAL)
    ];
    const originalOrder = policies.map(({ id }) => id);

    const result = resolveVehicleInsuranceCoverage(policies, evaluationDate);

    expect(result.compulsoryTraffic.policyId).toBe("a-stable");
    expect(policies.map(({ id }) => id)).toEqual(originalOrder);
  });
});
