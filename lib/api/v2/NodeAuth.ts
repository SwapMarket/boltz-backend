import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { Request } from 'express';
import type Logger from '../../Logger';
import { getHexString, getUnixTime } from '../../Utils';
import BlockedApiNodeRepository from '../../db/repositories/BlockedApiNodeRepository';
import type NotificationClient from '../../notifications/NotificationClient';
import type { Currency } from '../../wallet/WalletManager';
import AuthRejection, { isReplayProtected } from './AuthRejection';
import { apiPrefix } from './Consts';

// Authenticates "/v2" requests by the Lightning node that signed them, so a
// node manager like CLBOSS needs no shared secret. The node signs
// "<prefix>:<ts>:<method>:<path>:<sha256 of body>" with its node key, the
// same way CLN's and LND's `signmessage` do, and sends its node ID, the
// timestamp and the zbase32 signature as headers.
//
// Only nodes with public channels in our graph are let in, so a blocked node
// cannot come back under a fresh node ID without funding a channel. A public
// node that calls anything outside the endpoints a node manager needs is
// blocked on the spot and reported.
class NodeAuth {
  public static readonly nodeIdHeader = 'x-node-id';
  public static readonly signatureHeader = 'x-node-signature';
  public static readonly timestampHeader = 'x-node-timestamp';

  public static readonly messagePrefix = 'boltz-api-node-auth';

  private static readonly lightningMessagePrefix = 'Lightning Signed Message:';
  private static readonly zbase32Alphabet = 'ybndrfg8ejkmcpqxot1uwisza345h769';

  private static readonly timestampDeltaTolerance = 60;
  private static readonly publicCacheSeconds = 60 * 60;
  private static readonly notPublicCacheSeconds = 2 * 60;

  // The reverse swap endpoints CLBOSS uses: the reverse pairs, creating a
  // swap, its status and the cooperative claim
  private static readonly allowedRoutes: [string, RegExp][] = [
    ['GET', /^\/v2\/swap\/reverse\/?$/],
    ['POST', /^\/v2\/swap\/reverse\/?$/],
    ['GET', /^\/v2\/swap\/[A-Za-z0-9]+\/?$/],
    ['POST', /^\/v2\/swap\/reverse\/[A-Za-z0-9]+\/claim\/?$/],
  ];

  // node ID -> whether it is public, and until when that answer is used
  private readonly publicCache = new Map<
    string,
    { isPublic: boolean; expiry: number }
  >();

  // signature -> unix time it stops being replayable
  private readonly seenSignatures = new Map<string, number>();

  constructor(
    private readonly logger: Logger,
    private readonly currency: Currency,
    private readonly notifications?: NotificationClient,
  ) {}

  public static hasNodeHeaders = (req: Request): boolean =>
    req.get(NodeAuth.nodeIdHeader) !== undefined;

  // The signed path starts at the API prefix, so it does not depend on a
  // reverse proxy adding or stripping a prefix of its own
  public static signedPath = (req: Request): string => `${apiPrefix}${req.url}`;

  public static message = (
    ts: number,
    method: string,
    path: string,
    body: string,
  ): string =>
    [
      NodeAuth.messagePrefix,
      ts,
      method,
      path,
      getHexString(Buffer.from(sha256(Buffer.from(body, 'utf-8')))),
    ].join(':');

  // Returns the public key that made a zbase32 encoded signature of the given
  // message, the way `signmessage` of CLN and LND encodes it
  public static recoverSigner = (
    message: string,
    signature: string,
  ): string => {
    const bytes = NodeAuth.decodeZbase32(signature);
    if (bytes.length !== 65) {
      throw new AuthRejection('malformed signature');
    }

    const header = bytes[0];
    if (header < 27 || header > 34) {
      throw new AuthRejection('malformed signature');
    }

    const digest = sha256(
      sha256(Buffer.from(`${NodeAuth.lightningMessagePrefix}${message}`)),
    );

    try {
      return getHexString(
        Buffer.from(
          secp256k1.Signature.fromBytes(bytes.subarray(1), 'compact')
            .addRecoveryBit((header - 27) & 3)
            .recoverPublicKey(digest)
            .toBytes(true),
        ),
      );
    } catch {
      throw new AuthRejection('malformed signature');
    }
  };

  public static encodeZbase32 = (bytes: Uint8Array): string => {
    let result = '';
    let buffer = 0;
    let bits = 0;

    for (const byte of bytes) {
      buffer = (buffer << 8) | byte;
      bits += 8;

      while (bits >= 5) {
        bits -= 5;
        result += NodeAuth.zbase32Alphabet[(buffer >> bits) & 31];
      }
    }

    if (bits > 0) {
      result += NodeAuth.zbase32Alphabet[(buffer << (5 - bits)) & 31];
    }

    return result;
  };

  public static decodeZbase32 = (encoded: string): Uint8Array => {
    const bytes: number[] = [];
    let buffer = 0;
    let bits = 0;

    for (const char of encoded) {
      const value = NodeAuth.zbase32Alphabet.indexOf(char);
      if (value === -1) {
        throw new AuthRejection('malformed signature');
      }

      buffer = ((buffer << 5) | value) & 0xffff;
      bits += 5;

      if (bits >= 8) {
        bits -= 8;
        bytes.push((buffer >> bits) & 255);
      }
    }

    return Uint8Array.from(bytes);
  };

  public authenticate = async (req: Request): Promise<string> => {
    const nodeId = (req.get(NodeAuth.nodeIdHeader) || '').toLowerCase();
    const signature = req.get(NodeAuth.signatureHeader);
    const ts = NodeAuth.checkTimestamp(req.get(NodeAuth.timestampHeader));

    if (!/^0[23][0-9a-f]{64}$/.test(nodeId)) {
      throw new AuthRejection('malformed node ID');
    }
    if (signature === undefined) {
      throw new AuthRejection(`missing signature of node ${nodeId}`);
    }

    const path = NodeAuth.signedPath(req);
    const signer = NodeAuth.recoverSigner(
      NodeAuth.message(
        ts,
        req.method,
        path,
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        req.rawBody || '',
      ),
      signature,
    );
    if (signer !== nodeId) {
      throw new AuthRejection(`signature is not by node ${nodeId}`);
    }

    if (isReplayProtected(req.method)) {
      this.checkReplay(signature, ts);
    }

    if (await BlockedApiNodeRepository.isBlocked(nodeId)) {
      throw new AuthRejection(`node ${nodeId} is blocked`);
    }

    // Before the route check, so throwaway keys cannot fill the block list
    if (!(await this.isPublicNode(nodeId))) {
      throw new AuthRejection(`node ${nodeId} is not public in our graph`);
    }

    if (!NodeAuth.isAllowedRoute(req.method, path)) {
      await this.block(
        nodeId,
        `requested ${req.method} ${path} from ${req.ip}`,
      );
      throw new AuthRejection(`node ${nodeId} blocked for an unallowed route`);
    }

    return nodeId;
  };

  public static isAllowedRoute = (method: string, path: string): boolean => {
    const pathWithoutQuery = path.split('?')[0];
    return NodeAuth.allowedRoutes.some(
      ([allowedMethod, route]) =>
        allowedMethod === method && route.test(pathWithoutQuery),
    );
  };

  private block = async (nodeId: string, reason: string) => {
    await BlockedApiNodeRepository.block(nodeId, reason);

    const message = `Blocked API node ${nodeId}: ${reason}`;
    this.logger.warn(message);
    await this.notifications?.sendMessage(message, true, true);
  };

  private isPublicNode = async (nodeId: string): Promise<boolean> => {
    const now = getUnixTime();
    const cached = this.publicCache.get(nodeId);
    if (cached !== undefined && cached.expiry > now) {
      return cached.isPublic;
    }

    let isPublic = false;
    for (const client of [
      ...this.currency.lndClients.values(),
      ...(this.currency.clnClient ? [this.currency.clnClient] : []),
    ]) {
      if (await client.isPublicNode(nodeId)) {
        isPublic = true;
        break;
      }
    }

    this.publicCache.set(nodeId, {
      isPublic,
      expiry:
        now +
        (isPublic
          ? NodeAuth.publicCacheSeconds
          : NodeAuth.notPublicCacheSeconds),
    });
    return isPublic;
  };

  private checkReplay = (signature: string, ts: number) => {
    const now = getUnixTime();
    for (const [seen, expiry] of this.seenSignatures) {
      if (expiry <= now) {
        this.seenSignatures.delete(seen);
      }
    }

    if (this.seenSignatures.has(signature)) {
      throw new AuthRejection('replayed signature');
    }

    this.seenSignatures.set(signature, ts + NodeAuth.timestampDeltaTolerance);
  };

  private static checkTimestamp = (providedTsRaw?: string): number => {
    if (providedTsRaw === undefined || !/^[0-9]+$/.test(providedTsRaw)) {
      throw new AuthRejection('missing or malformed timestamp');
    }

    const providedTs = parseInt(providedTsRaw, 10);
    const now = getUnixTime();
    if (
      providedTs > now + NodeAuth.timestampDeltaTolerance ||
      providedTs < now - NodeAuth.timestampDeltaTolerance
    ) {
      throw new AuthRejection(
        `timestamp ${providedTs} is ${now - providedTs}s off server time`,
      );
    }

    return providedTs;
  };
}

export default NodeAuth;
