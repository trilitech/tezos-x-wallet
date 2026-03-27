export const COUNTER_ADDRESS = '0xBF1e9438e8e674CBCc5944613317BA4E84bCF52B';
export const TEZLINK_EVM_RPC = 'https://demo.txpark.nomadic-labs.com/rpc';

export const SELECTORS = {
  increment: '0xd09de08a',
  decrement: '0x2baeceb7',
  setNumber: '0x3fb5c1cb',
  retrieve:  '0x2e64cec1',
} as const;

export function encodeSetNumber(num: bigint): string {
  return `${SELECTORS.setNumber}${num.toString(16).padStart(64, '0')}`;
}

export async function readCounter(): Promise<bigint> {
  const res = await fetch(TEZLINK_EVM_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: COUNTER_ADDRESS, data: SELECTORS.retrieve }, 'latest'],
    }),
  });
  const json = await res.json() as { result: string };
  const raw = json.result;
  // '0x' or '0x0' means zero (or contract not deployed)
  if (!raw || raw === '0x') return BigInt(0);
  return BigInt(raw);
}
