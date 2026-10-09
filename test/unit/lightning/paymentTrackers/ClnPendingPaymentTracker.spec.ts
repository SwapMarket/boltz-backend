import { randomBytes } from 'crypto';
import Logger from '../../../../lib/Logger';
import { getHexString } from '../../../../lib/Utils';
import { LightningPaymentStatus } from '../../../../lib/db/models/LightningPayment';
import LightningPaymentRepository from '../../../../lib/db/repositories/LightningPaymentRepository';
import type ClnClient from '../../../../lib/lightning/cln/ClnClient';
import ClnClientDefault from '../../../../lib/lightning/cln/ClnClient';
import ClnPendingPaymentTracker from '../../../../lib/lightning/paymentTrackers/ClnPendingPaymentTracker';
import { PaymentStatusKind } from '../../../../lib/lightning/paymentTrackers/NodePendingPaymentTracker';

describe('ClnPendingPaymentTracker', () => {
  const preimageHash = getHexString(randomBytes(32));
  const invoice = 'lnbc1invoice';

  let tracker: ClnPendingPaymentTracker;
  let client: ClnClient;

  const checkPendingPayments = () =>
    (tracker as any)['checkPendingPayments']() as Promise<void>;
  const watched = () => (tracker as any)['paymentsToWatch'] as Map<string, any>;

  beforeEach(() => {
    LightningPaymentRepository.setStatus = jest.fn().mockResolvedValue(null);

    client = {
      id: 'cln-1',
      isConnected: jest.fn().mockReturnValue(true),
      listPays: jest.fn(),
      checkListPaysStatus: jest.fn(),
    } as unknown as ClnClient;

    tracker = new ClnPendingPaymentTracker(Logger.disabledLogger);
    tracker.watchPayment(client, invoice, preimageHash);
  });

  afterEach(() => {
    tracker.stop();
    jest.clearAllMocks();
  });

  test('should keep watching on a listPays transport error (no failure marked)', async () => {
    (client.listPays as jest.Mock).mockRejectedValue(
      new Error('14 UNAVAILABLE: connection reset'),
    );

    await checkPendingPayments();

    expect(LightningPaymentRepository.setStatus).not.toHaveBeenCalled();
    expect(watched().has(preimageHash)).toEqual(true);
  });

  test('should keep watching on an empty listPays result (no failure marked)', async () => {
    (client.listPays as jest.Mock).mockResolvedValue({
      decoded: {},
      pays: [],
    });

    await checkPendingPayments();

    expect(LightningPaymentRepository.setStatus).not.toHaveBeenCalled();
    expect(client.checkListPaysStatus).not.toHaveBeenCalled();
    expect(watched().has(preimageHash)).toEqual(true);
  });

  test('should keep watching while the payment is still pending', async () => {
    (client.listPays as jest.Mock).mockResolvedValue({
      decoded: {},
      pays: [{}],
    });
    (client.checkListPaysStatus as jest.Mock).mockRejectedValue(
      ClnClientDefault.paymentPendingError,
    );

    await checkPendingPayments();

    expect(LightningPaymentRepository.setStatus).not.toHaveBeenCalled();
    expect(watched().has(preimageHash)).toEqual(true);
  });

  test('should keep watching when the status is not resolved yet', async () => {
    (client.listPays as jest.Mock).mockResolvedValue({
      decoded: {},
      pays: [{}],
    });
    (client.checkListPaysStatus as jest.Mock).mockResolvedValue(undefined);

    await checkPendingPayments();

    expect(LightningPaymentRepository.setStatus).not.toHaveBeenCalled();
    expect(watched().has(preimageHash)).toEqual(true);
  });

  test('should fail the payment only on a definitive terminal failure', async () => {
    (client.listPays as jest.Mock).mockResolvedValue({
      decoded: {},
      pays: [{}],
    });
    (client.checkListPaysStatus as jest.Mock).mockRejectedValue(
      ClnClientDefault.paymentAllAttemptsFailed,
    );

    await checkPendingPayments();

    expect(LightningPaymentRepository.setStatus).toHaveBeenCalledWith(
      preimageHash,
      client.id,
      LightningPaymentStatus.TemporaryFailure,
      undefined,
    );
    expect(watched().has(preimageHash)).toEqual(false);
  });

  test('should not stop watching a terminal failure when the client is disconnected', async () => {
    (client.isConnected as jest.Mock).mockReturnValue(false);
    (client.listPays as jest.Mock).mockResolvedValue({
      decoded: {},
      pays: [{}],
    });
    (client.checkListPaysStatus as jest.Mock).mockRejectedValue(
      ClnClientDefault.paymentAllAttemptsFailed,
    );

    await checkPendingPayments();

    expect(LightningPaymentRepository.setStatus).not.toHaveBeenCalled();
    expect(watched().has(preimageHash)).toEqual(true);
  });

  test('should mark success and stop watching when the payment completed', async () => {
    const res = { feeMsat: 1, preimage: randomBytes(32) };
    (client.listPays as jest.Mock).mockResolvedValue({
      decoded: {},
      pays: [{}],
    });
    (client.checkListPaysStatus as jest.Mock).mockResolvedValue(res);

    await checkPendingPayments();

    expect(LightningPaymentRepository.setStatus).toHaveBeenCalledWith(
      preimageHash,
      client.id,
      LightningPaymentStatus.Success,
    );
    expect(watched().has(preimageHash)).toEqual(false);
  });

  describe('empty listPays results', () => {
    beforeEach(() => {
      (client.listPays as jest.Mock).mockResolvedValue({
        decoded: {},
        pays: [],
      });
    });

    test('should fail the payment after the grace period of empty results', async () => {
      for (
        let i = 1;
        i < ClnPendingPaymentTracker.maxEmptyListPaysChecks;
        i++
      ) {
        await checkPendingPayments();
      }
      expect(LightningPaymentRepository.setStatus).not.toHaveBeenCalled();
      expect(watched().has(preimageHash)).toEqual(true);

      await checkPendingPayments();

      expect(LightningPaymentRepository.setStatus).toHaveBeenCalledTimes(1);
      expect(LightningPaymentRepository.setStatus).toHaveBeenCalledWith(
        preimageHash,
        client.id,
        LightningPaymentStatus.TemporaryFailure,
        undefined,
      );
      expect(watched().has(preimageHash)).toEqual(false);
    });

    test('should not restart the grace period when watched again', async () => {
      for (
        let i = 1;
        i < ClnPendingPaymentTracker.maxEmptyListPaysChecks;
        i++
      ) {
        await checkPendingPayments();
      }

      tracker.watchPayment(client, invoice, preimageHash);
      await checkPendingPayments();

      expect(LightningPaymentRepository.setStatus).toHaveBeenCalledTimes(1);
      expect(watched().has(preimageHash)).toEqual(false);
    });

    test('should report pending while the payment is still watched', async () => {
      await expect(
        tracker.checkPaymentStatus(client, invoice, preimageHash),
      ).resolves.toEqual({ kind: PaymentStatusKind.Pending });
    });

    test('should report failed once the payment is no longer watched', async () => {
      watched().delete(preimageHash);

      await expect(
        tracker.checkPaymentStatus(client, invoice, preimageHash),
      ).resolves.toEqual({ kind: PaymentStatusKind.Failed });
    });
  });
});
