import { Long } from '@mtcute/web';
import { getMessages, getMe, iterDialogs, sendMedia, sendText } from '@mtcute/web/methods.js';
import { ServiceError, UserFacingError } from '../../../application/errors.ts';
import { findTelegramPeer } from '../../../infrastructure/telegram/peers.ts';
import {
  withTelegramErrors,
  readTelegramFailure,
} from '../../../infrastructure/telegram/errors.ts';
import { PublicationFailure } from '../application/contracts.ts';
import type { BaseTelegramClient, Message, Peer } from '@mtcute/web';
import type { PublishingGateway } from '../application/contracts.ts';
import type { Destination } from '../domain/models.ts';

function destination(peer: Peer): Destination {
  if (peer.type !== 'chat')
    throw new UserFacingError('Polls can only be published in groups and channels.');
  const privateId = peer.id < -1000000000000 ? -1000000000000 - peer.id : null;
  return {
    id: String(peer.id),
    title: peer.displayName,
    url: peer.username
      ? `https://t.me/${peer.username}`
      : privateId === null
        ? null
        : `https://t.me/c/${privateId}`,
  };
}

async function publicationFailure(error: unknown, outcome: 'failed' | 'unknown'): Promise<never> {
  try {
    await withTelegramErrors(() => {
      throw error;
    });
  } catch (safe) {
    if (safe instanceof ServiceError)
      throw new PublicationFailure(safe.message, outcome, safe.details);
    if (safe instanceof UserFacingError)
      throw new PublicationFailure(safe.message, outcome, {
        service: 'Telegram',
        kind: 'unexpected',
      });
  }
  throw new PublicationFailure(
    'The sending result is unknown. Check the destination in Telegram.',
    'unknown',
    { service: 'Telegram', kind: 'unexpected' },
  );
}

export function createTelegramPublishing(client: BaseTelegramClient): PublishingGateway {
  async function sendTo(
    target: Destination,
    send: (peer: Awaited<ReturnType<typeof findTelegramPeer>>) => Promise<Message>,
  ) {
    let peer;
    try {
      peer = await findTelegramPeer(client, Number(target.id));
    } catch (error) {
      return publicationFailure(error, 'failed');
    }
    try {
      const message = await send(peer);
      // A missing permalink must not turn a confirmed publication into a failure.
      try {
        return message.link;
      } catch {
        return null;
      }
    } catch (error) {
      const failure = readTelegramFailure(error);
      const definitive =
        failure.kind === 'rpc' &&
        failure.status !== undefined &&
        failure.status >= 400 &&
        failure.status < 500 &&
        failure.rpcCode !== 'RANDOM_ID_DUPLICATE';
      return publicationFailure(error, definitive ? 'failed' : 'unknown');
    }
  }

  return {
    accountId: () => withTelegramErrors(async () => String((await getMe(client)).id)),
    load: (links) =>
      withTelegramErrors(async () => {
        const accountId = String((await getMe(client)).id);
        const polls = [];
        for (const link of links) {
          const id = link.peer.kind === 'channel' ? -1000000000000 - link.peer.id : link.peer.name;
          const peer = await findTelegramPeer(client, id);
          const [message] = await getMessages(client, peer, link.messageId);
          const poll = message?.media;
          if (!message || poll?.type !== 'poll')
            throw new UserFacingError('A source message does not contain a poll.');
          if (poll.isQuiz)
            throw new UserFacingError(
              'Quiz copying is not supported yet. Choose an ordinary poll.',
            );
          if (
            poll.attachedMedia ||
            poll.questionEntities.length ||
            poll.answers.some((answer) => answer.media || answer.textEntities.length)
          )
            throw new UserFacingError(
              'This source uses poll media or formatted text that cannot be copied yet.',
            );
          if (poll.isSubscribersOnly || poll.countries?.length)
            throw new UserFacingError(
              'This source has voting restrictions that cannot be copied yet.',
            );
          polls.push({
            destination: message.chat.type === 'chat' ? destination(message.chat) : null,
            content: {
              question: poll.question,
              answers: poll.answers.map((answer) => answer.text),
              settings: {
                anonymous: !poll.isPublic,
                multiple: Boolean(poll.isMultiple),
                shuffle: Boolean(poll.shuffleAnswers),
                allowRevoting: !poll.isRevotingDisabled,
                openAnswers: Boolean(poll.canAddAnswers),
                hideResults: Boolean(poll.hideResultsUntilClose),
              },
            },
          });
        }
        return { accountId, polls };
      }),
    destinations: () =>
      withTelegramErrors(async () => {
        const values = new Map<string, Destination>();
        for await (const dialog of iterDialogs(client, { archived: 'keep' })) {
          if (dialog.peer.type !== 'chat') continue;
          const value = destination(dialog.peer);
          values.set(value.id, value);
        }
        return [...values.values()];
      }),
    publish: (target, content, sendKey) =>
      sendTo(target, (peer) =>
        sendMedia(
          client,
          peer,
          {
            type: 'poll',
            question: content.question,
            answers: [...content.answers],
            public: !content.settings.anonymous,
            multiple: content.settings.multiple,
            shuffleAnswers: content.settings.shuffle,
            disableRevoting: !content.settings.allowRevoting,
            openAnswers: content.settings.openAnswers,
            hideResultsUntilClose: content.settings.hideResults,
          },
          { randomId: Long.fromString(sendKey, true, 16) },
        ),
      ),
    publishMessage: (target, text, sendKey) =>
      sendTo(target, (peer) =>
        sendText(client, peer, text, {
          randomId: Long.fromString(sendKey, true, 16),
          disableWebPreview: true,
        }),
      ),
  };
}
