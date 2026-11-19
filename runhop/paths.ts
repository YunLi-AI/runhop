import * as path from 'path';
import { homedir } from 'node:os';

export function isLocalPathAtOrUnder(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

export function replaceHomePath(value: string): string {
  return value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value;
}

export function quoteShell(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

export function mapProjectPath(local: string, localRoot: string, remoteRoot: string): string {
  if (!isLocalPathAtOrUnder(localRoot, local)) {
    throw new Error('The program and working directory must be inside the SFTP project.');
  }
  return path.posix.join(remoteRoot, ...path.relative(localRoot, local).split(path.sep));
}

export function artifactPath(relative: string): string {
  if (!relative || /[\\:\0]/.test(relative) || path.posix.isAbsolute(relative)) {
    throw new Error('Download paths must be relative to the remote project.');
  }
  const target = path.posix.normalize(relative).replace(/\/+$/, '');
  if (target === '.' || target === '..' || target.startsWith('../')) {
    throw new Error('Download paths must point to files or folders inside the remote project.');
  }
  return target;
}
