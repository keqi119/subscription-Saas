import {
  InsuranceClaimStatus,
  ServiceCaseType,
  VehicleInsurancePolicyType
} from "@prisma/client";
import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { VehicleInsuranceService } from "../src/vehicle-insurance/vehicle-insurance.service";

describe("Insurance claim foundation", () => {
  it("creates a claim from an accident service case and carries customer/order/vehicle context", async () => {
    const { prisma, service, user } = createHarness();

    const claim = await service.createClaimFromServiceCase(
      "case-1",
      {
        estimatedAmount: 120000,
        policyId: "policy-1",
        submittedAt: "2026-06-22T08:30:00.000Z"
      },
      user
    );

    expect(prisma.insuranceClaim.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          customerId: "customer-1",
          estimatedAmount: 120000n,
          orderId: "order-1",
          policyId: "policy-1",
          serviceCaseId: "case-1",
          vehicleId: "vehicle-1"
        })
      })
    );
    expect(claim).toMatchObject({
      claimStatus: InsuranceClaimStatus.DRAFT,
      customerId: "customer-1",
      orderId: "order-1",
      vehicleId: "vehicle-1"
    });
    expect(prisma.vehicle.update).not.toHaveBeenCalled();
    expect(prisma.receivableBill.create).not.toHaveBeenCalled();
  });

  it("updates claim status without changing vehicle/order status or generating bills", async () => {
    const { prisma, service, user } = createHarness();

    const claim = await service.updateClaimStatus(
      "claim-1",
      { claimStatus: InsuranceClaimStatus.ACCEPTED },
      user
    );

    expect(claim.claimStatus).toBe(InsuranceClaimStatus.ACCEPTED);
    expect(prisma.insuranceClaim.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          acceptedAt: expect.any(Date),
          claimStatus: InsuranceClaimStatus.ACCEPTED
        })
      })
    );
    expect(prisma.vehicle.update).not.toHaveBeenCalled();
    expect(prisma.subscriptionOrder.update).not.toHaveBeenCalled();
    expect(prisma.receivableBill.create).not.toHaveBeenCalled();
  });

  it("rejects claims from non-accident service cases", async () => {
    const { prisma, service, user } = createHarness();
    prisma.serviceCase.findFirst.mockResolvedValueOnce(createServiceCase({ caseType: ServiceCaseType.RESCUE_REQUEST }));

    await expect(
      service.createClaimFromServiceCase("case-1", {}, user)
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.insuranceClaim.create).not.toHaveBeenCalled();
  });
});

function createHarness() {
  let claim = createClaim();
  const prisma = {
    insuranceClaim: {
      count: vi.fn(async () => 1),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        claim = {
          ...claim,
          ...data,
          claimNo: data.claimNo as string
        };
        return withClaimRelations(claim);
      }),
      findFirst: vi.fn(async () => withClaimRelations(claim)),
      findMany: vi.fn(async () => [withClaimRelations(claim)]),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        claim = {
          ...claim,
          ...data
        };
        return withClaimRelations(claim);
      })
    },
    receivableBill: {
      create: vi.fn()
    },
    serviceCase: {
      findFirst: vi.fn(async () => createServiceCase())
    },
    subscriptionOrder: {
      findFirst: vi.fn(),
      update: vi.fn()
    },
    vehicle: {
      findFirst: vi.fn(async () => ({ deletedAt: null, id: "vehicle-1" })),
      update: vi.fn()
    },
    vehicleDocument: {
      findMany: vi.fn()
    },
    vehicleInsurancePolicy: {
      findFirst: vi.fn(async () => ({
        deletedAt: null,
        id: "policy-1",
        vehicleId: "vehicle-1"
      }))
    }
  };
  const storageService = {
    getVehicleDocumentStream: vi.fn(),
    putVehicleDocument: vi.fn()
  };
  const auditService = { write: vi.fn() };
  const service = new VehicleInsuranceService(
    prisma as never,
    storageService as never,
    auditService as never
  );
  const user = {
    id: "user-1",
    menus: [],
    name: "Admin",
    permissions: [],
    roles: [],
    username: "admin"
  };
  return { auditService, prisma, service, user };
}

function createServiceCase(overrides: Record<string, unknown> = {}) {
  return {
    caseNo: "SC202606220001",
    caseType: ServiceCaseType.ACCIDENT_REPORT,
    customer: {
      customerNo: "C001",
      id: "customer-1",
      mobile: "13800000000",
      name: "Customer"
    },
    customerId: "customer-1",
    id: "case-1",
    occurredAt: new Date("2026-06-22T08:00:00.000Z"),
    order: {
      id: "order-1",
      orderNo: "ORD001",
      vehicleId: "vehicle-1"
    },
    orderId: "order-1",
    vehicle: {
      id: "vehicle-1",
      vehicleNo: "VH001"
    },
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function createClaim(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-06-22T08:00:00.000Z");
  return {
    acceptedAt: null,
    accidentAt: now,
    approvedAmount: null,
    claimNo: "IC202606220001",
    claimStatus: InsuranceClaimStatus.DRAFT,
    closedAt: null,
    createdAt: now,
    createdBy: "user-1",
    customerId: "customer-1",
    deletedAt: null,
    estimatedAmount: null,
    id: "claim-1",
    insurerClaimNo: null,
    orderId: "order-1",
    paidAmount: null,
    policyId: "policy-1",
    remark: null,
    serviceCaseId: "case-1",
    snapshot: null,
    submittedAt: null,
    updatedAt: now,
    updatedBy: "user-1",
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function withClaimRelations(claim: ReturnType<typeof createClaim>) {
  return {
    ...claim,
    customer: {
      customerNo: "C001",
      id: claim.customerId,
      mobile: "13800000000",
      name: "Customer"
    },
    order: {
      id: claim.orderId,
      orderNo: "ORD001",
      orderStatus: "PENDING_DELIVERY"
    },
    policy: {
      id: claim.policyId,
      insurerName: "Insurer",
      policyNo: "POLICY-001",
      policyType: VehicleInsurancePolicyType.COMPULSORY_TRAFFIC
    },
    serviceCase: {
      caseNo: "SC202606220001",
      caseStatus: "SUBMITTED",
      caseType: ServiceCaseType.ACCIDENT_REPORT,
      id: claim.serviceCaseId,
      insuranceReportNo: null,
      occurredAt: claim.accidentAt
    },
    vehicle: {
      brand: "NIO",
      id: claim.vehicleId,
      model: "ES6",
      plateNo: "沪A12345",
      series: "ES6",
      vehicleNo: "VH001"
    }
  };
}
