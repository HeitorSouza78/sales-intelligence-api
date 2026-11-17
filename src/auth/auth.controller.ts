import { Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { AuthService, type DevLoginResponse } from './auth.service.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login/dev')
  @HttpCode(HttpStatus.OK)
  loginDev(): DevLoginResponse {
    return this.authService.loginDev();
  }
}
