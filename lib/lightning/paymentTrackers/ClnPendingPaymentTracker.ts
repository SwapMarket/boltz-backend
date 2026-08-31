import type Logger from '../../Logger';
import { formatError } from '../../Utils';
import { NodeType } from '../../db/models/ReverseSwap';
import LightningNursery from '../../swap/LightningNursery';
import type { LightningClient, PaymentResponse } from '../LightningClient';
import ClnClient from '../cln/ClnClient';
import NodePendingPaymentTracker, {
  PaymentStatusKind,
  type PaymentStatusResult,
} from './NodePendingPaymentTracker';

class ClnPendingPaymentTracker extends NodePendingPaymentTracker {
  private static readonly checkInterval = 15;

  private readonly checkInterval: NodeJS.Timer;

  private readonly paymentsToWatch = new Map<
    string,
    { invoice: string; client: ClnClient }
  >();

  constructor(logger: Logger) {
    super(logger, NodeType.CLN);
    // CLN does not have a streaming endpoint for existing pending payments.
    // We have to poll on an interval
    this.logger.debug(
      `Checking for updates on pending CLN payments every ${ClnPendingPaymentTracker.checkInterval} seconds`,
    );
    this.checkInterval = setInterval(
      this.checkPendingPayments,
      ClnPendingPaymentTracker.checkInterval * 1_000,
    );
  }

  public stop = () => {
    clearInterval(this.checkInterval as unknown as number);
  };

  public trackPayment = (
    client: LightningClient,
    preimageHash: string,
    invoice: string,
    promise: Promise<PaymentResponse>,
  ): void => {
    promise
      .then((result) =>
        this.handleSucceededPayment(client, preimageHash, result),
      )
      .catch((error) => {
        // CLN xpay throws errors while the payment is still pending
        if (!this.isPermanentError(error)) {
          this.watchPayment(client, invoice, preimageHash);
        } else {
          this.handleFailedPayment(client, preimageHash, error);
        }
      });
  };

  public watchPayment = (
    client: LightningClient,
    invoice: string,
    preimageHash: string,
  ) => {
    this.paymentsToWatch.set(preimageHash, {
      invoice,
      client: client as ClnClient,
    });
  };

  public isPermanentError = (error: unknown) => {
    const errorMessage = this.parseErrorMessage(error);
    return (
      ClnClient.errIsIncorrectPaymentDetails(errorMessage) ||
      LightningNursery.errIsInvoiceExpired(errorMessage)
    );
  };

  public parseErrorMessage = (error: unknown) =>
    ClnClient.isRpcError(error)
      ? ClnClient.formatPaymentFailureReason(error as any)
      : formatError(error);

  public checkPaymentStatus = async (
    client: LightningClient,
    invoice: string,
    preimageHash: string,
  ): Promise<PaymentStatusResult> => {
    try {
      const { decoded, pays } = await (client as ClnClient).listPays(invoice);

      // No persisted attempt yet does not mean the payment failed: an xpay in
      // flight may not have recorded a sendpay attempt. Treat it as pending so
      // no second payment is dispatched.
      if (pays.length === 0) {
        return { kind: PaymentStatusKind.Pending };
      }

      const res = await (client as ClnClient).checkListPaysStatus(decoded, pays);
      if (res !== undefined) {
        return { kind: PaymentStatusKind.Succeeded, response: res };
      }

      return { kind: PaymentStatusKind.Pending };
    } catch (e) {
      if (e === ClnClient.paymentPendingError) {
        return { kind: PaymentStatusKind.Pending };
      }
      if (e === ClnClient.paymentAllAttemptsFailed || this.isPermanentError(e)) {
        return { kind: PaymentStatusKind.Failed };
      }
      // Inconclusive lookup: never assume the payment is dead.
      this.logger.warn(
        `Could not determine CLN payment status of ${preimageHash} on ${client.id}, treating as unknown: ${this.parseErrorMessage(e)}`,
      );
      return { kind: PaymentStatusKind.Unknown };
    }
  };

  private checkPendingPayments = async () => {
    for (const [
      preimageHash,
      { client, invoice },
    ] of this.paymentsToWatch.entries()) {
      // Only stop watching a payment once we have a definitive answer from the
      // node (it succeeded or terminally failed). A failed/empty status lookup
      // is inconclusive and must never be turned into a failure, otherwise a
      // transient boltz<->CLN RPC fault would let us abandon a still-live
      // payment and release the swap's refund (double spend).
      let resolved = false;

      try {
        const { decoded, pays } = await client.listPays(invoice);

        if (pays.length === 0) {
          // An empty listPays result does not imply the payment failed: an xpay
          // that has not (yet) persisted a sendpay attempt leaves no entry while
          // the payment is still in flight. Keep watching.
          this.logger.silly(
            `No CLN pay attempts recorded yet for payment ${preimageHash}; keeping watch`,
          );
        } else {
          const res = await client.checkListPaysStatus(decoded, pays);
          if (res !== undefined) {
            await this.handleSucceededPayment(client, preimageHash, res);
            resolved = true;
          }
        }
      } catch (e) {
        if (e === ClnClient.paymentPendingError) {
          // The payment is still in flight; keep watching.
        } else if (
          e === ClnClient.paymentAllAttemptsFailed ||
          this.isPermanentError(e)
        ) {
          // A definitive terminal failure reported by the node (all attempts
          // failed with no HTLC in flight, or a permanent error).
          resolved = await this.handleFailedPayment(client, preimageHash, e);
        } else {
          // Inconclusive lookup (transport/RPC error, listPeerChannels failure,
          // ...). Never convert this into a failure status: keep watching until
          // the node gives a definitive answer.
          this.logger.warn(
            `Could not check status of pending CLN payment ${preimageHash}, keeping watch: ${this.parseErrorMessage(e)}`,
          );
        }
      }

      if (resolved) {
        this.paymentsToWatch.delete(preimageHash);
      }
    }
  };
}

export default ClnPendingPaymentTracker;
