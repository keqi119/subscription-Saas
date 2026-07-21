import { IsString, Length } from "class-validator";

export class RequestFieldOperatorCodeDto {
  @IsString()
  phone!: string;
}

export class FieldOperatorLoginDto {
  @Length(4, 8)
  @IsString()
  code!: string;

  @IsString()
  phone!: string;
}
