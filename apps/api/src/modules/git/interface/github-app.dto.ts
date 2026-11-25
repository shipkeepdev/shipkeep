import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Length, Matches, ValidateIf } from 'class-validator';

import { type GithubAppMetadata, githubAppUrl } from '../domain/github-app';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export class GitOrganizationPathDto {
  @ApiProperty({ format: 'uuid' }) @Length(36, 36) @Matches(UUID) organizationId!: string;
}

export class StartGithubAppDto {
  @ApiProperty({
    enum: ['user', 'organization'],
    description: 'Create the App on the owner’s own GitHub account, or on a GitHub organization.',
  })
  @IsIn(['user', 'organization'])
  owner!: 'user' | 'organization';

  @ApiProperty({
    required: false,
    description: 'The GitHub organization, when `owner` is `organization`.',
    maxLength: 39,
  })
  @ValidateIf((body: StartGithubAppDto) => body.owner === 'organization')
  @IsString()
  @Length(1, 39)
  githubOrganization?: string;
}

export class GithubAppCreationDto {
  @ApiProperty({ description: 'Where the browser posts the manifest, as the `manifest` field.' })
  url!: string;

  @ApiProperty({ description: 'The App’s manifest, as JSON.' })
  manifest!: string;
}

export class CompleteGithubAppDto {
  @ApiProperty({ description: 'The code GitHub sent the browser back with.', maxLength: 128 })
  @IsString()
  @Length(1, 128)
  code!: string;

  @ApiProperty({ description: 'The state GitHub sent back, as the flow received it.' })
  @IsString()
  @Length(43, 43)
  state!: string;
}

export class GithubAppDto {
  @ApiProperty({ type: 'integer' }) appId!: number;
  @ApiProperty() slug!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ description: 'The GitHub account the App belongs to.' }) ownerLogin!: string;
  @ApiProperty({ description: 'The App’s page on GitHub.' }) url!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class GithubAppStatusDto {
  @ApiProperty({ type: GithubAppDto, nullable: true }) app!: GithubAppDto | null;
}

export function githubAppDto(app: GithubAppMetadata): GithubAppDto {
  return {
    appId: app.appId,
    slug: app.slug,
    name: app.name,
    ownerLogin: app.ownerLogin,
    url: githubAppUrl(app.slug),
    createdAt: app.createdAt.toISOString(),
  };
}

export class GithubRepositoryDto {
  @ApiProperty({ type: 'integer' }) installationId!: number;
  @ApiProperty({ type: 'integer' }) id!: number;
  @ApiProperty({ description: '`owner/name`.' }) fullName!: string;
  @ApiProperty() defaultBranch!: string;
  @ApiProperty() private!: boolean;
}

export class GithubRepositoriesDto {
  @ApiProperty({ type: [GithubRepositoryDto] }) repositories!: GithubRepositoryDto[];
  @ApiProperty({ description: 'True when more than the 500 listed exist.' }) truncated!: boolean;
}
