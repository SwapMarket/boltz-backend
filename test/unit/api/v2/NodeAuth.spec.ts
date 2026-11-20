import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import Logger from '../../../../lib/Logger';
import { getHexString, getUnixTime } from '../../../../lib/Utils';
import Auth from '../../../../lib/api/v2/Auth';
import AuthRejection from '../../../../lib/api/v2/AuthRejection';
import NodeAuth from '../../../../lib/api/v2/NodeAuth';
import BlockedApiNodeRepository from '../../../../lib/db/repositories/BlockedApiNodeRepository';

// Signs like `signmessage` of CLN and LND: a recoverable signature of
// sha256d("Lightning Signed Message:" + message), zbase32 encoded with a
// 31 + recovery id header byte
const signMessage = (privateKey: Uint8Array, message: string): string => {
  const digest = sha256(
    sha256(Buffer.from(`Lightning Signed Message:${message}`)),
  );
  const signature = secp256k1.Signature.fromBytes(
    secp256k1.sign(digest, privateKey, {
      prehash: false,
      format: 'recovered',
    }),
    'recovered',
  );

  return NodeAuth.encodeZbase32(
    Uint8Array.from([
      31 + signature.recovery!,
      ...signature.toBytes('compact'),
    ]),
  );
};

const makeNode = () => {
  const privateKey = secp256k1.utils.randomSecretKey();
  return {
    privateKey,
    nodeId: getHexString(Buffer.from(secp256k1.getPublicKey(privateKey))),
  };
};

const makeRequest = (
  node: { privateKey: Uint8Array; nodeId: string },
  options: {
    method?: string;
    url?: string;
    body?: string;
    ts?: number;
    signedBody?: string;
    signedUrl?: string;
  } = {},
) => {
  const method = options.method ?? 'POST';
  const url = options.url ?? '/swap/reverse';
  const body = options.body ?? '{"invoiceAmount":100000}';
  const ts = options.ts ?? getUnixTime();

  const headers: Record<string, string> = {
    [NodeAuth.nodeIdHeader]: node.nodeId,
    [NodeAuth.timestampHeader]: ts.toString(),
    [NodeAuth.signatureHeader]: signMessage(
      node.privateKey,
      NodeAuth.message(
        ts,
        method,
        `/v2${options.signedUrl ?? url}`,
        options.signedBody ?? body,
      ),
    ),
  };

  return {
    method,
    url,
    ip: '203.0.113.1',
    rawBody: body,
    get: jest.fn((name: string) => headers[name]),
  } as any;
};

describe('NodeAuth', () => {
  const isPublicNode = jest.fn();
  const sendMessage = jest.fn();

  let nodeAuth: NodeAuth;

  beforeEach(() => {
    jest.clearAllMocks();

    isPublicNode.mockResolvedValue(true);
    BlockedApiNodeRepository.isBlocked = jest.fn().mockResolvedValue(false);
    BlockedApiNodeRepository.block = jest.fn().mockResolvedValue(undefined);

    nodeAuth = new NodeAuth(
      Logger.disabledLogger,
      {
        lndClients: new Map([['lnd', { isPublicNode }]]),
        clnClient: undefined,
      } as any,
      { sendMessage } as any,
    );
  });

  test('should round trip zbase32', () => {
    const bytes = Uint8Array.from({ length: 65 }, (_, i) => (i * 37) % 256);
    expect(NodeAuth.decodeZbase32(NodeAuth.encodeZbase32(bytes))).toEqual(
      bytes,
    );
  });

  test('should recover the signer of a Lightning signed message', () => {
    const node = makeNode();
    expect(
      NodeAuth.recoverSigner(
        'message',
        signMessage(node.privateKey, 'message'),
      ),
    ).toEqual(node.nodeId);
  });

  test.each`
    signature
    ${'not zbase32 because of 0 and l'}
    ${'ybndrfg8'}
    ${''}
  `('should reject malformed signature $signature', ({ signature }) => {
    expect(() => NodeAuth.recoverSigner('message', signature)).toThrow();
  });

  test('should authenticate a correctly signed request of a public node', async () => {
    const node = makeNode();

    await expect(nodeAuth.authenticate(makeRequest(node))).resolves.toEqual(
      node.nodeId,
    );
    expect(isPublicNode).toHaveBeenCalledWith(node.nodeId);
    expect(BlockedApiNodeRepository.block).not.toHaveBeenCalled();
  });

  test('should sign the path from the API prefix on', () => {
    expect(NodeAuth.signedPath({ url: '/swap/abc?x=1' } as any)).toEqual(
      '/v2/swap/abc?x=1',
    );
  });

  test('should reject a signature by another key', async () => {
    const node = makeNode();
    const req = makeRequest(makeNode());
    const headers = {
      [NodeAuth.nodeIdHeader]: node.nodeId,
      [NodeAuth.timestampHeader]: req.get(NodeAuth.timestampHeader),
      [NodeAuth.signatureHeader]: req.get(NodeAuth.signatureHeader),
    };
    req.get = jest.fn((name: string) => headers[name]);

    await expect(nodeAuth.authenticate(req)).rejects.toBeInstanceOf(
      AuthRejection,
    );
  });

  test('should reject a tampered body', async () => {
    await expect(
      nodeAuth.authenticate(
        makeRequest(makeNode(), { signedBody: '{"invoiceAmount":1}' }),
      ),
    ).rejects.toBeInstanceOf(AuthRejection);
  });

  test('should reject a signature for another path', async () => {
    await expect(
      nodeAuth.authenticate(
        makeRequest(makeNode(), { signedUrl: '/swap/submarine' }),
      ),
    ).rejects.toBeInstanceOf(AuthRejection);
  });

  test('should reject a stale timestamp', async () => {
    await expect(
      nodeAuth.authenticate(
        makeRequest(makeNode(), { ts: getUnixTime() - 120 }),
      ),
    ).rejects.toBeInstanceOf(AuthRejection);
  });

  test('should reject a malformed node ID', async () => {
    const req = makeRequest(makeNode());
    const get = req.get;
    req.get = jest.fn((name: string) =>
      name === NodeAuth.nodeIdHeader ? 'not a node' : get(name),
    );

    await expect(nodeAuth.authenticate(req)).rejects.toBeInstanceOf(
      AuthRejection,
    );
  });

  test('should reject a replayed POST request', async () => {
    const req = makeRequest(makeNode());

    await nodeAuth.authenticate(req);
    await expect(nodeAuth.authenticate(req)).rejects.toEqual(
      new AuthRejection('replayed signature'),
    );
  });

  test('should accept identical GET requests in the same second', async () => {
    const req = makeRequest(makeNode(), {
      method: 'GET',
      url: '/swap/abc123',
      body: '',
    });

    await nodeAuth.authenticate(req);
    await expect(nodeAuth.authenticate(req)).resolves.toBeDefined();
  });

  test('should give the reason of a rejection', async () => {
    BlockedApiNodeRepository.isBlocked = jest.fn().mockResolvedValue(true);
    const node = makeNode();

    await expect(nodeAuth.authenticate(makeRequest(node))).rejects.toEqual(
      new AuthRejection(`node ${node.nodeId} is blocked`),
    );
  });

  test('should reject a blocked node', async () => {
    BlockedApiNodeRepository.isBlocked = jest.fn().mockResolvedValue(true);

    await expect(
      nodeAuth.authenticate(makeRequest(makeNode())),
    ).rejects.toBeInstanceOf(AuthRejection);
    expect(isPublicNode).not.toHaveBeenCalled();
  });

  test('should reject a node that is not public without blocking it', async () => {
    isPublicNode.mockResolvedValue(false);

    await expect(
      nodeAuth.authenticate(
        makeRequest(makeNode(), { method: 'GET', url: '/referral', body: '' }),
      ),
    ).rejects.toBeInstanceOf(AuthRejection);
    expect(BlockedApiNodeRepository.block).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('should block and report a public node calling outside its scope', async () => {
    const node = makeNode();

    await expect(
      nodeAuth.authenticate(
        makeRequest(node, { method: 'GET', url: '/referral', body: '' }),
      ),
    ).rejects.toBeInstanceOf(AuthRejection);

    expect(BlockedApiNodeRepository.block).toHaveBeenCalledTimes(1);
    expect(BlockedApiNodeRepository.block).toHaveBeenCalledWith(
      node.nodeId,
      'requested GET /v2/referral from 203.0.113.1',
    );
    expect(sendMessage).toHaveBeenCalledWith(
      `Blocked API node ${node.nodeId}: requested GET /v2/referral from 203.0.113.1`,
      true,
      true,
    );
  });

  test('should cache whether a node is public', async () => {
    const node = makeNode();

    await nodeAuth.authenticate(makeRequest(node));
    await nodeAuth.authenticate(makeRequest(node, { body: '{"a":1}' }));

    expect(isPublicNode).toHaveBeenCalledTimes(1);
  });

  test('should ask CLN when LND does not know the node', async () => {
    const clnIsPublicNode = jest.fn().mockResolvedValue(true);
    isPublicNode.mockResolvedValue(false);
    nodeAuth = new NodeAuth(Logger.disabledLogger, {
      lndClients: new Map([['lnd', { isPublicNode }]]),
      clnClient: { isPublicNode: clnIsPublicNode },
    } as any);

    await expect(
      nodeAuth.authenticate(makeRequest(makeNode())),
    ).resolves.toBeDefined();
    expect(clnIsPublicNode).toHaveBeenCalledTimes(1);
  });

  test.each`
    method    | path                                  | expected
    ${'GET'}  | ${'/v2/swap/reverse'}                 | ${true}
    ${'POST'} | ${'/v2/swap/reverse'}                 | ${true}
    ${'GET'}  | ${'/v2/swap/abc123'}                  | ${true}
    ${'GET'}  | ${'/v2/swap/abc123?x=1'}              | ${true}
    ${'POST'} | ${'/v2/swap/reverse/abc123/claim'}    | ${true}
    ${'GET'}  | ${'/v2/swap/reverse/abc123/claim'}    | ${false}
    ${'POST'} | ${'/v2/swap/submarine'}               | ${false}
    ${'POST'} | ${'/v2/swap/chain'}                   | ${false}
    ${'GET'}  | ${'/v2/referral'}                     | ${false}
    ${'GET'}  | ${'/v2/swap/../referral'}             | ${false}
    ${'POST'} | ${'/v2/swap/submarine/abc123/refund'} | ${false}
  `('should allow $method $path: $expected', ({ method, path, expected }) => {
    expect(NodeAuth.isAllowedRoute(method, path)).toEqual(expected);
  });

  describe('Auth middleware', () => {
    const makeRes = () => {
      const status = jest.fn().mockReturnThis();
      return { set: jest.fn(), status, json: jest.fn() } as any;
    };

    test('should authenticate requests with node headers by node', async () => {
      const next = jest.fn();

      await Auth.middleware(Logger.disabledLogger, 'secret', nodeAuth)(
        makeRequest(makeNode()),
        makeRes(),
        next,
      );

      expect(next).toHaveBeenCalledTimes(1);
    });

    test('should reject an invalid node signature with 401', async () => {
      const next = jest.fn();
      const res = makeRes();

      await Auth.middleware(Logger.disabledLogger, 'secret', nodeAuth)(
        makeRequest(makeNode(), { signedBody: 'other' }),
        res,
        next,
      );

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    test('should check the secret for requests without node headers', async () => {
      const next = jest.fn();
      const res = makeRes();

      await Auth.middleware(Logger.disabledLogger, 'secret', nodeAuth)(
        {
          get: jest.fn(),
          method: 'GET',
          originalUrl: '/v2/swap/reverse',
        } as any,
        res,
        next,
      );

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    test('should ignore node headers when node authentication is disabled', async () => {
      const next = jest.fn();
      const res = makeRes();

      await Auth.middleware(Logger.disabledLogger, 'secret')(
        makeRequest(makeNode()),
        res,
        next,
      );

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });
});
