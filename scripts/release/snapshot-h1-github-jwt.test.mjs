import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mock, test } from "node:test";

let secretReads = 0;
let protectedMemory = false;
mock.module("node:process", {
  defaultExport: { platform: "linux", getuid: () => 0, getgid: () => 0 }
});
mock.module("node:fs/promises", {
  namedExports: {
    async readFile(file) {
      if (file === "/proc/swaps")
        return protectedMemory
          ? "Filename Type Size Used Priority\n"
          : "header\n/swap file 1 0 -2\n";
      if (file === "/proc/sys/kernel/core_pattern") return "|/bin/false\n";
      if (file === "/proc/self/limits")
        return "Max core file size        0        0        bytes\n";
      throw Error("Unexpected read");
    },
    async lstat() {
      throw Error("Volume is not available");
    },
    async realpath() {
      throw Error("Volume is not available");
    },
    async open() {
      secretReads++;
      throw Error("SECRET_MUST_NOT_BE_OPENED");
    }
  }
});
const { createH1GitHubJwtSupplier } = await import("./snapshot-h1-github-jwt.mjs");

test("JWT supplier refuses unprotected memory before opening any credential", async () => {
  const supplier = createH1GitHubJwtSupplier();
  await assert.rejects(supplier(), { code: "H1_GITHUB_JWT_UNAVAILABLE" });
  assert.equal(secretReads, 0);
});

test("JWT supplier refuses absent protected volume and caller-selected configuration", async () => {
  protectedMemory = true;
  await assert.rejects(createH1GitHubJwtSupplier()(), { code: "H1_GITHUB_JWT_UNAVAILABLE" });
  assert.equal(secretReads, 0);
  assert.throws(() => createH1GitHubJwtSupplier({ key: Buffer.alloc(1) }), {
    code: "H1_GITHUB_JWT_UNAVAILABLE"
  });
});
