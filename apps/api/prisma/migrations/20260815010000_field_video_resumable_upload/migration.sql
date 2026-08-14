ALTER TYPE "vehicle_handover_event_type" ADD VALUE IF NOT EXISTS 'FIELD_VIDEO_UPLOAD_CREATED';
ALTER TYPE "vehicle_handover_event_type" ADD VALUE IF NOT EXISTS 'FIELD_VIDEO_UPLOAD_RESUMED';
ALTER TYPE "vehicle_handover_event_type" ADD VALUE IF NOT EXISTS 'FIELD_VIDEO_UPLOAD_CANCELLED';
ALTER TYPE "vehicle_handover_event_type" ADD VALUE IF NOT EXISTS 'FIELD_VIDEO_UPLOAD_COMPLETED';
ALTER TYPE "vehicle_handover_event_type" ADD VALUE IF NOT EXISTS 'FIELD_VIDEO_UPLOAD_FAILED';

CREATE TYPE "field_evidence_video_upload_status" AS ENUM (
  'UPLOADING',
  'FINALIZE_QUEUED',
  'OSS_COMPLETING',
  'OBJECT_READY',
  'PROCESSING',
  'RETRYABLE_FAILED',
  'VALIDATION_FAILED',
  'COMPLETED',
  'CANCELLED',
  'EXPIRED'
);

CREATE TABLE "field_evidence_video_upload_session" (
  "id" UUID NOT NULL,
  "work_order_id" UUID NOT NULL,
  "evidence_item_id" UUID NOT NULL,
  "created_by_session_id" UUID,
  "original_name" VARCHAR(255) NOT NULL,
  "mime_type" VARCHAR(128) NOT NULL,
  "size_bytes" BIGINT NOT NULL,
  "last_modified_ms" BIGINT NOT NULL,
  "fingerprint_hash" CHAR(64) NOT NULL,
  "replace_evidence_file_id" UUID,
  "chunk_size_bytes" INTEGER NOT NULL,
  "total_parts" INTEGER NOT NULL,
  "status" "field_evidence_video_upload_status" NOT NULL DEFAULT 'UPLOADING',
  "oss_upload_id" VARCHAR(255),
  "object_key" VARCHAR(512),
  "object_etag" VARCHAR(255),
  "failure_code" VARCHAR(64),
  "failure_message" VARCHAR(255),
  "resume_stage" "field_evidence_video_upload_status",
  "retry_count" INTEGER NOT NULL DEFAULT 0,
  "lease_owner" VARCHAR(128),
  "lease_expires_at" TIMESTAMPTZ(6),
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "object_completed_at" TIMESTAMPTZ(6),
  "processing_completed_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "cancelled_at" TIMESTAMPTZ(6),
  "version" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "field_evidence_video_upload_session_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "field_evidence_video_upload_session_size_check" CHECK ("size_bytes" BETWEEN 1 AND 314572800),
  CONSTRAINT "field_evidence_video_upload_session_chunk_check" CHECK ("chunk_size_bytes" = 8388608),
  CONSTRAINT "field_evidence_video_upload_session_parts_check" CHECK ("total_parts" BETWEEN 1 AND 38)
);

CREATE TABLE "field_evidence_video_upload_part" (
  "id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "part_number" INTEGER NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "oss_etag" VARCHAR(255) NOT NULL,
  "completed_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "field_evidence_video_upload_part_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "field_evidence_video_upload_part_number_check" CHECK ("part_number" BETWEEN 1 AND 38),
  CONSTRAINT "field_evidence_video_upload_part_size_check" CHECK ("size_bytes" BETWEEN 1 AND 8388608)
);

ALTER TABLE "field_evidence_video_upload_session"
  ADD CONSTRAINT "field_evidence_video_upload_session_work_order_id_fkey"
  FOREIGN KEY ("work_order_id") REFERENCES "vehicle_handover_work_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "field_evidence_video_upload_session"
  ADD CONSTRAINT "field_evidence_video_upload_session_evidence_item_id_fkey"
  FOREIGN KEY ("evidence_item_id") REFERENCES "vehicle_delivery_evidence_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "field_evidence_video_upload_session"
  ADD CONSTRAINT "field_evidence_video_upload_session_created_by_session_id_fkey"
  FOREIGN KEY ("created_by_session_id") REFERENCES "field_operator_session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "field_evidence_video_upload_session"
  ADD CONSTRAINT "field_evidence_video_upload_session_replace_evidence_file_id_fkey"
  FOREIGN KEY ("replace_evidence_file_id") REFERENCES "vehicle_delivery_evidence_file"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "field_evidence_video_upload_part"
  ADD CONSTRAINT "field_evidence_video_upload_part_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "field_evidence_video_upload_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "field_evidence_video_upload_session_work_order_id_status_idx"
  ON "field_evidence_video_upload_session"("work_order_id", "status");

CREATE INDEX "field_evidence_video_upload_session_evidence_item_id_status_idx"
  ON "field_evidence_video_upload_session"("evidence_item_id", "status");

CREATE INDEX "field_evidence_video_upload_session_status_lease_expires_at_idx"
  ON "field_evidence_video_upload_session"("status", "lease_expires_at");

CREATE INDEX "field_evidence_video_upload_session_expires_at_idx"
  ON "field_evidence_video_upload_session"("expires_at");

CREATE UNIQUE INDEX "field_evidence_video_upload_session_one_live_item"
  ON "field_evidence_video_upload_session"("evidence_item_id")
  WHERE "status" IN (
    'UPLOADING',
    'FINALIZE_QUEUED',
    'OSS_COMPLETING',
    'OBJECT_READY',
    'PROCESSING',
    'RETRYABLE_FAILED'
  );

CREATE UNIQUE INDEX "field_evidence_video_upload_part_session_id_part_number_key"
  ON "field_evidence_video_upload_part"("session_id", "part_number");

CREATE INDEX "field_evidence_video_upload_part_session_id_completed_at_idx"
  ON "field_evidence_video_upload_part"("session_id", "completed_at");
