import { ApiProperty } from '@nestjs/swagger';
import { DEPLOYMENT_STATES } from '@shipkeep/domain';
import { Length, Matches } from 'class-validator';

import { ApplicationPathDto } from '../../apps/interface/application.dto';
import { DEPLOYMENT_TRIGGERS, type DeploymentRecord, type Release } from '../domain/release';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export class DeploymentPathDto extends ApplicationPathDto {
  @ApiProperty({ format: 'uuid' }) @Length(36, 36) @Matches(UUID) deploymentId!: string;
}

export class DeploymentDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) releaseId!: string;
  @ApiProperty({ enum: DEPLOYMENT_STATES }) state!: string;
  @ApiProperty({ description: 'False for image sources: nothing is built.' }) build!: boolean;
  @ApiProperty({ description: 'True when a release command runs before the switch.' })
  release!: boolean;
  @ApiProperty({ enum: DEPLOYMENT_TRIGGERS }) trigger!: string;
  @ApiProperty({ type: String, nullable: true }) actorId!: string | null;
  @ApiProperty({ type: String, nullable: true, maxLength: 512 }) error!: string | null;
  @ApiProperty({ format: 'date-time' }) startedAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) finishedAt!: string | null;
}
export class DeploymentListDto {
  @ApiProperty({ type: [DeploymentDto], description: 'Most recent first, at most 50.' })
  items!: DeploymentDto[];
}

export class ReleaseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: 'integer' }) number!: number;
  @ApiProperty() image!: string;
  @ApiProperty({ type: String, nullable: true, description: 'Set once the image is resolved.' })
  imageDigest!: string | null;
  @ApiProperty({ type: 'object', additionalProperties: true }) config!: object;
  @ApiProperty() configSha!: string;
  @ApiProperty({ type: String, nullable: true }) createdBy!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
export class ReleaseListDto {
  @ApiProperty({ type: [ReleaseDto], description: 'Most recent first, at most 50.' })
  items!: ReleaseDto[];
}

export class QueuedDeploymentDto {
  @ApiProperty({ type: ReleaseDto }) release!: ReleaseDto;
  @ApiProperty({ type: DeploymentDto }) deployment!: DeploymentDto;
}

export function deploymentDto(deployment: DeploymentRecord): DeploymentDto {
  return {
    id: deployment.id,
    releaseId: deployment.releaseId,
    state: deployment.state,
    build: deployment.plan.build,
    release: deployment.plan.release,
    trigger: deployment.trigger,
    actorId: deployment.actorId,
    error: deployment.error,
    startedAt: deployment.startedAt.toISOString(),
    finishedAt: deployment.finishedAt?.toISOString() ?? null,
  };
}

export function releaseDto(release: Release): ReleaseDto {
  return {
    id: release.id,
    number: release.number,
    image: release.image,
    imageDigest: release.imageDigest,
    config: release.config,
    configSha: release.configSha,
    createdBy: release.createdBy,
    createdAt: release.createdAt.toISOString(),
  };
}
