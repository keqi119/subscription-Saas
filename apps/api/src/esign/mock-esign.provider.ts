import { ConfigService } from "@nestjs/config";

import {
  CreateSignTaskInput,
  CreateSignTaskResult,
  ESignProvider,
  GetSignerUrlInput,
  GetSignerUrlResult,
  VerifyCallbackResult
} from "./esign.provider";

export class MockESignProvider implements ESignProvider {
  constructor(private readonly configService: ConfigService) {}

  async createSignTask(input: CreateSignTaskInput): Promise<CreateSignTaskResult> {
    const expiresAt = this.signUrlExpiresAt();
    const signUrl = this.buildMockSignUrl(input.contractId, input.taskId);

    return {
      providerTaskId: `mock_${input.taskNo}`,
      rawResponse: {
        mock: true,
        signUrl
      },
      signUrl,
      signUrlExpiresAt: expiresAt
    };
  }

  async getSignerUrl(input: GetSignerUrlInput): Promise<GetSignerUrlResult> {
    const signUrl = this.buildMockSignUrl(input.contractId, input.taskId);

    return {
      expiresAt: this.signUrlExpiresAt(),
      rawResponse: {
        mock: true,
        providerTaskId: input.providerTaskId,
        signUrl
      },
      signUrl
    };
  }

  async verifyCallback(payload: unknown): Promise<VerifyCallbackResult> {
    const record = asRecord(payload);

    return {
      eventType: stringOrUndefined(record.eventType) ?? stringOrUndefined(record.event),
      payload,
      providerTaskId: stringOrUndefined(record.providerTaskId),
      verified: true
    };
  }

  private buildMockSignUrl(contractId?: string, taskId?: string) {
    const portalBaseUrl = trimTrailingSlash(
      this.configService.get<string>("PORTAL_BASE_URL") ?? "http://localhost:3000"
    );
    const contractSegment = encodeURIComponent(contractId ?? "");
    const taskQuery = taskId ? `?taskId=${encodeURIComponent(taskId)}` : "";

    return `${portalBaseUrl}/portal/contracts/${contractSegment}/sign${taskQuery}`;
  }

  private signUrlExpiresAt() {
    const seconds = Number(this.configService.get<string>("ESIGN_SIGN_URL_EXPIRES_SECONDS") ?? "1800");
    return new Date(Date.now() + Math.max(seconds, 60) * 1000);
  }
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}
