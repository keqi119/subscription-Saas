// A single live H1 operation may install its admitted job's forwarding key.
// Removing this key does not terminate an already established SSH connection.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import childProcess from "node:child_process";
import path from "node:path";
import { createPublicKey } from "node:crypto";
import { encodeManualJson, sha256Canonical } from "../../packages/release-foundation/src/index.mjs";
import { loadFixedManualProfile, readFixedR3JobAdmission } from "./manual-stage1-trust.mjs";

const CODE = "R3_H1_FORWARD_LEASE_UNAVAILABLE";
const KEY = "/etc/ssh/stage1-r3-forward/authorized_keys";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const need = (value) => {
  if (!value) fail();
};
function exact(value, fields) {
  need(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
      Reflect.ownKeys(value).length === fields.length &&
      fields.every((field) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, field);
        return descriptor?.enumerable && Object.hasOwn(descriptor, "value");
      })
  );
}
function same(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink
  );
}
async function command(binary, args, expected = 0) {
  const outcome = await new Promise((resolve) =>
    childProcess.execFile(
      binary,
      args,
      {
        shell: false,
        encoding: "buffer",
        timeout: 10000,
        maxBuffer: 65536,
        windowsHide: true,
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" }
      },
      (error, stdout, stderr) =>
        resolve({ error, stdout: Buffer.from(stdout ?? ""), stderr: Buffer.from(stderr ?? "") })
    )
  );
  need((outcome.error?.code ?? 0) === expected && outcome.stderr.length <= 4096);
  return outcome.stdout.toString("utf8");
}
async function privateDirectory(directory) {
  let current = path.parse(directory).root;
  for (const segment of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current, { bigint: true });
    need(
      stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        stat.uid === 0n &&
        (stat.mode & 0o022n) === 0n &&
        (await fs.realpath(current)) === current
    );
  }
}
async function heldFile(file, mode) {
  let before = await fs.lstat(file, { bigint: true });
  need(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.uid === 0n &&
      before.nlink === 1n &&
      (before.mode & 0o777n) === BigInt(mode) &&
      before.size <= 65536n
  );
  const handle = await fs.open(
    file,
    (mode === 0o644 ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW
  );
  try {
    const actual = await handle.stat({ bigint: true });
    need(
      same(before, actual) &&
        before.size === actual.size &&
        before.mtimeNs === actual.mtimeNs &&
        before.ctimeNs === actual.ctimeNs
    );
    const read = async () => {
      const stat = await handle.stat({ bigint: true });
      const visible = await fs.lstat(file, { bigint: true });
      need(
        same(before, stat) &&
          same(before, visible) &&
          stat.size <= 65536n &&
          stat.size === visible.size &&
          stat.mtimeNs === visible.mtimeNs &&
          stat.ctimeNs === visible.ctimeNs
      );
      const bytes = Buffer.alloc(Number(stat.size));
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, offset);
        need(result.bytesRead > 0);
        offset += result.bytesRead;
      }
      const afterHeld = await handle.stat({ bigint: true });
      const afterVisible = await fs.lstat(file, { bigint: true });
      need(
        same(stat, afterHeld) &&
          same(stat, afterVisible) &&
          stat.size === afterHeld.size &&
          stat.size === afterVisible.size &&
          stat.mtimeNs === afterHeld.mtimeNs &&
          stat.mtimeNs === afterVisible.mtimeNs &&
          stat.ctimeNs === afterHeld.ctimeNs &&
          stat.ctimeNs === afterVisible.ctimeNs
      );
      return bytes;
    };
    const refreshOwnWrite = async () => {
      const held = await handle.stat({ bigint: true });
      const visible = await fs.lstat(file, { bigint: true });
      need(
        same(before, held) &&
          same(before, visible) &&
          held.size === visible.size &&
          held.mtimeNs === visible.mtimeNs &&
          held.ctimeNs === visible.ctimeNs
      );
      before = held;
    };
    return { file, handle, read, refreshOwnWrite, close: () => handle.close() };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
function sshKey(pem) {
  const key = createPublicKey(pem);
  need(key.asymmetricKeyType === "ed25519" && key.export({ type: "spki", format: "pem" }) === pem);
  const der = key.export({ type: "spki", format: "der" });
  const raw = der.subarray(-32);
  need(der.length === 44 && raw.length === 32);
  const type = Buffer.from("ssh-ed25519");
  const size = (n) => {
    const value = Buffer.alloc(4);
    value.writeUInt32BE(n);
    return value;
  };
  return `ssh-ed25519 ${Buffer.concat([size(type.length), type, size(raw.length), raw]).toString("base64")}`;
}
async function transport(preinstall) {
  const settings = Object.fromEntries(
    (
      await command("/usr/sbin/sshd", [
        "-T",
        "-C",
        "user=stage1-r3-forward,host=139.196.227.195,addr=127.0.0.1"
      ])
    )
      .trim()
      .split("\n")
      .map((line) => {
        const at = line.indexOf(" ");
        return [line.slice(0, at), line.slice(at + 1)];
      })
  );
  const expected = {
    authenticationmethods: "publickey",
    pubkeyauthentication: "yes",
    passwordauthentication: "no",
    challengeresponseauthentication: "no",
    authorizedkeysfile: KEY,
    authorizedkeyscommand: "none",
    trustedusercakeys: "none",
    authorizedprincipalsfile: "none",
    authorizedprincipalscommand: "none",
    allowtcpforwarding: "remote",
    permitlisten: "127.0.0.1:55440 127.0.0.1:55441",
    permitopen: "none",
    allowstreamlocalforwarding: "no",
    allowagentforwarding: "no",
    x11forwarding: "no",
    permittty: "no",
    permituserrc: "no",
    permittunnel: "no",
    gatewayports: "no",
    maxsessions: "0",
    forcecommand: "/sbin/nologin"
  };
  for (const [field, value] of Object.entries(expected)) need(settings[field] === value);
  const outputRule = [
    "-p",
    "tcp",
    "-d",
    "127.0.0.1/32",
    "-m",
    "multiport",
    "--dports",
    "55440,55441",
    "-m",
    "owner",
    "!",
    "--uid-owner",
    "0",
    "-m",
    "comment",
    "--comment",
    "stage1-r3-loopback-root-only",
    "-j",
    "REJECT",
    "--reject-with",
    "tcp-reset"
  ];
  const inputRule = [
    "!",
    "-i",
    "lo",
    "-p",
    "tcp",
    "-d",
    "127.0.0.1/32",
    "-m",
    "multiport",
    "--dports",
    "55440,55441",
    "-m",
    "comment",
    "--comment",
    "stage1-r3-reject-nonloopback",
    "-j",
    "REJECT",
    "--reject-with",
    "tcp-reset"
  ];
  for (const [chain, rule, expectedFirst] of [
    [
      "OUTPUT",
      outputRule,
      "-A OUTPUT -d 127.0.0.1/32 -p tcp -m multiport --dports 55440,55441 -m owner ! --uid-owner 0 -m comment --comment stage1-r3-loopback-root-only -j REJECT --reject-with tcp-reset"
    ],
    [
      "INPUT",
      inputRule,
      "-A INPUT -d 127.0.0.1/32 ! -i lo -p tcp -m multiport --dports 55440,55441 -m comment --comment stage1-r3-reject-nonloopback -j REJECT --reject-with tcp-reset"
    ]
  ]) {
    await command("/usr/sbin/iptables", ["-w", "5", "-C", chain, ...rule]);
    const lines = (await command("/usr/sbin/iptables", ["-w", "5", "-S", chain])).split("\n");
    const first = lines.find((line) => line.startsWith(`-A ${chain} `));
    need(first === expectedFirst);
  }
  if (preinstall) {
    need(
      (await command("/usr/bin/ss", ["-H", "-ltn", "sport = :55440 or sport = :55441"])).trim() ===
        ""
    );
    need((await command("/usr/bin/pgrep", ["-u", "994"], 1)).trim() === "");
  }
}

export async function openR3H1ForwardLease(input) {
  let admission,
    key,
    locks = [],
    installed = null,
    closed = false,
    closing;
  const release = async () => {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      try {
        if (installed && key) {
          const current = await key.read();
          need(current.equals(installed));
          await key.handle.truncate(0);
          await key.handle.sync();
          await key.refreshOwnWrite();
          need((await key.read()).length === 0);
        }
      } finally {
        const outcomes = await Promise.allSettled([
          ...(key ? [key.close()] : []),
          ...locks.map((item) => item.close()),
          ...(admission ? [admission.close()] : [])
        ]);
        need(outcomes.every((outcome) => outcome.status === "fulfilled"));
      }
    })();
    return closing;
  };
  try {
    exact(input, ["repoRoot", "operationRef"]);
    need(
      process.platform === "linux" &&
        process.getuid?.() === 0 &&
        typeof input.repoRoot === "string" &&
        path.isAbsolute(input.repoRoot) &&
        path.normalize(input.repoRoot) === input.repoRoot &&
        typeof input.operationRef === "string" &&
        UUID.test(input.operationRef)
    );
    admission = await readFixedR3JobAdmission(input);
    const profile = await loadFixedManualProfile({ repoRoot: input.repoRoot });
    need(sha256Canonical(profile) === admission.spec.profileDigest);
    const scope = Object.freeze({
      targetPolicyDigest: admission.spec.targetPolicyDigest,
      creationSpecDigest: admission.creationSpecDigest,
      jobAdmissionDigest: admission.jobAdmissionDigest,
      buildProofDigest: admission.build.buildProofDigest,
      sourceSha: admission.sourceSha,
      phase: admission.spec.phase,
      chain: admission.spec.chain
    });
    const lockDir = path.join(profile.storage.journalRoot, "locks");
    await privateDirectory(lockDir);
    for (const slot of ["tcp://127.0.0.1:55440", "127.0.0.1:55441"]) {
      const name = `${sha256Canonical({ slot, kind: "r3-forward-slot" }).slice(7)}.json`;
      locks.push(await heldFile(path.join(lockDir, name), 0o600));
    }
    const lockBytes = await locks[0].read();
    need(lockBytes.equals(await locks[1].read()));
    const lock = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(lockBytes));
    exact(lock, ["sessionId", "sessionNonce", "profileDigest", "scope", "pid"]);
    exact(lock.scope, Object.keys(scope));
    need(
      encodeManualJson(lock).equals(lockBytes) &&
        lock.pid === process.pid &&
        lock.profileDigest === sha256Canonical(profile) &&
        Object.keys(scope).every((field) => lock.scope[field] === scope[field])
    );
    await admission.recheck();
    await transport(true);
    await privateDirectory(path.dirname(KEY));
    key = await heldFile(KEY, 0o644);
    need((await key.read()).length === 0);
    await admission.recheck();
    for (const item of locks) need((await item.read()).equals(lockBytes));
    const line = Buffer.from(
      `restrict,port-forwarding,permitlisten="127.0.0.1:55440",permitlisten="127.0.0.1:55441" ${sshKey(admission.admission.host.forwardingPublicKeyPem)} r3-${input.operationRef}\n`
    );
    need((await key.handle.write(line, 0, line.length, 0)).bytesWritten === line.length);
    await key.handle.sync();
    installed = line;
    await key.refreshOwnWrite();
    need((await key.read()).equals(line));
    const recheck = async () => {
      try {
        need(!closed);
        await admission.recheck();
        for (const item of locks) need((await item.read()).equals(lockBytes));
        need((await key.read()).equals(line));
        await transport(false);
        await admission.recheck();
        for (const item of locks) need((await item.read()).equals(lockBytes));
        need((await key.read()).equals(line));
      } catch {
        fail();
      }
    };
    await recheck();
    return Object.freeze({
      admission: admission.admission,
      profile,
      scope,
      recheck,
      close: release
    });
  } catch {
    await release().catch(() => {});
    fail();
  }
}
