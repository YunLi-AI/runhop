import { execFile, spawn, type ChildProcess } from 'node:child_process';
import type { PythonLaunch } from './adapter';

export function spawnPython(plan: PythonLaunch, args: string[], debugAdapter = false) {
  return spawn(plan.python, args, {
    cwd: plan.cwd,
    env: debugAdapter ? process.env : { ...process.env, ...plan.env },
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function stopLocalProcess(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    execFile('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, error => {
      if (error && child.exitCode === null && child.signalCode === null) child.kill();
    });
    return;
  }
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      return false;
    }
  };
  if (signalGroup('SIGTERM')) {
    setTimeout(() => signalGroup('SIGKILL'), 1000).unref();
  }
}
