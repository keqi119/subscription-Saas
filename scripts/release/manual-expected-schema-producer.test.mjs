import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { canonicalJson, computeMigrationCatalog, computeRepositoryContract, sha256Bytes } from "../../packages/release-foundation/src/index.mjs";
import { createBuildProof } from "./create-build-proof.mjs";
import { produceManualExpectedSchema, runReferenceExpectedSchema } from "./manual-expected-schema-producer.mjs";

const sourceSha = "1".repeat(40);
const digest = (c) => `sha256:${c.repeat(64)}`;
const nodeBase = "node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3";
const pgBase = "postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0";
const result = (stdout = "", exitCode = 0) => ({ stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), exitCode, signal: null });

async function fixture(t, fault) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "expected-schema-test-"));
  t.after(() => fs.rm(repoRoot, { recursive: true, force: true }));
  async function put(file, bytes) { await fs.mkdir(path.dirname(path.join(repoRoot, file)), { recursive: true }); await fs.writeFile(path.join(repoRoot, file), bytes); }
  const migrationPath = "apps/api/prisma/migrations/20260101000000_initial/migration.sql";
  await put(migrationPath, "CREATE TABLE example(id integer PRIMARY KEY);\n");
  await put("apps/api/prisma/schema.prisma", "// exact source schema\r\n");
  await put("apps/api/prisma.config.ts", "// frozen config\n");
  await put("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  await put("package.json", JSON.stringify({ packageManager: "pnpm@11.4.0" }));
  await put("Dockerfile.runner", `FROM ${nodeBase} AS deps\nFROM ${pgBase} AS runtime\n`);
  await put("scripts/release/manual-expected-schema-producer.mjs", await fs.readFile(new URL("./manual-expected-schema-producer.mjs", import.meta.url)));
  await put("release/contracts/repository-contract-files.v1.json", canonicalJson({ contractVersion: "repository-contract-files.v1", files: ["Dockerfile.runner", "pnpm-lock.yaml", "release/contracts/repository-contract-files.v1.json", "scripts/release/manual-expected-schema-producer.mjs"] }));
  const catalog = await computeMigrationCatalog(repoRoot);
  const contract = await computeRepositoryContract(repoRoot);
  const ciRunRef = "https://github.com/keqi119/subscription-Saas/actions/runs/2801";
  const bases = [nodeBase, pgBase].map((base) => { const [image, hex] = base.split("@sha256:"); return { image, declaredDigest: `sha256:${hex}`, digest: `sha256:${hex}` }; });
  const material = { schemaVersion: "build-material-observation.v1", sourceSha, checkoutRef: sourceSha, ciRunRef,
    repositoryContractDigest: contract.digest, migrationCatalogDigest: catalog.digest, policyDigest: digest("f"), promotionEligibility: "trusted-candidate",
    images: ["api", "web", "runner"].map((name, i) => { const image = `ghcr.io/keqi119/subscription-${name}`, d = digest(String(i + 1)); return { name, image, platform: "linux/amd64", digest: d, sourceRevision: sourceSha, baseImageDigests: bases, builderName: "https://mobyproject.org/buildkit@v1", buildAttestationRef: `oci://${image}@${d}#provenance=${digest("c")}`, registrySubject: `${image}@${d}`, buildRunRef: ciRunRef }; }),
    externalActions: [{ name: "actions/checkout", commitSha: "2".repeat(40) }], builder: { name: "https://mobyproject.org/buildkit@v1", provenanceRef: `build-material-attestations:${digest("4")}` }, observedAt: "2026-09-02T16:00:00.000Z" };
  const proof = createBuildProof({ sourceSha, images: material.images, migrationCatalog: catalog, repositoryContract: contract, provenance: { generatedAt: material.observedAt, ciRunRef, attestationRef: material.builder.provenanceRef, checkoutRef: sourceSha, buildMaterialObservation: material } });
  const calls = [], containers = new Map();
  let ordinal = 0;
  async function runProcess(command, argv, options) {
    calls.push({ command, argv, environment: options.environment });
    assert.equal(options.environment.DOCKER_HOST, undefined);
    assert.equal(options.environment.DATABASE_URL, undefined);
    if (command === "git") return result(argv.includes("status") ? "" : `${fault === "source" ? "9".repeat(40) : sourceSha}\n`);
    if (command === "pnpm") return result("11.4.0\n");
    const operation = argv.find((v) => ["create", "inspect", "start", "stop", "rm"].includes(v));
    if (operation === "create") {
      assert.ok(argv.includes("--network=none")); assert.ok(argv.includes("--user=postgres")); assert.ok(argv.includes("--pull=never"));
      const id = String(++ordinal).repeat(64); containers.set(id, { ordinal }); return result(`${id}\n`);
    }
    const id = argv.at(-1), container = containers.get(id);
    if (operation === "inspect") {
      if (argv.includes("image")) return result(JSON.stringify({ id: digest("a"), repoDigests: [`${proof.identity.images.runner.registry}@${proof.identity.images.runner.imageDigest}`], sourceRevision: sourceSha }));
      return result(JSON.stringify({ id, imageId: digest("a"), imageRef: `${proof.identity.images.runner.registry}@${proof.identity.images.runner.imageDigest}`, user: "postgres", network: fault === "network" ? "host" : "none", binds: null, mounts: [], tmpfs: { "/tmp": "rw,nosuid,nodev,size=512m,mode=1777", "/var/lib/postgresql/data": "rw,nosuid,nodev,size=16m,mode=1777" }, readonly: true, status: container.done ? "exited" : "created", running: false, exitCode: 0 }));
    }
    if (operation === "start") {
      const envelope = JSON.parse(options.stdin);
      const innerCalls = [];
      const innerProcess = async (cmd, args, opts) => {
        innerCalls.push({ cmd, args });
        assert.equal(opts.environment.STAGE1_ACCEPTANCE_MIGRATION_SKIP_DOTENV, "1");
        assert.ok(!("DOCKER_HOST" in opts.environment));
        if (args.includes("--version")) return result(cmd.endsWith("node") ? "v22.18.0\n" : cmd.endsWith("prisma") ? "prisma                  : 7.8.0\n@prisma/client          : 7.8.0\nQuery Engine           : pinned\n" : "psql (PostgreSQL) 17.11\n");
        if (cmd.endsWith("psql")) {
          const sql = args.at(-1);
          if (sql.includes("pg_control_system")) return result(JSON.stringify({ databaseName: "expected_schema_reference", databaseOid: "16384", systemIdentifier: String(container.ordinal), serverVersion: "17.11", schemaOwner: "expected_schema_owner", ownerInventory: [{ objectClass: "schema", objectName: "public", owner: "expected_schema_owner" }], extensions: ["plpgsql"], listenAddresses: "", socketDirectory: opts.environment.REFERENCE_SOCKET_DIRECTORY }));
          if (sql.includes("_prisma_migrations")) return result(JSON.stringify(catalog.entries.map((e) => ({ name: e.path.split("/").at(-2), checksum: e.sha256.slice(7), finished: true, rolledBack: false, appliedSteps: 1 }))));
          return result();
        }
        if (args.includes("--exit-code")) return result("", fault === "diff" ? 2 : 0);
        if (args.includes("--script")) return fault === "utf8" ? { ...result(), stdout: Buffer.from([255]) } : result(container.ordinal === 2 && fault === "reproduction" ? "changed\n" : "CREATE TABLE example(id integer PRIMARY KEY);\r\n");
        return result();
      };
      const output = await runReferenceExpectedSchema(envelope, { repoRoot, runProcess: innerProcess });
      container.done = true;
      assert.ok(innerCalls.some((c) => c.cmd.endsWith("pg_ctl") && c.args.includes("stop")));
      if (fault === "inner-source") output.sourceSchemaDigest = digest("9");
      return result(canonicalJson(output));
    }
    if (operation === "stop") return result("", fault === "stop" ? 1 : 0);
    if (operation === "rm") { containers.delete(id); return result(`${id}\n`); }
    throw new Error(`unexpected offline process ${command} ${argv.join(" ")}`);
  }
  return { input: { repoRoot, proofBytes: Buffer.from(canonicalJson(proof)), materialBytes: Buffer.from(canonicalJson(material)), buildIdentity: { sourceSha, repository: "keqi119/subscription-Saas", workflowPath: ".github/workflows/docker-images.yml", sourceRef: "refs/heads/main", runId: "2801", runAttempt: 1, protectedEnvironment: "trusted-image-build" } }, runProcess, calls, containers };
}

test("orchestrates two fresh pinned references and preserves exact subjects with closed unpublished provenance", async (t) => {
  const f = await fixture(t);
  const output = await produceManualExpectedSchema(f.input, { runProcess: f.runProcess });
  assert.equal(f.containers.size, 0);
  assert.equal(f.calls.filter((c) => c.argv.includes("create")).length, 2);
  assert.deepEqual(output.sourceSchemaBytes, Buffer.from("// exact source schema\r\n"));
  assert.deepEqual(output.scriptBytes, Buffer.from("CREATE TABLE example(id integer PRIMARY KEY);\r\n"));
  const record = JSON.parse(output.producerRecordBytes), expectation = JSON.parse(output.schemaExpectationBytes);
  assert.equal(record.references.length, 2);
  assert.notEqual(record.references[0].referenceId, record.references[1].referenceId);
  assert.notEqual(record.references[0].databaseIdentity.systemIdentifier, record.references[1].databaseIdentity.systemIdentifier);
  assert.equal(expectation.sourceSchemaDigest, sha256Bytes(output.sourceSchemaBytes));
  assert.equal(expectation.script.digest, sha256Bytes(output.scriptBytes));
  assert.ok(expectation.prismaVersion.includes("Query Engine"));
  assert.deepEqual(output.producerRecordBytes, Buffer.from(canonicalJson(record)));
  assert.equal(record.promotionEligible, false);
  assert.equal("admission" in record, false);
});

test("rejects wrong checkout before allocating reference resources", async (t) => {
  const f = await fixture(t, "source");
  await assert.rejects(produceManualExpectedSchema(f.input, { runProcess: f.runProcess }), { code: "MANUAL_EXPECTED_SCHEMA_SOURCE_INVALID" });
  assert.equal(f.calls.some((c) => c.argv.includes("create")), false);
});

test("rejects origin, nonzero diff, malformed raw output and divergent second reference while cleaning exact resources", async (t) => {
  for (const fault of ["network", "diff", "utf8", "reproduction", "inner-source"]) {
    const f = await fixture(t, fault);
    await assert.rejects(produceManualExpectedSchema(f.input, { runProcess: f.runProcess }));
    assert.equal(f.containers.size, 0, fault);
    assert.ok(f.calls.some((c) => c.argv.includes("rm")), fault);
  }
});

test("attempts exact forced removal after stop failure and preserves failed cleanup identity", async (t) => {
  const f = await fixture(t, "stop");
  await assert.rejects(produceManualExpectedSchema(f.input, { runProcess: f.runProcess }), (error) => {
    assert.equal(error.code, "MANUAL_EXPECTED_SCHEMA_CONTAINER_CLEANUP_FAILED");
    assert.equal(error.containerId, "1".repeat(64));
    return true;
  });
  assert.equal(f.calls.filter((c) => c.argv.includes("stop")).length, 1);
  const removals = f.calls.filter((c) => c.argv.includes("rm"));
  assert.equal(removals.length, 1);
  assert.equal(removals[0].argv.at(-1), "1".repeat(64));
  assert.ok(removals[0].argv.includes("--force"));
  assert.equal(f.containers.size, 0);
  assert.equal(f.calls.filter((c) => c.argv.includes("create")).length, 1);
});
