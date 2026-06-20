import { Injectable } from "@nestjs/common";

import { SendSmsCodeInput, SendSmsCodeResult, SmsProvider } from "./sms-provider";

@Injectable()
export class MockSmsProvider implements SmsProvider {
  async sendCode(input: SendSmsCodeInput): Promise<SendSmsCodeResult> {
    return {
      provider: "mock",
      providerMessageId: `mock_${Date.now()}`,
      providerResponse: {
        expiresInSeconds: input.expiresInSeconds,
        mock: true,
        phoneMasked: maskPhone(input.phone),
        purpose: input.purpose
      },
      success: true
    };
  }
}

function maskPhone(phone: string) {
  if (phone.length < 7) {
    return phone;
  }

  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}
