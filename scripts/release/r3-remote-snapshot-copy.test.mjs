import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import { copyR3SnapshotToPostgres } from "./r3-remote-snapshot-copy.mjs";

const OPERATION = "11111111-2222-4333-8444-555555555555";
const CONTAINER = "a".repeat(64);
const DIRECTORY = "/tmp/stage1-r3-11111111222243338444555555555555";
const FILE = `${DIRECTORY}/snapshot.dump`;
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const encoded = (value) => Buffer.from(JSON.stringify(value));
function frame(output, channel = 1) {
  const bytes = Buffer.from(output);
  const header = Buffer.alloc(8);
  header[0] = channel;
  header.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([header, bytes]);
}

function fixture({ corrupt = false, brokenSource = false } = {}) {
  const bytes = Buffer.from("authenticated snapshot dump\n".repeat(17));
  const events = [];
  let directoryExists = false,
    remoteBytes,
    execution,
    checks = 0,
    opens = 0;
  const plaintext = {
    facts: {
      path: "/sealed/consumer/plaintext/snapshot.dump",
      snapshotDigest: digest(bytes),
      plaintextSizeBytes: bytes.length,
      keyFingerprint: `sha256:${"f".repeat(64)}`
    },
    source: {
      open() {
        opens++;
        if (brokenSource)
          return Readable.from(
            (async function* () {
              yield bytes.subarray(0, 5);
              throw new Error("replay failed");
            })()
          );
        return Readable.from([bytes.subarray(0, 23), bytes.subarray(23)]);
      }
    },
    async recheck() {
      checks++;
    },
    async close() {
      throw new Error("copy must not close plaintext");
    }
  };
  const engineCall = async (method, url, value, status, options) => {
    events.push({ method, url, value, status, options });
    if (method === "POST" && url === `/containers/${CONTAINER}/exec`) {
      assert.equal(status, 201);
      assert.equal(value.User, "0");
      assert.equal(value.Tty, false);
      assert.equal(value.AttachStdout, true);
      assert.equal(value.AttachStderr, true);
      execution = { id: "b".repeat(64), command: value.Cmd, output: "", exit: 0 };
      return encoded({ Id: execution.id });
    }
    if (method === "POST" && url === `/exec/${execution.id}/start`) {
      assert.deepEqual(value, { Detach: false, Tty: false });
      assert.equal(status, 200);
      const [program, ...args] = execution.command;
      if (program === "/usr/bin/mkdir") {
        assert.deepEqual(args, ["-m", "0700", "--", DIRECTORY]);
        if (directoryExists) execution.exit = 1;
        else directoryExists = true;
      } else if (program === "/usr/bin/stat") {
        assert.deepEqual(args.slice(0, 3), ["-c", "%F|%a|%u|%g|%s|%d|%i|%h|%y|%z", "--"]);
        const target = args[3];
        if (target === DIRECTORY)
          execution.output =
            "directory|700|0|0|4096|42|99|2|2026-09-29 00:00:00.000000000 +0000|2026-09-29 00:00:00.000000000 +0000\n";
        else if (target === FILE && remoteBytes)
          execution.output = `regular file|600|0|0|${remoteBytes.length}|42|100|1|2026-09-29 00:00:00.000000000 +0000|2026-09-29 00:00:00.000000000 +0000\n`;
        else execution.exit = 1;
      } else if (program === "/usr/bin/sha256sum") {
        assert.deepEqual(args, ["--", FILE]);
        execution.output = `${digest(remoteBytes).slice(7)}  ${FILE}\n`;
      } else throw new Error(`unexpected command ${program}`);
      return frame(execution.output);
    }
    if (method === "GET" && url === `/exec/${execution.id}/json`) {
      assert.equal(status, 200);
      return encoded({
        ID: execution.id,
        ContainerID: CONTAINER,
        Running: false,
        ExitCode: execution.exit
      });
    }
    if (
      method === "PUT" &&
      url === `/containers/${CONTAINER}/archive?path=${encodeURIComponent(DIRECTORY)}`
    ) {
      assert.equal(status, 200);
      assert.equal(value, undefined);
      assert.equal(options.contentType, "application/x-tar");
      assert.equal(options.timeout, 120000);
      assert.equal(typeof options.bodySource.open, "function");
      const chunks = [];
      for await (const chunk of await options.bodySource.open()) chunks.push(Buffer.from(chunk));
      const tar = Buffer.concat(chunks);
      assert.equal(tar.length, options.bodySource.contentLength);
      assert.equal(tar.subarray(0, 100).toString("ascii").split("\0")[0], "snapshot.dump");
      assert.equal(tar.subarray(100, 108).toString("ascii").split("\0")[0], "0000600");
      assert.equal(tar.subarray(108, 116).toString("ascii").split("\0")[0], "0000000");
      assert.equal(tar.subarray(116, 124).toString("ascii").split("\0")[0], "0000000");
      assert.equal(tar[156], "0".charCodeAt(0));
      assert.equal(tar.subarray(257, 263).toString("ascii"), "ustar\0");
      assert.equal(Number.parseInt(tar.subarray(124, 136).toString("ascii"), 8), bytes.length);
      const header = tar.subarray(0, 512);
      const actualChecksum = header.reduce(
        (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
        0
      );
      assert.equal(Number.parseInt(header.subarray(148, 156).toString("ascii"), 8), actualChecksum);
      assert.equal(tar.subarray(512, 512 + bytes.length).compare(bytes), 0);
      assert.ok(tar.subarray(512 + bytes.length).every((byte) => byte === 0));
      remoteBytes = Buffer.from(tar.subarray(512, 512 + bytes.length));
      if (corrupt) remoteBytes[0] ^= 1;
      return Buffer.alloc(0);
    }
    throw new Error(`unexpected Engine call ${method} ${url}`);
  };
  return {
    plaintext,
    engineCall,
    events,
    get checks() {
      return checks;
    },
    get opens() {
      return opens;
    },
    get remoteBytes() {
      return remoteBytes;
    }
  };
}
function request(f) {
  return {
    operationRef: OPERATION,
    containerId: CONTAINER,
    plaintext: f.plaintext,
    engineCall: f.engineCall,
    recheck: async () => {},
    signal: new AbortController().signal
  };
}

test("streams one fixed root-owned ustar member and verifies copied bytes", async () => {
  const f = fixture();
  const held = await copyR3SnapshotToPostgres(request(f));
  assert.deepEqual(held.facts, {
    containerId: CONTAINER,
    directory: DIRECTORY,
    path: FILE,
    snapshotDigest: f.plaintext.facts.snapshotDigest,
    plaintextSizeBytes: f.plaintext.facts.plaintextSizeBytes
  });
  assert.equal(f.opens, 1);
  assert.ok(f.checks >= 2);
  assert.equal(Object.isFrozen(held.observations), true);
  await held.recheck();
  await held.close();
  await held.close();
  await assert.rejects(held.recheck(), { code: "R3_REMOTE_SNAPSHOT_COPY_UNAVAILABLE" });
});

test("changed remote bytes refuse a copy fact", async () => {
  const f = fixture({ corrupt: true });
  await assert.rejects(copyR3SnapshotToPostgres(request(f)), {
    code: "R3_REMOTE_SNAPSHOT_COPY_UNAVAILABLE"
  });
  assert.equal(f.opens, 1);
  assert.ok(f.remoteBytes);
});

test("a failed source stream cannot produce a copied-file observation", async () => {
  const f = fixture({ brokenSource: true });
  await assert.rejects(copyR3SnapshotToPostgres(request(f)), {
    code: "R3_REMOTE_SNAPSHOT_COPY_UNAVAILABLE"
  });
  assert.equal(f.events.filter((event) => event.method === "PUT").length, 1);
  assert.equal(
    f.events.filter((event) => event.value?.Cmd?.[0] === "/usr/bin/sha256sum").length,
    0
  );
  assert.equal(f.remoteBytes, undefined);
});
