import { UserFacingError } from '../../../application/errors.ts';
import { pollQuestion, pollAnswers } from '../../../domain/poll-content.ts';
import { parseLink, resolveLinkValues } from '../../polls/index.ts';
import { hasPublicationPlan } from '../domain/drafts.ts';
import type {
  Destination,
  Delivery,
  DraftMessage,
  PollDraft,
  PollSettings,
  PollContent,
  DraftItem,
} from '../domain/models.ts';
import { SETTING_KEYS } from '../domain/models.ts';
import type { StoredDraft } from '../application/contracts.ts';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
export function readDestination(value: unknown): Destination {
  if (
    !record(value) ||
    typeof value.id !== 'string' ||
    !/^-?[1-9]\d*$/.test(value.id) ||
    !Number.isSafeInteger(Number(value.id)) ||
    typeof value.title !== 'string' ||
    !(value.url === null || typeof value.url === 'string')
  )
    throw new Error('Invalid destination');
  if (
    value.url !== null &&
    !/^https:\/\/t\.me\/(?:c\/[1-9]\d*|[A-Za-z][A-Za-z0-9_]{3,31})\/?$/.test(value.url)
  )
    throw new Error('Invalid destination link');
  return { id: value.id, title: value.title, url: value.url };
}

function readDelivery(value: unknown): Delivery {
  if (!record(value)) throw new Error('Invalid delivery');
  if (value.state === 'ready' || value.state === 'sending') return { state: value.state };
  if (value.state === 'sent' && (value.url === null || typeof value.url === 'string')) {
    if (value.url !== null) parseLink(value.url);
    return { state: 'sent', url: value.url };
  }
  if ((value.state === 'failed' || value.state === 'unknown') && typeof value.message === 'string')
    return { state: value.state, message: value.message };
  throw new Error('Invalid delivery');
}

export function readStoredDraft(value: unknown): StoredDraft {
  try {
    if (
      !record(value) ||
      (value.version !== 1 && value.version !== 2) ||
      typeof value.revision !== 'string' ||
      !record(value.draft)
    )
      throw new Error('Invalid saved draft');
    const data = value.draft;
    if (
      !strings(data.sources) ||
      !Array.isArray(data.items) ||
      !(
        data.accountId === null ||
        (typeof data.accountId === 'string' && /^[1-9]\d*$/.test(data.accountId))
      )
    )
      throw new Error('Invalid saved draft');
    const sources = data.sources;
    const rawItems = data.items;
    const keys = new Set<string>();
    function readKey(value: unknown): string {
      if (typeof value !== 'string' || !/^[a-f0-9]{16}$/.test(value) || keys.has(value))
        throw new Error('Invalid sending key');
      keys.add(value);
      return value;
    }
    function readMessage(value: unknown): DraftMessage | null {
      // Drafts saved before accompanying messages were introduced have no such fields.
      if (value === undefined || value === null) return null;
      if (!record(value) || typeof value.text !== 'string' || !value.text.trim())
        throw new Error('Invalid accompanying message');
      const delivery = readDelivery(value.delivery);
      if (!data.accountId && delivery.state !== 'ready') throw new Error('Invalid draft');
      return { text: value.text, sendKey: readKey(value.sendKey), delivery };
    }
    function readContent(value: unknown): PollContent {
      if (
        !record(value) ||
        typeof value.question !== 'string' ||
        !strings(value.answers) ||
        !record(value.settings)
      )
        throw new Error('Invalid poll');
      const settings = {} as PollSettings;
      for (const key of SETTING_KEYS) {
        if (typeof value.settings[key] !== 'boolean') throw new Error('Invalid setting');
        settings[key] = value.settings[key];
      }
      return { question: value.question, answers: [...value.answers], settings };
    }
    const indices = new Set<number>();
    const resolved = resolveLinkValues(sources);
    const items: DraftItem[] = rawItems.map((item: unknown, index: number) => {
      if (!record(item)) throw new Error('Invalid poll');
      const content = readContent(item);
      if (value.version === 1) {
        if (typeof item.source !== 'string') throw new Error('Invalid source');
        if (item.source) parseLink(item.source);
        const delivery = readDelivery(item.delivery);
        if (!item.source && delivery.state !== 'ready') throw new Error('Invalid draft');
        const position =
          sources.length === rawItems.length
            ? index
            : resolved.findIndex(
                (source, position) => source === item.source && !indices.has(position),
              );
        if (position >= 0) indices.add(position);
        return {
          ...content,
          sourceIndices: position >= 0 ? [position] : [],
          loadedSources: item.source ? [item.source] : [],
          parts: [
            {
              ...structuredClone(content),
              sendKey: readKey(item.sendKey),
              delivery,
            },
          ],
        };
      }
      if (
        !Array.isArray(item.sourceIndices) ||
        !item.sourceIndices.length ||
        !strings(item.loadedSources) ||
        !Array.isArray(item.parts) ||
        !item.parts.length
      )
        throw new Error('Invalid poll references');
      const sourceIndices = item.sourceIndices.map((position: unknown) => {
        if (
          typeof position !== 'number' ||
          !Number.isSafeInteger(position) ||
          position < 0 ||
          position >= sources.length ||
          indices.has(position)
        )
          throw new Error('Invalid source position');
        indices.add(position);
        return position;
      });
      if (item.loadedSources.length && item.loadedSources.length !== sourceIndices.length)
        throw new Error('Invalid source references');
      item.loadedSources.forEach((source) => parseLink(source));
      const parts = item.parts.map((part: unknown) => {
        if (!record(part)) throw new Error('Invalid publication part');
        return {
          ...readContent(part),
          sendKey: readKey(part.sendKey),
          delivery: readDelivery(part.delivery),
        };
      });
      if (
        (!data.accountId || !item.loadedSources.length) &&
        parts.some((part) => part.delivery.state !== 'ready')
      )
        throw new Error('Invalid draft');
      const result = { ...content, sourceIndices, loadedSources: [...item.loadedSources], parts };
      if (!hasPublicationPlan(result)) throw new Error('Invalid publication plan');
      return result;
    });
    if (value.version === 2 && indices.size !== data.sources.length)
      throw new Error('Missing source references');
    const migrated: DraftItem[] = [];
    const groups = new Map<string, DraftItem>();
    const beforeMessage = readMessage(data.beforeMessage);
    const afterMessage = readMessage(data.afterMessage);
    const attempted = [
      ...items.flatMap((item) => item.parts),
      ...[beforeMessage, afterMessage].filter((message) => message !== null),
    ].some((item) => item.delivery.state !== 'ready');
    if (value.version === 2 && (typeof data.started !== 'boolean' || (!data.started && attempted)))
      throw new Error('Invalid publishing state');
    const started = value.version === 1 ? attempted : data.started === true;
    if (value.version === 1 && !started) {
      for (const item of items
        .filter((item) => item.sourceIndices.length)
        .sort((a, b) => a.sourceIndices[0] - b.sourceIndices[0])) {
        item.question = pollQuestion(item.question);
        item.answers = pollAnswers(item.answers);
        const previous = item.question ? groups.get(item.question) : undefined;
        if (!previous) {
          if (item.question) groups.set(item.question, item);
          migrated.push(item);
        } else {
          previous.answers = pollAnswers([...previous.answers, ...item.answers]);
          previous.sourceIndices.push(...item.sourceIndices);
          previous.loadedSources.push(...item.loadedSources);
          if (previous.loadedSources.length !== previous.sourceIndices.length)
            previous.loadedSources = [];
          previous.parts.push(...item.parts);
        }
      }
    }
    const draft: PollDraft = {
      started,
      sources: [...data.sources],
      accountId: data.accountId,
      destination: data.destination === null ? null : readDestination(data.destination),
      items: value.version === 1 && !started ? migrated : items,
      beforeMessage,
      afterMessage,
    };
    if (items.some((item) => item.loadedSources.length) && !draft.accountId)
      throw new Error('Invalid draft');
    return { revision: value.revision, draft };
  } catch {
    throw new UserFacingError('The saved draft cannot be read. Start a new draft to replace it.');
  }
}
