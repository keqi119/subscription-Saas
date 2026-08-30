import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import test from "node:test";

const runbookUrl = new URL(
  "../docs/runbooks/stage1-clean-staging-acceptance-database-rollout.zh-CN.md",
  import.meta.url
);
const SHA256 = "a".repeat(64);
const RELEASE_SHA = "b".repeat(40);
const IMAGE_ID = `sha256:${"c".repeat(64)}`;
const CONTAINER_ID = "e".repeat(64);
const NONCE = "d".repeat(64);

async function readRunbook() {
  return readFile(runbookUrl, "utf8").catch(() => "");
}

function assertContainsAll(contents, fragments) {
  for (const fragment of fragments) {
    assert.ok(contents.includes(fragment), `runbook must contain: ${fragment}`);
  }
}

function indexOfUnique(contents, fragment) {
  const first = contents.indexOf(fragment);
  assert.notEqual(first, -1, `runbook must contain: ${fragment}`);
  assert.equal(
    contents.indexOf(fragment, first + fragment.length),
    -1,
    `runbook must contain once: ${fragment}`
  );
  return first;
}

function assertStrictOrder(contents, fragments) {
  let cursor = 0;
  for (const fragment of fragments) {
    const index = contents.indexOf(fragment, cursor);
    assert.notEqual(index, -1, `runbook must contain in control-flow order: ${fragment}`);
    cursor = index + fragment.length;
  }
}

function extractExecutableFence(contents, name) {
  const begin = `<!-- ${name}_BEGIN -->`;
  const end = `<!-- ${name}_END -->`;
  assert.equal(contents.split(begin).length - 1, 1, `${begin} must occur once`);
  assert.equal(contents.split(end).length - 1, 1, `${end} must occur once`);
  const marked = contents.slice(contents.indexOf(begin) + begin.length, contents.indexOf(end));
  const matches = [...marked.matchAll(/```bash\r?\n([\s\S]*?)```/g)];
  assert.equal(matches.length, 1, `${name} must contain exactly one bash fence`);
  return matches[0][1];
}

function validateExecutableContracts(contents) {
  const evidenceHelpers = extractExecutableFence(contents, "STAGE1_EVIDENCE_HELPERS_EXECUTABLE");
  const transformer = extractExecutableFence(contents, "STAGE1_ENV_TRANSFORM_EXECUTABLE");
  const cutover = extractExecutableFence(contents, "STAGE1_CUTOVER_EXECUTABLE");
  assert.match(transformer, /^import \{ buildStage1AcceptanceDatabaseEnvSwitch \}/m);
  assert.match(transformer, /^const after = buildStage1AcceptanceDatabaseEnvSwitch\($/m);
  assert.doesNotMatch(transformer, /^\s*(?:#|\/\/).*buildStage1AcceptanceDatabaseEnvSwitch/m);
  assertContainsAll(evidenceHelpers, [
    "assert_private_directory() {",
    "assert_new_evidence_path() {",
    "assert_private_file() {",
    "publish_private_evidence() {",
    'test -d "$path" || return 1',
    'test ! -e "$path" || return 1',
    'test -f "$path" || return 1',
    'test ! -L "$path" || return 1'
  ]);

  const trapIndex = cutover.indexOf("trap 'rollback_after_switch_error' ERR");
  const activeIndex = cutover.indexOf("SWITCH_ACTIVE=1");
  const renameIndex = cutover.indexOf('mv -f -- "$ENV_TEMP" "$ENV_FILE"');
  assert.ok(trapIndex >= 0 && trapIndex < activeIndex && activeIndex < renameIndex);
  assert.match(cutover, /^post_switch_database_gates$/m);
  assert.match(cutover, /^if ! validate_browser_acceptance_fact \\/m);
  assert.match(cutover, /^if ! cutover_api_recreate api; then/m);
  assert.doesNotMatch(cutover, /STAGE1_CUTOVER_|CUTOVER_[A-Z_]+_FN/);
  assert.doesNotMatch(
    cutover,
    /^\s*#.*(?:post_switch_database_gates|rollback_after_switch_error)/m
  );
  assertContainsAll(cutover, [
    "revalidate_switched_api_identity() {",
    "{{.Id}}",
    "{{.Image}}",
    "org.opencontainers.image.revision",
    ".services.api.image",
    'test "$switched_image_id" = "$API_IMAGE_ID"',
    'test "$switched_release_sha" = "$RELEASE_SHA"',
    'test "$compose_image_id" = "$API_IMAGE_ID"',
    '"releaseSha"',
    '"imageId"',
    '"switchedContainerId"',
    '"challengeCreatedAtUtc"',
    '"nonce"',
    "isDeepStrictEqual(fact.challenge, challenge)",
    "Number.isFinite(millis)",
    "completedAt >= challengeCreatedAt",
    "completedAt <= receivedAt",
    "completedAt <= challengeCreatedAt + timeoutSeconds * 1000",
    "allDomains(fact.entryPoints",
    "allDomains(fact.rawEnumerations",
    "fact.console.errorCount === 0",
    "fact.console.warnCount === 0",
    "fact.visualReview.admin === true",
    "fact.visualReview.portal === true",
    'if ! IFS= read -r -s -t "$BROWSER_ACCEPTANCE_TIMEOUT_SECONDS" BROWSER_ACCEPTANCE_PAYLOAD; then',
    '"$BROWSER_ACCEPTANCE_RECEIVED_AT_UTC" "$BROWSER_ACCEPTANCE_TIMEOUT_SECONDS"; then',
    "const timeoutSeconds = Number(timeoutText);",
    "Number.isInteger(timeoutSeconds) && timeoutSeconds >= 1 && timeoutSeconds <= 900",
    "BROWSER_ACCEPTANCE_TIMEOUT",
    "BROWSER_ACCEPTANCE_REJECTED",
    "BROWSER_ACCEPTANCE_FACT_INVALID"
  ]);
  assert.match(
    cutover,
    /^if ! \[\[ "\$BROWSER_ACCEPTANCE_TIMEOUT_RAW" =~ \^\[1-9\]\[0-9\]\{0,2\}\$ \]\]; then$/m
  );
  assert.doesNotMatch(cutover, /\bread\b[^\n]*BROWSER_ACCEPTANCE_TIMEOUT_RAW/);
  assertStrictOrder(cutover.slice(trapIndex), [
    "SWITCH_ACTIVE=1",
    'mv -f -- "$ENV_TEMP" "$ENV_FILE"',
    "cutover_api_recreate api",
    "revalidate_switched_api_identity",
    "write_browser_acceptance_challenge",
    "post_switch_database_gates",
    "BROWSER_ACCEPTANCE_TIMEOUT_RAW",
    'if ! [[ "$BROWSER_ACCEPTANCE_TIMEOUT_RAW" =~ ^[1-9][0-9]{0,2}$ ]]; then',
    'BROWSER_ACCEPTANCE_TIMEOUT_SECONDS="$((10#$BROWSER_ACCEPTANCE_TIMEOUT_RAW))"',
    "BROWSER_ACCEPTANCE_TIMEOUT_SECONDS > 900",
    "BROWSER_ACCEPTANCE_PAYLOAD",
    "BROWSER_ACCEPTANCE_RECEIVED_AT_UTC",
    'publish_private_evidence "$BROWSER_FACT_PATH"',
    "validate_browser_acceptance_fact",
    "SWITCH_ACTIVE=0",
    "trap - ERR"
  ]);
  return { cutover, evidenceHelpers, transformer };
}

function validateTask9PreflightContracts(contents, checkMutations = true) {
  const preflight = extractExecutableFence(contents, "STAGE1_TASK9_PREFLIGHT_EXECUTABLE");
  assertContainsAll(preflight, [
    'readonly COMPOSE_FILE="/opt/subscription-saas/docker-compose.staging.images.example.yml"',
    'readonly COMPOSE_PROJECT="subauto-staging"',
    "readonly APPROVED_API_IMAGE",
    '"$APPROVED_API_IMAGE_ID" node',
    "docker image inspect --format",
    "org.opencontainers.image.revision",
    "STOP: APPROVED_API_IMAGE_DIGEST_INVALID",
    "STOP: APPROVED_API_IMAGE_REVISION_INVALID",
    "STOP: APPROVED_API_IMAGE_REVISION_MISMATCH",
    'check_public_http_200 "$STAGE1_ACCEPTANCE_PUBLIC_API_HEALTH_URL"',
    'check_public_http_200 "$STAGE1_ACCEPTANCE_PUBLIC_ADMIN_HEALTH_URL"',
    'check_public_http_200 "$STAGE1_ACCEPTANCE_PUBLIC_PORTAL_HEALTH_URL"',
    "CREATE DATABASE %I OWNER %I TEMPLATE template0 ENCODING %L",
    "TARGET_DATABASE_ALREADY_EXISTS",
    "EMPTY_NEW_DB_BACKUP",
    "empty-new-database.pre-migration",
    "prisma migrate deploy",
    "post_migration_business_nonzero_tables=0",
    "stage1-task9-preflight-governance.mjs approval-summary",
    "stage1-task9-preflight-governance.mjs validate-selection",
    "prisma migrate diff",
    "MIGRATION_COUNTS_INVALID",
    "STOP FOR HUMAN APPROVAL: BASELINE_APPLY_APPROVAL"
  ]);
  assert.doesNotMatch(preflight, /docker compose[^\n]+run[^\n]+\bapi\b/);
  assert.doesNotMatch(preflight, /^\s*(?:jq|node|psql|pg_dump)\b/m);
  assertStrictOrder(preflight, [
    'check_public_http_200 "$STAGE1_ACCEPTANCE_PUBLIC_API_HEALTH_URL"',
    "CREATE DATABASE %I OWNER %I TEMPLATE template0 ENCODING %L",
    "empty-new-database.pre-migration",
    "prisma migrate deploy",
    "post_migration_business_nonzero_tables=0",
    "--discover-vehicles",
    'read -r -s -p "Approved vehicle UUID (hidden): " APPROVED_VEHICLE_UUID',
    "--dry-run --vehicle-id",
    "STOP FOR HUMAN APPROVAL: BASELINE_APPLY_APPROVAL"
  ]);

  const mutations = [
    contents.replace(
      "docker-compose.staging.images.example.yml",
      "docker-compose.staging.images.yml"
    ),
    contents.replace('"$APPROVED_API_IMAGE_ID" node', '"$CURRENT_ONLINE_API_IMAGE" node'),
    contents.replace('check_public_http_200 "$STAGE1_ACCEPTANCE_PUBLIC_PORTAL_HEALTH_URL"', ":"),
    contents.replaceAll("empty-new-database.pre-migration", "migration-backup"),
    contents.replace(
      "post_migration_business_nonzero_tables=0",
      "post_migration_business_nonzero_tables=unchecked"
    ),
    contents.replace("stage1-task9-preflight-governance.mjs approval-summary", "node -e true")
  ];
  if (checkMutations) {
    for (const [index, mutation] of mutations.entries()) {
      assert.throws(
        () => validateTask9PreflightContracts(mutation, false),
        undefined,
        `mutation ${index}`
      );
    }
  }
  return preflight;
}

function toGitBashPath(path) {
  return path
    .replace(/^([A-Za-z]):/, (_match, drive) => `/${drive.toLowerCase()}`)
    .replaceAll("\\", "/");
}

function writeFakeCommand(binDirectory, name, contents) {
  const path = join(binDirectory, name);
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${contents}\n`, "utf8");
  chmodSync(path, 0o755);
}

function installLeafFakes(hostDirectory) {
  const binDirectory = join(hostDirectory, "fake-bin");
  mkdirSync(binDirectory);
  writeFakeCommand(
    binDirectory,
    "date",
    `counter="$HARNESS_DIR/date-count"
count=0
test ! -f "$counter" || IFS= read -r count <"$counter"
count=$((count + 1))
printf '%s\\n' "$count" >"$counter"
case "$count" in
  1) printf '%s\\n' 2026-08-30T12:00:00Z ;;
  2) printf '%s\\n' 2026-08-30T12:00:01Z ;;
  3) printf '%s\\n' 2026-08-30T12:00:02Z ;;
  *) printf '%s\\n' 2026-08-30T12:00:10Z ;;
esac`
  );
  writeFakeCommand(binDirectory, "openssl", `printf '%s\\n' ${NONCE}`);
  writeFakeCommand(
    binDirectory,
    "stat",
    `target="\${!#}"
if test "$FAILURE_SCENARIO" = browser_validator_permission && [[ "$target" = *browser-acceptance.fact.json ]]; then
  counter="$HARNESS_DIR/browser-fact-stat-count"
  count=0
  test ! -f "$counter" || IFS= read -r count <"$counter"
  count=$((count + 1))
  printf '%s\\n' "$count" >"$counter"
  if test "$count" -ge 2; then printf '%s\\n' '0:0:644'; exit 0; fi
fi
if test -d "$target"; then printf '%s\\n' '0:0:700'; else printf '%s\\n' '0:0:600'; fi`
  );
  writeFakeCommand(binDirectory, "chown", ":");
  writeFakeCommand(
    binDirectory,
    "sync",
    `printf '%s\\n' gate:filesystem-sync >>"$TRACE_FILE"
if test "$FAILURE_SCENARIO" = filesystem_sync && test "$(<"$ENV_FILE")" = target; then exit 71; fi`
  );
  writeFakeCommand(binDirectory, "sha256sum", `printf '%s\\n' 'deadbeef  -'`);
  writeFakeCommand(
    binDirectory,
    "curl",
    `url="\${!#}"
state="$(<"$ENV_FILE")"
if test "$state" = old; then
  printf '%s\\n' old-public-health >>"$TRACE_FILE"
  printf '%s' 200
  exit 0
fi
case "$url" in
  api-health) gate=public-api; scenario=public_api ;;
  admin-health) gate=public-admin; scenario=public_admin ;;
  portal-health) gate=public-portal; scenario=public_portal ;;
  *) printf '%s\\n' UNHANDLED_CURL_COMMAND >>"$TRACE_FILE"; exit 97 ;;
esac
printf 'gate:%s\\n' "$gate" >>"$TRACE_FILE"
if test "$FAILURE_SCENARIO" = "$scenario"; then printf '%s' 500; else printf '%s' 200; fi`
  );
  writeFakeCommand(
    binDirectory,
    "psql",
    `case "$*" in
  *secret-target-url*)
    printf '%s\\n' gate:migration-count >>"$TRACE_FILE"
    if test "$FAILURE_SCENARIO" = migration_count; then printf '%s\\n' '123|0|0|0'; else printf '%s\\n' '124|0|0|0'; fi
    ;;
  *secret-database-url*)
    printf '%s\\n' old-database-fingerprint >>"$TRACE_FILE"
    printf '%s\\n' fingerprint-input
    ;;
  *) printf '%s\\n' UNHANDLED_PSQL_COMMAND >>"$TRACE_FILE"; exit 97 ;;
esac`
  );
  writeFakeCommand(
    binDirectory,
    "jq",
    `args="$*"
case "$args" in
  *services.api.image*)
    while IFS= read -r _line; do :; done || true
    printf '%s\\n' approved-api
    ;;
  *localMigrationCount*)
    while IFS= read -r _line; do :; done || true
    printf '%s\\n' gate:checksum-assert >>"$TRACE_FILE"
    test "$FAILURE_SCENARIO" != checksum
    ;;
  *billing-completed-cycles.json*)
    printf '%s\\n' gate:billing >>"$TRACE_FILE"
    test "$FAILURE_SCENARIO" != billing
    ;;
  *target-validator.post-switch.json*)
    printf '%s\\n' gate:validator-evidence >>"$TRACE_FILE"
    [[ "$args" = *'.operation == "STAGE1_CLEAN_ACCEPTANCE_TARGET_VALIDATOR"'* ]]
    [[ "$args" = *'.result.safe == true'* ]]
    [[ "$args" = *'.result.manifestSha256 == $sha'* ]]
    ;;
  *) : ;;
esac`
  );
  writeFakeCommand(
    binDirectory,
    "docker",
    `args="$*"
state="$(<"$ENV_FILE")"
case "$args" in
  *' up -d --no-deps --force-recreate api'*)
    printf '%s\\n' recreate:api >>"$TRACE_FILE"
    if [[ "$FAILURE_SCENARIO" = api_recreate || "$FAILURE_SCENARIO" = rollback_health ]] \
      && test "$state" = target; then exit 70; fi
    ;;
  *' ps -q api'*) printf '%s\\n' ${CONTAINER_ID} ;;
  'image inspect --format {{.Id}} approved-api')
    printf '%s\\n' gate:compose-image >>"$TRACE_FILE"
    if test "$FAILURE_SCENARIO" = compose_image_drift; then printf '%s\\n' sha256:${"f".repeat(64)}; else printf '%s\\n' ${IMAGE_ID}; fi
    ;;
  *' config --format json'*) printf '%s\\n' '{"services":{"api":{"image":"approved-api"}}}' ;;
  *'inspect --format {{.Id}}'*)
    printf '%s\\n' gate:container-id >>"$TRACE_FILE"
    if test "$FAILURE_SCENARIO" = container_id_drift && test "$state" = target; then printf '%s\\n' ${"f".repeat(64)}; else printf '%s\\n' ${CONTAINER_ID}; fi
    ;;
  *'inspect --format {{.Image}}'*)
    printf '%s\\n' gate:container-image >>"$TRACE_FILE"
    if test "$FAILURE_SCENARIO" = image_drift && test "$state" = target; then printf '%s\\n' sha256:${"f".repeat(64)}; else printf '%s\\n' ${IMAGE_ID}; fi
    ;;
  *'org.opencontainers.image.revision'*)
    printf '%s\\n' gate:container-revision >>"$TRACE_FILE"
    if test "$FAILURE_SCENARIO" = revision_drift && test "$state" = target; then printf '%s\\n' ${"f".repeat(40)}; else printf '%s\\n' ${RELEASE_SHA}; fi
    ;;
  *'inspect --format {{.State.Running}}'*)
    printf '%s\\n' gate:container-running >>"$TRACE_FILE"
    if test "$FAILURE_SCENARIO" = container_running && test "$state" = target; then printf '%s\\n' false; else printf '%s\\n' true; fi
    ;;
  *'inspect --format {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}'*)
    if test "$state" = target; then printf '%s\\n' gate:container-health >>"$TRACE_FILE"; fi
    if { test "$FAILURE_SCENARIO" = container_health && test "$state" = target; } \
      || { test "$FAILURE_SCENARIO" = rollback_health && test "$state" = old; }; then
      printf '%s\\n' unhealthy
    else
      printf '%s\\n' healthy
    fi
    ;;
  *'inspect --format {{.RestartCount}}'*)
    printf '%s\\n' gate:restart-count >>"$TRACE_FILE"
    if test "$FAILURE_SCENARIO" = restart_count; then printf '%s\\n' 1; else printf '%s\\n' 0; fi
    ;;
  *'prisma migrate status'*)
    printf '%s\\n' gate:migration-status >>"$TRACE_FILE"
    test "$FAILURE_SCENARIO" != migration_status
    ;;
  *'prisma:migrate:checksum:verify'*)
    printf '%s\\n' gate:checksum >>"$TRACE_FILE"
    printf '%s\\n' '{"safe":true,"localMigrationCount":124,"appliedMigrationCount":124,"duplicateAppliedNames":[],"mismatchedNames":[],"missingFromDatabase":[],"missingLocally":[]}'
    ;;
  *'prisma migrate diff'*)
    printf '%s\\n' gate:drift >>"$TRACE_FILE"
    test "$FAILURE_SCENARIO" != drift
    ;;
  *'stage1-clean-acceptance-target-validator.mjs'*)
    printf '%s\\n' gate:validator >>"$TRACE_FILE"
    test "$FAILURE_SCENARIO" != validator || exit 72
    printf '%s\\n' '{"approvedManifest":{},"approvedManifestSha256":"${SHA256}","operation":"STAGE1_CLEAN_ACCEPTANCE_TARGET_VALIDATOR","result":{"safe":true,"manifestSha256":"${SHA256}","mode":"target-validator"}}' >"$EVIDENCE_DIR/target-validator.post-switch.json"
    ;;
  *'exec '*' node -e '*)
    printf '%s\\n' gate:runtime-flags >>"$TRACE_FILE"
    test "$FAILURE_SCENARIO" != runtime_flags
    ;;
  'logs --since '*)
    printf '%s\\n' gate:docker-logs >>"$TRACE_FILE"
    case "$FAILURE_SCENARIO" in
      log_read) exit 73 ;;
      log_error) printf '%s\\n' 'ERROR stable-test-event' ;;
      log_pii) printf '%s\\n' 'bearer stable-test-event' ;;
      *) printf '%s\\n' 'INFO stable-test-event' ;;
    esac
    ;;
  *) printf '%s\\n' UNHANDLED_DOCKER_COMMAND >>"$TRACE_FILE"; exit 97 ;;
esac`
  );
  return binDirectory;
}

function browserFactFor(scenario) {
  const challenge = {
    schemaVersion: 1,
    runUtc: "20260830T120000Z",
    manifestSha256: SHA256,
    releaseSha: RELEASE_SHA,
    imageId: IMAGE_ID,
    switchedContainerId: CONTAINER_ID,
    switchStartedAtUtc: "2026-08-30T12:00:01Z",
    logObservationStartedAtUtc: "2026-08-30T12:00:00Z",
    challengeCreatedAtUtc: "2026-08-30T12:00:02Z",
    nonce: NONCE
  };
  const completedAtUtc =
    {
      browser_before_challenge: "2026-08-30T12:00:01Z",
      browser_after_window: "2026-08-30T12:00:04Z",
      browser_future: "2026-08-30T12:00:11Z"
    }[scenario] ?? "2026-08-30T12:00:03Z";
  return {
    schemaVersion: 1,
    decision: "accepted",
    challenge,
    completedAtUtc,
    publicHealth: { api: 200, admin: 200, portal: 200 },
    auth: true,
    rbac: true,
    profile: true,
    eSign: true,
    catalog: { products: true, vehicles: true, packages: true, contractTemplates: true },
    emptyDomains: {
      applications: 0,
      orders: 0,
      contracts: 0,
      billing: 0,
      subscriptionChanges: 0,
      returns: 0
    },
    entryPoints: {
      applications: "absent",
      orders: "absent",
      contracts: "absent",
      billing: "absent",
      subscriptionChanges: "absent",
      returns: "absent"
    },
    rawEnumerations: {
      applications: [],
      orders: [],
      contracts: [],
      billing: [],
      subscriptionChanges: [],
      returns: []
    },
    console: { errorCount: 0, warnCount: 0 },
    visualReview: { admin: true, portal: true, responsive: true },
    businessWrites: 0
  };
}

function runCutover(cutover, evidenceHelpers, scenario) {
  const hostDirectory = mkdtempSync(join(tmpdir(), "stage1-cutover-contract-"));
  const directory = toGitBashPath(hostDirectory);
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  const binDirectory = toGitBashPath(installLeafFakes(hostDirectory));
  const wrapper = `set -Eeuo pipefail
HARNESS_DIR=${JSON.stringify(directory)}
TRACE_FILE="$HARNESS_DIR/trace"
FAILURE_SCENARIO=${JSON.stringify(scenario)}
export HARNESS_DIR TRACE_FILE FAILURE_SCENARIO
PATH=${JSON.stringify(binDirectory)}:"$PATH"
export PATH
EVIDENCE_DIR="$HARNESS_DIR/evidence"
ENV_FILE="$HARNESS_DIR/live.env"
ENV_BACKUP="$HARNESS_DIR/old.env"
ENV_TEMP="$HARNESS_DIR/target.env"
export EVIDENCE_DIR ENV_FILE
mkdir -p "$EVIDENCE_DIR"
printf '%s\\n' old >"$ENV_FILE"
printf '%s\\n' old >"$ENV_BACKUP"
printf '%s\\n' target >"$ENV_TEMP"
printf '%s\\n' deadbeef >"$EVIDENCE_DIR/old-database.fingerprint.sha256"
printf '%s\\n' '{"schemaVersion":1,"cycles":[{"completedCycleId":"one","state":"completed","blockedCount":0},{"completedCycleId":"two","state":"completed","blockedCount":0}],"forbiddenDomainCountsBeforeSha256":"same","forbiddenDomainCountsAfterSha256":"same"}' >"$EVIDENCE_DIR/billing-completed-cycles.json"
chmod 0600 "$EVIDENCE_DIR/old-database.fingerprint.sha256" "$EVIDENCE_DIR/billing-completed-cycles.json"
RUN_UTC=20260830T120000Z
MANIFEST_SHA=${SHA256}
RELEASE_SHA=${RELEASE_SHA}
API_IMAGE_ID=${IMAGE_ID}
COMPOSE_FILE=fake-compose
STAGE1_ACCEPTANCE_PUBLIC_API_HEALTH_URL=api-health
STAGE1_ACCEPTANCE_PUBLIC_ADMIN_HEALTH_URL=admin-health
STAGE1_ACCEPTANCE_PUBLIC_PORTAL_HEALTH_URL=portal-health
STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL=secret-database-url
STAGE1_ACCEPTANCE_TARGET_DATABASE_URL=secret-target-url
STAGE1_ACCEPTANCE_DATABASE_ALLOWED_HOSTNAME=fake-host
BROWSER_ACCEPTANCE_TIMEOUT_SECONDS=1
test "$FAILURE_SCENARIO" = timeout_901 && BROWSER_ACCEPTANCE_TIMEOUT_SECONDS=901
test "$FAILURE_SCENARIO" = timeout_9999 && BROWSER_ACCEPTANCE_TIMEOUT_SECONDS=9999
test "$FAILURE_SCENARIO" = timeout_uint64_plus_one && BROWSER_ACCEPTANCE_TIMEOUT_SECONDS=18446744073709551617
test "$FAILURE_SCENARIO" = timeout_uint64_plus_900 && BROWSER_ACCEPTANCE_TIMEOUT_SECONDS=18446744073709552516
test "$FAILURE_SCENARIO" = timeout_arbitrary_length && BROWSER_ACCEPTANCE_TIMEOUT_SECONDS=99999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999
test "$FAILURE_SCENARIO" = browser_preseed && printf '%s\\n' stale >"$EVIDENCE_DIR/browser-acceptance.fact.json"
test "$FAILURE_SCENARIO" = challenge_preseed && printf '%s\\n' stale >"$EVIDENCE_DIR/browser-acceptance.challenge.json"
read() {
  printf '%s\\n' browser-read-invoked >>"$TRACE_FILE"
  builtin read "$@"
}
${evidenceHelpers}
${cutover}
`;
  try {
    const scriptPath = join(hostDirectory, "cutover-contract.sh");
    writeFileSync(scriptPath, wrapper, "utf8");
    const input =
      scenario === "browser_timeout"
        ? ""
        : scenario === "browser_reject"
          ? "REJECT\n"
          : scenario === "browser_invalid"
            ? "{}\n"
            : `${JSON.stringify(browserFactFor(scenario))}\n`;
    const result = spawnSync(bash, [toGitBashPath(scriptPath)], {
      encoding: "utf8",
      env: {
        ...process.env,
        APPROVED_API_IMAGE: "registry.test/api:approved",
        STAGE1_CUTOVER_API_RECREATE_FN: "true",
        STAGE1_CUTOVER_POST_SWITCH_GATES_FN: "true"
      },
      input,
      timeout: 15000
    });
    const tracePath = join(hostDirectory, "trace");
    return {
      env: readFileSync(join(hostDirectory, "live.env"), "utf8"),
      evidenceFiles: readdirSync(join(hostDirectory, "evidence")),
      result,
      trace: readFileSync(tracePath, "utf8").trim().split(/\r?\n/).filter(Boolean)
    };
  } finally {
    const resolvedDirectory = resolve(hostDirectory);
    const resolvedTemp = resolve(tmpdir());
    assert.ok(
      resolvedDirectory.startsWith(`${resolvedTemp}${sep}`) &&
        basename(resolvedDirectory).startsWith("stage1-cutover-contract-")
    );
    rmSync(resolvedDirectory, { force: true, recursive: true });
  }
}

function assertRollback(outcome, scenario, expectedTrace) {
  assert.notEqual(outcome.result.status, 0, `${scenario} must exit nonzero`);
  assert.equal(outcome.result.signal, null, `${scenario} must not hang`);
  assert.equal(outcome.env, "old\n", `${scenario} must restore the old env`);
  assert.ok(outcome.trace.includes(expectedTrace), `${scenario} must reach ${expectedTrace}`);
  assert.ok(outcome.trace.includes("old-public-health"), `${scenario} must verify old health`);
  assert.ok(
    outcome.trace.includes("old-database-fingerprint"),
    `${scenario} must verify old database fingerprint`
  );
  const recreates = outcome.trace.filter((entry) => entry.startsWith("recreate:"));
  assert.equal(
    recreates.length,
    scenario === "filesystem_sync" ? 1 : 2,
    `${scenario} must perform every reached API recreate plus rollback recreate`
  );
  assert.ok(
    recreates.every((entry) => entry === "recreate:api"),
    `${scenario} recreates api only`
  );
  assert.equal(
    outcome.trace.some((entry) => entry.startsWith("UNHANDLED_")),
    false,
    `${scenario} may not reach an unfaked service command`
  );
  assert.doesNotMatch(
    `${outcome.result.stdout}\n${outcome.result.stderr}`,
    /secret-(?:target|database)-url/
  );
}

const COMPLETE_GATE_TRACE = [
  "gate:container-id",
  "gate:container-image",
  "gate:container-revision",
  "gate:compose-image",
  "gate:container-running",
  "gate:container-health",
  "gate:restart-count",
  "gate:migration-status",
  "gate:checksum",
  "gate:checksum-assert",
  "gate:drift",
  "gate:migration-count",
  "gate:validator",
  "gate:runtime-flags",
  "gate:public-api",
  "gate:public-admin",
  "gate:public-portal",
  "gate:billing",
  "gate:docker-logs"
];

function assertCompleteGateTrace(outcome) {
  for (const entry of COMPLETE_GATE_TRACE) {
    assert.ok(outcome.trace.includes(entry), `real post-switch gate must reach ${entry}`);
  }
}

test("requires two independent, exact human approval stops", async () => {
  const contents = await readRunbook();
  const markers = [
    "STOP FOR HUMAN APPROVAL: BASELINE_APPLY_APPROVAL",
    "STOP FOR HUMAN APPROVAL: API_DATABASE_SWITCH_APPROVAL"
  ];
  for (const marker of markers) {
    assert.equal(contents.split(marker).length - 1, 1, `${marker} must occur exactly once`);
  }
  assertStrictOrder(contents, [
    markers[0],
    "--apply --vehicle-id",
    "--replay --vehicle-id",
    "stage1-clean-acceptance-target-validator.mjs",
    "STOP: CANDIDATE_API_TIMER_ISOLATION_UNPROVEN",
    "STOP: BILLING_COMPLETED_CYCLE_EVIDENCE_UNAVAILABLE",
    markers[1],
    'mv -f -- "$ENV_TEMP" "$ENV_FILE"'
  ]);
});

test("defines fixed idempotent rollback before rename and routes switched failures through it", async () => {
  const { cutover } = validateExecutableContracts(await readRunbook());
  assertStrictOrder(cutover, [
    "rollback_api_database_switch() {",
    "rollback_and_stop() {",
    "trap 'rollback_after_switch_error' ERR",
    "SWITCH_ACTIVE=1",
    'mv -f -- "$ENV_TEMP" "$ENV_FILE"',
    "post_switch_database_gates",
    "SWITCH_ACTIVE=0"
  ]);
  assert.match(
    cutover,
    /if\s+!\s+cutover_api_recreate\s+api;\s+then\s+rollback_and_stop\s+'API_RECREATE_FAILED'/
  );
  assert.match(
    cutover,
    /rollback_after_switch_error\(\)[\s\S]{0,500}rollback_and_stop\s+'POST_SWITCH_GATE_FAILED'/
  );
  assertContainsAll(cutover, [
    "ROLLBACK_ENV_RESTORE_FAILED",
    "ROLLBACK_API_RECREATE_FAILED",
    "ROLLBACK_PUBLIC_HEALTH_FAILED",
    "ROLLBACK_OLD_DATABASE_FINGERPRINT_FAILED",
    "ROLLBACK_FAILED"
  ]);
});

test("never infers billing completion and keeps both source-code hard stops", async () => {
  const contents = await readRunbook();
  assert.doesNotMatch(contents, /\bsleep\s+130\b|billing_cycles_observed=2/);
  assertStrictOrder(contents, [
    "STOP: CANDIDATE_API_TIMER_ISOLATION_UNPROVEN",
    "STOP: BILLING_COMPLETED_CYCLE_EVIDENCE_UNAVAILABLE",
    "STOP FOR HUMAN APPROVAL: API_DATABASE_SWITCH_APPROVAL"
  ]);
  assertContainsAll(contents, [
    "两个不同的 completed cycle ID",
    "blockedCount=0",
    "禁止写域前后计数摘要一致",
    "ERROR|FATAL|Unhandled|PrismaClientKnownRequestError|HTTP 5",
    "PII_LOG_SCAN_CLEAR",
    "DOCKER_LOG_READ_FAILED"
  ]);
  assert.doesNotMatch(contents, /docker logs[^\n]*(?:\n[^\n]*){0,3}\|\| true/);
});

test("keeps complete database, runtime, public, billing, and log gates", async () => {
  const { cutover } = validateExecutableContracts(await readRunbook());
  const body = cutover.slice(indexOfUnique(cutover, "post_switch_database_gates() {"));
  assertContainsAll(body, [
    "stage1-clean-acceptance-target-validator.mjs",
    "prisma migrate status",
    "prisma:migrate:checksum:verify",
    "prisma migrate diff",
    "124 applied / 0 rolled-back / 0 pending / 0 failed / 0 duplicate",
    "RestartCount",
    "SUBSCRIPTION_JOURNEY_ENABLED",
    "SUBSCRIPTION_JOURNEY_WORKER_ENABLED",
    "BILLING_AUTOMATION_WORKER_ENABLED",
    "FIELD_VIDEO_UPLOAD_WORKER_ENABLED",
    "STAGE2_HANDOVER_WORKER_ENABLED",
    "MILEAGE_REVIEW_WORKER_ENABLED",
    "SUBSCRIPTION_EXTENSION_ENABLED",
    "SUBSCRIPTION_VEHICLE_SWAP_ENABLED",
    "SUBSCRIPTION_EARLY_TERMINATION_ENABLED",
    "SUBSCRIPTION_MANAGED_OTHER_ENABLED",
    "PUBLIC_API_HEALTH",
    "PUBLIC_ADMIN_HEALTH",
    "PUBLIC_PORTAL_HEALTH",
    "READ_ONLY_AUTH_RBAC_PROFILE_CATALOG_EMPTY_DOMAINS"
  ]);
});

test("binds approved source and target with the real env transformer before approval", async () => {
  const contents = await readRunbook();
  const { transformer } = validateExecutableContracts(contents);
  assertContainsAll(transformer, [
    "buildStage1AcceptanceDatabaseEnvSwitch",
    "STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL",
    "STAGE1_ACCEPTANCE_TARGET_DATABASE_URL"
  ]);
  assert.ok(
    contents.indexOf("<!-- STAGE1_ENV_TRANSFORM_EXECUTABLE_END -->") <
      contents.indexOf("STOP FOR HUMAN APPROVAL: API_DATABASE_SWITCH_APPROVAL") &&
      contents.indexOf("STOP FOR HUMAN APPROVAL: API_DATABASE_SWITCH_APPROVAL") <
        contents.indexOf("<!-- STAGE1_CUTOVER_EXECUTABLE_BEGIN -->")
  );
});

test("requires replay zero-write evidence before candidate and switch", async () => {
  const contents = await readRunbook();
  assertStrictOrder(contents, [
    ".auditCreated == 0 and .inserted == 0 and .updated == 0 and .deleted == 0",
    "STOP: CANDIDATE_API_TIMER_ISOLATION_UNPROVEN",
    "STOP FOR HUMAN APPROVAL: API_DATABASE_SWITCH_APPROVAL"
  ]);
});

test("makes evidence immutable/private and records complete backup metadata", async () => {
  const contents = await readRunbook();
  assertStrictOrder(contents, [
    'test ! -e "$EVIDENCE_DIR"',
    'install -d -o root -g root -m 0700 "$EVIDENCE_DIR"',
    'assert_private_directory "$EVIDENCE_DIR"'
  ]);
  assertContainsAll(contents, [
    "assert_new_evidence_path",
    "publish_private_evidence",
    "test ! -L",
    "uid=0",
    "gid=0",
    "mode=0700",
    "mode=0600",
    "backup_started_at_utc",
    "backup_completed_at_utc",
    "backup_size_bytes",
    "EVIDENCE_PERMISSION_SCAN_FAILED"
  ]);
});

test("keeps old database read-only and migration/backup gates fail closed", async () => {
  const contents = await readRunbook();
  assertContainsAll(contents, [
    "旧库全程只读",
    "禁止 repair",
    "TEMPLATE template0",
    "TARGET_DB_REGEX_INVALID",
    "migration deploy",
    "migrate status",
    "prisma:migrate:checksum:verify",
    "prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code",
    'DRIFT_EXIT="$?"',
    'test "$DRIFT_EXIT" -eq 0',
    "124 applied / 0 rolled-back / 0 pending / 0 failed / 0 duplicate",
    "先备份旧库，再备份空新库"
  ]);
  assert.doesNotMatch(contents, /^\s*(?:migrate\s+resolve|migrate\s+reset|repair\b)/im);
});

test("pins compose, release image, and fixed preflight identities", async () => {
  const contents = await readRunbook();
  assertContainsAll(contents, [
    'readonly COMPOSE_FILE="/opt/subscription-saas/docker-compose.staging.images.yml"',
    'readonly ENV_FILE="/opt/subscription-saas/.env.staging.images"',
    'readonly API_CONTAINER_ID="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q api)"',
    "org.opencontainers.image.revision",
    'readonly RUN_UTC="$(date -u +%Y%m%dT%H%M%SZ)"',
    'readonly EVIDENCE_DIR="/opt/subscription-saas/reports/stage1-clean-acceptance-${RUN_UTC}"',
    'readonly TARGET_DB="subscription_saas_staging_acceptance_${RUN_UTC,,}"',
    "docker compose config --services",
    "docker compose ps",
    "目标 API 镜像只运行一次 migration deploy",
    "磁盘、内存、连接数、容器 health、Git/image SHA"
  ]);
});

test("Task 9 preflight uses only the approved target image and reaches the approval stop through executable fences", async () => {
  const preflight = validateTask9PreflightContracts(await readRunbook());
  assert.ok(preflight.length > 0);
});

test("Task 9 executable helpers route target work through fake Docker when host database and JSON tools are unavailable", async () => {
  const preflight = extractExecutableFence(
    await readRunbook(),
    "STAGE1_TASK9_PREFLIGHT_EXECUTABLE"
  );
  const functions = preflight.slice(0, preflight.indexOf('test -f "$COMPOSE_FILE"'));
  const directory = mkdtempSync(join(tmpdir(), "task9-preflight-executable-"));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeFakeCommand(bin, "docker", 'printf "%s\\n" "$*" >>"$TRACE_FILE"');
  for (const name of ["jq", "node", "psql", "pg_dump"]) {
    writeFakeCommand(bin, name, `printf 'host-${name}-invoked\\n' >>"$TRACE_FILE"; exit 97`);
  }
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  const result = spawnSync(
    bash,
    [
      "-c",
      `${functions}
target_node scripts/stage1-task9-preflight-governance.mjs validate-pair
target_api sh -lc true`
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        APPROVED_API_IMAGE: "registry.test/api:approved",
        APPROVED_API_IMAGE_ID: IMAGE_ID,
        APPROVED_RELEASE_SHA: RELEASE_SHA,
        COMPOSE_PROJECT: "subauto-staging",
        EVIDENCE_DIR: directory,
        STAGE1_ACCEPTANCE_DATABASE_ALLOWED_HOSTNAME: "postgres",
        STAGE1_ACCEPTANCE_DATABASE_OWNER: "subscription_saas",
        STAGE1_ACCEPTANCE_IMAGE_REF: `registry.test/api@${IMAGE_ID}`,
        STAGE1_ACCEPTANCE_PUBLIC_ADMIN_HEALTH_URL: "admin-health",
        STAGE1_ACCEPTANCE_PUBLIC_API_HEALTH_URL: "api-health",
        STAGE1_ACCEPTANCE_PUBLIC_PORTAL_HEALTH_URL: "portal-health",
        STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL:
          "postgresql://subscription_saas:x@postgres:5432/subscription_saas_staging",
        STAGE1_ACCEPTANCE_TARGET_DATABASE_URL:
          "postgresql://subscription_saas:x@postgres:5432/subscription_saas_staging_acceptance_20260830t120000z",
        TARGET_DB: "subscription_saas_staging_acceptance_20260830t120000z",
        TRACE_FILE: toGitBashPath(join(directory, "trace")),
        PATH: `${toGitBashPath(bin)}:${process.env.PATH}`
      }
    }
  );
  assert.equal(result.status, 0, result.stderr);
  const tracePath = join(directory, "trace");
  const trace = readFileSync(tracePath, "utf8");
  rmSync(directory, { recursive: true, force: true });
  assert.match(trace, new RegExp(`run --rm -i .*${IMAGE_ID}`));
  assert.doesNotMatch(trace, /host-(?:jq|node|psql|pg_dump)-invoked/);
});

function runTask9Preflight(preflight, scenario = "success") {
  const host = mkdtempSync(join(tmpdir(), "task9-full-fence-"));
  mkdirSync(join(host, "reports"));
  writeFileSync(join(host, "docker-compose.staging.images.example.yml"), "services: {}\n");
  writeFileSync(join(host, ".env.staging.images"), "POSTGRES_USER=subscription_saas\n");
  const posix = toGitBashPath(host);
  const bin = join(host, "bin");
  mkdirSync(bin);
  const evidence = toGitBashPath(join(host, "reports", "stage1-clean-acceptance-20260830T120000Z"));
  const trace = toGitBashPath(join(host, "trace"));
  writeFakeCommand(bin, "date", "printf '%s\\n' 20260830T120000Z");
  writeFakeCommand(bin, "install", 'printf "%s\\n" install >>"$TRACE_FILE"; mkdir -p "${!#}"');
  writeFakeCommand(bin, "chown", 'printf "%s\\n" chown >>"$TRACE_FILE"');
  writeFakeCommand(bin, "chmod", 'printf "%s\\n" chmod >>"$TRACE_FILE"');
  writeFakeCommand(
    bin,
    "stat",
    `printf '%s\\n' stat >>"$TRACE_FILE"
if [[ "$*" == *'%u:%g:%a'* ]]; then target="\${!#}"; if test -d "$target"; then printf '%s\\n' '0:0:700'; else printf '%s\\n' '0:0:600'; fi; else printf '%s\\n' 1; fi`
  );
  writeFakeCommand(
    bin,
    "sha256sum",
    `printf '%s\\n' sha256sum >>"$TRACE_FILE"; printf '%s\\n' '${SHA256}  -'`
  );
  writeFakeCommand(
    bin,
    "curl",
    `printf '%s\\n' curl >>"$TRACE_FILE"
case "\${!#}" in
  api) failed_scenario=health_api ;;
  admin) failed_scenario=health_admin ;;
  portal) failed_scenario=health_portal ;;
  *) exit 96 ;;
esac
test "$FAILURE_SCENARIO" != "$failed_scenario"
printf 200`
  );
  for (const name of ["jq", "node", "psql", "pg_dump"])
    writeFakeCommand(bin, name, `printf 'HOST_${name}\\n' >>"$TRACE_FILE"; exit 97`);
  writeFakeCommand(
    bin,
    "docker",
    `args="$*"; printf '%s\\n' docker >>"$TRACE_FILE"
case "$args" in
  *'ps -q api'*) printf '%s\\n' ${CONTAINER_ID} ;;
  *'inspect --format {{.Image}}'*) printf '%s\\n' ${IMAGE_ID} ;;
  *'image inspect --format {{ index .Config.Labels "org.opencontainers.image.revision" }}'*) test "$FAILURE_SCENARIO" != image_revision || { printf '%s\\n' ${"f".repeat(40)}; exit 0; }; printf '%s\\n' ${RELEASE_SHA} ;;
  *'inspect --format {{ index .Config.Labels "org.opencontainers.image.revision" }}'*) printf '%s\\n' ${RELEASE_SHA} ;;
  *'image inspect --format {{.Id}}'*) test "$FAILURE_SCENARIO" != image_id || { printf '%s\\n' bad; exit 0; }; printf '%s\\n' ${IMAGE_ID} ;;
  *'image inspect --format {{index .RepoDigests 0}}'*) test "$FAILURE_SCENARIO" != image_digest || { printf '%s\\n' bad; exit 0; }; printf '%s\\n' registry.test/api@sha256:${"a".repeat(64)} ;;
  *'current_user;'*) printf '%s\\n' subscription_saas ;;
  *'pg_control_system'*) printf '%s\\n' server-id ;;
  *'SELECT EXISTS'*) test "$FAILURE_SCENARIO" != target_exists && printf f || printf t ;;
  *'information_schema.tables'*) test "$FAILURE_SCENARIO" != target_nonempty && printf 0 || printf 1 ;;
  *'_prisma_migrations'*) test "$FAILURE_SCENARIO" != migration_count && printf '124|0|0|0' || printf '123|0|0|0' ;;
  *'pg_dump'*) test "$FAILURE_SCENARIO" != backup && printf dump || exit 71 ;;
  *' -d subscription_saas_staging_acceptance_'*' -XAtq') test "$FAILURE_SCENARIO" != migration_count && printf '124|0|0|0' || printf '123|0|0|0' ;;
  *' -d subscription_saas_staging_acceptance_'*' -X -v ON_ERROR_STOP=1') test "$FAILURE_SCENARIO" != post_migration_nonempty || exit 72 ;;
  *'server-identity'*) test "$FAILURE_SCENARIO" != server_identity && printf '${SHA256}' || exit 73 ;;
  *'validate-pair'*) test "$FAILURE_SCENARIO" != url_identity || exit 74 ;;
  *'prisma migrate deploy'*) test "$FAILURE_SCENARIO" != migrate_deploy || exit 75 ;;
  *'prisma migrate status'*) test "$FAILURE_SCENARIO" != migrate_status || exit 76 ;;
  *' node -'*) test "$FAILURE_SCENARIO" != checksum || exit 77 ;;
  *'prisma:migrate:checksum:verify'*) test "$FAILURE_SCENARIO" != checksum || exit 77 ;;
  *'prisma migrate diff'*) test "$FAILURE_SCENARIO" != drift || exit 78 ;;
  *'--discover-vehicles'*) mkdir -p "$HARNESS_EVIDENCE"; printf '{}' >"$HARNESS_EVIDENCE/vehicle-discovery.json"; test "$FAILURE_SCENARIO" != discovery || exit 4; exit 3 ;;
  *'validate-selection'*) test "$FAILURE_SCENARIO" != uuid || exit 79 ;;
  *'--vehicle-id'*) mkdir -p "$HARNESS_EVIDENCE"; printf '{}' >"$HARNESS_EVIDENCE/baseline-dry-run.json"; test "$FAILURE_SCENARIO" != formal || exit 80 ;;
  *'approval-summary'*) if test "$FAILURE_SCENARIO" = approval; then exit 81; fi; printf '{"safe":true}' ;;
  *) : ;;
esac`
  );
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  const rewritten = `PATH=${JSON.stringify(toGitBashPath(bin))}:"$PATH"; export PATH
${preflight
  .replaceAll("/opt/subscription-saas", posix)
  .replaceAll("20260830T120000Z", "20260830T120000Z")}`;
  const scriptPath = join(host, "task9-preflight.sh");
  writeFileSync(scriptPath, rewritten, "utf8");
  const result = spawnSync(bash, [toGitBashPath(scriptPath)], {
    encoding: "utf8",
    input: `${"123e4567-e89b-42d3-a456-426614174000"}\n`,
    env: {
      ...process.env,
      APPROVED_API_IMAGE: "registry.test/api:tag",
      APPROVED_RELEASE_SHA: RELEASE_SHA,
      FAILURE_SCENARIO: scenario,
      HARNESS_EVIDENCE: evidence,
      TRACE_FILE: trace,
      STAGE1_ACCEPTANCE_DATABASE_OWNER: "subscription_saas",
      STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL:
        "postgresql://subscription_saas:x@postgres:5432/subscription_saas_staging",
      STAGE1_ACCEPTANCE_TARGET_DATABASE_URL:
        "postgresql://subscription_saas:x@postgres:5432/subscription_saas_staging_acceptance_20260830t120000z",
      STAGE1_ACCEPTANCE_DATABASE_ALLOWED_HOSTNAME: "postgres",
      STAGE1_ACCEPTANCE_PUBLIC_API_HEALTH_URL: "api",
      STAGE1_ACCEPTANCE_PUBLIC_ADMIN_HEALTH_URL: "admin",
      STAGE1_ACCEPTANCE_PUBLIC_PORTAL_HEALTH_URL: "portal",
      PATH: `${toGitBashPath(bin)}:${process.env.PATH}`
    }
  });
  const output = `${result.stdout}\n${result.stderr}`;
  const calls = readFileSync(join(host, "trace"), "utf8");
  rmSync(host, { recursive: true, force: true });
  return { result, output, calls };
}

test("Task 9 complete executable fence reaches approval only when every stateful gate is green", async () => {
  const preflight = extractExecutableFence(
    await readRunbook(),
    "STAGE1_TASK9_PREFLIGHT_EXECUTABLE"
  );
  const green = runTask9Preflight(preflight);
  assert.equal(green.result.status, 0, `${green.output}\n${green.calls}`);
  assert.match(green.output, /STOP FOR HUMAN APPROVAL: BASELINE_APPLY_APPROVAL/);
  assert.doesNotMatch(green.calls, /HOST_(?:jq|node|psql|pg_dump)/);
  const failureScenarios = [
    "health_api",
    "health_admin",
    "health_portal",
    "image_id",
    "image_digest",
    "image_revision",
    "url_identity",
    "server_identity",
    "target_exists",
    "target_nonempty",
    "backup",
    "migrate_deploy",
    "migrate_status",
    "checksum",
    "drift",
    "migration_count",
    "post_migration_nonempty",
    "discovery",
    "uuid",
    "formal",
    "approval"
  ];
  for (const scenario of failureScenarios) {
    const outcome = runTask9Preflight(preflight, scenario);
    assert.notEqual(outcome.result.status, 0, `${scenario} must stop`);
    assert.doesNotMatch(outcome.output, /BASELINE_APPLY_APPROVAL/, `${scenario} must not approve`);
  }
});

test("requires discovery, explicit UUID, approvals, apply/replay, and target validator", async () => {
  const contents = await readRunbook();
  assertContainsAll(contents, [
    "--discover-vehicles",
    '--vehicle-id "$APPROVED_VEHICLE_UUID"',
    "safeToApply=true",
    "exceptions=[]",
    "禁止域计数全部为 0",
    "manifest SHA 与独立 sha256sum 一致",
    "--apply",
    "--replay",
    "stage1-clean-acceptance-target-validator.mjs",
    "脱敏计数与车辆摘要"
  ]);
});

test("fails closed on candidate worker isolation and forbids business writes", async () => {
  const contents = await readRunbook();
  assertContainsAll(contents, [
    "127.0.0.1",
    "不接入 Nginx",
    "SUBSCRIPTION_JOURNEY_ENABLED=false",
    "SUBSCRIPTION_JOURNEY_WORKER_ENABLED=false",
    "BILLING_AUTOMATION_WORKER_ENABLED=false",
    "FIELD_VIDEO_UPLOAD_WORKER_ENABLED=false",
    "STAGE2_HANDOVER_WORKER_ENABLED=false",
    "MILEAGE_REVIEW_WORKER_ENABLED=false",
    "SubscriptionChangeWorker",
    "apps/api/src/subscription-change/subscription-change.worker.ts",
    "apps/api/src/subscription-change/subscription-change.module.ts",
    "CANDIDATE_API_TIMER_ISOLATION_UNPROVEN",
    "不得启动 candidate API",
    "不提交进件、不锁车、不签合同、不触发短信、电子签或支付"
  ]);
});

test("limits cutover and rollback to pathname-only env switch and API recreate", async () => {
  const contents = await readRunbook();
  assertContainsAll(contents, [
    "cp --preserve=mode,ownership,timestamps",
    "仅 pathname 不同",
    "保留 protocol/host/port/user/password/query",
    "同目录临时文件",
    "原子 rename",
    "只重建 API service",
    "恢复旧 env",
    "保留新库与证据",
    "不 DROP、不合并回旧库",
    "连续两个 billing maintenance cycle",
    "日志门禁",
    "浏览器验收",
    "禁止在在线 API 容器运行 pnpm 诊断"
  ]);
});

test("prohibits secrets and identities in output", async () => {
  const contents = await readRunbook();
  assertContainsAll(contents, [
    "不得输出 URL、凭据、环境文件内容、客户/车辆身份或 token",
    "只输出 hash、计数、稳定状态、固定证据路径、Git/image 身份"
  ]);
  assert.doesNotMatch(contents, /^\s*set\s+-x\b/m);
  assert.doesNotMatch(contents, /(?:cat|less|more|head|tail)\s+["']?\$ENV_FILE\b/);
  assert.doesNotMatch(contents, /docker\s+inspect[^\n]+\.Config\.Env/);
  assert.doesNotMatch(
    contents,
    /(?:echo|printf)[^\n]+\$(?:\{)?[^\s}"']*(?:DATABASE_URL|TOKEN|PASSWORD)/i
  );
});

test("all executable bash fences parse without executing them", async () => {
  const contents = await readRunbook();
  const blocks = [...contents.matchAll(/```bash\r?\n([\s\S]*?)```/g)].map((match) => match[1]);
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  assert.ok(blocks.length > 0);
  for (const [index, block] of blocks.entries()) {
    const result = spawnSync(bash, ["-n"], { encoding: "utf8", input: block });
    assert.equal(result.status, 0, `bash fence ${index + 1} must parse: ${result.stderr}`);
  }
});

test("designated fences reject transformer, gate, trap, identity, and browser mutations", async () => {
  const contents = await readRunbook();
  const { cutover, evidenceHelpers, transformer } = validateExecutableContracts(contents);
  const mutations = [
    contents.replace(
      "const after = buildStage1AcceptanceDatabaseEnvSwitch(",
      "// const after = buildStage1AcceptanceDatabaseEnvSwitch("
    ),
    contents.replace("post_switch_database_gates", "# post_switch_database_gates"),
    contents
      .replace("trap 'rollback_after_switch_error' ERR", "# trap moved")
      .replace(
        'mv -f -- "$ENV_TEMP" "$ENV_FILE"',
        'mv -f -- "$ENV_TEMP" "$ENV_FILE"\ntrap \'rollback_after_switch_error\' ERR'
      ),
    contents.replace('test "$switched_image_id" = "$API_IMAGE_ID"', ":"),
    contents.replace('test "$switched_release_sha" = "$RELEASE_SHA"', ":"),
    contents.replace('test "$compose_image_id" = "$API_IMAGE_ID"', ":"),
    contents.replace("fact.console.warnCount === 0", "fact.console.warnCount >= 0"),
    contents.replace(
      "completedAt <= challengeCreatedAt + timeoutSeconds * 1000",
      "completedAt >= challengeCreatedAt"
    ),
    contents.replace("^[1-9][0-9]{0,2}$", "^[1-9][0-9]*$")
  ];
  for (const mutation of mutations) assert.throws(() => validateExecutableContracts(mutation));
  assert.ok(cutover.length > 0 && evidenceHelpers.length > 0 && transformer.length > 0);
});

const MATERIAL_GATE_FAILURES = new Map([
  ["api_recreate", "recreate:api"],
  ["filesystem_sync", "gate:filesystem-sync"],
  ["container_id_drift", "gate:container-id"],
  ["image_drift", "gate:container-image"],
  ["revision_drift", "gate:container-revision"],
  ["compose_image_drift", "gate:compose-image"],
  ["container_running", "gate:container-running"],
  ["container_health", "gate:container-health"],
  ["restart_count", "gate:restart-count"],
  ["migration_status", "gate:migration-status"],
  ["checksum", "gate:checksum-assert"],
  ["drift", "gate:drift"],
  ["migration_count", "gate:migration-count"],
  ["validator", "gate:validator"],
  ["runtime_flags", "gate:runtime-flags"],
  ["public_api", "gate:public-api"],
  ["public_admin", "gate:public-admin"],
  ["public_portal", "gate:public-portal"],
  ["billing", "gate:billing"],
  ["log_read", "gate:docker-logs"],
  ["log_error", "gate:docker-logs"],
  ["log_pii", "gate:docker-logs"]
]);

for (const [scenario, expectedTrace] of MATERIAL_GATE_FAILURES) {
  test(`real ${scenario} failure rolls back through fixed production control flow`, async () => {
    const { cutover, evidenceHelpers } = validateExecutableContracts(await readRunbook());
    const outcome = runCutover(cutover, evidenceHelpers, scenario);
    assertRollback(outcome, scenario, expectedTrace);
    if (
      ["container_id_drift", "image_drift", "revision_drift", "compose_image_drift"].includes(
        scenario
      )
    ) {
      assert.equal(
        outcome.evidenceFiles.includes("browser-acceptance.challenge.json"),
        false,
        `${scenario} must roll back before challenge publication`
      );
    }
  });
}

test("rollback rejects an unhealthy restored API instead of overwriting the failed check", async () => {
  const { cutover, evidenceHelpers } = validateExecutableContracts(await readRunbook());
  const outcome = runCutover(cutover, evidenceHelpers, "rollback_health");
  assert.notEqual(outcome.result.status, 0);
  assert.equal(outcome.env, "old\n");
  assert.match(outcome.result.stdout, /STOP: ROLLBACK_PUBLIC_HEALTH_FAILED/);
  assert.match(outcome.result.stdout, /rollback_state=failed/);
});

const BROWSER_FAILURES = new Map([
  ["browser_reject", "gate:docker-logs"],
  ["browser_timeout", "gate:docker-logs"],
  ["browser_invalid", "gate:docker-logs"],
  ["browser_preseed", "gate:compose-image"],
  ["challenge_preseed", "gate:compose-image"],
  ["browser_before_challenge", "gate:docker-logs"],
  ["browser_after_window", "gate:docker-logs"],
  ["browser_future", "gate:docker-logs"],
  ["browser_validator_permission", "gate:docker-logs"],
  ["timeout_901", "gate:docker-logs"],
  ["timeout_9999", "gate:docker-logs"],
  ["timeout_uint64_plus_one", "gate:docker-logs"],
  ["timeout_uint64_plus_900", "gate:docker-logs"],
  ["timeout_arbitrary_length", "gate:docker-logs"]
]);

const TIMEOUT_REJECTED_BEFORE_BROWSER_WAIT = new Set([
  "timeout_901",
  "timeout_9999",
  "timeout_uint64_plus_one",
  "timeout_uint64_plus_900",
  "timeout_arbitrary_length"
]);

for (const [scenario, expectedTrace] of BROWSER_FAILURES) {
  test(`browser acceptance rejects ${scenario} and rolls back`, async () => {
    const { cutover, evidenceHelpers } = validateExecutableContracts(await readRunbook());
    const outcome = runCutover(cutover, evidenceHelpers, scenario);
    assertRollback(outcome, scenario, expectedTrace);
    if (TIMEOUT_REJECTED_BEFORE_BROWSER_WAIT.has(scenario)) {
      assert.equal(
        outcome.trace.includes("browser-read-invoked"),
        false,
        `${scenario} must roll back before browser read -t`
      );
    }
  });
}

test("real gate cannot early-return and unhandled service commands are poisoned locally", async () => {
  const { cutover, evidenceHelpers } = validateExecutableContracts(await readRunbook());
  const earlyReturn = cutover.replace(
    "post_switch_database_gates() {",
    "post_switch_database_gates() {\n  return 0"
  );
  const earlyOutcome = runCutover(earlyReturn, evidenceHelpers, "success");
  assert.equal(earlyOutcome.result.status, 0);
  assert.throws(() => assertCompleteGateTrace(earlyOutcome));

  const poisoned = cutover.replace(
    "\npost_switch_database_gates\n",
    "\ndocker unexpected-service-command\npost_switch_database_gates\n"
  );
  const poisonOutcome = runCutover(poisoned, evidenceHelpers, "success");
  assert.notEqual(poisonOutcome.result.status, 0);
  assert.ok(poisonOutcome.trace.includes("UNHANDLED_DOCKER_COMMAND"));
  assert.equal(poisonOutcome.env, "old\n");
  assert.ok(poisonOutcome.trace.includes("old-public-health"));
  assert.ok(poisonOutcome.trace.includes("old-database-fingerprint"));
});

test("success traverses the real gate, ignores ambient overrides, and validates browser window", async () => {
  const { cutover, evidenceHelpers } = validateExecutableContracts(await readRunbook());
  const outcome = runCutover(cutover, evidenceHelpers, "success");
  assert.equal(
    outcome.result.status,
    0,
    JSON.stringify({
      stderr: outcome.result.stderr,
      stdout: outcome.result.stdout,
      trace: outcome.trace
    })
  );
  assert.equal(outcome.env, "target\n");
  assertCompleteGateTrace(outcome);
  assert.ok(outcome.evidenceFiles.includes("browser-acceptance.challenge.json"));
  assert.ok(outcome.evidenceFiles.includes("browser-acceptance.fact.json"));
  assert.ok(outcome.evidenceFiles.includes("api-switch.state"));
  assert.equal(outcome.trace.filter((entry) => entry === "recreate:api").length, 1);
});
