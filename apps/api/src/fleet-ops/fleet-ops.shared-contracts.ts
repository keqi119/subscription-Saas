export type FleetOpsEvidenceSource =
  | "AUDIT_LOG"
  | "COLLECTION_CASE"
  | "CONDITION_REPORT"
  | "FINANCE"
  | "LEASE"
  | "ORDER"
  | "PAYMENT"
  | "SERVICE_CASE"
  | "SYSTEM"
  | "VEHICLE";

export interface FleetOpsEntityRef {
  entityId: string;
  entityType: string;
}

export interface FleetOpsEvidence {
  observedAt?: Date | string;
  ref?: FleetOpsEntityRef;
  source: FleetOpsEvidenceSource | string;
  summary: string;
}

export type FleetOpsConfidenceBand = "HIGH" | "LOW" | "MEDIUM" | "UNKNOWN";

export interface FleetOpsConfidence {
  band: FleetOpsConfidenceBand;
  reasons: string[];
  score: number;
}

export type FleetOpsConflictSeverity = "CRITICAL" | "HIGH" | "LOW" | "MEDIUM";

export interface FleetOpsConflict {
  evidence: FleetOpsEvidence[];
  reason: string;
  severity: FleetOpsConflictSeverity;
}

export interface FleetOpsWarning {
  code: string;
  evidence?: FleetOpsEvidence[];
  message: string;
}

export interface FleetOpsDateRange {
  from: Date;
  to: Date;
}

export type FleetOpsEngineHealthStatus = "OK" | "WARN" | "ERROR";

export interface FleetOpsEngineHealth {
  checkedAt: Date;
  engineName: string;
  status: FleetOpsEngineHealthStatus;
  warnings: FleetOpsWarning[];
}

export interface FleetOpsReadOnlyResult<T> {
  asOf: Date;
  confidence?: FleetOpsConfidence;
  conflicts: FleetOpsConflict[];
  data: T;
  evidence: FleetOpsEvidence[];
  warnings: FleetOpsWarning[];
}

export type FleetOpsSharedInvariantStatus = "FAIL" | "PASS";

export interface FleetOpsSharedInvariantResult {
  id: string;
  reason: string;
  status: FleetOpsSharedInvariantStatus;
}

export interface FleetOpsForbiddenWritePattern {
  expression: RegExp;
  label: string;
}

export type FleetOpsStaticScanClassification = "safe" | "unsafe";

export interface FleetOpsStaticScanHitInput {
  context: string;
  file: string;
  line: number;
  pattern: FleetOpsForbiddenWritePattern;
}

export interface FleetOpsStaticScanFinding extends FleetOpsStaticScanHitInput {
  classification: FleetOpsStaticScanClassification;
  reason: string;
}

export const FLEET_OPS_FORBIDDEN_WRITE_PATTERNS: FleetOpsForbiddenWritePattern[] = [
  { expression: /\.create\s*\(/, label: "prisma-create-call" },
  { expression: /\.update\s*\(/, label: "prisma-update-call" },
  { expression: /\.delete\s*\(/, label: "prisma-delete-call" },
  { expression: /\.upsert\s*\(/, label: "prisma-upsert-call" },
  { expression: /\.createMany\s*\(/, label: "prisma-create-many-call" },
  { expression: /\.updateMany\s*\(/, label: "prisma-update-many-call" },
  { expression: /\.deleteMany\s*\(/, label: "prisma-delete-many-call" },
  { expression: new RegExp("\\$" + "executeRaw\\s*\\("), label: "raw-execute-call" },
  { expression: new RegExp("\\$" + "queryRawUnsafe\\s*\\("), label: "unsafe-raw-query-call" },
  { expression: new RegExp("\\$" + "transaction\\s*\\("), label: "transaction-call" },
  { expression: /\bsave\s*\(/, label: "save-call" },
  { expression: /\bpersist\s*\(/, label: "persist-call" },
  { expression: /\bmutate\s*\(/, label: "mutate-call" },
  { expression: /\bsetStatus\s*\(/, label: "set-status-call" },
  { expression: /\bupdateStatus\s*\(/, label: "update-status-call" },
  { expression: /auditSink(?:\?\.|\.)\s*write\s*\(/, label: "audit-sink-write" },
  { expression: /\bauditLog\b/, label: "audit-log-reference" },
  { expression: /\bwriteAudit\b/, label: "write-audit-reference" }
];

export function classifyFleetOpsStaticScanHit(input: FleetOpsStaticScanHitInput): FleetOpsStaticScanFinding {
  const normalizedFile = input.file.replaceAll("\\", "/");
  const context = input.context.trim();

  if (isDocumentationLine(context)) {
    return safe(input, "Comment or documentation string only.");
  }

  if (input.pattern.label === "audit-sink-write" && normalizedFile.endsWith("src/fleet-ops/execution/execution-log.service.ts")) {
    return safe(input, "Allowed explicit PR-5 execution log audit sink path.");
  }

  if (isTypeOnlyLine(context)) {
    return safe(input, "Type-only declaration without runtime write execution.");
  }

  return {
    ...input,
    classification: "unsafe",
    reason: "Potential Fleet Ops write or business mutation path."
  };
}

function safe(input: FleetOpsStaticScanHitInput, reason: string): FleetOpsStaticScanFinding {
  return {
    ...input,
    classification: "safe",
    reason
  };
}

function isDocumentationLine(context: string) {
  return (
    context.startsWith("//") ||
    context.startsWith("*") ||
    context.startsWith("#") ||
    context.startsWith("- ") ||
    context.startsWith("```")
  );
}

function isTypeOnlyLine(context: string) {
  return /^(export\s+)?(interface|type)\s+/.test(context);
}
