import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { PassThrough } from "node:stream";
import test from "node:test";
import { setImmediate } from "node:timers";
import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { runH1DataWorker } from "./snapshot-h1-data-worker.mjs";

const sourceRow = {
  database_name: "subscription_saas_staging",
  database_oid: "1",
  system_identifier: "123",
  role_name: "stage1_snapshot_reader",
  session_role: "stage1_snapshot_reader",
  backend_pid: 41
};
const workspaceRow = {
  database_name: "stage1_snapshot_workspace",
  database_oid: "2",
  system_identifier: "456",
  role_name: "stage1_snapshot_migrate",
  session_role: "stage1_snapshot_migrate",
  backend_pid: 42
};
const fingerprint = (row) =>
  sha256Canonical({
    databaseName: row.database_name,
    databaseOid: row.database_oid,
    systemIdentifier: row.system_identifier
  });
const publicDer = Buffer.from("synthetic-public-key-der");
const configure = () => ({
  kind: "configure",
  authorization: {
    schemaVersion: "producer-crypto-run-authorization.v2",
    repository: { name: "keqi119/subscription-Saas", id: "1253231368" },
    notBefore: new Date(Date.now() - 60000).toISOString(),
    notAfter: new Date(Date.now() + 60000).toISOString(),
    snapshotRunId: "123",
    releaseAttemptId: "attempt-1",
    localKey: { keyFingerprint: sha256Bytes(publicDer) }
  },
  publicKey: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n",
  source: { port: 55431, password: "source-secret", identityFingerprint: fingerprint(sourceRow) },
  workspace: {
    port: 55432,
    password: "workspace-secret",
    identityFingerprint: fingerprint(workspaceRow)
  },
  tokenizationKeyBase64: Buffer.alloc(32, 7).toString("base64")
});

function fixture() {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => {
    text += chunk.toString();
  });
  const events = [];
  const clients = [];
  class Client {
    constructor(options) {
      this.options = options;
      this.processID = options.port === 55431 ? 41 : 42;
      clients.push(this);
    }
    async connect() {
      events.push(`connect:${this.options.port}`);
    }
    on() {
      return this;
    }
    async query() {
      events.push(`identity:${this.options.port}`);
      return { rows: [this.options.port === 55431 ? sourceRow : workspaceRow] };
    }
    async end() {
      events.push(`end:${this.options.port}`);
    }
  }
  const deps = {
    Client,
    assertRuntime: async () => {},
    validateAuthorization: () => {},
    readContracts: async () => ({ contract: {}, ownershipMap: {} }),
    parsePublicKey: () => ({
      type: "public",
      asymmetricKeyType: "rsa",
      asymmetricKeyDetails: { modulusLength: 3072, publicExponent: 65537n },
      export: () => publicDer
    }),
    createSource: ({ client, exportDump }) => {
      events.push("source-factory");
      assert.equal(typeof exportDump, "function");
      let closed = false;
      return {
        trustPolicy: "protected-snapshot-source/v1",
        closeSnapshot: async () => {
          if (!closed) {
            closed = true;
            await client.end();
          }
        }
      };
    },
    createWorkspace: ({ client, restoreDump, destroyResource }) => {
      events.push("workspace-factory");
      assert.equal(typeof restoreDump, "function");
      return {
        trustPolicy: "isolated-sanitization-workspace/v1",
        destroy: (() => {
          let pending;
          return () => {
            pending ??= (async () => {
              await client.end();
              await destroyResource();
            })();
            return pending;
          };
        })()
      };
    },
    createNativeTools: (settings) => {
      events.push(`native:${settings.purpose}:${settings.port}`);
      assert.ok(!JSON.stringify(settings).includes("docker"));
      return { exportDump: async () => Buffer.from("PGDMP"), restoreDump: async () => {} };
    },
    expandArchive: async () => ({}),
    runEncryption: async ({ adapters }) => {
      events.push("encryption-start");
      await adapters.workspace.destroy();
      events.push("encryption-after-destroy");
      return {
        metadata: {},
        privilegeObservation: {},
        fingerprintObservation: {},
        scan: {},
        envelope: {},
        ciphertextPath: "/work/crypto/snapshot.enc"
      };
    },
    ackTimeoutMs: 20
  };
  return { input, output, events, clients, deps, text: () => text };
}

test("closed configure rejects extra field before any client", async () => {
  const f = fixture();
  f.input.end(JSON.stringify({ ...configure(), extra: true }) + "\n");
  await runH1DataWorker({ input: f.input, output: f.output, deps: f.deps });
  assert.equal(f.clients.length, 0);
  assert.match(f.text(), /"status":"FAILED"/u);
});

test("matching source and target fingerprint rejects before connecting", async () => {
  const f = fixture();
  const value = configure();
  value.workspace.identityFingerprint = value.source.identityFingerprint;
  f.input.end(JSON.stringify(value) + "\n");
  await runH1DataWorker({ input: f.input, output: f.output, deps: f.deps });
  assert.equal(f.events.includes("source-factory"), false);
  assert.equal(f.events.includes("workspace-factory"), false);
  assert.equal(f.clients.length, 0);
  assert.equal(f.text().includes("COMPLETE"), false);
});

test("unconfirmed target destruction cannot produce success after real wiring order", async () => {
  const f = fixture();
  f.input.end(JSON.stringify(configure()) + "\n");
  await runH1DataWorker({ input: f.input, output: f.output, deps: f.deps });
  assert.deepEqual(f.events.slice(0, 6), [
    "connect:55431",
    "connect:55432",
    "identity:55431",
    "identity:55432",
    "native:source:55431",
    "native:workspace:55432"
  ]);
  assert.ok(f.text().includes("workspace-destroy-request"));
  assert.ok(!f.text().includes("COMPLETE"));
  assert.ok(f.events.includes("encryption-start"));
  assert.ok(!f.events.includes("encryption-after-destroy"));
});

test("split configure line and correct ACK followed by EOF permit completion", async () => {
  const f = fixture();
  let replied = false;
  f.output.on("data", (chunk) => {
    for (const line of chunk.toString().trim().split("\n")) {
      const message = JSON.parse(line);
      if (message.kind === "workspace-destroy-request") {
        replied = true;
        f.input.end(`${JSON.stringify({ ...message, kind: "workspace-destroyed" })}\n`);
      }
    }
  });
  const line = JSON.stringify(configure()) + "\n";
  const running = runH1DataWorker({ input: f.input, output: f.output, deps: f.deps });
  f.input.write(line.slice(0, 45));
  setImmediate(() => f.input.write(line.slice(45)));
  await running;
  assert.equal(replied, true);
  assert.ok(f.text().includes('"status":"COMPLETE"'), f.text());
  assert.deepEqual(
    f.events.filter((event) => event === "end:55431"),
    ["end:55431"]
  );
  assert.deepEqual(
    f.events.filter((event) => event === "end:55432"),
    ["end:55432"]
  );
});

test("late bytes after a correct ACK reject before encryption resumes", async () => {
  const f = fixture();
  f.output.on("data", (chunk) => {
    const message = JSON.parse(chunk.toString());
    if (message.kind === "workspace-destroy-request") {
      f.input.write(`${JSON.stringify({ ...message, kind: "workspace-destroyed" })}\n`);
      setImmediate(() => f.input.end("unexpected"));
    }
  });
  const running = runH1DataWorker({ input: f.input, output: f.output, deps: f.deps });
  f.input.write(`${JSON.stringify(configure())}\n`);
  assert.equal(await running, false);
  assert.equal(f.events.includes("encryption-after-destroy"), false);
  assert.equal(f.text().includes('"status":"COMPLETE"'), false);
});
