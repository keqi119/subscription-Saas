import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildAdminESignSignerGroups,
  getAdminESignArchiveStatus,
  type AdminESignSignerDisplayRow
} from "../src/lib/admin-esign-display";

const repoRoot = join(__dirname, "..", "..", "..");

describe("admin e-sign signer display", () => {
  it("renders four Stage 1 slot signer rows as two business signer groups", () => {
    const groups = buildAdminESignSignerGroups(stage1SignedRows());

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.displayName)).toEqual(["李柯", "Platform"]);
    expect(groups.map((group) => group.status)).toEqual(["SIGNED", "SIGNED"]);
    expect(groups.map((group) => group.slotSummaryLabel)).toEqual(["2 个签署位", "2 个盖章位"]);
  });

  it("keeps customer and platform slot details visible after grouping", () => {
    const groups = buildAdminESignSignerGroups(stage1SignedRows());

    expect(groups[0]).toMatchObject({
      displayName: "李柯",
      mobile: "186****0212",
      slotDetails: [
        { label: "合同正文", slotId: "STAGE1_BODY_CUSTOMER", status: "SIGNED" },
        { label: "附件1", slotId: "STAGE1_ATTACHMENT1_CUSTOMER", status: "SIGNED" }
      ]
    });
    expect(groups[1]).toMatchObject({
      displayName: "Platform",
      mobile: null,
      slotDetails: [
        { label: "合同正文", slotId: "STAGE1_BODY_PLATFORM", status: "SIGNED" },
        { label: "附件1", slotId: "STAGE1_ATTACHMENT1_PLATFORM", status: "SIGNED" }
      ]
    });
  });

  it("uses the least-complete slot state when grouped slot statuses differ", () => {
    const groups = buildAdminESignSignerGroups([
      stage1CustomerRow("customer-body", "STAGE1_BODY_CUSTOMER", "SIGNED"),
      stage1CustomerRow("customer-attachment", "STAGE1_ATTACHMENT1_CUSTOMER", "PENDING")
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      hasMixedStatuses: true,
      status: "PENDING",
      slotSummaryLabel: "2 个签署位"
    });
    expect(groups[0]!.slotDetails.map((slot) => `${slot.label}:${slot.status}`)).toEqual([
      "合同正文:SIGNED",
      "附件1:PENDING"
    ]);
  });

  it("does not copy signing URLs or full ID numbers into the display model", () => {
    const groups = buildAdminESignSignerGroups([
      {
        ...stage1CustomerRow("customer-body", "STAGE1_BODY_CUSTOMER", "SIGNED"),
        signerIdNo: "FULL_ID_NUMBER_SHOULD_NOT_RENDER",
        signUrl: "SIGNING_URL_SHOULD_NOT_RENDER"
      } as AdminESignSignerDisplayRow
    ]);

    expect(JSON.stringify(groups)).not.toContain("SIGNING_URL_SHOULD_NOT_RENDER");
    expect(JSON.stringify(groups)).not.toContain("FULL_ID_NUMBER_SHOULD_NOT_RENDER");
  });
});

describe("admin e-sign archive status display", () => {
  it("labels completed Fadada tasks without a signed PDF as awaiting archive", () => {
    expect(getAdminESignArchiveStatus({
      hasSignedDocument: false,
      provider: "FADADA",
      taskStatus: "COMPLETED"
    })).toMatchObject({
      actionLabel: "归档已签合同",
      canArchive: true,
      canOpenSignedPdf: false,
      state: "PENDING_ARCHIVE",
      tagColor: "orange",
      tagLabel: "已签署，待归档已签文件"
    });
  });

  it("shows the signed PDF action when the archive exists", () => {
    expect(getAdminESignArchiveStatus({
      hasSignedDocument: true,
      provider: "FADADA",
      taskStatus: "COMPLETED"
    })).toMatchObject({
      actionLabel: "查看已签署PDF",
      canArchive: false,
      canOpenSignedPdf: true,
      state: "ARCHIVED",
      tagColor: "green",
      tagLabel: "已签文件已归档"
    });
  });

  it("shows an archive retry state without marking signing failed", () => {
    expect(getAdminESignArchiveStatus({
      archiveError: "法大大下载已签合同失败",
      hasSignedDocument: false,
      provider: "FADADA",
      taskStatus: "COMPLETED"
    })).toMatchObject({
      actionLabel: "重试归档",
      canArchive: true,
      canOpenSignedPdf: false,
      errorSummary: "法大大下载已签合同失败",
      state: "ARCHIVE_FAILED",
      tagColor: "red",
      tagLabel: "归档失败，签署已完成"
    });
  });

  it("uses the authoritative Stage 2 handover archive state instead of a generic task object", () => {
    const stage2Task = {
      archiveError: "STAGE2_HANDOVER_ARCHIVE_PROVIDER_FAILED",
      archiveStatus: "FAILED",
      hasSignedDocument: true,
      provider: "FADADA",
      signedArtifactAvailable: false,
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      taskStatus: "COMPLETED"
    };

    expect(getAdminESignArchiveStatus(stage2Task)).toMatchObject({
      actionLabel: null,
      canArchive: false,
      canOpenSignedPdf: false,
      errorSummary: "STAGE2_HANDOVER_ARCHIVE_PROVIDER_FAILED",
      state: "ARCHIVE_FAILED",
      tagColor: "red",
      tagLabel: "归档失败，签署已完成"
    });
  });
});

describe("admin e-sign archive action wiring", () => {
  it("calls the archive endpoint and refreshes contract detail after archive", () => {
    const source = read("apps/web/src/app/contracts/[id]/page.tsx");
    const archiveAction = source.slice(
      source.indexOf("async function archiveSignedArtifacts"),
      source.indexOf("function openSignedContract")
    );

    expect(archiveAction).toContain("/esign-tasks/${taskId}/archive-signed-artifacts");
    expect(archiveAction).toContain('method: "POST"');
    expect(archiveAction).toContain("await loadContract()");
    expect(archiveAction).toContain("setArchivingTaskId(taskId)");
  });
});

function stage1SignedRows(): AdminESignSignerDisplayRow[] {
  return [
    stage1CustomerRow("customer-body", "STAGE1_BODY_CUSTOMER", "SIGNED"),
    stage1CustomerRow("customer-attachment", "STAGE1_ATTACHMENT1_CUSTOMER", "SIGNED"),
    stage1PlatformRow("platform-body", "STAGE1_BODY_PLATFORM", "SIGNED"),
    stage1PlatformRow("platform-attachment", "STAGE1_ATTACHMENT1_PLATFORM", "SIGNED")
  ];
}

function stage1CustomerRow(id: string, slotId: string, signerStatus: string): AdminESignSignerDisplayRow {
  return {
    id,
    providerActionType: "CUSTOMER_MANUAL_SIGN",
    providerSignerId: "ESG20260720165218TYGFS1",
    signerName: "李柯",
    signerPhone: "186****0212",
    signerStatus,
    signerType: "CUSTOMER",
    slotId
  };
}

function stage1PlatformRow(id: string, slotId: string, signerStatus: string): AdminESignSignerDisplayRow {
  return {
    id,
    providerActionType: "PLATFORM_AUTO_SEAL",
    providerSignerId: "ESG20260720165218TYGFS2",
    signerName: "Platform",
    signerPhone: null,
    signerStatus,
    signerType: "PLATFORM",
    slotId
  };
}

function read(file: string) {
  return readFileSync(join(repoRoot, file), "utf8");
}
