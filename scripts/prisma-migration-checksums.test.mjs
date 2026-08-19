import assert from "node:assert/strict";
import test from "node:test";

const checksums = await import("./prisma-migration-checksums.mjs").catch(() => ({}));

function requiredExport(name) {
  assert.equal(typeof checksums[name], "function", `${name} must be exported`);
  return checksums[name];
}

test("compares migration names and exact lowercase SHA-256 bytes fail closed", () => {
  const compare = requiredExport("compareMigrationChecksums");
  const result = compare(
    [
      { checksum: "aaa", migrationName: "001_a" },
      { checksum: "bbb", migrationName: "002_b" },
      { checksum: "ccc", migrationName: "003_c" }
    ],
    [
      { checksum: "aaa", migrationName: "001_a" },
      { checksum: "changed", migrationName: "002_b" },
      { checksum: "ddd", migrationName: "004_d" }
    ]
  );

  assert.deepEqual(result, {
    appliedMigrationCount: 3,
    duplicateAppliedNames: [],
    localMigrationCount: 3,
    mismatchedNames: ["002_b"],
    missingFromDatabase: ["003_c"],
    missingLocally: ["004_d"],
    safe: false
  });
});

test("hashes raw bytes without newline or encoding normalization", () => {
  const hash = requiredExport("hashMigrationBytes");

  assert.equal(
    hash(Buffer.from("SELECT 1;\n", "utf8")),
    "b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd"
  );
  assert.notEqual(hash(Buffer.from("SELECT 1;\r\n", "utf8")), hash(Buffer.from("SELECT 1;\n")));
});

test("duplicate successful database records are unsafe", () => {
  const compare = requiredExport("compareMigrationChecksums");
  const result = compare(
    [{ checksum: "aaa", migrationName: "001_a" }],
    [
      { checksum: "aaa", migrationName: "001_a" },
      { checksum: "aaa", migrationName: "001_a" }
    ]
  );

  assert.deepEqual(result.duplicateAppliedNames, ["001_a"]);
  assert.equal(result.safe, false);
});

test("resolves the pg Client constructor from its CommonJS default export", () => {
  class Client {}
  const resolveClient = requiredExport("resolvePgClient");

  assert.equal(resolveClient({ default: { Client } }), Client);
});
