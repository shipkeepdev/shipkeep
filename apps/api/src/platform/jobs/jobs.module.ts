import { Module } from '@nestjs/common';

import { JobQueue } from './job-queue';

@Module({ providers: [JobQueue], exports: [JobQueue] })
export class JobsModule {}
