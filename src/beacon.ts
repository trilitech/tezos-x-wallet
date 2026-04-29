import {
  DAppClient,
  BeaconEvent,
  NetworkType,
  TezosOperationType,
  type AccountInfo,
  type MichelineMichelsonV1Expression,
} from '@airgap/beacon-sdk';
import { TEZOS_L1_RPC, NAC_CONTRACT } from './constants.js';
import type { BeaconPermissions } from './types.js';

const EIP1193_USER_REJECTED = 4001;
const JSON_RPC_INTERNAL = -32603;

function beaconError(code: number, message: string): Error & { code: number } {
  const err = new Error(message) as Error & { code: number };
  err.code = code;
  return err;
}

function isUserAbort(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes('aborted') || msg.includes('rejected') || msg.includes('dismiss');
  }
  return false;
}

export class BeaconClient {
  private readonly client: DAppClient;
  private accountChangeHandler?: (tz1: string | null) => void;

  constructor() {
    this.client = new DAppClient({
      name: 'Tezos X Relayer',
      network: {
        type: NetworkType.CUSTOM,
        name: 'Tezos X Testnet',
        rpcUrl: TEZOS_L1_RPC,
      },
    });

    // Forward Temple account changes to RelayerProvider
    void this.client.subscribeToEvent(
      BeaconEvent.ACTIVE_ACCOUNT_SET,
      (account: AccountInfo | undefined) => {
        this.accountChangeHandler?.(account?.address ?? null);
      },
    );
  }

  setAccountChangeHandler(cb: (tz1: string | null) => void): void {
    this.accountChangeHandler = cb;
  }

  /** Return existing connected account without opening a popup, or null. */
  async getActiveAccount(): Promise<BeaconPermissions | null> {
    const account = await this.client.getActiveAccount();
    if (account == null) return null;
    return { address: account.address, publicKey: account.publicKey ?? '' };
  }

  /**
   * Open the Temple Wallet popup to request permissions.
   * Resolves after user approves; throws EIP-1193 error 4001 on rejection.
   */
  async requestPermissions(): Promise<BeaconPermissions> {
    try {
      // Network is already configured at DAppClient construction.
      // RequestPermissionInput only accepts { scopes? } — no network override.
      const result = await this.client.requestPermissions();
      return { address: result.address, publicKey: result.publicKey ?? '' };
    } catch (err) {
      if (isUserAbort(err)) {
        throw beaconError(EIP1193_USER_REJECTED, 'User rejected the permission request');
      }
      throw beaconError(JSON_RPC_INTERNAL, `Beacon requestPermissions failed: ${String(err)}`);
    }
  }

  /**
   * Submit a TRANSACTION operation to the NAC gateway via Temple.
   * Returns the Tezos L1 operation hash (Base58Check).
   *
   * @param michelineArg  Micheline JSON value for the entrypoint parameters
   */
  async sendContractCall(
    entrypoint: string,
    michelineArg: MichelineMichelsonV1Expression,
    mutezAmount = '0',
  ): Promise<string> {
    try {
      const result = await this.client.requestOperation({
        operationDetails: [
          {
            kind: TezosOperationType.TRANSACTION,
            amount: mutezAmount,
            fee: "100000",          // 0.1 XTZ — safe ceiling for cross-runtime ops (Temple re-estimates)
            // Tezos X demo has hard_gas_limit_per_block == hard_gas_limit_per_operation == 1_040_000.
            // A first-tx op group also includes a reveal (~633 gas), so 1_040_000 here would overflow
            // the block limit and trigger gas_limit_too_high. Leave headroom for reveal + safety.
            gas_limit: "1000000",
            storage_limit: "60000", // Allows storage allocation via NAC gateway
            destination: NAC_CONTRACT,
            parameters: {
              entrypoint,
              value: michelineArg,
            },
          },
        ],
      });
      // result.transactionHash is the Tezos L1 opHash
      const l1OpHash = (result as { transactionHash: string }).transactionHash;
      console.info('[TezosX Relayer] L1 opHash (Tezos):', l1OpHash);
      return l1OpHash;
    } catch (err) {
      if (isUserAbort(err)) {
        throw beaconError(EIP1193_USER_REJECTED, 'User rejected the transaction');
      }
      throw beaconError(JSON_RPC_INTERNAL, `Beacon sendContractCall failed: ${String(err)}`);
    }
  }

  async disconnect(): Promise<void> {
    await this.client.clearActiveAccount();
    await this.client.removeAllPeers();
  }
}
