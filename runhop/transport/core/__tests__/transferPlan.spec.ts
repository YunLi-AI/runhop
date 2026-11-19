import { ContentHasher } from '../contentHash';
import { planTransfer, TransferDirection } from '../transferPlan';
import TransferTask from '../transferTask';
import MemFs from './helpers/memFs';

test('a project deployment queues changed and new files and preserves remote-only files', async () => {
  const local = new MemFs('/local')
    .file('/local/same.py', 'same')
    .file('/local/changed.py', 'after!')
    .dir('/local/sub')
    .file('/local/sub/new.py', 'new');
  const remote = new MemFs('/remote')
    .file('/remote/same.py', 'same')
    .file('/remote/changed.py', 'before')
    .file('/remote/keep.py', 'remote-only');
  const tasks: TransferTask[] = [];
  await planTransfer(
    {
      srcFs: local,
      srcFsPath: '/local',
      targetFs: remote,
      targetFsPath: '/remote',
      transferDirection: TransferDirection.LOCAL_TO_REMOTE,
      walkConcurrency: 2,
      hasher: new ContentHasher(),
      transferOption: { perserveTargetMode: true },
      token: { isCancelled: () => false },
    },
    task => tasks.push(task)
  );
  expect(tasks.map(task => task.targetFsPath).sort()).toEqual([
    '/remote/changed.py',
    '/remote/sub/new.py',
  ]);
  await expect(remote.lstat('/remote/keep.py')).resolves.toMatchObject({ size: 11 });
});
