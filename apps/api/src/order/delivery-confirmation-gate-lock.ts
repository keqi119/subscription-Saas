import { Prisma } from "@prisma/client";

export async function lockDeliveryConfirmationGateRows(
  tx: Prisma.TransactionClient,
  orderId: string
) {
  await tx.$queryRaw(Prisma.sql`
    /* delivery-gate-lock:subscription_order */
    SELECT "id"
    FROM "subscription_order"
    WHERE "id" = ${orderId}
    ORDER BY "id"
    FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    /* delivery-gate-lock:vehicle */
    SELECT v."id"
    FROM "vehicle" v
    JOIN "subscription_order" o ON o."vehicle_id" = v."id"
    WHERE o."id" = ${orderId}
    ORDER BY v."id"
    FOR UPDATE OF v
  `);
  await tx.$queryRaw(Prisma.sql`
    /* delivery-gate-lock:vehicle_insurance_policy */
    SELECT p."id"
    FROM "vehicle_insurance_policy" p
    JOIN "subscription_order" o ON o."vehicle_id" = p."vehicle_id"
    WHERE o."id" = ${orderId}
    ORDER BY p."id"
    FOR UPDATE OF p
  `);
  await tx.$queryRaw(Prisma.sql`
    /* delivery-gate-lock:vehicle_delivery */
    SELECT "id"
    FROM "vehicle_delivery"
    WHERE "order_id" = ${orderId}
    ORDER BY "id"
    FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    /* delivery-gate-lock:order_change */
    SELECT "id"
    FROM "order_change"
    WHERE "order_id" = ${orderId}
    ORDER BY "id"
    FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    /* delivery-gate-lock:contract */
    SELECT "id"
    FROM "contract"
    WHERE "order_id" = ${orderId}
    ORDER BY "id"
    FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    /* delivery-gate-lock:contract_esign_task */
    SELECT t."id"
    FROM "contract_esign_task" t
    LEFT JOIN "contract" c ON c."id" = t."contract_id"
    WHERE t."order_id" = ${orderId} OR c."order_id" = ${orderId}
    ORDER BY t."id"
    FOR UPDATE OF t
  `);
  await tx.$queryRaw(Prisma.sql`
    /* delivery-gate-lock:contract_esign_signer */
    SELECT s."id"
    FROM "contract_esign_signer" s
    JOIN "contract_esign_task" t ON t."id" = s."task_id"
    LEFT JOIN "contract" c ON c."id" = t."contract_id"
    WHERE t."order_id" = ${orderId} OR c."order_id" = ${orderId}
    ORDER BY s."id"
    FOR UPDATE OF s
  `);
  await tx.$queryRaw(Prisma.sql`
    /* delivery-gate-lock:vehicle_delivery_handover */
    SELECT "id"
    FROM "vehicle_delivery_handover"
    WHERE "order_id" = ${orderId}
    ORDER BY "id"
    FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    /* delivery-gate-lock:vehicle_handover_work_order */
    SELECT "id"
    FROM "vehicle_handover_work_order"
    WHERE "order_id" = ${orderId}
    ORDER BY "id"
    FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    /* delivery-gate-lock:vehicle_handover_review_attempt */
    SELECT "id"
    FROM "vehicle_handover_review_attempt"
    WHERE "order_id" = ${orderId}
    ORDER BY "id"
    FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    /* delivery-gate-lock:vehicle_delivery_evidence_item */
    SELECT "id"
    FROM "vehicle_delivery_evidence_item"
    WHERE "order_id" = ${orderId}
    ORDER BY "id"
    FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    /* delivery-gate-lock:vehicle_delivery_evidence_file */
    SELECT f."id"
    FROM "vehicle_delivery_evidence_file" f
    JOIN "vehicle_delivery_evidence_item" i
      ON i."id" = f."evidence_item_id"
    WHERE i."order_id" = ${orderId}
    ORDER BY f."id"
    FOR UPDATE OF f
  `);
  await tx.$queryRaw(Prisma.sql`
    /* delivery-gate-lock:file_object */
    SELECT f."id"
    FROM "file_object" f
    WHERE f."id" IN (
      SELECT h."source_document_file_id"
      FROM "vehicle_delivery_handover" h
      WHERE h."order_id" = ${orderId}
        AND h."source_document_file_id" IS NOT NULL
      UNION
      SELECT h."signed_document_file_id"
      FROM "vehicle_delivery_handover" h
      WHERE h."order_id" = ${orderId}
        AND h."signed_document_file_id" IS NOT NULL
      UNION
      SELECT ef."file_id"
      FROM "vehicle_delivery_evidence_file" ef
      JOIN "vehicle_delivery_evidence_item" ei
        ON ei."id" = ef."evidence_item_id"
      WHERE ei."order_id" = ${orderId}
    )
    ORDER BY f."id"
    FOR UPDATE OF f
  `);
}
