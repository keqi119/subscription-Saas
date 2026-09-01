import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";

type Tx = Prisma.TransactionClient;

function fixtureToken(label: string) {
  return `${label}-${randomUUID().replaceAll("-", "").slice(0, 12)}`.slice(0, 48);
}

export async function insertRuntimeUser(tx: Tx, userId: string, label: string) {
  const token = fixtureToken(label);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "user" ("id", "username", "name", "password_hash", "status", "updated_at")
    VALUES (${userId}::uuid, ${token.toLowerCase()}, 'Runtime test user', 'not-used-by-test', 'ACTIVE', clock_timestamp())
    ON CONFLICT ("id") DO NOTHING
  `);
}

export async function insertRuntimeCustomer(tx: Tx, customerId: string, label: string) {
  const token = fixtureToken(label);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "customer" ("id", "customer_no", "name", "mobile", "status", "updated_at")
    VALUES (${customerId}::uuid, ${token}, 'Runtime test customer', '13000000000', 'ACTIVE', clock_timestamp())
    ON CONFLICT ("id") DO NOTHING
  `);
}

export async function insertRuntimeAssetOwner(tx: Tx, assetOwnerId: string, label: string) {
  const token = fixtureToken(label);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "asset_owner" ("id", "owner_no", "name", "owner_type", "status", "updated_at")
    VALUES (${assetOwnerId}::uuid, ${token}, 'Runtime test owner', 'PLATFORM', 'ACTIVE', clock_timestamp())
    ON CONFLICT ("id") DO NOTHING
  `);
}

export async function insertRuntimeOrderPrerequisites(
  tx: Tx,
  input: {
    applicationId: string;
    customerId: string;
    label: string;
    modelDefinitionId: string;
    productId: string;
    productVersionId: string;
    quoteId: string;
    salesUserId?: string;
    vehicleId?: string | null;
  }
) {
  const salesUserId = input.salesUserId ?? randomUUID();
  const token = fixtureToken(input.label);
  await insertRuntimeUser(tx, salesUserId, `${token}-USER`);
  await insertRuntimeCustomer(tx, input.customerId, `${token}-CUSTOMER`);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "vehicle_model_definition" (
      "id", "model_code", "brand", "model_name", "display_name", "enabled", "updated_at"
    ) VALUES (
      ${input.modelDefinitionId}::uuid, ${`${token}-MODEL`}, 'TEST', 'Runtime test model',
      'Runtime test model', true, clock_timestamp()
    )
    ON CONFLICT ("id") DO NOTHING
  `);
  if (input.vehicleId) {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "vehicle" (
        "id", "vehicle_no", "brand", "model_definition_id", "purchase_price_amount", "updated_at"
      ) VALUES (
        ${input.vehicleId}::uuid, ${`${token}-VEHICLE`}, 'TEST', ${input.modelDefinitionId}::uuid,
        1000000, clock_timestamp()
      )
      ON CONFLICT ("id") DO NOTHING
    `);
  }
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "product" ("id", "product_no", "name", "status", "updated_at")
    VALUES (${input.productId}::uuid, ${`${token}-PRODUCT`}, 'Runtime test product', 'ACTIVE', clock_timestamp())
    ON CONFLICT ("id") DO NOTHING
  `);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "product_version" (
      "id", "product_id", "version_no", "effective_from", "status", "updated_at"
    ) VALUES (
      ${input.productVersionId}::uuid, ${input.productId}::uuid, '1', DATE '2026-01-01',
      'ACTIVE', clock_timestamp()
    )
    ON CONFLICT ("id") DO NOTHING
  `);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "application" (
      "id", "application_no", "customer_id", "sales_user_id", "status", "updated_at"
    ) VALUES (
      ${input.applicationId}::uuid, ${`${token}-APPLICATION`}, ${input.customerId}::uuid,
      ${salesUserId}::uuid, 'APPROVED', clock_timestamp()
    )
    ON CONFLICT ("id") DO NOTHING
  `);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "subscription_quote" (
      "id", "quote_no", "application_id", "customer_id", "product_id", "product_version_id",
      "vehicle_id", "vehicle_purchase_price_amount", "monthly_fee_rate", "monthly_fee_amount",
      "deposit_amount", "period_months", "mileage_limit_km", "over_mileage_fee_amount",
      "model_definition_id_snapshot", "model_code_snapshot", "model_display_name_snapshot",
      "status", "updated_at"
    ) VALUES (
      ${input.quoteId}::uuid, ${`${token}-QUOTE`}, ${input.applicationId}::uuid,
      ${input.customerId}::uuid, ${input.productId}::uuid, ${input.productVersionId}::uuid,
      ${input.vehicleId}::uuid, 1000000, 0.010000, 10000, 100000, 6, 10000, 100,
      ${input.modelDefinitionId}::uuid, 'TEST-MODEL', 'Runtime test model', 'CONFIRMED',
      clock_timestamp()
    )
    ON CONFLICT ("id") DO NOTHING
  `);
  return { salesUserId };
}

export async function insertRuntimeVehicle(tx: Tx, vehicleId: string, label: string) {
  const modelDefinitionId = randomUUID();
  const token = fixtureToken(label);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "vehicle_model_definition" (
      "id", "model_code", "brand", "model_name", "display_name", "enabled", "updated_at"
    ) VALUES (
      ${modelDefinitionId}::uuid, ${`${token}-MODEL`}, 'TEST', 'Runtime test model',
      'Runtime test model', true, clock_timestamp()
    )
  `);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "vehicle" (
      "id", "vehicle_no", "brand", "model_definition_id", "purchase_price_amount", "updated_at"
    ) VALUES (
      ${vehicleId}::uuid, ${`${token}-VEHICLE`}, 'TEST', ${modelDefinitionId}::uuid, 1000000,
      clock_timestamp()
    )
    ON CONFLICT ("id") DO NOTHING
  `);
  return { modelDefinitionId };
}

export async function insertRuntimeOrderGraph(
  tx: Tx,
  input: {
    applicationId?: string;
    customerId?: string;
    label: string;
    orderId: string;
    salesUserId?: string;
    vehicleId?: string | null;
  }
) {
  const applicationId = input.applicationId ?? randomUUID();
  const customerId = input.customerId ?? randomUUID();
  const modelDefinitionId = randomUUID();
  const productId = randomUUID();
  const productVersionId = randomUUID();
  const quoteId = randomUUID();
  const salesUserId = input.salesUserId ?? randomUUID();
  const token = fixtureToken(input.label);

  await insertRuntimeUser(tx, salesUserId, `${token}-USER`);
  await insertRuntimeCustomer(tx, customerId, `${token}-CUSTOMER`);

  if (input.vehicleId) {
    await insertRuntimeVehicle(tx, input.vehicleId, `${token}-ORDER`);
  } else {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "vehicle_model_definition" (
        "id", "model_code", "brand", "model_name", "display_name", "enabled", "updated_at"
      ) VALUES (
        ${modelDefinitionId}::uuid, ${`${token}-MODEL`}, 'TEST', 'Runtime test model',
        'Runtime test model', true, clock_timestamp()
      )
    `);
  }

  const resolvedModel = input.vehicleId
    ? await tx.vehicle.findUniqueOrThrow({
        select: { modelDefinitionId: true },
        where: { id: input.vehicleId }
      })
    : { modelDefinitionId };

  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "product" ("id", "product_no", "name", "status", "updated_at")
    VALUES (${productId}::uuid, ${`${token}-PRODUCT`}, 'Runtime test product', 'ACTIVE', clock_timestamp())
  `);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "product_version" (
      "id", "product_id", "version_no", "effective_from", "status", "updated_at"
    ) VALUES (${productVersionId}::uuid, ${productId}::uuid, '1', DATE '2026-01-01', 'ACTIVE', clock_timestamp())
  `);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "application" (
      "id", "application_no", "customer_id", "sales_user_id", "status", "updated_at"
    ) VALUES (
      ${applicationId}::uuid, ${`${token}-APPLICATION`}, ${customerId}::uuid,
      ${salesUserId}::uuid, 'APPROVED', clock_timestamp()
    )
    ON CONFLICT ("id") DO NOTHING
  `);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "subscription_quote" (
      "id", "quote_no", "application_id", "customer_id", "product_id", "product_version_id",
      "vehicle_id", "vehicle_purchase_price_amount", "monthly_fee_rate", "monthly_fee_amount",
      "deposit_amount", "period_months", "mileage_limit_km", "over_mileage_fee_amount",
      "model_definition_id_snapshot", "model_code_snapshot", "model_display_name_snapshot",
      "status", "updated_at"
    ) VALUES (
      ${quoteId}::uuid, ${`${token}-QUOTE`}, ${applicationId}::uuid, ${customerId}::uuid,
      ${productId}::uuid, ${productVersionId}::uuid, ${input.vehicleId}::uuid, 1000000,
      0.010000, 10000, 100000, 6, 10000, 100, ${resolvedModel.modelDefinitionId}::uuid,
      'TEST-MODEL', 'Runtime test model', 'CONFIRMED', clock_timestamp()
    )
  `);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "subscription_order" (
      "id", "order_no", "customer_id", "application_id", "quote_id", "vehicle_id",
      "product_id", "product_version_id", "vehicle_purchase_price_amount", "monthly_fee_amount",
      "deposit_amount", "period_months", "mileage_limit_km", "over_mileage_fee_amount",
      "model_definition_id_snapshot", "model_code_snapshot", "model_display_name_snapshot",
      "quote_snapshot", "updated_at"
    ) VALUES (
      ${input.orderId}::uuid, ${`${token}-ORDER`}, ${customerId}::uuid, ${applicationId}::uuid,
      ${quoteId}::uuid, ${input.vehicleId}::uuid, ${productId}::uuid, ${productVersionId}::uuid,
      1000000, 10000, 100000, 6, 10000, 100, ${resolvedModel.modelDefinitionId}::uuid,
      'TEST-MODEL', 'Runtime test model', '{}'::jsonb, clock_timestamp()
    )
    ON CONFLICT ("id") DO NOTHING
  `);

  return {
    applicationId,
    customerId,
    modelDefinitionId: resolvedModel.modelDefinitionId,
    productId,
    productVersionId,
    quoteId,
    salesUserId
  };
}
