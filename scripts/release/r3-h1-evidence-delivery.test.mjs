import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import * as delivery from "./r3-h1-evidence-delivery.mjs";
import { cancelR3Startup, runWithR3StartupDeadline } from "./r3-startup-deadline.mjs";

const { readR3StableInboxFile } = delivery;

test(
  "H1 idle mount gate accepts a kernel table and rejects mounted or unknown state",
  { skip: process.platform !== "linux" },
  async () => {
    const maintenance = await fs.readFile(
      new URL("./maintenance/stage1-r3-evidence-account.sh", import.meta.url),
      "utf8"
    );
    const match = maintenance.match(/^assert_unmounted_exchange\(\) \{\n[\s\S]*?^\}/m);
    assert.ok(match, "exercise the actual production shell gate");
    const cases = [
      { table: "/\n/run\n", status: 0, accepted: true },
      { table: "/\n/run/stage1-r3-evidence\n", status: 0, accepted: false },
      { table: "", status: 0, accepted: false },
      { table: "/\n", status: 1, accepted: false }
    ];
    for (const fixture of cases) {
      const source = `set -Eeuo pipefail\nexchange=/run/stage1-r3-evidence\ndie() { exit 1; }\nfindmnt() { printf '%s' "$MOUNT_TABLE"; return "$MOUNT_STATUS"; }\n${match[0]}\nassert_unmounted_exchange\n`;
      const result = childProcess.spawnSync("bash", ["-s"], {
        input: source,
        encoding: "utf8",
        env: { ...process.env, MOUNT_TABLE: fixture.table, MOUNT_STATUS: String(fixture.status) },
        timeout: 1000
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status === 0, fixture.accepted, JSON.stringify(fixture));
    }
  }
);

test("pre-dispatch evidence gate accepts only a formal idle surface without writes", async (t) => {
  assert.equal(typeof delivery.assertR3H1EvidenceReady, "function");
  const oldPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const oldGetuid = Object.getOwnPropertyDescriptor(process, "getuid");
  Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
  Object.defineProperty(process, "getuid", { configurable: true, value: () => 0 });
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", oldPlatform);
    if (oldGetuid) Object.defineProperty(process, "getuid", oldGetuid);
    else delete process.getuid;
  });

  let entries = [];
  let shellIdle = true;
  let writes = 0;
  const directory = (uid = 0n, gid = 0n, mode = 0o755n) => ({
    isDirectory: () => true,
    isSymbolicLink: () => false,
    uid,
    gid,
    mode: 0o40000n | mode
  });
  const key = {
    isFile: () => true,
    isSymbolicLink: () => false,
    uid: 0n,
    gid: 0n,
    mode: 0o100644n,
    nlink: 1n,
    size: 0n
  };
  t.mock.method(fs, "lstat", async (file) => {
    if (file === "/run/stage1-r3-evidence") return directory();
    if (file === "/etc/ssh/stage1-r3-evidence/authorized_keys") return key;
    if (["/run", "/etc/ssh", "/etc/ssh/stage1-r3-evidence"].includes(file)) return directory();
    throw new Error(`unexpected lstat ${file}`);
  });
  t.mock.method(fs, "readdir", async (file) => {
    assert.equal(file, "/run/stage1-r3-evidence");
    return entries;
  });
  t.mock.method(fs, "readFile", async (file) => {
    if (file === "/proc/self/mountinfo") return "";
    throw new Error(`owner-only read at pre-dispatch: ${file}`);
  });
  for (const name of ["mkdir", "writeFile", "open", "rm", "unlink", "truncate"])
    t.mock.method(fs, name, async () => {
      writes++;
      throw new Error("unexpected write");
    });
  const ssh = {
    authenticationmethods: "publickey",
    pubkeyauthentication: "yes",
    passwordauthentication: "no",
    challengeresponseauthentication: "no",
    authorizedkeysfile: "/etc/ssh/stage1-r3-evidence/authorized_keys",
    authorizedkeyscommand: "none",
    trustedusercakeys: "none",
    authorizedprincipalsfile: "none",
    authorizedprincipalscommand: "none",
    chrootdirectory: "/run/stage1-r3-evidence",
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
  t.mock.method(childProcess, "execFile", (file, args, options, callback) => {
    assert.equal(options.shell, false);
    let output = "",
      code = 0;
    if (file === "/usr/bin/id") output = args[0] === "-u" ? "993\n" : "989\n";
    else if (file === "/usr/bin/getent" && args[0] === "passwd")
      output = "stage1-r3-evidence:x:993:989::/:/sbin/nologin\n";
    else if (file === "/usr/bin/getent" && args[0] === "shadow")
      output = "stage1-r3-evidence:!:0::::::\n";
    else if (file === "/usr/sbin/sshd")
      output =
        Object.entries(ssh)
          .map(([name, value]) => `${name} ${value}`)
          .join("\n") + "\n";
    else if (file === "/usr/bin/pgrep") code = 1;
    else if (file === "/usr/bin/bash") {
      assert.equal(args.at(-1), "check-idle");
      if (!shellIdle) code = 1;
    } else throw new Error(`unexpected command ${file}`);
    const child = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(() => {
      callback(
        code ? Object.assign(new Error("not idle"), { code }) : null,
        Buffer.from(output),
        Buffer.alloc(0)
      );
      child.emit("close", code, null);
    });
    return child;
  });
  syncBuiltinESMExports();

  await delivery.assertR3H1EvidenceReady();
  entries = ["in", "out"];
  await assert.rejects(delivery.assertR3H1EvidenceReady(), {
    code: "R3_H1_EVIDENCE_DELIVERY_UNAVAILABLE"
  });
  entries = [];
  shellIdle = false;
  await assert.rejects(delivery.assertR3H1EvidenceReady(), {
    code: "R3_H1_EVIDENCE_DELIVERY_UNAVAILABLE"
  });
  shellIdle = true;
  await runWithR3StartupDeadline(
    {
      deadlineAtMs: Date.now() + 60000,
      executeStartedAt: new Date().toISOString(),
      operationRef: "54a88ca5-7e62-474a-b3c6-69f34eb6f420",
      runId: "37787742897",
      jobId: "113348580001"
    },
    async () => {
      cancelR3Startup();
      await assert.rejects(delivery.assertR3H1EvidenceReady(), { code: "R3_STARTUP_CANCELLED" });
      await assert.rejects(
        delivery.openR3H1EvidenceDelivery({
          repoRoot: "/opt/stage1-r3-candidate",
          operationRef: "54a88ca5-7e62-474a-b3c6-69f34eb6f420"
        }),
        { code: "R3_STARTUP_CANCELLED" }
      );
    }
  );
  assert.equal(writes, 0);
});

test(
  "H1 reads a complete single-link inbox file as an independent copy",
  { skip: process.platform !== "linux" },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "r3-inbox-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, "creation.bundle.json");
    const original = Buffer.from('{"bundle":"complete"}');
    await fs.writeFile(file, original, { mode: 0o600 });
    const uid = (await fs.lstat(file, { bigint: true })).uid;
    const received = await readR3StableInboxFile({ file, uid });
    assert.deepEqual(received, original);
    received[0] = 0;
    assert.deepEqual(await fs.readFile(file), original);
  }
);

test(
  "H1 rejects partial, linked and oversized inbox files",
  { skip: process.platform !== "linux" },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "r3-inbox-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, "creation.bundle.json");
    const part = `${file}.part`;
    await fs.writeFile(part, "partial", { mode: 0o600 });
    const uid = (await fs.lstat(part, { bigint: true })).uid;
    await assert.rejects(readR3StableInboxFile({ file, uid }));
    await fs.link(part, file);
    await assert.rejects(readR3StableInboxFile({ file, uid }));
    await fs.unlink(file);
    await fs.writeFile(file, Buffer.alloc(1048577), { mode: 0o600 });
    await assert.rejects(readR3StableInboxFile({ file, uid }));
  }
);
