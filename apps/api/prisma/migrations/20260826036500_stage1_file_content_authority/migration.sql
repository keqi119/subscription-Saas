ALTER TABLE "file_object"
  ADD COLUMN "content_sha256" VARCHAR(64),
  ADD CONSTRAINT "file_object_content_sha256_check" CHECK (
    "content_sha256" IS NULL OR "content_sha256" ~ '^[0-9a-f]{64}$'
  );
