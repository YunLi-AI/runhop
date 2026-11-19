// Adapted from SFTPresso 1.42.0 (MIT).
// https://github.com/jmwerk/SFTPresso/blob/fda0e2e7341378e535f0336600127075c4d28758/src/core/fs/fileSystem.ts

import { Readable } from 'stream';
import * as fs from 'fs';

interface FileSystemError extends Error {
  code: string;
}

export const ERROR_MSG_STREAM_INTERRUPT = 'sftp.stream.interrupt';

export function isNotFoundError(error: any): boolean {
  return error?.code === 'ENOENT' || error?.code === 2;
}

export type FileHandle = unknown;

export enum FileType {
  Directory = 1,
  File,
  SymbolicLink,
  Unknown,
}

export interface FileOption {
  flags?: string;
  encoding?: string;
  mode?: number;
  autoClose?: boolean;
  fd?: FileHandle;
  // called as bytes stream through put(), with the cumulative number of
  // bytes transferred so far for this file.
  onProgress?: (transferred: number) => void;
}

export interface FileStats {
  type: FileType;
  mode: number;
  size: number;
  mtime: number;
  atime: number;
}

export type FileEntry = FileStats & {
  fspath: string;
  name: string;
};

// Structurally compatible with vscode.CancellationToken, so a TransferTask's
// real token can be passed straight through without this module depending on
// vscode.
export interface ParallelTransferToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface ParallelTransferOption {
  // total bytes to move, from the source-side stat -- required, since it's
  // what the chunk range is divided up over.
  size: number;
  // applied to the destination once it's open, put-side only.
  mode?: number;
  concurrency?: number;
  chunkSize?: number;
  onProgress?: (transferred: number) => void;
  token?: ParallelTransferToken;
}

export default abstract class FileSystem {
  static getFileTypecharacter(stat: fs.Stats): FileType {
    if (stat.isDirectory()) {
      return FileType.Directory;
    } else if (stat.isFile()) {
      return FileType.File;
    } else if (stat.isSymbolicLink()) {
      return FileType.SymbolicLink;
    } else {
      return FileType.Unknown;
    }
  }

  pathResolver: any;

  constructor(pathResolver: any) {
    this.pathResolver = pathResolver;
  }

  abstract readFile(path: string, option?: FileOption): Promise<string | Buffer>;
  abstract open(path: string, flags: string, mode?: number): Promise<FileHandle>;
  abstract close(fd: FileHandle): Promise<void>;
  abstract fstat(fd: FileHandle): Promise<FileStats>;
  /**
   * Change the file system timestamps of the object referenced by the supplied file descriptor.
   *
   * @abstract
   * @param {FileHandle} fd
   * @param {number} atime time in seconds
   * @param {number} mtime time in seconds
   * @returns {Promise<void>}
   * @memberof FileSystem
   */
  abstract futimes(fd: FileHandle, atime: number, mtime: number): Promise<void>;
  abstract get(path: string, option?: FileOption): Promise<Readable>;
  abstract put(input: Readable, path, option?: FileOption): Promise<void>;
  abstract mkdir(dir: string): Promise<void>;
  abstract ensureDir(dir: string): Promise<void>;
  abstract chmod(path: string, mode: number): Promise<void>;
  abstract list(dir: string): Promise<FileEntry[]>;
  abstract lstat(path: string): Promise<FileStats>;
  abstract unlink(path: string): Promise<void>;
  abstract rename(srcPath: string, destPath: string): Promise<void>;
  abstract renameAtomic(srcPath: string, destPath: string): Promise<void>;

  // Parallel-chunk transfer to/from a real local file, bypassing get()/put()'s
  // single-stream pipe. Only worth implementing where the protocol supports
  // pipelined positional reads/writes (SFTP); everything else keeps the
  // default here and falls back to the stream path.
  supportsParallelTransfer(): boolean {
    return false;
  }

  getToFile(remotePath: string, localPath: string, option: ParallelTransferOption): Promise<void> {
    throw new Error('getToFile is not supported by this file system');
  }

  putFromFile(
    localPath: string,
    remotePath: string,
    option: ParallelTransferOption
  ): Promise<void> {
    throw new Error('putFromFile is not supported by this file system');
  }

  static abortReadableStream(stream: Readable) {
    const err = new Error('Transfer Aborted') as FileSystemError;
    err.code = ERROR_MSG_STREAM_INTERRUPT;

    // don't do `stream.destroy(err)`! `sftp.ReadaStream` do not support `err` parameter in `destory` method.
    stream.emit('error', err);
    stream.destroy();
  }

  static isAbortedError(err: FileSystemError) {
    return err.code === ERROR_MSG_STREAM_INTERRUPT;
  }
}
