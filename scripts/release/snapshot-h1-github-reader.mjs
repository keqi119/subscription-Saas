// Private parent-side bridge. The root launcher's protected policy supplies the
// installed hashes and short-lived App JWT callback. No job-accessible RPC.
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { sha256Bytes } from "../../packages/release-foundation/src/digest.mjs";
import {
  assertKernelFrame,
  snapshotKernelData
} from "../../packages/release-foundation/src/snapshot/environment-policy.mjs";

const BASE = "/opt/subscription-saas/snapshot-adapter/v2/control";
const FILES = [
  "snapshot-h1-github-query.py",
  "snapshot-h1-github.py",
  "snapshot-h1-route-journal.py"
];
const CODE = "H1_GITHUB_READER_REJECTED";
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const requireThat = (value) => {
  if (!value) fail();
};

async function installed(name, digest) {
  let current = `${BASE}/${name}`;
  const source = current;
  while (current !== "/") {
    const stat = await lstat(current);
    requireThat(
      stat.uid === 0 &&
        stat.gid === 0 &&
        (stat.mode & 0o022) === 0 &&
        (current === source
          ? stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === 0o555
          : stat.isDirectory())
    );
    current = path.posix.dirname(current);
  }
  requireThat(sha256Bytes(await readFile(source)) === digest);
}

export function createH1GitHubReader(input) {
  return createReader(input, false);
}

export function createH1GitHubTerminalReader(input) {
  return createReader(input, true);
}

function createReader(input, terminal) {
  assertKernelFrame(input, ["jwtSupplier", "installation"], CODE);
  const { jwtSupplier, installation } = snapshotKernelData(input, CODE, true);
  assertKernelFrame(installation, FILES, CODE);
  requireThat(
    typeof jwtSupplier === "function" &&
      FILES.every((name) => /^sha256:[a-f0-9]{64}$/.test(installation[name]))
  );
  return async function readGitHub(selection) {
    requireThat(process.platform === "linux" && process.getuid() === 0);
    const captured = snapshotKernelData(selection, CODE);
    for (const name of FILES) await installed(name, installation[name]);
    requireThat(
      (await readFile("/proc/swaps", "utf8")).trim().split(/\r?\n/).length === 1 &&
        (await readFile("/proc/sys/kernel/core_pattern", "utf8")).trim() === "|/bin/false"
    );
    let packet;
    {
      const jwt = await jwtSupplier();
      requireThat(
        typeof jwt === "string" &&
          jwt.length <= 4096 &&
          /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt)
      );
      packet = Buffer.from(
        JSON.stringify({ jwt, selection: captured, ...(terminal ? { operation: "terminal" } : {}) })
      );
    }
    requireThat(packet.length <= 32768);
    try {
      const bytes = await new Promise((resolve, reject) => {
        const child = execFile(
          "/usr/bin/python3",
          ["-I", `${BASE}/${FILES[0]}`],
          {
            cwd: "/",
            env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" },
            timeout: 250000,
            maxBuffer: 16 * 1024 * 1024,
            encoding: "buffer"
          },
          (error, stdout) =>
            error ? reject(Object.assign(new Error(CODE), { code: CODE })) : resolve(stdout)
        );
        child.stdin.on("error", () => {});
        child.stdin.end(packet);
      });
      const result = JSON.parse(bytes.toString("utf8"));
      const decode = (value) => {
        requireThat(typeof value === "string" && value.length > 0 && value.length <= 1398104);
        const buffer = Buffer.from(value, "base64");
        requireThat(buffer.toString("base64") === value && buffer.length <= 1048576);
        return buffer;
      };
      if (terminal) {
        assertKernelFrame(result, ["selection", "run", "jobs", "observedAt"], CODE);
      } else {
        result.workflowBytes = decode(result.workflowBytes);
        result.artifact.bytes = decode(result.artifact.bytes);
      }
      return snapshotKernelData(result, CODE);
    } catch {
      fail();
    } finally {
      packet.fill(0);
    }
  };
}
