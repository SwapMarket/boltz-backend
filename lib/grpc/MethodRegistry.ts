import { BoltzService } from '../proto/boltzrpc';

// Wildcard matching every method on every service
export const wildcardAll = '*';

const allPaths = Object.values(BoltzService).map((m) => m.path as string);

// Methods that export private key material. These are deliberately excluded
// from wildcard ("*") and service-wildcard grants: a token may only call them
// if it lists the exact method path in its allowedMethods. This keeps the
// key-export/recovery capability available while preventing the bootstrap
// admin (wildcard) token from being a silent key-export oracle.
const sensitiveMethodNames: ReadonlySet<string> = new Set([
  'deriveKeys',
  'deriveBlindingKeys',
]);

export const sensitiveMethodPaths: ReadonlySet<string> = new Set(
  Object.entries(BoltzService)
    .filter(([name]) => sensitiveMethodNames.has(name))
    .map(([, m]) => m.path as string),
);

export const validMethodPaths: ReadonlySet<string> = new Set(allPaths);

export const validServiceWildcards: ReadonlySet<string> = new Set(
  allPaths.map((p) => `${p.slice(0, p.lastIndexOf('/'))}/*`),
);

export const isValidAllowedMethodEntry = (entry: string): boolean => {
  if (entry === wildcardAll) {
    return true;
  }
  if (validServiceWildcards.has(entry)) {
    return true;
  }
  return validMethodPaths.has(entry);
};

export const assertValidAllowedMethods = (entries: string[]): void => {
  const invalid = entries.filter((entry) => !isValidAllowedMethodEntry(entry));
  if (invalid.length > 0) {
    throw new Error(`unknown method path(s): ${invalid.join(', ')}`);
  }
};
