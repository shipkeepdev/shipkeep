import { Global, Module } from '@nestjs/common';

import { DATA_KEY_STORE } from './data-key-store';
import { EnvelopeService } from './envelope.service';
import { PrismaDataKeyStore } from './prisma-data-key.store';

@Global()
@Module({
  providers: [{ provide: DATA_KEY_STORE, useClass: PrismaDataKeyStore }, EnvelopeService],
  exports: [EnvelopeService],
})
export class CryptoModule {}
