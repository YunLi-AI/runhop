import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { resolveConnection } from '../transport/core/config';
import { sshHostAliases } from '../transport/core/sshConfiguration';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'runhop-ssh-aliases-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

test('lists distinct usable OpenSSH aliases without patterns or running Match exec', () => {
  const marker = path.join(workspace, 'command-was-run');
  writeFileSync(
    path.join(workspace, 'custom.conf'),
    [
      'Host compute2 compute10 *.lab blocked !blocked',
      '  HostName example.test',
      'Host Compute2 backup',
      '  HostName another.test',
      'Match exec "touch ' + marker + '"',
      '  User tester',
      '',
    ].join('\n')
  );
  expect(sshHostAliases(workspace, 'custom.conf')).toEqual(['backup', 'compute2', 'compute10']);
  expect(existsSync(marker)).toBe(false);
});

test('uses the same included alias in the picker and when resolving a connection', () => {
  const included = path.join(workspace, 'hosts');
  mkdirSync(included);
  writeFileSync(
    path.join(workspace, 'main.conf'),
    `Include "${included}/*.conf"\nHost *\n Port 22\n`
  );
  writeFileSync(
    path.join(included, 'cluster.conf'),
    'Host cluster\n HostName login.example.test\n Port 2200\n User scientist\n'
  );
  expect(sshHostAliases(workspace, 'main.conf')).toEqual(['cluster']);
  const { config } = resolveConnection({ host: 'cluster', sshConfigPath: 'main.conf' }, workspace);
  expect(config).toMatchObject({ host: 'login.example.test', username: 'scientist', port: 2200 });
});

test('handles recursive includes and distinguishes missing custom configuration files', () => {
  writeFileSync(
    path.join(workspace, 'recursive.conf'),
    `Include "${workspace}/recursive.conf"\nHost intact\n User tester\n`
  );
  expect(sshHostAliases(workspace, 'recursive.conf')).toEqual(['intact']);
  expect(() => sshHostAliases(workspace, 'missing.conf')).toThrow(
    'Unable to read SSH configuration'
  );
});
