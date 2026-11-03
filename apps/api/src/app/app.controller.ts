import { Controller, Get } from '@nestjs/common';

import { AppService, type HealthStatus } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('v1/health')
  getHealth(): HealthStatus {
    return this.appService.getHealth();
  }
}
