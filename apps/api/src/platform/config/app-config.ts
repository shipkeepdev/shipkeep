import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { ParsedConfig } from './config.schema';

/** Typed, validated access to the control plane configuration. */
@Injectable()
export class AppConfig {
  constructor(private readonly config: ConfigService<ParsedConfig, true>) {}

  get<K extends keyof ParsedConfig>(key: K): ParsedConfig[K] {
    return this.config.get(key, { infer: true });
  }

  get nodeEnv(): ParsedConfig['NODE_ENV'] {
    return this.get('NODE_ENV');
  }

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }

  /** Whether the interactive API documentation is served. Defaults to on outside production. */
  get openApiUi(): boolean {
    return this.get('OPENAPI_UI') ?? !this.isProduction;
  }
}
