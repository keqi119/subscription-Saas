import { PaymentChannel } from "@prisma/client";
import { ArrayMinSize, ArrayUnique, IsArray, IsEnum, IsOptional, IsUUID } from "class-validator";

export class PortalPayableBillsQueryDto {
  @IsOptional()
  @IsUUID()
  orderId?: string;
}

export class CreatePortalPaymentOrderDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsUUID("4", { each: true })
  billIds!: string[];

  @IsOptional()
  @IsEnum(PaymentChannel)
  paymentChannel?: PaymentChannel;
}
