import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Writable } from "node:stream";
import test from "node:test";

const executor = await import("./stage1c-access-baseline-executor.mjs").catch(() => ({}));
const cli = await import("./stage1c-access-baseline.mjs").catch(() => ({}));
const seed = await import("../apps/api/prisma/seed-stage1c-baseline.mjs").catch(() => ({}));

function requiredExport(module, name) {
  assert.equal(typeof module[name], "function", `${name} must be exported`);
  return module[name];
}

test("dry-run reports planned convergence and performs zero writes", async () => {
  let applyCalls = 0;
  const result = await requiredExport(
    executor,
    "executeStage1cAccessBaseline"
  )({
    apply: async () => {
      applyCalls += 1;
      throw new Error("dry-run must not apply");
    },
    classify: () => cleanClassification(),
    generatedAt: "2026-08-20T00:00:00.000Z",
    loadSnapshot: async () => emptySnapshot(),
    mode: "dry-run",
    prisma: transactionHarness()
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.report.mode, "dry-run");
  assert.equal(result.report.applied, null);
  assert.equal(applyCalls, 0);
});

test("apply refuses blockers before writes", async () => {
  let applyCalls = 0;
  const result = await requiredExport(
    executor,
    "executeStage1cAccessBaseline"
  )({
    apply: async () => {
      applyCalls += 1;
    },
    classify: () => cleanClassification({ blockers: [{ code: "ROLE_MISSING", roleCode: "RC" }] }),
    loadSnapshot: async () => emptySnapshot(),
    mode: "apply",
    prisma: transactionHarness()
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.report.safeToApply, false);
  assert.equal(applyCalls, 0);
});

test("apply verifies replay, preserves ownership-period count, and rolls back on audit failure", async () => {
  const persisted = { audit: 0, grants: 0, ownershipPeriods: 11 };
  const prisma = transactionHarness(persisted);

  await assert.rejects(
    requiredExport(
      executor,
      "executeStage1cAccessBaseline"
    )({
      apply: async (tx) => {
        tx.state.grants += 3;
        throw new Error("INJECTED_AUDIT_FAILURE");
      },
      classify: () => cleanClassification(),
      loadSnapshot: async (tx) => ({
        ...emptySnapshot(),
        ownershipPeriodCount: tx.state.ownershipPeriods
      }),
      mode: "apply",
      prisma
    }),
    /INJECTED_AUDIT_FAILURE/
  );

  assert.deepEqual(persisted, { audit: 0, grants: 0, ownershipPeriods: 11 });
});

test("apply uses the production writer, verifies exact replay, and preserves result compatibility with ownerChanged zero", async () => {
  const calls = [];
  let pass = 0;
  const result = await requiredExport(
    executor,
    "executeStage1cAccessBaseline"
  )({
    apply: async (tx, classification) => {
      calls.push(["apply", tx, classification]);
      return { auditsCreated: 1, grantsChanged: 2, ownerChanged: 0, permissionsChanged: 3 };
    },
    classify: () => {
      pass += 1;
      return cleanClassification();
    },
    loadSnapshot: async () => emptySnapshot(),
    mode: "apply",
    prisma: transactionHarness()
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.report.applied, {
    auditsCreated: 1,
    grantsChanged: 2,
    ownerChanged: 0,
    permissionsChanged: 3
  });
  assert.equal(calls.length, 1);
});

test("apply confirmation accepts only the exact dedicated value", () => {
  const assertConfirmation = requiredExport(cli, "assertStage1cAccessBaselineApplyConfirmation");

  assert.doesNotThrow(() => assertConfirmation("dry-run", {}));
  assert.doesNotThrow(() =>
    assertConfirmation("apply", { STAGE1C_ACCESS_BASELINE_APPLY: "SYNC_STAGE1C_ACCESS_BASELINE" })
  );
  for (const value of [
    undefined,
    "",
    "1",
    "true",
    "sync_stage1c_access_baseline",
    " SYNC_STAGE1C_ACCESS_BASELINE "
  ]) {
    assert.throws(
      () => assertConfirmation("apply", { STAGE1C_ACCESS_BASELINE_APPLY: value }),
      /STAGE1C_ACCESS_BASELINE_APPLY_CONFIRMATION_REQUIRED/
    );
  }
});

test("access CLI parsing keeps one optional output and rejects unusable path values", () => {
  const parse = requiredExport(cli, "parseStage1cAccessBaselineArgs");

  assert.deepEqual(parse(["--dry-run"]), { mode: "dry-run", output: null });
  assert.deepEqual(parse(["--apply", "--output", "reports/access.json"]), {
    mode: "apply",
    output: "reports/access.json"
  });
  assert.deepEqual(parse(["--dry-run", "--output=reports/access.json"]), {
    mode: "dry-run",
    output: "reports/access.json"
  });

  for (const args of [
    ["--dry-run", "--output"],
    ["--dry-run", "--output", ""],
    ["--dry-run", "--output", "   "],
    ["--dry-run", "--output", "--apply"],
    ["--dry-run", "--output="],
    ["--dry-run", "--output=\t"],
    ["--dry-run", "--output=--apply"],
    ["--dry-run", "--output", "a.json", "--output=b.json"]
  ]) {
    assert.throws(
      () => parse(args),
      /STAGE1C_ACCESS_BASELINE_OUTPUT_INVALID/,
      `expected ${JSON.stringify(args)} to reject an invalid output path`
    );
  }
});

test("process rejects a flag-shaped access output before database or report side effects", async () => {
  const stderr = [];
  let createPrismaCalls = 0;
  let executeCalls = 0;
  let stdoutWrites = 0;
  let outputWrites = 0;

  const exitCode = await requiredExport(
    cli,
    "runStage1cAccessBaselineProcess"
  )({
    disconnect: async () => {},
    run: () =>
      requiredExport(
        cli,
        "runStage1cAccessBaselineCli"
      )({
        args: ["--dry-run", "--output", "--apply"],
        createPrisma: async () => {
          createPrismaCalls += 1;
          return { marker: "must-not-connect" };
        },
        env: {},
        execute: async () => {
          executeCalls += 1;
          return { exitCode: 0, report: { safeToApply: true } };
        },
        writeOutput: async () => {
          outputWrites += 1;
        },
        writeStdout: async () => {
          stdoutWrites += 1;
        }
      }),
    writeStderr: (contents) => stderr.push(contents)
  });

  assert.equal(exitCode, 1);
  assert.equal(createPrismaCalls, 0);
  assert.equal(executeCalls, 0);
  assert.equal(stdoutWrites, 0);
  assert.equal(outputWrites, 0);
  assert.deepEqual(stderr, ['{"error":"STAGE1C_ACCESS_BASELINE_FAILED"}\n']);
});

test("process errors and disconnect errors are redacted and nonzero", async () => {
  const errors = [];
  const runProcess = requiredExport(cli, "runStage1cAccessBaselineProcess");
  const secret = "postgresql://secret-user:secret-password@db/internal";

  const exitCode = await runProcess({
    disconnect: async () => {
      throw new Error(`disconnect ${secret}`);
    },
    run: async () => {
      throw new Error(`failure ${secret}`);
    },
    writeStderr: (value) => errors.push(value)
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(errors, ['{"error":"STAGE1C_ACCESS_BASELINE_FAILED"}\n']);
  assert.equal(errors.join("").includes(secret), false);
});

test("stdout stream failures reject so the redacted process wrapper can return nonzero", async () => {
  const writeStdout = requiredExport(cli, "writeStage1cAccessBaselineStdout");
  const stdout = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error("INJECTED_STDOUT_FAILURE"));
    }
  });

  await assert.rejects(writeStdout("report\n", stdout), /INJECTED_STDOUT_FAILURE/);
});

test("generic disposable-local seed hook executes permission-only convergence and exact replay", async () => {
  const state = databaseState();
  state.permissions.find(({ code }) => code === "asset_facts:view").status = "INACTIVE";
  state.rolePermissions.push(
    grantRow("ADMIN", "asset_facts:view", "2026-08-01"),
    grantRow("SA", "asset_facts:view"),
    grantRow("FI", "unrelated:keep")
  );
  const originalOwnershipPeriods = structuredClone(state.ownershipPeriods);
  const prisma = inMemoryPrisma(state);
  const synchronize = requiredExport(seed, "synchronizeStage1cBaselineForDemoSeed");

  const first = await synchronize({ prisma });
  const auditCountAfterFirst = state.auditLogs.length;
  const replay = await synchronize({ prisma });

  assert.equal(first.exitCode, 0);
  assert.equal(first.report.applied.ownerChanged, 0);
  assert.equal(replay.exitCode, 0);
  assert.deepEqual(replay.report.applied, {
    auditsCreated: 0,
    grantsChanged: 0,
    ownerChanged: 0,
    permissionsChanged: 0
  });
  assert.equal(state.auditLogs.length, auditCountAfterFirst);
  assert.deepEqual(activeStage1cMatrix(state), expectedMatrix());
  assert.equal(
    state.rolePermissions.find(
      ({ permissionCode, roleCode }) => roleCode === "FI" && permissionCode === "unrelated:keep"
    ).deletedAt,
    null
  );
  assert.deepEqual(state.assetOwners, []);
  assert.deepEqual(state.ownershipPeriods, originalOwnershipPeriods);
});

test("generic seed entrypoint invokes the behavior-tested shared baseline hook", async () => {
  const source = await readFile(new URL("../apps/api/prisma/seed.mjs", import.meta.url), "utf8");

  assert.match(
    source,
    /import \{ synchronizeStage1cBaselineForDemoSeed \} from "\.\/seed-stage1c-baseline\.mjs";/
  );
  assert.match(source, /await synchronizeStage1cBaselineForDemoSeed\(\{ prisma \}\);/);
});

test("generic seed hook fails closed when shared convergence refuses the baseline", async () => {
  await assert.rejects(
    requiredExport(
      seed,
      "synchronizeStage1cBaselineForDemoSeed"
    )({
      execute: async () => ({
        exitCode: 1,
        report: { blockers: [{ code: "PLATFORM_OWNER_IDENTITY_DRIFT" }] }
      }),
      prisma: "seed-prisma"
    }),
    /STAGE1C_SEED_BASELINE_BLOCKED/
  );
});

test("real writer transaction rolls back permission, grant, and audit changes together", async () => {
  const state = databaseState();
  const before = structuredClone(state);
  const prisma = inMemoryPrisma(state, { failAudit: true });

  await assert.rejects(
    requiredExport(executor, "executeStage1cAccessBaseline")({ mode: "apply", prisma }),
    /INJECTED_AUDIT_FAILURE/
  );

  assert.deepEqual(state, before);
});

test("real executor refuses missing or inactive roles before any write", async () => {
  for (const mutate of [
    (state) =>
      state.roles.splice(
        state.roles.findIndex(({ code }) => code === "RC"),
        1
      ),
    (state) => {
      state.roles.find(({ code }) => code === "AS").status = "INACTIVE";
    }
  ]) {
    const state = databaseState();
    mutate(state);
    const before = structuredClone(state);
    const result = await requiredExport(
      executor,
      "executeStage1cAccessBaseline"
    )({
      mode: "apply",
      prisma: inMemoryPrisma(state)
    });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(state, before);
  }
});

function transactionHarness(persisted = {}) {
  return {
    async $transaction(work, options) {
      assert.deepEqual(options, {
        isolationLevel: "RepeatableRead",
        maxWait: 10_000,
        timeout: 120_000
      });
      const staged = structuredClone(persisted);
      const tx = {
        $executeRaw: async (query) => {
          const sql = String(query?.strings?.join(" ") ?? query ?? "");
          assert.equal(sql.includes("asset_owner"), false);
          return 0;
        },
        $queryRaw: async () => [{ locked: true }],
        assetOwner: new Proxy(
          {},
          {
            get() {
              throw new Error("assetOwner access is forbidden by Task 6 permission-only scope");
            }
          }
        ),
        state: staged,
        vehicleOwnershipPeriod: new Proxy(
          {},
          {
            get() {
              throw new Error("vehicleOwnershipPeriod writes are forbidden");
            }
          }
        )
      };
      const result = await work(tx);
      for (const key of Object.keys(persisted)) persisted[key] = staged[key];
      return result;
    }
  };
}

function emptySnapshot() {
  return {
    assetOwners: [],
    ownershipPeriodCount: 0,
    permissions: [],
    rolePermissions: [],
    roles: []
  };
}

function cleanClassification(overrides = {}) {
  return {
    blockers: [],
    ownershipPeriodCount: 0,
    permissions: [],
    platformOwner: { disposition: "NOT_MANAGED" },
    rolePermissions: [],
    ...overrides
  };
}

function databaseState() {
  const roleCodes = ["ADMIN", "AS", "OP", "FI", "GM", "SA", "RC", "CS"];
  return {
    assetOwners: [],
    auditLogs: [],
    ownershipPeriods: [{ id: "ownership-existing" }],
    permissions: [
      permissionRow("asset_facts:view", "查看车辆事实台账", "view"),
      permissionRow("asset_owner:manage", "管理车辆权属期间", "owner_manage"),
      permissionRow("vehicle_period:manage", "修复车辆订阅期间", "period_manage"),
      permissionRow("asset_operations:view", "查看资产运营工单与限制", "view", "asset_operations"),
      permissionRow(
        "asset_work_order:manage",
        "管理资产运营工单",
        "work_order_manage",
        "asset_operations"
      ),
      permissionRow(
        "vehicle_restriction:manage",
        "管理车辆运营限制",
        "restriction_manage",
        "asset_operations"
      ),
      permissionRow(
        "vehicle_restriction:release",
        "解除车辆运营限制",
        "restriction_release",
        "asset_operations"
      ),
      permissionRow(
        "vehicle_restriction:approve_release",
        "审批高风险车辆运营限制解除",
        "restriction_approve_release",
        "asset_operations"
      ),
      permissionRow("vehicle_cost_ledger:view", "查看车辆成本台账", "view", "vehicle_cost_ledger"),
      permissionRow(
        "vehicle_cost_ledger:confirm",
        "确认车辆成本台账",
        "confirm",
        "vehicle_cost_ledger"
      ),
      permissionRow(
        "vehicle_cost_ledger:reverse",
        "冲正车辆成本台账",
        "reverse",
        "vehicle_cost_ledger"
      ),
      permissionRow("business_exception:view", "查看业务例外审批", "view", "business_exception"),
      permissionRow(
        "business_exception:request",
        "发起业务例外审批",
        "request",
        "business_exception"
      ),
      permissionRow("business_exception:approve", "审批业务例外", "approve", "business_exception"),
      permissionRow("unrelated:keep", "不相关权限", "keep", "other")
    ],
    rolePermissions: [],
    roles: roleCodes.map((code) => ({
      code,
      deletedAt: null,
      id: `role-${code}`,
      status: "ACTIVE"
    }))
  };
}

function permissionRow(code, name, action, module = "asset_facts") {
  return {
    action,
    code,
    deletedAt: null,
    id: `permission-${code}`,
    module,
    name,
    status: "ACTIVE"
  };
}

function grantRow(roleCode, permissionCode, deletedAt = null) {
  return {
    deletedAt,
    id: `grant-${roleCode}-${permissionCode}`,
    permissionCode,
    permissionId: `permission-${permissionCode}`,
    roleCode,
    roleId: `role-${roleCode}`
  };
}

function inMemoryPrisma(persisted, { failAudit = false } = {}) {
  return {
    async $transaction(work) {
      const staged = structuredClone(persisted);
      const tx = inMemoryTransaction(staged, { failAudit });
      const result = await work(tx);
      for (const key of Object.keys(persisted)) persisted[key] = staged[key];
      return result;
    }
  };
}

function inMemoryTransaction(state, { failAudit }) {
  return {
    $executeRaw: async (query) => {
      const sql = String(query?.strings?.join(" ") ?? query ?? "");
      assert.equal(sql.includes("asset_owner"), false);
      return 0;
    },
    $queryRaw: async () => [{ locked: true }],
    assetOwner: new Proxy(
      {},
      {
        get() {
          throw new Error("assetOwner access is forbidden by Task 6 permission-only scope");
        }
      }
    ),
    auditLog: {
      async create({ data }) {
        if (failAudit) throw new Error("INJECTED_AUDIT_FAILURE");
        state.auditLogs.push({
          ...structuredClone(data),
          id: `audit-${state.auditLogs.length + 1}`
        });
      }
    },
    permission: {
      async findMany() {
        return structuredClone(state.permissions.filter(({ code }) => code !== "unrelated:keep"));
      },
      async upsert({ create, update, where }) {
        let row = state.permissions.find(({ code }) => code === where.code);
        if (row === undefined) {
          row = { ...create, deletedAt: null, id: `permission-${create.code}`, status: "ACTIVE" };
          state.permissions.push(row);
        } else {
          Object.assign(row, update);
        }
        return structuredClone(row);
      }
    },
    role: {
      async findMany() {
        return structuredClone(state.roles);
      }
    },
    rolePermission: {
      async findMany() {
        return structuredClone(
          state.rolePermissions
            .filter(({ permissionCode }) => permissionCode !== "unrelated:keep")
            .map((row) => ({
              deletedAt: row.deletedAt,
              id: row.id,
              permission: { code: row.permissionCode },
              permissionId: row.permissionId,
              role: { code: row.roleCode },
              roleId: row.roleId
            }))
        );
      },
      async updateMany({ data, where }) {
        for (const row of state.rolePermissions) {
          if (
            row.deletedAt === where.deletedAt &&
            row.permissionId === where.permissionId &&
            row.roleId === where.roleId
          ) {
            Object.assign(row, data);
          }
        }
      },
      async upsert({ create, update, where }) {
        const identity = where.roleId_permissionId;
        let row = state.rolePermissions.find(
          ({ permissionId, roleId }) =>
            permissionId === identity.permissionId && roleId === identity.roleId
        );
        if (row === undefined) {
          const roleCode = state.roles.find(({ id }) => id === create.roleId).code;
          const permissionCode = state.permissions.find(
            ({ id }) => id === create.permissionId
          ).code;
          row = grantRow(roleCode, permissionCode);
          state.rolePermissions.push(row);
        } else {
          Object.assign(row, update);
        }
        return structuredClone(row);
      }
    },
    vehicleOwnershipPeriod: {
      async count() {
        return state.ownershipPeriods.length;
      }
    }
  };
}

function activeStage1cMatrix(state) {
  const codes = new Set(
    state.permissions
      .filter(({ module }) =>
        ["asset_facts", "asset_operations", "business_exception", "vehicle_cost_ledger"].includes(
          module
        )
      )
      .map(({ code }) => code)
  );
  return Object.fromEntries(
    ["ADMIN", "AS", "CS", "FI", "GM", "OP", "RC", "SA"].map((roleCode) => [
      roleCode,
      state.rolePermissions
        .filter(
          (row) =>
            row.roleCode === roleCode && row.deletedAt === null && codes.has(row.permissionCode)
        )
        .map(({ permissionCode }) => permissionCode)
        .sort()
    ])
  );
}

function expectedMatrix() {
  return {
    ADMIN: [
      "asset_facts:view",
      "asset_operations:view",
      "asset_owner:manage",
      "asset_work_order:manage",
      "business_exception:approve",
      "business_exception:request",
      "business_exception:view",
      "vehicle_cost_ledger:confirm",
      "vehicle_cost_ledger:reverse",
      "vehicle_cost_ledger:view",
      "vehicle_period:manage",
      "vehicle_restriction:approve_release",
      "vehicle_restriction:manage",
      "vehicle_restriction:release"
    ],
    AS: [
      "asset_facts:view",
      "asset_operations:view",
      "asset_owner:manage",
      "asset_work_order:manage",
      "business_exception:request",
      "business_exception:view",
      "vehicle_cost_ledger:confirm",
      "vehicle_cost_ledger:view",
      "vehicle_period:manage",
      "vehicle_restriction:approve_release",
      "vehicle_restriction:manage",
      "vehicle_restriction:release"
    ],
    CS: [],
    FI: [
      "asset_facts:view",
      "asset_operations:view",
      "business_exception:request",
      "business_exception:view",
      "vehicle_cost_ledger:confirm",
      "vehicle_cost_ledger:reverse",
      "vehicle_cost_ledger:view"
    ],
    GM: [
      "asset_facts:view",
      "asset_operations:view",
      "business_exception:approve",
      "business_exception:view",
      "vehicle_cost_ledger:reverse",
      "vehicle_cost_ledger:view",
      "vehicle_restriction:approve_release"
    ],
    OP: [
      "asset_facts:view",
      "asset_operations:view",
      "asset_work_order:manage",
      "business_exception:request",
      "business_exception:view",
      "vehicle_cost_ledger:confirm",
      "vehicle_cost_ledger:view",
      "vehicle_period:manage",
      "vehicle_restriction:manage",
      "vehicle_restriction:release"
    ],
    RC: [
      "asset_operations:view",
      "business_exception:request",
      "business_exception:view",
      "vehicle_cost_ledger:view"
    ],
    SA: []
  };
}
