// A fixed OpenSSH SFTP client for the separate evidence-only identity.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { readR3HostedOperationKey } from "./r3-operation-inputs.mjs";
import { sha256Bytes } from "../../packages/release-foundation/src/digest.mjs";
import {
  r3EvidenceScope,
  decodeR3CleanupRequest,
  decodeR3CleanupImported,
  decodeR3Closed,
  encodeR3ClosedReceived
} from "./r3-evidence-delivery.mjs";

const CODE = "R3_HOSTED_EVIDENCE_DELIVERY_UNAVAILABLE";
const LIMIT = 1048576;
const HOST = "139.196.227.195";
const KNOWN_HOSTS = new URL("../../release/contracts/stage1-r3-h1-known-hosts", import.meta.url);
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const need = (condition) => {
  if (!condition) fail();
};
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
function exact(value, keys) {
  need(value && typeof value === "object" && !Array.isArray(value));
  need(
    Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}
async function localFile(file, bytes) {
  need(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= LIMIT);
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
async function stableLocal(file) {
  const before = await fs.lstat(file, { bigint: true });
  need(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.uid === 0n &&
      before.nlink === 1n &&
      (before.mode & 0o777n) === 0o600n &&
      before.size > 0n &&
      before.size <= BigInt(LIMIT)
  );
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const first = await handle.stat({ bigint: true });
    need(
      first.dev === before.dev &&
        first.ino === before.ino &&
        first.size === before.size &&
        first.mtimeNs === before.mtimeNs &&
        first.ctimeNs === before.ctimeNs
    );
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      need(read.bytesRead > 0);
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true }),
      visible = await fs.lstat(file, { bigint: true });
    need(
      [after, visible].every(
        (value) =>
          value.dev === before.dev &&
          value.ino === before.ino &&
          value.size === before.size &&
          value.mtimeNs === before.mtimeNs &&
          value.ctimeNs === before.ctimeNs
      )
    );
    return bytes;
  } finally {
    await handle.close();
  }
}
async function knownHosts() {
  const stat = await fs.lstat(KNOWN_HOSTS, { bigint: true });
  need(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1n &&
      stat.size > 0n &&
      stat.size <= 4096n &&
      (stat.mode & 0o022n) === 0n
  );
  const handle = await fs.open(KNOWN_HOSTS, constants.O_RDONLY | constants.O_NOFOLLOW);
  let contents;
  try {
    const same = (value) =>
      ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs"].every(
        (field) => value[field] === stat[field]
      );
    need(same(await handle.stat({ bigint: true })));
    contents = await handle.readFile("utf8");
    need(
      same(await handle.stat({ bigint: true })) &&
        same(await fs.lstat(KNOWN_HOSTS, { bigint: true }))
    );
  } finally {
    await handle.close();
  }
  need(/^139\.196\.227\.195 ssh-ed25519 [A-Za-z0-9+/]+={0,2}\n$/u.test(contents));
  return {
    contents,
    identity: [
      stat.dev,
      stat.ino,
      stat.mode,
      stat.uid,
      stat.gid,
      stat.nlink,
      stat.size,
      stat.mtimeNs,
      stat.ctimeNs
    ].join(":")
  };
}
function startSftp(keyPath) {
  let child;
  const oldMask = process.umask(0o077);
  try {
    child = childProcess.spawn(
      "/usr/bin/sftp",
      [
        "-b",
        "-",
        "-F",
        "/dev/null",
        "-oBatchMode=yes",
        "-oStrictHostKeyChecking=yes",
        `-oUserKnownHostsFile=${KNOWN_HOSTS.pathname}`,
        "-oGlobalKnownHostsFile=/dev/null",
        "-oIdentitiesOnly=yes",
        "-oIdentityAgent=none",
        "-oHostKeyAlgorithms=ssh-ed25519",
        `-oIdentityFile=${keyPath}`,
        "-oPasswordAuthentication=no",
        "-oKbdInteractiveAuthentication=no",
        "-oPreferredAuthentications=publickey",
        "-oConnectTimeout=10",
        "-oNumberOfPasswordPrompts=0",
        "-oControlMaster=no",
        "-P",
        "22",
        `stage1-r3-evidence@${HOST}`
      ],
      {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }
      }
    );
  } finally {
    process.umask(oldMask);
  }
  let stdout = "",
    stderr = "",
    pending = null,
    exit = null,
    stopped = false;
  const exited = new Promise((resolve) => {
    child.once("error", (error) => {
      if (pending) pending.reject(error);
    });
    child.once("close", (code, signal) => {
      exit = { code, signal };
      if (pending) pending.reject(Object.assign(new Error(CODE), { code: CODE }));
      resolve(exit);
    });
  });
  const collect = (field) => (chunk) => {
    if (field === "stdout") stdout += Buffer.from(chunk).toString("utf8");
    else stderr += Buffer.from(chunk).toString("utf8");
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 16384) {
      child.kill("SIGKILL");
      if (pending) pending.reject(Object.assign(new Error(CODE), { code: CODE }));
      return;
    }
    if (pending && /(?:^|\n)Remote working directory: \/\r?\n/u.test(stdout)) {
      const current = pending;
      pending = null;
      clearTimeout(current.timer);
      // stdout and stderr use separate pipes; allow the latter to drain before
      // interpreting an ignored missing-file response.
      setTimeout(() => {
        const output = { stdout, stderr };
        stdout = "";
        stderr = "";
        current.resolve(output);
      }, 20);
    }
  };
  child.stdout.on("data", collect("stdout"));
  child.stderr.on("data", collect("stderr"));
  const step = (script, timeout = 30000) => {
    need(
      !stopped &&
        !exit &&
        !pending &&
        typeof script === "string" &&
        script.length <= 1024 &&
        !script.includes("\r")
    );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        if (pending) pending.reject(Object.assign(new Error(CODE), { code: CODE }));
      }, timeout);
      pending = { resolve, reject, timer };
      child.stdin.write(`${script}pwd\n`, (error) => {
        if (error && pending) pending.reject(error);
      });
    });
  };
  const close = async () => {
    if (stopped) return exited;
    stopped = true;
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    try {
      return await exited;
    } finally {
      clearTimeout(timer);
    }
  };
  const abort = async () => {
    stopped = true;
    child.kill("SIGKILL");
    await exited;
  };
  return {
    step,
    close,
    abort,
    alive: () => !exit && !stopped,
    get exit() {
      return exit;
    }
  };
}

export async function openR3HostedEvidenceDelivery(input) {
  exact(input, ["creationSpecBytes", "jobAdmissionBytes"]);
  need(process.platform === "linux" && process.getuid?.() === 0);
  const scope = r3EvidenceScope(input);
  let key,
    sftp,
    state = "opened",
    closed = false,
    failed = false,
    busy = false,
    closing,
    request = null,
    cleanupDigest = null,
    closedReceipt = null;
  try {
    key = await readR3HostedOperationKey({ operationRef: scope.operationRef });
    need(
      key.creationSpecBytes.equals(input.creationSpecBytes) &&
        key.jobAdmissionBytes.equals(input.jobAdmissionBytes)
    );
    const transfer = path.join(path.dirname(key.sshPrivateKeyPath), "transfer");
    const known = await knownHosts();
    const recheck = async () => {
      need(!closed && !failed && Date.now() < Date.parse(scope.expiresAt));
      await key.recheck();
      need(
        key.creationSpecBytes.equals(input.creationSpecBytes) &&
          key.jobAdmissionBytes.equals(input.jobAdmissionBytes)
      );
      const latest = await knownHosts();
      need(latest.contents === known.contents && latest.identity === known.identity);
      const stat = await fs.lstat(transfer, { bigint: true });
      need(
        stat.isDirectory() &&
          !stat.isSymbolicLink() &&
          stat.uid === 0n &&
          (stat.mode & 0o777n) === 0o700n
      );
      if (sftp) need(sftp.alive());
    };
    await recheck();
    // The protected job publishes its attested input before H1 can import and
    // start the owner holder. This wait never extends the admitted expiry.
    const connectDeadline = Math.min(Date.now() + 600000, Date.parse(scope.expiresAt));
    while (!sftp && Date.now() < connectDeadline) {
      await recheck();
      const attempt = startSftp(key.sshPrivateKeyPath);
      try {
        const greeting = await attempt.step("", 15000);
        need(
          greeting.stdout.includes("Remote working directory: /") && greeting.stderr.length === 0
        );
        sftp = attempt;
      } catch {
        await attempt.abort();
        if (Date.now() < connectDeadline) await delay(1000);
      }
    }
    need(sftp);
    const action = async (expected, next, operation) => {
      need(!busy && state === expected && !failed && !closed);
      busy = true;
      try {
        await recheck();
        const result = await operation();
        await recheck();
        state = next;
        return result;
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        busy = false;
      }
    };
    const upload = async (name, bytes) => {
      need(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= LIMIT);
      const local = path.join(transfer, name);
      await localFile(local, bytes);
      try {
        const result = await sftp.step(
          `put ${local} /in/${name}.part\nrename /in/${name}.part /in/${name}\n`
        );
        need(result.stderr.length === 0);
      } finally {
        await fs.unlink(local).catch(() => {});
      }
      return { digest: sha256Bytes(bytes), bytes: bytes.length };
    };
    const receive = async (name, untilExpiry = false) => {
      const local = path.join(transfer, name);
      const deadline = untilExpiry
        ? Date.parse(scope.expiresAt)
        : Math.min(Date.now() + 120000, Date.parse(scope.expiresAt));
      while (Date.now() < deadline) {
        await recheck();
        const result = await sftp.step(`-get /out/${name} ${local}\n`);
        try {
          const bytes = await stableLocal(local);
          need(result.stderr.length === 0);
          await fs.unlink(local);
          return bytes;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          need(/No such file|File not found/iu.test(result.stderr) && result.stderr.length <= 1024);
        }
        await delay(2000);
      }
      fail();
    };
    return Object.freeze({
      sendCreation(bundleBytes) {
        return action("opened", "creation-sent", () => upload("creation.bundle.json", bundleBytes));
      },
      receiveCleanupRequest() {
        return action("creation-sent", "request-received", async () => {
          const bytes = await receive("cleanup-request.json", true);
          request = decodeR3CleanupRequest({ bytes, scope });
          return request;
        });
      },
      sendCleanup(bundleBytes) {
        return action("request-received", "cleanup-sent", async () => {
          const result = await upload("cleanup.bundle.json", bundleBytes);
          cleanupDigest = result.digest;
          return result;
        });
      },
      receiveCleanupImported({ bundleDigest }) {
        return action("cleanup-sent", "imported", async () => {
          need(bundleDigest === cleanupDigest);
          return decodeR3CleanupImported({
            bytes: await receive("cleanup-imported.json"),
            request,
            bundleDigest
          });
        });
      },
      receiveClosed() {
        return action("imported", "closed-read", async () => {
          const bytes = await receive("closed.json");
          const closedNotice = decodeR3Closed({ bytes, request });
          closedReceipt = encodeR3ClosedReceived({ request, closedBytes: bytes });
          return closedNotice;
        });
      },
      confirmClosedReceived() {
        // The caller first persists the public RC evidence. Keep the receipt
        // bound to our validated bytes, never to a caller-supplied notice.
        return action("closed-read", "closed-received", () =>
          upload("closed-received.json", closedReceipt)
        );
      },
      recheck,
      async close() {
        if (closing) return closing;
        closed = true;
        closing = (async () => {
          try {
            if (busy || failed || !sftp.alive()) {
              await sftp.abort();
            } else {
              const result = await sftp.close();
              need(result.code === 0 && result.signal === null);
            }
          } finally {
            await key.close();
          }
        })();
        return closing;
      }
    });
  } catch (error) {
    await sftp?.abort().catch(() => {});
    await key?.close().catch(() => {});
    throw error;
  }
}
