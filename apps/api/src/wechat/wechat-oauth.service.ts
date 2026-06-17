import { BadRequestException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac, timingSafeEqual } from "node:crypto";

import { PrismaService } from "../prisma/prisma.service";
import { CurrentCustomer } from "../portal/portal-auth.types";

interface WeChatOAuthState {
  customerAccountId: string;
  customerId: string;
  expiresAt: number;
  redirect: string;
}

@Injectable()
export class WeChatOAuthService {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService
  ) {}

  async createOAuthUrl(currentCustomer: CurrentCustomer, redirect?: string) {
    const expiresIn = this.stateTtlSeconds;
    const state = this.signState({
      customerAccountId: currentCustomer.customerAccountId,
      customerId: currentCustomer.customerId,
      expiresAt: Date.now() + expiresIn * 1000,
      redirect: sanitizeRedirect(redirect, this.portalBaseUrl)
    });
    const params = new URLSearchParams({
      appid: this.requiredConfig("WECHAT_PAY_APP_ID"),
      redirect_uri: this.requiredConfig("WECHAT_PAY_OAUTH_REDIRECT_URI"),
      response_type: "code",
      scope: "snsapi_base",
      state
    });

    return {
      authUrl: `https://open.weixin.qq.com/connect/oauth2/authorize?${params.toString()}#wechat_redirect`,
      expiresIn
    };
  }

  async handleCallback(code: string | undefined, state: string | undefined) {
    if (!code || !state) {
      throw new BadRequestException("WECHAT_OAUTH_CODE_OR_STATE_MISSING");
    }

    const parsedState = this.verifyState(state);
    const oauthResult = await this.exchangeCodeForOpenId(code);
    await this.prisma.customerAccount.update({
      data: {
        wechatOpenId: oauthResult.openid,
        wechatUnionId: oauthResult.unionid ?? undefined,
        updatedAt: new Date()
      },
      where: { id: parsedState.customerAccountId }
    });

    return {
      redirectUrl: parsedState.redirect
    };
  }

  async getBinding(currentCustomer: CurrentCustomer) {
    const account = await this.prisma.customerAccount.findFirst({
      select: { wechatOpenId: true },
      where: {
        customerId: currentCustomer.customerId,
        deletedAt: null,
        id: currentCustomer.customerAccountId
      }
    });
    const openId = account?.wechatOpenId ?? null;

    return {
      bound: Boolean(openId),
      wechatOpenIdMasked: openId ? maskOpenId(openId) : null
    };
  }

  async getOpenId(currentCustomer: CurrentCustomer) {
    const account = await this.prisma.customerAccount.findFirst({
      select: { wechatOpenId: true },
      where: {
        customerId: currentCustomer.customerId,
        deletedAt: null,
        id: currentCustomer.customerAccountId
      }
    });

    return account?.wechatOpenId ?? null;
  }

  private async exchangeCodeForOpenId(code: string): Promise<{ openid: string; unionid?: string }> {
    if (this.mockEnabled) {
      return {
        openid: code.startsWith("mock_") ? code : `mock_${code}`
      };
    }

    const params = new URLSearchParams({
      appid: this.requiredConfig("WECHAT_PAY_APP_ID"),
      secret: this.requiredConfig("WECHAT_PAY_APP_SECRET"),
      code,
      grant_type: "authorization_code"
    });
    const response = await fetch(`https://api.weixin.qq.com/sns/oauth2/access_token?${params.toString()}`);
    const body = await response.json() as Record<string, unknown>;
    if (!response.ok || typeof body.openid !== "string") {
      throw new BadRequestException({
        code: "WECHAT_OAUTH_EXCHANGE_FAILED",
        errcode: body.errcode
      });
    }

    return {
      openid: body.openid,
      unionid: typeof body.unionid === "string" ? body.unionid : undefined
    };
  }

  private signState(payload: WeChatOAuthState) {
    const encodedPayload = base64UrlEncode(JSON.stringify(payload));
    const signature = sign(encodedPayload, this.stateSecret);
    return `${encodedPayload}.${signature}`;
  }

  private verifyState(state: string): WeChatOAuthState {
    const [encodedPayload, signature] = state.split(".");
    if (!encodedPayload || !signature) {
      throw new BadRequestException("WECHAT_OAUTH_STATE_INVALID");
    }
    const expected = sign(encodedPayload, this.stateSecret);
    if (!safeEqual(signature, expected)) {
      throw new BadRequestException("WECHAT_OAUTH_STATE_INVALID");
    }

    const payload = JSON.parse(base64UrlDecode(encodedPayload)) as WeChatOAuthState;
    if (!payload.customerAccountId || !payload.customerId || !payload.redirect || payload.expiresAt < Date.now()) {
      throw new BadRequestException("WECHAT_OAUTH_STATE_EXPIRED");
    }

    return payload;
  }

  private requiredConfig(key: string) {
    const value = this.configService.get<string>(key)?.trim();
    if (!value) {
      throw new ServiceUnavailableException(`${key}_MISSING`);
    }
    return value;
  }

  private get stateSecret() {
    return this.configService.get<string>("WECHAT_OAUTH_STATE_SECRET")
      ?? this.configService.get<string>("CUSTOMER_JWT_SECRET")
      ?? this.configService.get<string>("COOKIE_SECRET")
      ?? "local-wechat-oauth-state-secret";
  }

  private get stateTtlSeconds() {
    const seconds = Number(this.configService.get<string>("WECHAT_OAUTH_STATE_TTL_SECONDS") ?? "300");
    return Number.isFinite(seconds) && seconds > 0 ? seconds : 300;
  }

  private get portalBaseUrl() {
    return trimTrailingSlash(this.configService.get<string>("PORTAL_BASE_URL") ?? "http://localhost:3000");
  }

  private get mockEnabled() {
    return (this.configService.get<string>("WECHAT_OAUTH_MOCK_ENABLED") ?? "false").toLowerCase() === "true";
  }
}

function sanitizeRedirect(redirect: string | undefined, portalBaseUrl: string) {
  if (!redirect?.trim()) {
    return `${portalBaseUrl}/portal`;
  }

  const value = redirect.trim();
  if (value.startsWith("/") && !value.startsWith("//")) {
    return `${portalBaseUrl}${value}`;
  }
  if (value.startsWith(`${portalBaseUrl}/`) || value === portalBaseUrl) {
    return value;
  }

  return `${portalBaseUrl}/portal`;
}

function sign(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function maskOpenId(value: string) {
  if (value.length <= 8) {
    return `${value.slice(0, 2)}****`;
  }
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}
