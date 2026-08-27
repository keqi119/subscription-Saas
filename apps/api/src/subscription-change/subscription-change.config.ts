import type { InjectionToken } from "@nestjs/common";

export interface SubscriptionChangeConfig {
  earlyTerminationEnabled?: boolean;
  enabled: boolean;
  extensionEnabled?: boolean;
  managedOtherEnabled?: boolean;
  now: () => Date;
  quoteValidityHours: number;
  vehicleSwapEnabled?: boolean;
}

export const SUBSCRIPTION_CHANGE_FLAG_NAMES = {
  earlyTermination: "SUBSCRIPTION_EARLY_TERMINATION_ENABLED",
  extension: "SUBSCRIPTION_EXTENSION_ENABLED",
  managedOther: "SUBSCRIPTION_MANAGED_OTHER_ENABLED",
  vehicleSwap: "SUBSCRIPTION_VEHICLE_SWAP_ENABLED"
} as const;

export const SUBSCRIPTION_CHANGE_CONFIG: InjectionToken = Symbol("SUBSCRIPTION_CHANGE_CONFIG");

export function loadSubscriptionChangeConfig(
  environment: NodeJS.ProcessEnv = process.env
): SubscriptionChangeConfig {
  const configuredHours = Number(environment.SUBSCRIPTION_EXTENSION_QUOTE_VALIDITY_HOURS ?? 72);
  const extensionEnabled = environment[SUBSCRIPTION_CHANGE_FLAG_NAMES.extension] === "true";
  return {
    earlyTerminationEnabled:
      environment[SUBSCRIPTION_CHANGE_FLAG_NAMES.earlyTermination] === "true",
    enabled: extensionEnabled,
    extensionEnabled,
    managedOtherEnabled: environment[SUBSCRIPTION_CHANGE_FLAG_NAMES.managedOther] === "true",
    now: () => new Date(),
    quoteValidityHours:
      Number.isSafeInteger(configuredHours) && configuredHours > 0 ? configuredHours : 72,
    vehicleSwapEnabled: environment[SUBSCRIPTION_CHANGE_FLAG_NAMES.vehicleSwap] === "true"
  };
}

export function isSubscriptionChangeTypeEnabled(
  config: SubscriptionChangeConfig,
  changeType: "EARLY_TERMINATION" | "EXTENSION" | "MANAGED_OTHER" | "VEHICLE_SWAP"
) {
  switch (changeType) {
    case "EXTENSION":
      return config.extensionEnabled ?? config.enabled;
    case "VEHICLE_SWAP":
      return config.vehicleSwapEnabled ?? config.enabled;
    case "EARLY_TERMINATION":
      return config.earlyTerminationEnabled ?? config.enabled;
    case "MANAGED_OTHER":
      return config.managedOtherEnabled ?? config.enabled;
  }
}
