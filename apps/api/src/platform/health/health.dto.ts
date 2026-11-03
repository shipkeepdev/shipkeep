import { ApiProperty } from '@nestjs/swagger';

export class HealthDto {
  @ApiProperty({ enum: ['ok'] })
  status!: 'ok';

  @ApiProperty({ example: '0.1.0' })
  version!: string;
}

export class ReadinessChecksDto {
  @ApiProperty({ enum: ['ok'] })
  database!: 'ok';
}

export class ReadinessDto {
  @ApiProperty({ enum: ['ok'] })
  status!: 'ok';

  @ApiProperty({ type: ReadinessChecksDto })
  checks!: ReadinessChecksDto;
}
