import { MtPeerNotFoundError } from '@mtcute/web';
import { resolvePeer, iterDialogs } from '@mtcute/web/methods.js';
import { UserFacingError } from '../../application/errors.ts';
import type { BaseTelegramClient } from '@mtcute/web';

export async function findTelegramPeer(client: BaseTelegramClient, id: number | string) {
  if (typeof id === 'number' && !Number.isSafeInteger(id))
    throw new UserFacingError('Invalid group ID.');
  try {
    return await resolvePeer(client, id);
  } catch (error) {
    if (typeof id !== 'number' || !(error instanceof MtPeerNotFoundError)) throw error;
    // Private links and restored drafts do not contain an access hash.
    for await (const dialog of iterDialogs(client, { archived: 'keep' }))
      if (dialog.peer.id === id) return dialog.peer.inputPeer;
    throw new UserFacingError(
      'The group was not found in your chats. Check the link and your access.',
    );
  }
}
