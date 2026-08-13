import { Op } from 'sequelize';
import { SwapUpdateEvent } from '../consts/Enums';
import { LightningPaymentStatus } from '../db/models/LightningPayment';
import type Swap from '../db/models/Swap';
import LightningPaymentRepository from '../db/repositories/LightningPaymentRepository';
import SwapRepository from '../db/repositories/SwapRepository';

type PaidUnclaimedSwap = {
  swap: Swap;
  paidAt: Date;
};

const findPaidUnclaimedSwaps = async (
  minAgeMs: number,
): Promise<PaidUnclaimedSwap[]> => {
  const unclaimed = await SwapRepository.getSwaps({
    status: {
      [Op.in]: [SwapUpdateEvent.InvoicePending, SwapUpdateEvent.InvoicePaid],
    },
  });
  if (unclaimed.length === 0) {
    return [];
  }

  const payments =
    await LightningPaymentRepository.findByPreimageHashesAndStatus(
      unclaimed.map((swap) => swap.preimageHash),
      LightningPaymentStatus.Success,
    );

  const paidAt = new Map<string, Date>();
  for (const payment of payments) {
    const existing = paidAt.get(payment.preimageHash);
    if (existing === undefined || payment.updatedAt < existing) {
      paidAt.set(payment.preimageHash, payment.updatedAt);
    }
  }

  const threshold = Date.now() - minAgeMs;

  return unclaimed
    .map((swap) => ({
      swap,
      // Self payments create no lightningPayments row, but the status is only
      // ever set together with the preimage
      paidAt:
        paidAt.get(swap.preimageHash) ??
        (swap.status === SwapUpdateEvent.InvoicePaid
          ? swap.updatedAt
          : undefined),
    }))
    .filter(
      (entry): entry is PaidUnclaimedSwap =>
        entry.paidAt !== undefined && entry.paidAt.getTime() <= threshold,
    );
};

export { findPaidUnclaimedSwaps, PaidUnclaimedSwap };
