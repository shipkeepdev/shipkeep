import { DOCUMENT } from '@angular/common';
import { inject, Injectable } from '@angular/core';

import { IDENTITY_FETCH } from '../identity/identity-api';

import type { JoinToken } from './fleet-api';

/** Only public, strictly validated pins and addresses can enter the displayed shell command. */
export function installCommand(
  origin: string,
  manifest: unknown,
  token: Pick<JoinToken, 'gatewayAddress' | 'caFingerprint'>,
): string {
  const pins = manifest as Record<string, unknown> | null;
  if (
    /\s/.test(origin + token.gatewayAddress + token.caFingerprint) ||
    !/^https:\/\/([A-Za-z0-9.-]+|\[[A-Fa-f0-9:]+\])(:[0-9]{1,5})?$/.test(origin) ||
    !pins ||
    !['installer', 'amd64', 'arm64'].every(
      (key) =>
        typeof pins[key] === 'string' &&
        pins[key].length === 64 &&
        /^[a-f0-9]{64}$/.test(pins[key]),
    ) ||
    !/^([A-Za-z0-9.-]+|\[[A-Fa-f0-9:]+\]):[0-9]{1,5}$/.test(token.gatewayAddress) ||
    !/^sha256:[a-f0-9]{64}$/.test(token.caFingerprint)
  )
    throw new Error('Verified installer requires HTTPS and valid build artifacts.');
  const installer = pins['installer'] as string;
  return (
    `shipkeep_install_dir=$(mktemp -d) &&\n` +
    `curl --fail --show-error --proto '=https' --max-time 60 -o "$shipkeep_install_dir/install.sh" '${origin}/install/install-${installer}.sh' &&\n` +
    `printf '%s  %s\\n' '${installer}' "$shipkeep_install_dir/install.sh" | sha256sum --check --status &&\n` +
    `sudo bash "$shipkeep_install_dir/install.sh" --control-plane '${token.gatewayAddress}' --ca-fingerprint '${token.caFingerprint}' --origin '${origin}' --amd64-sha256 '${pins['amd64'] as string}' --arm64-sha256 '${pins['arm64'] as string}'`
  );
}

@Injectable({ providedIn: 'root' })
export class InstallCommand {
  private readonly origin = inject(DOCUMENT).location.origin;
  private readonly send = inject(IDENTITY_FETCH);
  async load(): Promise<(token: JoinToken) => string> {
    const response = await this.send(
      new Request(`${this.origin}/install/manifest.json`, {
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
      }),
    );
    if (!response.ok) throw new Error('Installer artifacts are unavailable.');
    const manifest: unknown = await response.json();
    installCommand(this.origin, manifest, {
      gatewayAddress: 'check.example.com:7443',
      caFingerprint: `sha256:${'0'.repeat(64)}`,
    });
    return (token) => installCommand(this.origin, manifest, token);
  }
}
