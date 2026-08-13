import type Logger from '../Logger';
import { formatError, getTsString, minutesToMilliseconds } from '../Utils';
import { findPaidUnclaimedSwaps } from '../swap/PaidUnclaimedSwaps';
import { Emojis } from './Markup';
import type NotificationClient from './NotificationClient';

class StuckClaimChecker {
  private static readonly stuckThresholdMinutes = 15;

  private alerted = new Set<string>();

  constructor(
    private readonly logger: Logger,
    private readonly notificationClient: NotificationClient,
  ) {}

  // A rejection here would prevent the NotificationProvider from scheduling
  // its periodic checks
  public check = async (): Promise<void> => {
    try {
      await this.checkUnclaimedSwaps();
    } catch (e) {
      this.logger.warn(
        `Could not check for unclaimed Swaps: ${formatError(e)}`,
      );
    }
  };

  private checkUnclaimedSwaps = async () => {
    const stuck = await findPaidUnclaimedSwaps(
      minutesToMilliseconds(StuckClaimChecker.stuckThresholdMinutes),
    );
    const stuckIds = new Set(stuck.map(({ swap }) => swap.id));

    for (const { swap, paidAt } of stuck) {
      if (this.alerted.has(swap.id)) {
        continue;
      }
      this.alerted.add(swap.id);

      const message =
        `${Emojis.RotatingLight} **Swap ${swap.id} was paid but not claimed** ${Emojis.RotatingLight}\n` +
        `  Pair: ${swap.pair}\n` +
        `  Status: ${swap.status}\n` +
        `  Invoice paid at: ${getTsString(paidAt)}`;

      this.logger.warn(
        `Swap ${swap.id} was paid at ${getTsString(paidAt)} but has not been claimed`,
      );
      await this.notificationClient.sendMessage(message, true, true);
    }

    for (const id of this.alerted) {
      if (stuckIds.has(id)) {
        continue;
      }
      this.alerted.delete(id);

      const message = `${Emojis.Checkmark} Swap ${id} is not waiting to be claimed anymore ${Emojis.Checkmark}`;

      this.logger.info(message);
      await this.notificationClient.sendMessage(message, true, false);
    }
  };
}

export default StuckClaimChecker;
