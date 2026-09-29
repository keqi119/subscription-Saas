import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  utimes,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { compileAllSchemas, sha256Canonical, validateContract } from "../src/index.mjs";
import { finalDatabaseEnvelopeFixture } from "../../../apps/release-runner/test/fixtures/final-database-envelope.mjs";

test("R3 fixed target policy preserves H1 and restricts hosted destination topology", async () => {
  const read = async (name) =>
    JSON.parse(await readFile(new URL(`../../../release/contracts/${name}`, import.meta.url)));
  const policy = await read("manual-stage1-r3-target-policy.v1.json"),
    profile = await read("manual-stage1-profile.v2.json"),
    databasePolicies = await read("database-target-policies.v1.json");
  validateContract("manual-stage1-r3-target-policy.v1", policy);
  assert.equal(policy.profileDigest, sha256Canonical(profile));
  assert.ok(databasePolicies.policies.some((p) => p.policyId === policy.databaseTargetPolicyId));
  assert.equal(profile.allowedTargets.length, 1);
  assert.equal(profile.allowedTargets[0].endpointPolicyId, "stage1-r2-synthetic-20260927");
  for (const change of [
    (p) => {
      p.hosted.runnerClass = "self-hosted";
    },
    (p) => {
      p.hosted.workflowRef = "refs/heads/feature";
    },
    (p) => {
      p.hosted.runAttempt = 2;
    },
    (p) => {
      p.hosted.source.jobs.snapshot = "source-fresh";
    },
    (p) => {
      p.hosted.final.callerJobs.snapshot = "final-fresh";
    },
    (p) => {
      p.hosted.final.workflowPath = p.hosted.source.workflowPath;
    },
    (p) => {
      p.transport.engineEndpoint = "tcp://127.0.0.1:2375";
    },
    (p) => {
      p.transport.observerEndpoint = "127.0.0.1:55439";
    },
    (p) => {
      p.workspace.storageDriver = "containerd";
    },
    (p) => {
      p.workspace.containerdSnapshotter = true;
    },
    (p) => {
      p.workspace.dockerDataRootRelative = "../docker";
    },
    (p) => {
      p.workspace.persistentPaths = "host-default";
    },
    (p) => {
      p.workspace.logDriver = "journald";
    },
    (p) => {
      p.workspace.mountRoot = "/tmp";
    },
    (p) => {
      p.workspace.swap = "enabled";
    },
    (p) => {
      p.tls = "disabled";
    },
    (p) => {
      p.approved = true;
    }
  ]) {
    const changed = structuredClone(policy);
    change(changed);
    assert.throws(() => validateContract("manual-stage1-r3-target-policy.v1", changed), {
      code: "CONTRACT_SCHEMA_INVALID"
    });
  }
});

const digest = `sha256:${"a".repeat(64)}`;
const sourceSha = "b".repeat(40);

test("database target catalog accepts its existing policies and rejects mixed environments", async () => {
  const catalog = JSON.parse(
    await readFile(
      new URL("../../../release/contracts/database-target-policies.v1.json", import.meta.url)
    )
  );
  validateContract("database-target-policies.v1", catalog);
  for (const [policyId, field, value] of [
    ["s1-release-compose-ephemeral", "allowedEnvironments", ["ci", "local-controlled"]],
    ["s1-release-ephemeral", "allowedEnvironments", ["ci-fresh", "ci-snapshot"]],
    ["s1-release-compose-ephemeral", "allowedHosts", ["127.0.0.1", "localhost"]]
  ]) {
    const changed = structuredClone(catalog);
    changed.policies.find((p) => p.policyId === policyId)[field] = value;
    assert.throws(() => validateContract("database-target-policies.v1", changed), {
      code: "CONTRACT_SCHEMA_INVALID"
    });
  }
});

function validBuildProof() {
  const image = (name) => ({
    name,
    registry: "ghcr.io/keqi119",
    platform: "linux/amd64",
    imageDigest: digest,
    sourceRevision: sourceSha
  });
  return {
    schemaVersion: "build-proof.v1",
    identity: {
      schemaVersion: "build-proof.identity.v1",
      images: {
        api: image("api"),
        web: image("web"),
        runner: image("runner")
      },
      sourceSha,
      migrationCatalogDigest: digest,
      repositoryContractDigest: digest
    },
    provenance: {
      generatedAt: "2026-09-02T08:00:00.000Z",
      ciRunRef: "github-actions:run/123",
      attestationRef: "attestation:sha256:abc",
      checkoutRef: sourceSha,
      baseImages: [{ name: "node", resolvedDigest: digest }],
      materials: [{ name: "pnpm", reference: "pnpm@11.4.0" }],
      registryResolutionEvidenceDigest: digest
    }
  };
}

test("compiles every registered release Schema", () => {
  const result = compileAllSchemas();
  assert.ok(result.schemaIds.length >= 10);
  assert.ok(result.schemaIds.includes("build-proof.v1"));
  assert.ok(result.schemaIds.includes("controlled-target-record.v1"));
});

test("registers the closed final database launch envelope v2", () => {
  assert.ok(compileAllSchemas().schemaIds.includes("database-test-launch-envelope.v2"));
});

test("final database envelope v2 accepts both chains and closes nested launch facts", async () => {
  for (const chain of ["fresh", "snapshot"]) {
    const { envelope, manifest } = await finalDatabaseEnvelopeFixture(chain);
    assert.doesNotThrow(() => validateContract("database-test-launch-envelope.v2", envelope));
    assert.equal(Object.keys(envelope.suiteAssignments).length, manifest.suites.length);
    const reject = (change) => {
      const altered = structuredClone(envelope);
      change(altered);
      assert.throws(() => validateContract("database-test-launch-envelope.v2", altered), {
        code: "CONTRACT_SCHEMA_INVALID"
      });
    };
    const ordinary = manifest.suites.find(({ suiteId }) =>
      Object.hasOwn(envelope.suiteAssignments[suiteId].databases ?? {}, "target")
    ).suiteId;
    const lifecycle = "node.release-database-lifecycle.postgres";
    reject((value) => {
      value.phase = "source";
    });
    reject((value) => {
      value.target = value.suiteAssignments[ordinary].databases.target;
    });
    reject((value) => {
      value.suiteAssignments[lifecycle].reservations[0].databaseOid = "3001";
    });
    reject((value) => {
      value.suiteAssignments[ordinary].databases.target.rawPassword = "synthetic-password";
    });
    reject((value) => {
      value.suiteAssignments[ordinary].databases.target.targetLockDigest = "invalid";
    });
    reject((value) => {
      value.postgres.futureField = true;
    });
  }
});

test("accepts a strict build proof", () => {
  assert.doesNotThrow(() => validateContract("build-proof.v1", validBuildProof()));
});

test("published build-proof v1 retains its existing date-format behavior", () => {
  const proof = validBuildProof();
  proof.provenance.generatedAt = "2026-99-99TgarbageZ";
  assert.doesNotThrow(() => validateContract("build-proof.v1", proof));
});

test("rejects an unregistered Schema version", () => {
  assert.throws(() => validateContract("build-proof.v2", validBuildProof()), {
    code: "CONTRACT_SCHEMA_UNREGISTERED"
  });
});

test("rejects additional proof properties", () => {
  const proof = validBuildProof();
  proof.untrusted = true;
  assert.throws(() => validateContract("build-proof.v1", proof), {
    code: "CONTRACT_SCHEMA_INVALID"
  });
});

test("rejects non-lowercase SHA-256 values", () => {
  const proof = validBuildProof();
  proof.identity.repositoryContractDigest = `sha256:${"A".repeat(64)}`;
  assert.throws(() => validateContract("build-proof.v1", proof), {
    code: "CONTRACT_SCHEMA_INVALID"
  });
});

test("validates the Task 0 PostgreSQL image contract", () => {
  assert.doesNotThrow(() =>
    validateContract("postgres-image.v1", {
      contractVersion: "postgres-image.v1",
      repository: "docker.io/library/postgres",
      tag: "17-bookworm",
      platform: "linux/amd64",
      resolvedDigest: digest,
      serverVersionMajor: 17
    })
  );
});

test("rejects a schema whose filename and id differ", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "schema-parity-"));
  const schemas = path.join(root, "release", "contracts", "schemas");
  await mkdir(schemas, { recursive: true });
  await writeFile(
    path.join(schemas, "wrong.v1.schema.json"),
    JSON.stringify({ $id: "right.v1", type: "object" })
  );
  assert.throws(() => compileAllSchemas(root), { code: "CONTRACT_SCHEMA_FILENAME_ID_MISMATCH" });
  await rm(root, { recursive: true, force: true });
});

test("filename parity retains the existing duplicate-ID error", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "schema-duplicate-"));
  try {
    const schemas = path.join(root, "release/contracts/schemas");
    await mkdir(schemas, { recursive: true });
    for (const filename of ["a.v1", "b.v1"]) {
      await writeFile(
        path.join(schemas, `${filename}.schema.json`),
        JSON.stringify({ $id: "a.v1", type: "object" })
      );
    }
    assert.throws(() => compileAllSchemas(root), { code: "CONTRACT_SCHEMA_ID_DUPLICATE" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function schemaFixture(t, type = "string") {
  const root = await mkdtemp(path.join(os.tmpdir(), "schema-cache-"));
  t.after(async () => {
    const absolute = path.resolve(root);
    assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
    assert.ok(path.basename(absolute).startsWith("schema-cache-"));
    await rm(absolute, { recursive: true, force: true });
  });
  const directory = path.join(root, "release/contracts/schemas");
  const file = path.join(directory, "probe.v1.schema.json");
  await mkdir(directory, { recursive: true });
  await writeFile(file, JSON.stringify({ $id: "probe.v1", type }));
  return { root, repoRoot: root, directory, file };
}

test("reuses identical schema compilation while validating every new payload", async (t) => {
  const fixture = await schemaFixture(t);
  const compile = t.mock.method(Ajv2020.prototype, "compile");
  validateContract("probe.v1", "first", fixture);
  const firstCompilationCount = compile.mock.callCount();
  assert.ok(firstCompilationCount > 0);
  validateContract("probe.v1", "second", fixture);
  assert.throws(() => validateContract("probe.v1", 42, fixture), {
    code: "CONTRACT_SCHEMA_INVALID"
  });
  assert.throws(() => validateContract("missing.v1", "third", fixture), {
    code: "CONTRACT_SCHEMA_UNREGISTERED"
  });
  assert.equal(compile.mock.callCount(), firstCompilationCount);
  compileAllSchemas(fixture.root);
  assert.ok(compile.mock.callCount() > firstCompilationCount);
  const compiledAgain = compile.mock.callCount();
  compileAllSchemas(fixture.root);
  assert.ok(compile.mock.callCount() > compiledAgain);
});

test("observes schema replacement even when file size and mtime are unchanged", async (t) => {
  const fixture = await schemaFixture(t);
  validateContract("probe.v1", "before", fixture);
  const before = await stat(fixture.file);
  await writeFile(fixture.file, JSON.stringify({ $id: "probe.v1", type: "number" }));
  await utimes(fixture.file, before.atime, before.mtime);
  assert.equal((await stat(fixture.file)).size, before.size);
  assert.throws(() => validateContract("probe.v1", "after", fixture), {
    code: "CONTRACT_SCHEMA_INVALID"
  });
  validateContract("probe.v1", 42, fixture);
});

test("still rejects an unrelated invalid schema and recovers after its removal", async (t) => {
  const fixture = await schemaFixture(t);
  validateContract("probe.v1", "before", fixture);
  const other = path.join(fixture.directory, "other.v1.schema.json");
  await writeFile(other, JSON.stringify({ $id: "other.v1", type: "invalid-type" }));
  assert.throws(() => validateContract("probe.v1", "invalid schema", fixture));
  await writeFile(other, JSON.stringify({ type: "string" }));
  assert.throws(() => validateContract("probe.v1", "missing id", fixture), {
    code: "CONTRACT_SCHEMA_ID_MISSING"
  });
  await unlink(other);
  validateContract("probe.v1", "recovered", fixture);
});

test("observes added, renamed and removed schema files after a successful validation", async (t) => {
  const fixture = await schemaFixture(t);
  validateContract("probe.v1", "before", fixture);
  const added = path.join(fixture.directory, "added.v1.schema.json");
  const renamed = path.join(fixture.directory, "renamed.v1.schema.json");
  await writeFile(added, JSON.stringify({ $id: "added.v1", type: "number" }));
  validateContract("added.v1", 42, fixture);
  await rename(added, renamed);
  assert.throws(() => validateContract("probe.v1", "renamed", fixture), {
    code: "CONTRACT_SCHEMA_FILENAME_ID_MISMATCH"
  });
  await unlink(renamed);
  await unlink(fixture.file);
  assert.throws(() => validateContract("probe.v1", "removed", fixture), {
    code: "CONTRACT_SCHEMA_UNREGISTERED"
  });
  await rmdir(fixture.directory);
  assert.throws(() => validateContract("probe.v1", "unreadable", fixture), { code: "ENOENT" });
  await mkdir(fixture.directory);
  await writeFile(fixture.file, JSON.stringify({ $id: "probe.v1", type: "string" }));
  validateContract("probe.v1", "restored", fixture);
});

test("still rejects duplicate schema ids introduced after a successful validation", async (t) => {
  const fixture = await schemaFixture(t);
  validateContract("probe.v1", "before", fixture);
  const nested = path.join(fixture.directory, "nested");
  await mkdir(nested);
  await writeFile(
    path.join(nested, "probe.v1.schema.json"),
    JSON.stringify({ $id: "probe.v1", type: "string" })
  );
  assert.throws(() => validateContract("probe.v1", "duplicate", fixture), {
    code: "CONTRACT_SCHEMA_ID_DUPLICATE"
  });
});

test("does not share validators between roots or keep a result for changed input", async (t) => {
  const strings = await schemaFixture(t);
  const numbers = await schemaFixture(t, "number");
  const compile = t.mock.method(Ajv2020.prototype, "compile");
  validateContract("probe.v1", "first root", strings);
  validateContract("probe.v1", 42, numbers);
  assert.throws(() => validateContract("probe.v1", "wrong root", numbers), {
    code: "CONTRACT_SCHEMA_INVALID"
  });
  const afterSecondRoot = compile.mock.callCount();
  validateContract("probe.v1", "back to first root", strings);
  assert.ok(compile.mock.callCount() > afterSecondRoot);
  await writeFile(strings.file, "{");
  assert.throws(() => validateContract("probe.v1", "bad JSON", strings), SyntaxError);
  await writeFile(strings.file, JSON.stringify({ $id: "probe.v1", type: "number" }));
  validateContract("probe.v1", 42, strings);
});

test("compares schema bytes even when distinct bytes decode to the same JSON string", async (t) => {
  const fixture = await schemaFixture(t);
  const compile = t.mock.method(Ajv2020.prototype, "compile");
  const bytes = (byte) =>
    Buffer.concat([
      Buffer.from('{"$id":"probe.v1","const":"'),
      Buffer.from([byte]),
      Buffer.from('"}')
    ]);
  assert.equal(bytes(0x80).toString("utf8"), bytes(0x81).toString("utf8"));
  await writeFile(fixture.file, bytes(0x80));
  validateContract("probe.v1", "\ufffd", fixture);
  const firstCompilationCount = compile.mock.callCount();
  await writeFile(fixture.file, bytes(0x81));
  validateContract("probe.v1", "\ufffd", fixture);
  assert.ok(compile.mock.callCount() > firstCompilationCount);
});

function r3Allocation(stage = "target-create", phase = "source", chain = "fresh") {
  const digest = `sha256:${"a".repeat(64)}`;
  const value = {
    schemaVersion: "manual-runner-evidence.v2",
    kind: "attempt-allocation",
    profileDigest: digest,
    recordedAt: "2026-09-28T00:00:00.000Z",
    promotionEligible: false,
    sessionId: "00000000-0000-4000-8000-000000000001",
    sessionNonce: "a".repeat(64),
    sessionRecordDigest: digest,
    operationId: "00000000-0000-4000-8000-000000000002",
    idempotencyKey: "r3-creation",
    attemptId: "00000000-0000-4000-8000-000000000003",
    runId: "00000000-0000-4000-8000-000000000004",
    stage,
    phase,
    chain,
    allocatedAt: "2026-09-28T00:00:00.000Z",
    sourceSha: "a".repeat(40),
    buildProofDigest: digest,
    targetPolicyDigest: digest,
    creationSpecDigest: digest,
    jobAdmissionDigest: digest,
    predecessorExecutionRecordDigest: null
  };
  if (stage === "snapshot-consumer") {
    Object.assign(value, {
      chain: "snapshot",
      predecessorExecutionRecordDigest: digest,
      destinationAdmissionDigest: digest,
      scopeAuthorizationDigest: digest,
      input: { inputReference: "00000000-0000-4000-8000-000000000005", inputIndexDigest: digest }
    });
    if (phase === "final") value.matchingSourceEvidenceDigest = digest;
  }
  return value;
}

test("R3 ALLOCATION closes creation and snapshot-consumer branches without future facts", () => {
  for (const phase of ["source", "final"]) {
    for (const chain of ["fresh", "snapshot"])
      validateContract("manual-runner-evidence.v2", r3Allocation("target-create", phase, chain));
    validateContract("manual-runner-evidence.v2", r3Allocation("snapshot-consumer", phase));
  }
});

test("R3 ALLOCATION rejects mixed legacy creation and consumer evidence", () => {
  const digest = `sha256:${"b".repeat(64)}`;
  for (const [stage, mutate] of [
    [
      "target-create",
      (v) => {
        v.destinationAdmissionDigest = digest;
      }
    ],
    [
      "target-create",
      (v) => {
        v.predecessorExecutionRecordDigest = digest;
      }
    ],
    [
      "target-create",
      (v) => {
        v.matchingSourceEvidenceDigest = digest;
      }
    ],
    [
      "target-create",
      (v) => {
        v.targetIntent = { databaseName: "legacy" };
      }
    ],
    [
      "target-create",
      (v) => {
        v.phase = "apply";
      }
    ],
    [
      "target-create",
      (v) => {
        delete v.sessionRecordDigest;
      }
    ],
    [
      "snapshot-consumer",
      (v) => {
        v.chain = "fresh";
      }
    ],
    [
      "snapshot-consumer",
      (v) => {
        v.predecessorExecutionRecordDigest = null;
      }
    ],
    [
      "snapshot-consumer",
      (v) => {
        delete v.destinationAdmissionDigest;
      }
    ],
    [
      "snapshot-consumer",
      (v) => {
        v.input.path = "/caller/payload";
      }
    ],
    [
      "snapshot-consumer",
      (v) => {
        v.matchingSourceEvidenceDigest = digest;
      }
    ],
    [
      "snapshot-consumer",
      (v) => {
        v.phase = "final";
      }
    ]
  ]) {
    const value = r3Allocation(stage);
    mutate(value);
    assert.throws(() => validateContract("manual-runner-evidence.v2", value), {
      code: "CONTRACT_SCHEMA_INVALID"
    });
  }
});

test("caller mutation of error details cannot change future const or enum validation", async (t) => {
  const fixture = await schemaFixture(t);
  for (const keyword of ["const", "enum"]) {
    const allowed = [{ stage: ["verify", "migrate"] }];
    await writeFile(
      fixture.file,
      JSON.stringify({
        $id: "probe.v1",
        [keyword]: keyword === "const" ? allowed : [allowed]
      })
    );
    validateContract("probe.v1", allowed, fixture);
    let failure;
    try {
      validateContract("probe.v1", [{ stage: ["unsafe"] }], fixture);
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.code, "CONTRACT_SCHEMA_INVALID");
    const params = failure.details.errors.find((error) => error.keyword === keyword).params;
    const exposed = keyword === "const" ? params.allowedValue : params.allowedValues[0];
    // Error details remain mutable for callers, but must not alias the compiled schema.
    exposed[0].stage.splice(0, 2, "unsafe");
    validateContract("probe.v1", allowed, fixture);
    assert.throws(() => validateContract("probe.v1", [{ stage: ["unsafe"] }], fixture), {
      code: "CONTRACT_SCHEMA_INVALID"
    });
  }
});
