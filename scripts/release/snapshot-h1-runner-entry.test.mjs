import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { prepareH1RunnerInput } from "./snapshot-h1-runner-entry.mjs";

function input(change = {}) {
  const settings = {
    agentId: 8123,
    agentName: `stage1-snapshot-${"a".repeat(32)}`,
    workFolder: "_work",
    ephemeral: true,
    disableUpdate: true,
    poolId: 1,
    serverUrl: "https://pipelines.actions.githubusercontent.com/tenant",
    ...change
  };
  const files = Object.fromEntries(
    Object.entries({
      ".runner": JSON.stringify(settings),
      ".credentials": JSON.stringify({
        scheme: "OAuth",
        data: {
          clientId: "59eaa054-2ea7-40e0-b005-1876193c7e13",
          authorizationUrl: "https://vstoken.actions.githubusercontent.com/token"
        }
      }),
      ".credentials_rsaparams": "synthetic-key"
    }).map(([key, value]) => [key, Buffer.from(value).toString("base64")])
  );
  return {
    attemptId: "932dd453-5404-4677-9001-74b14600a222",
    admissionRef: `sha256:${"b".repeat(64)}`,
    runnerId: "8123",
    routeNonce: "a".repeat(32),
    encodedJitConfig: Buffer.from(JSON.stringify(files)).toString("base64")
  };
}

test("binds JIT settings to the one runner and derives every executable path", () => {
  const frame = input();
  const result = prepareH1RunnerInput(frame);
  assert.equal(
    result.runnerRoot,
    `/var/lib/subscription-saas/snapshot-volumes/${frame.attemptId}.mnt/runner`
  );
  assert.equal(result.settings.agentId, 8123);
  assert.deepEqual(Object.keys(result.files).sort(), [
    ".credentials",
    ".credentials_rsaparams",
    ".runner"
  ]);
  assert.equal(result.files[".credentials_rsaparams"].toString(), "synthetic-key");
});

test("rejects cross-runner identities, persistent runners and writable update settings", () => {
  for (const change of [
    { agentId: 8124 },
    { agentName: "another-runner" },
    { workFolder: "/tmp/work" },
    { ephemeral: false },
    { disableUpdate: false }
  ])
    assert.throws(() => prepareH1RunnerInput(input(change)), /H1_RUNNER_INPUT_REJECTED/);
  assert.throws(
    () => prepareH1RunnerInput({ ...input(), runnerRoot: "/tmp" }),
    /H1_RUNNER_INPUT_REJECTED/
  );
});

test("rejects JIT file traversal and alternate base64 encodings before any file write", () => {
  const frame = input();
  const files = JSON.parse(Buffer.from(frame.encodedJitConfig, "base64"));
  files["../outside"] = Buffer.from("invalid").toString("base64");
  frame.encodedJitConfig = Buffer.from(JSON.stringify(files)).toString("base64");
  assert.throws(() => prepareH1RunnerInput(frame), /H1_RUNNER_INPUT_REJECTED/);
  assert.throws(
    () => prepareH1RunnerInput({ ...input(), encodedJitConfig: input().encodedJitConfig + "\n" }),
    /H1_RUNNER_INPUT_REJECTED/
  );
});

test("rejects duplicate JIT file/settings keys and invalid UTF-8", () => {
  const frame = input();
  const files = JSON.parse(Buffer.from(frame.encodedJitConfig, "base64"));
  const raw = JSON.stringify(files);
  frame.encodedJitConfig = Buffer.from(raw.slice(0, -1) + ',".runner":"e30="}').toString("base64");
  assert.throws(() => prepareH1RunnerInput(frame), /H1_RUNNER_INPUT_REJECTED/);
  const settings = Buffer.from(files[".runner"], "base64").toString();
  files[".runner"] = Buffer.from(settings.slice(0, -1) + ',"ephemeral":true}').toString("base64");
  frame.encodedJitConfig = Buffer.from(JSON.stringify(files)).toString("base64");
  assert.throws(() => prepareH1RunnerInput(frame), /H1_RUNNER_INPUT_REJECTED/);
  files[".runner"] = Buffer.from([0xff]).toString("base64");
  frame.encodedJitConfig = Buffer.from(JSON.stringify(files)).toString("base64");
  assert.throws(() => prepareH1RunnerInput(frame), /H1_RUNNER_INPUT_REJECTED/);
});

test("rejects non-GitHub connection and OAuth endpoints and hidden setting aliases", () => {
  for (const change of [
    { serverUrl: "https://example.invalid/" },
    { serverUrl: "http://pipelines.actions.githubusercontent.com/" },
    { serverUrlV2: "https://actions.githubusercontent.com.example.invalid/" },
    { ServerUrl: "https://example.invalid/" },
    { monitorSocketAddress: "/tmp/socket" }
  ])
    assert.throws(() => prepareH1RunnerInput(input(change)), /H1_RUNNER_INPUT_REJECTED/);
  const frame = input();
  const files = JSON.parse(Buffer.from(frame.encodedJitConfig, "base64"));
  const credentials = JSON.parse(Buffer.from(files[".credentials"], "base64"));
  credentials.data.oauthEndpointUrl = "https://example.invalid/token";
  files[".credentials"] = Buffer.from(JSON.stringify(credentials)).toString("base64");
  frame.encodedJitConfig = Buffer.from(JSON.stringify(files)).toString("base64");
  assert.throws(() => prepareH1RunnerInput(frame), /H1_RUNNER_INPUT_REJECTED/);
});
