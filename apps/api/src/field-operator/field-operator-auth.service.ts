import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";

import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  FieldOperatorAuditEventType,
  FieldOperatorOtpPurpose,
  Prisma,
  VehicleHandoverOperatorType
} from "@prisma/client";
import jwt, { JwtPayload, SignOptions } from "jsonwebtoken";

import { HandoverWorkOrderService } from "../handover-work-order/handover-work-order.service";
import { PrismaService } from "../prisma/prisma.service";
import { PORTAL_SMS_SEND_FAILURE_MESSAGE } from "../sms/sms.dto";
import { SmsService } from "../sms/sms.service";
import { FieldOperatorLoginDto, RequestFieldOperatorCodeDto } from "./field-operator-auth.dto";
import { CurrentFieldOperator, FieldOperatorRequestContext } from "./field-operator-auth.types";
import { maskFieldOperatorPhone, normalizeFieldOperatorPhone } from "./field-operator-phone";

const FIELD_OPERATOR_TOKEN_TYPE = "field_operator";
const DEFAULT_FIELD_COOKIE_NAME = "field_access_token";
const DEFAULT_FIELD_TOKEN_EXPIRES_IN = "12h";
const DEFAULT_OTP_TTL_SECONDS = 300;
const DEFAULT_OTP_RESEND_SECONDS = 60;
const DEFAULT_OTP_MAX_ATTEMPTS = 5;

interface FieldOperatorJwtPayload extends JwtPayload {
  jti: string;
  phone: string;
  sub: string;
  tokenType: typeof FIELD_OPERATOR_TOKEN_TYPE;
}

@Injectable()
export class FieldOperatorAuthService {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly smsService: SmsService,
    private readonly handoverWorkOrderService: HandoverWorkOrderService
  ) {}

  async requestCode(dto: RequestFieldOperatorCodeDto, context: FieldOperatorRequestContext) {
    const phone = normalizeFieldOperatorPhone(dto.phone);
    if (
      await this.handoverWorkOrderService.countFieldAccessibleWorkOrders(
        phone
      ) === 0
    ) {
      throw new UnauthorizedException(
        "No active field handover work order is assigned to this phone."
      );
    }
    const now = new Date();
    const resendSeconds = this.getOtpResendSeconds();
    const recentCode = await this.prisma.fieldOperatorOtp.findFirst({
      orderBy: { createdAt: "desc" },
      where: {
        consumedAt: null,
        createdAt: { gte: new Date(now.getTime() - resendSeconds * 1000) },
        phone,
        purpose: FieldOperatorOtpPurpose.FIELD_HANDOVER_LOGIN
      }
    });

    if (recentCode) {
      throw new HttpException("Verification code requested too frequently.", HttpStatus.TOO_MANY_REQUESTS);
    }

    const code = createVerificationCode();
    const ttlSeconds = this.getOtpTtlSeconds();
    const debugCode = this.shouldExposeDebugCode() ? code : undefined;

    const otp = await this.prisma.fieldOperatorOtp.create({
      data: {
        codeHash: this.hashVerificationCode(phone, code),
        expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
        ipHash: hashContextValue(context.ipAddress),
        lastSentAt: now,
        phone,
        purpose: FieldOperatorOtpPurpose.FIELD_HANDOVER_LOGIN,
        userAgentHash: hashContextValue(normalizeUserAgent(context.userAgent))
      }
    });

    const sendResult = await this.smsService.sendFieldHandoverLoginCode({
      allowDebugCode: debugCode !== undefined,
      code,
      expiresInSeconds: ttlSeconds,
      phone,
      verificationCodeId: otp.id
    });

    if (!sendResult.success) {
      await this.prisma.fieldOperatorOtp.update({
        data: { consumedAt: new Date() },
        where: { id: otp.id }
      });
      await this.writeAudit(FieldOperatorAuditEventType.LOGIN_FAILED, {
        context,
        metadata: { reason: "SMS_SEND_FAILED" },
        phone
      });
      throw new BadRequestException(PORTAL_SMS_SEND_FAILURE_MESSAGE);
    }

    await this.writeAudit(FieldOperatorAuditEventType.OTP_REQUESTED, { context, phone });

    return {
      debugCode,
      expiresIn: ttlSeconds,
      sent: true
    };
  }

  async login(dto: FieldOperatorLoginDto, context: FieldOperatorRequestContext) {
    const phone = normalizeFieldOperatorPhone(dto.phone);
    const code = dto.code.trim();
    const otp = await this.prisma.fieldOperatorOtp.findFirst({
      orderBy: { createdAt: "desc" },
      where: {
        consumedAt: null,
        phone,
        purpose: FieldOperatorOtpPurpose.FIELD_HANDOVER_LOGIN
      }
    });

    if (!otp || otp.expiresAt.getTime() <= Date.now()) {
      await this.writeAudit(FieldOperatorAuditEventType.LOGIN_FAILED, {
        context,
        metadata: { reason: "OTP_INVALID_OR_EXPIRED" },
        phone
      });
      throw new UnauthorizedException("Verification code is invalid or expired.");
    }

    if (otp.failedAttempts >= this.getOtpMaxAttempts()) {
      await this.writeAudit(FieldOperatorAuditEventType.LOGIN_FAILED, {
        context,
        metadata: { reason: "OTP_MAX_ATTEMPTS" },
        phone
      });
      throw new UnauthorizedException("Verification code attempts exceeded.");
    }

    if (this.hashVerificationCode(phone, code) !== otp.codeHash) {
      await this.prisma.fieldOperatorOtp.update({
        data: { failedAttempts: { increment: 1 } },
        where: { id: otp.id }
      });
      await this.writeAudit(FieldOperatorAuditEventType.LOGIN_FAILED, {
        context,
        metadata: { reason: "OTP_MISMATCH" },
        phone
      });
      throw new UnauthorizedException("Verification code is invalid.");
    }

    const jti = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + this.getCookieMaxAgeMs());
    const session = await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.fieldOperatorOtp.updateMany({
        data: { consumedAt: new Date() },
        where: { consumedAt: null, id: otp.id }
      });

      if (consumed.count !== 1) {
        throw new UnauthorizedException("Verification code has been used.");
      }

      const created = await tx.fieldOperatorSession.create({
        data: {
          expiresAt,
          ipHash: hashContextValue(context.ipAddress),
          operatorType: null,
          phone,
          sessionTokenHash: hashSessionToken(jti),
          userAgentHash: hashContextValue(normalizeUserAgent(context.userAgent))
        }
      });

      await tx.fieldOperatorAuditLog.create({
        data: {
          eventType: FieldOperatorAuditEventType.OTP_VERIFIED,
          ipHash: hashContextValue(context.ipAddress),
          phone,
          sessionId: created.id,
          userAgentHash: hashContextValue(normalizeUserAgent(context.userAgent))
        }
      });
      await tx.fieldOperatorAuditLog.create({
        data: {
          eventType: FieldOperatorAuditEventType.LOGIN_SUCCEEDED,
          ipHash: hashContextValue(context.ipAddress),
          phone,
          sessionId: created.id,
          userAgentHash: hashContextValue(normalizeUserAgent(context.userAgent))
        }
      });

      return created;
    });

    return {
      session: toSafeSessionView(session),
      token: this.signFieldOperatorToken(session, jti)
    };
  }

  async validateToken(token: string): Promise<CurrentFieldOperator> {
    const payload = verifyFieldOperatorToken(token, this.getFieldOperatorJwtSecret());
    const session = await this.prisma.fieldOperatorSession.findUnique({
      where: { sessionTokenHash: hashSessionToken(payload.jti) }
    });

    if (
      !session ||
      session.id !== payload.sub ||
      session.phone !== payload.phone ||
      session.revokedAt ||
      session.expiresAt.getTime() <= Date.now()
    ) {
      throw new UnauthorizedException("Invalid field operator session.");
    }

    await this.prisma.fieldOperatorSession.update({
      data: { lastSeenAt: new Date() },
      where: { id: session.id }
    });

    return {
      operatorType: null,
      phone: session.phone,
      sessionId: session.id
    };
  }

  async getSession(current: CurrentFieldOperator) {
    const taskCount = await this.handoverWorkOrderService.countFieldAccessibleWorkOrders(current.phone);
    return {
      authenticated: true,
      operatorType: null,
      phoneMasked: maskFieldOperatorPhone(current.phone),
      taskCount
    };
  }

  async logout(sessionId: string) {
    await this.prisma.fieldOperatorSession.update({
      data: { revokedAt: new Date() },
      where: { id: sessionId }
    });
    await this.writeAudit(FieldOperatorAuditEventType.SESSION_REVOKED, { sessionId });
    return { success: true };
  }

  recordTaskListViewed(current: CurrentFieldOperator, context: FieldOperatorRequestContext) {
    return this.writeAudit(FieldOperatorAuditEventType.TASK_LIST_VIEWED, {
      context,
      phone: current.phone,
      sessionId: current.sessionId
    });
  }

  recordTaskViewed(current: CurrentFieldOperator, workOrderId: string, context: FieldOperatorRequestContext) {
    const openedAt = new Date();
    return this.prisma.$transaction(async (tx) => {
      const initialized = await tx.vehicleHandoverWorkOrder.updateMany({
        data: {
          firstAccessedAt: openedAt,
          lastAccessedAt: openedAt
        },
        where: {
          firstAccessedAt: null,
          id: workOrderId
        }
      });
      if (initialized.count === 0) {
        await tx.vehicleHandoverWorkOrder.update({
          data: { lastAccessedAt: openedAt },
          where: { id: workOrderId }
        });
      }
      await this.writeAudit(FieldOperatorAuditEventType.TASK_VIEWED, {
        context,
        phone: current.phone,
        sessionId: current.sessionId,
        workOrderId
      }, tx);
    });
  }

  getCookieName() {
    return this.configService.get<string>("FIELD_OPERATOR_ACCESS_TOKEN_COOKIE") ?? DEFAULT_FIELD_COOKIE_NAME;
  }

  getCookieMaxAgeMs() {
    return parseDurationMillis(
      this.configService.get<string>("FIELD_OPERATOR_ACCESS_TOKEN_EXPIRES_IN") ?? DEFAULT_FIELD_TOKEN_EXPIRES_IN
    );
  }

  private signFieldOperatorToken(session: { id: string; phone: string }, jti: string) {
    const expiresIn: SignOptions["expiresIn"] =
      this.configService.get<SignOptions["expiresIn"]>("FIELD_OPERATOR_ACCESS_TOKEN_EXPIRES_IN") ??
      DEFAULT_FIELD_TOKEN_EXPIRES_IN;

    return jwt.sign(
      {
        jti,
        phone: session.phone,
        tokenType: FIELD_OPERATOR_TOKEN_TYPE
      },
      this.getFieldOperatorJwtSecret(),
      {
        expiresIn,
        subject: session.id
      }
    );
  }

  private hashVerificationCode(phone: string, code: string) {
    return createHmac("sha256", this.getFieldOperatorJwtSecret())
      .update(`${FieldOperatorOtpPurpose.FIELD_HANDOVER_LOGIN}:${phone}:${code}`)
      .digest("hex");
  }

  private shouldExposeDebugCode() {
    if (this.getRuntimeEnvironment() === "production") {
      return false;
    }

    const debugEnabled =
      this.configService.get<string>("FIELD_OPERATOR_AUTH_DEBUG_CODE") === "true" ||
      this.configService.get<string>("FIELD_OPERATOR_SMS_DEBUG_CODE") === "true";
    return debugEnabled || this.getRuntimeEnvironment() !== "production";
  }

  private getRuntimeEnvironment() {
    return (
      this.configService.get<string>("APP_ENV") ??
      this.configService.get<string>("NODE_ENV") ??
      "development"
    )
      .trim()
      .toLowerCase();
  }

  private getFieldOperatorJwtSecret() {
    const secret = this.configService.get<string>("FIELD_OPERATOR_JWT_SECRET");
    if (secret) {
      return secret;
    }

    const customerSecret = this.configService.get<string>("CUSTOMER_JWT_SECRET");
    if (customerSecret) {
      return `field-operator:${customerSecret}`;
    }

    throw new Error("FIELD_OPERATOR_JWT_SECRET is required.");
  }

  private getOtpTtlSeconds() {
    return readPositiveInteger(this.configService, "FIELD_OPERATOR_OTP_TTL_SECONDS", DEFAULT_OTP_TTL_SECONDS);
  }

  private getOtpResendSeconds() {
    return readPositiveInteger(this.configService, "FIELD_OPERATOR_OTP_RESEND_SECONDS", DEFAULT_OTP_RESEND_SECONDS);
  }

  private getOtpMaxAttempts() {
    return readPositiveInteger(this.configService, "FIELD_OPERATOR_OTP_MAX_ATTEMPTS", DEFAULT_OTP_MAX_ATTEMPTS);
  }

  private async writeAudit(
    eventType: FieldOperatorAuditEventType,
    input: {
      context?: FieldOperatorRequestContext;
      metadata?: Record<string, unknown>;
      phone?: string | null;
      sessionId?: string | null;
      workOrderId?: string | null;
    },
    db: Prisma.TransactionClient | PrismaService = this.prisma
  ) {
    await db.fieldOperatorAuditLog.create({
      data: {
        eventType,
        ipHash: hashContextValue(input.context?.ipAddress),
        metadata: input.metadata === undefined ? undefined : toJsonValue(input.metadata),
        phone: input.phone,
        sessionId: input.sessionId,
        userAgentHash: hashContextValue(normalizeUserAgent(input.context?.userAgent)),
        workOrderId: input.workOrderId
      }
    });
  }
}

function verifyFieldOperatorToken(token: string, secret: string) {
  let payload: string | JwtPayload;
  try {
    payload = jwt.verify(token, secret);
  } catch (error) {
    if (isJwtVerificationError(error)) {
      throw new UnauthorizedException("Invalid field operator session.");
    }
    throw error;
  }

  if (typeof payload === "string" || !isFieldOperatorJwtPayload(payload)) {
    throw new UnauthorizedException("Invalid field operator session.");
  }

  return payload;
}

function isFieldOperatorJwtPayload(payload: JwtPayload): payload is FieldOperatorJwtPayload {
  return (
    typeof payload.jti === "string" &&
    typeof payload.phone === "string" &&
    typeof payload.sub === "string" &&
    payload.tokenType === FIELD_OPERATOR_TOKEN_TYPE
  );
}

function toSafeSessionView(session: { operatorType: VehicleHandoverOperatorType | null; phone: string }) {
  return {
    operatorType: null,
    phoneMasked: maskFieldOperatorPhone(session.phone)
  };
}

function createVerificationCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function hashSessionToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function hashContextValue(value: null | string | undefined) {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function normalizeUserAgent(userAgent?: string | string[]) {
  const value = Array.isArray(userAgent) ? userAgent.join(" ") : userAgent;
  return value?.slice(0, 255);
}

function parseDurationMillis(value: string) {
  const match = value.trim().match(/^(\d+)([smhd])?$/);

  if (!match) {
    return 12 * 60 * 60 * 1000;
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

function isJwtVerificationError(error: unknown) {
  return error instanceof Error &&
    ["JsonWebTokenError", "NotBeforeError", "TokenExpiredError"].includes(error.name);
}

function toJsonValue(value: unknown) {
  return value === undefined || value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}
