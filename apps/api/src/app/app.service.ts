import { Injectable } from '@nestjs/common';

export interface HealthStatus {
  status: 'ok';
}

@Injectable()
export class AppService {
  getHealth(): HealthStatus {
    return { status: 'ok' };
  }
}
