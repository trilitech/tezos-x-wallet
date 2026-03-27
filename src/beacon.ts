import {
  DAppClient,
  BeaconEvent,
  NetworkType,
  SigningType,
  TezosOperationType,
  type AccountInfo,
  type MichelineMichelsonV1Expression,
} from '@airgap/beacon-sdk';
import { TEZOS_L1_RPC, CRAC_CONTRACT } from './constants.js';
import { stringToHex, formatTezosSignatureAsEVM } from './utils/siwe.js';
import { beaconError, isUserAbort, EIP1193_USER_REJECTED, JSON_RPC_INTERNAL } from './utils/errors.js';
import type { BeaconPermissions } from './types.js';

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
   * Submit a TRANSACTION operation to the CRAC gateway via Temple.
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
            fee: "1000",         // 0.001 XTZ in mutez
            gas_limit: "15000",   // Gas limit for transfers (increased to avoid OutOfGas)
            storage_limit: "0",    // No storage needed for transfers
            destination: CRAC_CONTRACT,
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

  /**
   * Sign an arbitrary message via Temple's requestSignPayload.
   *
   * ⚠️ Requires a tz2 account (secp256k1). tz1 accounts use Ed25519, which
   * is incompatible with Ethereum's ecrecover — SIWE verification will fail.
   */
  async signMessage(message: string, address: string): Promise<string> {
    if (!address.startsWith('tz2')) {
      throw beaconError(
        EIP1193_USER_REJECTED,
        `[TezosX Relayer] personal_sign requires a tz2 account (secp256k1). ` +
        `Your current account (${address}) uses Ed25519 (tz1) which is incompatible ` +
        `with Ethereum signature verification. Please switch to a tz2 account in Temple.`,
      );
    }

    try {
      const hex = stringToHex(message);
      const response = await this.client.requestSignPayload({
        signingType: SigningType.RAW,
        payload: hex.slice(2), // Beacon expects hex without 0x prefix
      });
      return formatTezosSignatureAsEVM(response.signature);
    } catch (err) {
      if (isUserAbort(err)) {
        throw beaconError(EIP1193_USER_REJECTED, 'User rejected the sign request');
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('No server responded') || msg.toLowerCase().includes('network')) {
        throw beaconError(
          EIP1193_USER_REJECTED,
          'Temple Wallet not reachable. Make sure the Temple extension is installed and unlocked.',
        );
      }
      throw beaconError(JSON_RPC_INTERNAL, `Beacon signMessage failed: ${msg}`);
    }
  }

  async disconnect(): Promise<void> {
    await this.client.clearActiveAccount();
    await this.client.removeAllPeers();
  }
}
