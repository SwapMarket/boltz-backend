import { Op, Transaction } from 'sequelize';
import { SwapType } from '../../consts/Enums';
import Database from '../Database';
import { isSameLockup } from '../LockupIdentity';
import ChainSwap from '../models/ChainSwap';
import ChainSwapData from '../models/ChainSwapData';
import type { CommitmentType } from '../models/Commitment';
import Commitment from '../models/Commitment';
import Swap from '../models/Swap';
import type { ChainSwapInfo } from './ChainSwapRepository';

class CommitmentRepository {
  public static create = async (
    commitment: CommitmentType,
  ): Promise<Commitment> => {
    return await Database.sequelize.transaction(
      {
        isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE,
      },
      async (transaction) => {
        return await Commitment.create(commitment, { transaction });
      },
    );
  };

  public static createForLockup = async (
    commitment: CommitmentType,
    swap: Swap | ChainSwapInfo,
    logIndex: number,
  ): Promise<Commitment> => {
    return await Database.sequelize.transaction(
      {
        isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE,
      },
      async (transaction) => {
        const reserved =
          swap.type === SwapType.Submarine
            ? await CommitmentRepository.reserveSwapLockup(
                swap.id,
                commitment.transactionHash,
                logIndex,
                transaction,
              )
            : await CommitmentRepository.reserveChainSwapLockup(
                swap as ChainSwapInfo,
                commitment.transactionHash,
                logIndex,
                transaction,
              );

        if (!reserved) {
          throw new Error('swap has a lockup transaction already');
        }

        return await Commitment.create(commitment, { transaction });
      },
    );
  };

  private static reserveSwapLockup = async (
    id: string,
    lockupTransactionId: string,
    lockupTransactionVout: number,
    transaction: Transaction,
  ): Promise<boolean> => {
    const current = await Swap.findOne({
      transaction,
      lock: transaction.LOCK.UPDATE,
      where: { id },
    });
    if (current === null) {
      return false;
    }

    if (current.lockupTransactionId != null) {
      return isSameLockup(
        {
          transactionId: current.lockupTransactionId,
          vout: current.lockupTransactionVout,
        },
        { transactionId: lockupTransactionId, vout: lockupTransactionVout },
      );
    }

    await current.update(
      { lockupTransactionId, lockupTransactionVout },
      { transaction },
    );

    return true;
  };

  private static reserveChainSwapLockup = async (
    swap: ChainSwapInfo,
    transactionId: string,
    transactionVout: number,
    transaction: Transaction,
  ): Promise<boolean> => {
    const current = await ChainSwap.findOne({
      transaction,
      lock: transaction.LOCK.UPDATE,
      where: { id: swap.id },
    });
    const currentData = await ChainSwapData.findOne({
      transaction,
      lock: transaction.LOCK.UPDATE,
      where: { swapId: swap.id, symbol: swap.receivingData.symbol },
    });
    if (current === null || currentData === null) {
      return false;
    }

    if (currentData.transactionId != null) {
      return isSameLockup(
        {
          transactionId: currentData.transactionId,
          vout: currentData.transactionVout,
        },
        { transactionId, vout: transactionVout },
      );
    }

    await currentData.update(
      { transactionId, transactionVout },
      { transaction },
    );

    return true;
  };

  public static getBySwapId = async (
    swapId: string,
  ): Promise<Commitment | null> => {
    return await Commitment.findOne({
      where: {
        swapId,
      },
    });
  };

  public static getBySwapIds = async (
    swapIds: string[],
  ): Promise<Map<string, Commitment>> => {
    const commitments = await Commitment.findAll({
      where: {
        swapId: {
          [Op.in]: swapIds,
        },
      },
    });
    return new Map(
      commitments
        .filter((c): c is Commitment & { swapId: string } => c.swapId !== null)
        .map((c) => [c.swapId, c]),
    );
  };

  public static getByLockupHash = async (
    lockupHash: string,
  ): Promise<Commitment | null> => {
    return await Commitment.findOne({
      where: {
        lockupHash,
      },
    });
  };

  public static markRefunded = async (
    lockupHash: string,
    transactionHash: string,
  ): Promise<Commitment> => {
    return await Database.sequelize.transaction(
      {
        isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE,
      },
      async (transaction) => {
        const existing = await Commitment.findOne({
          where: { lockupHash },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });

        if (existing !== null) {
          existing.refunded = true;
          existing.transactionHash = transactionHash;
          await existing.save({ transaction });
          return existing;
        }

        return await Commitment.create(
          {
            lockupHash,
            transactionHash,
            refunded: true,
          },
          { transaction },
        );
      },
    );
  };
}

export default CommitmentRepository;
