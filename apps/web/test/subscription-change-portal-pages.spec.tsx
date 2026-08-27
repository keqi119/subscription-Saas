import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..", "..", "..");
const portalChangePage = readFileSync(
  join(repoRoot, "apps/web/src/app/portal/subscription-changes/[id]/page.tsx"),
  "utf8"
);
const portalOrderPage = readFileSync(
  join(repoRoot, "apps/web/src/app/portal/orders/[id]/page.tsx"),
  "utf8"
);

describe("Portal subscription change pages", () => {
  it("renders customer-facing terms for extension, swap, and early termination", () => {
    expect(portalChangePage).toContain("change.changeType");
    expect(portalChangePage).toContain("commercialSnapshotHash");
    expect(portalChangePage).toContain("effectiveDate");
    expect(portalChangePage).toContain("targetVehicle");
    expect(portalChangePage).toContain("contractId");
    expect(portalChangePage).toContain("!change.customerConfirmationPublishedAt");
  });

  it("keeps internal approvals and takeover diagnostics out of the customer page", () => {
    expect(portalChangePage).not.toContain("approvalReference");
    expect(portalChangePage).not.toContain("approvedBy");
    expect(portalChangePage).not.toContain("manualTakeoverReason");
  });

  it("links active orders to the customer-visible change detail", () => {
    expect(portalOrderPage).toContain("/portal/subscription-changes/");
  });
});
