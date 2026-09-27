/**
 * What every operation returns. The core never throws for an expected outcome and
 * never formats prose: adapters turn a `Result` into MCP, CLI output or HTTP.
 */

export type ErrorCode =
  | 'not_found'
  | 'invalid'
  | 'forbidden'
  | 'conflict'
  | 'too_large'
  | 'ambiguous'
  | 'unavailable';

export type Result<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'err'; code: ErrorCode; message: string; detail?: unknown }
  | { kind: 'requires_confirmation'; message: string; affects: unknown };

export const ok = <T>(value: T): Result<T> => ({ kind: 'ok', value });

export const err = <T = never>(code: ErrorCode, message: string, detail?: unknown): Result<T> =>
  ({ kind: 'err', code, message, ...(detail === undefined ? {} : { detail }) });

export const confirm = <T = never>(message: string, affects: unknown): Result<T> =>
  ({ kind: 'requires_confirmation', message, affects });
