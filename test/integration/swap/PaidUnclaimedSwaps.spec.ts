import Logger from '../../../lib/Logger';
import { SwapUpdateEvent } from '../../../lib/consts/Enums';
import Database from '../../../lib/db/Database';
import LightningPayment, {
  LightningPaymentStatus,
} from '../../../lib/db/models/LightningPayment';
import Swap from '../../../lib/db/models/Swap';
import LightningPaymentRepository from '../../../lib/db/repositories/LightningPaymentRepository';
import PairRepository from '../../../lib/db/repositories/PairRepository';
import SwapRepository from '../../../lib/db/repositories/SwapRepository';
import { findPaidUnclaimedSwaps } from '../../../lib/swap/PaidUnclaimedSwaps';
import { createSubmarineSwapData } from '../db/repositories/Fixtures';

describe('PaidUnclaimedSwaps', () => {
  let db: Database;
  const nodeId = 'lnd-1';

  const createSwap = async (status: SwapUpdateEvent, preimage?: string) => {
    const swap = await Swap.create(createSubmarineSwapData());
    return SwapRepository.setSwapStatus(
      preimage === undefined
        ? swap
        : await swap.update({ preimage, invoice: 'invoice' }),
      status,
    );
  };

  const fifteenMinutes = 15 * 60 * 1_000;

  // Sequelize refuses to write updatedAt, even with "silent"
  const backdate = async (swap: Swap, minutes: number) => {
    const date = new Date(Date.now() - minutes * 60 * 1_000);
    await Database.sequelize.query(
      'UPDATE swaps SET "updatedAt" = ? WHERE id = ?',
      {
        replacements: [
          date.toISOString().replace('T', ' ').replace('Z', ' +00:00'),
          swap.id,
        ],
      },
    );
  };

  const succeedPayment = async (preimageHash: string) => {
    await LightningPaymentRepository.create({ nodeId, preimageHash });
    await LightningPaymentRepository.setStatus(
      preimageHash,
      nodeId,
      LightningPaymentStatus.Success,
    );
  };

  beforeAll(async () => {
    db = new Database(Logger.disabledLogger, Database.memoryDatabase);
    await db.init();

    await PairRepository.addPair({
      id: 'BTC/BTC',
      base: 'BTC',
      quote: 'BTC',
    });
  });

  beforeEach(async () => {
    await LightningPayment.truncate();
    await Swap.truncate();
  });

  afterAll(async () => {
    await db.close();
  });

  test('should not find anything when there are no swaps', async () => {
    await expect(findPaidUnclaimedSwaps(0)).resolves.toEqual([]);
  });

  test('should find pending invoices with a successful payment', async () => {
    const swap = await createSwap(SwapUpdateEvent.InvoicePending);
    await succeedPayment(swap.preimageHash);

    const res = await findPaidUnclaimedSwaps(0);

    expect(res).toHaveLength(1);
    expect(res[0].swap.id).toEqual(swap.id);
    expect(res[0].paidAt).toBeInstanceOf(Date);
  });

  test('should find self payments that have no payment row', async () => {
    const swap = await createSwap(SwapUpdateEvent.InvoicePaid, 'preimage');

    const res = await findPaidUnclaimedSwaps(0);

    expect(res).toHaveLength(1);
    expect(res[0].swap.id).toEqual(swap.id);
    expect(res[0].paidAt).toEqual(res[0].swap.updatedAt);

    await expect(
      LightningPaymentRepository.findByPreimageHash(swap.preimageHash),
    ).resolves.toHaveLength(0);
  });

  test('should not find pending invoices without a successful payment', async () => {
    const swap = await createSwap(SwapUpdateEvent.InvoicePending);
    await LightningPaymentRepository.create({
      nodeId,
      preimageHash: swap.preimageHash,
    });

    await expect(findPaidUnclaimedSwaps(0)).resolves.toEqual([]);
  });

  test.each`
    status
    ${SwapUpdateEvent.TransactionClaimed}
    ${SwapUpdateEvent.SwapExpired}
    ${SwapUpdateEvent.InvoiceFailedToPay}
  `('should not find swaps with status $status', async ({ status }) => {
    const swap = await createSwap(status);
    await succeedPayment(swap.preimageHash);

    await expect(findPaidUnclaimedSwaps(0)).resolves.toEqual([]);
  });

  test('should not find swaps that were paid more recently than the minimum age', async () => {
    const swap = await createSwap(SwapUpdateEvent.InvoicePending);
    await succeedPayment(swap.preimageHash);

    await expect(findPaidUnclaimedSwaps(60 * 60 * 1_000)).resolves.toHaveLength(
      0,
    );
  });

  test('should find self payments whose claim keeps failing', async () => {
    const swap = await createSwap(SwapUpdateEvent.InvoicePaid, 'preimage');
    await backdate(swap, 30);

    await expect(findPaidUnclaimedSwaps(fifteenMinutes)).resolves.toHaveLength(
      1,
    );
  });

  // Why attemptSettleSwap must not settle an already paid swap again: the
  // fallback timestamp is refreshed by every write to the row
  test('should lose the fallback timestamp when the swap is settled again', async () => {
    const swap = await createSwap(SwapUpdateEvent.InvoicePaid, 'preimage');
    await backdate(swap, 30);

    await SwapRepository.setInvoicePaid(swap, 0, 'preimage');

    await expect(findPaidUnclaimedSwaps(fifteenMinutes)).resolves.toHaveLength(
      0,
    );
  });

  test('should find multiple unclaimed swaps', async () => {
    const withPayment = await createSwap(SwapUpdateEvent.InvoicePending);
    await succeedPayment(withPayment.preimageHash);
    const selfPayment = await createSwap(
      SwapUpdateEvent.InvoicePaid,
      'preimage',
    );

    const res = await findPaidUnclaimedSwaps(0);

    expect(res.map((entry) => entry.swap.id).sort()).toEqual(
      [withPayment.id, selfPayment.id].sort(),
    );
  });
});
