// Public storage topology only. The native collector owns process completeness,
// file identity and ownership checks; these facts grant no session or cleanup authority.
const CODE = "R3_WORKSPACE_OBSERVATION_INVALID";
const LIMIT = 1048576;
const requireThat = (condition) => {
  if (!condition) throw Object.assign(new Error(CODE), { code: CODE });
};
function exact(value, keys) {
  requireThat(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
      Reflect.ownKeys(value).length === keys.length &&
      keys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor?.enumerable && Object.hasOwn(descriptor, "value");
      })
  );
}
function freeze(value) {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function text(bytes) {
  requireThat(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= LIMIT);
  const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  requireThat(!value.includes("\0"));
  return value;
}
function object(value) {
  requireThat(value !== null && typeof value === "object" && !Array.isArray(value));
  return value;
}
function uint(value) {
  requireThat(
    typeof value === "number" || (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value))
  );
  const number = Number(value);
  requireThat(Number.isSafeInteger(number) && number >= 0);
  return number;
}
function device(value) {
  requireThat(typeof value === "string" && /^(?:0|[1-9][0-9]*):(?:0|[1-9][0-9]*)$/u.test(value));
  value.split(":").forEach(uint);
  return value;
}
function inventory(bytes, key, columns) {
  const value = JSON.parse(text(bytes));
  exact(value, [key]);
  requireThat(Array.isArray(value[key]));
  for (const row of value[key]) exact(row, columns);
  return value[key];
}
const undeleted = (value) => (value.endsWith(" (deleted)") ? value.slice(0, -10) : value);
const within = (root, value) => root === "/" || value === root || value.startsWith(root + "/");
function absolute(value) {
  requireThat(
    typeof value === "string" &&
      value.startsWith("/") &&
      !/[\0\r\n]/u.test(value) &&
      (value === "/" ||
        !value.split("/").some((part, index) => index > 0 && ["", ".", ".."].includes(part)))
  );
  return value;
}
function kernelName(value) {
  requireThat(typeof value === "string");
  const result = value.startsWith("/dev/") ? value : "/dev/" + value;
  requireThat(/^\/dev\/[A-Za-z0-9_.+-]+$/u.test(result));
  return result;
}
function validateWorkspace(value) {
  exact(value, ["id", "capacityBytes", "backingFile", "mountPath", "keyFile", "mapperName"]);
  requireThat(
    typeof value.id === "string" &&
      /^[0-9a-f]{32}$/u.test(value.id) &&
      Number.isSafeInteger(value.capacityBytes) &&
      value.capacityBytes >= 64 * 1048576 &&
      value.capacityBytes % 1048576 === 0 &&
      value.backingFile === `/var/lib/stage1-snapshots/${value.id}.luks` &&
      value.mountPath === `/srv/stage1-snapshot/${value.id}` &&
      value.keyFile === `/dev/shm/stage1-keys/${value.id}.key` &&
      value.mapperName === `s1snap_${value.id}`
  );
  return { ...value };
}
function luksMetadata(bytes, capacityBytes) {
  const header = JSON.parse(text(bytes));
  exact(header, ["keyslots", "tokens", "segments", "digests", "config"]);
  for (const key of ["keyslots", "tokens", "segments", "digests", "config"]) object(header[key]);
  const segmentIds = Object.keys(header.segments);
  requireThat(segmentIds.length === 1 && /^(?:0|[1-9][0-9]*)$/u.test(segmentIds[0]));
  const segment = object(header.segments[segmentIds[0]]);
  requireThat(
    segment.type === "crypt" &&
      segment.encryption === "aes-xts-plain64" &&
      [512, 4096].includes(segment.sector_size) &&
      segment.iv_tweak === "0" &&
      (!Object.hasOwn(segment, "flags") ||
        (Array.isArray(segment.flags) && segment.flags.length === 0))
  );
  const offset = uint(segment.offset);
  requireThat(offset > 0 && offset < capacityBytes && offset % segment.sector_size === 0);
  if (segment.size !== "dynamic")
    requireThat(uint(segment.size) > 0 && uint(segment.size) <= capacityBytes - offset);
  if (Object.hasOwn(header.config, "requirements")) {
    exact(header.config.requirements, ["mandatory"]);
    requireThat(
      Array.isArray(header.config.requirements.mandatory) &&
        header.config.requirements.mandatory.length === 0
    );
  }
  const keyslotIds = Object.keys(header.keyslots);
  requireThat(keyslotIds.length > 0);
  for (const id of keyslotIds) {
    const slot = object(header.keyslots[id]);
    requireThat(
      /^(?:0|[1-9][0-9]*)$/u.test(id) &&
        Number(id) <= 31 &&
        slot.type === "luks2" &&
        slot.key_size === 64
    );
    const area = object(slot.area);
    requireThat(
      area.type === "raw" && area.encryption === "aes-xts-plain64" && area.key_size === 64
    );
  }
  const bindings = Object.values(header.digests).filter((value) => {
    object(value);
    requireThat(
      value.type === "pbkdf2" && Array.isArray(value.segments) && Array.isArray(value.keyslots)
    );
    return value.segments.includes(segmentIds[0]);
  });
  requireThat(
    bindings.length === 1 &&
      bindings[0].segments.length === 1 &&
      bindings[0].keyslots.length > 0 &&
      bindings[0].keyslots.every((id) => keyslotIds.includes(id))
  );
  return {
    segmentIds,
    encryption: segment.encryption,
    sectorSize: segment.sector_size,
    keySizeBytes: 64
  };
}

export function assessR3WorkspaceObservation(input) {
  try {
    exact(input, ["workspace", "state", "captured"]);
    const workspace = validateWorkspace(input.workspace),
      { state, captured } = input;
    requireThat(["active", "absent"].includes(state));
    exact(
      captured,
      state === "active"
        ? ["mounts", "loops", "blocks", "mapper", "header", "uuid", "swaps", "limits"]
        : ["mounts", "loops", "blocks"]
    );
    const mounts = inventory(captured.mounts, "filesystems", [
      "target",
      "source",
      "fstype",
      "options",
      "maj:min"
    ]);
    const loops = inventory(captured.loops, "loopdevices", [
      "name",
      "back-file",
      "offset",
      "sizelimit"
    ]);
    const blocks = inventory(captured.blocks, "blockdevices", [
      "name",
      "kname",
      "type",
      "maj:min",
      "pkname"
    ]);
    for (const row of mounts) {
      absolute(undeleted(row.target));
      device(row["maj:min"]);
      requireThat(
        [row.source, row.fstype, row.options].every(
          (value) => typeof value === "string" && value.length > 0
        )
      );
    }
    const protectedMounts = mounts.filter((row) => {
      const target = undeleted(row.target);
      return (
        [workspace.keyFile, workspace.backingFile, workspace.mountPath].some((file) =>
          within(target, file)
        ) || within(workspace.mountPath, target)
      );
    });
    requireThat(
      new Set(protectedMounts.map((row) => undeleted(row.target))).size === protectedMounts.length
    );
    for (const row of loops) {
      requireThat(/^\/dev\/loop[0-9]+$/u.test(row.name));
      absolute(undeleted(row["back-file"]));
      uint(row.offset);
      uint(row.sizelimit);
    }
    requireThat(new Set(loops.map((row) => row.name)).size === loops.length);
    for (const row of blocks) {
      absolute(row.name);
      kernelName(row.kname);
      device(row["maj:min"]);
      requireThat(typeof row.type === "string" && row.type.length > 0);
      if (row.pkname !== null) kernelName(row.pkname);
    }
    requireThat(new Set(blocks.map((row) => row["maj:min"])).size === blocks.length);
    const keyMounts = mounts
      .filter((row) => within(undeleted(row.target), workspace.keyFile))
      .sort((a, b) => b.target.length - a.target.length);
    requireThat(
      keyMounts.length > 0 &&
        keyMounts[0].fstype === "tmpfs" &&
        keyMounts[0].target === undeleted(keyMounts[0].target)
    );
    const relevantMounts = mounts.filter((row) =>
      within(workspace.mountPath, undeleted(row.target))
    );
    const relevantLoops = loops.filter(
      (row) => undeleted(row["back-file"]) === workspace.backingFile
    );
    const mapperPath = `/dev/mapper/${workspace.mapperName}`;
    if (state === "absent") {
      requireThat(
        relevantMounts.length === 0 &&
          relevantLoops.length === 0 &&
          !mounts.some((row) => undeleted(row.source) === mapperPath) &&
          !blocks.some((row) => row.name === mapperPath || row.kname === mapperPath)
      );
      return freeze({
        state,
        workspace,
        mount: null,
        mapper: null,
        loop: null,
        luks: null,
        swapDevices: null,
        coreLimit: null
      });
    }
    requireThat(
      relevantMounts.length === 1 &&
        relevantMounts[0].target === workspace.mountPath &&
        relevantLoops.length === 1 &&
        relevantLoops[0]["back-file"] === workspace.backingFile
    );
    const mounted = relevantMounts[0],
      attached = relevantLoops[0];
    const options = mounted.options.split(",");
    requireThat(
      mounted.fstype === "ext4" &&
        ["rw", "nodev", "nosuid"].every((flag) => options.includes(flag)) &&
        !["ro", "dev", "suid"].some((flag) => options.includes(flag)) &&
        uint(attached.offset) === 0 &&
        uint(attached.sizelimit) === 0
    );
    const mapperParts = text(captured.mapper)
      .trim()
      .split("|")
      .map((part) => part.trim());
    requireThat(mapperParts.length === 4 && mapperParts[0] === workspace.mapperName);
    const majorMinor = `${uint(mapperParts[2])}:${uint(mapperParts[3])}`;
    requireThat(
      majorMinor === mounted["maj:min"] &&
        mounts.filter((row) => row["maj:min"] === majorMinor).length === 1
    );
    const uuid = text(captured.uuid).trim();
    requireThat(
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(uuid) &&
        mapperParts[1] === `CRYPT-LUKS2-${uuid.replaceAll("-", "")}-${workspace.mapperName}`
    );
    const block = blocks.find((row) => row["maj:min"] === majorMinor);
    requireThat(
      block?.type === "crypt" &&
        block.pkname !== null &&
        /^\/dev\/dm-[0-9]+$/u.test(kernelName(block.kname)) &&
        (block.name === mapperPath || block.name === kernelName(block.kname)) &&
        (mounted.source === mapperPath || mounted.source === kernelName(block.kname)) &&
        kernelName(block.pkname) === attached.name
    );
    const loopBlock = blocks.find((row) => kernelName(row.kname) === attached.name);
    requireThat(
      loopBlock?.type === "loop" &&
        loopBlock.name === attached.name &&
        loopBlock.pkname === null &&
        !mounts.some((row) => row["maj:min"] === loopBlock["maj:min"]) &&
        blocks.filter((row) => row.pkname !== null && kernelName(row.pkname) === attached.name)
          .length === 1
    );
    const luks = { uuid, ...luksMetadata(captured.header, workspace.capacityBytes) };
    const swaps = text(captured.swaps).trim().split(/\r?\n/u);
    requireThat(swaps.length === 1 && /^Filename\s+Type\s+Size\s+Used\s+Priority$/u.test(swaps[0]));
    const limits = text(captured.limits).trim().split(/\r?\n/u);
    requireThat(/^Limit\s+Soft Limit\s+Hard Limit\s+Units$/u.test(limits[0]));
    const cores = limits.filter((line) => /^Max core file size\s/u.test(line));
    requireThat(cores.length === 1 && /^Max core file size\s+0\s+0\s+bytes\s*$/u.test(cores[0]));
    return freeze({
      state,
      workspace,
      mount: {
        target: mounted.target,
        source: mounted.source,
        fsType: mounted.fstype,
        options,
        majorMinor
      },
      mapper: { name: mapperParts[0], uuid: mapperParts[1], majorMinor },
      loop: { name: attached.name, backingFile: attached["back-file"], offset: 0, sizeLimit: 0 },
      luks,
      swapDevices: [],
      coreLimit: { soft: 0, hard: 0 }
    });
  } catch (cause) {
    if (cause?.code === CODE) throw cause;
    throw Object.assign(new Error(CODE, { cause }), { code: CODE });
  }
}
