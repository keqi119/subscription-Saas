import { describe, expect, it } from "vitest";

import { buildApplicationCustomerProfileSnapshot } from "../src/customer/application-customer-profile-snapshot";

const completeProfile = {
  id: "customer-1",
  identity: { idCardNo: "11010519491231002X" },
  mobile: "13800000000",
  name: "测试客户",
  profile: {
    emergencyContactMobile: "13900000000",
    emergencyContactName: "王女士",
    residenceCity: "上海市",
    residenceDetail: "北翟路1554弄53号",
    residenceDistrict: "闵行区",
    residenceProvince: "上海市"
  },
  sourceChannel: "portal"
};

describe("application customer profile snapshots", () => {
  it("builds a V1 snapshot from a complete customer profile", () => {
    expect(
      buildApplicationCustomerProfileSnapshot(
        completeProfile,
        null,
        new Date("2026-08-12T00:00:00.000Z")
      )
    ).toEqual({
      capturedAt: "2026-08-12T00:00:00.000Z",
      customerId: "customer-1",
      emergencyContactMobile: "13900000000",
      emergencyContactName: "王女士",
      idCardNo: "11010519491231002X",
      mobile: "13800000000",
      name: "测试客户",
      residenceAddress: "上海市闵行区北翟路1554弄53号",
      residenceCity: "上海市",
      residenceDetail: "北翟路1554弄53号",
      residenceDistrict: "闵行区",
      residenceProvince: "上海市",
      snapshotVersion: 1,
      source: "CUSTOMER_PORTAL_PROFILE"
    });
  });

  it("increments an existing snapshot version", () => {
    const v1 = buildApplicationCustomerProfileSnapshot(
      completeProfile,
      null,
      new Date("2026-08-12T00:00:00.000Z")
    );

    expect(
      buildApplicationCustomerProfileSnapshot(
        completeProfile,
        v1,
        new Date("2026-08-13T00:00:00.000Z")
      )
    ).toMatchObject({
      capturedAt: "2026-08-13T00:00:00.000Z",
      snapshotVersion: 2
    });
  });

  it("starts at V1 when the previous JSON does not contain a valid version", () => {
    expect(
      buildApplicationCustomerProfileSnapshot(
        completeProfile,
        { snapshotVersion: -1 },
        new Date("2026-08-12T00:00:00.000Z")
      ).snapshotVersion
    ).toBe(1);
  });
});
