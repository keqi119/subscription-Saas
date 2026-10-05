// Concrete H1 dispatch reader: protected originals, live independent OSS GET,
// a newly signed current-head read and the existing durable checkpoint/verifier.
import { Buffer } from "node:buffer";
import { canonicalJson } from "../../packages/release-foundation/src/canonical-json.mjs";
import { sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { assertKernelFrame } from "../../packages/release-foundation/src/snapshot/environment-policy.mjs";
import { createDispatchEvidenceStorage } from "./dispatch-evidence-oss-storage.mjs";
import { createH1DispatchJournal } from "./snapshot-h1-dispatch-journal.mjs";
import {
  readAndSignH1CurrentRevocation,
  readH1SnapshotDispatchInputs
} from "./snapshot-h1-signing.mjs";

const CODE = "H1_DISPATCH_SOURCE_REJECTED";
const requireThat = (value) => {
  if (!value) throw Object.assign(new Error(CODE), { code: CODE });
};

export async function createInstalledH1DispatchVerification(...args) {
  requireThat(args.length === 0);
  const inputs = await readH1SnapshotDispatchInputs();
  const { authorization, state, expected, trustPolicy } = inputs;
  const packets = [authorization, state];
  const reader = await createDispatchEvidenceStorage({
    profile: "reader",
    originals: packets.map((packet) => ({
      originalBytes: Buffer.from(canonicalJson(packet.body))
    })),
    session: inputs.session
  });
  const evidenceSource = Object.freeze({
    ...trustPolicy.revocation.reader,
    async readRevocationHead(request) {
      const result = await readAndSignH1CurrentRevocation(request);
      // A concurrently committed newer head requires a fresh operation, never a
      // substitution with the old captured body or its custody records.
      requireThat(
        result.response.headDigest === sha256Canonical(state.body) &&
          canonicalJson(result.response.archive) === canonicalJson(state.archive)
      );
      return result;
    },
    async readExact(request) {
      assertKernelFrame(request, ["reference", "expectedDigest"], CODE);
      const packet = packets.find((item) => item.archive.reference === request.reference);
      requireThat(packet && request.expectedDigest === sha256Canonical(packet.body));
      const actual = await reader.readback({ exactKey: packet.archive.objectKey });
      const observed = packet.observation;
      requireThat(
        actual.object.version === observed.objectVersion &&
          actual.object.contentDigest === observed.contentDigest &&
          actual.object.contentSizeBytes === observed.contentSizeBytes &&
          actual.object.lastModified === observed.lastModified &&
          actual.bucket.worm.id === observed.worm.id &&
          actual.bucket.worm.retentionDays === observed.worm.retentionDays &&
          actual.object.retainUntil === observed.worm.retainUntil &&
          Date.parse(actual.readbackAt) >= Date.parse(observed.readbackAt)
      );
      return {
        originalBytes: actual.originalBytes,
        signature: packet.signature,
        receipt: packet.receipt,
        observation: packet.observation,
        observationSignature: packet.observationSignature
      };
    }
  });
  return Object.freeze({
    rootPolicy: inputs.rootPolicy,
    dispatchVerification: Object.freeze({
      authorization: authorization.body,
      signature: authorization.signature,
      expected,
      trustPolicy,
      evidenceSource,
      revocationJournal: createH1DispatchJournal(),
      clock: Object.freeze({ now: () => new Date().toISOString() })
    })
  });
}
