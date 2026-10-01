// Internal H1 plaintext step. The consumed native session owns authority and aborts.
import childProcess from "node:child_process";
import { createPrivateKey, createPublicKey, createHash } from "node:crypto";
import fsNative from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { decryptSnapshotStream } from "../../packages/release-foundation/src/snapshot/envelope-crypto.mjs";
import { readFixedH1SnapshotPublicKeyInputs } from "./manual-stage1-trust.mjs";
import {
  checkedPrivatePath,
  pinPrivateInput,
  sameIdentity,
  samePublicDirectory
} from "./manual-runner-source-inputs.mjs";

const CODE = "R3_H1_SNAPSHOT_DECRYPT_UNAVAILABLE";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const MAIN_UUID = "97c61d0d-fa2c-42bb-9ba7-66f8724bc29b";
const BACKING = "/var/lib/stage1-ciphertext/main.luks";
const MAPPER_NAME = "stage1-h1-main";
const MAPPER = `/dev/mapper/${MAPPER_NAME}`;
const KEY_NAME = "snapshot-rsa3072.pk8.der";
const LIMIT = 65536;
const TRANSCRIPT_LIMIT = 131072;
const decode = (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
function fail() {
  throw Object.assign(new Error(CODE), { code: CODE });
}
function requireThat(value) {
  if (!value) fail();
}
function exact(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable && "value" in descriptor;
    })
  );
}
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function checkSignal(signal) {
  requireThat(
    signal &&
      typeof signal === "object" &&
      typeof signal.addEventListener === "function" &&
      typeof signal.removeEventListener === "function" &&
      !signal.aborted
  );
}
function absolute(value) {
  requireThat(
    typeof value === "string" &&
      path.isAbsolute(value) &&
      path.resolve(value) === value &&
      !value.includes("\0")
  );
  return value;
}
function sameChain(left, right, privateRoot, mutableLeaf = null) {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.path === right[index].path &&
        (entry.path === privateRoot || entry.path.startsWith(privateRoot + path.sep)
          ? sameIdentity(entry.stat, right[index].stat, entry.path !== mutableLeaf)
          : samePublicDirectory(entry.stat, right[index].stat))
    )
  );
}
function majorMinor(device) {
  const value = BigInt(device);
  return `${((value >> 8n) & 0xfffn) | ((value >> 32n) & 0xfffff000n)}:${(value & 0xffn) | ((value >> 12n) & 0xffffff00n)}`;
}
async function native(command, args, signal) {
  checkSignal(signal);
  const output = await new Promise((resolve, reject) => {
    childProcess.execFile(
      command,
      args,
      {
        shell: false,
        encoding: "buffer",
        timeout: 10000,
        maxBuffer: LIMIT,
        windowsHide: true,
        signal,
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C", LANG: "C" }
      },
      (error, stdout, stderr) => {
        if (
          error ||
          !Buffer.isBuffer(stdout) ||
          !Buffer.isBuffer(stderr) ||
          stderr.length ||
          stdout.length === 0 ||
          stdout.length > LIMIT
        )
          reject(new Error(CODE));
        else resolve(stdout);
      }
    );
  });
  checkSignal(signal);
  return decode(output);
}
async function boundedRead(file, signal) {
  checkSignal(signal);
  const handle = await fs.open(file, fsNative.constants.O_RDONLY | fsNative.constants.O_NOFOLLOW);
  let bytes;
  try {
    const buffer = Buffer.alloc(LIMIT + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, null);
      if (!bytesRead) break;
      count += bytesRead;
    }
    requireThat(count > 0 && count <= LIMIT);
    bytes = buffer.subarray(0, count);
  } finally {
    await handle.close();
  }
  checkSignal(signal);
  return decode(bytes);
}
function corePolicy(text) {
  let section = "",
    storage,
    size;
  for (const line of text.split(/\r?\n/u)) {
    const source = line.trim();
    if (!source || source.startsWith("#") || source.startsWith(";")) continue;
    if (/^\[[^\]]+\]$/u.test(source)) {
      section = source.slice(1, -1);
      continue;
    }
    if (section !== "Coredump") continue;
    const match = source.match(/^(Storage|ProcessSizeMax)\s*=(.*)$/u);
    if (!match) continue;
    if (match[1] === "Storage") storage = match[2].trim();
    else size = match[2].trim();
  }
  requireThat(storage === "none" && size === "0");
}
async function liveH1Guard(profile, signal) {
  const keyRoot = absolute(profile.storage.keyRoot),
    credentialRoot = absolute(profile.storage.credentialRoot);
  const mainRoot = path.dirname(keyRoot);
  requireThat(
    path.basename(keyRoot) === "key" &&
      path.basename(credentialRoot) === "credential" &&
      path.dirname(credentialRoot) === mainRoot &&
      path.basename(mainRoot) === "main"
  );
  const transcript = [];
  let transcriptBytes = 0;
  const record = (name, value, command = null, args = null) => {
    const bytes = Buffer.from(value, "utf8");
    transcriptBytes += bytes.length;
    requireThat(transcriptBytes <= TRANSCRIPT_LIMIT);
    transcript.push({
      name,
      source: args === null ? "file" : "command",
      path: args === null ? command : null,
      command: args === null ? null : command,
      args: args ?? [],
      exitCode: args === null ? null : 0,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      bytes: bytes.length,
      rawOutput: value,
      stderr: ""
    });
    return value;
  };
  const read = async (name, file) => record(name, await boundedRead(file, signal), file);
  const run = async (name, command, args) =>
    record(name, await native(command, args, signal), command, args);
  const swaps = await read("swaps", "/proc/swaps");
  requireThat(/^Filename\s+Type\s+Size\s+Used\s+Priority\s*$/u.test(swaps.trim()));
  const limits = await read("limits", "/proc/self/limits");
  const core = limits.split(/\r?\n/u).filter((line) => /^Max core file size\s+/u.test(line));
  requireThat(core.length === 1 && /^Max core file size\s+0\s+0\s+bytes\s*$/u.test(core[0]));
  corePolicy(
    await run("coredump", "/usr/bin/systemd-analyze", ["cat-config", "systemd/coredump.conf"])
  );
  requireThat((await fs.realpath(BACKING)) === BACKING);
  const backing = await fs.lstat(BACKING, { bigint: true });
  requireThat(
    backing.isFile() &&
      !backing.isSymbolicLink() &&
      backing.nlink === 1n &&
      backing.uid === 0n &&
      (backing.mode & 0o777n) === 0o600n &&
      backing.size === 1073741824n
  );
  const mounted = await fs.stat(mainRoot, { bigint: true });
  const key = await fs.stat(keyRoot, { bigint: true }),
    credential = await fs.stat(credentialRoot, { bigint: true });
  requireThat(
    mounted.isDirectory() &&
      mounted.uid === 0n &&
      (mounted.mode & 0o777n) === 0o700n &&
      key.dev === mounted.dev &&
      credential.dev === mounted.dev &&
      key.uid === 0n &&
      credential.uid === 0n &&
      (key.mode & 0o777n) === 0o700n &&
      (credential.mode & 0o777n) === 0o700n
  );
  const mapperReal = await fs.realpath(MAPPER);
  requireThat(/^\/dev\/dm-[0-9]+$/u.test(mapperReal));
  const mapper = await fs.stat(mapperReal, { bigint: true });
  requireThat(mapper.isBlockDevice() && mapper.uid === 0n);
  const device = majorMinor(mapper.rdev);
  requireThat(majorMinor(mounted.dev) === device);
  const mounts = JSON.parse(
    await run("mounts", "/usr/bin/findmnt", [
      "--json",
      "--list",
      "--kernel",
      "--output",
      "TARGET,SOURCE,FSTYPE,OPTIONS,MAJ:MIN"
    ])
  );
  requireThat(Array.isArray(mounts.filesystems));
  const rows = mounts.filesystems;
  const selected = rows.filter((row) => row.target === mainRoot);
  requireThat(
    selected.length === 1 &&
      selected[0].fstype === "ext4" &&
      [MAPPER, mapperReal].includes(selected[0].source) &&
      selected[0]["maj:min"] === device &&
      ["nosuid", "nodev", "noexec"].every((option) =>
        selected[0].options.split(",").includes(option)
      ) &&
      !rows.some(
        (row) =>
          row !== selected[0] &&
          (row.target?.startsWith(mainRoot + path.sep) || row["maj:min"] === device)
      )
  );
  const uuid = (await run("uuid", "/usr/sbin/cryptsetup", ["luksUUID", BACKING])).trim();
  requireThat(uuid === MAIN_UUID);
  const status = await run("status", "/usr/sbin/cryptsetup", ["status", MAPPER_NAME]);
  requireThat(status.includes(`${MAPPER} is active`) && /^\s*type:\s*LUKS2\s*$/mu.test(status));
  const loop = status.match(/^\s*device:\s*(\/dev\/loop[0-9]+)\s*$/mu)?.[1];
  requireThat(loop);
  const dm = (
    await run("mapper", "/usr/sbin/dmsetup", [
      "info",
      "--columns",
      "--noheadings",
      "--separator",
      "|",
      "--options",
      "name,uuid,major,minor",
      MAPPER_NAME
    ])
  )
    .trim()
    .split("|")
    .map((x) => x.trim());
  requireThat(
    dm.length === 4 &&
      dm[0] === MAPPER_NAME &&
      dm[1].startsWith(`CRYPT-LUKS2-${MAIN_UUID.replaceAll("-", "")}-`) &&
      `${dm[2]}:${dm[3]}` === device
  );
  const loops = JSON.parse(
    await run("loops", "/usr/sbin/losetup", [
      "--json",
      "--list",
      "--output",
      "NAME,BACK-FILE,OFFSET,SIZELIMIT"
    ])
  );
  requireThat(Array.isArray(loops.loopdevices));
  const backingLoops = loops.loopdevices.filter(
    (item) => item.name === loop || item["back-file"] === BACKING
  );
  requireThat(
    backingLoops.length === 1 &&
      backingLoops[0].name === loop &&
      backingLoops[0]["back-file"] === BACKING &&
      Number(backingLoops[0].offset) === 0 &&
      Number(backingLoops[0].sizelimit) === 0
  );
  checkSignal(signal);
  return freeze({
    observedAt: new Date().toISOString(),
    mainRoot,
    mapper: MAPPER,
    mapperDevice: device,
    luksUuid: uuid,
    backingFile: BACKING,
    mountOptions: selected[0].options,
    noSwap: true,
    coreLimitZero: true,
    coreStorageNone: true,
    coreProcessSizeMaxZero: true,
    transcript
  });
}

export async function decryptR3SnapshotCiphertext(input) {
  let publicHeld, keyPin, outputHandle, rawKey, privateKey;
  const closeOwned = async () => {
    const results = await Promise.allSettled(
      [keyPin?.close(), outputHandle?.close(), publicHeld?.close()].filter(Boolean)
    );
    keyPin?.bytes.fill(0);
    rawKey?.fill(0);
    keyPin = null;
    rawKey = null;
    privateKey = null;
    outputHandle = null;
    publicHeld = null;
    if (results.some((result) => result.status === "rejected")) fail();
  };
  try {
    requireThat(
      process.platform === "linux" &&
        process.getuid() === 0 &&
        exact(input, [
          "repoRoot",
          "profile",
          "operationRef",
          "cryptoInputs",
          "source",
          "recheck",
          "signal"
        ])
    );
    const { repoRoot, profile, operationRef, cryptoInputs, source, recheck, signal } = input;
    absolute(repoRoot);
    checkSignal(signal);
    requireThat(
      UUID.test(operationRef) &&
        typeof recheck === "function" &&
        profile?.storage &&
        typeof source?.open === "function" &&
        exact(cryptoInputs, ["authorization", "envelope", "aad"])
    );
    const { authorization, envelope, aad } = cryptoInputs;
    const local = envelope?.localKeyReadback;
    requireThat(
      DIGEST.test(local?.keyFingerprint) &&
        DIGEST.test(local?.keyReadbackDigest) &&
        DIGEST.test(local?.recoveryReadbackDigest) &&
        local.keyFingerprint === authorization?.localKey?.keyFingerprint &&
        local.keyReadbackDigest === authorization.localKey.keyReadbackDigest &&
        local.recoveryReadbackDigest === authorization.localKey.recoveryReadbackDigest &&
        aad?.snapshotDigest === envelope.snapshotDigest &&
        DIGEST.test(aad.snapshotDigest)
    );
    const keyRoot = absolute(profile.storage.keyRoot),
      credentialRoot = absolute(profile.storage.credentialRoot);
    const principal = { platform: "posix", uid: process.getuid() };
    const keyOptions = { principal, privateRoot: keyRoot },
      outputOptions = { principal, privateRoot: credentialRoot };
    const directory = path.join(credentialRoot, "r3", operationRef, "consumer", "plaintext");
    const output = path.join(directory, "snapshot.dump");
    await recheck();
    checkSignal(signal);
    publicHeld = await readFixedH1SnapshotPublicKeyInputs({
      repoRoot,
      creationRawDigest: local.keyReadbackDigest,
      recoveryRawDigest: local.recoveryReadbackDigest
    });
    requireThat(
      publicHeld?.refs?.indexRawDigest === null &&
        publicHeld.refs.creationRawDigest === local.keyReadbackDigest &&
        publicHeld.refs.recoveryRawDigest === local.recoveryReadbackDigest &&
        publicHeld.creation?.keyRef === KEY_NAME &&
        publicHeld.creation.profileDigest === sha256Canonical(profile) &&
        publicHeld.creation.keyFingerprint === local.keyFingerprint &&
        publicHeld.recovery?.keyFingerprint === local.keyFingerprint &&
        publicHeld.creation.publicKeyPem === publicHeld.recovery.publicKeyPem
    );
    await publicHeld.recheck();
    const initialDir = await checkedPrivatePath(directory, { ...outputOptions, directory: true });
    requireThat((initialDir.at(-1).stat.mode & 0o777n) === 0o700n);
    requireThat((await fs.readdir(directory)).length === 0);
    await checkedPrivatePath(keyRoot, { ...keyOptions, directory: true });
    const firstGuard = await liveH1Guard(profile, signal);
    await recheck();
    await publicHeld.recheck();
    checkSignal(signal);
    const keyPath = path.join(keyRoot, KEY_NAME);
    const keyPathStat = (await checkedPrivatePath(keyPath, keyOptions)).at(-1).stat;
    requireThat(keyPathStat.uid === 0n && (keyPathStat.mode & 0o777n) === 0o600n);
    const beforeKey = await liveH1Guard(profile, signal);
    keyPin = await pinPrivateInput(keyPath, keyOptions, 16384);
    rawKey = Buffer.from(keyPin.bytes);
    privateKey = createPrivateKey({ key: rawKey, format: "der", type: "pkcs8" });
    requireThat(
      privateKey.asymmetricKeyType === "rsa" &&
        privateKey.asymmetricKeyDetails?.modulusLength === 3072 &&
        BigInt(privateKey.asymmetricKeyDetails.publicExponent) === 65537n
    );
    const keyFingerprint = `sha256:${createHash("sha256")
      .update(createPublicKey(privateKey).export({ type: "spki", format: "der" }))
      .digest("hex")}`;
    requireThat(keyFingerprint === local.keyFingerprint);
    await keyPin.recheck();
    await publicHeld.recheck();
    checkSignal(signal);
    await decryptSnapshotStream({
      source,
      destination: output,
      envelope,
      aad,
      authorization,
      privateKey,
      signal
    });
    await keyPin.recheck();
    await keyPin.close();
    keyPin.bytes.fill(0);
    keyPin = null;
    rawKey.fill(0);
    rawKey = null;
    privateKey = null;
    const afterGuard = await liveH1Guard(profile, signal);
    await publicHeld.recheck();
    await recheck();
    checkSignal(signal);
    const afterDir = await checkedPrivatePath(directory, { ...outputOptions, directory: true });
    requireThat(
      sameChain(afterDir, initialDir, credentialRoot, directory) &&
        (await fs.readdir(directory)).length === 1 &&
        (await fs.readdir(directory))[0] === "snapshot.dump"
    );
    const dirHandle = await fs.open(
      directory,
      fsNative.constants.O_RDONLY | fsNative.constants.O_DIRECTORY | fsNative.constants.O_NOFOLLOW
    );
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
    outputHandle = await fs.open(
      output,
      fsNative.constants.O_RDONLY | fsNative.constants.O_NOFOLLOW
    );
    const outputStat = (await checkedPrivatePath(output, outputOptions)).at(-1).stat;
    requireThat(
      sameIdentity(outputStat, await outputHandle.stat({ bigint: true })) &&
        outputStat.size > 0n &&
        outputStat.size <= 1073741824n &&
        (outputStat.mode & 0o777n) === 0o600n
    );
    const heldDirectory = await checkedPrivatePath(directory, {
      ...outputOptions,
      directory: true
    });
    requireThat(
      sameChain(heldDirectory, afterDir, credentialRoot) &&
        sameIdentity(outputStat, await outputHandle.stat({ bigint: true }))
    );
    const plaintextHash = createHash("sha256");
    const plaintextBuffer = Buffer.alloc(65536);
    let plaintextBytes = 0;
    try {
      while (plaintextBytes < Number(outputStat.size)) {
        checkSignal(signal);
        const { bytesRead } = await outputHandle.read(
          plaintextBuffer,
          0,
          Math.min(plaintextBuffer.length, Number(outputStat.size) - plaintextBytes),
          plaintextBytes
        );
        requireThat(bytesRead > 0);
        plaintextHash.update(plaintextBuffer.subarray(0, bytesRead));
        plaintextBytes += bytesRead;
      }
    } finally {
      plaintextBuffer.fill(0);
    }
    requireThat(
      plaintextBytes === Number(outputStat.size) &&
        `sha256:${plaintextHash.digest("hex")}` === aad.snapshotDigest &&
        sameIdentity(outputStat, await outputHandle.stat({ bigint: true })) &&
        sameIdentity(outputStat, (await checkedPrivatePath(output, outputOptions)).at(-1).stat) &&
        sameChain(
          heldDirectory,
          await checkedPrivatePath(directory, { ...outputOptions, directory: true }),
          credentialRoot
        )
    );
    const facts = freeze({
      path: output,
      snapshotDigest: aad.snapshotDigest,
      plaintextSizeBytes: Number(outputStat.size),
      keyFingerprint
    });
    const observations = freeze({
      publicRefs: {
        creationRawDigest: publicHeld.refs.creationRawDigest,
        recoveryRawDigest: publicHeld.refs.recoveryRawDigest
      },
      firstGuard,
      beforeKey,
      afterGuard,
      output: {
        observedAt: new Date().toISOString(),
        sizeBytes: Number(outputStat.size),
        mode: "0600",
        digest: aad.snapshotDigest
      }
    });
    let closed = false,
      closing;
    const openingReplays = new Set();
    const replayStreams = new Set();
    const ownRecheck = async () => {
      try {
        requireThat(!closed && !signal.aborted);
        await publicHeld.recheck();
        await liveH1Guard(profile, signal);
        const currentDir = await checkedPrivatePath(directory, {
          ...outputOptions,
          directory: true
        });
        requireThat(sameChain(currentDir, heldDirectory, credentialRoot));
        const current = (await checkedPrivatePath(output, outputOptions)).at(-1).stat;
        requireThat(
          sameIdentity(current, outputStat) &&
            sameIdentity(current, await outputHandle.stat({ bigint: true }))
        );
      } catch {
        fail();
      }
    };
    const openReplay = () => {
      const opening = (async () => {
        try {
          await ownRecheck();
          const handle = await fs.open(
            output,
            fsNative.constants.O_RDONLY | fsNative.constants.O_NOFOLLOW
          );
          try {
            requireThat(sameIdentity(await handle.stat({ bigint: true }), outputStat));
            await ownRecheck();
            requireThat(!closed && !signal.aborted);
            const replay = handle.createReadStream({ autoClose: true });
            replayStreams.add(replay);
            replay.once("close", () => replayStreams.delete(replay));
            return replay;
          } catch {
            await handle.close();
            fail();
          }
        } catch {
          fail();
        }
      })();
      openingReplays.add(opening);
      opening.then(
        () => openingReplays.delete(opening),
        () => openingReplays.delete(opening)
      );
      return opening;
    };
    return Object.freeze({
      facts,
      observations,
      source: Object.freeze({ open: openReplay }),
      recheck: ownRecheck,
      close() {
        if (closing) return closing;
        closed = true;
        closing = (async () => {
          await Promise.allSettled([...openingReplays]);
          await Promise.allSettled(
            [...replayStreams].map(async (stream) => {
              if (stream.closed) return;
              const done = new Promise((resolve) => stream.once("close", resolve));
              stream.destroy();
              await done;
            })
          );
          await closeOwned();
        })();
        return closing;
      }
    });
  } catch {
    try {
      await closeOwned();
    } catch {
      /* fixed failure below */
    }
    fail();
  }
}
