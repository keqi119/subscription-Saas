// Internal held-Engine lifecycle, not an authorization or public success gate.
// The native holder supplies admitted identity, credentials and resource checks.
import { createHash } from "node:crypto";
import { sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { API_APPLICATION_ENTRYPOINT } from "./r3-application-bootstrap.mjs";
import { openR3EngineAttach } from "./r3-engine-attach.mjs";

const CODE = "R3_APPLICATION_CONTAINER_FAILED";
const cid = /^[0-9a-f]{64}$/u;
const digest = /^sha256:[0-9a-f]{64}$/u;
const failure = () => Object.assign(new Error(CODE), { code: CODE });
const need = (value) => {
  if (!value) throw failure();
};
const same = (a, b) => sha256Canonical(a ?? null) === sha256Canonical(b ?? null);
const empty = (value) =>
  value == null || (typeof value === "object" && Object.keys(value).length === 0);
const ipv4 = (value) =>
  typeof value === "string" &&
  /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/u.test(value) &&
  value.split(".").every((part) => Number(part) <= 255 && String(Number(part)) === part);
const COMMANDS = Object.freeze({
  api: ["node", "apps/api/dist/src/main.js"],
  web: ["node", "apps/web/server.js"]
});
const WEB_ORIGIN = "http://web:3000";

export function applicationContainerSpecs(identity) {
  need(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      identity?.operationRef
    ) &&
      /^[0-9a-f]{40}$/u.test(identity.sourceSha) &&
      ipv4(identity.postgresAddress)
  );
  for (const field of ["apiManifestId", "apiSessionNonce"])
    need(/^[a-z0-9][a-z0-9-]{1,39}$/u.test(identity[field]));
  need(`subscription-api/${identity.apiManifestId}/${identity.apiSessionNonce}`.length <= 63);
  for (const field of ["databaseName", "runtimeRole"])
    need(/^[a-z][a-z0-9_]{0,62}$/u.test(identity[field]));
  const suffix = identity.operationRef.replaceAll("-", "");
  return Object.fromEntries(
    ["api", "web"].map((role) => {
      need(
        digest.test(identity[role]?.imageDigest) &&
          identity[role].imageReference ===
            `ghcr.io/keqi119/subscription-${role}@${identity[role].imageDigest}`
      );
      const privateTmpfs = "rw,nosuid,nodev,noexec,size=33554432,mode=0700,uid=1000,gid=1000";
      return [
        role,
        {
          name: `s1r3${role}_${suffix}`,
          body: {
            Image: identity[role].imageReference,
            User: "1000:1000",
            WorkingDir: "/app",
            Entrypoint: role === "api" ? [...API_APPLICATION_ENTRYPOINT] : [],
            Cmd: [...COMMANDS[role]],
            Env: [
              "NODE_ENV=production",
              "HOME=/tmp",
              "PATH=/usr/local/bin:/usr/bin:/bin",
              `PORT=${role === "api" ? 3001 : 3000}`,
              ...(role === "api"
                ? [
                    "RELEASE_FINAL_GATE=true",
                    `DATABASE_MANIFEST_ID=${identity.apiManifestId}`,
                    `DATABASE_SESSION_NONCE=${identity.apiSessionNonce}`,
                    "DATABASE_POOL_MAX=1",
                    "DATABASE_POOL_IDLE_TIMEOUT_MS=300000",
                    `CORS_ORIGIN=${WEB_ORIGIN}`
                  ]
                : ["HOSTNAME=0.0.0.0"])
            ],
            Labels: {
              "com.subscription.release.operation-ref": identity.operationRef,
              "com.subscription.release.container-role": role
            },
            OpenStdin: role === "api",
            StdinOnce: false,
            AttachStdin: role === "api",
            AttachStdout: true,
            AttachStderr: true,
            Tty: false,
            HostConfig: {
              NetworkMode: `s1r3net_${suffix}`,
              PidMode: "",
              IpcMode: "private",
              Privileged: false,
              ReadonlyRootfs: true,
              Init: true,
              CapDrop: ["ALL"],
              SecurityOpt: ["no-new-privileges:true"],
              RestartPolicy: { Name: "no" },
              Memory: 1073741824,
              MemorySwap: 1073741824,
              PidsLimit: 256,
              ExtraHosts: role === "api" ? [`postgres:${identity.postgresAddress}`] : [],
              Tmpfs: {
                "/tmp": "rw,nosuid,nodev,noexec,size=268435456,mode=1777",
                ...(role === "api"
                  ? { "/app/uploads": privateTmpfs, "/app/apps/api/uploads": privateTmpfs }
                  : { "/app/apps/web/.next/cache": privateTmpfs })
              },
              PortBindings: {},
              PublishAllPorts: false,
              LogConfig: { Type: "none", Config: {} }
            }
          }
        }
      ];
    })
  );
}

function checkImage(image, identity, role) {
  need(
    digest.test(image?.Id) &&
      image.Os === "linux" &&
      image.Architecture === "amd64" &&
      image.RepoDigests?.includes(identity[role].imageReference) &&
      image.Config?.Labels?.["org.opencontainers.image.revision"] === identity.sourceSha &&
      same(image.Config.Cmd, COMMANDS[role]) &&
      empty(image.Config.Volumes)
  );
  need(
    Array.isArray(image.Config.Env) &&
      image.Config.Env.every(
        (entry) =>
          typeof entry === "string" &&
          /^[A-Za-z_][A-Za-z0-9_]*=/u.test(entry) &&
          !/(?:PASSWORD|PASSFILE|SECRET|TOKEN|DATABASE_URL|DIRECT_URL|DOCKER_HOST|NODE_OPTIONS)/iu.test(
            entry.slice(0, entry.indexOf("="))
          )
      )
  );
}

function inspectOwned(value, held, state) {
  const { id, image, spec, role } = held,
    config = value?.Config,
    host = value?.HostConfig;
  need(value?.Id === id && value.Name === `/${spec.name}` && value.Image === image.Id);
  for (const key of [
    "Image",
    "User",
    "WorkingDir",
    "Entrypoint",
    "Cmd",
    "OpenStdin",
    "StdinOnce",
    "AttachStdin",
    "AttachStdout",
    "AttachStderr",
    "Tty"
  ])
    need(
      key === "Entrypoint" && role === "web"
        ? empty(config?.[key])
        : same(config?.[key], spec.body[key])
    );
  need(same(config.Labels, { ...image.Config.Labels, ...spec.body.Labels }));
  const env = (entries) =>
    Object.fromEntries(
      entries.map((entry) => {
        const index = entry.indexOf("=");
        need(index > 0);
        return [entry.slice(0, index), entry.slice(index + 1)];
      })
    );
  const expectedEnv = env([...(image.Config.Env ?? []), ...spec.body.Env]);
  need(
    Array.isArray(config.Env) &&
      config.Env.length === Object.keys(expectedEnv).length &&
      same(env(config.Env), expectedEnv) &&
      empty(config.Volumes)
  );
  for (const [key, expected] of Object.entries(spec.body.HostConfig)) {
    if (key === "RestartPolicy")
      need(host?.RestartPolicy?.Name === "no" && !host.RestartPolicy.MaximumRetryCount);
    else if (["ExtraHosts", "PortBindings"].includes(key) && empty(expected))
      need(empty(host?.[key]));
    else need(same(host?.[key], expected));
  }
  need(
    !host.AutoRemove &&
      ["Binds", "Mounts", "VolumesFrom", "Devices", "DeviceRequests", "CapAdd"].every((key) =>
        empty(host[key])
      )
  );
  need(
    Array.isArray(value.Mounts) &&
      value.Mounts.length <= Object.keys(host.Tmpfs).length &&
      new Set(value.Mounts.map((m) => m.Destination)).size === value.Mounts.length &&
      value.Mounts.every(
        (m) =>
          m.Type === "tmpfs" &&
          Object.hasOwn(host.Tmpfs, m.Destination) &&
          !m.Source &&
          !m.Name &&
          m.RW === true
      )
  );
  const running = state === "running",
    observed = value.State;
  need(
    observed?.Status === state &&
      observed.Running === running &&
      observed.Paused === false &&
      observed.Restarting === false &&
      observed.Dead === false &&
      observed.OOMKilled === false &&
      observed.Error === "" &&
      Number.isSafeInteger(observed.Pid) &&
      (running ? observed.Pid > 0 : observed.Pid === 0)
  );
  const networks = value.NetworkSettings?.Networks;
  need(networks && same(Object.keys(networks), [host.NetworkMode]));
  const attachment = networks[host.NetworkMode];
  if (state === "created")
    need(
      attachment.NetworkID === "" && attachment.EndpointID === "" && attachment.IPAddress === ""
    );
  if (running)
    need(
      cid.test(attachment.NetworkID) &&
        cid.test(attachment.EndpointID) &&
        ipv4(attachment.IPAddress)
    );
  const ports = value.NetworkSettings.Ports;
  need(empty(ports) || same(ports, { [`${role === "api" ? 3001 : 3000}/tcp`]: null }));
  return running ? attachment.IPAddress : null;
}

// Pure checks for independent native Engine readback. These facts do not grant
// image use, credential access or cleanup authority.
export function assessR3ApplicationImage({ identity, role, image }) {
  need(["api", "web"].includes(role));
  applicationContainerSpecs(identity);
  checkImage(image, identity, role);
  return image.Id;
}

export function assessR3ApplicationContainer({ identity, role, id, state, image, container }) {
  need(cid.test(id) && ["created", "running"].includes(state));
  assessR3ApplicationImage({ identity, role, image });
  const spec = applicationContainerSpecs(identity)[role];
  const address = inspectOwned(container, { id, image, spec, role }, state);
  return Object.freeze({
    containerId: id,
    role,
    state,
    address,
    networkId: container.NetworkSettings.Networks[spec.body.HostConfig.NetworkMode].NetworkID,
    pid: container.State.Pid
  });
}

export async function withR3ApplicationContainers({
  identity,
  signal,
  engineCall,
  recheck,
  observe,
  readCredential,
  execute,
  openAttach = openR3EngineAttach
}) {
  identity = structuredClone(identity);
  const specs = applicationContainerSpecs(identity);
  need(
    signal?.addEventListener &&
      !signal.aborted &&
      [engineCall, recheck, observe, readCredential, execute, openAttach].every(
        (fn) => typeof fn === "function"
      )
  );
  const originals = {
    operationRef: identity.operationRef,
    sourceSha: identity.sourceSha,
    specDigest: sha256Canonical(specs),
    exchanges: [],
    streams: {},
    cleaned: false
  };
  const images = [],
    containers = [],
    controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  let failed,
    value,
    streamFailure = false,
    pendingImage = false,
    pendingContainer = false;
  const live = () => need(!signal.aborted && !controller.signal.aborted && !streamFailure);
  const call = async (method, url, body, status, options) => {
    const bytes = await engineCall(method, url, body, status, options);
    need(Buffer.isBuffer(bytes) && bytes.length <= 8 * 1024 * 1024);
    originals.exchanges.push({
      method,
      url,
      status,
      requestBody: structuredClone(body ?? null),
      bodyBase64: bytes.toString("base64")
    });
    return bytes;
  };
  const json = async (...args) =>
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await call(...args)));
  const snapshot = () => ({
    images: images.map(({ role, reference, image }) => ({ role, reference, imageId: image.Id })),
    containers: containers.map(({ id, role, spec, state, image }) => ({
      id,
      role,
      name: spec.name,
      state,
      imageId: image.Id
    }))
  });
  const observeCurrent = async () => {
    await recheck();
    live();
    await observe(snapshot());
    live();
  };
  const assertRunning = async () => {
    for (const held of containers) {
      live();
      const actual = await json("GET", `/containers/${held.id}/json`, undefined, 200);
      need(inspectOwned(actual, held, "running") === held.address);
    }
    await observeCurrent();
  };
  try {
    await observeCurrent();
    for (const role of ["api", "web"]) {
      const reference = identity[role].imageReference;
      pendingImage = true;
      const bytes = await call(
        "POST",
        `/images/create?fromImage=${encodeURIComponent(reference)}&platform=linux%2Famd64`,
        undefined,
        200,
        { timeout: 300000 }
      );
      const progress = bytes
        .toString("utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
      need(progress.length > 0 && progress.every((item) => !item.error && !item.errorDetail));
      const image = await json(
        "GET",
        `/images/${encodeURIComponent(reference)}/json`,
        undefined,
        200
      );
      checkImage(image, identity, role);
      need(!images.some((item) => item.image.Id === image.Id));
      images.push({ role, reference, image });
      pendingImage = false;
      await observeCurrent();
      const spec = specs[role];
      pendingContainer = true;
      const created = await json("POST", `/containers/create?name=${spec.name}`, spec.body, 201);
      need(
        cid.test(created.Id) &&
          !containers.some((item) => item.id === created.Id) &&
          empty(created.Warnings)
      );
      const held = { id: created.Id, image, role, spec, state: "created", owned: false };
      containers.push(held);
      pendingContainer = false;
      inspectOwned(
        await json("GET", `/containers/${held.id}/json`, undefined, 200),
        held,
        "created"
      );
      held.owned = true;
      await observeCurrent();
      const attached = openAttach({ containerId: held.id, signal: controller.signal });
      held.attached = attached;
      // Runtime output can contain error details. Retain only bounded byte counts
      // and hashes, never raw API/Web stdout or a credential-bearing transcript.
      for (const stream of ["stdout", "stderr"]) {
        const hash = createHash("sha256");
        let count = 0;
        attached[stream].on("data", (bytes) => {
          count += bytes.length;
          if (count > 4 * 1024 * 1024) {
            streamFailure = true;
            controller.abort();
          } else hash.update(bytes);
        });
        held[`${stream}Summary`] = () => ({ bytes: count, digest: `sha256:${hash.digest("hex")}` });
      }
      attached.completed.then(
        () => {
          if (held.state !== "stopping" && held.state !== "exited") streamFailure = true;
        },
        () => {
          streamFailure = true;
        }
      );
      await attached.ready;
      live();
      await call("POST", `/containers/${held.id}/start`, undefined, 204);
      held.state = "running";
      held.address = inspectOwned(
        await json("GET", `/containers/${held.id}/json`, undefined, 200),
        held,
        "running"
      );
      need(
        held.address !== identity.postgresAddress &&
          !containers.some((other) => other !== held && other.address === held.address)
      );
      await observeCurrent();
      if (role === "api") {
        const secret = await readCredential();
        live();
        need(
          secret?.username === identity.runtimeRole &&
            secret.database === identity.databaseName &&
            typeof secret.password === "string" &&
            secret.password.length > 0 &&
            secret.password.length <= 4096
        );
        const bytes = Buffer.from(
          `${JSON.stringify({ databaseUrl: `postgresql://${encodeURIComponent(secret.username)}:${encodeURIComponent(secret.password)}@postgres:5432/${identity.databaseName}?sslmode=require` })}\n`
        );
        try {
          need(bytes.length <= 16384);
          await new Promise((resolve, reject) =>
            // PassThrough completion is not socket flush. The transport owns
            // a separate copy so wiping our buffer cannot corrupt queued data.
            attached.stdin.write(Buffer.from(bytes), (error) =>
              error ? reject(failure()) : resolve()
            )
          );
        } finally {
          bytes.fill(0);
        }
      }
    }
    await assertRunning();
    let timer, aborted;
    try {
      value = await Promise.race([
        execute(
          Object.freeze({
            api: Object.freeze({
              ...identity.api,
              containerId: containers[0].id,
              address: containers[0].address
            }),
            web: Object.freeze({
              ...identity.web,
              containerId: containers[1].id,
              address: containers[1].address
            }),
            publicWebOrigin: WEB_ORIGIN,
            applicationName: `subscription-api/${identity.apiManifestId}/${identity.apiSessionNonce}`,
            signal: controller.signal,
            assertRunning
          })
        ),
        new Promise((_, reject) => {
          aborted = () => reject(failure());
          controller.signal.addEventListener("abort", aborted, { once: true });
          if (controller.signal.aborted) aborted();
          timer = setTimeout(() => controller.abort(), 180000);
        })
      ]);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", aborted);
    }
    await assertRunning();
  } catch {
    failed = failure();
  } finally {
    for (const held of [...containers].reverse()) {
      if (!held.owned) {
        failed ??= failure();
        continue;
      }
      try {
        // Exact CID ownership was established before start. A changed/failed
        // runtime remains deletable, but can never become a successful check.
        held.state = "stopping";
        const current = await json("GET", `/containers/${held.id}/json`, undefined, 200);
        if (current.State?.Running)
          await call("POST", `/containers/${held.id}/stop?t=10`, undefined, 204, {
            timeout: 15000
          });
        const stopped = await json("GET", `/containers/${held.id}/json`, undefined, 200);
        if (!failed) {
          inspectOwned(stopped, held, "exited");
          need([0, 143].includes(stopped.State.ExitCode));
        }
      } catch {
        failed ??= failure();
      }
      try {
        await call("DELETE", `/containers/${held.id}?force=1&v=1`, undefined, 204, {
          timeout: 15000
        });
        await call("GET", `/containers/${held.id}/json`, undefined, 404);
        held.deleted = true;
      } catch {
        failed ??= failure();
      }
      held.state = "exited";
      try {
        await held.attached?.close();
      } catch {
        failed ??= failure();
      }
      if (held.attached)
        originals.streams[held.role] = {
          stdout: held.stdoutSummary(),
          stderr: held.stderrSummary()
        };
    }
    for (const held of [...images].reverse()) {
      if (containers.some((item) => item.image.Id === held.image.Id && !item.deleted)) {
        failed ??= failure();
        continue;
      }
      try {
        await json(
          "DELETE",
          `/images/${encodeURIComponent(held.reference)}?force=0&noprune=1`,
          undefined,
          200
        );
        await call("GET", `/images/${encodeURIComponent(held.reference)}/json`, undefined, 404);
        held.deleted = true;
      } catch {
        failed ??= failure();
      }
    }
    originals.cleaned =
      !pendingImage &&
      !pendingContainer &&
      containers.every((item) => item.deleted) &&
      images.every((item) => item.deleted);
    try {
      await recheck();
      await observe({
        images: images
          .filter((item) => !item.deleted)
          .map(({ role, reference, image }) => ({ role, reference, imageId: image.Id })),
        containers: containers
          .filter((item) => !item.deleted)
          .map(({ id, role, spec, state, image }) => ({
            id,
            role,
            name: spec.name,
            state,
            imageId: image.Id
          }))
      });
    } catch {
      failed ??= failure();
    }
    if (streamFailure || signal.aborted) failed ??= failure();
    controller.abort();
    signal.removeEventListener("abort", onAbort);
  }
  if (failed) {
    Object.defineProperty(failed, "originals", { value: originals });
    throw failed;
  }
  return Object.freeze({ value, cleaned: originals.cleaned, originals });
}
