import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";

const launcher = fileURLToPath(new URL("./launch-manual-stage1.mjs", import.meta.url));
const digest = (letter) => `sha256:${letter.repeat(64)}`;

async function candidateUseWith(options = {}) {
  // Run the production private entrypoint with only its external effects replaced.
  const source = await readFile(launcher, "utf8");
  const begin = source.indexOf(
    "  const consumeCandidateUse = async (matchingSourceEvidenceDigest) => {"
  );
  const end = source.indexOf("\n  const sourceSecret = async (record, profile) => {", begin);
  assert.ok(begin >= 0 && end > begin);
  let clock = 0;
  const events = [];
  const sessionId = "session";
  const executionDigest = digest("e");
  let requestDigest;
  let authorization;
  const boundary = {
    code: "TEST_STOP",
    candidateUseRecord: null,
    completionRecord: { executionRecordDigest: digest("c") },
    snapshotCompletionRecord: null,
    destinationRecord: { destinationDigest: digest("d") },
    fixed: { databaseTestManifest: {} },
    lease: { profile: { ownerId: "owner" } },
    input: { operationRef: "operation" },
    stopping: false,
    closed: false,
    sourceAbort: { signal: { aborted: false } },
    check: async () => {},
    sourceCheck: async () => {
      events.push("sourceCheck");
    },
    fail: (code) => {
      throw Object.assign(new Error(code), { code });
    },
    fieldsFrom: (value, keys) =>
      Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key]])),
    randomUUID: (() => {
      let n = 0;
      return () => `uuid-${++n}`;
    })(),
    sha256Canonical: () => digest("f"),
    encodeManualJson: (value) => Buffer.from(JSON.stringify(value)),
    validateContract: (schema) => assert.equal(schema, "manual-operation-record.v3"),
    recheckResources: async () => {
      events.push("recheck");
      if (options.failRecheck === events.filter((event) => event === "recheck").length)
        throw Object.assign(new Error("RESOURCE_RECHECK_FAILED"), {
          code: "RESOURCE_RECHECK_FAILED"
        });
      clock += options.recheckMs ?? 360000;
    },
    archive: {
      graph: async () =>
        new Map([
          [
            digest("o"),
            {
              value: {
                schemaVersion: "manual-operation-record.v3",
                kind: "session",
                sessionId,
                status: "OPEN"
              }
            }
          ]
        ]),
      put: async (value) => {
        if (value.kind === "attempt-allocation") {
          events.push("allocation");
          return digest("a");
        }
        events.push("request");
        requestDigest = digest("b");
        return requestDigest;
      },
      get: async () => ({
        value: {
          stage: "candidate-use",
          status: "INTERRUPTED_UNKNOWN",
          predecessorExecutionRecordDigest: digest("c"),
          requestDigest,
          authorizationDigest: digest("f"),
          sessionId,
          sessionNonce: "nonce"
        }
      })
    },
    session: {
      scope: {
        phase: "source",
        chain: "fresh",
        sourceSha: "source",
        targetPolicyDigest: digest("p"),
        creationSpecDigest: digest("s"),
        jobAdmissionDigest: digest("j"),
        buildProofDigest: digest("b")
      },
      profileDigest: digest("q"),
      sessionId,
      sessionNonce: "nonce",
      sign: async () => {
        events.push("sign");
        authorization = { issuedAt: clock, expiresAt: clock + 300000 };
        return authorization;
      },
      consume: async ({ authorization: candidate }) => {
        events.push("consume");
        assert.equal(candidate, authorization);
        if (options.failConsume)
          throw Object.assign(new Error("CONSUME_REJECTED"), { code: "CONSUME_REJECTED" });
        if (clock >= candidate.expiresAt)
          throw Object.assign(new Error("AUTH_EXPIRED"), { code: "AUTH_EXPIRED" });
        return { stage: "candidate-use", executionRecordDigest: executionDigest };
      },
      assertCandidateUse: async () => ({ executionRecordDigest: executionDigest })
    }
  };
  const consumeCandidateUse = vm.runInNewContext(
    `${source.slice(begin, end)}\nconsumeCandidateUse`,
    boundary
  );
  return {
    consumeCandidateUse,
    events,
    boundary,
    get clock() {
      return clock;
    }
  };
}

test("candidate-use signs after the costly resource recheck so its five-minute authorization is fresh", async () => {
  const fixture = await candidateUseWith({ recheckMs: 360000 });
  await fixture.consumeCandidateUse();
  assert.equal(fixture.events.filter((event) => event === "recheck").length, 2);
  assert.equal(fixture.events.filter((event) => event === "sign").length, 1);
  assert.equal(fixture.events.filter((event) => event === "consume").length, 1);
  assert.equal(fixture.events.at(-1), "sourceCheck");
});

test("candidate-use resource failure before signing creates no authorization or consumption", async () => {
  const fixture = await candidateUseWith({ failRecheck: 2 });
  await assert.rejects(fixture.consumeCandidateUse(), { code: "RESOURCE_RECHECK_FAILED" });
  assert.equal(fixture.events.filter((event) => event === "sign").length, 0);
  assert.equal(fixture.events.filter((event) => event === "consume").length, 0);
});

test("candidate-use consume rejection does not sign or consume again", async () => {
  const fixture = await candidateUseWith({ recheckMs: 0, failConsume: true });
  await assert.rejects(fixture.consumeCandidateUse(), { code: "CONSUME_REJECTED" });
  assert.equal(fixture.events.filter((event) => event === "sign").length, 1);
  assert.equal(fixture.events.filter((event) => event === "consume").length, 1);
  assert.ok(!fixture.events.includes("sourceCheck"));
});
