import { ConflictException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

export type VehicleMileageCommandSource = Readonly<{
  id: string;
  key: string;
  type: string;
}>;

declare const vehicleMileageSourceCapabilityBrand: unique symbol;
export type VehicleMileageSourceCapability = Readonly<{
  [vehicleMileageSourceCapabilityBrand]: true;
}>;

type VehicleMileageSourceCapabilityState = Readonly<{
  source: VehicleMileageCommandSource;
  transaction: Prisma.TransactionClient;
}>;

@Injectable()
export class VehicleMileageRepository {
  private readonly sourceCapabilities = new WeakMap<
    VehicleMileageSourceCapability,
    VehicleMileageSourceCapabilityState
  >();

  async prepareCallerOwnedCommand(
    tx: Prisma.TransactionClient,
    source: VehicleMileageCommandSource
  ): Promise<VehicleMileageSourceCapability> {
    const normalized = normalizeSource(source);
    await assertTransactionContract(tx);
    const lockKey = JSON.stringify([
      "vehicle-mileage",
      "source-ownership",
      normalized.type,
      normalized.id,
      normalized.key
    ]);
    await tx.$queryRaw(
      Prisma.sql`SELECT TRUE AS "locked" FROM pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`
    );
    const capability = Object.freeze({}) as VehicleMileageSourceCapability;
    this.sourceCapabilities.set(capability, Object.freeze({ source: normalized, transaction: tx }));
    return capability;
  }

  attestCallerOwnedCommand(
    tx: Prisma.TransactionClient,
    source: VehicleMileageCommandSource,
    capability: VehicleMileageSourceCapability
  ) {
    const state = this.sourceCapabilities.get(capability);
    this.sourceCapabilities.delete(capability);
    const normalized = normalizeSource(source);
    if (
      !state ||
      state.transaction !== tx ||
      sourceIdentity(state.source) !== sourceIdentity(normalized)
    ) {
      throw capabilityInvalid();
    }
  }
}

function normalizeSource(source: VehicleMileageCommandSource): VehicleMileageCommandSource {
  const id = source.id.trim().toLowerCase();
  const key = source.key.trim();
  const type = source.type.trim().toUpperCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) ||
    !key ||
    !type ||
    key.length > 255 ||
    type.length > 64
  ) {
    throw capabilityInvalid();
  }
  return Object.freeze({ id, key, type });
}

function sourceIdentity(source: VehicleMileageCommandSource) {
  return JSON.stringify([source.type, source.id, source.key]);
}

async function assertTransactionContract(tx: Prisma.TransactionClient) {
  const [first] = await tx.$queryRaw<Array<{ isolationLevel: string; transactionId: string }>>(
    Prisma.sql`
      SELECT current_setting('transaction_isolation') AS "isolationLevel",
             txid_current()::text AS "transactionId"
    `
  );
  const [second] = await tx.$queryRaw<Array<{ transactionId: string }>>(
    Prisma.sql`SELECT txid_current()::text AS "transactionId"`
  );
  if (
    first?.isolationLevel !== "read committed" ||
    !first.transactionId ||
    first.transactionId !== second?.transactionId
  ) {
    throw capabilityInvalid();
  }
}

function capabilityInvalid() {
  return new ConflictException({
    code: "VEHICLE_MILEAGE_CAPABILITY_INVALID",
    message: "The caller-owned vehicle-mileage capability is invalid."
  });
}
