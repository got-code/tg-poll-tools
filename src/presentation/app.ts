import { createAuthController } from '../modules/auth/presentation/controller.ts';
import { createPollController } from '../modules/polls/presentation/controller.ts';
import { createPublishingController } from '../modules/publishing/presentation/controller.ts';
import type { Publishing } from '../modules/publishing/index.ts';
import { createStatus, elements } from './dom.ts';
import type { AuthSession } from '../modules/auth/index.ts';
import type { PollResults, PreferencesStore } from '../modules/polls/index.ts';

interface AppDependencies {
  authSession: AuthSession;
  results: PollResults;
  preferences: PreferencesStore;
  publishing?: Publishing;
  explainError(this: void, error: unknown): string;
  prepareLogin?(this: void): Promise<void>;
}

export function startApp({
  authSession,
  results,
  preferences,
  publishing,
  explainError,
  prepareLogin = async () => {},
}: AppDependencies) {
  const $ = elements<{ status: HTMLElement }>();
  const notify = createStatus($('status'));
  const busyFeatures = new Set<string>();
  const onBusyChange = (feature: string, busy: boolean) => {
    if (busy) busyFeatures.add(feature);
    else busyFeatures.delete(feature);
    auth.setDisabled(busyFeatures.size > 0);
  };
  const auth = createAuthController({
    session: authSession,
    explainError,
    prepareLogin,
    notify,
    onSignOut: () => polls.clear(authSession.hasSavedLogin()),
  });
  const polls = createPollController({
    results,
    preferences,
    explainError,
    notify,
    isConnected: authSession.isConnected,
    openLogin: auth.openLogin,
    onBusyChange: (busy) => onBusyChange('analysis', busy),
  });
  if (publishing)
    createPublishingController({
      publishing,
      sourceLinks: polls.sourceLinks,
      isConnected: authSession.isConnected,
      openLogin: auth.openLogin,
      onBusyChange: (busy) => onBusyChange('publishing', busy),
      explainError,
    });
  else document.getElementById('copySection')?.setAttribute('hidden', '');
}
