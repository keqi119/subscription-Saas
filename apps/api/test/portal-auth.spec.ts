import { BadRequestException, ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  CustomerAccountStatus,
  CustomerStatus,
  CustomerVerificationCodePurpose,
  SmsProviderType,
  SmsSendStatus
} from "@prisma/client";
import jwt from "jsonwebtoken";
import { describe, expect, it, vi } from "vitest";

import { CustomerAuthGuard } from "../src/portal/portal-auth.guard";
import { PortalAuthController } from "../src/portal/portal-auth.controller";
import { PortalAuthService } from "../src/portal/portal-auth.service";
import { PORTAL_BETA_GATE_MESSAGE, PORTAL_SMS_SEND_FAILURE_MESSAGE } from "../src/sms/sms.dto";
import { SendSmsCodeInput, SendSmsCodeResult, SmsProvider } from "../src/sms/sms-provider";
import { SmsService } from "../src/sms/sms.service";

const CUSTOMER_SECRET = "customer-test-secret";

describe("PortalAuthService", () => {
  it("request-code creates a login code and returns debugCode outside production", async () => {
    const { prisma, service } = createPortalAuthFixture();

    const result = await service.requestCode({ phone: "13800000000" }, requestContext());

    expect(result.sent).toBe(true);
    expect(result.expiresIn).toBe(300);
    expect(result.debugCode).toMatch(/^\d{6}$/);
    expect(prisma.codes).toHaveLength(1);
    expect(prisma.codes[0]?.codeHash).not.toBe(result.debugCode);
    expect(prisma.smsLogs).toMatchObject([
      {
        provider: SmsProviderType.MOCK,
        sendStatus: SmsSendStatus.SKIPPED
      }
    ]);
  });

  it("request-code rejects duplicate requests within resend window", async () => {
    const { service } = createPortalAuthFixture();

    await service.requestCode({ phone: "13800000000" }, requestContext());

    await expect(service.requestCode({ phone: "13800000000" }, requestContext())).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it("request-code hides debugCode in production by default", async () => {
    const { service } = createPortalAuthFixture({
      NODE_ENV: "production",
      PORTAL_AUTH_DEBUG_CODE: "false",
      PORTAL_SMS_ENABLED: "true"
    });

    const result = await service.requestCode({ phone: "13800000000" }, requestContext());

    expect(result.debugCode).toBeUndefined();
  });

  it("request-code never exposes debugCode in production even when explicitly enabled", async () => {
    const { service } = createPortalAuthFixture({
      APP_ENV: "production",
      NODE_ENV: "production",
      PORTAL_AUTH_DEBUG_CODE: "true",
      PORTAL_SMS_DEBUG_CODE: "true",
      PORTAL_SMS_ENABLED: "true"
    });

    const result = await service.requestCode({ phone: "13800000000" }, requestContext());

    expect(result.debugCode).toBeUndefined();
  });

  it("request-code can expose debugCode in staging even when NODE_ENV uses production runtime mode", async () => {
    const { service } = createPortalAuthFixture({
      APP_ENV: "staging",
      NODE_ENV: "production",
      PORTAL_SMS_DEBUG_CODE: "true",
      PORTAL_SMS_ENABLED: "false"
    });

    const result = await service.requestCode({ phone: "13800000000" }, requestContext());

    expect(result.debugCode).toMatch(/^\d{6}$/);
  });

  it("request-code uses the mock sms provider and records SENT when sms is enabled", async () => {
    const { prisma, service, smsProvider } = createPortalAuthFixture({ PORTAL_SMS_ENABLED: "true" });

    const result = await service.requestCode({ phone: "13800000000" }, requestContext());

    expect(result.sent).toBe(true);
    expect(smsProvider.sendCode).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: "13800000000",
        purpose: CustomerVerificationCodePurpose.LOGIN
      })
    );
    expect(prisma.smsLogs[0]).toMatchObject({
      phone: "13800000000",
      phoneMasked: "138****0000",
      provider: SmsProviderType.MOCK,
      sendStatus: SmsSendStatus.SENT,
      verificationCodeId: prisma.codes[0]?.id
    });
  });

  it("request-code succeeds with an aliyun OK result and records SENT", async () => {
    const { prisma, service } = createPortalAuthFixture(
      { PORTAL_SMS_ENABLED: "true", PORTAL_SMS_PROVIDER: "aliyun" },
      {
        smsProvider: createSmsProvider({
          provider: "aliyun",
          providerMessageId: "aliyun-biz-id",
          providerRequestId: "aliyun-request-id",
          providerResponse: { bizId: "aliyun-biz-id", code: "OK", message: "OK", requestId: "aliyun-request-id" },
          success: true
        })
      }
    );

    await expect(service.requestCode({ phone: "13800000000" }, requestContext())).resolves.toMatchObject({
      sent: true
    });
    expect(prisma.smsLogs[0]).toMatchObject({
      provider: SmsProviderType.ALIYUN,
      providerMessageId: "aliyun-biz-id",
      providerRequestId: "aliyun-request-id",
      sendStatus: SmsSendStatus.SENT
    });
  });

  it("request-code rejects sms failures, records FAILED, and makes the code unusable", async () => {
    const { prisma, service } = createPortalAuthFixture(
      { PORTAL_SMS_ENABLED: "true" },
      {
        smsProvider: createSmsProvider({
          errorCode: "MockFailure",
          errorMessage: "mock failed",
          provider: "mock",
          success: false
        })
      }
    );

    await expect(service.requestCode({ phone: "13800000000" }, requestContext())).rejects.toMatchObject({
      response: { message: PORTAL_SMS_SEND_FAILURE_MESSAGE }
    });

    expect(prisma.codes).toHaveLength(1);
    expect(prisma.codes[0]?.consumedAt).toBeInstanceOf(Date);
    expect(prisma.codes[0]?.deletedAt).toBeInstanceOf(Date);
    expect(prisma.smsLogs[0]).toMatchObject({
      errorCode: "MockFailure",
      provider: SmsProviderType.MOCK,
      sendStatus: SmsSendStatus.FAILED
    });
  });

  it("request-code allows whitelisted phones when beta mode is enabled", async () => {
    const { service } = createPortalAuthFixture({
      PORTAL_BETA_ALLOWED_PHONES: "+8613800000000",
      PORTAL_BETA_MODE: "true"
    });

    await expect(service.requestCode({ phone: "13800000000" }, requestContext())).resolves.toMatchObject({
      sent: true
    });
  });

  it("request-code rejects non-whitelisted phones when beta mode is enabled", async () => {
    const { prisma, service } = createPortalAuthFixture({
      PORTAL_BETA_ALLOWED_PHONES: "13800000000",
      PORTAL_BETA_MODE: "true"
    });

    await expect(service.requestCode({ phone: "13900000000" }, requestContext())).rejects.toMatchObject({
      response: { message: PORTAL_BETA_GATE_MESSAGE }
    });
    expect(prisma.codes).toHaveLength(0);
  });

  it("request-code allows ordinary phones when beta mode is disabled", async () => {
    const { service } = createPortalAuthFixture({
      PORTAL_BETA_ALLOWED_PHONES: "",
      PORTAL_BETA_MODE: "false"
    });

    await expect(service.requestCode({ phone: "13900000000" }, requestContext())).resolves.toMatchObject({
      sent: true
    });
  });

  it("login succeeds with a correct code and creates customer account on first login", async () => {
    const { prisma, service } = createPortalAuthFixture();
    const code = (await service.requestCode({ phone: "13800000000" }, requestContext())).debugCode;

    const result = await service.login({ code: code!, phone: "13800000000" }, requestContext());

    expect(result.customer.phone).toBe("13800000000");
    expect(result.customer.accountStatus).toBe(CustomerAccountStatus.ACTIVE);
    expect(result.token).toBeTruthy();
    expect(prisma.customers).toHaveLength(1);
    expect(prisma.accounts).toHaveLength(1);
  });

  it("login reuses an existing Customer by mobile and does not create a backend User", async () => {
    const { prisma, service } = createPortalAuthFixture();
    prisma.customers.push(createCustomer({ id: "customer-existing", mobile: "13800000000" }));
    const code = (await service.requestCode({ phone: "13800000000" }, requestContext())).debugCode;

    const result = await service.login({ code: code!, phone: "13800000000" }, requestContext());

    expect(result.customer.customerId).toBe("customer-existing");
    expect(prisma.customers).toHaveLength(1);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("login rejects a wrong code and increments attemptCount", async () => {
    const { prisma, service } = createPortalAuthFixture();
    await service.requestCode({ phone: "13800000000" }, requestContext());

    await expect(service.login({ code: "000000", phone: "13800000000" }, requestContext())).rejects.toBeInstanceOf(
      UnauthorizedException
    );

    expect(prisma.codes[0]?.attemptCount).toBe(1);
  });

  it("login rejects a code after max attempts are reached", async () => {
    const { prisma, service } = createPortalAuthFixture();
    const code = (await service.requestCode({ phone: "13800000000" }, requestContext())).debugCode;
    prisma.codes[0]!.attemptCount = 5;

    await expect(service.login({ code: code!, phone: "13800000000" }, requestContext())).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });

  it("login rejects an expired code", async () => {
    const { prisma, service } = createPortalAuthFixture();
    const code = (await service.requestCode({ phone: "13800000000" }, requestContext())).debugCode;
    prisma.codes[0]!.expiresAt = new Date(Date.now() - 1000);

    await expect(service.login({ code: code!, phone: "13800000000" }, requestContext())).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });

  it("login rejects a consumed code when reused", async () => {
    const { service } = createPortalAuthFixture();
    const code = (await service.requestCode({ phone: "13800000000" }, requestContext())).debugCode;

    await service.login({ code: code!, phone: "13800000000" }, requestContext());

    await expect(service.login({ code: code!, phone: "13800000000" }, requestContext())).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });
});

describe("CustomerAuthGuard", () => {
  it("rejects unauthenticated portal requests", async () => {
    const { service } = createPortalAuthFixture();
    const guard = new CustomerAuthGuard(service);

    await expect(guard.canActivate(contextFor({ cookies: {}, headers: {} }))).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });

  it("accepts a customer token and attaches currentCustomer", async () => {
    const { service } = createPortalAuthFixture();
    const code = (await service.requestCode({ phone: "13800000000" }, requestContext())).debugCode;
    const login = await service.login({ code: code!, phone: "13800000000" }, requestContext());
    const request: {
      cookies: { customer_access_token: string };
      currentCustomer?: unknown;
      headers: Record<string, string>;
    } = { cookies: { customer_access_token: login.token }, headers: {} };
    const guard = new CustomerAuthGuard(service);

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.currentCustomer).toMatchObject({
      customerId: login.customer.customerId,
      phone: "13800000000"
    });
  });

  it("rejects an admin-shaped token even when it is signed by the customer secret", async () => {
    const { service } = createPortalAuthFixture();
    const adminToken = jwt.sign({ username: "admin" }, CUSTOMER_SECRET, { subject: "user-admin" });
    const guard = new CustomerAuthGuard(service);

    await expect(
      guard.canActivate(contextFor({ cookies: { customer_access_token: adminToken }, headers: {} }))
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects a disabled customer account", async () => {
    const { prisma, service } = createPortalAuthFixture();
    const customer = createCustomer({ id: "customer-disabled", mobile: "13800000000" });
    prisma.customers.push(customer);
    prisma.accounts.push(
      createAccount({
        accountStatus: CustomerAccountStatus.DISABLED,
        customerId: customer.id,
        id: "account-disabled",
        phone: "13800000000"
      })
    );
    const token = jwt.sign(
      { customerId: customer.id, phone: "13800000000", tokenType: "customer" },
      CUSTOMER_SECRET,
      { subject: "account-disabled" }
    );
    const guard = new CustomerAuthGuard(service);

    await expect(
      guard.canActivate(contextFor({ cookies: { customer_access_token: token }, headers: {} }))
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("PortalAuthController", () => {
  it("logout clears the customer access token cookie", () => {
    const { service } = createPortalAuthFixture();
    const controller = new PortalAuthController(service);
    const response = { clearCookie: vi.fn() };

    expect(controller.logout(response as never)).toEqual({ success: true });
    expect(response.clearCookie).toHaveBeenCalledWith("customer_access_token");
  });
});

function createPortalAuthFixture(
  overrides: Record<string, string> = {},
  options: { smsProvider?: SmsProvider } = {}
) {
  const config = new FakeConfigService({
    CUSTOMER_ACCESS_TOKEN_COOKIE: "customer_access_token",
    CUSTOMER_ACCESS_TOKEN_EXPIRES_IN: "7d",
    CUSTOMER_JWT_SECRET: CUSTOMER_SECRET,
    NODE_ENV: "test",
    PORTAL_AUTH_DEBUG_CODE: "false",
    PORTAL_BETA_ALLOWED_PHONES: "",
    PORTAL_BETA_MODE: "false",
    PORTAL_OTP_MAX_ATTEMPTS: "5",
    PORTAL_OTP_RESEND_SECONDS: "60",
    PORTAL_OTP_TTL_SECONDS: "300",
    PORTAL_SMS_DEBUG_CODE: "false",
    PORTAL_SMS_ENABLED: "false",
    PORTAL_SMS_PROVIDER: "mock",
    ...overrides
  });
  const prisma = new FakePrismaService();
  const smsProvider = options.smsProvider ?? createSmsProvider();
  const smsService = new SmsService(config as unknown as ConfigService, prisma as never, smsProvider);
  const service = new PortalAuthService(config as unknown as ConfigService, prisma as never, smsService);
  return { config, prisma, service, smsProvider };
}

function requestContext() {
  return {
    ipAddress: "127.0.0.1",
    userAgent: "vitest"
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
  readonly accounts: FakeAccount[] = [];
  readonly codes: FakeCode[] = [];
  readonly customers: FakeCustomer[] = [];
  readonly smsLogs: FakeSmsSendLog[] = [];
  readonly user = {
    create: vi.fn()
  };

  readonly customerVerificationCode = {
    create: vi.fn(async ({ data }: { data: Partial<FakeCode> }) => {
      const code: FakeCode = {
        attemptCount: data.attemptCount ?? 0,
        codeHash: data.codeHash!,
        consumedAt: data.consumedAt ?? null,
        createdAt: data.createdAt ?? new Date(),
        deletedAt: data.deletedAt ?? null,
        expiresAt: data.expiresAt!,
        id: data.id ?? `code-${this.codes.length + 1}`,
        phone: data.phone!,
        purpose: data.purpose!,
        requestIp: data.requestIp ?? null,
        updatedAt: data.updatedAt ?? new Date(),
        userAgent: data.userAgent ?? null
      };
      this.codes.push(code);
      return code;
    }),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return this.codes
        .filter((code) => matchesCodeWhere(code, where))
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null;
    }),
    update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
      const code = this.codes.find((item) => item.id === where.id);
      if (!code) {
        throw new Error("Code not found");
      }
      applyUpdate(code, data);
      return code;
    }),
    updateMany: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: Record<string, unknown> }) => {
      const records = this.codes.filter((code) => matchesCodeWhere(code, where));
      for (const code of records) {
        applyUpdate(code, data);
      }
      return { count: records.length };
    })
  };

  readonly customerAccount = {
    create: vi.fn(async ({ data }: { data: Partial<FakeAccount> }) => {
      const account = createAccount({
        accountStatus: data.accountStatus,
        customerId: data.customerId,
        id: data.id,
        lastLoginAt: data.lastLoginAt,
        lastLoginIp: data.lastLoginIp,
        lastUserAgent: data.lastUserAgent,
        phone: data.phone,
        phoneVerifiedAt: data.phoneVerifiedAt
      });
      this.accounts.push(account);
      return this.withCustomer(account);
    }),
    findUnique: vi.fn(async ({ where }: { where: { id?: string; phone?: string } }) => {
      const account = this.accounts.find((item) =>
        where.id ? item.id === where.id : item.phone === where.phone
      );
      return account ? this.withCustomer(account) : null;
    }),
    update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
      const account = this.accounts.find((item) => item.id === where.id);
      if (!account) {
        throw new Error("Account not found");
      }
      applyUpdate(account, data);
      return this.withCustomer(account);
    })
  };

  readonly customer = {
    create: vi.fn(async ({ data }: { data: Partial<FakeCustomer> }) => {
      const customer = createCustomer({
        customerNo: data.customerNo,
        id: data.id,
        mobile: data.mobile,
        name: data.name,
        sourceChannel: data.sourceChannel,
        status: data.status
      });
      this.customers.push(customer);
      return customer;
    }),
    findFirst: vi.fn(async ({ where }: { where: { deletedAt?: null; mobile?: string } }) => {
      return this.customers.find((customer) => customer.mobile === where.mobile && customer.deletedAt === null) ?? null;
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

  private withCustomer(account: FakeAccount) {
    const customer = this.customers.find((item) => item.id === account.customerId);
    if (!customer) {
      throw new Error("Customer not found");
    }
    return { ...account, customer };
  }
}

interface FakeCode {
  attemptCount: number;
  codeHash: string;
  consumedAt: Date | null;
  createdAt: Date;
  deletedAt: Date | null;
  expiresAt: Date;
  id: string;
  phone: string;
  purpose: CustomerVerificationCodePurpose;
  requestIp: string | null;
  updatedAt: Date;
  userAgent: string | null;
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
  purpose: CustomerVerificationCodePurpose;
  sendStatus: SmsSendStatus;
  verificationCodeId?: string | null;
}

interface FakeCustomer {
  createdAt: Date;
  customerNo: string;
  deletedAt: Date | null;
  id: string;
  mobile: string;
  name: string;
  sourceChannel: string | null;
  status: CustomerStatus;
}

interface FakeAccount {
  accountStatus: CustomerAccountStatus;
  createdAt: Date;
  customerId: string;
  deletedAt: Date | null;
  id: string;
  lastLoginAt: Date | null;
  lastLoginIp: string | null;
  lastUserAgent: string | null;
  phone: string;
  phoneVerifiedAt: Date | null;
  updatedAt: Date;
  wechatOpenId: string | null;
  wechatUnionId: string | null;
}

function createCustomer(overrides: Partial<FakeCustomer> = {}): FakeCustomer {
  return {
    createdAt: new Date(),
    customerNo: overrides.customerNo ?? "CUS202606160001",
    deletedAt: overrides.deletedAt ?? null,
    id: overrides.id ?? "customer-1",
    mobile: overrides.mobile ?? "13800000000",
    name: overrides.name ?? "手机用户138****0000",
    sourceChannel: overrides.sourceChannel ?? "portal",
    status: overrides.status ?? CustomerStatus.LEAD
  };
}

function createAccount(overrides: Partial<FakeAccount> = {}): FakeAccount {
  return {
    accountStatus: overrides.accountStatus ?? CustomerAccountStatus.ACTIVE,
    createdAt: new Date(),
    customerId: overrides.customerId ?? "customer-1",
    deletedAt: overrides.deletedAt ?? null,
    id: overrides.id ?? "account-1",
    lastLoginAt: overrides.lastLoginAt ?? null,
    lastLoginIp: overrides.lastLoginIp ?? null,
    lastUserAgent: overrides.lastUserAgent ?? null,
    phone: overrides.phone ?? "13800000000",
    phoneVerifiedAt: overrides.phoneVerifiedAt ?? null,
    updatedAt: new Date(),
    wechatOpenId: overrides.wechatOpenId ?? null,
    wechatUnionId: overrides.wechatUnionId ?? null
  };
}

function matchesCodeWhere(code: FakeCode, where: Record<string, unknown>) {
  if (where.id !== undefined && code.id !== where.id) {
    return false;
  }
  if (where.phone !== undefined && code.phone !== where.phone) {
    return false;
  }
  if (where.purpose !== undefined && code.purpose !== where.purpose) {
    return false;
  }
  if ("consumedAt" in where && code.consumedAt !== where.consumedAt) {
    return false;
  }
  if ("deletedAt" in where && code.deletedAt !== where.deletedAt) {
    return false;
  }
  const createdAt = where.createdAt as { gte?: Date } | undefined;
  if (createdAt?.gte && code.createdAt.getTime() < createdAt.gte.getTime()) {
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

      return (
        result ?? defaultResult
      );
    })
  } satisfies SmsProvider;
}
