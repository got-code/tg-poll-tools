import { DomainError } from '../../../domain/errors.ts';
import type { PollContent, DeliveryItem, PollDraft, DraftMessage } from './models.ts';

export function validateContent(content: PollContent) {
  if (!content.question.trim()) throw new DomainError('Enter a question for each poll.');
  if (content.answers.length < 2)
    throw new DomainError('Each poll needs at least two answer options.');
  if (content.answers.some((answer) => !answer.trim()))
    throw new DomainError('Answer options cannot be empty.');
}

export function validateMessage(message: DraftMessage) {
  if (!message.text.trim()) throw new DomainError('Enter text for each accompanying message.');
  if (message.text.length > 4096)
    throw new DomainError('Each accompanying message can contain at most 4096 characters.');
}

export function orderedPublications(draft: PollDraft) {
  return [
    ...(draft.beforeMessage ? [draft.beforeMessage] : []),
    ...draft.items,
    ...(draft.afterMessage ? [draft.afterMessage] : []),
  ];
}

export function isEditable(item: DeliveryItem) {
  return item.delivery.state === 'ready' || item.delivery.state === 'failed';
}

export function requireEditable(item: DeliveryItem) {
  if (!isEditable(item))
    throw new DomainError('This item has already been sent or needs its sending result checked.');
}
