export interface PollSettings {
  anonymous: boolean;
  multiple: boolean;
  shuffle: boolean;
  allowRevoting: boolean;
  openAnswers: boolean;
  hideResults: boolean;
}

export const SETTING_KEYS = [
  'anonymous',
  'multiple',
  'shuffle',
  'allowRevoting',
  'openAnswers',
  'hideResults',
] as const;

export interface PollContent {
  question: string;
  answers: string[];
  settings: PollSettings;
}

export interface Destination {
  id: string;
  title: string;
  url: string | null;
}

export type Delivery =
  | { state: 'ready' }
  | { state: 'sending' }
  | { state: 'sent'; url: string | null }
  | { state: 'failed' | 'unknown'; message: string };

export interface DraftItem extends PollContent {
  source: string;
  sendKey: string;
  delivery: Delivery;
}

export interface PollDraft {
  sources: string[];
  accountId: string | null;
  destination: Destination | null;
  items: DraftItem[];
}
