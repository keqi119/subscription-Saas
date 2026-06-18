import { BadRequestException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import {
  NotificationProvider,
  SendNotificationInput,
  SendNotificationResult
} from "./notification.provider";

const WECHAT_API_BASE_URL = "https://api.weixin.qq.com";
const TOKEN_EXPIRED_ERROR_CODES = new Set([40001, 42001]);

@Injectable()
export class WeChatOfficialAccountProvider implements NotificationProvider {
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(private readonly configService: ConfigService) {}

  async send(input: SendNotificationInput): Promise<SendNotificationResult> {
    if (!this.enabled) {
      return {
        errorMessage: "WECHAT_OFFICIAL_ACCOUNT_DISABLED",
        success: false
      };
    }
    if (!input.recipientOpenId) {
      return {
        errorMessage: "WECHAT_OPENID_MISSING",
        success: false
      };
    }
    if (!input.providerTemplateId) {
      return {
        errorMessage: "WECHAT_TEMPLATE_ID_MISSING",
        success: false
      };
    }

    return this.sendTemplateMessage(input, false);
  }

  private async sendTemplateMessage(input: SendNotificationInput, retried: boolean): Promise<SendNotificationResult> {
    const accessToken = await this.getAccessToken();
    const response = await fetch(`${WECHAT_API_BASE_URL}/cgi-bin/message/template/send?access_token=${accessToken}`, {
      body: JSON.stringify({
        data: toWechatTemplateData(input.data),
        template_id: input.providerTemplateId,
        touser: input.recipientOpenId,
        url: input.url
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST"
    });
    const body = await response.json() as Record<string, unknown>;
    const errcode = typeof body.errcode === "number" ? body.errcode : 0;

    if (!response.ok || errcode !== 0) {
      if (!retried && TOKEN_EXPIRED_ERROR_CODES.has(errcode)) {
        this.clearTokenCache();
        return this.sendTemplateMessage(input, true);
      }

      return {
        errorMessage: `WECHAT_TEMPLATE_SEND_FAILED:${errcode}`,
        providerResponse: body,
        success: false
      };
    }

    return {
      providerMessageId: typeof body.msgid === "string" ? body.msgid : undefined,
      providerResponse: body,
      success: true
    };
  }

  private async getAccessToken() {
    if (this.accessToken && this.accessTokenExpiresAt > Date.now()) {
      return this.accessToken;
    }

    const appId = this.requiredConfig("WECHAT_OFFICIAL_ACCOUNT_APP_ID", "WECHAT_PAY_APP_ID");
    const appSecret = this.requiredConfig("WECHAT_OFFICIAL_ACCOUNT_APP_SECRET", "WECHAT_PAY_APP_SECRET");
    const params = new URLSearchParams({
      appid: appId,
      grant_type: "client_credential",
      secret: appSecret
    });
    const response = await fetch(`${WECHAT_API_BASE_URL}/cgi-bin/token?${params.toString()}`);
    const body = await response.json() as Record<string, unknown>;
    const token = typeof body.access_token === "string" ? body.access_token : null;
    if (!response.ok || !token) {
      throw new BadRequestException({
        code: "WECHAT_ACCESS_TOKEN_FAILED",
        errcode: body.errcode
      });
    }

    const expiresIn = Number(body.expires_in ?? this.tokenCacheSeconds);
    const ttlSeconds = Number.isFinite(expiresIn) && expiresIn > 60 ? Math.min(expiresIn, this.tokenCacheSeconds) : this.tokenCacheSeconds;
    this.accessToken = token;
    this.accessTokenExpiresAt = Date.now() + Math.max(ttlSeconds - 60, 60) * 1000;
    return token;
  }

  private clearTokenCache() {
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
  }

  private requiredConfig(primaryKey: string, fallbackKey?: string) {
    const value = this.configService.get<string>(primaryKey)?.trim()
      || (fallbackKey ? this.configService.get<string>(fallbackKey)?.trim() : undefined);
    if (!value) {
      throw new ServiceUnavailableException(`${primaryKey}_MISSING`);
    }
    return value;
  }

  private get enabled() {
    return (this.configService.get<string>("NOTIFICATION_WECHAT_ENABLED") ?? "false").toLowerCase() === "true";
  }

  private get tokenCacheSeconds() {
    const value = Number(this.configService.get<string>("WECHAT_OFFICIAL_ACCOUNT_TOKEN_CACHE_SECONDS") ?? "7000");
    return Number.isFinite(value) && value > 0 ? value : 7000;
  }
}

function toWechatTemplateData(data: Record<string, unknown> | undefined) {
  const result: Record<string, { value: string }> = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    if (key === "forceFail") continue;
    result[key] = {
      value: value === null || value === undefined ? "" : String(value)
    };
  }
  return result;
}
