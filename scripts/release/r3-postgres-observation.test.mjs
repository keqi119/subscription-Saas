import assert from "node:assert/strict";
import test from "node:test";
import {
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
