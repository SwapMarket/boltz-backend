import { createHmac } from 'crypto';
import Logger from '../../../../lib/Logger';
import { getUnixTime } from '../../../../lib/Utils';
import Auth from '../../../../lib/api/v2/Auth';

const sign = (
  secret: string,
  ts: number,
  method: string,
  path: string,
  body: string,
) =>
  createHmac('sha256', secret)
    .update(`${ts}${method}${path}${body}`)
    .digest('hex');

describe('Auth', () => {
  test('should call next without checking when no secret is configured', () => {
    const next = jest.fn();
    const req = { get: jest.fn() } as any;
    const res = {} as any;

    Auth.middleware(Logger.disabledLogger, undefined)(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.get).not.toHaveBeenCalled();
  });

  test('should reject requests without the timestamp header', () => {
    const next = jest.fn();
    const req = {
      get: jest.fn().mockReturnValue(undefined),
      method: 'POST',
      originalUrl: '/v2/swap/submarine',
    } as any;
    const status = jest.fn().mockReturnThis();
    const json = jest.fn();
    const res = { set: jest.fn(), status, json } as any;

    Auth.middleware(Logger.disabledLogger, 'secret')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: 'unauthorized' });
  });

  test('should reject requests with a stale timestamp', () => {
    const staleTs = getUnixTime() - 120;
    const next = jest.fn();
    const req = {
      get: jest.fn().mockImplementation((name: string) => {
        if (name === Auth.timestampHeader) {
          return staleTs.toString();
        }
        return undefined;
      }),
      method: 'POST',
      originalUrl: '/v2/swap/submarine',
    } as any;
    const status = jest.fn().mockReturnThis();
    const json = jest.fn();
    const res = { set: jest.fn(), status, json } as any;

    Auth.middleware(Logger.disabledLogger, 'secret')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });

  test('should reject requests without the signature header', () => {
    const next = jest.fn();
    const req = {
      get: jest.fn().mockImplementation((name: string) => {
        if (name === Auth.timestampHeader) {
          return getUnixTime().toString();
        }
        return undefined;
      }),
      method: 'POST',
      originalUrl: '/v2/swap/submarine',
    } as any;
    const status = jest.fn().mockReturnThis();
    const json = jest.fn();
    const res = { set: jest.fn(), status, json } as any;

    Auth.middleware(Logger.disabledLogger, 'secret')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });

  test('should reject requests with a wrong signature', () => {
    const ts = getUnixTime();
    const next = jest.fn();
    const req = {
      get: jest.fn().mockImplementation((name: string) => {
        if (name === Auth.timestampHeader) return ts.toString();
        if (name === Auth.signatureHeader) return 'wrong';
        return undefined;
      }),
      rawBody: 'some raw body',
      method: 'POST',
      originalUrl: '/v2/swap/submarine',
    } as any;
    const status = jest.fn().mockReturnThis();
    const json = jest.fn();
    const res = { set: jest.fn(), status, json } as any;

    Auth.middleware(Logger.disabledLogger, 'secret')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });

  test('should accept requests with a correct signature', () => {
    const secret = 'secret';
    const ts = getUnixTime();
    const method = 'POST';
    const path = '/v2/swap/submarine';
    const body = 'some raw body';
    const signature = sign(secret, ts, method, path, body);

    const next = jest.fn();
    const req = {
      get: jest.fn().mockImplementation((name: string) => {
        if (name === Auth.timestampHeader) return ts.toString();
        if (name === Auth.signatureHeader) return signature;
        return undefined;
      }),
      rawBody: body,
      method,
      originalUrl: path,
    } as any;
    const res = {} as any;

    Auth.middleware(Logger.disabledLogger, secret)(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  test('should treat a missing raw body as an empty string (GET requests)', () => {
    const secret = 'secret';
    const ts = getUnixTime();
    const method = 'GET';
    const path = '/v2/swap/submarine';
    const signature = sign(secret, ts, method, path, '');

    const next = jest.fn();
    const req = {
      get: jest.fn().mockImplementation((name: string) => {
        if (name === Auth.timestampHeader) return ts.toString();
        if (name === Auth.signatureHeader) return signature;
        return undefined;
      }),
      method,
      originalUrl: path,
    } as any;
    const res = {} as any;

    Auth.middleware(Logger.disabledLogger, secret)(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  test('should reject a signature captured for a different path', () => {
    const secret = 'secret';
    const ts = getUnixTime();
    const body = 'some raw body';
    // Signed for a different endpoint with the same body shape
    const signature = sign(secret, ts, 'POST', '/v2/swap/reverse', body);

    const next = jest.fn();
    const req = {
      get: jest.fn().mockImplementation((name: string) => {
        if (name === Auth.timestampHeader) return ts.toString();
        if (name === Auth.signatureHeader) return signature;
        return undefined;
      }),
      rawBody: body,
      method: 'POST',
      originalUrl: '/v2/swap/submarine',
    } as any;
    const status = jest.fn().mockReturnThis();
    const json = jest.fn();
    const res = { set: jest.fn(), status, json } as any;

    Auth.middleware(Logger.disabledLogger, secret)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });
});
