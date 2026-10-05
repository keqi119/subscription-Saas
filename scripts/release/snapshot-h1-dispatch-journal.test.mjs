import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, chmod, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";
import test from "node:test";
import {
  createH1DispatchJournalForTesting,
  initializeH1DispatchJournalForTesting
} from "./snapshot-h1-dispatch-journal.mjs";

const digest = (char) => `sha256:${char.repeat(64)}`;
const checkpoint = (sequence, headDigest = digest("a")) => ({ sequence, headDigest });

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "h1-dispatch-journal-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, policyDigest: digest("1") };
}

test("checkpoint initialization is explicit and records survive a fresh journal instance", async (t) => {
  const f = await fixture(t);
  const journal = createH1DispatchJournalForTesting({ stateDir: f.root });
  await assert.rejects(journal.readCheckpoint(f.policyDigest));
  const initial = checkpoint(3);
  const initializing = initializeH1DispatchJournalForTesting({
    stateDir: f.root,
    policyDigest: f.policyDigest,
    initialCheckpoint: initial
  });
  initial.sequence = 100;
  await initializing;
  const next = { policyDigest: f.policyDigest, ...checkpoint(4, digest("b")) };
  const recording = journal.recordVerifiedHead(next);
  next.sequence = 100;
  next.headDigest = digest("c");
  await recording;
  const restarted = createH1DispatchJournalForTesting({ stateDir: f.root });
  assert.deepEqual(await restarted.readCheckpoint(f.policyDigest), checkpoint(4, digest("b")));
  await assert.rejects(
    initializeH1DispatchJournalForTesting({
      stateDir: f.root,
      policyDigest: f.policyDigest,
      initialCheckpoint: checkpoint(3)
    })
  );
});

test("checkpoint compare-and-record rejects rollback and same-sequence equivocation", async (t) => {
  const f = await fixture(t);
  const journal = createH1DispatchJournalForTesting({ stateDir: f.root });
  await initializeH1DispatchJournalForTesting({
    stateDir: f.root,
    policyDigest: f.policyDigest,
    initialCheckpoint: checkpoint(8)
  });
  let getterInvoked = false;
  const accessor = { policyDigest: f.policyDigest, sequence: 9 };
  Object.defineProperty(accessor, "headDigest", {
    enumerable: true,
    get() {
      getterInvoked = true;
      throw new Error("must not execute");
    }
  });
  await assert.rejects(journal.recordVerifiedHead(accessor));
  assert.equal(getterInvoked, false);
  await assert.rejects(
    journal.recordVerifiedHead({ policyDigest: f.policyDigest, ...checkpoint(7) })
  );
  await assert.rejects(
    journal.recordVerifiedHead({ policyDigest: f.policyDigest, ...checkpoint(8, digest("c")) })
  );
  assert.deepEqual(await journal.readCheckpoint(f.policyDigest), checkpoint(8));
});

test("cross-process writers cannot both replace the head and damaged state fails closed", async (t) => {
  const f = await fixture(t);
  const journal = createH1DispatchJournalForTesting({ stateDir: f.root });
  await initializeH1DispatchJournalForTesting({
    stateDir: f.root,
    policyDigest: f.policyDigest,
    initialCheckpoint: checkpoint(1)
  });
  const moduleUrl = new URL("./snapshot-h1-dispatch-journal.mjs", import.meta.url).href;
  const source = (headDigest) =>
    `import { createH1DispatchJournalForTesting as make } from ${JSON.stringify(moduleUrl)};\n` +
    `const j = make({ stateDir: ${JSON.stringify(f.root)} });\n` +
    `try { await j.recordVerifiedHead({ policyDigest: ${JSON.stringify(f.policyDigest)}, sequence: 2, headDigest: ${JSON.stringify(headDigest)} }); process.exit(0); } catch { process.exit(3); }`;
  const run = (headDigest) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", source(headDigest)], {
        stdio: "ignore"
      });
      child.on("exit", (code) => resolve(code));
    });
  const codes = await Promise.all([run(digest("d")), run(digest("e"))]);
  assert.equal(codes.filter((code) => code === 0).length, 1);
  assert.equal(codes.filter((code) => code === 3).length, 1);
  const saved = await journal.readCheckpoint(f.policyDigest);
  assert.ok(saved.sequence === 2);
  const filename = path.join(f.root, `${f.policyDigest.slice(7)}.json`);
  await writeFile(filename, "{damaged", { mode: 0o600 });
  await assert.rejects(journal.readCheckpoint(f.policyDigest));
});
