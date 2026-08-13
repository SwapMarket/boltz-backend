import type { CreateOptions, Order, WhereOptions } from 'sequelize';
import { Op, Transaction } from 'sequelize';
import { SwapUpdateEvent } from '../../consts/Enums';
import Database from '../Database';
import type { LockupTargetStatus, LockupWriteResult } from '../LockupIdentity';
import {
  LockupWriteOutcome,
  decideLockupWrite,
  shouldWriteZeroConfRejection,
} from '../LockupIdentity';
import type { SwapType } from '../models/Swap';
import Swap from '../models/Swap';

class SwapRepository {
  public static readonly lockupNonUpdatableStatuses = [
    SwapUpdateEvent.InvoicePending,
    SwapUpdateEvent.InvoicePaid,
    SwapUpdateEvent.InvoiceFailedToPay,
    SwapUpdateEvent.TransactionClaimPending,
    SwapUpdateEvent.TransactionClaimed,
    SwapUpdateEvent.SwapExpired,
  ];

  public static getSwaps = (
    options?: WhereOptions,
    order?: Order,
    limit?: number,
  ): Promise<Swap[]> => {
    return Swap.findAll({
      limit,
      order,
      where: options,
    });
  };

  public static getSwapsExpirable = (height: number): Promise<Swap[]> => {
    return Swap.findAll({
      where: {
        status: {
          [Op.notIn]: [
            SwapUpdateEvent.SwapExpired,
            SwapUpdateEvent.InvoiceFailedToPay,
            SwapUpdateEvent.TransactionClaimed,
          ],
        },
        timeoutBlockHeight: {
          [Op.lte]: height,
        },
      },
    });
  };

  public static getSwapsClaimable = () => {
    return Swap.findAll({
      where: {
        status: SwapUpdateEvent.TransactionClaimPending,
      },
    });
  };

  public static getSwap = (options: WhereOptions): Promise<Swap | null> => {
    return Swap.findOne({
      where: options,
    });
  };

  public static addSwap = async (
    swap: SwapType,
    options?: CreateOptions<Swap>,
  ): Promise<Swap> => {
    if (options !== undefined) {
      return await Swap.create(swap, options);
    }

    return await Database.sequelize.transaction(
      {
        isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE,
      },
      async (transaction) => {
        return await Swap.create(swap, { transaction });
      },
    );
  };

  public static disableZeroConf = async (swaps: Swap[]) => {
    if (swaps.length === 0) {
      return;
    }

    await Swap.update(
      { acceptZeroConf: false },
      { where: { id: swaps.map((s) => s.id) } },
    );
  };

  public static setSwapStatus = (
    swap: Swap,
    status: string,
    failureReason?: string,
  ): Promise<Swap> =>
    swap.update({
      status,
      failureReason: swap.failureReason || failureReason,
    });

  public static setInvoice = (
    swap: Swap,
    invoice: string,
    invoiceAmount: number,
    expectedAmount: number,
    fee: number,
    acceptZeroConf: boolean,
  ): Promise<Swap> => {
    return Database.sequelize.transaction(
      {
        isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE,
      },
      async (transaction) => {
        return await swap.update(
          {
            fee,
            invoice,
            invoiceAmount,
            acceptZeroConf,
            expectedAmount,
            status: SwapUpdateEvent.InvoiceSet,
          },
          { transaction },
        );
      },
    );
  };

  public static setLockupTransaction = async (
    swap: Swap,
    lockupTransactionId: string,
    onchainAmount: number,
    status: LockupTargetStatus,
    lockupTransactionVout?: number,
  ): Promise<LockupWriteResult<Swap>> => {
    const outcome = await Database.sequelize.transaction(
      async (transaction) => {
        const current = await Swap.findOne({
          transaction,
          lock: transaction.LOCK.UPDATE,
          where: { id: swap.id },
        });
        if (current === null) {
          return LockupWriteOutcome.Rejected;
        }

        const decision = decideLockupWrite({
          existing:
            current.lockupTransactionId == null
              ? null
              : {
                  transactionId: current.lockupTransactionId,
                  vout: current.lockupTransactionVout,
                },
          incoming: {
            transactionId: lockupTransactionId,
            vout: lockupTransactionVout,
          },
          currentStatus: current.status as SwapUpdateEvent,
          targetStatus: status,
          updatable: !SwapRepository.lockupNonUpdatableStatuses.includes(
            current.status as SwapUpdateEvent,
          ),
        });

        if (decision.write) {
          await current.update(
            {
              status,
              onchainAmount,
              lockupTransactionId,
              lockupTransactionVout: decision.vout,
            },
            { transaction },
          );
        }

        return decision.outcome;
      },
    );

    return {
      outcome,
      swap: (await SwapRepository.getSwap({ id: swap.id })) || swap,
    };
  };

  public static setZeroConfRejected = async (
    swap: Swap,
    transactionId: string,
    transactionVout?: number,
  ): Promise<Swap> => {
    await Database.sequelize.transaction(async (transaction) => {
      const current = await Swap.findOne({
        transaction,
        lock: transaction.LOCK.UPDATE,
        where: { id: swap.id },
      });
      if (
        current === null ||
        !shouldWriteZeroConfRejection({
          existing:
            current.lockupTransactionId == null
              ? null
              : {
                  transactionId: current.lockupTransactionId,
                  vout: current.lockupTransactionVout,
                },
          incoming: { transactionId, vout: transactionVout },
          currentStatus: current.status as SwapUpdateEvent,
        })
      ) {
        return;
      }

      await current.update(
        { status: SwapUpdateEvent.TransactionZeroConfRejected },
        { transaction },
      );
    });

    return (await SwapRepository.getSwap({ id: swap.id })) || swap;
  };

  public static setRefundAddress = (
    swap: Swap,
    refundAddress: string,
  ): Promise<Swap> => {
    return swap.update({
      refundAddress,
    });
  };

  public static setRate = (swap: Swap, rate: number): Promise<Swap> => {
    return swap.update({
      rate,
    });
  };

  public static setInvoicePaid = (
    swap: Swap,
    routingFee: number,
    preimage: string,
  ): Promise<Swap> => {
    return swap.update({
      preimage,
      routingFee,
      failureReason: null,
      status: SwapUpdateEvent.InvoicePaid,
    });
  };

  public static setMinerFee = (swap: Swap, minerFee: number): Promise<Swap> => {
    return swap.update({
      minerFee,
      status: SwapUpdateEvent.TransactionClaimed,
    });
  };

  public static setRefundSignatureCreated = (id: string) =>
    Swap.update(
      {
        createdRefundSignature: true,
      },
      {
        where: {
          id,
        },
      },
    );

  public static destroyPristine = async (id: string): Promise<boolean> => {
    const destroyed = await Swap.destroy({
      where: {
        id,
        invoice: null,
        onchainAmount: null,
        lockupTransactionId: null,
        createdRefundSignature: false,
        status: SwapUpdateEvent.SwapCreated,
      },
    });

    return destroyed > 0;
  };

  public static dropTable = (): Promise<void> => {
    return Swap.drop();
  };
}

export default SwapRepository;
