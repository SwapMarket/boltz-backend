import { randomBytes } from 'crypto';
import Logger from '../../../lib/Logger';
import { getVersion } from '../../../lib/Utils';
import { ClientStatus, SwapUpdateEvent } from '../../../lib/consts/Enums';
import type * as sidecarrpc from '../../../lib/proto/boltzr';
import Sidecar from '../../../lib/sidecar/Sidecar';

describe('Sidecar', () => {
  const sidecar = new Sidecar(Logger.disabledLogger, {} as any, '');

  describe('validateVersion', () => {
    test('should check for exact match in production', async () => {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-expect-error
      Sidecar['isProduction'] = true;

      sidecar.getInfo = jest.fn().mockResolvedValue({
        version: getVersion(),
      });

      await sidecar.validateVersion();
    });

    test('should throw on slight mismatch in production', async () => {
      const sidecarVersion = getVersion().split('-');
      sidecarVersion[1] = randomBytes(4).toString('hex');
      sidecar.getInfo = jest.fn().mockResolvedValue({
        version: sidecarVersion.join('-'),
      });

      await expect(sidecar.validateVersion()).rejects.toEqual(
        `sidecar version incompatible: ${(await sidecar.getInfo()).version} vs ${getVersion()}`,
      );
    });

    test('should allow slight mismatch in development', async () => {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-expect-error
      Sidecar['isProduction'] = false;

      const sidecarVersion = getVersion().split('-');
      sidecarVersion[1] = randomBytes(4).toString('hex');
      sidecar.getInfo = jest.fn().mockResolvedValue({
        version: sidecarVersion.join('-'),
      });

      await sidecar.validateVersion();
    });

    test('should throw on version mismatch in development', async () => {
      const sidecarVersion = getVersion().split('-');
      sidecarVersion[0] = randomBytes(4).toString('hex');
      sidecar.getInfo = jest.fn().mockResolvedValue({
        version: sidecarVersion.join('-'),
      });

      await expect(sidecar.validateVersion()).rejects.toEqual(
        `sidecar version incompatible: ${(await sidecar.getInfo()).version} vs ${getVersion()}`,
      );
    });
  });

  describe('trimDirtySuffix', () => {
    test('should trim dirty suffix', () => {
      const version = '3.8.0-1ec2944b';

      expect(Sidecar['trimDirtySuffix'](`${version}-dirty`)).toEqual(version);
    });
  });

  describe('deleteWebHook', () => {
    test('should call the sidecar to delete a webhook', async () => {
      const unaryNodeCall = jest.fn().mockResolvedValue(undefined);
      sidecar['unaryNodeCall'] = unaryNodeCall;

      await sidecar.deleteWebHook('swap-id');

      expect(unaryNodeCall).toHaveBeenCalledTimes(1);
      expect(unaryNodeCall).toHaveBeenCalledWith('deleteWebHook', {
        id: 'swap-id',
      });
    });
  });

  describe('subscribeSwapUpdates', () => {
    test('should serialize transaction confirmed flag', async () => {
      const stream = {
        on: jest.fn().mockReturnThis(),
        write: jest.fn(),
        cancel: jest.fn(),
      };
      let swapUpdateListener:
        | ((args: {
            id: string;
            status: {
              status: SwapUpdateEvent;
              transaction?: {
                id: string;
                confirmed?: boolean;
              };
            };
          }) => Promise<void>)
        | undefined;

      sidecar['client'] = {
        swapUpdate: jest.fn().mockReturnValue(stream),
      } as any;
      sidecar['eventHandler'] = {
        on: jest.fn((event: string, listener: typeof swapUpdateListener) => {
          if (event === 'swap.update') {
            swapUpdateListener = listener;
          }
        }),
      } as any;
      sidecar['sendWebHook'] = jest.fn().mockResolvedValue(undefined);

      sidecar['subscribeSwapUpdates']();

      expect(swapUpdateListener).toBeDefined();

      await swapUpdateListener!({
        id: 'swap-id',
        status: {
          status: SwapUpdateEvent.TransactionRefunded,
          transaction: {
            id: 'refund-tx',
            confirmed: true,
          },
        },
      });

      expect(stream.write).toHaveBeenCalledTimes(1);

      const request = stream.write.mock
        .calls[0][0] as sidecarrpc.SwapUpdateRequest;
      const update = request.status[0];
      const transaction = update.transactionInfo!;

      expect(update.status).toEqual(SwapUpdateEvent.TransactionRefunded);
      expect(transaction.id).toEqual('refund-tx');
      expect(transaction.confirmed).toEqual(true);
    });
  });

  describe('reconnect', () => {
    const createStreamMock = () => ({
      on: jest.fn().mockReturnThis(),
      write: jest.fn(),
      cancel: jest.fn(),
    });

    const setupClientMock = () => {
      const streams = {
        swapUpdate: createStreamMock(),
        sendSwapUpdate: createStreamMock(),
        blockAdded: createStreamMock(),
        transactionFound: createStreamMock(),
      };

      sidecar['client'] = {
        swapUpdate: jest.fn().mockReturnValue(streams.swapUpdate),
        sendSwapUpdate: jest.fn().mockReturnValue(streams.sendSwapUpdate),
        blockAdded: jest.fn().mockReturnValue(streams.blockAdded),
        transactionFound: jest.fn().mockReturnValue(streams.transactionFound),
      } as any;
      sidecar['eventHandler'] = {
        on: jest.fn(),
        removeAllListeners: jest.fn(),
      } as any;

      return streams;
    };

    // Regression test for a silent, permanent loss of lockup transaction
    // detection: the "relevant transaction" stream from the sidecar could
    // die without ever being resubscribed, since its error/end handlers
    // only cleared the local reference instead of reconnecting
    test('should resubscribe all sidecar streams when the relevant transaction stream errors while connected', async () => {
      const streams = setupClientMock();
      sidecar.getInfo = jest.fn().mockResolvedValue({ version: getVersion() });

      sidecar['setClientStatus'](ClientStatus.Connected);
      sidecar['subscribeRelevantTransaction']();

      const errorHandler = streams.transactionFound.on.mock.calls.find(
        ([event]) => event === 'error',
      )![1];

      await errorHandler(new Error('stream died'));

      expect(sidecar['client']!.transactionFound).toHaveBeenCalledTimes(2);
      expect(sidecar['client']!.blockAdded).toHaveBeenCalledTimes(1);
      expect(sidecar['client']!.swapUpdate).toHaveBeenCalledTimes(1);
      expect(sidecar['client']!.sendSwapUpdate).toHaveBeenCalledTimes(1);
      expect(sidecar.isConnected()).toBe(true);
    });

    test('should resubscribe when the block added stream ends while connected', async () => {
      const streams = setupClientMock();
      sidecar.getInfo = jest.fn().mockResolvedValue({ version: getVersion() });

      sidecar['setClientStatus'](ClientStatus.Connected);
      sidecar['subscribeBlockAdded']();

      const endHandler = streams.blockAdded.on.mock.calls.find(
        ([event]) => event === 'end',
      )![1];

      await endHandler();

      expect(sidecar['client']!.blockAdded).toHaveBeenCalledTimes(2);
      expect(sidecar.isConnected()).toBe(true);
    });

    test('should not attempt to reconnect if already disconnected', async () => {
      const streams = setupClientMock();
      sidecar.getInfo = jest.fn().mockResolvedValue({ version: getVersion() });

      sidecar['setClientStatus'](ClientStatus.Disconnected);
      sidecar['subscribeRelevantTransaction']();

      const errorHandler = streams.transactionFound.on.mock.calls.find(
        ([event]) => event === 'error',
      )![1];

      await errorHandler(new Error('stream died'));

      expect(sidecar['client']!.transactionFound).toHaveBeenCalledTimes(1);
    });
  });
});
