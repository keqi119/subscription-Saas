import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromApi = createRequire(resolve(repoRoot, "apps/api/package.json"));
const REMINDER_SLOTS = ["D30", "D14", "D3"];
const CLOSED_CONSIDERATION_STATUSES = new Set([
  "EXPIRY_CONFIRMED",
  "EXTENDED",
  "EXPIRED",
  "CANCELLED"
]);

export function parseSubscriptionRenewalReconciliationMode(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === "--dry-run")) {
    return "dry-run";
  }
  if (args.length === 1 && args[0] === "--apply") return "apply";
  throw new Error("Specify at most one of --dry-run or --apply.");
}

export function buildSubscriptionRenewalReconciliationPlan(records, now = new Date()) {
  const candidates = [];
  const exceptions = [];
  const summary = {
    alreadyExtended: 0,
    eligible: 0,
    exceptions: 0,
    existing: 0,
    expired: 0,
    notDue: 0,
    skipped: 0
  };

  for (const segment of records) {
    if (segment.status !== "ACTIVE" || segment.orderStatus !== "ACTIVE") {
      summary.skipped += 1;
      continue;
    }
    if (hasFutureExtension(segment)) {
      summary.alreadyExtended += 1;
      continue;
    }
    if (!validDate(segment.endDate)) {
      exceptions.push({
        code: "RENEWAL_SEGMENT_END_DATE_INVALID",
        orderId: segment.orderId,
        segmentId: segment.id
      });
      summary.exceptions += 1;
      continue;
    }
    const schedule = renewalSchedule(segment.endDate);
    if (now >= schedule.completionDeadlineAt) {
      summary.expired += 1;
      continue;
    }
    if (now < schedule.considerationStartAt) {
      summary.notDue += 1;
      continue;
    }
    if (
      segment.renewalConsideration &&
      CLOSED_CONSIDERATION_STATUSES.has(segment.renewalConsideration.status)
    ) {
      summary.existing += 1;
      continue;
    }

    const reminders = buildReminderPlan(schedule.reminders, now);
    const considerationId = segment.renewalConsideration?.id ?? null;
    candidates.push({
      consideration: {
        completionDeadlineAt: schedule.completionDeadlineAt,
        considerationNo: reconciliationConsiderationNo(segment.id),
        considerationStartAt: schedule.considerationStartAt,
        orderId: segment.orderId,
        segmentId: segment.id,
        status: "PENDING_DECISION"
      },
      considerationId,
      jobs: [
        ...reminders
          .filter((reminder) => reminder.status === "PENDING")
          .map((reminder) => ({
            availableAt: reminder.scheduledAt,
            idempotencyKey: null,
            jobType: `RENEWAL_REMINDER_${reminder.slot}`,
            slot: reminder.slot
          })),
        {
          availableAt: schedule.completionDeadlineAt,
          idempotencyKey: `renewal-expiry:${segment.id}:${dateKey(segment.endDate)}`,
          jobType: "RENEWAL_EXPIRY_PROCESS",
          slot: null
        },
        {
          availableAt: addDays(schedule.completionDeadlineAt, 1),
          idempotencyKey: `renewal-return-overdue:${segment.orderId}:${dateKey(segment.endDate)}:D1`,
          jobType: "RENEWAL_RETURN_OVERDUE_D1",
          slot: null
        }
      ],
      orderId: segment.orderId,
      reminders,
      segmentId: segment.id
    });
    if (considerationId) summary.existing += 1;
    else summary.eligible += 1;
  }

  return { candidates, exceptions, summary };
}

export async function executeSubscriptionRenewalReconciliation({
  mode,
  now = new Date(),
  prisma,
  records
}) {
  const plan = buildSubscriptionRenewalReconciliationPlan(records, now);
  if (mode !== "apply") return { created: 0, mode, plan, reconciled: 0 };

  let created = 0;
  for (const candidate of plan.candidates) {
    const result = await prisma.$transaction((tx) => applyCandidate(tx, candidate));
    if (result.created) created += 1;
  }
  return { created, mode, plan, reconciled: plan.candidates.length };
}

export function inspectSubscriptionSegmentConsistency(records) {
  const activeCountViolations = [];
  const gaps = [];
  const overlaps = [];
  const scheduledChangeViolations = [];

  for (const order of records) {
    const segments = [...(order.segments ?? [])]
      .filter((segment) => segment.status !== "CANCELLED")
      .sort((left, right) => left.sequenceNo - right.sequenceNo);
    const activeCount = segments.filter((segment) => segment.status === "ACTIVE").length;
    const expectedActiveCount = order.orderStatus === "PENDING_RETURN" ? 0 : 1;
    if (activeCount !== expectedActiveCount) {
      activeCountViolations.push({ activeCount, orderId: order.id });
    }
    for (let index = 1; index < segments.length; index += 1) {
      const left = segments[index - 1];
      const right = segments[index];
      if (right.startDate <= left.endDate) {
        overlaps.push({
          leftSegmentId: left.id,
          orderId: order.id,
          rightSegmentId: right.id
        });
      } else if (right.startDate.getTime() !== addUtcDays(left.endDate, 1).getTime()) {
        gaps.push({
          leftSegmentId: left.id,
          orderId: order.id,
          rightSegmentId: right.id
        });
      }
    }
    for (const change of order.scheduledChanges ?? []) {
      if (change.status !== "SCHEDULED") continue;
      if (change.contractStatus !== "ARCHIVED") {
        scheduledChangeViolations.push({
          changeOrderId: change.id,
          code: "SCHEDULED_CONTRACT_NOT_ARCHIVED",
          orderId: order.id
        });
        continue;
      }
      const targetCount = segments.filter(
        (segment) => segment.id === change.targetSegmentId
      ).length;
      if (targetCount !== 1) {
        scheduledChangeViolations.push({
          changeOrderId: change.id,
          code: "SCHEDULED_EXTENSION_SEGMENT_INVALID",
          orderId: order.id
        });
      }
    }
  }
  return { activeCountViolations, gaps, overlaps, scheduledChangeViolations };
}

export async function loadSubscriptionRenewalReconciliationRecords(prisma) {
  const activeSegments = await prisma.subscriptionContractSegment.findMany({
    include: {
      order: { select: { orderStatus: true } },
      renewalConsideration: { include: { reminders: true } }
    },
    orderBy: [{ orderId: "asc" }, { sequenceNo: "asc" }],
    where: { status: "ACTIVE" }
  });
  const orderIds = [...new Set(activeSegments.map((segment) => segment.orderId))];
  const allSegments = orderIds.length
    ? await prisma.subscriptionContractSegment.findMany({
        orderBy: { sequenceNo: "asc" },
        where: { orderId: { in: orderIds }, status: { not: "CANCELLED" } }
      })
    : [];
  return activeSegments.map((segment) => ({
    ...segment,
    laterSegments: allSegments.filter(
      (candidate) =>
        candidate.orderId === segment.orderId && candidate.sequenceNo > segment.sequenceNo
    ),
    orderStatus: segment.order.orderStatus
  }));
}

export async function loadSubscriptionSegmentConsistencyRecords(prisma) {
  const orders = await prisma.subscriptionOrder.findMany({
    include: {
      contractSegments: true,
      subscriptionChanges: {
        include: {
          contract: { select: { status: true } },
          targetSegment: { select: { id: true } }
        },
        where: { status: "SCHEDULED" }
      }
    },
    where: { orderStatus: { in: ["ACTIVE", "PENDING_RETURN"] } }
  });
  return orders.map((order) => ({
    id: order.id,
    orderStatus: order.orderStatus,
    scheduledChanges: order.subscriptionChanges.map((change) => ({
      contractStatus: change.contract?.status ?? null,
      id: change.id,
      status: change.status,
      targetSegmentId: change.targetSegment?.id ?? null
    })),
    segments: order.contractSegments
  }));
}

async function applyCandidate(tx, candidate) {
  const before = await tx.renewalConsideration.findUnique({
    where: { segmentId: candidate.segmentId }
  });
  const consideration = await tx.renewalConsideration.upsert({
    create: candidate.consideration,
    update: {},
    where: { segmentId: candidate.segmentId }
  });
  for (const desired of candidate.reminders) {
    const reminder = await tx.renewalReminder.upsert({
      create: {
        renewalConsiderationId: consideration.id,
        scheduledAt: desired.scheduledAt,
        slot: desired.slot,
        status: desired.status
      },
      update: {},
      where: {
        renewalConsiderationId_slot: {
          renewalConsiderationId: consideration.id,
          slot: desired.slot
        }
      }
    });
    if (reminder.status === "PENDING") {
      await upsertJob(tx, candidate, consideration.id, {
        availableAt: reminder.scheduledAt,
        idempotencyKey: `renewal-reminder:${consideration.id}:${reminder.slot}`,
        jobType: `RENEWAL_REMINDER_${reminder.slot}`,
        payload: { reminderId: reminder.id, slot: reminder.slot }
      });
    }
  }
  for (const job of candidate.jobs.filter((item) => item.slot === null)) {
    await upsertJob(tx, candidate, consideration.id, job);
  }
  return { created: !before };
}

async function upsertJob(tx, candidate, considerationId, job) {
  return tx.subscriptionAutomationJob.upsert({
    create: {
      availableAt: job.availableAt,
      contractSegmentId: candidate.segmentId,
      idempotencyKey: job.idempotencyKey,
      jobType: job.jobType,
      orderId: candidate.orderId,
      payload: job.payload,
      renewalConsiderationId: considerationId
    },
    update: {},
    where: { idempotencyKey: job.idempotencyKey }
  });
}

function buildReminderPlan(reminders, now) {
  let latestPastIndex = -1;
  REMINDER_SLOTS.forEach((slot, index) => {
    if (reminders[slot] <= now) latestPastIndex = index;
  });
  return REMINDER_SLOTS.map((slot, index) => {
    const original = reminders[slot];
    const skipped = original < now && index < latestPastIndex;
    return {
      scheduledAt: skipped ? original : original < now ? now : original,
      slot,
      status: skipped ? "SKIPPED_LATE_ENROLLMENT" : "PENDING"
    };
  });
}

function hasFutureExtension(segment) {
  return (segment.laterSegments ?? []).some(
    (candidate) => candidate.segmentType === "EXTENSION" && candidate.status !== "CANCELLED"
  );
}

function renewalSchedule(endDate) {
  return {
    completionDeadlineAt: atShanghaiHour(addUtcDays(endDate, 1), 0),
    considerationStartAt: atShanghaiHour(addUtcDays(endDate, -30), 9),
    reminders: {
      D30: atShanghaiHour(addUtcDays(endDate, -30), 9),
      D14: atShanghaiHour(addUtcDays(endDate, -14), 9),
      D3: atShanghaiHour(addUtcDays(endDate, -3), 9)
    }
  };
}

function reconciliationConsiderationNo(segmentId) {
  return `RNC-RECON-${String(segmentId)
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 46)}`;
}

function addUtcDays(value, days) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() + days));
}

function addDays(value, days) {
  return new Date(value.getTime() + days * 86_400_000);
}

function atShanghaiHour(date, hour) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour) - 8 * 3_600_000
  );
}

function dateKey(value) {
  return value.toISOString().slice(0, 10);
}

function validDate(value) {
  return value instanceof Date && Number.isFinite(value.getTime());
}

async function main() {
  const mode = parseSubscriptionRenewalReconciliationMode(process.argv.slice(2));
  const prisma = await createPrismaClient();
  try {
    const now = new Date();
    const records = await loadSubscriptionRenewalReconciliationRecords(prisma);
    const result = await executeSubscriptionRenewalReconciliation({ mode, now, prisma, records });
    const consistencyRecords = await loadSubscriptionSegmentConsistencyRecords(prisma);
    const consistency = inspectSubscriptionSegmentConsistency(consistencyRecords);
    console.log(
      JSON.stringify(
        {
          applied: { created: result.created, reconciled: result.reconciled },
          consistency,
          exceptions: result.plan.exceptions,
          mode,
          summary: result.plan.summary
        },
        null,
        2
      )
    );
    process.exitCode = hasConsistencyFailures(consistency) || result.plan.exceptions.length ? 2 : 0;
  } finally {
    await prisma.$disconnect();
  }
}

function hasConsistencyFailures(consistency) {
  return Object.values(consistency).some((rows) => rows.length > 0);
}

async function createPrismaClient() {
  const [{ PrismaPg }, { PrismaClient }, { config }] = await Promise.all([
    import(pathToFileURL(requireFromApi.resolve("@prisma/adapter-pg")).href),
    import(pathToFileURL(requireFromApi.resolve("@prisma/client")).href),
    import(pathToFileURL(requireFromApi.resolve("dotenv")).href)
  ]);
  config({ path: resolve(repoRoot, ".env"), quiet: true });
  config({ path: resolve(repoRoot, "apps/api/.env"), quiet: true });
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("SUBSCRIPTION_RENEWAL_RECONCILE_DATABASE_URL_REQUIRED");
  const url = new URL(databaseUrl);
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return new PrismaClient({ adapter: new PrismaPg(url.toString()) });
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedUrl === import.meta.url) {
  main().catch((error) => {
    console.error(
      JSON.stringify({
        error: "SUBSCRIPTION_RENEWAL_RECONCILE_FAILED",
        message: error instanceof Error ? error.message : "Unknown error"
      })
    );
    process.exitCode = 1;
  });
}
