-- CreateEnum
CREATE TYPE "customer_account_status" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "customer_verification_code_purpose" AS ENUM ('LOGIN', 'BIND_PHONE');

-- CreateTable
CREATE TABLE "customer_account" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "phone" VARCHAR(32) NOT NULL,
    "phone_verified_at" TIMESTAMPTZ(6),
    "wechat_open_id" VARCHAR(128),
    "wechat_union_id" VARCHAR(128),
    "account_status" "customer_account_status" NOT NULL DEFAULT 'ACTIVE',
    "last_login_at" TIMESTAMPTZ(6),
    "last_login_ip" VARCHAR(64),
    "last_user_agent" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "customer_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_verification_code" (
    "id" UUID NOT NULL,
    "phone" VARCHAR(32) NOT NULL,
    "purpose" "customer_verification_code_purpose" NOT NULL,
    "code_hash" VARCHAR(128) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "request_ip" VARCHAR(64),
    "user_agent" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "customer_verification_code_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_account_phone_key" ON "customer_account"("phone");

-- CreateIndex
CREATE INDEX "customer_account_customer_id_idx" ON "customer_account"("customer_id");

-- CreateIndex
CREATE INDEX "customer_account_phone_idx" ON "customer_account"("phone");

-- CreateIndex
CREATE INDEX "customer_account_wechat_open_id_idx" ON "customer_account"("wechat_open_id");

-- CreateIndex
CREATE INDEX "customer_account_wechat_union_id_idx" ON "customer_account"("wechat_union_id");

-- CreateIndex
CREATE INDEX "customer_account_account_status_idx" ON "customer_account"("account_status");

-- CreateIndex
CREATE INDEX "customer_verification_code_phone_idx" ON "customer_verification_code"("phone");

-- CreateIndex
CREATE INDEX "customer_verification_code_purpose_idx" ON "customer_verification_code"("purpose");

-- CreateIndex
CREATE INDEX "customer_verification_code_expires_at_idx" ON "customer_verification_code"("expires_at");

-- CreateIndex
CREATE INDEX "customer_verification_code_consumed_at_idx" ON "customer_verification_code"("consumed_at");

-- AddForeignKey
ALTER TABLE "customer_account" ADD CONSTRAINT "customer_account_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
