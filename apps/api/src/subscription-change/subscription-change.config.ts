import type { InjectionToken } from "@nestjs/common";

export interface SubscriptionChangeConfig {
  enabled: boolean;
  now: () => Date;
  quoteValidityHours: number;
}

export const SUBSCRIPTION_CHANGE_CONFIG: InjectionToken = Symbol("SUBSCRIPTION_CHANGE_CONFIG");

export function loadSubscriptionChangeConfig(
  environment: NodeJS.ProcessEnv = process.env
): SubscriptionChangeConfig {
  const configuredHours = Number(environment.SUBSCRIPTION_EXTENSION_QUOTE_VALIDITY_HOURS ?? 72);
  return {
    enabled: environment.SUBSCRIPTION_EXTENSION_ENABLED === "true",
    now: () => new Date(),
    quoteValidityHours:
      Number.isSafeInteger(configuredHours) && configuredHours > 0 ? configuredHours : 72
  };
}
