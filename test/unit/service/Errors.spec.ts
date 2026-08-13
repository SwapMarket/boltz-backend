import Errors from '../../../lib/service/Errors';

describe('Errors', () => {
  const codes = Object.entries(Errors).map(([name, factory]) => [
    name,
    (factory as (...args: any[]) => { code: string })(
      ...new Array(factory.length).fill(0),
    ).code,
  ]);

  test('should have a unique code for every error', () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];

    for (const [name, code] of codes) {
      if (seen.has(code)) {
        duplicates.push(`${name} and ${seen.get(code)} share code ${code}`);
      } else {
        seen.set(code, name);
      }
    }

    expect(duplicates).toEqual([]);
  });

  test('should prefix every code with the service error code prefix', () => {
    for (const [, code] of codes) {
      expect(code).toMatch(/^2\.\d+$/);
    }
  });

  test('should have the expected code for the invoice CLTV error', () => {
    expect(Errors.INVOICE_CLTV_TOO_SMALL(10, 16)).toEqual({
      message: 'invoice CLTV 10 is smaller than the required 16',
      code: '2.60',
    });
  });
});
