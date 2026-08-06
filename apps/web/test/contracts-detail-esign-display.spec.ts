import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..", "..", "..");
const contractDetailPath = "apps/web/src/app/contracts/[id]/page.tsx";
const portalContractDetailPath = "apps/web/src/app/portal/contracts/[id]/page.tsx";

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

  it("passes the typed Stage 2 archive projection to the archive display model", () => {
    const eSignTaskSection = source.slice(
      source.indexOf("getAdminESignArchiveStatus({"),
      source.indexOf("const signerGroups")
    );

    expect(eSignTaskSection).toContain("archiveError:");
    expect(eSignTaskSection).toContain("task.archiveError ?? archiveErrorsByTaskId[task.id]");
    expect(eSignTaskSection).toContain("archiveStatus: task.archiveStatus");
    expect(eSignTaskSection).toContain("signedArtifactAvailable: task.signedArtifactAvailable");
    expect(eSignTaskSection).toContain("signingStage: task.signingStage");
  });

  it("uses the archive display model for the signed-document action", () => {
    const eSignTaskSection = source.slice(
      source.indexOf("getAdminESignArchiveStatus({"),
      source.indexOf("<ContractSnapshotSection")
    );

    expect(eSignTaskSection).toContain("archiveStatus.actionLabel");
    expect(eSignTaskSection).toContain("openSignedContract(task.id)");
    expect(eSignTaskSection).toContain("archiveStatus.errorSummary");
  });
});

describe("portal extension contract display", () => {
  const source = read(portalContractDetailPath);

  it("recognizes the Stage 3 extension agreement signing identity", () => {
    expect(source).toContain("SUBSCRIPTION_EXTENSION_AGREEMENT");
    expect(source).toContain("STAGE3_SUBSCRIPTION_EXTENSION");
  });

  it("shows both the original contract and supplemental agreement documents", () => {
    expect(source).toContain("原订阅合同");
    expect(source).toContain("续期补充协议");
    expect(source).toContain("generated-document/preview");
  });
});

function read(file: string) {
  return readFileSync(join(repoRoot, file), "utf8");
}
