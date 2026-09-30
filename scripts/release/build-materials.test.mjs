import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  provenanceMaterialMatchesBase,
  verifyBuildMaterials,
  verifyBuildWorkflow,
  verifyDockerfileBaseImages,
  verifyRunnerDependencyClosure
} from "./verify-build-materials.mjs";

const sourceSha = "1".repeat(40);
const digest = (character) => `sha256:${character.repeat(64)}`;
const actions = Object.freeze({
  "actions/attest": "1e69f48acb82d1966a394da916b4c1698aa569d6",
  "actions/checkout": "11d5960a326750d5838078e36cf38b85af677262",
  "actions/download-artifact": "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  "actions/upload-artifact": "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  "docker/build-push-action": "10e90e3645eae34f1e60eeb005ba3a3d33f178e8",
  "docker/login-action": "c94ce9fb468520275223c153574b00df6fe4bcc9",
  "docker/setup-buildx-action": "8d2750c68a42422c14e847fe6c8ac0403b4cbd6f"
});

function policy() {
  return {
    schemaVersion: "build-material-policy.v1",
    trustedBuild: {
      workflow: ".github/workflows/docker-images.yml",
      eventName: "workflow_dispatch",
      ref: "refs/heads/main",
      runAttempt: 1,
      platform: "linux/amd64",
      protectedEnvironment: "trusted-image-build"
    },
    requiredImages: ["api", "web", "runner"],
    externalActions: actions,
    baseImages: {
      "node:22-bookworm-slim": digest("a"),
      "postgres:17.11-bookworm": digest("b")
    },
    requiredBaseImagesByArtifact: {
      api: ["node:22-bookworm-slim"],
      web: ["node:22-bookworm-slim"],
      runner: ["node:22-bookworm-slim", "postgres:17.11-bookworm"]
    },
    requiredRunnerAssets: [
      "apps/api/prisma/migrations",
      "apps/api/prisma/schema.prisma",
      "apps/api/src/billing-automation/stage1-acceptance-forbidden-domains.json"
    ],
    requireRegistryDigest: true,
    requireBuildAttestation: true,
    requireBuilderProvenance: true
  };
}

function image(name, character, baseImages = ["node:22-bookworm-slim"]) {
  const imageDigest = digest(character);
  const repository = `ghcr.io/example/subscription-${name}`;
  return {
    name,
    image: repository,
    platform: "linux/amd64",
    digest: imageDigest,
    sourceRevision: sourceSha,
    baseImageDigests: baseImages.map((baseImage, index) => ({
      image: baseImage,
      declaredDigest: index === 0 && baseImage.startsWith("node:") ? digest("a") : digest("b"),
      digest: index === 0 && baseImage.startsWith("node:") ? digest("e") : digest("f")
    })),
    builderName: "https://mobyproject.org/buildkit@v1",
    buildAttestationRef: `oci://${repository}@${imageDigest}#provenance`,
    registrySubject: `${repository}@${imageDigest}`,
    buildRunRef: "github://example/subscription/actions/runs/27"
  };
}

function validInput() {
  return {
    policy: policy(),
    workflow: trustedWorkflow(),
    context: {
      eventName: "workflow_dispatch",
      ref: "refs/heads/main",
      runAttempt: 1,
      sourceSha,
      checkoutRef: sourceSha,
      ciRunRef: "github://example/subscription/actions/runs/27",
      protectedEnvironment: "trusted-image-build"
    },
    repositoryContractDigest: digest("c"),
    migrationCatalogDigest: digest("d"),
    images: [
      image("api", "1"),
      image("web", "2"),
      image("runner", "3", ["node:22-bookworm-slim", "postgres:17.11-bookworm"])
    ],
    externalActions: Object.entries(actions).map(([name, commitSha]) => ({ name, commitSha })),
    builder: {
      name: "https://mobyproject.org/buildkit@v1",
      provenanceRef: "oci://ghcr.io/example/build-run-27#builder"
    },
    observedAt: "2026-09-02T15:00:00.000Z"
  };
}

function trustedWorkflow() {
  const actionLines = Object.entries(actions)
    .map(([name, commitSha]) => `      - uses: ${name}@${commitSha}`)
    .join("\n");
  return `
on: workflow_dispatch
jobs:
  prepare:
    if: github.ref == 'refs/heads/main' && github.run_attempt == 1
    environment: trusted-image-build
    outputs:
      source-sha: \${{ steps.source.outputs.sha }}
${actionLines}
  build-api:
    needs: prepare
    steps:
      - uses: actions/checkout@${actions["actions/checkout"]}
        with:
          ref: \${{ needs.prepare.outputs.source-sha }}
      - uses: docker/build-push-action@${actions["docker/build-push-action"]}
        with:
          platforms: linux/amd64
          provenance: mode=max
          sbom: true
          build-args: API_SOURCE_REVISION=\${{ needs.prepare.outputs.source-sha }}
  build-web:
    needs: prepare
    steps:
      - uses: actions/checkout@${actions["actions/checkout"]}
        with:
          ref: \${{ needs.prepare.outputs.source-sha }}
      - uses: docker/build-push-action@${actions["docker/build-push-action"]}
        with:
          platforms: linux/amd64
          provenance: mode=max
          sbom: true
          build-args: WEB_SOURCE_REVISION=\${{ needs.prepare.outputs.source-sha }}
  build-runner:
    needs: prepare
    steps:
      - uses: actions/checkout@${actions["actions/checkout"]}
        with:
          ref: \${{ needs.prepare.outputs.source-sha }}
      - uses: docker/build-push-action@${actions["docker/build-push-action"]}
        with:
          platforms: linux/amd64
          provenance: mode=max
          sbom: true
          build-args: RUNNER_SOURCE_REVISION=\${{ needs.prepare.outputs.source-sha }}
  observe-build-materials:
    needs: [prepare, build-api, build-web, build-runner]
    environment: trusted-image-build
    steps:
      - run: echo '.Provenance.SLSA resolvedDependencies .materials declaredDigest'
`;
}

test("accepts exactly one trusted three-image build material observation", () => {
  const result = verifyBuildMaterials(validInput());
  assert.equal(result.schemaVersion, "build-material-observation.v1");
  assert.deepEqual(
    result.images.map(({ name }) => name),
    ["api", "runner", "web"]
  );
  assert.equal(result.promotionEligibility, "trusted-candidate");
});

test("retains the validated Web API address bound to its selected platform image", () => {
  const input = validInput();
  input.webClient = {
    imageDigest: input.images.find(({ name }) => name === "web").digest,
    apiBaseUrl: "https://api.example.com/api"
  };
  const result = verifyBuildMaterials(input);
  assert.deepEqual(result.webClient, input.webClient);
  assert.ok(Object.isFrozen(result.webClient));
  for (const change of [
    (v) => {
      v.imageDigest = input.images[0].digest;
    },
    (v) => {
      v.apiBaseUrl = "http://127.0.0.1:33001/api";
    },
    (v) => {
      v.apiBaseUrl = "https://api.example.com:443/api";
    },
    (v) => {
      v.apiBaseUrl = "https://user:password@api.example.com/api";
    },
    (v) => {
      v.apiBaseUrl = "https://api.example.com/api?x=1";
    },
    (v) => {
      v.apiBaseUrl = "https://api.example.com/api/";
    },
    (v) => {
      v.apiBaseUrl = " https://api.example.com/api";
    },
    (v) => {
      v.override = true;
    }
  ]) {
    const altered = structuredClone(input);
    change(altered.webClient);
    assert.throws(() => verifyBuildMaterials(altered), { code: "BUILD_WEB_CLIENT_INVALID" });
  }
});

test("BUILD_ACTION_UNPINNED rejects a mutable external action reference", () => {
  assert.throws(
    () =>
      verifyBuildWorkflow(trustedWorkflow().replace(actions["actions/checkout"], "v4"), policy()),
    { code: "BUILD_ACTION_UNPINNED" }
  );
});

test("BUILD_BASE_IMAGE_UNPROVEN rejects an absent base-image digest", () => {
  const input = validInput();
  input.images[0].baseImageDigests = [];
  assert.throws(() => verifyBuildMaterials(input), { code: "BUILD_BASE_IMAGE_UNPROVEN" });
});

test("BUILD_BASE_IMAGE_UNPROVEN rejects a declared base digest outside policy", () => {
  const input = validInput();
  input.images[0].baseImageDigests[0].declaredDigest = digest("9");
  assert.throws(() => verifyBuildMaterials(input), { code: "BUILD_BASE_IMAGE_UNPROVEN" });
});

test("BUILD_BASE_IMAGE_UNPROVEN rejects an unpinned Docker base image", () => {
  assert.throws(
    () =>
      verifyDockerfileBaseImages({
        policy: policy(),
        dockerfiles: { api: "FROM node:22-bookworm-slim AS runtime" }
      }),
    { code: "BUILD_BASE_IMAGE_UNPROVEN" }
  );
});

test("matches BuildKit provenance that records the declared base index digest", () => {
  assert.equal(
    provenanceMaterialMatchesBase({
      material: {
        uri: `pkg:docker/node@22-bookworm-slim?digest=${digest("a")}&platform=linux%2Famd64`,
        digest: { sha256: digest("a").replace(/^sha256:/u, "") }
      },
      baseImage: "node:22-bookworm-slim",
      declaredDigest: digest("a"),
      resolvedDigest: digest("e")
    }),
    true
  );
});

test("rejects BuildKit provenance for another base repository or digest", () => {
  assert.equal(
    provenanceMaterialMatchesBase({
      material: {
        uri: `pkg:docker/postgres@17.11-bookworm?digest=${digest("9")}&platform=linux%2Famd64`,
        digest: { sha256: digest("9").replace(/^sha256:/u, "") }
      },
      baseImage: "node:22-bookworm-slim",
      declaredDigest: digest("a"),
      resolvedDigest: digest("e")
    }),
    false
  );
});

test("Runner copies exactly the registered governance dependency closure", () => {
  const result = verifyRunnerDependencyClosure({
    dockerfile: `
FROM postgres:17@sha256:${"a".repeat(64)} AS runtime
COPY scripts/a.mjs \\
  scripts/b.mjs \\
  ./scripts/
`,
    inventory: {
      files: [
        { repositorySource: "scripts/a.mjs", disposition: "runner-only" },
        { repositorySource: "scripts/b.mjs", disposition: "runner-only" }
      ]
    }
  });
  assert.deepEqual(result.files, ["scripts/a.mjs", "scripts/b.mjs"]);
});

test("RUNNER_DEPENDENCY_COPY_TOO_BROAD rejects copying the scripts directory", () => {
  assert.throws(
    () =>
      verifyRunnerDependencyClosure({
        dockerfile: "COPY scripts ./scripts",
        inventory: {
          files: [{ repositorySource: "scripts/a.mjs", disposition: "runner-only" }]
        }
      }),
    { code: "RUNNER_DEPENDENCY_COPY_TOO_BROAD" }
  );
});

function runtimeLayoutFixture() {
  const readJson = (file) =>
    JSON.parse(readFileSync(new URL(`../../${file}`, import.meta.url), "utf8"));
  const actualPolicy = readJson("release/contracts/build-material-policy.v1.json");
  return {
    dockerfile: readFileSync(new URL("../../Dockerfile.runner", import.meta.url), "utf8"),
    inventory: readJson("release/contracts/api-runtime-governance-inventory.v1.json"),
    requiredAssets: actualPolicy.requiredRunnerAssets,
    runtimeCopies: actualPolicy.runnerRuntimeCopies,
    databaseTestManifest: readJson("release/contracts/database-test-manifest.v1.json")
  };
}

test("current Runner layout covers governance, migrations and every database suite and fixture", () => {
  const f = runtimeLayoutFixture();
  const result = verifyRunnerDependencyClosure(f);
  assert.deepEqual(result.runtimeCopies, f.runtimeCopies);
  assert.deepEqual(result.requiredAssets, f.requiredAssets);
  for (const suite of f.databaseTestManifest.suites) {
    for (const file of [...suite.files, ...Object.values(suite.fixtures ?? {})]) {
      assert.ok(result.manifestFiles.includes(file));
    }
  }
  assert.equal(result.manifestFiles.length, new Set(result.manifestFiles).size);
});

test("runtime layout rejects extra content, retargeted or absent copies and uncovered tests", () => {
  for (const mutate of [
    (f) => {
      f.dockerfile += "\nCOPY . /app\n";
    },
    (f) => {
      f.dockerfile += "\nADD injected.tar /app\n";
    },
    (f) => {
      f.dockerfile += "\nFROM node:22 AS other\n";
    },
    (f) => {
      f.dockerfile = f.dockerfile.replace("COPY scripts ./scripts", "COPY scripts ./wrong");
    },
    (f) => {
      f.dockerfile = f.dockerfile.replace("COPY release ./release", "");
    },
    (f) => {
      f.runtimeCopies = [];
    },
    (f) => {
      f.requiredAssets.push("not-copied/required.json");
    },
    (f) => {
      f.databaseTestManifest.suites[0].files = ["not-copied/test.mjs"];
    },
    (f) => {
      f.dockerfile += "\nCOPY . /app\n";
      f.runtimeCopies.push("COPY . /app");
    },
    (f) => {
      f.dockerfile = f.dockerfile.replace(
        "COPY --from=deps /pnpm /pnpm",
        "COPY --from=foreign /pnpm /pnpm"
      );
      f.runtimeCopies[1] = "COPY --from=foreign /pnpm /pnpm";
    }
  ]) {
    const f = runtimeLayoutFixture();
    mutate(f);
    assert.throws(() => verifyRunnerDependencyClosure(f), /RUNNER_/u);
  }
});

test("RUNNER_DEPENDENCY_CLOSURE_MISMATCH rejects a missing registered dependency", () => {
  assert.throws(
    () =>
      verifyRunnerDependencyClosure({
        dockerfile: "COPY scripts/a.mjs ./scripts/",
        inventory: {
          files: [
            { repositorySource: "scripts/a.mjs", disposition: "runner-only" },
            { repositorySource: "scripts/b.mjs", disposition: "runner-only" }
          ]
        }
      }),
    { code: "RUNNER_DEPENDENCY_CLOSURE_MISMATCH" }
  );
});

test("RUNNER_REQUIRED_ASSET_MISSING rejects a Runner without migration inputs", () => {
  assert.throws(
    () =>
      verifyRunnerDependencyClosure({
        dockerfile: "COPY scripts/a.mjs ./scripts/",
        inventory: {
          files: [{ repositorySource: "scripts/a.mjs", disposition: "runner-only" }]
        },
        requiredAssets: ["apps/api/prisma/migrations"]
      }),
    { code: "RUNNER_REQUIRED_ASSET_MISSING" }
  );
});

test("BUILD_SOURCE_REVISION_MISMATCH rejects mixed image revisions", () => {
  const input = validInput();
  input.images[1].sourceRevision = "2".repeat(40);
  assert.throws(() => verifyBuildMaterials(input), { code: "BUILD_SOURCE_REVISION_MISMATCH" });
});

test("BUILD_BUILDER_PROVENANCE_REQUIRED rejects mixed attested builders", () => {
  const input = validInput();
  input.images[1].builderName = "untrusted-builder";
  assert.throws(() => verifyBuildMaterials(input), {
    code: "BUILD_BUILDER_PROVENANCE_REQUIRED"
  });
});

test("BUILD_REGISTRY_DIGEST_REQUIRED rejects tag identity", () => {
  const input = validInput();
  input.images[0].registrySubject = `${input.images[0].image}:candidate`;
  assert.throws(() => verifyBuildMaterials(input), { code: "BUILD_REGISTRY_DIGEST_REQUIRED" });
});

test("PR_ARTIFACT_NOT_PROMOTABLE rejects a PR build context", () => {
  const input = validInput();
  input.context.eventName = "pull_request";
  assert.throws(() => verifyBuildMaterials(input), { code: "PR_ARTIFACT_NOT_PROMOTABLE" });
});

test("rejects a checkout identity different from the protected source SHA", () => {
  const input = validInput();
  input.context.checkoutRef = "2".repeat(40);
  assert.throws(() => verifyBuildMaterials(input), { code: "BUILD_CHECKOUT_REF_MISMATCH" });
});

test("rejects a workflow that lets an image job choose its own source", () => {
  const workflow = trustedWorkflow().replace(
    "ref: ${{ needs.prepare.outputs.source-sha }}",
    "ref: ${{ inputs.sourceRef }}"
  );
  assert.throws(() => verifyBuildWorkflow(workflow, policy()), {
    code: "BUILD_IMAGE_SOURCE_NOT_FIXED"
  });
});
