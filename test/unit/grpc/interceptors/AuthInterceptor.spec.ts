import { isMethodAllowed } from '../../../../lib/grpc/interceptors/AuthInterceptor';

describe('isMethodAllowed', () => {
  const m = '/boltzrpc.Boltz/GetInfo';

  test.each([
    [m, ['*'], true],
    [m, ['/boltzrpc.Boltz/*'], true],
    [m, [m], true],
    [m, ['/boltzrpc.Boltz/Stop', m], true],
    [m, ['/boltzrpc.Boltz/Stop'], false],
    [m, ['/boltzrpc.Other/*'], false],
    [m, [], false],
    [m, [''], false],
    ['/boltzrpc.Boltz/Stop', ['/boltzrpc.Boltz/*'], true],
    ['/other.Service/Foo', ['/boltzrpc.Boltz/*'], false],
    // Sensitive key-export methods require an exact grant: neither the global
    // wildcard nor a service wildcard may grant them.
    ['/boltzrpc.Boltz/DeriveKeys', ['*'], false],
    ['/boltzrpc.Boltz/DeriveKeys', ['/boltzrpc.Boltz/*'], false],
    ['/boltzrpc.Boltz/DeriveKeys', ['/boltzrpc.Boltz/DeriveKeys'], true],
    ['/boltzrpc.Boltz/DeriveBlindingKeys', ['*'], false],
    [
      '/boltzrpc.Boltz/DeriveBlindingKeys',
      ['/boltzrpc.Boltz/DeriveBlindingKeys'],
      true,
    ],
  ])('isMethodAllowed(%s, %j) -> %s', (method, allowed, expected) => {
    expect(isMethodAllowed(method, allowed)).toBe(expected);
  });
});
