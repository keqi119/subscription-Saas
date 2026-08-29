import { createHash } from "node:crypto";

type JsonRecord = Readonly<Record<string, unknown>>;

export type ReturnManifestPdfFacts = Readonly<{
  attestationMode: string;
  checklistManifestHash: string;
  checklistRevisionId: string;
  checklistRevisionNumber: number | null;
  customerComments: string;
  evidence: readonly Readonly<{
    contentSha256: string;
    evidencePurpose: string;
    evidenceType: string;
    fileId: string;
  }>[];
  items: readonly Readonly<{
    expectedQuantity: number | null;
    itemCode: string;
    remark: string;
    returnedQuantity: number | null;
    state: string;
  }>[];
  returnLocation: string;
  returnScheduledAt: string;
}>;

export type ReturnManifestModelInput = Readonly<{
  attestation: Readonly<{
    mode: "CUSTOMER_SIGNED" | "CUSTOMER_REFUSED" | "CUSTOMER_ABSENT";
    reason?: string;
    witnesses?: readonly string[];
  }>;
  caseNo: string;
  checklist: readonly JsonRecord[];
  customerComments?: string | null;
  damages: readonly (JsonRecord & { evidenceIds?: readonly string[] })[];
  evidence: readonly (JsonRecord & { contentSha256: string; id: string })[];
  location: string;
  mileageKm: number;
  pickupAt: string;
  revision: number;
  vehicle: JsonRecord;
}>;

export function buildReturnManifestModel(input: ReturnManifestModelInput) {
  if (!Number.isSafeInteger(input.mileageKm) || input.mileageKm < 0) {
    throw new Error("INVALID_RETURN_MILEAGE");
  }
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw new Error("INVALID_RETURN_MANIFEST_REVISION");
  }
  if (input.attestation.mode !== "CUSTOMER_SIGNED" && !input.attestation.reason?.trim()) {
    throw new Error("UNILATERAL_ATTESTATION_REASON_REQUIRED");
  }
  const evidenceIndex = [...input.evidence]
    .map((item) => ({ contentSha256: requiredHash(item.contentSha256), id: item.id }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const evidenceManifestHash = hash(canonical(evidenceIndex));
  const body = {
    attestation: {
      mode: input.attestation.mode,
      reason: input.attestation.reason?.trim() ?? null,
      witnesses: [...(input.attestation.witnesses ?? [])].map((value) => value.trim()).filter(Boolean)
    },
    caseNo: input.caseNo,
    checklist: [...input.checklist].sort((left, right) =>
      String(left.itemCode ?? "").localeCompare(String(right.itemCode ?? ""))
    ),
    customerComments: input.customerComments?.trim() || null,
    damages: [...input.damages],
    evidenceIndex,
    evidenceManifestHash,
    location: input.location,
    mileageKm: input.mileageKm,
    pickupAt: new Date(input.pickupAt).toISOString(),
    revision: input.revision,
    vehicle: input.vehicle
  };
  return Object.freeze({ ...body, manifestHash: hash(canonical(body)) });
}

export function extractReturnManifestPdfFacts(
  documentSnapshot: unknown,
  checklistSnapshot: unknown
): ReturnManifestPdfFacts {
  const document = record(documentSnapshot);
  const checklist = record(document.returnChecklistSnapshot ?? checklistSnapshot);
  const attestation = record(checklist.attestation);
  const rawItems = Array.isArray(checklist.items) ? checklist.items : [];
  const rawEvidence = Array.isArray(document.returnEvidence) ? document.returnEvidence : [];
  return Object.freeze({
    attestationMode: text(attestation.mode ?? document.returnChecklistAttestationMode),
    checklistManifestHash: text(document.returnChecklistManifestHash),
    checklistRevisionId: text(document.returnChecklistRevisionId),
    checklistRevisionNumber: integer(
      checklist.revisionNumber ?? document.returnChecklistRevisionNumber
    ),
    customerComments: text(checklist.customerComments),
    evidence: rawEvidence
      .map((value) => record(value))
      .map((value) =>
        Object.freeze({
          contentSha256: text(value.contentSha256),
          evidencePurpose: text(value.evidencePurpose),
          evidenceType: text(value.evidenceType),
          fileId: text(value.fileId)
        })
      )
      .sort((left, right) =>
        `${left.evidencePurpose}:${left.fileId}`.localeCompare(
          `${right.evidencePurpose}:${right.fileId}`
        )
      ),
    items: rawItems
      .map((value) => record(value))
      .map((value) =>
        Object.freeze({
          expectedQuantity: integer(value.expectedQuantity),
          itemCode: text(value.itemCode),
          remark: text(value.remark),
          returnedQuantity: integer(value.returnedQuantity),
          state: text(value.state)
        })
      )
      .sort((left, right) => left.itemCode.localeCompare(right.itemCode)),
    returnLocation: text(document.returnLocation),
    returnScheduledAt: text(document.returnScheduledAt)
  });
}

function requiredHash(value: string) {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("INVALID_EVIDENCE_HASH");
  return value;
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function integer(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}
