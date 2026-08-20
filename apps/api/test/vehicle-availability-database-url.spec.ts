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

  it("accepts an intended database URL without query parameters", () => {
    const parsed = new URL(
      requiredVehicleAvailabilityTestDatabaseUrl(
        "postgresql://test_user:test_password@127.0.0.1:55432/subscription_saas_codex"
      )
    );

    expect(parsed.search).toBe("");
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
    ["bad escape", "postgresql://test_user:test_password@localhost/subscription_saas_%ZZ"],
    [
      "remote host override",
      "postgresql://test_user:test_password@localhost/subscription_saas_test?schema=public&host=db.internal"
    ],
    [
      "Unix socket host override",
      "postgresql://test_user:test_password@localhost/subscription_saas_test?host=%2Fvar%2Frun%2Fpostgresql"
    ],
    [
      "duplicate host override",
      "postgresql://test_user:test_password@localhost/subscription_saas_test?host=db.internal&host=127.0.0.1"
    ],
    [
      "mixed-case host override",
      "postgresql://test_user:test_password@localhost/subscription_saas_test?HOST=db.internal"
    ],
    [
      "encoded host override key",
      "postgresql://test_user:test_password@localhost/subscription_saas_test?%68ost=db.internal"
    ],
    [
      "port override",
      "postgresql://test_user:test_password@localhost/subscription_saas_test?port=6432"
    ],
    [
      "user override",
      "postgresql://test_user:test_password@localhost/subscription_saas_test?user=other_user"
    ],
    [
      "password override",
      "postgresql://test_user:test_password@localhost/subscription_saas_test?password=other_password"
    ],
    [
      "database override",
      "postgresql://test_user:test_password@localhost/subscription_saas_test?database=postgres"
    ],
    [
      "dbname override",
      "postgresql://test_user:test_password@localhost/subscription_saas_test?dbname=postgres"
    ],
    [
      "SSL override",
      "postgresql://test_user:test_password@localhost/subscription_saas_test?sslmode=require"
    ],
    [
      "duplicate schema",
      "postgresql://test_user:test_password@localhost/subscription_saas_test?schema=public&schema=public"
    ],
    [
      "non-public schema",
      "postgresql://test_user:test_password@localhost/subscription_saas_test?schema=tenant"
    ],
    [
      "blank schema",
      "postgresql://test_user:test_password@localhost/subscription_saas_test?schema="
    ],
    [
      "mixed-case schema key",
      "postgresql://test_user:test_password@localhost/subscription_saas_test?Schema=public"
    ],
    [
      "encoded schema key",
      "postgresql://test_user:test_password@localhost/subscription_saas_test?%73chema=public"
    ],
    [
      "encoded schema value",
      "postgresql://test_user:test_password@localhost/subscription_saas_test?schema=%70ublic"
    ],
    [
      "extra query key",
      "postgresql://test_user:test_password@localhost/subscription_saas_test?schema=public&application_name=availability"
    ],
    [
      "trailing query separator",
      "postgresql://test_user:test_password@localhost/subscription_saas_test?schema=public&"
    ]
  ])("rejects a %s target", (_label, value) => {
    expect(() => requiredVehicleAvailabilityTestDatabaseUrl(value)).toThrow(
      /vehicle availability integration tests/i
    );
  });

  it("does not echo a rejected URL or password", () => {
    const sentinelPassword = "VEHICLE_AVAILABILITY_SENTINEL_PASSWORD";
    const sentinelUrl =
      `postgresql://test_user:${sentinelPassword}@localhost/subscription_saas_test` +
      "?schema=public&host=db.internal";
    let caught: unknown;

    try {
      requiredVehicleAvailabilityTestDatabaseUrl(sentinelUrl);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(sentinelPassword);
    expect((caught as Error).message).not.toContain(sentinelUrl);
  });
});
