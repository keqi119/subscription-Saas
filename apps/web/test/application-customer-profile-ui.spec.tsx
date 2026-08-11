import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..", "..", "..");

describe("Admin assisted application customer profile contract", () => {
  it("creates a draft from customer selection without copying identity fields", () => {
    const source = read("apps/web/src/app/applications/page.tsx");

    expect(source).not.toContain("customerIdentity");
    expect(source).not.toContain("fillCustomerIdentity");
    expect(source).not.toContain('name={["customerIdentity", "idCardNo"]}');
    expect(source).toContain('name="customerId"');
    expect(source).toContain("record.customerProfileReadiness?.complete");
  });

  it("shows refreshable read-only customer profile and manual driving review copy", () => {
    const source = read("apps/web/src/app/applications/[id]/page.tsx");

    expect(source).toContain("刷新客户资料");
    expect(source).toContain("APPLICATION_DRIVING_QUALIFICATION_COPY");
    expect(source).toContain("buildApplicationCustomerProfileView");
    expect(source).toContain("onClick={() => void loadDetail()}");
    expect(source).not.toContain("refresh-customer-profile");
  });

  it("does not display structured driver license identity fields", () => {
    const source = read("apps/web/src/app/applications/[id]/page.tsx");

    expect(source).not.toContain('label: "驾驶证号"');
    expect(source).not.toContain('label: "驾驶证有效期"');
  });
});

function read(file: string) {
  return readFileSync(join(repoRoot, file), "utf8");
}
