import { UserFacingError } from '../../../application/errors.ts';
import { parseLink } from '../../polls/index.ts';
import type { Destination, Delivery, PollDraft, PollSettings } from '../domain/models.ts';
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
      value.version !== 1 ||
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
    const keys = new Set<string>();
    const items = data.items.map((item: unknown) => {
      if (
        !record(item) ||
        typeof item.question !== 'string' ||
        !strings(item.answers) ||
        typeof item.source !== 'string' ||
        typeof item.sendKey !== 'string' ||
        !/^[a-f0-9]{16}$/.test(item.sendKey) ||
        keys.has(item.sendKey) ||
        !record(item.settings)
      )
        throw new Error('Invalid poll');
      if (item.source) parseLink(item.source);
      else if (readDelivery(item.delivery).state !== 'ready')
        throw new Error('Unfilled poll has delivery state');
      keys.add(item.sendKey);
      const settings = {} as PollSettings;
      for (const key of SETTING_KEYS) {
        if (typeof item.settings[key] !== 'boolean') throw new Error('Invalid setting');
        settings[key] = item.settings[key];
      }
      return {
        source: item.source,
        sendKey: item.sendKey,
        question: item.question,
        answers: [...item.answers],
        settings,
        delivery: readDelivery(item.delivery),
      };
    });
    const draft: PollDraft = {
      sources: [...data.sources],
      accountId: data.accountId,
      destination: data.destination === null ? null : readDestination(data.destination),
      items,
    };
    if (items.some((item) => item.source) && !draft.accountId) throw new Error('Invalid draft');
    return { revision: value.revision, draft };
  } catch {
    throw new UserFacingError('The saved draft cannot be read. Start a new draft to replace it.');
  }
}
