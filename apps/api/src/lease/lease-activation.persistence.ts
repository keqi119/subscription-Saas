import { LeaseStatus, Prisma } from "@prisma/client";

type LeaseActivationDb = Pick<Prisma.TransactionClient, "lease">;

export async function activateLeaseRecord(
  db: LeaseActivationDb,
  input: {
    activatedAt: Date;
    actorId?: string | null;
    orderId: string;
  }
) {
  const existing = await db.lease.findUnique({
    where: { orderId: input.orderId }
  });
  const lease = existing
    ? await db.lease.update({
        data: {
          activatedAt: input.activatedAt,
          deletedAt: null,
          status: LeaseStatus.ACTIVE,
          updatedBy: input.actorId ?? undefined
        },
        where: { id: existing.id }
      })
    : await db.lease.create({
        data: {
          activatedAt: input.activatedAt,
          createdBy: input.actorId ?? undefined,
          orderId: input.orderId,
          status: LeaseStatus.ACTIVE,
          updatedBy: input.actorId ?? undefined
        }
      });

  return { existing, lease };
}
