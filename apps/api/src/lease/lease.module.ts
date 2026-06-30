import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { LeaseActivationEngine } from "./lease-activation.engine";
import { LeaseController } from "./lease.controller";

@Module({
  controllers: [LeaseController],
  exports: [LeaseActivationEngine],
  imports: [AuditModule, AuthModule],
  providers: [LeaseActivationEngine]
})
export class LeaseModule {}
