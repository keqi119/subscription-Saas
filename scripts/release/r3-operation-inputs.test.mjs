import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import childProcess from "node:child_process";
import { promisify } from "node:util";
import { createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import * as inputs from "./r3-operation-inputs.mjs";
import { encodeManualJson } from "../../packages/release-foundation/src/manual-stage1-contracts.mjs";
import { sha256Bytes } from "../../packages/release-foundation/src/digest.mjs";
import {
  encodeR3HostedSshPrivateKey,
  decodeR3HostedSshPrivateKey
} from "./r3-operation-inputs.mjs";

const exec = promisify(execFile);

test("temporary Ed25519 key encodings bind SSH and signing to the same key", async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const bytes = encodeR3HostedSshPrivateKey(privateKey);
  const parsed = decodeR3HostedSshPrivateKey(bytes);
  assert.deepEqual(
    parsed.export({ format: "der", type: "pkcs8" }),
    privateKey.export({ format: "der", type: "pkcs8" })
  );
  const payload = Buffer.from("stage1 evidence from the actual temporary job key");
  assert.equal(verify(null, payload, publicKey, sign(null, payload, parsed)), true);

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "r3-job-key-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "forwarding.key");
  await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  const { stdout, stderr } = await exec("ssh-keygen", ["-y", "-f", file], {
    timeout: 10000,
    maxBuffer: 4096,
    windowsHide: true
  });
  assert.equal(stderr, "");
  const [algorithm, publicBlob] = stdout.trim().split(" ");
  assert.equal(algorithm, "ssh-ed25519");
  const rawPublic = createPublicKey(parsed).export({ format: "der", type: "spki" }).subarray(-32);
  assert.deepEqual(Buffer.from(publicBlob, "base64").subarray(-32), rawPublic);

  assert.throws(() => encodeR3HostedSshPrivateKey(publicKey), {
    code: "R3_OPERATION_INPUT_INVALID"
  });
  const body = Buffer.from(bytes.toString().split("\n").slice(1, -2).join(""), "base64");
  const publicOffset = body.indexOf(rawPublic);
  assert.ok(publicOffset > 0);
  body[publicOffset] ^= 1;
  const changed = Buffer.from(
    "-----BEGIN OPENSSH PRIVATE KEY-----\n" +
      body
        .toString("base64")
        .match(/.{1,70}/gu)
        .join("\n") +
      "\n-----END OPENSSH PRIVATE KEY-----\n"
  );
  assert.throws(() => decodeR3HostedSshPrivateKey(changed), {
    code: "R3_OPERATION_INPUT_INVALID"
  });
  assert.throws(() => decodeR3HostedSshPrivateKey(Buffer.concat([bytes, Buffer.from("extra")])));
});

test("source fresh spec writer derives H2 fields and preserves create-only inputs", async (t) => {
  const directory = `/dev/shm/r3-input-writer-${randomUUID()}`;
  await fs.mkdir(directory, { mode: 0o700 });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(`${directory}/inputs`, { mode: 0o700 });
  await fs.mkdir(`${directory}/inputs/build`, { mode: 0o700 });
  const policy = JSON.parse(
    await fs.readFile(
      new URL("../../release/contracts/manual-stage1-r3-target-policy.v1.json", import.meta.url)
    )
  );
  const proof = encodeManualJson({ synthetic: "H2 proof" }),
    material = encodeManualJson({ synthetic: "H2 material" });
  const proofRawDigest = sha256Bytes(proof),
    materialRawDigest = sha256Bytes(material);
  await fs.writeFile(`${directory}/inputs/build/${proofRawDigest.slice(7)}.proof.json`, proof, {
    mode: 0o600
  });
  await fs.writeFile(
    `${directory}/inputs/build/${materialRawDigest.slice(7)}.material.json`,
    material,
    { mode: 0o600 }
  );
  const expiresAt = new Date(Date.now() + 60000).toISOString();
  let opens = 0,
    closes = 0;
  // H1/H2 readers are synthetic here; the writer's create-only files are actual tmpfs.
  const mocked = mock.module("./manual-stage1-trust.mjs", {
    namedExports: {
      loadFixedManualProfile: async () => ({
        ownerId: "keqi119",
        expiresAt,
        storage: { archiveRoot: directory }
      }),
      readFixedR3TargetPolicy: async (value) => {
        assert.deepEqual(value.proofBytes, proof);
        assert.deepEqual(value.materialBytes, material);
        return {
          profileDigest: policy.profileDigest,
          policy,
          policyRawDigest: sha256Bytes(Buffer.from("synthetic policy")),
          sourceSha: "a".repeat(40),
          build: { buildProofDigest: `sha256:${"8".repeat(64)}` },
          recheck: async () => {},
          close: async () => {
            closes++;
          }
        };
      },
      readFixedR3CreationSpec: async ({ operationRef }) => {
        opens++;
        const spec = JSON.parse(
          await fs.readFile(`${directory}/inputs/r3/${operationRef}/creation-spec.json`)
        );
        assert.equal(spec.ownerId, "keqi119");
        assert.equal(spec.sourceSha, "a".repeat(40));
        assert.equal(spec.buildProofDigest, `sha256:${"8".repeat(64)}`);
        return {
          spec,
          recheck: async () => {},
          close: async () => {
            closes++;
          }
        };
      },
      readFixedR3JobAdmission: async ({ operationRef }) => {
        const bytes = await fs.readFile(
          `${directory}/inputs/r3/${operationRef}/job-admission.json`
        );
        assert.equal(JSON.parse(bytes).operationRef, operationRef);
        return { rawInputs: { admission: bytes }, recheck: async () => {}, close: async () => {} };
      }
    }
  });
  t.after(() => mocked.restore());
  const input = {
    repoRoot: "/synthetic-checked-repo",
    operationRef: randomUUID(),
    proofRawDigest,
    materialRawDigest,
    capacityBytes: 64 * 1048576,
    expiresAt
  };
  const bytes = await inputs.prepareR3SourceFreshSpec(input);
  const spec = JSON.parse(bytes);
  assert.equal(spec.phase, "source");
  assert.equal(spec.chain, "fresh");
  assert.equal(spec.workspace.id, input.operationRef.replaceAll("-", ""));
  assert.equal(opens, 1);
  assert.equal(closes, 2);
  await assert.rejects(inputs.prepareR3SourceFreshSpec(input), {
    code: "R3_OPERATION_INPUT_INVALID"
  });
  await assert.rejects(inputs.prepareR3SourceFreshSpec({ ...input, sourceSha: "b".repeat(40) }), {
    code: "R3_OPERATION_INPUT_INVALID"
  });
  await assert.rejects(
    inputs.prepareR3SourceFreshSpec({ ...input, proofRawDigest: `sha256:${"0".repeat(64)}` }),
    { code: "R3_OPERATION_INPUT_INVALID" }
  );
  assert.deepEqual(
    await fs.readFile(`${directory}/inputs/r3/${input.operationRef}/creation-spec.json`),
    bytes
  );
  const originalRef = randomUUID(),
    racedInput = { ...input, operationRef: originalRef };
  const racing = inputs.prepareR3SourceFreshSpec(racedInput);
  racedInput.operationRef = randomUUID();
  assert.equal(JSON.parse(await racing).operationRef, originalRef);
  const snapshotInput = { ...input, operationRef: randomUUID() };
  const snapshotBytes = await inputs.prepareR3SourceSnapshotSpec(snapshotInput);
  assert.equal(JSON.parse(snapshotBytes).chain, "snapshot");
  assert.equal(JSON.parse(snapshotBytes).phase, "source");
  await assert.rejects(
    inputs.importR3SourceFreshJob({
      repoRoot: input.repoRoot,
      operationRef: snapshotInput.operationRef,
      runId: "1234"
    }),
    { code: "R3_OPERATION_INPUT_INVALID" }
  );
  await assert.rejects(
    inputs.importR3SourceSnapshotJob({
      repoRoot: input.repoRoot,
      operationRef: input.operationRef,
      runId: "1234"
    }),
    { code: "R3_OPERATION_INPUT_INVALID" }
  );
  let admitted = encodeManualJson({
    operationRef: input.operationRef,
    sourceSha: spec.sourceSha,
    creationSpecDigest: sha256Bytes(bytes),
    ci: { runId: "1234", runAttempt: 1 }
  });
  const zipScript =
    "import io,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,'w'); z.writestr('job-admission.json',sys.argv[1]); z.close(); sys.stdout.buffer.write(b.getvalue())";
  let zip = (await exec("python3", ["-c", zipScript, admitted.toString()], { encoding: "buffer" }))
    .stdout;
  const actualExecFile = childProcess.execFile;
  const calls = [];
  let importedOperationRef = input.operationRef;
  const commandMock = mock.method(childProcess, "execFile", (file, args, options, callback) => {
    if (file !== "gh") return actualExecFile(file, args, options, callback);
    calls.push(args);
    const body = args.at(-1).endsWith("/zip")
      ? zip
      : Buffer.from(
          JSON.stringify({
            total_count: 1,
            artifacts: [
              {
                id: 789,
                name: `stage1-r3-job-${importedOperationRef}-1234-1`,
                expired: false,
                size_in_bytes: zip.length,
                workflow_run: { id: 1234, head_sha: spec.sourceSha }
              }
            ]
          })
        );
    queueMicrotask(() => callback(null, body, Buffer.alloc(0)));
    return { stdin: { end() {} } };
  });
  t.after(() => commandMock.mock.restore());
  const imported = await inputs.importR3SourceFreshJob({
    repoRoot: input.repoRoot,
    operationRef: input.operationRef,
    runId: "1234"
  });
  assert.deepEqual(imported, admitted);
  assert.equal(calls.length, 2);
  await assert.rejects(
    inputs.importR3SourceFreshJob({
      repoRoot: input.repoRoot,
      operationRef: input.operationRef,
      runId: "1234"
    }),
    { code: "R3_OPERATION_INPUT_INVALID" }
  );
  importedOperationRef = snapshotInput.operationRef;
  admitted = encodeManualJson({
    ...JSON.parse(admitted),
    operationRef: importedOperationRef,
    creationSpecDigest: sha256Bytes(snapshotBytes)
  });
  zip = (await exec("python3", ["-c", zipScript, admitted.toString()], { encoding: "buffer" }))
    .stdout;
  assert.deepEqual(
    await inputs.importR3SourceSnapshotJob({
      repoRoot: input.repoRoot,
      operationRef: importedOperationRef,
      runId: "1234"
    }),
    admitted
  );
  for (const chain of ["fresh", "snapshot"]) {
    const finalInput = { ...input, operationRef: randomUUID() };
    const prepare =
      chain === "fresh" ? inputs.prepareR3FinalFreshSpec : inputs.prepareR3FinalSnapshotSpec;
    const finalBytes = await prepare(finalInput);
    assert.equal(JSON.parse(finalBytes).phase, "final");
    assert.equal(JSON.parse(finalBytes).chain, chain);
    const importInput = {
      repoRoot: input.repoRoot,
      operationRef: finalInput.operationRef,
      runId: "1234"
    };
    await assert.rejects(inputs.importR3SourceFreshJob(importInput), {
      code: "R3_OPERATION_INPUT_INVALID"
    });
    importedOperationRef = finalInput.operationRef;
    admitted = encodeManualJson({
      ...JSON.parse(admitted),
      operationRef: importedOperationRef,
      creationSpecDigest: sha256Bytes(finalBytes)
    });
    zip = (await exec("python3", ["-c", zipScript, admitted.toString()], { encoding: "buffer" }))
      .stdout;
    const importFinal =
      chain === "fresh" ? inputs.importR3FinalFreshJob : inputs.importR3FinalSnapshotJob;
    assert.deepEqual(await importFinal(importInput), admitted);
  }
});

test("fixed hosted key holder binds actual files, job and machine and rejects replacement", async (t) => {
  assert.equal(process.platform, "linux", "run this security boundary on Linux");
  assert.equal(process.getuid(), 0);
  const operationRef = randomUUID();
  const id = operationRef.replaceAll("-", "");
  const directory = `/dev/shm/stage1-keys/r3-job-${id}`;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const policy = JSON.parse(
    await fs.readFile(
      new URL("../../release/contracts/manual-stage1-r3-target-policy.v1.json", import.meta.url)
    )
  );
  const now = Date.now();
  const spec = {
    schemaVersion: "manual-r3-creation-spec.v1",
    operationRef,
    profileDigest: policy.profileDigest,
    ownerId: "keqi119",
    sourceSha: "a".repeat(40),
    buildProofDigest: `sha256:${"2".repeat(64)}`,
    proofRawDigest: `sha256:${"3".repeat(64)}`,
    materialRawDigest: `sha256:${"4".repeat(64)}`,
    targetPolicyDigest: `sha256:${"5".repeat(64)}`,
    phase: "source",
    chain: "fresh",
    createdAt: new Date(now - 10000).toISOString(),
    expiresAt: new Date(now + 120000).toISOString(),
    workspace: {
      id,
      capacityBytes: 64 * 1048576,
      backingFile: `/var/lib/stage1-snapshots/${id}.luks`,
      mountPath: `/srv/stage1-snapshot/${id}`,
      keyFile: `/dev/shm/stage1-keys/${id}.key`,
      mapperName: `s1snap_${id}`
    },
    cleanup: "stop-owned-engine-and-remove-workspace"
  };
  const specBytes = encodeManualJson(spec);
  const machine = (await fs.readFile("/etc/machine-id", "utf8")).trim();
  const job = {
    schemaVersion: "manual-r3-job-admission.v1",
    operationRef,
    profileDigest: spec.profileDigest,
    ownerId: spec.ownerId,
    creationSpecDigest: sha256Bytes(specBytes),
    buildProofDigest: spec.buildProofDigest,
    sourceSha: spec.sourceSha,
    phase: spec.phase,
    chain: spec.chain,
    generatedAt: new Date(now - 5000).toISOString(),
    expiresAt: spec.expiresAt,
    ci: {
      repository: policy.hosted.repository,
      repositoryId: policy.hosted.repositoryId,
      runId: "1234",
      runAttempt: 1,
      workflowPath: policy.hosted.source.workflowPath,
      callerWorkflowPath: policy.hosted.source.workflowPath,
      jobKey: "source-fresh",
      jobId: "5678",
      jobName: "source-fresh",
      environment: policy.hosted.source.environment,
      runnerClass: "github-hosted"
    },
    host: {
      machineIdFingerprint: sha256Bytes(
        Buffer.from(`subscription-saas/linux-machine-id/v1\n${machine}`)
      ),
      forwardingPublicKeyPem: publicKey.export({ format: "pem", type: "spki" }),
      forwardingKeyFingerprint: sha256Bytes(publicKey.export({ format: "der", type: "spki" })),
      runnerId: 1,
      runnerName: "synthetic-current-job"
    }
  };
  const environment = {
    GITHUB_ACTIONS: "true",
    RUNNER_OS: "Linux",
    GITHUB_REPOSITORY: job.ci.repository,
    GITHUB_REPOSITORY_ID: job.ci.repositoryId,
    GITHUB_SHA: spec.sourceSha,
    GITHUB_RUN_ID: job.ci.runId,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_JOB: job.ci.jobKey,
    RUNNER_NAME: job.host.runnerName,
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: `${job.ci.repository}/${job.ci.callerWorkflowPath}@refs/heads/main`
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, environment);
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.mkdir(`${directory}/transfer`, { mode: 0o700 });
  for (const [name, bytes] of Object.entries({
    "creation-spec.json": specBytes,
    "job-admission.json": encodeManualJson(job),
    "forwarding.key": encodeR3HostedSshPrivateKey(privateKey),
    "signing-key.pem": privateKey.export({ format: "pem", type: "pkcs8" })
  })) {
    await fs.writeFile(`${directory}/${name}`, bytes, { flag: "wx", mode: 0o600 });
  }
  const held = await inputs.readR3HostedOperationKey({ operationRef });
  t.after(() => held.close());
  assert.equal(held.sshPrivateKeyPath, `${directory}/forwarding.key`);
  assert.deepEqual(
    createPublicKey(held.privateKey).export({ format: "der", type: "spki" }),
    publicKey.export({ format: "der", type: "spki" })
  );
  await held.recheck();
  // Expected transport writes must not invalidate its stable parent or key files.
  await fs.writeFile(`${directory}/transfer/creation.bundle.json`, "synthetic transport", {
    flag: "wx",
    mode: 0o600
  });
  await held.recheck();
  process.env.GITHUB_REF = "refs/heads/other";
  await assert.rejects(held.recheck(), { code: "R3_OPERATION_INPUT_INVALID" });
  process.env.GITHUB_REF = "refs/heads/main";
  await assert.rejects(
    inputs.readR3HostedOperationKey({ operationRef, keyPath: `${directory}/forwarding.key` }),
    { code: "R3_OPERATION_INPUT_INVALID" }
  );
  await held.close();
  assert.throws(() => held.privateKey, { code: "R3_OPERATION_INPUT_INVALID" });
  await fs.writeFile(
    `${directory}/signing-key.pem`,
    generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" })
  );
  await assert.rejects(inputs.readR3HostedOperationKey({ operationRef }), {
    code: "R3_OPERATION_INPUT_INVALID"
  });
  await fs.writeFile(
    `${directory}/signing-key.pem`,
    privateKey.export({ format: "pem", type: "pkcs8" })
  );
  const replaced = await inputs.readR3HostedOperationKey({ operationRef });
  t.after(() => replaced.close());
  await fs.rename(`${directory}/forwarding.key`, `${directory}/forwarding.old`);
  await fs.writeFile(`${directory}/forwarding.key`, encodeR3HostedSshPrivateKey(privateKey), {
    flag: "wx",
    mode: 0o600
  });
  await assert.rejects(replaced.recheck(), { code: "R3_OPERATION_INPUT_INVALID" });

  // Hosted producer: real new files/key/machine, only GitHub HTTP is synthetic.
  const preparedRef = randomUUID(),
    preparedId = preparedRef.replaceAll("-", "");
  const preparedDir = `/dev/shm/stage1-keys/r3-job-${preparedId}`;
  t.after(() => fs.rm(preparedDir, { recursive: true, force: true }));
  const preparedSpec = {
    ...spec,
    operationRef: preparedRef,
    targetPolicyDigest: sha256Bytes(
      await fs.readFile(
        new URL("../../release/contracts/manual-stage1-r3-target-policy.v1.json", import.meta.url)
      )
    ),
    workspace: {
      ...spec.workspace,
      id: preparedId,
      backingFile: `/var/lib/stage1-snapshots/${preparedId}.luks`,
      mountPath: `/srv/stage1-snapshot/${preparedId}`,
      keyFile: `/dev/shm/stage1-keys/${preparedId}.key`,
      mapperName: `s1snap_${preparedId}`
    }
  };
  const tokenBefore = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "synthetic-token-not-a-credential";
  t.after(() => {
    if (tokenBefore === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = tokenBefore;
  });
  const run = {
    id: 1234,
    run_attempt: 1,
    head_sha: spec.sourceSha,
    head_branch: "main",
    path: job.ci.workflowPath,
    status: "in_progress",
    conclusion: null,
    repository: { id: Number(job.ci.repositoryId), full_name: job.ci.repository },
    head_repository: { id: Number(job.ci.repositoryId), full_name: job.ci.repository }
  };
  const apiJob = {
    id: 5678,
    run_id: 1234,
    head_sha: spec.sourceSha,
    name: "source-fresh",
    status: "in_progress",
    conclusion: null,
    completed_at: null,
    started_at: spec.createdAt,
    runner_id: 1,
    runner_name: job.host.runnerName
  };
  const apiCalls = [];
  const fetchMock = mock.method(globalThis, "fetch", async (url) => {
    apiCalls.push(String(url));
    assert.ok(
      String(url).startsWith(
        `https://api.github.com/repos/${job.ci.repository}/actions/runs/1234/attempts/1`
      )
    );
    return new Response(
      JSON.stringify(String(url).includes("/jobs?") ? { total_count: 1, jobs: [apiJob] } : run)
    );
  });
  t.after(() => fetchMock.mock.restore());
  const prepareInput = {
    repoRoot: path.resolve(import.meta.dirname, "../.."),
    creationSpecBytes: encodeManualJson(preparedSpec)
  };
  const produced = await inputs.prepareR3SourceFreshHostedJob(prepareInput);
  assert.equal(JSON.parse(produced.jobAdmissionBytes).operationRef, preparedRef);
  assert.equal(apiCalls.length, 2);
  const preparedKey = await inputs.readR3HostedOperationKey({ operationRef: preparedRef });
  assert.deepEqual(preparedKey.creationSpecBytes, prepareInput.creationSpecBytes);
  assert.deepEqual(preparedKey.jobAdmissionBytes, produced.jobAdmissionBytes);
  await preparedKey.close();
  await assert.rejects(inputs.prepareR3SourceFreshHostedJob(prepareInput), {
    code: "R3_OPERATION_INPUT_INVALID"
  });
  process.env.GITHUB_REF = "refs/heads/other";
  await assert.rejects(inputs.prepareR3SourceFreshHostedJob(prepareInput), {
    code: "R3_OPERATION_INPUT_INVALID"
  });
  process.env.GITHUB_REF = "refs/heads/main";
  const snapshotRef = randomUUID(),
    snapshotId = snapshotRef.replaceAll("-", "");
  const snapshotDir = `/dev/shm/stage1-keys/r3-job-${snapshotId}`;
  t.after(() => fs.rm(snapshotDir, { recursive: true, force: true }));
  const snapshotSpec = {
    ...preparedSpec,
    operationRef: snapshotRef,
    chain: "snapshot",
    workspace: {
      ...preparedSpec.workspace,
      id: snapshotId,
      backingFile: `/var/lib/stage1-snapshots/${snapshotId}.luks`,
      mountPath: `/srv/stage1-snapshot/${snapshotId}`,
      keyFile: `/dev/shm/stage1-keys/${snapshotId}.key`,
      mapperName: `s1snap_${snapshotId}`
    }
  };
  const snapshotInput = { ...prepareInput, creationSpecBytes: encodeManualJson(snapshotSpec) };
  await assert.rejects(inputs.prepareR3SourceFreshHostedJob(snapshotInput), {
    code: "R3_OPERATION_INPUT_INVALID"
  });
  await assert.rejects(inputs.prepareR3SourceSnapshotHostedJob(snapshotInput), {
    code: "R3_OPERATION_INPUT_INVALID"
  });
  process.env.GITHUB_JOB = "source-snapshot";
  apiJob.name = "source-snapshot";
  const producedSnapshot = await inputs.prepareR3SourceSnapshotHostedJob(snapshotInput);
  const snapshotJob = JSON.parse(producedSnapshot.jobAdmissionBytes);
  assert.equal(snapshotJob.chain, "snapshot");
  assert.equal(snapshotJob.ci.jobKey, "source-snapshot");
  assert.equal(snapshotJob.ci.jobName, "source-snapshot");
  const snapshotKey = await inputs.readR3HostedOperationKey({ operationRef: snapshotRef });
  assert.deepEqual(snapshotKey.creationSpecBytes, snapshotInput.creationSpecBytes);
  assert.deepEqual(snapshotKey.jobAdmissionBytes, producedSnapshot.jobAdmissionBytes);
  await snapshotKey.close();
  for (const chain of ["fresh", "snapshot"]) {
    const finalRef = randomUUID(),
      finalId = finalRef.replaceAll("-", "");
    t.after(() =>
      fs.rm(`/dev/shm/stage1-keys/r3-job-${finalId}`, { recursive: true, force: true })
    );
    const finalSpec = {
      ...preparedSpec,
      operationRef: finalRef,
      phase: "final",
      chain,
      workspace: {
        ...preparedSpec.workspace,
        id: finalId,
        backingFile: `/var/lib/stage1-snapshots/${finalId}.luks`,
        mountPath: `/srv/stage1-snapshot/${finalId}`,
        keyFile: `/dev/shm/stage1-keys/${finalId}.key`,
        mapperName: `s1snap_${finalId}`
      }
    };
    const finalInput = { ...prepareInput, creationSpecBytes: encodeManualJson(finalSpec) };
    const prepareFinal =
      chain === "fresh"
        ? inputs.prepareR3FinalFreshHostedJob
        : inputs.prepareR3FinalSnapshotHostedJob;
    await assert.rejects(inputs.prepareR3SourceSnapshotHostedJob(finalInput), {
      code: "R3_OPERATION_INPUT_INVALID"
    });
    process.env.GITHUB_JOB = "execute";
    apiJob.name = `final-${chain} / execute`;
    process.env.GITHUB_WORKFLOW_REF = `${job.ci.repository}/${policy.hosted.final.workflowPath}@refs/heads/main`;
    await assert.rejects(prepareFinal(finalInput), { code: "R3_OPERATION_INPUT_INVALID" });
    process.env.GITHUB_WORKFLOW_REF = environment.GITHUB_WORKFLOW_REF;
    const finalJob = JSON.parse((await prepareFinal(finalInput)).jobAdmissionBytes);
    assert.equal(finalJob.phase, "final");
    assert.equal(finalJob.chain, chain);
    assert.equal(finalJob.ci.workflowPath, policy.hosted.final.workflowPath);
    assert.equal(finalJob.ci.callerWorkflowPath, policy.hosted.final.callerWorkflowPath);
    assert.equal(finalJob.ci.jobKey, "execute");
    assert.equal(finalJob.ci.jobName, apiJob.name);
    assert.equal(finalJob.ci.environment, policy.hosted.final.environment);
    const finalKey = await inputs.readR3HostedOperationKey({ operationRef: finalRef });
    await finalKey.recheck();
    await finalKey.close();
  }
});
