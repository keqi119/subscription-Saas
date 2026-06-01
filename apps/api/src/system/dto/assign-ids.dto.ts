import { IsArray, IsUUID } from "class-validator";

export class AssignIdsDto {
  @IsArray()
  @IsUUID("4", { each: true })
  ids!: string[];
}
