import fs from "node:fs/promises";
import path from "node:path";
import childProcess from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assessManualRunnerEvidence,
  computeManualClusterFingerprint,
  deterministicPlanDigest,
  encodeManualJson,
  parseManualRunnerFrames,
  sha256Bytes,
  sha256Canonical,
  validateContract,
  validateManualRunnerRequest,
  verifyManualAuthorization,
  verifyManualHandoff
} from "../../packages/release-foundation/src/index.mjs";
import {
  loadFixedManualProfile,
  readFixedManualOperation,
  verifyManualBuild
} from "./manual-stage1-trust.mjs";
import {
  checkedPrivatePath,
  expectedGhArgv,
  expectedGhResult,
  expectedJson,
  observedPath,
  openManualExpectedSchemaInputs,
  openManualH3AInputs,
  openManualH3BInputs,
  pinPrivateInput,
  readPinned,
  sameIdentity,
  samePublicDirectory
} from "./manual-runner-source-inputs.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const INCOMPLETE = "MANUAL_RESULT_INCOMPLETE";
const MISMATCH = "MANUAL_RESULT_IDENTITY_MISMATCH";
const identityKeys = [
  "profileDigest",
  "sessionId",
  "sessionNonce",
  "operationId",
  "idempotencyKey",
  "attemptId",
  "runId"
];
function requireThat(value, code = INCOMPLETE) {
  if (!value) throw Object.assign(new Error(code), { code });
}
function exact(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable && Object.hasOwn(descriptor, "value");
    })
  );
}
const equal = (a, b) => encodeManualJson(a).equals(encodeManualJson(b));
const fields = (value, keys) => Object.fromEntries(keys.map((key) => [key, value[key]]));
const rawRef = (bytes) => ({ digest: sha256Bytes(bytes), bytes: bytes.length });
function canonical(bytes) {
  const value = expectedJson(bytes, true);
  requireThat(encodeManualJson(value).equals(bytes));
  return value;
}
async function batches(items, action) {
  const values = [];
  for (let offset = 0; offset < items.length; offset += 8) {
    const results = await Promise.allSettled(items.slice(offset, offset + 8).map(action));
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    values.push(...results.map((result) => result.value));
  }
  return values;
}

// These two public files are fixed repository inputs. R1 establishes their
// owner/host authority; this holder preserves the exact bytes across that check.
async function ownerInputs() {
  const held = [];
  const close = async () => {
    const results = await Promise.allSettled(held.map((item) => item.handle.close()));
    for (const item of held) item.bytes?.fill(0);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  };
  try {
    for (const name of ["manual-stage1-profile.v2.json", "manual-stage1-owner-binding.v1.json"]) {
      const file = path.join(repoRoot, "release", "contracts", name);
      const chain = await observedPath(file),
        handle = await fs.open(file, "r");
      const item = { file, chain, handle };
      held.push(item);
      Object.assign(item, await readPinned(handle, chain.at(-1).stat));
    }
    const recheck = async () => {
      for (const item of held) {
        const after = await observedPath(item.file);
        requireThat(
          after.length === item.chain.length &&
            after.every(
              (entry, index) =>
                entry.path === item.chain[index].path &&
                (index === after.length - 1 ||
                entry.path === repoRoot ||
                entry.path.startsWith(repoRoot + path.sep)
                  ? sameIdentity(entry.stat, item.chain[index].stat)
                  : samePublicDirectory(entry.stat, item.chain[index].stat))
            )
        );
        requireThat((await readPinned(item.handle, item.stat)).bytes.equals(item.bytes));
        const independent = await fs.open(item.file, "r");
        try {
          requireThat((await readPinned(independent, item.stat)).bytes.equals(item.bytes));
        } finally {
          await independent.close();
        }
      }
    };
    return { profileBytes: held[0].bytes, bindingBytes: held[1].bytes, recheck, close };
  } catch (cause) {
    await close();
    throw cause;
  }
}

// No writer, session, credential or caller-selected path is exposed. Initial
// reads and the final full readback use the same private pin/ACL implementation.
function archiveInputs(profile, principal) {
  const files = new Map(),
    directories = new Map();
  const sameChain = (before, after, role) =>
    before.length === after.length &&
    after.every(
      (entry, index) =>
        entry.path === before[index].path &&
        (entry.path === profile.storage[role + "Root"] ||
        entry.path.startsWith(profile.storage[role + "Root"] + path.sep)
          ? sameIdentity(entry.stat, before[index].stat)
          : samePublicDirectory(entry.stat, before[index].stat))
    );
  const read = async (file, role, limit = 1048576) => {
    const known = files.get(file);
    if (known) {
      requireThat(known.role === role && known.bytes.length <= limit);
      return known.bytes;
    }
    const chain = await checkedPrivatePath(file, {
      principal,
      privateRoot: profile.storage[role + "Root"]
    });
    const input = await pinPrivateInput(
      file,
      {
        principal,
        privateRoot: profile.storage[role + "Root"]
      },
      limit
    );
    try {
      await input.recheck();
      requireThat(
        sameChain(
          chain,
          await checkedPrivatePath(file, {
            principal,
            privateRoot: profile.storage[role + "Root"]
          }),
          role
        )
      );
      const bytes = Buffer.from(input.bytes);
      files.set(file, { role, limit, bytes, chain });
      return bytes;
    } finally {
      await input.close();
    }
  };
  const list = async (role, relative, pattern) => {
    const file = path.join(profile.storage[role + "Root"], relative);
    const chain = await checkedPrivatePath(file, {
      principal,
      privateRoot: profile.storage[role + "Root"],
      directory: true
    });
    const names = (await fs.readdir(file)).sort();
    requireThat(names.every((name) => pattern.test(name)));
    const prior = directories.get(file);
    if (prior)
      requireThat(
        prior.role === role && sameChain(prior.chain, chain, role) && equal(prior.names, names)
      );
    else directories.set(file, { role, chain, names });
    return names;
  };
  const object = async (digest, role = "archive") => {
    requireThat(typeof digest === "string" && DIGEST.test(digest), MISMATCH);
    const bytes = await read(
      path.join(profile.storage[role + "Root"], "objects", digest.slice(7) + ".json"),
      role
    );
    requireThat(sha256Bytes(bytes) === digest, MISMATCH);
    return { bytes, value: canonical(bytes) };
  };
  const recheck = async () => {
    await batches([...files], async ([file, saved]) => {
      const input = await pinPrivateInput(
        file,
        {
          principal,
          privateRoot: profile.storage[saved.role + "Root"]
        },
        saved.limit
      );
      try {
        requireThat(input.bytes.equals(saved.bytes));
        await input.recheck();
        requireThat(
          sameChain(
            saved.chain,
            await checkedPrivatePath(file, {
              principal,
              privateRoot: profile.storage[saved.role + "Root"]
            }),
            saved.role
          )
        );
      } finally {
        await input.close();
      }
    });
    for (const [file, saved] of directories) {
      const chain = await checkedPrivatePath(file, {
        principal,
        privateRoot: profile.storage[saved.role + "Root"],
        directory: true
      });
      requireThat(
        chain.length === saved.chain.length &&
          chain.every(
            (entry, index) =>
              entry.path === saved.chain[index].path &&
              (entry.path === profile.storage[saved.role + "Root"] ||
              entry.path.startsWith(profile.storage[saved.role + "Root"] + path.sep)
                ? sameIdentity(entry.stat, saved.chain[index].stat)
                : samePublicDirectory(entry.stat, saved.chain[index].stat))
          )
      );
      requireThat(equal((await fs.readdir(file)).sort(), saved.names));
    }
  };
  return {
    read,
    list,
    object,
    recheck,
    close: async () => {
      for (const { bytes } of files.values()) bytes.fill(0);
      files.clear();
      directories.clear();
    }
  };
}

async function readGraph(archive, profile) {
  const graph = new Map();
  for (const role of ["journal", "archive"]) {
    const names = await archive.list(role, "objects", /^[0-9a-f]{64}\.json$/u);
    const objects = await batches(names, (name) =>
      archive.object("sha256:" + name.slice(0, -5), role)
    );
    for (const [index, item] of objects.entries()) {
      const digest = "sha256:" + names[index].slice(0, -5);
      requireThat(!graph.has(digest) || graph.get(digest).bytes.equals(item.bytes));
      graph.set(digest, item);
    }
  }
  const prefixes = new Set();
  for (const { value } of graph.values()) {
    if (value.kind !== "process") continue;
    validateContract("manual-runner-evidence.v1", value);
    const request = graph.get(value.requestDigest)?.value;
    if (request?.schemaVersion !== "manual-runner-request.v1") continue;
    validateManualRunnerRequest(request);
    if (
      identityKeys.every((key) => value[key] === request[key]) &&
      value.attemptAllocationDigest === request.attemptAllocationDigest
    )
      prefixes.add(value.protocol.stdoutPrefix.digest);
  }
  const raw = new Map();
  const names = await archive.list("archive", "raw", /^[0-9a-f]{64}\.bin$/u);
  const values = await batches(names, async (name) => {
    const digest = "sha256:" + name.slice(0, -4);
    const bytes = await archive.read(
      path.join(profile.storage.archiveRoot, "raw", name),
      "archive",
      prefixes.has(digest) ? 2097152 : 1048576
    );
    requireThat(sha256Bytes(bytes) === digest, MISMATCH);
    return bytes;
  });
  for (const [index, bytes] of values.entries())
    raw.set("sha256:" + names[index].slice(0, -4), bytes);
  return { graph, raw };
}

function original(graph, digest, kind = null) {
  const item = graph.get(digest);
  requireThat(item && sha256Bytes(item.bytes) === digest);
  if (kind) requireThat(item.value.kind === kind, MISMATCH);
  return item.value;
}

async function consumedHistory(archive, profile, graph) {
  const slots = new Map();
  const names = await archive.list(
    "journal",
    "consumptions",
    /^[0-9a-f]{64}-[0-9a-f-]{36}\.json$/u
  );
  for (const name of names) {
    const bytes = await archive.read(
      path.join(profile.storage.journalRoot, "consumptions", name),
      "journal"
    );
    const value = canonical(bytes);
    requireThat(
      ["manual-operation-record.v1", "manual-operation-record.v2"].includes(value.schemaVersion)
    );
    validateContract(value.schemaVersion, value);
    requireThat(value.kind === "consumption" && value.status === "CONSUMED");
    const digest = sha256Bytes(bytes),
      authorization = original(graph, value.authorizationDigest);
    requireThat(
      name === `${value.profileDigest.slice(7)}-${authorization.payload.authorizationId}.json`,
      MISMATCH
    );
    requireThat(graph.get(digest)?.bytes.equals(bytes));
    requireThat(!slots.has(value.requestDigest), MISMATCH);
    await archive.object(digest, "journal");
    slots.set(value.requestDigest, { digest, value });
  }
  for (const { value } of graph.values()) {
    if (value.kind !== "consumption") continue;
    requireThat(slots.get(value.requestDigest)?.digest === sha256Canonical(value));
  }
  return slots;
}

async function currentExpectedAttestations(reader, profile, build) {
  const provenance = reader.context.provenance;
  const captures = [];
  for (const name of ["provenance.json", "expected.sql"]) {
    await reader.recheck();
    const file = path.join(
      profile.storage.archiveRoot,
      "inputs",
      "expected-schema",
      build.proofRawDigest.slice(7),
      name
    );
    const argv = expectedGhArgv(file, provenance),
      startedAt = new Date().toISOString();
    let spawned = false,
      pid = null;
    const result = await new Promise((resolve) => {
      const environment = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !["GH_HOST", "GH_REPO"].includes(key.toUpperCase())
          )
        ),
        GH_HOST: "github.com",
        GH_PROMPT_DISABLED: "1",
        GIT_TERMINAL_PROMPT: "0"
      };
      try {
        const child = childProcess.execFile(
          "gh",
          argv,
          {
            shell: false,
            windowsHide: true,
            encoding: "buffer",
            timeout: 30000,
            maxBuffer: 1048576,
            env: environment
          },
          (error, stdout, stderr) =>
            resolve({
              spawned,
              pid,
              stdout,
              stderr,
              exitCode: !error
                ? 0
                : Number.isSafeInteger(error.code)
                  ? error.code
                  : (child.exitCode ?? null),
              signal: error?.signal ?? child.signalCode ?? null,
              errorCode: typeof error?.code === "string" ? error.code : null,
              problem: error ? "MANUAL_EXPECTED_SCHEMA_PROCESS_FAILED" : null,
              closedAt: new Date().toISOString()
            })
        );
        child.once("spawn", () => {
          spawned = true;
          pid = child.pid;
        });
      } catch {
        resolve({ problem: "MANUAL_EXPECTED_SCHEMA_PROCESS_FAILED" });
      }
    });
    const argvBytes = encodeManualJson(argv),
      stdout = Buffer.from(result.stdout ?? Buffer.alloc(0)),
      stderr = Buffer.from(result.stderr ?? Buffer.alloc(0));
    let capture = null,
      failure = null;
    try {
      capture = expectedGhResult({
        subject: reader.refs.files[name],
        p: provenance,
        processResult: result,
        startedAt,
        argvRaw: rawRef(argvBytes),
        stdout: rawRef(stdout),
        stderr: rawRef(stderr)
      });
    } catch (cause) {
      failure = cause;
    }
    // The existing complete execution log is the custody boundary for this
    // read-only invocation. Never write back a historical admission or journal.
    const diagnostic = {
      subject: reader.refs.files[name],
      startedAt,
      closedAt: result.closedAt ?? null,
      spawned: result.spawned === true,
      pid: result.pid ?? null,
      exitCode: result.exitCode ?? null,
      signal: result.signal ?? null,
      problem: result.problem ?? failure?.code ?? null,
      errorCode: result.errorCode ?? null,
      argv: argvBytes.toString("base64"),
      stdout: stdout.toString("base64"),
      stderr: stderr.toString("base64"),
      capture
    };
    const bytes = encodeManualJson(diagnostic);
    await new Promise((resolve, reject) => {
      process.stderr.write(
        `MANUAL_RESULT_ATTESTATION ${bytes.toString("utf8")}\n`,
        "utf8",
        (error) => (error ? reject(error) : resolve())
      );
    });
    if (failure) throw failure;
    captures.push({ diagnostic: rawRef(bytes), capture });
    await reader.recheck();
  }
  return captures;
}

function requestInput(item) {
  const ignored = new Set([
    "schemaVersion",
    "attemptId",
    "runId",
    "attemptAllocationDigest",
    "domainInput",
    "expectedSchemaEvidenceDigest"
  ]);
  return {
    canonicalBytes: item.bytes,
    binding: Object.fromEntries(Object.entries(item.value).filter(([key]) => !ignored.has(key)))
  };
}

async function historicalAuthorization(archive, profile, requestItem, consumed, execution, graph) {
  const request = requestItem.value,
    authorization = original(graph, consumed.authorizationDigest);
  const now = consumed.recordedAt;
  const records = [];
  const prefix = request.profileDigest.slice(7) + "-";
  const revocations = await archive.list("journal", "revocations", /^[0-9a-f]{64}-[0-9]+\.json$/u);
  const checkpoints = new Set(
    await archive.list(
      "journal",
      "checkpoints",
      /^(?:[0-9a-f]{64}-[0-9]+|execution-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[0-9a-f]{64})\.json$/u
    )
  );
  for (const name of revocations.filter((name) => name.startsWith(prefix))) {
    const bytes = await archive.read(
      path.join(profile.storage.journalRoot, "revocations", name),
      "journal"
    );
    const value = canonical(bytes);
    requireThat(
      value.kind === "revocation" && value.profileDigest === request.profileDigest,
      MISMATCH
    );
    requireThat(name === `${prefix}${value.sequence}.json`, MISMATCH);
    requireThat(graph.get(sha256Bytes(bytes))?.bytes.equals(bytes));
    if (Date.parse(value.recordedAt) <= Date.parse(now)) records.push(value);
  }
  records.sort((a, b) => a.sequence - b.sequence);
  // A revocation may reach its canonical journal object before its sequence
  // slot. That partial append is uncertainty, not permission to use an old head.
  for (const { value } of graph.values()) {
    if (value.kind !== "revocation" || value.profileDigest !== request.profileDigest) continue;
    requireThat(
      ["manual-operation-record.v1", "manual-operation-record.v2"].includes(value.schemaVersion)
    );
    validateContract(value.schemaVersion, value);
    if (Date.parse(value.recordedAt) <= Date.parse(now))
      requireThat(records[value.sequence] && equal(records[value.sequence], value));
  }
  const head = records.at(-1);
  requireThat(head);
  requireThat(
    consumed.revocationRecordDigest === sha256Canonical(head) &&
      consumed.revocationSequence === head.sequence,
    MISMATCH
  );
  const checkpointName = `${prefix}${head.sequence}.json`;
  requireThat(checkpoints.has(checkpointName));
  const checkpoint = canonical(
    await archive.read(
      path.join(profile.storage.journalRoot, "checkpoints", checkpointName),
      "journal"
    )
  );
  requireThat(equal(checkpoint, head));
  const predecessorDigest = request.dryRunRecordDigest ?? request.predecessorExecutionRecordDigest;
  verifyManualAuthorization({
    authorization,
    profile,
    request: requestInput(requestItem),
    session: {
      record: original(graph, consumed.sessionRecordDigest, "session"),
      recordDigest: consumed.sessionRecordDigest,
      readAt: now,
      predecessor: predecessorDigest ? original(graph, predecessorDigest, "execution") : null
    },
    revocation: {
      records,
      headDigest: sha256Canonical(head),
      checkpoint: { sequence: head.sequence, digest: sha256Canonical(checkpoint) },
      readAt: now
    },
    now
  });
  if (request.stage === "runner-command") {
    const receipt = original(graph, execution.handoffRecordDigest, "consumption-handoff");
    verifyManualHandoff({
      authorization,
      receipt,
      profile,
      request: requestInput(requestItem),
      childObservation: fields(request, ["containerId", "runnerImageDigest", "childChallenge"]),
      now: receipt.issuedAt
    });
  }
}

async function runnerOriginals(
  archive,
  profile,
  fixed,
  build,
  request,
  execution,
  graph,
  raw,
  targetContext
) {
  const process = original(graph, execution.processEvidenceDigest, "process");
  requireThat(process.requestDigest === sha256Canonical(request) && process.closedAt !== null);
  const closed = process.events.filter(
    (event) => event.source === "parent" && event.tool === "runner" && event.event === "CLOSED"
  );
  requireThat(closed.length === 1 && Number.isSafeInteger(closed[0].pid) && closed[0].pid > 0);
  const authorizeRaw = raw.get(process.protocol.parentFrames[0]?.digest);
  requireThat(authorizeRaw?.subarray(0, 4).equals(Buffer.from("MS2 ")), MISMATCH);
  const authorize = parseManualRunnerFrames({
    direction: "parent-to-child",
    bytes: authorizeRaw,
    ended: true
  }).frames[0];
  requireThat(
    authorize?.type === "AUTHORIZE" && equal(authorize.payload.targetContext, targetContext),
    MISMATCH
  );
  const base = path.join(
    profile.storage.archiveRoot,
    "inputs",
    "operations",
    fixed.operation.operationRef,
    "runner-launch",
    request.attemptId
  );
  const source = async (name, json = true) => {
    const bytes = await archive.read(path.join(base, name), "archive");
    requireThat(raw.get(sha256Bytes(bytes))?.equals(bytes));
    return json ? expectedJson(bytes) : bytes;
  };
  const image = await source("image-inspect.stdout"),
    before = await source("container-inspect.stdout"),
    after = await source("final-inspect.stdout");
  for (const prefix of ["image-inspect", "container-inspect", "final-inspect"])
    requireThat((await source(prefix + ".stderr", false)).length === 0);
  const proof = expectedJson(fixed.proofBytes),
    trustedImage = proof.identity.images.runner;
  requireThat(
    image.sourceRevision === proof.identity.sourceSha &&
      image.platform === trustedImage.platform &&
      image.repoDigests.includes(`${trustedImage.registry}@${trustedImage.imageDigest}`) &&
      image.defaultEntrypoint === true &&
      image.defaultCommand === true &&
      DIGEST.test(image.id),
    MISMATCH
  );
  requireThat(
    request.buildProofDigest === build.buildProofDigest &&
      request.runnerImageDigest === trustedImage.imageDigest,
    MISMATCH
  );
  const argvBytes = await source("runner.argv.json", false),
    argv = canonical(argvBytes);
  requireThat(
    process.events
      .filter(
        (event) =>
          event.source === "parent" && event.tool === "runner" && event.event !== "DISPATCH_CLOSED"
      )
      .every((event) => event.argvDigest === sha256Bytes(argvBytes)),
    MISMATCH
  );
  requireThat(argv.command === "docker" && Array.isArray(argv.args) && argv.args[0] === "run");
  requireThat(
    argv.args.at(-1) === `${trustedImage.registry}@${trustedImage.imageDigest}` &&
      argv.args[argv.args.indexOf("--network") + 1] === before.networkId,
    MISMATCH
  );
  for (const [value, running] of [
    [before, true],
    [after, false]
  ]) {
    requireThat(
      value.id === request.containerId &&
        value.imageId === image.id &&
        value.imageReference === `${trustedImage.registry}@${trustedImage.imageDigest}` &&
        value.running === running &&
        value.paused === false &&
        value.restarting === false &&
        value.dead === false &&
        value.readonlyRootfs === true &&
        value.privileged === false &&
        /^[0-9a-f]{64}$/u.test(value.networkId) &&
        value.networkMode === before.networkId &&
        value.networkId === before.networkId &&
        equal(value.capDrop, ["ALL"]) &&
        equal(value.securityOpt, ["no-new-privileges"]) &&
        equal(value.tmpfs, {
          "/tmp": "rw,noexec,nosuid,size=64m",
          "/var/lib/postgresql/data": "rw,noexec,nosuid,size=1m"
        }) &&
        Array.isArray(value.mounts) &&
        value.mounts.every(
          (mount) =>
            mount.Type === "tmpfs" &&
            ["/tmp", "/var/lib/postgresql/data"].includes(mount.Destination)
        ) &&
        (value.ports === null ||
          exact(value.ports, []) ||
          (exact(value.ports, ["5432/tcp"]) && value.ports["5432/tcp"] === null)) &&
        (value.portBindings === null || exact(value.portBindings, [])) &&
        value.defaultEntrypoint === true &&
        value.defaultCommand === true &&
        equal(value.manualMode, [true]),
      MISMATCH
    );
  }
  return process;
}

export async function verifyManualRunnerResult(input) {
  requireThat(
    exact(input, ["operationRef"]) &&
      typeof input.operationRef === "string" &&
      UUID.test(input.operationRef),
    MISMATCH
  );
  const operationRef = input.operationRef,
    resources = [];
  let fixed;
  try {
    const profile = await loadFixedManualProfile({ repoRoot });
    const owner = await ownerInputs();
    resources.push(owner);
    requireThat(encodeManualJson(profile).equals(owner.profileBytes), MISMATCH);
    const principal = canonical(owner.bindingBytes).principal;
    fixed = await readFixedManualOperation({ repoRoot, operationRef });
    const operation = fixed.operation;
    requireThat(
      operation.operationRef === operationRef &&
        operation.profileDigest === sha256Canonical(profile),
      MISMATCH
    );
    const build = await verifyManualBuild({
      repoRoot,
      proofBytes: fixed.proofBytes,
      materialBytes: fixed.materialBytes
    });
    requireThat(
      ["buildProofDigest", "proofRawDigest", "materialRawDigest", "custodyReceiptRawDigest"].every(
        (key) => build[key] === operation[key]
      ),
      MISMATCH
    );
    const h3 = await openManualH3AInputs({ fixed, profile, principal });
    resources.push(h3);
    const targetContext = h3.context.targetContext;
    const archive = archiveInputs(profile, principal);
    resources.push(archive);
    const { graph, raw } = await readGraph(archive, profile);
    const consumptions = await consumedHistory(archive, profile, graph);
    const selectedTarget = profile.allowedTargets.find((target) =>
      equal(fields(target, ["endpointPolicyId", "databaseName"]), operation.targetIntent)
    );
    requireThat(selectedTarget, MISMATCH);
    const identities = Object.values(operation.operations);
    const owned = new Map(),
      targetRequests = [];
    for (const [digest, item] of graph) {
      const request = item.value;
      if (request.schemaVersion !== "manual-runner-request.v1") continue;
      validateManualRunnerRequest(request);
      const belongs =
        request.runId === operation.runId ||
        identities.some(
          (identity) =>
            request.operationId === identity.operationId ||
            request.idempotencyKey === identity.idempotencyKey
        );
      if (belongs) {
        const expectedIdentity =
          operation.operations[
            request.stage === "target-observe"
              ? "observe"
              : request.phase === "verify"
                ? "verify"
                : "migrate"
          ];
        requireThat(
          request.runId === operation.runId &&
            request.profileDigest === operation.profileDigest &&
            request.operationId === expectedIdentity.operationId &&
            request.idempotencyKey === expectedIdentity.idempotencyKey &&
            equal(request.targetIntent, operation.targetIntent),
          MISMATCH
        );
        requireThat(consumptions.has(digest));
        const phase = request.phase ?? "observe";
        requireThat(!owned.has(phase), MISMATCH);
        owned.set(phase, { digest, item });
      }
      if (!consumptions.has(digest)) continue;
      const target = profile.allowedTargets.find((entry) =>
        equal(fields(entry, ["endpointPolicyId", "databaseName"]), request.targetIntent)
      );
      requireThat(target, MISMATCH);
      if (
        target.endpoint === selectedTarget.endpoint &&
        target.databaseName === selectedTarget.databaseName
      )
        targetRequests.push({ digest, item, belongs });
    }
    const phases =
      operation.scenario === "normal"
        ? ["observe", "dry-run", "apply", "verify", "replay"]
        : ["observe", "dry-run", "apply", "reconcile"];
    requireThat(["normal", "apply-interrupted"].includes(operation.scenario), MISMATCH);
    const seen = [...owned.keys()];
    requireThat(
      seen.every((phase) => phases.includes(phase)) &&
        phases.slice(0, seen.length).every((phase) => owned.has(phase)),
      MISMATCH
    );
    const expectedReaders = new Map();
    for (const phase of phases.filter((phase) => phase !== "observe" && owned.has(phase))) {
      const request = owned.get(phase).item.value;
      const allocation = original(graph, request.attemptAllocationDigest, "attempt-allocation");
      const reader = await openManualExpectedSchemaInputs({
        fixed,
        build,
        profile,
        principal,
        targetContext,
        allocation,
        attemptAllocationDigest: request.attemptAllocationDigest
      });
      resources.push(reader);
      expectedReaders.set(phase, reader);
      const admission = await reader.readRecordedAdmission();
      requireThat(
        admission.context.admission.schemaExpectation.digest ===
          request.expectedSchemaEvidenceDigest &&
          equal(
            reader.context.expectation,
            original(graph, request.expectedSchemaEvidenceDigest, "schema-expectation")
          ),
        MISMATCH
      );
    }
    const currentAttestations = expectedReaders.size
      ? await currentExpectedAttestations(expectedReaders.values().next().value, profile, build)
      : [];
    const assessments = new Map(),
      executions = new Map(),
      processes = new Map();
    const artifactBytes = [...graph.values()].map((item) => item.bytes),
      rawBlobs = [...raw.values()];
    for (const entry of targetRequests) {
      const request = entry.item.value,
        consumed = consumptions.get(entry.digest).value;
      const originals = [...graph].filter(
        ([, item]) => item.value.kind === "execution" && item.value.requestDigest === entry.digest
      );
      requireThat(originals.length === 1);
      const [executionDigest, executionItem] = originals[0],
        execution = executionItem.value;
      requireThat(
        execution.consumptionRecordDigest === sha256Canonical(consumed) &&
          execution.authorizationDigest === consumed.authorizationDigest,
        MISMATCH
      );
      let profileInput = {};
      if (request.profileDigest === operation.profileDigest)
        profileInput = { profileBytes: owner.profileBytes };
      else requireThat(consumed.schemaVersion === "manual-operation-record.v1", MISMATCH);
      const assessment = assessManualRunnerEvidence({
        ...profileInput,
        requestBytes: entry.item.bytes,
        artifactBytes,
        rawBlobs
      });
      if (execution.status !== "INTERRUPTED_UNKNOWN")
        requireThat(
          execution.status === assessment.executionStatus &&
            execution.resultDigest === assessment.proofDigest
        );
      else
        requireThat(
          assessment.executionStatus === "INTERRUPTED_UNKNOWN" ||
            (request.phase === "apply" &&
              assessment.executionStatus === "SUCCEEDED" &&
              assessment.originalDatabaseOutcome === "committed")
        );
      assessments.set(entry.digest, assessment);
      executions.set(entry.digest, { digest: executionDigest, value: execution });
      if (request.profileDigest === operation.profileDigest)
        await historicalAuthorization(archive, profile, entry.item, consumed, execution, graph);
      if (entry.belongs) {
        await archive.object(executionDigest, "archive");
        if (
          request.stage === "runner-command" &&
          (execution.status === "SUCCEEDED" || execution.finishedAt !== null)
        )
          await archive.object(executionDigest, "backup");
        if (request.stage === "runner-command")
          processes.set(
            entry.digest,
            await runnerOriginals(
              archive,
              profile,
              fixed,
              build,
              request,
              execution,
              graph,
              raw,
              targetContext
            )
          );
      }
    }
    const unresolved = new Set(
      targetRequests
        .filter(({ digest }) => executions.get(digest).value.status === "INTERRUPTED_UNKNOWN")
        .map(({ digest }) => digest)
    );
    for (const entry of targetRequests) {
      const request = entry.item.value,
        execution = executions.get(entry.digest).value,
        assessment = assessments.get(entry.digest);
      if (
        request.phase !== "reconcile" ||
        execution.status !== "SUCCEEDED" ||
        assessment.executionStatus !== "SUCCEEDED" ||
        !["committed", "not-committed"].includes(assessment.originalDatabaseOutcome)
      )
        continue;
      const prior = original(graph, request.predecessorExecutionRecordDigest, "execution");
      const priorRequest = original(graph, prior.requestDigest);
      requireThat(
        prior.status === "INTERRUPTED_UNKNOWN" &&
          priorRequest.phase === "apply" &&
          priorRequest.operationId === request.operationId &&
          priorRequest.idempotencyKey === request.idempotencyKey,
        MISMATCH
      );
      unresolved.delete(prior.requestDigest);
    }
    requireThat(
      [...unresolved].every(
        (digest) =>
          owned.get("apply")?.digest === digest && operation.scenario === "apply-interrupted"
      )
    );
    const counts = {
      expectedCommands: phases.length,
      consumedCommands: owned.size,
      succeededCommands: 0,
      failedCommands: 0,
      interruptedCommands: 0,
      unresolvedCommands: 0
    };
    for (const { digest } of owned.values()) {
      const status = executions.get(digest).value.status;
      requireThat(["SUCCEEDED", "FAILED", "INTERRUPTED_UNKNOWN"].includes(status));
      counts[
        status === "SUCCEEDED"
          ? "succeededCommands"
          : status === "FAILED"
            ? "failedCommands"
            : "interruptedCommands"
      ]++;
      if (unresolved.has(digest)) counts.unresolvedCommands++;
    }
    requireThat(counts.failedCommands === 0);
    const baselineCandidates = [...graph.values()].filter(
      ({ value }) =>
        value.schemaVersion === "manual-baseline-manifest.v1" &&
        owned.has("observe") &&
        value.identity?.authorizationDigest ===
          consumptions.get(owned.get("observe").digest).value.authorizationDigest
    );
    let baseline = null;
    if (owned.size) {
      requireThat(baselineCandidates.length === 1);
      baseline = baselineCandidates[0].value;
      requireThat(
        baseline.identity.buildProofDigest === build.buildProofDigest &&
          baseline.identity.physicalIdentity.databaseOid === targetContext.databaseOid &&
          baseline.identity.physicalIdentity.clusterFingerprint ===
            computeManualClusterFingerprint(targetContext.cluster),
        MISMATCH
      );
      for (const [phase, { digest, item }] of owned) {
        const request = item.value;
        if (phase === "observe") {
          requireThat(assessments.get(digest).executionStatus === "SUCCEEDED");
          continue;
        }
        requireThat(
          request.baselineManifestDigest === sha256Canonical(baseline) &&
            request.targetObservationDigest === baseline.identity.targetObservationDigest &&
            equal(request.physicalIdentity, baseline.identity.physicalIdentity),
          MISMATCH
        );
      }
    }
    if (owned.has("apply")) {
      const dry = owned.get("dry-run"),
        apply = owned.get("apply");
      const dryExecution = executions.get(dry.digest),
        applied = executions.get(apply.digest);
      const dryAssessment = assessments.get(dry.digest),
        applyAssessment = assessments.get(apply.digest);
      const dryResult = original(graph, dryExecution.value.resultDigest, "manual-command-result");
      requireThat(
        dryAssessment.executionStatus === "SUCCEEDED" &&
          dryResult.plan?.identity?.pendingMigrations?.length > 0 &&
          apply.item.value.dryRunRecordDigest === dryExecution.digest &&
          applied.value.predecessorExecutionRecordDigest === dryExecution.digest &&
          apply.item.value.approvedPlanDigest === deterministicPlanDigest(dryResult.plan),
        MISMATCH
      );
      requireThat(
        operation.scenario === "normal"
          ? applied.value.status === "SUCCEEDED" &&
              applyAssessment.originalDatabaseOutcome === "committed"
          : applied.value.status === "INTERRUPTED_UNKNOWN" &&
              ["SUCCEEDED", "INTERRUPTED_UNKNOWN"].includes(applyAssessment.executionStatus)
      );
      const second = phases.slice(3).filter((phase) => owned.has(phase));
      if (second.length) {
        const resultDigest = applyAssessment.proofDigest ?? applied.value.resultDigest;
        const result = resultDigest ? original(graph, resultDigest, "manual-command-result") : null;
        const migration = {
          branch: operation.scenario === "normal" ? "normal-success" : "apply-unknown-recovery",
          request: apply.item.value,
          execution: applied.value,
          process: processes.get(apply.digest),
          postObservation: result?.observationDigest
            ? original(graph, result.observationDigest, "observation")
            : null,
          migration: {
            operationId: apply.item.value.operationId,
            idempotencyKey: apply.item.value.idempotencyKey,
            attemptId: apply.item.value.attemptId,
            allocationDigest: apply.item.value.attemptAllocationDigest,
            requestDigest: apply.digest,
            approvedPlanDigest: apply.item.value.approvedPlanDigest,
            processEvidenceDigest: applied.value.processEvidenceDigest,
            resultDigest,
            executionRecordDigest: applied.digest
          }
        };
        const h3b = await openManualH3BInputs({
          fixed,
          profile,
          principal,
          h3InputBytes: h3.bytes,
          targetContext,
          migration
        });
        resources.push(h3b);
        await h3b.recheckArchived();
        for (const phase of second) {
          const current = owned.get(phase),
            request = current.item.value;
          requireThat(
            request.predecessorExecutionRecordDigest === applied.digest &&
              executions.get(current.digest).value.predecessorExecutionRecordDigest ===
                applied.digest &&
              assessments.get(current.digest).executionStatus === "SUCCEEDED",
            MISMATCH
          );
          if (phase === "reconcile")
            requireThat(assessments.get(current.digest).originalDatabaseOutcome === "committed");
        }
      }
    }
    const complete = owned.size === phases.length;
    requireThat(!complete || counts.unresolvedCommands === 0);
    const refreshed = await readFixedManualOperation({ repoRoot, operationRef });
    try {
      requireThat(
        refreshed.indexDigest === fixed.indexDigest &&
          refreshed.proofBytes.equals(fixed.proofBytes) &&
          refreshed.materialBytes.equals(fixed.materialBytes),
        MISMATCH
      );
    } finally {
      refreshed.proofBytes.fill(0);
      refreshed.materialBytes.fill(0);
    }
    for (const resource of resources) if (resource.recheck) await resource.recheck();
    const status = complete ? "PASS" : "NOT_RUN";
    const report = {
      operationRef,
      indexDigest: fixed.indexDigest,
      scenario: operation.scenario,
      runId: operation.runId,
      buildProofDigest: build.buildProofDigest,
      custodyReceiptRawDigest: operation.custodyReceiptRawDigest,
      currentAttestations,
      baselineDigest: baseline ? sha256Canonical(baseline) : null,
      status,
      counts,
      commands: phases
        .filter((phase) => owned.has(phase))
        .map((phase) => ({
          phase,
          requestDigest: owned.get(phase).digest,
          executionRecordDigest: executions.get(owned.get(phase).digest).digest
        })),
      promotionEligible: false
    };
    return Object.freeze({
      status,
      counts: Object.freeze(counts),
      recordDigest: sha256Canonical(report),
      promotionEligible: false
    });
  } catch (cause) {
    if ([INCOMPLETE, MISMATCH].includes(cause.code)) throw cause;
    throw Object.assign(new Error(INCOMPLETE, { cause }), { code: INCOMPLETE });
  } finally {
    const settled = await Promise.allSettled(
      resources.reverse().map((resource) => resource.close())
    );
    fixed?.proofBytes.fill(0);
    fixed?.materialBytes.fill(0);
    const failed = settled.find((result) => result.status === "rejected");
    if (failed)
      throw Object.assign(new Error(INCOMPLETE, { cause: failed.reason }), { code: INCOMPLETE });
  }
}
