import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..", "..", "..");
const portalHomePath = "apps/web/src/app/portal/page.tsx";
const listPagePath = "apps/web/src/app/portal/handover-reviews/page.tsx";
const detailPagePath = "apps/web/src/app/portal/handover-reviews/[id]/page.tsx";

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
    expect(source).toContain('router.replace(`/portal/login?redirect=${encodeURIComponent(`/portal/handover-reviews/${params.id}`)}`)');
    expect(source).not.toMatch(/objectKey|bucket|storage path|signingUrl|idCard|deposit|payment|lease|billing|raw DTO|JSON.stringify/i);
    expect(source).not.toMatch(/生成.*PDF|电子签|去签署|确认交付|去支付|付款|账单/);
  });
});

function read(file: string) {
  return readFileSync(join(repoRoot, file), "utf8");
}
