import { DomainError } from '../../../domain/errors.ts';
import { pollAnswers } from '../../../domain/poll-content.ts';
import type { PollContent, DeliveryItem, PollDraft, DraftMessage, DraftItem } from './models.ts';

export const MAX_POLL_ANSWERS = 12;

export function validateContent(content: PollContent) {
  if (!content.question.trim()) throw new DomainError('Enter a question for each poll.');
  if (pollAnswers(content.answers).length < 2)
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
    ...draft.items.flatMap((item) => item.parts),
    ...(draft.afterMessage ? [draft.afterMessage] : []),
  ];
}

export function splitContent(content: PollContent): PollContent[] {
  const answers = pollAnswers(content.answers);
  const chunks: string[][] = [];
  while (answers.length > MAX_POLL_ANSWERS) {
    const count = answers.length === MAX_POLL_ANSWERS + 1 ? MAX_POLL_ANSWERS - 1 : MAX_POLL_ANSWERS;
    chunks.push(answers.splice(0, count));
  }
  chunks.push(answers);
  return chunks.map((answers, index) => ({
    question: `${content.question.trim()}${chunks.length > 1 ? ` #${index + 1}` : ''}`,
    answers,
    settings: { ...content.settings },
  }));
}

export function isDraftEditable(item: DraftItem) {
  return item.parts.every(isEditable);
}

export function planParts(item: DraftItem, newKey: () => string) {
  if (!isDraftEditable(item))
    throw new DomainError('This poll has already been sent or needs its sending result checked.');
  item.parts = splitContent(item).map((content, index) => ({
    ...content,
    sendKey: item.parts[index]?.sendKey ?? newKey(),
    delivery: { state: 'ready' },
  }));
}

export function hasPublicationPlan(item: DraftItem) {
  const content = ({ question, answers, settings }: PollContent) => ({
    question,
    answers,
    settings,
  });
  const parts = item.parts.map(content);
  return (
    JSON.stringify(parts) === JSON.stringify(splitContent(item)) ||
    (parts.length === 1 &&
      parts[0].answers.length <= MAX_POLL_ANSWERS &&
      JSON.stringify(parts[0]) === JSON.stringify(content(item)))
  );
}

export function isEditable(item: DeliveryItem) {
  return item.delivery.state === 'ready' || item.delivery.state === 'failed';
}
