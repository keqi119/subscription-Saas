import { describe, expect, it } from "vitest";

import {
  APPLICATION_DRIVING_QUALIFICATION_COPY,
  buildApplicationCustomerProfileView,
  type ApplicationCustomerProfileDetail
} from "../src/lib/application-customer-profile-view-model";

describe("application customer profile view model", () => {
  it.each([
    ["CURRENT", "客户当前资料"],
    ["SNAPSHOT", "V2 进件提交快照"],
    ["HISTORICAL_CURRENT_FALLBACK", "历史记录，当前展示客户档案"]
  ] as const)("labels %s correctly", (source, label) => {
    expect(
      buildApplicationCustomerProfileView(
        applicationDetail({ customerProfileDisplaySource: source })
      ).sourceLabel
    ).toBe(label);
  });

  it("uses the frozen snapshot after submission", () => {
    const view = buildApplicationCustomerProfileView(
      applicationDetail({
        customerProfileDisplaySource: "SNAPSHOT",
        customerProfileSnapshot: {
          capturedAt: "2026-08-12T10:00:00.000Z",
          emergencyContactMobile: "13900000000",
          emergencyContactName: "王女士",
          idCardNo: "11010519491231002X",
          mobile: "13800000000",
          name: "快照姓名",
          residenceAddress: "上海市闵行区北翟路1554弄53号",
          residenceCity: "上海市",
          residenceDetail: "北翟路1554弄53号",
          residenceDistrict: "闵行区",
          residenceProvince: "上海市",
          snapshotVersion: 2
        }
      })
    );

    expect(view).toMatchObject({
      address: "上海市闵行区北翟路1554弄53号",
      capturedAt: "2026-08-12T10:00:00.000Z",
      mobile: "13800000000",
      name: "快照姓名",
      profileComplete: true
    });
  });

  it("formats current structured address and readiness issues", () => {
    const view = buildApplicationCustomerProfileView(
      applicationDetail({
        customerProfileReadiness: {
          complete: false,
          missingFields: [
            { key: "residenceDetail", reason: "MISSING" },
            { key: "emergencyContactMobile", reason: "INVALID" }
          ]
        }
      })
    );

    expect(view.address).toBe("上海市闵行区北翟路1554弄53号");
    expect(view.missingFieldLabels).toEqual(["详细居住地址", "紧急联系人手机号"]);
    expect(view.profileComplete).toBe(false);
  });

  it("uses the approved manual driving-qualification copy", () => {
    expect(APPLICATION_DRIVING_QUALIFICATION_COPY).toBe(
      "驾驶资格以驾驶证材料人工审核结果为准"
    );
  });
});

function applicationDetail(
  overrides: Partial<ApplicationCustomerProfileDetail> = {}
): ApplicationCustomerProfileDetail {
  return {
    customer: {
      identity: { idCardNo: "11010519491231002X" },
      mobile: "13800000000",
      name: "当前姓名",
      profile: {
        emergencyContactMobile: "13900000000",
        emergencyContactName: "王女士",
        residenceCity: "上海市",
        residenceDetail: "北翟路1554弄53号",
        residenceDistrict: "闵行区",
        residenceProvince: "上海市"
      }
    },
    customerProfileDisplaySource: "CURRENT",
    customerProfileReadiness: { complete: true, missingFields: [] },
    customerProfileSnapshot: {
      capturedAt: "2026-08-12T10:00:00.000Z",
      emergencyContactMobile: "13900000000",
      emergencyContactName: "王女士",
      idCardNo: "11010519491231002X",
      mobile: "13800000000",
      name: "快照姓名",
      residenceAddress: "上海市闵行区北翟路1554弄53号",
      residenceCity: "上海市",
      residenceDetail: "北翟路1554弄53号",
      residenceDistrict: "闵行区",
      residenceProvince: "上海市",
      snapshotVersion: 2
    },
    customerProfileUpdatedAt: "2026-08-12T09:00:00.000Z",
    ...overrides
  };
}
