import { describe, expect, it } from "vitest";

import { requiredVehicleAvailabilityTestDatabaseUrl } from "./helpers/test-database-url";

describe("vehicle availability test database URL", () => {
  it.each([
    ["dedicated local", "subscription_saas_codex", "55432"],
    ["canonical CI", "subscription_saas_test", "5432"]
  ])("accepts the %s database", (_label, databaseName, port) => {
    const parsed = new URL(
      requiredVehicleAvailabilityTestDatabaseUrl(
        `postgresql://test_user:test_password@localhost:${port}/${databaseName}?schema=public`
      )
    );

    expect({
      databaseName: decodeURIComponent(parsed.pathname.slice(1)),
      hostname: parsed.hostname,
      port: parsed.port,
      protocol: parsed.protocol,
      username: parsed.username
    }).toEqual({
      databaseName,
      hostname: "127.0.0.1",
      port,
      protocol: "postgresql:",
      username: "test_user"
    });
  });

  it.each([
    ["missing", undefined],
    ["blank", "  "],
    ["malformed", "not-a-database-url"],
    ["wrong protocol", "https://test_user:test_password@localhost/subscription_saas_test"],
    ["non-loopback", "postgresql://test_user:test_password@db.internal/subscription_saas_test"],
    ["missing user", "postgresql://:test_password@localhost/subscription_saas_test"],
    ["blank database", "postgresql://test_user:test_password@localhost/"],
    ["default database", "postgresql://test_user:test_password@localhost/postgres"],
    ["production-like", "postgresql://test_user:test_password@localhost/subscription_saas"],
    ["other test", "postgresql://test_user:test_password@localhost/subscription_other_test"],
    ["other codex", "postgresql://test_user:test_password@localhost/subscription_other_codex"],
    [
      "name extension",
      "postgresql://test_user:test_password@localhost/subscription_saas_test_shadow"
    ],
    ["bad escape", "postgresql://test_user:test_password@localhost/subscription_saas_%ZZ"]
  ])("rejects a %s target", (_label, value) => {
    expect(() => requiredVehicleAvailabilityTestDatabaseUrl(value)).toThrow(
      /vehicle availability integration tests/i
    );
  });
});
