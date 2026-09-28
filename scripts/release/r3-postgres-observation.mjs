// Pure consistency check for one observed PG17 container in the admitted Engine.
// The resulting facts grant neither destination use nor cleanup authority.
const CODE = "R3_POSTGRES_OBSERVATION_INVALID";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const CID = /^[0-9a-f]{64}$/u;
const DECIMAL = /^[1-9][0-9]*$/u;
const IPV4 = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/u;
const LABEL = "com.subscription.release.operation-ref";
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const need = (value) => {
  if (!value) fail();
};
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function keys(value, expected) {
  need(
    object(value) &&
      Reflect.ownKeys(value).length === expected.length &&
      expected.every((name) => Object.hasOwn(value, name))
  );
}
function labeled(value, operationRef) {
  need(object(value?.Labels) && value.Labels[LABEL] === operationRef);
}
function unpublished(value, hostConfig = false) {
  if (hostConfig) need(value === null || (object(value) && Reflect.ownKeys(value).length === 0));
  else
    need(
      object(value) &&
        (Reflect.ownKeys(value).length === 0 ||
          (Reflect.ownKeys(value).length === 1 &&
            Object.hasOwn(value, "5432/tcp") &&
            value["5432/tcp"] === null))
    );
}
function freeze(value) {
  if (object(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function ipv4(value) {
  if (typeof value !== "string" || !IPV4.test(value)) return false;
  return value
    .split(".")
    .every((part) => Number(part) <= 255 && (part === "0" || !part.startsWith("0")));
}

export function assessR3PostgresResources({
  operationRef,
  workspaceMountPath,
  engineId,
  imageDigest,
  engine,
  image,
  container,
  network,
  volume
}) {
  try {
    need(
      UUID.test(operationRef) &&
        DIGEST.test(imageDigest) &&
        typeof engineId === "string" &&
        engineId.length > 0
    );
    const id = operationRef.replaceAll("-", ""),
      containerName = `s1r3pg_${id}`,
      networkName = `s1r3net_${id}`,
      volumeName = `s1r3data_${id}`;
    need(workspaceMountPath === `/srv/stage1-snapshot/${id}`);
    const dataRoot = `${workspaceMountPath}/docker`,
      volumePath = `${dataRoot}/volumes/${volumeName}/_data`;
    need(
      engine?.ID === engineId &&
        engine.Driver === "overlay2" &&
        engine.LoggingDriver === "json-file" &&
        engine.DockerRootDir === dataRoot
    );
    need(
      DIGEST.test(image?.Id) &&
        image.Os === "linux" &&
        image.Architecture === "amd64" &&
        Array.isArray(image.RepoDigests) &&
        image.RepoDigests.some(
          (value) =>
            value === `postgres@${imageDigest}` ||
            value === `docker.io/library/postgres@${imageDigest}`
        )
    );
    need(
      CID.test(container?.Id) &&
        container.Name === `/${containerName}` &&
        container.Image === image.Id &&
        container.Config?.Image === `postgres:17-bookworm@${imageDigest}`
    );
    labeled(container.Config, operationRef);
    need(
      container.State?.Running === true &&
        container.State.Paused === false &&
        container.State.Restarting === false &&
        container.State.Dead === false &&
        Number.isSafeInteger(container.State.Pid) &&
        container.State.Pid > 0
    );
    need(
      container.HostConfig?.Privileged === false &&
        !["host", "container"].includes(container.HostConfig.PidMode) &&
        ["", "private", undefined].includes(container.HostConfig.PidMode) &&
        container.HostConfig.NetworkMode === networkName &&
        (container.HostConfig.Binds === null ||
          (Array.isArray(container.HostConfig.Binds) && container.HostConfig.Binds.length === 0))
    );
    unpublished(container.HostConfig.PortBindings, true);
    unpublished(container.NetworkSettings?.Ports);
    keys(container.NetworkSettings.Networks, [networkName]);
    const attachment = container.NetworkSettings.Networks[networkName];
    need(
      CID.test(network?.Id) &&
        network.Name === networkName &&
        network.Driver === "bridge" &&
        network.Internal === true &&
        network.Ingress === false &&
        network.EnableIPv6 === false &&
        attachment?.NetworkID === network.Id &&
        ipv4(attachment.IPAddress)
    );
    labeled(network, operationRef);
    keys(network.Containers, [container.Id]);
    const member = network.Containers[container.Id];
    const cidr = typeof member?.IPv4Address === "string" ? member.IPv4Address.split("/") : [];
    need(
      member?.Name === containerName &&
        cidr.length === 2 &&
        cidr[0] === attachment.IPAddress &&
        /^[1-9][0-9]?$/u.test(cidr[1]) &&
        Number(cidr[1]) <= 32
    );
    need(Array.isArray(container.Mounts) && container.Mounts.length === 1);
    const mount = container.Mounts[0];
    need(
      mount.Type === "volume" &&
        mount.Name === volumeName &&
        mount.Source === volumePath &&
        mount.Destination === "/var/lib/postgresql/data" &&
        mount.Driver === "local" &&
        mount.RW === true
    );
    need(
      volume?.Name === volumeName &&
        volume.Driver === "local" &&
        volume.Mountpoint === volumePath &&
        (volume.Options === null ||
          volume.Options === undefined ||
          (object(volume.Options) && Reflect.ownKeys(volume.Options).length === 0))
    );
    labeled(volume, operationRef);
    return freeze({
      operationRef,
      engineId,
      imageDigest,
      imageId: image.Id,
      containerId: container.Id,
      containerName,
      networkId: network.Id,
      networkName,
      containerAddress: attachment.IPAddress,
      volumeName,
      volumeMountpoint: volumePath,
      workspaceMountPath,
      hostAddress: "127.0.0.1",
      hostPort: 55441,
      postgresPort: 5432,
      transport: "hosted-loopback-relay",
      promotionEligible: false
    });
  } catch {
    fail();
  }
}

export function assessR3PostgresObservation(input) {
  try {
    const resources = assessR3PostgresResources(input);
    const postgres = input?.postgres;
    need(
      object(postgres) &&
        typeof postgres.systemIdentifier === "string" &&
        DECIMAL.test(postgres.systemIdentifier) &&
        Number.isSafeInteger(postgres.serverVersionNum) &&
        postgres.serverVersionNum >= 170000 &&
        postgres.serverVersionNum < 180000 &&
        postgres.serverAddress === resources.containerAddress &&
        postgres.serverPort === 5432 &&
        postgres.databaseName === "postgres" &&
        typeof postgres.databaseOid === "string" &&
        DECIMAL.test(postgres.databaseOid) &&
        postgres.role === "release_provisioner" &&
        postgres.tls === true &&
        postgres.clusterMarker === "subscription-s1-controlled/v1"
    );
    return freeze({
      ...resources,
      postgres: {
        systemIdentifier: postgres.systemIdentifier,
        serverVersionNum: postgres.serverVersionNum,
        serverAddress: postgres.serverAddress,
        serverPort: postgres.serverPort,
        databaseName: postgres.databaseName,
        databaseOid: postgres.databaseOid,
        role: postgres.role,
        tls: true,
        clusterMarker: postgres.clusterMarker
      }
    });
  } catch {
    fail();
  }
}
