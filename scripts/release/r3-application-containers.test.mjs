import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

const d = (n) => `sha256:${n.repeat(64)}`;
const identity = {
  operationRef: "01234567-89ab-4cde-8123-456789abcdef",
  sourceSha: "a".repeat(40),
  api: { imageDigest: d("1"), imageReference: `ghcr.io/keqi119/subscription-api@${d("1")}` },
  web: { imageDigest: d("2"), imageReference: `ghcr.io/keqi119/subscription-web@${d("2")}` },
  postgresAddress: "172.28.0.2",
  apiManifestId: "r3-manifest",
  apiSessionNonce: "session-123",
  databaseName: "stage1_application",
  runtimeRole: "stage1_api"
};

async function fixture({
  corruptRunning = false,
  failVerification = false,
  failDelete = false
} = {}) {
  const { withR3ApplicationContainers, applicationContainerSpecs } =
    await import("./r3-application-containers.mjs");
  const specs = applicationContainerSpecs(identity);
  const events = [],
    containers = new Map(),
    images = new Map();
  let credentialReads = 0;
  let queuedCredential;
  const replies = (value) => Buffer.from(JSON.stringify(value));
  const engineCall = async (method, url, body, status) => {
    events.push({ method, url, body });
    if (url.startsWith("/images/create?")) {
      const ref = new URL(`http://engine${url}`).searchParams.get("fromImage");
      const role = ref.includes("subscription-api@") ? "api" : "web";
      images.set(ref, {
        Id: d(role === "api" ? "3" : "4"),
        Os: "linux",
        Architecture: "amd64",
        RepoDigests: [ref],
        Config: {
          Cmd: specs[role].body.Cmd,
          Env: [],
          Labels: { "org.opencontainers.image.revision": identity.sourceSha }
        }
      });
      return replies({ status: "downloaded" });
    }
    if (url.startsWith("/images/")) {
      const ref = decodeURIComponent(
        url
          .slice(8)
          .split("?")[0]
          .replace(/\/json$/u, "")
      );
      if (method === "DELETE") {
        images.delete(ref);
        return replies([]);
      }
      if (status === 404) {
        assert.ok(!images.has(ref));
        return replies({ message: "absent" });
      }
      return replies(images.get(ref));
    }
    if (url.startsWith("/containers/create?")) {
      const role = body.Labels["com.subscription.release.container-role"];
      const id = (role === "api" ? "5" : "6").repeat(64);
      containers.set(id, { role, spec: { name: specs[role].name, body }, state: "created" });
      return replies({ Id: id, Warnings: [] });
    }
    const id = url.split("/")[2].split("?")[0],
      entry = containers.get(id);
    if (method === "DELETE") {
      if (failDelete && entry?.role === "api") throw new Error("cleanup failed");
      containers.delete(id);
      return Buffer.alloc(0);
    }
    if (url.endsWith("/start")) {
      assert.ok(events.some((e) => e.attach === id));
      entry.state = "running";
      return Buffer.alloc(0);
    }
    if (url.includes("/stop?")) {
      entry.state = "exited";
      return Buffer.alloc(0);
    }
    if (status === 404) {
      assert.ok(!entry);
      return replies({ message: "absent" });
    }
    assert.ok(url.endsWith("/json"));
    const running = entry.state === "running";
    const config = structuredClone(entry.spec.body);
    config.Labels = { ...images.get(config.Image).Config.Labels, ...config.Labels };
    delete config.HostConfig;
    const value = {
      Id: id,
      Name: `/${entry.spec.name}`,
      Image: images.get(config.Image).Id,
      Config: config,
      HostConfig: structuredClone(entry.spec.body.HostConfig),
      Mounts: [],
      State: {
        Status: entry.state,
        Running: running,
        Paused: false,
        Restarting: false,
        Dead: false,
        OOMKilled: false,
        Pid: running ? 101 + (entry.role === "web" ? 1 : 0) : 0,
        ExitCode: 0,
        Error: ""
      },
      NetworkSettings: {
        Ports: running ? { [entry.role === "api" ? "3001/tcp" : "3000/tcp"]: null } : {},
        Networks: {
          [entry.spec.body.HostConfig.NetworkMode]: {
            NetworkID: running ? "7".repeat(64) : "",
            EndpointID: running ? (entry.role === "api" ? "8" : "9").repeat(64) : "",
            IPAddress: running ? `172.28.0.${entry.role === "api" ? 3 : 4}` : ""
          }
        }
      }
    };
    if (corruptRunning && running && entry.role === "api") value.HostConfig.Privileged = true;
    return replies(value);
  };
  const openAttach = ({ containerId }) => {
    const stdin = new PassThrough(),
      stdout = new PassThrough(),
      stderr = new PassThrough();
    stdin.on("data", (chunk) => {
      // A PassThrough write can complete while its downstream socket still
      // holds this exact buffer. Consume it later, as a backed-up socket would.
      queuedCredential = chunk;
      events.push({ credentialSent: containerId });
      // Keep secret bytes out of test diagnostics as well as owner observations.
      assert.ok(JSON.parse(chunk).databaseUrl.startsWith("postgresql://"));
      stdout.write("application startup output\n");
    });
    return {
      stdin,
      stdout,
      stderr,
      ready: Promise.resolve().then(() => events.push({ attach: containerId })),
      completed: new Promise(() => {}),
      close: async () => {
        stdout.end();
        stderr.end();
      }
    };
  };
  const run = () =>
    withR3ApplicationContainers({
      identity,
      signal: new AbortController().signal,
      engineCall,
      openAttach,
      recheck: async () => {},
      observe: async (state) => {
        events.push({ observation: structuredClone(state) });
      },
      readCredential: async () => {
        credentialReads++;
        return {
          username: identity.runtimeRole,
          password: "test-private-password",
          database: identity.databaseName
        };
      },
      execute: async (applications) => {
        assert.ok(queuedCredential.includes(Buffer.from("postgresql://")));
        assert.equal(applications.api.address, "172.28.0.3");
        assert.equal(applications.web.address, "172.28.0.4");
        assert.equal(applications.publicWebOrigin, "http://web:3000");
        if (failVerification) throw new Error("verification failed");
        await applications.assertRunning();
        return { observed: true };
      }
    });
  return { run, events, containers, images, credentials: () => credentialReads };
}

test("candidate applications attach and inspect before credentials, then retain cleanup observations", async () => {
  const f = await fixture();
  const result = await f.run();
  assert.equal(result.value.observed, true);
  assert.equal(result.cleaned, true);
  assert.equal(f.credentials(), 1);
  assert.equal(f.containers.size, 0);
  assert.equal(f.images.size, 0);
  const sent = f.events.findIndex((e) => e.credentialSent);
  assert.ok(sent > f.events.findIndex((e) => e.url?.endsWith("/start")));
  assert.equal(f.events[sent - 1].observation.containers[0].state, "running");
  assert.ok(!JSON.stringify(result).includes("test-private-password"));
  assert.ok(!JSON.stringify(f.events).includes("test-private-password"));
});

test("wrong running ownership prevents credential release and still cleans known owned containers", async () => {
  const f = await fixture({ corruptRunning: true });
  await assert.rejects(f.run, { code: "R3_APPLICATION_CONTAINER_FAILED" });
  assert.equal(f.credentials(), 0);
  assert.equal(f.containers.size, 0);
});

test("verification failure remains a failure after cleanup; failed cleanup cannot report success", async () => {
  const failedCheck = await fixture({ failVerification: true });
  await assert.rejects(failedCheck.run, { code: "R3_APPLICATION_CONTAINER_FAILED" });
  assert.equal(failedCheck.containers.size, 0);
  const failedCleanup = await fixture({ failDelete: true });
  await assert.rejects(
    failedCleanup.run,
    (error) => error.code === "R3_APPLICATION_CONTAINER_FAILED" && error.originals.cleaned === false
  );
  assert.equal(failedCleanup.containers.size, 1);
});
