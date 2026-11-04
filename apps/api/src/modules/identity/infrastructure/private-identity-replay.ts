import { createHash, timingSafeEqual } from 'node:crypto';

import { HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConflictError, InvalidInputError, isDomainError, Secret } from '@shipkeep/domain';
import { z } from 'zod';

import { EnvelopeService } from '../../../platform/crypto/envelope.service';
import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';

export const IDEMPOTENCY_KEY_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[47][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const snapshotSchema = z
  .object({ request: z.string().max(32768), response: z.string().max(32768) })
  .strict();
const SCOPE = 'identity:replay';
const TTL_MS = 300000;

/** The command, audit and encrypted retry result commit together across API instances. */
@Injectable()
export class PrivateIdentityReplay {
  constructor(
    private readonly database: PrismaUnitOfWork,
    private readonly envelope: EnvelopeService,
  ) {}

  async execute(
    route: string,
    key: string,
    request: Secret,
    operation: () => Promise<Secret>,
    now = new Date(),
  ): Promise<{ response: Secret; replayed: boolean }> {
    if (
      !IDEMPOTENCY_KEY_PATTERN.test(key) ||
      !/^auth\/[a-z/-]{1,64}$/.test(route) ||
      request.expose().length > 32768
    )
      throw new InvalidInputError(
        'invalid_idempotency_key',
        'A lowercase UUIDv4 or UUIDv7 idempotency key is required.',
      );
    const keyHash = createHash('sha256').update(`shipkeep:replay:${route}:${key}`).digest('hex');
    const lock = BigInt.asIntN(64, BigInt(`0x${keyHash.slice(0, 16)}`));
    try {
      return await this.database.run(async () => {
        // A hash collision only serializes independent requests; the full hash identifies rows.
        await this.database.client.$queryRaw`SELECT pg_advisory_xact_lock(${lock})::text`;
        const prior = await this.database.client.identityReplay.findUnique({ where: { keyHash } });
        if (prior && prior.expiresAt > now) {
          const plaintext = await this.envelope.decryptFor(
            SCOPE,
            keyHash,
            Buffer.from(prior.ciphertext),
          );
          try {
            const snapshot = snapshotSchema.parse(
              JSON.parse(plaintext.toString('utf8')) as unknown,
            );
            if (
              !timingSafeEqual(
                createHash('sha256').update(snapshot.request).digest(),
                createHash('sha256').update(request.expose()).digest(),
              )
            )
              throw new ConflictError(
                'idempotency_key_reused',
                'The idempotency key belongs to a different request.',
              );
            return { response: new Secret(snapshot.response), replayed: true };
          } finally {
            plaintext.fill(0);
          }
        }
        const response = await operation();
        const snapshot = snapshotSchema.parse({
          request: request.expose(),
          response: response.expose(),
        });
        const plaintext = Buffer.from(JSON.stringify(snapshot));
        try {
          const ciphertext = new Uint8Array(
            await this.envelope.encryptFor(SCOPE, keyHash, plaintext),
          );
          const data = { ciphertext, createdAt: now, expiresAt: new Date(now.getTime() + TTL_MS) };
          await this.database.client.identityReplay.upsert({
            where: { keyHash },
            create: { keyHash, ...data },
            update: data,
          });
        } finally {
          plaintext.fill(0);
        }
        await this.database.client.$executeRaw`
          DELETE FROM identity_replays WHERE key_hash IN (
            SELECT key_hash FROM identity_replays WHERE expires_at <= ${now}
            ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED
          )`;
        return { response, replayed: false };
      });
    } catch (error: unknown) {
      if (isDomainError(error) || error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Request retry storage temporarily unavailable.');
    }
  }
}
