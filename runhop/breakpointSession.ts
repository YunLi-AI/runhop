import { breakpointKey, exceptionFilterIds } from './breakpointMute';
import type { DebugMessage } from './protocol';

export interface BreakpointStatus {
  id?: number;
  verified: boolean;
  line?: number;
  message?: string;
}

type Properties = { condition?: string; hitCondition?: string; logMessage?: string };
type SourcePoint = Properties & { line: number; column?: number };
type FunctionPoint = Properties & { name: string };
type ResolvedPoint = { requested: SourcePoint | FunctionPoint; status: BreakpointStatus };

function sameProperties(a: Properties, b: Properties): boolean {
  return (
    (a.condition ?? '') === (b.condition ?? '') &&
    (a.hitCondition ?? '') === (b.hitCondition ?? '') &&
    (a.logMessage ?? '') === (b.logMessage ?? '')
  );
}

export class BreakpointSession {
  private readonly pending = new Map<number, DebugMessage>();
  private readonly latest = new Map<string, number>();
  private readonly resolved = new Map<string, ResolvedPoint[]>();

  exceptions?: Set<string>;
  exceptionOverride = false;

  request(message: DebugMessage): boolean {
    const key = breakpointKey(message);
    if (!key) return false;
    const previous = this.latest.get(key);
    if (previous !== undefined) this.pending.delete(previous);
    this.latest.set(key, message.seq);
    this.pending.set(message.seq, message);
    return this.resolved.delete(key);
  }

  response(message: DebugMessage): boolean {
    if (message.request_seq === undefined) return false;
    const request = this.pending.get(message.request_seq);
    if (!request) return false;
    this.pending.delete(request.seq);
    return Boolean(message.success && this.accept(request, message.body?.breakpoints));
  }

  accept(request: DebugMessage, result: unknown, exceptionOverride = false): boolean {
    const key = breakpointKey(request);
    if (!key || this.latest.get(key) !== request.seq) return false;
    if (request.command === 'setExceptionBreakpoints') {
      this.exceptions = exceptionFilterIds(request.arguments);
      this.exceptionOverride = exceptionOverride;
      return true;
    }

    const input = request.arguments?.breakpoints;
    if (Array.isArray(input) && Array.isArray(result)) {
      this.resolved.set(
        key,
        input.flatMap((requested, i) =>
          result[i] && typeof result[i].verified === 'boolean'
            ? [{ requested, status: result[i] }]
            : []
        )
      );
      return true;
    }
    return false;
  }

  event(reason: unknown, status?: BreakpointStatus): boolean {
    if (status?.id === undefined) return false;
    let changed = false;
    for (const points of this.resolved.values()) {
      for (let i = points.length - 1; i >= 0; i--) {
        if (points[i].status.id !== status.id) continue;
        if (reason === 'removed') points.splice(i, 1);
        else points[i].status = { ...points[i].status, ...status };
        changed = true;
      }
    }
    return changed;
  }

  source(file: string, line: number, column: number, properties: Properties) {
    const matches = (this.resolved.get('source:' + file) ?? []).filter(
      ({ requested }) =>
        'line' in requested && requested.line === line && sameProperties(requested, properties)
    );
    return (
      matches.find(({ requested }) => 'column' in requested && requested.column === column)
        ?.status ??
      (matches.length === 1 && !('column' in matches[0].requested) ? matches[0].status : undefined)
    );
  }

  function(name: string, properties: Properties) {
    return this.resolved
      .get('setFunctionBreakpoints')
      ?.find(
        ({ requested }) =>
          'name' in requested && requested.name === name && sameProperties(requested, properties)
      )?.status;
  }

  clear(): void {
    this.pending.clear();
    this.latest.clear();
    this.resolved.clear();
    this.exceptions = undefined;
    this.exceptionOverride = false;
  }
}
