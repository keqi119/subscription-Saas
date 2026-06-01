import { describe, expect, it } from "vitest";

import { normalizeLocalhostDatabaseUrl } from "../src/prisma/prisma.service";

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
});
