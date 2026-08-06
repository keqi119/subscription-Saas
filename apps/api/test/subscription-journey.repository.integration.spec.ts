import { ConfigService } from "@nestjs/config";
import {
  Prisma,
  SubscriptionJourneyEventType,
  SubscriptionJourneyJobStatus,
  SubscriptionJourneyJobType,
  SubscriptionJourneyOutboxStatus,
  SubscriptionJourneyStepCode,
  SubscriptionJourneyStepStatus
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it
} from "vitest";

import { PrismaService } from "../src/prisma/prisma.service";
import { SubscriptionJourneyRepository } from "../src/subscription-journey/subscription-journey.repository";

const TEST_DATABASE_URL = requiredTestDatabaseUrl();
const FIXTURE_PREFIX = `task2_claim_${randomUUID().replaceAll("-", "")}`;
const suffix = FIXTURE_PREFIX.slice("task2_claim_".length);
const fixture = {
  applicationId: randomUUID(),
  customerId: randomUUID(),
  journeyId: `${FIXTURE_PREFIX}_journey`,
  stepId: `${FIXTURE_PREFIX}_step`,
  userId: randomUUID()
};

describe("SubscriptionJourneyRepository PostgreSQL leases", () => {
  let prisma: PrismaService;
  let repository: SubscriptionJourneyRepository;

  beforeAll(async () => {
    prisma = new PrismaService(
      new ConfigService({
        DATABASE_POOL_MAX: "10",
        DATABASE_URL: TEST_DATABASE_URL
      })
    );
    await prisma.onModuleInit();
    repository = new SubscriptionJourneyRepository();
    await createFixture(prisma);
  });

  afterEach(async () => {
    await resetFixture(prisma);
  });

  afterAll(async () => {
    try {
      await deleteFixture(prisma);
      await expectFixtureCleanup(prisma);
    } finally {
      await prisma.onModuleDestroy();
    }
  });

  it("gives two concurrent workers non-overlapping claims within each limit", async () => {
    const claimable = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        createJob(prisma, `concurrent-due-${index}`, {
          availableAt: new Date(`1900-01-0${index + 1}T00:00:00.000Z`)
        })
      )
    );
    await createJob(prisma, "concurrent-future", {
      availableAt: new Date("2999-01-01T00:00:00.000Z")
    });
    await createJob(prisma, "concurrent-live", {
      availableAt: new Date("1800-01-01T00:00:00.000Z"),
      leaseExpiresAt: new Date("2999-01-01T00:00:00.000Z"),
      leaseToken: `${FIXTURE_PREFIX}_live`,
      status: SubscriptionJourneyJobStatus.PROCESSING
    });
    await createJob(prisma, "concurrent-completed", {
      availableAt: new Date("1700-01-01T00:00:00.000Z"),
      status: SubscriptionJourneyJobStatus.COMPLETED
    });

    const claims = await Promise.all([
      prisma.$transaction((tx) => repository.claimJobs(tx, 2, 120_000)),
      prisma.$transaction((tx) => repository.claimJobs(tx, 2, 120_000))
    ]);
    const firstIds = claims[0].map(({ id }) => id);
    const secondIds = claims[1].map(({ id }) => id);
    const claimedIds = [...firstIds, ...secondIds];
    const claimableIds = new Set(claimable.map(({ id }) => id));

    expect(firstIds).toHaveLength(2);
    expect(secondIds).toHaveLength(2);
    expect(new Set(claimedIds).size).toBe(4);
    expect(claimedIds.every((id) => claimableIds.has(id))).toBe(true);
  });

  it("reclaims a processing job after its lease expires", async () => {
    const oldLeaseToken = `${FIXTURE_PREFIX}_expired`;
    const job = await createJob(prisma, "expired-reclaim", {
      availableAt: new Date("1800-01-01T00:00:00.000Z"),
      leaseExpiresAt: new Date(),
      leaseToken: oldLeaseToken,
      status: SubscriptionJourneyJobStatus.PROCESSING
    });
    await prisma.$executeRaw`
      UPDATE "subscription_journey_job"
      SET "lease_expires_at" = clock_timestamp() - interval '1 second'
      WHERE "id" = ${job.id}
    `;

    const [claimed] = await prisma.$transaction((tx) =>
      repository.claimJobs(tx, 1, 120_000)
    );
    const [databaseClock] = await prisma.$queryRaw<Array<{ now: Date }>>`
      SELECT clock_timestamp() AS "now"
    `;

    expect(claimed).toMatchObject({
      id: job.id,
      status: SubscriptionJourneyJobStatus.PROCESSING
    });
    expect(claimed?.leaseToken).not.toBe(oldLeaseToken);
    expect(claimed?.leaseExpiresAt.getTime()).toBeGreaterThan(
      databaseClock!.now.getTime()
    );
  });

  it.each(["complete", "reschedule", "dead-letter"] as const)(
    "rejects an expired old lease token when attempting to %s",
    async (operation) => {
      const leaseToken = `${FIXTURE_PREFIX}_${operation}`;
      const job = await createJob(prisma, `expired-${operation}`, {
        availableAt: new Date("1800-01-01T00:00:00.000Z"),
        leaseExpiresAt: new Date(),
        leaseToken,
        status: SubscriptionJourneyJobStatus.PROCESSING
      });
      await prisma.$executeRaw`
        UPDATE "subscription_journey_job"
        SET "lease_expires_at" = clock_timestamp() - interval '1 second'
        WHERE "id" = ${job.id}
      `;

      const attempted = prisma.$transaction(async (tx) => {
        if (operation === "complete") {
          return repository.completeJob(tx, job.id, leaseToken, { ok: true });
        }
        if (operation === "reschedule") {
          return repository.rescheduleJob(tx, job.id, leaseToken, {
            delayMs: 1_000,
            error: {
              code: "PROVIDER_TIMEOUT",
              message: "Provider timed out.",
              retryable: true
            }
          });
        }
        return repository.deadLetterJob(tx, {
          error: {
            code: "PROVIDER_REJECTED",
            message: "Provider rejected the request.",
            retryable: false
          },
          jobId: job.id,
          journeyId: fixture.journeyId,
          leaseToken,
          stepId: fixture.stepId
        });
      });

      await expect(attempted).rejects.toMatchObject({
        code: "JOURNEY_LEASE_LOST"
      });
      await expect(
        prisma.subscriptionJourneyJob.findUniqueOrThrow({
          where: { id: job.id }
        })
      ).resolves.toMatchObject({
        leaseToken,
        status: SubscriptionJourneyJobStatus.PROCESSING
      });
      await expect(
        prisma.subscriptionJourneyException.count({
          where: { jobId: job.id }
        })
      ).resolves.toBe(0);
    }
  );

  it("commits concurrent retries of the same domain signal exactly once", async () => {
    const eventKey = `${FIXTURE_PREFIX}:signal:application-submitted`;
    const signal = {
      applicationId: fixture.applicationId,
      eventKey,
      payload: { source: "application-submit" },
      type: "APPLICATION_SUBMITTED" as const
    };

    await expect(
      Promise.all([
        prisma.$transaction((tx) => repository.recordSignal(tx, signal)),
        prisma.$transaction((tx) => repository.recordSignal(tx, signal))
      ])
    ).resolves.toEqual([undefined, undefined]);

    const [eventCount, outboxCount, journey] = await Promise.all([
      prisma.subscriptionJourneyEvent.count({ where: { eventKey } }),
      prisma.subscriptionJourneyOutbox.count({
        where: { eventKey: `${eventKey}:outbox` }
      }),
      prisma.subscriptionJourney.findUniqueOrThrow({
        where: { id: fixture.journeyId }
      })
    ]);
    expect(eventCount).toBe(1);
    expect(outboxCount).toBe(1);
    expect(journey.version).toBe(1);
  });

  it("reclaims stale signal outbox separately from notification outbox", async () => {
    const signal = await createOutbox(prisma, "signal-stale", {
      aggregateType: "SUBSCRIPTION_JOURNEY",
      eventType: SubscriptionJourneyEventType.DOMAIN_FACT_OBSERVED,
      leaseExpiresAt: new Date(),
      leaseToken: `${FIXTURE_PREFIX}:stale-signal-lease`,
      status: SubscriptionJourneyOutboxStatus.PROCESSING
    });
    const notification = await createOutbox(prisma, "notification-due", {
      aggregateType: "JOURNEY_NOTIFICATION",
      eventType: SubscriptionJourneyEventType.STEP_COMPLETED
    });
    await prisma.$executeRaw`
      UPDATE "subscription_journey_outbox"
      SET "lease_expires_at" = clock_timestamp() - interval '1 second'
      WHERE "id" = ${signal.id}
    `;
    const persistedRows = await prisma.subscriptionJourneyOutbox.findMany({
      orderBy: { id: "asc" },
      select: {
        aggregateType: true,
        availableAt: true,
        id: true,
        status: true
      },
      where: { id: { in: [signal.id, notification.id] } }
    });
    expect(persistedRows).toHaveLength(2);
    expect(
      persistedRows.find(({ id }) => id === notification.id)
    ).toMatchObject({
      aggregateType: "JOURNEY_NOTIFICATION",
      status: SubscriptionJourneyOutboxStatus.PENDING
    });

    const [signals, notifications] = await Promise.all([
      prisma.$transaction((tx) =>
        repository.claimSignalOutbox(tx, 10, 120_000)
      ),
      prisma.$transaction((tx) =>
        repository.claimNotificationOutbox(tx, 10, 120_000)
      )
    ]);

    expect(signals.map(({ id }) => id)).toEqual([signal.id]);
    expect(notifications.map(({ id }) => id)).toEqual([notification.id]);
    expect(signals[0]?.leaseToken).not.toBe(
      `${FIXTURE_PREFIX}:stale-signal-lease`
    );
  });
});

async function createFixture(prisma: PrismaService) {
  assertFixturePrefix();
  await prisma.user.create({
    data: {
      id: fixture.userId,
      name: "Task 2 Claim Test",
      passwordHash: "test-only-not-a-credential",
      username: `t2_claim_${suffix}`
    }
  });
  await prisma.customer.create({
    data: {
      customerNo: `T2C-${suffix}`,
      id: fixture.customerId,
      mobile: "13800000000",
      name: "Task 2 Claim Test"
    }
  });
  await prisma.application.create({
    data: {
      applicationNo: `T2A-${suffix}`,
      customerId: fixture.customerId,
      id: fixture.applicationId,
      salesUserId: fixture.userId
    }
  });
  await prisma.subscriptionJourney.create({
    data: {
      applicationId: fixture.applicationId,
      currentStepCode: SubscriptionJourneyStepCode.APPLICATION_VALIDATION,
      currentStepStatus: SubscriptionJourneyStepStatus.RUNNING,
      id: fixture.journeyId
    }
  });
  await prisma.subscriptionJourneyStep.create({
    data: {
      code: SubscriptionJourneyStepCode.APPLICATION_VALIDATION,
      id: fixture.stepId,
      journeyId: fixture.journeyId,
      status: SubscriptionJourneyStepStatus.RUNNING
    }
  });
}

function createJob(
  prisma: PrismaService,
  label: string,
  overrides: Partial<{
    availableAt: Date;
    leaseExpiresAt: Date | null;
    leaseToken: string | null;
    status: SubscriptionJourneyJobStatus;
  }> = {}
) {
  return prisma.subscriptionJourneyJob.create({
    data: {
      availableAt: new Date("1900-01-01T00:00:00.000Z"),
      jobType: SubscriptionJourneyJobType.VALIDATE_APPLICATION,
      journeyId: fixture.journeyId,
      payload: { fixture: FIXTURE_PREFIX } satisfies Prisma.InputJsonValue,
      sourceKey: `${FIXTURE_PREFIX}:${label}`,
      status: SubscriptionJourneyJobStatus.PENDING,
      stepId: fixture.stepId,
      ...overrides
    }
  });
}

function createOutbox(
  prisma: PrismaService,
  label: string,
  overrides: Partial<{
    aggregateType: string;
    eventType: SubscriptionJourneyEventType;
    leaseExpiresAt: Date | null;
    leaseToken: string | null;
    status: SubscriptionJourneyOutboxStatus;
  }> = {}
) {
  return prisma.subscriptionJourneyOutbox.create({
    data: {
      aggregateId: fixture.journeyId,
      aggregateType: "SUBSCRIPTION_JOURNEY",
      availableAt: new Date("1900-01-01T00:00:00.000Z"),
      eventKey: `${FIXTURE_PREFIX}:${label}`,
      eventType: SubscriptionJourneyEventType.DOMAIN_FACT_OBSERVED,
      journeyId: fixture.journeyId,
      payload: { fixture: FIXTURE_PREFIX },
      ...overrides
    }
  });
}

async function deleteTestJobs(prisma: PrismaService) {
  assertFixturePrefix();
  await prisma.subscriptionJourneyException.deleteMany({
    where: { journeyId: fixture.journeyId }
  });
  await prisma.subscriptionJourneyJob.deleteMany({
    where: { sourceKey: { startsWith: `${FIXTURE_PREFIX}:` } }
  });
}

async function resetFixture(prisma: PrismaService) {
  assertFixturePrefix();
  await deleteTestJobs(prisma);
  await prisma.subscriptionJourneyOutbox.deleteMany({
    where: {
      eventKey: { startsWith: `${FIXTURE_PREFIX}:` },
      journeyId: fixture.journeyId
    }
  });
  await prisma.subscriptionJourneyEvent.deleteMany({
    where: {
      eventKey: { startsWith: `${FIXTURE_PREFIX}:` },
      journeyId: fixture.journeyId
    }
  });
  await prisma.subscriptionJourney.update({
    data: { version: 0 },
    where: { id: fixture.journeyId }
  });
}

async function deleteFixture(prisma: PrismaService) {
  assertFixturePrefix();
  await deleteTestJobs(prisma);
  await prisma.subscriptionJourneyOutbox.deleteMany({
    where: { journeyId: fixture.journeyId }
  });
  await prisma.subscriptionJourneyEvent.deleteMany({
    where: { journeyId: fixture.journeyId }
  });
  await prisma.subscriptionJourneyManualTask.deleteMany({
    where: { journeyId: fixture.journeyId }
  });
  await prisma.subscriptionJourneyStep.deleteMany({
    where: { journeyId: fixture.journeyId }
  });
  await prisma.subscriptionJourney.deleteMany({
    where: { id: fixture.journeyId }
  });
  await prisma.application.deleteMany({
    where: { id: fixture.applicationId }
  });
  await prisma.customer.deleteMany({
    where: { id: fixture.customerId }
  });
  await prisma.user.deleteMany({
    where: { id: fixture.userId }
  });
}

async function expectFixtureCleanup(prisma: PrismaService) {
  const counts = await Promise.all([
    prisma.subscriptionJourneyJob.count({
      where: { sourceKey: { startsWith: `${FIXTURE_PREFIX}:` } }
    }),
    prisma.subscriptionJourney.count({ where: { id: fixture.journeyId } }),
    prisma.application.count({ where: { id: fixture.applicationId } }),
    prisma.customer.count({ where: { id: fixture.customerId } }),
    prisma.user.count({ where: { id: fixture.userId } })
  ]);
  expect(counts).toEqual([0, 0, 0, 0, 0]);
}

function assertFixturePrefix() {
  if (!/^task2_claim_[a-f0-9]{32}$/.test(FIXTURE_PREFIX)) {
    throw new Error("Refusing to mutate an unexpected journey test fixture.");
  }
}

function requiredTestDatabaseUrl(value = process.env.DATABASE_URL) {
  if (!value) {
    throw new Error("DATABASE_URL is required for journey repository integration tests");
  }
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("Journey repository integration tests require PostgreSQL");
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error("Journey repository integration tests require a loopback host");
  }
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*_(test|codex)$/.test(databaseName)) {
    throw new Error("Journey repository integration tests require a test-only database");
  }
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.toString();
}

function isLoopbackHostname(hostname: string) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => {
      if (!/^\d{1,3}$/.test(octet)) return false;
      const value = Number(octet);
      return value >= 0 && value <= 255;
    })
  );
}
