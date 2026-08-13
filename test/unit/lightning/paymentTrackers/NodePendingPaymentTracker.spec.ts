import { randomBytes } from 'crypto';
import Logger from '../../../../lib/Logger';
import { getHexString } from '../../../../lib/Utils';
import { LightningPaymentStatus } from '../../../../lib/db/models/LightningPayment';
import { NodeType } from '../../../../lib/db/models/ReverseSwap';
import LightningPaymentRepository from '../../../../lib/db/repositories/LightningPaymentRepository';
import SwapRepository from '../../../../lib/db/repositories/SwapRepository';
import type { LightningClient } from '../../../../lib/lightning/LightningClient';
import NodePendingPaymentTracker from '../../../../lib/lightning/paymentTrackers/NodePendingPaymentTracker';

class MockTracker extends NodePendingPaymentTracker {
  constructor() {
    super(Logger.disabledLogger, NodeType.CLN);
  }

  public trackPayment = jest.fn();

  public watchPayment = jest.fn();

  public isPermanentError = jest.fn();

  public parseErrorMessage = jest.fn();
}

describe('NodePendingPaymentTracker', () => {
  describe('handleSucceededPayment', () => {
    const tracker = new MockTracker();

    test('should set the success status', async () => {
      const preimageHash = getHexString(randomBytes(32));
      const nodeId = 'cln-1';

      LightningPaymentRepository.setStatus = jest.fn();

      await tracker['handleSucceededPayment'](
        { id: nodeId } as unknown as LightningClient,
        preimageHash,
        { feeMsat: 1_000, preimage: randomBytes(32) },
      );

      expect(LightningPaymentRepository.setStatus).toHaveBeenCalledTimes(1);
      expect(LightningPaymentRepository.setStatus).toHaveBeenCalledWith(
        preimageHash,
        nodeId,
        LightningPaymentStatus.Success,
      );
    });

    // The preimage is only recovered by the retry loop of the SwapNursery
    test('should not persist the preimage of the swap', async () => {
      LightningPaymentRepository.setStatus = jest.fn();
      SwapRepository.setInvoicePaid = jest.fn();

      await tracker['handleSucceededPayment'](
        { id: 'cln-1' } as unknown as LightningClient,
        getHexString(randomBytes(32)),
        { feeMsat: 1_000, preimage: randomBytes(32) },
      );

      expect(SwapRepository.setInvoicePaid).not.toHaveBeenCalled();
    });
  });

  describe('handleFailedPayment', () => {
    const tracker = new MockTracker();

    beforeEach(() => {
      tracker.isPermanentError = jest.fn().mockReturnValue(false);
      tracker.parseErrorMessage = jest.fn().mockImplementation((msg) => msg);
    });

    test('should set permanent failures', async () => {
      tracker.isPermanentError = jest.fn().mockReturnValue(true);

      const msg = 'incorrect payment details';
      const preimageHash = getHexString(randomBytes(32));
      const nodeId = 'cln-1';

      LightningPaymentRepository.setStatus = jest.fn();

      await tracker['handleFailedPayment'](
        {
          id: nodeId,
          isConnected: jest.fn().mockReturnValue(true),
        } as unknown as LightningClient,
        preimageHash,
        msg,
      );

      expect(LightningPaymentRepository.setStatus).toHaveBeenCalledTimes(1);
      expect(LightningPaymentRepository.setStatus).toHaveBeenCalledWith(
        preimageHash,
        nodeId,
        LightningPaymentStatus.PermanentFailure,
        msg,
      );
    });

    test('should set temporary failures', async () => {
      const preimageHash = getHexString(randomBytes(32));
      const nodeId = 'cln-1';

      LightningPaymentRepository.setStatus = jest.fn();

      await tracker['handleFailedPayment'](
        {
          id: nodeId,
          isConnected: jest.fn().mockReturnValue(true),
        } as unknown as LightningClient,
        preimageHash,
        'idk try again',
      );

      expect(LightningPaymentRepository.setStatus).toHaveBeenCalledTimes(1);
      expect(LightningPaymentRepository.setStatus).toHaveBeenCalledWith(
        preimageHash,
        nodeId,
        LightningPaymentStatus.TemporaryFailure,
        undefined,
      );
    });

    test('should not fail payment if client is not connected', async () => {
      LightningPaymentRepository.setStatus = jest.fn();

      const client = {
        id: 'cln-1',
        isConnected: jest.fn().mockReturnValue(false),
      } as unknown as LightningClient;

      await tracker['handleFailedPayment'](
        client,
        getHexString(randomBytes(32)),
        'error',
      );

      expect(LightningPaymentRepository.setStatus).not.toHaveBeenCalled();
    });

    test('should not fail payment when connection is dropped', async () => {
      LightningPaymentRepository.setStatus = jest.fn();

      const client = {
        id: 'cln-1',
        isConnected: jest.fn().mockReturnValue(true),
      } as unknown as LightningClient;

      await tracker['handleFailedPayment'](
        client,
        getHexString(randomBytes(32)),
        'Connection dropped',
      );

      expect(LightningPaymentRepository.setStatus).not.toHaveBeenCalled();
    });
  });
});
