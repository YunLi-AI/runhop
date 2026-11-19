// Adapted from SFTPresso 1.42.0 (MIT).
// https://github.com/jmwerk/SFTPresso/blob/fda0e2e7341378e535f0336600127075c4d28758/src/core/scheduler.ts

// modified from https://raw.githubusercontent.com/sindresorhus/p-queue/a202b25d3e2f8d0472f85d501f7f558a7fa89b56/index.js

import { EventEmitter } from 'events';

export interface Task {
  run(): unknown | Promise<unknown>;
}

const EVENT_TASK_START = 'task.start';
const EVENT_TASK_DONE = 'task.done';
const EVENT_IDLE = 'idle';

class Scheduler {
  private _queue: Task[] = [];
  private _pendingCount: number = 0;
  private _eventEmitter: EventEmitter = new EventEmitter();
  private _concurrency: number;
  private _isPaused: boolean;

  constructor(opts: { concurrency?: number; autoStart?: boolean } = {}) {
    opts = Object.assign(
      {
        concurrency: Infinity,
        autoStart: true,
      },
      opts
    );

    if (!(typeof opts.concurrency === 'number' && opts.concurrency >= 1)) {
      throw new TypeError(
        `Expected \`concurrency\` to be a number from 1 and up, got \`${
          opts.concurrency
        }\` (${typeof opts.concurrency})`
      );
    }

    this._concurrency = opts.concurrency;
    this._isPaused = opts.autoStart === false;
  }

  add(task: Task) {
    if (!this._isPaused && this._pendingCount < this._concurrency) {
      this._runTask(task);
    } else {
      this._queue.push(task);
    }
  }

  start() {
    if (!this._isPaused) {
      return;
    }

    this._isPaused = false;
    while (this.size > 0 && this._pendingCount < this._concurrency) {
      this._runTask(this._queue.shift()!);
    }
  }

  empty() {
    this._queue.length = 0;
  }

  onTaskStart(listener: (task: Task) => void) {
    this._eventEmitter.on(EVENT_TASK_START, listener);
  }

  onTaskDone(listener: (err: Error | null, task: Task) => void) {
    this._eventEmitter.on(EVENT_TASK_DONE, listener);
  }

  onIdle(listener: () => void) {
    this._eventEmitter.on(EVENT_IDLE, listener);
  }

  get size() {
    return this._queue.length;
  }

  get pendingCount() {
    return this._pendingCount;
  }

  private _next() {
    if (this.size > 0) {
      if (!this._isPaused) {
        this._runTask(this._queue.shift()!);
      }
    } else if (this._pendingCount <= 0) {
      this._eventEmitter.emit(EVENT_IDLE);
    }
  }

  private async _runTask(task: Task) {
    this._pendingCount += 1;
    this._eventEmitter.emit(EVENT_TASK_START, task);

    let error = null;
    try {
      await task.run();
    } catch (err) {
      error = err;
    } finally {
      this._pendingCount -= 1;
      this._eventEmitter.emit(EVENT_TASK_DONE, error, task);
      this._next();
    }
  }
}

export default Scheduler;
