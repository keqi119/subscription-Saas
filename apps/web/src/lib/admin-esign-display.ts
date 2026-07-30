export interface AdminESignSignerDisplayRow {
  id: string;
  providerActionType?: string | null;
  providerSignerId?: string | null;
  signerName?: string | null;
  signerPhone?: string | null;
  signerStatus: string;
  signerType: string;
  slotId?: string | null;
}

export interface AdminESignSignerSlotDetail {
  id: string;
  label: string;
  slotId: string | null;
  status: string;
}

export interface AdminESignSignerGroup {
  actionType: string | null;
  displayName: string;
  hasMixedStatuses: boolean;
  id: string;
  mobile: string | null;
  providerSignerId: string | null;
  signerType: string;
  slotCount: number;
  slotDetails: AdminESignSignerSlotDetail[];
  slotSummaryLabel: string;
  status: string;
}

export type AdminESignArchiveStatusState =
  | "ARCHIVE_FAILED"
  | "ARCHIVED"
  | "NOT_READY"
  | "PENDING_ARCHIVE";

export interface AdminESignArchiveStatusInput {
  archiveError?: string | null;
  archiveStatus?: string | null;
  hasSignedDocument?: boolean | null;
  provider: string;
  signedArtifactAvailable?: boolean | null;
  signingStage?: string | null;
  taskStatus: string;
}

export interface AdminESignArchiveStatus {
  actionLabel: string | null;
  canArchive: boolean;
  canOpenSignedPdf: boolean;
  errorSummary: string | null;
  state: AdminESignArchiveStatusState;
  tagColor: string | null;
  tagLabel: string | null;
}

const SLOT_ORDER = new Map<string, number>([
  ["STAGE1_BODY_CUSTOMER", 10],
  ["STAGE1_BODY_PLATFORM", 20],
  ["STAGE1_ATTACHMENT1_CUSTOMER", 30],
  ["STAGE1_ATTACHMENT1_PLATFORM", 40]
]);

const STATUS_PRIORITY = new Map<string, number>([
  ["FAILED", 0],
  ["REJECTED", 0],
  ["CANCELLED", 1],
  ["PENDING", 2],
  ["SIGNING", 3],
  ["SIGNED", 4]
]);

export function buildAdminESignSignerGroups(
  signers: readonly AdminESignSignerDisplayRow[]
): AdminESignSignerGroup[] {
  const groups = new Map<string, AdminESignSignerDisplayRow[]>();

  for (const signer of signers) {
    const key = buildSignerGroupKey(signer);
    groups.set(key, [...(groups.get(key) ?? []), signer]);
  }

  return Array.from(groups.entries()).map(([key, rows]) => buildSignerGroup(key, rows));
}

export function getAdminESignArchiveStatus(input: AdminESignArchiveStatusInput): AdminESignArchiveStatus {
  const provider = input.provider.toUpperCase();
  const isFadadaCompleted = provider === "FADADA" && input.taskStatus === "COMPLETED";
  const errorSummary = normalizeOptionalText(input.archiveError);

  if (input.signingStage === "STAGE2_DELIVERY_HANDOVER") {
    if (
      input.archiveStatus === "ARCHIVED" &&
      input.signedArtifactAvailable === true
    ) {
      return {
        actionLabel: "查看已签署PDF",
        canArchive: false,
        canOpenSignedPdf: true,
        errorSummary: null,
        state: "ARCHIVED",
        tagColor: "green",
        tagLabel: "已签文件已归档"
      };
    }

    if (input.archiveStatus === "FAILED") {
      return {
        actionLabel: null,
        canArchive: false,
        canOpenSignedPdf: false,
        errorSummary,
        state: "ARCHIVE_FAILED",
        tagColor: "red",
        tagLabel: "归档失败，签署已完成"
      };
    }

    if (isFadadaCompleted) {
      return {
        actionLabel: null,
        canArchive: false,
        canOpenSignedPdf: false,
        errorSummary: null,
        state: "PENDING_ARCHIVE",
        tagColor: input.archiveStatus === "PENDING" ? "blue" : "orange",
        tagLabel:
          input.archiveStatus === "PENDING"
            ? "签署文件归档中"
            : "已签署，待归档已签文件"
      };
    }

    return {
      actionLabel: null,
      canArchive: false,
      canOpenSignedPdf: false,
      errorSummary: null,
      state: "NOT_READY",
      tagColor: null,
      tagLabel: null
    };
  }

  if (input.hasSignedDocument) {
    return {
      actionLabel: "查看已签署PDF",
      canArchive: false,
      canOpenSignedPdf: true,
      errorSummary: null,
      state: "ARCHIVED",
      tagColor: "green",
      tagLabel: "已签文件已归档"
    };
  }

  if (isFadadaCompleted && errorSummary) {
    return {
      actionLabel: "重试归档",
      canArchive: true,
      canOpenSignedPdf: false,
      errorSummary,
      state: "ARCHIVE_FAILED",
      tagColor: "red",
      tagLabel: "归档失败，签署已完成"
    };
  }

  if (isFadadaCompleted) {
    return {
      actionLabel: "归档已签合同",
      canArchive: true,
      canOpenSignedPdf: false,
      errorSummary: null,
      state: "PENDING_ARCHIVE",
      tagColor: "orange",
      tagLabel: "已签署，待归档已签文件"
    };
  }

  return {
    actionLabel: null,
    canArchive: false,
    canOpenSignedPdf: false,
    errorSummary: null,
    state: "NOT_READY",
    tagColor: null,
    tagLabel: null
  };
}

function buildSignerGroup(key: string, rows: AdminESignSignerDisplayRow[]): AdminESignSignerGroup {
  const sortedRows = [...rows].sort(compareSignerRowsBySlot);
  const first = sortedRows[0]!;
  const slotNoun = getSlotNoun(sortedRows);
  const status = getLeastCompleteStatus(sortedRows);
  const statuses = new Set(sortedRows.map((row) => row.signerStatus));

  return {
    actionType: normalizeOptionalText(first.providerActionType),
    displayName: getDisplayName(first),
    hasMixedStatuses: statuses.size > 1,
    id: key,
    mobile: normalizeOptionalText(first.signerPhone),
    providerSignerId: normalizeOptionalText(first.providerSignerId),
    signerType: first.signerType,
    slotCount: sortedRows.length,
    slotDetails: sortedRows.map((row, index) => ({
      id: row.id,
      label: getSlotLabel(row.slotId, slotNoun, index),
      slotId: normalizeOptionalText(row.slotId),
      status: row.signerStatus
    })),
    slotSummaryLabel: `${sortedRows.length} 个${slotNoun}`,
    status
  };
}

function buildSignerGroupKey(signer: AdminESignSignerDisplayRow) {
  const providerSignerId = normalizeOptionalText(signer.providerSignerId);
  if (providerSignerId) {
    return `${signer.signerType}:provider:${providerSignerId}`;
  }

  return [
    signer.signerType,
    normalizeOptionalText(signer.providerActionType) ?? "-",
    normalizeOptionalText(signer.signerName) ?? "-",
    normalizeOptionalText(signer.signerPhone) ?? "-"
  ].join(":");
}

function compareSignerRowsBySlot(left: AdminESignSignerDisplayRow, right: AdminESignSignerDisplayRow) {
  const leftOrder = left.slotId ? SLOT_ORDER.get(left.slotId) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
  const rightOrder = right.slotId ? SLOT_ORDER.get(right.slotId) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return left.id.localeCompare(right.id);
}

function getDisplayName(signer: AdminESignSignerDisplayRow) {
  return normalizeOptionalText(signer.signerName) ?? (signer.signerType === "PLATFORM" ? "Platform" : "签署人");
}

function getLeastCompleteStatus(rows: readonly AdminESignSignerDisplayRow[]) {
  return rows.reduce((selected, row) =>
    getStatusPriority(row.signerStatus) < getStatusPriority(selected) ? row.signerStatus : selected,
  rows[0]?.signerStatus ?? "PENDING");
}

function getStatusPriority(status: string) {
  return STATUS_PRIORITY.get(status) ?? 2;
}

function getSlotNoun(rows: readonly AdminESignSignerDisplayRow[]) {
  return rows.some((row) =>
    row.signerType === "PLATFORM" || row.providerActionType === "PLATFORM_AUTO_SEAL"
  )
    ? "盖章位"
    : "签署位";
}

function getSlotLabel(slotId: string | null | undefined, slotNoun: string, index: number) {
  if (!slotId) {
    return `${slotNoun} ${index + 1}`;
  }
  if (slotId.includes("BODY")) {
    return "合同正文";
  }
  if (slotId.includes("ATTACHMENT1")) {
    return "附件1";
  }
  return slotId;
}

function normalizeOptionalText(value?: string | null) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
