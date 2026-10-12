import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { performance } from "node:perf_hooks";
import { currentR3StartupScope } from "./r3-startup-deadline.mjs";
import { r3FailureTracker } from "./r3-failure-diagnostic.mjs";

const storage = new AsyncLocalStorage();
const GH = "/opt/stage1-tools/gh_2.101.0_linux_amd64/bin/gh";
// The deployed version's default and custom verifier policies were compared.
const GH_SHA = "ea857a3f0f7d4276cf5848b236542c5048e2eaa7bdd1b6ddec238f8793e74bff";
const LIMIT = 1048576;
const WINDOW = 1200000;
const HOSTS = [
  ["tuf-repo-cdn.sigstore.dev", "sigstore.dev"],
  ["tuf-repo.github.com", "GitHub, Inc."]
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
const requireThat = (condition, code = "R3_TUF_MATERIAL_CHANGED") => {
  if (!condition) fail(code);
};
const json = (bytes) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));

function same(a, b, contents = true) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.uid === b.uid &&
    a.gid === b.gid &&
    a.mode === b.mode &&
    (!contents ||
      (a.nlink === b.nlink &&
        a.size === b.size &&
        a.mtimeNs === b.mtimeNs &&
        a.ctimeNs === b.ctimeNs))
  );
}

async function parents(file) {
  const found = [];
  let current = "/";
  for (const segment of path.dirname(file).split("/").filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current, { bigint: true });
    requireThat(stat.isDirectory() && stat.uid === 0n && (stat.mode & 0o022n) === 0n);
    found.push({ file: current, stat });
  }
  return found;
}

async function hold(file, { max = LIMIT, binary = false } = {}) {
  const ancestors = await parents(file);
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const stat = await handle.stat({ bigint: true });
    requireThat(
      stat.isFile() &&
        stat.uid === 0n &&
        (stat.mode & 0o022n) === 0n &&
        stat.nlink === 1n &&
        stat.size > 0n &&
        stat.size <= BigInt(max)
    );
    const read = async () => {
      const bytes = Buffer.alloc(Number(stat.size));
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        requireThat(bytesRead > 0);
        offset += bytesRead;
      }
      return bytes;
    };
    const bytes = await read();
    const recheck = async () => {
      for (const item of ancestors)
        requireThat(same(item.stat, await fs.lstat(item.file, { bigint: true }), false));
      requireThat(
        same(stat, await handle.stat({ bigint: true })) &&
          same(stat, await fs.lstat(file, { bigint: true }))
      );
      if (!binary) requireThat((await read()).equals(bytes));
    };
    await recheck();
    return { bytes, recheck, close: () => handle.close() };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function remaining(state) {
  requireThat(!state.closed, "R3_TUF_SCOPE_CLOSED");
  const now = Date.now(),
    mono = performance.now();
  requireThat(now >= state.lastWall && mono >= state.startedMono, "R3_TUF_SCOPE_EXPIRED");
  state.lastWall = now;
  const current = currentR3StartupScope();
  if (current) requireThat(current.operationRef === state.operationRef, "R3_TUF_SCOPE_INVALID");
  const left = Math.floor(
    Math.min(
      state.deadline - now,
      state.monoDeadline - mono,
      current ? current.deadlineAtMs - now : Infinity
    )
  );
  requireThat(left > 0, "R3_TUF_SCOPE_EXPIRED");
  return left;
}

// Even outside the startup/connected scope, acquisition waits for callback AND
// close before inspecting files or deleting its private directory.
function acquire(env, timeout, state) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    let done = false,
      closed = false,
      result,
      timer,
      child;
    const finish = () => {
      if (!done || !closed) return;
      clearTimeout(timer);
      if (result.error) {
        const raw = Buffer.from(result.stderr ?? "").toString("utf8");
        const httpMatches = [
          ...raw.matchAll(/(?:HTTP(?:\/\d(?:\.\d)?)?\s+|status(?: code)?[\s:=]+)([45]\d{2})\b/giu)
        ];
        const httpStatus = httpMatches.length ? Number(httpMatches.at(-1)[1]) : null;
        const reason = /gh auth login|not authenticated/u.test(raw)
          ? "AUTH_REQUIRED"
          : /certificate|x509:/u.test(raw)
            ? "TLS_CERTIFICATE"
            : /no such host/u.test(raw)
              ? "DNS"
              : /timeout|deadline exceeded/iu.test(raw)
                ? "TIMEOUT"
                : /connection refused|connection reset/iu.test(raw)
                  ? "CONNECTION"
                  : httpStatus !== null
                    ? "HTTP_ERROR"
                    : /expired (?:root|timestamp|snapshot|targets|metadata)|(?:root|timestamp|snapshot|targets|metadata)(?:\.json)?.{0,60}(?:is |has )?expired/iu.test(
                          raw
                        )
                      ? "METADATA_EXPIRED"
                      : /signature.{0,50}(?:invalid|failed|threshold)|(?:invalid|failed).{0,50}signature/iu.test(
                            raw
                          )
                        ? "SIGNATURE_INVALID"
                        : /version.{0,50}(?:mismatch|invalid|rollback)|(?:rollback|mismatch).{0,50}version/iu.test(
                              raw
                            )
                          ? "VERSION_INVALID"
                          : /invalid character|cannot unmarshal|invalid json|unexpected end of JSON/iu.test(
                                raw
                              )
                            ? "METADATA_INVALID"
                            : /failed to create TUF client/u.test(raw)
                              ? "TUF_CLIENT"
                              : /Failed to verify the TUF repository/u.test(raw)
                                ? "TUF_VERIFICATION"
                                : "UNKNOWN";
        const requests = [
          ...raw.matchAll(
            /https:\/\/(tuf-repo\.github\.com|tuf-repo-cdn\.sigstore\.dev)\/([A-Za-z0-9._/-]+)/gu
          )
        ];
        const last = requests.at(-1);
        const diagnostic = {
          schemaVersion: "r3-tuf-acquisition-failure.v1",
          operationRef: state.operationRef,
          monotonicElapsedMs: Math.min(
            WINDOW,
            Math.max(0, Math.floor(performance.now() - started))
          ),
          childCode: Number.isInteger(result.error.code) ? result.error.code : null,
          childSignal: ["SIGTERM", "SIGKILL"].includes(result.error.signal)
            ? result.error.signal
            : null,
          reason,
          httpStatus,
          repository: last ? (last[1] === HOSTS[0][0] ? "PUBLIC_GOOD" : "GITHUB") : null,
          target: last
            ? /root\.json$/u.test(last[2])
              ? "ROOT"
              : /timestamp\.json$/u.test(last[2])
                ? "TIMESTAMP"
                : /snapshot\.json$/u.test(last[2])
                  ? "SNAPSHOT"
                  : /targets\.json$/u.test(last[2])
                    ? "TARGETS"
                    : "OTHER"
            : null
        };
        try {
          process.stderr.write(
            `${JSON.stringify({ brand: "R3_TUF_ACQUISITION_FAILURE", diagnostic })}\n`
          );
        } catch {
          /* Preserve the command error. */
        }
        reject(result.error);
      } else resolve(Buffer.from(result.stdout));
    };
    child = childProcess.execFile(
      GH,
      ["attestation", "trusted-root"],
      {
        env,
        shell: false,
        encoding: "buffer",
        timeout,
        maxBuffer: LIMIT,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        result = { error, stdout, stderr };
        done = true;
        finish();
      }
    );
    child.once("close", () => {
      closed = true;
      finish();
    });
    timer = setTimeout(() => {
      if (!closed) child.kill("SIGKILL");
    }, timeout + 1000);
  });
}

async function capture(state, file, options) {
  const item = await hold(file, options);
  state.held.push(item);
  return item.bytes;
}

async function material(state, output) {
  requireThat(
    output.length > 0 && output.length <= LIMIT && output.at(-1) === 10,
    "R3_TUF_ROOT_INVALID"
  );
  const lines = new TextDecoder("utf-8", { fatal: true }).decode(output).trimEnd().split("\n");
  requireThat(lines.length === 2, "R3_TUF_ROOT_INVALID");
  const printed = lines.map((line) => JSON.parse(line));
  let expiry = Infinity;
  for (const [i, [host, issuer]] of HOSTS.entries()) {
    const base = path.join(state.dir, "cache/gh/.sigstore/root", host);
    let targets;
    for (const role of ["root", "timestamp", "snapshot", "targets"]) {
      const metadata = json(await capture(state, path.join(base, `${role}.json`)));
      const expires = Date.parse(metadata.signed?.expires);
      requireThat(
        metadata.signed?._type === role &&
          Number.isSafeInteger(metadata.signed.version) &&
          metadata.signed.version > 0 &&
          Number.isFinite(expires) &&
          metadata.signatures?.length > 0,
        "R3_TUF_ROOT_INVALID"
      );
      expiry = Math.min(expiry, expires);
      if (role === "targets") targets = metadata.signed.targets;
    }
    const bytes = await capture(state, path.join(base, "targets/trusted_root.json"));
    const target = targets?.["trusted_root.json"],
      root = json(bytes);
    requireThat(
      target?.length === bytes.length &&
        target.hashes?.sha256 === hash(bytes) &&
        JSON.stringify(root) === JSON.stringify(printed[i]),
      "R3_TUF_ROOT_INVALID"
    );
    requireThat(
      root.mediaType === "application/vnd.dev.sigstore.trustedroot+json;version=0.1" &&
        Array.isArray(root.certificateAuthorities) &&
        root.certificateAuthorities.length > 0,
      "R3_TUF_ROOT_INVALID"
    );
    // gh 2.101.0 maps the lowest CA issuer to its existing GitHub or Public
    // Good policy. Refuse the generic custom-policy fallback entirely.
    for (const ca of root.certificateAuthorities) {
      const certificates = ca.certChain?.certificates;
      requireThat(Array.isArray(certificates) && certificates.length > 0, "R3_TUF_ROOT_INVALID");
      const certificate = new X509Certificate(Buffer.from(certificates[0].rawBytes, "base64"));
      requireThat(certificate.toLegacyObject().issuer.O === issuer, "R3_TUF_ISSUER_INVALID");
    }
  }
  const now = Date.now(),
    mono = performance.now();
  remaining(state);
  state.deadline = Math.min(state.deadline, expiry, now + WINDOW);
  state.monoDeadline = Math.min(state.monoDeadline, mono + state.deadline - now);
  remaining(state);
  state.materialPath = path.join(state.dir, "trusted-roots.jsonl");
  await fs.writeFile(state.materialPath, output, { flag: "wx", mode: 0o600 });
  await capture(state, state.materialPath);
}

async function removeOwned(state) {
  if (!state.dir) return;
  requireThat(same(state.dirIdentity, await fs.lstat(state.dir, { bigint: true }), false));
  const files = [],
    directories = [];
  let bytes = 0;
  const scan = async (dir) => {
    const stat = await fs.lstat(dir, { bigint: true });
    requireThat(stat.isDirectory() && stat.uid === 0n && (stat.mode & 0o022n) === 0n);
    directories.push({ file: dir, stat });
    for (const name of await fs.readdir(dir)) {
      requireThat(files.length + directories.length < 128);
      const file = path.join(dir, name),
        s = await fs.lstat(file, { bigint: true });
      if (s.isDirectory()) await scan(file);
      else {
        requireThat(s.isFile() && s.uid === 0n && s.nlink === 1n && s.size <= BigInt(LIMIT));
        bytes += Number(s.size);
        requireThat(bytes <= 8388608);
        files.push({ file, stat: s });
      }
    }
  };
  await scan(state.dir);
  for (const item of files) {
    requireThat(same(item.stat, await fs.lstat(item.file, { bigint: true })));
    await fs.unlink(item.file);
  }
  for (const item of directories.reverse()) {
    requireThat(same(item.stat, await fs.lstat(item.file, { bigint: true }), false));
    await fs.rmdir(item.file);
  }
}

export async function withR3TufMaterialScope(binding, consume) {
  requireThat(
    process.platform === "linux" &&
      process.getuid() === 0 &&
      !storage.getStore() &&
      binding &&
      Object.getPrototypeOf(binding) === Object.prototype &&
      Reflect.ownKeys(binding).length === 2 &&
      ["operationRef", "deadlineAtMs"].every((key) =>
        Object.hasOwn(Object.getOwnPropertyDescriptor(binding, key) ?? {}, "value")
      ) &&
      typeof binding.operationRef === "string" &&
      UUID.test(binding.operationRef) &&
      Number.isSafeInteger(binding.deadlineAtMs) &&
      typeof consume === "function",
    "R3_TUF_SCOPE_INVALID"
  );
  const now = Date.now(),
    mono = performance.now();
  requireThat(
    binding.deadlineAtMs > now && binding.deadlineAtMs <= now + WINDOW,
    "R3_TUF_SCOPE_EXPIRED"
  );
  const state = {
    operationRef: binding.operationRef,
    deadline: binding.deadlineAtMs,
    startedMono: mono,
    monoDeadline: mono + binding.deadlineAtMs - now,
    lastWall: now,
    held: [],
    pending: new Set(),
    busy: false,
    closed: false,
    dir: null
  };
  let result, primary, cleanupFailure;
  try {
    let binary;
    try {
      binary = await capture(state, GH, { max: 134217728, binary: true });
    } catch {
      fail("R3_TUF_BINARY_INVALID");
    }
    requireThat(hash(binary) === GH_SHA, "R3_TUF_BINARY_INVALID");
    await parents("/run/owner");
    const filesystem = await fs.statfs("/run");
    requireThat(
      [0x01021994, 0xef53, 0x58465342, 0x9123683e].includes(filesystem.type),
      "R3_TUF_SCOPE_INVALID"
    );
    state.dir = await fs.mkdtemp("/run/stage1-tuf-");
    await fs.chmod(state.dir, 0o700);
    state.dirIdentity = await fs.lstat(state.dir, { bigint: true });
    await fs.mkdir(path.join(state.dir, "config"), { mode: 0o700 });
    await fs.mkdir(path.join(state.dir, "cache"), { mode: 0o700 });
    const output = await acquire(
      {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        LC_ALL: "C",
        GH_HOST: "github.com",
        GH_PROMPT_DISABLED: "1",
        GH_DEBUG: "1",
        GH_CONFIG_DIR: path.join(state.dir, "config"),
        XDG_CACHE_HOME: path.join(state.dir, "cache")
      },
      Math.min(120000, remaining(state)),
      state
    );
    await material(state, output);
    for (const item of state.held) await item.recheck();
    result = await storage.run(state, () => consume());
  } catch (error) {
    primary = error;
  } finally {
    state.closed = true;
    const pending = await Promise.allSettled([...state.pending]);
    primary ??= pending.find((item) => item.status === "rejected")?.reason;
    let cleanup;
    for (const item of state.held.reverse()) {
      try {
        await item.close();
      } catch (error) {
        cleanup ??= error;
      }
    }
    try {
      await removeOwned(state);
    } catch (error) {
      cleanup ??= error;
    }
    if (cleanup) {
      cleanupFailure = Object.assign(new Error("R3_TUF_CLEANUP_FAILED"), {
        code: "R3_TUF_CLEANUP_FAILED"
      });
      primary ??= cleanupFailure;
    }
  }
  if (primary) {
    const tracker = r3FailureTracker("H1_CALLER");
    if (primary === cleanupFailure) tracker.enter("CLEANUP");
    throw tracker.decorate(primary, primary, cleanupFailure);
  }
  return result;
}

export async function withR3TufAttestation(args, execute) {
  requireThat(
    Array.isArray(args) &&
      args[0] === "attestation" &&
      args[1] === "verify" &&
      args.every(
        (arg) =>
          typeof arg === "string" &&
          !/^--(?:custom-trusted-root|tuf-|custom-tuf|hostname|no-public-good|cert-identity)/u.test(
            arg
          )
      ) &&
      typeof execute === "function",
    "R3_TUF_ARGUMENT_INVALID"
  );
  const state = storage.getStore();
  if (!state) return execute(args, "gh", 120000);
  try {
    remaining(state);
    requireThat(!state.busy, "R3_TUF_SCOPE_BUSY");
  } catch (error) {
    state.closed = true;
    throw error;
  }
  state.busy = true;
  const pending = (async () => {
    try {
      for (const item of state.held) await item.recheck();
      const output = await execute(
        [...args, "--custom-trusted-root", state.materialPath],
        GH,
        Math.min(120000, remaining(state))
      );
      remaining(state);
      for (const item of state.held) await item.recheck();
      return output;
    } catch (error) {
      state.closed = true;
      throw error;
    } finally {
      state.busy = false;
    }
  })();
  state.pending.add(pending);
  try {
    return await pending;
  } finally {
    state.pending.delete(pending);
  }
}
