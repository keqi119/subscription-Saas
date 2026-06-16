import { Module } from "@nestjs/common";

import { PrismaModule } from "../prisma/prisma.module";
import { CustomerAuthGuard } from "./portal-auth.guard";
import { PortalAuthController } from "./portal-auth.controller";
import { PortalAuthService } from "./portal-auth.service";
import { PortalController } from "./portal.controller";

@Module({
  controllers: [PortalAuthController, PortalController],
  exports: [CustomerAuthGuard, PortalAuthService],
  imports: [PrismaModule],
  providers: [CustomerAuthGuard, PortalAuthService]
})
export class PortalModule {}
