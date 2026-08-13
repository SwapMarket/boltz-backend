import Logger from '../../../lib/Logger';
import { Emojis } from '../../../lib/notifications/Markup';
import NotificationClient from '../../../lib/notifications/NotificationClient';
import StuckClaimChecker from '../../../lib/notifications/StuckClaimChecker';
import { findPaidUnclaimedSwaps } from '../../../lib/swap/PaidUnclaimedSwaps';

jest.mock('../../../lib/swap/PaidUnclaimedSwaps', () => ({
  findPaidUnclaimedSwaps: jest.fn().mockResolvedValue([]),
}));

const mockSendMessage = jest.fn().mockResolvedValue(undefined);

jest.mock('../../../lib/notifications/NotificationClient', () => {
  return jest.fn().mockImplementation(() => ({
    sendMessage: mockSendMessage,
  }));
});

const MockedNotificationClient = <jest.Mock<NotificationClient>>(
  (<any>NotificationClient)
);

describe('StuckClaimChecker', () => {
  const stuckSwap = {
    swap: {
      id: 'stuck-swap',
      pair: 'BTC/BTC',
      status: 'invoice.pending',
    },
    paidAt: new Date(1_700_000_000_000),
  };

  let checker: StuckClaimChecker;

  const setStuck = (stuck: any[]) =>
    (findPaidUnclaimedSwaps as jest.Mock).mockResolvedValue(stuck);

  beforeEach(() => {
    jest.clearAllMocks();
    checker = new StuckClaimChecker(
      Logger.disabledLogger,
      new MockedNotificationClient(),
    );
  });

  test('should only consider payments that succeeded at least 15 minutes ago', async () => {
    setStuck([]);
    await checker.check();

    expect(findPaidUnclaimedSwaps).toHaveBeenCalledWith(15 * 60 * 1_000);
  });

  test('should not send a message when nothing is stuck', async () => {
    setStuck([]);
    await checker.check();

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  test('should alert when a paid swap has not been claimed', async () => {
    setStuck([stuckSwap]);
    await checker.check();

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.stringContaining(
        `${Emojis.RotatingLight} **Swap stuck-swap was paid but not claimed** ${Emojis.RotatingLight}`,
      ),
      true,
      true,
    );
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Pair: BTC/BTC'),
      true,
      true,
    );
  });

  test('should not alert again while the swap is still stuck', async () => {
    setStuck([stuckSwap]);

    await checker.check();
    await checker.check();

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  test('should send a message when the swap is not stuck anymore', async () => {
    setStuck([stuckSwap]);
    await checker.check();

    setStuck([]);
    await checker.check();

    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    expect(mockSendMessage).toHaveBeenLastCalledWith(
      `${Emojis.Checkmark} Swap stuck-swap is not waiting to be claimed anymore ${Emojis.Checkmark}`,
      true,
      false,
    );
  });

  test('should alert again when the swap gets stuck again', async () => {
    setStuck([stuckSwap]);
    await checker.check();

    setStuck([]);
    await checker.check();

    setStuck([stuckSwap]);
    await checker.check();

    expect(mockSendMessage).toHaveBeenCalledTimes(3);
    expect(mockSendMessage).toHaveBeenLastCalledWith(
      expect.stringContaining('was paid but not claimed'),
      true,
      true,
    );
  });

  test('should alert for every stuck swap', async () => {
    const other = {
      swap: { id: 'other-swap', pair: 'L-BTC/BTC', status: 'invoice.paid' },
      paidAt: new Date(1_700_000_000_000),
    };
    setStuck([stuckSwap, other]);

    await checker.check();

    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.stringContaining('**Swap other-swap was paid but not claimed**'),
      true,
      true,
    );
  });

  test('should only resolve the swaps that are not stuck anymore', async () => {
    const other = {
      swap: { id: 'other-swap', pair: 'L-BTC/BTC', status: 'invoice.paid' },
      paidAt: new Date(1_700_000_000_000),
    };
    setStuck([stuckSwap, other]);
    await checker.check();

    mockSendMessage.mockClear();
    setStuck([stuckSwap]);
    await checker.check();

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Swap other-swap is not waiting to be claimed'),
      true,
      false,
    );
  });

  test('should not reject when the query fails', async () => {
    (findPaidUnclaimedSwaps as jest.Mock).mockRejectedValue('no database');

    await expect(checker.check()).resolves.toBeUndefined();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  test('should alert again after the query failed', async () => {
    (findPaidUnclaimedSwaps as jest.Mock).mockRejectedValue('no database');
    await checker.check();

    setStuck([stuckSwap]);
    await checker.check();

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.stringContaining('was paid but not claimed'),
      true,
      true,
    );
  });
});
