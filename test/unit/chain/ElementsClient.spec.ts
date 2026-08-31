import Logger from '../../../lib/Logger';
import type { ChainConfig } from '../../../lib/Config';
import ElementsClient from '../../../lib/chain/ElementsClient';
import type Sidecar from '../../../lib/sidecar/Sidecar';

jest.mock('../../../lib/chain/RpcClient', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    request: jest.fn(),
  })),
}));

describe('ElementsClient', () => {
  const client = new ElementsClient(
    Logger.disabledLogger,
    { on: jest.fn() } as unknown as Sidecar,
    'regtest',
    { host: '', port: 0 } as unknown as ChainConfig,
  );

  const mockResponse = (res: unknown) => {
    (client as unknown as { client: { request: jest.Mock } }).client = {
      request: jest.fn().mockResolvedValue(res),
    };
  };

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getWalletTransaction', () => {
    test('should leave numeric fee and amount untouched', async () => {
      mockResponse({ amount: 1, fee: 2, comment: '', hex: '' });

      const res = await client.getWalletTransaction('id');
      expect(res.amount).toEqual(1);
      expect(res.fee).toEqual(2);
    });

    test('should extract the bitcoin entry from confidential objects', async () => {
      mockResponse({
        amount: { bitcoin: 5 },
        fee: { bitcoin: 3 },
        comment: '',
        hex: '',
      });

      const res = await client.getWalletTransaction('id');
      expect(res.amount).toEqual(5);
      expect(res.fee).toEqual(3);
    });

    test('should throw on an unexpected fee structure', async () => {
      mockResponse({ amount: 1, fee: { liquid: 3 }, comment: '', hex: '' });

      await expect(client.getWalletTransaction('id')).rejects.toThrow(
        'unexpected fee structure in Elements wallet transaction',
      );
    });

    test('should throw on an unexpected amount structure', async () => {
      mockResponse({ amount: { liquid: 1 }, fee: 2, comment: '', hex: '' });

      await expect(client.getWalletTransaction('id')).rejects.toThrow(
        'unexpected amount structure in Elements wallet transaction',
      );
    });

    test('should throw when the bitcoin entry is not a number', async () => {
      mockResponse({
        amount: 1,
        fee: { bitcoin: '3' },
        comment: '',
        hex: '',
      });

      await expect(client.getWalletTransaction('id')).rejects.toThrow(
        'unexpected fee structure in Elements wallet transaction',
      );
    });
  });
});
