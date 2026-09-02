import { describe, expect, it } from "vitest";

import {
  buildDatabaseApplicationName,
  normalizeLocalhostDatabaseUrl,
  resolveDatabaseApplicationName
} from "../src/prisma/prisma.service";

describe("PrismaService connection configuration", () => {
  it("uses IPv4 for local PostgreSQL URLs to avoid localhost IPv6 instability", () => {
    const url = normalizeLocalhostDatabaseUrl(
      "postgresql://subscription:subscription@localhost:5432/subscription_saas?schema=public"
    );

    expect(url).toContain("@127.0.0.1:5432/");
    expect(url).toContain("schema=public");
  });

  it("keeps non-localhost database hosts unchanged", () => {
    const url = normalizeLocalhostDatabaseUrl(
      "postgresql://subscription:subscription@db.internal:5432/subscription_saas?schema=public"
    );

    expect(url).toContain("@db.internal:5432/");
  });

  it("binds the pool application_name to the manifest and session nonce", () => {
    expect(buildDatabaseApplicationName("manifest-ab12", "session-cd34")).toBe(
      "subscription-api/manifest-ab12/session-cd34"
    );
  });

  it.each([
    ["manifest/escape", "session-cd34"],
    ["manifest-ab12", "session with spaces"],
    ["m".repeat(40), "session-cd34"]
  ])("rejects unsafe or overlong database session labels", (manifestId, sessionNonce) => {
    expect(() => buildDatabaseApplicationName(manifestId, sessionNonce)).toThrow(
      "DATABASE_SESSION_IDENTITY_INVALID"
    );
  });

  it("requires both final-gate session identity components", () => {
    const values = new Map([["RELEASE_FINAL_GATE", "true"]]);
    expect(() => resolveDatabaseApplicationName({ get: (key: string) => values.get(key) })).toThrow(
      "DATABASE_SESSION_IDENTITY_REQUIRED"
    );
  });

  it("retains the stable application name outside the final gate", () => {
    expect(resolveDatabaseApplicationName({ get: () => undefined })).toBe("subscription-api");
  });
});
