import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { AuditAction, Prisma, RecordStatus } from "@prisma/client";
import bcrypt from "bcryptjs";

import { AuditService } from "../audit/audit.service";
import { RequestContext } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { AssignIdsDto } from "./dto/assign-ids.dto";
import { CreateRoleDto } from "./dto/create-role.dto";
import { CreateUserDto } from "./dto/create-user.dto";
import { UpdateRoleDto } from "./dto/update-role.dto";
import { UpdateUserDto } from "./dto/update-user.dto";

@Injectable()
export class SystemService {
  constructor(
    private readonly auditService: AuditService,
    private readonly prisma: PrismaService
  ) {}

  async listUsers() {
    const users = await this.prisma.user.findMany({
      include: {
        roles: {
          include: {
            role: true
          },
          where: { deletedAt: null }
        }
      },
      orderBy: { createdAt: "desc" },
      where: { deletedAt: null }
    });

    return users.map(toUserView);
  }

  async createUser(dto: CreateUserDto, operatorId: string, context: RequestContext) {
    await this.ensureUsernameAvailable(dto.username);

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          createdBy: operatorId,
          email: dto.email,
          mobile: dto.mobile,
          name: dto.name,
          passwordHash,
          updatedBy: operatorId,
          username: dto.username
        }
      });

      if (dto.roleIds?.length) {
        await syncUserRoles(tx, created.id, dto.roleIds, operatorId);
      }

      return tx.user.findUniqueOrThrow({
        include: {
          roles: {
            include: { role: true },
            where: { deletedAt: null }
          }
        },
        where: { id: created.id }
      });
    });

    await this.auditService.write({
      action: AuditAction.CREATE,
      after: toUserView(user),
      entityId: user.id,
      entityType: "user",
      ipAddress: context.ipAddress,
      module: "system",
      operatorId,
      userAgent: context.userAgent
    });

    return toUserView(user);
  }

  async updateUser(id: string, dto: UpdateUserDto, operatorId: string, context: RequestContext) {
    const before = await this.findUserOrThrow(id);
    const passwordHash = dto.password ? await bcrypt.hash(dto.password, 12) : undefined;

    const user = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        data: {
          email: dto.email,
          mobile: dto.mobile,
          name: dto.name,
          passwordHash,
          status: dto.status,
          updatedBy: operatorId
        },
        where: { id }
      });

      if (dto.roleIds) {
        await syncUserRoles(tx, id, dto.roleIds, operatorId);
      }

      return tx.user.findUniqueOrThrow({
        include: {
          roles: {
            include: { role: true },
            where: { deletedAt: null }
          }
        },
        where: { id }
      });
    });

    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: toUserView(user),
      before: toUserView(before),
      entityId: id,
      entityType: "user",
      ipAddress: context.ipAddress,
      module: "system",
      operatorId,
      userAgent: context.userAgent
    });

    return toUserView(user);
  }

  async listRoles() {
    const roles = await this.prisma.role.findMany({
      include: {
        menus: {
          include: { menu: true },
          where: { deletedAt: null }
        },
        permissions: {
          include: { permission: true },
          where: { deletedAt: null }
        }
      },
      orderBy: { code: "asc" },
      where: { deletedAt: null }
    });

    return roles.map(toRoleView);
  }

  async createRole(dto: CreateRoleDto, operatorId: string, context: RequestContext) {
    const existing = await this.prisma.role.findUnique({ where: { code: dto.code } });

    if (existing && !existing.deletedAt) {
      throw new ConflictException("Role code already exists.");
    }

    const role = await this.prisma.role.create({
      data: {
        code: dto.code,
        createdBy: operatorId,
        description: dto.description,
        name: dto.name,
        updatedBy: operatorId
      }
    });

    await this.auditService.write({
      action: AuditAction.CREATE,
      after: role,
      entityId: role.id,
      entityType: "role",
      ipAddress: context.ipAddress,
      module: "system",
      operatorId,
      userAgent: context.userAgent
    });

    return role;
  }

  async updateRole(id: string, dto: UpdateRoleDto, operatorId: string, context: RequestContext) {
    const before = await this.findRoleOrThrow(id);
    const role = await this.prisma.role.update({
      data: {
        description: dto.description,
        name: dto.name,
        status: dto.status,
        updatedBy: operatorId
      },
      where: { id }
    });

    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: role,
      before,
      entityId: role.id,
      entityType: "role",
      ipAddress: context.ipAddress,
      module: "system",
      operatorId,
      userAgent: context.userAgent
    });

    return role;
  }

  async assignRolePermissions(
    roleId: string,
    permissionIds: AssignIdsDto["ids"],
    operatorId: string,
    context: RequestContext
  ) {
    const before = await this.findRoleOrThrow(roleId);
    await this.prisma.$transaction(async (tx) => {
      await syncRolePermissions(tx, roleId, permissionIds, operatorId);
    });
    const after = await this.findRoleOrThrow(roleId);

    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: toRoleView(after),
      before: toRoleView(before),
      entityId: roleId,
      entityType: "role_permission",
      ipAddress: context.ipAddress,
      module: "system",
      operatorId,
      userAgent: context.userAgent
    });

    return toRoleView(after);
  }

  async assignRoleMenus(
    roleId: string,
    menuIds: AssignIdsDto["ids"],
    operatorId: string,
    context: RequestContext
  ) {
    const before = await this.findRoleOrThrow(roleId);
    await this.prisma.$transaction(async (tx) => {
      await syncRoleMenus(tx, roleId, menuIds, operatorId);
    });
    const after = await this.findRoleOrThrow(roleId);

    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: toRoleView(after),
      before: toRoleView(before),
      entityId: roleId,
      entityType: "role_menu",
      ipAddress: context.ipAddress,
      module: "system",
      operatorId,
      userAgent: context.userAgent
    });

    return toRoleView(after);
  }

  listPermissions() {
    return this.prisma.permission.findMany({
      orderBy: [{ module: "asc" }, { code: "asc" }],
      where: { deletedAt: null, status: RecordStatus.ACTIVE }
    });
  }

  listMenus() {
    return this.prisma.menu.findMany({
      orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
      where: { deletedAt: null, status: RecordStatus.ACTIVE }
    });
  }

  listAuditLogs() {
    return this.prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 100
    });
  }

  private async ensureUsernameAvailable(username: string) {
    const existing = await this.prisma.user.findUnique({ where: { username } });

    if (existing && !existing.deletedAt) {
      throw new ConflictException("Username already exists.");
    }
  }

  private async findUserOrThrow(id: string) {
    const user = await this.prisma.user.findUnique({
      include: {
        roles: {
          include: { role: true },
          where: { deletedAt: null }
        }
      },
      where: { id }
    });

    if (!user || user.deletedAt) {
      throw new NotFoundException("User not found.");
    }

    return user;
  }

  private async findRoleOrThrow(id: string) {
    const role = await this.prisma.role.findUnique({
      include: {
        menus: {
          include: { menu: true },
          where: { deletedAt: null }
        },
        permissions: {
          include: { permission: true },
          where: { deletedAt: null }
        }
      },
      where: { id }
    });

    if (!role || role.deletedAt) {
      throw new NotFoundException("Role not found.");
    }

    return role;
  }
}

type Tx = Prisma.TransactionClient;

async function syncUserRoles(tx: Tx, userId: string, roleIds: string[], operatorId: string) {
  await tx.userRole.updateMany({
    data: { deletedAt: new Date() },
    where: {
      deletedAt: null,
      roleId: { notIn: roleIds },
      userId
    }
  });

  for (const roleId of roleIds) {
    await tx.userRole.upsert({
      create: { createdBy: operatorId, roleId, userId },
      update: { createdBy: operatorId, deletedAt: null },
      where: { userId_roleId: { roleId, userId } }
    });
  }
}

async function syncRolePermissions(
  tx: Tx,
  roleId: string,
  permissionIds: string[],
  operatorId: string
) {
  await tx.rolePermission.updateMany({
    data: { deletedAt: new Date() },
    where: {
      deletedAt: null,
      permissionId: { notIn: permissionIds },
      roleId
    }
  });

  for (const permissionId of permissionIds) {
    await tx.rolePermission.upsert({
      create: { createdBy: operatorId, permissionId, roleId },
      update: { createdBy: operatorId, deletedAt: null },
      where: { roleId_permissionId: { permissionId, roleId } }
    });
  }
}

async function syncRoleMenus(tx: Tx, roleId: string, menuIds: string[], operatorId: string) {
  await tx.roleMenu.updateMany({
    data: { deletedAt: new Date() },
    where: {
      deletedAt: null,
      menuId: { notIn: menuIds },
      roleId
    }
  });

  for (const menuId of menuIds) {
    await tx.roleMenu.upsert({
      create: { createdBy: operatorId, menuId, roleId },
      update: { createdBy: operatorId, deletedAt: null },
      where: { roleId_menuId: { menuId, roleId } }
    });
  }
}

export function toUserView(
  user: Prisma.UserGetPayload<{
    include: { roles: { include: { role: true } } };
  }>
) {
  return {
    createdAt: user.createdAt,
    email: user.email,
    id: user.id,
    mobile: user.mobile,
    name: user.name,
    roles: user.roles.map(({ role }) => ({
      code: role.code,
      id: role.id,
      name: role.name
    })),
    status: user.status,
    username: user.username
  };
}

export function toRoleView(
  role: Prisma.RoleGetPayload<{
    include: {
      menus: { include: { menu: true } };
      permissions: { include: { permission: true } };
    };
  }>
) {
  return {
    code: role.code,
    description: role.description,
    id: role.id,
    menus: role.menus.map(({ menu }) => ({
      code: menu.code,
      id: menu.id,
      name: menu.name,
      path: menu.path
    })),
    name: role.name,
    permissions: role.permissions.map(({ permission }) => ({
      code: permission.code,
      id: permission.id,
      name: permission.name
    })),
    status: role.status
  };
}
