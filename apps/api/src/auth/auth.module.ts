import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { PrismaModule } from "../prisma/prisma.module";
import { AuthController } from "./auth.controller";
import { AuthGuard } from "./auth.guard";
import { AuthService } from "./auth.service";
import { PermissionsGuard } from "./permissions.guard";

@Module({
  controllers: [AuthController],
  exports: [AuthGuard, AuthService, PermissionsGuard],
  imports: [AuditModule, PrismaModule],
  providers: [AuthGuard, AuthService, PermissionsGuard]
})
export class AuthModule {}
