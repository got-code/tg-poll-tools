import { DomainError } from '../../../domain/errors.ts';
import type { PollContent, DraftItem } from './models.ts';

export function validateContent(content: PollContent) {
  if (!content.question.trim()) throw new DomainError('Enter a question for each poll.');
  if (content.answers.length < 2)
    throw new DomainError('Each poll needs at least two answer options.');
  if (content.answers.some((answer) => !answer.trim()))
    throw new DomainError('Answer options cannot be empty.');
}

export function isEditable(item: DraftItem) {
  return item.delivery.state === 'ready' || item.delivery.state === 'failed';
}

export function requireEditable(item: DraftItem) {
  if (!isEditable(item))
    throw new DomainError('This poll has already been sent or needs its sending result checked.');
}
