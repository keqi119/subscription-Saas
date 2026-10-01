import assert from "node:assert/strict";
import test from "node:test";
import {
  assessR3ApplicationPostgresObservation,
  assessR3FinalPostgresObservation,
  assessR3PostgresObservation,
  assessR3PostgresResources
} from "./r3-postgres-observation.mjs";
import {
  assessR3ApplicationPostgresReadback,
  assessR3FinalPostgresReadback
} from "./r3-destination.mjs";
import { applicationContainerSpecs } from "./r3-application-containers.mjs";

const operationRef = "10000000-0000-4000-8000-000000000001";
const id = operationRef.replaceAll("-", "");
const mount = `/srv/stage1-snapshot/${id}`;
const digest = `sha256:${"a".repeat(64)}`;
const imageId = `sha256:${"e".repeat(64)}`;
const image = `postgres:17-bookworm@${digest}`;
const cid = "b".repeat(64);
const networkName = `s1r3net_${id}`;
const volumeName = `s1r3data_${id}`;
const containerName = `s1r3pg_${id}`;
const label = { "com.subscription.release.operation-ref": operationRef };
const invalid = { code: "R3_POSTGRES_OBSERVATION_INVALID" };

function fixture() {
  const volumePath = `${mount}/docker/volumes/${volumeName}/_data`;
  return {
    operationRef,
    workspaceMountPath: mount,
    engineId: "engine-synthetic",
    imageDigest: digest,
    engine: {
      ID: "engine-synthetic",
      Driver: "overlay2",
      LoggingDriver: "json-file",
      DockerRootDir: `${mount}/docker`
    },
    image: { Id: imageId, RepoDigests: [`postgres@${digest}`], Os: "linux", Architecture: "amd64" },
    container: {
      Id: cid,
      Name: `/${containerName}`,
      Image: imageId,
      Config: { Image: image, Labels: label },
      State: { Running: true, Paused: false, Restarting: false, Dead: false, Pid: 321 },
      HostConfig: {
        NetworkMode: networkName,
        Privileged: false,
        PidMode: "",
        PortBindings: {},
        Binds: null
      },
      NetworkSettings: {
        Networks: { [networkName]: { NetworkID: "c".repeat(64), IPAddress: "172.28.0.2" } },
        Ports: { "5432/tcp": null }
      },
      Mounts: [
        {
          Type: "volume",
          Name: volumeName,
          Source: volumePath,
          Destination: "/var/lib/postgresql/data",
          Driver: "local",
          RW: true
        }
      ]
    },
    network: {
      Id: "c".repeat(64),
      Name: networkName,
      Driver: "bridge",
      Internal: true,
      Ingress: false,
      EnableIPv6: false,
      Labels: label,
      Containers: { [cid]: { Name: containerName, IPv4Address: "172.28.0.2/16" } }
    },
    volume: {
      Name: volumeName,
      Driver: "local",
      Mountpoint: volumePath,
      Options: null,
      Labels: label
    },
    postgres: {
      systemIdentifier: "7340000000000000001",
      serverVersionNum: 170011,
      serverAddress: "172.28.0.2",
      serverPort: 5432,
      databaseName: "postgres",
      databaseOid: "5",
      role: "release_provisioner",
      tls: true,
      clusterMarker: "subscription-s1-controlled/v1"
    }
  };
}

function applicationFixture(states = []) {
  const input = fixture();
  const identity = {
    operationRef,
    sourceSha: "7".repeat(40),
    postgresAddress: input.postgres.serverAddress,
    api: {
      imageDigest: `sha256:${"1".repeat(64)}`,
      imageReference: `ghcr.io/keqi119/subscription-api@sha256:${"1".repeat(64)}`
    },
    web: {
      imageDigest: `sha256:${"2".repeat(64)}`,
      imageReference: `ghcr.io/keqi119/subscription-web@sha256:${"2".repeat(64)}`
    },
    apiManifestId: "manifest01",
    apiSessionNonce: "session01",
    databaseName: "s1ci_test",
    runtimeRole: "s1_app"
  };
  const specs = applicationContainerSpecs(identity);
  const images = [];
  const containers = [];
  const imageObservations = [];
  const containerObservations = [];
  for (const [index, state] of states.entries()) {
    const role = ["api", "web", "browser"][index];
    const spec = specs[role];
    const heldImage = {
      role,
      reference: spec.body.Image,
      imageId: `sha256:${String(index + 3).repeat(64)}`
    };
    const rawImage = {
      Id: heldImage.imageId,
      Os: "linux",
      Architecture: "amd64",
      RepoDigests: [
        role === "browser"
          ? heldImage.reference.replace(":v1.62.1-noble@", "@")
          : heldImage.reference
      ],
      Config: {
        Labels:
          role === "browser" ? {} : { "org.opencontainers.image.revision": identity.sourceSha },
        Cmd: role === "browser" ? ["node", "tooling.js"] : spec.body.Cmd,
        Volumes: null,
        Env: ["NODE_ENV=production"]
      }
    };
    images.push(heldImage);
    imageObservations.push(rawImage);
    if (state === "image") continue;
    const id = String(index + 4).repeat(64);
    const address = `172.28.0.${index + 3}`;
    const heldContainer = {
      id,
      role,
      name: spec.name,
      state,
      imageId: rawImage.Id
    };
    const rawContainer = {
      Id: id,
      Name: `/${spec.name}`,
      Image: rawImage.Id,
      Config: {
        ...spec.body,
        Labels: { ...rawImage.Config.Labels, ...spec.body.Labels },
        Env: [
          ...new Map(
            [...rawImage.Config.Env, ...spec.body.Env].map((entry) => [
              entry.slice(0, entry.indexOf("=")),
              entry
            ])
          ).values()
        ],
        Volumes: null
      },
      HostConfig: { ...spec.body.HostConfig, Binds: null, Mounts: [], AutoRemove: false },
      Mounts: [],
      State: {
        Status: state,
        Running: state === "running",
        Paused: false,
        Restarting: false,
        Dead: false,
        OOMKilled: false,
        Error: "",
        Pid: state === "running" ? index + 322 : 0
      },
      NetworkSettings: {
        Networks: {
          [networkName]: {
            NetworkID: state === "running" ? input.network.Id : "",
            EndpointID: state === "running" ? String(index + 6).repeat(64) : "",
            IPAddress: state === "running" ? address : ""
          }
        },
        Ports: {}
      }
    };
    if (state === "running")
      input.network.Containers[id] = { Name: spec.name, IPv4Address: `${address}/16` };
    containers.push(heldContainer);
    containerObservations.push(rawContainer);
  }
  input.applicationResources = {
    identity,
    images,
    containers,
    imageObservations,
    containerObservations
  };
  input.engine.Containers = 1 + containers.length;
  input.engine.Images = 1 + images.length;
  input.containerInventory = [input.container, ...containerObservations].map((raw) => ({
    Id: raw.Id,
    Names: [raw.Name],
    ImageID: raw.Image,
    Image: raw.Config.Image,
    State: raw.Id === cid ? "running" : raw.State.Status,
    Labels: raw.Config.Labels
  }));
  input.imageInventory = [input.image, ...imageObservations].map((raw) => ({
    Id: raw.Id,
    RepoDigests: raw.RepoDigests
  }));
  return input;
}

test("R3 application observation accepts transitional held states through a running browser", () => {
  for (const states of [
    [],
    ["image"],
    ["created"],
    ["running"],
    ["running", "running"],
    ["running", "running", "image"],
    ["running", "running", "created"],
    ["running", "running", "running"]
  ]) {
    const input = applicationFixture(states);
    const observed = assessR3ApplicationPostgresObservation(input);
    assert.deepEqual(
      observed.applicationImageIds,
      input.applicationResources.images.map((x) => x.imageId)
    );
    assert.deepEqual(
      observed.applicationContainerIds,
      input.applicationResources.containers.map((x) => x.id)
    );
    assert.deepEqual(
      observed.applicationContainerAddresses,
      states
        .map((state, index) => (state === "running" ? `172.28.0.${index + 3}` : null))
        .filter(Boolean)
    );
    assert.equal(observed.sourceSha, input.applicationResources.identity.sourceSha);
    assert.equal(observed.promotionEligible, false);
    assert.ok(Object.isFrozen(observed));
  }
});

test("R3 application observation rejects foreign inventory, network, identity and unsafe containers", () => {
  const mutations = [
    (f) => f.containerInventory.push({ ...f.containerInventory[1], Id: "0".repeat(64) }),
    (f) => f.imageInventory.push({ Id: `sha256:${"0".repeat(64)}`, RepoDigests: [] }),
    (f) => {
      f.network.Containers["0".repeat(64)] = { Name: "foreign", IPv4Address: "172.28.0.9/16" };
    },
    (f) => {
      f.applicationResources.images[0].imageId = f.image.Id;
    },
    (f) => {
      f.applicationResources.identity.postgresAddress = "172.28.0.9";
    },
    (f) => {
      f.applicationResources.containerObservations[0].HostConfig.Binds = [
        "/var/run/docker.sock:/sock"
      ];
    },
    (f) => {
      f.applicationResources.containerObservations[0].Config.Env.push("DATABASE_URL=secret");
    },
    (f) => {
      f.applicationResources.containerObservations[0].NetworkSettings.Networks[
        networkName
      ].NetworkID = "0".repeat(64);
    },
    (f) => {
      f.network.Containers[f.applicationResources.containers[0].id].IPv4Address = "172.28.0.9/16";
    },
    (f) => {
      f.finalResources = {};
    }
  ];
  for (const mutate of mutations) {
    const input = applicationFixture(["running"]);
    mutate(input);
    assert.throws(() => assessR3ApplicationPostgresObservation(input), invalid);
  }
  const wrongBrowser = applicationFixture(["running", "running", "running"]);
  wrongBrowser.applicationResources.images[2].reference =
    wrongBrowser.applicationResources.identity.web.imageReference;
  assert.throws(() => assessR3ApplicationPostgresObservation(wrongBrowser), invalid);
  const missingBrowserMember = applicationFixture(["running", "running", "running"]);
  delete missingBrowserMember.network.Containers[
    missingBrowserMember.applicationResources.containers[2].id
  ];
  assert.throws(() => assessR3ApplicationPostgresObservation(missingBrowserMember), invalid);
  const browserSecret = applicationFixture(["running", "running", "running"]);
  browserSecret.applicationResources.imageObservations[2].Config.Env.push("DATABASE_URL=secret");
  assert.throws(() => assessR3ApplicationPostgresObservation(browserSecret), invalid);
  const browserPort = applicationFixture(["running", "running", "running"]);
  browserPort.applicationResources.containerObservations[2].NetworkSettings.Ports = {
    "8080/tcp": null
  };
  assert.throws(() => assessR3ApplicationPostgresObservation(browserPort), invalid);
});

test("R3 application PG readback binds independent PG output to held application inventory", () => {
  const resources = applicationFixture(["running", "running"]);
  const stream = (postgres) => {
    const encoded = Buffer.from(JSON.stringify(postgres));
    const header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(encoded.length, 4);
    return Buffer.concat([header, encoded]).toString("base64");
  };
  const readback = {
    resources,
    execution: { Id: "1".repeat(64) },
    streamBase64: stream(resources.postgres),
    completed: { ContainerID: cid, Running: false, ExitCode: 0 }
  };
  assert.deepEqual(assessR3ApplicationPostgresReadback(readback).applicationContainerAddresses, [
    "172.28.0.3",
    "172.28.0.4"
  ]);
  const forged = structuredClone(readback);
  forged.streamBase64 = stream({ ...resources.postgres, systemIdentifier: "7340000000000000002" });
  assert.throws(() => assessR3ApplicationPostgresReadback(forged), {
    code: "R3_DESTINATION_INVALID"
  });
});

const runnerCid = "d".repeat(64);
const migrationCid = "f".repeat(64);
const runnerDigest = `sha256:${"8".repeat(64)}`;
const runnerImageId = `sha256:${"9".repeat(64)}`;
const runnerReference = `registry.example.test/release-runner@${runnerDigest}`;
const sourceSha = "7".repeat(40);
const roleLabel = "com.subscription.release.container-role";
function finalFixture(withMigration = true, runtimeState = "running") {
  const input = fixture();
  const makeContainer = (role, containerId, address) => {
    const name = `s1r3${role === "runtime" ? "runner" : "migrate"}_${id}`;
    const labels = { "org.opencontainers.image.revision": sourceSha, ...label, [roleLabel]: role };
    const container = {
      Id: containerId,
      Name: `/${name}`,
      Image: runnerImageId,
      Config: {
        Image: runnerReference,
        Labels: labels,
        Entrypoint: ["/usr/local/bin/node", "/app/apps/release-runner/src/cli.mjs"],
        Cmd: [],
        WorkingDir: "/app",
        User: "1000:1000",
        Tty: false,
        OpenStdin: true,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        StdinOnce: false,
        ExposedPorts: { "5432/tcp": {} },
        Volumes: { "/var/lib/postgresql/data": {} },
        Env: [`RUNNER_EXECUTION_MODE=r3-final-${role === "runtime" ? "runtime" : "migration"}`]
      },
      State: {
        Status: "running",
        Running: true,
        Paused: false,
        Restarting: false,
        Dead: false,
        Pid: role === "runtime" ? 322 : 323
      },
      HostConfig: {
        Privileged: false,
        ReadonlyRootfs: true,
        Init: true,
        RestartPolicy: { Name: "no" },
        PublishAllPorts: false,
        CapDrop: ["ALL"],
        CapAdd: null,
        SecurityOpt: ["no-new-privileges:true"],
        PidMode: "",
        IpcMode: "private",
        NetworkMode: networkName,
        Binds: null,
        Mounts: [],
        VolumesFrom: null,
        Devices: [],
        DeviceRequests: null,
        PortBindings: {},
        ExtraHosts: [`postgres:${input.postgres.serverAddress}`],
        Tmpfs: {
          "/tmp": "rw,nosuid,nodev,noexec,size=268435456,mode=1777",
          "/var/lib/postgresql/data":
            "rw,nosuid,nodev,noexec,size=65536,mode=0700,uid=1000,gid=1000",
          ...(role === "runtime"
            ? {
                "/app/.release-local":
                  "rw,nosuid,nodev,noexec,size=33554432,mode=0700,uid=1000,gid=1000",
                "/run/launch": "rw,nosuid,nodev,noexec,size=1048576,mode=0700,uid=1000,gid=1000",
                "/run/secrets": "rw,nosuid,nodev,noexec,size=1048576,mode=0700,uid=1000,gid=1000"
              }
            : {})
        },
        PidsLimit: 256,
        Memory: 1073741824,
        MemorySwap: 1073741824
      },
      Mounts: [],
      NetworkSettings: {
        Networks: { [networkName]: { NetworkID: input.network.Id, IPAddress: address } },
        Ports: { "5432/tcp": null }
      }
    };
    input.network.Containers[containerId] = { Name: name, IPv4Address: `${address}/16` };
    return container;
  };
  const containers = [makeContainer("runtime", runnerCid, "172.28.0.3")];
  if (withMigration) containers.push(makeContainer("migration", migrationCid, "172.28.0.4"));
  input.engine.Containers = containers.length + 1;
  input.engine.Images = 2;
  input.finalResources = {
    containers,
    image: {
      Id: runnerImageId,
      Os: "linux",
      Architecture: "amd64",
      RepoDigests: [runnerReference],
      Config: {
        Labels: { "org.opencontainers.image.revision": sourceSha },
        Volumes: { "/var/lib/postgresql/data": {} },
        ExposedPorts: { "5432/tcp": {} }
      }
    },
    imageDigest: runnerDigest,
    imageReference: runnerReference,
    runnerContainerId: runnerCid,
    runtimeState,
    sourceSha,
    ...(withMigration ? { migrationContainerId: migrationCid } : {})
  };
  input.containerInventory = [input.container, ...containers].map((entry) => ({
    Id: entry.Id,
    Names: [entry.Name],
    ImageID: entry.Image,
    Image: entry.Config.Image,
    Labels: entry.Config.Labels,
    State: "running"
  }));
  input.imageInventory = [input.image, input.finalResources.image].map((entry) => ({
    Id: entry.Id,
    RepoDigests: entry.RepoDigests
  }));
  if (runtimeState === "created") {
    const runtime = containers[0];
    runtime.State = {
      Status: "created",
      Running: false,
      Paused: false,
      Restarting: false,
      Dead: false,
      Pid: 0
    };
    runtime.NetworkSettings.Networks[networkName] = {
      NetworkID: "",
      IPAddress: "",
      EndpointID: ""
    };
    runtime.NetworkSettings.Ports = {};
    delete input.network.Containers[runnerCid];
    input.containerInventory[1].State = "created";
  }
  return input;
}

test("R3 final observation accepts only a held created runtime outside network membership", () => {
  const input = finalFixture(true, "created");
  const result = assessR3FinalPostgresObservation(input);
  assert.equal(result.runtimeState, "created");
  assert.deepEqual(result.finalContainerAddresses, ["172.28.0.4"]);
  for (const mutate of [
    (f) => {
      f.network.Containers[runnerCid] = { Name: `s1r3runner_${id}`, IPv4Address: "172.28.0.3/16" };
    },
    (f) => {
      f.finalResources.containers[0].NetworkSettings.Networks[networkName].IPAddress = "172.28.0.3";
    },
    (f) => {
      f.finalResources.containers[0].NetworkSettings.Networks[networkName].NetworkID = f.network.Id;
    },
    (f) => {
      f.finalResources.containers[0].NetworkSettings.Ports = { "5432/tcp": null };
    },
    (f) => {
      f.finalResources.containers[1].State.Status = "created";
      f.finalResources.containers[1].State.Running = false;
    },
    (f) => {
      f.finalResources.runtimeState = "running";
    }
  ]) {
    const foreign = finalFixture(true, "created");
    mutate(foreign);
    assert.throws(() => assessR3FinalPostgresObservation(foreign), invalid);
  }
});

test("R3 final observation binds the exact PG/runtime/migration Engine inventory", () => {
  for (const withMigration of [false, true]) {
    const input = finalFixture(withMigration);
    if (withMigration) input.finalResources.containers[1].Config.Cmd = null;
    if (withMigration)
      input.finalResources.containers[1].Mounts = [
        { Type: "tmpfs", Destination: "/tmp", RW: true },
        { Type: "tmpfs", Destination: "/var/lib/postgresql/data", RW: true }
      ];
    const result = assessR3FinalPostgresObservation(input);
    assert.equal(result.containerId, cid);
    assert.equal(result.runnerContainerId, runnerCid);
    assert.equal(result.migrationContainerId, withMigration ? migrationCid : null);
    assert.ok(Object.isFrozen(result));
    assert.throws(() => assessR3PostgresObservation(input), invalid);
  }
});

test("R3 final observation rejects foreign CID or image inventory", () => {
  for (const mutate of [
    (f) => {
      f.containerInventory.push({ ...f.containerInventory[1], Id: "0".repeat(64) });
    },
    (f) => {
      f.network.Containers["0".repeat(64)] = { Name: "foreign", IPv4Address: "172.28.0.5/16" };
    },
    (f) => {
      f.finalResources.containers[1].Id = "0".repeat(64);
    },
    (f) => {
      f.imageInventory.push({ Id: `sha256:${"0".repeat(64)}`, RepoDigests: [] });
    },
    (f) => {
      f.finalResources.containers[0].HostConfig.Binds = [
        "/var/run/docker.sock:/var/run/docker.sock"
      ];
    },
    (f) => {
      f.finalResources.containers[1].Config.Env.push("POSTGRES_PASSWORD_FILE=/run/secret");
    },
    (f) => {
      f.finalResources.containers[0].Config.Volumes = { "/foreign": {} };
    },
    (f) => {
      f.finalResources.image.Config.ExposedPorts = { "8080/tcp": {} };
    },
    (f) => {
      f.engine.Containers += 1;
    },
    (f) => {
      f.finalResources.containers[0].Config.Env = ["RUNNER_EXECUTION_MODE=r3-final-migration"];
    },
    (f) => {
      delete f.finalResources.containers[0].HostConfig.Tmpfs["/run/secrets"];
    },
    (f) => {
      f.finalResources.containers[0].Mounts.push({
        Type: "bind",
        Source: "/tmp/foreign",
        Destination: "/run/secrets",
        RW: true
      });
    }
  ]) {
    const input = finalFixture();
    mutate(input);
    assert.throws(() => assessR3FinalPostgresObservation(input), invalid);
  }
});

test("R3 final PG readback ties the independent container stream to the held final Engine", () => {
  const resources = finalFixture();
  const encoded = Buffer.from(JSON.stringify(resources.postgres));
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(encoded.length, 4);
  const readback = {
    resources,
    execution: { Id: "1".repeat(64) },
    streamBase64: Buffer.concat([header, encoded]).toString("base64"),
    completed: { ContainerID: cid, Running: false, ExitCode: 0 }
  };
  const observed = assessR3FinalPostgresReadback(readback);
  assert.equal(observed.runnerContainerId, runnerCid);
  assert.equal(observed.migrationContainerId, migrationCid);
  assert.equal(observed.postgres.systemIdentifier, resources.postgres.systemIdentifier);

  const wrong = structuredClone(readback);
  wrong.completed.ContainerID = runnerCid;
  assert.throws(() => assessR3FinalPostgresReadback(wrong), { code: "R3_DESTINATION_INVALID" });
  const forged = structuredClone(readback);
  const altered = Buffer.from(
    JSON.stringify({
      ...resources.postgres,
      systemIdentifier: "7340000000000000002"
    })
  );
  header.writeUInt32BE(altered.length, 4);
  forged.streamBase64 = Buffer.concat([header, altered]).toString("base64");
  assert.throws(() => assessR3FinalPostgresReadback(forged), { code: "R3_DESTINATION_INVALID" });
});

test("R3 POSTGRES binds one encrypted Engine, private network, volume and TLS cluster", () => {
  const input = fixture();
  const resources = assessR3PostgresResources(input);
  assert.equal(resources.containerAddress, input.postgres.serverAddress);
  assert.equal(resources.transport, "hosted-loopback-relay");
  assert.equal(resources.hostAddress, "127.0.0.1");
  assert.equal(resources.hostPort, 55441);
  assert.equal(Object.hasOwn(resources, "postgres"), false);
  assert.ok(Object.isFrozen(resources));
  const result = assessR3PostgresObservation(input);
  assert.equal(result.engineId, "engine-synthetic");
  assert.equal(result.containerId, cid);
  assert.equal(result.networkId, "c".repeat(64));
  assert.equal(result.volumeName, volumeName);
  assert.equal(result.hostPort, 55441);
  assert.equal(result.transport, "hosted-loopback-relay");
  assert.equal(result.postgres.systemIdentifier, "7340000000000000001");
  assert.equal(result.promotionEligible, false);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.postgres));
});

test("R3 POSTGRES rejects wrong Engine, image identity or ownership", () => {
  for (const mutate of [
    (f) => {
      f.engine.ID = "other";
    },
    (f) => {
      f.engine.Driver = "btrfs";
    },
    (f) => {
      f.image.RepoDigests = [];
    },
    (f) => {
      f.container.Image = `sha256:${"d".repeat(64)}`;
    },
    (f) => {
      f.container.Config.Labels = {};
    }
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => assessR3PostgresObservation(f), invalid);
  }
});

test("R3 POSTGRES rejects port, network, volume and bind substitutions", () => {
  for (const mutate of [
    (f) => {
      f.container.HostConfig.PortBindings = {
        "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55441" }]
      };
    },
    (f) => {
      f.container.NetworkSettings.Ports = {
        "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55441" }]
      };
    },
    (f) => {
      f.network.Internal = false;
    },
    (f) => {
      f.container.NetworkSettings.Networks.other = {};
    },
    (f) => {
      f.volume.Mountpoint = "/var/lib/docker/volumes/other/_data";
    },
    (f) => {
      f.container.Mounts.push({ Type: "bind", Source: "/tmp", Destination: "/tmp" });
    }
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => assessR3PostgresResources(f), invalid);
    assert.throws(() => assessR3PostgresObservation(f), invalid);
  }
});

test("R3 POSTGRES refuses non-TLS, wrong server address and inconsistent PG identity", () => {
  for (const mutate of [
    (f) => {
      f.postgres.tls = false;
    },
    (f) => {
      f.postgres.serverAddress = "127.0.0.1";
    },
    (f) => {
      f.postgres.serverVersionNum = 160020;
    },
    (f) => {
      f.postgres.databaseOid = "0";
    },
    (f) => {
      f.postgres.clusterMarker = "unknown";
    }
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => assessR3PostgresObservation(f), invalid);
  }
});
