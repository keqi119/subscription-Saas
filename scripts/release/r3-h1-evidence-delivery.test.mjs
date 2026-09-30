import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readR3StableInboxFile } from "./r3-h1-evidence-delivery.mjs";

test(
  "H1 reads a complete single-link inbox file as an independent copy",
  { skip: process.platform !== "linux" },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "r3-inbox-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, "creation.bundle.json");
    const original = Buffer.from('{"bundle":"complete"}');
    await fs.writeFile(file, original, { mode: 0o600 });
    const uid = (await fs.lstat(file, { bigint: true })).uid;
    const received = await readR3StableInboxFile({ file, uid });
    assert.deepEqual(received, original);
    received[0] = 0;
    assert.deepEqual(await fs.readFile(file), original);
  }
);

test(
  "H1 rejects partial, linked and oversized inbox files",
  { skip: process.platform !== "linux" },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "r3-inbox-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, "creation.bundle.json");
    const part = `${file}.part`;
    await fs.writeFile(part, "partial", { mode: 0o600 });
    const uid = (await fs.lstat(part, { bigint: true })).uid;
    await assert.rejects(readR3StableInboxFile({ file, uid }));
    await fs.link(part, file);
    await assert.rejects(readR3StableInboxFile({ file, uid }));
    await fs.unlink(file);
    await fs.writeFile(file, Buffer.alloc(1048577), { mode: 0o600 });
    await assert.rejects(readR3StableInboxFile({ file, uid }));
  }
);
