import { describe, expect, it } from "vitest";

import {
  buildContractVersionCreatePayload,
  CONTRACT_TEMPLATE_TYPE_OPTIONS,
  DEFAULT_CONTRACT_TEMPLATE_TYPE,
  labelContractTemplateType
} from "../src/lib/contract-version-form";

describe("contract version form", () => {
  it("defaults new versions to the standard subscription template type", () => {
    expect(DEFAULT_CONTRACT_TEMPLATE_TYPE).toBe("SUBSCRIPTION_STANDARD");
  });

  it("includes the selected delivery handover type in the create payload", () => {
    expect(buildContractVersionCreatePayload({
      contentTemplate: "车辆交接确认单",
      effectiveFrom: "2026-07-26",
      effectiveTo: undefined,
      templateName: "车辆交接确认单",
      templateType: "DELIVERY_HANDOVER",
      versionNo: "V1.0"
    })).toEqual({
      businessType: "SUBSCRIPTION",
      contentTemplate: "车辆交接确认单",
      effectiveFrom: "2026-07-26",
      effectiveTo: undefined,
      templateName: "车辆交接确认单",
      templateType: "DELIVERY_HANDOVER",
      versionNo: "V1.0"
    });
  });

  it("exposes stable Admin labels for both supported template types", () => {
    expect(CONTRACT_TEMPLATE_TYPE_OPTIONS).toEqual([
      { label: "标准订阅合同", value: "SUBSCRIPTION_STANDARD" },
      { label: "车辆交接确认单", value: "DELIVERY_HANDOVER" }
    ]);
    expect(labelContractTemplateType("DELIVERY_HANDOVER")).toBe("车辆交接确认单");
    expect(labelContractTemplateType("UNKNOWN")).toBe("UNKNOWN");
  });
});
