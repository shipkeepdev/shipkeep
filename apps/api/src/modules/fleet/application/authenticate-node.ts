import { Inject, Injectable } from '@nestjs/common';

import {
  authenticateCertificate,
  type NodeCredential,
  type NodeIdentity,
} from '../domain/node-identity';

import { NODE_CREDENTIAL_STORE, type NodeCredentialStore } from './ports';

@Injectable()
export class AuthenticateNode {
  constructor(@Inject(NODE_CREDENTIAL_STORE) private readonly credentials: NodeCredentialStore) {}

  async execute(identity: NodeIdentity, now = new Date()): Promise<NodeCredential> {
    return authenticateCertificate(identity, await this.credentials.find(identity.serial), now);
  }
}
