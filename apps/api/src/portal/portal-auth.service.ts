import { createHmac, randomInt } from "node:crypto";

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Customer,
  CustomerAccount,
  CustomerAccountStatus,
  CustomerStatus,
  CustomerVerificationCodePurpose,
  Prisma
} from "@prisma/client";
import jwt, { JwtPayload, SignOptions } from "jsonwebtoken";

import { createBusinessNo, withUniqueBusinessNoRetry } from "../common/business-number";
import { PrismaService } from "../prisma/prisma.service";
import { PortalLoginDto, RequestPortalCodeDto } from "./portal-auth.dto";
import { CurrentCustomer, PortalRequestContext } from "./portal-auth.types";

const CUSTOMER_TOKEN_TYPE = "customer";
const DEFAULT_CUSTOMER_COOKIE_NAME = "customer_access_token";
const DEFAULT_CUSTOMER_TOKEN_EXPIRES_IN = "7d";
const DEFAULT_OTP_TTL_SECONDS = 300;
const DEFAULT_OTP_RESEND_SECONDS = 60;
const DEFAULT_OTP_MAX_ATTEMPTS = 5;

const customerAccountWithCustomerInclude = {
  customer: true
} satisfies Prisma.CustomerAccountInclude;

type CustomerAccountWithCustomer = Prisma.CustomerAccountGetPayload<{
  include: typeof customerAccountWithCustomerInclude;
}>;

interface CustomerJwtPayload extends JwtPayload {
  customerId: string;
  phone: string;
  sub: string;
  tokenType: typeof CUSTOMER_TOKEN_TYPE;
}

@Injectable()
export class PortalAuthService {
  private readonly logger = new Logger(PortalAuthService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService
  ) {}

  async requestCode(dto: RequestPortalCodeDto, context: PortalRequestContext) {
    const phone = normalizePhone(dto.phone);
    const now = new Date();
    const resendSeconds = this.getOtpResendSeconds();
    const recentCode = await this.prisma.customerVerificationCode.findFirst({
      orderBy: { createdAt: "desc" },
      where: {
        consumedAt: null,
        createdAt: { gte: new Date(now.getTime() - resendSeconds * 1000) },
        deletedAt: null,
        phone,
        purpose: CustomerVerificationCodePurpose.LOGIN
      }
    });

    if (recentCode) {
      throw new BadRequestException("验证码发送过于频繁，请稍后再试。");
    }

    const code = createVerificationCode();
    const ttlSeconds = this.getOtpTtlSeconds();

    await this.prisma.customerVerificationCode.create({
      data: {
        codeHash: this.hashVerificationCode(phone, CustomerVerificationCodePurpose.LOGIN, code),
        expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
        phone,
        purpose: CustomerVerificationCodePurpose.LOGIN,
        requestIp: normalizeIp(context.ipAddress),
        userAgent: normalizeUserAgent(context.userAgent)
      }
    });

    if (this.shouldExposeDebugCode()) {
      this.logger.log(`Mock customer login code for ${maskPhone(phone)}: ${code}`);
    }

    return {
      debugCode: this.shouldExposeDebugCode() ? code : undefined,
      expiresIn: ttlSeconds,
      sent: true
    };
  }

  async login(dto: PortalLoginDto, context: PortalRequestContext) {
    const phone = normalizePhone(dto.phone);
    const code = dto.code.trim();
    const codeRecord = await this.prisma.customerVerificationCode.findFirst({
      orderBy: { createdAt: "desc" },
      where: {
        consumedAt: null,
        deletedAt: null,
        phone,
        purpose: CustomerVerificationCodePurpose.LOGIN
      }
    });

    if (!codeRecord || codeRecord.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException("验证码无效或已过期。");
    }

    if (codeRecord.attemptCount >= this.getOtpMaxAttempts()) {
      throw new UnauthorizedException("验证码错误次数过多，请重新获取。");
    }

    const codeHash = this.hashVerificationCode(phone, CustomerVerificationCodePurpose.LOGIN, code);
    if (codeHash !== codeRecord.codeHash) {
      await this.prisma.customerVerificationCode.update({
        data: { attemptCount: { increment: 1 } },
        where: { id: codeRecord.id }
      });
      throw new UnauthorizedException("验证码错误。");
    }

    const account = await withUniqueBusinessNoRetry(() =>
      this.prisma.$transaction(async (tx) => {
        const consumed = await tx.customerVerificationCode.updateMany({
          data: { consumedAt: new Date() },
          where: { consumedAt: null, id: codeRecord.id }
        });

        if (consumed.count !== 1) {
          throw new UnauthorizedException("验证码已使用。");
        }

        return this.findOrCreateAccountForPhone(tx, phone, context);
      })
    );

    return {
      customer: toPortalCustomerView(account),
      token: this.signCustomerToken(account)
    };
  }

  async validateToken(token: string): Promise<CurrentCustomer> {
    const payload = jwt.verify(token, this.getCustomerJwtSecret());

    if (typeof payload === "string" || !isCustomerJwtPayload(payload)) {
      throw new UnauthorizedException("未登录客户，请先登录。");
    }

    const account = await this.prisma.customerAccount.findUnique({
      include: customerAccountWithCustomerInclude,
      where: { id: payload.sub }
    });

    if (
      !account ||
      account.deletedAt ||
      account.customerId !== payload.customerId ||
      account.phone !== payload.phone
    ) {
      throw new UnauthorizedException("未登录客户，请先登录。");
    }

    if (account.accountStatus !== CustomerAccountStatus.ACTIVE) {
      throw new ForbiddenException("客户账号已禁用。");
    }

    return toCurrentCustomer(account);
  }

  getCookieName() {
    return this.configService.get<string>("CUSTOMER_ACCESS_TOKEN_COOKIE") ?? DEFAULT_CUSTOMER_COOKIE_NAME;
  }

  getCookieMaxAgeMs() {
    return parseDurationMillis(
      this.configService.get<string>("CUSTOMER_ACCESS_TOKEN_EXPIRES_IN") ?? DEFAULT_CUSTOMER_TOKEN_EXPIRES_IN
    );
  }

  private async findOrCreateAccountForPhone(
    tx: Prisma.TransactionClient,
    phone: string,
    context: PortalRequestContext
  ) {
    const now = new Date();
    const existingAccount = await tx.customerAccount.findUnique({
      include: customerAccountWithCustomerInclude,
      where: { phone }
    });

    if (existingAccount?.deletedAt) {
      throw new ForbiddenException("客户账号已禁用。");
    }

    if (existingAccount?.accountStatus === CustomerAccountStatus.DISABLED) {
      throw new ForbiddenException("客户账号已禁用。");
    }

    if (existingAccount) {
      return tx.customerAccount.update({
        data: {
          lastLoginAt: now,
          lastLoginIp: normalizeIp(context.ipAddress),
          lastUserAgent: normalizeUserAgent(context.userAgent),
          phoneVerifiedAt: existingAccount.phoneVerifiedAt ?? now
        },
        include: customerAccountWithCustomerInclude,
        where: { id: existingAccount.id }
      });
    }

    const customer = await findOrCreateCustomer(tx, phone);

    return tx.customerAccount.create({
      data: {
        accountStatus: CustomerAccountStatus.ACTIVE,
        customerId: customer.id,
        lastLoginAt: now,
        lastLoginIp: normalizeIp(context.ipAddress),
        lastUserAgent: normalizeUserAgent(context.userAgent),
        phone,
        phoneVerifiedAt: now
      },
      include: customerAccountWithCustomerInclude
    });
  }

  private signCustomerToken(account: CustomerAccountWithCustomer) {
    const expiresIn: SignOptions["expiresIn"] =
      this.configService.get<SignOptions["expiresIn"]>("CUSTOMER_ACCESS_TOKEN_EXPIRES_IN") ??
      DEFAULT_CUSTOMER_TOKEN_EXPIRES_IN;

    return jwt.sign(
      {
        customerId: account.customerId,
        phone: account.phone,
        tokenType: CUSTOMER_TOKEN_TYPE
      },
      this.getCustomerJwtSecret(),
      {
        expiresIn,
        subject: account.id
      }
    );
  }

  private hashVerificationCode(
    phone: string,
    purpose: CustomerVerificationCodePurpose,
    code: string
  ) {
    return createHmac("sha256", this.getCustomerJwtSecret())
      .update(`${purpose}:${phone}:${code}`)
      .digest("hex");
  }

  private shouldExposeDebugCode() {
    const debugEnabled = this.configService.get<string>("PORTAL_AUTH_DEBUG_CODE") === "true";
    return debugEnabled || this.configService.get<string>("NODE_ENV") !== "production";
  }

  private getCustomerJwtSecret() {
    const secret = this.configService.get<string>("CUSTOMER_JWT_SECRET");

    if (!secret) {
      throw new Error("CUSTOMER_JWT_SECRET is required.");
    }

    return secret;
  }

  private getOtpTtlSeconds() {
    return readPositiveInteger(this.configService, "PORTAL_OTP_TTL_SECONDS", DEFAULT_OTP_TTL_SECONDS);
  }

  private getOtpResendSeconds() {
    return readPositiveInteger(this.configService, "PORTAL_OTP_RESEND_SECONDS", DEFAULT_OTP_RESEND_SECONDS);
  }

  private getOtpMaxAttempts() {
    return readPositiveInteger(this.configService, "PORTAL_OTP_MAX_ATTEMPTS", DEFAULT_OTP_MAX_ATTEMPTS);
  }
}

async function findOrCreateCustomer(tx: Prisma.TransactionClient, phone: string): Promise<Customer> {
  const existingCustomer = await tx.customer.findFirst({
    orderBy: { createdAt: "asc" },
    where: {
      deletedAt: null,
      mobile: phone
    }
  });

  if (existingCustomer) {
    return existingCustomer;
  }

  return tx.customer.create({
    data: {
      customerNo: createBusinessNo("CUS"),
      mobile: phone,
      name: `手机用户${maskPhone(phone)}`,
      sourceChannel: "portal",
      status: CustomerStatus.LEAD
    }
  });
}

function createVerificationCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function isCustomerJwtPayload(payload: JwtPayload): payload is CustomerJwtPayload {
  return (
    typeof payload.sub === "string" &&
    typeof payload.customerId === "string" &&
    typeof payload.phone === "string" &&
    payload.tokenType === CUSTOMER_TOKEN_TYPE
  );
}

function toCurrentCustomer(account: CustomerAccount): CurrentCustomer {
  return {
    accountStatus: account.accountStatus,
    customerAccountId: account.id,
    customerId: account.customerId,
    phone: account.phone
  };
}

export function toPortalCustomerView(account: CustomerAccountWithCustomer) {
  return {
    accountStatus: account.accountStatus,
    customer: {
      customerNo: account.customer.customerNo,
      id: account.customer.id,
      name: account.customer.name,
      status: account.customer.status
    },
    customerAccountId: account.id,
    customerId: account.customerId,
    phone: account.phone,
    phoneVerifiedAt: account.phoneVerifiedAt?.toISOString() ?? null
  };
}

function normalizePhone(phone: string) {
  return phone.trim();
}

function normalizeIp(ip?: string) {
  return ip?.slice(0, 64);
}

function normalizeUserAgent(userAgent?: string) {
  return userAgent?.slice(0, 255);
}

function maskPhone(phone: string) {
  if (phone.length < 7) {
    return phone;
  }

  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

function parseDurationMillis(value: string) {
  const match = value.trim().match(/^(\d+)([smhd])?$/);

  if (!match) {
    return 7 * 24 * 60 * 60 * 1000;
  }

  const amount = Number(match[1]);
  const unit = (match[2] ?? "s") as "d" | "h" | "m" | "s";
  const unitMillis: Record<"d" | "h" | "m" | "s", number> = {
    d: 24 * 60 * 60 * 1000,
    h: 60 * 60 * 1000,
    m: 60 * 1000,
    s: 1000
  };

  return amount * unitMillis[unit];
}

function readPositiveInteger(configService: ConfigService, key: string, fallback: number) {
  const value = configService.get<string>(key);
  const parsed = value ? Number(value) : fallback;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
