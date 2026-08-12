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

  it("integrates the shared profile tabs and defaults the home entry to basic profile", () => {
    const meSource = read("apps/web/src/app/portal/me/page.tsx");
    const materialsSource = read("apps/web/src/app/portal/materials/page.tsx");
    const homeSource = read("apps/web/src/app/portal/page.tsx");

    expect(meSource).toContain('<PortalProfileTabs activeTab="basic"');
    expect(materialsSource).toContain('<PortalProfileTabs activeTab="materials"');
    expect(homeSource).toContain(
      '{ href: "/portal/me", icon: <IdcardOutlined />, title: "我的资料" }'
    );
    expect(homeSource).not.toContain(
      '{ href: "/portal/materials", icon: <IdcardOutlined />, title: "我的资料" }'
    );
  });
});

function read(file: string) {
  return readFileSync(join(repoRoot, file), "utf8");
}
