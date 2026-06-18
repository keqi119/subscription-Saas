import { Injectable } from "@nestjs/common";

import {
  NotificationProvider,
  SendNotificationInput,
  SendNotificationResult
} from "./notification.provider";

@Injectable()
export class MockNotificationProvider implements NotificationProvider {
  async send(input: SendNotificationInput): Promise<SendNotificationResult> {
    if (input.data?.forceFail === true) {
      return {
        errorMessage: "MOCK_NOTIFICATION_FORCE_FAIL",
        providerResponse: { mock: true, forceFail: true },
        success: false
      };
    }

    return {
      providerMessageId: `mock_${Date.now()}`,
      providerResponse: {
        channel: input.channel,
        mock: true,
        templateCode: input.templateCode,
        title: input.title
      },
      success: true
    };
  }
}
