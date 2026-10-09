import { randomBytes } from 'crypto';
import Logger from '../../../../lib/Logger';
import { getHexString } from '../../../../lib/Utils';
import { LightningPaymentStatus } from '../../../../lib/db/models/LightningPayment';
import LightningPaymentRepository from '../../../../lib/db/repositories/LightningPaymentRepository';
import type LndClient from '../../../../lib/lightning/LndClient';
import LndPendingPaymentTracker from '../../../../lib/lightning/paymentTrackers/LndPendingPaymentTracker';
import {
  PaymentFailureReason,
  Payment_PaymentStatus,
} from '../../../../lib/proto/lnd/rpc';

const flush = async () => {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
};

describe('LndPendingPaymentTracker', () => {
  const preimageHash = getHexString(randomBytes(32));

  let tracker: LndPendingPaymentTracker;
  let client: LndClient;

  beforeEach(() => {
    jest.useFakeTimers();
    LightningPaymentRepository.setStatus = jest.fn().mockResolvedValue(null);

    client = {
      id: 'lnd-1',
      symbol: 'BTC',
      isConnected: jest.fn().mockReturnValue(true),
      trackPayment: jest.fn(),
    } as unknown as LndClient;

    tracker = new LndPendingPaymentTracker(Logger.disabledLogger);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  test('should keep watching (re-watch) on a stream error instead of dropping', async () => {
    (client.trackPayment as jest.Mock)
      .mockRejectedValueOnce(new Error('14 UNAVAILABLE: transport closed'))
      .mockResolvedValueOnce({
        status: Payment_PaymentStatus.FAILED,
        failureReason: PaymentFailureReason.FAILURE_REASON_TIMEOUT,
      });

    tracker.watchPayment(client, '', preimageHash);
    await flush();

    expect(client.trackPayment).toHaveBeenCalledTimes(1);
    expect(LightningPaymentRepository.setStatus).not.toHaveBeenCalled();

    jest.advanceTimersByTime(15_000);
    await flush();

    expect(client.trackPayment).toHaveBeenCalledTimes(2);
  });

  test('should mark success and stop watching', async () => {
    (client.trackPayment as jest.Mock).mockResolvedValue({
      status: Payment_PaymentStatus.SUCCEEDED,
      feeMsat: 1,
      paymentPreimage: getHexString(randomBytes(32)),
    });

    tracker.watchPayment(client, '', preimageHash);
    await flush();

    expect(LightningPaymentRepository.setStatus).toHaveBeenCalledWith(
      preimageHash,
      client.id,
      LightningPaymentStatus.Success,
    );

    jest.advanceTimersByTime(60_000);
    await flush();

    expect(client.trackPayment).toHaveBeenCalledTimes(1);
  });

  test('should re-watch a failed payment that could not be marked (disconnected)', async () => {
    (client.isConnected as jest.Mock).mockReturnValue(false);
    (client.trackPayment as jest.Mock).mockResolvedValue({
      status: Payment_PaymentStatus.FAILED,
      failureReason: PaymentFailureReason.FAILURE_REASON_TIMEOUT,
    });

    tracker.watchPayment(client, '', preimageHash);
    await flush();

    expect(LightningPaymentRepository.setStatus).not.toHaveBeenCalled();

    jest.advanceTimersByTime(15_000);
    await flush();

    expect(client.trackPayment).toHaveBeenCalledTimes(2);
  });
});
