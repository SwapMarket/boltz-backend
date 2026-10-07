import Logger from '../../../../lib/Logger';
import type { IChainClient } from '../../../../lib/chain/ChainClient';
import RpcClient from '../../../../lib/chain/RpcClient';
import { resolveBitcoinNetwork } from '../../../../lib/consts/BitcoinNetworks';
import CoreWalletProvider from '../../../../lib/wallet/providers/CoreWalletProvider';
import NotBroadcastError from '../../../../lib/wallet/providers/NotBroadcastError';

describe('CoreWalletProvider', () => {
  const provider = (
    sendToAddress: jest.Mock,
    getWalletTransaction?: jest.Mock,
  ) =>
    new CoreWalletProvider(
      Logger.disabledLogger,
      {
        symbol: 'BTC',
        sendToAddress,
        getWalletTransaction:
          getWalletTransaction ??
          jest.fn().mockRejectedValue(new Error('unreachable')),
      } as unknown as IChainClient,
      resolveBitcoinNetwork('regtest')!,
    );

  test('should mark a refusal by the node as not broadcast', async () => {
    const refusal = RpcClient.markNodeError({
      code: -6,
      message: 'Insufficient funds',
    });
    await expect(
      provider(jest.fn().mockRejectedValue(refusal)).sendToAddress(
        'bcrt1q',
        1,
        2,
        'label',
      ),
    ).rejects.toBeInstanceOf(NotBroadcastError);
  });

  test('should not mark an error of another origin as not broadcast', async () => {
    const lookalike = { code: -6, message: 'not from the node' };
    await expect(
      provider(jest.fn().mockRejectedValue(lookalike)).sendToAddress(
        'bcrt1q',
        1,
        2,
        'label',
      ),
    ).rejects.toBe(lookalike);
  });

  test('should not mark a lost answer as not broadcast', async () => {
    const lost = new Error('socket hang up');
    await expect(
      provider(jest.fn().mockRejectedValue(lost)).sendToAddress(
        'bcrt1q',
        1,
        2,
        'label',
      ),
    ).rejects.toBe(lost);
  });

  test('should not mark an error after the send as not broadcast', async () => {
    const after = RpcClient.markNodeError({
      code: -5,
      message: 'Invalid or non-wallet transaction id',
    });
    await expect(
      provider(
        jest.fn().mockResolvedValue('txid'),
        jest.fn().mockRejectedValue(after),
      ).sendToAddress('bcrt1q', 1, 2, 'label'),
    ).rejects.toBe(after);
  });
});
