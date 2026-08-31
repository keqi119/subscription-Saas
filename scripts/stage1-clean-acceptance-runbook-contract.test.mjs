import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
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

import {
  BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_SHA256,
  BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_VERSION,
  BILLING_MAINTENANCE_FORBIDDEN_KEYS,
  buildBillingMaintenanceCycleEvidence,
  canonicalBillingMaintenanceEvidenceJson,
  hashBillingMaintenanceEvidenceValue
} from "./billing-maintenance-cycle-evidence-core.mjs";
import { hashStage1CleanAcceptanceManifest } from "./stage1-clean-acceptance-baseline-core.mjs";
import {
  STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES,
  STAGE1_ACCEPTANCE_WHITELIST_DELEGATES
} from "./stage1-clean-acceptance-baseline-snapshot.mjs";

const runbookUrl = new URL(
  "../docs/runbooks/stage1-clean-staging-acceptance-database-rollout.zh-CN.md",
  import.meta.url
);
const SHA256 = "a".repeat(64);
const RELEASE_SHA = "b".repeat(40);
const IMAGE_ID = `sha256:${"c".repeat(64)}`;
const UNAPPROVED_IMAGE_ID = `sha256:${"f".repeat(64)}`;
const APPROVED_IMAGE_DIGEST = `registry.test/api@sha256:${"a".repeat(64)}`;
const UNAPPROVED_IMAGE_DIGEST = `registry.test/api@sha256:${"f".repeat(64)}`;
const CONTAINER_ID = "e".repeat(64);
const NONCE = "d".repeat(64);
const BILLING_NOT_BEFORE = "2026-08-30T12:00:01Z";
const CANDIDATE_HARNESS_COMPLETION_TIMEOUT_MS = 15_000;
const CANDIDATE_HARNESS_GRACEFUL_TERMINATION_TIMEOUT_MS = 1_000;
const CANDIDATE_HARNESS_FINAL_SETTLE_TIMEOUT_MS = 2_000;
const CANDIDATE_HARNESS_PROCESS_SNAPSHOT_TIMEOUT_MS = 5_000;
const BILLING_FAKE_EVIDENCE_DOCUMENT = buildFakeBillingEvidenceDocument();
const BILLING_FAKE_EVIDENCE = canonicalBillingMaintenanceEvidenceJson(
  BILLING_FAKE_EVIDENCE_DOCUMENT
);
const OLD_ENV_CONTENT = [
  "old",
  "BILLING_MAINTENANCE_EVIDENCE_ENABLED=true",
  `BILLING_MAINTENANCE_EVIDENCE_RUN_ID=${"1".repeat(64)}`,
  `BILLING_MAINTENANCE_EVIDENCE_RELEASE_SHA=${"2".repeat(40)}`,
  `BILLING_MAINTENANCE_EVIDENCE_IMAGE_DIGEST=sha256:${"3".repeat(64)}`,
  `BILLING_MAINTENANCE_EVIDENCE_DATABASE_IDENTITY_SHA256=${"4".repeat(64)}`,
  ""
].join("\n");

function buildFakeBillingEvidenceDocument() {
  const zeroCounts = Object.fromEntries(BILLING_MAINTENANCE_FORBIDDEN_KEYS.map((key) => [key, 0]));
  const countsSha256 = hashBillingMaintenanceEvidenceValue(zeroCounts);
  const facts = [1, 2].map((sequence) => {
    const startSecond = sequence === 1 ? 2 : 6;
    const utc = (second) => new Date(`2026-08-30T12:00:${String(second).padStart(2, "0")}.000Z`);
    return {
      afterCounts: { ...zeroCounts },
      afterCountsSha256: countsSha256,
      beforeCounts: { ...zeroCounts },
      beforeCountsSha256: countsSha256,
      blockedCount: 0,
      completedAt: utc(startSecond + 3),
      cycleStartedAt: utc(startSecond),
      databaseIdentitySha256: SHA256,
      enqueueCompletedAt: utc(startSecond + 2),
      enqueueSummary: { dueCount: 0, enqueuedCount: 0 },
      evidenceRunId: NONCE,
      forbiddenDomainSetSha256: BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_SHA256,
      forbiddenDomainSetVersion: BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_VERSION,
      id: `00000000-0000-4000-8000-00000000000${sequence}`,
      imageDigest: IMAGE_ID,
      reconciliationCompletedAt: utc(startSecond + 1),
      reconciliationSummary: {
        blockedCount: 0,
        blockerCodes: [],
        createdCount: 0,
        dryRun: false,
        eligibleCount: 0,
        existingCount: 0,
        leaseActivationCount: 0
      },
      releaseSha: RELEASE_SHA,
      sequence,
      status: "COMPLETED"
    };
  });
  return buildBillingMaintenanceCycleEvidence(facts, {
    expectedDatabaseIdentitySha256: SHA256,
    expectedImageDigest: IMAGE_ID,
    expectedReleaseSha: RELEASE_SHA,
    notBefore: BILLING_NOT_BEFORE,
    runId: NONCE,
    timeoutSeconds: 180
  });
}

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
    'test "$switched_image_id" = "$APPROVED_API_IMAGE_ID"',
    'test "$switched_image_digest" = "$APPROVED_API_IMAGE_DIGEST"',
    'test "$switched_release_sha" = "$APPROVED_API_IMAGE_REVISION"',
    'test "$switched_release_sha" = "$APPROVED_RELEASE_SHA"',
    'test "$compose_image_id" = "$APPROVED_API_IMAGE_ID"',
    'test "$compose_image_digest" = "$APPROVED_API_IMAGE_DIGEST"',
    'test "$compose_image_revision" = "$APPROVED_API_IMAGE_REVISION"',
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
    "BROWSER_ACCEPTANCE_FACT_INVALID",
    "cutover_billing_database_identity_sha256() {",
    "disable_billing_maintenance_evidence() {",
    "billing-maintenance-cycle-evidence.mjs",
    '--expected-release-sha "$APPROVED_RELEASE_SHA"',
    '--expected-image-digest "$APPROVED_API_IMAGE_ID"',
    'BILLING_MAINTENANCE_EVIDENCE_RELEASE_SHA="$APPROVED_RELEASE_SHA"',
    'BILLING_MAINTENANCE_EVIDENCE_IMAGE_DIGEST="$APPROVED_API_IMAGE_ID"',
    'publish_private_evidence "$EVIDENCE_DIR/billing-completed-cycles.json"',
    "BILLING_MAINTENANCE_EVIDENCE_TIMEOUT_SECONDS=180",
    "BILLING_MAINTENANCE_EVIDENCE_WATCHDOG_SECONDS=190",
    "timeout --signal=TERM --kill-after=5s",
    'SUBSCRIPTION_CHANGE_WORKER_ENABLED: "true"',
    'SUBSCRIPTION_RETURN_THREE_STAGE_ENABLED: "true"',
    "if (Object.entries(expected).some(([key, value]) => process.env[key] !== value)) process.exit(1);"
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
    'test "$CURRENT_ONLINE_API_IMAGE" = "$APPROVED_API_IMAGE_ID"',
    'test "$CURRENT_ONLINE_API_DIGEST" = "$APPROVED_API_IMAGE_DIGEST"',
    'test "$CURRENT_ONLINE_API_REVISION" = "$APPROVED_API_IMAGE_REVISION"',
    "config --images api",
    'test "$COMPOSE_API_IMAGE_ID" = "$APPROVED_API_IMAGE_ID"',
    'test "$COMPOSE_API_IMAGE_DIGEST" = "$APPROVED_API_IMAGE_DIGEST"',
    'test "$COMPOSE_API_IMAGE_REVISION" = "$APPROVED_API_IMAGE_REVISION"',
    "export TARGET_DB",
    "readonly MIN_HOST_DISK_AVAILABLE_KB=10485760",
    "readonly EXPECTED_API_MEMORY_LIMIT_BYTES=536870912",
    "readonly MIN_API_MEMORY_HEADROOM_BYTES=134217728",
    "readonly EXPECTED_POSTGRES_MAX_CONNECTIONS=30",
    "readonly MIN_POSTGRES_CONNECTION_HEADROOM=10",
    'docker compose --project-name "$COMPOSE_PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config --services',
    "STOP: COMPOSE_SERVICE_SET_INVALID",
    "STOP: API_CONTAINER_COUNT_INVALID",
    "STOP: API_CONTAINER_NOT_RUNNING",
    "STOP: API_CONTAINER_NOT_HEALTHY",
    "STOP: DISK_AVAILABLE_STATE_INVALID",
    "STOP: API_MEMORY_STATE_INVALID",
    "STOP: POSTGRES_CONNECTION_STATE_INVALID",
    "STOP: TIMEOUT_WATCHDOG_UNAVAILABLE",
    "command -v timeout",
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
  assert.match(preflight, /--env APPROVED_VEHICLE_UUID/);
  assert.doesNotMatch(preflight, /validate-selection[^\n]*["']?\$APPROVED_VEHICLE_UUID/);
  assert.doesNotMatch(preflight, /docker compose[^\n]+run[^\n]+\bapi\b/);
  assert.doesNotMatch(preflight, /^\s*(?:jq|node|psql|pg_dump)\b/m);
  assertStrictOrder(preflight, [
    "config --services",
    "API_CONTAINER_NOT_RUNNING",
    "API_CONTAINER_NOT_HEALTHY",
    'test "$CURRENT_ONLINE_API_IMAGE" = "$APPROVED_API_IMAGE_ID"',
    'test "$CURRENT_ONLINE_API_DIGEST" = "$APPROVED_API_IMAGE_DIGEST"',
    'test "$COMPOSE_API_IMAGE_ID" = "$APPROVED_API_IMAGE_ID"',
    'test "$COMPOSE_API_IMAGE_DIGEST" = "$APPROVED_API_IMAGE_DIGEST"',
    'stage1-task9-preflight-governance.mjs resource-disk "$MIN_HOST_DISK_AVAILABLE_KB"',
    'stage1-task9-preflight-governance.mjs resource-memory "$EXPECTED_API_MEMORY_LIMIT_BYTES" "$MIN_API_MEMORY_HEADROOM_BYTES"',
    'stage1-task9-preflight-governance.mjs resource-postgres-connections "$EXPECTED_POSTGRES_MAX_CONNECTIONS" "$MIN_POSTGRES_CONNECTION_HEADROOM"',
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
  writeFakeCommand(
    binDirectory,
    "sha256sum",
    `input="$(cat)"
if [[ "$input" = '{"databaseName":'* ]]; then
  printf '%s\\n' '${SHA256}  -'
else
  printf '%s\\n' 'deadbeef  -'
fi`
  );
  writeFakeCommand(
    binDirectory,
    "curl",
    `url="\${!#}"
IFS= read -r state <"$ENV_FILE"
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
  *pg_control_system*)
    printf '%s\\n' gate:billing-database-identity >>"$TRACE_FILE"
    printf '%s\\n' 'subscription_saas_staging_acceptance_20260830t120000z|7541900280213006521'
    ;;
  *secret-target-url*)
    printf '%s\\n' gate:migration-count >>"$TRACE_FILE"
    if test "$FAILURE_SCENARIO" = migration_count; then printf '%s\\n' '124|0|0|0'; else printf '%s\\n' '125|0|0|0'; fi
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
    test "$FAILURE_SCENARIO" != billing_assert
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
IFS= read -r state <"$ENV_FILE"
effective_env_value() {
  local key="$1"
  if [[ -v "$key" ]]; then
    printf '%s' "\${!key}"
  else
    awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
  fi
}
case "$args" in
  *' up -d --no-deps --force-recreate api'*)
    printf '%s\\n' recreate:api >>"$TRACE_FILE"
    if test "$state" = old; then
      test "$(effective_env_value BILLING_MAINTENANCE_EVIDENCE_ENABLED)" = false
      test -z "$(effective_env_value BILLING_MAINTENANCE_EVIDENCE_RUN_ID)"
      test -z "$(effective_env_value BILLING_MAINTENANCE_EVIDENCE_RELEASE_SHA)"
      test -z "$(effective_env_value BILLING_MAINTENANCE_EVIDENCE_IMAGE_DIGEST)"
      test -z "$(effective_env_value BILLING_MAINTENANCE_EVIDENCE_DATABASE_IDENTITY_SHA256)"
      printf '%s\\n' rollback-evidence-env-scrubbed >>"$TRACE_FILE"
    fi
    if [[ "$FAILURE_SCENARIO" = api_recreate || "$FAILURE_SCENARIO" = rollback_health ]] \
      && test "$state" = target; then exit 70; fi
    ;;
  *' ps -q api'*) printf '%s\\n' ${CONTAINER_ID} ;;
  'image inspect --format {{.Id}} approved-api')
    printf '%s\\n' gate:compose-image >>"$TRACE_FILE"
    if test "$FAILURE_SCENARIO" = compose_image_drift; then printf '%s\\n' sha256:${"f".repeat(64)}; else printf '%s\\n' ${IMAGE_ID}; fi
    ;;
  'image inspect --format {{index .RepoDigests 0}} ${IMAGE_ID}')
    printf '%s\\n' gate:container-image-digest >>"$TRACE_FILE"
    if test "$FAILURE_SCENARIO" = image_digest_drift; then printf '%s\\n' ${UNAPPROVED_IMAGE_DIGEST}; else printf '%s\\n' ${APPROVED_IMAGE_DIGEST}; fi
    ;;
  'image inspect --format {{index .RepoDigests 0}} approved-api')
    printf '%s\\n' gate:compose-image-digest >>"$TRACE_FILE"
    if test "$FAILURE_SCENARIO" = compose_image_digest_drift; then printf '%s\\n' ${UNAPPROVED_IMAGE_DIGEST}; else printf '%s\\n' ${APPROVED_IMAGE_DIGEST}; fi
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
    printf '%s\\n' '{"safe":true,"localMigrationCount":125,"appliedMigrationCount":125,"duplicateAppliedNames":[],"mismatchedNames":[],"missingFromDatabase":[],"missingLocally":[]}'
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
  *'billing-maintenance-cycle-evidence.mjs'*)
    printf '%s\\n' gate:billing-exporter >>"$TRACE_FILE"
    expected_args='exec ${CONTAINER_ID} node /app/scripts/billing-maintenance-cycle-evidence.mjs --run-id ${NONCE} --expected-release-sha ${RELEASE_SHA} --expected-image-digest ${IMAGE_ID} --expected-database-identity-sha256 ${SHA256} --not-before ${BILLING_NOT_BEFORE} --timeout-seconds 180'
    if test "$args" != "$expected_args"; then
      printf '%s\\n' BILLING_CLI_ARGV_INVALID >>"$TRACE_FILE"
      exit 97
    fi
    printf '%s\\n' gate:billing-cli-argv-verified >>"$TRACE_FILE"
    if test "$FAILURE_SCENARIO" = billing_hang; then
      trap '' TERM
      while :; do sleep 1; done
    fi
    case "$FAILURE_SCENARIO" in
      billing_timeout) code=BILLING_MAINTENANCE_EVIDENCE_TIMEOUT ;;
      billing_binding) code=BILLING_MAINTENANCE_SOURCE_BINDING_MISMATCH ;;
      billing_hash) code=BILLING_MAINTENANCE_COUNTS_INVALID ;;
      billing_blocked) code=BILLING_MAINTENANCE_BLOCKED ;;
      billing_cli) code=BILLING_MAINTENANCE_DATABASE_QUERY_FAILED ;;
      *) code= ;;
    esac
    if test -n "$code"; then printf '{"error":{"code":"%s"}}\\n' "$code" >&2; exit 74; fi
    printf '%s\\n' '${BILLING_FAKE_EVIDENCE}'
    ;;
  *'exec '*' node -e '*)
    if test "$state" = old; then
      test "$(effective_env_value BILLING_MAINTENANCE_EVIDENCE_ENABLED)" = false
      test -z "$(effective_env_value BILLING_MAINTENANCE_EVIDENCE_RUN_ID)"
      test -z "$(effective_env_value BILLING_MAINTENANCE_EVIDENCE_RELEASE_SHA)"
      test -z "$(effective_env_value BILLING_MAINTENANCE_EVIDENCE_IMAGE_DIGEST)"
      test -z "$(effective_env_value BILLING_MAINTENANCE_EVIDENCE_DATABASE_IDENTITY_SHA256)"
      printf '%s\\n' gate:rollback-evidence-disabled >>"$TRACE_FILE"
    else
      printf '%s\\n' gate:runtime-flags >>"$TRACE_FILE"
      test "$FAILURE_SCENARIO" != runtime_flags
    fi
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

function runCutover(cutover, evidenceHelpers, scenario, options = {}) {
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
printf '%s\\n' \
  old \
  'BILLING_MAINTENANCE_EVIDENCE_ENABLED=true' \
  'BILLING_MAINTENANCE_EVIDENCE_RUN_ID=${"1".repeat(64)}' \
  'BILLING_MAINTENANCE_EVIDENCE_RELEASE_SHA=${"2".repeat(40)}' \
  'BILLING_MAINTENANCE_EVIDENCE_IMAGE_DIGEST=sha256:${"3".repeat(64)}' \
  'BILLING_MAINTENANCE_EVIDENCE_DATABASE_IDENTITY_SHA256=${"4".repeat(64)}' \
  >"$ENV_FILE"
cp "$ENV_FILE" "$ENV_BACKUP"
printf '%s\\n' target >"$ENV_TEMP"
printf '%s\\n' deadbeef >"$EVIDENCE_DIR/old-database.fingerprint.sha256"
chmod 0600 "$EVIDENCE_DIR/old-database.fingerprint.sha256"
RUN_UTC=20260830T120000Z
MANIFEST_SHA=${SHA256}
RELEASE_SHA=${RELEASE_SHA}
API_IMAGE_ID=${IMAGE_ID}
APPROVED_RELEASE_SHA=${RELEASE_SHA}
APPROVED_API_IMAGE_ID=${IMAGE_ID}
APPROVED_API_IMAGE_DIGEST=${APPROVED_IMAGE_DIGEST}
APPROVED_API_IMAGE_REVISION=${RELEASE_SHA}
COMPOSE_FILE=fake-compose
STAGE1_ACCEPTANCE_PUBLIC_API_HEALTH_URL=api-health
STAGE1_ACCEPTANCE_PUBLIC_ADMIN_HEALTH_URL=admin-health
STAGE1_ACCEPTANCE_PUBLIC_PORTAL_HEALTH_URL=portal-health
STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL=secret-database-url
STAGE1_ACCEPTANCE_TARGET_DATABASE_URL=secret-target-url
STAGE1_ACCEPTANCE_DATABASE_ALLOWED_HOSTNAME=fake-host
TARGET_DB=subscription_saas_staging_acceptance_20260830t120000z
BROWSER_ACCEPTANCE_TIMEOUT_SECONDS=1
test "$FAILURE_SCENARIO" = timeout_901 && BROWSER_ACCEPTANCE_TIMEOUT_SECONDS=901
test "$FAILURE_SCENARIO" = timeout_9999 && BROWSER_ACCEPTANCE_TIMEOUT_SECONDS=9999
test "$FAILURE_SCENARIO" = timeout_uint64_plus_one && BROWSER_ACCEPTANCE_TIMEOUT_SECONDS=18446744073709551617
test "$FAILURE_SCENARIO" = timeout_uint64_plus_900 && BROWSER_ACCEPTANCE_TIMEOUT_SECONDS=18446744073709552516
test "$FAILURE_SCENARIO" = timeout_arbitrary_length && BROWSER_ACCEPTANCE_TIMEOUT_SECONDS=99999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999
test "$FAILURE_SCENARIO" = browser_preseed && printf '%s\\n' stale >"$EVIDENCE_DIR/browser-acceptance.fact.json"
test "$FAILURE_SCENARIO" = challenge_preseed && printf '%s\\n' stale >"$EVIDENCE_DIR/browser-acceptance.challenge.json"
read() {
  if [[ " $* " = *' -t '* ]]; then
    printf '%s\\n' browser-read-invoked >>"$TRACE_FILE"
  fi
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
      timeout: options.timeoutMilliseconds ?? 15000
    });
    const tracePath = join(hostDirectory, "trace");
    const billingEvidencePath = join(hostDirectory, "evidence", "billing-completed-cycles.json");
    return {
      billingEvidenceText: existsSync(billingEvidencePath)
        ? readFileSync(billingEvidencePath, "utf8")
        : null,
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

function candidateHarnessWindowsProcessTreePids(rootPid) {
  if (process.platform !== "win32" || !Number.isInteger(rootPid) || rootPid <= 0) {
    return [];
  }
  const script = [
    `$root = ${rootPid}`,
    "$children = @{}",
    "Get-CimInstance Win32_Process | ForEach-Object {",
    "  $parent = [int]$_.ParentProcessId",
    "  if (-not $children.ContainsKey($parent)) { $children[$parent] = @() }",
    "  $children[$parent] += [int]$_.ProcessId",
    "}",
    "function Get-Descendants([int]$processId) {",
    "  Write-Output $processId",
    "  if ($children.ContainsKey($processId)) { foreach ($child in $children[$processId]) { Get-Descendants $child } }",
    "}",
    "Get-Descendants $root"
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: CANDIDATE_HARNESS_PROCESS_SNAPSHOT_TIMEOUT_MS
    }
  );
  if (result.status !== 0) return [rootPid];
  return [
    ...new Set(
      result.stdout
        .split(/\r?\n/)
        .map((value) => Number.parseInt(value.trim(), 10))
        .filter((pid) => Number.isInteger(pid) && pid > 0)
    )
  ];
}

function forceTerminateCandidateHarnessTree(child, processTreePids = []) {
  const pids = [
    ...new Set([...processTreePids, child.pid].filter((pid) => Number.isInteger(pid) && pid > 0))
  ];
  if (process.platform === "win32") {
    for (const pid of pids) {
      spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: CANDIDATE_HARNESS_FINAL_SETTLE_TIMEOUT_MS
      });
    }
    return;
  }
  if (!Number.isInteger(child.pid) || child.pid <= 0) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processIsAlive(pid);
}

function waitForCandidateHarnessCompletion(child, options = {}) {
  const completionTimeoutMs =
    options.completionTimeoutMs ?? CANDIDATE_HARNESS_COMPLETION_TIMEOUT_MS;
  const startupTimeoutMs = options.startupTimeoutMs ?? completionTimeoutMs;
  const gracefulTerminationTimeoutMs =
    options.gracefulTerminationTimeoutMs ?? CANDIDATE_HARNESS_GRACEFUL_TERMINATION_TIMEOUT_MS;
  const finalSettleTimeoutMs =
    options.finalSettleTimeoutMs ?? CANDIDATE_HARNESS_FINAL_SETTLE_TIMEOUT_MS;
  const timeoutReadyPath = options.timeoutReadyPath ?? null;
  return new Promise((resolve) => {
    let stderr = "";
    let stdout = "";
    let timedOut = false;
    let forceTerminated = false;
    let settled = false;
    let completionTimer;
    let forceTerminationTimer;
    let finalSettleTimer;
    let readinessPollTimer;
    let startupTimer;
    let terminationProcessTreePids = [];
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(completionTimer);
      clearTimeout(forceTerminationTimer);
      clearTimeout(finalSettleTimer);
      clearTimeout(readinessPollTimer);
      clearTimeout(startupTimer);
      resolve(result);
    };
    const beginTimeout = () => {
      timedOut = true;
      terminationProcessTreePids = candidateHarnessWindowsProcessTreePids(child.pid);
      child.kill("SIGTERM");
      forceTerminationTimer = setTimeout(() => {
        forceTerminated = true;
        forceTerminateCandidateHarnessTree(child, terminationProcessTreePids);
        finalSettleTimer = setTimeout(() => {
          settle({
            error: `candidate harness did not exit within ${completionTimeoutMs}ms`,
            forceTerminated,
            signal: child.signalCode ?? null,
            status: child.exitCode ?? null,
            stderr,
            terminationProcessTreePids,
            stdout
          });
        }, finalSettleTimeoutMs);
      }, gracefulTerminationTimeoutMs);
    };
    const beginCompletionTimeout = () => {
      completionTimer = setTimeout(beginTimeout, completionTimeoutMs);
    };
    const waitForTimeoutReady = () => {
      if (existsSync(timeoutReadyPath)) {
        beginCompletionTimeout();
        return;
      }
      readinessPollTimer = setTimeout(waitForTimeoutReady, 25);
    };

    if (timeoutReadyPath) {
      startupTimer = setTimeout(beginTimeout, startupTimeoutMs);
      waitForTimeoutReady();
    } else {
      beginCompletionTimeout();
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      settle({
        error: error.message,
        forceTerminated,
        signal: null,
        status: null,
        stderr,
        terminationProcessTreePids,
        stdout
      });
    });
    child.once("close", (status, signal) => {
      settle({
        error: timedOut ? `candidate harness did not exit within ${completionTimeoutMs}ms` : null,
        forceTerminated,
        signal,
        status,
        stderr,
        terminationProcessTreePids,
        stdout
      });
    });
  });
}

async function runCandidate(candidate, candidateStop, scenario = "success", harnessOptions = {}) {
  const hostDirectory = mkdtempSync(join(tmpdir(), "stage1-candidate-contract-"));
  const directory = toGitBashPath(hostDirectory);
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  const binDirectory = join(hostDirectory, "fake-bin");
  mkdirSync(binDirectory);
  const fakeDocker = `set -Eeuo pipefail
readonly CANDIDATE_ID=${CONTAINER_ID}
readonly POSTGRES_ID=${"f".repeat(64)}
readonly NETWORK_ID=${"a".repeat(64)}
readonly REPLACEMENT_CANDIDATE_ID=${"b".repeat(64)}
readonly REPLACEMENT_NETWORK_ID=${"c".repeat(64)}
state="$HARNESS_DIR/candidate-state"
meta="$HARNESS_DIR/candidate-meta"
candidate_id_state="$HARNESS_DIR/candidate-id"
candidate_owner_state="$HARNESS_DIR/candidate-owner"
network_state="$HARNESS_DIR/candidate-network"
network_id_state="$HARNESS_DIR/candidate-network-id"
network_owner_state="$HARNESS_DIR/candidate-network-owner"
network_members="$HARNESS_DIR/candidate-network-members"
network_alias="$HARNESS_DIR/candidate-network-alias"
signal_sent="$HARNESS_DIR/candidate-signal-sent"

trace() { printf '%s\\n' "$1" >>"$TRACE_FILE"; }
load_meta() { test -f "$meta" && source "$meta"; }
require_candidate() { test -f "$state" && test -f "$meta" && test -f "$candidate_id_state"; }
candidate_id() { cat "$candidate_id_state"; }
candidate_owner() { cat "$candidate_owner_state"; }
network_exists() { test -f "$network_state"; }
network_name() { cat "$network_state"; }
network_id() { cat "$network_id_state"; }
network_owner() { cat "$network_owner_state"; }
network_has_member() { grep -Fqx "$1" "$network_members"; }
network_add_member() { network_has_member "$1" || printf '%s\\n' "$1" >>"$network_members"; }
network_remove_member() { grep -Fvx "$1" "$network_members" >"$network_members.tmp" || true; mv "$network_members.tmp" "$network_members"; }
replace_candidate() {
  printf '%s' "$REPLACEMENT_CANDIDATE_ID" >"$candidate_id_state"
  printf '%s' unowned-replacement >"$candidate_owner_state"
  network_remove_member "$CANDIDATE_ID"
  network_add_member "$REPLACEMENT_CANDIDATE_ID"
  trace candidate-replaced
}
replace_network() {
  printf '%s' "$REPLACEMENT_NETWORK_ID" >"$network_id_state"
  printf '%s' unowned-replacement >"$network_owner_state"
  trace candidate-network-replaced
}
send_candidate_signal() {
  test -n "\${SIGNAL_PARENT_PID-}" && test ! -e "$signal_sent" || return 0
  : >"$signal_sent"
  case "$FAILURE_SCENARIO" in
    signal_hup) trace candidate-signal-hup; kill -HUP "$SIGNAL_PARENT_PID" ;;
    signal_int) trace candidate-signal-int; kill -INT "$SIGNAL_PARENT_PID" ;;
    signal_term) trace candidate-signal-term; kill -TERM "$SIGNAL_PARENT_PID" ;;
    signal_after_network_create) trace candidate-signal-after-network-create; kill -TERM "$SIGNAL_PARENT_PID" ;;
    signal_after_container_run) trace candidate-signal-after-container-run; kill -TERM "$SIGNAL_PARENT_PID" ;;
  esac
}

case "\${1-}" in
  compose)
    if [[ "$*" == *' ps -q postgres'* ]]; then
      printf '%s\\n' "$POSTGRES_ID"
      exit 0
    fi
    ;;
  container)
    if test "\${2-}" = inspect; then
      test -f "$state" || exit 1
      exit 0
    fi
    ;;
  network)
    case "\${2-}" in
      create)
        shift 2
        candidate_network_owner=""
        if test "\${1-}" = --label; then
          candidate_network_owner="\${2#*=}"
          shift 2
        fi
        candidate_network="\${1-}"
        test -n "$candidate_network" && ! network_exists || exit 1
        test "$FAILURE_SCENARIO" != network_create_failure || exit 75
        printf '%s' "$candidate_network" >"$network_state"
        printf '%s' "$NETWORK_ID" >"$network_id_state"
        printf '%s' "$candidate_network_owner" >"$network_owner_state"
        : >"$network_members"
        trace candidate-network-create
        if test "$FAILURE_SCENARIO" = signal_after_network_create; then send_candidate_signal; fi
        printf '%s\\n' "$NETWORK_ID"
        exit 0
        ;;
      inspect)
        shift 2
        network_format=""
        if test "\${1-}" = --format; then
          network_format="\${2-}"
          shift 2
        fi
        test "\${1-}" = "$(network_name 2>/dev/null)" || test "\${1-}" = "$(network_id 2>/dev/null)" || exit 1
        case "$network_format" in
          '{{.Id}}') network_id ;;
          *'com.subauto.stage1.candidate.owner'*) printf '%s|%s\\n' "$(network_id)" "$(network_owner)" ;;
          *'.Containers'*) cat "$network_members" ;;
        esac
        exit 0
        ;;
      connect)
        shift 2
        test "\${1-}" = --alias || exit 97
        candidate_alias="\${2-}"
        candidate_network="\${3-}"
        candidate_postgres="\${4-}"
        test "$candidate_network" = "$(network_name 2>/dev/null)" && test "$candidate_postgres" = "$POSTGRES_ID" || exit 1
        test "$FAILURE_SCENARIO" != postgres_attach_failure || exit 76
        printf '%s' "$candidate_alias" >"$network_alias"
        network_add_member "$POSTGRES_ID"
        trace candidate-network-connect-postgres
        exit 0
        ;;
      disconnect)
        shift 2
        candidate_network="\${1-}"
        candidate_postgres="\${2-}"
        { test "$candidate_network" = "$(network_name 2>/dev/null)" || test "$candidate_network" = "$(network_id 2>/dev/null)"; } && test "$candidate_postgres" = "$POSTGRES_ID" || exit 1
        if { test "$FAILURE_SCENARIO" = network_toctou_replacement || test "$FAILURE_SCENARIO" = stop_network_toctou_replacement; } && test "$candidate_network" = "$NETWORK_ID"; then
          replace_network
          trace candidate-network-disconnect-old-id-rejected
          exit 83
        fi
        test "$FAILURE_SCENARIO" != cleanup_failure || { trace candidate-cleanup-failure; exit 77; }
        network_has_member "$POSTGRES_ID" || exit 1
        network_remove_member "$POSTGRES_ID"
        trace candidate-network-disconnect-postgres
        exit 0
        ;;
      rm)
        candidate_network="\${3-}"
        test "$candidate_network" = "$(network_name 2>/dev/null)" || test "$candidate_network" = "$(network_id 2>/dev/null)" || exit 1
        test ! -s "$network_members" || exit 1
        rm -f "$network_state" "$network_id_state" "$network_owner_state" "$network_members" "$network_alias"
        trace candidate-network-rm
        exit 0
        ;;
    esac
    ;;
  inspect)
    shift
    inspect_format=""
    if test "\${1-}" = --format; then
      inspect_format="\${2-}"
      shift 2
    fi
    inspect_target="\${1-}"
    if test "$inspect_target" = "$POSTGRES_ID"; then
      test "$inspect_format" = '{{.Id}}' || exit 97
      printf '%s\\n' "$POSTGRES_ID"
      exit 0
    fi
    require_candidate || exit 1
    load_meta
    test "$inspect_target" = "$candidate_name" || test "$inspect_target" = "$(candidate_id)" || exit 1
    case "$inspect_format" in
      '{{.Id}}')
        send_candidate_signal
        printf '%s\\n' "$(candidate_id)"
        ;;
      *'com.subauto.stage1.candidate.owner'*)
        send_candidate_signal
        printf '%s|%s\\n' "$(candidate_id)" "$(candidate_owner)"
        ;;
      '{{.Image}}') printf '%s\\n' "$candidate_image" ;;
      *'org.opencontainers.image.revision'*) printf '%s\\n' ${RELEASE_SHA} ;;
      '{{.HostConfig.NetworkMode}}') printf '%s\\n' "$candidate_network" ;;
      *'NetworkSettings.Networks'*) printf '%s\\n' "$candidate_network" ;;
      '{{json .HostConfig.PortBindings}}')
        if test -n "$candidate_publish"; then printf '%s\\n' '{"3001/tcp":["published"]}'; else printf '%s\\n' null; fi
        ;;
      *) trace "UNHANDLED_INSPECT_FORMAT:$inspect_format"; exit 97 ;;
    esac
    exit 0
    ;;
  run)
    run_argv="$*"
    shift
    candidate_name=""
    candidate_network=""
    candidate_image=""
    candidate_publish=""
    candidate_owner=""
    env_database_url=""
    env_target_database_url=""
    env_target_db=""
    env_subscription_journey=""
    env_subscription_journey_worker=""
    env_billing=""
    env_field_video=""
    env_handover=""
    env_mileage=""
    env_change=""
    env_return=""
    while test "$#" -gt 0; do
      case "$1" in
        -d) shift ;;
        --name) candidate_name="\${2-}"; shift 2 ;;
        --network) candidate_network="\${2-}"; shift 2 ;;
        --label) candidate_owner="\${2#*=}"; shift 2 ;;
        --publish|-p) candidate_publish="\${2-}"; shift 2 ;;
        --env)
          env_spec="\${2-}"
          env_key="\${env_spec%%=*}"
          if [[ "$env_spec" == *=* ]]; then env_value="\${env_spec#*=}"; else env_value="\${!env_key-}"; fi
          case "$env_key" in
            DATABASE_URL) env_database_url="$env_value" ;;
            STAGE1_ACCEPTANCE_TARGET_DATABASE_URL) env_target_database_url="$env_value" ;;
            TARGET_DB) env_target_db="$env_value" ;;
            SUBSCRIPTION_JOURNEY_ENABLED) env_subscription_journey="$env_value" ;;
            SUBSCRIPTION_JOURNEY_WORKER_ENABLED) env_subscription_journey_worker="$env_value" ;;
            BILLING_AUTOMATION_WORKER_ENABLED) env_billing="$env_value" ;;
            FIELD_VIDEO_UPLOAD_WORKER_ENABLED) env_field_video="$env_value" ;;
            STAGE2_HANDOVER_WORKER_ENABLED) env_handover="$env_value" ;;
            MILEAGE_REVIEW_WORKER_ENABLED) env_mileage="$env_value" ;;
            SUBSCRIPTION_CHANGE_WORKER_ENABLED) env_change="$env_value" ;;
            SUBSCRIPTION_RETURN_THREE_STAGE_ENABLED) env_return="$env_value" ;;
          esac
          shift 2
          ;;
        *) candidate_image="$1"; shift ;;
      esac
    done
    printf '%s\\n' "$run_argv" >"$HARNESS_DIR/candidate-run-argv"
    test -n "$candidate_name" && test -n "$candidate_network" && test -n "$candidate_image" || exit 97
    if [[ "$run_argv" == *'postgresql://'* ]]; then
      trace candidate-secret-literal-argv
      exit 78
    fi
    test "$FAILURE_SCENARIO" != launch && test "$FAILURE_SCENARIO" != launch_failure || exit 71
    test "$candidate_network" = "$(network_name 2>/dev/null)" || exit 1
    {
      printf 'candidate_name=%q\\n' "$candidate_name"
      printf 'candidate_network=%q\\n' "$candidate_network"
      printf 'candidate_image=%q\\n' "$candidate_image"
      printf 'candidate_publish=%q\\n' "$candidate_publish"
      printf 'candidate_owner=%q\\n' "$candidate_owner"
      printf 'env_database_url=%q\\n' "$env_database_url"
      printf 'env_target_database_url=%q\\n' "$env_target_database_url"
      printf 'env_target_db=%q\\n' "$env_target_db"
      printf 'env_subscription_journey=%q\\n' "$env_subscription_journey"
      printf 'env_subscription_journey_worker=%q\\n' "$env_subscription_journey_worker"
      printf 'env_billing=%q\\n' "$env_billing"
      printf 'env_field_video=%q\\n' "$env_field_video"
      printf 'env_handover=%q\\n' "$env_handover"
      printf 'env_mileage=%q\\n' "$env_mileage"
      printf 'env_change=%q\\n' "$env_change"
      printf 'env_return=%q\\n' "$env_return"
    } >"$meta"
    printf running >"$state"
    printf '%s' "$CANDIDATE_ID" >"$candidate_id_state"
    printf '%s' "$candidate_owner" >"$candidate_owner_state"
    if test "$candidate_network" = "$(network_name)"; then network_add_member "$CANDIDATE_ID"; fi
    if test "$FAILURE_SCENARIO" = network_membership_drift; then
      network_add_member ${"d".repeat(64)}
    fi
    trace candidate-run
    if test "$FAILURE_SCENARIO" = signal_after_container_run; then send_candidate_signal; fi
    if test "$FAILURE_SCENARIO" = harness_timeout; then
      trace candidate-harness-timeout
      CANDIDATE_TIMEOUT_PID_FILE="$HARNESS_DIR/candidate-timeout-sleep.pid" \
        node -e 'require("node:fs").writeFileSync(process.env.CANDIDATE_TIMEOUT_PID_FILE, String(process.pid)); setTimeout(() => {}, 60_000)' &
      for _candidate_timeout_pid_attempt in $(seq 1 100); do
        test -s "$HARNESS_DIR/candidate-timeout-sleep.pid" && break
        /usr/bin/sleep 0.01
      done
      test -s "$HARNESS_DIR/candidate-timeout-sleep.pid" || exit 98
      : >"$HARNESS_DIR/candidate-timeout-ready"
      wait "$!"
    fi
    printf '%s\\n' "$CANDIDATE_ID"
    exit 0
    ;;
  exec)
    requested_candidate_name="\${2-}"
    require_candidate || exit 1
    load_meta
    test "$requested_candidate_name" = "$candidate_name" || exit 1
    args="$*"
    if [[ "$args" == *'DATABASE_URL !== process.env.STAGE1_ACCEPTANCE_TARGET_DATABASE_URL'* ]]; then
      trace candidate-runtime-env-checked
      if test "$FAILURE_SCENARIO" = container_replacement; then
        replace_candidate
        exit 81
      fi
      if test "$FAILURE_SCENARIO" = network_replacement; then
        replace_network
        exit 82
      fi
      if ! test "$env_database_url" = "$env_target_database_url" \
        || ! test -n "$env_target_db" \
        || ! test "$env_target_db" = "$TARGET_DB"; then
        trace candidate-runtime-env-database-mismatch
        exit 72
      fi
      for candidate_gate in env_subscription_journey env_subscription_journey_worker env_billing env_field_video env_handover env_mileage env_change env_return; do
        if ! test "\${!candidate_gate}" = false; then
          trace "candidate-runtime-env-gate-mismatch:$candidate_gate"
          exit 72
        fi
      done
      exit 0
    fi
    if [[ "$args" == *'fetch('* ]]; then
      trace candidate-internal-health
      test -z "$candidate_publish" || exit 79
      test "$FAILURE_SCENARIO" != internal_health_failure && test "$FAILURE_SCENARIO" != health_failure || exit 80
      exit 0
    fi
    trace candidate-runtime-command-unrecognized
    exit 96
    ;;
  rm)
    shift
    test "\${1-}" = -f && shift
    requested_candidate_name="\${1-}"
    require_candidate || exit 1
    load_meta
    test "$requested_candidate_name" = "$candidate_name" || test "$requested_candidate_name" = "$(candidate_id)" || exit 1
    if { test "$FAILURE_SCENARIO" = container_toctou_replacement || test "$FAILURE_SCENARIO" = stop_container_toctou_replacement; } && test "$requested_candidate_name" = "$CANDIDATE_ID"; then
      replace_candidate
      trace candidate-rm-old-id-rejected
      exit 84
    fi
    current_candidate_id="$(candidate_id)"
    rm -f "$state" "$meta" "$candidate_id_state" "$candidate_owner_state"
    if network_exists && network_has_member "$current_candidate_id"; then network_remove_member "$current_candidate_id"; fi
    trace candidate-rm
    exit 0
    ;;
esac
trace "UNHANDLED_DOCKER_COMMAND:$*"
exit 97`;
  writeFakeCommand(binDirectory, "docker", fakeDocker);
  writeFakeCommand(binDirectory, "sleep", "exit 0");
  const wrapper = `set -Eeuo pipefail
HARNESS_DIR=${JSON.stringify(directory)}
TRACE_FILE="$HARNESS_DIR/trace"
FAILURE_SCENARIO=${JSON.stringify(scenario)}
SIGNAL_PARENT_PID=$$
export HARNESS_DIR TRACE_FILE FAILURE_SCENARIO SIGNAL_PARENT_PID
PATH=${JSON.stringify(toGitBashPath(binDirectory))}:"$PATH"
export PATH
docker() (
${fakeDocker}
)
EVIDENCE_DIR="$HARNESS_DIR/evidence"
mkdir -p "$EVIDENCE_DIR"
APPROVED_API_IMAGE_ID=${IMAGE_ID}
APPROVED_RELEASE_SHA=${RELEASE_SHA}
COMPOSE_PROJECT=subauto-staging
COMPOSE_FILE=/fixture/docker-compose.yml
ENV_FILE=/fixture/.env.staging.images
RUN_UTC=20260831T120000Z
STAGE1_ACCEPTANCE_DATABASE_ALLOWED_HOSTNAME=postgres
STAGE1_ACCEPTANCE_TARGET_DATABASE_URL=postgresql://subscription:secret-password@postgres:5432/subscription_saas_staging_acceptance_20260830t120000z
DATABASE_URL="$STAGE1_ACCEPTANCE_TARGET_DATABASE_URL"
TARGET_DB=subscription_saas_staging_acceptance_20260830t120000z
assert_new_evidence_path() { test ! -e "$1" && test ! -L "$1"; }
assert_private_file() { test "$FAILURE_SCENARIO" != assert_failure && test -f "$1" && test ! -L "$1"; }
publish_private_evidence() { test "$FAILURE_SCENARIO" != evidence_failure && cat >"$1" && chmod 0600 "$1"; }
if test "$FAILURE_SCENARIO" = candidate_collision; then
  printf running >"$HARNESS_DIR/candidate-state"
fi
if test "$FAILURE_SCENARIO" = network_collision; then
  printf '%s' "subauto-staging-stage1-candidate-20260831t120000z" >"$HARNESS_DIR/candidate-network"
  : >"$HARNESS_DIR/candidate-network-members"
fi
${candidate}
if test "$FAILURE_SCENARIO" = success || [[ "$FAILURE_SCENARIO" = stop_* ]]; then
  printf '%s\\n' candidate-stop-fence-enter >>"$TRACE_FILE"
  ${candidateStop}
  printf '%s\\n' candidate-stop-fence-exit >>"$TRACE_FILE"
fi
`;
  try {
    const scriptPath = join(hostDirectory, "candidate-contract.sh");
    const candidateHarnessOptions = {
      ...harnessOptions,
      timeoutReadyPath: harnessOptions.awaitTimeoutReady
        ? join(hostDirectory, "candidate-timeout-ready")
        : harnessOptions.timeoutReadyPath
    };
    delete candidateHarnessOptions.awaitTimeoutReady;
    writeFileSync(scriptPath, wrapper, "utf8");
    const result = await waitForCandidateHarnessCompletion(
      spawn(bash, [toGitBashPath(scriptPath)], {
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"]
      }),
      candidateHarnessOptions
    );
    const tracePath = join(hostDirectory, "trace");
    const argvPath = join(hostDirectory, "candidate-run-argv");
    const launchEvidencePath = join(hostDirectory, "evidence", "candidate-api.launch.safe.state");
    const timeoutSleepPidPath = join(hostDirectory, "candidate-timeout-sleep.pid");
    return {
      candidateExists: existsSync(join(hostDirectory, "candidate-state")),
      candidateNetworkExists: existsSync(join(hostDirectory, "candidate-network")),
      postgresAttached:
        existsSync(join(hostDirectory, "candidate-network-members")) &&
        readFileSync(join(hostDirectory, "candidate-network-members"), "utf8").includes(
          "f".repeat(64)
        ),
      candidateRunArgv: existsSync(argvPath) ? readFileSync(argvPath, "utf8") : "",
      candidateLaunchEvidence: existsSync(launchEvidencePath)
        ? readFileSync(launchEvidencePath, "utf8")
        : "",
      timeoutSleepPid: existsSync(timeoutSleepPidPath)
        ? Number.parseInt(readFileSync(timeoutSleepPidPath, "utf8").trim(), 10)
        : null,
      error: result.error,
      result,
      trace: existsSync(tracePath)
        ? readFileSync(tracePath, "utf8")
            .trim()
            .split(/\\r?\\n/)
            .filter(Boolean)
        : []
    };
  } finally {
    const resolvedDirectory = resolve(hostDirectory);
    const resolvedTemp = resolve(tmpdir());
    assert.ok(
      resolvedDirectory.startsWith(`${resolvedTemp}${sep}`) &&
        basename(resolvedDirectory).startsWith("stage1-candidate-contract-")
    );
    rmSync(resolvedDirectory, { force: true, recursive: true });
  }
}

function assertRollback(outcome, scenario, expectedTrace) {
  assert.notEqual(outcome.result.status, 0, `${scenario} must exit nonzero`);
  assert.equal(outcome.result.signal, null, `${scenario} must not hang`);
  assert.equal(outcome.env, OLD_ENV_CONTENT, `${scenario} must restore the old env`);
  assert.ok(outcome.trace.includes(expectedTrace), `${scenario} must reach ${expectedTrace}`);
  assert.ok(
    outcome.trace.includes("old-public-health"),
    `${scenario} must verify old health: ${JSON.stringify({
      stderr: outcome.result.stderr,
      stdout: outcome.result.stdout,
      trace: outcome.trace
    })}`
  );
  assert.ok(
    outcome.trace.includes("rollback-evidence-env-scrubbed"),
    `${scenario} must override historical evidence values during rollback recreate`
  );
  assert.ok(
    outcome.trace.includes("gate:rollback-evidence-disabled"),
    `${scenario} must verify the restored container has disabled and empty evidence bindings`
  );
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
  "gate:billing-database-identity",
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
  "gate:billing-exporter",
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
    "SUBSCRIPTION_CHANGE_WORKER_ENABLED=false",
    "SUBSCRIPTION_RETURN_THREE_STAGE_ENABLED=false",
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

test("uses only the database-backed exporter for bounded billing completion evidence", async () => {
  const contents = await readRunbook();
  assert.doesNotMatch(contents, /\bsleep\s+130\b|billing_cycles_observed=2/);
  assert.doesNotMatch(contents, /STOP: BILLING_COMPLETED_CYCLE_EVIDENCE_UNAVAILABLE/);
  assertContainsAll(contents, [
    "billing-maintenance-cycle-evidence.mjs",
    "--run-id",
    "--expected-release-sha",
    "--expected-image-digest",
    "--expected-database-identity-sha256",
    "--not-before",
    "--timeout-seconds",
    'publish_private_evidence "$EVIDENCE_DIR/billing-completed-cycles.json"',
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
    "125 applied / 0 rolled-back / 0 pending / 0 failed / 0 duplicate",
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

test("requires replay zero-write evidence before candidate configuration and switch", async () => {
  const contents = await readRunbook();
  assertStrictOrder(contents, [
    ".auditCreated == 0 and .inserted == 0 and .updated == 0 and .deleted == 0",
    "SUBSCRIPTION_CHANGE_WORKER_ENABLED=false",
    "SUBSCRIPTION_RETURN_THREE_STAGE_ENABLED=false",
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
    "125 applied / 0 rolled-back / 0 pending / 0 failed / 0 duplicate",
    "先备份旧库，再备份空新库"
  ]);
  assert.doesNotMatch(contents, /^\s*(?:migrate\s+resolve|migrate\s+reset|repair\b)/im);
});

test("pins compose, release image, and fixed preflight identities", async () => {
  const preflight = validateTask9PreflightContracts(await readRunbook());
  assertContainsAll(preflight, [
    'readonly COMPOSE_FILE="/opt/subscription-saas/docker-compose.staging.images.example.yml"',
    'readonly ENV_FILE="/opt/subscription-saas/.env.staging.images"',
    'readonly COMPOSE_PROJECT="subauto-staging"',
    "org.opencontainers.image.revision",
    'readonly RUN_UTC="$(date -u +%Y%m%dT%H%M%SZ)"',
    'readonly EVIDENCE_DIR="${EVIDENCE_PARENT}/stage1-clean-acceptance-${RUN_UTC}"',
    'readonly TARGET_DB="subscription_saas_staging_acceptance_${RUN_UTC,,}"',
    "config --services",
    'resource-disk "$MIN_HOST_DISK_AVAILABLE_KB"',
    'resource-memory "$EXPECTED_API_MEMORY_LIMIT_BYTES" "$MIN_API_MEMORY_HEADROOM_BYTES"',
    'resource-postgres-connections "$EXPECTED_POSTGRES_MAX_CONNECTIONS" "$MIN_POSTGRES_CONNECTION_HEADROOM"'
  ]);
});

test("approved image identity directly binds formal acceptance, cutover, and billing evidence", async () => {
  const contents = await readRunbook();
  assertContainsAll(contents, [
    'test "$CURRENT_ONLINE_API_IMAGE" = "$APPROVED_API_IMAGE_ID"',
    'test "$CURRENT_ONLINE_API_DIGEST" = "$APPROVED_API_IMAGE_DIGEST"',
    'test "$API_IMAGE_ID" = "$APPROVED_API_IMAGE_ID"',
    'test "$API_IMAGE_REF" = "$APPROVED_API_IMAGE_DIGEST"',
    'test "$COMPOSE_API_IMAGE_ID" = "$APPROVED_API_IMAGE_ID"',
    'test "$COMPOSE_API_IMAGE_REF" = "$APPROVED_API_IMAGE_DIGEST"',
    'export STAGE1_ACCEPTANCE_IMAGE_REF="$APPROVED_API_IMAGE_DIGEST"',
    'test "$switched_image_id" = "$APPROVED_API_IMAGE_ID"',
    'test "$switched_image_digest" = "$APPROVED_API_IMAGE_DIGEST"',
    'BILLING_MAINTENANCE_EVIDENCE_RELEASE_SHA="$APPROVED_RELEASE_SHA"',
    'BILLING_MAINTENANCE_EVIDENCE_IMAGE_DIGEST="$APPROVED_API_IMAGE_ID"',
    '--expected-release-sha "$APPROVED_RELEASE_SHA"',
    '--expected-image-digest "$APPROVED_API_IMAGE_ID"'
  ]);
});

test("Task 9 preflight uses only the approved target image and reaches the approval stop through executable fences", async () => {
  const preflight = validateTask9PreflightContracts(await readRunbook());
  assert.ok(preflight.length > 0);
  assert.doesNotMatch(preflight, /--env\s+DATABASE_URL=/);
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

function task9FormalReport(nonzeroForbidden = false) {
  const manifest = {
    counts: { access: 0, catalog: 0, customer: 0, templates: 0, vehicle: 0 },
    exceptions: [],
    generatedAt: "2026-08-30T12:00:00.000Z",
    gitSha: RELEASE_SHA,
    hashSalt: "f".repeat(64),
    imageRef: `registry.test/api@sha256:${"a".repeat(64)}`,
    operation: "STAGE1_CLEAN_ACCEPTANCE_BASELINE",
    rowDigests: {
      access: SHA256,
      catalog: SHA256,
      customer: SHA256,
      templates: SHA256,
      vehicle: SHA256
    },
    safeToApply: true,
    schemaVersion: 1,
    selection: {
      adminDigest: SHA256,
      customerDigest: SHA256,
      vehicleDigests: ["f".repeat(64)]
    },
    source: {
      databaseDigest: SHA256,
      migrationCatalogDigest: SHA256,
      schemaDigest: SHA256
    },
    target: {
      databaseDigest: SHA256,
      migrationCatalogDigest: SHA256,
      schemaDigest: SHA256
    }
  };
  const forbiddenCounts = Object.fromEntries(
    STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES.map((key, index) => [
      key,
      nonzeroForbidden && index === 0 ? 1 : 0
    ])
  );
  return {
    manifest,
    manifestSha256: hashStage1CleanAcceptanceManifest(manifest),
    mode: "dry-run",
    operation: "STAGE1_CLEAN_ACCEPTANCE_BASELINE",
    safe: true,
    targetCountEvidence: {
      forbiddenCountKeys: [...STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES],
      forbiddenCounts,
      tableCountKeys: [...STAGE1_ACCEPTANCE_WHITELIST_DELEGATES],
      tableCounts: Object.fromEntries(STAGE1_ACCEPTANCE_WHITELIST_DELEGATES.map((key) => [key, 0]))
    }
  };
}

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
  const governanceScript = toGitBashPath(resolve("scripts/stage1-task9-preflight-governance.mjs"));
  const realNode = toGitBashPath(process.execPath);
  const formalZero = join(host, "formal-zero.json");
  const formalNonzero = join(host, "formal-nonzero.json");
  writeFileSync(formalZero, `${JSON.stringify(task9FormalReport())}\n`);
  writeFileSync(formalNonzero, `${JSON.stringify(task9FormalReport(true))}\n`);
  writeFakeCommand(bin, "date", "printf '%s\\n' 20260830T120000Z");
  writeFakeCommand(bin, "install", 'printf "%s\\n" install >>"$TRACE_FILE"; mkdir -p "${!#}"');
  writeFakeCommand(bin, "chown", 'printf "%s\\n" chown >>"$TRACE_FILE"');
  writeFakeCommand(bin, "chmod", 'printf "%s\\n" chmod >>"$TRACE_FILE"');
  writeFakeCommand(
    bin,
    "ln",
    `if test "$FAILURE_SCENARIO" = approval_publication && [[ "$*" = *baseline-approval.safe.json ]]; then printf '%s\\n' gate:approval-publication >>"$TRACE_FILE"; exit 81; fi; /usr/bin/ln "$@"`
  );
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
    "df",
    `printf '%s\\n' df >>"$TRACE_FILE"
printf '%s\\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on'
case "$FAILURE_SCENARIO" in
  disk_below) printf '%s\\n' gate:disk-headroom >>"$TRACE_FILE"; available=10485759 ;;
  disk_malformed) printf '%s\\n' gate:disk-parse >>"$TRACE_FILE"; available=not-a-count ;;
  *) available=10485760 ;;
esac
printf 'fake 41943040 0 %s 0%% /opt/subscription-saas\\n' "$available"`
  );
  writeFakeCommand(
    bin,
    "curl",
    `printf '%s\\n' curl >>"$TRACE_FILE"
case "\${!#}" in
  api) failed_scenario=health_api; gate=health-api ;;
  admin) failed_scenario=health_admin; gate=health-admin ;;
  portal) failed_scenario=health_portal; gate=health-portal ;;
  *) exit 96 ;;
esac
printf 'gate:%s\\n' "$gate" >>"$TRACE_FILE"
test "$FAILURE_SCENARIO" != "$failed_scenario"
printf 200`
  );
  for (const name of ["jq", "node", "psql", "pg_dump"])
    writeFakeCommand(bin, name, `printf 'HOST_${name}\\n' >>"$TRACE_FILE"; exit 97`);
  writeFakeCommand(
    bin,
    "docker",
    `args="$*"; printf '%s\\n' docker >>"$TRACE_FILE"
if [[ "$args" == *"$UUID_SENTINEL"* ]]; then printf '%s\\n' gate:vehicle-uuid-argv-leak >>"$TRACE_FILE"; exit 82; fi
case "$args" in
  *'config --services'*)
    if test "$FAILURE_SCENARIO" = compose_services; then printf '%s\\n' gate:compose-services >>"$TRACE_FILE"; printf '%s\\n' postgres api; else printf '%s\\n' postgres api web; fi ;;
  *'ps -q api'*)
    if test "$FAILURE_SCENARIO" = api_container_unique; then printf '%s\\n' gate:api-container-unique >>"$TRACE_FILE"; printf '%s\\n%s\\n' ${CONTAINER_ID} '${"d".repeat(64)}'; else printf '%s\\n' ${CONTAINER_ID}; fi ;;
  *'inspect --format {{.State.Running}}'*)
    if test "$FAILURE_SCENARIO" = api_not_running; then printf '%s\\n' gate:api-running >>"$TRACE_FILE"; printf false; else printf true; fi ;;
  *'inspect --format {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}'*)
    if test "$FAILURE_SCENARIO" = api_unhealthy; then printf '%s\\n' gate:api-health >>"$TRACE_FILE"; printf unhealthy; else printf healthy; fi ;;
  *'stats --no-stream --format {{.MemUsage}}'*)
    case "$FAILURE_SCENARIO" in
      api_memory_limit) printf '%s\\n' gate:api-memory-limit >>"$TRACE_FILE"; printf '%s\\n' '115.1MiB / 511.999999MiB' ;;
      api_memory_headroom) printf '%s\\n' gate:api-memory-headroom >>"$TRACE_FILE"; printf '%s\\n' '384.1MiB / 512MiB' ;;
      api_memory_malformed) printf '%s\\n' gate:api-memory-parse >>"$TRACE_FILE"; printf '%s\\n' 'malformed' ;;
      *) printf '%s\\n' '115.1MiB / 512MiB' ;;
    esac ;;
  *'inspect --format {{.Image}}'*)
    case "$FAILURE_SCENARIO" in
      approved_online_identity_mismatch) printf '%s\\n' ${UNAPPROVED_IMAGE_ID} ;;
      *) printf '%s\\n' ${IMAGE_ID} ;;
    esac ;;
  *'image inspect --format {{ index .Config.Labels "org.opencontainers.image.revision" }}'*)
    case "$FAILURE_SCENARIO" in
      image_revision_missing) printf '%s\\n' gate:image-revision-missing >>"$TRACE_FILE"; printf '\\n' ;;
      image_revision_malformed) printf '%s\\n' gate:image-revision-malformed >>"$TRACE_FILE"; printf '%s\\n' malformed ;;
      image_revision_mismatch) printf '%s\\n' gate:image-revision-mismatch >>"$TRACE_FILE"; printf '%s\\n' ${"f".repeat(40)} ;;
      *) printf '%s\\n' ${RELEASE_SHA} ;;
    esac ;;
  *'inspect --format {{ index .Config.Labels "org.opencontainers.image.revision" }}'*) printf '%s\\n' ${RELEASE_SHA} ;;
  *'config --images api'*) printf '%s\\n' registry.test/api:online ;;
  *'image inspect --format {{.Id}}'*)
    test "$FAILURE_SCENARIO" != image_id || { printf '%s\\n' gate:image-id >>"$TRACE_FILE"; printf '%s\\n' bad; exit 0; }
    if test "$FAILURE_SCENARIO" = approved_online_identity_mismatch && [[ "$args" = *registry.test/api:online ]]; then
      printf '%s\\n' ${UNAPPROVED_IMAGE_ID}
    else
      printf '%s\\n' ${IMAGE_ID}
    fi ;;
  *'image inspect --format {{index .RepoDigests 0}}'*)
    test "$FAILURE_SCENARIO" != image_digest || { printf '%s\\n' gate:image-digest >>"$TRACE_FILE"; printf '%s\\n' bad; exit 0; }
    if { test "$FAILURE_SCENARIO" = approved_online_identity_mismatch || test "$FAILURE_SCENARIO" = approved_online_digest_mismatch; } \\
      && [[ "$args" != *registry.test/api:tag ]]; then
      printf '%s\\n' ${UNAPPROVED_IMAGE_DIGEST}
    else
      printf '%s\\n' ${APPROVED_IMAGE_DIGEST}
    fi ;;
  *'pg_stat_activity'*)
    case "$FAILURE_SCENARIO" in
      postgres_max_connections) printf '%s\\n' gate:postgres-max-connections >>"$TRACE_FILE"; printf '%s\\n' '20|31' ;;
      postgres_headroom) printf '%s\\n' gate:postgres-connection-headroom >>"$TRACE_FILE"; printf '%s\\n' '21|30' ;;
      postgres_connections_malformed) printf '%s\\n' gate:postgres-connection-parse >>"$TRACE_FILE"; printf '%s\\n' 'twenty|30' ;;
      *) printf '%s\\n' '20|30' ;;
    esac ;;
  *'current_user;'*) printf '%s\\n' subscription_saas ;;
  *'pg_control_system'*) printf '%s\\n' server-id ;;
  *'SELECT EXISTS'*) printf '%s\\n' gate:target-exists >>"$TRACE_FILE"; test "$FAILURE_SCENARIO" != target_exists && printf f || printf t ;;
  *'information_schema.tables'*) test "$FAILURE_SCENARIO" != target_nonempty || printf '%s\\n' gate:target-empty >>"$TRACE_FILE"; test "$FAILURE_SCENARIO" != target_nonempty && printf 0 || printf 1 ;;
  *'_prisma_migrations'*) test "$FAILURE_SCENARIO" != migration_count || printf '%s\\n' gate:migration-count >>"$TRACE_FILE"; test "$FAILURE_SCENARIO" != migration_count && printf '125|0|0|0' || printf '124|0|0|0' ;;
  *'pg_dump'*) test "$FAILURE_SCENARIO" != backup || { printf '%s\\n' gate:backup >>"$TRACE_FILE"; exit 71; }; printf dump ;;
  *' -d subscription_saas_staging_acceptance_'*' -XAtq') test "$FAILURE_SCENARIO" != migration_count || printf '%s\\n' gate:migration-count >>"$TRACE_FILE"; test "$FAILURE_SCENARIO" != migration_count && printf '125|0|0|0' || printf '124|0|0|0' ;;
  *' -d subscription_saas_staging_acceptance_'*' -X -v ON_ERROR_STOP=1') test "$FAILURE_SCENARIO" != post_migration_nonempty || { printf '%s\\n' gate:post-migration-business-count >>"$TRACE_FILE"; exit 72; } ;;
  *'source-server-identity'*) if test "$FAILURE_SCENARIO" = server_identity; then printf '%s\\n' gate:server-identity-different-cluster >>"$TRACE_FILE"; printf '%s\\n' '${"d".repeat(64)}'; else printf '%s\\n' '${SHA256}'; fi ;;
  *'target-server-identity'*) printf '%s\\n' '${SHA256}' ;;
  *'validate-pair'*)
    case "$FAILURE_SCENARIO" in
      source_name_mismatch)
        printf '%s\\n' gate:url-source-database >>"$TRACE_FILE"
        export STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL='postgresql://subscription_saas:x@postgres:5432/not_the_source?schema=public'
        ;;
      url_semantics_mismatch)
        printf '%s\\n' gate:url-semantics >>"$TRACE_FILE"
        export STAGE1_ACCEPTANCE_TARGET_DATABASE_URL='postgresql://subscription_saas:x@postgres:5432/subscription_saas_staging_acceptance_20260830t120000z?schema=other'
        ;;
    esac
    "$REAL_NODE" "$TASK9_GOVERNANCE_SCRIPT" validate-pair ;;
  *'prisma migrate deploy'*) test "$FAILURE_SCENARIO" != migrate_deploy || { printf '%s\\n' gate:migration-deploy >>"$TRACE_FILE"; exit 75; } ;;
  *'prisma migrate status'*) test "$FAILURE_SCENARIO" != migrate_status || { printf '%s\\n' gate:migration-status >>"$TRACE_FILE"; exit 76; } ;;
  *' node -'*) test "$FAILURE_SCENARIO" != checksum || { printf '%s\\n' gate:migration-checksum >>"$TRACE_FILE"; exit 77; } ;;
  *'prisma:migrate:checksum:verify'*) test "$FAILURE_SCENARIO" != checksum || { printf '%s\\n' gate:migration-checksum >>"$TRACE_FILE"; exit 77; } ;;
  *'prisma migrate diff'*) test "$FAILURE_SCENARIO" != drift || { printf '%s\\n' gate:migration-drift >>"$TRACE_FILE"; exit 78; } ;;
  *'--discover-vehicles'*) mkdir -p "$HARNESS_EVIDENCE"; printf '{"candidates":[{"id":"%s"}]}' "$UUID_SENTINEL" >"$HARNESS_EVIDENCE/vehicle-discovery.json"; test "$FAILURE_SCENARIO" != discovery || { printf '%s\\n' gate:discovery >>"$TRACE_FILE"; exit 4; }; exit 3 ;;
  *'resource-disk'*) "$REAL_NODE" "$TASK9_GOVERNANCE_SCRIPT" resource-disk "\${@: -1}" ;;
  *'resource-memory'*) "$REAL_NODE" "$TASK9_GOVERNANCE_SCRIPT" resource-memory "\${@: -2:1}" "\${@: -1}" ;;
  *'resource-postgres-connections'*) "$REAL_NODE" "$TASK9_GOVERNANCE_SCRIPT" resource-postgres-connections "\${@: -2:1}" "\${@: -1}" ;;
  *'validate-selection'*)
    test "$FAILURE_SCENARIO" != uuid || { printf '%s\\n' gate:vehicle-selection >>"$TRACE_FILE"; export APPROVED_VEHICLE_UUID='223e4567-e89b-42d3-a456-426614174000'; }
    "$REAL_NODE" "$TASK9_GOVERNANCE_SCRIPT" validate-selection "$HARNESS_EVIDENCE/vehicle-discovery.json" ;;
  *'--vehicle-id'*) mkdir -p "$HARNESS_EVIDENCE"; if test "$FAILURE_SCENARIO" = formal_nonzero; then /usr/bin/cp "$FORMAL_NONZERO_REPORT" "$HARNESS_EVIDENCE/baseline-dry-run.json"; else /usr/bin/cp "$FORMAL_ZERO_REPORT" "$HARNESS_EVIDENCE/baseline-dry-run.json"; fi ;;
  *'approval-summary'*) if test "$FAILURE_SCENARIO" = formal_nonzero; then printf '%s\\n' gate:approval-summary-nonzero >>"$TRACE_FILE"; else printf '%s\\n' gate:approval-summary >>"$TRACE_FILE"; fi; "$REAL_NODE" "$TASK9_GOVERNANCE_SCRIPT" approval-summary "$HARNESS_EVIDENCE/baseline-dry-run.json" ;;
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
      FORMAL_NONZERO_REPORT: toGitBashPath(formalNonzero),
      FORMAL_ZERO_REPORT: toGitBashPath(formalZero),
      HARNESS_EVIDENCE: evidence,
      REAL_NODE: realNode,
      TASK9_GOVERNANCE_SCRIPT: governanceScript,
      TRACE_FILE: trace,
      UUID_SENTINEL: "123e4567-e89b-42d3-a456-426614174000",
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

test("Task 9 preflight rejects approved image ID and digest drift before database state changes", async () => {
  const preflight = extractExecutableFence(
    await readRunbook(),
    "STAGE1_TASK9_PREFLIGHT_EXECUTABLE"
  );
  for (const scenario of ["approved_online_identity_mismatch", "approved_online_digest_mismatch"]) {
    const outcome = runTask9Preflight(preflight, scenario);
    assert.notEqual(outcome.result.status, 0, `${scenario} must stop`);
    assert.doesNotMatch(
      outcome.calls,
      /^gate:target-exists$/m,
      `${scenario} must stop before target database lookup/create`
    );
    assert.doesNotMatch(outcome.output, /BASELINE_APPLY_APPROVAL/);
  }
});

test(
  "Task 9 complete executable fence reaches approval only when every stateful gate is green",
  { concurrency: 4 },
  async (t) => {
    const preflight = extractExecutableFence(
      await readRunbook(),
      "STAGE1_TASK9_PREFLIGHT_EXECUTABLE"
    );
    const green = runTask9Preflight(preflight);
    assert.equal(green.result.status, 0, `${green.output}\n${green.calls}`);
    assert.match(green.output, /STOP FOR HUMAN APPROVAL: BASELINE_APPLY_APPROVAL/);
    assert.doesNotMatch(green.calls, /HOST_(?:jq|node|psql|pg_dump)/);
    assert.doesNotMatch(green.calls, /vehicle-uuid-argv-leak/);
    const allFailureScenarios = [
      "compose_services",
      "api_container_unique",
      "api_not_running",
      "api_unhealthy",
      "disk_below",
      "disk_malformed",
      "api_memory_limit",
      "api_memory_headroom",
      "api_memory_malformed",
      "postgres_max_connections",
      "postgres_headroom",
      "postgres_connections_malformed",
      "health_api",
      "health_admin",
      "health_portal",
      "image_id",
      "image_digest",
      "image_revision_missing",
      "image_revision_malformed",
      "image_revision_mismatch",
      "source_name_mismatch",
      "url_semantics_mismatch",
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
      "formal_nonzero",
      "approval_publication"
    ];
    const expectedLastGate = {
      api_container_unique: "gate:api-container-unique",
      api_memory_headroom: "gate:api-memory-headroom",
      api_memory_limit: "gate:api-memory-limit",
      api_memory_malformed: "gate:api-memory-parse",
      api_not_running: "gate:api-running",
      api_unhealthy: "gate:api-health",
      approval_publication: "gate:approval-publication",
      backup: "gate:backup",
      checksum: "gate:migration-checksum",
      compose_services: "gate:compose-services",
      discovery: "gate:discovery",
      disk_below: "gate:disk-headroom",
      disk_malformed: "gate:disk-parse",
      drift: "gate:migration-drift",
      formal_nonzero: "gate:approval-summary-nonzero",
      health_admin: "gate:health-admin",
      health_api: "gate:health-api",
      health_portal: "gate:health-portal",
      image_digest: "gate:image-digest",
      image_id: "gate:image-id",
      image_revision_malformed: "gate:image-revision-malformed",
      image_revision_mismatch: "gate:image-revision-mismatch",
      image_revision_missing: "gate:image-revision-missing",
      migrate_deploy: "gate:migration-deploy",
      migrate_status: "gate:migration-status",
      migration_count: "gate:migration-count",
      post_migration_nonempty: "gate:post-migration-business-count",
      postgres_connections_malformed: "gate:postgres-connection-parse",
      postgres_headroom: "gate:postgres-connection-headroom",
      postgres_max_connections: "gate:postgres-max-connections",
      server_identity: "gate:server-identity-different-cluster",
      source_name_mismatch: "gate:url-source-database",
      target_exists: "gate:target-exists",
      target_nonempty: "gate:target-empty",
      url_semantics_mismatch: "gate:url-semantics",
      uuid: "gate:vehicle-selection"
    };
    await Promise.all(
      allFailureScenarios.map((scenario) =>
        t.test(scenario, () => {
          const outcome = runTask9Preflight(preflight, scenario);
          assert.notEqual(outcome.result.status, 0, `${scenario} must stop`);
          assert.doesNotMatch(
            outcome.output,
            /BASELINE_APPLY_APPROVAL/,
            `${scenario} must not approve`
          );
          const reachedGates = outcome.calls.match(/^gate:[^\r\n]+/gm) ?? [];
          assert.equal(
            reachedGates.at(-1),
            expectedLastGate[scenario],
            `${scenario} must stop at its uniquely mapped gate\n${outcome.calls}`
          );
        })
      )
    );
  }
);

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

test("pins candidate worker isolation and forbids business writes", async () => {
  const contents = await readRunbook();
  assertContainsAll(contents, [
    "candidate **不发布主机端口**",
    "不读取、修改或 reload Nginx",
    "正式切换后的既有浏览器 gate",
    "SUBSCRIPTION_JOURNEY_ENABLED=false",
    "SUBSCRIPTION_JOURNEY_WORKER_ENABLED=false",
    "BILLING_AUTOMATION_WORKER_ENABLED=false",
    "FIELD_VIDEO_UPLOAD_WORKER_ENABLED=false",
    "STAGE2_HANDOVER_WORKER_ENABLED=false",
    "MILEAGE_REVIEW_WORKER_ENABLED=false",
    "SUBSCRIPTION_CHANGE_WORKER_ENABLED=false",
    "SUBSCRIPTION_RETURN_THREE_STAGE_ENABLED=false",
    "apps/api/src/subscription-change/subscription-change.worker.ts",
    "workerEnabled()",
    "subscription-change-worker.spec.ts",
    "false 或缺失值都不会启动轮询",
    "只有精确字符串 `true` 才允许新的三阶段 case",
    "不提交进件、不锁车、不签合同、不触发短信、电子签或支付"
  ]);
});

test("candidate executable keeps database secrets out of argv and proves a dedicated no-host-route boundary", async () => {
  const contents = await readRunbook();
  const candidate = extractExecutableFence(contents, "STAGE1_CANDIDATE_API_EXECUTABLE");

  assert.match(candidate, /export DATABASE_URL STAGE1_ACCEPTANCE_TARGET_DATABASE_URL/);
  assert.match(candidate, /--env DATABASE_URL(?:\s|\\)/);
  assert.match(candidate, /--env STAGE1_ACCEPTANCE_TARGET_DATABASE_URL(?:\s|\\)/);
  assert.doesNotMatch(candidate, /--env\s+(?:DATABASE_URL|STAGE1_ACCEPTANCE_TARGET_DATABASE_URL)=/);
  assert.doesNotMatch(candidate, /(?:--publish|docker port|curl[^\n]+127\.0\.0\.1:)/);
  assert.match(candidate, /CANDIDATE_OWNERSHIP_TOKEN=.*urandom/);
  assert.match(
    candidate,
    /docker network create --label "\$CANDIDATE_OWNERSHIP_LABEL=\$CANDIDATE_OWNERSHIP_TOKEN" "\$CANDIDATE_API_NETWORK"/
  );
  assert.match(
    candidate,
    /docker run -d --name "\$CANDIDATE_API_CONTAINER"[\s\S]+?--label "\$CANDIDATE_OWNERSHIP_LABEL=\$CANDIDATE_OWNERSHIP_TOKEN"/
  );
  assert.doesNotMatch(candidate, /CANDIDATE_(?:API_)?CREATED|CANDIDATE_POSTGRES_ATTACHED/);
  assert.match(candidate, /docker network connect --alias/);
  assert.match(candidate, /docker network inspect --format/);
  assert.match(candidate, /docker exec "\$CANDIDATE_API_CONTAINER" node -e/);
  assert.match(candidate, /trap 'candidate_exit_trap_cleanup' ERR EXIT/);
  assert.match(candidate, /trap 'candidate_signal_trap_cleanup 129' HUP/);
  assert.match(candidate, /trap 'candidate_signal_trap_cleanup 130' INT/);
  assert.match(candidate, /trap 'candidate_signal_trap_cleanup 143' TERM/);
  assert.match(candidate, /CANDIDATE_API_NETWORK_ID="\$\(docker network create/);
  assert.match(candidate, /docker network disconnect/);
  assert.match(candidate, /docker network rm/);
});

test("candidate health uses the actual in-container endpoint without an image HEALTHCHECK", async () => {
  const contents = await readRunbook();
  const candidate = extractExecutableFence(contents, "STAGE1_CANDIDATE_API_EXECUTABLE");
  const candidateStop = extractExecutableFence(contents, "STAGE1_CANDIDATE_API_STOP_EXECUTABLE");
  const outcome = await runCandidate(candidate, candidateStop, "health_failure");

  assert.doesNotMatch(candidate, /\.State\.Health/);
  assert.equal(
    outcome.error,
    null,
    "health failure must be a bounded candidate failure, not a harness error"
  );
  assert.notEqual(outcome.result.status, 0, "failed in-container health must fail closed");
  assert.equal(outcome.result.signal, null, "failed in-container health must exit normally");
  assert.match(outcome.trace.join("\n"), /candidate-internal-health/);
  assert.doesNotMatch(outcome.trace.join("\n"), /candidate-health-inspect/);
  assert.equal(outcome.candidateExists, false, "failed in-container health must clean candidate");
  assert.equal(
    outcome.candidateNetworkExists,
    false,
    "failed in-container health must clean network"
  );
});

test("candidate signals exit nonzero after cleanup and cannot continue the launch", async () => {
  const contents = await readRunbook();
  const candidate = extractExecutableFence(contents, "STAGE1_CANDIDATE_API_EXECUTABLE");
  const candidateStop = extractExecutableFence(contents, "STAGE1_CANDIDATE_API_STOP_EXECUTABLE");

  for (const [scenario, expectedStatus] of [
    ["signal_hup", 129],
    ["signal_int", 130],
    ["signal_term", 143]
  ]) {
    const outcome = await runCandidate(candidate, candidateStop, scenario);
    assert.equal(
      outcome.error,
      null,
      `${scenario} must be a candidate failure, not a harness error`
    );
    assert.equal(
      outcome.result.signal,
      null,
      `${scenario} must translate signal to an explicit exit`
    );
    assert.equal(
      outcome.result.status,
      expectedStatus,
      `${scenario} must exit after cleanup; trace=${outcome.trace.join(",")}; stdout=${outcome.result.stdout}; stderr=${outcome.result.stderr}`
    );
    assert.equal(outcome.candidateExists, false, `${scenario} must clean candidate`);
    assert.equal(outcome.candidateNetworkExists, false, `${scenario} must clean network`);
    assert.equal(outcome.postgresAttached, false, `${scenario} must detach postgres`);
    assert.doesNotMatch(
      outcome.trace.join("\n"),
      /candidate-runtime-env-checked|candidate-internal-health|candidate-stop-fence-enter/,
      `${scenario} must not continue after the signal`
    );
  }
});

test("candidate cleanup owns resources acquired before a post-create signal", async () => {
  const contents = await readRunbook();
  const candidate = extractExecutableFence(contents, "STAGE1_CANDIDATE_API_EXECUTABLE");
  const candidateStop = extractExecutableFence(contents, "STAGE1_CANDIDATE_API_STOP_EXECUTABLE");

  for (const [scenario, forbiddenTrace] of [
    ["signal_after_network_create", /candidate-network-connect-postgres|candidate-run/],
    ["signal_after_container_run", /candidate-runtime-env-checked|candidate-internal-health/]
  ]) {
    const outcome = await runCandidate(candidate, candidateStop, scenario);
    assert.equal(
      outcome.error,
      null,
      `${scenario} must be a candidate failure, not a harness error`
    );
    assert.equal(
      outcome.result.status,
      143,
      `${scenario} must exit through the TERM handler; trace=${outcome.trace.join(",")}; stdout=${outcome.result.stdout}; stderr=${outcome.result.stderr}`
    );
    assert.equal(
      outcome.candidateExists,
      false,
      `${scenario} must remove only the owned candidate`
    );
    assert.equal(
      outcome.candidateNetworkExists,
      false,
      `${scenario} must remove only the owned network`
    );
    assert.equal(outcome.postgresAttached, false, `${scenario} must detach postgres when attached`);
    assert.doesNotMatch(
      outcome.trace.join("\n"),
      forbiddenTrace,
      `${scenario} must not continue after cleanup`
    );
  }
});

test("candidate cleanup uses immutable IDs after ownership inspection to preserve TOCTOU replacements", async () => {
  const contents = await readRunbook();
  const candidate = extractExecutableFence(contents, "STAGE1_CANDIDATE_API_EXECUTABLE");
  const candidateStop = extractExecutableFence(contents, "STAGE1_CANDIDATE_API_STOP_EXECUTABLE");

  for (const [scenario, expectedTrace] of [
    ["container_toctou_replacement", /candidate-rm-old-id-rejected/],
    ["network_toctou_replacement", /candidate-network-disconnect-old-id-rejected/]
  ]) {
    const outcome = await runCandidate(candidate, candidateStop, scenario);
    assert.equal(
      outcome.error,
      null,
      `${scenario} must be a candidate failure, not a harness error`
    );
    assert.notEqual(outcome.result.status, 0, `${scenario} must fail closed`);
    assert.match(
      outcome.trace.join("\n"),
      expectedTrace,
      `${scenario} must direct its destructive operation at the original immutable ID`
    );
    assert.equal(
      scenario === "container_toctou_replacement"
        ? outcome.candidateExists
        : outcome.candidateNetworkExists,
      true,
      `${scenario} must preserve the same-name replacement`
    );
  }
});

test("candidate stop fence uses immutable IDs after ownership inspection to preserve TOCTOU replacements", async () => {
  const contents = await readRunbook();
  const candidate = extractExecutableFence(contents, "STAGE1_CANDIDATE_API_EXECUTABLE");
  const candidateStop = extractExecutableFence(contents, "STAGE1_CANDIDATE_API_STOP_EXECUTABLE");

  for (const [scenario, expectedTrace] of [
    ["stop_container_toctou_replacement", /candidate-rm-old-id-rejected/],
    ["stop_network_toctou_replacement", /candidate-network-disconnect-old-id-rejected/]
  ]) {
    const outcome = await runCandidate(candidate, candidateStop, scenario);
    assert.equal(
      outcome.error,
      null,
      `${scenario} must be a candidate failure, not a harness error`
    );
    assert.notEqual(outcome.result.status, 0, `${scenario} must fail closed`);
    assert.match(
      outcome.trace.join("\n"),
      expectedTrace,
      `${scenario} must direct its destructive operation at the original immutable ID`
    );
    assert.equal(
      scenario === "stop_container_toctou_replacement"
        ? outcome.candidateExists
        : outcome.candidateNetworkExists,
      true,
      `${scenario} must preserve the same-name replacement`
    );
  }
});

test("candidate cleanup refuses container and network replacements by name", async () => {
  const contents = await readRunbook();
  const candidate = extractExecutableFence(contents, "STAGE1_CANDIDATE_API_EXECUTABLE");
  const candidateStop = extractExecutableFence(contents, "STAGE1_CANDIDATE_API_STOP_EXECUTABLE");

  for (const [scenario, expectedResource] of [
    ["container_replacement", "container"],
    ["network_replacement", "network"]
  ]) {
    const outcome = await runCandidate(candidate, candidateStop, scenario);
    assert.equal(
      outcome.error,
      null,
      `${scenario} must be a candidate failure, not a harness error`
    );
    assert.notEqual(outcome.result.status, 0, `${scenario} must fail closed`);
    assert.equal(
      expectedResource === "container" ? outcome.candidateExists : outcome.candidateNetworkExists,
      true,
      `${scenario} must preserve the replacement rather than delete by name`
    );
    assert.doesNotMatch(
      outcome.trace.join("\n"),
      expectedResource === "container" ? /candidate-rm/ : /candidate-network-rm/,
      `${scenario} must not remove the replacement`
    );
  }
});

test("candidate fake drives every launch failure from actual command state and bounds a hung harness", async () => {
  const contents = await readRunbook();
  const candidate = extractExecutableFence(contents, "STAGE1_CANDIDATE_API_EXECUTABLE");
  const candidateStop = extractExecutableFence(contents, "STAGE1_CANDIDATE_API_STOP_EXECUTABLE");
  const targetDbMissing = candidate.replace(/ {2}--env TARGET_DB="\$TARGET_DB" \\\r?\n/, "");

  for (const [scenario, runnableCandidate] of [
    ["target_db_missing", targetDbMissing],
    ["network_create_failure", candidate],
    ["postgres_attach_failure", candidate],
    ["launch_failure", candidate],
    ["health_failure", candidate]
  ]) {
    const outcome = await runCandidate(runnableCandidate, candidateStop, scenario);
    assert.equal(
      outcome.error,
      null,
      `${scenario} must be a business failure, not a harness error`
    );
    assert.notEqual(outcome.result.status, 0, `${scenario} must fail closed`);
    assert.equal(outcome.result.signal, null, `${scenario} must exit normally`);
  }

  const startedAt = Date.now();
  const timeout = await runCandidate(candidate, candidateStop, "harness_timeout", {
    awaitTimeoutReady: true,
    completionTimeoutMs: 100,
    gracefulTerminationTimeoutMs: 100,
    finalSettleTimeoutMs: 500,
    startupTimeoutMs: 30_000
  });
  assert.notEqual(timeout.error, null, "a hung harness must report a harness timeout");
  assert.equal(
    timeout.result.forceTerminated,
    true,
    "a hung harness must escalate from TERM to process-tree KILL"
  );
  assert.ok(
    Number.isInteger(timeout.timeoutSleepPid) && timeout.timeoutSleepPid > 0,
    "the timeout fake must expose the actual child PID used to prove process-tree cleanup"
  );
  if (process.platform === "win32") {
    assert.ok(
      timeout.result.terminationProcessTreePids.includes(timeout.timeoutSleepPid),
      "the Windows termination snapshot must include the real timed-out child before TERM"
    );
  }
  assert.equal(
    await waitForProcessExit(timeout.timeoutSleepPid, 1_000),
    true,
    "TERM then process-tree KILL must remove the timed-out child rather than leaving it orphaned"
  );
  assert.ok(
    Date.now() - startedAt < 35_000,
    "a hung harness must settle after TERM then process-tree KILL"
  );
});

test("candidate executable injects exact disabled gates, verifies isolation, and cleans up before cutover", async () => {
  const contents = await readRunbook();
  const candidate = extractExecutableFence(contents, "STAGE1_CANDIDATE_API_EXECUTABLE");
  const candidateStop = extractExecutableFence(contents, "STAGE1_CANDIDATE_API_STOP_EXECUTABLE");
  const green = await runCandidate(candidate, candidateStop);

  assert.equal(
    green.result.status,
    0,
    `${green.result.stdout}\n${green.result.stderr}\n${green.error}\n${green.trace.join("\n")}`
  );
  assert.equal(green.candidateExists, false, "candidate must be removed before cutover");
  assert.equal(
    green.candidateNetworkExists,
    false,
    "candidate network must be removed before cutover"
  );
  assert.equal(green.postgresAttached, false, "postgres must be detached before cutover");
  assert.match(green.trace.join("\n"), /candidate-internal-health/);
  assert.match(green.trace.join("\n"), /candidate-runtime-env-checked/);
  assert.match(green.trace.join("\n"), /candidate-rm/);
  assert.match(green.trace.join("\n"), /candidate-network-disconnect-postgres/);
  assert.match(green.trace.join("\n"), /candidate-network-rm/);
  assert.doesNotMatch(green.candidateRunArgv, /(?:--network|--link)\s+nginx\b/);
  assert.doesNotMatch(green.candidateRunArgv, /(?:--publish|-p)\s/);
  assert.doesNotMatch(green.candidateRunArgv, /postgresql:\/\//);
  assert.doesNotMatch(
    green.candidateLaunchEvidence,
    /candidate_ownership_token=/,
    "the non-sensitive ownership token belongs only in private ownership evidence"
  );
  assert.doesNotMatch(
    `${green.result.stdout}\n${green.result.stderr}`,
    /[0-9a-f]{32}/,
    "candidate stdout/stderr must not publish the ownership token"
  );
  assert.match(green.candidateRunArgv, /--env DATABASE_URL(?:\s|$)/);
  assert.match(green.candidateRunArgv, /--env STAGE1_ACCEPTANCE_TARGET_DATABASE_URL(?:\s|$)/);
  for (const flag of [
    "SUBSCRIPTION_JOURNEY_ENABLED",
    "SUBSCRIPTION_JOURNEY_WORKER_ENABLED",
    "BILLING_AUTOMATION_WORKER_ENABLED",
    "FIELD_VIDEO_UPLOAD_WORKER_ENABLED",
    "STAGE2_HANDOVER_WORKER_ENABLED",
    "MILEAGE_REVIEW_WORKER_ENABLED",
    "SUBSCRIPTION_CHANGE_WORKER_ENABLED",
    "SUBSCRIPTION_RETURN_THREE_STAGE_ENABLED"
  ]) {
    assert.match(green.candidateRunArgv, new RegExp(`--env ${flag}=false`));
  }
  assert.ok(
    contents.indexOf("<!-- STAGE1_CANDIDATE_API_STOP_EXECUTABLE_BEGIN -->") <
      contents.indexOf("<!-- STAGE1_ENV_TRANSFORM_EXECUTABLE_BEGIN -->"),
    "candidate stop fence must precede the formal switch preparation"
  );
  const mutatedCandidates = [
    ["image_drift", candidate.replace('"$APPROVED_API_IMAGE_ID"', `"sha256:${"a".repeat(64)}"`)],
    [
      "port_drift",
      candidate.replace(
        / {2}--network "\$CANDIDATE_API_NETWORK" \\\r?\n/,
        '$&  --publish "127.0.0.1:3181:3001" \\\n'
      )
    ],
    ["network_drift", candidate.replace('--network "$CANDIDATE_API_NETWORK"', "--network bridge")],
    ["target_db_missing", candidate.replace(/ {2}--env TARGET_DB="\$TARGET_DB" \\\r?\n/, "")],
    [
      "env_missing",
      candidate.replace(/ {2}--env SUBSCRIPTION_RETURN_THREE_STAGE_ENABLED=false \\\r?\n/, "")
    ],
    [
      "env_drift",
      candidate.replace(
        "--env SUBSCRIPTION_RETURN_THREE_STAGE_ENABLED=false",
        "--env SUBSCRIPTION_RETURN_THREE_STAGE_ENABLED=true"
      )
    ],
    [
      "literal_secret_argv",
      candidate.replace(
        "--env DATABASE_URL",
        "--env DATABASE_URL=postgresql://subscription:secret-password@postgres:5432/target"
      )
    ]
  ];
  for (const [scenario, mutatedCandidate] of mutatedCandidates) {
    const outcome = await runCandidate(mutatedCandidate, candidateStop);
    assert.equal(
      outcome.error,
      null,
      `${scenario} must be a candidate failure, not a harness error`
    );
    assert.notEqual(outcome.result.status, 0, `${scenario} must fail closed`);
    assert.equal(outcome.candidateExists, false, `${scenario} must remove the candidate`);
    assert.equal(
      outcome.candidateNetworkExists,
      false,
      `${scenario} must remove the candidate network`
    );
    assert.equal(outcome.postgresAttached, false, `${scenario} must detach postgres`);
    if (outcome.trace.includes("candidate-run")) {
      assert.match(
        outcome.trace.join("\n"),
        /candidate-rm/,
        `${scenario} must remove the candidate`
      );
    }
  }

  for (const scenario of ["evidence_failure", "assert_failure", "internal_health_failure"]) {
    const outcome = await runCandidate(candidate, candidateStop, scenario);
    assert.equal(
      outcome.error,
      null,
      `${scenario} must be a candidate failure, not a harness error`
    );
    assert.notEqual(outcome.result.status, 0, `${scenario} must fail closed`);
    assert.equal(outcome.candidateExists, false, `${scenario} must clean up the candidate`);
    assert.equal(outcome.candidateNetworkExists, false, `${scenario} must clean up the network`);
    assert.equal(outcome.postgresAttached, false, `${scenario} must detach postgres`);
    assert.match(outcome.trace.join("\n"), /candidate-rm/, `${scenario} must remove the candidate`);
  }

  const membershipDrift = await runCandidate(candidate, candidateStop, "network_membership_drift");
  assert.equal(membershipDrift.error, null, "network membership drift must be a candidate failure");
  assert.notEqual(membershipDrift.result.status, 0, "network membership drift must fail closed");
  assert.equal(membershipDrift.candidateExists, false, "membership drift must remove candidate");
  assert.equal(membershipDrift.postgresAttached, false, "membership drift must detach postgres");
  assert.equal(
    membershipDrift.candidateNetworkExists,
    true,
    "membership drift must not delete a network occupied by an unknown member"
  );
  assert.match(membershipDrift.trace.join("\n"), /candidate-rm/);

  const cleanupFailure = await runCandidate(candidate, candidateStop, "cleanup_failure");
  assert.equal(cleanupFailure.error, null, "cleanup failure must be a candidate failure");
  assert.notEqual(cleanupFailure.result.status, 0, "cleanup failure must fail closed");
  assert.match(cleanupFailure.trace.join("\n"), /candidate-cleanup-failure/);
  assert.equal(
    cleanupFailure.candidateNetworkExists,
    true,
    "cleanup failure must not claim network absence"
  );
  assert.equal(
    cleanupFailure.postgresAttached,
    true,
    "cleanup failure must not claim postgres detached"
  );

  const candidateCollision = await runCandidate(candidate, candidateStop, "candidate_collision");
  assert.equal(candidateCollision.error, null, "candidate collision must be a candidate failure");
  assert.notEqual(candidateCollision.result.status, 0, "candidate collision must fail closed");
  assert.equal(
    candidateCollision.candidateExists,
    true,
    "candidate collision must preserve non-owned container"
  );
  assert.equal(
    candidateCollision.trace.includes("candidate-rm"),
    false,
    "collision must not remove non-owned container"
  );

  const networkCollision = await runCandidate(candidate, candidateStop, "network_collision");
  assert.equal(networkCollision.error, null, "network collision must be a candidate failure");
  assert.notEqual(networkCollision.result.status, 0, "network collision must fail closed");
  assert.equal(
    networkCollision.candidateNetworkExists,
    true,
    "network collision must preserve non-owned network"
  );
  assert.equal(
    networkCollision.trace.includes("candidate-network-rm"),
    false,
    "collision must not remove non-owned network"
  );
});

test("candidate harness waits for observed child completion instead of a fixed three-second deadline", async () => {
  const contents = await readRunbook();
  const candidate = extractExecutableFence(contents, "STAGE1_CANDIDATE_API_EXECUTABLE");
  const candidateStop = extractExecutableFence(contents, "STAGE1_CANDIDATE_API_STOP_EXECUTABLE");
  const delayedCandidate = candidate.replace(
    'assert_private_file "$CANDIDATE_API_OWNERSHIP_EVIDENCE"',
    'assert_private_file "$CANDIDATE_API_OWNERSHIP_EVIDENCE"\n/usr/bin/sleep 4'
  );
  const outcome = await runCandidate(delayedCandidate, candidateStop);

  assert.equal(outcome.result.status, 0, `${outcome.error}\n${outcome.result.stderr}`);
  assert.equal(
    outcome.candidateExists,
    false,
    "candidate cleanup must finish before the harness returns"
  );
  assert.equal(
    outcome.candidateNetworkExists,
    false,
    "candidate network cleanup must finish before the harness returns"
  );
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
    contents.replace('test "$switched_image_id" = "$APPROVED_API_IMAGE_ID"', ":"),
    contents.replace('test "$switched_image_digest" = "$APPROVED_API_IMAGE_DIGEST"', ":"),
    contents.replace('test "$switched_release_sha" = "$APPROVED_API_IMAGE_REVISION"', ":"),
    contents.replace('test "$compose_image_id" = "$APPROVED_API_IMAGE_ID"', ":"),
    contents.replace('test "$compose_image_digest" = "$APPROVED_API_IMAGE_DIGEST"', ":"),
    contents.replace("fact.console.warnCount === 0", "fact.console.warnCount >= 0"),
    contents.replace(
      "completedAt <= challengeCreatedAt + timeoutSeconds * 1000",
      "completedAt >= challengeCreatedAt"
    ),
    contents.replace("^[1-9][0-9]{0,2}$", "^[1-9][0-9]*$"),
    contents.replace(
      'SUBSCRIPTION_RETURN_THREE_STAGE_ENABLED: "true"',
      'SUBSCRIPTION_RETURN_THREE_STAGE_ENABLED: "false"'
    )
  ];
  for (const mutation of mutations) assert.throws(() => validateExecutableContracts(mutation));
  assert.ok(cutover.length > 0 && evidenceHelpers.length > 0 && transformer.length > 0);
});

const MATERIAL_GATE_FAILURES = new Map([
  ["api_recreate", "recreate:api"],
  ["filesystem_sync", "gate:filesystem-sync"],
  ["container_id_drift", "gate:container-id"],
  ["image_drift", "gate:container-image"],
  ["image_digest_drift", "gate:container-image-digest"],
  ["revision_drift", "gate:container-revision"],
  ["compose_image_drift", "gate:compose-image"],
  ["compose_image_digest_drift", "gate:compose-image-digest"],
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
  ["billing_timeout", "gate:billing-exporter"],
  ["billing_binding", "gate:billing-exporter"],
  ["billing_hash", "gate:billing-exporter"],
  ["billing_blocked", "gate:billing-exporter"],
  ["billing_cli", "gate:billing-exporter"],
  ["billing_assert", "gate:billing"],
  ["log_read", "gate:docker-logs"],
  ["log_error", "gate:docker-logs"],
  ["log_pii", "gate:docker-logs"]
]);

test(
  "host watchdog terminates a truly hung billing exporter and reaches rollback",
  { timeout: 20_000 },
  async () => {
    const contents = await readRunbook();
    const cutover = extractExecutableFence(contents, "STAGE1_CUTOVER_EXECUTABLE");
    const evidenceHelpers = extractExecutableFence(contents, "STAGE1_EVIDENCE_HELPERS_EXECUTABLE");
    const shortenedWatchdog = cutover
      .replace(
        "readonly BILLING_MAINTENANCE_EVIDENCE_WATCHDOG_SECONDS=190",
        "readonly BILLING_MAINTENANCE_EVIDENCE_WATCHDOG_SECONDS=1"
      )
      .replace("--kill-after=5s", "--kill-after=1s");
    const startedAt = Date.now();
    const outcome = runCutover(shortenedWatchdog, evidenceHelpers, "billing_hang", {
      timeoutMilliseconds: 12_000
    });

    assertRollback(outcome, "billing_hang", "gate:billing-exporter");
    assert.ok(Date.now() - startedAt < 12_000, "watchdog rollback must beat the harness limit");
    assert.equal(outcome.billingEvidenceText, null);
  }
);

test("rollback scrubs historical evidence bindings and verifies the restored container", async () => {
  const contents = await readRunbook();
  const cutover = extractExecutableFence(contents, "STAGE1_CUTOVER_EXECUTABLE");
  const evidenceHelpers = extractExecutableFence(contents, "STAGE1_EVIDENCE_HELPERS_EXECUTABLE");
  const outcome = runCutover(cutover, evidenceHelpers, "public_api");

  assertRollback(outcome, "historical_evidence_env", "gate:public-api");
});

test("billing exporter fake rejects CLI argument drift before publishing evidence", async () => {
  const contents = await readRunbook();
  const cutover = extractExecutableFence(contents, "STAGE1_CUTOVER_EXECUTABLE");
  const evidenceHelpers = extractExecutableFence(contents, "STAGE1_EVIDENCE_HELPERS_EXECUTABLE");
  const wrongTimeout = cutover.replace(
    '--timeout-seconds "$BILLING_MAINTENANCE_EVIDENCE_TIMEOUT_SECONDS"',
    "--timeout-seconds 179"
  );
  const outcome = runCutover(wrongTimeout, evidenceHelpers, "success");

  assertRollback(outcome, "billing_argv", "gate:billing-exporter");
  assert.ok(outcome.trace.includes("BILLING_CLI_ARGV_INVALID"));
  assert.equal(outcome.billingEvidenceText, null);
});

test("billing exporter fake emits the complete document produced by the tested builder", async () => {
  const contents = await readRunbook();
  const cutover = extractExecutableFence(contents, "STAGE1_CUTOVER_EXECUTABLE");
  const evidenceHelpers = extractExecutableFence(contents, "STAGE1_EVIDENCE_HELPERS_EXECUTABLE");
  const outcome = runCutover(cutover, evidenceHelpers, "success");

  assert.equal(outcome.result.status, 0, outcome.result.stderr);
  assert.deepEqual(JSON.parse(outcome.billingEvidenceText), BILLING_FAKE_EVIDENCE_DOCUMENT);
});

for (const [scenario, expectedTrace] of MATERIAL_GATE_FAILURES) {
  test(`real ${scenario} failure rolls back through fixed production control flow`, async () => {
    const { cutover, evidenceHelpers } = validateExecutableContracts(await readRunbook());
    const outcome = runCutover(cutover, evidenceHelpers, scenario);
    assertRollback(outcome, scenario, expectedTrace);
    if (
      [
        "container_id_drift",
        "image_drift",
        "image_digest_drift",
        "revision_drift",
        "compose_image_drift",
        "compose_image_digest_drift"
      ].includes(scenario)
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
  assert.equal(outcome.env, OLD_ENV_CONTENT);
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
  assert.equal(poisonOutcome.env, OLD_ENV_CONTENT);
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
  assert.ok(outcome.trace.includes("gate:billing-cli-argv-verified"));
  assert.deepEqual(JSON.parse(outcome.billingEvidenceText), BILLING_FAKE_EVIDENCE_DOCUMENT);
});
