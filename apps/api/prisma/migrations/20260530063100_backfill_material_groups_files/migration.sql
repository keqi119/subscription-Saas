CREATE EXTENSION IF NOT EXISTS "pgcrypto";

WITH latest_material AS (
    SELECT DISTINCT ON ("application_id", "material_type")
        "application_id",
        "material_type",
        "material_name",
        "status",
        COALESCE("review_comment", "review_remark") AS "review_comment",
        "reviewed_by",
        "reviewed_at",
        "created_by",
        "updated_by",
        "created_at",
        "updated_at"
    FROM "application_material"
    WHERE "deleted_at" IS NULL
    ORDER BY "application_id", "material_type", "created_at" DESC
)
INSERT INTO "application_material_group" (
    "id",
    "application_id",
    "material_type",
    "material_name",
    "required",
    "review_status",
    "review_comment",
    "reviewed_by",
    "reviewed_at",
    "created_by",
    "updated_by",
    "created_at",
    "updated_at"
)
SELECT
    gen_random_uuid(),
    "application_id",
    "material_type",
    "material_name",
    "material_type" IN ('ID_CARD', 'DRIVER_LICENSE', 'CREDIT_AUTH'),
    "status",
    "review_comment",
    "reviewed_by",
    "reviewed_at",
    "created_by",
    "updated_by",
    "created_at",
    "updated_at"
FROM latest_material
ON CONFLICT ("application_id", "material_type") DO NOTHING;

INSERT INTO "application_material_file" (
    "id",
    "material_group_id",
    "application_id",
    "material_type",
    "file_id",
    "file_name",
    "mime_type",
    "size_bytes",
    "uploaded_by",
    "uploaded_at",
    "is_deleted",
    "created_by",
    "updated_by",
    "created_at",
    "updated_at"
)
SELECT
    am."id",
    amg."id",
    am."application_id",
    am."material_type",
    am."file_id",
    fo."original_name",
    fo."mime_type",
    fo."size_bytes",
    fo."uploaded_by",
    fo."created_at",
    false,
    am."created_by",
    am."updated_by",
    am."created_at",
    am."updated_at"
FROM "application_material" am
JOIN "application_material_group" amg
    ON amg."application_id" = am."application_id"
    AND amg."material_type" = am."material_type"
JOIN "file_object" fo ON fo."id" = am."file_id"
WHERE am."deleted_at" IS NULL
  AND NOT EXISTS (
      SELECT 1
      FROM "application_material_file" amf
      WHERE amf."id" = am."id"
  );
