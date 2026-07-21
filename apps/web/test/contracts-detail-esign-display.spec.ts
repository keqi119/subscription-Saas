import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..", "..", "..");
const contractDetailPath = "apps/web/src/app/contracts/[id]/page.tsx";

describe("contract detail e-sign display", () => {
  const source = read(contractDetailPath);

  it("removes the duplicate signed original section", () => {
    expect(source).not.toContain("已签署合同原件");
  });

  it("keeps e-sign task information as the single signed document surface", () => {
    const eSignTaskSection = source.slice(
      source.indexOf('title="电子签任务"'),
      source.indexOf("<ContractSnapshotSection")
    );

    expect(eSignTaskSection).toContain('title="电子签任务"');
    expect(eSignTaskSection).toContain("查看已签署PDF");
    expect(eSignTaskSection).toContain("openSignedContract(task.id)");
    expect(eSignTaskSection).toContain("getAdminESignArchiveStatus");
    expect(eSignTaskSection).toContain("archiveStatus.actionLabel");
    expect(eSignTaskSection).toContain("archiveSignedArtifacts(task.id)");
    expect(eSignTaskSection).toContain("buildAdminESignSignerGroups(task.signers)");
    expect(eSignTaskSection).toContain("labelOf(ESIGN_TASK_STATUS_LABELS");
    expect(eSignTaskSection).toContain("labelOf(ESIGN_PROVIDER_LABELS");
    expect(eSignTaskSection).toContain("signerGroups.map");
  });

  it("shows the generated signing PDF before an e-sign task exists", () => {
    expect(source).toContain("openGeneratedContractPdf");
    expect(source).toContain("/generated-pdf/preview");
    expect(source).toContain("查看待签署PDF");
  });
});

function read(file: string) {
  return readFileSync(join(repoRoot, file), "utf8");
}
