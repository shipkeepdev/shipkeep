import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import type { Application } from '../domain/application';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export class ApplicationEnvironmentPathDto {
  @ApiProperty({ format: 'uuid' }) @Length(36, 36) @Matches(UUID) organizationId!: string;
  @ApiProperty({ format: 'uuid' }) @Length(36, 36) @Matches(UUID) projectId!: string;
  @ApiProperty({ format: 'uuid' }) @Length(36, 36) @Matches(UUID) environmentId!: string;
}
export class ApplicationPathDto extends ApplicationEnvironmentPathDto {
  @ApiProperty({ format: 'uuid' }) @Length(36, 36) @Matches(UUID) applicationId!: string;
}

const CONFIG_DESCRIPTION =
  'The shipkeep.yml document as JSON (SPEC 2), validated against the schema. Only build.type image is accepted here: an application built from its repository is created from it. Secrets are listed by name; values are set through the secrets API.';

export class CreateApplicationDto {
  @ApiProperty({ type: 'object', additionalProperties: true, description: CONFIG_DESCRIPTION })
  @IsObject()
  config!: Record<string, unknown>;
}
export class CreateGithubApplicationDto {
  @ApiProperty({
    description: "An installation of the organization's GitHub App that reaches the repository.",
  })
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  installationId!: number;
  @ApiProperty({ description: "GitHub's identifier of the repository." })
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  repositoryId!: number;
  @ApiProperty({ maxLength: 255, description: 'The branch whose pushes the application follows.' })
  @IsString()
  @MaxLength(255)
  branch!: string;
  @ApiPropertyOptional({
    maxLength: 255,
    default: 'shipkeep.yml',
    description:
      'Where shipkeep.yml is in the repository: a relative path to a .yml or .yaml file.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  configPath?: string;
}

export class ApplicationRepositoryDto {
  @ApiProperty() installationId!: number;
  @ApiProperty() repositoryId!: number;
  @ApiProperty({ description: '`owner/name`, as GitHub names the repository.' }) fullName!: string;
  @ApiProperty() branch!: string;
  @ApiProperty() configPath!: string;
  @ApiProperty({
    pattern: '^[0-9a-f]{40}$',
    description: 'The commit the configuration was last read from.',
  })
  commitSha!: string;
}

export class UpdateApplicationConfigDto extends CreateApplicationDto {
  @ApiProperty({ pattern: SHA256.source, description: 'configSha of the configuration edited.' })
  @Matches(SHA256)
  expectedConfigSha!: string;
}

export class ApplicationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['image', 'git'] }) source!: string;
  @ApiProperty({
    type: ApplicationRepositoryDto,
    nullable: true,
    description:
      "With source git: the repository whose shipkeep.yml is the application's configuration.",
  })
  repository!: ApplicationRepositoryDto | null;
  @ApiProperty({ type: 'object', additionalProperties: true }) config!: object;
  @ApiProperty({ pattern: SHA256.source }) configSha!: string;
  @ApiProperty({ type: String, nullable: true }) createdBy!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
export class ApplicationListDto {
  @ApiProperty({ type: [ApplicationDto] }) items!: ApplicationDto[];
}

export class CloneEnvironmentDto {
  @ApiProperty({ description: 'Name of the new environment (same rules as for creation).' })
  @IsString()
  @MaxLength(64)
  name!: string;
}
export class ClonedEnvironmentDto {
  @ApiProperty({ format: 'uuid' }) environmentId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({
    type: [ApplicationDto],
    description: 'The copied applications: not deployed, without domains.',
  })
  applications!: ApplicationDto[];
}

export class DomainCertificateDto {
  @ApiProperty({ format: 'date-time', description: 'When the certificate expires.' })
  notAfter!: string;
  @ApiProperty({ description: "The issuer's common name, or its organization, at most 64 bytes." })
  issuer!: string;
  @ApiProperty({ format: 'date-time', description: 'When a node last read it.' })
  observedAt!: string;
}

export class DomainDto {
  @ApiProperty() hostname!: string;
  @ApiProperty({
    enum: ['public', 'private', 'none', 'unknown'],
    description:
      'public: resolves to public addresses. private: only to non-public ones. none: no record. unknown: the lookup failed.',
  })
  status!: string;
  @ApiProperty({ type: [String], description: 'Public addresses only.' }) addresses!: string[];
  @ApiProperty({
    enum: ['serving', 'partial', 'elsewhere', 'not_running', 'unknown'],
    description:
      'Whether the answers reach a server running the application, compared with the public ' +
      'addresses administrators declared for its nodes. serving: every answer is such a server. ' +
      'partial: only some answers are. elsewhere: none is, or there is no record. not_running: ' +
      'no reachable server runs the application. unknown: the lookup failed, or a server running ' +
      'it has no declared address.',
  })
  match!: string;
  @ApiProperty({
    type: DomainCertificateDto,
    nullable: true,
    description:
      'The certificate the servers running the application serve for the name: of the readings ' +
      'nodes reported in the last hour, the one that expires first. Null while none was read, ' +
      'for instance before the first certificate is issued.',
  })
  certificate!: DomainCertificateDto | null;
}
export class DomainListDto {
  @ApiProperty({ type: [DomainDto] }) items!: DomainDto[];
}

export function applicationDto(application: Application): ApplicationDto {
  return {
    id: application.id,
    name: application.name,
    source: application.source,
    repository: application.repository ? { ...application.repository } : null,
    config: application.config,
    configSha: application.configSha,
    createdBy: application.createdBy,
    createdAt: application.createdAt.toISOString(),
    updatedAt: application.updatedAt.toISOString(),
  };
}

const BLOB = /^[0-9a-f]{40}$/;

/** A Git application's shipkeep.yml in its repository, and whether it runs it (#214). */
export class RepositoryConfigDto {
  @ApiProperty({ description: "The repository's current owner/name." }) fullName!: string;
  @ApiProperty() branch!: string;
  @ApiProperty() configPath!: string;
  @ApiProperty({ pattern: BLOB.source, description: "The branch's head, where the file was read." })
  commitSha!: string;
  @ApiProperty({
    pattern: BLOB.source,
    description: "The file's blob: a change names it, so that it applies to this text only.",
  })
  blobSha!: string;
  @ApiProperty({ description: 'The file as the repository holds it.' }) text!: string;
  @ApiProperty({
    pattern: BLOB.source,
    description: "The commit the application's configuration was last read from.",
  })
  appliedCommitSha!: string;
  @ApiProperty({ description: 'Whether the file is a valid configuration for this application.' })
  valid!: boolean;
  @ApiProperty({ description: "Whether the application's configuration is the file's." })
  applied!: boolean;
}

/** A change of a Git application's shipkeep.yml, to preview (#214). */
export class RepositoryConfigChangeDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'The whole shipkeep.yml document as JSON (SPEC 2), validated against the schema, with the same name. The file keeps its comments and order where the document does not change it.',
  })
  @IsObject()
  config!: Record<string, unknown>;
  @ApiProperty({
    pattern: BLOB.source,
    description:
      'blobSha of the file the change was made against. Another one answers 409 config_file_changed.',
  })
  @Matches(BLOB)
  blobSha!: string;
}

export class DiffLineDto {
  @ApiProperty({ enum: ['same', 'removed', 'added', 'skipped'] }) kind!:
    'same' | 'removed' | 'added' | 'skipped';
  @ApiPropertyOptional({ description: 'The line, without its line break; not for skipped.' })
  text?: string;
  @ApiPropertyOptional({ description: 'Unchanged lines left out; skipped only.' })
  count?: number;
}

/** Where a change of a Git application's shipkeep.yml went (#214). */
export class WrittenConfigChangeDto {
  @ApiProperty({
    enum: ['commit', 'pull_request'],
    description: "A commit on the application's branch, or a pull request into it.",
  })
  via!: 'commit' | 'pull_request';
  @ApiProperty({ pattern: BLOB.source, description: 'The commit that holds the change.' })
  commitSha!: string;
  @ApiProperty({ description: "The commit's or the pull request's page on GitHub." }) url!: string;
  @ApiPropertyOptional({ description: 'The pull request, with via pull_request.' })
  number?: number;
  @ApiPropertyOptional({ description: "The pull request's branch, with via pull_request." })
  branch?: string;
}

/** What a change would write (#214). */
export class RepositoryConfigPreviewDto {
  @ApiProperty() fullName!: string;
  @ApiProperty() branch!: string;
  @ApiProperty() configPath!: string;
  @ApiProperty({ pattern: BLOB.source }) commitSha!: string;
  @ApiProperty({ pattern: BLOB.source }) blobSha!: string;
  @ApiProperty({ description: 'The file as the repository holds it.' }) text!: string;
  @ApiProperty({ description: 'The file with the change.' }) changedText!: string;
  @ApiProperty({ type: [DiffLineDto], description: 'Its changed lines, with three around each.' })
  diff!: DiffLineDto[];
}
