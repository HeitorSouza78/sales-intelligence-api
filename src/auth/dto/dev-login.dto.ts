import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class DevLoginDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  code: string;
}
