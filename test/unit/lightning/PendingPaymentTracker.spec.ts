import { randomBytes } from 'crypto';
import Logger from '../../../lib/Logger';
import {
  getHexBuffer,
  getHexString,
  minutesToMilliseconds,
  secondsToMilliseconds,
} from '../../../lib/Utils';
import type LightningPayment from '../../../lib/db/models/LightningPayment';
import { LightningPaymentStatus } from '../../../lib/db/models/LightningPayment';
import { NodeType } from '../../../lib/db/models/ReverseSwap';
import type Swap from '../../../lib/db/models/Swap';
import LightningPaymentRepository from '../../../lib/db/repositories/LightningPaymentRepository';
import ReferralRepository from '../../../lib/db/repositories/ReferralRepository';
import LightningErrors from '../../../lib/lightning/Errors';
import type { LightningClient } from '../../../lib/lightning/LightningClient';
import NoExistingPaymentActionError from '../../../lib/lightning/NoExistingPaymentActionError';
import PendingPaymentTracker from '../../../lib/lightning/PendingPaymentTracker';
import type ClnPendingPaymentTracker from '../../../lib/lightning/paymentTrackers/ClnPendingPaymentTracker';

describe('PendingPaymentTracker', () => {
  const paymentTimeoutMinutes = 30;
  const tracker = new PendingPaymentTracker(
    Logger.disabledLogger,
    {} as any,
    paymentTimeoutMinutes,
  );
  const trackerWithoutPaymentTimeout = new PendingPaymentTracker(
    Logger.disabledLogger,
    {} as any,
  );

  describe('constructor', () => {
    let mockLogger: any;

    beforeEach(() => {
      mockLogger = {
        info: jest.fn(),
        debug: jest.fn(),
      };
    });

    test('should set paymentTimeoutMinutes when a valid number is provided', () => {
      const validTimeout = 45;
      const numericTracker = new PendingPaymentTracker(
        mockLogger,
        {} as any,
        validTimeout,
      );

      expect(numericTracker['paymentTimeoutMinutes']).toBe(validTimeout);
      expect(mockLogger.info).toHaveBeenCalledWith(
        `Payment timeout configured: ${validTimeout} minutes`,
      );
      (
        numericTracker.lightningTrackers[
          NodeType.CLN
        ] as ClnPendingPaymentTracker
      ).stop();
    });

    test('should not set paymentTimeoutMinutes when undefined is provided', () => {
      const undefinedTracker = new PendingPaymentTracker(
        mockLogger,
        {} as any,
        undefined,
      );

      expect(undefinedTracker['paymentTimeoutMinutes']).toBeUndefined();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Payment timeout not configured',
      );
      (
        undefinedTracker.lightningTrackers[
          NodeType.CLN
        ] as ClnPendingPaymentTracker
      ).stop();
    });

    test('should not set paymentTimeoutMinutes when non-numeric value is provided', () => {
      const stringTracker = new PendingPaymentTracker(
        mockLogger,
        {} as any,
        '60' as any,
      );

      expect(stringTracker['paymentTimeoutMinutes']).toBeUndefined();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Payment timeout not configured',
      );
      (
        stringTracker.lightningTrackers[
          NodeType.CLN
        ] as ClnPendingPaymentTracker
      ).stop();
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    (
      tracker.lightningTrackers[NodeType.CLN] as ClnPendingPaymentTracker
    ).stop();
    (
      trackerWithoutPaymentTimeout.lightningTrackers[
        NodeType.CLN
      ] as ClnPendingPaymentTracker
    ).stop();
  });

  describe('getRelevantNode', () => {
    const preferredNode = { id: 'preferred' } as unknown as LightningClient;
    const swap = { invoice: 'lnbcrt1' } as unknown as Swap;
    const currency = { lndClients: new Map(), clnClient: undefined } as any;

    beforeEach(() => {
      (tracker as any).sidecar = {
        decodeInvoiceOrOffer: jest
          .fn()
          .mockResolvedValue({ paymentHash: randomBytes(32) }),
      };
    });

    test('should return existingRelevantAction undefined when no relevant payment exists', async () => {
      LightningPaymentRepository.findByPreimageHash = jest
        .fn()
        .mockResolvedValue([
          {
            status: LightningPaymentStatus.TemporaryFailure,
          } as LightningPayment,
        ]);

      const res = await tracker.getRelevantNode(currency, swap, preferredNode);

      expect(res.existingRelevantAction).toBeUndefined();
      expect(res.node).toBe(preferredNode);
    });

    test('should return the in-flight payment as existingRelevantAction', async () => {
      const pending = {
        status: LightningPaymentStatus.Pending,
        nodeId: 'missing',
      } as LightningPayment;
      LightningPaymentRepository.findByPreimageHash = jest
        .fn()
        .mockResolvedValue([pending]);

      const res = await tracker.getRelevantNode(currency, swap, preferredNode);

      expect(res.existingRelevantAction).toBe(pending);
      expect(res.node).toBe(preferredNode);
    });
  });

  describe('sendPayment with an already succeeded payment', () => {
    const preimage = randomBytes(32);
    const preimageHash = getHexString(randomBytes(32));

    const swap = { id: 'swap-id', invoice: 'invoice' } as unknown as Swap;

    const payments = [
      {
        preimageHash,
        nodeId: 'lnd-1',
        status: LightningPaymentStatus.Success,
      },
    ] as LightningPayment[];

    const nodeThatPaid = {
      id: 'lnd-1',
      symbol: 'BTC',
      type: NodeType.LND,
      sendPayment: jest.fn(),
      trackPayment: jest.fn().mockResolvedValue({
        feeMsat: 21,
        paymentPreimage: getHexString(preimage),
      }),
    } as unknown as LightningClient;

    beforeEach(() => {
      jest.clearAllMocks();
      LightningPaymentRepository.create = jest.fn();
      tracker['lightningNodes'].set(
        'BTC',
        new Map([[nodeThatPaid.id, nodeThatPaid]]),
      );
    });

    test('should recover the preimage without paying again', async () => {
      const res = await tracker.sendPayment(
        swap,
        nodeThatPaid,
        preimageHash,
        payments,
      );

      expect(res).toEqual({ feeMsat: 21, preimage });
      expect(nodeThatPaid.sendPayment).not.toHaveBeenCalled();
      expect(LightningPaymentRepository.create).not.toHaveBeenCalled();
    });

    test('should return undefined when the node that paid is not available', async () => {
      tracker['lightningNodes'].set('BTC', new Map());

      await expect(
        tracker.sendPayment(swap, nodeThatPaid, preimageHash, payments),
      ).resolves.toBeUndefined();
    });
  });

  describe('sendPayment recovery authorization', () => {
    const swap = {
      id: 'recovery-only',
      invoice: 'lnbcrt1',
    } as unknown as Swap;
    const lightningClient = {
      id: 'lnd-1',
      type: NodeType.LND,
      symbol: 'BTC',
    } as unknown as LightningClient;
    const paymentHash = getHexString(randomBytes(32));

    let sendPaymentWithNode: jest.SpyInstance;

    beforeEach(() => {
      sendPaymentWithNode = jest
        .spyOn(tracker as any, 'sendPaymentWithNode')
        .mockResolvedValue(undefined);
    });

    afterEach(() => {
      sendPaymentWithNode.mockRestore();
    });

    test.each([
      ['no payment rows', []],
      [
        'only a temporary failure',
        [{ status: LightningPaymentStatus.TemporaryFailure }],
      ],
    ])(
      'should not create a payment in recovery-only mode with %s',
      async (_name, payments) => {
        await expect(
          tracker.sendPayment(
            swap,
            lightningClient,
            paymentHash,
            payments as LightningPayment[],
            undefined,
            undefined,
            false,
          ),
        ).rejects.toBeInstanceOf(NoExistingPaymentActionError);

        expect(sendPaymentWithNode).not.toHaveBeenCalled();
      },
    );

    test('should preserve recovery of a pending payment', async () => {
      await expect(
        tracker.sendPayment(
          swap,
          lightningClient,
          paymentHash,
          [
            {
              status: LightningPaymentStatus.Pending,
              nodeId: lightningClient.id,
            } as LightningPayment,
          ],
          undefined,
          undefined,
          false,
        ),
      ).resolves.toBeUndefined();

      expect(sendPaymentWithNode).not.toHaveBeenCalled();
    });

    test('should preserve recovery of a successful payment', async () => {
      const response = {
        feeMsat: 21,
        preimage: randomBytes(32),
      };
      const getSuccessfulPaymentDetails = jest
        .spyOn(tracker as any, 'getSuccessfulPaymentDetails')
        .mockResolvedValue(response);

      await expect(
        tracker.sendPayment(
          swap,
          lightningClient,
          paymentHash,
          [
            {
              status: LightningPaymentStatus.Success,
              nodeId: lightningClient.id,
            } as LightningPayment,
          ],
          undefined,
          undefined,
          false,
        ),
      ).resolves.toEqual(response);

      expect(getSuccessfulPaymentDetails).toHaveBeenCalledTimes(1);
      expect(sendPaymentWithNode).not.toHaveBeenCalled();
      getSuccessfulPaymentDetails.mockRestore();
    });
  });

  describe('sendPaymentWithNode', () => {
    const lightningClient = {
      id: 'lnd-1',
      type: NodeType.LND,
      sendPayment: jest.fn().mockResolvedValue({
        feeMsat: 21,
        preimage: randomBytes(32),
      }),
    } as unknown as LightningClient;

    beforeAll(() => {
      LightningPaymentRepository.create = jest.fn();
      LightningPaymentRepository.setStatus = jest.fn();
    });

    test('should use max payment fee ratio from referral', async () => {
      const swap = {
        pair: 'BTC/BTC',
        referral: 'test',
        invoice: 'invoice',
      } as unknown as Swap;

      ReferralRepository.getReferralById = jest.fn().mockResolvedValue({
        maxRoutingFeeRatio: jest.fn().mockReturnValue(0.01),
      });

      await tracker['sendPaymentWithNode'](
        swap,
        lightningClient,
        getHexString(randomBytes(32)),
      );

      expect(ReferralRepository.getReferralById).toHaveBeenCalledTimes(1);
      expect(ReferralRepository.getReferralById).toHaveBeenCalledWith(
        swap.referral,
      );

      expect(lightningClient.sendPayment).toHaveBeenCalledTimes(1);
      expect(lightningClient.sendPayment).toHaveBeenCalledWith(
        swap.invoice,
        undefined,
        0.01,
        undefined,
      );
    });

    test('should not throw no referral for swap can be found', async () => {
      const swap = {
        pair: 'BTC/BTC',
        referral: 'test',
        invoice: 'invoice',
      } as unknown as Swap;

      ReferralRepository.getReferralById = jest.fn().mockResolvedValue(null);

      await tracker['sendPaymentWithNode'](
        swap,
        lightningClient,
        getHexString(randomBytes(32)),
      );

      expect(ReferralRepository.getReferralById).toHaveBeenCalledTimes(1);
      expect(ReferralRepository.getReferralById).toHaveBeenCalledWith(
        swap.referral,
      );

      expect(lightningClient.sendPayment).toHaveBeenCalledTimes(1);
      expect(lightningClient.sendPayment).toHaveBeenCalledWith(
        swap.invoice,
        undefined,
        undefined,
        undefined,
      );
    });

    test('should not throw when swap has no referral', async () => {
      const swap = {
        pair: 'BTC/BTC',
        invoice: 'invoice',
      } as unknown as Swap;

      ReferralRepository.getReferralById = jest.fn().mockResolvedValue({});

      await tracker['sendPaymentWithNode'](
        swap,
        lightningClient,
        getHexString(randomBytes(32)),
      );

      expect(ReferralRepository.getReferralById).toHaveBeenCalledTimes(0);

      expect(lightningClient.sendPayment).toHaveBeenCalledTimes(1);
      expect(lightningClient.sendPayment).toHaveBeenCalledWith(
        swap.invoice,
        undefined,
        undefined,
        undefined,
      );
    });

    test('should watch payment for temporarily failed CLN payments', async () => {
      const clnClient = {
        id: 'cln-1',
        type: NodeType.CLN,
        sendPayment: jest.fn().mockRejectedValue('xpay doing something weird'),
      } as unknown as LightningClient;

      tracker.lightningTrackers[NodeType.CLN].watchPayment = jest.fn();

      const swap = {
        pair: 'BTC/BTC',
        invoice: 'invoice',
      } as unknown as Swap;

      const preimageHash = getHexString(randomBytes(32));

      await expect(
        tracker['sendPaymentWithNode'](swap, clnClient, preimageHash),
      ).resolves.toEqual(undefined);

      expect(
        tracker.lightningTrackers[NodeType.CLN].watchPayment,
      ).toHaveBeenCalledTimes(1);
      expect(
        tracker.lightningTrackers[NodeType.CLN].watchPayment,
      ).toHaveBeenCalledWith(clnClient, swap.invoice, preimageHash);
    });
  });

  describe('sendPayment', () => {
    const preimage = randomBytes(32);
    const preimageHash = getHexString(randomBytes(32));

    const swap = {
      id: 'swapId',
      pair: 'BTC/BTC',
      invoice: 'lnbcrt1',
    } as unknown as Swap;

    const clnClient = {
      id: 'cln-1',
      symbol: 'BTC',
      type: NodeType.CLN,
      sendPayment: jest.fn(),
      checkPayStatus: jest.fn().mockResolvedValue({ feeMsat: 21, preimage }),
    } as unknown as LightningClient;

    const lndClient = {
      id: 'lnd-1',
      symbol: 'BTC',
      type: NodeType.LND,
      sendPayment: jest.fn(),
      trackPayment: jest.fn().mockResolvedValue({
        feeMsat: '42',
        paymentPreimage: getHexString(preimage),
      }),
    } as unknown as LightningClient;

    const payment = (
      status: LightningPaymentStatus,
      nodeId: string = clnClient.id,
      error?: string,
    ) => ({ status, nodeId, error }) as LightningPayment;

    beforeEach(() => {
      LightningPaymentRepository.create = jest.fn();
      LightningPaymentRepository.setStatus = jest.fn();
      tracker['lightningNodes'].set(
        'BTC',
        new Map([
          [clnClient.id, clnClient],
          [lndClient.id, lndClient],
        ]),
      );
    });

    test('should resolve the preimage of a successful CLN payment', async () => {
      await expect(
        tracker.sendPayment(swap, clnClient, preimageHash, [
          payment(LightningPaymentStatus.Success),
        ]),
      ).resolves.toEqual({ feeMsat: 21, preimage });

      expect((clnClient as any).checkPayStatus).toHaveBeenCalledTimes(1);
      expect((clnClient as any).checkPayStatus).toHaveBeenCalledWith(
        swap.invoice,
      );
    });

    test('should resolve the preimage of a successful LND payment', async () => {
      await expect(
        tracker.sendPayment(swap, lndClient, preimageHash, [
          payment(LightningPaymentStatus.Success, lndClient.id),
        ]),
      ).resolves.toEqual({ feeMsat: 42, preimage });

      expect((lndClient as any).trackPayment).toHaveBeenCalledTimes(1);
      expect((lndClient as any).trackPayment).toHaveBeenCalledWith(
        getHexBuffer(preimageHash),
      );
    });

    test('should prefer a pending payment over a successful one', async () => {
      await expect(
        tracker.sendPayment(swap, clnClient, preimageHash, [
          payment(LightningPaymentStatus.Success),
          payment(LightningPaymentStatus.Pending),
        ]),
      ).resolves.toBeUndefined();

      expect((clnClient as any).checkPayStatus).not.toHaveBeenCalled();
    });

    test('should not resolve a successful payment of an unavailable node', async () => {
      await expect(
        tracker.sendPayment(swap, clnClient, preimageHash, [
          payment(LightningPaymentStatus.Success, 'gone'),
        ]),
      ).resolves.toBeUndefined();

      expect((clnClient as any).checkPayStatus).not.toHaveBeenCalled();
    });

    test('should rethrow the stored error of a permanently failed payment', async () => {
      const error = 'incorrect payment details';

      await expect(
        tracker.sendPayment(swap, clnClient, preimageHash, [
          payment(LightningPaymentStatus.PermanentFailure, clnClient.id, error),
        ]),
      ).rejects.toEqual(error);
    });

    test.each`
      status
      ${LightningPaymentStatus.Pending}
      ${LightningPaymentStatus.Success}
      ${LightningPaymentStatus.PermanentFailure}
    `(
      'should never start a new payment when a $status one exists',
      async ({ status }) => {
        await tracker
          .sendPayment(swap, clnClient, preimageHash, [payment(status)], 1)
          .catch(() => {});

        expect(clnClient.sendPayment).not.toHaveBeenCalled();
        expect(LightningPaymentRepository.create).not.toHaveBeenCalled();
      },
    );
  });

  describe('checkInvoiceTimeout', () => {
    const swapId = 'testSwap123';
    const paymentHash = 'paymentHash123';
    const nodeId = 'lnd-1';
    const expectedError = LightningErrors.PAYMENT_TIMED_OUT().message;

    beforeEach(() => {
      jest.clearAllMocks();
      LightningPaymentRepository.setStatus = jest.fn().mockResolvedValue([1]);

      jest.spyOn(Date, 'now').mockReturnValue(1742265902131);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('should not time out when there are no payments', async () => {
      const payments: LightningPayment[] = [];

      await expect(
        tracker['checkInvoiceTimeout'](
          { id: swapId },
          paymentHash,
          nodeId,
          payments,
        ),
      ).resolves.toBeUndefined();

      expect(LightningPaymentRepository.setStatus).not.toHaveBeenCalled();
    });

    test('should not time out when payments are recent', async () => {
      const recentPayment = {
        status: LightningPaymentStatus.TemporaryFailure,
        createdAt: new Date(
          Date.now() - minutesToMilliseconds(paymentTimeoutMinutes / 2),
        ),
      } as LightningPayment;

      await expect(
        tracker['checkInvoiceTimeout']({ id: swapId }, paymentHash, nodeId, [
          recentPayment,
        ]),
      ).resolves.toBeUndefined();

      expect(LightningPaymentRepository.setStatus).not.toHaveBeenCalled();
    });

    test('should not time out when timeout is not configured', async () => {
      const oldPayment = {
        status: LightningPaymentStatus.TemporaryFailure,
        createdAt: new Date(
          Date.now() - minutesToMilliseconds(paymentTimeoutMinutes + 5),
        ),
      } as LightningPayment;

      await expect(
        trackerWithoutPaymentTimeout['checkInvoiceTimeout'](
          { id: swapId },
          paymentHash,
          nodeId,
          [oldPayment],
        ),
      ).resolves.toBeUndefined();

      expect(LightningPaymentRepository.setStatus).not.toHaveBeenCalled();
    });

    test('should time out when one of the payments exceeds timeout', async () => {
      const payments = [
        {
          status: LightningPaymentStatus.Pending,
          createdAt: new Date(
            Date.now() - minutesToMilliseconds(paymentTimeoutMinutes / 3),
          ),
        } as LightningPayment,
        {
          status: LightningPaymentStatus.TemporaryFailure,
          createdAt: new Date(
            Date.now() - minutesToMilliseconds(paymentTimeoutMinutes + 1),
          ),
        } as LightningPayment,
        {
          status: LightningPaymentStatus.TemporaryFailure,
          createdAt: new Date(
            Date.now() - minutesToMilliseconds(paymentTimeoutMinutes / 2),
          ),
        } as LightningPayment,
      ];

      await expect(
        tracker['checkInvoiceTimeout'](
          { id: swapId },
          paymentHash,
          nodeId,
          payments,
        ),
      ).rejects.toEqual(expectedError);

      expect(LightningPaymentRepository.setStatus).toHaveBeenCalledWith(
        paymentHash,
        nodeId,
        LightningPaymentStatus.PermanentFailure,
        expectedError,
      );
    });

    test('should not consider payments with statuses other than TemporaryFailure', async () => {
      const payments = [
        {
          status: LightningPaymentStatus.PermanentFailure,
          createdAt: new Date(
            Date.now() - minutesToMilliseconds(paymentTimeoutMinutes * 2),
          ),
        } as LightningPayment,
        {
          status: LightningPaymentStatus.Success,
          createdAt: new Date(
            Date.now() - minutesToMilliseconds(paymentTimeoutMinutes * 2),
          ),
        } as LightningPayment,
        {
          status: LightningPaymentStatus.Pending,
          createdAt: new Date(
            Date.now() - minutesToMilliseconds(paymentTimeoutMinutes * 2),
          ),
        } as LightningPayment,
      ];

      await expect(
        tracker['checkInvoiceTimeout'](
          { id: swapId },
          paymentHash,
          nodeId,
          payments,
        ),
      ).resolves.toBeUndefined();

      expect(LightningPaymentRepository.setStatus).not.toHaveBeenCalled();
    });

    test('should respect swap.paymentTimeout over global timeout', async () => {
      const oldPayment = {
        status: LightningPaymentStatus.TemporaryFailure,
        createdAt: new Date(Date.now() - secondsToMilliseconds(2)),
      } as LightningPayment;

      await expect(
        tracker['checkInvoiceTimeout'](
          { id: swapId, paymentTimeout: 1 },
          paymentHash,
          nodeId,
          [oldPayment],
        ),
      ).rejects.toEqual(expectedError);
      expect(LightningPaymentRepository.setStatus).toHaveBeenCalledWith(
        paymentHash,
        nodeId,
        LightningPaymentStatus.PermanentFailure,
        expectedError,
      );
    });
  });

  describe('resolveCrossNodePayment', () => {
    const paymentHash = getHexString(randomBytes(32));
    const swap = {
      id: 'swap-cross',
      invoice: 'lnbcrt-cross',
    } as unknown as Swap;
    const chosenNode = {
      id: 'lnd-1',
      type: NodeType.LND,
      symbol: 'BTC',
    } as unknown as LightningClient;
    const clnClient = {
      id: 'cln-1',
      type: NodeType.CLN,
      symbol: 'BTC',
    } as unknown as LightningClient;

    const otherNodeTempFailure = [
      {
        nodeId: 'cln-1',
        status: LightningPaymentStatus.TemporaryFailure,
      } as LightningPayment,
    ];

    beforeEach(() => {
      jest.clearAllMocks();
      (tracker as any).lightningNodes.get('BTC').set('cln-1', clnClient);
      LightningPaymentRepository.setStatus = jest.fn();
      tracker.lightningTrackers[NodeType.CLN].watchPayment = jest.fn();
      tracker.lightningTrackers[NodeType.CLN].checkPaymentStatus = jest.fn();
    });

    test('should proceed when there is no attempt on another node', async () => {
      const res = await tracker['resolveCrossNodePayment'](
        swap,
        paymentHash,
        chosenNode,
        [
          {
            nodeId: 'lnd-1',
            status: LightningPaymentStatus.TemporaryFailure,
          } as LightningPayment,
        ],
      );

      expect(res).toEqual({ action: 'proceed' });
      expect(
        tracker.lightningTrackers[NodeType.CLN].checkPaymentStatus,
      ).not.toHaveBeenCalled();
    });

    test('should abstain while a previous attempt is still pending', async () => {
      tracker.lightningTrackers[NodeType.CLN].checkPaymentStatus = jest
        .fn()
        .mockResolvedValue({ kind: 'pending' });

      const res = await tracker['resolveCrossNodePayment'](
        swap,
        paymentHash,
        chosenNode,
        otherNodeTempFailure,
      );

      expect(res).toEqual({ action: 'abstain' });
      expect(
        tracker.lightningTrackers[NodeType.CLN].watchPayment,
      ).toHaveBeenCalledWith(clnClient, swap.invoice, paymentHash);
    });

    test('should abstain when the previous attempt status is unknown', async () => {
      tracker.lightningTrackers[NodeType.CLN].checkPaymentStatus = jest
        .fn()
        .mockResolvedValue({ kind: 'unknown' });

      const res = await tracker['resolveCrossNodePayment'](
        swap,
        paymentHash,
        chosenNode,
        otherNodeTempFailure,
      );

      expect(res).toEqual({ action: 'abstain' });
    });

    test('should settle when the previous attempt already succeeded', async () => {
      const response = { feeMsat: 21, preimage: randomBytes(32) };
      tracker.lightningTrackers[NodeType.CLN].checkPaymentStatus = jest
        .fn()
        .mockResolvedValue({ kind: 'succeeded', response });

      const res = await tracker['resolveCrossNodePayment'](
        swap,
        paymentHash,
        chosenNode,
        otherNodeTempFailure,
      );

      expect(res).toEqual({ action: 'settle', response });
      expect(LightningPaymentRepository.setStatus).toHaveBeenCalledWith(
        paymentHash,
        'cln-1',
        LightningPaymentStatus.Success,
      );
    });

    test('should proceed when the previous attempt terminally failed', async () => {
      tracker.lightningTrackers[NodeType.CLN].checkPaymentStatus = jest
        .fn()
        .mockResolvedValue({ kind: 'failed' });

      const res = await tracker['resolveCrossNodePayment'](
        swap,
        paymentHash,
        chosenNode,
        otherNodeTempFailure,
      );

      expect(res).toEqual({ action: 'proceed' });
    });

    test('should abstain when the previous node is unavailable', async () => {
      const res = await tracker['resolveCrossNodePayment'](
        swap,
        paymentHash,
        chosenNode,
        [
          {
            nodeId: 'cln-missing',
            status: LightningPaymentStatus.TemporaryFailure,
          } as LightningPayment,
        ],
      );

      expect(res).toEqual({ action: 'abstain' });
    });
  });
});
