import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..", "..", "..");
const portalHomePath = "apps/web/src/app/portal/page.tsx";
const listPagePath = "apps/web/src/app/portal/handover-reviews/page.tsx";
const detailPagePath = "apps/web/src/app/portal/handover-reviews/[id]/page.tsx";
const contractListPagePath = "apps/web/src/app/portal/contracts/page.tsx";
const contractDetailPagePath = "apps/web/src/app/portal/contracts/[id]/page.tsx";

describe("portal handover review pages", () => {
  it("adds the Portal entry and list route with safe loading, empty, error, and auth handling", () => {
    const homeSource = read(portalHomePath);
    const source = read(listPagePath);

    expect(homeSource).toContain("/portal/handover-reviews");
    expect(homeSource).toContain("车辆交接确认");
    expect(source).toContain("车辆交接确认");
    expect(source).toContain("正在加载交接确认事项...");
    expect(source).toContain("暂无待确认的车辆交接事项");
    expect(source).toContain("交接确认事项加载失败，请稍后重试");
    expect(source).toContain("listPortalHandoverReviews");
    expect(source).toContain('router.replace(`/portal/login?redirect=${encodeURIComponent("/portal/handover-reviews")}`)');
    expect(source).toContain("/portal/handover-reviews/${review.id}");
    expect(source).toContain("查看交接资料");
    expect(source).not.toMatch(/objectKey|bucket|signingUrl|fullId|idCard|deposit|payment|raw DTO|JSON.stringify/i);
    expect(source).not.toMatch(/电子签|签署链接|PDF|付款|账单|交付确认按钮/);
  });

  it("adds the detail route with facts, evidence, confirm and objection flows", () => {
    const source = read(detailPagePath);

    expect(source).toContain("车辆交接资料确认");
    expect(source).toContain("基础信息");
    expect(source).toContain("现场交接信息");
    expect(source).toContain("资料清单");
    expect(source).toContain("客户确认");
    expect(source).toContain("本人已查看本次交接证据包所列全部照片和视频");
    expect(source).toContain("manifestHash");
    expect(source).toContain("确认无异议");
    expect(source).toContain("提出异议");
    expect(source).toContain("提交异议");
    expect(source).toContain("请填写异议原因");
    expect(source).toContain("已确认无异议");
    expect(source).toContain("已提交异议，工作人员将联系您处理");
    expect(source).toContain("confirmPortalHandoverReview");
    expect(source).toContain("objectPortalHandoverReview");
    expect(source).toContain("getPortalHandoverReview");
    expect(source).toContain("item.files");
    expect(source).toContain("预览");
    expect(source).toContain("下载/打开");
    expect(source).toContain("复核历史");
    expect(source).toContain("reviewHistory");
    expect(source).toContain("车辆交接确认单签署");
    expect(source).toContain("getPortalHandoverESign");
    expect(source).toContain("startPortalHandoverSigning");
    expect(source).toContain("buildPortalHandoverESignView");
    expect(source).toContain("buildPortalHandoverWorkflowView");
    expect(source).toContain("正在加载签署状态...");
    expect(source).toContain("签署状态加载失败");
    expect(source).toContain("workflowDisplay.signingButtonText");
    expect(source).toContain("workflowDisplay.signingButtonDisabled");
    expect(source).toContain("window.setTimeout");
    expect(source).toContain("window.clearTimeout");
    expect(source).toContain("查看已签署交接确认单");
    expect(source).toContain("esignDisplay.signedDocumentPreviewUrl");
    expect(source).toMatch(
      /buildPortalHandoverReviewFileUrl\(\s*esignDisplay\.signedDocumentPreviewUrl\s*\)/
    );
    expect(source).toContain("loading={startingSigning}");
    expect(source).toContain("workflowDisplay.signingButtonDisabled || startingSigning");
    expect(source).toContain(
      "window.location.assign(validatePortalHandoverSigningRedirect(result.signUrl))"
    );
    expect(source).toContain('"alreadySigned" in result');
    expect(source).toContain("createPortalWorkflowRequestController");
    expect(source).toContain("startPolling(3000)");
    expect(source).not.toContain("window.setInterval");
    expect(source).toContain("PENDING_CUSTOMER_SIGNATURE");
    expect(source).toContain('router.replace(`/portal/login?redirect=${encodeURIComponent(`/portal/handover-reviews/${params.id}`)}`)');
    expect(source).not.toMatch(/objectKey|bucket|storage path|signingUrl|idCard|deposit|payment|lease|billing|raw DTO|JSON.stringify/i);
    expect(source).not.toMatch(/setSignUrl|localStorage|sessionStorage|console\.(log|info|debug)|href=\{[^}]*signUrl/i);
    expect(source).not.toMatch(/生成.*PDF|确认交付|去支付|付款|账单/);
  });

  it("guards the intentional signing start action against repeated clicks", () => {
    const source = read(detailPagePath);

    expect(source).toContain("signingStartInFlight.current");
    expect(source).toContain("!workflowDisplay?.canStartSigning");
    expect(source).toContain('review?.handover?.status !== "PENDING_CUSTOMER_SIGNATURE"');
    expect(source).toContain("signingStartInFlight.current = true");
    expect(source).toContain("signingStartInFlight.current = false");
  });

  it("routes generic Stage 2 contract entries to the dedicated handover review before Stage 1 signing", () => {
    const listSource = read(contractListPagePath);
    const detailSource = read(contractDetailPagePath);
    const stage2GuardIndex = detailSource.indexOf("const stage2Destination");
    const stage1StartIndex = detailSource.indexOf(
      "`/portal/contracts/${contract.id}/signing/start`"
    );

    expect(listSource).toContain("getPortalContractDestination(contract)");
    expect(stage2GuardIndex).toBeGreaterThan(-1);
    expect(stage1StartIndex).toBeGreaterThan(stage2GuardIndex);
    expect(detailSource.slice(stage2GuardIndex, stage1StartIndex)).toContain("return;");
  });
});

function read(file: string) {
  return readFileSync(join(repoRoot, file), "utf8");
}
