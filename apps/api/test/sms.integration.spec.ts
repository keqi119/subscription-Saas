import { ConfigService } from "@nestjs/config";
import { SmsSendStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi
} from "vitest";

import { PrismaService } from "../src/prisma/prisma.service";
import { SmsProvider } from "../src/sms/sms-provider";
import { SmsService } from "../src/sms/sms.service";

const TEST_DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://subscription:subscription@127.0.0.1:5432/subscription_saas?schema=public";

describe("SmsService PostgreSQL acceptance boundary", () => {
  const keys = new Set<string>();
  let firstClient: PrismaService;
  let secondClient: PrismaService;

  beforeAll(async () => {
    firstClient = await connectClient();
    secondClient = await connectClient();
  });

  afterEach(async () => {
    await firstClient.smsSendLog.deleteMany({
      where: {
        idempotencyKey: {
          in: [...keys]
        }
      }
    });
    keys.clear();
  });

  afterAll(async () => {
    await Promise.all([
      firstClient.onModuleDestroy(),
      secondClient.onModuleDestroy()
    ]);
  });

  it("allows only one provider call across two independent clients", async () => {
    const providerEntered = deferred<void>();
    const releaseProvider = deferred<void>();
    const provider = successProvider(async () => {
      providerEntered.resolve();
      await releaseProvider.promise;
    });
    const firstService = smsService(firstClient, provider);
    const secondService = smsService(secondClient, provider);
    const input = businessInput("concurrent");

    const firstSend = firstService.sendStage2CustomerReady(input);
    await providerEntered.promise;
    const concurrent = await secondService.sendStage2CustomerReady(input);
    releaseProvider.resolve();
    const winner = await firstSend;

    expect(concurrent.sendStatus).toBe(SmsSendStatus.SENDING);
    expect(winner.sendStatus).toBe(SmsSendStatus.SENT);
    expect(provider.sendTemplate).toHaveBeenCalledTimes(1);
    await expect(
      secondClient.smsSendLog.findUniqueOrThrow({
        where: { idempotencyKey: input.idempotencyKey }
      })
    ).resolves.toMatchObject({
      sendStatus: SmsSendStatus.SENT
    });
  });

  it("does not call the provider again after acceptance and local finalization failure", async () => {
    const provider = successProvider();
    let failAcceptedFinalization = true;
    const failingClient = {
      smsSendLog: {
        create: firstClient.smsSendLog.create.bind(firstClient.smsSendLog),
        findUnique:
          firstClient.smsSendLog.findUnique.bind(firstClient.smsSendLog),
        updateMany: async (
          args: Parameters<typeof firstClient.smsSendLog.updateMany>[0]
        ) => {
          if (
            failAcceptedFinalization &&
            args.data.sendStatus === SmsSendStatus.SENT
          ) {
            failAcceptedFinalization = false;
            throw new Error("simulated commit interruption");
          }
          return firstClient.smsSendLog.updateMany(args);
        }
      }
    };
    const interruptedService = smsService(failingClient as never, provider);
    const retryService = smsService(secondClient, provider);
    const input = businessInput("accepted-finalization-failure");

    const interrupted =
      await interruptedService.sendStage2CustomerReady(input);
    const retry = await retryService.sendStage2CustomerReady(input);

    expect(interrupted.sendStatus).toBe(SmsSendStatus.UNCERTAIN);
    expect(retry.sendStatus).toBe(SmsSendStatus.UNCERTAIN);
    expect(provider.sendTemplate).toHaveBeenCalledTimes(1);
  });

  function businessInput(label: string) {
    const idempotencyKey = `sms-integration:${label}:${randomUUID()}`;
    keys.add(idempotencyKey);
    return {
      idempotencyKey,
      phone: "13900000000"
    };
  }
});

async function connectClient() {
  const client = new PrismaService(
    new ConfigService({
      DATABASE_POOL_MAX: "2",
      DATABASE_URL: TEST_DATABASE_URL
    })
  );
  await client.onModuleInit();
  return client;
}

function smsService(prisma: PrismaService, provider: SmsProvider) {
  return new SmsService(
    new ConfigService({
      ALIYUN_SMS_CUSTOMER_HANDOVER_ESIGN_READY_TEMPLATE_CODE:
        "SMS_CUSTOMER_READY",
      ALIYUN_SMS_FIELD_HANDOVER_ESIGN_READY_TEMPLATE_CODE:
        "SMS_FIELD_READY",
      FIELD_OPERATOR_SMS_ENABLED: "true",
      FIELD_OPERATOR_SMS_PROVIDER: "mock",
      PORTAL_SMS_ENABLED: "true",
      PORTAL_SMS_PROVIDER: "mock"
    }),
    prisma,
    provider
  );
}

function successProvider(beforeSuccess?: () => Promise<void>): SmsProvider {
  return {
    sendCode: vi.fn(),
    sendTemplate: vi.fn(async () => {
      await beforeSuccess?.();
      return {
        provider: "mock" as const,
        providerMessageId: "provider-accepted-once",
        providerResponse: {
          accepted: true
        },
        success: true
      };
    })
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
