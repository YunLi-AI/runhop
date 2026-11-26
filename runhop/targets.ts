import { mkdir, readFile, writeFile } from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import ignore from 'ignore';
import { FileService, ServiceConfig } from './transport/core';
import { backupDirSetting } from './transport/core/backup';
import { resolveConnection } from './transport/core/config';
import { isLocalPathAtOrUnder } from './paths';
import { Connection, isRecord, settingsFile } from './settings';

export async function connectSsh(service: FileService, config: ServiceConfig) {
  const fs = await service.getRemoteFileSystem(config);
  return { fs, client: fs.getClient() };
}

export async function configure(requestedFolder?: vscode.WorkspaceFolder): Promise<void> {
  const folders = vscode.workspace.workspaceFolders || [];
  const active = vscode.window.activeTextEditor?.document.uri;
  const folder =
    requestedFolder ||
    (active && vscode.workspace.getWorkspaceFolder(active)) ||
    (folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick());
  if (folder?.uri.scheme !== 'file') {
    return;
  }
  const workspace = folder.uri.fsPath;
  const file = path.join(workspace, settingsFile);
  try {
    await readFile(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    const targets = [
      {
        name: 'Development server',
        host: 'your-ssh-host',
        username: 'your-username',
        remotePath: '/home/your-username/project',
      },
    ];
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify(
        { targets, syncMode: 'incremental', uploadPolicy: 'safe', uploadOnSave: true },
        null,
        2
      ) + '\n',
      { flag: 'wx' }
    ).catch(error => {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    });
  }
  await vscode.window.showTextDocument(vscode.Uri.file(file));
}

interface ProjectTargetDefinition {
  raw: Connection;
  baseDir: string;
}

export function projectTargets(
  connections: Connection[],
  workspace: string
): ProjectTargetDefinition[] {
  return connections.flatMap(raw => {
    const context = typeof raw.context === 'string' ? raw.context : '';
    const baseDir = path.resolve(workspace, context);
    return isLocalPathAtOrUnder(workspace, baseDir) ? [{ raw, baseDir }] : [];
  });
}

export function matchingTargets(
  connections: Connection[],
  workspace: string,
  local: string,
  targetName?: string
): ProjectTargetDefinition[] {
  return projectTargets(connections, workspace)
    .filter(
      ({ raw, baseDir }) =>
        isLocalPathAtOrUnder(baseDir, local) && (!targetName || raw.name === targetName)
    )
    .sort((a, b) => b.baseDir.length - a.baseDir.length);
}

export interface RunHopTarget {
  service: FileService;
  config: ServiceConfig;
  ignoreDirectory(local: string): boolean;
}

export function resolveTarget(
  connections: Connection[],
  workspace: string,
  local: string,
  targetName?: string,
  requestedProfile?: string
): RunHopTarget {
  const matches = matchingTargets(connections, workspace, local, targetName);
  if (!matches.length) {
    throw new Error(
      targetName
        ? 'No RunHop target matches: ' + targetName
        : 'No RunHop target covers this program.'
    );
  }
  const { baseDir } = matches[0];
  if (matches[1]?.baseDir.length === baseDir.length) {
    throw new Error('Multiple RunHop targets cover this program. Select a named SSH target.');
  }
  return resolveProjectTarget(workspace, matches[0], requestedProfile);
}

export function resolveProjectTarget(
  workspace: string,
  { raw, baseDir }: ProjectTargetDefinition,
  requestedProfile?: string
): RunHopTarget {
  const { context: _context, name: _name, profiles, defaultProfile, ...connection } = raw;
  const selected = requestedProfile ?? defaultProfile;
  if (selected !== undefined && (typeof selected !== 'string' || !selected)) {
    throw new Error('The RunHop target defaultProfile must name a profile.');
  }
  let options = connection;
  if (selected) {
    const profile =
      isRecord(profiles) && Object.hasOwn(profiles, selected) ? profiles[selected] : undefined;
    if (!isRecord(profile)) {
      throw new Error('Unknown RunHop SSH profile: ' + selected);
    }
    options = { ...connection, ...profile };
    if (Array.isArray(connection.ignore) && Array.isArray(profile.ignore)) {
      options.ignore = [...connection.ignore, ...profile.ignore];
    }
  }
  const { config, patterns } = resolveConnection(options, workspace);
  const backupDir = backupDirSetting(config);
  if (backupDir) {
    const backup = path.resolve(baseDir, backupDir);
    const relative = path.relative(baseDir, backup).split(path.sep).join('/');
    if (relative && isLocalPathAtOrUnder(baseDir, backup)) {
      patterns.push('/' + relative + '/');
    }
  }
  const excluded = ignore().add(patterns);
  const isExcluded = (local: string, directory = false): boolean => {
    const relative = path.relative(baseDir, local).split(path.sep).join('/');
    return Boolean(
      relative &&
      isLocalPathAtOrUnder(baseDir, local) &&
      excluded.ignores(relative + (directory ? '/' : ''))
    );
  };
  return {
    service: new FileService(baseDir, workspace),
    config: { ...config, ignore: isExcluded },
    ignoreDirectory: local => isExcluded(local, true),
  };
}
