import { createHmac, timingSafeEqual } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import type Logger from '../../Logger';
import { getUnixTime } from '../../Utils';
import { errorResponse, setContentTypeJson } from '../Utils';
import AuthRejection, { isReplayProtected } from './AuthRejection';
import NodeAuth from './NodeAuth';

// Restricts the v2 API to callers that know the configured "api.authSecret",
// by requiring an HMAC-SHA256 of "<ts><method><path><body>", keyed by that
// secret, as a header pair. Unlike Bouncer, this is a single shared secret
// meant for trusted frontends rather than per-referral credentials, and is
// opt-in: with no "authSecret" configured, the API stays open as before.
// The timestamp bounds how long a captured request stays replayable, and
// binding method+path stops a signature captured for one endpoint being
// replayed against another that happens to accept a similarly-shaped body.
// Reads are not checked for replays: see isReplayProtected
class Auth {
  public static readonly signatureHeader = 'x-api-signature';
  public static readonly timestampHeader = 'x-api-timestamp';

  private static readonly timestampDeltaTolerance = 60;

  // signature (hex) -> unix time it stops being replayable. Only ever
  // populated with signatures that already passed HMAC verification, so an
  // attacker without the secret can't grow this by spamming bogus ones
  private static readonly seenSignatures = new Map<string, number>();

  // A request carrying node headers is authenticated by its node signature
  // instead of the shared secret, when node authentication is enabled
  public static middleware = (
    logger: Logger,
    secret?: string,
    nodeAuth?: NodeAuth,
  ) => {
    return async (
      req: Request,
      res: Response,
      next: NextFunction,
    ): Promise<void> => {
      try {
        if (nodeAuth !== undefined && NodeAuth.hasNodeHeaders(req)) {
          await nodeAuth.authenticate(req);
        } else if (secret !== undefined) {
          Auth.verify(req, secret);
        }
      } catch (e) {
        if (!(e instanceof AuthRejection)) {
          errorResponse(logger, req, res, e, 401);
          return;
        }

        logger.warn(
          `Request ${req.method} ${req.originalUrl} unauthorized: ${e.reason}`,
        );
        setContentTypeJson(res);
        res.status(401).json({ error: 'unauthorized' });
        return;
      }

      next();
    };
  };

  private static verify = (req: Request, secret: string) => {
    const ts = Auth.checkTimestamp(req.get(Auth.timestampHeader));
    const provided = req.get(Auth.signatureHeader);

    if (provided === undefined) {
      throw new AuthRejection('missing signature');
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
      throw new AuthRejection('wrong signature');
    }

    if (isReplayProtected(req.method)) {
      Auth.checkReplay(provided, ts);
    }
  };

  private static checkReplay = (signature: string, ts: number) => {
    Auth.pruneExpiredSignatures();

    if (Auth.seenSignatures.has(signature)) {
      throw new AuthRejection('replayed signature');
    }

    // Past this point a replay would fail checkTimestamp on its own anyway
    Auth.seenSignatures.set(signature, ts + Auth.timestampDeltaTolerance);
  };

  private static pruneExpiredSignatures = () => {
    const now = getUnixTime();

    for (const [signature, expiry] of Auth.seenSignatures) {
      if (expiry <= now) {
        Auth.seenSignatures.delete(signature);
      }
    }
  };

  private static checkTimestamp = (providedTsRaw?: string): number => {
    if (providedTsRaw === undefined) {
      throw new AuthRejection('missing timestamp');
    }

    const providedTs = parseInt(providedTsRaw, 10);
    if (isNaN(providedTs)) {
      throw new AuthRejection('malformed timestamp');
    }

    const now = getUnixTime();
    if (
      providedTs > now + Auth.timestampDeltaTolerance ||
      providedTs < now - Auth.timestampDeltaTolerance
    ) {
      throw new AuthRejection(
        `timestamp ${providedTs} is ${now - providedTs}s off server time`,
      );
    }

    return providedTs;
  };
}

export default Auth;
