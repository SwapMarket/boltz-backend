import { createHmac, timingSafeEqual } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import type Logger from '../../Logger';
import { getUnixTime } from '../../Utils';
import { errorResponse } from '../Utils';

// Restricts the v2 API to callers that know the configured "api.authSecret",
// by requiring an HMAC-SHA256 of "<ts><method><path><body>", keyed by that
// secret, as a header pair. Unlike Bouncer, this is a single shared secret
// meant for trusted frontends rather than per-referral credentials, and is
// opt-in: with no "authSecret" configured, the API stays open as before.
// The timestamp bounds how long a captured request stays replayable, and
// binding method+path stops a signature captured for one endpoint being
// replayed against another that happens to accept a similarly-shaped body
class Auth {
  public static readonly signatureHeader = 'x-api-signature';
  public static readonly timestampHeader = 'x-api-timestamp';

  private static readonly timestampDeltaTolerance = 60;

  private static readonly errorUnauthorized = 'unauthorized';

  public static middleware = (logger: Logger, secret?: string) => {
    return (req: Request, res: Response, next: NextFunction): void => {
      if (secret === undefined) {
        next();
        return;
      }

      try {
        Auth.verify(req, secret);
        next();
      } catch (e) {
        errorResponse(logger, req, res, e, 401);
      }
    };
  };

  private static verify = (req: Request, secret: string) => {
    const ts = Auth.checkTimestamp(req.get(Auth.timestampHeader));
    const provided = req.get(Auth.signatureHeader);

    if (provided === undefined) {
      throw Auth.errorUnauthorized;
    }

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const body: string = req.rawBody || '';
    const expected = createHmac('sha256', secret)
      .update(`${ts}${req.method}${req.originalUrl}${body}`)
      .digest('hex');

    const providedBuf = Buffer.from(provided, 'hex');
    const expectedBuf = Buffer.from(expected, 'hex');

    if (
      providedBuf.length !== expectedBuf.length ||
      !timingSafeEqual(providedBuf, expectedBuf)
    ) {
      throw Auth.errorUnauthorized;
    }
  };

  private static checkTimestamp = (providedTsRaw?: string): number => {
    if (providedTsRaw === undefined) {
      throw Auth.errorUnauthorized;
    }

    const providedTs = parseInt(providedTsRaw, 10);
    if (isNaN(providedTs)) {
      throw Auth.errorUnauthorized;
    }

    const now = getUnixTime();
    if (
      providedTs > now + Auth.timestampDeltaTolerance ||
      providedTs < now - Auth.timestampDeltaTolerance
    ) {
      throw Auth.errorUnauthorized;
    }

    return providedTs;
  };
}

export default Auth;
