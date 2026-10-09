import type Logger from '../Logger';
import { racePromise } from '../PromiseUtils';
import {
  fromProtoInt,
  getHexBuffer,
  getHexString,
  minutesToMilliseconds,
  nullishPipe,
  secondsToMilliseconds,
} from '../Utils';
import DefaultMap from '../consts/DefaultMap';
import type LightningPayment from '../db/models/LightningPayment';
import { LightningPaymentStatus } from '../db/models/LightningPayment';
import { NodeType } from '../db/models/ReverseSwap';
import type Swap from '../db/models/Swap';
import LightningPaymentRepository from '../db/repositories/LightningPaymentRepository';
import ReferralRepository from '../db/repositories/ReferralRepository';
import type Sidecar from '../sidecar/Sidecar';
import { type Currency, getLightningClientById } from '../wallet/WalletManager';
import LightningErrors from './Errors';
import type { LightningClient, PaymentResponse } from './LightningClient';
import type LndClient from './LndClient';
import NoExistingPaymentActionError from './NoExistingPaymentActionError';
import type ClnClient from './cln/ClnClient';
import ClnPendingPaymentTracker from './paymentTrackers/ClnPendingPaymentTracker';
import LndPendingPaymentTracker from './paymentTrackers/LndPendingPaymentTracker';
import type NodePendingPaymentTracker from './paymentTrackers/NodePendingPaymentTracker';
import { PaymentStatusKind } from './paymentTrackers/NodePendingPaymentTracker';

type LightningNodes = Map<string, LightningClient>;

class PendingPaymentTracker {
  public static readonly raceTimeout = 10;

  private static readonly timeoutError = 'payment timed out';

  public readonly lightningTrackers: Record<
    Exclude<NodeType, NodeType.SelfPayment>,
    NodePendingPaymentTracker
  >;

  private readonly lightningNodes = new DefaultMap<string, LightningNodes>(
    () => new Map<string, LightningClient>(),
  );

  constructor(
    private readonly logger: Logger,
    private readonly sidecar: Sidecar,
    private readonly paymentTimeoutMinutes?: number,
  ) {
    this.lightningTrackers = {
      [NodeType.LND]: new LndPendingPaymentTracker(this.logger),
      [NodeType.CLN]: new ClnPendingPaymentTracker(this.logger),
    };

    if (
      this.paymentTimeoutMinutes === undefined ||
      typeof this.paymentTimeoutMinutes !== 'number'
    ) {
      this.paymentTimeoutMinutes = undefined;
      this.logger.info('Payment timeout not configured');
      return;
    }

    this.logger.info(
      `Payment timeout configured: ${this.paymentTimeoutMinutes} minutes`,
    );
  }

  public init = async (currencies: Currency[]) => {
    currencies.forEach((currency) => {
      const nodes = new Map<string, LightningClient>();
      currency.lndClients.forEach((client, nodeId) =>
        nodes.set(nodeId, client),
      );
      if (currency.clnClient) {
        nodes.set(currency.clnClient.id, currency.clnClient);
      }
      this.lightningNodes.set(currency.symbol, nodes);
    });

    for (const payment of await LightningPaymentRepository.findByStatus(
      LightningPaymentStatus.Pending,
    )) {
      const nodes = this.lightningNodes.get(payment.Swap.lightningCurrency);
      const client = nodes.get(payment.nodeId);
      if (client === undefined) {
        this.logger.warn(
          `Could not track payment ${payment.Swap.id} (${payment.preimageHash}): ${payment.Swap.lightningCurrency} ${payment.nodeId} is not available`,
        );
        continue;
      }

      this.logger.debug(
        `Watching pending ${client.symbol} ${client.id} payment of ${payment.Swap.id}: ${payment.preimageHash}`,
      );
      this.lightningTrackers[client.type].watchPayment(
        client,
        payment.Swap.invoice!,
        payment.preimageHash,
      );
    }
  };

  public getRelevantNode = async (
    lightningCurrency: Currency,
    swap: Swap,
    preferredNode: LightningClient,
  ): Promise<{
    paymentHash: string;
    node: LightningClient;
    payments: LightningPayment[];
    existingRelevantAction: LightningPayment | undefined;
  }> => {
    const { paymentHash, payments, existingRelevantAction } =
      await this.getPaymentActions(swap);

    if (existingRelevantAction === undefined) {
      return {
        payments,
        paymentHash,
        node: preferredNode,
        existingRelevantAction,
      };
    }

    const node = getLightningClientById(
      lightningCurrency,
      existingRelevantAction.nodeId,
    );

    if (node === undefined) {
      this.logger.warn(
        `Node ${existingRelevantAction.nodeId} for existing payment ${paymentHash} not available; using preferred node`,
      );
    }

    return {
      payments,
      paymentHash,
      node: node || preferredNode,
      existingRelevantAction,
    };
  };

  public getPaymentActions = async (
    swap: Swap,
  ): Promise<{
    paymentHash: string;
    payments: LightningPayment[];
    existingRelevantAction: LightningPayment | undefined;
  }> => {
    const paymentHash = getHexString(
      (await this.sidecar.decodeInvoiceOrOffer(swap.invoice!)).paymentHash!,
    );

    const payments =
      await LightningPaymentRepository.findByPreimageHash(paymentHash);

    const existingRelevantAction = payments.find(
      (p) =>
        p.status === LightningPaymentStatus.Success ||
        p.status === LightningPaymentStatus.Pending ||
        p.status === LightningPaymentStatus.PermanentFailure,
    );

    return {
      payments,
      paymentHash,
      existingRelevantAction,
    };
  };

  public sendPayment = async (
    swap: Swap,
    lightningClient: LightningClient,
    paymentHash: string,
    payments: LightningPayment[],
    cltvLimit?: number,
    timePreference?: number,
    allowNewPayment = true,
  ): Promise<PaymentResponse | undefined> => {
    for (const status of [
      LightningPaymentStatus.Pending,
      LightningPaymentStatus.Success,
      LightningPaymentStatus.PermanentFailure,
    ]) {
      const relevant = payments.find((p) => p.status === status);
      if (relevant === undefined) {
        continue;
      }

      switch (status) {
        case LightningPaymentStatus.Pending:
          this.logger.verbose(
            `Invoice payment of ${swap.id} (${paymentHash}) still pending with node ${relevant.nodeId}`,
          );
          return undefined;

        case LightningPaymentStatus.Success:
          return await this.getSuccessfulPaymentDetails(
            swap.id,
            relevant,
            lightningClient.symbol,
            paymentHash,
            swap.invoice!,
          );

        case LightningPaymentStatus.PermanentFailure:
          return await this.getPermanentFailureDetails(
            swap.id,
            relevant,
            lightningClient.symbol,
          );
      }
    }

    if (!allowNewPayment) {
      throw new NoExistingPaymentActionError();
    }

    await this.checkInvoiceTimeout(
      swap,
      paymentHash,
      lightningClient.id,
      payments,
    );

    // Before paying on a node that differs from one that already attempted this
    // invoice, verify the previous node's authoritative state. A local
    // TemporaryFailure is not proof the previous attempt is dead (it can be
    // written for transient lookup faults), so re-paying elsewhere could settle
    // the invoice twice (operator fund loss).
    const crossNode = await this.resolveCrossNodePayment(
      swap,
      paymentHash,
      lightningClient,
      payments,
    );
    if (crossNode.action === 'settle') {
      return crossNode.response;
    }
    if (crossNode.action === 'abstain') {
      return undefined;
    }

    return await this.sendPaymentWithNode(
      swap,
      lightningClient,
      paymentHash,
      cltvLimit,
      timePreference,
    );
  };

  private resolveCrossNodePayment = async (
    swap: Swap,
    paymentHash: string,
    chosenNode: LightningClient,
    payments: LightningPayment[],
  ): Promise<
    | { action: 'proceed' }
    | { action: 'abstain' }
    | { action: 'settle'; response: PaymentResponse }
  > => {
    const otherNodeIds = Array.from(
      new Set(
        payments
          .filter(
            (p) =>
              p.nodeId !== chosenNode.id &&
              p.status === LightningPaymentStatus.TemporaryFailure,
          )
          .map((p) => p.nodeId),
      ),
    );
    if (otherNodeIds.length === 0) {
      return { action: 'proceed' };
    }

    const nodes = this.lightningNodes.get(chosenNode.symbol);
    for (const nodeId of otherNodeIds) {
      const client = nodes.get(nodeId);
      if (client === undefined) {
        this.logger.warn(
          `Cannot verify previous payment attempt of ${swap.id} (${paymentHash}) on unavailable node ${nodeId}; not paying on ${chosenNode.id} to avoid a double payment`,
        );
        return { action: 'abstain' };
      }

      const status = await this.lightningTrackers[
        client.type
      ].checkPaymentStatus(client, swap.invoice!, paymentHash);

      switch (status.kind) {
        case PaymentStatusKind.Succeeded:
          this.logger.info(
            `Previous payment attempt of ${swap.id} (${paymentHash}) on ${client.symbol} ${client.id} already succeeded; settling instead of paying again`,
          );
          await LightningPaymentRepository.setStatus(
            paymentHash,
            client.id,
            LightningPaymentStatus.Success,
          );
          return { action: 'settle', response: status.response };

        case PaymentStatusKind.Pending:
          this.logger.warn(
            `Previous payment attempt of ${swap.id} (${paymentHash}) on ${client.symbol} ${client.id} is still pending; not paying on ${chosenNode.id} to avoid a double payment`,
          );
          this.lightningTrackers[client.type].watchPayment(
            client,
            swap.invoice!,
            paymentHash,
          );
          return { action: 'abstain' };

        case PaymentStatusKind.Unknown:
          this.logger.warn(
            `Could not determine status of previous payment attempt of ${swap.id} (${paymentHash}) on ${client.symbol} ${client.id}; not paying on ${chosenNode.id} to avoid a double payment`,
          );
          return { action: 'abstain' };

        case PaymentStatusKind.Failed:
          // Verified terminal failure on that node: safe to consider paying elsewhere.
          break;
      }
    }

    return { action: 'proceed' };
  };

  private checkInvoiceTimeout = async (
    swap: Pick<Swap, 'id' | 'paymentTimeout'>,
    paymentHash: string,
    lightningClientId: string,
    payments: LightningPayment[],
  ) => {
    // Prefer the payment timeout from the swap, if it exists
    const timeout =
      nullishPipe(swap.paymentTimeout, secondsToMilliseconds) ??
      nullishPipe(this.paymentTimeoutMinutes, minutesToMilliseconds);

    const relevantTimestamps = payments
      .filter(
        (payment) => payment.status === LightningPaymentStatus.TemporaryFailure,
      )
      .map((p) => p.createdAt.getTime());

    if (timeout === undefined || relevantTimestamps.length === 0) {
      return;
    }

    if (Date.now() - Math.min(...relevantTimestamps) > timeout) {
      this.logger.warn(`Payment for ${swap.id} (${paymentHash}) has timed out`);

      const err = LightningErrors.PAYMENT_TIMED_OUT();
      await LightningPaymentRepository.setStatus(
        paymentHash,
        lightningClientId,
        LightningPaymentStatus.PermanentFailure,
        err.message,
      );
      throw err.message;
    }
  };

  private sendPaymentWithNode = async (
    swap: Swap,
    lightningClient: LightningClient,
    preimageHash: string,
    cltvLimit?: number,
    timePreference?: number,
  ) => {
    await LightningPaymentRepository.create({
      preimageHash,
      nodeId: lightningClient.id,
    });

    const referral =
      swap.referral !== undefined && swap.referral !== null
        ? await ReferralRepository.getReferralById(swap.referral)
        : null;

    let paymentPromise: Promise<PaymentResponse> | undefined = undefined;
    try {
      paymentPromise = lightningClient.sendPayment(
        swap.invoice!,
        cltvLimit,
        referral?.maxRoutingFeeRatio(swap.pair),
        timePreference,
      );
      const res = await racePromise(
        paymentPromise,
        (reject) => reject(PendingPaymentTracker.timeoutError),
        PendingPaymentTracker.raceTimeout * 1_000,
      );
      await LightningPaymentRepository.setStatus(
        preimageHash,
        lightningClient.id,
        LightningPaymentStatus.Success,
      );

      return res;
    } catch (e) {
      if (
        e === PendingPaymentTracker.timeoutError &&
        paymentPromise !== undefined
      ) {
        this.lightningTrackers[lightningClient.type].trackPayment(
          lightningClient,
          preimageHash,
          swap.invoice!,
          paymentPromise,
        );
        this.logger.verbose(
          `Invoice payment of ${swap.id} (${preimageHash}) is still pending with node ${lightningClient.id} after ${PendingPaymentTracker.raceTimeout} seconds`,
        );
        return undefined;
      }

      const isPermanentError =
        this.lightningTrackers[lightningClient.type].isPermanentError(e);

      // CLN xpay does throw errors while the payment is still pending
      if (lightningClient.type === NodeType.CLN && !isPermanentError) {
        this.lightningTrackers[lightningClient.type].watchPayment(
          lightningClient,
          swap.invoice!,
          preimageHash,
        );

        return undefined;
      }

      await LightningPaymentRepository.setStatus(
        preimageHash,
        lightningClient.id,
        isPermanentError
          ? LightningPaymentStatus.PermanentFailure
          : LightningPaymentStatus.TemporaryFailure,
        isPermanentError
          ? this.lightningTrackers[lightningClient.type].parseErrorMessage(e)
          : undefined,
      );

      throw e;
    }
  };

  private getSuccessfulPaymentDetails = async (
    swapId: string,
    payment: LightningPayment,
    symbol: string,
    preimageHash: string,
    invoice: string,
  ): Promise<PaymentResponse | undefined> => {
    this.logger.verbose(
      `Invoice payment of ${swapId} (${preimageHash}) has already succeeded on node ${symbol} ${payment.nodeId}`,
    );

    const nodeThatPaid = this.lightningNodes.get(symbol).get(payment.nodeId);
    if (nodeThatPaid === undefined) {
      this.logger.warn(
        `Could not resolve payment of ${swapId} (${preimageHash}): ${symbol} ${payment.nodeId} is not available`,
      );
      return undefined;
    }

    switch (nodeThatPaid.type) {
      case NodeType.LND: {
        const trackedPayment = await (nodeThatPaid as LndClient).trackPayment(
          getHexBuffer(preimageHash),
        );
        return {
          feeMsat: fromProtoInt(trackedPayment.feeMsat),
          preimage: getHexBuffer(trackedPayment.paymentPreimage),
        };
      }

      case NodeType.CLN:
        return (nodeThatPaid as ClnClient).checkPayStatus(invoice);

      case NodeType.SelfPayment:
        throw new Error('self payments cannot be tracked');
    }

    return undefined;
  };

  private getPermanentFailureDetails = async (
    swapId: string,
    payment: LightningPayment,
    symbol: string,
  ) => {
    this.logger.verbose(
      `Invoice payment of ${swapId} (${payment.preimageHash}) has failed with a permanent error on node ${symbol} ${payment.nodeId}`,
    );
    throw payment.error;
  };
}

export default PendingPaymentTracker;
