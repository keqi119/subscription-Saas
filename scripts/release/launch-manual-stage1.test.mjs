import assert from "node:assert/strict";
import childProcess, { execFile } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import crypto, { generateKeyPairSync, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

// R1 deliberately captures its native OS boundary at module initialization.
// Install the same fixed Windows ACL double before loading R1, then restore the
// builtin. All later filesystem and cryptographic behavior remains genuine.
const initialExecFile = childProcess.execFile;
childProcess.execFile = (file, args, options, callback) => {
  if (file === "icacls.exe" || file === "powershell.exe") {
    const value =
      file === "icacls.exe"
        ? "synthetic session ACL\n"
        : "S-1-5-21-111-222-333-1001\nS-1-5-21-111-222-333-1001|Allow|2032127\n";
    queueMicrotask(() => callback(null, value, ""));
    return { kill() {} };
  }
  return initialExecFile(file, args, options, callback);
};
const sessionExecFile = childProcess.execFile;
sessionExecFile[Symbol.for("nodejs.util.promisify.custom")] = (...args) =>
  new Promise((resolve, reject) =>
    sessionExecFile(...args, (error, stdout, stderr) =>
      error ? reject(error) : resolve({ stdout, stderr })
    )
  );
syncBuiltinESMExports();
const {
  encodeManualJson,
  computeMigrationCatalog,
  computeRepositoryContract,
  sha256Bytes,
  sha256Canonical,
  assessManualRunnerEvidence,
  verifyManualAuthorization,
  signManualAuthorization,
  encodeManualRunnerFrame
} = await import("../../packages/release-foundation/src/index.mjs");
const { createBuildProof } = await import("./create-build-proof.mjs");
const {
  loadFixedManualProfile,
  readFixedManualOperation,
  verifyManualBuild,
  openTrustedManualSession
} = await import("./manual-stage1-trust.mjs");
childProcess.execFile = initialExecFile;
syncBuiltinESMExports();

const launcherFile = fileURLToPath(new URL("./launch-manual-stage1.mjs", import.meta.url));
const operationRef = "abcdefab-1111-4111-8111-abcdefabcdef";
// Only PostgreSQL's OS/network client is replaced. The production connector,
// transaction adapter, observer, session and archive readers execute unchanged.
const pgClientSlot = Symbol.for("r22.offline.postgres-client");
const pgHook = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "postgres")
      return {
        url:
          "data:text/javascript," +
          encodeURIComponent(
            'export default options => globalThis[Symbol.for("r22.offline.postgres-client")](options);'
          ),
        shortCircuit: true
      };
    return next(specifier, context);
  }
});
const launcher = await import("./launch-manual-stage1.mjs").catch((error) => {
  if (error.code === "ERR_MODULE_NOT_FOUND" && error.url?.endsWith("/launch-manual-stage1.mjs"))
    return null;
  throw error;
});
// Resolve the genuine connector while the single PG-edge hook is active.
await import("../../apps/release-runner/src/postgres-connector.mjs");
pgHook.deregister();

function invoke(argv, extraEnvironment = {}, entrypoint = launcherFile) {
  // Test-only native boundary guards run in the actual CLI child. They deny
  // any external process/socket and count attempted credential/metadata access.
  const preload = `
    import fs from 'node:fs/promises'; import cp from 'node:child_process';
    import net from 'node:net'; import tls from 'node:tls'; import {syncBuiltinESMExports} from 'node:module';
    const effects={processSpawn:0,secretReads:0,metadataWrites:0,databaseConnections:0};
    for(const name of ['spawn','exec','execFile','fork']) cp[name]=()=>{effects.processSpawn++;throw new Error('External child forbidden');};
    net.Socket.prototype.connect=()=>{effects.databaseConnections++;throw new Error('Socket forbidden');};
    tls.connect=()=>{effects.databaseConnections++;throw new Error('TLS forbidden');};
    for(const name of ['open','readFile','writeFile','mkdir']) {const native=fs[name].bind(fs);fs[name]=(...args)=>{
      if(/(?:^|[\\\\/])(?:key|credential)(?:[\\\\/]|$)/u.test(String(args[0]))) {effects.secretReads++;throw new Error('Secret input forbidden');}
      if(name==='writeFile'||name==='mkdir'||(name==='open'&&args[1]!=='r')) effects.metadataWrites++;
      return native(...args);
    };}
    syncBuiltinESMExports();
    process.once('exit',()=>process.stderr.write('EFFECTS:'+JSON.stringify(effects)+'\\n'));
  `;
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, entrypoint, ...argv],
      {
        shell: false,
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 8192,
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...extraEnvironment }
      },
      (error, stdout, stderr) => {
        const match = stderr.match(/EFFECTS:(\{[^\n]+\})\n$/u);
        resolve({
          exit: error?.code ?? 0,
          stdout,
          stderr: match ? stderr.slice(0, match.index) : stderr,
          effects: match ? JSON.parse(match[1]) : null
        });
      }
    );
  });
}
function noCliEffects(result) {
  assert.deepEqual(result.effects, {
    processSpawn: 0,
    secretReads: 0,
    metadataWrites: 0,
    databaseConnections: 0
  });
}

for (const argv of [
  [],
  ["--command", "db.migrate.deploy@1"],
  ["--entrypoint", "sh"],
  ["--shell", "sh"],
  ["--adapter", "adapter.mjs"],
  ["--profile-file", "profile.json"],
  ["--archive-root", "archive"],
  ["--credentials", "secret"],
  ["--operation-ref", "../index.json"],
  ["--operation-ref", operationRef.toUpperCase()],
  ["--operation-ref", operationRef, "--command", "db.schema.verify@1"],
  ["--operation-ref", operationRef, "extra"],
  ["--operation-ref", "sha256:" + "a".repeat(64)]
]) {
  test(`fixed launcher rejects argv ${JSON.stringify(argv)} before input access`, async () => {
    const result = await invoke(argv);
    assert.equal(result.exit, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "MANUAL_LAUNCH_INVOCATION_REJECTED\n");
    noCliEffects(result);
  });
}

test("fixed launcher rejects mixing manual ref with the old launch-envelope mode", async () => {
  const result = await invoke(["--operation-ref", operationRef], {
    RUNNER_LAUNCH_ENVELOPE_FILE: "forbidden-old-envelope.json"
  });
  assert.equal(result.exit, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "MANUAL_LAUNCH_INVOCATION_REJECTED\n");
  noCliEffects(result);
});

test("unknown ref with no H1 cannot open a session or fall back to a legacy launcher", async () => {
  const result = await invoke(["--operation-ref", operationRef]);
  assert.equal(result.exit, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "MANUAL_OPERATION_INPUT_UNAVAILABLE\n");
  noCliEffects(result);
});

test("metadata prepare requires the formal four-key input without caller IO authority", async () => {
  assert.equal(typeof launcher?.prepareManualOperation, "function");
  await assert.rejects(
    launcher.prepareManualOperation({
      proofBytes: Buffer.from("{}"),
      materialBytes: Buffer.from("{}"),
      targetIntent: { endpointPolicyId: "synthetic-policy", databaseName: "synthetic-db" },
      scenario: "normal",
      repoRoot: "/caller-authority"
    }),
    { code: "MANUAL_OPERATION_INPUT_UNAVAILABLE" }
  );
});

test("real Runner CLI manual mode alone cannot consume credentials or connect a database", async () => {
  const result = await invoke(
    [],
    { RUNNER_EXECUTION_MODE: "manual-stage1" },
    fileURLToPath(new URL("../../apps/release-runner/src/cli.mjs", import.meta.url))
  );
  assert.equal(result.exit, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "MANUAL_AUTHORIZATION_REQUIRED\n");
  noCliEffects(result);
});

test("launcher API rejects non-string UUID and extra caller authority before fixed IO", async () => {
  for (const input of [
    { operationRef: { toString: () => operationRef } },
    { operationRef, adapter: {} }
  ])
    await assert.rejects(launcher.launchManualStage1(input), {
      code: "MANUAL_LAUNCH_INVOCATION_REJECTED"
    });
});

const productionRoot = fileURLToPath(new URL("../../", import.meta.url)).replace(/[\\/]$/u, "");
const profileName = "release/contracts/manual-stage1-profile.v2.json";
const bindingName = "release/contracts/manual-stage1-owner-binding.v1.json";
const repository = "keqi119/subscription-Saas";
const workflowPath = ".github/workflows/docker-images.yml";
const generatedAt = "2026-09-01T00:00:00.000Z";
const runId = 2801;
const digest = (character) => `sha256:${character.repeat(64)}`;
const nativeExecFile = childProcess.execFile.bind(childProcess);
const nativeUUID = crypto.randomUUID.bind(crypto);
const nativeFS = Object.fromEntries(
  ["open", "lstat", "realpath", "readFile", "readdir", "mkdir", "writeFile"].map((name) => [
    name,
    fs[name].bind(fs)
  ])
);
const sid = "S-1-5-21-111-222-333-1001";
const guid = "01234567-89ab-4cde-8fab-0123456789ab";
const systemRoot = "C:\\Windows";
const system = systemRoot + "\\System32\\";

async function git(repoRoot, ...args) {
  return new Promise((resolve, reject) =>
    nativeExecFile(
      "git",
      [
        "-c",
        "core.hooksPath=NUL",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Synthetic Test",
        "-c",
        "user.email=test@example.invalid",
        "-C",
        repoRoot,
        ...args
      ],
      {
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 1048576,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "NUL"
        }
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim()))
    )
  );
}

async function fixture(t, endpoint = "db.invalid:5432") {
  assert.ok(["win32", "linux"].includes(process.platform));
  const root = await fs.mkdtemp(path.join(tmpdir(), "r22-metadata-"));
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("r22-metadata-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const repoRoot = path.join(root, "repo");
  await fs.mkdir(path.join(repoRoot, "release", "contracts"), { recursive: true });
  const storage = { keyRef: "owner.key", retentionDays: 90 };
  for (const name of ["key", "journal", "archive", "backup", "credential"]) {
    storage[`${name}Root`] = path.join(root, name);
    await fs.mkdir(storage[`${name}Root`], { mode: 0o700 });
  }
  const keys = generateKeyPairSync("ed25519");
  const profile = {
    schemaVersion: "manual-stage1-profile.v2",
    profileId: randomUUID(),
    ownerId: "synthetic-owner",
    publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }),
    keyFingerprint: sha256Bytes(keys.publicKey.export({ type: "spki", format: "der" })),
    validFrom: "2020-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    buildTrust: {
      repository,
      workflow: `${repository}/${workflowPath}`,
      sourceRef: "refs/heads/main",
      oidcIssuer: "https://token.actions.githubusercontent.com",
      runnerClass: "github-hosted"
    },
    allowedCommands: [
      { commandId: "db.migrate.deploy", commandVersion: "1", capability: "migrate" },
      { commandId: "db.schema.verify", commandVersion: "1", capability: "verify" }
    ],
    allowedTargets: [
      {
        endpointPolicyId: "synthetic-policy",
        endpoint,
        databaseName: "synthetic-db",
        purposes: ["synthetic-fresh"],
        roles: { observer: "observer", migrate: "migrate", verify: "verify" },
        tls: "required"
      }
    ],
    storage
  };
  const approval = {
    schemaVersion: "manual-stage1-owner-approval.v1",
    profileDigest: sha256Canonical(profile),
    ownerId: profile.ownerId,
    principal:
      process.platform === "linux"
        ? { platform: "posix", uid: process.getuid() }
        : { platform: "win32", sid },
    hostFingerprint: sha256Bytes(
      Buffer.from(
        process.platform === "linux"
          ? `subscription-saas/linux-machine-id/v1\n${(await nativeFS.readFile("/etc/machine-id", "utf8")).trim()}`
          : `subscription-saas/win32-machine-guid/v1\n${guid}`
      )
    ),
    approvedAt: generatedAt,
    promotionEligible: false
  };
  const approvalBytes = encodeManualJson(approval),
    approvalDigest = sha256Bytes(approvalBytes);
  const binding = {
    ...approval,
    schemaVersion: "manual-stage1-owner-binding.v1",
    approvalDigest,
    approvalReference: `inputs/h1/${approvalDigest.slice(7)}.approval.json`
  };
  const approvalPath = path.join(storage.archiveRoot, binding.approvalReference);
  await fs.mkdir(path.dirname(approvalPath), { recursive: true, mode: 0o700 });
  for (const [file, bytes] of [
    [path.join(repoRoot, profileName), encodeManualJson(profile)],
    [path.join(repoRoot, bindingName), encodeManualJson(binding)],
    [approvalPath, approvalBytes]
  ])
    await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  const systemDir = path.join(root, "synthetic-system");
  for (const relative of [
    "System32/reg.exe",
    "System32/whoami.exe",
    "System32/icacls.exe",
    "System32/WindowsPowerShell/v1.0/powershell.exe"
  ]) {
    const file = path.join(systemDir, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "synthetic executable");
  }
  return {
    root,
    repoRoot,
    profile,
    approval,
    binding,
    approvalPath,
    keys,
    systemDir,
    docker: { calls: [], outputs: null, before: null },
    counters: {
      privateKeyReads: 0,
      indexWrites: 0,
      sessionWrites: 0,
      credentialReads: 0,
      externalCalls: 0
    },
    host: { guid, sid, badRoot: null }
  };
}

function installFixedIO(t, f, gh) {
  const sourceMapped = (file) =>
    typeof file === "string" &&
    (file === productionRoot || file.startsWith(productionRoot + path.sep)) &&
    !file.includes(path.join("release", "contracts", "schemas"));
  const mapped = (file) =>
    typeof file !== "string"
      ? file
      : file.startsWith(systemRoot)
        ? path.join(f.systemDir, file.slice(systemRoot.length))
        : sourceMapped(file)
          ? path.join(f.repoRoot, path.relative(productionRoot, file))
          : file;
  for (const name of ["lstat", "readFile", "readdir", "mkdir", "writeFile"])
    t.mock.method(fs, name, (file, ...args) => nativeFS[name](mapped(file), ...args));
  t.mock.method(fs, "realpath", async (file, ...args) => {
    const real = await nativeFS.realpath(mapped(file), ...args);
    return sourceMapped(file) || String(file).startsWith(systemRoot) ? file : real;
  });
  t.mock.method(fs, "open", async (file, flags, ...args) => {
    const actual = mapped(file);
    if (actual.startsWith(f.profile.storage.keyRoot + path.sep)) f.counters.privateKeyReads++;
    if (actual.startsWith(f.profile.storage.credentialRoot + path.sep)) {
      f.counters.credentialReads++;
      (f.counters.credentialPaths ??= []).push(actual);
    }
    if (String(flags) !== "r" && actual.startsWith(f.profile.storage.journalRoot + path.sep))
      f.counters.sessionWrites++;
    if (String(flags) !== "r" && actual.endsWith(path.sep + "index.json")) f.counters.indexWrites++;
    return nativeFS.open(actual, flags, ...args);
  });
  t.mock.method(childProcess, "execFile", (file, args, options, callback) => {
    if (f.host.before) f.host.before(file, args);
    let value;
    if (file === "git") {
      const actualArgs = args.map((arg) => (arg === productionRoot ? f.repoRoot : arg));
      return nativeExecFile(file, actualArgs, options, (error, stdout, stderr) => {
        const output =
          args.includes("--show-toplevel") && !error ? Buffer.from(productionRoot) : stdout;
        callback(error, output, stderr);
      });
    }
    if (file === "gh") {
      if (gh.before) gh.before(args);
      gh.calls.push({ file, args: [...args], options: { ...options } });
      if (args[0] === "attestation" && args[2] === gh.paths.proof) value = gh.proof;
      else if (args[0] === "attestation" && args[2] === gh.paths.receipt) value = gh.receipt;
      else if (
        args[0] === "api" &&
        args[1] === `repos/${repository}/actions/runs/${runId}/attempts/1`
      )
        value = gh.run;
      else throw new Error("Unexpected synthetic gh invocation");
      value = Buffer.from(JSON.stringify(value));
    } else if (file === "docker" && f.docker.outputs) {
      f.docker.calls.push({ args: [...args], options: { ...options } });
      const kind = args[2] === "container" && args[3] === "ls" ? "users" : args[2];
      assert.equal(args[0], "--host");
      assert.equal(
        args[1],
        process.platform === "linux"
          ? "unix:///var/run/docker.sock"
          : "npipe:////./pipe/docker_engine"
      );
      assert.equal(args[3], kind === "users" ? "ls" : "inspect");
      assert.equal(options.shell, false);
      assert.equal(options.encoding, "buffer");
      assert.equal(options.windowsHide, true);
      assert.ok(options.timeout > 0 && options.timeout <= 10000);
      assert.ok(options.maxBuffer <= 1048576);
      assert.ok(
        Object.keys(options.env).every((key) => ["PATH", "SystemRoot", "WINDIR"].includes(key))
      );
      if (f.docker.before) f.docker.before(kind, args);
      if (f.docker.native) return f.docker.native(args, options, callback);
      const observed = f.docker.outputs[kind];
      assert.notEqual(observed, undefined, "only fixed read-only Docker observations are allowed");
      if (observed instanceof Error) {
        queueMicrotask(() =>
          callback(observed, Buffer.alloc(0), Buffer.from("private daemon error"))
        );
        return { kill() {} };
      }
      value = Buffer.isBuffer(observed) ? observed : Buffer.from(JSON.stringify(observed) + "\n");
    } else if (file === "icacls.exe") value = Buffer.from("synthetic session ACL\n");
    else if (file === "powershell.exe") value = Buffer.from(`${sid}\n${sid}|Allow|2032127\n`);
    else if (file === system + "reg.exe")
      value = Buffer.from(
        `HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    {${f.host.guid}}\r\n`
      );
    else if (file === system + "whoami.exe")
      value = Buffer.from(`"synthetic\\owner","${f.host.sid}"\r\n`);
    else if (file === system + "icacls.exe") value = Buffer.from("synthetic ACL observation\n");
    else if (file === system + "WindowsPowerShell\\v1.0\\powershell.exe") {
      const script = args.at(-1),
        isSystem = script.includes(systemRoot),
        bad = f.host.badRoot && script.includes(f.host.badRoot.replaceAll("'", "''")),
        wide = f.host.wideRoot && script.includes(f.host.wideRoot.replaceAll("'", "''"));
      value = Buffer.from(
        isSystem
          ? "S-1-5-18\nS-1-5-18|Allow|2032127\nattributes|0\n"
          : `${bad ? "S-1-5-21-999" : sid}\n${sid}|Allow|2032127\n${wide ? "S-1-5-32-545|Allow|1179817\n" : ""}attributes|0\n`
      );
    } else {
      f.counters.externalCalls++;
      throw new Error("Unexpected external process denied");
    }
    queueMicrotask(() =>
      callback(
        null,
        options.encoding === "buffer" ? value : value.toString("utf8"),
        options.encoding === "buffer" ? Buffer.alloc(0) : ""
      )
    );
    return { kill() {} };
  });
  syncBuiltinESMExports();
}

function verifiedItem(bytes, sourceSha, name, timestamp = generatedAt) {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name, digest: { sha256: sha256Bytes(bytes).slice(7) } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://actions.github.io/buildtypes/workflow/v1",
        externalParameters: {}
      },
      runDetails: { builder: { id: "https://github.com/actions/runner" } }
    }
  };
  return {
    attestation: {
      bundle: {
        mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
        verificationMaterial: {
          certificate: { rawBytes: Buffer.from("synthetic-certificate").toString("base64") },
          tlogEntries: []
        },
        dsseEnvelope: {
          payloadType: "application/vnd.in-toto+json",
          payload: encodeManualJson(statement).toString("base64"),
          signatures: [{ sig: Buffer.alloc(64, 1).toString("base64") }]
        }
      },
      bundle_url: "https://synthetic.invalid/short-lived-download",
      initiator: "github"
    },
    verificationResult: {
      statement,
      signature: {
        certificate: {
          issuer: "https://token.actions.githubusercontent.com",
          subjectAlternativeName: {
            type: "URI",
            value: `https://github.com/${repository}/${workflowPath}@refs/heads/main`
          },
          buildSignerURI: `https://github.com/${repository}/${workflowPath}@refs/heads/main`,
          buildSignerDigest: sourceSha,
          runnerEnvironment: "github-hosted",
          sourceRepositoryURI: `https://github.com/${repository}`,
          sourceRepositoryDigest: sourceSha,
          sourceRepositoryRef: "refs/heads/main",
          sourceRepositoryIdentifier: "10001",
          sourceRepositoryOwnerURI: "https://github.com/keqi119",
          sourceRepositoryOwnerIdentifier: "10002",
          buildConfigURI: `https://github.com/${repository}/${workflowPath}@refs/heads/main`,
          buildConfigDigest: sourceSha,
          buildTrigger: "push",
          runInvocationURI: `https://github.com/${repository}/actions/runs/${runId}/attempts/1`,
          sourceRepositoryVisibilityAtSigning: "public"
        }
      },
      verifiedTimestamps: [{ type: "Tlog", uri: "https://rekor.sigstore.dev", timestamp }]
    }
  };
}

async function buildFixture(t, endpoint) {
  const f = await fixture(t, endpoint);
  const manifest = "release/contracts/repository-contract-files.v1.json";
  const entrypoints = [
    "scripts/release/manual-stage1-trust.mjs",
    "scripts/release/verify-build-proof.mjs"
  ];
  await fs.mkdir(path.join(f.repoRoot, "scripts", "release"), { recursive: true });
  await fs.mkdir(path.join(f.repoRoot, "apps", "api", "prisma", "migrations"), { recursive: true });
  for (const file of entrypoints)
    await fs.copyFile(
      new URL(`./${path.basename(file)}`, import.meta.url),
      path.join(f.repoRoot, file)
    );
  await fs.writeFile(
    path.join(f.repoRoot, manifest),
    encodeManualJson({
      contractVersion: "repository-contract-files.v1",
      files: [manifest, profileName, bindingName, ...entrypoints].sort()
    }),
    { mode: 0o600 }
  );
  await git(f.repoRoot, "init", "--initial-branch=main");
  await git(f.repoRoot, "add", "--all");
  await git(f.repoRoot, "commit", "--no-verify", "-m", "Synthetic fixed trust inputs");
  const sourceSha = await git(f.repoRoot, "rev-parse", "HEAD");
  const contract = await computeRepositoryContract(f.repoRoot);
  const catalog = await computeMigrationCatalog(f.repoRoot);
  const ciRunRef = `https://github.com/${repository}/actions/runs/${runId}`;
  const images = ["api", "web", "runner"].map((name, index) => {
    const image = `ghcr.io/keqi119/subscription-${name}`,
      imageDigest = digest(String(index + 1));
    return {
      name,
      image,
      platform: "linux/amd64",
      digest: imageDigest,
      sourceRevision: sourceSha,
      baseImageDigests: [
        { image: "node:22-bookworm-slim", declaredDigest: digest("a"), digest: digest("b") }
      ],
      builderName: "https://mobyproject.org/buildkit@v1",
      buildAttestationRef: `oci://${image}@${imageDigest}#provenance=${digest("c")}`,
      registrySubject: `${image}@${imageDigest}`,
      buildRunRef: ciRunRef
    };
  });
  const material = {
    schemaVersion: "build-material-observation.v1",
    sourceSha,
    checkoutRef: sourceSha,
    ciRunRef,
    repositoryContractDigest: contract.digest,
    migrationCatalogDigest: catalog.digest,
    policyDigest: digest("f"),
    promotionEligibility: "trusted-candidate",
    images,
    externalActions: [
      { name: "actions/checkout", commitSha: "2".repeat(40) },
      { name: "docker/build-push-action", commitSha: "3".repeat(40) }
    ],
    builder: {
      name: "https://mobyproject.org/buildkit@v1",
      provenanceRef: `build-material-attestations:${digest("4")}`
    },
    observedAt: generatedAt
  };
  const proof = structuredClone(
    createBuildProof({
      sourceSha,
      images,
      migrationCatalog: catalog,
      repositoryContract: contract,
      provenance: {
        generatedAt,
        ciRunRef,
        attestationRef: material.builder.provenanceRef,
        checkoutRef: sourceSha,
        buildMaterialObservation: material
      }
    })
  );
  const proofBytes = Buffer.from(JSON.stringify(proof, null, 2) + "\n");
  const materialBytes = Buffer.from(JSON.stringify(material, null, 2) + "\n");
  const proofItem = verifiedItem(proofBytes, sourceSha, "build-proof.json");
  const receipt = {
    schemaVersion: "custody-receipt.retention90.v1",
    receiptId: randomUUID(),
    contentDigest: sha256Canonical(proof),
    contentSizeBytes: encodeManualJson(proof).length,
    storeRef: `s3://synthetic-authority/private/${sha256Canonical(proof).slice(7)}.json`,
    uploadedAt: generatedAt,
    readbackAt: "2026-09-01T00:00:01.000Z",
    readbackDigest: sha256Canonical(proof),
    owner: "release-engineering",
    readers: ["release", "qa", "security", "audit"],
    retainUntil: "2026-11-30T00:00:00.000Z",
    expiryDisposition: "review",
    attestationRef: sha256Canonical(proofItem.attestation.bundle)
  };
  const buildRoot = path.join(f.profile.storage.archiveRoot, "inputs", "build");
  await fs.mkdir(buildRoot, { recursive: true, mode: 0o700 });
  const proofPath = path.join(buildRoot, `${sha256Bytes(proofBytes).slice(7)}.proof.json`);
  const materialPath = path.join(buildRoot, `${sha256Bytes(materialBytes).slice(7)}.material.json`);
  const receiptPath = path.join(
    buildRoot,
    `${sha256Bytes(proofBytes).slice(7)}.custody-receipt.retention90.v1.json`
  );
  const receiptBytes = encodeManualJson(receipt);
  for (const [file, bytes] of [
    [proofPath, proofBytes],
    [materialPath, materialBytes],
    [receiptPath, receiptBytes]
  ])
    await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  const gh = {
    proof: [proofItem],
    receipt: [
      verifiedItem(receiptBytes, sourceSha, "custody-receipt.json", "2026-09-01T00:00:02.000Z")
    ],
    run: {
      id: runId,
      run_attempt: 1,
      head_sha: sourceSha,
      head_branch: "main",
      status: "completed",
      conclusion: "success",
      path: workflowPath,
      html_url: ciRunRef,
      repository: { full_name: repository },
      head_repository: { full_name: repository },
      event: "push",
      workflow_id: 3001
    },
    calls: [],
    before: null,
    error: null,
    stderr: Buffer.alloc(0),
    raw: null
  };
  gh.paths = { proof: proofPath, receipt: receiptPath };
  installFixedIO(t, f, gh);
  return {
    ...f,
    sourceSha,
    proof,
    material,
    proofBytes,
    materialBytes,
    proofPath,
    materialPath,
    receipt,
    receiptBytes,
    receiptPath,
    gh
  };
}

function prepareInput(f, overrides = {}) {
  return {
    proofBytes: f.proofBytes,
    materialBytes: f.materialBytes,
    targetIntent: { endpointPolicyId: "synthetic-policy", databaseName: "synthetic-db" },
    scenario: "normal",
    ...overrides
  };
}
function noAuthority(f) {
  assert.equal(f.counters.privateKeyReads, 0);
  assert.equal(f.counters.sessionWrites, 0);
  assert.equal(f.counters.credentialReads, 0);
  assert.equal(f.counters.externalCalls, 0);
}

async function zeroCredentialFixture(t, mode = "split") {
  const f = await targetObserveFixture(t);
  await launcher.connectAndObserveManualTarget({
    session: await f.open(),
    operationRef: f.prepared.operationRef
  });
  const originals = await f.records();
  const baseline = originals.find((v) => v.schemaVersion === "manual-baseline-manifest.v1");
  const indexBytes = await fs.readFile(path.join(f.operationRoot, "index.json"));
  const baselineBytes = await fs.readFile(f.objectPath(baseline));
  const credentialReads = f.counters.credentialReads;
  const keyReads = f.counters.privateKeyReads;
  const nativeSpawn = childProcess.spawn.bind(childProcess);
  const previousExec = childProcess.execFile.bind(childProcess);
  const id = "e".repeat(64);
  const challenge = encodeManualRunnerFrame({
    protocol: "MS2",
    type: "CHALLENGE",
    sequence: 0,
    payload: { childChallenge: "f".repeat(64) }
  });
  let child;
  const launches = [];
  const actualCloses = [];
  const readOpens = new Map(),
    previousOpen = fs.open.bind(fs);
  t.mock.method(fs, "open", (file, flags, ...args) => {
    if (flags === "r") readOpens.set(String(file), (readOpens.get(String(file)) ?? 0) + 1);
    return previousOpen(file, flags, ...args);
  });
  t.mock.method(childProcess, "spawn", (file, args, options) => {
    assert.equal(file, "docker");
    assert.equal(args[0], "run");
    const cid = args[args.indexOf("--cidfile") + 1];
    const attemptId = /^\/tmp\/manual-stage1-([0-9a-f-]+)\/runner\.cid$/u.exec(cid)?.[1];
    assert.ok(attemptId);
    const records = fsSync
      .readdirSync(path.join(f.profile.storage.archiveRoot, "objects"))
      .map((name) =>
        JSON.parse(fsSync.readFileSync(path.join(f.profile.storage.archiveRoot, "objects", name)))
      );
    const prepared = records.find((v) => v.kind === "process" && v.attemptId === attemptId);
    assert.equal(prepared?.requestDigest, null, "PREPARED must be saved before the actual spawn");
    assert.ok(
      readOpens.get(f.objectPath(prepared)) >= 4,
      "PREPARED must be independently reopened before spawn"
    );
    assert.deepEqual(
      prepared.events.map((e) => e.event),
      ["PREPARED"]
    );
    const allocation = records.find(
      (v) => v.kind === "attempt-allocation" && v.attemptId === attemptId
    );
    assert.equal(allocation?.phaseKey, "dry-run");
    assert.ok(
      readOpens.get(f.objectPath(allocation)) >= 4,
      "allocation must be independently reopened before spawn"
    );
    assert.equal(allocation.operationId, JSON.parse(indexBytes).operations.migrate.operationId);
    assert.equal(options.env.DOCKER_HOST, "unix:///var/run/docker.sock");
    assert.deepEqual(fsSync.readdirSync(options.env.DOCKER_CONFIG), []);
    assert.equal(process.umask(), 0o077);
    const cidWrite =
      mode === "empty-cid"
        ? `fs.writeFileSync(${JSON.stringify(cid)}, ''); setTimeout(()=>fs.writeFileSync(${JSON.stringify(cid)},${JSON.stringify(id)}),150);`
        : `fs.writeFileSync(${JSON.stringify(cid)},${JSON.stringify(id)});`;
    const source = `import fs from 'node:fs'; ${cidWrite} const bytes=Buffer.from(${JSON.stringify(challenge.toString("base64"))},'base64'); ${mode === "invalid" ? "process.stdout.write(Buffer.from([255]));" : mode === "limit" ? "process.stdout.write(bytes); process.stderr.write(Buffer.alloc(1048577,65));" : mode === "early" ? "process.exit(7);" : mode === "stderr-invalid" ? "process.stdout.write(bytes);process.stderr.write(Buffer.from([255]));" : "for(let i=0;i<bytes.length;i+=7) process.stdout.write(bytes.subarray(i,i+7));"} process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));`;
    child = nativeSpawn(process.execPath, ["--input-type=module", "-e", source], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH }
    });
    child.once("close", (exitCode, signal) =>
      actualCloses.push({ pid: child.pid, exitCode, signal })
    );
    launches.push({ attemptId, args: [...args], options, pid: child.pid });
    return child;
  });
  const calls = [];
  t.mock.method(childProcess, "execFile", (file, args, options, callback) => {
    if (file !== "docker" || args[0] === "--host")
      return previousExec(file, args, options, callback);
    calls.push([...args]);
    assert.equal(options.env.DOCKER_HOST, "unix:///var/run/docker.sock");
    const image = `${f.proof.identity.images.runner.registry}@${f.proof.identity.images.runner.imageDigest}`;
    const value =
      args[0] === "image"
        ? {
            id: digest("9"),
            repoDigests: [image],
            sourceRevision: f.sourceSha,
            platform: "linux/amd64",
            defaultEntrypoint: true,
            defaultCommand: true
          }
        : {
            id,
            imageId: digest("9"),
            imageReference: image,
            running: child?.exitCode === null && child?.signalCode === null,
            paused: false,
            restarting: false,
            dead: false,
            readonlyRootfs: true,
            privileged: false,
            networkMode: "d".repeat(64),
            networkId: "d".repeat(64),
            capDrop: ["ALL"],
            securityOpt: ["no-new-privileges"],
            tmpfs: {
              "/tmp": "rw,noexec,nosuid,size=64m",
              "/var/lib/postgresql/data": "rw,noexec,nosuid,size=1m"
            },
            mounts: [],
            ports:
              mode === "exposed"
                ? { "5432/tcp": null }
                : mode === "published"
                  ? { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "25499" }] }
                  : {},
            portBindings:
              mode === "published"
                ? { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "25499" }] }
                : {},
            defaultEntrypoint: true,
            defaultCommand: true,
            manualMode: [true]
          };
    if (args[0] === "stop") {
      assert.equal(args.at(-1), id);
      child.stdin.end();
      if (child.exitCode !== null || child.signalCode !== null)
        queueMicrotask(() => callback(null, Buffer.from(id + "\n"), Buffer.alloc(0)));
      else child.once("close", () => callback(null, Buffer.from(id + "\n"), Buffer.alloc(0)));
    } else
      queueMicrotask(() =>
        callback(
          mode === "unknown-stop" && args[0] === "container" && child.exitCode !== null
            ? new Error("inspect unavailable")
            : null,
          Buffer.from(JSON.stringify(value) + "\n"),
          Buffer.alloc(0)
        )
      );
    return { kill() {} };
  });
  t.after(() => child?.kill("SIGKILL"));
  return {
    ...f,
    launches,
    calls,
    challenge,
    indexBytes,
    baselineBytes,
    baseline,
    credentialReads,
    keyReads,
    actualCloses
  };
}

test(
  "zero-credential parent saves real null attempt and split CHALLENGE then precisely stops before expected admission",
  { skip: process.platform !== "linux" },
  async (t) => {
    const f = await zeroCredentialFixture(t);
    await assert.rejects(launcher.launchManualStage1({ operationRef: f.prepared.operationRef }), {
      code: "MANUAL_EXPECTED_SCHEMA_INPUT_REQUIRED"
    });
    assert.equal(f.launches.length, 1);
    const records = await f.records();
    const snapshots = records.filter(
      (v) => v.kind === "process" && v.attemptId === f.launches[0].attemptId
    );
    const final = snapshots.find((v) => v.closedAt !== null);
    assert.ok(final);
    assert.deepEqual(
      final.events.map((e) => e.event),
      ["PREPARED", "SPAWNED", "DISPATCH_CLOSED", "CLOSED"]
    );
    assert.equal(final.events[1].pid, f.launches[0].pid);
    assert.equal(final.events[1].containerId, "e".repeat(64));
    assert.equal(final.events.at(-1).exitCode, 0);
    const raw = await fs.readFile(
      path.join(
        f.profile.storage.archiveRoot,
        "raw",
        final.protocol.stdoutPrefix.digest.slice(7) + ".bin"
      )
    );
    assert.deepEqual(raw, f.challenge);
    assert.equal(f.counters.credentialReads, f.credentialReads);
    assert.equal(f.pg.connects, 1);
    assert.equal(records.filter((v) => v.schemaVersion === "manual-runner-request.v1").length, 1);
    assert.deepEqual(await fs.readFile(path.join(f.operationRoot, "index.json")), f.indexBytes);
    assert.deepEqual(await fs.readFile(f.objectPath(f.baseline)), f.baselineBytes);
    assert.ok(f.calls.some((args) => args[0] === "stop"));
    assert.ok(f.calls.some((args) => args[0] === "container" && args.at(-1) === "e".repeat(64)));
  }
);

test(
  "zero-credential parent refuses PREPARED write or independent reopen failure before spawn",
  { skip: process.platform !== "linux" },
  async (t) => {
    for (const mode of ["write", "reopen"])
      await t.test(mode, async (t) => {
        const f = await zeroCredentialFixture(t),
          open = fs.open.bind(fs);
        let blocked;
        t.mock.method(fs, "open", async (file, flags, ...args) => {
          if (flags === "r" && file === blocked)
            throw Object.assign(new Error("read unavailable"), { code: "EIO" });
          const handle = await open(file, flags, ...args);
          if (flags === "wx" && String(file).includes(path.sep + "objects" + path.sep)) {
            const write = handle.writeFile.bind(handle);
            handle.writeFile = async (bytes, ...rest) => {
              const value = JSON.parse(bytes);
              if (value.kind === "process" && value.requestDigest === null) {
                if (mode === "write")
                  throw Object.assign(new Error("write unavailable"), { code: "EIO" });
                blocked = file;
              }
              return write(bytes, ...rest);
            };
          }
          return handle;
        });
        await assert.rejects(
          launcher.launchManualStage1({ operationRef: f.prepared.operationRef }),
          (error) => ["EIO", "MANUAL_STORAGE_UNVERIFIED"].includes(error.code)
        );
        assert.equal(f.launches.length, 0);
        assert.equal(f.counters.credentialReads, f.credentialReads);
        assert.equal(f.pg.connects, 1);
      });
  }
);

test(
  "zero-credential parent retains bounded real failure bytes and close without command admission",
  { skip: process.platform !== "linux" },
  async (t) => {
    for (const [mode, code] of [
      ["invalid", "MANUAL_FRAME_INVALID"],
      ["stderr-invalid", "MANUAL_FRAME_INVALID"],
      ["limit", "MANUAL_OUTPUT_LIMIT"],
      ["early", "MANUAL_FRAME_INCOMPLETE"]
    ])
      await t.test(mode, async (t) => {
        const f = await zeroCredentialFixture(t, mode);
        await assert.rejects(
          launcher.launchManualStage1({ operationRef: f.prepared.operationRef }),
          { code }
        );
        assert.equal(f.launches.length, 1);
        const records = await f.records(),
          snapshots = records.filter(
            (v) => v.kind === "process" && v.attemptId === f.launches[0].attemptId
          );
        assert.ok(
          snapshots.some((v) => v.events.some((e) => e.event === "CLOSED")),
          "actual process close must survive refusal"
        );
        assert.ok(snapshots.every((v) => v.protocol.stdoutPrefix.bytes <= 1048576));
        if (mode === "limit") {
          assert.ok(snapshots.every((v) => v.closedAt === null));
          assert.equal(
            snapshots.find((v) => v.events.at(-1)?.event === "CLOSED").events.at(-1).stderr,
            null
          );
        }
        assert.equal(f.counters.credentialReads, f.credentialReads);
        assert.equal(f.pg.connects, 1);
        assert.equal(
          records.filter((v) => v.schemaVersion === "manual-runner-request.v1").length,
          1
        );
      });
  }
);

test(
  "zero-credential parent preserves actual CLI close but unknown container cleanup",
  { skip: process.platform !== "linux" },
  async (t) => {
    const f = await zeroCredentialFixture(t, "unknown-stop");
    await assert.rejects(launcher.launchManualStage1({ operationRef: f.prepared.operationRef }), {
      code: "MANUAL_RUNNER_CLEANUP_UNKNOWN"
    });
    const snapshots = (await f.records()).filter(
      (v) => v.kind === "process" && v.attemptId === f.launches[0].attemptId
    );
    assert.ok(snapshots.every((v) => v.closedAt === null));
    assert.ok(snapshots.every((v) => v.events.every((e) => e.event !== "DISPATCH_CLOSED")));
    assert.ok(snapshots.some((v) => v.events.some((e) => e.event === "CLOSED")));
    assert.equal(f.counters.credentialReads, f.credentialReads);
  }
);

test(
  "zero-credential parent keeps the validated CID for exact stop when CID custody write fails",
  { skip: process.platform !== "linux" },
  async (t) => {
    const f = await zeroCredentialFixture(t),
      open = fs.open.bind(fs);
    t.mock.method(fs, "open", async (file, flags, ...args) => {
      const handle = await open(file, flags, ...args);
      if (
        flags === "wx" &&
        String(file).startsWith(f.operationRoot + path.sep) &&
        path.basename(file) === "runner.cid"
      )
        handle.writeFile = async () => {
          throw Object.assign(new Error("CID source write unavailable"), { code: "EIO" });
        };
      return handle;
    });
    await assert.rejects(launcher.launchManualStage1({ operationRef: f.prepared.operationRef }), {
      code: "EIO"
    });
    assert.equal(f.launches.length, 1);
    assert.ok(f.calls.some((args) => args[0] === "stop" && args.at(-1) === "e".repeat(64)));
    assert.deepEqual(f.actualCloses, [{ pid: f.launches[0].pid, exitCode: 0, signal: null }]);
    const snapshots = (await f.records()).filter(
      (v) => v.kind === "process" && v.attemptId === f.launches[0].attemptId
    );
    assert.ok(snapshots.every((v) => v.closedAt === null));
    assert.equal(f.counters.credentialReads, f.credentialReads);
  }
);

test(
  "zero-credential review handles native CID transition and unpublished inherited port",
  { skip: process.platform !== "linux" },
  async (t) => {
    for (const mode of ["empty-cid", "exposed"])
      await t.test(mode, async (t) => {
        const f = await zeroCredentialFixture(t, mode);
        await assert.rejects(
          launcher.launchManualStage1({ operationRef: f.prepared.operationRef }),
          { code: "MANUAL_EXPECTED_SCHEMA_INPUT_REQUIRED" }
        );
        assert.equal(f.launches.length, 1);
        assert.ok(f.calls.some((args) => args[0] === "stop" && args.at(-1) === "e".repeat(64)));
        assert.equal(f.actualCloses.length, 1);
        assert.equal(f.counters.credentialReads, f.credentialReads);
      });
  }
);

test(
  "zero-credential review rejects an actual published port mapping",
  { skip: process.platform !== "linux" },
  async (t) => {
    const f = await zeroCredentialFixture(t, "published");
    await assert.rejects(
      launcher.launchManualStage1({ operationRef: f.prepared.operationRef }),
      (error) =>
        error.code === "MANUAL_RUNNER_CLEANUP_UNKNOWN" &&
        error.cause?.code === "MANUAL_RUNNER_RESOURCE_MISMATCH"
    );
    assert.equal(f.counters.credentialReads, f.credentialReads);
    assert.equal(f.actualCloses.length, 1);
    assert.ok(f.calls.some((args) => args[0] === "stop"));
  }
);

test(
  "zero-credential review ignores public sibling nlink changes within the common private path guard",
  { skip: process.platform !== "linux" },
  async (t) => {
    const f = await zeroCredentialFixture(t),
      lstat = fs.lstat.bind(fs),
      sibling = `/tmp/r22-public-sibling-${randomUUID()}`;
    let armed = false,
      created = false;
    t.mock.method(fs, "lstat", async (file, ...args) => {
      if (
        f.launches.length &&
        file === path.join(f.operationRoot, "h3-a-approval.json") &&
        !created
      )
        armed = true;
      if (armed && file === "/tmp" && !created) {
        await nativeFS.mkdir(sibling, { mode: 0o700 });
        created = true;
      }
      return lstat(file, ...args);
    });
    t.after(async () => {
      if (created) await fs.rmdir(sibling);
    });
    await assert.rejects(launcher.launchManualStage1({ operationRef: f.prepared.operationRef }), {
      code: "MANUAL_EXPECTED_SCHEMA_INPUT_REQUIRED"
    });
    assert.equal(created, true);
    assert.equal(f.actualCloses.length, 1);
    assert.equal(f.counters.credentialReads, f.credentialReads);
  }
);

function h3Rejection(causeCode) {
  return (error) => {
    assert.equal(error.code, "H3_INPUT_UNAVAILABLE");
    assert.equal(
      error.cause?.code,
      causeCode,
      `${error.cause?.stack}\n${JSON.stringify({ changedPath: error.cause?.changedPath, changedFields: error.cause?.changedFields })}`
    );
    return true;
  };
}
async function launchInputFixture(t, endpoint) {
  const f = await buildFixture(t, endpoint);
  const prepared = await launcher.prepareManualOperation(prepareInput(f));
  const operationRoot = path.join(
    f.profile.storage.archiveRoot,
    "inputs",
    "operations",
    prepared.operationRef
  );
  const files = [];
  const opening = fs.open.bind(fs);
  t.mock.method(fs, "open", (file, ...args) => {
    if (
      typeof file === "string" &&
      file.startsWith(operationRoot + path.sep) &&
      path.basename(file).startsWith("h3-a-")
    )
      files.push(file);
    return opening(file, ...args);
  });
  return { ...f, prepared, operationRoot, h3Opens: files };
}

test("launch missing fixed H3 input never opens a session or capability credential", async (t) => {
  const f = await launchInputFixture(t);
  await assert.rejects(
    launcher.launchManualStage1({ operationRef: f.prepared.operationRef }),
    h3Rejection("ENOENT")
  );
  noAuthority(f);
});

for (const [name, bytes] of [
  ["invalid UTF-8", Buffer.from([0xff])],
  ["BOM", Buffer.from("\ufeff{}")],
  ["duplicate keys", Buffer.from('{"x":1,"x":1}')],
  ["trailing newline", Buffer.from("{}\n")],
  ["above full raw limit", Buffer.alloc(1048577, 32)]
]) {
  test(`launch refuses fixed H3 approval ${name} before authority`, async (t) => {
    const f = await launchInputFixture(t);
    await fs.mkdir(f.operationRoot, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(f.operationRoot, "h3-a-approval.json"), bytes, { mode: 0o600 });
    await assert.rejects(
      launcher.launchManualStage1({ operationRef: f.prepared.operationRef }),
      h3Rejection(
        name === "above full raw limit"
          ? "MANUAL_OPERATION_INPUT_UNAVAILABLE"
          : "MANUAL_H3_FORMAT_INVALID"
      )
    );
    noAuthority(f);
  });
}

for (const name of ["inputs", "operations", "h3-a-approval.json"]) {
  test(`launch rejects wide ACL on fixed H3 ${name} before reading data`, async (t) => {
    const f = await launchInputFixture(t);
    await fs.mkdir(f.operationRoot, { recursive: true, mode: 0o700 });
    const file = path.join(f.operationRoot, "h3-a-approval.json");
    await fs.writeFile(file, encodeManualJson({}), { mode: 0o600 });
    const checking = fs.lstat.bind(fs);
    t.mock.method(fs, "lstat", (candidate, ...args) => {
      if (candidate === file)
        f.host.wideRoot =
          name === "inputs"
            ? path.join(f.profile.storage.archiveRoot, "inputs")
            : name === "operations"
              ? path.dirname(f.operationRoot)
              : file;
      return checking(candidate, ...args);
    });
    await assert.rejects(
      launcher.launchManualStage1({ operationRef: f.prepared.operationRef }),
      h3Rejection("MANUAL_OPERATION_INPUT_UNAVAILABLE")
    );
    assert.equal(f.h3Opens.length, 0);
    noAuthority(f);
  });
}

test("launch rejects hard-linked fixed H3 approval before reading data", async (t) => {
  const f = await launchInputFixture(t);
  await fs.mkdir(f.operationRoot, { recursive: true, mode: 0o700 });
  const file = path.join(f.operationRoot, "h3-a-approval.json");
  await fs.writeFile(file, encodeManualJson({}), { mode: 0o600 });
  await fs.link(file, path.join(f.operationRoot, "other.json"));
  await assert.rejects(
    launcher.launchManualStage1({ operationRef: f.prepared.operationRef }),
    h3Rejection("MANUAL_OPERATION_INPUT_UNAVAILABLE")
  );
  assert.equal(f.h3Opens.length, 0);
  noAuthority(f);
});

test("launch detects fixed H3 approval changed at independent reopen", async (t) => {
  const f = await launchInputFixture(t);
  await fs.mkdir(f.operationRoot, { recursive: true, mode: 0o700 });
  const file = path.join(f.operationRoot, "h3-a-approval.json");
  await fs.writeFile(file, encodeManualJson({}), { mode: 0o600 });
  const opening = fs.open.bind(fs);
  let opens = 0;
  t.mock.method(fs, "open", async (candidate, ...args) => {
    if (candidate === file && ++opens === 2)
      await fs.writeFile(file, encodeManualJson({ changed: true }));
    return opening(candidate, ...args);
  });
  await assert.rejects(
    launcher.launchManualStage1({ operationRef: f.prepared.operationRef }),
    h3Rejection("MANUAL_OPERATION_INPUT_UNAVAILABLE")
  );
  assert.equal(opens, 2, "the intended independent reopen fault happened");
  noAuthority(f);
});

async function h3InputFixture(t, endpoint) {
  const f = await launchInputFixture(t, endpoint);
  const fixed = await readFixedManualOperation({
    repoRoot: productionRoot,
    operationRef: f.prepared.operationRef
  });
  const common = {
    operationRef: f.prepared.operationRef,
    indexDigest: f.prepared.indexDigest,
    runId: fixed.operation.runId,
    profileDigest: sha256Canonical(f.profile),
    targetIntent: fixed.operation.targetIntent,
    ownerId: f.profile.ownerId,
    promotionEligible: false
  };
  const approval = {
    recordVersion: "manual-h3-a-approval.v1",
    ...common,
    approvedAt: generatedAt,
    creationSpec: {
      databaseContainerName: "synthetic-h3-database",
      dataVolumeName: "synthetic-h3-volume",
      postgresImageDigest: digest("a"),
      marker: "synthetic-h3-marker",
      endpoint: f.profile.allowedTargets[0].endpoint,
      serverPort: 5432
    },
    operationSheet: "Synthetic nonsecret approved operations; not real H3 approval."
  };
  const approvalBytes = encodeManualJson(approval);
  const readback = {
    recordVersion: "manual-h3-a-readback.v1",
    ...common,
    approval: { digest: sha256Bytes(approvalBytes), bytes: approvalBytes.length },
    databaseContainerName: approval.creationSpec.databaseContainerName,
    endpoint: approval.creationSpec.endpoint,
    databaseOid: "123",
    cluster: {
      systemIdentifier: "123456789012345678",
      databaseContainerId: "b".repeat(64),
      dataVolumeName: approval.creationSpec.dataVolumeName,
      postgresImageDigest: approval.creationSpec.postgresImageDigest,
      marker: approval.creationSpec.marker,
      serverAddress: "172.19.0.2",
      serverPort: approval.creationSpec.serverPort
    },
    resourceObservedAt: "2026-09-01T00:00:01.000Z",
    sqlObservedAt: "2026-09-01T00:00:01.000Z",
    readbackAt: "2026-09-01T00:00:02.000Z",
    readbackReport: "Synthetic nonsecret source readback; not real Docker or SQL evidence."
  };
  return { ...f, approval, readback };
}

async function writeH3(f, { bindApproval = true } = {}) {
  if (bindApproval) {
    const bytes = encodeManualJson(f.approval);
    f.readback.approval = { digest: sha256Bytes(bytes), bytes: bytes.length };
  }
  for (const [name, value] of [
    ["h3-a-approval.json", f.approval],
    ["h3-a-readback.json", f.readback]
  ])
    await fs.writeFile(path.join(f.operationRoot, name), encodeManualJson(value), { mode: 0o600 });
}

async function h3ResourceFixture(t) {
  const f = await h3InputFixture(t, "127.0.0.1:25432");
  await writeH3(f);
  f.docker.outputs = {
    container: {
      id: "b".repeat(64),
      name: "/synthetic-h3-database",
      imageId: digest("c"),
      imageReference: "postgres@" + digest("a"),
      running: true,
      paused: false,
      restarting: false,
      dead: false,
      privileged: false,
      marker: "synthetic-h3-marker",
      networkMode: "synthetic-h3-network",
      pgdata: [true],
      defaultEntrypoint: true,
      defaultCommand: true,
      mounts: [
        {
          Type: "volume",
          Name: "synthetic-h3-volume",
          Source: "/var/lib/docker/volumes/synthetic-h3-volume/_data",
          Destination: "/var/lib/postgresql/data",
          RW: true
        }
      ],
      networks: {
        "synthetic-h3-network": {
          NetworkID: "d".repeat(64),
          IPAddress: "172.19.0.2",
          GlobalIPv6Address: ""
        }
      },
      ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "25432" }] },
      portBindings: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "25432" }] }
    },
    volume: {
      name: "synthetic-h3-volume",
      driver: "local",
      scope: "local",
      mountpoint: "/var/lib/docker/volumes/synthetic-h3-volume/_data",
      optionsEmpty: true,
      marker: "synthetic-h3-marker"
    },
    image: { id: digest("c"), repoDigests: ["postgres@" + digest("a")] },
    network: {
      id: "d".repeat(64),
      name: "synthetic-h3-network",
      driver: "bridge",
      scope: "local",
      internal: true
    },
    users: Buffer.from("b".repeat(64) + "\n")
  };
  return f;
}

async function targetObserveFixture(t) {
  const f = await h3ResourceFixture(t);
  for (const role of ["journal", "archive", "backup"])
    await fs.mkdir(path.join(f.profile.storage[`${role}Root`], "objects"), { mode: 0o700 });
  for (const name of ["locks", "consumptions", "revocations", "checkpoints"])
    await fs.mkdir(path.join(f.profile.storage.journalRoot, name), { mode: 0o700 });
  await fs.mkdir(path.join(f.profile.storage.archiveRoot, "raw"), { mode: 0o700 });
  await fs.writeFile(
    path.join(f.profile.storage.keyRoot, "owner.key"),
    f.keys.privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 }
  );
  const genesis = {
    schemaVersion: "manual-operation-record.v2",
    kind: "revocation",
    profileDigest: sha256Canonical(f.profile),
    recordedAt: generatedAt,
    promotionEligible: false,
    ownerId: f.profile.ownerId,
    sequence: 0,
    previousRevocationDigest: null,
    action: "GENESIS",
    authorizationId: null,
    reasonCode: null
  };
  const objectPath = (value, role = "archive") =>
    path.join(
      f.profile.storage[`${role}Root`],
      "objects",
      `${sha256Canonical(value).slice(7)}.json`
    );
  await fs.writeFile(objectPath(genesis, "journal"), encodeManualJson(genesis), { mode: 0o600 });
  await fs.writeFile(
    path.join(
      f.profile.storage.journalRoot,
      "revocations",
      `${sha256Canonical(f.profile).slice(7)}-0.json`
    ),
    encodeManualJson(genesis),
    { mode: 0o600 }
  );
  const credentialDirectory = path.join(
    f.profile.storage.credentialRoot,
    "operations",
    f.prepared.operationRef
  );
  await fs.mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
  for (const role of ["observer", "migrate", "verify", "provision"])
    await fs.writeFile(
      path.join(credentialDirectory, `${role}.json`),
      encodeManualJson({ username: role, password: `offline-${role}-secret` }),
      { mode: 0o600 }
    );
  const pg = { connects: 0, closes: 0, statements: [], options: [], fault: null, before: null };
  globalThis[pgClientSlot] = (options) => {
    pg.connects++;
    pg.options.push(options);
    const client = {
      async begin(callback) {
        return callback(client);
      },
      async unsafe(statement) {
        pg.statements.push(statement);
        if (pg.before) await pg.before(statement);
        if (pg.fault === "query") throw new Error("offline SQL failure with private detail");
        if (statement.startsWith("SET TRANSACTION")) return [];
        if (statement === "SHOW transaction_isolation")
          return [{ transaction_isolation: "repeatable read" }];
        if (statement === "SHOW transaction_read_only") return [{ transaction_read_only: "on" }];
        if (statement.includes("pg_control_system"))
          return [
            {
              systemIdentifier: pg.fault === "system" ? "999" : f.readback.cluster.systemIdentifier
            }
          ];
        if (statement.includes("inet_server_addr"))
          return [
            {
              serverAddress:
                pg.fault === "address" ? "172.19.0.3" : f.readback.cluster.serverAddress,
              serverPort: pg.fault === "port" ? 5433 : 5432,
              databaseName: pg.fault === "name" ? "other-db" : "synthetic-db",
              databaseOid: pg.fault === "oid" ? "124" : "123",
              role: pg.fault === "role" ? "migrate" : "observer",
              tls: pg.fault !== "tls"
            }
          ];
        if (statement.includes("to_regclass")) return [{ oid: null }];
        if (statement.includes("AS owner FROM pg_namespace")) return [{ owner: "provision" }];
        if (statement.includes("UNION ALL"))
          return [{ objectClass: "schema", objectName: "public", owner: "provision" }];
        if (statement.includes("pg_extension")) return [{ name: "plpgsql" }];
        if (statement === "SHOW server_version") return [{ server_version: "17.0" }];
        throw new Error("Unexpected SQL statement");
      },
      async end() {
        pg.closes++;
      }
    };
    return client;
  };
  t.after(() => {
    delete globalThis[pgClientSlot];
  });
  const records = async () => {
    const values = new Map();
    for (const role of ["journal", "archive"])
      for (const name of await fs.readdir(path.join(f.profile.storage[`${role}Root`], "objects"))) {
        const bytes = await fs.readFile(
          path.join(f.profile.storage[`${role}Root`], "objects", name)
        );
        values.set(sha256Bytes(bytes), JSON.parse(bytes));
      }
    return [...values.values()];
  };
  const open = () =>
    openTrustedManualSession({
      repoRoot: productionRoot,
      proofBytes: f.proofBytes,
      materialBytes: f.materialBytes,
      operationRef: f.prepared.operationRef
    });
  return { ...f, pg, records, open, objectPath, genesis, credentialDirectory };
}

test("target-observe baseline reuse preserves genuine original observation without reconnecting", async (t) => {
  const f = await targetObserveFixture(t),
    session = await f.open();
  const result = await launcher.connectAndObserveManualTarget({
    session,
    operationRef: f.prepared.operationRef
  });
  assert.deepEqual(Object.keys(result).sort(), ["observation", "readbackDigest"]);
  assert.equal(f.pg.connects, 1);
  assert.equal(f.pg.closes, 1);
  assert.ok(f.counters.credentialReads > 0);
  assert.deepEqual(
    [...new Set(f.counters.credentialPaths)],
    [path.join(f.credentialDirectory, "observer.json")]
  );
  assert.equal(result.observation.roleObservation.role, "observer");
  assert.equal(result.observation.physicalIdentity.databaseOid, "123");
  assert.equal(f.pg.statements[0], "SET TRANSACTION READ ONLY, ISOLATION LEVEL REPEATABLE READ");
  assert.deepEqual(f.pg.statements.slice(1, 3), [
    "SHOW transaction_isolation",
    "SHOW transaction_read_only"
  ]);
  const values = await f.records(),
    request = values.find(
      (v) => v.stage === "target-observe" && v.schemaVersion === "manual-runner-request.v1"
    );
  const assessment = assessManualRunnerEvidence({
    profileBytes: encodeManualJson(f.profile),
    requestBytes: encodeManualJson(request),
    artifactBytes: values.map(encodeManualJson),
    rawBlobs: []
  });
  assert.equal(assessment.executionStatus, "SUCCEEDED");
  const baseline = values.filter((v) => v.schemaVersion === "manual-baseline-manifest.v1");
  assert.equal(baseline.length, 1);
  assert.equal(baseline[0].identity.targetObservationDigest, sha256Canonical(result.observation));
  assert.equal(baseline[0].identity.preStateDigest, sha256Canonical(result.observation.catalog));
  assert.ok(
    values.some(
      (v) =>
        v.kind === "custody" &&
        sha256Canonical(v) === result.readbackDigest &&
        v.subjectDigest === sha256Canonical(result.observation) &&
        v.outcome === "MATCH"
    )
  );
  assert.ok(values.some((v) => v.kind === "session" && v.status === "CLOSED"));
  for (const v of values) assert.ok(!JSON.stringify(v).includes("offline-observer-secret"));
  for (const role of ["migrate", "verify", "provision"])
    assert.ok((await fs.readFile(path.join(f.credentialDirectory, `${role}.json`))).length);
  const preserved = await fs.readFile(f.objectPath(baseline[0])),
    observationBytes = await fs.readFile(f.objectPath(result.observation)),
    custodyPath = path.join(
      f.profile.storage.archiveRoot,
      "objects",
      `${result.readbackDigest.slice(7)}.json`
    ),
    custodyBytes = await fs.readFile(custodyPath),
    credentialReads = f.counters.credentialReads,
    statements = [...f.pg.statements],
    next = await f.open();
  assert.notEqual(next.sessionId, session.sessionId);
  const reused = await launcher.connectAndObserveManualTarget({
    session: {
      ...next,
      sign() {
        assert.fail("reuse must not sign a fresh target observation");
      },
      consume() {
        assert.fail("reuse must not consume a fresh target observation");
      }
    },
    operationRef: f.prepared.operationRef
  });
  assert.deepEqual(encodeManualJson(reused.observation), observationBytes);
  assert.equal(reused.readbackDigest, result.readbackDigest);
  assert.deepEqual(await fs.readFile(custodyPath), custodyBytes);
  assert.deepEqual(await fs.readFile(f.objectPath(baseline[0])), preserved);
  assert.equal(f.counters.credentialReads, credentialReads);
  assert.deepEqual(f.pg.statements, statements);
  assert.equal(f.pg.connects, 1);
  assert.equal((await f.records()).filter((v) => v.kind === "attempt-allocation").length, 1);
});

test("target-observe baseline reuse parent retains explicit runner boundary", async (t) => {
  const f = await targetObserveFixture(t);
  await assert.rejects(launcher.launchManualStage1({ operationRef: f.prepared.operationRef }), {
    code: "MANUAL_RUNNER_INPUT_REQUIRED"
  });
  assert.equal(f.pg.connects, 1);
  assert.equal(f.pg.closes, 1);
  assert.ok((await f.records()).some((v) => v.kind === "execution" && v.status === "SUCCEEDED"));
  const credentialReads = f.counters.credentialReads,
    statements = [...f.pg.statements];
  await assert.rejects(launcher.launchManualStage1({ operationRef: f.prepared.operationRef }), {
    code: "MANUAL_RUNNER_INPUT_REQUIRED"
  });
  assert.equal(f.pg.connects, 1);
  assert.equal(f.counters.credentialReads, credentialReads);
  assert.deepEqual(f.pg.statements, statements);
  assert.equal((await f.records()).filter((v) => v.kind === "attempt-allocation").length, 1);
  assert.equal(f.counters.externalCalls, 0);
});

test("target-observe baseline reuse rejects incomplete conflicting or foreign originals without repair", async (t) => {
  const f = await targetObserveFixture(t);
  const result = await launcher.connectAndObserveManualTarget({
    session: await f.open(),
    operationRef: f.prepared.operationRef
  });
  const values = await f.records(),
    baseline = values.find((v) => v.schemaVersion === "manual-baseline-manifest.v1"),
    request = values.find((v) => v.schemaVersion === "manual-runner-request.v1"),
    execution = values.find((v) => v.kind === "execution"),
    consumption = values.find((v) => v.kind === "consumption");
  const custodyFor = (subject) =>
    values.find(
      (v) =>
        v.kind === "custody" &&
        v.subjectDigest === sha256Canonical(subject) &&
        v.purpose === "archive-readback"
    );
  const credentialReads = f.counters.credentialReads,
    statements = [...f.pg.statements];
  const competingCatalog = { ...result.observation.catalog, postgresqlVersion: "17.1" },
    competingObservation = {
      ...result.observation,
      catalog: competingCatalog,
      roleObservation: {
        ...result.observation.roleObservation,
        schemaObservationDigest: sha256Canonical(competingCatalog)
      }
    },
    competingBaseline = {
      ...baseline,
      identity: {
        ...baseline.identity,
        targetObservationDigest: sha256Canonical(competingObservation),
        roleObservation: competingObservation.roleObservation,
        preStateDigest: sha256Canonical(competingCatalog)
      }
    };
  const competingCustody = (subject, original) => ({
    ...custodyFor(original),
    subjectDigest: sha256Canonical(subject),
    observedDigest: sha256Canonical(subject)
  });
  const cases = [
    ["missing baseline", baseline],
    ["missing observation readback", custodyFor(result.observation)],
    ["missing execution", execution],
    ["missing execution readback", custodyFor(execution)],
    ["missing baseline readback", custodyFor(baseline)],
    ["missing consumption slot", consumption, "slot"],
    [
      "inconsistent bound graph",
      baseline,
      "replace",
      { ...baseline, identity: { ...baseline.identity, preStateDigest: digest("e") } }
    ],
    [
      "foreign build",
      baseline,
      "replace",
      { ...baseline, identity: { ...baseline.identity, buildProofDigest: digest("e") } }
    ],
    ["foreign run", request, "replace", { ...request, runId: randomUUID() }],
    [
      "foreign ref",
      request,
      "replace",
      { ...request, idempotencyKey: `manual-stage1:${randomUUID()}:observe` }
    ],
    [
      "ambiguous baseline",
      baseline,
      "add",
      { ...baseline, createdAt: new Date(Date.parse(baseline.createdAt) + 1).toISOString() }
    ],
    [
      "same-request competing observation",
      baseline,
      "competing-observation",
      competingBaseline,
      [
        { remove: custodyFor(baseline), add: competingCustody(competingBaseline, baseline) },
        { add: competingObservation },
        { add: competingCustody(competingObservation, result.observation) }
      ]
    ]
  ];
  for (const [name, subject, mode, replacement, mutations = []] of cases) {
    await t.test(name, async () => {
      const file =
          mode === "slot"
            ? path.join(
                f.profile.storage.journalRoot,
                "consumptions",
                `${request.profileDigest.slice(7)}-${values.find((v) => v.payload?.requestDigest === sha256Canonical(request)).payload.authorizationId}.json`
              )
            : f.objectPath(subject),
        original = await fs.readFile(file),
        added = replacement ? f.objectPath(replacement) : null;
      if (mode !== "add") await fs.unlink(file);
      if (added) await fs.writeFile(added, encodeManualJson(replacement), { mode: 0o600 });
      const restored = new Map(),
        injected = [];
      for (const mutation of mutations) {
        if (mutation.remove) {
          const removedPath = f.objectPath(mutation.remove);
          restored.set(removedPath, await fs.readFile(removedPath));
          await fs.unlink(removedPath);
        }
        if (mutation.add) {
          const injectedPath = f.objectPath(mutation.add);
          await fs.writeFile(injectedPath, encodeManualJson(mutation.add), { mode: 0o600 });
          injected.push(injectedPath);
        }
      }
      const originals = new Map();
      for (const role of ["journal", "archive"])
        for (const name of await fs.readdir(
          path.join(f.profile.storage[`${role}Root`], "objects")
        )) {
          const originalPath = path.join(f.profile.storage[`${role}Root`], "objects", name);
          originals.set(originalPath, await fs.readFile(originalPath));
        }
      try {
        if (mode === "competing-observation") {
          assert.notEqual(
            sha256Canonical(result.observation),
            replacement.identity.targetObservationDigest
          );
          assert.equal(
            assessManualRunnerEvidence({
              profileBytes: encodeManualJson(f.profile),
              requestBytes: encodeManualJson(request),
              artifactBytes: (await f.records()).map(encodeManualJson),
              rawBlobs: []
            }).executionStatus,
            "SUCCEEDED"
          );
        }
        await assert.rejects(
          launcher.connectAndObserveManualTarget({
            session: await f.open(),
            operationRef: f.prepared.operationRef
          }),
          { code: "MANUAL_BASELINE_REUSE_INPUT_REQUIRED" }
        );
        if (mode !== "add") await assert.rejects(fs.stat(file), { code: "ENOENT" });
        for (const [originalPath, bytes] of originals)
          assert.deepEqual(await fs.readFile(originalPath), bytes);
        assert.equal(f.pg.connects, 1);
        assert.equal(f.counters.credentialReads, credentialReads);
        assert.deepEqual(f.pg.statements, statements);
        assert.equal((await f.records()).filter((v) => v.kind === "attempt-allocation").length, 1);
        assert.equal(f.counters.externalCalls, 0);
      } finally {
        for (const injectedPath of injected) await fs.unlink(injectedPath);
        for (const [restoredPath, bytes] of restored)
          await fs.writeFile(restoredPath, bytes, { mode: 0o600 });
        if (added) await fs.unlink(added);
        if (mode !== "add") await fs.writeFile(file, original, { mode: 0o600 });
      }
    });
  }
});

for (const fault of ["forged", "expired", "revoked", "mismatched", "unconsumed"])
  test(`target-observe ${fault} authorization releases no credential or connection`, async (t) => {
    const f = await targetObserveFixture(t),
      genuine = await f.open();
    const session = {
      ...genuine,
      async sign(input) {
        const authorization = await genuine.sign(input);
        if (fault === "expired")
          return signManualAuthorization({
            privateKey: f.keys.privateKey,
            payload: {
              ...authorization.payload,
              issuedAt: "2026-09-01T01:00:00.000Z",
              expiresAt: "2026-09-01T01:01:00.000Z"
            }
          });
        if (fault === "mismatched")
          return signManualAuthorization({
            privateKey: f.keys.privateKey,
            payload: {
              ...authorization.payload,
              targetIntent: { ...authorization.payload.targetIntent, databaseName: "other-db" }
            }
          });
        if (fault === "revoked")
          await genuine.record("revocation", {
            ...f.genesis,
            recordedAt: new Date().toISOString(),
            sequence: 1,
            previousRevocationDigest: sha256Canonical(f.genesis),
            action: "REVOKE_AUTHORIZATION",
            authorizationId: authorization.payload.authorizationId,
            reasonCode: "OFFLINE_REVOKED"
          });
        return authorization;
      },
      async consume(input) {
        if (fault === "forged")
          return {
            stage: "target-observe",
            parentDecision: {},
            consumptionReadbackDigest: digest("f")
          };
        if (fault === "unconsumed") {
          const opened = (await f.records()).find(
              (v) => v.kind === "session" && v.status === "OPEN"
            ),
            readAt = new Date().toISOString(),
            genesisDigest = sha256Canonical(f.genesis);
          return {
            stage: "target-observe",
            consumptionReadbackDigest: digest("f"),
            parentDecision: verifyManualAuthorization({
              authorization: input.authorization,
              request: input.request,
              profile: f.profile,
              session: {
                record: opened,
                recordDigest: sha256Canonical(opened),
                readAt,
                predecessor: null
              },
              revocation: {
                records: [f.genesis],
                headDigest: genesisDigest,
                checkpoint: { sequence: 0, digest: genesisDigest },
                readAt
              },
              now: readAt
            })
          };
        }
        return genuine.consume(input);
      }
    };
    await assert.rejects(
      launcher.connectAndObserveManualTarget({ session, operationRef: f.prepared.operationRef })
    );
    assert.equal(f.counters.credentialReads, 0);
    assert.equal(f.pg.connects, 0);
    assert.ok(!(await f.records()).some((v) => v.schemaVersion === "manual-baseline-manifest.v1"));
  });

test("target-observe changed H3 after consumption releases no credentials", async (t) => {
  const f = await targetObserveFixture(t),
    genuine = await f.open();
  const session = {
    ...genuine,
    async consume(input) {
      const consumed = await genuine.consume(input);
      await fs.appendFile(path.join(f.operationRoot, "h3-a-readback.json"), "\n");
      return consumed;
    }
  };
  await assert.rejects(
    launcher.connectAndObserveManualTarget({ session, operationRef: f.prepared.operationRef })
  );
  assert.equal(f.counters.credentialReads, 0);
  assert.equal(f.pg.connects, 0);
});

test("target-observe revocation during credential read prevents DB connection", async (t) => {
  const f = await targetObserveFixture(t),
    session = await f.open();
  const opening = fs.open.bind(fs);
  let revoked = false;
  t.mock.method(fs, "open", async (file, flags, ...args) => {
    if (!revoked && file === path.join(f.credentialDirectory, "observer.json")) {
      revoked = true;
      await session.record("revocation", {
        ...f.genesis,
        recordedAt: new Date().toISOString(),
        sequence: 1,
        previousRevocationDigest: sha256Canonical(f.genesis),
        action: "REVOKE_PROFILE",
        reasonCode: "OFFLINE_REVOKED"
      });
    }
    return opening(file, flags, ...args);
  });
  await assert.rejects(
    launcher.connectAndObserveManualTarget({ session, operationRef: f.prepared.operationRef }),
    { code: "MANUAL_AUTHORIZATION_REVOKED" }
  );
  assert.equal(revoked, true);
  assert.equal(f.pg.connects, 0);
});

for (const [fault, bytes] of [
  ["malformed", Buffer.from('{"password":"offline-private-parse-secret",broken')],
  [
    "role selector",
    encodeManualJson({
      username: "observer",
      password: "offline-private-parse-secret",
      capabilityProfile: "verify"
    })
  ]
])
  test(`target-observe invalid ${fault} credential rejects without private diagnostics`, async (t) => {
    const f = await targetObserveFixture(t),
      session = await f.open();
    await fs.writeFile(path.join(f.credentialDirectory, "observer.json"), bytes);
    await assert.rejects(
      launcher.connectAndObserveManualTarget({ session, operationRef: f.prepared.operationRef }),
      (error) => {
        assert.equal(error.code, "MANUAL_CREDENTIAL_INVALID");
        assert.ok(!error.message.includes("offline-private-parse-secret"));
        return true;
      }
    );
    assert.equal(f.pg.connects, 0);
    assert.ok(!(await f.records()).some((v) => v.schemaVersion === "manual-baseline-manifest.v1"));
  });

for (const fault of ["system", "address", "port", "name", "oid", "role", "tls", "query"])
  test(`target-observe rejects actual SQL ${fault} without baseline and retains UNKNOWN`, async (t) => {
    const f = await targetObserveFixture(t),
      session = await f.open();
    f.pg.fault = fault;
    await assert.rejects(
      launcher.connectAndObserveManualTarget({ session, operationRef: f.prepared.operationRef })
    );
    assert.equal(f.pg.connects, 1);
    assert.equal(f.pg.closes, 1);
    const values = await f.records();
    assert.ok(!values.some((v) => v.schemaVersion === "manual-baseline-manifest.v1"));
    assert.ok(values.some((v) => v.kind === "execution" && v.status === "INTERRUPTED_UNKNOWN"));
    assert.ok(values.some((v) => v.kind === "session" && v.status === "CLOSED"));
  });

for (const fault of ["partial-write", "readback"])
  test(`target-observe ${fault} prevents baseline and keeps consumed attempt UNKNOWN`, async (t) => {
    const f = await targetObserveFixture(t),
      session = await f.open();
    const opening = fs.open.bind(fs);
    let observationFile,
      injected = false;
    t.mock.method(fs, "open", async (file, flags, ...args) => {
      if (fault === "readback" && file === observationFile && flags === "r") {
        injected = true;
        throw new Error("offline observation independent reopen failure");
      }
      const handle = await opening(file, flags, ...args);
      if (flags === "wx" && String(file).startsWith(f.profile.storage.archiveRoot + path.sep)) {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async (bytes) => {
          if (JSON.parse(bytes).kind === "observation") {
            observationFile = file;
            if (fault === "partial-write") {
              injected = true;
              await write(bytes.subarray(0, 24));
              throw new Error("offline partial observation write");
            }
          }
          return write(bytes);
        };
      }
      return handle;
    });
    await assert.rejects(
      launcher.connectAndObserveManualTarget({ session, operationRef: f.prepared.operationRef })
    );
    assert.equal(injected, true);
    assert.equal(f.pg.closes, 1);
    // Unreadable/partial archive facts may prevent R1 from appending UNKNOWN:
    // the durable consumption and lock must remain rather than claim success.
    assert.equal(
      (await fs.readdir(path.join(f.profile.storage.journalRoot, "consumptions"))).length,
      1
    );
    const archived = await fs.readdir(path.join(f.profile.storage.archiveRoot, "objects"));
    for (const name of archived) {
      if (path.join(f.profile.storage.archiveRoot, "objects", name) === observationFile) continue;
      const value = JSON.parse(
        await nativeFS.readFile(path.join(f.profile.storage.archiveRoot, "objects", name))
      );
      assert.notEqual(value.schemaVersion, "manual-baseline-manifest.v1");
    }
  });

test("H3 Docker source observations bind resources before trusted session bootstrap", async (t) => {
  const f = await h3ResourceFixture(t);
  await assert.rejects(launcher.launchManualStage1({ operationRef: f.prepared.operationRef }), {
    code: "MANUAL_SESSION_UNVERIFIED"
  });
  assert.deepEqual(
    f.docker.calls.map(({ args }) =>
      args[2] === "container" && args[3] === "ls" ? "users" : args[2]
    ),
    [
      "container",
      "volume",
      "image",
      "network",
      "users",
      "container",
      "volume",
      "image",
      "network",
      "users"
    ]
  );
  for (const { args } of f.docker.calls) {
    assert.ok(!args.some((arg) => ["exec", "run", "start", "create", "pull"].includes(arg)));
    if (args[3] === "inspect") {
      assert.equal(args.at(-2), "--");
      assert.ok(
        ["b".repeat(64), "synthetic-h3-volume", digest("c"), "d".repeat(64)].includes(args.at(-1))
      );
      const template = args[args.indexOf("--format") + 1];
      assert.ok(
        !template.includes("{{json .}}") &&
          !template.includes("{{json .Config}}") &&
          !template.includes("{{json .Config.Env}}"),
        "whole configuration or secret environment must never be requested"
      );
    } else {
      assert.deepEqual(args.slice(2), [
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--filter",
        "volume=synthetic-h3-volume",
        "--format",
        "{{.ID}}"
      ]);
    }
  }
  assert.equal(f.counters.privateKeyReads, 0);
  assert.equal(f.counters.sessionWrites, 0);
  assert.equal(f.counters.credentialReads, 0);
  assert.equal(f.counters.externalCalls, 0);
});

test("H3 Docker real CLI formats nonsecret projections against an isolated synthetic Engine pipe", async (t) => {
  const f = await h3ResourceFixture(t);
  const pipe = "\\\\.\\pipe\\stage1-h3-test-" + randomUUID();
  const requests = [];
  const c = f.docker.outputs.container,
    v = f.docker.outputs.volume,
    i = f.docker.outputs.image,
    n = f.docker.outputs.network;
  const secret = "SYNTHETIC_SECRET_MUST_NOT_BE_PROJECTED";
  let volumeOptions = null;
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.setHeader("Api-Version", "1.47");
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/_ping") {
      response.end("OK");
      return;
    }
    const route = request.url.replace(/^\/v[0-9.]+/u, "").split("?")[0];
    let value;
    if (route === "/containers/" + c.id + "/json")
      value = {
        Id: c.id,
        Name: c.name,
        Image: c.imageId,
        Config: {
          Image: c.imageReference,
          Labels: { "subscription-stage1-manual-marker": c.marker },
          Env: ["X=x", "PGDATA=/var/lib/postgresql/data", "POSTGRES_PASSWORD=" + secret],
          Entrypoint: ["docker-entrypoint.sh"],
          Cmd: ["postgres"]
        },
        State: { Running: true, Paused: false, Restarting: false, Dead: false },
        HostConfig: { Privileged: false, NetworkMode: c.networkMode, PortBindings: c.portBindings },
        Mounts: c.mounts,
        NetworkSettings: { Ports: c.ports, Networks: c.networks }
      };
    else if (route === "/volumes/" + v.name)
      value = {
        Name: v.name,
        Driver: v.driver,
        Scope: v.scope,
        Mountpoint: v.mountpoint,
        Options: volumeOptions,
        Labels: { "subscription-stage1-manual-marker": v.marker }
      };
    else if (decodeURIComponent(route) === "/images/" + i.id + "/json")
      value = { Id: i.id, RepoDigests: i.repoDigests };
    else if (route === "/networks/" + n.id)
      value = { Id: n.id, Name: n.name, Driver: n.driver, Scope: n.scope };
    else if (route === "/containers/json")
      value = [
        {
          Id: c.id,
          Names: [c.name],
          Image: c.imageReference,
          ImageID: c.imageId,
          State: "running",
          Status: "Up",
          Ports: [],
          Labels: {}
        }
      ];
    else {
      response.statusCode = 404;
      value = { message: "unexpected synthetic route" };
    }
    response.end(JSON.stringify(value));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipe, resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const responses = [];
  f.docker.native = (args, options, callback) =>
    nativeExecFile(
      "docker",
      ["--host", "npipe:////./pipe/" + pipe.split("\\").at(-1), ...args.slice(2)],
      options,
      (error, stdout, stderr) => {
        responses.push({
          error: error?.message,
          stdout: stdout?.toString("utf8"),
          stderr: stderr?.toString("utf8")
        });
        callback(error, stdout, stderr);
      }
    );
  await assert.rejects(
    launcher.launchManualStage1({ operationRef: f.prepared.operationRef }),
    (error) => {
      assert.equal(error.code, "MANUAL_SESSION_UNVERIFIED", JSON.stringify(responses));
      return true;
    }
  );
  assert.equal(responses.length, 10);
  assert.ok(requests.some((url) => url.includes("/containers/json?")));
  assert.ok(!JSON.stringify(responses).includes(secret));
  for (const [name, mutate, expected] of [
    [
      "network driver options stay out of collected output",
      () => {
        c.networks["synthetic-h3-network"].DriverOpts = { password: secret };
      },
      "MANUAL_SESSION_UNVERIFIED"
    ],
    [
      "rejected volume options stay out of collected output",
      () => {
        delete c.networks["synthetic-h3-network"].DriverOpts;
        volumeOptions = { type: "cifs", o: "username=synthetic,password=" + secret };
      },
      "MANUAL_H3_RESOURCE_MISMATCH"
    ]
  ])
    await t.test(name, async () => {
      mutate();
      const offset = responses.length;
      await assert.rejects(
        launcher.launchManualStage1({ operationRef: f.prepared.operationRef }),
        expected === "MANUAL_SESSION_UNVERIFIED" ? { code: expected } : h3Rejection(expected)
      );
      assert.ok(responses.length > offset, "the real CLI observation happened");
      assert.ok(
        !JSON.stringify(responses.slice(offset)).includes(secret),
        "driver secrets must not enter captured stdout even when the resource is refused"
      );
      assert.equal(f.counters.sessionWrites, 0);
      assert.equal(f.counters.credentialReads, 0);
      assert.equal(f.counters.externalCalls, 0);
    });
  assert.equal(f.counters.privateKeyReads, 0);
  assert.equal(f.counters.sessionWrites, 0);
  assert.equal(f.counters.credentialReads, 0);
  assert.equal(f.counters.externalCalls, 0);
});

test("H3 Docker resource mismatches cannot become target observations", async (t) => {
  const f = await h3ResourceFixture(t);
  const original = structuredClone(f.docker.outputs);
  for (const [name, mutate] of [
    [
      "container ID",
      (o) => {
        o.container.id = "f".repeat(64);
      }
    ],
    [
      "container name",
      (o) => {
        o.container.name = "/other";
      }
    ],
    [
      "stopped container",
      (o) => {
        o.container.running = false;
      }
    ],
    [
      "container marker",
      (o) => {
        o.container.marker = "other";
      }
    ],
    [
      "volume marker",
      (o) => {
        o.volume.marker = "other";
      }
    ],
    [
      "named volume",
      (o) => {
        o.container.mounts[0].Name = "other";
      }
    ],
    [
      "volume mount source",
      (o) => {
        o.volume.mountpoint += "-other";
      }
    ],
    [
      "bind-backed local volume",
      (o) => {
        o.volume.optionsEmpty = false;
      }
    ],
    [
      "PGDATA bypass",
      (o) => {
        o.container.pgdata = [false];
      }
    ],
    [
      "entrypoint bypass",
      (o) => {
        o.container.defaultEntrypoint = false;
      }
    ],
    [
      "command override",
      (o) => {
        o.container.defaultCommand = false;
      }
    ],
    [
      "overlaid data directory",
      (o) => {
        o.container.mounts.push({
          Type: "bind",
          Source: "/other",
          Destination: "/var/lib/postgresql/data/base",
          RW: false
        });
      }
    ],
    [
      "local image identity",
      (o) => {
        o.image.id = digest("f");
      }
    ],
    [
      "registry digest",
      (o) => {
        o.image.repoDigests = ["postgres@" + digest("f")];
      }
    ],
    [
      "mutable image tag",
      (o) => {
        o.container.imageReference = "postgres:17";
      }
    ],
    [
      "published port",
      (o) => {
        o.container.ports["5432/tcp"][0].HostPort = "25433";
      }
    ],
    [
      "wildcard bind",
      (o) => {
        o.container.ports["5432/tcp"][0].HostIp = "0.0.0.0";
        o.container.portBindings = structuredClone(o.container.ports);
      }
    ],
    [
      "duplicate published binding",
      (o) => {
        o.container.ports["5432/tcp"].push({ HostIp: "::", HostPort: "25432" });
      }
    ],
    [
      "internal server address",
      (o) => {
        o.container.networks["synthetic-h3-network"].IPAddress = "172.19.0.3";
      }
    ],
    [
      "host networking",
      (o) => {
        o.container.networkMode = "host";
      }
    ],
    [
      "network ID",
      (o) => {
        o.network.id = "f".repeat(64);
      }
    ],
    [
      "unproven proxy network",
      (o) => {
        o.network.driver = "overlay";
      }
    ],
    [
      "shared volume",
      (o) => {
        o.users = Buffer.from("b".repeat(64) + "\n" + "e".repeat(64) + "\n");
      }
    ]
  ]) {
    await t.test(name, async () => {
      f.docker.outputs = structuredClone(original);
      f.docker.outputs.users = Buffer.from(f.docker.outputs.users);
      mutate(f.docker.outputs);
      await assert.rejects(
        launcher.launchManualStage1({ operationRef: f.prepared.operationRef }),
        h3Rejection("MANUAL_H3_RESOURCE_MISMATCH")
      );
      noAuthority(f);
    });
  }
});

test("H3 Docker observations reject failed or unbounded raw source output", async (t) => {
  const f = await h3ResourceFixture(t);
  for (const [name, value] of [
    ["daemon failure", new Error("synthetic failed inspect")],
    ["invalid UTF-8", Buffer.from([0xff])],
    ["oversized raw", Buffer.alloc(1048577, 32)],
    ["two documents", Buffer.from("{}\n{}\n")],
    ["truncated JSON", Buffer.from('{"id":')]
  ])
    await t.test(name, async () => {
      f.docker.outputs.container = value;
      const before = f.docker.calls.length;
      await assert.rejects(
        launcher.launchManualStage1({ operationRef: f.prepared.operationRef }),
        (error) => {
          h3Rejection("MANUAL_H3_RESOURCE_INPUT_REQUIRED")(error);
          assert.ok(!String(error.cause?.stack).includes("private daemon error"));
          return true;
        }
      );
      assert.equal(
        f.docker.calls.length,
        before + 1,
        "the actual raw observation boundary was reached"
      );
      noAuthority(f);
    });
});

test("H3 Docker observations recheck source bytes after every external await", async (t) => {
  const f = await h3ResourceFixture(t);
  let changed = false;
  f.docker.before = (kind) => {
    if (kind === "container" && !changed) {
      changed = true;
      fsSync.writeFileSync(
        path.join(f.operationRoot, "h3-a-readback.json"),
        encodeManualJson({ ...f.readback, databaseOid: "456" })
      );
    }
  };
  await assert.rejects(
    launcher.launchManualStage1({ operationRef: f.prepared.operationRef }),
    h3Rejection("MANUAL_OPERATION_INPUT_UNAVAILABLE")
  );
  assert.equal(changed, true);
  assert.equal(f.docker.calls.length, 1, "do not continue inspection after fixed input changed");
  noAuthority(f);
});

test("H3 Docker observations detect replacement between independent resource reads", async (t) => {
  const f = await h3ResourceFixture(t);
  let seen = 0;
  f.docker.before = (kind) => {
    if (kind === "container" && ++seen === 2) f.docker.outputs.container.id = "e".repeat(64);
  };
  await assert.rejects(
    launcher.launchManualStage1({ operationRef: f.prepared.operationRef }),
    h3Rejection("MANUAL_H3_RESOURCE_MISMATCH")
  );
  assert.equal(seen, 2);
  noAuthority(f);
});

test("H3 Docker observations cannot carry an index replaced during inspection into the next phase", async (t) => {
  const f = await h3ResourceFixture(t);
  let changed = false;
  f.docker.before = (kind) => {
    if (kind === "users" && !changed) {
      changed = true;
      fsSync.appendFileSync(path.join(f.operationRoot, "index.json"), "\n");
    }
  };
  await assert.rejects(
    launcher.launchManualStage1({ operationRef: f.prepared.operationRef }),
    h3Rejection("MANUAL_OPERATION_INPUT_UNAVAILABLE")
  );
  assert.equal(changed, true);
  noAuthority(f);
});

for (const key of [
  "operationRef",
  "indexDigest",
  "runId",
  "profileDigest",
  "targetIntent",
  "ownerId"
]) {
  for (const part of ["approval", "readback"]) {
    test(`launch binds fixed H3 ${part} ${key} to independently read index/profile`, async (t) => {
      const f = await h3InputFixture(t);
      f[part][key] =
        key === "targetIntent"
          ? { ...f[part][key], databaseName: "other-db" }
          : key.endsWith("Digest")
            ? digest("f")
            : key === "ownerId"
              ? "other-owner"
              : randomUUID();
      await writeH3(f);
      await assert.rejects(
        launcher.launchManualStage1({ operationRef: f.prepared.operationRef }),
        h3Rejection("MANUAL_H3_BINDING_INVALID")
      );
      noAuthority(f);
    });
  }
}

for (const [name, mutate] of [
  [
    "extra creation spec key",
    (f) => {
      f.approval.creationSpec.command = "forbidden";
    }
  ],
  [
    "wrong profile endpoint",
    (f) => {
      f.approval.creationSpec.endpoint = "other.invalid:5432";
      f.readback.endpoint = f.approval.creationSpec.endpoint;
    }
  ],
  [
    "wrong complete approval bytes",
    (f) => {
      f.readback.approval.digest = digest("f");
    }
  ],
  [
    "wrong complete approval size",
    (f) => {
      f.readback.approval.bytes++;
    }
  ],
  [
    "changed volume",
    (f) => {
      f.readback.cluster.dataVolumeName = "other-volume";
    }
  ],
  [
    "changed container name",
    (f) => {
      f.readback.databaseContainerName = "other-container";
    }
  ],
  [
    "observations before approval",
    (f) => {
      f.readback.sqlObservedAt = "2026-08-01T00:00:00.000Z";
    }
  ],
  [
    "future readback",
    (f) => {
      f.readback.readbackAt = "2099-01-01T00:00:00.000Z";
    }
  ],
  [
    "numeric database OID",
    (f) => {
      f.readback.databaseOid = 123;
    }
  ]
]) {
  test(`launch refuses fixed H3 ${name} before any session or credential`, async (t) => {
    const f = await h3InputFixture(t);
    mutate(f);
    await writeH3(f, { bindApproval: !name.startsWith("wrong complete approval") });
    await assert.rejects(
      launcher.launchManualStage1({ operationRef: f.prepared.operationRef }),
      h3Rejection(
        name === "extra creation spec key"
          ? "MANUAL_H3_FORMAT_INVALID"
          : "MANUAL_H3_BINDING_INVALID"
      )
    );
    noAuthority(f);
  });
}

test("well-shaped fixed H3 does not claim actual resource source verification", async (t) => {
  const f = await h3InputFixture(t);
  await writeH3(f);
  await assert.rejects(
    launcher.launchManualStage1({ operationRef: f.prepared.operationRef }),
    h3Rejection("MANUAL_H3_RESOURCE_INPUT_REQUIRED")
  );
  assert.equal(new Set(f.h3Opens).size, 2);
  noAuthority(f);
});

test("fixed H3 retains ancestor identity without treating unrelated sibling creation as source mutation", async (t) => {
  const f = await h3InputFixture(t);
  await writeH3(f);
  const file = path.join(f.operationRoot, "h3-a-approval.json");
  const opening = fs.open.bind(fs);
  let opens = 0;
  t.mock.method(fs, "open", async (candidate, ...args) => {
    if (candidate === file && ++opens === 2) await fs.mkdir(path.join(f.root, "unrelated-sibling"));
    return opening(candidate, ...args);
  });
  await assert.rejects(
    launcher.launchManualStage1({ operationRef: f.prepared.operationRef }),
    h3Rejection("MANUAL_H3_RESOURCE_INPUT_REQUIRED")
  );
  assert.ok(opens >= 2, "the unrelated ancestor timestamp change actually occurred");
  noAuthority(f);
});

test("H3 ACL inspection tolerates unrelated ancestor timestamps while preserving private path checks", async (t) => {
  const f = await h3InputFixture(t);
  await writeH3(f);
  const file = path.join(f.operationRoot, "h3-a-approval.json");
  let faultHit = false;
  f.host.before = (command, args) => {
    if (!faultHit && command === system + "icacls.exe" && args.includes(file)) {
      faultHit = true;
      fsSync.mkdirSync(path.join(f.root, "unrelated-during-acl"));
    }
  };
  await assert.rejects(
    launcher.launchManualStage1({ operationRef: f.prepared.operationRef }),
    h3Rejection("MANUAL_H3_RESOURCE_INPUT_REQUIRED")
  );
  assert.equal(faultHit, true, "the existing ACL await window changed only the outside ancestor");
  noAuthority(f);
});

for (const mode of ["junction", "new regular directory"]) {
  test(`H3 rejects a private ancestor replaced with ${mode} despite identical file bytes`, async (t) => {
    const f = await h3InputFixture(t);
    await writeH3(f);
    const file = path.join(f.operationRoot, "h3-a-approval.json");
    const retained = path.join(f.root, "original-h3-directory");
    let faultHit = false;
    const replace = async () => {
      faultHit = true;
      await fs.rename(f.operationRoot, retained);
      if (mode === "junction") await fs.symlink(retained, f.operationRoot, "junction");
      else {
        await fs.mkdir(f.operationRoot, { mode: 0o700 });
        await writeH3(f);
      }
    };
    if (mode === "junction") {
      const checking = fs.lstat.bind(fs);
      t.mock.method(fs, "lstat", async (candidate, ...args) => {
        if (candidate === file && !faultHit) await replace();
        return checking(candidate, ...args);
      });
    } else {
      const opening = fs.open.bind(fs);
      t.mock.method(fs, "open", async (candidate, ...args) => {
        if (candidate === file && !faultHit) await replace();
        return opening(candidate, ...args);
      });
    }
    await assert.rejects(
      launcher.launchManualStage1({ operationRef: f.prepared.operationRef }),
      h3Rejection("MANUAL_OPERATION_INPUT_UNAVAILABLE")
    );
    assert.equal(faultHit, true, "the actual private directory replacement happened");
    noAuthority(f);
  });
}

test("prepare freezes its four caller inputs before asynchronous build verification", async (t) => {
  const f = await buildFixture(t),
    input = prepareInput(f);
  const originalProof = Buffer.from(input.proofBytes),
    originalMaterial = Buffer.from(input.materialBytes);
  f.gh.before = () => {
    input.proofBytes.fill(32);
    input.materialBytes.fill(32);
    input.targetIntent.databaseName = "changed-caller-db";
    input.scenario = "apply-interrupted";
  };
  const result = await launcher.prepareManualOperation(input);
  const fixed = await readFixedManualOperation({
    repoRoot: productionRoot,
    operationRef: result.operationRef
  });
  assert.equal(fixed.operation.scenario, "normal");
  assert.equal(fixed.operation.targetIntent.databaseName, "synthetic-db");
  assert.equal(fixed.operation.proofRawDigest, sha256Bytes(originalProof));
  assert.equal(fixed.operation.materialRawDigest, sha256Bytes(originalMaterial));
  noAuthority(f);
});

test("synthetic lowest-layer fixture passes the unchanged R1 build verifier", async (t) => {
  const f = await buildFixture(t);
  const build = await verifyManualBuild({
    repoRoot: productionRoot,
    proofBytes: f.proofBytes,
    materialBytes: f.materialBytes
  });
  assert.equal(build.custodyReceiptRawDigest, sha256Bytes(f.receiptBytes));
  assert.equal(build.buildProofDigest, sha256Canonical(f.proof));
  assert.equal(f.counters.indexWrites, 0);
  noAuthority(f);
});

for (const scenario of ["normal", "apply-interrupted"]) {
  test(`prepare ${scenario} creates a closed fixed index and returns only its independent reference`, async (t) => {
    const f = await buildFixture(t);
    const result = await launcher.prepareManualOperation(prepareInput(f, { scenario }));
    assert.deepEqual(Object.keys(result).sort(), [
      "indexDigest",
      "operationRef",
      "promotionEligible"
    ]);
    assert.equal(result.promotionEligible, false);
    const fixed = await readFixedManualOperation({
      repoRoot: productionRoot,
      operationRef: result.operationRef
    });
    const index = fixed.operation;
    assert.equal(fixed.indexDigest, result.indexDigest);
    assert.deepEqual(Object.keys(index).sort(), [
      "buildProofDigest",
      "createdAt",
      "custodyReceiptRawDigest",
      "materialRawDigest",
      "operationRef",
      "operations",
      "profileDigest",
      "promotionEligible",
      "proofRawDigest",
      "purpose",
      "runId",
      "scenario",
      "schemaVersion",
      "targetIntent"
    ]);
    assert.equal(index.profileDigest, sha256Canonical(f.profile));
    assert.equal(index.buildProofDigest, sha256Canonical(f.proof));
    assert.equal(index.proofRawDigest, sha256Bytes(f.proofBytes));
    assert.equal(index.materialRawDigest, sha256Bytes(f.materialBytes));
    assert.equal(index.custodyReceiptRawDigest, sha256Bytes(f.receiptBytes));
    assert.equal(index.purpose, "synthetic-fresh");
    assert.equal(index.scenario, scenario);
    assert.deepEqual(index.targetIntent, {
      endpointPolicyId: "synthetic-policy",
      databaseName: "synthetic-db"
    });
    const identities = [
      index.operationRef,
      index.runId,
      ...Object.values(index.operations).map((entry) => entry.operationId)
    ];
    assert.equal(new Set(identities).size, 5);
    for (const identity of identities)
      assert.match(
        identity,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      );
    for (const phase of ["observe", "migrate", "verify"])
      assert.equal(
        index.operations[phase].idempotencyKey,
        `manual-stage1:${result.operationRef}:${phase}`
      );
    const bytes = await fs.readFile(
      path.join(
        f.profile.storage.archiveRoot,
        "inputs",
        "operations",
        result.operationRef,
        "index.json"
      )
    );
    assert.deepEqual(bytes, encodeManualJson(index));
    assert.equal(f.counters.indexWrites, 1);
    noAuthority(f);
  });
}

for (const [name, mutate, code] of [
  [
    "missing sidecar",
    (f) => fs.unlink(path.join(f.repoRoot, bindingName)),
    "TRUSTED_BUILD_UNAVAILABLE"
  ],
  ["changed approval", (f) => fs.appendFile(f.approvalPath, "\n"), "TRUSTED_BUILD_UNAVAILABLE"],
  [
    "wrong actual host",
    (f) => {
      f.host.guid = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    },
    "TRUSTED_BUILD_UNAVAILABLE"
  ],
  [
    "wrong actual principal",
    (f) => {
      f.host.sid = "S-1-5-21-999-888-777-1002";
    },
    "TRUSTED_BUILD_UNAVAILABLE"
  ],
  ...["key", "journal", "archive", "backup", "credential"].map((name) => [
    `wrong ${name} root ACL`,
    (f) => {
      f.host.badRoot = f.profile.storage[`${name}Root`];
    },
    "TRUSTED_BUILD_UNAVAILABLE"
  ]),
  ["missing proof", (f) => fs.unlink(f.proofPath), "TRUSTED_BUILD_UNAVAILABLE"],
  ["changed material", (f) => fs.appendFile(f.materialPath, "\n"), "TRUSTED_BUILD_UNAVAILABLE"],
  [
    "missing custody receipt",
    (f) => fs.unlink(f.receiptPath),
    "MANUAL_BUILD_CUSTODY_INPUT_REQUIRED"
  ],
  [
    "wrong receipt content binding",
    (f) =>
      fs.writeFile(f.receiptPath, encodeManualJson({ ...f.receipt, contentDigest: digest("e") })),
    "TRUSTED_BUILD_UNAVAILABLE"
  ],
  [
    "receipt from another source run",
    (f) => {
      f.gh.receipt[0].verificationResult.signature.certificate.runInvocationURI = `https://github.com/${repository}/actions/runs/9999/attempts/1`;
    },
    "TRUSTED_BUILD_UNAVAILABLE"
  ],
  [
    "incomplete CI",
    (f) => {
      f.gh.run.status = "in_progress";
    },
    "TRUSTED_BUILD_UNAVAILABLE"
  ]
]) {
  test(`prepare rejects ${name} before index/key/session/H3 access`, async (t) => {
    const f = await buildFixture(t);
    await mutate(f);
    await assert.rejects(launcher.prepareManualOperation(prepareInput(f)), { code });
    assert.equal(f.counters.indexWrites, 0);
    noAuthority(f);
  });
}

for (const [name, overrides] of [
  ["missing target", { targetIntent: undefined }],
  [
    "target profile mismatch",
    { targetIntent: { endpointPolicyId: "synthetic-policy", databaseName: "other-db" } }
  ],
  [
    "target future authority field",
    {
      targetIntent: {
        endpointPolicyId: "synthetic-policy",
        databaseName: "synthetic-db",
        approved: true
      }
    }
  ],
  ["missing scenario", { scenario: undefined }],
  ["unsupported scenario", { scenario: "snapshot" }]
]) {
  test(`prepare rejects ${name} without reserving an operation`, async (t) => {
    const f = await buildFixture(t);
    await assert.rejects(launcher.prepareManualOperation(prepareInput(f, overrides)), {
      code: "MANUAL_OPERATION_INPUT_UNAVAILABLE"
    });
    assert.equal(f.counters.indexWrites, 0);
    noAuthority(f);
    await assert.rejects(
      fs.readdir(path.join(f.profile.storage.archiveRoot, "inputs", "operations")),
      { code: "ENOENT" }
    );
  });
}

test("prepare rejects a wide existing operations-directory ACL before writing any index", async (t) => {
  const f = await buildFixture(t);
  const operationsRoot = path.join(f.profile.storage.archiveRoot, "inputs", "operations");
  await fs.mkdir(operationsRoot, { recursive: true });
  f.host.wideRoot = operationsRoot;
  await assert.rejects(launcher.prepareManualOperation(prepareInput(f)));
  assert.equal(f.counters.indexWrites, 0);
  assert.deepEqual(await fs.readdir(operationsRoot), []);
  noAuthority(f);
});

test("prepare refuses a changed owner binding after H1 success before index write", async (t) => {
  const f = await buildFixture(t);
  let changed = false;
  t.mock.method(crypto, "randomUUID", () => {
    if (!changed) {
      changed = true;
      fsSync.writeFileSync(
        path.join(f.repoRoot, bindingName),
        encodeManualJson({ ...f.binding, approvedAt: "2026-09-02T00:00:00.000Z" })
      );
    }
    return nativeUUID();
  });
  syncBuiltinESMExports();
  await assert.rejects(launcher.prepareManualOperation(prepareInput(f)));
  assert.equal(f.counters.indexWrites, 0);
  noAuthority(f);
});

test("prepare refuses a new checkout HEAD even when tracked contract bytes stay identical", async (t) => {
  const f = await buildFixture(t);
  let changed = false;
  t.mock.method(crypto, "randomUUID", () => {
    if (!changed) {
      changed = true;
      childProcess.execFileSync(
        "git",
        [
          "-c",
          "core.hooksPath=NUL",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "user.name=Synthetic Test",
          "-c",
          "user.email=test@example.invalid",
          "-C",
          f.repoRoot,
          "commit",
          "--allow-empty",
          "--no-verify",
          "-m",
          "Synthetic changed source"
        ],
        {
          shell: false,
          windowsHide: true,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "NUL"
          }
        }
      );
    }
    return nativeUUID();
  });
  syncBuiltinESMExports();
  await assert.rejects(launcher.prepareManualOperation(prepareInput(f)));
  assert.equal(f.counters.indexWrites, 0);
  noAuthority(f);
});

test("prepare detects binding rename-out-and-back during the real H1 loader window", async (t) => {
  const f = await buildFixture(t);
  let replaced = false;
  f.host.before = (file) => {
    if (!replaced && file === system + "whoami.exe") {
      replaced = true;
      const bindingPath = path.join(f.repoRoot, bindingName),
        displaced = bindingPath + ".displaced";
      fsSync.renameSync(bindingPath, displaced);
      fsSync.renameSync(displaced, bindingPath);
    }
  };
  await assert.rejects(launcher.prepareManualOperation(prepareInput(f)));
  assert.equal(replaced, true);
  assert.equal(f.counters.indexWrites, 0);
  noAuthority(f);
});

test("prepare cannot replace the verified build tuple with another independently valid H1 tuple", async (t) => {
  const f = await buildFixture(t);
  let changed = false,
    replacement;
  t.mock.method(crypto, "randomUUID", () => {
    if (!changed) {
      changed = true;
      replacement = { ...f.profile, profileId: nativeUUID() };
      const approval = { ...f.approval, profileDigest: sha256Canonical(replacement) };
      const approvalBytes = encodeManualJson(approval),
        approvalDigest = sha256Bytes(approvalBytes);
      const binding = {
        ...approval,
        schemaVersion: "manual-stage1-owner-binding.v1",
        approvalDigest,
        approvalReference: `inputs/h1/${approvalDigest.slice(7)}.approval.json`
      };
      fsSync.writeFileSync(
        path.join(f.profile.storage.archiveRoot, binding.approvalReference),
        approvalBytes
      );
      fsSync.writeFileSync(path.join(f.repoRoot, profileName), encodeManualJson(replacement));
      fsSync.writeFileSync(path.join(f.repoRoot, bindingName), encodeManualJson(binding));
    }
    return nativeUUID();
  });
  syncBuiltinESMExports();
  await assert.rejects(launcher.prepareManualOperation(prepareInput(f)));
  assert.deepEqual(await loadFixedManualProfile({ repoRoot: productionRoot }), replacement);
  assert.equal(f.counters.indexWrites, 0);
  noAuthority(f);
});

test("prepare detects a verified source file changed after build success before index write", async (t) => {
  const f = await buildFixture(t);
  let changed = false;
  t.mock.method(crypto, "randomUUID", () => {
    if (!changed) {
      changed = true;
      fsSync.appendFileSync(
        path.join(f.repoRoot, "scripts", "release", "verify-build-proof.mjs"),
        "\n// synthetic later source\n"
      );
    }
    return nativeUUID();
  });
  syncBuiltinESMExports();
  await assert.rejects(launcher.prepareManualOperation(prepareInput(f)));
  assert.equal(f.counters.indexWrites, 0);
  noAuthority(f);
});

for (const fault of ["source-bytes", "checkout-HEAD", "binding-ABA"]) {
  test(`prepare final independent readback ${fault} retains UNKNOWN instead of returning success`, async (t) => {
    const f = await buildFixture(t);
    const open = fs.open.bind(fs);
    let injected = false,
      reservedRef;
    t.mock.method(fs, "open", async (file, flags, ...args) => {
      if (!injected && flags === "r" && String(file).endsWith(path.sep + "index.json")) {
        injected = true;
        reservedRef = path.basename(path.dirname(file));
        if (fault === "source-bytes")
          await nativeFS.writeFile(
            path.join(f.repoRoot, "scripts", "release", "verify-build-proof.mjs"),
            "changed during independent reader\n"
          );
        else if (fault === "checkout-HEAD")
          await git(
            f.repoRoot,
            "commit",
            "--allow-empty",
            "--no-verify",
            "-m",
            "Synthetic readback source change"
          );
        else {
          const binding = path.join(f.repoRoot, bindingName);
          fsSync.renameSync(binding, binding + ".displaced");
          fsSync.renameSync(binding + ".displaced", binding);
        }
      }
      return open(file, flags, ...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(launcher.prepareManualOperation(prepareInput(f)), (error) => {
      assert.equal(error.code, "MANUAL_OPERATION_PREPARATION_UNKNOWN");
      assert.equal(error.operationRef, reservedRef);
      assert.equal(error.cause.code, "MANUAL_OPERATION_INPUT_UNAVAILABLE");
      return true;
    });
    assert.equal(injected, true);
    assert.deepEqual(
      await fs.readdir(path.join(f.profile.storage.archiveRoot, "inputs", "operations")),
      [reservedRef]
    );
    assert.ok(
      (
        await nativeFS.readFile(
          path.join(
            f.profile.storage.archiveRoot,
            "inputs",
            "operations",
            reservedRef,
            "index.json"
          )
        )
      ).length > 0
    );
    assert.equal(f.counters.indexWrites, 1);
    noAuthority(f);
  });
}

test("prepare rechecks opened index ACL after source awaits before writing bytes", async (t) => {
  const f = await buildFixture(t);
  const open = fs.open.bind(fs);
  let indexPath,
    injected = false,
    dataWrites = 0;
  t.mock.method(fs, "open", async (file, flags, ...args) => {
    const handle = await open(file, flags, ...args);
    if (flags === "wx" && String(file).endsWith(path.sep + "index.json")) {
      indexPath = file;
      const write = handle.writeFile.bind(handle);
      handle.writeFile = (...values) => {
        dataWrites++;
        return write(...values);
      };
    }
    return handle;
  });
  f.host.before = (file) => {
    if (!injected && indexPath && file === "git") {
      injected = true;
      f.host.wideRoot = indexPath;
    }
  };
  syncBuiltinESMExports();
  await assert.rejects(launcher.prepareManualOperation(prepareInput(f)), (error) => {
    assert.equal(error.code, "MANUAL_OPERATION_PREPARATION_UNKNOWN");
    assert.equal(error.operationRef, path.basename(path.dirname(indexPath)));
    assert.equal(error.cause.code, "MANUAL_OPERATION_INPUT_UNAVAILABLE");
    return true;
  });
  assert.equal(injected, true);
  assert.equal(dataWrites, 0);
  assert.equal((await nativeFS.readFile(indexPath)).length, 0);
  assert.equal(f.counters.indexWrites, 1, "CreateNew reserved the empty file without data writes");
  noAuthority(f);
});

for (const fault of [
  "wide-inputs",
  "new-directory-ACL",
  "new-directory-path",
  "opened-index-ACL"
]) {
  test(`prepare ${fault} refuses bytes before the first index write`, async (t) => {
    const f = await buildFixture(t);
    let reservedRef, indexPath;
    const mkdir = fs.mkdir.bind(fs),
      open = fs.open.bind(fs),
      realpath = fs.realpath.bind(fs);
    if (fault === "wide-inputs")
      f.host.wideRoot = path.join(f.profile.storage.archiveRoot, "inputs");
    t.mock.method(fs, "mkdir", async (file, ...args) => {
      const result = await mkdir(file, ...args);
      if (path.basename(path.dirname(file)) === "operations") {
        reservedRef = path.basename(file);
        if (fault === "new-directory-ACL") f.host.wideRoot = file;
      }
      return result;
    });
    t.mock.method(fs, "realpath", (file, ...args) =>
      fault === "new-directory-path" && path.basename(file) === reservedRef
        ? Promise.resolve(path.join(f.root, "wrong-operation-path"))
        : realpath(file, ...args)
    );
    t.mock.method(fs, "open", async (file, flags, ...args) => {
      const handle = await open(file, flags, ...args);
      if (flags === "wx" && String(file).endsWith(path.sep + "index.json")) {
        indexPath = file;
        if (fault === "opened-index-ACL") f.host.wideRoot = file;
      }
      return handle;
    });
    syncBuiltinESMExports();
    await assert.rejects(launcher.prepareManualOperation(prepareInput(f)));
    if (indexPath) assert.equal((await nativeFS.readFile(indexPath)).length, 0);
    else assert.equal(f.counters.indexWrites, 0);
    noAuthority(f);
  });
}

test("prepare collision preserves the original ref and bytes without generating another identity set", async (t) => {
  const f = await buildFixture(t),
    reservedRef = randomUUID();
  const directory = path.join(f.profile.storage.archiveRoot, "inputs", "operations", reservedRef);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "index.json"), "original reserved bytes");
  let calls = 0;
  t.mock.method(crypto, "randomUUID", () => (++calls === 1 ? reservedRef : nativeUUID()));
  syncBuiltinESMExports();
  await assert.rejects(launcher.prepareManualOperation(prepareInput(f)), (error) => {
    assert.equal(error.code, "MANUAL_OPERATION_PREPARATION_UNKNOWN");
    assert.equal(error.operationRef, reservedRef);
    return true;
  });
  assert.equal(
    await fs.readFile(path.join(directory, "index.json"), "utf8"),
    "original reserved bytes"
  );
  assert.equal(calls, 5);
  assert.equal(f.counters.indexWrites, 0);
  noAuthority(f);
});

for (const fault of [
  "partial-write",
  "independent-readback",
  "readback-ACL",
  "readback-path",
  "future-index-field"
]) {
  test(`prepare ${fault} leaves the reserved ref and refuses success or automatic retry`, async (t) => {
    const f = await buildFixture(t);
    const open = fs.open.bind(fs);
    let reservedRef,
      wroteIndex = false,
      injected = false;
    t.mock.method(fs, "open", async (file, flags, ...args) => {
      if (String(file).endsWith(path.sep + "index.json")) {
        reservedRef = path.basename(path.dirname(file));
        if (flags === "r" && fault === "independent-readback") {
          injected = true;
          throw new Error("synthetic independent reopen failure");
        }
        if (flags === "r" && fault === "readback-ACL") {
          injected = true;
          f.host.badRoot = path.dirname(file);
        }
      }
      const handle = await open(file, flags, ...args);
      if (String(file).endsWith(path.sep + "index.json") && flags === "wx") {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async (bytes) => {
          if (fault === "partial-write") {
            injected = true;
            await write(bytes.subarray(0, 30));
            throw new Error("synthetic partial write");
          }
          if (fault === "future-index-field") {
            injected = true;
            return write(encodeManualJson({ ...JSON.parse(bytes), approved: true }));
          }
          const result = await write(bytes);
          wroteIndex = true;
          return result;
        };
      }
      return handle;
    });
    if (fault === "readback-path") {
      const realpath = fs.realpath.bind(fs);
      t.mock.method(fs, "realpath", (file, ...args) => {
        if (wroteIndex && String(file).endsWith(path.sep + "index.json")) {
          injected = true;
          return Promise.resolve(path.join(f.root, "wrong-path"));
        }
        return realpath(file, ...args);
      });
    }
    syncBuiltinESMExports();
    await assert.rejects(launcher.prepareManualOperation(prepareInput(f)), (error) => {
      assert.equal(error.code, "MANUAL_OPERATION_PREPARATION_UNKNOWN");
      assert.equal(error.operationRef, reservedRef);
      if (fault === "partial-write") assert.equal(error.cause.message, "synthetic partial write");
      else assert.equal(error.cause.code, "MANUAL_OPERATION_INPUT_UNAVAILABLE");
      return true;
    });
    assert.equal(injected, true, "the intended write/readback fault must actually occur");
    assert.deepEqual(
      await fs.readdir(path.join(f.profile.storage.archiveRoot, "inputs", "operations")),
      [reservedRef]
    );
    assert.ok(
      (
        await nativeFS.readFile(
          path.join(
            f.profile.storage.archiveRoot,
            "inputs",
            "operations",
            reservedRef,
            "index.json"
          )
        )
      ).length > 0
    );
    assert.equal(f.counters.indexWrites, 1);
    noAuthority(f);
  });
}
