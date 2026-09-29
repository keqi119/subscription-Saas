import assert from "node:assert/strict";
import test from "node:test";
import {
  assessR3FinalPostgresObservation,
  assessR3PostgresObservation,
  assessR3PostgresResources
} from "./r3-postgres-observation.mjs";

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
        Env: role === "migration" ? ["RUNNER_EXECUTION_MODE=r3-final-migration"] : []
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
            "rw,nosuid,nodev,noexec,size=65536,mode=0700,uid=1000,gid=1000"
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
    }
  ]) {
    const input = finalFixture();
    mutate(input);
    assert.throws(() => assessR3FinalPostgresObservation(input), invalid);
  }
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
