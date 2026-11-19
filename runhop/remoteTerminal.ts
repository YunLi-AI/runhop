import * as path from 'path';
import { randomBytes } from 'crypto';
import { StringDecoder } from 'string_decoder';
import { stripVTControlCharacters } from 'util';
import * as vscode from 'vscode';
import { resolveRemotePath } from './debuggerHelper';
import { mapProjectPath, quoteShell } from './paths';
import { interpreterFor, readOptionalSettings, scriptLaunchOptions } from './settings';
import { openChannel } from './sshChannel';
import { connectSsh, resolveTarget } from './targets';
import { TerminalPanel } from './terminal';

declare const RUNHOP_TERMINAL_RC: string;

function shellCommand(python: string, cwd: string, token: string, conda?: string): string {
  const script = [
    'export RUNHOP_TERMINAL_PYTHON=' + quoteShell(python),
    'export RUNHOP_TERMINAL_CWD=' + quoteShell(cwd),
    'export RUNHOP_TERMINAL_TOKEN=' + quoteShell(token),
    'export RUNHOP_TERMINAL_CONDA=' + quoteShell(conda ?? ''),
    'export RUNHOP_TERMINAL_INIT=' + quoteShell(RUNHOP_TERMINAL_RC.trimEnd()),
    'runhop_login_shell="${SHELL:-/bin/bash}"',
    'case "$runhop_login_shell" in',
    '  /*/bash|/*/zsh) ;;',
    '  *) printf "[RunHop] Terminal activation requires a Bash or Zsh login shell. Current: %s\\n" "$runhop_login_shell" >&2; exit 1 ;;',
    'esac',
    'case "$RUNHOP_TERMINAL_PYTHON" in',
    '  /*) ;;',
    '  *) runhop_executable=$(command -v "$RUNHOP_TERMINAL_PYTHON") || {',
    '       printf "[RunHop] Cannot find the configured Python: %s\\n" "$RUNHOP_TERMINAL_PYTHON" >&2; exit 1;',
    '     }; export RUNHOP_TERMINAL_PYTHON="$runhop_executable" ;;',
    'esac',
    'stty -echo || exit 1',
    'exec "$runhop_login_shell" -il',
  ].join('\n');
  return 'exec /bin/sh -c ' + quoteShell(script);
}

export async function openServerTerminal(
  panel: TerminalPanel,
  resource?: vscode.Uri
): Promise<void> {
  const uri =
    resource instanceof vscode.Uri ? resource : vscode.window.activeTextEditor?.document.uri;
  let folder = uri?.scheme === 'file' ? vscode.workspace.getWorkspaceFolder(uri) : undefined;
  if (!vscode.workspace.isTrusted || vscode.env.remoteName) {
    throw new Error('RunHop requires a trusted local workspace.');
  }
  if (!folder) {
    const folders = vscode.workspace.workspaceFolders || [];
    folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
  }
  if (folder?.uri.scheme !== 'file') {
    return;
  }
  const workspace = folder.uri.fsPath;
  const settings = await readOptionalSettings(workspace);
  if (!settings?.targets.length) {
    await vscode.commands.executeCommand(
      'runhop.configurations',
      folder,
      { section: 'servers' },
      uri
    );
    return;
  }
  const file =
    uri?.scheme === 'file' &&
    vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() === folder.uri.toString()
      ? uri.fsPath
      : undefined;
  const { program, options } = scriptLaunchOptions(
    settings,
    workspace,
    file,
    settings.activeRunConfiguration
  );
  const interpreter = interpreterFor(settings, options.interpreter ?? settings.defaultInterpreter);
  const cwd = options.cwd ? path.resolve(workspace, options.cwd) : undefined;
  const { service, config } = resolveTarget(
    settings.targets,
    workspace,
    program || cwd || workspace,
    interpreter?.target,
    interpreter?.profile
  );
  const terminal = panel.create('SSH · ' + (settings.activeRunConfiguration || config.host), true);
  terminal.write('[RunHop] Opening SSH terminal on ' + config.host + '…\n');
  try {
    const { client } = await connectSsh(service, config);
    const remoteRoot = await resolveRemotePath(client, config.remotePath);
    const remoteCwd = mapProjectPath(cwd || service.baseDir, service.baseDir, remoteRoot);
    if (terminal.finished) {
      return;
    }
    const token = randomBytes(18).toString('hex');
    const marker = '\x1b]777;runhop:' + token + '\x07';
    const channel = await openChannel(
      client.getRawClient(),
      shellCommand(interpreter?.path || 'python3', remoteCwd, token, interpreter?.condaExecutable),
      true
    );
    const stdout = new StringDecoder('utf8');
    const stderr = new StringDecoder('utf8');
    let pending = '';
    let exitCode: number | undefined;
    let signal: string | undefined;
    let bootstrapTimer: NodeJS.Timeout | undefined;
    let bootstrapSent = false;
    let promptLine = '';
    const queueBootstrap = (delay: number) => {
      clearTimeout(bootstrapTimer);
      bootstrapTimer = setTimeout(() => {
        if (!terminal.finished && !bootstrapSent) {
          bootstrapSent = true;
          channel.write(' builtin eval "$RUNHOP_TERMINAL_INIT"\r');
        }
      }, delay);
    };
    const timer = setTimeout(() => {
      if (!terminal.finished && !terminal.ready) {
        terminal.write(
          '\n[RunHop] The login shell did not complete initialization within 30 seconds.\n'
        );
        channel.close();
      }
    }, 30_000);
    const output = (data: string) => {
      if (terminal.ready) {
        terminal.write(data, true);
        return;
      }
      if (!bootstrapSent) {
        promptLine = (promptLine + stripVTControlCharacters(data))
          .split(/[\r\n]/)
          .at(-1)!
          .slice(-256);
        queueBootstrap(promptLine.trim() ? 250 : 3000);
      }
      pending += data;
      const end = pending.indexOf(marker);
      if (end >= 0) {
        clearTimeout(timer);
        terminal.write(pending.slice(0, end) + pending.slice(end + marker.length), true);
        pending = '';
        terminal.markReady();
      } else if (pending.length >= marker.length) {
        const offset = pending.length - marker.length + 1;
        terminal.write(pending.slice(0, offset), true);
        pending = pending.slice(offset);
      }
    };
    channel.on('data', (data: Buffer) => output(stdout.write(data)));
    channel.stderr.on('data', (data: Buffer) => terminal.write(stderr.write(data), true));
    channel.on('error', (error: Error) => terminal.write('\n[RunHop] ' + error.message + '\n'));
    channel.on('exit', (code?: number, name?: string) => {
      exitCode = typeof code === 'number' ? code : undefined;
      signal = name;
    });
    channel.once('close', () => {
      clearTimeout(timer);
      clearTimeout(bootstrapTimer);
      bootstrapSent = true;
      output(stdout.end());
      terminal.write(pending + stderr.end(), true);
      const reason = signal
        ? ' by signal ' + signal
        : exitCode === undefined
          ? ' after the SSH connection was lost'
          : ' with exit code ' + exitCode;
      terminal.write(
        '\n[RunHop] ' +
          (terminal.ready ? 'SSH terminal closed' : 'Shell initialization ended') +
          reason +
          '.\n'
      );
      terminal.finish();
    });
    if (
      terminal.attach({
        input: data => channel.write(data),
        resize: (cols, rows) => channel.setWindow(rows, cols, 0, 0),
        close: () => {
          clearTimeout(timer);
          clearTimeout(bootstrapTimer);
          channel.close();
        },
      })
    ) {
      // Let the login shell reach its prompt before sending the fixed bootstrap command.
      // The idle fallback covers shells with an empty prompt.
      queueBootstrap(3000);
    }
  } catch (error) {
    terminal.write('\n[RunHop] ' + error.message + '\n');
    terminal.finish();
    throw error;
  }
}
