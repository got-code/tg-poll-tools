import { UserFacingError } from '../../../application/errors.ts';
import { lazyTelegram } from '../../../infrastructure/telegram/loader.ts';
import type { BaseTelegramClient } from '@mtcute/web';
import type { PublishingGateway } from '../application/contracts.ts';

const load = lazyTelegram(() => import('./telegram.ts'));
export const preloadPublishing = () => load().then(() => {});

export function createPublishingGateway(
  getClient: () => BaseTelegramClient | null,
): PublishingGateway {
  async function gateway() {
    const client = getClient();
    if (!client) throw new UserFacingError('Sign in to Telegram first.');
    const code = await load();
    if (getClient() !== client)
      throw new UserFacingError('The Telegram session changed. Try again.');
    return code.createTelegramPublishing(client);
  }
  return {
    load: async (links) => (await gateway()).load(links),
    destinations: async () => (await gateway()).destinations(),
    accountId: async () => (await gateway()).accountId(),
    publish: async (target, content, sendKey) =>
      (await gateway()).publish(target, content, sendKey),
  };
}
