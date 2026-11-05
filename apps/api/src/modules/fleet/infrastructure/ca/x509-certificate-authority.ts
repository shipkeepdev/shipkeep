import { createHash, sign, verify } from 'node:crypto';

import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Secret } from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { EnvelopeService } from '../../../../platform/crypto/envelope.service';
import { DomainEventBus } from '../../../../platform/events/domain-event-bus';
import {
  type CertificateAuthority,
  type ConfirmationKeyProvider,
  FLEET_TRANSACTION,
  type FleetTransaction,
  type IssuedCertificate,
} from '../../application/ports';
import { installationKeyCreated } from '../../domain/events';
import { nodeSpiffeId } from '../../domain/node';

import {
  INSTALLATION_KEY_STORE,
  type InstallationKeyKind,
  type InstallationKeyStore,
  type StoredInstallationKey,
} from './installation-key-store';
import {
  certificateFingerprint,
  CLOCK_SKEW_ALLOWANCE_MS,
  createCaCertificate,
  createGatewayCertificate,
  createNodeCertificate,
  generateEd25519KeyPair,
  NODE_CERT_VALIDITY_MS,
  randomSerial,
  verifyCsr,
} from './x509';

const KEY_SCOPE = 'installation:keys';

function publicKeyFingerprint(publicKeyPem: string): string {
  return `sha256:${createHash('sha256').update(publicKeyPem.trim()).digest('hex')}`;
}

interface LoadedKey {
  certificatePem: string | null;
  publicKeyPem: string;
  privateKeyPem: Secret;
}

/**
 * The installation CA and the confirmation signing key (SPEC sections 3.2 and 3.6). Both key
 * pairs are created on first start, stored with their private half encrypted by the KEK, and
 * never leave this class unencrypted.
 *
 * Keys are loaded at application bootstrap rather than module init: every `onModuleInit` (the
 * audit recorder's subscription included) has run by then, so the creation event is recorded.
 */
@Injectable()
export class X509CertificateAuthority
  implements CertificateAuthority, ConfirmationKeyProvider, OnApplicationBootstrap
{
  private readonly logger = new Logger(X509CertificateAuthority.name);
  private ca: LoadedKey | undefined;
  private confirmation: LoadedKey | undefined;

  constructor(
    @Inject(INSTALLATION_KEY_STORE) private readonly store: InstallationKeyStore,
    private readonly envelope: EnvelopeService,
    private readonly events: DomainEventBus,
    @Inject(FLEET_TRANSACTION) private readonly transaction: FleetTransaction,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.ca = await this.loadOrCreate('ca');
    this.confirmation = await this.loadOrCreate('confirmation');
    this.logger.log({ caFingerprint: await this.caFingerprint() }, 'installation CA ready');
  }

  async caCertificatePem(): Promise<string> {
    const ca = await this.requireCa();
    if (!ca.certificatePem) throw new Error('CA has no certificate');
    return ca.certificatePem;
  }

  async caFingerprint(): Promise<string> {
    return certificateFingerprint(await this.caCertificatePem());
  }

  async gatewayCredentials(hostname: string): Promise<{ cert: string; key: Secret; ca: string }> {
    const ca = await this.requireCa();
    const keys = await generateEd25519KeyPair();
    const caPem = await this.caCertificatePem();
    return {
      cert: await createGatewayCertificate(caPem, ca.privateKeyPem.expose(), keys, hostname),
      key: new Secret(keys.privateKeyPem),
      ca: caPem,
    };
  }

  async publicKeyPem(): Promise<string> {
    return (await this.requireConfirmation()).publicKeyPem;
  }

  /** Ed25519 signature of a confirmation token's signing input (SPEC 3.6). */
  async signConfirmation(input: Uint8Array): Promise<Uint8Array> {
    const key = await this.requireConfirmation();
    return sign(null, input, key.privateKeyPem.expose());
  }

  async verifyConfirmation(input: Uint8Array, signature: Uint8Array): Promise<boolean> {
    const key = await this.requireConfirmation();
    return verify(null, input, key.publicKeyPem, signature);
  }

  private async requireConfirmation(): Promise<LoadedKey> {
    await Promise.resolve();
    if (!this.confirmation) throw new Error('installation keys not loaded yet');
    return this.confirmation;
  }

  async issueNodeCertificate(
    csrPem: string,
    identity: { organizationId: string; nodeId: string },
  ): Promise<IssuedCertificate> {
    const ca = await this.requireCa();
    const nodePublicKey = await verifyCsr(csrPem);
    const issuedAt = Date.now();
    const notBefore = new Date(issuedAt - CLOCK_SKEW_ALLOWANCE_MS);
    const notAfter = new Date(issuedAt + NODE_CERT_VALIDITY_MS);
    const serial = randomSerial();
    const certificatePem = await createNodeCertificate({
      caCertificatePem: await this.caCertificatePem(),
      caPrivateKeyPem: ca.privateKeyPem.expose(),
      nodePublicKey,
      nodeId: identity.nodeId,
      spiffeId: nodeSpiffeId(identity.organizationId, identity.nodeId),
      notBefore,
      notAfter,
      serial,
    });
    return { certificatePem, serial, notBefore, notAfter };
  }

  private async requireCa(): Promise<LoadedKey> {
    await Promise.resolve();
    if (!this.ca) throw new Error('installation keys not loaded yet');
    return this.ca;
  }

  private async loadOrCreate(kind: InstallationKeyKind): Promise<LoadedKey> {
    let stored = await this.store.find(kind);
    if (!stored) {
      const created = await this.create(kind);
      try {
        // The key and its audit row commit together (rule 6): no unaudited CA can exist.
        await this.transaction.run(async () => {
          await this.store.insert(created);
          await this.events.publish([
            installationKeyCreated({
              keyId: created.id,
              kind,
              publicKeyFingerprint: publicKeyFingerprint(created.publicKeyPem),
            }),
          ]);
        });
        stored = created;
        this.logger.log({ kind }, 'installation key created');
      } catch (error: unknown) {
        // Another instance won the race: use its key, never a second CA. Anything else (an audit
        // failure included) left nothing behind and fails startup.
        stored = await this.store.find(kind);
        if (!stored) throw error;
      }
    }
    const privateKeyPem = await this.envelope.decryptFor(
      KEY_SCOPE,
      `private_key:${kind}`,
      stored.privateKeyEnc,
    );
    return {
      certificatePem: stored.certificatePem,
      publicKeyPem: stored.publicKeyPem,
      privateKeyPem: new Secret(privateKeyPem.toString('utf8')),
    };
  }

  private async create(kind: InstallationKeyKind): Promise<StoredInstallationKey & { id: string }> {
    const now = new Date();
    const keys = await generateEd25519KeyPair();
    const certificatePem = kind === 'ca' ? await createCaCertificate(keys, now) : null;
    return {
      id: uuidv7(),
      kind,
      certificatePem,
      publicKeyPem: keys.publicKeyPem,
      privateKeyEnc: await this.envelope.encryptFor(
        KEY_SCOPE,
        `private_key:${kind}`,
        Buffer.from(keys.privateKeyPem, 'utf8'),
      ),
      notAfter: kind === 'ca' ? new Date(now.getTime() + 10 * 365 * 864e5) : null,
      createdAt: now,
    };
  }
}
