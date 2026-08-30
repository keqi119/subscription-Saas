import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  BILLING_MAINTENANCE_FORBIDDEN_DOMAINS,
  BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_SHA256,
  BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_VERSION
} from "../src/billing-automation/billing-maintenance-forbidden-domains";

const REPOSITORY_ROOT = path.resolve(__dirname, "../../..");
const SCHEMA_PATH = path.join(REPOSITORY_ROOT, "apps/api/prisma/schema.prisma");
const MIGRATION_PATH = path.join(
  REPOSITORY_ROOT,
  "apps/api/prisma/migrations/20260831010000_billing_maintenance_cycle_fact/migration.sql"
);

describe("billing maintenance evidence schema", () => {
  it("defines a dedicated typed fact outside the acceptance forbidden-domain set", async () => {
    const schema = await readFile(SCHEMA_PATH, "utf8");
    const authority = (await import(
      pathToFileURL(
        path.join(REPOSITORY_ROOT, "scripts/stage1-clean-acceptance-baseline-snapshot.mjs")
      ).href
    )) as { STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES: readonly string[] };

    expect(schema).toMatch(/enum BillingMaintenanceCycleFactStatus\s*{\s*COMPLETED/);
    expect(schema).toMatch(/model BillingMaintenanceCycleFact\s*{/);
    expect(schema).toMatch(/@@unique\(\[evidenceRunId, sequence\]\)/);
    const schemaDomains = [...schema.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)].map(
      ([, model, body]) => ({
        delegate: model![0]!.toLowerCase() + model!.slice(1),
        table: body!.match(/@@map\("([^"]+)"\)/)?.[1]
      })
    );
    expect(
      BILLING_MAINTENANCE_FORBIDDEN_DOMAINS.map(({ delegate }) => ({
        delegate,
        table: schemaDomains.find((domain) => domain.delegate === delegate)?.table
      }))
    ).toEqual(BILLING_MAINTENANCE_FORBIDDEN_DOMAINS);
    expect(authority.STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES).toEqual(
      BILLING_MAINTENANCE_FORBIDDEN_DOMAINS.map(({ delegate }) => delegate)
    );
    expect(authority.STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES).not.toContain(
      "billingMaintenanceCycleFact"
    );
    expect(BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_VERSION).toMatch(/\/v1$/);
    expect(BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_SHA256).toBe(
      "b9eac6d543ad972684dabc0d261816c54229c1276100e7fc19d3c568e37871cb"
    );
  });

  it("ships one append-only migration with database-enforced source, sequence, time, JSON, and privacy constraints", async () => {
    const migration = await readFile(MIGRATION_PATH, "utf8");

    expect(migration).toContain("billing_maintenance_cycle_fact_evidence_run_id_sequence_key");
    expect(migration).toContain("billing_maintenance_cycle_fact_sequence_chk");
    expect(migration).toContain("billing_maintenance_cycle_fact_source_format_chk");
    expect(migration).toContain("billing_maintenance_cycle_fact_time_order_chk");
    expect(migration).toContain("billing_maintenance_cycle_fact_count_maps_chk");
    expect(migration).toContain("billing_maintenance_cycle_fact_summaries_chk");
    expect(migration).toContain("billing_maintenance_cycle_fact_append_only_trg");
    expect(migration).toContain("ERRCODE = '55000'");
    expect(migration).toContain("BEFORE UPDATE OR DELETE");
  });

  it("loads the same forbidden-domain asset from the compiled API runtime layout", async () => {
    const authority = (await import(
      pathToFileURL(
        path.join(REPOSITORY_ROOT, "scripts/stage1-clean-acceptance-baseline-snapshot.mjs")
      ).href
    )) as {
      loadStage1AcceptanceForbiddenDomainDefinition: (moduleUrl: string) => {
        domains: Array<{ delegate: string; table: string }>;
        version: string;
      };
    };
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "billing-maintenance-forbidden-runtime-")
    );
    try {
      const runtimeAsset = path.join(
        temporaryRoot,
        "apps/api/dist/src/billing-automation/stage1-acceptance-forbidden-domains.json"
      );
      await mkdir(path.dirname(runtimeAsset), { recursive: true });
      await writeFile(
        runtimeAsset,
        JSON.stringify({
          domains: BILLING_MAINTENANCE_FORBIDDEN_DOMAINS,
          version: BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_VERSION
        }),
        "utf8"
      );

      const loaded = authority.loadStage1AcceptanceForbiddenDomainDefinition(
        pathToFileURL(path.join(temporaryRoot, "scripts/snapshot.mjs")).href
      );

      expect(loaded).toEqual({
        domains: BILLING_MAINTENANCE_FORBIDDEN_DOMAINS,
        version: BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_VERSION
      });
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });
});
