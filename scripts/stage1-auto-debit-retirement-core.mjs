export const RETIRED_AUTO_DEBIT_JOB_TYPES = Object.freeze([
  "SUBMIT_BILL_DEBIT",
  "QUERY_DEBIT_ATTEMPT",
  "SEND_DEBIT_FAILURE_NOTICE",
  "SYNC_PAYMENT_MANDATE"
]);

const RETIRED_AUTO_DEBIT_JOB_TYPE_SET = new Set(RETIRED_AUTO_DEBIT_JOB_TYPES);

export function parseMode(args) {
  const dryRun = args.includes("--dry-run");
  const apply = args.includes("--apply");
  if (dryRun && apply) {
    throw new Error("STAGE1_AUTO_DEBIT_RETIREMENT_MODE_CONFLICT");
  }
  if (!dryRun && !apply) {
    throw new Error("STAGE1_AUTO_DEBIT_RETIREMENT_MODE_REQUIRED");
  }
  return apply ? "apply" : "dry-run";
}

export function buildRetirementPlan(rows, now) {
  const retiredRows = rows.filter((row) => RETIRED_AUTO_DEBIT_JOB_TYPE_SET.has(row.jobType));
  const cancellableIds = [];
  const blockedProcessingIds = [];
  let historicalCount = 0;
  const byJobType = {};

  for (const row of retiredRows) {
    byJobType[row.jobType] = (byJobType[row.jobType] ?? 0) + 1;
    if (row.jobStatus === "PENDING") {
      cancellableIds.push(row.id);
      continue;
    }
    if (row.jobStatus === "PROCESSING") {
      if (row.leaseExpiresAt && row.leaseExpiresAt.getTime() <= now.getTime()) {
        cancellableIds.push(row.id);
      } else {
        blockedProcessingIds.push(row.id);
      }
      continue;
    }
    historicalCount += 1;
  }

  return {
    blockedProcessingIds,
    byJobType,
    cancellableIds,
    historicalCount,
    scannedCount: retiredRows.length
  };
}
