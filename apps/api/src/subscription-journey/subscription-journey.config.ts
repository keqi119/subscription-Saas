import { Injectable, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { journeyError } from "./subscription-journey.errors";

const DEFAULT_CLAIM_LIMIT = 10;
const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

@Injectable()
export class SubscriptionJourneyRuntimeConfig implements OnModuleInit {
  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.validate();
  }

  validate(): void {
    void this.claimLimit;
    void this.leaseMs;
    void this.pollIntervalMs;
  }

  get enabled(): boolean {
    return readBoolean(this.config, "SUBSCRIPTION_JOURNEY_ENABLED");
  }

  get workerEnabled(): boolean {
    return readBoolean(this.config, "SUBSCRIPTION_JOURNEY_WORKER_ENABLED");
  }

  get claimLimit(): number {
    return readPositiveInteger(
      this.config,
      "SUBSCRIPTION_JOURNEY_CLAIM_LIMIT",
      DEFAULT_CLAIM_LIMIT
    );
  }

  get leaseMs(): number {
    return readPositiveInteger(
      this.config,
      "SUBSCRIPTION_JOURNEY_LEASE_MS",
      DEFAULT_LEASE_MS
    );
  }

  get pollIntervalMs(): number {
    return readPositiveInteger(
      this.config,
      "SUBSCRIPTION_JOURNEY_POLL_INTERVAL_MS",
      DEFAULT_POLL_INTERVAL_MS
    );
  }

  permitsEnrollment(applicationId: string, customerId: string): boolean {
    if (!this.enabled) return false;
    const applicationIds = readAllowlist(
      this.config,
      "SUBSCRIPTION_JOURNEY_ALLOWLIST_APPLICATION_IDS"
    );
    const customerIds = readAllowlist(
      this.config,
      "SUBSCRIPTION_JOURNEY_ALLOWLIST_CUSTOMER_IDS"
    );
    if (applicationIds.size === 0 && customerIds.size === 0) return true;
    return applicationIds.has(applicationId) || customerIds.has(customerId);
  }
}

function readBoolean(config: ConfigService, key: string): boolean {
  return config.get<string>(key)?.trim().toLowerCase() === "true";
}

function readAllowlist(config: ConfigService, key: string): Set<string> {
  return new Set(
    (config.get<string>(key) ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function readPositiveInteger(
  config: ConfigService,
  key: string,
  fallback: number
): number {
  const raw = config.get<string>(key)?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  throw journeyError(
    "JOURNEY_CONFIGURATION_ERROR",
    "Subscription journey worker configuration is invalid."
  );
}
