import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..", "..", "..");

describe("Admin terminal application workspace", () => {
  it("keeps the header read-only after a formal order exists", () => {
    const source = readFileSync(
      join(repoRoot, "apps/web/src/app/applications/[id]/page.tsx"),
      "utf8"
    );

    expect(source).toContain(
      "const applicationWorkspaceReadOnly = isApplicationWorkspaceReadOnly(detail);"
    );
    expect(source).toContain(
      "const applicationActionButtons = applicationWorkspaceReadOnly ? null : ("
    );
    expect(source).toContain("{applicationActionButtons}");
    expect(source).toContain("file.canDelete && !applicationWorkspaceReadOnly");
    expect(source).toContain("hidden: applicationWorkspaceReadOnly");
    expect(source).toContain("canReviewApplication && !applicationWorkspaceReadOnly");
    expect(source).toContain("查看订单");
    expect(source).not.toContain("申请变更方案");
  });
});
