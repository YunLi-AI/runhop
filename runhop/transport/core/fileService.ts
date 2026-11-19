// Contains file operations adapted from SFTPresso 1.42.0 (MIT).
// https://github.com/jmwerk/SFTPresso/blob/fda0e2e7341378e535f0336600127075c4d28758/src/core/fileService.ts

import { EventEmitter } from 'node:events';
import logger from '../logger';
import { connectionIdentity } from './connectionIdentity';
import type { RetryOption, ServiceConfig } from './config';
import localFs from './localFs';
import { createRemoteIfNoneExist } from './remoteFs';
import Scheduler, { Task } from './scheduler';
import TransferTask, { isRetryable } from './transferTask';

interface TransferScheduler {
  add(task: TransferTask): void;
  run(): Promise<void>;
  stop(): void;
  isStopped(): boolean;
}

interface ScheduledTransfer extends Task {
  transferTask: TransferTask;
}

export default class FileService {
  private readonly events = new EventEmitter();
  private readonly pending = new Set<TransferTask>();
  constructor(
    readonly baseDir: string,
    readonly workspace: string
  ) {}

  getPendingTransferTasks(): TransferTask[] {
    return Array.from(this.pending);
  }

  afterTransfer(listener: (error: Error | null, task: TransferTask) => void): () => void {
    this.events.on('finished', listener);
    return () => this.events.off('finished', listener);
  }

  createTransferScheduler(
    concurrency: number,
    retryOption: RetryOption,
    stallTimeout: number,
    config: ServiceConfig
  ): TransferScheduler {
    const service = this;
    const { attempts: maxRetries, delay: retryBaseDelay } = retryOption;
    const active = new Set<TransferTask>();
    const scheduler = new Scheduler({
      autoStart: false,
      concurrency,
    });

    // tasks waiting out their backoff, with the failure that put them there.
    // They are in neither the queue nor the pending set, so the scheduler can go
    // idle while they wait -- we hold the run() promise open for them instead.
    const retryTimers = new Map<
      TransferTask,
      { timer: ReturnType<typeof setTimeout>; error: Error }
    >();

    const unwrapTask = (task: Task): TransferTask => (task as ScheduledTransfer).transferTask;
    const queueTask = (transferTask: TransferTask) => {
      const task: ScheduledTransfer = {
        transferTask,
        run: () => transferTask.run(),
      };
      scheduler.add(task);
    };

    scheduler.onTaskStart(task => {
      const transferTask = unwrapTask(task);
      // emitted synchronously before run(), so the task is armed in time
      transferTask.stallTimeout = stallTimeout;
      active.add(transferTask);
      this.pending.add(transferTask);
    });
    scheduler.onTaskDone((err, task) => {
      const transferTask = unwrapTask(task);
      active.delete(transferTask);
      this.pending.delete(transferTask);

      if (
        err &&
        !isStopped &&
        !transferTask.isCancelled() &&
        transferTask.attempts < maxRetries &&
        isRetryable(err)
      ) {
        transferTask.reset();
        transferTask.attempts += 1;
        const delay = Math.min(retryBaseDelay * 2 ** transferTask.attempts, 15_000);
        logger.warn(
          `${transferTask.transferType} ${transferTask.localFsPath} failed` +
            ` (${err.message}), retrying in ${delay}ms` +
            ` (attempt ${transferTask.attempts} of ${maxRetries})`
        );
        const timer = setTimeout(async () => {
          let freshFs;
          try {
            freshFs = await service.getRemoteFileSystem(config);
          } catch (reconnectError) {
            if (isStopped) {
              finishRun();
              return;
            }
            retryTimers.delete(transferTask);
            logger.warn(
              `${transferTask.transferType} ${transferTask.localFsPath} retry` +
                ` aborted: reconnect failed (${reconnectError.message})`
            );
            service.events.emit('finished', reconnectError, transferTask);
            transferTask.dispose();
            finishRun();
            return;
          }
          if (isStopped) {
            finishRun();
            return;
          }
          retryTimers.delete(transferTask);
          transferTask.refreshRemoteFs(freshFs);
          queueTask(transferTask);
        }, delay);
        retryTimers.set(transferTask, { timer, error: err });
        return;
      }

      this.events.emit('finished', err, transferTask);
      transferTask.dispose();
    });

    let runningPromise: Promise<void> | null = null;
    let resolveRunning: (() => void) | null = null;
    let isStopped: boolean = false;

    // settle run(), but only once every task (including ones sitting in a
    // backoff) is accounted for
    function finishRun() {
      if (
        !resolveRunning ||
        retryTimers.size > 0 ||
        scheduler.pendingCount > 0 ||
        scheduler.size > 0
      ) {
        return;
      }

      const resolve = resolveRunning;
      resolveRunning = null;
      runningPromise = null;
      resolve();
    }

    const transferScheduler: TransferScheduler = {
      stop() {
        isStopped = true;
        // Cancel both running transfers and those waiting to retry.
        const abandoned = Array.from(retryTimers.entries());
        retryTimers.clear();
        active.forEach(task => task.cancel());
        abandoned.forEach(([task, { timer, error }]) => {
          clearTimeout(timer);
          task.cancel();
          service.events.emit('finished', error, task);
          task.dispose();
        });
        scheduler.empty();
        if (scheduler.pendingCount <= 0) {
          finishRun();
        }
      },
      isStopped() {
        return isStopped;
      },
      add(task: TransferTask) {
        if (!isStopped) {
          queueTask(task);
        }
      },
      run() {
        if (isStopped) {
          return Promise.resolve();
        }

        if (scheduler.size <= 0) {
          return Promise.resolve();
        }

        if (!runningPromise) {
          runningPromise = new Promise(resolve => {
            resolveRunning = resolve;
            scheduler.onIdle(finishRun);
            scheduler.start();
          });
        }
        return runningPromise;
      },
    };

    return transferScheduler;
  }

  getLocalFileSystem() {
    return localFs;
  }

  getConnectionId(config: ServiceConfig): string {
    return connectionIdentity(config.connection);
  }

  getRemoteFileSystem(config: ServiceConfig) {
    return createRemoteIfNoneExist(config);
  }
}
