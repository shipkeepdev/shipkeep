-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "actor_kind" VARCHAR(16) NOT NULL,
    "actor_id" VARCHAR(128),
    "ip" VARCHAR(45),
    "action" VARCHAR(128) NOT NULL,
    "target_type" VARCHAR(64) NOT NULL,
    "target_id" VARCHAR(128) NOT NULL,
    "metadata" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_encryption_keys" (
    "id" UUID NOT NULL,
    "scope" VARCHAR(128) NOT NULL,
    "wrapped_key" BYTEA NOT NULL,
    "kek_version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_encryption_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_events_organization_id_created_at_idx" ON "audit_events"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_target_type_target_id_idx" ON "audit_events"("target_type", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "data_encryption_keys_scope_key" ON "data_encryption_keys"("scope");
