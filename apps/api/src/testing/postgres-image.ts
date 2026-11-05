/**
 * PostgreSQL image used by every Testcontainers-based test. Pinned by digest like the CI service
 * container and deploy/dev/compose.yml (THREAT_MODEL: tool images are pinned to digests).
 * Renovate updates the three references together.
 */
export const POSTGRES_TEST_IMAGE =
  'postgres:17@sha256:3b0cda93be7c8dba2ed484d19393d93845dc3dafb88973e248ba8e6d99d784e1';
