import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..", "..", "..");

describe("mileage review workspaces", () => {
  it("provides an admin queue with filters, overdue-first ordering, and order links", () => {
    const source = read("apps/web/src/app/mileage-reviews/page.tsx");

    expect(source).toContain('apiFetch<MileageReviewPage>("/mileage-reviews');
    expect(source).toContain('params.set("overdue", "true")');
    expect(source).toContain("showSizeChanger: true");
    expect(source).toContain("逾期待提交");
    expect(source).toContain("待后台复核");
    expect(source).toContain("已确认");
    expect(source).toContain("已作废");
    expect(source).toContain("/orders/${item.order.id}");
    expect(source).toContain("/mileage-reviews/${item.id}");
  });

  it("provides admin draft, submit, return, confirm, and controlled void actions", () => {
    const source = read("apps/web/src/app/mileage-reviews/[id]/page.tsx");

    expect(source).toContain("/admin-draft");
    expect(source).toContain("/submit");
    expect(source).toContain("/return");
    expect(source).toContain("/confirm");
    expect(source).toContain("/void-reopen");
    expect(source).toContain("validateMileageReviewSubmission");
    expect(source).toContain("overMileageBillId");
    expect(source).toContain("previewUrl");
    expect(source).toContain("/evidence/upload");
    expect(source).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(source).toContain('permissions.has("mileage_review:confirm")');
    expect(source).toContain('permissions.has("mileage_review:submit")');
    expect(source).toContain("lockVersion");
  });

  it("uses mobile cards for Portal submission, image upload, results, bills, and history", () => {
    const listSource = read("apps/web/src/app/portal/mileage-reviews/page.tsx");
    const detailSource = read("apps/web/src/app/portal/mileage-reviews/[id]/page.tsx");

    expect(listSource).toContain("里程复核");
    expect(listSource).toContain("getPortalMileageReviewGuidance");
    expect(listSource).not.toContain("<Table");
    expect(detailSource).toContain('accept="image/*"');
    expect(detailSource).toContain('capture="environment"');
    expect(detailSource).toContain("/portal/mileage-reviews/${params.id}/evidence");
    expect(detailSource).toContain("validateMileageReviewSubmission");
    expect(detailSource).toContain("overMileageBillHref");
    expect(detailSource).toContain("只读历史");
    expect(detailSource).not.toMatch(/objectKey|bucket|JSON\.stringify\(review\)/);
  });

  it("continues guidance from Portal home/order and exposes the admin order entry", () => {
    const portalHome = read("apps/web/src/app/portal/page.tsx");
    const portalOrder = read("apps/web/src/app/portal/orders/[id]/page.tsx");
    const adminOrder = read("apps/web/src/app/orders/[id]/page.tsx");

    expect(portalHome).toContain("/portal/mileage-reviews");
    expect(portalHome).toContain("月度里程复核");
    expect(portalOrder).toContain("mileageReviewSummary");
    expect(portalOrder).toContain("getMileageReviewPresentation");
    expect(portalOrder).not.toContain("as MileageReviewStatus");
    expect(portalOrder).not.toContain(
      'order.mileageReviewSummary.overdue ? "已逾期" : order.mileageReviewSummary.status'
    );
    expect(portalOrder).toContain("SUBMIT_MILEAGE_REVIEW");
    expect(portalOrder).toContain("nextActionTarget");
    expect(adminOrder).toContain("/mileage-reviews?orderId=");
  });
});

function read(file: string) {
  return readFileSync(join(repoRoot, file), "utf8");
}
