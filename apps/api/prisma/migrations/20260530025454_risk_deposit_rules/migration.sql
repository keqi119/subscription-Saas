-- CreateEnum
CREATE TYPE "risk_result_decision" AS ENUM ('APPROVED', 'REJECTED', 'NEED_MORE_INFO');

-- CreateTable
CREATE TABLE "risk_result" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "score" INTEGER,
    "grade" "customer_grade" NOT NULL,
    "approved_deposit_amount" BIGINT NOT NULL,
    "default_rate" DECIMAL(8,6) NOT NULL,
    "max_vehicle_purchase_price_amount" BIGINT,
    "result" "risk_result_decision" NOT NULL DEFAULT 'APPROVED',
    "remark" TEXT,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "risk_result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposit_rule" (
    "id" UUID NOT NULL,
    "grade" "customer_grade" NOT NULL,
    "deposit_amount" BIGINT NOT NULL,
    "customer_ratio" DECIMAL(8,6),
    "default_rate" DECIMAL(8,6) NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "status" "record_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "deposit_rule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "risk_result_application_id_idx" ON "risk_result"("application_id");

-- CreateIndex
CREATE INDEX "risk_result_customer_id_idx" ON "risk_result"("customer_id");

-- CreateIndex
CREATE INDEX "risk_result_approved_by_idx" ON "risk_result"("approved_by");

-- CreateIndex
CREATE INDEX "risk_result_grade_idx" ON "risk_result"("grade");

-- CreateIndex
CREATE INDEX "risk_result_result_idx" ON "risk_result"("result");

-- CreateIndex
CREATE INDEX "deposit_rule_grade_status_idx" ON "deposit_rule"("grade", "status");

-- CreateIndex
CREATE INDEX "deposit_rule_effective_from_effective_to_idx" ON "deposit_rule"("effective_from", "effective_to");

-- AddForeignKey
ALTER TABLE "risk_result" ADD CONSTRAINT "risk_result_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_result" ADD CONSTRAINT "risk_result_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_result" ADD CONSTRAINT "risk_result_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
