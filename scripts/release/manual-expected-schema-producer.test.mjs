import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { canonicalJson, computeMigrationCatalog, computeRepositoryContract, sha256Bytes } from "../../packages/release-foundation/src/index.mjs";
import { createBuildProof } from "./create-build-proof.mjs";
import { produceManualExpectedSchema, runReferenceExpectedSchema } from "./manual-expected-schema-producer.mjs";
import { expectedNoDifferenceOutput, expectedProvenanceShape } from "./manual-runner-source-inputs.mjs";

const sourceSha = "1".repeat(40);
const digest = (c) => `sha256:${c.repeat(64)}`;
const nodeBase = "node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3";
const pgBase = "postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0";
let fakePid = 1000;
const result = (stdout = "", exitCode = 0) => { const time = new Date().toISOString(); return { stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), exitCode, signal: null, pid: ++fakePid, preparedAt: time, spawnedAt: time, closedAt: time }; };

export async function fixture(t, fault, baseBinding = "index") {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "expected-schema-test-"));
  t.after(() => fs.rm(repoRoot, { recursive: true, force: true }));
  async function put(file, bytes) { await fs.mkdir(path.dirname(path.join(repoRoot, file)), { recursive: true }); await fs.writeFile(path.join(repoRoot, file), bytes); }
  const migrationPath = "apps/api/prisma/migrations/20260101000000_initial/migration.sql";
  await put(migrationPath, "CREATE TABLE example(id integer PRIMARY KEY);\n");
  await put("apps/api/prisma/schema.prisma", fault === "large" ? Buffer.alloc(462831, "s") : "// exact source schema\r\n");
  await put("apps/api/prisma.config.ts", "// frozen config\n");
  await put("pnpm-lock.yaml", fault === "large" ? Buffer.alloc(274737, "l") : "lockfileVersion: '9.0'\n");
  await put("package.json", JSON.stringify({ packageManager: "pnpm@11.4.0" }));
  await put("Dockerfile.runner", `FROM ${nodeBase} AS deps\nFROM ${pgBase} AS runtime\n`);
  await put("scripts/release/manual-expected-schema-producer.mjs", await fs.readFile(new URL("./manual-expected-schema-producer.mjs", import.meta.url)));
  await put("release/contracts/repository-contract-files.v1.json", canonicalJson({ contractVersion: "repository-contract-files.v1", files: ["Dockerfile.runner", "pnpm-lock.yaml", "release/contracts/repository-contract-files.v1.json", "scripts/release/manual-expected-schema-producer.mjs"] }));
  const catalog = await computeMigrationCatalog(repoRoot);
  const contract = await computeRepositoryContract(repoRoot);
  const ciRunRef = "https://github.com/keqi119/subscription-Saas/actions/runs/2801";
  const bases = [nodeBase, pgBase].map((base) => { const [image, hex] = base.split("@sha256:"); return { image, declaredDigest: `sha256:${hex}`, digest: `sha256:${hex}` }; });
  if (baseBinding === "platform") {
    bases[0].digest = "sha256:8607a9064d4a571140998ae9e52a3b3fcf9cff361d04642d5971e6cd76d39e27";
    bases[1].digest = "sha256:7bade6d532592ca8ce7ee32def7399dad2607c4ea5583839fc4352a095a11ea6";
  } else if (baseBinding === "wrong-declared") {
    bases[1].declaredDigest = digest("8");
  }
  const material = { schemaVersion: "build-material-observation.v1", sourceSha, checkoutRef: sourceSha, ciRunRef,
    repositoryContractDigest: contract.digest, migrationCatalogDigest: catalog.digest, policyDigest: digest("f"), promotionEligibility: "trusted-candidate",
    images: ["api", "web", "runner"].map((name, i) => { const image = `ghcr.io/keqi119/subscription-${name}`, d = digest(String(i + 1)); return { name, image, platform: "linux/amd64", digest: d, sourceRevision: sourceSha, baseImageDigests: bases, builderName: "https://mobyproject.org/buildkit@v1", buildAttestationRef: `oci://${image}@${d}#provenance=${digest("c")}`, registrySubject: `${image}@${d}`, buildRunRef: ciRunRef }; }),
    externalActions: [{ name: "actions/checkout", commitSha: "2".repeat(40) }], builder: { name: "https://mobyproject.org/buildkit@v1", provenanceRef: `build-material-attestations:${digest("4")}` }, observedAt: "2026-09-02T16:00:00.000Z" };
  const proof = globalThis.structuredClone(createBuildProof({ sourceSha, images: material.images, migrationCatalog: catalog, repositoryContract: contract, provenance: { generatedAt: material.observedAt, ciRunRef, attestationRef: material.builder.provenanceRef, checkoutRef: sourceSha, buildMaterialObservation: material } }));
  if (baseBinding === "wrong-resolved") {
    proof.provenance.baseImages.find((base) => base.name === "postgres:17.11-bookworm").resolvedDigest = digest("8");
  }
  const calls = [], containers = new Map();
  let ordinal = 0;
  async function runProcess(command, argv, options) {
    calls.push({ command, argv, environment: options.environment });
    assert.equal(options.environment.DOCKER_HOST, undefined);
    assert.equal(options.environment.DATABASE_URL, undefined);
    if (command === "git") return result(argv.includes("status") ? "" : `${fault === "source" ? "9".repeat(40) : sourceSha}\n`);
    if (command === "pnpm") return result("11.4.0\n");
    const operation = argv.find((v) => ["create", "inspect", "start", "stop", "rm", "exec", "cp"].includes(v));
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
      assert.equal(options.stdin.at(-1), 10);
      const envelope = JSON.parse(options.stdin.subarray(0, options.stdin.length - 1));
      const innerCalls = [];
      const innerProcess = async (cmd, args, opts) => {
        innerCalls.push({ cmd, args });
        assert.equal(opts.environment.STAGE1_ACCEPTANCE_MIGRATION_SKIP_DOTENV, "1");
        assert.ok(!("DOCKER_HOST" in opts.environment));
        if (args.includes("--version")) {
          const raw = result(cmd.endsWith("node") ? "v22.18.0\n" : cmd.endsWith("prisma") ? "prisma                  : 7.8.0\n@prisma/client          : 7.8.0\nQuery Engine           : pinned\n" : "psql (PostgreSQL) 17.11\n");
          if (cmd.endsWith("prisma") && fault === "missing-pid") delete raw.pid;
          if (cmd.endsWith("prisma") && fault === "time") raw.preparedAt = raw.spawnedAt = raw.closedAt = new Date(Date.now() - 60000).toISOString();
          return raw;
        }
        if (cmd.endsWith("psql")) {
          const sql = args.at(-1);
          if (sql.includes("pg_control_system")) return result(JSON.stringify({ databaseName: "expected_schema_reference", databaseOid: "16384", systemIdentifier: String(container.ordinal), serverVersion: "17.11", schemaOwner: "pg_database_owner", ownerInventory: [{ objectClass: "schema", objectName: "public", owner: "pg_database_owner" }, ...(container.deployed ? [{ objectClass: "relation", objectName: "_prisma_migrations", owner: "expected_schema_owner" }] : [])], extensions: ["plpgsql"], listenAddresses: "", socketDirectory: opts.environment.REFERENCE_SOCKET_DIRECTORY, dataDirectory: opts.environment.REFERENCE_DATA_DIRECTORY, configuredPort: 5432 }));
          if (sql.includes("_prisma_migrations")) return result(JSON.stringify(catalog.entries.map((e) => ({ name: e.path.split("/").at(-2), checksum: e.sha256.slice(7), finished: true, rolledBack: false, appliedSteps: 1 }))));
          return result();
        }
        if (args.includes("--exit-code")) return result(fault === "diff-marker" ? "No difference detected." : fault === "diff-output" ? "unexpected difference\n" : "", fault === "diff" ? 2 : 0);
        if (args.includes("--script")) return fault === "utf8" ? { ...result(), stdout: Buffer.from([255]) } : result(fault === "large" ? Buffer.alloc(400000, "x") : container.ordinal === 2 && fault === "reproduction" ? "changed\n" : "CREATE TABLE example(id integer PRIMARY KEY);\r\n");
        if (args.includes("deploy")) container.deployed = true;
        return result();
      };
      const output = await runReferenceExpectedSchema(envelope, { repoRoot, runProcess: innerProcess });
      assert.ok(innerCalls.some((c) => c.cmd.endsWith("pg_ctl") && c.args.includes("stop")));
      container.rawBlobs = output.rawBlobs;
      if (fault === "inner-source") output.manifest.sourceDigests.sourceSchemaDigest = digest("9");
      const manifest = Buffer.from(canonicalJson(output.manifest));
      assert.ok(manifest.length < 1048576);
      assert.equal("sourceSchemaBase64" in output.manifest, false);
      assert.equal("scriptBase64" in output.manifest, false);
      await options.onManifest(manifest);
      container.released = true;
      container.done = true;
      return result(Buffer.concat([manifest, Buffer.from("\n")]));
    }
    if (operation === "exec") {
      assert.ok(argv.includes("--user=postgres"));
      assert.ok(argv.includes("/usr/local/bin/node"));
      const id = argv[argv.indexOf("--user=postgres") + 1];
      const rawDigest = argv.at(-1);
      assert.match(rawDigest, /^[0-9a-f]{64}$/u);
      const owner = containers.get(id);
      assert.equal(owner.done, undefined);
      assert.equal(owner.released, undefined);
      let raw = owner.rawBlobs.get(`sha256:${rawDigest}`);
      assert.ok(raw);
      if (fault === "raw-copy") raw = Buffer.from("changed");
      return result(raw);
    }
    if (operation === "cp") throw new Error("docker cp cannot read the tmpfs handoff");
    if (operation === "stop") return result("", fault === "stop" ? 1 : 0);
    if (operation === "rm") { containers.delete(id); return result(`${id}\n`); }
    throw new Error(`unexpected offline process ${command} ${argv.join(" ")}`);
  }
  return { input: { repoRoot, proofBytes: Buffer.from(canonicalJson(proof)), materialBytes: Buffer.from(canonicalJson(material)), buildIdentity: { sourceSha, repository: "keqi119/subscription-Saas", workflowPath: ".github/workflows/docker-images.yml", sourceRef: "refs/heads/main", runId: "2801", runAttempt: 1, protectedEnvironment: "trusted-image-build" } }, runProcess, calls, containers };
}

test("accepts declared image indexes bound to distinct linux/amd64 digests by material and proof", async (t) => {
  const f = await fixture(t, undefined, "platform");
  const output = await produceManualExpectedSchema(f.input, { runProcess: f.runProcess });
  const record = JSON.parse(output.producerRecordBytes);
  assert.equal(record.toolchain.postgresImageDigest, pgBase.split("@")[1]);
  assert.equal(f.calls.filter((c) => c.argv.includes("create")).length, 2);
  assert.equal(f.containers.size, 0);
});

test("downstream provenance validates declared Postgres index through material to resolved proof", async (t) => {
  const f = await fixture(t, undefined, "platform");
  const output = await produceManualExpectedSchema(f.input, { runProcess: f.runProcess });
  const record = JSON.parse(output.producerRecordBytes), proof = JSON.parse(f.input.proofBytes);
  const facts = { build: { buildProofDigest: record.buildProofDigest, proofRawDigest: sha256Bytes(f.input.proofBytes) }, fixed: { proofBytes: f.input.proofBytes, materialBytes: f.input.materialBytes } };
  assert.equal(expectedProvenanceShape(record, facts, proof), "2801");
  const wrongMaterial = JSON.parse(f.input.materialBytes);
  wrongMaterial.images.find((image) => image.name === "runner").baseImageDigests.find((base) => base.image === "postgres:17.11-bookworm").declaredDigest = digest("8");
  assert.throws(() => expectedProvenanceShape(record, { ...facts, fixed: { ...facts.fixed, materialBytes: Buffer.from(canonicalJson(wrongMaterial)) } }, proof), { code: "MANUAL_EXPECTED_SCHEMA_SOURCE_INVALID" });
});

test("rejects a declared index that does not match the pinned Dockerfile", async (t) => {
  const f = await fixture(t, undefined, "wrong-declared");
  await assert.rejects(produceManualExpectedSchema(f.input, { runProcess: f.runProcess }), { code: "MANUAL_EXPECTED_SCHEMA_TOOLCHAIN_INVALID" });
  assert.equal(f.calls.some((c) => c.argv.includes("create")), false);
});

test("rejects a proof resolved digest that differs from bound material", async (t) => {
  const f = await fixture(t, undefined, "wrong-resolved");
  await assert.rejects(produceManualExpectedSchema(f.input, { runProcess: f.runProcess }), { code: "BUILD_PROOF_PROVENANCE_MISMATCH" });
  assert.equal(f.calls.length, 0);
});

test("orchestrates two fresh pinned references and preserves exact subjects with closed unpublished provenance", async (t) => {
  const f = await fixture(t);
  const output = await produceManualExpectedSchema(f.input, { runProcess: f.runProcess });
  assert.equal(f.containers.size, 0);
  assert.equal(f.calls.filter((c) => c.argv.includes("create")).length, 2);
  assert.deepEqual(output.sourceSchemaBytes, Buffer.from("// exact source schema\r\n"));
  assert.deepEqual(output.scriptBytes, Buffer.from("CREATE TABLE example(id integer PRIMARY KEY);\r\n"));
  const record = JSON.parse(output.producerRecordBytes), expectation = JSON.parse(output.schemaExpectationBytes);
  assert.equal(record.recordVersion, "manual-expected-schema-provenance.v1");
  assert.deepEqual(Object.keys(record).sort(), ["recordVersion", "buildProofDigest", "proofRaw", "sourceSha", "ci", "sourceSchema", "config", "lockfile", "migrationCatalogDigest", "toolchain", "expectedScript", "references", "generatedAt", "promotionEligible"].sort());
  assert.ok(output.prismaVersionBytes instanceof Uint8Array);
  assert.ok(output.rawBlobs instanceof Map);
  assert.equal(record.references.length, 2);
  assert.notEqual(record.references[0].referenceRunId, record.references[1].referenceRunId);
  assert.notEqual(record.references[0].identity.cluster.systemIdentifier, record.references[1].identity.cluster.systemIdentifier);
  assert.equal(record.references[0].identity.databaseOid, record.references[1].identity.databaseOid);
  const raw = (ref) => { const b = output.rawBlobs.get(ref.digest); assert.equal(b.length, ref.bytes); assert.equal(sha256Bytes(b), ref.digest); return b; };
  const seen = new Set();
  const checkRefs = (value) => { if (!value || typeof value !== "object") return; if (Object.keys(value).sort().join(",") === "bytes,digest") { raw(value); seen.add(value.digest); return; } for (const v of Object.values(value)) checkRefs(v); };
  checkRefs(record);
  for (const ref of record.references) {
    assert.deepEqual(Object.keys(ref).sort(), ["referenceRunId", "identity", "createdAt", "readbackAt", "creationEvidence", "readbackEvidence", "migrationCatalog", "migrationHead", "migrationOwner", "allowedExtensions", "calls"].sort());
    assert.deepEqual(ref.calls.map((c) => c.tool), ["prisma-version", "prisma-deploy", "prisma-diff", "prisma-script"]);
    for (const call of ref.calls) {
      assert.ok(call.pid > 0);
      assert.deepEqual(Object.keys(call).sort(), ["tool", "argv", "stdout", "stderr", "pid", "preparedAt", "spawnedAt", "closedAt", "exitCode", "signal"].sort());
      assert.ok(ref.createdAt <= call.preparedAt && call.preparedAt <= call.spawnedAt && call.spawnedAt <= call.closedAt && call.closedAt <= ref.readbackAt && ref.readbackAt <= record.generatedAt);
      assert.equal(JSON.parse(raw(call.argv))[0], "/app/apps/release-runner/node_modules/.bin/prisma");
    }
    assert.deepEqual(raw(ref.calls[0].stdout), output.prismaVersionBytes);
    assert.deepEqual(raw(ref.calls[3].stdout), output.scriptBytes);
    assert.equal(raw(ref.calls[2].stdout).toString().trim(), "");
    const creation = JSON.parse(raw(ref.creationEvidence)), readback = JSON.parse(raw(ref.readbackEvidence));
    assert.deepEqual(creation.calls.map((c) => c.tool), ["container-create", "container-inspect", "image-inspect", "node-version", "psql-version", "initdb", "pg-start", "database-create", "identity-before"]);
    assert.deepEqual(readback.calls.map((c) => c.tool), ["identity-after", "migration-readback", "pg-stop", "container-exit-inspect", "container-stop", "container-remove"]);
    checkRefs(creation); checkRefs(readback);
    assert.equal(ref.migrationOwner, "expected_schema_owner");
    assert.equal(ref.identity.cluster.configuredPort, 5432);
    assert.equal(Object.keys(ref.identity.cluster).length, 8);
  }
  assert.deepEqual(new Set(output.rawBlobs.keys()), seen);
  assert.equal(expectation.sourceSchemaDigest, sha256Bytes(output.sourceSchemaBytes));
  assert.equal(expectation.script.digest, sha256Bytes(output.scriptBytes));
  assert.ok(expectation.prismaVersion.includes("Query Engine"));
  assert.deepEqual(output.producerRecordBytes, Buffer.from(canonicalJson(record)));
  assert.equal(record.promotionEligible, false);
  assert.equal("admission" in record, false);
});

test("rejects nonempty diff stdout even when the real command exits zero", async (t) => {
  const f = await fixture(t, "diff-output");
  await assert.rejects(produceManualExpectedSchema(f.input, { runProcess: f.runProcess }), { code: "MANUAL_EXPECTED_SCHEMA_DIFF_INVALID" });
  assert.equal(f.containers.size, 0);
});

test("accepts Prisma's fixed no-difference marker while retaining exact raw stdout", async (t) => {
  const f = await fixture(t, "diff-marker");
  const output = await produceManualExpectedSchema(f.input, { runProcess: f.runProcess });
  const record = JSON.parse(output.producerRecordBytes);
  for (const reference of record.references) {
    const ref = reference.calls.find((call) => call.tool === "prisma-diff").stdout;
    assert.equal(output.rawBlobs.get(ref.digest).toString(), "No difference detected.");
  }
  assert.equal(f.containers.size, 0);
});

test("downstream diff reader accepts only empty or the fixed no-difference marker", () => {
  assert.equal(expectedNoDifferenceOutput(Buffer.alloc(0)), true);
  assert.equal(expectedNoDifferenceOutput(Buffer.from("No difference detected.")), true);
  assert.equal(expectedNoDifferenceOutput(Buffer.from("No difference detected.\n")), true);
  assert.equal(expectedNoDifferenceOutput(Buffer.from("unexpected difference\n")), false);
  assert.equal(expectedNoDifferenceOutput(Buffer.from("No difference detected.\nALTER TABLE x;")), false);
});

test("reads exact and empty raw subjects from tmpfs without an aggregate base64 packet", async (t) => {
  const f = await fixture(t, "large");
  const output = await produceManualExpectedSchema(f.input, { runProcess: f.runProcess });
  assert.equal(output.sourceSchemaBytes.length, 462831);
  assert.equal(output.scriptBytes.length, 400000);
  assert.ok(output.producerRecordBytes.length <= 1048576);
  assert.ok(f.calls.some((c) => c.argv.includes("exec")));
  assert.equal(f.calls.some((c) => c.argv.includes("cp")), false);
  assert.ok([...output.rawBlobs.values()].some((raw) => raw.length === 0));
  assert.ok([...output.rawBlobs.values()].reduce((sum, b) => sum + b.length, 0) > 1048576);
  assert.equal(f.containers.size, 0);
});

test("rejects missing real PID, pre-creation process times and altered streamed raw bytes", async (t) => {
  for (const fault of ["missing-pid", "time", "raw-copy"]) {
    const f = await fixture(t, fault);
    await assert.rejects(produceManualExpectedSchema(f.input, { runProcess: f.runProcess }));
    assert.equal(f.containers.size, 0, fault);
  }
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
