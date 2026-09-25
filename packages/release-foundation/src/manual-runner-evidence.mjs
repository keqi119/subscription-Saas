import { canonicalJson } from "./canonical-json.mjs";
import { sha256Bytes, sha256Canonical } from "./digest.mjs";
import { encodeManualJson } from "./manual-stage1-contracts.mjs";
import { validateContract } from "./schema-registry.mjs";
import { deterministicPlanDigest } from "./proof-builders.mjs";
import { isIP } from "node:net";
import Ajv2020 from "ajv/dist/2020.js";
import evidenceSchema from "../../../release/contracts/schemas/manual-runner-evidence.v1.schema.json" with { type: "json" };

const LIMIT = 1048576;
const MISMATCH = "MANUAL_EVIDENCE_BINDING_MISMATCH";
const REQUIRED = "MANUAL_EVIDENCE_INPUT_REQUIRED";
const manualVersions = Object.freeze({
  "manual-stage1-profile.v1": Object.freeze({ record: "manual-operation-record.v1", days: 180 }),
  "manual-stage1-profile.v2": Object.freeze({ record: "manual-operation-record.v2", days: 90 })
});
const recordVersions = Object.freeze(Object.values(manualVersions).map((p) => p.record));
const A = [
  "profileDigest",
  "sessionId",
  "sessionNonce",
  "operationId",
  "idempotencyKey",
  "attemptId",
  "runId"
];
const FRAME = "MANUAL_FRAME_INVALID",
  ORDER = "MANUAL_FRAME_ORDER_INVALID",
  INCOMPLETE = "MANUAL_FRAME_INCOMPLETE";
const OUTPUT = "MANUAL_OUTPUT_LIMIT",
  REUSED = "MANUAL_HANDOFF_REUSED";
const CHILD_TYPES = [
  "CHALLENGE",
  "READY",
  "CREDENTIAL_RECEIVED",
  "PREPARED",
  "EVENT",
  "OBSERVATION",
  "ACK_RECEIVED",
  "RESULT"
];
const PARENT_TYPES = ["AUTHORIZE", "CREDENTIAL", "ACK"];
const WIRE_KEYS = [
  ...A,
  "attemptAllocationDigest",
  "requestDigest",
  "authorizationDigest",
  "containerId",
  "runnerImageDigest",
  "childChallenge"
];
const DIGEST = /^sha256:[0-9a-f]{64}$/,
  NONCE = /^[0-9a-f]{64}$/,
  UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MANUAL_PROTOCOLS = ["MS1", "MS2"];
const CLUSTER_KEYS = [
  "systemIdentifier",
  "databaseContainerId",
  "dataVolumeName",
  "postgresImageDigest",
  "marker",
  "serverAddress",
  "serverPort"
];
function requireThat(condition, code = MISMATCH) {
  if (!condition) throw Object.assign(new Error(code), { code });
}
function equal(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}
function instant(value) {
  const time = Date.parse(value);
  requireThat(
    Number.isFinite(time) && new Date(time).toISOString() === value,
    "MANUAL_TIME_INVALID"
  );
  return time;
}
function sortedUnique(values) {
  return values.every((v, i) => i === 0 || values[i - 1] < v);
}
function decode(bytes) {
  requireThat(Buffer.isBuffer(bytes));
  requireThat(bytes.length <= LIMIT, "MANUAL_JSON_LIMIT");
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    requireThat(false);
  }
}
function parse(bytes) {
  const text = decode(bytes);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    requireThat(false);
  }
  requireThat(encodeManualJson(value).equals(bytes));
  return value;
}

function exact(value, keys, code = FRAME) {
  requireThat(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
      Reflect.ownKeys(value).length === keys.length &&
      keys.every((k) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, k);
        return descriptor?.enumerable && Object.hasOwn(descriptor, "value");
      }),
    code
  );
}
function clusterOrigin(cluster) {
  exact(cluster, CLUSTER_KEYS);
  requireThat(
    matches(/^[1-9][0-9]*$/, cluster.systemIdentifier) &&
      BigInt(cluster.systemIdentifier) <= 18446744073709551615n &&
      matches(/^[0-9a-f]{64}$/, cluster.databaseContainerId) &&
      matches(DIGEST, cluster.postgresImageDigest) &&
      [cluster.dataVolumeName, cluster.marker].every(
        (value) => typeof value === "string" && value.length > 0 && value.length <= 256
      ) &&
      typeof cluster.serverAddress === "string" &&
      !cluster.serverAddress.includes("%") &&
      isIP(cluster.serverAddress) !== 0 &&
      Number.isInteger(cluster.serverPort) &&
      cluster.serverPort >= 1 &&
      cluster.serverPort <= 65535,
    FRAME
  );
}

export function computeManualClusterFingerprint(cluster) {
  clusterOrigin(cluster);
  return sha256Canonical({ domain: "manual-postgres-cluster.v1", ...cluster });
}
function profileKeys(input, keys) {
  return Object.hasOwn(input ?? {}, "profileBytes") ? [...keys, "profileBytes"] : keys;
}
function resolveProfile(input, request) {
  if (!Object.hasOwn(input, "profileBytes")) return manualVersions["manual-stage1-profile.v1"];
  const profile = parse(input.profileBytes);
  validateContract(
    typeof profile?.schemaVersion === "string" &&
      Object.hasOwn(manualVersions, profile.schemaVersion)
      ? profile.schemaVersion
      : "manual-stage1-profile.v1",
    profile
  );
  requireThat(sha256Bytes(input.profileBytes) === request.profileDigest);
  return manualVersions[profile.schemaVersion];
}
function recordPolicy(record, policy) {
  requireThat(record.schemaVersion === policy.record);
  if (record.kind === "custody") requireThat(record.retentionDays === policy.days);
}
function frameRecord(record) {
  requireThat(recordVersions.includes(record?.schemaVersion), FRAME);
  validateContract(record.schemaVersion, record);
}
function matches(pattern, value) {
  return typeof value === "string" && pattern.test(value);
}
function frameRef(bytes) {
  return { digest: sha256Bytes(bytes), bytes: bytes.length };
}
function checkRef(ref) {
  exact(ref, ["digest", "bytes"]);
  requireThat(
    matches(DIGEST, ref.digest) && Number.isSafeInteger(ref.bytes) && ref.bytes >= 0,
    FRAME
  );
}
function checkTargetIntent(targetIntent) {
  exact(targetIntent, ["endpointPolicyId", "databaseName"]);
  requireThat(
    [targetIntent.endpointPolicyId, targetIntent.databaseName].every(
      (value) => typeof value === "string" && value.length > 0 && value.length <= 256
    ),
    FRAME
  );
}
function checkTargetContext(context) {
  exact(context, [
    "contextVersion",
    "operationRef",
    "indexDigest",
    "runId",
    "profileDigest",
    "targetIntent",
    "databaseOid",
    "h3Approval",
    "h3Readback",
    "cluster"
  ]);
  requireThat(
    context.contextVersion === "manual-h3-target-context.v1" &&
      matches(UUID, context.operationRef) &&
      matches(DIGEST, context.indexDigest) &&
      matches(UUID, context.runId) &&
      matches(DIGEST, context.profileDigest) &&
      matches(/^[1-9][0-9]*$/, context.databaseOid),
    FRAME
  );
  checkTargetIntent(context.targetIntent);
  checkRef(context.h3Approval);
  checkRef(context.h3Readback);
  clusterOrigin(context.cluster);
}
function checkWire(binding) {
  exact(binding, WIRE_KEYS);
  for (const k of WIRE_KEYS) {
    const pattern = ["sessionId", "operationId", "attemptId", "runId"].includes(k)
      ? UUID
      : ["sessionNonce", "containerId", "childChallenge"].includes(k)
        ? NONCE
        : k === "idempotencyKey"
          ? /^.{1,256}$/su
          : DIGEST;
    requireThat(typeof binding[k] === "string" && pattern.test(binding[k]), FRAME);
  }
}
function checkEvent(e) {
  exact(e, [
    "sequence",
    "processSequence",
    "source",
    "tool",
    "event",
    "at",
    "containerId",
    "pid",
    "argvDigest",
    "exitCode",
    "signal",
    "reasonCode",
    "stdout",
    "stderr"
  ]);
  requireThat(
    [e.sequence, e.processSequence].every((n) => Number.isSafeInteger(n) && n >= 0),
    FRAME
  );
  requireThat(
    ["parent", "runner"].includes(e.source) &&
      [
        "runner",
        "prisma-version",
        "psql-version",
        "prisma-deploy",
        "prisma-diff",
        "prisma-script",
        "target-observe"
      ].includes(e.tool),
    FRAME
  );
  requireThat(
    ["PREPARED", "SPAWNED", "CLOSED", "SPAWN_FAILED", "DISPATCH_CLOSED"].includes(e.event),
    FRAME
  );
  instant(e.at);
  requireThat(e.containerId === null || matches(NONCE, e.containerId), FRAME);
  requireThat(e.pid === null || (Number.isSafeInteger(e.pid) && e.pid > 0), FRAME);
  requireThat(e.argvDigest === null || matches(DIGEST, e.argvDigest), FRAME);
  requireThat(e.exitCode === null || Number.isSafeInteger(e.exitCode), FRAME);
  requireThat(
    e.signal === null ||
      (typeof e.signal === "string" && e.signal.length > 0 && e.signal.length <= 256),
    FRAME
  );
  requireThat(e.reasonCode === null || matches(/^[A-Z][A-Z0-9_]{0,127}$/, e.reasonCode), FRAME);
  for (const k of ["stdout", "stderr"]) if (e[k] !== null) checkRef(e[k]);
}
function framePayload(type, payload, protocol) {
  try {
    validateFramePayload(type, payload, protocol);
  } catch (error) {
    if (
      ["CONTRACT_SCHEMA_INVALID", "CANONICAL_JSON_REFUSED"].includes(error.code) ||
      error instanceof TypeError
    )
      requireThat(false, FRAME);
    throw error;
  }
}
function validateFramePayload(type, payload, protocol) {
  const shapes = {
    CHALLENGE: ["childChallenge"],
    AUTHORIZE:
      protocol === "MS2"
        ? [
            "launchContext",
            "allocation",
            "request",
            "authorization",
            "receipt",
            "baseline",
            "process",
            "processReadback",
            "targetContext"
          ]
        : [
            "launchContext",
            "allocation",
            "request",
            "authorization",
            "receipt",
            "baseline",
            "process",
            "processReadback"
          ],
    READY: ["binding", "authorizeFrame"],
    CREDENTIAL: ["binding", "credential"],
    CREDENTIAL_RECEIVED: ["binding", "authorizeFrame"],
    PREPARED: ["binding", "previousAck", "event"],
    EVENT: ["binding", "previousAck", "event", "stdoutBase64", "stderrBase64"],
    OBSERVATION: ["binding", "previousAck", "observation"],
    ACK: ["binding", "acknowledgedFrame", "subject", "readback"],
    ACK_RECEIVED: ["binding", "previousAck"]
  };
  if (type === "RESULT") {
    requireThat(payload?.kind === "manual-command-result", FRAME);
    validateContract("manual-runner-evidence.v1", payload);
    return;
  }
  requireThat(shapes[type], FRAME);
  exact(payload, shapes[type]);
  if (type === "CHALLENGE") {
    requireThat(matches(NONCE, payload.childChallenge), FRAME);
    return;
  }
  if (type === "AUTHORIZE") {
    exact(payload.launchContext, ["containerId", "runnerImageDigest"]);
    requireThat(
      matches(NONCE, payload.launchContext.containerId) &&
        matches(DIGEST, payload.launchContext.runnerImageDigest),
      FRAME
    );
    validateManualRunnerRequest(payload.request);
    for (const k of ["allocation", "process"]) {
      requireThat(payload[k]?.kind === (k === "allocation" ? "attempt-allocation" : k), FRAME);
      validateContract("manual-runner-evidence.v1", payload[k]);
    }
    validateContract("manual-launch-authorization.v1", payload.authorization);
    validateContract("manual-baseline-manifest.v1", payload.baseline);
    for (const [k, kind] of [
      ["receipt", "consumption-handoff"],
      ["processReadback", "custody"]
    ]) {
      requireThat(payload[k]?.kind === kind, FRAME);
      frameRecord(payload[k]);
    }
    if (protocol === "MS2") checkTargetContext(payload.targetContext);
    return;
  }
  checkWire(payload.binding);
  if (Object.hasOwn(payload, "authorizeFrame")) checkRef(payload.authorizeFrame);
  if (Object.hasOwn(payload, "previousAck") && payload.previousAck !== null)
    checkRef(payload.previousAck);
  if (type === "ACK_RECEIVED") requireThat(payload.previousAck !== null, FRAME);
  if (type === "CREDENTIAL")
    requireThat(
      typeof payload.credential === "string" &&
        payload.credential.length > 0 &&
        !payload.credential.includes("\0"),
      FRAME
    );
  if (["PREPARED", "EVENT"].includes(type)) {
    checkEvent(payload.event);
    requireThat(payload.event.source === "runner", FRAME);
    requireThat(
      type === "PREPARED"
        ? payload.event.event === "PREPARED"
        : ["SPAWNED", "CLOSED", "SPAWN_FAILED", "DISPATCH_CLOSED"].includes(payload.event.event),
      FRAME
    );
    if (type === "EVENT") {
      for (const [k, ref] of [
        ["stdoutBase64", "stdout"],
        ["stderrBase64", "stderr"]
      ]) {
        if (payload.event.event !== "CLOSED") requireThat(payload[k] === null, FRAME);
        else {
          requireThat(typeof payload[k] === "string", FRAME);
          const bytes = Buffer.from(payload[k], "base64");
          requireThat(bytes.toString("base64") === payload[k], FRAME);
          requireThat(bytes.length <= LIMIT, OUTPUT);
          requireThat(equal(frameRef(bytes), payload.event[ref]), ORDER);
          try {
            decode(bytes);
          } catch {
            requireThat(false, FRAME);
          }
        }
      }
    }
  }
  if (type === "OBSERVATION") {
    requireThat(payload.observation?.kind === "observation", FRAME);
    validateContract("manual-runner-evidence.v1", payload.observation);
  }
  if (type === "ACK") {
    checkRef(payload.acknowledgedFrame);
    requireThat(["process", "observation"].includes(payload.subject?.kind), FRAME);
    exact(payload.subject, ["kind", payload.subject.kind]);
    const subject = payload.subject[payload.subject.kind];
    requireThat(subject?.kind === payload.subject.kind, FRAME);
    validateContract("manual-runner-evidence.v1", subject);
    requireThat(payload.readback?.kind === "custody", FRAME);
    frameRecord(payload.readback);
  }
}

export function encodeManualRunnerFrame(input) {
  const keyCount = input !== null && typeof input === "object" ? Reflect.ownKeys(input).length : 0;
  const protocol = keyCount === 3 ? "MS1" : "MS2";
  exact(
    input,
    protocol === "MS1"
      ? ["type", "sequence", "payload"]
      : ["protocol", "type", "sequence", "payload"]
  );
  if (protocol === "MS2") requireThat(input.protocol === "MS2", FRAME);
  requireThat(
    [...CHILD_TYPES, ...PARENT_TYPES].includes(input.type) &&
      Number.isSafeInteger(input.sequence) &&
      input.sequence >= 0,
    FRAME
  );
  let payloadBytes;
  try {
    payloadBytes = encodeManualJson(input.payload);
  } catch (error) {
    requireThat(false, error.code === "MANUAL_JSON_LIMIT" ? OUTPUT : FRAME);
  }
  const payload = JSON.parse(payloadBytes.toString("utf8"));
  framePayload(input.type, payload, protocol);
  const bytes = Buffer.concat([
    Buffer.from(`${protocol} ${input.type} ${input.sequence} ${payloadBytes.length}\n`, "ascii"),
    payloadBytes
  ]);
  requireThat(bytes.length <= LIMIT, OUTPUT);
  return bytes;
}

// This private prefix reader uses only the finite, non-recursive RESULT schema.
// It rejects contradictions already received; it never supplies missing evidence.
const resultSchema = evidenceSchema.oneOf.find(
  (s) => s.properties.kind.const === "manual-command-result"
);
const prefixAjv = new Ajv2020({ strict: true, validateFormats: false });
const prefixValidators = new WeakMap();
function resultSchemaNode(schema) {
  return schema.$ref ? evidenceSchema.$defs[schema.$ref.slice("#/$defs/".length)] : schema;
}
function validateResultSubtree(schema, value) {
  let validate = prefixValidators.get(schema);
  if (!validate) {
    validate = prefixAjv.compile({ ...schema, $defs: evidenceSchema.$defs });
    prefixValidators.set(schema, validate);
  }
  requireThat(validate(value), FRAME);
}
function resultPatternRemainder(pattern, value) {
  // The RESULT's anchored ASCII patterns have fixed runs followed, at most,
  // by one variable final run. No user-provided regular expression is compiled.
  const source = pattern.slice(1, -1),
    runs = [];
  const token = /(\[[^\]]+\]|\\.|[^\[\]\\{}*+?])(?:\{(\d+)(?:,(\d+))?\}|([*+]))?/gy;
  let end = 0,
    match;
  while ((match = token.exec(source))) {
    const min = match[4] === "*" ? 0 : match[4] === "+" ? 1 : Number(match[2] ?? 1);
    const max = match[4] ? Infinity : Number(match[3] ?? match[2] ?? 1);
    runs.push({ test: new RegExp(`^(?:${match[1]})$`), min, max });
    end = token.lastIndex;
  }
  requireThat(
    end === source.length && runs.every((r, i) => r.min === r.max || i === runs.length - 1),
    FRAME
  );
  let position = 0,
    minimum = 0,
    maximum = 0;
  for (const run of runs) {
    let count = 0;
    while (position < value.length && count < run.max) {
      requireThat(run.test.test(value[position++]), FRAME);
      count++;
    }
    minimum += Math.max(0, run.min - count);
    maximum += run.max - count;
  }
  requireThat(position === value.length, FRAME);
  return [minimum, maximum];
}
function pendingResultBody(bytes, declaredLength, binding = {}, request = null) {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes, {
    stream: true
  });
  const trailing = bytes.length - Buffer.byteLength(text);
  const partialUtf8 = trailing ? bytes.subarray(bytes.length - trailing) : Buffer.alloc(0);
  const continuation = trailing
    ? (partialUtf8[0] < 224 ? 2 : partialUtf8[0] < 240 ? 3 : 4) - trailing
    : 0;
  let position = 0;
  const root = Object.create(null);
  const known = Object.fromEntries(
    [...A, "attemptAllocationDigest", "requestDigest"]
      .filter((key) => binding[key] !== undefined)
      .map((key) => [key, binding[key]])
  );
  if (request)
    Object.assign(known, {
      ...Object.fromEntries(A.map((key) => [key, request[key]])),
      attemptAllocationDigest: request.attemptAllocationDigest,
      requestDigest: sha256Canonical(request),
      phaseKey: request.phase
    });
  const postKnown = Object.fromEntries(
    ["attemptId", "operationId", "runId"]
      .filter((key) => known[key] !== undefined)
      .map((key) => [key, known[key]])
  );
  if (request)
    Object.assign(postKnown, {
      baselineManifestIdentityDigest: request.domainInput.baselineManifestIdentityDigest,
      baselineManifestDigest: request.domainInput.baselineManifestDigest,
      databaseIdentityFingerprint: request.domainInput.databaseIdentityFingerprint,
      commandId: request.commandId,
      commandVersion: request.commandVersion,
      planDigest: request.approvedPlanDigest
    });
  const schemaFor = (schema, key, isRoot, objectKnown) => {
    if (objectKnown && objectKnown[key] !== undefined) return { const: objectKnown[key] };
    if (!isRoot) return resultSchemaNode(schema);
    if (Object.hasOwn(known, key)) return { const: known[key] };
    const phase = known.phaseKey ?? root.phaseKey;
    if (
      (key === "plan" && phase && phase !== "dry-run") ||
      (key === "originalExecutionRecordDigest" && phase && !["replay", "reconcile"].includes(phase))
    )
      return { const: null };
    return resultSchemaNode(schema);
  };
  const combine = (ranges) => [
    Math.min(...ranges.map((r) => r[0])),
    Math.max(...ranges.map((r) => r[1]))
  ];
  function bounds(input) {
    const schema = resultSchemaNode(input);
    if (Object.hasOwn(schema, "const") || schema.enum) {
      const lengths = (schema.enum ?? [schema.const]).map((v) =>
        Buffer.byteLength(canonicalJson(v))
      );
      return [Math.min(...lengths), Math.max(...lengths)];
    }
    if (schema.anyOf) return combine(schema.anyOf.map(bounds));
    if (schema.type === "null") return [4, 4];
    if (schema.type === "boolean") return [4, 5];
    if (schema.type === "integer") return [1, String(schema.maximum).length];
    if (schema.type === "string") {
      if (schema.pattern) return resultPatternRemainder(schema.pattern, "").map((n) => n + 2);
      return [2 + (schema.minLength ?? 0), 2 + 6 * (schema.maxLength ?? Infinity)];
    }
    if (schema.type === "array") return [2, Infinity];
    requireThat(schema.type === "object" && schema.additionalProperties === false, FRAME);
    const keys = Object.keys(schema.properties),
      required = schema.required ?? [];
    const size = (selected, side) =>
      2 +
      Math.max(0, selected.length - 1) +
      selected.reduce(
        (n, key) =>
          n + Buffer.byteLength(canonicalJson(key)) + 1 + bounds(schema.properties[key])[side],
        0
      );
    return [size(required, 0), size(keys, 1)];
  }
  const incomplete = (min, max) => ({ complete: false, min, max });
  function finish(schema, start, value) {
    requireThat(canonicalJson(value) === text.slice(start, position), FRAME);
    validateResultSubtree(schema, value);
    return { complete: true, value };
  }
  function fixed(values) {
    const rest = text.slice(position),
      candidates = values.map(canonicalJson);
    const complete = candidates.find((candidate) => rest.startsWith(candidate));
    if (complete !== undefined) {
      position += complete.length;
      return { complete: true, value: JSON.parse(complete) };
    }
    const pending = candidates.filter(
      (candidate) =>
        candidate.startsWith(rest) &&
        (!trailing ||
          Buffer.from(candidate.slice(rest.length)).subarray(0, trailing).equals(partialUtf8))
    );
    requireThat(pending.length > 0, FRAME);
    const lengths = pending.map(
      (candidate) => Buffer.byteLength(candidate) - Buffer.byteLength(rest) - trailing
    );
    position = text.length;
    return incomplete(Math.min(...lengths), Math.max(...lengths));
  }
  function take(input, isRoot = false, objectKnown = null) {
    let schema = resultSchemaNode(input);
    const start = position;
    if (Object.hasOwn(schema, "const") || schema.enum) return fixed(schema.enum ?? [schema.const]);
    if (position === text.length) {
      requireThat(trailing === 0, FRAME);
      return incomplete(...bounds(schema));
    }
    const first = text[position];
    if (schema.anyOf) {
      const kind =
        first === "{"
          ? "object"
          : first === "["
            ? "array"
            : first === '"'
              ? "string"
              : first === "n"
                ? "null"
                : /[0-9-]/.test(first)
                  ? "integer"
                  : "boolean";
      const choices = schema.anyOf
        .map(resultSchemaNode)
        .filter((s) => s.type === kind || Object.hasOwn(s, "const") || s.enum);
      requireThat(choices.length === 1, FRAME);
      schema = choices[0];
    }
    if (schema.type === "null") return fixed([null]);
    if (schema.type === "boolean") return fixed([true, false]);
    if (schema.type === "integer") {
      while (position < text.length && !",]}".includes(text[position])) position++;
      const token = text.slice(start, position);
      requireThat(/^(?:0|[1-9][0-9]*)$/.test(token), FRAME);
      const value = Number(token);
      requireThat(Number.isSafeInteger(value) && value <= schema.maximum, FRAME);
      if (position === text.length) {
        requireThat(trailing === 0, FRAME);
        return incomplete(
          value >= (schema.minimum ?? 0) ? 0 : 1,
          Math.max(0, bounds(schema)[1] - token.length)
        );
      }
      return finish(schema, start, value);
    }
    if (schema.type === "string") {
      requireThat(first === '"', FRAME);
      position++;
      let value = "",
        escapeNeeded = 0;
      const escapes = [
        '\\"',
        "\\\\",
        ...Array.from({ length: 32 }, (_, n) => canonicalJson(String.fromCharCode(n)).slice(1, -1))
      ];
      while (position < text.length && text[position] !== '"') {
        const char = text[position];
        requireThat(char.charCodeAt(0) >= 32, FRAME);
        if (char === "\\") {
          const rest = text.slice(position),
            full = escapes.find((e) => rest.startsWith(e));
          if (full) {
            value += JSON.parse('"' + full + '"');
            position += full.length;
          } else {
            const candidates = escapes.filter((e) => e.startsWith(rest));
            requireThat(candidates.length > 0 && trailing === 0 && !schema.pattern, FRAME);
            escapeNeeded = Math.min(...candidates.map((e) => e.length - rest.length));
            position = text.length;
          }
        } else {
          value += char;
          position++;
        }
      }
      if (position < text.length) {
        position++;
        return finish(schema, start, JSON.parse(text.slice(start, position)));
      }
      requireThat(!schema.pattern || trailing === 0, FRAME);
      const count = [...value].length + (escapeNeeded || trailing ? 1 : 0);
      requireThat(count <= (schema.maxLength ?? Infinity), FRAME);
      const range = schema.pattern
        ? resultPatternRemainder(schema.pattern, value)
        : [
            Math.max(0, (schema.minLength ?? 0) - count),
            6 * Math.max(0, (schema.maxLength ?? Infinity) - count)
          ];
      return incomplete(
        1 + escapeNeeded + continuation + range[0],
        1 + escapeNeeded + continuation + range[1]
      );
    }
    if (schema.type === "array") {
      requireThat(first === "[", FRAME);
      position++;
      const value = [],
        seenItems = new Set();
      if (position === text.length) {
        requireThat(trailing === 0, FRAME);
        return incomplete(1, Infinity);
      }
      if (text[position] === "]") {
        position++;
        return finish(schema, start, value);
      }
      while (true) {
        const item = take(schema.items);
        if (!item.complete) return incomplete(item.min + 1, Infinity);
        if (schema.uniqueItems) {
          const key = canonicalJson(item.value);
          requireThat(!seenItems.has(key), FRAME);
          seenItems.add(key);
        }
        value.push(item.value);
        if (position === text.length) {
          requireThat(trailing === 0, FRAME);
          return incomplete(1, Infinity);
        }
        if (text[position] === "]") {
          position++;
          return finish(schema, start, value);
        }
        requireThat(text[position++] === ",", FRAME);
      }
    }
    requireThat(
      schema.type === "object" && first === "{" && schema.additionalProperties === false,
      FRAME
    );
    position++;
    const value = isRoot ? root : Object.create(null),
      keys = Object.keys(schema.properties).sort();
    let previous = "";
    function tail(after) {
      const remaining = keys.filter((k) => k > after),
        required = remaining.filter((k) => schema.required?.includes(k));
      const size = (selected, side) =>
        1 +
        selected.reduce(
          (n, k) =>
            n +
            2 +
            Buffer.byteLength(canonicalJson(k)) +
            bounds(schemaFor(schema.properties[k], k, isRoot, objectKnown))[side],
          0
        );
      return [size(required, 0), size(remaining, 1)];
    }
    while (true) {
      if (text[position] === "}") {
        position++;
        return finish(schema, start, value);
      }
      const nextRequired = keys.find((key) => key > previous && schema.required?.includes(key));
      const candidates = keys.filter(
        (key) => key > previous && (!nextRequired || key <= nextRequired)
      );
      const keyStart = position,
        key = fixed(candidates);
      if (!key.complete) {
        const seen = text.slice(keyStart),
          possible = candidates.filter((k) => canonicalJson(k).startsWith(seen));
        const ranges = possible.map((k) => {
          const extra = Buffer.byteLength(canonicalJson(k)) - Buffer.byteLength(seen) + 1,
            field = bounds(schemaFor(schema.properties[k], k, isRoot, objectKnown)),
            rest = tail(k);
          return [extra + field[0] + rest[0], extra + field[1] + rest[1]];
        });
        requireThat(trailing === 0, FRAME);
        return incomplete(...combine(ranges));
      }
      previous = key.value;
      const fieldSchema = schemaFor(schema.properties[previous], previous, isRoot, objectKnown),
        rest = tail(previous);
      if (position === text.length) {
        requireThat(trailing === 0, FRAME);
        const field = bounds(fieldSchema);
        return incomplete(1 + field[0] + rest[0], 1 + field[1] + rest[1]);
      }
      requireThat(text[position++] === ":", FRAME);
      const child = take(fieldSchema, false, isRoot && previous === "postState" ? postKnown : null);
      if (!child.complete) return incomplete(child.min + rest[0], child.max + rest[1]);
      value[previous] = child.value;
      if (position === text.length) {
        requireThat(trailing === 0, FRAME);
        return incomplete(...rest);
      }
      if (text[position] === "}") {
        position++;
        return finish(schema, start, value);
      }
      requireThat(text[position++] === "," && text[position] !== "}", FRAME);
    }
  }
  const result = take(resultSchema, true);
  requireThat(position === text.length, FRAME);
  const remaining = declaredLength - bytes.length;
  requireThat(
    result.complete
      ? remaining === 0 && trailing === 0
      : remaining >= result.min && remaining <= result.max,
    FRAME
  );
}

function decodeFrame(
  bytes,
  offset,
  direction,
  ended,
  expectedSequence = null,
  seen = [],
  binding = {},
  protocolState = { value: null }
) {
  const allowed = direction === "parent-to-child" ? PARENT_TYPES : CHILD_TYPES;
  const headerEnd = bytes.indexOf(10, offset);
  const end = headerEnd < 0 ? bytes.length : headerEnd;
  const header = bytes.subarray(offset, end);
  requireThat(header.length <= 64 && header.every((b) => b >= 32 && b <= 126), FRAME);
  const text = header.toString("ascii");
  if (text.length < 4) {
    const prefixes = protocolState.value
      ? [`${protocolState.value} `]
      : MANUAL_PROTOCOLS.map((protocol) => `${protocol} `);
    requireThat(
      headerEnd < 0 && prefixes.some((prefix) => prefix.startsWith(text)),
      FRAME
    );
    if (ended) requireThat(false, INCOMPLETE);
    return null;
  }
  const protocol =
    protocolState.value ?? MANUAL_PROTOCOLS.find((value) => text.startsWith(`${value} `));
  requireThat(protocol && text.startsWith(`${protocol} `), FRAME);
  protocolState.value = protocol;
  const pieces = text.slice(4).split(" ");
  requireThat(pieces.length <= 3, FRAME);
  requireThat(
    pieces.length === 1 && headerEnd < 0
      ? allowed.some((t) => t.startsWith(pieces[0]))
      : allowed.includes(pieces[0]),
    FRAME
  );
  if (pieces.length > 1)
    requireThat(
      ![
        "CHALLENGE",
        "AUTHORIZE",
        "READY",
        "CREDENTIAL",
        "CREDENTIAL_RECEIVED",
        "ACK_RECEIVED",
        "RESULT"
      ].includes(pieces[0]) || !seen.includes(pieces[0]),
      REUSED
    );
  if (expectedSequence !== null) {
    const stageTypes =
      direction === "parent-to-child"
        ? [seen.length === 0 ? "AUTHORIZE" : seen.length === 1 ? "CREDENTIAL" : "ACK"]
        : seen.length < 3
          ? [["CHALLENGE", "READY", "CREDENTIAL_RECEIVED"][seen.length]]
          : seen.includes("ACK_RECEIVED")
            ? ["RESULT"]
            : ["PREPARED", "EVENT", "OBSERVATION", "ACK_RECEIVED"];
    requireThat(
      pieces.length === 1 && headerEnd < 0
        ? stageTypes.some((t) => t.startsWith(pieces[0]))
        : stageTypes.includes(pieces[0]),
      ORDER
    );
  }
  for (let i = 1; i < pieces.length; i++) {
    const token = pieces[i],
      complete = i < pieces.length - 1 || headerEnd >= 0;
    requireThat(
      token.length <= (i === 1 ? 16 : 7) &&
        (/^(?:0|[1-9][0-9]*)$/.test(token) || (!complete && token === "")),
      FRAME
    );
    if (token)
      requireThat(Number.isSafeInteger(Number(token)) && (i === 1 || Number(token) > 0), FRAME);
    if (token && i === 2) requireThat(Number(token) <= LIMIT, OUTPUT);
    if (i === 1 && complete && expectedSequence !== null)
      requireThat(Number(token) === expectedSequence, ORDER);
  }
  if (headerEnd < 0) {
    if (ended) requireThat(false, INCOMPLETE);
    return null;
  }
  requireThat(pieces.length === 3, FRAME);
  const [type, sequenceText, lengthText] = pieces,
    length = Number(lengthText),
    frameEnd = headerEnd + 1 + length;
  requireThat(frameEnd - offset <= LIMIT, OUTPUT);
  if (frameEnd > bytes.length) {
    try {
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(headerEnd + 1),
        { stream: true }
      );
    } catch {
      requireThat(false, FRAME);
    }
    if (type === "RESULT") pendingResultBody(bytes.subarray(headerEnd + 1), length, binding);
    if (ended) requireThat(false, INCOMPLETE);
    return null;
  }
  const payloadBytes = Buffer.from(bytes.subarray(headerEnd + 1, frameEnd));
  let payload;
  try {
    payload = parse(payloadBytes);
  } catch {
    requireThat(false, FRAME);
  }
  framePayload(type, payload, protocol);
  return {
    type,
    sequence: Number(sequenceText),
    frameBytes: Buffer.from(bytes.subarray(offset, frameEnd)),
    payloadBytes,
    payload
  };
}

export function parseManualRunnerFrames(input) {
  exact(input, ["direction", "bytes", "ended"]);
  requireThat(
    ["parent-to-child", "child-to-parent"].includes(input.direction) &&
      Buffer.isBuffer(input.bytes) &&
      typeof input.ended === "boolean",
    FRAME
  );
  requireThat(input.bytes.length <= LIMIT, OUTPUT);
  const frames = [];
  let consumedBytes = 0,
    result = false,
    acknowledged = false;
  const protocolState = { value: null };
  while (consumedBytes < input.bytes.length) {
    if (result)
      requireThat(
        false,
        input.bytes
          .subarray(consumedBytes)
          .toString("ascii")
          .startsWith(`${protocolState.value} RESULT `)
          ? REUSED
          : FRAME
      );
    const frame = decodeFrame(
      input.bytes,
      consumedBytes,
      input.direction,
      input.ended,
      frames.length,
      frames.map((f) => f.type),
      frames.find((f) => f.type === "READY")?.payload.binding,
      protocolState
    );
    if (!frame) break;
    const once = [
      "CHALLENGE",
      "AUTHORIZE",
      "READY",
      "CREDENTIAL",
      "CREDENTIAL_RECEIVED",
      "ACK_RECEIVED",
      "RESULT"
    ];
    requireThat(!once.includes(frame.type) || !frames.some((f) => f.type === frame.type), REUSED);
    requireThat(frame.sequence === frames.length, ORDER);
    if (input.direction === "parent-to-child")
      requireThat(
        frame.type ===
          (frames.length === 0 ? "AUTHORIZE" : frames.length === 1 ? "CREDENTIAL" : "ACK"),
        ORDER
      );
    else if (frames.length < 3)
      requireThat(
        frame.type === ["CHALLENGE", "READY", "CREDENTIAL_RECEIVED"][frames.length],
        ORDER
      );
    else {
      requireThat(
        acknowledged
          ? frame.type === "RESULT"
          : ["PREPARED", "EVENT", "OBSERVATION", "ACK_RECEIVED"].includes(frame.type),
        ORDER
      );
      if (frame.type === "ACK_RECEIVED") acknowledged = true;
      if (frame.type === "RESULT") result = true;
    }
    frames.push(frame);
    consumedBytes += frame.frameBytes.length;
  }
  return { frames, consumedBytes, pendingBytes: Buffer.from(input.bytes.subarray(consumedBytes)) };
}

export function validateManualRunnerProtocol(input) {
  if (Object.getOwnPropertyDescriptor(input ?? {}, "mode")?.value === "live-ack") {
    exact(
      input,
      profileKeys(input, [
        "mode",
        "requestBytes",
        "authorizationBytes",
        "previousProcessBytes",
        "childFrameBytes",
        "ackFrameBytes",
        "stdoutPrefixBytes",
        "parentFrameBytes"
      ]),
      Object.hasOwn(input, "profileBytes") ? MISMATCH : FRAME
    );
    const request = parse(input.requestBytes),
      authorization = parse(input.authorizationBytes),
      previous = parse(input.previousProcessBytes);
    validateManualRunnerRequest(request);
    validateContract("manual-launch-authorization.v1", authorization);
    validateContract("manual-runner-evidence.v1", previous);
    const policy = resolveProfile(input, request);
    const parsed = parseManualRunnerFrames({
      direction: "child-to-parent",
      bytes: input.stdoutPrefixBytes,
      ended: true
    });
    requireThat(
      parsed.frames.length > 0 && parsed.frames.at(-1).frameBytes.equals(input.childFrameBytes),
      ORDER
    );
    requireThat(parsed.frames[0]?.type === "CHALLENGE", INCOMPLETE);
    const parents = publicParents(input.parentFrameBytes);
    const candidate = singleFrame(input.ackFrameBytes, "parent-to-child");
    requireThat(candidate.type === "ACK" && candidate.sequence === parents.length + 1, ORDER);
    requireThat(
      parents.length > 0 &&
        frameProtocol(parsed.frames[0]) === frameProtocol(parents[0]) &&
        frameProtocol(candidate) === frameProtocol(parents[0]),
      FRAME
    );
    protocolTrace(request, authorization, parsed.frames, [...parents, candidate], {
      live: true,
      policy,
      previous,
      current: input.childFrameBytes,
      stdout: input.stdoutPrefixBytes
    });
    return;
  }
  exact(
    input,
    profileKeys(input, ["requestBytes", "artifactBytes", "rawBlobs"]),
    Object.hasOwn(input ?? {}, "profileBytes") ? MISMATCH : FRAME
  );
  const graph = inputGraph(input);
  protocolArchive(graph.request, graph);
}

function singleFrame(bytes, direction) {
  requireThat(Buffer.isBuffer(bytes), FRAME);
  requireThat(bytes.length <= LIMIT, OUTPUT);
  const frame = decodeFrame(bytes, 0, direction, true);
  requireThat(frame && frame.frameBytes.length === bytes.length, FRAME);
  return frame;
}
function frameProtocol(frame) {
  const protocol = frame.frameBytes.subarray(0, 3).toString("ascii");
  requireThat(MANUAL_PROTOCOLS.includes(protocol), FRAME);
  return protocol;
}
function publicParents(bytes) {
  bytes = bufferCollection(bytes, FRAME);
  requireThat(
    bytes.reduce((n, b) => n + (Buffer.isBuffer(b) ? b.length : LIMIT + 1), 0) <= LIMIT,
    OUTPUT
  );
  let protocol = null;
  return bytes.map((b, i) => {
    const frame = singleFrame(b, "parent-to-child");
    protocol ??= frameProtocol(frame);
    requireThat(frameProtocol(frame) === protocol, FRAME);
    requireThat(frame.type === (i === 0 ? "AUTHORIZE" : "ACK"), FRAME);
    requireThat(frame.sequence === (i === 0 ? 0 : i + 1), ORDER);
    return frame;
  });
}
function expectedWire(request, authorization) {
  return Object.fromEntries(
    WIRE_KEYS.map((k) => [
      k,
      k === "requestDigest"
        ? sha256Canonical(request)
        : k === "authorizationDigest"
          ? sha256Canonical(authorization)
          : request[k]
    ])
  );
}
function readbackMatches(subject, readback, request, policy) {
  recordPolicy(readback, policy);
  requireThat(
    readback.kind === "custody" &&
      readback.subjectType === "r2-artifact" &&
      readback.purpose === "archive-readback" &&
      readback.storageRole === "archive" &&
      readback.outcome === "MATCH",
    ORDER
  );
  requireThat(
    readback.subjectDigest === sha256Canonical(subject) &&
      readback.observedDigest === readback.subjectDigest &&
      readback.reasonCode === null &&
      readback.retentionDays === policy.days &&
      readback.promotionEligible === false,
    ORDER
  );
  requireThat(
    readback.profileDigest === request.profileDigest && readback.ownerId === request.ownerId,
    MISMATCH
  );
  requireThat(
    instant(subject.recordedAt) <= instant(readback.observedAt) &&
      instant(readback.observedAt) <= instant(readback.recordedAt),
    "MANUAL_TIME_INVALID"
  );
}
function authorizeMatches(frame, request, authorization, challenge, policy) {
  requireThat(frame?.type === "AUTHORIZE", INCOMPLETE);
  const p = frame.payload;
  recordPolicy(p.receipt, policy);
  requireThat(equal(p.request, request) && equal(p.authorization, authorization), MISMATCH);
  requireThat(challenge === request.childChallenge, MISMATCH);
  same(p.launchContext, request, ["containerId", "runnerImageDigest"]);
  same(p.allocation, request, A);
  requireThat(sha256Canonical(p.allocation) === request.attemptAllocationDigest, MISMATCH);
  same(p.process, request, A);
  const launches = p.process.events.filter(
    (event) => event.source === "parent" && event.tool === "runner" && event.event === "SPAWNED"
  );
  requireThat(launches.length === 1 && launches[0].processSequence === 0, MISMATCH);
  same(launches[0], request, ["containerId"]);
  requireThat(
    p.process.requestDigest === sha256Canonical(request) &&
      p.process.attemptAllocationDigest === request.attemptAllocationDigest &&
      p.process.closedAt === null,
    MISMATCH
  );
  requireThat(p.process.protocol.parentFrames.length === 0, ORDER);
  same(p.receipt, request, [
    "profileDigest",
    "sessionId",
    "sessionNonce",
    "operationId",
    "idempotencyKey",
    "containerId",
    "runnerImageDigest",
    "childChallenge"
  ]);
  requireThat(
    p.receipt.requestDigest === sha256Canonical(request) &&
      p.receipt.authorizationDigest === sha256Canonical(authorization),
    MISMATCH
  );
  const payload = authorization.payload;
  same(
    payload,
    request,
    Object.keys(payload).filter(
      (k) =>
        !["schemaVersion", "authorizationId", "issuedAt", "expiresAt", "requestDigest"].includes(k)
    )
  );
  requireThat(payload.requestDigest === sha256Canonical(request), MISMATCH);
  requireThat(sha256Canonical(p.baseline) === request.baselineManifestDigest, MISMATCH);
  if (frameProtocol(frame) === "MS2") {
    const context = p.targetContext;
    requireThat(
      context.runId === request.runId &&
        context.profileDigest === request.profileDigest &&
        equal(context.targetIntent, request.targetIntent) &&
        context.databaseOid === request.physicalIdentity.databaseOid &&
        context.databaseOid === p.baseline.identity.physicalIdentity.databaseOid,
      MISMATCH
    );
    const clusterFingerprint = computeManualClusterFingerprint(context.cluster);
    requireThat(
      clusterFingerprint === request.physicalIdentity.clusterFingerprint &&
        clusterFingerprint === p.baseline.identity.physicalIdentity.clusterFingerprint,
      MISMATCH
    );
  }
  readbackMatches(p.process, p.processReadback, request, policy);
}
function protocolEvent(previous, event, request) {
  requireThat(event.sequence === previous.events.length, ORDER);
  requireThat(event.containerId === request.containerId && event.source === "runner", MISMATCH);
  const events = previous.events,
    dispatch = events.some((e) => e.event === "DISPATCH_CLOSED");
  requireThat(!dispatch, ORDER);
  if (event.event === "DISPATCH_CLOSED") {
    requireThat(
      event.tool === "runner" &&
        event.processSequence === 0 &&
        ["pid", "argvDigest", "exitCode", "signal", "stdout", "stderr"].every(
          (k) => event[k] === null
        ),
      ORDER
    );
    requireThat(
      events
        .filter((e) => e.source === "runner" && e.event === "PREPARED")
        .every((e) =>
          events.some(
            (end) =>
              end.processSequence === e.processSequence &&
              ["CLOSED", "SPAWN_FAILED"].includes(end.event)
          )
        ),
      ORDER
    );
    return;
  }
  requireThat(event.tool !== "runner" && event.processSequence > 0, ORDER);
  const toolEvents = events.filter(
    (e) => e.source === "runner" && e.processSequence === event.processSequence
  );
  if (event.event === "PREPARED") {
    const prepared = events.filter((e) => e.source === "runner" && e.event === "PREPARED");
    requireThat(event.processSequence === prepared.length + 1 && toolEvents.length === 0, ORDER);
    requireThat(
      prepared.every((e) =>
        events.some(
          (end) =>
            end.processSequence === e.processSequence &&
            ["CLOSED", "SPAWN_FAILED"].includes(end.event)
        )
      ),
      ORDER
    );
    requireThat(
      event.argvDigest !== null &&
        ["pid", "exitCode", "signal", "reasonCode", "stdout", "stderr"].every(
          (k) => event[k] === null
        ),
      ORDER
    );
  } else {
    requireThat(toolEvents.length > 0 && toolEvents[0].event === "PREPARED", ORDER);
    requireThat(
      toolEvents.every(
        (e) =>
          e.tool === event.tool &&
          e.argvDigest === event.argvDigest &&
          e.containerId === event.containerId
      ),
      ORDER
    );
    if (["SPAWNED", "SPAWN_FAILED"].includes(event.event))
      requireThat(toolEvents.length === 1, ORDER);
    if (event.event === "SPAWNED")
      requireThat(
        event.pid !== null &&
          ["exitCode", "signal", "reasonCode", "stdout", "stderr"].every((k) => event[k] === null),
        ORDER
      );
    if (event.event === "SPAWN_FAILED")
      requireThat(
        event.reasonCode !== null &&
          ["pid", "exitCode", "signal", "stdout", "stderr"].every((k) => event[k] === null),
        ORDER
      );
    if (event.event === "CLOSED")
      requireThat(
        toolEvents.length === 2 &&
          toolEvents[1].event === "SPAWNED" &&
          event.pid === toolEvents[1].pid &&
          event.stdout !== null &&
          event.stderr !== null &&
          (event.exitCode !== null || event.signal !== null),
        ORDER
      );
  }
}
function ackMatches(ack, child, previous, parents, stdout, request, wire, policy) {
  requireThat(equal(ack.payload.binding, wire), MISMATCH);
  requireThat(equal(ack.payload.acknowledgedFrame, frameRef(child.frameBytes)), ORDER);
  const p = ack.payload;
  let subject;
  if (child.type === "OBSERVATION") {
    requireThat(
      p.subject.kind === "observation" && equal(p.subject.observation, child.payload.observation),
      ORDER
    );
    subject = p.subject.observation;
    requireThat(subject.processEvidenceDigest === sha256Canonical(previous), ORDER);
    requireThat(instant(subject.observedAt) <= instant(subject.recordedAt), "MANUAL_TIME_INVALID");
  } else {
    requireThat(p.subject.kind === "process", ORDER);
    subject = p.subject.process;
    same(subject, previous, [...A, "attemptAllocationDigest", "requestDigest"]);
    requireThat(
      subject.previousProcessEvidenceDigest === sha256Canonical(previous) &&
        subject.closedAt === null,
      ORDER
    );
    requireThat(equal(subject.events, [...previous.events, child.payload.event]), ORDER);
    requireThat(
      equal(subject.protocol, {
        stdoutPrefix: frameRef(stdout),
        parentFrames: parents.map((f) => frameRef(f.frameBytes))
      }),
      ORDER
    );
    protocolEvent(previous, child.payload.event, request);
    requireThat(
      instant(child.payload.event.at) <= instant(subject.recordedAt) &&
        instant(previous.recordedAt) <= instant(subject.recordedAt),
      "MANUAL_TIME_INVALID"
    );
  }
  same(subject, request, A);
  requireThat(subject.requestDigest === sha256Canonical(request), MISMATCH);
  readbackMatches(subject, p.readback, request, policy);
  return p.subject.kind === "process" ? subject : previous;
}
function protocolTrace(request, authorization, children, parents, options) {
  requireThat(children[0]?.type === "CHALLENGE", INCOMPLETE);
  const wire = expectedWire(request, authorization);
  authorizeMatches(
    parents[0],
    request,
    authorization,
    children[0].payload.childChallenge,
    options.policy
  );
  let process = parents[0].payload.process,
    lastAck = null,
    parentIndex = 1,
    offset = 0,
    finalDispatch = false,
    ackReceived = false;
  const authorizeRef = frameRef(parents[0].frameBytes);
  const initialTime = Math.max(
    instant(authorization.payload.issuedAt),
    instant(parents[0].payload.receipt.issuedAt),
    instant(parents[0].payload.receipt.recordedAt),
    instant(parents[0].payload.processReadback.recordedAt)
  );
  const startBytes = options.stdout.subarray(0, process.protocol.stdoutPrefix.bytes);
  requireThat(equal(frameRef(startBytes), process.protocol.stdoutPrefix), ORDER);
  requireThat(startBytes.equals(children[0].frameBytes), ORDER);
  for (const child of children) {
    offset += child.frameBytes.length;
    if (child.type === "CHALLENGE") continue;
    if (child.type !== "RESULT") requireThat(equal(child.payload.binding, wire), MISMATCH);
    if (["READY", "CREDENTIAL_RECEIVED"].includes(child.type)) {
      requireThat(equal(child.payload.authorizeFrame, authorizeRef), ORDER);
      continue;
    }
    if (["PREPARED", "EVENT", "OBSERVATION"].includes(child.type)) {
      requireThat(!finalDispatch, ORDER);
      requireThat(
        equal(child.payload.previousAck, lastAck ? frameRef(lastAck.frameBytes) : null),
        ORDER
      );
      requireThat(
        (lastAck !== null ? instant(lastAck.payload.readback.recordedAt) : initialTime) <=
          instant(
            child.type === "OBSERVATION"
              ? child.payload.observation.observedAt
              : child.payload.event.at
          ),
        "MANUAL_TIME_INVALID"
      );
      if (child.type === "EVENT" && child.payload.event.event !== "DISPATCH_CLOSED")
        requireThat(lastAck !== null, ORDER);
      const ack = parents[parentIndex];
      requireThat(ack, INCOMPLETE);
      requireThat(ack.type === "ACK" && ack.sequence === parentIndex + 1, ORDER);
      if (options.live && child.frameBytes.equals(options.current)) {
        requireThat(child === children.at(-1), ORDER);
        requireThat(equal(process, options.previous), ORDER);
        const prefix = options.stdout.subarray(0, process.protocol.stdoutPrefix.bytes);
        requireThat(equal(frameRef(prefix), process.protocol.stdoutPrefix), ORDER);
        requireThat(
          equal(
            process.protocol.parentFrames,
            parents
              .slice(0, process.protocol.parentFrames.length)
              .map((p) => frameRef(p.frameBytes))
          ),
          ORDER
        );
      }
      process = ackMatches(
        ack,
        child,
        process,
        parents.slice(0, parentIndex),
        options.stdout.subarray(0, offset),
        request,
        wire,
        options.policy
      );
      lastAck = ack;
      parentIndex++;
      if (child.type === "EVENT" && child.payload.event.event === "DISPATCH_CLOSED")
        finalDispatch = true;
    } else if (child.type === "ACK_RECEIVED") {
      requireThat(
        finalDispatch &&
          lastAck !== null &&
          equal(child.payload.previousAck, frameRef(lastAck.frameBytes)),
        ORDER
      );
      ackReceived = true;
    } else if (child.type === "RESULT") {
      requireThat(ackReceived, ORDER);
      same(child.payload, request, A);
      requireThat(
        child.payload.requestDigest === wire.requestDigest &&
          child.payload.attemptAllocationDigest === request.attemptAllocationDigest,
        MISMATCH
      );
    }
  }
  requireThat(parentIndex === parents.length, ORDER);
  if (options.live)
    requireThat(["PREPARED", "EVENT", "OBSERVATION"].includes(children.at(-1)?.type), ORDER);
  else
    requireThat(
      ackReceived &&
        (children.at(-1)?.type === "RESULT" ||
          (options.allowMissingResult && children.at(-1)?.type === "ACK_RECEIVED")),
      INCOMPLETE
    );
  return process;
}

export function validateManualRunnerRequest(request) {
  request = JSON.parse(encodeManualJson(request).toString("utf8"));
  validateContract("manual-runner-request.v1", request);
  requireThat(request.attemptId !== request.runId);
  if (request.stage === "target-observe") return;
  const p = request.physicalIdentity;
  requireThat(
    p.endpointPolicyId === request.targetIntent.endpointPolicyId &&
      p.databaseName === request.targetIntent.databaseName
  );
  requireThat(request.domainInput.baselineManifestDigest === request.baselineManifestDigest);
  requireThat(
    request.domainInput.databaseIdentityFingerprint ===
      sha256Canonical({
        databaseName: p.databaseName,
        databaseOid: String(p.databaseOid),
        role: request.roleObservation.role,
        tls: true
      })
  );
  requireThat(sortedUnique(request.domainInput.allowedExtensions));
  if (["replay", "reconcile"].includes(request.phase))
    requireThat(request.originalIdempotencyKey === request.idempotencyKey);
}

function inputGraph(input) {
  exact(input, profileKeys(input, ["artifactBytes", "rawBlobs", "requestBytes"]), MISMATCH);
  const artifactBytes = bufferCollection(input.artifactBytes),
    rawBlobs = bufferCollection(input.rawBlobs);
  const request = parse(input.requestBytes);
  validateManualRunnerRequest(request);
  const policy = resolveProfile(input, request);
  const artifacts = new Map(),
    raws = new Map();
  for (const bytes of rawBlobs) {
    requireThat(Buffer.isBuffer(bytes));
    requireThat(bytes.length <= LIMIT, OUTPUT);
    const digest = sha256Bytes(bytes);
    requireThat(!raws.has(digest));
    raws.set(digest, bytes);
  }
  for (const bytes of artifactBytes) {
    const value = parse(bytes),
      digest = sha256Bytes(bytes);
    requireThat(!artifacts.has(digest));
    artifacts.set(digest, value);
  }
  const requestDigest = sha256Bytes(input.requestBytes);
  if (artifacts.has(requestDigest)) requireThat(equal(artifacts.get(requestDigest), request));
  else artifacts.set(requestDigest, request);
  const graph = validateArtifacts(artifacts, raws, request.profileDigest, policy);
  const protocolPrefixes = new Set(
    graph.list("process").map((p) => p.protocol.stdoutPrefix.digest)
  );
  for (const [digest, bytes] of raws) if (!protocolPrefixes.has(digest)) decode(bytes);
  const allocation = artifacts.get(request.attemptAllocationDigest);
  requireThat(allocation, REQUIRED);
  requireThat(allocation.kind === "attempt-allocation");
  requireThat(A.every((k) => allocation[k] === request[k]));
  requireThat(allocation.allocatedAt === allocation.recordedAt);
  instant(allocation.recordedAt);
  return {
    ...graph,
    request,
    policyFor(evaluatedRequest) {
      // Recursive recovery evaluates this bound profile, never unrelated history.
      requireThat(evaluatedRequest.profileDigest === request.profileDigest);
      return policy;
    }
  };
}

function bufferCollection(value, code = MISMATCH) {
  requireThat(
    Array.isArray(value) &&
      Object.getPrototypeOf(value) === Array.prototype &&
      Reflect.ownKeys(value).length === value.length + 1,
    code
  );
  const copy = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    requireThat(
      descriptor?.enumerable &&
        Object.hasOwn(descriptor, "value") &&
        Buffer.isBuffer(descriptor.value),
      code
    );
    copy.push(Buffer.from(descriptor.value));
  }
  return copy;
}

export function assessManualRunnerEvidence(input) {
  const graph = inputGraph(input);
  return classify(graph.request, graph);
}

function closedProtocolStdout(final, graph) {
  requireThat(final.closedAt !== null, INCOMPLETE);
  const closed = final.events.filter(
    (e) => e.source === "parent" && e.tool === "runner" && e.event === "CLOSED"
  );
  requireThat(closed.length === 1, INCOMPLETE);
  requireThat(
    equal(closed[0].stdout, final.protocol.stdoutPrefix) &&
      graph.raw(closed[0].stdout).equals(graph.raw(final.protocol.stdoutPrefix)),
    ORDER
  );
}

function protocolArchive(request, graph, { allowMissingResult = false } = {}) {
  const policy = graph.policyFor(request);
  if (request.stage === "target-observe") {
    requireThat(
      !graph
        .list("process")
        .some((p) => p.attemptAllocationDigest === request.attemptAllocationDigest)
    );
    return;
  }
  const process = processChain(request, graph);
  requireThat(process, INCOMPLETE);
  const final = process.final,
    raw = graph.raw(final.protocol.stdoutPrefix);
  const parentBytes = final.protocol.parentFrames.map(graph.raw);
  const parents = publicParents(parentBytes);
  const parsed = parseManualRunnerFrames({
    direction: "child-to-parent",
    bytes: raw,
    ended: final.closedAt !== null && !allowMissingResult
  });
  const { frames, pendingBytes } = parsed;
  if (pendingBytes.length) {
    const headerEnd = pendingBytes.indexOf(10);
    const protocol = frames.length > 0 ? frameProtocol(frames[0]) : null;
    if (
      headerEnd >= 0 &&
      protocol !== null &&
      pendingBytes.subarray(0, headerEnd).toString("ascii").startsWith(`${protocol} RESULT `)
    )
      pendingResultBody(
        pendingBytes.subarray(headerEnd + 1),
        Number(pendingBytes.subarray(0, headerEnd).toString("ascii").split(" ")[3]),
        {},
        request
      );
  }
  requireThat(parents.length > 0, INCOMPLETE);
  requireThat(frames[0]?.type === "CHALLENGE", INCOMPLETE);
  requireThat(frameProtocol(frames[0]) === frameProtocol(parents[0]), FRAME);
  const authorization = parents[0].payload.authorization;
  const archived = (value) =>
    requireThat(equal(graph.artifacts.get(sha256Canonical(value)) ?? null, value), REQUIRED);
  for (const p of parents) {
    if (p.type === "AUTHORIZE") {
      for (const key of [
        "allocation",
        "request",
        "authorization",
        "receipt",
        "baseline",
        "process",
        "processReadback"
      ])
        archived(p.payload[key]);
      if (frameProtocol(p) === "MS2") {
        graph.raw(p.payload.targetContext.h3Approval);
        graph.raw(p.payload.targetContext.h3Readback);
      }
    } else {
      archived(p.payload.subject[p.payload.subject.kind]);
      archived(p.payload.readback);
    }
  }
  for (const f of frames) if (f.type === "OBSERVATION") archived(f.payload.observation);
  const lastAcknowledgedProcess = protocolTrace(request, authorization, frames, parents, {
    live: false,
    policy,
    stdout: raw,
    allowMissingResult
  });
  closedProtocolStdout(final, graph);
  requireThat(
    final.previousProcessEvidenceDigest === sha256Canonical(lastAcknowledgedProcess),
    ORDER
  );
  const result = frames.at(-1);
  // Only original-apply reconstruction may end after the proved dispatch ACK;
  // the decoder has still checked every available byte and complete frame.
  if (allowMissingResult && result?.type === "ACK_RECEIVED") return;
  requireThat(result?.type === "RESULT", INCOMPLETE);
  const originals = graph
    .list("manual-command-result")
    .filter((r) => r.requestDigest === sha256Canonical(request));
  requireThat(originals.length === 1, INCOMPLETE);
  requireThat(result.payloadBytes.equals(encodeManualJson(originals[0])), MISMATCH);
}

function type(value) {
  if (value?.payload?.schemaVersion === "manual-launch-authorization.v1") return "authorization";
  if (value?.catalogVersion === "migration-catalog.v1") return "migration-catalog";
  if (["manual-runner-evidence.v1", ...recordVersions].includes(value?.schemaVersion))
    return value.kind;
  return {
    "manual-runner-request.v1": "request",
    "manual-baseline-manifest.v1": "baseline",
    "build-proof.v1": "build"
  }[value?.schemaVersion];
}
function timeFields(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (child !== null && (key === "at" || key.endsWith("At") || ["validFrom"].includes(key)))
      instant(child);
    else if (child && typeof child === "object") timeFields(child);
  }
}
function same(left, right, keys) {
  requireThat(keys.every((k) => equal(left[k], right[k])));
}
function validateArtifacts(artifacts, raws, profileDigest, policy) {
  const get = (digest, kinds) => {
    const value = artifacts.get(digest);
    requireThat(value, REQUIRED);
    requireThat(kinds.includes(type(value)));
    return value;
  };
  const list = (kind) => [...artifacts.values()].filter((v) => type(v) === kind);
  const raw = (ref) => {
    const bytes = raws.get(ref.digest);
    requireThat(bytes, REQUIRED);
    requireThat(bytes.length === ref.bytes);
    return bytes;
  };
  const birth = (value) =>
    value.recordedAt ??
    value.createdAt ??
    value.payload?.issuedAt ??
    value.provenance?.generatedAt ??
    (type(value) === "request"
      ? get(value.attemptAllocationDigest, ["attempt-allocation"]).allocatedAt
      : null);
  const edges = new Map();
  const edge = (from, digest, kinds) => {
    const target = get(digest, kinds),
      key = sha256Canonical(from);
    if (
      (from.profileDigest ?? from.payload?.profileDigest) === profileDigest &&
      recordVersions.includes(target.schemaVersion)
    )
      recordPolicy(target, policy);
    const links = edges.get(key) ?? [];
    links.push(digest);
    edges.set(key, links);
    if (birth(from) && birth(target))
      requireThat(instant(birth(target)) <= instant(birth(from)), "MANUAL_TIME_INVALID");
    return target;
  };
  for (const value of artifacts.values()) {
    const kind = type(value);
    requireThat(kind);
    if (kind === "request") validateManualRunnerRequest(value);
    else if (kind === "authorization") validateContract("manual-launch-authorization.v1", value);
    else if (kind === "migration-catalog") {
      requireThat(equal(Object.keys(value).sort(), ["catalogVersion", "digest", "entries"]));
      requireThat(Array.isArray(value.entries));
      requireThat(
        value.digest ===
          sha256Canonical({ catalogVersion: value.catalogVersion, entries: value.entries })
      );
      const paths = [];
      for (const [i, entry] of value.entries.entries()) {
        requireThat(equal(Object.keys(entry).sort(), ["order", "path", "sha256"]));
        requireThat(
          entry.order === i + 1 &&
            /^apps\/api\/prisma\/migrations\/[0-9]{14}_[a-z0-9_]+\/migration\.sql$/.test(entry.path)
        );
        requireThat(raws.has(entry.sha256), REQUIRED);
        paths.push(entry.path);
      }
      requireThat(sortedUnique(paths));
    } else validateContract(value.schemaVersion, value);
    if (value.profileDigest === profileDigest && recordVersions.includes(value.schemaVersion))
      recordPolicy(value, policy);
    timeFields(value);
    if (value.recordedAt) {
      for (const field of [
        "openedAt",
        "allocatedAt",
        "observedAt",
        "startedAt",
        "finishedAt",
        "closedAt"
      ]) {
        if (value[field] != null)
          requireThat(instant(value[field]) <= instant(value.recordedAt), "MANUAL_TIME_INVALID");
      }
    }
    if (value.startedAt && value.finishedAt)
      requireThat(instant(value.startedAt) <= instant(value.finishedAt), "MANUAL_TIME_INVALID");
    if (kind === "manual-command-result" && value.postState)
      validateContract("post-state-observation.v1", value.postState);
  }
  for (const value of artifacts.values()) {
    const kind = type(value);
    if (kind === "request") {
      const allocation = edge(value, value.attemptAllocationDigest, ["attempt-allocation"]);
      same(value, allocation, A);
      same(value, allocation, ["stage", "targetIntent"]);
      requireThat(allocation.phaseKey === (value.phase ?? value.stage));
      requireThat(
        allocation.predecessorExecutionRecordDigest ===
          (value.dryRunRecordDigest ?? value.predecessorExecutionRecordDigest ?? null)
      );
      if (value.stage === "runner-command") {
        for (const [key, target] of [
          ["buildProofDigest", "build"],
          ["baselineManifestDigest", "baseline"],
          ["targetObservationDigest", "observation"],
          ["expectedSchemaEvidenceDigest", "schema-expectation"]
        ])
          edge(value, value[key], [target]);
        const baseline = get(value.baselineManifestDigest, ["baseline"]).identity;
        // Bind actual predecessors to this request, not to the archive's current policy.
        for (const digest of [value.targetObservationDigest, baseline.targetObservationDigest])
          same(value, get(digest, ["observation"]), ["profileDigest"]);
        same(value, get(baseline.authorizationDigest, ["authorization"]).payload, [
          "profileDigest"
        ]);
        for (const key of ["dryRunRecordDigest", "predecessorExecutionRecordDigest"])
          if (value[key]) edge(value, value[key], ["execution"]);
      }
    } else if (kind === "attempt-allocation") {
      requireThat(value.allocatedAt === value.recordedAt);
      if (value.predecessorExecutionRecordDigest)
        edge(value, value.predecessorExecutionRecordDigest, ["execution"]);
    } else if (kind === "authorization") {
      const p = value.payload,
        request = edge(value, p.requestDigest, ["request"]);
      const ignored = [
        "schemaVersion",
        "authorizationId",
        "issuedAt",
        "expiresAt",
        "requestDigest"
      ];
      same(
        p,
        request,
        Object.keys(p).filter((k) => !ignored.includes(k))
      );
      requireThat(
        instant(p.issuedAt) < instant(p.expiresAt) &&
          instant(p.expiresAt) - instant(p.issuedAt) <= 300000,
        "MANUAL_TIME_INVALID"
      );
    } else if (kind === "baseline") {
      const id = value.identity;
      edge(value, id.buildProofDigest, ["build"]);
      const observation = edge(value, id.targetObservationDigest, ["observation"]);
      const auth = edge(value, id.authorizationDigest, ["authorization"]);
      requireThat(
        auth.payload.stage === "target-observe" &&
          observation.requestDigest === auth.payload.requestDigest
      );
      const consumed = list("consumption").filter(
        (c) =>
          c.authorizationDigest === id.authorizationDigest &&
          c.requestDigest === observation.requestDigest
      );
      requireThat(consumed.length === 1, REQUIRED);
      requireThat(
        instant(consumed[0].recordedAt) <= instant(observation.observedAt),
        "MANUAL_TIME_INVALID"
      );
      same(id, observation, ["physicalIdentity", "roleObservation"]);
      requireThat(id.preStateDigest === sha256Canonical(observation.catalog));
      requireThat(id.purpose === auth.payload.purpose);
    } else if (kind === "schema-expectation") {
      edge(value, value.buildProofDigest, ["build"]);
      raw(value.script);
      requireThat(raws.has(value.sourceSchemaDigest), REQUIRED);
    } else if (["process", "observation", "manual-command-result"].includes(kind)) {
      let request = null;
      if (value.requestDigest !== null) {
        request = edge(value, value.requestDigest, ["request"]);
        same(value, request, A);
      }
      if (kind !== "observation") {
        const allocation = edge(value, value.attemptAllocationDigest, ["attempt-allocation"]);
        same(value, allocation, A);
      }
      if (kind === "process") {
        raw(value.protocol.stdoutPrefix);
        for (const ref of value.protocol.parentFrames) raw(ref);
        if (value.previousProcessEvidenceDigest)
          edge(value, value.previousProcessEvidenceDigest, ["process"]);
        for (const event of value.events) {
          requireThat(instant(event.at) <= instant(value.recordedAt), "MANUAL_TIME_INVALID");
          if (event.argvDigest) requireThat(raws.has(event.argvDigest), REQUIRED);
          if (event.stdout) raw(event.stdout);
          if (event.stderr) raw(event.stderr);
        }
      } else {
        if (value.processEvidenceDigest) edge(value, value.processEvidenceDigest, ["process"]);
        if (kind === "observation") {
          requireThat(
            value.physicalIdentity.endpointPolicyId === request.targetIntent.endpointPolicyId &&
              value.physicalIdentity.databaseName === request.targetIntent.databaseName
          );
          requireThat(
            value.roleObservation.schemaObservationDigest === sha256Canonical(value.catalog)
          );
          if (request.stage === "runner-command") {
            same(value, request, ["physicalIdentity"]);
            same(value.roleObservation, request.roleObservation, ["role", "tls"]);
          }
          validateCatalogObservation(value.catalog);
        } else {
          requireThat(value.phaseKey === (request.phase ?? request.stage));
          requireThat(value.attemptAllocationDigest === request.attemptAllocationDigest);
          if (value.observationDigest) {
            const o = edge(value, value.observationDigest, ["observation"]);
            requireThat(o.requestDigest === value.requestDigest);
          }
          if (value.originalExecutionRecordDigest)
            edge(value, value.originalExecutionRecordDigest, ["execution"]);
          if (value.outcome === "RETURNED")
            requireThat(
              value.startedAt !== null && value.finishedAt !== null && value.reasonCode === null
            );
          else
            requireThat(
              value.reasonCode !== null && (value.outcome !== "THREW" || value.finishedAt !== null)
            );
          requireThat(value.plan === null || value.phaseKey === "dry-run");
          requireThat(value.postState === null || value.phaseKey === "apply");
          requireThat(
            ["replay", "reconcile"].includes(value.phaseKey) ||
              value.originalExecutionRecordDigest === null
          );
        }
      }
    } else if (recordVersions.includes(value.schemaVersion)) {
      validateRecord(value, edge, get);
    }
  }
  const active = new Set(),
    visited = new Set();
  function visit(digest) {
    requireThat(!active.has(digest));
    if (visited.has(digest)) return;
    active.add(digest);
    for (const next of edges.get(digest) ?? []) visit(next);
    active.delete(digest);
    visited.add(digest);
  }
  for (const digest of artifacts.keys()) visit(digest);
  return { artifacts, raws, get, list, raw };
}

function validateCatalogObservation(catalog) {
  requireThat(catalog.migrationTableOid !== null || catalog.migrationRows.length === 0);
  requireThat(sortedUnique(catalog.extensions));
  requireThat(
    sortedUnique(catalog.ownerInventory.map((v) => `${v.objectClass}\u0000${v.objectName}`))
  );
  requireThat(
    new Set(catalog.migrationRows.map((v) => v.id)).size === catalog.migrationRows.length
  );
  requireThat(
    sortedUnique(
      catalog.migrationRows.map((v) => `${v.startedAt}\u0000${v.migrationName}\u0000${v.id}`)
    )
  );
  for (const row of catalog.migrationRows) {
    for (const k of ["finishedAt", "rolledBackAt"])
      if (row[k]) requireThat(instant(row.startedAt) <= instant(row[k]), "MANUAL_TIME_INVALID");
  }
}

function validateRecord(value, edge, get) {
  const scoped = ["profileDigest", "sessionId", "sessionNonce", "operationId", "idempotencyKey"];
  const link = (key, kinds) => (value[key] === null ? null : edge(value, value[key], kinds));
  const request = Object.hasOwn(value, "requestDigest") ? link("requestDigest", ["request"]) : null;
  if (request) same(value, request, scoped);
  if (value.kind === "session") {
    if (value.status === "OPEN") requireThat(value.openedAt === value.recordedAt);
    if (value.previousSessionRecordDigest) {
      const prev = link("previousSessionRecordDigest", ["session"]);
      same(value, prev, [
        "profileDigest",
        "sessionId",
        "sessionNonce",
        "ownerId",
        "targetIntent",
        "openedAt"
      ]);
    }
  } else if (value.kind === "revocation") {
    if (value.previousRevocationDigest) {
      const prev = link("previousRevocationDigest", ["revocation"]);
      same(value, prev, ["profileDigest", "ownerId"]);
      requireThat(value.sequence === prev.sequence + 1);
    }
  } else if (value.kind === "consumption") {
    const auth = link("authorizationDigest", ["authorization"]).payload;
    same(value, auth, [...scoped, "ownerId", "requestDigest", "stage"]);
    const session = link("sessionRecordDigest", ["session"]);
    same(value, session, ["profileDigest", "sessionId", "sessionNonce", "ownerId"]);
    requireThat(session.status === "OPEN" && equal(session.targetIntent, request.targetIntent));
    const revocation = link("revocationRecordDigest", ["revocation"]);
    same(value, revocation, ["profileDigest", "ownerId"]);
    requireThat(value.revocationSequence === revocation.sequence);
    let node = revocation;
    while (node) {
      requireThat(
        node.action !== "REVOKE_PROFILE" &&
          !(node.action === "REVOKE_AUTHORIZATION" && node.authorizationId === auth.authorizationId)
      );
      node = node.previousRevocationDigest
        ? get(node.previousRevocationDigest, ["revocation"])
        : null;
    }
    requireThat(
      instant(auth.issuedAt) <= instant(value.recordedAt) &&
        instant(value.recordedAt) < instant(auth.expiresAt),
      "MANUAL_TIME_INVALID"
    );
  } else if (value.kind === "consumption-handoff") {
    const auth = link("authorizationDigest", ["authorization"]).payload;
    same(value, auth, [
      ...scoped,
      "requestDigest",
      "containerId",
      "runnerImageDigest",
      "childChallenge"
    ]);
    requireThat(auth.stage === "runner-command");
    const consumption = link("consumptionRecordDigest", ["consumption"]);
    same(value, consumption, [
      ...scoped,
      "authorizationDigest",
      "requestDigest",
      "revocationSequence"
    ]);
    const custody = link("consumptionReadbackDigest", ["custody"]);
    requireThat(
      custody.purpose === "consumption-readback" &&
        custody.outcome === "MATCH" &&
        custody.subjectDigest === value.consumptionRecordDigest
    );
    requireThat(
      value.recordedAt === value.issuedAt &&
        instant(value.issuedAt) >= instant(auth.issuedAt) &&
        instant(value.expiresAt) ===
          Math.min(instant(auth.expiresAt), instant(value.issuedAt) + 30000),
      "MANUAL_TIME_INVALID"
    );
  } else if (value.kind === "post-state") {
    const consumption = link("consumptionRecordDigest", ["consumption"]);
    same(value, consumption, [...scoped, "requestDigest"]);
    if (value.observationDigest) {
      const observation = link("observationDigest", ["observation"]);
      same(value, observation, [...scoped, "requestDigest", "observedAt"]);
    }
  } else if (value.kind === "execution") {
    requireThat(value.attemptId === request.attemptId);
    for (const [key, kind] of [
      ["authorizationDigest", "authorization"],
      ["consumptionRecordDigest", "consumption"],
      ["handoffRecordDigest", "consumption-handoff"],
      ["handoffReadbackDigest", "custody"],
      ["postStateRecordDigest", "post-state"],
      ["predecessorExecutionRecordDigest", "execution"],
      ["resultDigest", "manual-command-result"],
      ["processEvidenceDigest", "process"]
    ]) {
      const target = link(key, [kind]);
      if (target && !["predecessorExecutionRecordDigest", "handoffReadbackDigest"].includes(key))
        requireThat(
          (target.payload?.requestDigest ?? target.requestDigest) === value.requestDigest
        );
    }
    requireThat(
      value.predecessorExecutionRecordDigest ===
        (request.dryRunRecordDigest ?? request.predecessorExecutionRecordDigest ?? null)
    );
    if (value.handoffReadbackDigest) {
      const readback = get(value.handoffReadbackDigest, ["custody"]);
      requireThat(
        readback.purpose === "handoff-readback" &&
          readback.subjectDigest === value.handoffRecordDigest &&
          readback.outcome === "MATCH"
      );
    }
  } else if (value.kind === "custody") {
    if (value.subjectType === "profile") requireThat(value.subjectDigest === value.profileDigest);
    else {
      const kinds =
        value.subjectType === "authorization"
          ? ["authorization"]
          : value.subjectType === "record"
            ? [
                "session",
                "revocation",
                "consumption",
                "consumption-handoff",
                "post-state",
                "execution",
                "signoff"
              ]
            : [
                "request",
                "attempt-allocation",
                "process",
                "observation",
                "manual-command-result",
                "baseline",
                "schema-expectation",
                "build",
                "migration-catalog"
              ];
      const subject = edge(value, value.subjectDigest, kinds);
      if (subject.profileDigest) requireThat(subject.profileDigest === value.profileDigest);
    }
    if (value.outcome === "MATCH") requireThat(value.observedDigest === value.subjectDigest);
    if (value.purpose === "consumption-readback")
      requireThat(
        type(get(value.subjectDigest, ["consumption"])) === "consumption" &&
          value.storageRole === "journal"
      );
    if (value.purpose === "handoff-readback") {
      get(value.subjectDigest, ["consumption-handoff"]);
      requireThat(value.storageRole === "archive");
    }
    if (value.purpose === "backup-readback") requireThat(value.storageRole === "backup");
  } else if (value.kind === "signoff") {
    const execution = link("executionRecordDigest", ["execution"]);
    same(value, execution, scoped);
    for (const [key, purpose] of [
      ["executionReadbackDigest", "archive-readback"],
      ["backupReadbackDigest", "backup-readback"]
    ]) {
      const custody = link(key, ["custody"]);
      requireThat(
        custody.subjectDigest === value.executionRecordDigest &&
          custody.purpose === purpose &&
          custody.outcome === "MATCH"
      );
    }
    if (value.decision === "ACCEPTED") requireThat(execution.status === "SUCCEEDED");
  }
}

function classify(request, graph) {
  const digest = sha256Canonical(request),
    phase = request.phase ?? request.stage;
  const results = graph.list("manual-command-result").filter((v) => v.requestDigest === digest);
  requireThat(results.length <= 1);
  const result = results[0] ?? null;
  const consumption = graph.list("consumption").filter((v) => v.requestDigest === digest);
  requireThat(consumption.length <= 1);
  const posts = graph
    .list("post-state")
    .filter((v) => v.requestDigest === digest && v.outcome === "OBSERVED");
  const observed = result?.observationDigest
    ? graph.get(result.observationDigest, ["observation"])
    : null;
  const base = {
    attemptId: request.attemptId,
    phaseKey: phase,
    executionStatus: "INTERRUPTED_UNKNOWN",
    originalDatabaseOutcome: "unknown",
    reasonCode: "MANUAL_EVIDENCE_INCOMPLETE",
    planDigest: null,
    proofDigest: result ? sha256Canonical(result) : null,
    promotionEligible: false
  };
  if (request.stage === "target-observe") {
    requireThat(
      result === null ||
        (result.plan === null && result.postState === null && result.processEvidenceDigest === null)
    );
    requireThat(
      observed === null || (observed.schema === null && observed.processEvidenceDigest === null)
    );
    if (
      result?.outcome === "RETURNED" &&
      observed &&
      consumption.length === 1 &&
      posts.some((v) => v.observationDigest === result.observationDigest)
    ) {
      requireThat(
        instant(consumption[0].recordedAt) <= instant(result.startedAt) &&
          instant(result.startedAt) <= instant(observed.observedAt) &&
          instant(observed.observedAt) <= instant(result.finishedAt),
        "MANUAL_TIME_INVALID"
      );
      return Object.freeze({
        ...base,
        executionStatus: "SUCCEEDED",
        originalDatabaseOutcome: "not-applicable",
        reasonCode: null
      });
    }
    if (result?.outcome === "THREW" && consumption.length === 1)
      return Object.freeze({
        ...base,
        executionStatus: "FAILED",
        originalDatabaseOutcome: "not-applicable",
        reasonCode: result.reasonCode
      });
  }
  if (request.stage === "runner-command")
    return classifyRunner(request, graph, base, result, observed, consumption, posts);
  return Object.freeze(base);
}

function processChain(request, graph) {
  const snapshots = graph
    .list("process")
    .filter((p) => p.attemptAllocationDigest === request.attemptAllocationDigest);
  if (snapshots.length === 0) return null;
  const roots = snapshots.filter((p) => p.previousProcessEvidenceDigest === null);
  requireThat(roots.length === 1);
  let node = roots[0],
    previous = null,
    bound = false,
    count = 0;
  requireThat(node.requestDigest === null);
  const requestDigest = sha256Canonical(request),
    chain = [];
  while (node) {
    count++;
    chain.push(node);
    same(node, request, A);
    if (previous) {
      requireThat(previous.closedAt === null);
      requireThat(equal(node.events.slice(0, previous.events.length), previous.events));
      requireThat(
        node.events.length > previous.events.length ||
          (!bound && previous.requestDigest === null && node.requestDigest === requestDigest)
      );
      if (previous.events.some((e) => e.event === "DISPATCH_CLOSED"))
        requireThat(
          node.events.length === previous.events.length + 1 &&
            node.events.at(-1).source === "parent" &&
            node.events.at(-1).tool === "runner" &&
            node.events.at(-1).event === "CLOSED"
        );
    }
    if (node.requestDigest === null) {
      requireThat(!bound && node.events.every((e) => e.source === "parent" && e.tool === "runner"));
      requireThat(
        node.events.filter((e) => e.event === "DISPATCH_CLOSED").every((e) => e.reasonCode !== null)
      );
    } else {
      requireThat(node.requestDigest === requestDigest);
      bound = true;
    }
    const calls = new Map();
    let dispatchedClosed = false;
    for (const [i, e] of node.events.entries()) {
      requireThat(
        e.sequence === i &&
          (!dispatchedClosed ||
            (e.source === "parent" && e.tool === "runner" && e.event === "CLOSED"))
      );
      if (i > 0)
        requireThat(instant(node.events[i - 1].at) <= instant(e.at), "MANUAL_TIME_INVALID");
      if (e.event === "DISPATCH_CLOSED") {
        requireThat(
          ["parent", "runner"].includes(e.source) && e.tool === "runner" && e.processSequence === 0
        );
        requireThat(
          ["pid", "argvDigest", "exitCode", "signal", "stdout", "stderr"].every(
            (k) => e[k] === null
          )
        );
        dispatchedClosed = true;
        continue;
      }
      requireThat((e.tool === "runner") === (e.source === "parent"));
      requireThat(e.argvDigest !== null);
      validateArgv(e, request, graph);
      const existing = calls.get(e.processSequence);
      if (e.event === "PREPARED") {
        requireThat(!existing && e.processSequence === calls.size);
        requireThat(
          ["pid", "exitCode", "signal", "reasonCode", "stdout", "stderr"].every(
            (k) => e[k] === null
          )
        );
        calls.set(e.processSequence, { prepared: e, index: i, last: e });
      } else {
        requireThat(
          existing &&
            existing.prepared.tool === e.tool &&
            existing.prepared.argvDigest === e.argvDigest
        );
        if (i >= (previous?.events.length ?? 0))
          requireThat(previous && existing.index < previous.events.length);
        if (e.event === "SPAWNED") {
          requireThat(existing.last.event === "PREPARED" && e.pid !== null);
          requireThat(
            ["exitCode", "signal", "reasonCode", "stdout", "stderr"].every((k) => e[k] === null)
          );
        } else if (e.event === "SPAWN_FAILED") {
          requireThat(existing.last.event === "PREPARED" && e.reasonCode !== null);
          requireThat(
            ["pid", "exitCode", "signal", "stdout", "stderr"].every((k) => e[k] === null)
          );
        } else {
          requireThat(e.event === "CLOSED" && existing.last.event === "SPAWNED");
          requireThat(
            e.pid === existing.last.pid &&
              e.containerId === existing.last.containerId &&
              (e.exitCode !== null || e.signal !== null)
          );
          requireThat(e.stdout !== null && e.stderr !== null);
        }
        existing.last = e;
      }
      if (e.tool !== "runner" || e.event !== "PREPARED")
        requireThat(e.containerId === request.containerId);
    }
    if (node.closedAt !== null) {
      requireThat(
        dispatchedClosed &&
          [...calls.values()].every((c) => ["CLOSED", "SPAWN_FAILED"].includes(c.last.event))
      );
      requireThat(
        node.events.every((e) => instant(e.at) <= instant(node.closedAt)),
        "MANUAL_TIME_INVALID"
      );
    }
    const prefix = graph.raw(node.protocol.stdoutPrefix);
    if (previous) {
      const old = graph.raw(previous.protocol.stdoutPrefix);
      requireThat(prefix.subarray(0, old.length).equals(old));
      requireThat(
        equal(
          node.protocol.parentFrames.slice(0, previous.protocol.parentFrames.length),
          previous.protocol.parentFrames
        )
      );
    } else
      requireThat(
        node.protocol.stdoutPrefix.bytes === 0 &&
          prefix.length === 0 &&
          node.protocol.parentFrames.length === 0
      );
    if (node.requestDigest === null) requireThat(node.protocol.parentFrames.length === 0);
    const next = snapshots.filter((p) => p.previousProcessEvidenceDigest === sha256Canonical(node));
    requireThat(next.length <= 1);
    previous = node;
    node = next[0] ?? null;
  }
  requireThat(count === snapshots.length);
  return {
    chain,
    final: previous,
    bound,
    calls: previous.events.filter((e) => e.event === "CLOSED")
  };
}

function validateArgv(event, request, graph) {
  const argv = parse(graph.raws.get(event.argvDigest));
  requireThat(
    equal(Object.keys(argv).sort(), ["args", "command"]) &&
      typeof argv.command === "string" &&
      Array.isArray(argv.args) &&
      argv.args.every((a) => typeof a === "string")
  );
  if (event.tool === "runner") {
    requireThat(argv.command === "docker" && argv.args[0] === "run");
    const args = argv.args.slice(1),
      image = graph.get(request.buildProofDigest, ["build"]).identity.images.runner;
    requireThat(args.at(-1) === `${image.registry}@${request.runnerImageDigest}`);
    const values = new Map();
    for (let i = 0; i < args.length - 1; i++) {
      const name = args[i];
      requireThat(!values.has(name));
      if (["--interactive", "-i", "--read-only"].includes(name)) values.set(name, true);
      else {
        requireThat(
          ["--network", "--tmpfs", "--cap-drop", "--security-opt", "--env"].includes(name)
        );
        requireThat(i + 1 < args.length - 1);
        values.set(name, args[++i]);
      }
    }
    requireThat((values.has("--interactive") || values.has("-i")) && values.has("--read-only"));
    requireThat(
      typeof values.get("--network") === "string" &&
        !["host", "bridge", "none", "default"].includes(values.get("--network"))
    );
    requireThat(/^\/tmp:rw,noexec,nosuid,size=[1-9][0-9]*[km]$/.test(values.get("--tmpfs") ?? ""));
    requireThat(
      values.get("--cap-drop") === "ALL" && values.get("--security-opt") === "no-new-privileges"
    );
    requireThat(
      !values.has("--env") || values.get("--env") === "RUNNER_EXECUTION_MODE=manual-stage1"
    );
    return;
  }
  if (event.tool === "psql-version") {
    requireThat(argv.command === "psql" && equal(argv.args, ["--version"]));
    return;
  }
  const command = argv.command.replaceAll("\\", "/");
  const suffix = "/apps/release-runner/node_modules/.bin/prisma";
  requireThat(command.endsWith(suffix));
  const root = command.slice(0, -suffix.length);
  requireThat(
    /^(?:\/[A-Za-z0-9_./-]+|[A-Z]:\/[A-Za-z0-9_ ./-]+)$/.test(root) &&
      !root.split("/").some((p) => p === "." || p === "..")
  );
  const schema = `${root}/apps/api/prisma/schema.prisma`,
    config = `${root}/apps/api/prisma.config.ts`;
  const args = argv.args.map((a) => a.replaceAll("\\", "/"));
  const expected = {
    "prisma-version": ["--version"],
    "prisma-deploy": ["migrate", "deploy", "--schema", schema, "--config", config],
    "prisma-diff": [
      "migrate",
      "diff",
      "--from-config-datasource",
      "--to-schema",
      schema,
      "--exit-code",
      "--config",
      config
    ],
    "prisma-script": [
      "migrate",
      "diff",
      "--from-empty",
      "--to-config-datasource",
      "--script",
      "--config",
      config
    ]
  }[event.tool];
  requireThat(expected && equal(args, expected));
}

function catalogFor(request, graph) {
  const build = graph.get(request.buildProofDigest, ["build"]);
  requireThat(build.identity.images.runner.imageDigest === request.runnerImageDigest);
  const candidates = graph
    .list("migration-catalog")
    .filter((c) => c.digest === build.identity.migrationCatalogDigest);
  requireThat(candidates.length === 1, REQUIRED);
  return candidates[0];
}
function projectedRows(catalog, observation, complete = false) {
  const rows = observation.catalog.migrationRows;
  if (rows.length > catalog.entries.length || (complete && rows.length !== catalog.entries.length))
    return null;
  if (
    rows.some(
      (row, i) =>
        row.finishedAt === null ||
        row.rolledBackAt !== null ||
        row.migrationName !== catalog.entries[i].path.split("/").at(-2) ||
        row.checksum !== catalog.entries[i].sha256
    )
  )
    return null;
  return catalog.entries.slice(0, rows.length);
}
function toolsFor(request, graph, process, observation, result) {
  if (!process || process.final.closedAt === null || !process.bound) return null;
  if (
    process.final.events.some(
      (e) => e.reasonCode !== null || e.signal !== null || e.event === "SPAWN_FAILED"
    )
  )
    return null;
  const closed = process.calls;
  const tool = (name) => {
    const matches = closed.filter((e) => e.tool === name);
    return matches.length === 1 ? matches[0] : null;
  };
  const prisma = tool("prisma-version"),
    psql = tool("psql-version"),
    runner = tool("runner");
  if (!prisma || !psql || !runner || [prisma, psql, runner].some((e) => e.exitCode !== 0))
    return null;
  const versions = {
    postgresql: observation.catalog.postgresqlVersion,
    prisma: decode(graph.raw(prisma.stdout)).trim(),
    psql: decode(graph.raw(psql.stdout)).trim()
  };
  requireThat(versions.prisma.length > 0 && versions.psql.length > 0);
  requireThat(/(?:^|\n)prisma\s*:\s*7\.8\.0(?:\s|$)/.test(versions.prisma));
  requireThat(
    /(?:^|\s)17(?:\.|\s|$)/.test(versions.psql) && /^17(?:\.|\s|$)/.test(versions.postgresql)
  );
  if (result) {
    requireThat(process.chain.some((p) => sha256Canonical(p) === result.processEvidenceDigest));
    requireThat(
      process.chain.some((p) => sha256Canonical(p) === observation.processEvidenceDigest)
    );
    requireThat(
      instant(result.finishedAt) <= instant(process.final.closedAt),
      "MANUAL_TIME_INVALID"
    );
  }
  return { versions, tool, closed };
}

function schemaPassed(request, graph, observation, result, tools, catalog) {
  const schema = observation.schema;
  if (!schema || !tools || !projectedRows(catalog, observation, true)) return false;
  const script = tools.tool("prisma-script"),
    diff = tools.tool("prisma-diff");
  if (!script || !diff || script.exitCode !== 0 || diff.exitCode !== 0) return false;
  const expectation = graph.get(request.expectedSchemaEvidenceDigest, ["schema-expectation"]);
  requireThat(
    expectation.buildProofDigest === request.buildProofDigest &&
      expectation.script.digest === request.domainInput.expectedSchemaDigest
  );
  requireThat(expectation.prismaVersion === tools.versions.prisma);
  const stdout = decode(graph.raw(diff.stdout));
  requireThat(
    schema.schemaDigest === script.stdout.digest &&
      schema.schemaDigest === request.domainInput.expectedSchemaDigest
  );
  requireThat(equal(schema.schemaDiff, { exitCode: diff.exitCode, stdout }));
  requireThat(equal(schema.toolVersions, tools.versions));
  requireThat(schema.statementLogDigest === sha256Canonical(result.statements));
  requireThat(
    schema.catalogDigest === catalog.digest && equal(schema.migrationChecksums, catalog.entries)
  );
  requireThat(schema.migrationHead === (catalog.entries.at(-1)?.path.split("/").at(-2) ?? null));
  same(schema, observation.catalog, ["schemaOwner", "ownerInventory", "extensions"]);
  return (
    stdout.trim() === "" &&
    schema.schemaOwner === request.domainInput.expectedOwner &&
    schema.ownerInventory.every((v) => v.owner === request.domainInput.expectedOwner) &&
    schema.extensions.every((v) => request.domainInput.allowedExtensions.includes(v)) &&
    result.statements.length > 0 &&
    result.statements.every((statement) => {
      const sql = statement.replace(/--.*$/gmu, " ").trim();
      return (
        /^(?:explain\s+)?(?:select|show|with)\b|^set\s+transaction\s+read\s+only\b/iu.test(sql) &&
        !/\b(?:alter|call|comment|copy|create|delete|do|drop|grant|insert|merge|refresh|reindex|revoke|truncate|update|vacuum)\b/iu.test(
          sql
        )
      );
    })
  );
}

function planFor(request, observation, catalog, versions) {
  const input = request.domainInput;
  return {
    schemaVersion: "deterministic-plan.v1",
    identity: {
      planType: "migration-plan.v1",
      commandKey: "db.migrate.deploy@1",
      inputDigest: sha256Canonical(input),
      databaseIdentityFingerprint: input.databaseIdentityFingerprint,
      baselineManifestIdentityDigest: input.baselineManifestIdentityDigest,
      baselineManifestDigest: input.baselineManifestDigest,
      migrationCatalogDigest: catalog.digest,
      currentMigrationHead: observation.catalog.migrationRows.at(-1)?.migrationName ?? null,
      pendingMigrations: catalog.entries.slice(observation.catalog.migrationRows.length),
      expectedPostMigrationHead: catalog.entries.at(-1)?.path.split("/").at(-2) ?? null,
      expectedSchemaDigest: input.expectedSchemaDigest,
      expectedOwner: input.expectedOwner,
      allowedExtensions: input.allowedExtensions,
      expectedWriteScope: ["_prisma_migrations", "schema-ddl"]
    },
    provenance: { planner: "db.migrate.deploy@1", toolVersions: versions }
  };
}

function postStatePassed(request, observation, plan, postState) {
  if (!postState) return false;
  same(postState, request, ["operationId", "attemptId", "runId", "commandId", "commandVersion"]);
  same(postState, request.domainInput, [
    "baselineManifestIdentityDigest",
    "baselineManifestDigest",
    "databaseIdentityFingerprint"
  ]);
  const schema = observation.schema;
  requireThat(
    postState.planDigest === deterministicPlanDigest(plan) &&
      postState.postMigrationHead === schema.migrationHead &&
      postState.postSchemaDigest === schema.schemaDigest
  );
  requireThat(
    postState.configurationFingerprint ===
      sha256Canonical({
        schemaOwner: schema.schemaOwner,
        extensions: schema.extensions,
        toolVersions: schema.toolVersions
      })
  );
  const expected = [
    [
      "migration-head-equals-catalog-head",
      plan.identity.expectedPostMigrationHead,
      schema.migrationHead
    ],
    ["schema-diff-zero", { exitCode: 0, stdout: "" }, schema.schemaDiff],
    ["schema-owner-matches", request.domainInput.expectedOwner, schema.schemaOwner],
    ["extensions-allowed", request.domainInput.allowedExtensions, schema.extensions]
  ].map(([id, expected, actual]) => ({
    id,
    status: sha256Canonical(expected) === sha256Canonical(actual) ? "PASSED" : "FAILED",
    expectedDigest: sha256Canonical(expected),
    actualDigest: sha256Canonical(actual)
  }));
  requireThat(equal(postState.postconditions, expected));
  return expected.every((v) => v.status === "PASSED");
}

function classifyRunner(request, graph, base, result, observed, consumption, posts) {
  const baseline = graph.get(request.baselineManifestDigest, ["baseline"]),
    target = graph.get(request.targetObservationDigest, ["observation"]);
  requireThat(
    request.domainInput.baselineManifestIdentityDigest === sha256Canonical(baseline.identity)
  );
  same(request, baseline.identity, [
    "buildProofDigest",
    "purpose",
    "targetObservationDigest",
    "physicalIdentity"
  ]);
  same(request, target, ["physicalIdentity"]);
  requireThat(request.roleObservation.schemaObservationDigest === sha256Canonical(target.catalog));
  const process = processChain(request, graph);
  let original = null,
    originalRequest = null,
    plan = null,
    originalAssessment = null;
  const predecessorDigest = request.dryRunRecordDigest ?? request.predecessorExecutionRecordDigest;
  if (predecessorDigest) {
    original = graph.get(predecessorDigest, ["execution"]);
    originalRequest = graph.get(original.requestDigest, ["request"]);
    requireThat(
      originalRequest.stage === "runner-command" && originalRequest.attemptId !== request.attemptId
    );
    same(request, originalRequest, [
      "profileDigest",
      "purpose",
      "buildProofDigest",
      "baselineManifestDigest",
      "physicalIdentity"
    ]);
    if (request.phase !== "verify")
      same(request, originalRequest, ["operationId", "idempotencyKey"]);
    if (request.phase === "apply") {
      requireThat(originalRequest.phase === "dry-run" && original.status === "SUCCEEDED");
      same(request, originalRequest, ["sessionId", "sessionNonce", "domainInput"]);
      originalAssessment = classify(originalRequest, graph);
      requireThat(originalAssessment.executionStatus === "SUCCEEDED");
      plan = graph.get(original.resultDigest, ["manual-command-result"]).plan;
      requireThat(request.approvedPlanDigest === deterministicPlanDigest(plan));
    } else if (["replay", "reconcile"].includes(request.phase)) {
      requireThat(originalRequest.phase === "apply");
      requireThat(
        original.status === (request.phase === "replay" ? "SUCCEEDED" : "INTERRUPTED_UNKNOWN")
      );
      const dry = graph.get(originalRequest.dryRunRecordDigest, ["execution"]);
      plan = graph.get(dry.resultDigest, ["manual-command-result"]).plan;
      requireThat(
        plan !== null && originalRequest.approvedPlanDigest === deterministicPlanDigest(plan)
      );
      // Recovery reads the original approved plan; only the capability-derived
      // connection fingerprint is independently checked against the current role.
      same(request.domainInput, plan.identity, [
        "baselineManifestIdentityDigest",
        "baselineManifestDigest",
        "expectedSchemaDigest",
        "expectedOwner",
        "allowedExtensions"
      ]);
      if (request.phase === "replay") {
        originalAssessment = classify(originalRequest, graph);
        requireThat(
          originalAssessment.executionStatus === "SUCCEEDED" &&
            originalAssessment.originalDatabaseOutcome === "committed"
        );
        const custody = graph
          .list("custody")
          .filter((c) => c.subjectDigest === predecessorDigest && c.outcome === "MATCH");
        requireThat(
          ["archive-readback", "backup-readback"].every((p) =>
            custody.some((c) => c.purpose === p)
          ),
          REQUIRED
        );
        base.originalDatabaseOutcome = "committed";
      }
      if (result) requireThat(result.originalExecutionRecordDigest === predecessorDigest);
    } else requireThat(originalRequest.phase === "apply" && original.status === "SUCCEEDED");
  }
  if (plan) base.planDigest = deterministicPlanDigest(plan);
  try {
    protocolArchive(request, graph);
  } catch (error) {
    if ([FRAME, ORDER, INCOMPLETE, OUTPUT, REUSED].includes(error.code))
      return Object.freeze({ ...base, reasonCode: error.code });
    throw error;
  }
  if (!result || !process || consumption.length !== 1) return Object.freeze(base);
  const handoffs = graph
    .list("consumption-handoff")
    .filter((h) => h.requestDigest === sha256Canonical(request));
  requireThat(handoffs.length <= 1);
  const handoff = handoffs[0],
    readbacks = handoff
      ? graph
          .list("custody")
          .filter(
            (c) =>
              c.subjectDigest === sha256Canonical(handoff) &&
              c.purpose === "handoff-readback" &&
              c.outcome === "MATCH"
          )
      : [];
  if (!handoff || readbacks.length === 0) return Object.freeze(base);
  for (const event of process.final.events.filter((e) => e.tool !== "runner"))
    requireThat(
      readbacks.some((c) => instant(c.recordedAt) <= instant(event.at)),
      "MANUAL_TIME_INVALID"
    );
  if (result.outcome === "THREW" && observed === null && request.phase !== "apply") {
    requireThat(process.chain.some((p) => sha256Canonical(p) === result.processEvidenceDigest));
    requireThat(
      instant(handoff.issuedAt) <= instant(result.finishedAt) &&
        instant(result.finishedAt) <= instant(process.final.closedAt),
      "MANUAL_TIME_INVALID"
    );
    requireThat(process.final.events.every((e) => e.tool !== "prisma-deploy"));
    return Object.freeze({
      ...base,
      executionStatus: "FAILED",
      originalDatabaseOutcome:
        request.phase === "replay"
          ? "committed"
          : request.phase === "reconcile"
            ? "unknown"
            : "not-applicable",
      reasonCode: result.reasonCode
    });
  }
  if (!observed) return Object.freeze(base);
  requireThat(
    instant(handoff.issuedAt) <= instant(result.startedAt) &&
      instant(result.startedAt) <= instant(observed.observedAt) &&
      instant(observed.observedAt) <= instant(result.finishedAt),
    "MANUAL_TIME_INVALID"
  );
  const tools = toolsFor(request, graph, process, observed, result),
    catalog = catalogFor(request, graph);
  const deploys = process.final.events.filter(
    (e) => e.tool === "prisma-deploy" && e.event === "PREPARED"
  );
  if (request.phase !== "apply") requireThat(deploys.length === 0);
  if (result.outcome !== "RETURNED") {
    if (
      ["verify", "reconcile", "replay", "dry-run"].includes(request.phase) &&
      result.outcome === "THREW" &&
      process.final.closedAt !== null
    )
      return Object.freeze({ ...base, executionStatus: "FAILED", reasonCode: result.reasonCode });
    return Object.freeze(base);
  }
  const postStored = posts.some((p) => p.observationDigest === result.observationDigest);
  if (!tools || (request.phase !== "apply" && !postStored)) return Object.freeze(base);
  if (request.phase === "dry-run") {
    if (
      !projectedRows(catalog, observed) ||
      observed.schema !== null ||
      observed.catalog.schemaOwner !== request.domainInput.expectedOwner
    )
      return Object.freeze(base);
    const expectation = graph.get(request.expectedSchemaEvidenceDigest, ["schema-expectation"]);
    requireThat(
      expectation.buildProofDigest === request.buildProofDigest &&
        expectation.script.digest === request.domainInput.expectedSchemaDigest &&
        expectation.prismaVersion === tools.versions.prisma
    );
    requireThat(
      result.plan !== null &&
        equal(result.plan, planFor(request, observed, catalog, tools.versions))
    );
    return Object.freeze({
      ...base,
      executionStatus: "SUCCEEDED",
      originalDatabaseOutcome: "not-applicable",
      reasonCode: null,
      planDigest: deterministicPlanDigest(result.plan)
    });
  }
  const schemaOk = schemaPassed(request, graph, observed, result, tools, catalog);
  if (request.phase === "verify" || request.phase === "replay") {
    if (schemaOk)
      return Object.freeze({
        ...base,
        executionStatus: "SUCCEEDED",
        originalDatabaseOutcome: request.phase === "replay" ? "committed" : "not-applicable",
        reasonCode: null
      });
    return Object.freeze(base);
  }
  if (request.phase === "apply") {
    const deploy = tools.tool("prisma-deploy");
    if (
      schemaOk &&
      plan &&
      plan.identity.pendingMigrations.length > 0 &&
      deploys.length === 1 &&
      deploy &&
      deploy.exitCode === 0 &&
      postStatePassed(request, observed, plan, result.postState)
    ) {
      const previousObservation = graph.get(
        graph.get(original.resultDigest, ["manual-command-result"]).observationDigest,
        ["observation"]
      );
      requireThat(
        equal(
          observed.catalog.migrationRows.slice(0, previousObservation.catalog.migrationRows.length),
          previousObservation.catalog.migrationRows
        )
      );
      const pendingRows = observed.catalog.migrationRows.slice(
        previousObservation.catalog.migrationRows.length
      );
      requireThat(
        pendingRows.every(
          (row) =>
            instant(row.startedAt) >= instant(deploys[0].at) &&
            instant(row.finishedAt) <= instant(deploy.at)
        ),
        "MANUAL_TIME_INVALID"
      );
      if (!postStored) return Object.freeze({ ...base, originalDatabaseOutcome: "committed" });
      return Object.freeze({
        ...base,
        executionStatus: "SUCCEEDED",
        originalDatabaseOutcome: "committed",
        reasonCode: null
      });
    }
    return Object.freeze(base);
  }
  if (request.phase === "reconcile") {
    requireThat(original && originalRequest && plan, REQUIRED);
    const dryExecution = graph.get(originalRequest.dryRunRecordDigest, ["execution"]);
    const dryRequest = graph.get(dryExecution.requestDigest, ["request"]);
    requireThat(dryRequest.phase === "dry-run" && dryExecution.status === "SUCCEEDED");
    same(originalRequest, dryRequest, [
      "profileDigest",
      "sessionId",
      "sessionNonce",
      "operationId",
      "idempotencyKey",
      "domainInput",
      "buildProofDigest",
      "baselineManifestDigest",
      "physicalIdentity"
    ]);
    requireThat(classify(dryRequest, graph).executionStatus === "SUCCEEDED");
    const dryResult = graph.get(dryExecution.resultDigest, ["manual-command-result"]),
      dryObservation = graph.get(dryResult.observationDigest, ["observation"]);
    requireThat(
      equal(plan, dryResult.plan) &&
        originalRequest.approvedPlanDigest === deterministicPlanDigest(plan)
    );
    const originalProcesses = processChain(originalRequest, graph);
    if (
      !originalProcesses ||
      originalProcesses.final.closedAt === null ||
      !original.processEvidenceDigest ||
      original.processEvidenceDigest !== sha256Canonical(originalProcesses.final)
    )
      return Object.freeze({ ...base, reasonCode: "MANUAL_COMMIT_ATTRIBUTION_UNAVAILABLE" });
    try {
      closedProtocolStdout(originalProcesses.final, graph);
    } catch (error) {
      if ([ORDER, INCOMPLETE].includes(error.code))
        return Object.freeze({ ...base, reasonCode: error.code });
      throw error;
    }
    const originalConsumption = graph
      .list("consumption")
      .filter((c) => c.requestDigest === original.requestDigest);
    requireThat(
      originalConsumption.length === 1 &&
        original.consumptionRecordDigest === sha256Canonical(originalConsumption[0]),
      REQUIRED
    );
    const events = originalProcesses.final.events;
    const originalDeploy = events.filter(
      (e) => e.tool === "prisma-deploy" && e.event === "PREPARED"
    );
    const endedDeploy = events.filter((e) => e.tool === "prisma-deploy" && e.event === "CLOSED");
    const oldPrefix = dryObservation.catalog.migrationRows;
    const unchangedPrefix = equal(
      observed.catalog.migrationRows.slice(0, oldPrefix.length),
      oldPrefix
    );
    if (
      schemaOk &&
      plan.identity.pendingMigrations.length > 0 &&
      originalDeploy.length === 1 &&
      endedDeploy.length === 1 &&
      unchangedPrefix
    ) {
      const rows = observed.catalog.migrationRows.slice(oldPrefix.length);
      if (
        rows.length === plan.identity.pendingMigrations.length &&
        rows.every(
          (r, i) =>
            r.migrationName === plan.identity.pendingMigrations[i].path.split("/").at(-2) &&
            r.checksum === plan.identity.pendingMigrations[i].sha256 &&
            r.finishedAt !== null &&
            r.rolledBackAt === null &&
            instant(r.startedAt) >= instant(originalDeploy[0].at) &&
            instant(r.finishedAt) <= instant(endedDeploy[0].at)
        )
      ) {
        try {
          protocolArchive(originalRequest, graph, { allowMissingResult: true });
        } catch (error) {
          if ([FRAME, ORDER, INCOMPLETE, OUTPUT, REUSED].includes(error.code))
            return Object.freeze({ ...base, reasonCode: error.code });
          throw error;
        }
        return Object.freeze({
          ...base,
          executionStatus: "SUCCEEDED",
          originalDatabaseOutcome: "committed",
          reasonCode: null
        });
      }
    }
    const originalFrames = parseManualRunnerFrames({
      direction: "child-to-parent",
      bytes: graph.raw(originalProcesses.final.protocol.stdoutPrefix),
      ended: true
    }).frames;
    const refused = events.find(
      (e) => e.event === "DISPATCH_CLOSED" && e.source === "parent" && e.reasonCode !== null
    );
    const readbacks = graph
      .list("custody")
      .filter(
        (c) =>
          c.subjectDigest === original.consumptionRecordDigest &&
          c.purpose === "consumption-readback" &&
          c.outcome === "MATCH"
      );
    if (
      originalDeploy.length === 0 &&
      refused &&
      original.handoffRecordDigest === null &&
      original.handoffReadbackDigest === null &&
      originalProcesses.final.protocol.parentFrames.length === 0 &&
      originalFrames.every((f) => f.type === "CHALLENGE") &&
      readbacks.length > 0 &&
      equal(observed.catalog, dryObservation.catalog)
    ) {
      requireThat(
        instant(originalConsumption[0].recordedAt) <= instant(refused.at),
        "MANUAL_TIME_INVALID"
      );
      return Object.freeze({
        ...base,
        executionStatus: "SUCCEEDED",
        originalDatabaseOutcome: "not-committed",
        reasonCode: null
      });
    }
    return Object.freeze({ ...base, reasonCode: "MANUAL_COMMIT_ATTRIBUTION_UNAVAILABLE" });
  }
  return Object.freeze(base);
}
