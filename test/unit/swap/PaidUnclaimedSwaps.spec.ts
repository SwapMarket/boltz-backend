import { Op } from 'sequelize';
import { SwapUpdateEvent } from '../../../lib/consts/Enums';
import { LightningPaymentStatus } from '../../../lib/db/models/LightningPayment';
import LightningPaymentRepository from '../../../lib/db/repositories/LightningPaymentRepository';
import SwapRepository from '../../../lib/db/repositories/SwapRepository';
import { findPaidUnclaimedSwaps } from '../../../lib/swap/PaidUnclaimedSwaps';

jest.mock('../../../lib/db/repositories/SwapRepository');
jest.mock('../../../lib/db/repositories/LightningPaymentRepository');

describe('PaidUnclaimedSwaps', () => {
  const minutesAgo = (minutes: number) =>
    new Date(Date.now() - minutes * 60 * 1_000);

  const setSwaps = (swaps: any[]) =>
    (SwapRepository.getSwaps as jest.Mock).mockResolvedValue(swaps);

  const setPayments = (payments: any[]) =>
    (
      LightningPaymentRepository.findByPreimageHashesAndStatus as jest.Mock
    ).mockResolvedValue(payments);

  beforeEach(() => {
    jest.clearAllMocks();
    setPayments([]);
  });

  test('should query the swaps that have not been claimed yet', async () => {
    setSwaps([]);

    await expect(findPaidUnclaimedSwaps(0)).resolves.toEqual([]);

    expect(SwapRepository.getSwaps).toHaveBeenCalledWith({
      status: {
        [Op.in]: [SwapUpdateEvent.InvoicePending, SwapUpdateEvent.InvoicePaid],
      },
    });
    expect(
      LightningPaymentRepository.findByPreimageHashesAndStatus,
    ).not.toHaveBeenCalled();
  });

  test('should query the successful payments of the unclaimed swaps', async () => {
    setSwaps([
      { id: 'first', preimageHash: 'hash-1' },
      { id: 'second', preimageHash: 'hash-2' },
    ]);

    await findPaidUnclaimedSwaps(0);

    expect(
      LightningPaymentRepository.findByPreimageHashesAndStatus,
    ).toHaveBeenCalledWith(
      ['hash-1', 'hash-2'],
      LightningPaymentStatus.Success,
    );
  });

  test('should ignore swaps without a successful payment', async () => {
    const swap = { id: 'paid', preimageHash: 'hash-1' };
    setSwaps([swap, { id: 'unpaid', preimageHash: 'hash-2' }]);

    const paidAt = minutesAgo(30);
    setPayments([{ preimageHash: 'hash-1', updatedAt: paidAt }]);

    await expect(findPaidUnclaimedSwaps(0)).resolves.toEqual([
      { swap, paidAt },
    ]);
  });

  test('should include self payments that have no payment row', async () => {
    const paidAt = minutesAgo(30);
    const swap = {
      id: 'self-payment',
      preimageHash: 'hash-1',
      preimage: 'preimage',
      status: SwapUpdateEvent.InvoicePaid,
      updatedAt: paidAt,
    };
    setSwaps([swap]);
    setPayments([]);

    await expect(findPaidUnclaimedSwaps(0)).resolves.toEqual([
      { swap, paidAt },
    ]);
  });

  test('should not treat pending invoices without a payment row as paid', async () => {
    setSwaps([
      {
        id: 'pending',
        preimageHash: 'hash-1',
        status: SwapUpdateEvent.InvoicePending,
        updatedAt: minutesAgo(30),
      },
    ]);
    setPayments([]);

    await expect(findPaidUnclaimedSwaps(0)).resolves.toHaveLength(0);
  });

  test('should prefer the payment row over the swap timestamp', async () => {
    const paidAt = minutesAgo(30);
    const swap = {
      id: 'paid',
      preimageHash: 'hash-1',
      status: SwapUpdateEvent.InvoicePaid,
      updatedAt: minutesAgo(10),
    };
    setSwaps([swap]);
    setPayments([{ preimageHash: 'hash-1', updatedAt: paidAt }]);

    await expect(findPaidUnclaimedSwaps(0)).resolves.toEqual([
      { swap, paidAt },
    ]);
  });

  test('should apply the minimum age to self payments', async () => {
    setSwaps([
      {
        id: 'self-payment',
        preimageHash: 'hash-1',
        status: SwapUpdateEvent.InvoicePaid,
        updatedAt: minutesAgo(1),
      },
    ]);
    setPayments([]);

    await expect(findPaidUnclaimedSwaps(15 * 60 * 1_000)).resolves.toHaveLength(
      0,
    );
  });

  test('should ignore payments that succeeded more recently than the minimum age', async () => {
    setSwaps([{ id: 'paid', preimageHash: 'hash-1' }]);
    setPayments([{ preimageHash: 'hash-1', updatedAt: minutesAgo(1) }]);

    await expect(findPaidUnclaimedSwaps(15 * 60 * 1_000)).resolves.toHaveLength(
      0,
    );
  });

  test('should include payments that succeeded before the minimum age', async () => {
    setSwaps([{ id: 'paid', preimageHash: 'hash-1' }]);
    setPayments([{ preimageHash: 'hash-1', updatedAt: minutesAgo(30) }]);

    await expect(findPaidUnclaimedSwaps(15 * 60 * 1_000)).resolves.toHaveLength(
      1,
    );
  });

  test('should use the earliest successful payment of a swap', async () => {
    const swap = { id: 'paid', preimageHash: 'hash-1' };
    setSwaps([swap]);

    const earliest = minutesAgo(30);
    setPayments([
      { preimageHash: 'hash-1', updatedAt: minutesAgo(10) },
      { preimageHash: 'hash-1', updatedAt: earliest },
    ]);

    await expect(findPaidUnclaimedSwaps(0)).resolves.toEqual([
      { swap, paidAt: earliest },
    ]);
  });

  test('should keep the earliest payment when the later one comes second', async () => {
    const swap = { id: 'paid', preimageHash: 'hash-1' };
    setSwaps([swap]);

    const earliest = minutesAgo(30);
    setPayments([
      { preimageHash: 'hash-1', updatedAt: earliest },
      { preimageHash: 'hash-1', updatedAt: minutesAgo(10) },
    ]);

    await expect(findPaidUnclaimedSwaps(0)).resolves.toEqual([
      { swap, paidAt: earliest },
    ]);
  });
});
