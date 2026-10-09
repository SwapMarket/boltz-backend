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

  // Consecutive empty listPays results before a payment counts as never attempted
  public static readonly maxEmptyListPaysChecks = 4;

  private readonly checkInterval: NodeJS.Timer;

  private readonly paymentsToWatch = new Map<
    string,
    { invoice: string; client: ClnClient; emptyChecks: number }
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
    // Keep the empty listPays count so re-watching cannot extend the grace period
    if (this.paymentsToWatch.get(preimageHash)?.client.id === client.id) {
      return;
    }

    this.paymentsToWatch.set(preimageHash, {
      invoice,
      client: client as ClnClient,
      emptyChecks: 0,
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

      // An xpay in flight may not have recorded a sendpay attempt yet, so no
      // attempt is only conclusive once the watch's grace period has ended
      if (pays.length === 0) {
        return this.paymentsToWatch.get(preimageHash)?.client.id === client.id
          ? { kind: PaymentStatusKind.Pending }
          : { kind: PaymentStatusKind.Failed };
      }

      const res = await (client as ClnClient).checkListPaysStatus(
        decoded,
        pays,
      );
      if (res !== undefined) {
        return { kind: PaymentStatusKind.Succeeded, response: res };
      }

      return { kind: PaymentStatusKind.Pending };
    } catch (e) {
      if (e === ClnClient.paymentPendingError) {
        return { kind: PaymentStatusKind.Pending };
      }
      if (
        e === ClnClient.paymentAllAttemptsFailed ||
        this.isPermanentError(e)
      ) {
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
    for (const [preimageHash, watched] of this.paymentsToWatch.entries()) {
      const { client, invoice } = watched;
      // Only stop watching a payment once we have a definitive answer from the
      // node (it succeeded or terminally failed). A failed status lookup
      // is inconclusive and must never be turned into a failure, otherwise a
      // transient boltz<->CLN RPC fault would let us abandon a still-live
      // payment and release the swap's refund (double spend).
      let resolved = false;

      try {
        const { decoded, pays } = await client.listPays(invoice);

        if (pays.length === 0) {
          // An xpay in flight may not have persisted a sendpay attempt yet, so
          // only a run of empty results means no attempt was made
          watched.emptyChecks += 1;
          if (
            watched.emptyChecks >=
            ClnPendingPaymentTracker.maxEmptyListPaysChecks
          ) {
            resolved = await this.handleFailedPayment(
              client,
              preimageHash,
              'no attempts have been made',
            );
          } else {
            this.logger.silly(
              `No CLN pay attempts recorded yet for payment ${preimageHash}; keeping watch`,
            );
          }
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
