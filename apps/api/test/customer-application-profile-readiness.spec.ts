import { describe, expect, it } from "vitest";

import {
  buildCustomerApplicationProfileReadiness,
  CUSTOMER_APPLICATION_PROFILE_INCOMPLETE,
  CUSTOMER_APPLICATION_PROFILE_INVALID,
  type CustomerApplicationProfileFieldKey,
  formatResidenceAddress,
  normalizeCustomerApplicationProfile
} from "../src/customer/customer-application-profile-readiness";

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

describe("customer application profile readiness", () => {
  it("accepts and normalizes the minimum application profile", () => {
    expect(buildCustomerApplicationProfileReadiness(completeProfile)).toEqual({
      complete: true,
      missingFields: []
    });
    expect(normalizeCustomerApplicationProfile(completeProfile)).toEqual({
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
      residenceProvince: "上海市"
    });
  });

  it.each([
    "name",
    "mobile",
    "idCardNo",
    "residenceProvince",
    "residenceCity",
    "residenceDistrict",
    "residenceDetail",
    "emergencyContactName",
    "emergencyContactMobile"
  ] as const)("reports missing %s", (key) => {
    const source = structuredClone(completeProfile);
    deleteProfileField(source, key);

    expect(buildCustomerApplicationProfileReadiness(source).missingFields).toEqual(
      expect.arrayContaining([expect.objectContaining({ key, reason: "MISSING" })])
    );
  });

  it("rejects an invalid emergency contact mobile", () => {
    const source = structuredClone(completeProfile);
    source.profile.emergencyContactMobile = "12345";

    expect(buildCustomerApplicationProfileReadiness(source).missingFields).toContainEqual(
      expect.objectContaining({ key: "emergencyContactMobile", reason: "INVALID" })
    );
  });

  it("rejects an emergency contact mobile equal to the login mobile", () => {
    const source = structuredClone(completeProfile);
    source.profile.emergencyContactMobile = source.mobile;

    expect(buildCustomerApplicationProfileReadiness(source).missingFields).toContainEqual(
      expect.objectContaining({ key: "emergencyContactMobile", reason: "INVALID" })
    );
    expect(() => normalizeCustomerApplicationProfile(source)).toThrow(
      CUSTOMER_APPLICATION_PROFILE_INCOMPLETE
    );
  });

  it("formats direct-municipality addresses without duplicating the city", () => {
    expect(formatResidenceAddress(completeProfile.profile)).toBe(
      "上海市闵行区北翟路1554弄53号"
    );
  });

  it("rejects a composed residence address longer than the persisted limit", () => {
    expect(() =>
      formatResidenceAddress({
        ...completeProfile.profile,
        residenceDetail: "址".repeat(256)
      })
    ).toThrow(CUSTOMER_APPLICATION_PROFILE_INVALID);
  });
});

function deleteProfileField(
  source: typeof completeProfile,
  key: CustomerApplicationProfileFieldKey
) {
  if (key === "name" || key === "mobile") {
    source[key] = "";
    return;
  }
  if (key === "idCardNo") {
    source.identity.idCardNo = "";
    return;
  }
  source.profile[key] = "";
}
