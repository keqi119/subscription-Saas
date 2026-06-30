import { describe, expect, it } from "vitest";

import { createFadadaProviderOpenId } from "../src/esign/esign-provider-open-id";

describe("Fadada provider openId", () => {
  it("generates a stable non-PII personal openId from the local customer id", () => {
    const first = createFadadaProviderOpenId("3c954f88-bc12-47a4-b1d6-1c7bb0e9810a");
    const second = createFadadaProviderOpenId("3c954f88-bc12-47a4-b1d6-1c7bb0e9810a");

    expect(first).toBe(second);
    expect(first).toBe("subauto_person_v1_ad8de196e9a8021ec9a7ac8a");
    expect(first).toMatch(/^subauto_person_v1_[a-f0-9]{24}$/);
    expect(first).not.toContain("186");
    expect(first).not.toContain("0212");
    expect(first).not.toContain("3c954f88");
  });

  it("uses different openIds for different customers", () => {
    expect(createFadadaProviderOpenId("customer-a")).not.toBe(createFadadaProviderOpenId("customer-b"));
  });
});
