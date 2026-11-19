import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as sshConfig from 'ssh-config';
import Joi from 'joi';
import { replaceHomePath } from '../../paths';
import type { ConnectOption } from './remote-client';

export interface RetryOption {
  attempts: number;
  delay: number;
}

export interface ServiceConfig {
  host: string;
  username: string;
  port: number;
  connectTimeout: number;
  remotePath: string;
  privateKeyPath?: string;
  agent?: string;
  hop?: ConnectOption | ConnectOption[];
  concurrency: number;
  retry: RetryOption;
  idleTimeout: number;
  operationTimeout: number;
  stallTimeout: number;
  remoteTimeOffsetInHours: number;
  transferMode: 'auto' | 'parallel' | 'stream';
  filePerm?: number;
  dirPerm?: number;
  maxFileSize?: number;
  backup?: boolean | { dir?: string; keep?: number } | null;
  openSsh: boolean;
  connection: ConnectOption;
  ignore(local: string): boolean;
}

const nonNegative = Joi.number().integer().min(0);
const string = Joi.string();
const authentication = {
  username: string,
  port: Joi.number().port(),
  password: string,
  agent: string,
  privateKeyPath: string,
  passphrase: Joi.alternatives().try(Joi.valid(true), string),
  interactiveAuth: Joi.alternatives().try(Joi.boolean(), Joi.array().items(string)),
  algorithms: Joi.object(),
  connectTimeout: nonNegative,
  keepaliveInterval: nonNegative,
  keepaliveCountMax: nonNegative,
  limitOpenFilesOnRemote: Joi.alternatives().try(Joi.boolean(), nonNegative),
  strictHostKeyChecking: Joi.alternatives().try(Joi.boolean(), Joi.valid('ask', 'accept-new')),
};
const hopSchema = Joi.object({
  ...authentication,
  host: string.required(),
  port: authentication.port.default(22),
});
const schema = Joi.object({
  ...authentication,
  host: string.required(),
  sshConfigPath: string,
  remotePath: string.default('.'),
  hop: Joi.alternatives().try(hopSchema, Joi.array().items(hopSchema)),
  concurrency: nonNegative.min(1).default(4),
  retry: Joi.object({ attempts: nonNegative.default(2), delay: nonNegative.default(1000) }).default(
    () => ({ attempts: 2, delay: 1000 })
  ),
  idleTimeout: nonNegative.default(0),
  operationTimeout: nonNegative.default(60_000),
  stallTimeout: nonNegative.default(30_000),
  remoteTimeOffsetInHours: Joi.number().default(0),
  transferMode: Joi.valid('auto', 'parallel', 'stream').default('auto'),
  filePerm: nonNegative,
  dirPerm: nonNegative,
  maxFileSize: nonNegative,
  backup: Joi.alternatives()
    .try(Joi.boolean(), Joi.object({ dir: string, keep: nonNegative }))
    .allow(null),
  openSsh: Joi.boolean().default(false),
  ignore: Joi.array().items(string.allow('')).default([]),
  ignoreFile: string,
});

function sshDefaults(host: string, file: string, optional: boolean) {
  try {
    return sshConfig.parse(readFileSync(file, 'utf8')).compute(host, { ignoreCase: true });
  } catch (error) {
    if (optional && error.code === 'ENOENT') {
      return {};
    }
    throw new Error('Unable to read SSH configuration ' + file + ': ' + error.message);
  }
}

function toMilliseconds(value: unknown): number | undefined {
  const number = typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 1000) : undefined;
}

function agentSocket(value?: string): string | undefined {
  if (!value?.startsWith('$')) {
    return value && replaceHomePath(value);
  }
  const socket = process.env[value.slice(1)];
  if (!socket) {
    throw new Error('SSH agent environment variable ' + value + ' is unset.');
  }
  return socket;
}

export function resolveConnection(
  options: Record<string, unknown>,
  workspace: string
): { config: Omit<ServiceConfig, 'ignore'>; patterns: string[] } {
  const { error, value } = schema.validate(options);
  if (error) {
    throw new Error('Invalid RunHop SSH target: ' + error.message);
  }
  const sshFile = value.sshConfigPath
    ? path.resolve(workspace, replaceHomePath(value.sshConfigPath))
    : replaceHomePath('~/.ssh/config');
  const ssh = sshDefaults(value.host, sshFile, !value.sshConfigPath);
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const host = first(ssh.hostname) ?? value.host;
  const username = value.username ?? first(ssh.user);
  const port = value.port ?? Number(first(ssh.port) ?? 22);
  if (!username || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('RunHop SSH target ' + host + ' requires a username and valid port.');
  }

  const privateKey = value.privateKeyPath ?? first(ssh.identityfile);
  const privateKeyPath = privateKey && path.resolve(workspace, replaceHomePath(privateKey));
  const agent = agentSocket(value.agent);
  const connectTimeout =
    value.connectTimeout ?? toMilliseconds(first(ssh.connecttimeout)) ?? 10_000;
  const auth = Object.fromEntries(
    Object.keys(authentication).flatMap(key =>
      value[key] === undefined ? [] : [[key, value[key]]]
    )
  );
  const connection: ConnectOption = {
    ...auth,
    host,
    port,
    username,
    privateKeyPath,
    agent,
    connectTimeout,
    keepaliveInterval: value.keepaliveInterval ?? toMilliseconds(first(ssh.serveraliveinterval)),
    hop: value.hop,
  };
  const { ignore, ignoreFile, ...rest } = value;
  const patterns = [...ignore];
  if (ignoreFile) {
    patterns.push(
      ...readFileSync(path.resolve(workspace, replaceHomePath(ignoreFile)), 'utf8').split(/\r?\n/)
    );
  }
  return {
    config: {
      ...rest,
      host,
      username,
      port,
      privateKeyPath,
      agent,
      connectTimeout,
      remotePath: path.posix.normalize(value.remotePath),
      connection,
    },
    patterns,
  };
}
