/**
 * PostgreSQL image used by every Testcontainers-based test. Pinned by digest like the CI service
 * container and deploy/dev/compose.yml (THREAT_MODEL: tool images are pinned to digests).
 * Renovate updates the three references together.
 */
export const POSTGRES_TEST_IMAGE =
  'postgres:17@sha256:0d938e975177bef9f1f61f3f9dbcf2e0aa0a139568f66d3415ed8892eb97f6ac';
