import type { ProviderRpcError } from '../types.js';

// ── EIP-1193 / JSON-RPC error codes ─────────────────────────────────────────

export const EIP1193_USER_REJECTED      = 4001;
export const EIP1193_UNAUTHORIZED       = 4100;
export const EIP1193_UNSUPPORTED_METHOD = 4200;
export const JSON_RPC_INTERNAL          = -32603;
export const JSON_RPC_METHOD_NOT_FOUND  = -32601;
export const JSON_RPC_INVALID_PARAMS    = -32602;

// ── Error factories ──────────────────────────────────────────────────────────

export function rpcError(code: number, message: string, data?: unknown): ProviderRpcError {
  const err = new Error(message) as ProviderRpcError;
  (err as { code: number }).code = code;
  if (data !== undefined) (err as { data: unknown }).data = data;
  return err;
}

export function beaconError(code: number, message: string): Error & { code: number } {
  const err = new Error(message) as Error & { code: number };
  err.code = code;
  return err;
}

export function isUserAbort(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes('aborted') || msg.includes('rejected') || msg.includes('dismiss');
  }
  return false;
}
