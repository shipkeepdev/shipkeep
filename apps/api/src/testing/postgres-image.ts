/**
 * PostgreSQL image used by every Testcontainers-based test. Pinned by digest like the CI service
 * container and deploy/dev/compose.yml (THREAT_MODEL: tool images are pinned to digests).
 * Renovate updates the three references together.
 */
export const POSTGRES_TEST_IMAGE =
  'postgres:17@sha256:87c8b42f423b45d5247e6aa8fdb2e7762fec164c68a50fe3eb07e7bfcaf4dbcf';
