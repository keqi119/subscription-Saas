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

// Final-only inventory check for already-running runner containers. H1 must
// independently bind these observed IDs to its private creation registry.
export function assessR3FinalPostgresObservation(input) {
  try {
    const final = input?.finalResources;
    keys(final, [
      "containers",
      "image",
      "imageDigest",
      "imageReference",
      "runnerContainerId",
      "sourceSha",
      ...(Object.hasOwn(final ?? {}, "migrationContainerId") ? ["migrationContainerId"] : [])
    ]);
    need(
      CID.test(final.runnerContainerId) &&
        (final.migrationContainerId === undefined || CID.test(final.migrationContainerId)) &&
        final.runnerContainerId !== final.migrationContainerId &&
        final.runnerContainerId !== input.container?.Id &&
        final.migrationContainerId !== input.container?.Id &&
        /^[0-9a-f]{40}$/u.test(final.sourceSha) &&
        DIGEST.test(final.imageDigest) &&
        typeof final.imageReference === "string" &&
        /^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$/u.test(final.imageReference) &&
        final.imageReference.endsWith(`@${final.imageDigest}`) &&
        Array.isArray(final.containers) &&
        final.containers.length === (final.migrationContainerId ? 2 : 1)
    );
    const expectedIds = [
      input.container.Id,
      final.runnerContainerId,
      ...(final.migrationContainerId ? [final.migrationContainerId] : [])
    ];
    need(new Set(expectedIds).size === expectedIds.length);
    need(input.engine?.Containers === expectedIds.length && input.engine.Images === 2);
    keys(input.network?.Containers, expectedIds);
    // The PG-only exported assessor remains strict. Project only its own
    // network membership here; the complete original membership is checked
    // above and for each final container below.
    const postgres = assessR3PostgresObservation({
      ...input,
      network: {
        ...input.network,
        Containers: { [input.container.Id]: input.network.Containers[input.container.Id] }
      }
    });
    const empty = (value) =>
      value == null ||
      (Array.isArray(value) && value.length === 0) ||
      (object(value) && Reflect.ownKeys(value).length === 0);
    need(
      DIGEST.test(final.image?.Id) &&
        final.image.Id !== input.image.Id &&
        final.image.Os === "linux" &&
        final.image.Architecture === "amd64" &&
        Array.isArray(final.image.RepoDigests) &&
        final.image.RepoDigests.includes(final.imageReference) &&
        final.image.Config?.Labels?.["org.opencontainers.image.revision"] === final.sourceSha &&
        object(final.image.Config.Volumes) &&
        Reflect.ownKeys(final.image.Config.Volumes).length === 1 &&
        Object.hasOwn(final.image.Config.Volumes, "/var/lib/postgresql/data") &&
        empty(final.image.Config.Volumes["/var/lib/postgresql/data"]) &&
        object(final.image.Config.ExposedPorts) &&
        Reflect.ownKeys(final.image.Config.ExposedPorts).length === 1 &&
        Object.hasOwn(final.image.Config.ExposedPorts, "5432/tcp") &&
        empty(final.image.Config.ExposedPorts["5432/tcp"])
    );
    const opId = input.operationRef.replaceAll("-", "");
    const names = [
      `s1r3runner_${opId}`,
      ...(final.migrationContainerId ? [`s1r3migrate_${opId}`] : [])
    ];
    const ids = [
      final.runnerContainerId,
      ...(final.migrationContainerId ? [final.migrationContainerId] : [])
    ];
    const addresses = new Set([postgres.containerAddress]);
    const pids = new Set([input.container.State.Pid]);
    const labels = (role) => ({
      ...final.image.Config.Labels,
      [LABEL]: input.operationRef,
      "com.subscription.release.container-role": role
    });
    const safeEnv = (entries, role) =>
      Array.isArray(entries) &&
      entries.every((item) => {
        if (typeof item !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(item)) return false;
        const name = item.slice(0, item.indexOf("="));
        return !/(?:PASSWORD|PASSFILE|SECRET|TOKEN|DATABASE_URL|DIRECT_URL|DOCKER_HOST|NODE_OPTIONS)/iu.test(
          name
        );
      }) &&
      new Set(entries.map((item) => item.slice(0, item.indexOf("=")))).size === entries.length &&
      (role !== "migration" || entries.includes("RUNNER_EXECUTION_MODE=r3-final-migration"));
    for (const [index, container] of final.containers.entries()) {
      const role = index === 0 ? "runtime" : "migration";
      const expectedLabels = labels(role);
      const host = container?.HostConfig;
      const config = container?.Config;
      const state = container?.State;
      need(
        container?.Id === ids[index] &&
          container.Name === `/${names[index]}` &&
          container.Image === final.image.Id &&
          config?.Image === final.imageReference &&
          object(config.Labels) &&
          Reflect.ownKeys(config.Labels).length === Reflect.ownKeys(expectedLabels).length &&
          Object.entries(expectedLabels).every(([key, value]) => config.Labels[key] === value) &&
          JSON.stringify(config.Entrypoint) ===
            JSON.stringify(["/usr/local/bin/node", "/app/apps/release-runner/src/cli.mjs"]) &&
          (config.Cmd === null || (Array.isArray(config.Cmd) && config.Cmd.length === 0)) &&
          config.WorkingDir === "/app" &&
          config.User === "1000:1000" &&
          config.Tty === false &&
          config.OpenStdin === true &&
          config.AttachStdin === true &&
          config.AttachStdout === true &&
          config.AttachStderr === true &&
          config.StdinOnce === false &&
          object(config.ExposedPorts) &&
          Reflect.ownKeys(config.ExposedPorts).length === 1 &&
          Object.hasOwn(config.ExposedPorts, "5432/tcp") &&
          empty(config.ExposedPorts["5432/tcp"]) &&
          object(config.Volumes) &&
          Reflect.ownKeys(config.Volumes).length === 1 &&
          Object.hasOwn(config.Volumes, "/var/lib/postgresql/data") &&
          empty(config.Volumes["/var/lib/postgresql/data"]) &&
          safeEnv(config.Env, role) &&
          state?.Running === true &&
          state.Paused === false &&
          state.Restarting === false &&
          state.Dead === false &&
          Number.isSafeInteger(state.Pid) &&
          state.Pid > 0 &&
          !pids.has(state.Pid) &&
          host?.Privileged === false &&
          host.ReadonlyRootfs === true &&
          host.Init === true &&
          host.RestartPolicy?.Name === "no" &&
          host.PublishAllPorts === false &&
          JSON.stringify(host.CapDrop) === '["ALL"]' &&
          empty(host.CapAdd) &&
          JSON.stringify(host.SecurityOpt) === '["no-new-privileges:true"]' &&
          ["", "private"].includes(host.PidMode) &&
          host.IpcMode === "private" &&
          host.NetworkMode === postgres.networkName &&
          empty(host.Binds) &&
          empty(host.Mounts) &&
          empty(host.VolumesFrom) &&
          empty(host.Devices) &&
          empty(host.DeviceRequests) &&
          empty(host.PortBindings) &&
          Array.isArray(container.Mounts) &&
          container.Mounts.length <= 2 &&
          new Set(container.Mounts.map((mount) => mount.Destination)).size ===
            container.Mounts.length &&
          container.Mounts.every(
            (mount) =>
              mount.Type === "tmpfs" &&
              mount.RW === true &&
              ["/tmp", "/var/lib/postgresql/data"].includes(mount.Destination)
          ) &&
          object(container.NetworkSettings?.Ports) &&
          Reflect.ownKeys(container.NetworkSettings.Ports).length === 1 &&
          container.NetworkSettings.Ports["5432/tcp"] === null &&
          JSON.stringify(host.ExtraHosts) ===
            JSON.stringify([`postgres:${postgres.containerAddress}`]) &&
          object(host.Tmpfs) &&
          Reflect.ownKeys(host.Tmpfs).length === 2 &&
          host.Tmpfs["/tmp"] === "rw,nosuid,nodev,noexec,size=268435456,mode=1777" &&
          host.Tmpfs["/var/lib/postgresql/data"] ===
            "rw,nosuid,nodev,noexec,size=65536,mode=0700,uid=1000,gid=1000" &&
          host.PidsLimit === 256 &&
          host.Memory === 1073741824 &&
          host.MemorySwap === 1073741824
      );
      pids.add(state.Pid);
      keys(container.NetworkSettings.Networks, [postgres.networkName]);
      const attachment = container.NetworkSettings.Networks[postgres.networkName];
      const member = input.network.Containers[container.Id];
      need(
        attachment?.NetworkID === postgres.networkId &&
          ipv4(attachment.IPAddress) &&
          !addresses.has(attachment.IPAddress) &&
          member?.Name === names[index] &&
          typeof member.IPv4Address === "string" &&
          member.IPv4Address.startsWith(`${attachment.IPAddress}/`) &&
          /^[1-9][0-9]?$/u.test(member.IPv4Address.split("/")[1] ?? "") &&
          Number(member.IPv4Address.split("/")[1]) <= 32
      );
      addresses.add(attachment.IPAddress);
    }
    need(
      Array.isArray(input.containerInventory) &&
        input.containerInventory.length === expectedIds.length &&
        new Set(input.containerInventory.map((entry) => entry?.Id)).size === expectedIds.length &&
        expectedIds.every((id) => input.containerInventory.some((entry) => entry.Id === id))
    );
    for (const container of [input.container, ...final.containers]) {
      const summary = input.containerInventory.find((entry) => entry.Id === container.Id);
      need(
        Array.isArray(summary.Names) &&
          summary.Names.length === 1 &&
          summary.Names[0] === container.Name &&
          summary.ImageID === container.Image &&
          summary.Image === container.Config.Image &&
          summary.State === "running" &&
          object(summary.Labels) &&
          Reflect.ownKeys(summary.Labels).length ===
            Reflect.ownKeys(container.Config.Labels).length &&
          Object.entries(container.Config.Labels).every(
            ([key, value]) => summary.Labels[key] === value
          )
      );
    }
    const imageIds = [input.image.Id, final.image.Id];
    need(
      Array.isArray(input.imageInventory) &&
        input.imageInventory.length === 2 &&
        new Set(input.imageInventory.map((entry) => entry?.Id)).size === 2 &&
        imageIds.every((id) => input.imageInventory.some((entry) => entry.Id === id))
    );
    for (const image of [input.image, final.image]) {
      const summary = input.imageInventory.find((entry) => entry.Id === image.Id);
      need(
        Array.isArray(summary.RepoDigests) &&
          image.RepoDigests.every((digest) => summary.RepoDigests.includes(digest))
      );
    }
    return freeze({
      ...postgres,
      runnerContainerId: final.runnerContainerId,
      migrationContainerId: final.migrationContainerId ?? null,
      runnerImageId: final.image.Id,
      runnerImageDigest: final.imageDigest,
      runnerImageReference: final.imageReference,
      sourceSha: final.sourceSha,
      finalContainerAddresses: [...addresses].slice(1),
      promotionEligible: false
    });
  } catch {
    fail();
  }
}
