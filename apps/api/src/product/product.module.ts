import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { ProductController } from "./product.controller";
import { ProductService } from "./product.service";

@Module({
  controllers: [ProductController],
  imports: [AuditModule, AuthModule, PrismaModule],
  providers: [ProductService]
})
export class ProductModule {}
