import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Secret } from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { EnvelopeService } from '../../../../platform/crypto/envelope.service';
import type {
  CertificateAuthority,
  ConfirmationKeyProvider,
  IssuedCertificate,
} from '../../application/ports';
import { nodeSpiffeId } from '../../domain/node';

import {
  INSTALLATION_KEY_STORE,
  type InstallationKeyKind,
  type InstallationKeyStore,
  type StoredInstallationKey,
} from './installation-key-store';
import {
  certificateFingerprint,
  createCaCertificate,
  createNodeCertificate,
  generateEd25519KeyPair,
  NODE_CERT_VALIDITY_MS,
  randomSerial,
  verifyCsr,
} from './x509';

const KEY_SCOPE = 'installation:keys';

interface LoadedKey {
  certificatePem: string | null;
  publicKeyPem: string;
  privateKeyPem: Secret;
}

/**
 * The installation CA and the confirmation signing key (SPEC sections 3.2 and 3.6). Both key
 * pairs are created on first start, stored with their private half encrypted by the KEK, and
 * never leave this class unencrypted.
 */
@Injectable()
export class X509CertificateAuthority
  implements CertificateAuthority, ConfirmationKeyProvider, OnModuleInit
{
  private readonly logger = new Logger(X509CertificateAuthority.name);
  private ca: LoadedKey | undefined;
  private confirmation: LoadedKey | undefined;

  constructor(
    @Inject(INSTALLATION_KEY_STORE) private readonly store: InstallationKeyStore,
    private readonly envelope: EnvelopeService,
  ) {}

  async onModuleInit(): Promise<void> {
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

  async publicKeyPem(): Promise<string> {
    await Promise.resolve();
    if (!this.confirmation) throw new Error('installation keys not loaded yet');
    return this.confirmation.publicKeyPem;
  }

  async issueNodeCertificate(
    csrPem: string,
    identity: { organizationId: string; nodeId: string },
  ): Promise<IssuedCertificate> {
    const ca = await this.requireCa();
    const nodePublicKey = await verifyCsr(csrPem);
    const notBefore = new Date();
    const notAfter = new Date(notBefore.getTime() + NODE_CERT_VALIDITY_MS);
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
        await this.store.insert(created);
      } catch (error: unknown) {
        // Another instance won the race: use its key, never a second CA.
        stored = await this.store.find(kind);
        if (!stored) throw error;
      }
      stored ??= created;
      this.logger.log({ kind }, 'installation key created');
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
