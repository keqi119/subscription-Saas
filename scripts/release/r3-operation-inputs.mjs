// Fixed R3 operation inputs. Key encoding is transport material, never a grant.
import {
  KeyObject,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes
} from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import childProcess from "node:child_process";
import { sha256Bytes } from "../../packages/release-foundation/src/digest.mjs";
import { encodeManualJson } from "../../packages/release-foundation/src/manual-stage1-contracts.mjs";
import { checkR3HostedOperationContext } from "./r3-hosted-creation-control.mjs";

const CODE = "R3_OPERATION_INPUT_INVALID";
const MAGIC = Buffer.from("openssh-key-v1\0");
const TYPE = Buffer.from("ssh-ed25519");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ROOT = "/dev/shm/stage1-keys";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const need = (value) => {
  if (!value) fail();
};
const uint32 = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};
const field = (bytes) => Buffer.concat([uint32(bytes.length), bytes]);

export function encodeR3HostedSshPrivateKey(privateKey) {
  need(
    privateKey instanceof KeyObject &&
      privateKey.type === "private" &&
      privateKey.asymmetricKeyType === "ed25519"
  );
  const jwk = privateKey.export({ format: "jwk" });
  const seed = Buffer.from(jwk.d, "base64url");
  const publicBytes = Buffer.from(jwk.x, "base64url");
  need(seed.length === 32 && publicBytes.length === 32);
  const check = randomBytes(4);
  const publicBlob = Buffer.concat([field(TYPE), field(publicBytes)]);
  const privateBytes = Buffer.concat([seed, publicBytes]);
  const plain = Buffer.concat([
    check,
    check,
    field(TYPE),
    field(publicBytes),
    field(privateBytes),
    field(Buffer.alloc(0))
  ]);
  const padding = Buffer.from(
    Array.from({ length: (8 - (plain.length % 8)) % 8 }, (_, index) => index + 1)
  );
  const padded = Buffer.concat([plain, padding]);
  const contents = Buffer.concat([
    MAGIC,
    field(Buffer.from("none")),
    field(Buffer.from("none")),
    field(Buffer.alloc(0)),
    uint32(1),
    field(publicBlob),
    field(padded)
  ]);
  try {
    return Buffer.from(
      "-----BEGIN OPENSSH PRIVATE KEY-----\n" +
        contents
          .toString("base64")
          .match(/.{1,70}/gu)
          .join("\n") +
        "\n-----END OPENSSH PRIVATE KEY-----\n"
    );
  } finally {
    for (const bytes of [seed, privateBytes, plain, padded, contents]) bytes.fill(0);
  }
}

function cursor(bytes) {
  let offset = 0;
  const number = () => {
    need(offset + 4 <= bytes.length);
    const value = bytes.readUInt32BE(offset);
    offset += 4;
    return value;
  };
  return {
    number,
    field() {
      const length = number();
      need(length <= 4096 && offset + length <= bytes.length);
      const value = bytes.subarray(offset, offset + length);
      offset += length;
      return value;
    },
    remaining: () => bytes.subarray(offset)
  };
}

export function decodeR3HostedSshPrivateKey(input) {
  let contents, pkcs8;
  try {
    need(Buffer.isBuffer(input) && input.length > 0 && input.length <= 4096);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(input);
    const match =
      /^-----BEGIN OPENSSH PRIVATE KEY-----\n((?:[A-Za-z0-9+/=]{1,70}\n)+)-----END OPENSSH PRIVATE KEY-----\n$/u.exec(
        text
      );
    need(match);
    const base64 = match[1].replaceAll("\n", "");
    contents = Buffer.from(base64, "base64");
    need(
      contents.toString("base64") === base64 && contents.subarray(0, MAGIC.length).equals(MAGIC)
    );
    const outer = cursor(contents.subarray(MAGIC.length));
    need(outer.field().equals(Buffer.from("none")));
    need(outer.field().equals(Buffer.from("none")) && outer.field().length === 0);
    need(outer.number() === 1);
    const publicBlob = cursor(outer.field());
    need(publicBlob.field().equals(TYPE));
    const publicBytes = publicBlob.field();
    need(publicBytes.length === 32 && publicBlob.remaining().length === 0);
    const privateBlob = outer.field();
    need(privateBlob.length % 8 === 0 && outer.remaining().length === 0);
    const inner = cursor(privateBlob);
    need(inner.number() === inner.number() && inner.field().equals(TYPE));
    need(inner.field().equals(publicBytes));
    const privateBytes = inner.field();
    need(privateBytes.length === 64 && privateBytes.subarray(32).equals(publicBytes));
    need(inner.field().length === 0);
    const padding = inner.remaining();
    need(padding.length < 8 && padding.every((value, index) => value === index + 1));
    pkcs8 = Buffer.concat([PKCS8_PREFIX, privateBytes.subarray(0, 32)]);
    const privateKey = createPrivateKey({ key: pkcs8, type: "pkcs8", format: "der" });
    const actual = createPublicKey(privateKey).export({ type: "spki", format: "der" });
    need(actual.length === 44 && actual.subarray(-32).equals(publicBytes));
    return privateKey;
  } catch {
    fail();
  } finally {
    contents?.fill(0);
    pkcs8?.fill(0);
  }
}

function exact(value, fields) {
  need(
    value &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
      Reflect.ownKeys(value).length === fields.length &&
      fields.every((name) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        return descriptor?.enumerable && Object.hasOwn(descriptor, "value");
      })
  );
}
const IDENTITY = ["dev", "ino", "mode", "uid", "gid", "nlink"];
const CONTENT = [...IDENTITY, "size", "mtimeNs", "ctimeNs"];
const same = (a, b, fields = CONTENT) => fields.every((field) => a[field] === b[field]);

async function privateMemory() {
  need(process.platform === "linux" && process.getuid?.() === 0);
  const swaps = await fs.readFile("/proc/swaps", "utf8");
  need(/^Filename\s+Type\s+Size\s+Used\s+Priority\s*$/u.test(swaps.trim()));
  const core = (await fs.readFile("/proc/self/limits", "utf8"))
    .split(/\r?\n/u)
    .filter((line) => /^Max core file size\s+/u.test(line));
  need(core.length === 1 && /^Max core file size\s+0\s+0\s+bytes\s*$/u.test(core[0]));
  need((await fs.statfs(ROOT, { bigint: true })).type === 0x01021994n);
}

async function holdDirectory(file, fullIdentity) {
  const before = await fs.lstat(file, { bigint: true });
  need(before.isDirectory() && !before.isSymbolicLink() && before.uid === 0n && before.gid === 0n);
  if (file.startsWith(ROOT)) need((before.mode & 0o7777n) === 0o700n);
  else if (file === "/dev/shm") need((before.mode & 0o7777n) === 0o1777n);
  else need((before.mode & 0o022n) === 0n);
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  const fields = fullIdentity ? CONTENT : IDENTITY.filter((field) => field !== "nlink");
  const recheck = async () => {
    need(same(before, await handle.stat({ bigint: true }), fields));
    need(same(before, await fs.lstat(file, { bigint: true }), fields));
  };
  try {
    await recheck();
    return { recheck, close: () => handle.close() };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function holdInput(file, limit) {
  const before = await fs.lstat(file, { bigint: true });
  need(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.uid === 0n &&
      before.gid === 0n &&
      before.nlink === 1n &&
      (before.mode & 0o7777n) === 0o600n &&
      before.size > 0n &&
      before.size <= BigInt(limit)
  );
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  let bytes;
  const identity = async () => {
    need(same(before, await handle.stat({ bigint: true })));
    need(same(before, await fs.lstat(file, { bigint: true })));
  };
  const read = async () => {
    await identity();
    const copy = Buffer.alloc(Number(before.size));
    try {
      let offset = 0;
      while (offset < copy.length) {
        const result = await handle.read(copy, offset, copy.length - offset, offset);
        need(result.bytesRead > 0);
        offset += result.bytesRead;
      }
      await identity();
      return copy;
    } catch (error) {
      copy.fill(0);
      throw error;
    }
  };
  try {
    bytes = await read();
    return {
      bytes,
      async recheck() {
        const current = await read();
        try {
          need(current.equals(bytes));
        } finally {
          current.fill(0);
        }
      },
      async close() {
        bytes.fill(0);
        await handle.close();
      }
    };
  } catch (error) {
    bytes?.fill(0);
    await handle.close();
    throw error;
  }
}

async function fixedJobContext(specBytes, jobBytes, operationRef) {
  const { spec, job } = await checkR3HostedOperationContext({
    creationSpecBytes: specBytes,
    jobAdmissionBytes: jobBytes
  });
  need(spec.operationRef === operationRef);
  const policy = JSON.parse(
    await fs.readFile(
      new URL("../../release/contracts/manual-stage1-r3-target-policy.v1.json", import.meta.url),
      "utf8"
    )
  );
  const hosted = policy.hosted,
    ci = job.ci,
    source = spec.phase === "source";
  need(
    spec.profileDigest === policy.profileDigest && process.env.GITHUB_REF === hosted.workflowRef
  );
  for (const name of ["repository", "repositoryId", "runAttempt", "runnerClass"])
    need(ci[name] === hosted[name]);
  need(
    ci.workflowPath === (source ? hosted.source.workflowPath : hosted.final.workflowPath) &&
      ci.callerWorkflowPath ===
        (source ? hosted.source.workflowPath : hosted.final.callerWorkflowPath) &&
      ci.jobKey === (source ? hosted.source.jobs[spec.chain] : hosted.final.jobId) &&
      ci.jobName ===
        (source
          ? hosted.source.jobs[spec.chain]
          : `${hosted.final.callerJobs[spec.chain]} / ${hosted.final.jobId}`) &&
      ci.environment === (source ? hosted.source.environment : hosted.final.environment)
  );
  for (const name of ["runId", "jobId"])
    need(
      typeof ci[name] === "string" &&
        /^[1-9][0-9]*$/u.test(ci[name]) &&
        Number.isSafeInteger(Number(ci[name]))
    );
  need(
    Number.isSafeInteger(job.host.runnerId) &&
      job.host.runnerId >= 0 &&
      typeof job.host.runnerName === "string" &&
      job.host.runnerName.length > 0 &&
      job.host.runnerName.length <= 256
  );
  return { spec, job };
}

export async function readR3HostedOperationKey(input) {
  const held = [];
  let privateKey,
    closed = false,
    closing;
  const close = () => {
    if (closing) return closing;
    closed = true;
    privateKey = undefined;
    closing = (async () => {
      const results = await Promise.allSettled(held.map((item) => item.close()));
      if (results.some((result) => result.status === "rejected")) fail();
    })();
    return closing;
  };
  try {
    exact(input, ["operationRef"]);
    input = Object.freeze({ ...input });
    need(typeof input.operationRef === "string" && UUID.test(input.operationRef));
    await privateMemory();
    const directory = `${ROOT}/r3-job-${input.operationRef.replaceAll("-", "")}`;
    for (const file of ["/", "/dev", "/dev/shm", ROOT, directory, `${directory}/transfer`])
      held.push(await holdDirectory(file, file === directory));
    const files = {};
    for (const [name, limit] of [
      ["forwarding.key", 4096],
      ["signing-key.pem", 4096],
      ["creation-spec.json", 1048576],
      ["job-admission.json", 1048576]
    ]) {
      files[name] = await holdInput(`${directory}/${name}`, limit);
      held.push(files[name]);
    }
    const { job } = await fixedJobContext(
      files["creation-spec.json"].bytes,
      files["job-admission.json"].bytes,
      input.operationRef
    );
    privateKey = createPrivateKey(files["signing-key.pem"].bytes);
    need(privateKey.asymmetricKeyType === "ed25519");
    const sshKey = decodeR3HostedSshPrivateKey(files["forwarding.key"].bytes);
    const publicKey = createPublicKey(privateKey),
      publicDer = publicKey.export({ format: "der", type: "spki" });
    need(
      publicDer.equals(createPublicKey(sshKey).export({ format: "der", type: "spki" })) &&
        publicKey.export({ format: "pem", type: "spki" }) === job.host.forwardingPublicKeyPem &&
        sha256Bytes(publicDer) === job.host.forwardingKeyFingerprint
    );
    const recheck = async () => {
      try {
        need(!closed);
        await privateMemory();
        for (const item of held) await item.recheck();
        await fixedJobContext(
          files["creation-spec.json"].bytes,
          files["job-admission.json"].bytes,
          input.operationRef
        );
        need(!closed);
      } catch {
        await close();
        fail();
      }
    };
    await recheck();
    return Object.freeze({
      get privateKey() {
        need(!closed);
        return privateKey;
      },
      get creationSpecBytes() {
        need(!closed);
        return Buffer.from(files["creation-spec.json"].bytes);
      },
      get jobAdmissionBytes() {
        need(!closed);
        return Buffer.from(files["job-admission.json"].bytes);
      },
      sshPrivateKeyPath: `${directory}/forwarding.key`,
      recheck,
      close
    });
  } catch {
    await close();
    fail();
  }
}

async function privateArchiveDirectory(directory, archiveRoot, create = false) {
  need(
    path.isAbsolute(archiveRoot) &&
      path.normalize(archiveRoot) === archiveRoot &&
      (directory === archiveRoot || directory.startsWith(`${archiveRoot}/`))
  );
  if (create) {
    try {
      await fs.mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  const segments = directory.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current += `/${segment}`;
    const stat = await fs.lstat(current, { bigint: true });
    need(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0n && stat.gid === 0n);
    if (current === archiveRoot || current.startsWith(`${archiveRoot}/`))
      need((stat.mode & 0o7777n) === 0o700n);
    else if (current !== "/dev/shm") need((stat.mode & 0o022n) === 0n);
    else need((stat.mode & 0o7777n) === 0o1777n);
  }
}
async function createInput(file, bytes) {
  const handle = await fs.open(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export const prepareR3SourceFreshSpec = (input) => prepareR3Spec(input, "source", "fresh");
export const prepareR3SourceSnapshotSpec = (input) => prepareR3Spec(input, "source", "snapshot");
export const prepareR3FinalFreshSpec = (input) => prepareR3Spec(input, "final", "fresh");
export const prepareR3FinalSnapshotSpec = (input) => prepareR3Spec(input, "final", "snapshot");

async function prepareR3Spec(input, phase, chain) {
  const opened = [];
  try {
    exact(input, [
      "repoRoot",
      "operationRef",
      "proofRawDigest",
      "materialRawDigest",
      "capacityBytes",
      "expiresAt"
    ]);
    input = Object.freeze({ ...input });
    need(
      process.platform === "linux" &&
        process.getuid?.() === 0 &&
        typeof input.repoRoot === "string" &&
        typeof input.operationRef === "string" &&
        UUID.test(input.operationRef)
    );
    for (const name of ["proofRawDigest", "materialRawDigest"])
      need(/^sha256:[0-9a-f]{64}$/u.test(input[name]));
    need(
      Number.isSafeInteger(input.capacityBytes) &&
        input.capacityBytes >= 64 * 1048576 &&
        input.capacityBytes % 1048576 === 0
    );
    need(
      typeof input.expiresAt === "string" &&
        Number.isFinite(Date.parse(input.expiresAt)) &&
        new Date(input.expiresAt).toISOString() === input.expiresAt &&
        Date.now() < Date.parse(input.expiresAt)
    );
    const trust = await import("./manual-stage1-trust.mjs");
    const profile = await trust.loadFixedManualProfile({ repoRoot: input.repoRoot });
    need(Date.parse(input.expiresAt) <= Date.parse(profile.expiresAt));
    const archiveRoot = profile.storage.archiveRoot;
    await privateArchiveDirectory(`${archiveRoot}/inputs/build`, archiveRoot);
    const proof = await holdInput(
      `${archiveRoot}/inputs/build/${input.proofRawDigest.slice(7)}.proof.json`,
      1048576
    );
    opened.push(proof);
    const material = await holdInput(
      `${archiveRoot}/inputs/build/${input.materialRawDigest.slice(7)}.material.json`,
      1048576
    );
    opened.push(material);
    need(
      sha256Bytes(proof.bytes) === input.proofRawDigest &&
        sha256Bytes(material.bytes) === input.materialRawDigest
    );
    const policy = await trust.readFixedR3TargetPolicy({
      repoRoot: input.repoRoot,
      proofBytes: proof.bytes,
      materialBytes: material.bytes
    });
    opened.push(policy);
    const id = input.operationRef.replaceAll("-", ""),
      roots = policy.policy.workspace;
    const spec = {
      schemaVersion: "manual-r3-creation-spec.v1",
      operationRef: input.operationRef,
      profileDigest: policy.profileDigest,
      ownerId: profile.ownerId,
      sourceSha: policy.sourceSha,
      buildProofDigest: policy.build.buildProofDigest,
      proofRawDigest: input.proofRawDigest,
      materialRawDigest: input.materialRawDigest,
      targetPolicyDigest: policy.policyRawDigest,
      phase,
      chain,
      createdAt: new Date().toISOString(),
      expiresAt: input.expiresAt,
      workspace: {
        id,
        capacityBytes: input.capacityBytes,
        backingFile: `${roots.backingRoot}/${id}.luks`,
        mountPath: `${roots.mountRoot}/${id}`,
        keyFile: `${roots.keyRoot}/${id}.key`,
        mapperName: `${roots.mapperPrefix}${id}`
      },
      cleanup: "stop-owned-engine-and-remove-workspace"
    };
    for (const item of opened) await item.recheck();
    const parent = `${archiveRoot}/inputs/r3`,
      directory = `${parent}/${input.operationRef}`;
    await privateArchiveDirectory(parent, archiveRoot, true);
    // Reserving a failed operation is intentional: no overwrite or implicit retry.
    await fs.mkdir(directory, { mode: 0o700 });
    await privateArchiveDirectory(directory, archiveRoot);
    const bytes = encodeManualJson(spec);
    await createInput(`${directory}/creation-spec.json`, bytes);
    const reopened = await trust.readFixedR3CreationSpec({
      repoRoot: input.repoRoot,
      operationRef: input.operationRef
    });
    opened.push(reopened);
    await reopened.recheck();
    need(encodeManualJson(reopened.spec).equals(bytes));
    return bytes;
  } catch {
    fail();
  } finally {
    await Promise.all(opened.map((item) => item.close()));
  }
}

async function githubJson(endpoint) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  need(typeof token === "string" && token.length > 0);
  const response = await fetch(
    `https://api.github.com/repos/keqi119/subscription-Saas/${endpoint}`,
    {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(20000),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28"
      }
    }
  );
  need(response.ok);
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    need(size <= 1048576);
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}

export const prepareR3SourceFreshHostedJob = (input) =>
  prepareR3HostedJob(input, "source", "fresh");
export const prepareR3SourceSnapshotHostedJob = (input) =>
  prepareR3HostedJob(input, "source", "snapshot");
export const prepareR3FinalFreshHostedJob = (input) => prepareR3HostedJob(input, "final", "fresh");
export const prepareR3FinalSnapshotHostedJob = (input) =>
  prepareR3HostedJob(input, "final", "snapshot");

async function prepareR3HostedJob(input, phase, chain) {
  let pem, sshBytes;
  try {
    exact(input, ["repoRoot", "creationSpecBytes"]);
    need(input.repoRoot === fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/u, ""));
    need(
      Buffer.isBuffer(input.creationSpecBytes) &&
        input.creationSpecBytes.length > 0 &&
        input.creationSpecBytes.length <= 1048576
    );
    const specBytes = Buffer.from(input.creationSpecBytes),
      spec = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(specBytes));
    await privateMemory();
    need(
      encodeManualJson(spec).equals(specBytes) &&
        spec.phase === phase &&
        spec.chain === chain &&
        UUID.test(spec.operationRef)
    );
    const policyBytes = await fs.readFile(
      new URL("../../release/contracts/manual-stage1-r3-target-policy.v1.json", import.meta.url)
    );
    const policy = JSON.parse(policyBytes),
      hosted = policy.hosted,
      workflow = hosted[phase],
      callerWorkflowPath = phase === "source" ? workflow.workflowPath : workflow.callerWorkflowPath,
      jobKey = phase === "source" ? workflow.jobs[chain] : workflow.jobId,
      jobName = phase === "source" ? jobKey : `${workflow.callerJobs[chain]} / ${jobKey}`;
    need(
      spec.profileDigest === policy.profileDigest &&
        spec.targetPolicyDigest === sha256Bytes(policyBytes) &&
        process.env.GITHUB_ACTIONS === "true" &&
        process.env.RUNNER_OS === "Linux" &&
        process.env.GITHUB_REPOSITORY === hosted.repository &&
        process.env.GITHUB_REPOSITORY_ID === hosted.repositoryId &&
        process.env.GITHUB_REF === hosted.workflowRef &&
        process.env.GITHUB_SHA === spec.sourceSha &&
        process.env.GITHUB_RUN_ATTEMPT === "1" &&
        process.env.GITHUB_JOB === jobKey &&
        process.env.GITHUB_WORKFLOW_REF ===
          `${hosted.repository}/${callerWorkflowPath}@${hosted.workflowRef}` &&
        /^[1-9][0-9]*$/u.test(process.env.GITHUB_RUN_ID ?? "") &&
        Number.isSafeInteger(Number(process.env.GITHUB_RUN_ID))
    );
    const runId = process.env.GITHUB_RUN_ID;
    const run = await githubJson(`actions/runs/${runId}/attempts/1`);
    need(
      run.id === Number(runId) &&
        run.run_attempt === 1 &&
        run.head_sha === spec.sourceSha &&
        run.head_branch === "main" &&
        run.path === callerWorkflowPath &&
        run.status === "in_progress" &&
        run.conclusion === null
    );
    for (const repo of [run.repository, run.head_repository])
      need(repo?.full_name === hosted.repository && repo.id === Number(hosted.repositoryId));
    const jobs = [];
    for (let page = 1; page <= 10; page++) {
      const result = await githubJson(
        `actions/runs/${runId}/attempts/1/jobs?per_page=100&page=${page}`
      );
      need(
        Number.isSafeInteger(result.total_count) &&
          result.total_count >= 0 &&
          result.total_count <= 1000 &&
          Array.isArray(result.jobs)
      );
      jobs.push(...result.jobs);
      if (jobs.length >= result.total_count) {
        need(jobs.length === result.total_count);
        break;
      }
      need(result.jobs.length === 100 && page < 10);
    }
    const matches = jobs.filter((job) => job.name === jobName);
    need(matches.length === 1);
    const observed = matches[0];
    need(
      observed.run_id === Number(runId) &&
        observed.head_sha === spec.sourceSha &&
        observed.status === "in_progress" &&
        observed.conclusion === null &&
        observed.completed_at === null &&
        observed.runner_name === process.env.RUNNER_NAME &&
        Number.isSafeInteger(observed.id) &&
        observed.id > 0 &&
        Number.isFinite(Date.parse(observed.started_at)) &&
        Date.parse(observed.started_at) <= Date.now()
    );
    const machine = (await fs.readFile("/etc/machine-id", "utf8")).trim();
    need(/^[0-9a-f]{32}$/u.test(machine));
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const job = {
      schemaVersion: "manual-r3-job-admission.v1",
      operationRef: spec.operationRef,
      profileDigest: spec.profileDigest,
      ownerId: spec.ownerId,
      creationSpecDigest: sha256Bytes(specBytes),
      buildProofDigest: spec.buildProofDigest,
      sourceSha: spec.sourceSha,
      phase: spec.phase,
      chain: spec.chain,
      generatedAt: new Date().toISOString(),
      expiresAt: spec.expiresAt,
      ci: {
        repository: hosted.repository,
        repositoryId: hosted.repositoryId,
        runId,
        runAttempt: 1,
        workflowPath: workflow.workflowPath,
        callerWorkflowPath,
        jobKey,
        jobId: String(observed.id),
        jobName,
        environment: workflow.environment,
        runnerClass: hosted.runnerClass
      },
      host: {
        machineIdFingerprint: sha256Bytes(
          Buffer.from(`subscription-saas/linux-machine-id/v1\n${machine}`)
        ),
        forwardingPublicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
        forwardingKeyFingerprint: sha256Bytes(publicKey.export({ type: "spki", format: "der" })),
        runnerId: observed.runner_id,
        runnerName: observed.runner_name
      }
    };
    const jobAdmissionBytes = encodeManualJson(job);
    await fixedJobContext(specBytes, jobAdmissionBytes, spec.operationRef);
    for (const file of ["/", "/dev", "/dev/shm", ROOT]) {
      const held = await holdDirectory(file, false);
      await held.close();
    }
    const directory = `${ROOT}/r3-job-${spec.operationRef.replaceAll("-", "")}`;
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.mkdir(`${directory}/transfer`, { mode: 0o700 });
    pem = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" }));
    sshBytes = encodeR3HostedSshPrivateKey(privateKey);
    for (const [name, bytes] of [
      ["forwarding.key", sshBytes],
      ["signing-key.pem", pem],
      ["creation-spec.json", specBytes],
      ["job-admission.json", jobAdmissionBytes]
    ])
      await createInput(`${directory}/${name}`, bytes);
    const held = await readR3HostedOperationKey({ operationRef: spec.operationRef });
    try {
      await held.recheck();
    } finally {
      await held.close();
    }
    return Object.freeze({
      jobAdmissionBytes,
      artifactName: `stage1-r3-job-${spec.operationRef}-${runId}-1`,
      jobAdmissionPath: `${directory}/job-admission.json`
    });
  } catch {
    fail();
  } finally {
    pem?.fill(0);
    sshBytes?.fill(0);
  }
}

async function fixedCommand(binary, args, stdin) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !["GH_HOST", "GH_REPO"].includes(name.toUpperCase())
    )
  );
  env.GH_HOST = "github.com";
  env.GH_PROMPT_DISABLED = "1";
  return new Promise((resolve, reject) => {
    const child = childProcess.execFile(
      binary,
      args,
      { shell: false, encoding: "buffer", timeout: 60000, maxBuffer: 1048576, env },
      (error, stdout) =>
        error
          ? reject(Object.assign(new Error(CODE), { code: CODE }))
          : resolve(Buffer.from(stdout))
    );
    child.stdin.on?.("error", () => {});
    child.stdin.end(stdin);
  });
}
// Read one bounded member, never extract paths from an untrusted ZIP to disk.
const SINGLE_JOB_ZIP = `import io,sys,zipfile,stat
data=sys.stdin.buffer.read(1048577)
assert 0<len(data)<=1048576
with zipfile.ZipFile(io.BytesIO(data)) as z:
    files=z.infolist()
    assert len(files)==1
    f=files[0]
    assert f.filename=='job-admission.json' and not f.is_dir()
    assert 0<f.file_size<=1048576 and not (f.flag_bits&1)
    assert stat.S_IFMT(f.external_attr>>16) in (0,stat.S_IFREG)
    value=z.read(f)
    assert len(value)==f.file_size
    sys.stdout.buffer.write(value)
`;

export const importR3SourceFreshJob = (input) => importR3Job(input, "source", "fresh");
export const importR3SourceSnapshotJob = (input) => importR3Job(input, "source", "snapshot");
export const importR3FinalFreshJob = (input) => importR3Job(input, "final", "fresh");
export const importR3FinalSnapshotJob = (input) => importR3Job(input, "final", "snapshot");

async function importR3Job(input, phase, chain) {
  const opened = [];
  try {
    exact(input, ["repoRoot", "operationRef", "runId"]);
    input = Object.freeze({ ...input });
    need(
      process.platform === "linux" &&
        process.getuid?.() === 0 &&
        typeof input.repoRoot === "string" &&
        UUID.test(input.operationRef) &&
        typeof input.runId === "string" &&
        /^[1-9][0-9]*$/u.test(input.runId) &&
        Number.isSafeInteger(Number(input.runId))
    );
    const trust = await import("./manual-stage1-trust.mjs");
    const creation = await trust.readFixedR3CreationSpec({
      repoRoot: input.repoRoot,
      operationRef: input.operationRef
    });
    opened.push(creation);
    need(creation.spec.phase === phase && creation.spec.chain === chain);
    const profile = await trust.loadFixedManualProfile({ repoRoot: input.repoRoot });
    const archiveRoot = profile.storage.archiveRoot,
      directory = `${archiveRoot}/inputs/r3/${input.operationRef}`;
    await privateArchiveDirectory(directory, archiveRoot);
    // A partial/failed import keeps its reserved directory and cannot be silently retried.
    const staging = `${directory}/job-import`;
    await fs.mkdir(staging, { mode: 0o700 });
    await privateArchiveDirectory(staging, archiveRoot);
    const artifactName = `stage1-r3-job-${input.operationRef}-${input.runId}-1`,
      artifacts = [];
    const api = (endpoint) =>
      fixedCommand("gh", ["api", `repos/keqi119/subscription-Saas/${endpoint}`]);
    for (let page = 1; page <= 10; page++) {
      const bytes = await api(`actions/runs/${input.runId}/artifacts?per_page=100&page=${page}`);
      const result = JSON.parse(bytes);
      need(
        Number.isSafeInteger(result.total_count) &&
          result.total_count >= 0 &&
          result.total_count <= 1000 &&
          Array.isArray(result.artifacts)
      );
      artifacts.push(...result.artifacts);
      if (artifacts.length >= result.total_count) {
        need(artifacts.length === result.total_count);
        break;
      }
      need(result.artifacts.length === 100 && page < 10);
    }
    const matches = artifacts.filter((artifact) => artifact.name === artifactName);
    need(matches.length === 1);
    const artifact = matches[0];
    need(
      Number.isSafeInteger(artifact.id) &&
        artifact.id > 0 &&
        artifact.expired === false &&
        Number.isSafeInteger(artifact.size_in_bytes) &&
        artifact.size_in_bytes > 0 &&
        artifact.size_in_bytes <= 1048576 &&
        artifact.workflow_run?.id === Number(input.runId) &&
        artifact.workflow_run?.head_sha === creation.spec.sourceSha
    );
    await creation.recheck();
    const zip = await api(`actions/artifacts/${artifact.id}/zip`);
    need(zip.length > 0 && zip.length <= 1048576);
    await createInput(`${staging}/artifact.zip`, zip);
    const bytes = await fixedCommand("python3", ["-I", "-c", SINGLE_JOB_ZIP], zip);
    need(bytes.length > 0 && bytes.length <= 1048576);
    const admission = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    need(
      encodeManualJson(admission).equals(bytes) &&
        admission.operationRef === input.operationRef &&
        admission.sourceSha === creation.spec.sourceSha &&
        admission.creationSpecDigest === sha256Bytes(encodeManualJson(creation.spec)) &&
        admission.ci?.runId === input.runId &&
        admission.ci?.runAttempt === 1
    );
    await creation.recheck();
    await privateArchiveDirectory(directory, archiveRoot);
    await createInput(`${directory}/job-admission.json`, bytes);
    // Neither artifact metadata nor download success admits the job. Existing
    // GitHub attestation plus independent current run/job API must both pass.
    const admitted = await trust.readFixedR3JobAdmission({
      repoRoot: input.repoRoot,
      operationRef: input.operationRef
    });
    opened.push(admitted);
    await admitted.recheck();
    need(admitted.rawInputs.admission.equals(bytes));
    return Buffer.from(bytes);
  } catch {
    fail();
  } finally {
    await Promise.all(opened.map((item) => item.close()));
  }
}
