import DecodedInvoice from '../../../lib/sidecar/DecodedInvoice';

describe('DecodedInvoice', () => {
  const bolt12WithPaths = (deltas: number[]) =>
    new DecodedInvoice({
      isExpired: false,
      bolt12Invoice: {
        msat: '100000',
        features: [],
        paths: deltas.map((delta) => ({
          cltvExpiryDelta: delta.toString(),
        })),
      },
    } as any);

  describe('minFinalCltv', () => {
    test.each`
      description      | deltas       | expected
      ${'single path'} | ${[144]}     | ${144}
      ${'several'}     | ${[160, 10]} | ${160}
      ${'no paths'}    | ${[]}        | ${0}
    `(
      'should return the largest advertised path delta for $description',
      ({ deltas, expected }) => {
        expect(bolt12WithPaths(deltas).minFinalCltv).toEqual(expected);
      },
    );

    test('should return the bolt11 min final CLTV expiry', () => {
      expect(
        new DecodedInvoice({
          bolt11: { minFinalCltvExpiry: '80' },
        } as any).minFinalCltv,
      ).toEqual(80);
    });
  });

  describe('guaranteedFinalCltv', () => {
    test.each`
      description      | deltas       | expected
      ${'single path'} | ${[144]}     | ${144}
      ${'several'}     | ${[160, 10]} | ${10}
      ${'ascending'}   | ${[10, 160]} | ${10}
      ${'no paths'}    | ${[]}        | ${0}
    `(
      'should return the smallest advertised path delta for $description',
      ({ deltas, expected }) => {
        expect(bolt12WithPaths(deltas).guaranteedFinalCltv).toEqual(expected);
      },
    );

    test('should fall back to the bolt11 min final CLTV expiry', () => {
      expect(
        new DecodedInvoice({
          bolt11: { minFinalCltvExpiry: '80' },
        } as any).guaranteedFinalCltv,
      ).toEqual(80);
    });
  });
});
