import type { DebugMessage } from './protocol';

export function breakpointKey(request: DebugMessage): string | undefined {
  if (request.command === 'setBreakpoints') {
    const source = request.arguments?.source as { path?: string; sourceReference?: number };
    return typeof source?.path === 'string'
      ? 'source:' + source.path
      : source?.sourceReference
        ? 'reference:' + source.sourceReference
        : undefined;
  }
  return [
    'setFunctionBreakpoints',
    'setExceptionBreakpoints',
    'setDataBreakpoints',
    'setInstructionBreakpoints',
  ].includes(request.command ?? '')
    ? request.command
    : undefined;
}

const exceptionCommand = 'setExceptionBreakpoints';

function filterOptions(args: DebugMessage['arguments']): { filterId: string }[] {
  return Array.isArray(args?.filterOptions) ? args.filterOptions : [];
}

export function exceptionFilterIds(args: DebugMessage['arguments']): Set<string> {
  return new Set([
    ...(Array.isArray(args?.filters) ? args.filters : []),
    ...filterOptions(args).map(option => option.filterId),
  ]);
}

export class BreakpointMute {
  private readonly settings = new Map<string, DebugMessage>();
  private muted = false;
  private pending = false;

  constructor(private readonly reapply: (request: DebugMessage, muted: boolean) => Promise<void>) {}

  track(request: DebugMessage): DebugMessage {
    const key = breakpointKey(request);
    if (!key) {
      return request;
    }
    this.settings.set(key, request);
    return this.effective(request);
  }

  isCurrent(request: DebugMessage): boolean {
    const key = breakpointKey(request);
    return Boolean(key && this.settings.get(key) === request);
  }

  async setExceptionFilter(filter: string, enabled: boolean): Promise<DebugMessage | undefined> {
    if (this.pending || this.muted) {
      throw new Error('Wait for the current breakpoint update or unmute this session.');
    }
    const previous = this.settings.get(exceptionCommand);
    if (!previous) {
      throw new Error('The debugger has not received the exception settings from VS Code.');
    }
    const args = previous.arguments;
    const plain = new Set<string>(Array.isArray(args?.filters) ? args.filters : []);
    if (enabled) {
      if (!exceptionFilterIds(args).has(filter)) plain.add(filter);
    } else {
      plain.delete(filter);
    }
    const request = {
      ...previous,
      arguments: {
        ...args,
        filters: [...plain],
        filterOptions: filterOptions(args).filter(option => enabled || option.filterId !== filter),
      },
    };
    this.pending = true;
    this.settings.set(exceptionCommand, request);
    try {
      await this.reapply(request, false);
      return this.isCurrent(request) ? request : undefined;
    } catch (error) {
      if (this.isCurrent(request)) {
        this.settings.set(exceptionCommand, previous);
        try {
          await this.reapply(previous, false);
        } catch {
          throw new Error(
            'The adapter could not confirm the exception settings. Restart the session to restore them.'
          );
        }
      }
      throw error;
    } finally {
      this.pending = false;
    }
  }

  private effective(request: DebugMessage): DebugMessage {
    if (!this.muted) {
      return request;
    }
    return {
      ...request,
      arguments: {
        ...request.arguments,
        ...(request.command === 'setExceptionBreakpoints'
          ? { filters: [], filterOptions: [], exceptionOptions: [] }
          : { breakpoints: [], ...(request.command === 'setBreakpoints' ? { lines: [] } : {}) }),
      },
    };
  }

  async setMuted(muted: boolean): Promise<void> {
    if (this.pending) {
      throw new Error('A breakpoint update is already in progress.');
    }
    if (this.muted === muted) {
      return;
    }
    this.pending = true;
    this.muted = muted;
    const apply = async () =>
      Promise.allSettled(
        [...this.settings.values()].map(request =>
          this.reapply(this.effective(request), this.muted)
        )
      );
    try {
      const result = await apply();
      if (result.some(reply => reply.status === 'rejected')) {
        this.muted = !muted;
        const rollback = await apply();
        throw new Error(
          rollback.some(reply => reply.status === 'rejected')
            ? 'The adapter could not confirm the breakpoint state. Restart the session to restore it.'
            : 'The adapter rejected the breakpoint update. The previous settings were restored.'
        );
      }
    } finally {
      this.pending = false;
    }
  }

  clear(): void {
    this.settings.clear();
  }
}
