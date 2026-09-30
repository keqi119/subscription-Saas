// Root-held H1 lease for the separate, file-only evidence SSH identity.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { createPublicKey } from "node:crypto";
import { readFixedR3JobAdmission } from "./manual-stage1-trust.mjs";
import { sha256Bytes } from "../../packages/release-foundation/src/digest.mjs";
import { encodeManualJson } from "../../packages/release-foundation/src/manual-stage1-contracts.mjs";
import {
  r3EvidenceScope,
  encodeR3CleanupRequest,
  encodeR3CleanupImported,
  encodeR3Closed,
  decodeR3ClosedReceived
} from "./r3-evidence-delivery.mjs";

const CODE = "R3_H1_EVIDENCE_DELIVERY_UNAVAILABLE";
const ROOT = "/run/stage1-r3-evidence";
const KEY = "/etc/ssh/stage1-r3-evidence/authorized_keys";
const LIMIT = 1048576;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const need = (condition) => {
  if (!condition) fail();
};
const same = (a, b) =>
  ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs"].every(
    (field) => a[field] === b[field]
  );
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
function exact(value, fields) {
  need(value && typeof value === "object" && !Array.isArray(value));
  need(
    Reflect.ownKeys(value).length === fields.length &&
      fields.every((field) => Object.hasOwn(value, field))
  );
}
async function command(file, args, expected = 0) {
  const result = await new Promise((resolve) =>
    childProcess.execFile(
      file,
      args,
      {
        shell: false,
        encoding: "buffer",
        timeout: 10000,
        maxBuffer: 65536,
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" }
      },
      (error, stdout, stderr) =>
        resolve({ error, stdout: Buffer.from(stdout ?? ""), stderr: Buffer.from(stderr ?? "") })
    )
  );
  const code = result.error?.code ?? 0;
  need(
    (Array.isArray(expected) ? expected.includes(code) : code === expected) &&
      result.stderr.length <= 4096
  );
  return result.stdout.toString("utf8");
}
async function account() {
  const uid = Number((await command("/usr/bin/id", ["-u", "stage1-r3-evidence"])).trim());
  const gid = Number((await command("/usr/bin/id", ["-g", "stage1-r3-evidence"])).trim());
  const groups = (await command("/usr/bin/id", ["-G", "stage1-r3-evidence"])).trim();
  const passwd = (await command("/usr/bin/getent", ["passwd", "stage1-r3-evidence"]))
    .trim()
    .split(":");
  const shadow = (await command("/usr/bin/getent", ["shadow", "stage1-r3-evidence"]))
    .trim()
    .split(":");
  need(Number.isSafeInteger(uid) && uid > 0 && uid !== 994 && Number.isSafeInteger(gid) && gid > 0);
  need(
    groups === String(gid) &&
      passwd.length === 7 &&
      Number(passwd[2]) === uid &&
      Number(passwd[3]) === gid &&
      passwd[6] === "/sbin/nologin"
  );
  need(shadow.length >= 2 && shadow[0] === "stage1-r3-evidence" && /^[!*]/u.test(shadow[1]));
  return { uid, gid };
}
async function effectiveSsh() {
  const output = await command("/usr/sbin/sshd", [
    "-T",
    "-C",
    "user=stage1-r3-evidence,host=139.196.227.195,addr=127.0.0.1"
  ]);
  const config = Object.fromEntries(
    output
      .trim()
      .split("\n")
      .map((line) => {
        const index = line.indexOf(" ");
        return [line.slice(0, index), line.slice(index + 1)];
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
    chrootdirectory: ROOT,
    forcecommand:
      "internal-sftp -d / -u 0077 -p open,close,read,write,lstat,fstat,stat,realpath,rename,posix-rename",
    maxsessions: "1",
    allowtcpforwarding: "no",
    allowstreamlocalforwarding: "no",
    permitlisten: "none",
    permitopen: "none",
    allowagentforwarding: "no",
    x11forwarding: "no",
    permittty: "no",
    permittunnel: "no",
    permituserrc: "no"
  };
  need(Object.entries(expected).every(([field, value]) => config[field] === value));
}
async function pristine(accountUid) {
  for (const directory of ["/run", ROOT, "/etc/ssh", path.dirname(KEY)]) {
    const stat = await fs.lstat(directory, { bigint: true });
    need(
      stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0n && (stat.mode & 0o022n) === 0n
    );
  }
  const root = await fs.lstat(ROOT, { bigint: true });
  need(root.gid === 0n && (root.mode & 0o777n) === 0o755n);
  const key = await fs.lstat(KEY, { bigint: true });
  need(
    key.isFile() &&
      key.uid === 0n &&
      key.gid === 0n &&
      key.nlink === 1n &&
      (key.mode & 0o777n) === 0o644n &&
      key.size === 0n
  );
  need(((await fs.lstat(path.dirname(KEY), { bigint: true })).mode & 0o777n) === 0o755n);
  need((await fs.readdir(ROOT)).length === 0);
  need((await fs.readFile("/proc/swaps", "utf8")).trim().split("\n").length === 1);
  const coreLimit = (await fs.readFile("/proc/self/limits", "utf8"))
    .split("\n")
    .find((line) => line.startsWith("Max core file size"));
  need(coreLimit && /^Max core file size\s+0\s+0\s+bytes\s*$/u.test(coreLimit));
  const mounts = await fs.readFile("/proc/self/mountinfo", "utf8");
  need(!mounts.split("\n").some((line) => line.split(" ")[4] === ROOT));
  need((await command("/usr/bin/pgrep", ["-u", String(accountUid)], 1)).trim() === "");
  return key;
}
async function mounted(uid, gid) {
  const stat = await fs.lstat(ROOT, { bigint: true });
  need(stat.isDirectory() && stat.uid === 0n && stat.gid === 0n && (stat.mode & 0o777n) === 0o755n);
  const mounts = (await fs.readFile("/proc/self/mountinfo", "utf8")).split("\n");
  const line = mounts.find((entry) => entry.split(" ")[4] === ROOT);
  need(
    line &&
      line.includes(" - tmpfs ") &&
      ["nodev", "nosuid", "noexec"].every((flag) => line.includes(flag))
  );
  const statfs = await fs.statfs(ROOT, { bigint: true });
  need(
    statfs.type === 0x01021994n &&
      statfs.bsize * statfs.blocks === 8n * 1048576n &&
      statfs.files === 128n
  );
  for (const [name, owner, group, mode] of [
    ["in", uid, gid, 0o700],
    ["out", 0, gid, 0o750]
  ]) {
    const child = await fs.lstat(path.join(ROOT, name), { bigint: true });
    need(
      child.isDirectory() &&
        !child.isSymbolicLink() &&
        child.uid === BigInt(owner) &&
        child.gid === BigInt(group) &&
        (child.mode & 0o777n) === BigInt(mode)
    );
  }
}
function sshKey(pem) {
  const publicKey = createPublicKey(pem);
  need(
    publicKey.asymmetricKeyType === "ed25519" &&
      publicKey.export({ type: "spki", format: "pem" }) === pem
  );
  const der = publicKey.export({ type: "spki", format: "der" });
  need(der.length === 44);
  const name = Buffer.from("ssh-ed25519");
  const length = (bytes) => {
    const result = Buffer.alloc(4);
    result.writeUInt32BE(bytes.length);
    return result;
  };
  const raw = der.subarray(-32);
  return `ssh-ed25519 ${Buffer.concat([length(name), name, length(raw), raw]).toString("base64")}`;
}
async function stable(file, uid, gid, mode, limit = LIMIT) {
  const before = await fs.lstat(file, { bigint: true });
  need(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1n &&
      before.uid === BigInt(uid) &&
      before.gid === BigInt(gid) &&
      (before.mode & 0o777n) === BigInt(mode) &&
      before.size > 0n &&
      before.size <= BigInt(limit)
  );
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    need(same(before, await handle.stat({ bigint: true })));
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      need(result.bytesRead > 0);
      offset += result.bytesRead;
    }
    need(
      same(before, await handle.stat({ bigint: true })) &&
        same(before, await fs.lstat(file, { bigint: true }))
    );
    return bytes;
  } finally {
    await handle.close();
  }
}
export async function readR3StableInboxFile({ file, uid }) {
  need(typeof file === "string" && path.isAbsolute(file) && Number.isSafeInteger(Number(uid)));
  const stat = await fs.lstat(file, { bigint: true });
  return stable(file, uid, stat.gid, 0o600);
}
async function publish(name, bytes, gid) {
  const file = path.join(ROOT, "out", name);
  const partial = `${file}.part`;
  const handle = await fs.open(
    partial,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o640
  );
  try {
    await handle.chown(0, gid);
    await handle.chmod(0o640);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const actual = await stable(partial, 0, gid, 0o640);
  need(actual.equals(bytes));
  // Publish complete bytes atomically without replacing an earlier notice.
  // Only root writes this directory; SFTP clients cannot create links here.
  await fs.link(partial, file);
  await fs.unlink(partial);
  need((await stable(file, 0, gid, 0o640)).equals(bytes));
  const directory = await fs.open(path.dirname(file), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function openR3H1EvidenceDelivery(input) {
  exact(input, ["repoRoot", "operationRef"]);
  need(
    process.platform === "linux" &&
      process.getuid?.() === 0 &&
      typeof input.repoRoot === "string" &&
      path.isAbsolute(input.repoRoot) &&
      path.normalize(input.repoRoot) === input.repoRoot &&
      UUID.test(input.operationRef)
  );
  let admission,
    keyHandle,
    keyIdentity,
    installed = null,
    ownMount = false,
    closed = false;
  let request = null,
    cleanupDigest = null,
    imported = false,
    publishedClosed = false,
    closedBytes = null,
    creationReceived = false;
  const { repoRoot, operationRef } = input;
  try {
    admission = await readFixedR3JobAdmission({ repoRoot, operationRef });
    const { uid, gid } = await account();
    await effectiveSsh();
    await pristine(uid);
    await admission.recheck();
    const scope = r3EvidenceScope({
      creationSpecBytes: encodeManualJson(admission.spec),
      jobAdmissionBytes: admission.rawInputs.admission
    });
    // The held reader is the source of exact spec bytes; the admission already
    // authenticated their digest. Retain the signed job and native context.
    need(
      scope.creationSpecDigest === admission.creationSpecDigest &&
        scope.jobAdmissionDigest === admission.jobAdmissionDigest
    );
    await command("/usr/bin/mount", [
      "-t",
      "tmpfs",
      "-o",
      "size=8m,nr_inodes=128,nodev,nosuid,noexec,mode=0755,uid=0,gid=0",
      "tmpfs",
      ROOT
    ]);
    ownMount = true;
    await fs.mkdir(path.join(ROOT, "in"), { mode: 0o700 });
    await fs.chown(path.join(ROOT, "in"), uid, gid);
    await fs.mkdir(path.join(ROOT, "out"), { mode: 0o750 });
    await fs.chown(path.join(ROOT, "out"), 0, gid);
    await fs.chmod(path.join(ROOT, "out"), 0o750);
    await mounted(uid, gid);
    keyHandle = await fs.open(KEY, constants.O_RDWR | constants.O_NOFOLLOW);
    const before = await keyHandle.stat({ bigint: true });
    need(
      before.uid === 0n &&
        before.gid === 0n &&
        before.size === 0n &&
        before.nlink === 1n &&
        (before.mode & 0o777n) === 0o644n
    );
    const visibleBefore = await fs.lstat(KEY, { bigint: true });
    need(before.dev === visibleBefore.dev && before.ino === visibleBefore.ino);
    const line = Buffer.from(
      `restrict ${sshKey(admission.admission.host.forwardingPublicKeyPem)} r3-${operationRef}\n`
    );
    need((await keyHandle.write(line, 0, line.length, 0)).bytesWritten === line.length);
    await keyHandle.sync();
    installed = line;
    keyIdentity = await keyHandle.stat({ bigint: true });
    const recheck = async () => {
      need(!closed);
      await admission.recheck();
      await effectiveSsh();
      await mounted(uid, gid);
      const held = await keyHandle.stat({ bigint: true });
      const visible = await fs.lstat(KEY, { bigint: true });
      need(
        held.dev === keyIdentity.dev &&
          held.ino === keyIdentity.ino &&
          visible.dev === keyIdentity.dev &&
          visible.ino === keyIdentity.ino
      );
      const current = await stable(KEY, 0, 0, 0o644, 65536);
      need(current.equals(installed));
      await admission.recheck();
    };
    await recheck();
    const receive = async (name) => {
      for (let attempt = 0; attempt < 60; attempt++) {
        await recheck();
        try {
          return await stable(path.join(ROOT, "in", name), uid, gid, 0o600);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        await delay(2000);
      }
      fail();
    };
    return Object.freeze({
      async receiveCreation() {
        need(!creationReceived);
        const bytes = await receive("creation.bundle.json");
        creationReceived = true;
        return bytes;
      },
      async publishCleanupRequest({ executionBytes, acknowledgementBytes }) {
        need(creationReceived && !request);
        await recheck();
        const bytes = encodeR3CleanupRequest({ scope, executionBytes, acknowledgementBytes });
        await publish("cleanup-request.json", bytes, gid);
        request = { ...scope, ...JSON.parse(bytes) };
        return { digest: sha256Bytes(bytes), bytes: Buffer.from(bytes) };
      },
      async receiveCleanup() {
        need(request && !cleanupDigest);
        const bytes = await receive("cleanup.bundle.json");
        cleanupDigest = sha256Bytes(bytes);
        return bytes;
      },
      async publishCleanupImported({ bundleDigest }) {
        need(request && cleanupDigest === bundleDigest && !imported);
        await recheck();
        const bytes = encodeR3CleanupImported({ request, bundleDigest });
        await publish("cleanup-imported.json", bytes, gid);
        imported = true;
        return { digest: sha256Bytes(bytes), bytes: Buffer.from(bytes) };
      },
      async publishClosed({ sessionBytes, sourceGateEvidenceBytes, snapshotMetadataBytes }) {
        need(request && imported && !publishedClosed);
        // Freeze the caller's bytes before the first asynchronous boundary.
        const bytes = encodeR3Closed({
          request,
          sessionBytes,
          sourceGateEvidenceBytes,
          snapshotMetadataBytes
        });
        await recheck();
        await publish("closed.json", bytes, gid);
        publishedClosed = true;
        closedBytes = Buffer.from(bytes);
        return { digest: sha256Bytes(bytes), bytes: Buffer.from(bytes) };
      },
      recheck,
      async close() {
        if (closed) return;
        try {
          let delivered = false;
          if (publishedClosed) {
            const receipt = await receive("closed-received.json");
            decodeR3ClosedReceived({ bytes: receipt, request, closedBytes });
            delivered = true;
          }
          if (installed && keyHandle) {
            const held = await keyHandle.stat({ bigint: true });
            const visible = await fs.lstat(KEY, { bigint: true });
            need(
              held.dev === keyIdentity.dev &&
                held.ino === keyIdentity.ino &&
                visible.dev === keyIdentity.dev &&
                visible.ino === keyIdentity.ino &&
                held.size === BigInt(installed.length)
            );
            const contents = Buffer.alloc(installed.length);
            need(
              (await keyHandle.read(contents, 0, contents.length, 0)).bytesRead ===
                contents.length && contents.equals(installed)
            );
            await keyHandle.truncate(0);
            await keyHandle.sync();
          }
          await keyHandle?.close();
          keyHandle = null;
          if (delivered) {
            let processesGone = false;
            for (let attempt = 0; attempt < 60; attempt++) {
              if ((await command("/usr/bin/pgrep", ["-u", String(uid)], [0, 1])).trim() === "") {
                processesGone = true;
                break;
              }
              await delay(2000);
            }
            need(processesGone);
            // A successful unmount drops the entire operation exchange at once.
            // On a failed unmount, all original files remain for diagnosis.
            await command("/usr/bin/umount", [ROOT]);
            ownMount = false;
          }
        } finally {
          closed = true;
          if (keyHandle) {
            if (installed) await keyHandle.truncate(0).catch(() => {});
            await keyHandle.close().catch(() => {});
          }
          await admission.close();
        }
      }
    });
  } catch (error) {
    if (keyHandle) {
      if (installed) await keyHandle.truncate(0).catch(() => {});
      await keyHandle.close().catch(() => {});
    }
    await admission?.close().catch(() => {});
    // A failed exchange remains mounted for diagnosis and blocks reuse.
    if (ownMount) void ownMount;
    throw error;
  }
}
