import { UserFacingError } from '../../../application/errors.ts';
import { pollQuestion, pollAnswers } from '../../../domain/poll-content.ts';
import { readPollLinks, linkIdentity, resolveLinkValues } from '../../polls/index.ts';
import {
  validateContent,
  validateMessage,
  isEditable,
  orderedPublications,
  planParts,
  hasPublicationPlan,
} from '../domain/drafts.ts';
import { PublicationFailure } from './contracts.ts';
import type { DraftStore, PublishingGateway } from './contracts.ts';
import type {
  Destination,
  DraftItem,
  MessagePosition,
  PollContent,
  PollDraft,
} from '../domain/models.ts';

export function createPublishing({
  gateway,
  store,
  newKey,
}: {
  gateway: PublishingGateway;
  store: DraftStore;
  newKey: () => string;
}) {
  let draft: PollDraft | null = null;
  let revision: string | null = null;
  let busy = false;
  let saves: Promise<void> = Promise.resolve();
  let savedContent: string | null = null;
  let writeFailed = false;

  function blankItem(): DraftItem {
    const item: DraftItem = {
      sourceIndices: [],
      loadedSources: [],
      parts: [],
      question: '',
      answers: ['', ''],
      settings: {
        anonymous: false,
        multiple: false,
        shuffle: false,
        allowRevoting: true,
        openAnswers: false,
        hideResults: false,
      },
    };
    planParts(item, newKey);
    return item;
  }
  function requireEditing() {
    requireIdle();
    if (requireDraft().started)
      throw new UserFacingError(
        'This draft is fixed after a publishing attempt. Start a new draft to make changes.',
      );
  }
  function requireDraft() {
    if (!draft) throw new UserFacingError('Load source polls to create a draft.');
    return draft;
  }
  function requireIdle() {
    if (busy) throw new UserFacingError('Wait for the current draft operation to finish.');
  }
  function persist(value: PollDraft) {
    try {
      revision = store.write(value, revision);
      savedContent = JSON.stringify(value);
      writeFailed = false;
    } catch (error) {
      writeFailed = true;
      throw error;
    }
  }
  function pendingItems() {
    return orderedPublications(requireDraft()).filter(isEditable);
  }
  function normalizeQuestions() {
    const current = requireDraft();
    if (current.started) return;
    const groups = new Map<string, DraftItem>();
    const next: DraftItem[] = [];
    for (const item of current.items) {
      const question = item.question.trim();
      const previous = question ? groups.get(question) : undefined;
      if (!previous) {
        if (question) groups.set(question, item);
        next.push(item);
        continue;
      }
      previous.answers = pollAnswers([...previous.answers, ...item.answers]);
      const references = [
        ...previous.sourceIndices.map((index, position) => ({
          index,
          source: previous.loadedSources[position],
        })),
        ...item.sourceIndices.map((index, position) => ({
          index,
          source: item.loadedSources[position],
        })),
      ].sort((a, b) => a.index - b.index);
      previous.sourceIndices = references.map(({ index }) => index);
      previous.loadedSources = references.every(({ source }) => source !== undefined)
        ? references.map(({ source }) => source)
        : [];
      planParts(previous, newKey);
    }
    current.items = next;
    for (const item of current.items) if (!hasPublicationPlan(item)) planParts(item, newKey);
  }
  function validate() {
    const current = requireDraft();
    const links = readPollLinks(current.sources);
    if (
      current.items.some(
        (item) =>
          item.loadedSources.length !== item.sourceIndices.length ||
          item.sourceIndices.some(
            (index, position) =>
              !item.loadedSources[position] ||
              linkIdentity(links[index]) !==
                linkIdentity(readPollLinks([item.loadedSources[position]])[0]),
          ),
      ) ||
      current.items.flatMap((item) => item.sourceIndices).length !== links.length
    )
      throw new UserFacingError(
        'Source links changed. Fill drafts from sources before publishing.',
      );
    if (!current.destination || !current.accountId)
      throw new UserFacingError('Choose a destination.');
    if (!pendingItems().length)
      throw new UserFacingError('There are no remaining polls or messages ready to publish.');
    if (orderedPublications(current).some((item) => item.delivery.state === 'unknown'))
      throw new UserFacingError(
        'Check the uncertain sending result in Telegram before publishing the remaining items.',
      );
    for (const item of current.items) {
      if (!current.started) validateContent(item);
      if (!hasPublicationPlan(item))
        throw new UserFacingError(
          'The publication plan does not match this poll. Start a new draft to review it.',
        );
    }
    for (const item of pendingItems()) {
      if ('text' in item) validateMessage(item);
      else validateContent(item);
    }
  }
  function save() {
    const value = structuredClone(requireDraft());
    const attempt = saves.then(() =>
      store.exclusive(() => {
        persist(value);
      }),
    );
    saves = attempt.catch(() => {});
    return attempt;
  }

  return {
    getDraft: () => (draft === null ? null : structuredClone(draft)),
    isBusy: () => busy,
    isSaved: () => draft === null || (!writeFailed && JSON.stringify(draft) === savedContent),
    restore() {
      requireIdle();
      const saved = store.read();
      revision = saved?.revision ?? null;
      draft = saved?.draft ?? null;
      savedContent = saved === null ? null : JSON.stringify(saved.draft);
      if (draft) {
        draft.items = draft.items.filter((item) => item.sourceIndices.length);
        const assigned = new Set(draft.items.flatMap((item) => item.sourceIndices));
        draft.sources.forEach((_, index) => {
          if (!assigned.has(index)) draft!.items.push({ ...blankItem(), sourceIndices: [index] });
        });
        if (!draft.started) {
          draft.items.sort((a, b) => Math.min(...a.sourceIndices) - Math.min(...b.sourceIndices));
          for (const item of draft.items) if (!hasPublicationPlan(item)) planParts(item, newKey);
        }
      }
      writeFailed = false;
      for (const item of draft ? orderedPublications(draft) : [])
        if (item.delivery.state === 'sending')
          item.delivery = {
            state: 'unknown',
            message: 'Sending was interrupted. Check the destination in Telegram before retrying.',
          };
      return draft === null ? null : structuredClone(draft);
    },
    start(sources: readonly string[]) {
      requireIdle();
      if (draft)
        throw new UserFacingError('A draft already exists. Delete it explicitly to start again.');
      draft = {
        started: false,
        sources: sources.length ? [...sources] : [''],
        items: (sources.length ? sources : ['']).map((_, index) => ({
          ...blankItem(),
          sourceIndices: [index],
        })),
        destination: null,
        accountId: null,
        beforeMessage: null,
        afterMessage: null,
      };
      return structuredClone(draft);
    },
    async deleteDraft({ unreadable = false } = {}) {
      requireIdle();
      busy = true;
      try {
        await saves;
        await store.exclusive(() => {
          store.remove(unreadable ? undefined : revision);
          draft = null;
          revision = null;
          savedContent = null;
          writeFailed = false;
        });
      } finally {
        busy = false;
      }
    },
    setSources(sources: readonly string[]) {
      requireEditing();
      const current = requireDraft();
      const next = sources.length ? [...sources] : [''];
      const previous = resolveLinkValues(current.sources);
      const resolved = resolveLinkValues(next);
      const used = new Set<DraftItem>();
      const mapped = new Map<DraftItem, number[]>();
      resolved.forEach((source, index) => {
        const item = current.items.find((item) =>
          item.sourceIndices.some((position) => previous[position] === source),
        );
        if (item) mapped.set(item, [...(mapped.get(item) ?? []), index]);
      });
      const matched = new Set(mapped.keys());
      resolved.forEach((_, index) => {
        if ([...mapped.values()].some((indices) => indices.includes(index))) return;
        const item = current.items.find(
          (item) => !matched.has(item) && item.sourceIndices.includes(index),
        );
        if (item) mapped.set(item, [...(mapped.get(item) ?? []), index]);
      });
      current.items = resolved.flatMap((_, index) => {
        const item = [...mapped].find(([, indices]) => indices.includes(index))?.[0];
        if (!item) return [{ ...blankItem(), sourceIndices: [index] }];
        if (used.has(item)) return [];
        used.add(item);
        const indices = mapped.get(item)!;
        const loadedBySource = new Map(
          item.sourceIndices.map((position, offset) => [
            previous[position],
            item.loadedSources[offset],
          ]),
        );
        const loadedByIndex = new Map(
          item.sourceIndices.map((position, offset) => [position, item.loadedSources[offset]]),
        );
        const loadedSources = indices.map(
          (position) => loadedBySource.get(resolved[position]) ?? loadedByIndex.get(position),
        );
        item.sourceIndices = indices;
        item.loadedSources = loadedSources.every((source) => source !== undefined)
          ? loadedSources
          : [];
        return [item];
      });
      current.sources = next;
    },
    setSource(index: number, source: string) {
      requireEditing();
      const current = requireDraft();
      if (index < 0 || index >= current.sources.length)
        throw new UserFacingError('This source no longer exists.');
      current.sources[index] = source;
    },
    add() {
      requireEditing();
      const current = requireDraft();
      const index = current.sources.length;
      current.sources.push('');
      current.items.push({ ...blankItem(), sourceIndices: [index] });
    },
    remove(index: number) {
      requireEditing();
      const current = requireDraft();
      if (!current.items[index]) throw new UserFacingError('This draft item no longer exists.');
      // Resolve implicit links before removal to keep surviving cards bound to their sources.
      current.sources = resolveLinkValues(current.sources);
      const removed = new Set(current.items[index].sourceIndices);
      current.sources = current.sources.filter((_, position) => !removed.has(position));
      current.items.splice(index, 1);
      for (const item of current.items)
        item.sourceIndices = item.sourceIndices.map(
          (position) => position - [...removed].filter((removed) => removed < position).length,
        );
    },
    edit(index: number, content: PollContent) {
      requireEditing();
      const item = requireDraft().items[index];
      if (!item) throw new UserFacingError('This draft item no longer exists.');
      Object.assign(item, {
        question:
          content.question === item.question ? item.question : pollQuestion(content.question),
        answers: [...content.answers],
        settings: { ...content.settings },
      });
      planParts(item, newKey);
    },
    setMessage(position: MessagePosition, text: string) {
      requireEditing();
      const current = requireDraft();
      const field = position === 'before' ? 'beforeMessage' : 'afterMessage';
      const message = current[field];
      current[field] = text.trim()
        ? { text, sendKey: message?.sendKey ?? newKey(), delivery: { state: 'ready' } }
        : null;
    },
    setDestination(destination: Destination) {
      requireEditing();
      requireDraft().destination = structuredClone(destination);
    },
    save,
    validate,
    async prepare() {
      requireIdle();
      normalizeQuestions();
      validate();
      await save();
    },
    destinations: () => gateway.destinations(),
    async load({ replace = false } = {}) {
      requireEditing();
      const current = requireDraft();
      const links = readPollLinks(current.sources);
      busy = true;
      try {
        await saves;
        const loaded = await gateway.load(links);
        if (current.accountId && current.accountId !== loaded.accountId)
          throw new UserFacingError(
            'This draft belongs to a different Telegram account. Start a new draft explicitly to replace it.',
          );
        if (loaded.polls.length !== links.length || !loaded.polls.length)
          throw new UserFacingError('Telegram did not return all requested source polls.');
        const groups = new Map<string, DraftItem>();
        const items: DraftItem[] = [];
        loaded.polls.forEach(({ content }, index) => {
          const question = pollQuestion(content.question);
          const previous = groups.get(question);
          if (previous) {
            previous.answers = pollAnswers([...previous.answers, ...content.answers]);
            previous.sourceIndices.push(index);
            previous.loadedSources.push(links[index].url);
          } else {
            const item: DraftItem = {
              ...structuredClone(content),
              question,
              answers: pollAnswers(content.answers),
              sourceIndices: [index],
              loadedSources: [links[index].url],
              parts: [],
            };
            groups.set(question, item);
            items.push(item);
          }
        });
        const identity = (sources: string[]) =>
          sources.map((source) => linkIdentity(readPollLinks([source])[0])).join('|');
        const existing = new Map(
          current.accountId === loaded.accountId
            ? current.items
                .filter((item) => item.loadedSources.length)
                .map((item) => [identity(item.loadedSources), item])
            : [],
        );
        const nextItems = items.map((item) => {
          const previous = !replace && existing.get(identity(item.loadedSources));
          if (previous) return { ...previous, sourceIndices: item.sourceIndices };
          planParts(item, newKey);
          return item;
        });
        draft = {
          started: false,
          sources: [...current.sources],
          accountId: loaded.accountId,
          beforeMessage: current.beforeMessage,
          afterMessage: current.afterMessage,
          destination:
            current.accountId === loaded.accountId && current.destination
              ? current.destination
              : loaded.polls[0].destination,
          items: nextItems,
        };
        await save();
      } finally {
        busy = false;
      }
    },
    async resolveUnknown(index: number | MessagePosition, published: boolean, part = 0) {
      requireIdle();
      const current = requireDraft();
      const item =
        typeof index === 'number'
          ? current.items[index]?.parts[part]
          : index === 'before'
            ? current.beforeMessage
            : current.afterMessage;
      if (item?.delivery.state !== 'unknown')
        throw new UserFacingError('This item does not need a sending check.');
      item.delivery = published ? { state: 'sent', url: null } : { state: 'ready' };
      await save();
    },
    async publish(changed: () => void) {
      requireIdle();
      normalizeQuestions();
      validate();
      busy = true;
      try {
        await save();
        await store.exclusive(async () => {
          const current = requireDraft();
          if (store.read()?.revision !== revision)
            throw new UserFacingError(
              'The draft changed in another tab. Reload before publishing.',
            );
          if ((await gateway.accountId()) !== current.accountId)
            throw new UserFacingError(
              'This draft belongs to a different Telegram account. Create a new draft with the current account.',
            );
          for (const item of orderedPublications(current)) {
            if (!isEditable(item)) continue;
            const previous = item.delivery;
            const wasStarted = current.started;
            current.started = true;
            item.delivery = { state: 'sending' };
            try {
              persist(current);
            } catch (error) {
              item.delivery = previous;
              current.started = wasStarted;
              throw error;
            }
            changed();
            let failure: unknown;
            try {
              const url =
                'text' in item
                  ? await gateway.publishMessage(current.destination!, item.text, item.sendKey)
                  : await gateway.publish(current.destination!, item, item.sendKey);
              item.delivery = { state: 'sent', url };
            } catch (error) {
              failure =
                error instanceof PublicationFailure
                  ? error
                  : new UserFacingError(
                      'The sending result is unknown. Check the destination in Telegram before retrying.',
                    );
              item.delivery =
                error instanceof PublicationFailure
                  ? { state: error.outcome, message: error.message }
                  : {
                      state: 'unknown',
                      message:
                        'The sending result is unknown. Check the destination in Telegram before retrying.',
                    };
            }
            persist(current);
            changed();
            if (item.delivery.state !== 'sent') throw failure;
          }
        });
      } finally {
        busy = false;
        changed();
      }
    },
  };
}

export type Publishing = ReturnType<typeof createPublishing>;
