import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  FieldOperatorAuditEventType,
  FieldOperatorOtpPurpose,
  SmsProviderType,
  SmsSendStatus,
  VehicleHandoverOperatorType
} from "@prisma/client";
import jwt from "jsonwebtoken";
import { describe, expect, it, vi } from "vitest";

import { FieldOperatorAuthGuard } from "../src/field-operator/field-operator-auth.guard";
import { FieldOperatorAuthController } from "../src/field-operator/field-operator-auth.controller";
import { FieldOperatorAuthService } from "../src/field-operator/field-operator-auth.service";
import { SendSmsCodeInput, SendSmsCodeResult, SmsProvider } from "../src/sms/sms-provider";
import { SmsService } from "../src/sms/sms.service";

const FIELD_SECRET = "field-operator-test-secret";
const ADMIN_SECRET = "admin-jwt-test-secret";

describe("FieldOperatorAuthService", () => {
  it("send-code validates and normalizes China mobile numbers, stores only hashed OTP, and uses SMS abstraction", async () => {
    const { prisma, service, smsProvider } = createFieldAuthFixture({ FIELD_OPERATOR_SMS_ENABLED: "true" });

    const result = await service.requestCode({ phone: "+86 138-0000-0000" }, requestContext());

    expect(result).toMatchObject({ expiresIn: 300, sent: true });
    expect(result.debugCode).toMatch(/^\d{6}$/);
    expect(prisma.otps).toHaveLength(1);
    expect(prisma.otps[0]).toMatchObject({
      phone: "13800000000",
      purpose: FieldOperatorOtpPurpose.FIELD_HANDOVER_LOGIN
    });
    expect(prisma.otps[0]?.codeHash).not.toBe(result.debugCode);
    expect(smsProvider.sendCode).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: "13800000000",
        purpose: "FIELD_HANDOVER_LOGIN"
      })
    );
    expect(prisma.smsLogs[0]).toMatchObject({
      phone: "13800000000",
      phoneMasked: "138****0000",
      provider: SmsProviderType.MOCK,
      sendStatus: SmsSendStatus.SENT
    });
  });

  it("send-code rejects invalid mobile numbers before creating OTP rows", async () => {
    const { prisma, service } = createFieldAuthFixture();

    await expect(service.requestCode({ phone: "12345" }, requestContext())).rejects.toMatchObject({
      status: 400
    });
    expect(prisma.otps).toHaveLength(0);
  });

  it("send-code rate limits duplicate unconsumed requests in the resend window", async () => {
    const { service } = createFieldAuthFixture();

    await service.requestCode({ phone: "13800000000" }, requestContext());

    await expect(service.requestCode({ phone: "13800000000" }, requestContext())).rejects.toMatchObject({
      status: 429
    });
  });

  it("send-code never exposes debugCode in production-like runtime", async () => {
    const { service } = createFieldAuthFixture({
      APP_ENV: "production",
      FIELD_OPERATOR_AUTH_DEBUG_CODE: "true",
      FIELD_OPERATOR_SMS_ENABLED: "true",
      NODE_ENV: "production"
    });

    const result = await service.requestCode({ phone: "13800000000" }, requestContext());

    expect(result.debugCode).toBeUndefined();
  });

  it("login rejects wrong, expired, and reused OTPs while consuming a valid OTP once", async () => {
    const { prisma, service } = createFieldAuthFixture();
    const code = (await service.requestCode({ phone: "13800000000" }, requestContext())).debugCode!;

    await expect(service.login({ code: "000000", phone: "13800000000" }, requestContext())).rejects.toBeInstanceOf(
      UnauthorizedException
    );
    expect(prisma.otps[0]?.failedAttempts).toBe(1);

    prisma.otps[0]!.expiresAt = new Date(Date.now() - 1000);
    await expect(service.login({ code, phone: "13800000000" }, requestContext())).rejects.toBeInstanceOf(
      UnauthorizedException
    );

    const freshCode = (await service.requestCode({ phone: "13900000000" }, requestContext())).debugCode!;
    const login = await service.login({ code: freshCode, phone: "13900000000" }, requestContext());

    expect(login.session.phoneMasked).toBe("139****0000");
    expect(login.token).toBeTruthy();
    expect(prisma.otps[1]?.consumedAt).toBeInstanceOf(Date);
    expect(prisma.sessions).toHaveLength(1);
    expect(JSON.stringify(prisma.sessions[0])).not.toContain(login.token);

    await expect(service.login({ code: freshCode, phone: "13900000000" }, requestContext())).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });

  it("validates, refreshes, and revokes independent field sessions", async () => {
    const { prisma, service } = createFieldAuthFixture();
    const code = (await service.requestCode({ phone: "13800000000" }, requestContext())).debugCode!;
    const login = await service.login({ code, phone: "13800000000" }, requestContext());

    const current = await service.validateToken(login.token);
    expect(current).toMatchObject({
      phone: "13800000000",
      sessionId: prisma.sessions[0]?.id
    });
    expect(prisma.sessions[0]?.lastSeenAt).toBeInstanceOf(Date);

    await service.logout(current.sessionId);
    await expect(service.validateToken(login.token)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("validates persisted legacy session origins as origin-neutral without rewriting storage", async () => {
    const { prisma, service } = createFieldAuthFixture();
    const code = (await service.requestCode({ phone: "13800000000" }, requestContext())).debugCode!;
    const login = await service.login({ code, phone: "13800000000" }, requestContext());
    prisma.sessions[0]!.operatorType = VehicleHandoverOperatorType.EXTERNAL;

    const current = await service.validateToken(login.token);

    expect(current.operatorType).toBeNull();
    expect(prisma.sessions[0]!.operatorType).toBe(VehicleHandoverOperatorType.EXTERNAL);
  });

  it("projects getSession as origin-neutral for a persisted legacy session", async () => {
    const { prisma, service } = createFieldAuthFixture();
    const code = (await service.requestCode({ phone: "13800000000" }, requestContext())).debugCode!;
    await service.login({ code, phone: "13800000000" }, requestContext());
    prisma.sessions[0]!.operatorType = VehicleHandoverOperatorType.EXTERNAL;
    const persisted = prisma.sessions[0]!;

    const session = await service.getSession({
      operatorType: persisted.operatorType,
      phone: persisted.phone,
      sessionId: persisted.id
    });

    expect(session.operatorType).toBeNull();
    expect(persisted.operatorType).toBe(VehicleHandoverOperatorType.EXTERNAL);
  });

  it("rejects admin and portal-shaped tokens as field sessions", async () => {
    const { service } = createFieldAuthFixture();
    const adminToken = jwt.sign({ username: "admin" }, ADMIN_SECRET, { subject: "user-admin" });
    const portalToken = jwt.sign({ customerId: "customer-1", phone: "13800000000", tokenType: "customer" }, FIELD_SECRET, {
      subject: "customer-account-1"
    });

    await expect(service.validateToken(adminToken)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.validateToken(portalToken)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("namespaces the customer secret fallback so Portal tokens are not field sessions", async () => {
    const { service } = createFieldAuthFixture({
      CUSTOMER_JWT_SECRET: "customer-fallback-secret",
      FIELD_OPERATOR_JWT_SECRET: ""
    });
    const code = (await service.requestCode({ phone: "13800000000" }, requestContext())).debugCode!;
    const login = await service.login({ code, phone: "13800000000" }, requestContext());
    const portalToken = jwt.sign(
      { customerId: "customer-1", phone: "13800000000", tokenType: "customer" },
      "customer-fallback-secret",
      { subject: "customer-account-1" }
    );

    await expect(service.validateToken(login.token)).resolves.toMatchObject({ phone: "13800000000" });
    await expect(service.validateToken(portalToken)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("session DTO is origin-neutral and includes assigned task count without exposing the session token", async () => {
    const { handoverService, service } = createFieldAuthFixture();
    handoverService.countFieldAccessibleWorkOrders.mockResolvedValueOnce(2);
    const code = (await service.requestCode({ phone: "13800000000" }, requestContext())).debugCode!;
    const login = await service.login({ code, phone: "13800000000" }, requestContext());

    const session = await service.getSession(await service.validateToken(login.token));

    expect(session).toEqual({
      authenticated: true,
      operatorType: null,
      phoneMasked: "138****0000",
      taskCount: 2
    });
    expect(JSON.stringify(session)).not.toContain(login.token);
  });
});

describe("FieldOperatorAuthGuard", () => {
  it("requires field_access_token and attaches currentFieldOperator", async () => {
    const { service } = createFieldAuthFixture();
    const guard = new FieldOperatorAuthGuard(service);

    await expect(guard.canActivate(contextFor({ cookies: {}, headers: {} }))).rejects.toBeInstanceOf(
      UnauthorizedException
    );

    const code = (await service.requestCode({ phone: "13800000000" }, requestContext())).debugCode!;
    const login = await service.login({ code, phone: "13800000000" }, requestContext());
    const request: Record<string, unknown> = { cookies: { field_access_token: login.token }, headers: {} };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.currentFieldOperator).toMatchObject({
      phone: "13800000000"
    });
  });
});

describe("FieldOperatorAuthController", () => {
  it("sets and clears only the field session cookie", async () => {
    const { service } = createFieldAuthFixture();
    const controller = new FieldOperatorAuthController(service, {} as never);
    const response = {
      clearCookie: vi.fn(),
      cookie: vi.fn()
    };
    const code = (await controller.sendCode({ phone: "13800000000" }, requestFor())).debugCode!;

    await controller.login({ code, phone: "13800000000" }, requestFor(), response as never);

    expect(response.cookie).toHaveBeenCalledWith(
      "field_access_token",
      expect.any(String),
      expect.objectContaining({ httpOnly: true, sameSite: "lax" })
    );
    expect(response.cookie).not.toHaveBeenCalledWith("access_token", expect.anything(), expect.anything());
    expect(response.cookie).not.toHaveBeenCalledWith("customer_access_token", expect.anything(), expect.anything());

    await controller.logout({ sessionId: "session-1", phone: "13800000000" } as never, response as never);
    expect(response.clearCookie).toHaveBeenCalledWith("field_access_token");
  });

  it("delegates field work-order actions with the current field session phone", async () => {
    const { service } = createFieldAuthFixture();
    const handoverService = {
      declareFieldAccessibleNoVisibleDamage: vi.fn(async () => ({ id: "work-order-1" })),
      getFieldAccessibleReadiness: vi.fn(async () => ({ blockingReasons: [], ready: true })),
      startFieldAccessibleWorkOrder: vi.fn(async () => ({ id: "work-order-1" })),
      submitFieldAccessibleEvidence: vi.fn(async () => ({ id: "work-order-1" })),
      updateFieldAccessibleFacts: vi.fn(async () => ({ id: "work-order-1" })),
      uploadAndAttachFieldAccessibleEvidenceFile: vi.fn(async () => ({ id: "evidence-item-1" }))
    };
    const controller = new FieldOperatorAuthController(service, handoverService as never);
    const current = { sessionId: "field-session-1", phone: "13800000000" };

    await controller.startWorkOrder("work-order-1", current as never);
    await controller.updateWorkOrderFacts("work-order-1", { handoverMileageKm: 28600 }, current as never);
    await controller.uploadAndAttachEvidenceFile(
      "work-order-1",
      "evidence-item-1",
      {},
      [uploadFile("front.jpg", "image/jpeg")],
      current as never
    );
    await controller.declareNoVisibleDamage("work-order-1", { remark: "现场确认" }, current as never);
    await controller.getWorkOrderReadiness("work-order-1", current as never);
    await controller.submitEvidence("work-order-1", current as never);

    expect(handoverService.startFieldAccessibleWorkOrder).toHaveBeenCalledWith(
      "work-order-1",
      "13800000000",
      "field-session-1"
    );
    expect(handoverService.updateFieldAccessibleFacts).toHaveBeenCalledWith(
      "work-order-1",
      "13800000000",
      { handoverMileageKm: 28600 },
      "field-session-1"
    );
    expect(handoverService.uploadAndAttachFieldAccessibleEvidenceFile).toHaveBeenCalledWith(
      "work-order-1",
      "13800000000",
      "evidence-item-1",
      expect.any(Array),
      {},
      "field-session-1"
    );
    expect(handoverService.declareFieldAccessibleNoVisibleDamage).toHaveBeenCalledWith(
      "work-order-1",
      "13800000000",
      "现场确认",
      "field-session-1"
    );
    expect(handoverService.getFieldAccessibleReadiness).toHaveBeenCalledWith("work-order-1", "13800000000");
    expect(handoverService.submitFieldAccessibleEvidence).toHaveBeenCalledWith(
      "work-order-1",
      "13800000000",
      "field-session-1"
    );
  });
});

function createFieldAuthFixture(
  overrides: Record<string, string> = {},
  options: { smsProvider?: SmsProvider } = {}
) {
  const config = new FakeConfigService({
    APP_ENV: "test",
    FIELD_OPERATOR_ACCESS_TOKEN_COOKIE: "field_access_token",
    FIELD_OPERATOR_ACCESS_TOKEN_EXPIRES_IN: "12h",
    FIELD_OPERATOR_AUTH_DEBUG_CODE: "true",
    FIELD_OPERATOR_JWT_SECRET: FIELD_SECRET,
    FIELD_OPERATOR_OTP_MAX_ATTEMPTS: "5",
    FIELD_OPERATOR_OTP_RESEND_SECONDS: "60",
    FIELD_OPERATOR_OTP_TTL_SECONDS: "300",
    FIELD_OPERATOR_SMS_ENABLED: "false",
    FIELD_OPERATOR_SMS_PROVIDER: "mock",
    JWT_SECRET: ADMIN_SECRET,
    NODE_ENV: "test",
    PORTAL_SMS_ENABLED: "false",
    PORTAL_SMS_PROVIDER: "mock",
    ...overrides
  });
  const prisma = new FakePrismaService();
  const smsProvider = options.smsProvider ?? createSmsProvider();
  const smsService = new SmsService(config as unknown as ConfigService, prisma as never, smsProvider);
  const handoverService = {
    countFieldAccessibleWorkOrders: vi.fn(async () => 0)
  };
  const service = new FieldOperatorAuthService(
    config as unknown as ConfigService,
    prisma as never,
    smsService,
    handoverService as never
  );
  return { config, handoverService, prisma, service, smsProvider };
}

function requestContext() {
  return {
    ipAddress: "127.0.0.1",
    userAgent: "vitest"
  };
}

function requestFor() {
  return {
    headers: { "user-agent": "vitest" },
    ip: "127.0.0.1"
  } as never;
}

function uploadFile(originalname: string, mimetype: string) {
  return {
    buffer: Buffer.from("image"),
    mimetype,
    originalname,
    size: 5
  };
}

function contextFor(request: Record<string, unknown>) {
  return {
    switchToHttp: () => ({
      getRequest: () => request
    })
  } as unknown as ExecutionContext;
}

class FakeConfigService {
  constructor(private readonly values: Record<string, string>) {}

  get<T = string>(key: string): T | undefined {
    return this.values[key] as T | undefined;
  }
}

class FakePrismaService {
  readonly auditLogs: FakeAuditLog[] = [];
  readonly otps: FakeOtp[] = [];
  readonly sessions: FakeSession[] = [];
  readonly smsLogs: FakeSmsSendLog[] = [];

  readonly fieldOperatorOtp = {
    create: vi.fn(async ({ data }: { data: Partial<FakeOtp> }) => {
      const otp: FakeOtp = {
        codeHash: data.codeHash!,
        consumedAt: data.consumedAt ?? null,
        createdAt: data.createdAt ?? new Date(),
        expiresAt: data.expiresAt!,
        failedAttempts: data.failedAttempts ?? 0,
        id: data.id ?? `otp-${this.otps.length + 1}`,
        ipHash: data.ipHash ?? null,
        lastSentAt: data.lastSentAt ?? null,
        metadata: data.metadata ?? null,
        phone: data.phone!,
        purpose: data.purpose!,
        updatedAt: data.updatedAt ?? new Date(),
        userAgentHash: data.userAgentHash ?? null
      };
      this.otps.push(otp);
      return otp;
    }),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      this.otps
        .filter((otp) => matchesOtpWhere(otp, where))
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null
    ),
    update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
      const otp = this.otps.find((item) => item.id === where.id);
      if (!otp) {
        throw new Error("OTP not found");
      }
      applyUpdate(otp, data);
      return otp;
    }),
    updateMany: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: Record<string, unknown> }) => {
      const records = this.otps.filter((otp) => matchesOtpWhere(otp, where));
      for (const otp of records) {
        applyUpdate(otp, data);
      }
      return { count: records.length };
    })
  };

  readonly fieldOperatorSession = {
    create: vi.fn(async ({ data }: { data: Partial<FakeSession> }) => {
      const session: FakeSession = {
        createdAt: data.createdAt ?? new Date(),
        expiresAt: data.expiresAt!,
        id: data.id ?? `session-${this.sessions.length + 1}`,
        ipHash: data.ipHash ?? null,
        lastSeenAt: data.lastSeenAt ?? null,
        metadata: data.metadata ?? null,
        operatorType:
          data.operatorType === undefined ? VehicleHandoverOperatorType.EXTERNAL : data.operatorType,
        phone: data.phone!,
        revokedAt: data.revokedAt ?? null,
        sessionTokenHash: data.sessionTokenHash!,
        updatedAt: data.updatedAt ?? new Date(),
        userAgentHash: data.userAgentHash ?? null,
        wechatOpenId: data.wechatOpenId ?? null,
        wechatUnionId: data.wechatUnionId ?? null
      };
      this.sessions.push(session);
      return session;
    }),
    findUnique: vi.fn(async ({ where }: { where: { id?: string; sessionTokenHash?: string } }) =>
      this.sessions.find((session) =>
        where.sessionTokenHash ? session.sessionTokenHash === where.sessionTokenHash : session.id === where.id
      ) ?? null
    ),
    update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
      const session = this.sessions.find((item) => item.id === where.id);
      if (!session) {
        throw new Error("Session not found");
      }
      applyUpdate(session, data);
      return session;
    })
  };

  readonly fieldOperatorAuditLog = {
    create: vi.fn(async ({ data }: { data: Partial<FakeAuditLog> }) => {
      const log: FakeAuditLog = {
        createdAt: data.createdAt ?? new Date(),
        eventType: data.eventType!,
        id: data.id ?? `field-audit-${this.auditLogs.length + 1}`,
        ipHash: data.ipHash ?? null,
        metadata: data.metadata ?? null,
        phone: data.phone ?? null,
        sessionId: data.sessionId ?? null,
        userAgentHash: data.userAgentHash ?? null,
        workOrderId: data.workOrderId ?? null
      };
      this.auditLogs.push(log);
      return log;
    })
  };

  readonly smsSendLog = {
    create: vi.fn(async ({ data }: { data: Partial<FakeSmsSendLog> }) => {
      const log: FakeSmsSendLog = {
        createdAt: data.createdAt ?? new Date(),
        errorCode: data.errorCode,
        errorMessage: data.errorMessage,
        id: data.id ?? `sms-log-${this.smsLogs.length + 1}`,
        phone: data.phone!,
        phoneMasked: data.phoneMasked,
        provider: data.provider!,
        providerMessageId: data.providerMessageId,
        providerRequestId: data.providerRequestId,
        providerResponse: data.providerResponse,
        purpose: data.purpose!,
        sendStatus: data.sendStatus!,
        verificationCodeId: data.verificationCodeId
      };
      this.smsLogs.push(log);
      return log;
    })
  };

  async $transaction<T>(callback: (tx: FakePrismaService) => Promise<T>) {
    return callback(this);
  }
}

interface FakeOtp {
  codeHash: string;
  consumedAt: Date | null;
  createdAt: Date;
  expiresAt: Date;
  failedAttempts: number;
  id: string;
  ipHash: string | null;
  lastSentAt: Date | null;
  metadata: unknown;
  phone: string;
  purpose: FieldOperatorOtpPurpose;
  updatedAt: Date;
  userAgentHash: string | null;
}

interface FakeSession {
  createdAt: Date;
  expiresAt: Date;
  id: string;
  ipHash: string | null;
  lastSeenAt: Date | null;
  metadata: unknown;
  operatorType: VehicleHandoverOperatorType | null;
  phone: string;
  revokedAt: Date | null;
  sessionTokenHash: string;
  updatedAt: Date;
  userAgentHash: string | null;
  wechatOpenId: string | null;
  wechatUnionId: string | null;
}

interface FakeAuditLog {
  createdAt: Date;
  eventType: FieldOperatorAuditEventType;
  id: string;
  ipHash: string | null;
  metadata: unknown;
  phone: string | null;
  sessionId: string | null;
  userAgentHash: string | null;
  workOrderId: string | null;
}

interface FakeSmsSendLog {
  createdAt: Date;
  errorCode?: string | null;
  errorMessage?: string | null;
  id: string;
  phone: string;
  phoneMasked?: string | null;
  provider: SmsProviderType;
  providerMessageId?: string | null;
  providerRequestId?: string | null;
  providerResponse?: unknown;
  purpose: string;
  sendStatus: SmsSendStatus;
  verificationCodeId?: string | null;
}

function matchesOtpWhere(otp: FakeOtp, where: Record<string, unknown>) {
  if (where.id !== undefined && otp.id !== where.id) {
    return false;
  }
  if (where.phone !== undefined && otp.phone !== where.phone) {
    return false;
  }
  if (where.purpose !== undefined && otp.purpose !== where.purpose) {
    return false;
  }
  if ("consumedAt" in where && otp.consumedAt !== where.consumedAt) {
    return false;
  }
  const createdAt = where.createdAt as { gte?: Date } | undefined;
  if (createdAt?.gte && otp.createdAt.getTime() < createdAt.gte.getTime()) {
    return false;
  }
  return true;
}

function applyUpdate<T extends object>(target: T, data: Record<string, unknown>) {
  const record = target as Record<string, unknown>;
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "object" && value !== null && "increment" in value) {
      record[key] = Number(record[key] ?? 0) + Number((value as { increment: number }).increment);
      continue;
    }
    record[key] = value;
  }
}

function createSmsProvider(result?: SendSmsCodeResult) {
  return {
    sendCode: vi.fn(async (input: SendSmsCodeInput) => {
      const defaultResult: SendSmsCodeResult = {
        provider: "mock",
        providerMessageId: "mock-message-id",
        providerResponse: {
          mock: true,
          phoneMasked: `${input.phone.slice(0, 3)}****${input.phone.slice(-4)}`,
          purpose: input.purpose
        },
        success: true
      };

      return result ?? defaultResult;
    }),
    sendTemplate: vi.fn()
  } satisfies SmsProvider;
}
