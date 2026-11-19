import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const stage = path.join(root, 'dist', 'runhop-extension');
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const { scripts: _scripts, devDependencies: _devDependencies, jest: _jest, ...manifest } = metadata;
manifest.dependencies = { ssh2: lock.packages['node_modules/ssh2'].version };
const debuggerBundle = JSON.parse(
  await readFile(path.join(root, 'runhop', 'debugpy-release.json'), 'utf8')
);
const terminalRc = await readFile(path.join(root, 'runhop', 'remoteShell.sh'), 'utf8');
const runSupervisor = await readFile(path.join(root, 'runhop', 'runSupervisor.py'), 'utf8');
execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--noEmit'], {
  cwd: root,
  stdio: 'inherit',
});
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
for (const entry of ['.vscodeignore', 'LICENSE']) {
  await cp(path.join(root, entry), path.join(stage, entry), { recursive: true });
}
await mkdir(path.join(stage, 'schema'));
await cp(
  path.join(root, 'runhop', 'config.schema.json'),
  path.join(stage, 'schema', 'runhop.schema.json')
);
await mkdir(path.join(stage, 'resources'));
await cp(
  path.join(root, 'runhop', 'transport', 'LICENSE'),
  path.join(stage, 'resources', 'sftpresso-LICENSE.txt')
);
await cp(
  path.join(root, 'runhop', 'webview', 'server.svg'),
  path.join(stage, 'resources', 'server.svg')
);
const webview = path.join(root, 'runhop', 'webview');
execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: webview,
  stdio: 'inherit',
});
await esbuild.build({
  absWorkingDir: webview,
  entryPoints: ['terminal.js', 'breakpoints.js'],
  outdir: path.join(stage, 'resources'),
  platform: 'browser',
  bundle: true,
  minify: true,
  legalComments: 'eof',
  logLevel: 'info',
});
for (const [packageName, label] of [
  ['xterm', 'xterm'],
  ['addon-fit', 'xterm-addon-fit'],
]) {
  await cp(
    path.join(webview, 'node_modules', '@xterm', packageName, 'LICENSE'),
    path.join(stage, 'resources', label + '-LICENSE.txt')
  );
}
const bundleCache = path.join(root, 'dist', 'debugpy-' + debuggerBundle.sha256 + '.whl');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
let wheel = await readFile(bundleCache).catch(error => {
  if (error.code === 'ENOENT') {
    return undefined;
  }
  throw error;
});
if (!wheel || digest(wheel) !== debuggerBundle.sha256) {
  const response = await fetch(debuggerBundle.url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    throw new Error('Failed to fetch the bundled debugpy wheel (' + response.status + ').');
  }
  wheel = Buffer.from(await response.arrayBuffer());
  if (digest(wheel) !== debuggerBundle.sha256) {
    throw new Error('The bundled debugpy wheel does not match its pinned SHA-256 checksum.');
  }
  await writeFile(bundleCache, wheel);
}
await writeFile(path.join(stage, 'resources', 'debugpy.whl'), wheel);
await cp(path.join(root, 'README.md'), path.join(stage, 'README.md'));
await writeFile(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');

await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['runhop/extension.ts'],
  outfile: path.join(stage, 'dist', 'extension.js'),
  bundle: true,
  external: ['vscode', 'ssh2'],
  define: {
    RUNHOP_DEBUGPY_SHA256: JSON.stringify(debuggerBundle.sha256),
    RUNHOP_TERMINAL_RC: JSON.stringify(terminalRc),
    RUNHOP_RUN_SUPERVISOR: JSON.stringify(runSupervisor),
  },
  alias: { 'jsonc-parser': 'jsonc-parser/lib/esm/main.js' },
  platform: 'node',
  legalComments: 'eof',
  target: 'node22',
  format: 'cjs',
  logLevel: 'info',
});
execFileSync(
  'npm',
  [
    'install',
    '--omit=dev',
    '--omit=optional',
    '--ignore-scripts',
    '--no-save',
    '--no-package-lock',
    '--no-audit',
    '--no-fund',
  ],
  { cwd: stage, stdio: 'inherit' }
);

if (process.argv.includes('--package')) {
  execFileSync(
    process.execPath,
    [
      path.join(root, 'node_modules', '@vscode', 'vsce', 'vsce'),
      'package',
      '--out',
      path.join(root, 'dist', 'runhop-' + manifest.version + '.vsix'),
    ],
    { cwd: stage, stdio: 'inherit' }
  );
}
