// Private monotonic checkpoint for the fixed H1 snapshot root controller.
// Initialization is explicit; readers never infer or recreate a missing head.
import { constants } from "node:fs";
import { Buffer } from "node:buffer";
import { lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { snapshotKernelData } from "../../packages/release-foundation/src/snapshot/environment-policy.mjs";

const STATE_DIR = "/var/lib/subscription-saas/snapshot-root-state/dispatch-checkpoints";
const PARENT_DIR = path.posix.dirname(STATE_DIR);
const CODE = "H1_DISPATCH_JOURNAL_REJECTED";
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const requireThat = (value) => {
  if (!value) fail();
};
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

function validCheckpoint(value) {
  requireThat(
    exact(value, ["sequence", "headDigest"]) &&
      Number.isSafeInteger(value.sequence) &&
      value.sequence >= 0 &&
      typeof value.headDigest === "string" &&
      DIGEST.test(value.headDigest)
  );
}

function validPolicyDigest(value) {
  requireThat(typeof value === "string" && DIGEST.test(value));
}

function validateRecordFile(stat, testMode) {
  requireThat(
    stat.isFile() &&
      stat.nlink === 1 &&
      (testMode || (stat.mode & 0o777) === 0o600) &&
      (testMode || (stat.uid === 0 && stat.gid === 0))
  );
}

function validateDirectory(stat, { final, testMode }) {
  requireThat(stat.isDirectory() && !stat.isSymbolicLink());
  if (!testMode) requireThat(stat.uid === 0 && stat.gid === 0);
  if (!testMode) {
    requireThat((stat.mode & 0o022) === 0);
    if (final) requireThat((stat.mode & 0o777) === 0o700);
  }
}

async function checkedDirectory(directory, { final = false, testMode = false } = {}) {
  requireThat(path.isAbsolute(directory) && path.normalize(directory) === directory);
  const parsed = path.parse(directory);
  let current = parsed.root;
  let finalStat;
  for (const part of directory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await lstat(current);
    validateDirectory(stat, { final: final && current === directory, testMode });
    finalStat = stat;
  }
  requireThat(finalStat);
  if (!testMode) {
    const handle = await open(
      directory,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)
    );
    try {
      const opened = await handle.stat();
      validateDirectory(opened, { final, testMode });
      requireThat(opened.dev === finalStat.dev && opened.ino === finalStat.ino);
    } finally {
      await handle.close();
    }
  }
}

function productionHost() {
  requireThat(
    process.platform === "linux" &&
      typeof process.getuid === "function" &&
      process.getuid() === 0 &&
      typeof process.getgid === "function" &&
      process.getgid() === 0
  );
}

async function withLock(directory, { testMode = false } = {}, action) {
  await checkedDirectory(directory, { final: true, testMode });
  const lock = path.join(directory, ".lock");
  let held = false;
  try {
    await mkdir(lock, { mode: 0o700 });
    held = true;
    await checkedDirectory(lock, { final: true, testMode });
    return await action();
  } catch (error) {
    if (testMode) throw error;
    fail();
  } finally {
    if (held) {
      try {
        await rmdir(lock);
      } catch {
        // A lock that cannot be released remains a fail-closed barrier.
        fail();
      }
    }
  }
}

function statePath(directory, policyDigest) {
  validPolicyDigest(policyDigest);
  return path.join(directory, `${policyDigest.slice(7)}.json`);
}

async function readState(file, { testMode = false } = {}) {
  let handle;
  try {
    handle = await open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
    );
    const stat = await handle.stat();
    requireThat(stat.size > 0 && stat.size <= 1024);
    validateRecordFile(stat, testMode);
    const buffer = Buffer.alloc(1025);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    const currentPath = await lstat(file);
    validateRecordFile(after, testMode);
    validateRecordFile(currentPath, testMode);
    requireThat(
      length === stat.size &&
        length <= 1024 &&
        after.dev === stat.dev &&
        after.ino === stat.ino &&
        after.size === stat.size &&
        after.mtimeMs === stat.mtimeMs &&
        after.ctimeMs === stat.ctimeMs &&
        currentPath.dev === stat.dev &&
        currentPath.ino === stat.ino &&
        currentPath.size === stat.size
    );
    const bytes = buffer.subarray(0, length);
    const text = bytes.toString("utf8");
    const value = JSON.parse(text);
    requireThat(text === `${JSON.stringify(value)}\n`);
    requireThat(exact(value, ["policyDigest", "sequence", "headDigest"]));
    validPolicyDigest(value.policyDigest);
    validCheckpoint({ sequence: value.sequence, headDigest: value.headDigest });
    return value;
  } catch {
    fail();
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeInitial(directory, policyDigest, checkpoint, { testMode = false } = {}) {
  validPolicyDigest(policyDigest);
  validCheckpoint(checkpoint);
  let created = false;
  try {
    await mkdir(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") fail();
  }
  if (created && !testMode) {
    const dirHandle = await open(
      directory,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)
    );
    try {
      const info = await dirHandle.stat();
      validateDirectory(info, { final: false, testMode });
      await dirHandle.chmod(0o700);
      validateDirectory(await dirHandle.stat(), { final: true, testMode });
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
    const parentHandle = await open(
      path.dirname(directory),
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)
    );
    try {
      await parentHandle.sync();
    } finally {
      await parentHandle.close();
    }
  }
  await withLock(directory, { testMode }, async () => {
    const file = statePath(directory, policyDigest);
    let handle;
    try {
      handle = await open(file, "wx", 0o600);
      await handle.chmod(0o600);
      validateRecordFile(await handle.stat(), testMode);
      const body = `${JSON.stringify({ policyDigest, ...checkpoint })}\n`;
      await handle.writeFile(body, "utf8");
      await handle.sync();
    } catch {
      fail();
    } finally {
      await handle?.close().catch(() => {});
    }
    if (!testMode) {
      const dirHandle = await open(
        directory,
        constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)
      );
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    }
  });
}

function createAt(directory, { testMode = false } = {}) {
  return Object.freeze({
    async readCheckpoint(policyDigest) {
      if (!testMode) productionHost();
      validPolicyDigest(policyDigest);
      return withLock(directory, { testMode }, async () => {
        const state = await readState(statePath(directory, policyDigest), { testMode });
        requireThat(state.policyDigest === policyDigest);
        return { sequence: state.sequence, headDigest: state.headDigest };
      });
    },
    async recordVerifiedHead(input) {
      const accepted = snapshotKernelData(input, CODE);
      requireThat(exact(accepted, ["policyDigest", "sequence", "headDigest"]));
      validPolicyDigest(accepted.policyDigest);
      validCheckpoint({ sequence: accepted.sequence, headDigest: accepted.headDigest });
      if (!testMode) productionHost();
      return withLock(directory, { testMode }, async () => {
        const file = statePath(directory, accepted.policyDigest);
        const current = await readState(file, { testMode });
        requireThat(current.policyDigest === accepted.policyDigest);
        requireThat(
          accepted.sequence > current.sequence ||
            (accepted.sequence === current.sequence && accepted.headDigest === current.headDigest)
        );
        if (accepted.sequence === current.sequence) return;
        const temporary = path.join(directory, `.next-${process.pid}-${Date.now()}`);
        let handle;
        try {
          handle = await open(temporary, "wx", 0o600);
          await handle.chmod(0o600);
          validateRecordFile(await handle.stat(), testMode);
          await handle.writeFile(`${JSON.stringify(accepted)}\n`, "utf8");
          await handle.sync();
          await handle.close();
          handle = null;
          await rename(temporary, file);
          if (!testMode) {
            const dirHandle = await open(
              directory,
              constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)
            );
            try {
              await dirHandle.sync();
            } finally {
              await dirHandle.close();
            }
          }
        } catch {
          fail();
        } finally {
          await handle?.close().catch(() => {});
          await unlink(temporary).catch(() => {});
        }
      });
    }
  });
}

export async function initializeH1DispatchJournal(policyDigest, initialCheckpoint) {
  validPolicyDigest(policyDigest);
  const capturedCheckpoint = snapshotKernelData(initialCheckpoint, CODE);
  validCheckpoint(capturedCheckpoint);
  productionHost();
  await checkedDirectory(PARENT_DIR, { final: true });
  await writeInitial(STATE_DIR, policyDigest, capturedCheckpoint);
}

export function createH1DispatchJournal() {
  productionHost();
  return createAt(STATE_DIR);
}

// Isolated filesystem seam used only by the local journal tests; production
// callers use the fixed-path exports above and cannot pass a path override.
export async function initializeH1DispatchJournalForTesting({
  stateDir,
  policyDigest,
  initialCheckpoint
}) {
  requireThat(typeof stateDir === "string" && path.isAbsolute(stateDir));
  validPolicyDigest(policyDigest);
  const capturedCheckpoint = snapshotKernelData(initialCheckpoint, CODE);
  validCheckpoint(capturedCheckpoint);
  await writeInitial(stateDir, policyDigest, capturedCheckpoint, { testMode: true });
}

export function createH1DispatchJournalForTesting({ stateDir }) {
  requireThat(typeof stateDir === "string" && path.isAbsolute(stateDir));
  return createAt(stateDir, { testMode: true });
}
