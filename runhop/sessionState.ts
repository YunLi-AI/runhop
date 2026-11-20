export type FinalPhase = 'Exited' | 'Failed' | 'Disconnected';
export const rerunTokenKey = '__runhopRerunToken';
export type SessionPhase =
  'Starting' | 'Running' | 'Paused' | 'Exception' | 'Stopping' | FinalPhase;

export interface Outcome {
  phase: FinalPhase;
  code?: number;
  detail?: string;
}

export interface Execution {
  id: string;
  workspace?: string;
  host?: string;
  python?: string;
  program?: string;
  cwd?: string;
  configurationFile?: string;
  stop?: () => Promise<void>;
  input?: (line: string | null) => void;
  rerun?: (token: string) => Promise<void>;
}

export function exitOutcome(code: number, stopping = false): Outcome {
  return { phase: code === 0 || stopping ? 'Exited' : 'Failed', code };
}

export function formatPhase(phase: SessionPhase, code?: number): string {
  return code === undefined ? phase : phase + ' (' + code + ')';
}
