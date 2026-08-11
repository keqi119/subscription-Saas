import { describe, expect, it } from "vitest";

import {
  toPortalProfileFormValues,
  toPortalProfileUpdatePayload
} from "../src/lib/portal-profile-form";
import type { PortalCustomerProfile } from "../src/lib/portal-types";

describe("Portal profile form mapping", () => {
  it("maps structured profile values to the Portal PATCH payload", () => {
    expect(
      toPortalProfileUpdatePayload({
        emergencyContactMobile: "13900000000",
        emergencyContactName: "王女士",
        idCardNo: "11010519491231002X",
        name: "测试客户",
        residenceRegion: ["上海市", "上海市", "闵行区"],
        residenceDetail: "北翟路1554弄53号"
      })
    ).toEqual({
      emergencyContactMobile: "13900000000",
      emergencyContactName: "王女士",
      idCardNo: "11010519491231002X",
      name: "测试客户",
      residenceCity: "上海市",
      residenceDetail: "北翟路1554弄53号",
      residenceDistrict: "闵行区",
      residenceProvince: "上海市"
    });
  });

  it("maps persisted region names back to the Cascader path", () => {
    expect(toPortalProfileFormValues(profile()).residenceRegion).toEqual([
      "上海市",
      "上海市",
      "闵行区"
    ]);
  });

  it("omits a blank replacement ID when an ID is already stored", () => {
    expect(
      toPortalProfileUpdatePayload(
        {
          emergencyContactMobile: "13900000000",
          emergencyContactName: "王女士",
          idCardNo: " ",
          name: "测试客户",
          residenceRegion: ["上海市", "上海市", "闵行区"],
          residenceDetail: "北翟路1554弄53号"
        },
        true
      )
    ).not.toHaveProperty("idCardNo");
  });

  it("rejects a payload without a complete region path", () => {
    expect(() =>
      toPortalProfileUpdatePayload({
        emergencyContactMobile: "13900000000",
        emergencyContactName: "王女士",
        name: "测试客户",
        residenceRegion: ["上海市", "上海市"],
        residenceDetail: "北翟路1554弄53号"
      })
    ).toThrow("PROFILE_REGION_REQUIRED");
  });
});

function profile(): PortalCustomerProfile {
  return {
    emergencyContactMobile: "13900000000",
    emergencyContactName: "王女士",
    idCardNoMasked: "110105********002X",
    idCardNoPresent: true,
    missingProfileFields: [],
    mobile: "13800000000",
    name: "测试客户",
    profileComplete: true,
    profileUpdatedAt: "2026-08-12T00:00:00.000Z",
    residenceAddress: "上海市闵行区北翟路1554弄53号",
    residenceCity: "上海市",
    residenceDetail: "北翟路1554弄53号",
    residenceDistrict: "闵行区",
    residenceProvince: "上海市"
  };
}
