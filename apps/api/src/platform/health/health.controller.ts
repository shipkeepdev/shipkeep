import { Controller, Get, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';

import { PrismaService } from '../prisma/prisma.service';

import { HealthDto, ReadinessDto } from './health.dto';

/** Version of the control plane, stamped at build time (task M8.3); "dev" otherwise. */
export const API_VERSION = process.env['SHIPKEEP_VERSION'] ?? 'dev';

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Liveness: the process is up. Never touches the database. */
  @Get('health')
  @ApiOkResponse({ type: HealthDto })
  health(): HealthDto {
    return { status: 'ok', version: API_VERSION };
  }

  /** Readiness: the process can serve requests, including database access. */
  @Get('ready')
  @ApiOkResponse({ type: ReadinessDto })
  @ApiServiceUnavailableResponse({ description: 'A dependency is unavailable (problem details).' })
  async ready(): Promise<ReadinessDto> {
    const database = await this.prisma.ping();
    if (!database) {
      throw new ServiceUnavailableException('database unavailable');
    }
    return { status: 'ok', checks: { database: 'ok' } };
  }
}

export { HttpStatus };
