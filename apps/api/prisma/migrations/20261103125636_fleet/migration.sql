-- CreateTable
CREATE TABLE "installation_keys" (
    "id" UUID NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "certificate_pem" TEXT,
    "public_key_pem" TEXT NOT NULL,
    "private_key_enc" BYTEA NOT NULL,
    "not_after" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "installation_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "join_tokens" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "created_by" VARCHAR(128),
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "used_by_node_id" UUID,

    CONSTRAINT "join_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nodes" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "labels" JSONB NOT NULL,
    "facts" JSONB NOT NULL,
    "lease_epoch" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "last_heartbeat_at" TIMESTAMPTZ(6),

    CONSTRAINT "nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_certificates" (
    "id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "serial" VARCHAR(64) NOT NULL,
    "not_before" TIMESTAMPTZ(6) NOT NULL,
    "not_after" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "node_certificates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "installation_keys_kind_key" ON "installation_keys"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "join_tokens_token_hash_key" ON "join_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "join_tokens_organization_id_expires_at_idx" ON "join_tokens"("organization_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "nodes_organization_id_name_key" ON "nodes"("organization_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "node_certificates_serial_key" ON "node_certificates"("serial");

-- CreateIndex
CREATE INDEX "node_certificates_node_id_idx" ON "node_certificates"("node_id");

-- AddForeignKey
ALTER TABLE "node_certificates" ADD CONSTRAINT "node_certificates_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
