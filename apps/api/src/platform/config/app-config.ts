import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { ParsedConfig } from './config.schema';

/** Typed, validated access to the control plane configuration. */
@Injectable()
export class AppConfig {
  constructor(private readonly config: ConfigService<ParsedConfig, true>) {}

  get<K extends keyof ParsedConfig>(key: K): ParsedConfig[K] {
    const value: unknown = this.config.get(key, { infer: true });
    // When validation left a key undefined, ConfigService falls back to the raw environment
    // variable. No validated value is ever empty, so an empty string is that raw fallback for a
    // variable the schema treats as unset (optional SMTP credentials left empty by compose).
    return (value === '' ? undefined : value) as ParsedConfig[K];
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
