import { AuditAction, CustomerAccountStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { AuditService } from "../src/audit/audit.service";
import { PortalController } from "../src/portal/portal.controller";
import { type CurrentCustomer } from "../src/portal/portal-auth.types";
import { type UpdatePortalProfileDto } from "../src/portal/portal-profile.dto";
import { PortalProfileService } from "../src/portal/portal-profile.service";

const currentCustomer: CurrentCustomer = {
  accountStatus: CustomerAccountStatus.ACTIVE,
  customerAccountId: "account-1",
  customerId: "customer-1",
  phone: "13800000000"
};

const updateDto: UpdatePortalProfileDto = {
  emergencyContactMobile: "13900000000",
  emergencyContactName: "王女士",
  idCardNo: "11010519491231002X",
  name: "测试客户",
  residenceCity: "上海市",
  residenceDetail: "北翟路1554弄53号",
  residenceDistrict: "闵行区",
  residenceProvince: "上海市"
};

describe("PortalProfileService", () => {
  it("stores a complete application profile and writes an audit", async () => {
    const harness = portalProfileHarness();

    await expect(
      harness.service.updateProfile(updateDto, currentCustomer, {
        ipAddress: "127.0.0.1",
        userAgent: "vitest"
      })
    ).resolves.toMatchObject({
      emergencyContactMobile: "13900000000",
      profileComplete: true,
      residenceDistrict: "闵行区"
    });

    expect(harness.tx.customerProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          emergencyContactMobile: "13900000000",
          residenceAddress: "上海市闵行区北翟路1554弄53号",
          residenceDistrict: "闵行区"
        }),
        where: { customerId: currentCustomer.customerId }
      })
    );
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.UPDATE,
        entityType: "customer_profile",
        ipAddress: "127.0.0.1",
        operatorId: "account-1",
        userAgent: "vitest"
      })
    );
  });

  it("rejects an invalid emergency contact before opening a transaction", async () => {
    const harness = portalProfileHarness();

    await expect(
      harness.service.updateProfile(
        { ...updateDto, emergencyContactMobile: currentCustomer.phone },
        currentCustomer,
        {}
      )
    ).rejects.toThrow("CUSTOMER_APPLICATION_PROFILE_INCOMPLETE");

    expect(harness.prisma.$transaction).not.toHaveBeenCalled();
    expect(harness.auditService.write).not.toHaveBeenCalled();
  });

  it("uses the verified login mobile instead of accepting a request-body mobile", async () => {
    const harness = portalProfileHarness();
    const maliciousDto = { ...updateDto, mobile: "13700000000" } as UpdatePortalProfileDto;

    await harness.service.updateProfile(maliciousDto, currentCustomer, {});

    expect(harness.tx.customer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ mobile: currentCustomer.phone })
      })
    );
  });
});

describe("PortalController profile context", () => {
  it("passes request metadata to profile updates", async () => {
    const updateProfile = vi.fn(async () => ({ ok: true }));
    const controller = new PortalController({ updateProfile } as unknown as PortalProfileService);

    await controller.updateProfile(updateDto, currentCustomer, {
      headers: { "user-agent": "vitest" },
      ip: "127.0.0.1"
    } as never);

    expect(updateProfile).toHaveBeenCalledWith(updateDto, currentCustomer, {
      ipAddress: "127.0.0.1",
      userAgent: "vitest"
    });
  });
});

function portalProfileHarness() {
  const before = customerRecord({
    identity: null,
    name: "待完善客户",
    profile: null
  });
  const updated = customerRecord({
    identity: { idCardNo: "11010519491231002X" },
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
    }
  });
  const tx = {
    customer: {
      findUniqueOrThrow: vi.fn(async () => updated),
      update: vi.fn(async () => updated)
    },
    customerIdentity: { upsert: vi.fn(async () => updated.identity) },
    customerProfile: { upsert: vi.fn(async () => updated.profile) }
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    customer: { findUnique: vi.fn(async () => before) }
  };
  const auditService = { write: vi.fn(async () => undefined) };
  const service = new PortalProfileService(
    prisma as never,
    auditService as unknown as AuditService
  );
  return { auditService, prisma, service, tx };
}

function customerRecord(overrides: Record<string, unknown> = {}) {
  return {
    deletedAt: null,
    id: "customer-1",
    identity: { idCardNo: "11010519491231002X" },
    mobile: "13800000000",
    name: "测试客户",
    profile: null,
    sourceChannel: "portal",
    ...overrides
  };
}
