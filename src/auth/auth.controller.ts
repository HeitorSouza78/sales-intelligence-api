import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AuthService, type DevLoginResponse } from './auth.service.js';
import { DevLoginDto } from './dto/dev-login.dto.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login/dev')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  loginDev(@Body() dto: DevLoginDto): DevLoginResponse {
    return this.authService.loginDev(dto.code);
  }
}
