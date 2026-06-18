import { NotificationChannel } from "@prisma/client";

export const NOTIFICATION_PROVIDER_CLIENT = Symbol("NOTIFICATION_PROVIDER_CLIENT");

export interface SendNotificationInput {
  channel: NotificationChannel;
  recipientOpenId?: string | null;
  recipientPhone?: string | null;
  title?: string | null;
  content?: string | null;
  url?: string | null;
  templateCode?: string | null;
  providerTemplateId?: string | null;
  data?: Record<string, unknown>;
}

export interface SendNotificationResult {
  success: boolean;
  providerMessageId?: string;
  providerResponse?: unknown;
  errorMessage?: string;
}

export interface NotificationProvider {
  send(input: SendNotificationInput): Promise<SendNotificationResult>;
}
