import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const schema = fs.readFileSync(path.resolve(__dirname, "../prisma/schema.prisma"), "utf8");
const labels = fs.readFileSync(path.resolve(__dirname, "../../web/src/constants/labels.ts"), "utf8");
const migrationPath = path.resolve(
  __dirname,
  "../prisma/migrations/20260808010000_vehicle_document_workspace/migration.sql"
);
const migration = fs.existsSync(migrationPath) ? fs.readFileSync(migrationPath, "utf8") : "";

describe("vehicle document workspace schema", () => {
  it.each([
    ["VEHICLE_REGISTRATION_CERTIFICATE", "机动车登记证"],
    ["VEHICLE_INSPECTION_REPORT", "车辆检测报告"],
    ["VEHICLE_PURCHASE_AGREEMENT", "车辆购买合同及附属协议"],
    ["MOTOR_VEHICLE_INVOICE", "机动车发票"],
    ["OWNER_IDENTITY_DOCUMENT", "车主信息"],
    ["VEHICLE_CONFIGURATION_SHEET", "车辆配置单"],
    ["PURCHASE_PAYMENT_VOUCHER", "车辆采购支付凭证"]
  ])("defines and labels %s", (value, label) => {
    expect(schema).toMatch(new RegExp(`enum VehicleDocumentType[\\s\\S]*\\b${value}\\b`));
    expect(labels).toContain(`${value}: "${label}"`);
  });

  it("models versioned document batches for a vehicle and document type", () => {
    expect(schema).toMatch(/model VehicleDocumentBatch[\s\S]*versionNo\s+Int\s+@map\("version_no"\)/);
    expect(schema).toMatch(/model VehicleDocumentBatch[\s\S]*@@unique\(\[vehicleId, documentType, versionNo\]\)/);
    expect(schema).toMatch(/model VehicleDocument[\s\S]*batchId\s+String\?/);
    expect(schema).toMatch(/model VehicleDocument[\s\S]*batch\s+VehicleDocumentBatch\?/);
  });

  it("models one exact source document binding per vehicle section", () => {
    expect(schema).toMatch(/enum VehicleListingSourceSection[\s\S]*CONFIGURATION_SHEET[\s\S]*CONDITION_REPORT/);
    expect(schema).toMatch(/model VehicleListingSourceBinding[\s\S]*documentId\s+String/);
    expect(schema).toMatch(/model VehicleListingSourceBinding[\s\S]*@@unique\(\[vehicleId, section\]\)/);
    expect(schema).toMatch(/model VehicleListingSourceBinding[\s\S]*@@index\(\[documentId\]\)/);
  });

  it("migrates tables and backfills each non-deleted legacy file into a deterministic batch", () => {
    expect(migration).toContain('CREATE TABLE "vehicle_document_batch"');
    expect(migration).toContain('CREATE TABLE "vehicle_listing_source_binding"');
    expect(migration).toMatch(
      /ROW_NUMBER\(\) OVER \(\s*PARTITION BY "vehicle_id", "document_type"\s*ORDER BY "created_at", "id"/m
    );
    expect(migration).toContain('UPDATE "vehicle_document"');
    expect(migration).toContain('SET "batch_id" = id');
    expect(migration).toContain('WHERE "batch_id" IS NULL AND "deleted_at" IS NULL');
  });
});
