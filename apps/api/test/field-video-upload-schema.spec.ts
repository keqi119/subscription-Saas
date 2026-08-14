import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const schema = readFileSync(path.resolve("prisma/schema.prisma"), "utf8");
const migration = readFileSync(
  path.resolve(
    "prisma/migrations/20260815010000_field_video_resumable_upload/migration.sql"
  ),
  "utf8"
);

describe("field video upload schema", () => {
  it("defines durable upload sessions and idempotent parts", () => {
    expect(schema).toContain("model FieldEvidenceVideoUploadSession");
    expect(schema).toContain("model FieldEvidenceVideoUploadPart");
    expect(schema).toContain("@@unique([sessionId, partNumber])");
    expect(migration).toContain(
      "field_evidence_video_upload_session_one_live_item"
    );
    expect(migration).toContain("WHERE \"status\" IN");
  });
});
