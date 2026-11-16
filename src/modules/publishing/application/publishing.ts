import { UserFacingError } from '../../../application/errors.ts';
import { readPollLinks, linkIdentity } from '../../polls/index.ts';
import { requireEditable, validateContent, isEditable } from '../domain/drafts.ts';
import { PublicationFailure } from './contracts.ts';
import type { DraftStore, PublishingGateway } from './contracts.ts';
import type { Destination, DraftItem, PollContent, PollDraft } from '../domain/models.ts';

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
    return requireDraft().items.filter(isEditable);
  }
  function validate() {
    const current = requireDraft();
    const links = readPollLinks(current.sources);
    if (
      links.length !== current.items.length ||
      links.some(
        (link, index) =>
          linkIdentity(link) !== linkIdentity(readPollLinks([current.items[index].source])[0]),
      )
    )
      throw new UserFacingError('Source links changed. Load source polls again before publishing.');
    if (!current.destination || !current.accountId)
      throw new UserFacingError('Choose a destination.');
    if (!pendingItems().length)
      throw new UserFacingError('There are no remaining polls ready to publish.');
    pendingItems().forEach(validateContent);
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
      savedContent = draft === null ? null : JSON.stringify(draft);
      writeFailed = false;
      for (const item of draft?.items ?? [])
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
        throw new UserFacingError('A draft already exists. Reset it explicitly to start again.');
      draft = {
        sources: sources.length ? [...sources] : [''],
        items: [],
        destination: null,
        accountId: null,
      };
      return structuredClone(draft);
    },
    async reset(sources: readonly string[]) {
      requireIdle();
      await saves;
      await store.exclusive(() => {
        const next: PollDraft = {
          sources: sources.length ? [...sources] : [''],
          items: [],
          destination: null,
          accountId: null,
        };
        try {
          revision = store.write(next, undefined);
        } catch (error) {
          writeFailed = true;
          throw error;
        }
        draft = next;
        savedContent = JSON.stringify(next);
        writeFailed = false;
      });
    },
    setSources(sources: readonly string[]) {
      requireIdle();
      if (requireDraft().items.some((item) => !isEditable(item)))
        throw new UserFacingError('Start a new draft to change sources after sending has begun.');
      requireDraft().sources = sources.length ? [...sources] : [''];
    },
    edit(index: number, content: PollContent) {
      requireIdle();
      const item = requireDraft().items[index];
      if (!item) throw new UserFacingError('This draft item no longer exists.');
      requireEditable(item);
      Object.assign(item, {
        question: content.question,
        answers: [...content.answers],
        settings: { ...content.settings },
        delivery: { state: 'ready' },
      });
    },
    setDestination(destination: Destination) {
      requireIdle();
      if (requireDraft().items.some((item) => !isEditable(item)))
        throw new UserFacingError('The destination cannot change after sending has begun.');
      requireDraft().destination = structuredClone(destination);
    },
    save,
    validate,
    destinations: () => gateway.destinations(),
    async load() {
      requireIdle();
      const current = requireDraft();
      if (current.items.some((item) => !isEditable(item)))
        throw new UserFacingError('Start a new draft before loading different source polls.');
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
        const existing = new Map(
          current.accountId === loaded.accountId
            ? current.items.map((item) => [linkIdentity(readPollLinks([item.source])[0]), item])
            : [],
        );
        draft = {
          sources: [...current.sources],
          accountId: loaded.accountId,
          destination:
            current.accountId === loaded.accountId && current.destination
              ? current.destination
              : loaded.polls[0].destination,
          items: loaded.polls.map(
            ({ content }, index): DraftItem =>
              existing.get(linkIdentity(links[index])) ?? {
                ...structuredClone(content),
                source: links[index].url,
                sendKey: newKey(),
                delivery: { state: 'ready' },
              },
          ),
        };
        await save();
      } finally {
        busy = false;
      }
    },
    async resolveUnknown(index: number, published: boolean) {
      requireIdle();
      const item = requireDraft().items[index];
      if (item?.delivery.state !== 'unknown')
        throw new UserFacingError('This poll does not need a sending check.');
      item.delivery = published ? { state: 'sent', url: null } : { state: 'ready' };
      await save();
    },
    async publish(changed: () => void) {
      requireIdle();
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
          for (const item of current.items) {
            if (!isEditable(item)) continue;
            const previous = item.delivery;
            item.delivery = { state: 'sending' };
            try {
              persist(current);
            } catch (error) {
              item.delivery = previous;
              throw error;
            }
            changed();
            let failure: unknown;
            try {
              const url = await gateway.publish(current.destination!, item, item.sendKey);
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
