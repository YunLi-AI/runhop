import { globSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { glob, LineType, parse } from 'ssh-config';
import { replaceHomePath } from '../../paths';

const sshDirectory = path.join(homedir(), '.ssh');

function configurationFile(workspace: string, input?: string): string {
  return input
    ? path.resolve(workspace, replaceHomePath(input))
    : path.join(sshDirectory, 'config');
}

type ParsedConfiguration = ReturnType<typeof parse>;

function tokens(value: string | { val: string }[]): string[] {
  return typeof value === 'string' ? [value] : value.map(item => item.val);
}

export function readSshConfiguration(workspace: string, input?: string): ParsedConfiguration {
  const file = configurationFile(workspace, input);
  const stack = new Set<string>();
  let filesRead = 0;

  function load(entry: string, optional: boolean): ParsedConfiguration {
    let absolute: string;
    try {
      absolute = realpathSync(entry);
    } catch (error) {
      if (optional && error.code === 'ENOENT') return parse('');
      throw error;
    }
    if (stack.has(absolute)) return parse('');
    if (stack.size >= 12 || ++filesRead > 256) {
      throw new Error('Too many SSH configuration includes.');
    }
    const info = statSync(absolute);
    if (!info.isFile() || info.size > 1024 * 1024) {
      throw new Error('Expected an SSH configuration file under 1 MB.');
    }
    const config = parse(readFileSync(absolute));
    stack.add(absolute);
    try {
      for (let i = 0; i < config.length; i++) {
        const directive = config[i];
        if (directive.type !== LineType.DIRECTIVE || directive.param.toLowerCase() !== 'include') {
          continue;
        }
        const included = tokens(directive.value).flatMap(pattern =>
          globSync(path.resolve(sshDirectory, replaceHomePath(pattern)))
            .sort()
            .flatMap(match => load(match, true))
        );
        config.splice(i, 1, ...included);
        i += included.length - 1;
      }
      return config;
    } finally {
      stack.delete(absolute);
    }
  }

  try {
    return load(file, !input);
  } catch {
    throw new Error('Unable to read SSH configuration ' + file + '.');
  }
}

export function sshHostAliases(workspace: string, input?: string): string[] {
  const aliases = new Map<string, string>();
  for (const line of readSshConfiguration(workspace, input)) {
    if (line.type !== LineType.DIRECTIVE || line.param.toLowerCase() !== 'host') continue;
    const patterns = tokens(line.value);
    for (const alias of patterns) {
      if (/^[a-zA-Z0-9._:][a-zA-Z0-9._:%-]*$/.test(alias) && glob(patterns, alias)) {
        const key = alias.toLowerCase();
        if (!aliases.has(key)) aliases.set(key, alias);
      }
    }
  }
  return [...aliases.values()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
