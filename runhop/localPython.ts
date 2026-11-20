import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { AdapterLaunch } from './adapter';
import { isLocalPathAtOrUnder } from './paths';
import { readSettings, scriptLaunchOptions, validateLaunchArguments } from './settings';

export const localLaunchKey = 'runhopLocal';
const exec = promisify(execFile);

interface PythonEnvironmentApi {
  environments?: {
    getActiveEnvironmentPath(resource: vscode.Uri): { path: string } | undefined;
  };
}

function selectedPython(folder: vscode.WorkspaceFolder): string | undefined {
  const extension = vscode.extensions.getExtension<PythonEnvironmentApi>('ms-python.python');
  if (extension?.isActive) {
    return extension.exports?.environments?.getActiveEnvironmentPath?.(folder.uri)?.path;
  }
}

function environmentPython(directory: string): string {
  return path.join(
    directory,
    ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'])
  );
}

async function configuredPython(workspace: string, value: string): Promise<string> {
  const expanded = value.replace(/\$\{workspaceFolder\}/g, () => workspace);
  const location = path.resolve(workspace, expanded);
  if (!(await stat(location).catch(() => undefined))?.isDirectory()) {
    return /[\\/]/.test(expanded) || path.isAbsolute(expanded) ? location : expanded;
  }
  if (process.platform === 'win32') {
    const condaPython = path.join(location, 'python.exe');
    if ((await stat(condaPython).catch(() => undefined))?.isFile()) return condaPython;
  }
  return environmentPython(location);
}

async function findPython(
  folder: vscode.WorkspaceFolder,
  cwd: string,
  configured: string | undefined,
  debug: boolean
): Promise<string> {
  const root = folder.uri.fsPath;
  const check = async (python: string) => {
    const { stdout } = await exec(python, ['--version'], {
      cwd,
      timeout: 5000,
      windowsHide: true,
    });
    const version = /^Python (\d+)\.(\d+)/m.exec(stdout);
    if (!version || Number(version[1]) !== 3) throw new Error('Python 3 is required.');
    return Number(version[2]);
  };
  const use = (python: string, minor: number) => {
    if (debug && minor < 8) {
      throw new Error('RunHop Debug requires Python 3.8 or later. Check ' + python + '.');
    }
    return python;
  };
  if (configured) {
    const python = await configuredPython(root, configured);
    try {
      return use(python, await check(python));
    } catch (error) {
      throw new Error('Cannot use local Python ' + python + '. ' + error.message);
    }
  }
  const preferred = vscode.workspace
    .getConfiguration('python', folder.uri)
    .inspect<string>('defaultInterpreterPath');
  const defaultPath =
    preferred?.workspaceFolderValue ?? preferred?.workspaceValue ?? preferred?.globalValue;
  const active = selectedPython(folder);
  const candidates = [
    active && (await configuredPython(root, active)),
    defaultPath && (await configuredPython(root, defaultPath)),
    ...['.venv', 'venv'].map(directory => environmentPython(path.join(root, directory))),
    process.env.VIRTUAL_ENV && environmentPython(process.env.VIRTUAL_ENV),
    process.env.CONDA_PREFIX && (await configuredPython(root, process.env.CONDA_PREFIX)),
    'python3',
    'python',
  ];
  for (const candidate of new Set(candidates)) {
    if (!candidate) continue;
    const minor = await check(candidate).catch(() => undefined);
    if (minor !== undefined) return use(candidate, minor);
  }
  throw new Error(
    'No local Python ' +
      (debug ? '3.8 or later' : '3') +
      ' was found. Set Local Interpreter in RunHop Configurations.'
  );
}

export async function resolveLocalPython(
  session: vscode.DebugSession,
  debug: boolean
): Promise<AdapterLaunch> {
  const folder = session.workspaceFolder;
  if (!vscode.workspace.isTrusted || folder?.uri.scheme !== 'file' || vscode.env.remoteName) {
    throw new Error('RunHop requires a trusted local workspace.');
  }
  const { program: file, runConfiguration, runhopSelectedFile } = session.configuration;
  if (
    [file, runConfiguration, runhopSelectedFile].some(
      value => value !== undefined && typeof value !== 'string'
    )
  ) {
    throw new Error('Select a local Python file or a saved RunHop configuration.');
  }
  const root = folder.uri.fsPath;
  const settings = await readSettings(root);
  const { program, module, options } = scriptLaunchOptions(
    settings,
    root,
    file && path.resolve(root, file),
    runConfiguration
  );
  if (options.runOn === 'remote') {
    throw new Error(
      'This configuration now runs on an SSH server. Start it from the RunHop toolbar.'
    );
  }
  if (runhopSelectedFile && (!program || path.relative(runhopSelectedFile, program) !== '')) {
    throw new Error('The saved RunHop configuration no longer points to the selected file.');
  }
  if (!program && !module) throw new Error('Select a Python script or module to run.');
  const unsaved = vscode.workspace.textDocuments.find(
    document =>
      document.isDirty &&
      document.uri.scheme === 'file' &&
      (document.uri.fsPath === program ||
        (document.languageId === 'python' && isLocalPathAtOrUnder(root, document.uri.fsPath)))
  );
  if (unsaved) {
    throw new Error(
      'Save ' + path.basename(unsaved.uri.fsPath) + ' before running or debugging with RunHop.'
    );
  }
  if (
    options.cwd !== undefined &&
    (typeof options.cwd !== 'string' || options.cwd.includes('\0'))
  ) {
    throw new Error('cwd must be a local working directory.');
  }
  validateLaunchArguments(options.args, options.env);
  const cwd = options.cwd ? path.resolve(root, options.cwd) : root;
  if (!(await stat(cwd).catch(() => undefined))?.isDirectory()) {
    throw new Error('Local working directory does not exist at ' + cwd + '.');
  }
  return {
    python: await findPython(folder, cwd, options.localPython, debug),
    cwd,
    program,
    module,
    args: options.args ?? [],
    env: options.env ?? {},
    justMyCode: options.justMyCode !== false,
    stopOnEntry: debug && options.stopOnEntry === true,
  };
}
