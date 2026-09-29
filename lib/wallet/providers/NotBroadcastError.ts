/**
 * The node refused to send a transaction: nothing was broadcast.
 *
 * Any other error while sending may have come after the broadcast (the node
 * sent it, then the answer was lost), and a caller must not act as if no
 * coins had left the wallet.
 */
class NotBroadcastError extends Error {
  constructor(public readonly cause: unknown) {
    super(
      `transaction not broadcast: ${
        (cause as { message?: string })?.message ?? String(cause)
      }`,
    );
  }

  /** A JSON-RPC error: the node answered, and it answered no. */
  public static isNodeRefusal = (error: unknown): boolean =>
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'number';
}

export default NotBroadcastError;
