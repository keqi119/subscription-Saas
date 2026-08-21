ALTER TABLE "contract_esign_task"
  ADD COLUMN "source_type" VARCHAR(64),
  ADD COLUMN "source_id" UUID,
  ADD COLUMN "source_key" VARCHAR(255),
  ADD CONSTRAINT "contract_esign_task_source_tuple_chk" CHECK (
    ("source_type" IS NULL AND "source_id" IS NULL AND "source_key" IS NULL)
    OR
    ("source_type" IS NOT NULL AND "source_id" IS NOT NULL AND "source_key" IS NOT NULL)
  );

CREATE UNIQUE INDEX "contract_esign_task_source_tuple_key"
ON "contract_esign_task"("source_type", "source_id", "source_key")
WHERE "source_type" IS NOT NULL
  AND "source_id" IS NOT NULL
  AND "source_key" IS NOT NULL;

DROP INDEX "contract_esign_task_one_active_per_contract_key";

CREATE UNIQUE INDEX "contract_esign_task_one_active_per_contract_key"
ON "contract_esign_task"("contract_id")
WHERE "source_type" IS NULL
  AND "source_id" IS NULL
  AND "source_key" IS NULL
  AND "deleted_at" IS NULL
  AND "task_status" IN ('CREATED', 'WAITING_CUSTOMER', 'SIGNING', 'COMPLETED');
