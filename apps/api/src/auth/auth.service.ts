import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuditAction, Prisma, UserStatus } from "@prisma/client";
import { MenuItemDefinition } from "@subscription-saas/shared";
import bcrypt from "bcryptjs";
import jwt, { JwtPayload, SignOptions } from "jsonwebtoken";

import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { LoginDto } from "./dto/login.dto";
import { AuthResult, RequestContext, RequestUser } from "./auth.types";

const userAccessInclude = {
  roles: {
    include: {
      role: {
        include: {
          menus: {
            include: {
              menu: true
            },
            where: {
              deletedAt: null,
              menu: {
                deletedAt: null,
                status: "ACTIVE"
              }
            }
          },
          permissions: {
            include: {
              permission: true
            },
            where: {
              deletedAt: null,
              permission: {
                deletedAt: null,
                status: "ACTIVE"
              }
            }
          }
        }
      }
    },
    where: {
      deletedAt: null,
      role: {
        deletedAt: null,
        status: "ACTIVE"
      }
    }
  }
} satisfies Prisma.UserInclude;

type UserWithAccess = Prisma.UserGetPayload<{ include: typeof userAccessInclude }>;

@Injectable()
export class AuthService {
  constructor(
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService
  ) {}

  async login(dto: LoginDto, context: RequestContext): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({
      include: userAccessInclude,
      where: { username: dto.username }
    });

    if (!user || user.deletedAt || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException("Invalid username or password.");
    }

    const passwordMatched = await bcrypt.compare(dto.password, user.passwordHash);

    if (!passwordMatched) {
      throw new UnauthorizedException("Invalid username or password.");
    }

    await this.prisma.user.update({
      data: { lastLoginAt: new Date() },
      where: { id: user.id }
    });

    const requestUser = buildRequestUser(user);

    await this.auditService.write({
      action: AuditAction.LOGIN,
      after: { username: user.username },
      entityId: user.id,
      entityType: "user",
      ipAddress: context.ipAddress,
      module: "system",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return {
      menus: requestUser.menus,
      token: this.signToken(requestUser),
      user: {
        id: requestUser.id,
        name: requestUser.name,
        permissions: requestUser.permissions,
        roles: requestUser.roles,
        username: requestUser.username
      }
    };
  }

  async logout(userId: string, context: RequestContext) {
    await this.auditService.write({
      action: AuditAction.LOGOUT,
      entityId: userId,
      entityType: "user",
      ipAddress: context.ipAddress,
      module: "system",
      operatorId: userId,
      userAgent: context.userAgent
    });
  }

  async validateToken(token: string): Promise<RequestUser> {
    const secret = this.getJwtSecret();
    const payload = jwt.verify(token, secret);

    if (typeof payload === "string" || !isJwtPayload(payload)) {
      throw new UnauthorizedException("Invalid access token.");
    }

    const user = await this.prisma.user.findUnique({
      include: userAccessInclude,
      where: { id: payload.sub }
    });

    if (!user || user.deletedAt || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException("Invalid access token.");
    }

    return buildRequestUser(user);
  }

  private signToken(user: RequestUser): string {
    const expiresIn: SignOptions["expiresIn"] =
      this.configService.get<SignOptions["expiresIn"]>("JWT_EXPIRES_IN") ?? "7d";

    return jwt.sign(
      {
        permissions: user.permissions,
        roles: user.roles,
        username: user.username
      },
      this.getJwtSecret(),
      {
        expiresIn,
        subject: user.id
      }
    );
  }

  private getJwtSecret(): string {
    const secret = this.configService.get<string>("JWT_SECRET");

    if (!secret) {
      throw new Error("JWT_SECRET is required.");
    }

    return secret;
  }
}

function isJwtPayload(payload: JwtPayload): payload is JwtPayload & { sub: string } {
  return typeof payload.sub === "string";
}

export function buildRequestUser(user: UserWithAccess): RequestUser {
  const roles = user.roles.map(({ role }) => role.code);
  const permissions = new Set<string>();
  const menuMap = new Map<string, MenuItemDefinition & { parentCode?: string | null; sortOrder: number }>();

  for (const userRole of user.roles) {
    for (const rolePermission of userRole.role.permissions) {
      permissions.add(rolePermission.permission.code);
    }

    for (const roleMenu of userRole.role.menus) {
      const menu = roleMenu.menu;
      menuMap.set(menu.code, {
        code: menu.code,
        icon: menu.icon ?? undefined,
        label: menu.name,
        parentCode: undefined,
        path: menu.path,
        permissionCode: menu.permissionCode ?? undefined,
        sortOrder: menu.sortOrder
      });
    }
  }

  return {
    id: user.id,
    menus: Array.from(menuMap.values()).sort((a, b) => a.sortOrder - b.sortOrder),
    name: user.name,
    permissions: Array.from(permissions).sort(),
    roles,
    username: user.username
  };
}
