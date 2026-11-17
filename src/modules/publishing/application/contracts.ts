import type { PollLink } from '../../polls/index.ts';
import { ServiceError } from '../../../application/errors.ts';
import type { ServiceFailure } from '../../../application/errors.ts';
import type { Destination, PollContent, PollDraft } from '../domain/models.ts';

export interface LoadedSources {
  accountId: string;
  polls: { content: PollContent; destination: Destination | null }[];
}

export interface PublishingGateway {
  load(links: readonly PollLink[]): Promise<LoadedSources>;
  destinations(): Promise<Destination[]>;
  accountId(): Promise<string>;
  publish(destination: Destination, content: PollContent, sendKey: string): Promise<string | null>;
  publishMessage(destination: Destination, text: string, sendKey: string): Promise<string | null>;
}

export interface StoredDraft {
  revision: string;
  draft: PollDraft;
}

export interface DraftStore {
  read(): StoredDraft | null;
  // Called only inside exclusive(). Reject stale revisions rather than overwriting another tab.
  // undefined means an explicit user-requested replacement, including corrupt saved data.
  write(draft: PollDraft, expectedRevision: string | null | undefined): string;
  remove(expectedRevision: string | null | undefined): void;
  exclusive<T>(action: () => T | Promise<T>): Promise<T>;
}

export class PublicationFailure extends ServiceError {
  readonly outcome: 'failed' | 'unknown';

  constructor(message: string, outcome: 'failed' | 'unknown', details: ServiceFailure) {
    super(message, details);
    this.outcome = outcome;
  }
}
