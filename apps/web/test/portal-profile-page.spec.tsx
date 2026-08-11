import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..", "..", "..");

describe("Portal profile page contract", () => {
  it("collects the approved structured address and emergency contact fields", () => {
    const source = read("apps/web/src/app/portal/me/page.tsx");

    expect(source).toContain("省 / 市 / 区县");
    expect(source).toContain("详细地址");
    expect(source).toContain("紧急联系人姓名");
    expect(source).toContain("紧急联系人手机号");
    expect(source).toContain("CHINA_REGION_OPTIONS");
  });

  it("shows the verified login mobile without an editable mobile form field", () => {
    const source = read("apps/web/src/app/portal/me/page.tsx");

    expect(source).toContain('label="登录手机号"');
    expect(source).not.toContain('name="mobile"');
    expect(source).not.toContain("values.mobile");
  });
});

function read(file: string) {
  return readFileSync(join(repoRoot, file), "utf8");
}
