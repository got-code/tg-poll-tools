import { UserFacingError } from '../../../application/errors.ts';
import { readStoredDraft } from './codec.ts';
import type { DraftStore } from '../application/contracts.ts';

export const DRAFT_KEY = 'telegram-poll-tools.draft.v1';

export function newSendKey() {
  const values = crypto.getRandomValues(new Uint32Array(2));
  return [...values].map((value) => value.toString(16).padStart(8, '0')).join('');
}

export function createDraftStore(): DraftStore {
  const read: DraftStore['read'] = () => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      return raw === null ? null : readStoredDraft(JSON.parse(raw) as unknown);
    } catch (error) {
      if (error instanceof UserFacingError) throw error;
      throw new UserFacingError('Browser storage is unavailable. The draft cannot be restored.');
    }
  };
  return {
    read,
    write(draft, expectedRevision) {
      if (expectedRevision !== undefined && (read()?.revision ?? null) !== expectedRevision)
        throw new UserFacingError('The draft changed in another tab. Reload before continuing.');
      const revision = crypto.randomUUID();
      try {
        const raw = JSON.stringify({ version: 2, revision, draft });
        localStorage.setItem(DRAFT_KEY, raw);
        if (localStorage.getItem(DRAFT_KEY) !== raw) throw new Error('Write did not persist');
      } catch {
        throw new UserFacingError(
          'The draft could not be saved. Free browser storage before publishing.',
        );
      }
      return revision;
    },
    remove(expectedRevision) {
      if (expectedRevision !== undefined && (read()?.revision ?? null) !== expectedRevision)
        throw new UserFacingError('The draft changed in another tab. Reload before deleting it.');
      try {
        localStorage.removeItem(DRAFT_KEY);
        if (localStorage.getItem(DRAFT_KEY) !== null) throw new Error('Deletion did not persist');
      } catch {
        throw new UserFacingError(
          'The draft could not be deleted. Check browser storage and retry.',
        );
      }
    },
    async exclusive(action) {
      if (!navigator.locks)
        throw new UserFacingError(
          'This browser cannot safely coordinate draft storage. Use a current browser with Web Locks support.',
        );
      return navigator.locks.request(DRAFT_KEY, { ifAvailable: true }, async (lock) => {
        if (!lock)
          throw new UserFacingError(
            'Another tab is updating or publishing this draft. Wait and reload before continuing.',
          );
        return action();
      });
    },
  };
}
