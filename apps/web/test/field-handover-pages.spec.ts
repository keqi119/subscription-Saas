import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..", "..", "..");
const loginPagePath = "apps/web/src/app/field/handover/page.tsx";
const tasksPagePath = "apps/web/src/app/field/handover/tasks/page.tsx";
const detailPagePath = "apps/web/src/app/field/handover/tasks/[id]/page.tsx";

describe("field handover H5 pages", () => {
  it("adds the fixed login route without Admin or Portal auth redirects", () => {
    const source = read(loginPagePath);

    expect(source).toContain("车辆现场交接");
    expect(source).toContain("请使用被分配交接任务的手机号登录");
    expect(source).toContain("sendFieldHandoverCode");
    expect(source).toContain("loginFieldHandover");
    expect(source).toContain('router.replace("/field/handover/tasks")');
    expect(source).not.toContain("/portal/login");
    expect(source).not.toContain("/auth/login");
    expect(source).not.toMatch(/localStorage|sessionStorage|debugCode|access_token|field_access_token/);
  });

  it("adds a mobile task list route with loading, empty, error, and logout states", () => {
    const source = read(tasksPagePath);

    expect(source).toContain("我的交接任务");
    expect(source).toContain("正在加载交接任务...");
    expect(source).toContain("暂无待处理交接任务");
    expect(source).toContain("任务加载失败，请稍后重试");
    expect(source).toContain("logoutFieldHandover");
    expect(source).toContain('router.replace("/field/handover")');
    expect(source).toContain("/field/handover/tasks/${task.id}");
    expect(source).not.toContain("/portal/login");
    expect(source).not.toContain("/login");
    expect(source).not.toMatch(/finance|payment|deposit|objectKey|providerPayload|signingUrl|token|cookie/i);
  });

  it("adds a safe detail placeholder without evidence capture controls", () => {
    const source = read(detailPagePath);

    expect(source).toContain("现场资料采集将在下一阶段开放");
    expect(source).toContain("getFieldHandoverWorkOrder");
    expect(source).toContain('router.replace("/field/handover")');
    expect(source).not.toMatch(/attachEvidence|updateFieldFacts|submitEvidence|startFieldWork|eSignTask|startSigning|signingUrl|objectKey/i);
    expect(source).not.toMatch(/上传|提交|电子签|签署|PDF/);
  });
});

function read(file: string) {
  return readFileSync(join(repoRoot, file), "utf8");
}
