// Root-private credential source. The launcher unlocks the existing main volume;
// this module neither unlocks it nor accepts paths, keys, claims or environment input.
import { Buffer } from "node:buffer";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { assertH1KeyVolume } from "./snapshot-h1-key-volume.mjs";

const CODE = "H1_GITHUB_JWT_UNAVAILABLE";
const MOUNT = "/var/lib/stage1-volumes/main";
const CONFIG = `${MOUNT}/credential/github-app-stage1-snapshot/config.json`;
const CLIENT = "Iv23liv1am29eM85IzZH";
const FINGERPRINT = "5d3ed578d6090079cbaa4d5c54c24cd2bda1175aa5b4fe53cf89e8e464c41291";
const PERMISSIONS = {
  administration: "write",
  actions: "read",
  contents: "read",
  deployments: "read",
  metadata: "read"
};
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const requireThat = (value) => {
  if (!value) fail();
};
const identity = (left, right) =>
  ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeMs", "ctimeMs"].every(
    (key) => left[key] === right[key]
  );
async function directories(file) {
  let current = path.posix.dirname(file);
  while (true) {
    const stat = await lstat(current);
    requireThat(
      stat.isDirectory() && stat.uid === 0 && stat.gid === 0 && (stat.mode & 0o022) === 0
    );
    if (current === MOUNT || current.startsWith(`${MOUNT}/`))
      requireThat((stat.mode & 0o777) === 0o700);
    if (current === "/") break;
    current = path.posix.dirname(current);
  }
}

function appKey(raw) {
  const app = JSON.parse(raw.toString("utf8"));
  requireThat(
    app?.id === 5196151 &&
      app.client_id === CLIENT &&
      app.owner?.id === 275060624 &&
      app.owner.login === "keqi119" &&
      app.slug === "keqi119-stage1-snapshot-jit" &&
      // The stored manifest-conversion response omits registration visibility.
      // Absence is not a new observation that the app is private.
      (app.public === undefined || app.public === false) &&
      Array.isArray(app.events) &&
      app.events.length === 0 &&
      app.permissions &&
      Object.keys(app.permissions).length === Object.keys(PERMISSIONS).length &&
      Object.entries(PERMISSIONS).every(([key, value]) => app.permissions[key] === value) &&
      (app.hook_attributes == null || app.hook_attributes.active === false) &&
      typeof app.pem === "string" &&
      app.pem.length < 16384
  );
  const key = createPrivateKey(app.pem);
  const publicKey = createPublicKey(key);
  requireThat(
    key.asymmetricKeyType === "rsa" &&
      createHash("sha256")
        .update(publicKey.export({ type: "spki", format: "der" }))
        .digest("hex") === FINGERPRINT
  );
  return key;
}

export function createH1GitHubJwtSupplier(...args) {
  requireThat(args.length === 0);
  return async function jwtSupplier(...request) {
    let handle, raw;
    try {
      requireThat(request.length === 0);
      await assertH1KeyVolume();
      await directories(CONFIG);
      handle = await open(CONFIG, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await handle.stat();
      requireThat(
        before.isFile() &&
          before.uid === 0 &&
          before.gid === 0 &&
          before.nlink === 1 &&
          (before.mode & 0o777) === 0o600 &&
          before.size > 0 &&
          before.size <= 1048576
      );
      // Bounded FD read rather than readFile: a concurrently growing file cannot
      // allocate unbounded credential memory before its metadata is rechecked.
      raw = Buffer.alloc(before.size + 1);
      const { bytesRead } = await handle.read(raw, 0, raw.length, 0);
      requireThat(bytesRead === before.size);
      const key = appKey(raw.subarray(0, bytesRead));
      requireThat(identity(before, await handle.stat()) && identity(before, await lstat(CONFIG)));
      await directories(CONFIG);
      await assertH1KeyVolume();
      const now = Math.floor(Date.now() / 1000);
      requireThat(Number.isSafeInteger(now) && now > 0);
      const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const payload = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 120, iss: CLIENT })}`;
      // Returned only through the private callback/pipe, never through a CLI/log.
      return `${payload}.${sign("RSA-SHA256", Buffer.from(payload), key).toString("base64url")}`;
    } catch {
      fail();
    } finally {
      raw?.fill(0);
      try {
        await handle?.close();
      } catch {
        fail();
      }
      // JS strings/KeyObjects are not claimed to be physically erased.
    }
  };
}
