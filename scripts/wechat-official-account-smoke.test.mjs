import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const smokePath = path.join(root, "scripts", "wechat-official-account-smoke.mjs");

test("supports the independent handover pending smoke type", () => {
  const source = readFileSync(smokePath, "utf8");
  assert.match(source, /HANDOVER_PENDING:\s*\{/u);
  assert.match(source, /envKey:\s*"WECHAT_TEMPLATE_HANDOVER_PENDING"/u);
  assert.match(source, /eventType:\s*"HANDOVER_ESIGN_PENDING"/u);
  assert.match(source, /notificationType:\s*"HANDOVER_ESIGN_PENDING"/u);
  assert.match(source, /templateCode:\s*"HANDOVER_ESIGN_PENDING_WECHAT"/u);

  const help = spawnSync(process.execPath, [smokePath, "--help"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /HANDOVER_PENDING/u);
});

test("checked-in environment examples expose only a handover placeholder", () => {
  const files = [
    ".env.example",
    ".env.production.example",
    ".env.production.images.example",
    ".env.staging.example",
    ".env.staging.images.example",
    "apps/api/.env.example",
    "apps/api/.env.production.example"
  ];

  for (const file of files) {
    const source = readFileSync(path.join(root, file), "utf8");
    assert.match(
      source,
      /^WECHAT_TEMPLATE_HANDOVER_PENDING=<CHANGE_ME>$/mu,
      file
    );
  }

  const compose = readFileSync(
    path.join(root, "docker-compose.production.images.example.yml"),
    "utf8"
  );
  assert.match(
    compose,
    /WECHAT_TEMPLATE_HANDOVER_PENDING:\s*\$\{WECHAT_TEMPLATE_HANDOVER_PENDING:-\}/u
  );
});
