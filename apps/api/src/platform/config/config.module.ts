import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppConfig } from './app-config';
import { parseConfig } from './config.schema';

/**
 * Loads and validates the environment once for the whole application. A `.env` file at the
 * repository root is read in development; production relies on real environment variables.
 */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: parseConfig,
      envFilePath: ['.env'],
    }),
  ],
  providers: [AppConfig],
  exports: [AppConfig],
})
export class AppConfigModule {}
