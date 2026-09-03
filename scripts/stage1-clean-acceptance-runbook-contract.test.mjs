import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repoRoot = new URL("../", import.meta.url);
const governedLegacyEntries = [
  "scripts/prisma-migration-checksums.mjs",
  "scripts/stage1-active-source-facts-repair.mjs",
  "scripts/stage1-clean-acceptance-baseline.mjs",
  "scripts/stage1-clean-acceptance-target-validator.mjs",
  "scripts/stage1-contract-change-bootstrap.mjs",
  "scripts/stage1-return-closure-backfill.mjs",
  "scripts/stage1-staging-invalid-test-order-retirement.mjs",
  "scripts/stage1-task9-preflight-governance.mjs",
  "scripts/stage1c-period-backfill.mjs",
  "scripts/subscription-segment-bootstrap.mjs",
  "scripts/billing-maintenance-cycle-evidence.mjs"
];

async function read(relativePath) {
  return readFile(new URL(relativePath, repoRoot), "utf8");
}

async function readJson(relativePath) {
  return JSON.parse(await read(relativePath));
}

test("formal Stage1 runbooks select only fixed trusted Runner commands", async () => {
  const contents = (
    await Promise.all([
      read("docs/runbooks/stage1-clean-staging-acceptance-database-rollout.zh-CN.md"),
      read("docs/runbooks/stage1-active-term-contract-change-release.md")
    ])
  ).join("\n");
  for (const commandKey of [
    "db.migrate.deploy@1",
    "db.schema.verify@1",
    "stage1.active-source-facts.repair@1",
    "stage1.acceptance.target.verify@1",
    "stage1.billing-maintenance.evidence@1",
    "stage1.clean-acceptance.baseline@1",
    "stage1.contract-change.bootstrap@1",
    "stage1.period.backfill@1",
    "stage1.return-closure.backfill@1",
    "stage1.return-closure.publication-constraint.validate@1",
    "stage1.task9.preflight@1",
    "subscription.segment.bootstrap@1"
  ]) {
    assert.equal(
      contents.includes(
        "node scripts/release/trusted-launch-runner.mjs --command " + commandKey + " "
      ),
      true,
      commandKey
    );
  }
  assert.doesNotMatch(contents, /runner:exec/);
  assert.doesNotMatch(
    contents,
    /docker (?:compose[^\n]* )?(?:exec|run)[^\n]*\bapi\b[^\n]*(?:prisma|node scripts\/)/
  );
  for (const legacy of governedLegacyEntries) {
    assert.equal(contents.includes(legacy), false, legacy);
  }
});

test("return Closure DML proof custody precedes the independent constraint DDL operation", async () => {
  const contents = await read(
    "docs/runbooks/stage1-clean-staging-acceptance-database-rollout.zh-CN.md"
  );
  const dml = contents.indexOf("--command stage1.return-closure.backfill@1 --phase dry-run");
  const dmlReconcile = contents.indexOf(
    "--command stage1.return-closure.backfill@1 --phase reconcile"
  );
  const ddl = contents.indexOf(
    "--command stage1.return-closure.publication-constraint.validate@1 --phase dry-run"
  );
  assert.ok(dml >= 0 && dml < dmlReconcile && dmlReconcile < ddl);
  assert.match(contents, /proof 完成不可改写保管[\s\S]*之后才可规划 DDL/);
  assert.match(contents, /禁止批量批准、组合凭证或共享 request\/plan\/proof/);
  assert.match(contents, /DDL 失败不回滚已成功并已证明的 DML/);
  assert.match(contents, /约束保持 .*NOT VALID/);
  assert.match(contents, /DML command 的[\s\S]{0,20}statement log 必须证明无 DDL/);
  assert.match(contents, /DDL command 的[\s\S]{0,20}statement log 必须证明无业务 DML/);
});

test("package wrappers cannot invoke a legacy entry or a generic Runner", async () => {
  const packageJson = await readJson("package.json");
  const operational = Object.entries(packageJson.scripts).filter(
    ([name, value]) => !name.endsWith(":test") && !value.startsWith("node --test")
  );
  assert.equal(
    operational.some(([name]) => name === "runner:exec"),
    false
  );
  for (const [name, value] of operational) {
    for (const legacy of governedLegacyEntries) {
      assert.equal(value.includes("node " + legacy), false, name + ":" + legacy);
    }
  }
  for (const commandKey of [
    "stage1.return-closure.backfill@1",
    "stage1.return-closure.publication-constraint.validate@1"
  ]) {
    const wrappers = operational.filter(([, value]) => value.includes("--command " + commandKey));
    assert.ok(wrappers.length >= 3, commandKey);
    assert.equal(
      wrappers.every(([, value]) =>
        /--request-file \.release-inputs\/[a-z0-9.-]+\.json$/.test(value)
      ),
      true
    );
  }
});

test("the API runtime is application-only and Runner is non-resident", async () => {
  const [dockerfile, sourceCompose, imageCompose, allowlist] = await Promise.all([
    read("Dockerfile.api"),
    read("docker-compose.staging.example.yml"),
    read("docker-compose.staging.images.example.yml"),
    readJson("release/contracts/api-runtime-allowlist.v1.json")
  ]);
  const runtime = dockerfile.slice(dockerfile.indexOf(" AS runtime"));
  assert.doesNotMatch(runtime, /^COPY[^\n]*(?:\/app\/)?scripts(?:\/|\s)/m);
  assert.match(runtime, /test ! -e \/app\/scripts/);
  assert.match(runtime, /test ! -e \/app\/apps\/api\/node_modules\/\.bin\/prisma/);
  assert.match(runtime, /! command -v psql/);
  assert.deepEqual(allowlist.forbiddenPaths, ["/app/scripts"]);
  assert.deepEqual(allowlist.forbiddenExecutables.sort(), ["docker", "podman", "prisma", "psql"]);
  for (const compose of [sourceCompose, imageCompose]) {
    assert.match(compose, /^  runner:\n    profiles: \["release-operations"\]/m);
    assert.match(compose, /runner:[\s\S]*restart: "no"/);
    assert.match(compose, /runner:[\s\S]*read_only: true/);
    assert.doesNotMatch(compose, /api:[\s\S]*volumes:[\s\S]*scripts\//);
  }
});

test("rollback is reconcile-first and database restore is an approved last resort", async () => {
  const contents = (
    await Promise.all([
      read("docs/runbooks/stage1-clean-staging-acceptance-database-rollout.zh-CN.md"),
      read("docs/runbooks/stage1-active-term-contract-change-release.md"),
      read("docs/deployment.md"),
      read("docs/staging-deployment-runbook.md")
    ])
  ).join("\n");
  assert.match(contents, /未写入时安全停止|尚未发生数据库写入/);
  assert.match(contents, /结果可查询时 reconcile\/replay|结果确定或可查询/);
  assert.match(contents, /旧 API 与当前 Schema (?:兼容证明通过时|向后兼容)/);
  assert.match(contents, /数据库恢复(?:仅)?作为[\s\S]{0,120}最后手段/);
  assert.match(contents, /停止写入/);
  assert.match(contents, /损失窗口|数据丢失窗口/);
  assert.match(contents, /不得改写或逆转已应用迁移|Never rewrite or reverse an applied migration/);
});

test("governance inventory records complete caller migration and zero API surface", async () => {
  const inventory = await readJson("release/contracts/api-runtime-governance-inventory.v1.json");
  assert.deepEqual(inventory.source, {
    dockerfile: "Dockerfile.api",
    runtimeCopyCount: 0,
    executableEntrypointCount: 0
  });
  assert.equal(inventory.files.length, 25);
  assert.equal(inventory.commands.length, 11);
  assert.equal(
    inventory.files.every(({ disposition }) =>
      ["runner-only", "source-test-only"].includes(disposition)
    ),
    true
  );
  assert.equal(
    inventory.commands.every(
      ({ runnerRegistrationStatus, callers }) =>
        runnerRegistrationStatus === "registered" &&
        callers.every(
          ({ owner, migrationStatus }) =>
            owner === "release-engineering" && migrationStatus === "runner-cutover-complete"
        )
    ),
    true
  );
});
