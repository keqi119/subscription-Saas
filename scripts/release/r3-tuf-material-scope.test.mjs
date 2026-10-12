import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { getR3FailureDiagnostic, r3FailureTracker } from "./r3-failure-diagnostic.mjs";
import { tufCliFixture } from "./test-fixtures/tuf-cli-fixture.mjs";

const api = await import("./r3-tuf-material-scope.mjs").catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  return {};
});
const ref = "e5d6bef1-b423-4a47-a66c-85dc978d2da9";
const binding = () => ({ operationRef: ref, deadlineAtMs: Date.now() + 60000 });

const args = ["attestation", "verify", "/public/proof.json", "--repo", "keqi119/subscription-Saas"];
const nativeOnly = { skip: process.platform !== "linux" || process.getuid?.() !== 0 };

test(
  "binary admission failure stops before root acquisition and retains a fixed cause",
  nativeOnly,
  async (t) => {
    const original = fs.open;
    t.mock.method(fs, "open", (file, ...rest) => {
      if (file === "/opt/stage1-tools/gh_2.101.0_linux_amd64/bin/gh")
        throw Object.assign(new Error("private path"), { code: "ELOOP" });
      return original(file, ...rest);
    });
    t.mock.method(childProcess, "execFile", () => assert.fail("untrusted binary executed"));
    await assert.rejects(
      api.withR3TufMaterialScope(binding(), () => assert.fail("consumer entered")),
      (error) => {
        assert.equal(error.code, "R3_TUF_BINARY_INVALID");
        assert.equal(getR3FailureDiagnostic(error).causeCode, "R3_TUF_BINARY_INVALID");
        return true;
      }
    );
  }
);

test(
  "TUF failure emits a bounded public classification without raw command output",
  nativeOnly,
  async (t) => {
    await cli(t, {
      failure: Object.assign(new Error("private-secret"), { code: 1 }),
      stderr:
        "https://tuf-repo.github.com/4.root.json\nfailed to create TUF client: status code: 503 private-secret"
    });
    const lines = [];
    t.mock.method(process.stderr, "write", (value) => {
      lines.push(String(value));
      return true;
    });
    await assert.rejects(
      api.withR3TufMaterialScope(binding(), () => assert.fail("consumer entered"))
    );
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes("private-secret"));
    const envelope = JSON.parse(lines[0]);
    assert.equal(envelope.brand, "R3_TUF_ACQUISITION_FAILURE");
    assert.equal(envelope.diagnostic.reason, "HTTP_ERROR");
    assert.equal(envelope.diagnostic.httpStatus, 503);
    assert.equal(envelope.diagnostic.repository, "GITHUB");
    assert.equal(envelope.diagnostic.target, "ROOT");
  }
);

async function cli(t, { wrongIssuer = false, expired = false, failure = null, stderr = "" } = {}) {
  const calls = [];
  t.mock.method(childProcess, "execFile", (file, argv, options, callback) => {
    const child = new EventEmitter();
    child.kill = () => true;
    calls.push({ file, argv, options });
    setImmediate(async () => {
      try {
        if (failure) throw failure;
        assert.deepEqual(argv, ["attestation", "trusted-root"]);
        assert.equal(options.env.GH_TOKEN, undefined);
        callback(null, await tufCliFixture(options, { wrongIssuer, expired }), Buffer.alloc(0));
        child.emit("close", 0, null);
      } catch (error) {
        callback(error, Buffer.alloc(0), Buffer.from(stderr));
        child.emit("close", 1, null);
      }
    });
    return child;
  });
  return calls;
}

test(
  "one owner acquires roots once but verifies each input and removes only its private material",
  nativeOnly,
  async (t) => {
    assert.equal(
      typeof api.withR3TufMaterialScope,
      "function",
      "official material scope is missing"
    );
    const calls = await cli(t);
    let file, afterClose;
    await api.withR3TufMaterialScope(binding(), async () => {
      for (const input of ["proof", "receipt", "current", "history"]) {
        assert.equal(
          await api.withR3TufAttestation([...args, input], async (actual, executable) => {
            assert.equal(executable, "/opt/stage1-tools/gh_2.101.0_linux_amd64/bin/gh");
            assert.deepEqual(actual.slice(0, -2), [...args, input]);
            assert.equal(actual.at(-2), "--custom-trusted-root");
            file ??= actual.at(-1);
            assert.equal(actual.at(-1), file);
            assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
            assert.equal((await fs.readFile(file, "utf8")).trim().split("\n").length, 2);
            return input;
          }),
          input
        );
      }
      let resolve;
      const wait = new Promise((r) => {
        resolve = r;
      });
      afterClose = {
        resolve,
        use: wait.then(() =>
          api.withR3TufAttestation(args, () => assert.fail("closed material used"))
        )
      };
    });
    assert.equal(calls.length, 1);
    const env = calls[0].options.env;
    const directory = path.dirname(file);
    assert.equal(env.HOME, directory);
    for (const [key, suffix] of [
      ["XDG_STATE_HOME", "state"],
      ["XDG_DATA_HOME", "data"]
    ])
      assert.equal(env[key], path.join(directory, suffix));
    await assert.rejects(fs.stat(directory), { code: "ENOENT" });
    await assert.rejects(fs.stat(file), { code: "ENOENT" });
    afterClose.resolve();
    await assert.rejects(afterClose.use, { code: "R3_TUF_SCOPE_CLOSED" });
  }
);

test(
  "caller root injection and nested acquisition reject before executing",
  nativeOnly,
  async (t) => {
    await cli(t);
    for (const option of [
      "--custom-trusted-root",
      "--custom-trusted-root=/tmp/forged",
      "--tuf-root",
      "--tuf-metadata-dir=/tmp/cache"
    ]) {
      await assert.rejects(
        api.withR3TufAttestation([...args, option], () => assert.fail("injection reached CLI")),
        { code: "R3_TUF_ARGUMENT_INVALID" }
      );
    }
    await api.withR3TufMaterialScope(binding(), async () => {
      await assert.rejects(
        api.withR3TufMaterialScope(binding(), () => assert.fail("nested scope accepted")),
        { code: "R3_TUF_SCOPE_INVALID" }
      );
    });
  }
);

test("altered held material rejects before a later attestation", nativeOnly, async (t) => {
  await cli(t);
  await api.withR3TufMaterialScope(binding(), async () => {
    await api
      .withR3TufAttestation(args, async (actual) => {
        await fs.writeFile(actual.at(-1), "{}\n");
        return "would pass";
      })
      .then(
        () => assert.fail("tampered bytes accepted"),
        (error) => assert.equal(error.code, "R3_TUF_MATERIAL_CHANGED")
      );
    await assert.rejects(
      api.withR3TufAttestation(args, () => assert.fail("poisoned scope reused")),
      { code: "R3_TUF_SCOPE_CLOSED" }
    );
  });
});

test(
  "unexpected issuer, expired metadata and acquisition failure never enter consumer",
  nativeOnly,
  async (t) => {
    for (const options of [
      { wrongIssuer: true },
      { expired: true },
      { failure: Object.assign(new Error("private stderr"), { code: 1 }) }
    ]) {
      const calls = await cli(t, options);
      await assert.rejects(
        api.withR3TufMaterialScope(binding(), () => assert.fail("invalid roots accepted"))
      );
      assert.equal(calls.length, 1);
      t.mock.restoreAll();
    }
  }
);

test("absolute cutoff cannot be renewed by later use or clock rollback", nativeOnly, async (t) => {
  await cli(t);
  const now = Date.now();
  await api.withR3TufMaterialScope({ operationRef: ref, deadlineAtMs: now + 60000 }, async () => {
    t.mock.method(Date, "now", () => now - 10000);
    await assert.rejects(
      api.withR3TufAttestation(args, () => assert.fail("clock rollback accepted")),
      { code: "R3_TUF_SCOPE_EXPIRED" }
    );
    t.mock.restoreAll();
    await assert.rejects(
      api.withR3TufAttestation(args, () =>
        assert.fail("failed scope revived after clock recovery")
      ),
      { code: "R3_TUF_SCOPE_CLOSED" }
    );
  });
});

test(
  "same bytes on a replacement inode are refused and pending children settle before cleanup",
  nativeOnly,
  async (t) => {
    await cli(t);
    await api.withR3TufMaterialScope(binding(), async () => {
      await assert.rejects(
        api.withR3TufAttestation(args, async (actual) => {
          const file = actual.at(-1),
            bytes = await fs.readFile(file);
          await fs.rename(file, file + ".old");
          await fs.writeFile(file, bytes, { mode: 0o600 });
        }),
        { code: "R3_TUF_MATERIAL_CHANGED" }
      );
    });
    let settle, entered, file, detached;
    const waiting = new Promise((resolve) => {
      settle = resolve;
    });
    const ready = new Promise((resolve) => {
      entered = resolve;
    });
    const owner = api.withR3TufMaterialScope(binding(), async () => {
      detached = api.withR3TufAttestation(args, async (actual) => {
        file = actual.at(-1);
        entered();
        await waiting;
      });
      detached.catch(() => {});
      await ready;
    });
    await ready;
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok((await fs.stat(file)).isFile());
    settle();
    await assert.rejects(owner, { code: "R3_TUF_SCOPE_CLOSED" });
    await assert.rejects(detached, { code: "R3_TUF_SCOPE_CLOSED" });
    await assert.rejects(fs.stat(file), { code: "ENOENT" });
  }
);

test(
  "primary failure survives cleanup failure without losing its diagnostic",
  nativeOnly,
  async (t) => {
    await cli(t);
    const tracker = r3FailureTracker("H1_CONSUME");
    tracker.enter("HISTORY");
    const primary = tracker.decorate(
      Object.assign(new Error("secret detail"), { code: "R3_HISTORY_CONTEXT_UNAVAILABLE" }),
      { code: "R3_HISTORY_CONTEXT_UNAVAILABLE" }
    );
    let directory;
    const originalRmdir = fs.rmdir;
    t.mock.method(fs, "rmdir", async (name) => {
      if (directory && name.startsWith(directory)) throw new Error("fixture cleanup failure");
      return originalRmdir(name);
    });
    try {
      await assert.rejects(
        api.withR3TufMaterialScope(binding(), () =>
          api.withR3TufAttestation(args, async (actual) => {
            directory = path.dirname(actual.at(-1));
            throw primary;
          })
        ),
        (error) => {
          assert.equal(error, primary);
          const diagnostic = getR3FailureDiagnostic(error);
          assert.equal(diagnostic.component, "H1_CONSUME");
          assert.equal(diagnostic.stage, "HISTORY");
          assert.equal(diagnostic.causeCode, "R3_HISTORY_CONTEXT_UNAVAILABLE");
          assert.equal(diagnostic.cleanupCode, "R3_TUF_CLEANUP_FAILED");
          assert.ok(!JSON.stringify(diagnostic).includes("secret"));
          return true;
        }
      );
    } finally {
      t.mock.restoreAll();
      assert.match(directory, /^\/run\/stage1-tuf-[A-Za-z0-9]+$/u);
      assert.equal(await fs.realpath(directory), directory);
      await fs.rm(directory, { recursive: true });
    }
  }
);
