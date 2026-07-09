import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { ContractModule } from "../contract/contract.module";
import { ESignModule } from "../esign/esign.module";
import { OrderController } from "./order.controller";
import { OrderService } from "./order.service";

@Module({
  controllers: [OrderController],
  imports: [AuditModule, AuthModule, ContractModule, ESignModule],
  providers: [OrderService]
})
export class OrderModule {}
