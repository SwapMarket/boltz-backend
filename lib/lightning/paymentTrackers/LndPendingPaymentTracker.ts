import type Logger from '../../Logger';
import { formatError, fromProtoInt, getHexBuffer } from '../../Utils';
import { NodeType } from '../../db/models/ReverseSwap';
import {
  PaymentFailureReason,
  Payment_PaymentStatus,
} from '../../proto/lnd/rpc';
import LightningNursery from '../../swap/LightningNursery';
import type { LightningClient, PaymentResponse } from '../LightningClient';
import LndClient from '../LndClient';
import NodePendingPaymentTracker, {
  PaymentStatusKind,
  type PaymentStatusResult,
} from './NodePendingPaymentTracker';

class LndPendingPaymentTracker extends NodePendingPaymentTracker {
  private static readonly rewatchInterval = 15;

  constructor(logger: Logger) {
    super(logger, NodeType.LND);
  }

  public trackPayment = (
    client: LightningClient,
    preimageHash: string,
    _invoice: string,
    promise: Promise<PaymentResponse>,
  ): void => {
    promise
      .then((result) =>
        this.handleSucceededPayment(client, preimageHash, result),
      )
      .catch((error) => this.handleFailedPayment(client, preimageHash, error));
  };

  public watchPayment = (
    client: LightningClient,
    _: string,
    preimageHash: string,
  ) => {
    (client as LndClient)
      .trackPayment(getHexBuffer(preimageHash), true)
      .then(async (res) => {
        switch (res.status) {
          case Payment_PaymentStatus.SUCCEEDED:
            await this.handleSucceededPayment(client, preimageHash, {
              feeMsat: fromProtoInt(res.feeMsat),
              preimage: getHexBuffer(res.paymentPreimage),
            });
            break;

          case Payment_PaymentStatus.FAILED:
            // If the payment could not be marked failed (e.g. the client is not
            // connected), keep watching so the still-pending row is not dropped.
            if (
              !(await this.handleFailedPayment(
                client,
                preimageHash,
                res.failureReason,
              ))
            ) {
              this.rewatchPayment(client, preimageHash);
            }
            break;

          default:
            // Not a terminal status yet: keep watching instead of dropping it.
            this.rewatchPayment(client, preimageHash);
            break;
        }
      })
      .catch((error) => {
        // A stream error (e.g. a transient transport fault) is not proof the
        // payment failed. Keep watching so the payment is not dropped and left
        // stuck as "Pending" until the swap expires.
        this.logger.warn(
          `Tracking payment ${preimageHash} with ${client.symbol} ${client.id} failed, keeping watch: ${this.parseErrorMessage(error)}`,
        );
        this.rewatchPayment(client, preimageHash);
      });
  };

  private rewatchPayment = (client: LightningClient, preimageHash: string) => {
    setTimeout(
      () => this.watchPayment(client, '', preimageHash),
      LndPendingPaymentTracker.rewatchInterval * 1_000,
    ).unref();
  };

  public checkPaymentStatus = async (
    client: LightningClient,
    _invoice: string,
    preimageHash: string,
  ): Promise<PaymentStatusResult> => {
    try {
      const res = await (client as LndClient).trackPayment(
        getHexBuffer(preimageHash),
      );

      switch (res.status) {
        case Payment_PaymentStatus.SUCCEEDED:
          return {
            kind: PaymentStatusKind.Succeeded,
            response: {
              feeMsat: fromProtoInt(res.feeMsat),
              preimage: getHexBuffer(res.paymentPreimage),
            },
          };

        case Payment_PaymentStatus.FAILED:
          return { kind: PaymentStatusKind.Failed };

        default:
          // IN_FLIGHT / INITIATED: the payment may still settle.
          return { kind: PaymentStatusKind.Pending };
      }
    } catch (error) {
      // A tracking error is not proof the payment is dead (transient transport
      // fault, ...). Treat it as unknown so the caller does not risk a second
      // payment on another node.
      this.logger.warn(
        `Could not determine LND payment status of ${preimageHash} on ${client.id}, treating as unknown: ${this.parseErrorMessage(error)}`,
      );
      return { kind: PaymentStatusKind.Unknown };
    }
  };

  public isPermanentError = (error: unknown) =>
    error === PaymentFailureReason.FAILURE_REASON_INCORRECT_PAYMENT_DETAILS ||
    LightningNursery.errIsInvoiceExpired(this.parseErrorMessage(error));

  public parseErrorMessage = (error: unknown) =>
    typeof error === 'number'
      ? LndClient.formatPaymentFailureReason(error as any)
      : formatError(error);
}

export default LndPendingPaymentTracker;
