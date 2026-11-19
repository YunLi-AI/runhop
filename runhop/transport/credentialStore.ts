// Adapted from SFTPresso 1.42.0 (MIT).
// https://github.com/jmwerk/SFTPresso/blob/fda0e2e7341378e535f0336600127075c4d28758/src/credentialStore.ts

import { l10n, window } from 'vscode';
import { getSecrets } from './logger';
import logger from './logger';

export interface ConnectIdentity {
  host: string;
  port?: number;
  username?: string;
}

const SECRET_KEY_PREFIX_PASSWORD = 'sftp.password.';
const SECRET_KEY_PREFIX_PASSPHRASE = 'sftp.passphrase.';

// "protocol://username@host:port" — identifies a remote both in secret
// storage keys and in messages shown to the user
export function connectionToken(identity: ConnectIdentity): string {
  return `sftp://${identity.username}@${identity.host}:${identity.port ?? 22}`;
}

function secretKey(prefix: string, identity: ConnectIdentity): string {
  return prefix + connectionToken(identity);
}

function getSecretStorage() {
  return getSecrets();
}

async function getStoredSecret(
  prefix: string,
  identity: ConnectIdentity,
  kind: string
): Promise<string | undefined> {
  const secrets = getSecretStorage();
  if (!secrets) {
    return undefined;
  }

  try {
    return await secrets.get(secretKey(prefix, identity));
  } catch (error) {
    logger.warn(
      `read ${kind} for ${connectionToken(identity)} from secret storage failed: ${error.message}`
    );
    return undefined;
  }
}

async function storeSecret(
  prefix: string,
  identity: ConnectIdentity,
  value: string
): Promise<void> {
  const secrets = getSecretStorage();
  if (!secrets) {
    throw new Error('Secret storage is unavailable.');
  }

  await secrets.store(secretKey(prefix, identity), value);
}

async function offerToRememberSecret(
  prefix: string,
  identity: ConnectIdentity,
  value: string,
  kind: string,
  question: string,
  offerLabel: string
) {
  try {
    const answer = await window.showInformationMessage(question, offerLabel);
    if (answer === offerLabel) {
      await storeSecret(prefix, identity, value);
      logger.info(`${kind} for ${connectionToken(identity)} saved to secret storage`);
    }
  } catch (error) {
    logger.warn(`save ${kind} for ${connectionToken(identity)} failed: ${error.message}`);
  }
}

export function getStoredPassword(identity: ConnectIdentity): Promise<string | undefined> {
  return getStoredSecret(SECRET_KEY_PREFIX_PASSWORD, identity, 'password');
}

export function offerToRememberPassword(identity: ConnectIdentity, password: string) {
  return offerToRememberSecret(
    SECRET_KEY_PREFIX_PASSWORD,
    identity,
    password,
    'password',
    l10n.t('Remember password for {0}?', connectionToken(identity)),
    l10n.t('Remember password')
  );
}

export function getStoredPassphrase(identity: ConnectIdentity): Promise<string | undefined> {
  return getStoredSecret(SECRET_KEY_PREFIX_PASSPHRASE, identity, 'passphrase');
}

export function offerToRememberPassphrase(identity: ConnectIdentity, passphrase: string) {
  return offerToRememberSecret(
    SECRET_KEY_PREFIX_PASSPHRASE,
    identity,
    passphrase,
    'passphrase',
    l10n.t('Remember passphrase for {0}?', connectionToken(identity)),
    l10n.t('Remember passphrase')
  );
}
