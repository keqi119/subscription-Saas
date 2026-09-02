import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCommandVersionEvolution,
  assertRegistryDependencyVerifierParity,
  assertRegistryHandlerParity,
  loadCommandRegistry,
  loadTargetPolicies
} from "../src/command-registry.mjs";

test("target policies may prohibit stricter environments but always prohibit production", async () => {
  const targetPolicies = await loadTargetPolicies();

  for (const policy of targetPolicies.policies) {
    assert.ok(policy.prohibitedEnvironments.includes("production"));
  }
  assert.deepEqual(targetPolicies.policies[0].prohibitedEnvironments, ["staging", "production"]);
});

test("JSON registry is the only policy declaration and has exact handler parity", async () => {
  const registry = await loadCommandRegistry();
  const handlers = new Map(
    registry.commands.map(({ commandId, commandVersion }) => [
      `${commandId}@${commandVersion}`,
      async () => ({})
    ])
  );
  assert.doesNotThrow(() => assertRegistryHandlerParity(registry, handlers));
  handlers.delete("release.verify@1");
  assert.throws(() => assertRegistryHandlerParity(registry, handlers), {
    code: "RUNNER_REGISTRY_HANDLER_DRIFT"
  });
  handlers.set("undeclared@1", async () => ({}));
  assert.throws(() => assertRegistryHandlerParity(registry, handlers), {
    code: "RUNNER_REGISTRY_HANDLER_DRIFT"
  });
});

test("published command semantics require a commandVersion increment", async () => {
  const previous = await loadCommandRegistry();
  const changed = structuredClone(previous);
  changed.commands[0].timeoutMs += 1;
  assert.throws(() => assertCommandVersionEvolution(previous, changed), {
    code: "RUNNER_COMMAND_VERSION_IMMUTABLE"
  });
  changed.commands[0].commandVersion = "2";
  assert.doesNotThrow(() => assertCommandVersionEvolution(previous, changed));
});

test("dependency contracts and pre-credential verifiers have exact parity", async () => {
  const registry = await loadCommandRegistry();
  const expected = new Map(
    registry.commands
      .filter(({ dependencyContract }) => dependencyContract)
      .map(({ commandId, commandVersion }) => [`${commandId}@${commandVersion}`, async () => ({})])
  );
  assert.doesNotThrow(() => assertRegistryDependencyVerifierParity(registry, expected));
  expected.clear();
  assert.throws(() => assertRegistryDependencyVerifierParity(registry, expected), {
    code: "RUNNER_REGISTRY_DEPENDENCY_VERIFIER_DRIFT"
  });
});
