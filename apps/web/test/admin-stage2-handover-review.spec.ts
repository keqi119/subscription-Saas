import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..", "..", "..");
const orderPagePath = "apps/web/src/app/orders/[id]/page.tsx";

describe("Admin Stage 2 handover review order page", () => {
  it("loads Stage 2 work orders and renders review, evidence, and objection actions safely", () => {
    const source = read(orderPagePath);

    expect(source).toContain("/handover-work-orders");
    expect(source).toContain("Stage 2");
    expect(source).toContain("viewHandoverWorkOrderDetail");
    expect(source).toContain("acknowledgeCustomerObjection");
    expect(source).toContain("requestCustomerObjectionResubmission");
    expect(source).toContain("sendCustomerObjectionBackToReview");
    expect(source).toContain("/objection/${action}");
    expect(source).toContain("\"acknowledge\"");
    expect(source).toContain("\"request-resubmission\"");
    expect(source).toContain("\"send-customer-review\"");
    expect(source).toContain("buildAdminHandoverFileUrl");
    expect(source).toContain("previewUrl");
    expect(source).toContain("downloadUrl");
    expect(source).toContain("预览");
    expect(source).toContain("下载/打开");
    expect(source).not.toMatch(/accessTokenHash|objectKey|bucket|signingUrl|idCard|fullPhone|raw DTO/i);
  });
});

function read(file: string) {
  return readFileSync(join(repoRoot, file), "utf8");
}
