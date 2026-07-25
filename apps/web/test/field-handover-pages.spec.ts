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
    expect(source).not.toContain("disabled={checkingSession");
    expect(source).not.toContain("loading={submitting || checkingSession}");
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
    expect(source).toContain("重新加载");
    expect(source).toContain("loadTasks");
    expect(source).toContain("logoutFieldHandover");
    expect(source).toContain('router.replace("/field/handover")');
    expect(source).toContain("/field/handover/tasks/${task.id}");
    expect(source).not.toContain("/portal/login");
    expect(source).not.toContain("/login");
    expect(source).not.toMatch(/finance|payment|deposit|objectKey|providerPayload|signingUrl|token|cookie/i);
  });

  it("adds a mobile evidence capture detail page without PDF or eSign controls", () => {
    const source = read(detailPagePath);

    expect(source).toContain("现场资料采集");
    expect(source).toContain("保存现场信息");
    expect(source).toContain("提交现场资料");
    expect(source).toContain("发现损伤/瑕疵");
    expect(source).toContain("无可见损伤");
    expect(source).toContain("当前交接任务已提交或不可继续编辑");
    expect(source).toContain("startFieldHandoverWorkOrder");
    expect(source).toContain("updateFieldHandoverFacts");
    expect(source).toContain("uploadAndAttachFieldHandoverEvidenceFile");
    expect(source).toContain("removeFieldHandoverEvidenceFile");
    expect(source).toContain("validateFieldEvidenceFile");
    expect(source).not.toContain("function validateEvidenceFile");
    expect(source).not.toContain("MAX_PHOTO_SIZE_BYTES");
    expect(source).not.toContain("MAX_VIDEO_SIZE_BYTES");
    expect(source).toContain('capture="environment"');
    expect(source).toContain("现场拍照");
    expect(source).toContain("现场录像");
    expect(source).toContain("从相册选择");
    expect(source).toContain("从相册/文件选择");
    expect(source).toContain("上传进度");
    expect(source).toContain("取消上传");
    expect(source).toContain("重试上传");
    expect(source).toContain("multiple={false}");
    expect(source).toContain("multiple={multiple}");
    expect(source).toContain("reviewContext.customerObjectionReason");
    expect(source).toContain("reviewContext.customerObjectionDetails");
    expect(source).toContain("reviewContext.requestedEvidenceItems");
    expect(source).not.toContain("reviewContext.objectionReason");
    expect(source).toContain("查看资料");
    expect(source).toContain("重新加载");
    expect(source).toContain("declareFieldHandoverNoVisibleDamage");
    expect(source).toContain("submitFieldHandoverEvidence");
    expect(source).toContain("getFieldHandoverWorkOrder");
    expect(source).toContain('router.replace("/field/handover")');
    expect(source).not.toMatch(/eSignTask|startSigning|signingUrl|objectKey/i);
    expect(source).not.toMatch(/电子签|签署|PDF/);
  });

  it("shows customer objection recheck guidance before the evidence capture overview", () => {
    const source = read(detailPagePath);
    const reviewGuidanceIndex = source.indexOf("message={`客户异议：");
    const captureOverviewIndex = source.indexOf("现场资料采集");

    expect(reviewGuidanceIndex).toBeGreaterThan(-1);
    expect(captureOverviewIndex).toBeGreaterThan(-1);
    expect(reviewGuidanceIndex).toBeLessThan(captureOverviewIndex);
  });
});

function read(file: string) {
  return readFileSync(join(repoRoot, file), "utf8");
}
