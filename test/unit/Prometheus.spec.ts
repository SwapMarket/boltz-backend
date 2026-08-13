import Logger from '../../lib/Logger';
import Prometheus from '../../lib/Prometheus';
import { findPaidUnclaimedSwaps } from '../../lib/swap/PaidUnclaimedSwaps';

jest.mock('../../lib/swap/PaidUnclaimedSwaps', () => ({
  findPaidUnclaimedSwaps: jest.fn().mockResolvedValue([]),
}));

describe('Prometheus', () => {
  // Gauges register in the global registry, so only one instance can be created
  const prometheus = new Prometheus(
    Logger.disabledLogger,
    {} as any,
    {} as any,
    { host: '127.0.0.1', port: 9_093 },
    [],
  );

  const getGauge = (name: string) =>
    (prometheus as any).swapRegistry.getSingleMetric(name);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('swap_paid_unclaimed_count', () => {
    const metricName = 'boltz_swap_paid_unclaimed_count';

    test('should report the number of paid but unclaimed swaps', async () => {
      (findPaidUnclaimedSwaps as jest.Mock).mockResolvedValue([{}, {}]);

      const { values } = await getGauge(metricName).get();

      expect(findPaidUnclaimedSwaps).toHaveBeenCalledWith(0);
      expect(values).toHaveLength(1);
      expect(values[0].value).toEqual(2);
    });

    test('should not throw when the query fails', async () => {
      (findPaidUnclaimedSwaps as jest.Mock).mockRejectedValue('no database');

      await expect(getGauge(metricName).get()).resolves.toBeDefined();
    });
  });
});
