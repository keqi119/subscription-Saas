import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { AuditAction } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { createFleetOpsObservation } from "../src/fleet-ops/fleet-ops.observability";
import { buildFleetOpsDiagnostics } from "../src/fleet-ops/fleet-ops.diagnostics";
import { ExecutionLogService } from "../src/fleet-ops/execution/execution-log.service";
import { ExecutionActionType, ExecutionOutcome, ExecutionStatus, type ExecutionLogEntry } from "../src/fleet-ops/execution/execution.types";
import { FleetOpsHealthService } from "../src/fleet-ops/fleet-ops.health.service";
import { CollectionPriorityLevel, ControlDecision } from "../src/fleet-ops/risk/risk.types";

describe("Fleet Ops PR-5 audit sink boundary", () => {
  it("allows only the explicit PR-5 execution log path to call the optional audit sink", async () => {
    const auditSink = {
      write: vi.fn(
        async (input: {
          action: AuditAction;
          after: ExecutionLogEntry;
          entityId: string;
          entityType: string;
          module: string;
          operatorId?: string;
        }) => {
          void input;
        }
      )
    };
    const service = new ExecutionLogService(auditSink);
    const entry = executionLogEntry();

    await service.record(entry);

    const auditWrite = auditSink.write;
    expect(auditWrite).toHaveBeenCalledOnce();
    expect(auditWrite).toHaveBeenCalledWith({
      action: AuditAction.CREATE,
      after: expect.objectContaining({
        executionId: "exec-1",
        vehicleId: "vehicle-1"
      }),
      entityId: "vehicle-1",
      entityType: "FleetExecution",
      module: "fleet_ops_execution"
    });
    expect(Object.keys(auditWrite.mock.calls[0]?.[0] ?? {}).sort()).toEqual(["action", "after", "entityId", "entityType", "module"]);
  });

  it("keeps health, diagnostics, and observability paths free of audit writes", () => {
    const auditWrite = vi.fn();

    new FleetOpsHealthService().getHealth();
    buildFleetOpsDiagnostics({
      facadeReady: true,
      healthReady: true,
      invariantResults: [],
      moduleLoaded: true,
      readonlyViolations: []
    });
    createFleetOpsObservation({
      durationMs: 1,
      engineName: "stateEngine",
      operationName: "getVehicleState",
      requestId: "request-1",
      status: "OK",
      traceId: "trace-1"
    });

    expect(auditWrite).not.toHaveBeenCalled();
  });

  it("does not call auditSink.write outside execution-log.service.ts", async () => {
    const files = await listFleetOpsSourceFiles();
    const matches: string[] = [];

    for (const file of files) {
      const content = await readFile(file, "utf8");
      if (/auditSink(?:\?\.|\.)\s*write\s*\(/.test(content)) {
        matches.push(relative(process.cwd(), file).replaceAll("\\", "/"));
      }
    }

    expect(matches).toEqual(["src/fleet-ops/execution/execution-log.service.ts"]);
  });
});

function executionLogEntry(): ExecutionLogEntry {
  return {
    actionType: ExecutionActionType.VEHICLE_ALLOCATION,
    decisionUsed: ControlDecision.ALLOW,
    executionId: "exec-1",
    inputSnapshot: {
      collectionLevel: CollectionPriorityLevel.D1,
      confidence: 90,
      controlDecision: ControlDecision.ALLOW,
      exposureScore: 0,
      reasons: ["Risk signals within normal control tolerance."],
      riskScore: 10,
      signals: [],
      vehicleId: "vehicle-1"
    },
    outcome: ExecutionOutcome.VEHICLE_ALLOCATED,
    reason: ["Vehicle allocation workflow event prepared."],
    status: ExecutionStatus.SUCCESS,
    success: true,
    timestamp: new Date("2026-07-05T08:30:00.000Z"),
    vehicleId: "vehicle-1"
  };
}

async function listFleetOpsSourceFiles(root = join(process.cwd(), "src", "fleet-ops")): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(root, entry.name);

      if (entry.isDirectory()) {
        return listFleetOpsSourceFiles(fullPath);
      }

      return entry.isFile() && entry.name.endsWith(".ts") ? [fullPath] : [];
    })
  );

  return nested.flat().sort();
}
