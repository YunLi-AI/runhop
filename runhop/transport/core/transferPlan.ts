import { ContentHasher } from './contentHash';
import { FileEntry, FileStats, FileSystem, FileType, isNotFoundError } from './fs';
import TransferTask, { TransferDirection, TransferOption } from './transferTask';
import { createLimiter } from '../utils';

type PlanOption = Omit<TransferOption, 'mtime' | 'atime'> & { maxFileSize?: number };
interface TransferPlan {
  srcFs: FileSystem;
  srcFsPath: string;
  targetFs: FileSystem;
  targetFsPath: string;
  transferDirection: TransferDirection;
  walkConcurrency: number;
  transferOption: PlanOption;
  token: { isCancelled(): boolean };
  skipped?: { fsPath: string; size: number }[];
  hasher?: ContentHasher;
  listSource?(directory: string): Promise<FileEntry[]>;
}

export { TransferDirection };

export async function planTransfer(
  plan: TransferPlan,
  enqueue: (task: TransferTask) => void
): Promise<void> {
  const { srcFs, targetFs, transferDirection, hasher, token, skipped, transferOption } = plan;
  const { maxFileSize, dirPerm } = transferOption;
  const limited = createLimiter(plan.walkConcurrency);
  const active = () => !token.isCancelled();

  function queue(source: string, target: string, stat: FileStats, existing?: FileStats): void {
    enqueue(
      new TransferTask(
        { fsPath: source, fileSystem: srcFs },
        { fsPath: target, fileSystem: targetFs },
        {
          transferDirection,
          transferOption: {
            ...transferOption,
            size: stat.size,
            atime: stat.atime,
            mtime: stat.mtime,
            fallbackMode: stat.mode & 0o777,
            mode: transferOption.perserveTargetMode ? existing?.mode : undefined,
          },
        }
      )
    );
  }

  function eligible(source: string, item: FileStats): boolean {
    if (item.type !== FileType.File && item.type !== FileType.Directory) {
      return false;
    }
    if (item.type === FileType.File && maxFileSize && item.size > maxFileSize * 1024 * 1024) {
      skipped?.push({ fsPath: source, size: item.size });
      return false;
    }
    return true;
  }

  function ensureDirectory(directory: string): Promise<void> {
    return limited(async () => {
      if (!active()) {
        return;
      }
      await targetFs.ensureDir(directory);
      if (dirPerm) {
        await targetFs.chmod(directory, parseInt(String(dirPerm), 8));
      }
    });
  }

  async function walk(source: string, target: string, compare: boolean): Promise<void> {
    if (!active()) {
      return;
    }
    const children = await limited(() => plan.listSource?.(source) ?? srcFs.list(source));
    await ensureDirectory(target);
    if (!active()) {
      return;
    }
    const destination = compare ? await limited(() => targetFs.list(target)) : [];
    const existing = new Map(destination.map(item => [item.name, item]));
    const toCompare: { from: FileEntry; to: FileEntry }[] = [];
    const subdirectories: { from: string; to: string; compare: boolean }[] = [];
    for (const item of children) {
      if (!eligible(item.fspath, item)) {
        continue;
      }
      const previous = existing.get(item.name);
      const next = targetFs.pathResolver.join(target, item.name);
      if (previous && previous.type !== item.type) {
        throw new Error('The destination has a different file type: ' + next);
      }
      if (item.type === FileType.Directory) {
        subdirectories.push({ from: item.fspath, to: next, compare: Boolean(previous) });
      } else if (previous && previous.size === item.size) {
        toCompare.push({ from: item, to: previous });
      } else {
        queue(item.fspath, next, item, previous);
      }
    }
    if (toCompare.length && active()) {
      const differences = await hasher!.contentDiffers(
        toCompare.map(({ from, to }) => [
          { fs: srcFs, entry: from },
          { fs: targetFs, entry: to },
        ])
      );
      for (const [index, result] of differences.entries()) {
        if (result instanceof Error) {
          throw result;
        }
        if (result && active()) {
          const { from, to } = toCompare[index];
          queue(from.fspath, to.fspath, from, to);
        }
      }
    }
    const results = await Promise.allSettled(
      subdirectories.map(({ from, to, compare }) => walk(from, to, compare))
    );
    const failed = results.find(result => result.status === 'rejected');
    if (failed) {
      throw failed.reason;
    }
  }

  const stat = await srcFs.lstat(plan.srcFsPath);
  if (!eligible(plan.srcFsPath, stat)) {
    return;
  }
  if (stat.type === FileType.Directory) {
    const compare = Boolean(hasher);
    if (compare) {
      try {
        if ((await targetFs.lstat(plan.targetFsPath)).type === FileType.SymbolicLink) {
          throw new Error('Project transfers skip symbolic links: ' + plan.targetFsPath);
        }
      } catch (error) {
        if (!isNotFoundError(error)) {
          throw error;
        }
      }
    }
    await walk(plan.srcFsPath, plan.targetFsPath, compare);
  } else if (active()) {
    await ensureDirectory(targetFs.pathResolver.dirname(plan.targetFsPath));
    if (active()) {
      queue(plan.srcFsPath, plan.targetFsPath, stat);
    }
  }
}
