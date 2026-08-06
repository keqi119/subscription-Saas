CREATE TABLE "subscription_change_command" (
    "id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "operation" VARCHAR(64) NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "resource_type" VARCHAR(32),
    "resource_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "subscription_change_command_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "subscription_change_command_actor_id_operation_idempotency_key_key"
ON "subscription_change_command"("actor_id", "operation", "idempotency_key");

CREATE INDEX "subscription_change_command_resource_type_resource_id_idx"
ON "subscription_change_command"("resource_type", "resource_id");

CREATE INDEX "subscription_change_command_created_at_idx"
ON "subscription_change_command"("created_at");

ALTER TABLE "subscription_change_order"
ADD COLUMN "customer_confirmation_published_at" TIMESTAMPTZ(6),
ADD COLUMN "customer_confirmation_published_by" UUID;

CREATE INDEX "subscription_change_order_customer_confirmation_published_at_idx"
ON "subscription_change_order"("customer_confirmation_published_at");
