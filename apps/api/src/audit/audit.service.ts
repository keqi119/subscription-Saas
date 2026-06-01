import { Injectable } from "@nestjs/common";
import { AuditAction, Prisma } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";

interface WriteAuditLogInput {
  action: AuditAction;
  after?: unknown;
  before?: unknown;
  entityId?: string;
  entityType: string;
  ipAddress?: string;
  module: string;
  operatorId?: string;
  userAgent?: string;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async write(input: WriteAuditLogInput) {
    await this.prisma.auditLog.create({
      data: {
        action: input.action,
        afterSnapshot: toJsonSnapshot(input.after),
        beforeSnapshot: toJsonSnapshot(input.before),
        entityId: input.entityId,
        entityType: input.entityType,
        ipAddress: input.ipAddress,
        module: input.module,
        operatorId: input.operatorId,
        userAgent: input.userAgent
      }
    });
  }
}

function toJsonSnapshot(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
