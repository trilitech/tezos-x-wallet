/** Converts a 0x-prefixed hex string to a UTF-8 string. */
export function hexToString(hex: string): string {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

/** Converts a UTF-8 string to a 0x-prefixed hex string. */
export function stringToHex(str: string): string {
  const bytes = new TextEncoder().encode(str);
  return '0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Formats a raw Tezos secp256k1 signature as an EVM-compatible signature.
 * Appends v = 27 (0x1b) — the convention for non-transaction signatures.
 *
 * ⚠️ Only valid for tz2 accounts (secp256k1). tz1 (Ed25519) signatures are
 * not compatible with Ethereum ecrecover.
 */
export function formatTezosSignatureAsEVM(tezosSignature: string): string {
  const rawHex = tezosSignature.startsWith('0x')
    ? tezosSignature.slice(2)
    : tezosSignature;
  return `0x${rawHex}1b`; // v = 27
}

// ── SIWE (EIP-4361) ─────────────────────────────────────────────────────────

export interface SIWEMessage {
  domain: string;
  address: string;
  statement?: string;
  uri: string;
  version: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
}

/**
 * Parses an EIP-4361 (SIWE) message string.
 * Returns null if the message does not match the SIWE format.
 */
export function parseSIWEMessage(message: string): SIWEMessage | null {
  try {
    const lines = message.split('\n');
    if (!lines[0]?.includes('wants you to sign in')) return null;

    const domain = lines[0].split(' ')[0];
    const address = lines[1]?.trim();
    if (!domain || !address?.startsWith('0x')) return null;

    const get = (key: string): string | undefined => {
      const line = lines.find(l => l.startsWith(`${key}: `));
      return line?.slice(key.length + 2).trim();
    };

    const uri       = get('URI');
    const version   = get('Version');
    const chainIdStr = get('Chain ID');
    const nonce     = get('Nonce');
    const issuedAt  = get('Issued At');

    if (!uri || !version || !chainIdStr || !nonce || !issuedAt) return null;

    return {
      domain,
      address,
      statement: get('Statement'),
      uri,
      version,
      chainId: parseInt(chainIdStr, 10),
      nonce,
      issuedAt,
    };
  } catch {
    return null;
  }
}
