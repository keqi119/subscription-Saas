// Synthetic, signed-creation-bound cleanup input for codec/native unit tests.
// This constructs observations only; it does not perform cleanup or sign them.
import { encodeManualJson } from "../src/manual-stage1-contracts.mjs";
import { sha256Bytes } from "../src/digest.mjs";
import { assessR3PostgresResources } from "../../../scripts/release/r3-postgres-observation.mjs";

const ref = (bytes) => ({ digest: sha256Bytes(bytes), bytes: bytes.length });
const rawJson = (value) => Buffer.from(JSON.stringify(value) + "\n");
const copy = (value) => JSON.parse(JSON.stringify(value));
const stamp = (base, offset) => new Date(base + offset).toISOString();

export function r3CleanupFixture({
  spec,
  jobAdmissionBytes,
  creationEvidenceBytes,
  activeObservation,
  activeRawInputs,
  absentObservation,
  absentRawInputs,
  imageDigest,
  startedAt
}) {
  const base = Date.parse(startedAt);
  if (
    !Number.isFinite(base) ||
    new Date(base).toISOString() !== startedAt ||
    base < Date.parse(activeObservation.finishedAt)
  )
    throw new Error("R3_CLEANUP_FIXTURE_TIME_INVALID");
  const creation = JSON.parse(creationEvidenceBytes);
  const engine = creation.engine;
  if (base < Date.parse(engine.process.startedAt))
    throw new Error("R3_CLEANUP_FIXTURE_TIME_INVALID");
  const operationRef = spec.operationRef;
  const workspace = spec.workspace;
  const id = operationRef.replaceAll("-", "");
  const imageId = `sha256:${"e".repeat(64)}`;
  const cid = "b".repeat(64);
  const nid = "c".repeat(64);
  const containerName = `s1r3pg_${id}`;
  const networkName = `s1r3net_${id}`;
  const volumeName = `s1r3data_${id}`;
  const labels = { "com.subscription.release.operation-ref": operationRef };
  const volumePath = `${workspace.mountPath}/docker/volumes/${volumeName}/_data`;
  const pgRaw = {
    info: { ...engine.info, Containers: 1, Images: 1 },
    image: {
      Id: imageId,
      RepoDigests: [`postgres@${imageDigest}`],
      Os: "linux",
      Architecture: "amd64"
    },
    container: {
      Id: cid,
      Name: `/${containerName}`,
      Image: imageId,
      Config: { Image: `postgres:17-bookworm@${imageDigest}`, Labels: labels },
      State: {
        Status: "running",
        Running: true,
        Paused: false,
        Restarting: false,
        Dead: false,
        Pid: Math.max(engine.process.pid, engine.containerd.pid) + 1
      },
      HostConfig: {
        Privileged: false,
        PidMode: "",
        NetworkMode: networkName,
        Binds: null,
        PortBindings: {}
      },
      NetworkSettings: {
        Ports: { "5432/tcp": null },
        Networks: { [networkName]: { NetworkID: nid, IPAddress: "127.0.0.2" } }
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
      Id: nid,
      Name: networkName,
      Driver: "bridge",
      Internal: true,
      Ingress: false,
      EnableIPv6: false,
      Labels: labels,
      Containers: { [cid]: { Name: containerName, IPv4Address: "127.0.0.2/8" } }
    },
    volume: {
      Name: volumeName,
      Driver: "local",
      Mountpoint: volumePath,
      Options: null,
      Labels: labels
    }
  };
  const postgres = assessR3PostgresResources({
    operationRef,
    workspaceMountPath: workspace.mountPath,
    engineId: engine.id,
    imageDigest,
    engine: pgRaw.info,
    image: pgRaw.image,
    container: pgRaw.container,
    network: pgRaw.network,
    volume: pgRaw.volume
  });
  const rawInputs = Object.fromEntries(
    Object.entries(pgRaw).map(([name, value]) => [`before.${name}`, rawJson(value)])
  );
  const requestRows = [
    ["stop-container", "POST", `/containers/${cid}/stop?t=10`, 204, Buffer.alloc(0)],
    [
      "stopped-container",
      "GET",
      `/containers/${cid}/json`,
      200,
      rawJson({
        ...pgRaw.container,
        State: {
          Status: "exited",
          Running: false,
          Paused: false,
          Restarting: false,
          Dead: false,
          Pid: 0,
          ExitCode: 0
        }
      })
    ],
    ["remove-container", "DELETE", `/containers/${cid}?v=false&force=false`, 204, Buffer.alloc(0)],
    ["absent-container", "GET", `/containers/${cid}/json`, 404, Buffer.alloc(0)],
    ["remove-network", "DELETE", `/networks/${nid}`, 204, Buffer.alloc(0)],
    ["absent-network", "GET", `/networks/${nid}`, 404, Buffer.alloc(0)],
    ["remove-volume", "DELETE", `/volumes/${volumeName}?force=false`, 204, Buffer.alloc(0)],
    ["absent-volume", "GET", `/volumes/${volumeName}`, 404, Buffer.alloc(0)],
    [
      "remove-image",
      "DELETE",
      `/images/${encodeURIComponent(imageId)}?force=false&noprune=true`,
      200,
      rawJson([{ Deleted: imageId }])
    ],
    ["absent-image", "GET", `/images/${encodeURIComponent(imageId)}/json`, 404, Buffer.alloc(0)],
    ["empty-engine", "GET", "/info", 200, rawJson(engine.info)]
  ];
  const requests = requestRows.map(([name, method, route, status, response], index) => {
    rawInputs[name] = response;
    return {
      name,
      method,
      path: `/v1.45${route}`,
      startedAt: stamp(base, index * 100),
      finishedAt: stamp(base, index * 100 + 50),
      status,
      response: ref(response)
    };
  });
  const after = copy(absentObservation);
  const shift = base + 7000 - Date.parse(after.startedAt);
  const shifted = (value) => new Date(Date.parse(value) + shift).toISOString();
  after.startedAt = shifted(after.startedAt);
  after.finishedAt = shifted(after.finishedAt);
  for (const row of after.files) row.observedAt = shifted(row.observedAt);
  for (const row of after.processes) {
    row.startedAt = shifted(row.startedAt);
    row.closedAt = shifted(row.closedAt);
  }
  const workspaceRaw = {
    ...Object.fromEntries(
      Object.entries(activeRawInputs).map(([name, bytes]) => [`before.${name}`, Buffer.from(bytes)])
    ),
    "cleanup.unmount.stdout": Buffer.alloc(0),
    "cleanup.unmount.stderr": Buffer.alloc(0),
    "cleanup.luksClose.stdout": Buffer.alloc(0),
    "cleanup.luksClose.stderr": Buffer.alloc(0),
    ...Object.fromEntries(
      Object.entries(absentRawInputs).map(([name, bytes]) => [`after.${name}`, Buffer.from(bytes)])
    )
  };
  const executable = activeObservation.processes[0].executable;
  const cleanupProcess = (name, command, args, offset) => ({
    name,
    command,
    args,
    executable: copy(executable),
    startedAt: stamp(base, offset),
    pid: 5000 + offset,
    closedAt: stamp(base, offset + 50),
    exitCode: 0,
    signal: null,
    stdout: ref(workspaceRaw[`cleanup.${name}.stdout`]),
    stderr: ref(workspaceRaw[`cleanup.${name}.stderr`])
  });
  const workspaceFinished = Math.max(base + 8500, Date.parse(after.finishedAt) + 500);
  return {
    operationRef,
    creationSpecDigest: sha256Bytes(encodeManualJson(spec)),
    jobAdmissionDigest: sha256Bytes(jobAdmissionBytes),
    status: "TARGET_REMOVED",
    startedAt,
    finishedAt: stamp(workspaceFinished, 1500),
    postgres,
    engine: {
      id: engine.id,
      process: copy(engine.process),
      containerd: copy(engine.containerd),
      exit: { pid: engine.process.pid, exitCode: 0, signal: null, closedAt: stamp(base, 2000) }
    },
    requests,
    processAbsence: [engine.process.pid, engine.containerd.pid].map((pid, index) => ({
      path: `/proc/${pid}`,
      code: "ENOENT",
      observedAt: stamp(base, 2100 + index * 100)
    })),
    workspace: {
      cleanup: {
        operationRef,
        promotionEligible: false,
        status: "WORKSPACE_REMOVED",
        startedAt: stamp(base, 6000),
        finishedAt: new Date(workspaceFinished).toISOString(),
        ownedPaths: [
          workspace.keyFile,
          workspace.backingFile,
          `/dev/mapper/${workspace.mapperName}`,
          workspace.mountPath
        ],
        processes: [
          cleanupProcess("unmount", "/usr/bin/umount", [workspace.mountPath], 6100),
          cleanupProcess("luksClose", "/usr/sbin/cryptsetup", ["close", workspace.mapperName], 6300)
        ]
      },
      observation: {
        observation: after,
        observationDigest: sha256Bytes(encodeManualJson(after)),
        rawInputs: Object.fromEntries(
          Object.entries(absentRawInputs).map(([name, bytes]) => [name, Buffer.from(bytes)])
        )
      },
      rawInputs: workspaceRaw
    },
    rawInputs,
    promotionEligible: false
  };
}
