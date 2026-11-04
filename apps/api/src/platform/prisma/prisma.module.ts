import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service';
import { PrismaUnitOfWork } from './prisma-unit-of-work';

@Global()
@Module({
  providers: [PrismaService, PrismaUnitOfWork],
  exports: [PrismaService, PrismaUnitOfWork],
})
export class PrismaModule {}
