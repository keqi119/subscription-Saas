// Internal R3 copy step. The consumed native session owns authority and Engine transport.
import { createHash } from "node:crypto";
import { Readable } from "node:stream";

const CODE = "R3_REMOTE_SNAPSHOT_COPY_UNAVAILABLE";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTAINER = /^[0-9a-f]{64}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const MAX_PLAINTEXT = 1073741824;
const RESPONSE_LIMIT = 65536;
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
      typeof signal.addEventListener === "function" &&
      typeof signal.removeEventListener === "function" &&
      !signal.aborted
  );
}
function textResponse(bytes) {
  requireThat(Buffer.isBuffer(bytes) && bytes.length <= RESPONSE_LIMIT);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail();
  }
}
function jsonResponse(bytes) {
  const text = textResponse(bytes);
  requireThat(text.length > 0);
  try {
    return JSON.parse(text);
  } catch {
    fail();
  }
}
function stdoutResponse(bytes) {
  requireThat(Buffer.isBuffer(bytes) && bytes.length <= RESPONSE_LIMIT);
  let offset = 0,
    size = 0;
  const chunks = [];
  while (offset < bytes.length) {
    requireThat(
      bytes.length - offset >= 8 &&
        bytes[offset] === 1 &&
        bytes[offset + 1] === 0 &&
        bytes[offset + 2] === 0 &&
        bytes[offset + 3] === 0
    );
    const length = bytes.readUInt32BE(offset + 4);
    offset += 8;
    requireThat(length <= RESPONSE_LIMIT - size && length <= bytes.length - offset);
    chunks.push(bytes.subarray(offset, offset + length));
    size += length;
    offset += length;
  }
  return textResponse(Buffer.concat(chunks, size));
}
function tarHeader(size) {
  const header = Buffer.alloc(512);
  header.write("snapshot.dump", 0, "ascii");
  header.write("0000600\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header.fill(32, 148, 156);
  header.write("0", 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  header.write(
    `${header
      .reduce((sum, byte) => sum + byte, 0)
      .toString(8)
      .padStart(6, "0")}\0 `,
    148,
    "ascii"
  );
  return header;
}
function statRow(output, type) {
  const match = output.match(
    /^(directory|regular file)\|([0-7]{3,4})\|([0-9]+)\|([0-9]+)\|([0-9]+)\|([0-9]+)\|([0-9]+)\|([0-9]+)\|([^|\n]+)\|([^|\n]+)\n$/u
  );
  requireThat(
    match &&
      match[1] === type &&
      match[3] === "0" &&
      match[4] === "0" &&
      Number.isSafeInteger(Number(match[5])) &&
      BigInt(match[6]) > 0n &&
      BigInt(match[7]) > 0n &&
      BigInt(match[8]) > 0n
  );
  return freeze({
    type: match[1],
    mode: match[2],
    uid: Number(match[3]),
    gid: Number(match[4]),
    size: Number(match[5]),
    device: match[6],
    inode: match[7],
    links: Number(match[8]),
    modifiedAt: match[9],
    changedAt: match[10]
  });
}
function sameDirectory(left, right) {
  return (
    left.type === right.type &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.links === right.links
  );
}
function sameFile(left, right) {
  return (
    sameDirectory(left, right) &&
    left.size === right.size &&
    left.modifiedAt === right.modifiedAt &&
    left.changedAt === right.changedAt
  );
}

export async function copyR3SnapshotToPostgres(input) {
  let uploadStream, replay;
  try {
    requireThat(
      exact(input, ["operationRef", "containerId", "plaintext", "engineCall", "recheck", "signal"])
    );
    const { operationRef, containerId, plaintext, engineCall, recheck, signal } = input;
    checkSignal(signal);
    requireThat(
      UUID.test(operationRef) &&
        CONTAINER.test(containerId) &&
        typeof engineCall === "function" &&
        typeof recheck === "function" &&
        typeof plaintext?.recheck === "function" &&
        typeof plaintext?.source?.open === "function" &&
        plaintext.facts?.path?.endsWith("/snapshot.dump") &&
        DIGEST.test(plaintext.facts.snapshotDigest) &&
        DIGEST.test(plaintext.facts.keyFingerprint) &&
        Number.isSafeInteger(plaintext.facts.plaintextSizeBytes) &&
        plaintext.facts.plaintextSizeBytes >= 1 &&
        plaintext.facts.plaintextSizeBytes <= MAX_PLAINTEXT
    );
    const size = plaintext.facts.plaintextSizeBytes;
    const expectedDigest = plaintext.facts.snapshotDigest;
    const directory = `/tmp/stage1-r3-${operationRef.replaceAll("-", "")}`;
    const file = `${directory}/snapshot.dump`;
    const transcript = [];
    let recording = true;
    const run = async (command) => {
      checkSignal(signal);
      const creation = jsonResponse(
        await engineCall(
          "POST",
          `/containers/${containerId}/exec`,
          { AttachStdout: true, AttachStderr: true, Tty: false, User: "0", Cmd: command },
          201
        )
      );
      requireThat(CONTAINER.test(creation?.Id));
      const output = stdoutResponse(
        await engineCall("POST", `/exec/${creation.Id}/start`, { Detach: false, Tty: false }, 200)
      );
      const completed = jsonResponse(
        await engineCall("GET", `/exec/${creation.Id}/json`, undefined, 200)
      );
      requireThat(
        completed?.ID === creation.Id &&
          completed.ContainerID === containerId &&
          completed.Running === false &&
          completed.ExitCode === 0
      );
      checkSignal(signal);
      if (recording)
        transcript.push(
          freeze({
            command,
            executionId: creation.Id,
            output,
            containerId: completed.ContainerID,
            running: completed.Running,
            exitCode: completed.ExitCode
          })
        );
      return output;
    };
    const stat = async (target, type) => {
      const row = statRow(
        await run(["/usr/bin/stat", "-c", "%F|%a|%u|%g|%s|%d|%i|%h|%y|%z", "--", target]),
        type
      );
      requireThat(
        row.mode === (type === "directory" ? "700" : "600") &&
          (type !== "regular file" || (row.links === 1 && row.size === size))
      );
      return row;
    };
    const hash = async () => {
      const output = await run(["/usr/bin/sha256sum", "--", file]);
      requireThat(output === `${expectedDigest.slice(7)}  ${file}\n`);
      return expectedDigest;
    };
    await recheck();
    await plaintext.recheck();
    checkSignal(signal);
    requireThat((await run(["/usr/bin/mkdir", "-m", "0700", "--", directory])) === "");
    const firstDirectory = await stat(directory, "directory");
    await plaintext.recheck();
    await recheck();
    checkSignal(signal);
    const padding = (512 - (size % 512)) % 512;
    const contentLength = 512 + size + padding + 1024;
    let opened = false,
      completedUpload = false;
    const bodySource = Object.freeze({
      contentLength,
      async open() {
        requireThat(!opened);
        opened = true;
        await plaintext.recheck();
        checkSignal(signal);
        replay = await plaintext.source.open();
        requireThat(
          replay &&
            typeof replay[Symbol.asyncIterator] === "function" &&
            typeof replay.destroy === "function"
        );
        const abort = () => replay.destroy(Object.assign(new Error(CODE), { code: CODE }));
        signal.addEventListener("abort", abort, { once: true });
        async function* tar() {
          const digest = createHash("sha256");
          let consumed = 0;
          try {
            yield tarHeader(size);
            for await (const chunk of replay) {
              checkSignal(signal);
              requireThat(Buffer.isBuffer(chunk));
              consumed += chunk.length;
              requireThat(consumed <= size);
              digest.update(chunk);
              yield chunk;
            }
            requireThat(consumed === size && `sha256:${digest.digest("hex")}` === expectedDigest);
            if (padding) yield Buffer.alloc(padding);
            yield Buffer.alloc(1024);
            completedUpload = true;
          } finally {
            signal.removeEventListener("abort", abort);
            replay.destroy();
            replay = null;
          }
        }
        uploadStream = Readable.from(tar(), { signal });
        return uploadStream;
      }
    });
    await engineCall(
      "PUT",
      `/containers/${containerId}/archive?path=${encodeURIComponent(directory)}`,
      undefined,
      200,
      { contentType: "application/x-tar", timeout: 120000, bodySource }
    );
    requireThat(opened && completedUpload);
    await plaintext.recheck();
    await recheck();
    checkSignal(signal);
    const copiedDirectory = await stat(directory, "directory");
    requireThat(sameDirectory(firstDirectory, copiedDirectory));
    const copiedFile = await stat(file, "regular file");
    await hash();
    await plaintext.recheck();
    await recheck();
    checkSignal(signal);
    const finalDirectory = await stat(directory, "directory");
    const finalFile = await stat(file, "regular file");
    requireThat(sameDirectory(firstDirectory, finalDirectory) && sameFile(copiedFile, finalFile));
    recording = false;
    const facts = freeze({
      containerId,
      directory,
      path: file,
      snapshotDigest: expectedDigest,
      plaintextSizeBytes: size
    });
    const observations = freeze({
      directory: firstDirectory,
      copiedDirectory,
      copiedFile,
      finalDirectory,
      finalFile,
      copiedDigest: expectedDigest,
      transcript
    });
    let closed = false,
      closing;
    const ownRecheck = async () => {
      try {
        requireThat(!closed);
        checkSignal(signal);
        await plaintext.recheck();
        requireThat(
          sameDirectory(firstDirectory, await stat(directory, "directory")) &&
            sameFile(copiedFile, await stat(file, "regular file"))
        );
        await hash();
        await plaintext.recheck();
        checkSignal(signal);
      } catch {
        fail();
      }
    };
    return Object.freeze({
      facts,
      observations,
      recheck: ownRecheck,
      close() {
        if (closing) return closing;
        closed = true;
        closing = Promise.resolve();
        return closing;
      }
    });
  } catch {
    uploadStream?.destroy();
    replay?.destroy();
    fail();
  }
}
