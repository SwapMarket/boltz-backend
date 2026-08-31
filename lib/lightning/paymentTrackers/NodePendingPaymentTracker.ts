import type Logger from '../../Logger';
import { getHexString, stringify } from '../../Utils';
import { LightningPaymentStatus } from '../../db/models/LightningPayment';
import type { NodeType } from '../../db/models/ReverseSwap';
import { nodeTypeToPrettyString } from '../../db/models/ReverseSwap';
import LightningPaymentRepository from '../../db/repositories/LightningPaymentRepository';
import type { LightningClient, PaymentResponse } from '../LightningClient';

export enum PaymentStatusKind {
  Pending = 'pending',
  Succeeded = 'succeeded',
  Failed = 'failed',
  Unknown = 'unknown',
}

export type PaymentStatusResult =
  | { kind: PaymentStatusKind.Pending }
  | { kind: PaymentStatusKind.Succeeded; response: PaymentResponse }
  | { kind: PaymentStatusKind.Failed }
  | { kind: PaymentStatusKind.Unknown };

abstract class NodePendingPaymentTracker {
  protected constructor(
    protected readonly logger: Logger,
    protected readonly nodeType: NodeType,
  ) {}

  public abstract trackPayment(
    client: LightningClient,
    preimageHash: string,
    invoice: string,
    promise: Promise<PaymentResponse>,
  ): void;

  public abstract watchPayment(
    client: LightningClient,
    invoice: string,
    preimageHash: string,
  ): void;

  public abstract isPermanentError(err: unknown): boolean;

  public abstract parseErrorMessage(error: unknown): string;

  /**
   * Query the node for its authoritative status of a payment. Used before
   * dispatching a payment to a *different* node to make sure an attempt on
   * another node is not still live, which would settle the invoice twice.
   */
  public abstract checkPaymentStatus(
    client: LightningClient,
    invoice: string,
    preimageHash: string,
  ): Promise<PaymentStatusResult>;

  protected handleSucceededPayment = async (
    client: LightningClient,
    preimageHash: string,
    result: PaymentResponse,
  ) => {
    this.logger.debug(
      `${client.id} (${nodeTypeToPrettyString(this.nodeType)}) paid invoice ${preimageHash}: ${stringify(
        {
          feeMsat: result.feeMsat,
          preimage: getHexString(result.preimage),
        },
      )}`,
    );
    await LightningPaymentRepository.setStatus(
      preimageHash,
      client.id,
      LightningPaymentStatus.Success,
    );
  };

  protected handleFailedPayment = async (
    client: LightningClient,
    preimageHash: string,
    error: any,
  ): Promise<boolean> => {
    const isPermanent = this.isPermanentError(error);

    const errorMsg = this.parseErrorMessage(error);
    this.logger.debug(
      `${client.id} (${nodeTypeToPrettyString(this.nodeType)}) payment ${preimageHash} failed ${isPermanent ? 'permanently' : 'temporarily'}: ${errorMsg}`,
    );

    // Check for "Connection dropped" because the node status might be stale
    if (!client.isConnected() || errorMsg === 'Connection dropped') {
      this.logger.warn(
        `Not failing payment ${preimageHash} because client is not connected`,
      );
      return false;
    }

    await LightningPaymentRepository.setStatus(
      preimageHash,
      client.id,
      isPermanent
        ? LightningPaymentStatus.PermanentFailure
        : LightningPaymentStatus.TemporaryFailure,
      isPermanent ? errorMsg : undefined,
    );
    return true;
  };
}

export default NodePendingPaymentTracker;
