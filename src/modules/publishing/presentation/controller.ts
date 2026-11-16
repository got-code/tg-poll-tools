import { resolveLinkValues } from '../../polls/index.ts';
import { isEditable } from '../domain/drafts.ts';
import { element, elements, createStatus } from '../../../presentation/dom.ts';
import type { Publishing } from '../application/publishing.ts';
import type { Destination, PollContent, PollSettings } from '../domain/models.ts';

const SETTINGS: [keyof PollSettings, string][] = [
  ['anonymous', 'Anonymous voting'],
  ['multiple', 'Allow multiple answers'],
  ['shuffle', 'Shuffle answer options'],
  ['allowRevoting', 'Allow changing or retracting a vote'],
  ['openAnswers', 'Participants can add answer options'],
  ['hideResults', 'Hide results until the poll closes'],
];

export function createPublishingController({
  publishing,
  sourceLinks,
  isConnected,
  openLogin,
  onBusyChange,
  explainError,
}: {
  publishing: Publishing;
  sourceLinks: () => string[];
  isConnected: () => boolean;
  openLogin: (after: () => Promise<void>) => void;
  onBusyChange: (busy: boolean) => void;
  explainError: (error: unknown) => string;
}) {
  const $ = elements<{
    copyDetails: HTMLDetailsElement;
    copyForm: HTMLFormElement;
    copySources: HTMLDivElement;
    copyAddSource: HTMLButtonElement;
    copyUseAnalysis: HTMLButtonElement;
    copyLoad: HTMLButtonElement;
    copyReset: HTMLButtonElement;
    copySave: HTMLButtonElement;
    copyEditors: HTMLDivElement;
    copyDestination: HTMLSelectElement;
    copyChats: HTMLButtonElement;
    copyPreview: HTMLButtonElement;
    copyStatus: HTMLParagraphElement;
    copySaveHint: HTMLParagraphElement;
    publishPreview: HTMLDialogElement;
    publishSummary: HTMLDivElement;
    publishConfirm: HTMLButtonElement;
    publishCancel: HTMLButtonElement;
  }>();
  const status = createStatus($('copyStatus'));
  let busy = false;
  let saving = false;
  let saveVersion = 0;
  let restoreFailed = false;
  let sourceInputs: HTMLInputElement[] = [];
  const destinations = new Map<string, Destination>();

  function report(error: unknown) {
    status(explainError(error), true);
  }
  function state() {
    return publishing.getDraft();
  }
  function renderState() {
    const draft = state();
    const locked = draft?.items.some((item) => !isEditable(item)) ?? false;
    for (const input of sourceInputs) input.disabled = busy || locked;
    $('copyAddSource').disabled = busy || locked || !draft;
    $('copyUseAnalysis').disabled = busy || locked || !draft;
    $('copyLoad').disabled = busy || locked || !draft;
    $('copyReset').disabled = busy;
    $('copySave').disabled = busy || !draft;
    $('copyDestination').disabled = busy || locked || !draft?.items.length;
    $('copyChats').disabled = busy || locked || !draft?.items.length;
    $('copyPreview').disabled =
      busy || saving || !publishing.isSaved() || !draft?.items.some(isEditable);
    if (draft && !saving)
      $('copySaveHint').textContent = publishing.isSaved()
        ? 'Draft saved in this browser.'
        : 'Changes are not saved. Retry saving before publishing.';
    $('copyLoad').textContent = busy ? 'Working…' : 'Load source polls';
  }
  function save() {
    const version = ++saveVersion;
    saving = true;
    $('copySaveHint').textContent = 'Saving draft…';
    renderState();
    return publishing
      .save()
      .then(() => {
        if (version === saveVersion) $('copySaveHint').textContent = 'Draft saved in this browser.';
      })
      .catch((error: unknown) => {
        if (version === saveVersion) {
          $('copySaveHint').textContent = 'Changes are not saved. Retry saving before publishing.';
          report(error);
        }
      })
      .finally(() => {
        if (version === saveVersion) {
          saving = false;
          renderState();
        }
      });
  }
  function change(action: () => void, redraw = false) {
    try {
      if (busy) return;
      action();
      if (redraw) render();
      void save();
    } catch (error) {
      report(error);
    }
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    onBusyChange(true);
    render();
    try {
      await action();
    } catch (error) {
      report(error);
    } finally {
      busy = false;
      onBusyChange(false);
      render();
    }
  }
  function authenticated(action: () => Promise<void>) {
    if (!isConnected()) openLogin(action);
    else void action();
  }
  function renderSources() {
    const values = state()?.sources ?? [];
    const resolved = resolveLinkValues(values);
    sourceInputs = [];
    $('copySources').replaceChildren();
    values.forEach((value, index) => {
      const row = element('div', 'copy-source');
      const label = element('label', '', `Source poll ${index + 1}`);
      const input = element('input');
      input.type = 'url';
      input.value = value;
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.required = index === 0;
      input.setAttribute('aria-label', `Source poll ${index + 1} link`);
      input.placeholder = resolved[index] || 'https://t.me/group/123';
      label.append(input);
      const hint = element(
        'span',
        'field-hint',
        index && !value.trim() && resolved[index]
          ? `Automatic · ${resolved[index]}`
          : 'Paste a poll link. Blank rows use the next message.',
      );
      input.addEventListener('input', () =>
        change(() => {
          const next = sourceInputs.map((field) => field.value);
          publishing.setSources(next);
          const suggestions = resolveLinkValues(next);
          sourceInputs.forEach((field, position) => {
            field.placeholder = suggestions[position] || 'https://t.me/group/123';
          });
          hint.textContent =
            index && !input.value.trim()
              ? 'Automatic · next message after the previous source.'
              : 'Source changed; load source polls to update copies.';
        }),
      );
      const remove = element('button', 'text', 'Remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove source poll ${index + 1}`);
      remove.disabled = busy || (state()?.items.some((item) => !isEditable(item)) ?? false);
      remove.addEventListener('click', () =>
        change(() => {
          const next = state()!.sources.filter((_, position) => position !== index);
          publishing.setSources(next.length ? next : ['']);
        }, true),
      );
      row.append(label, remove, hint);
      $('copySources').append(row);
      sourceInputs.push(input);
    });
  }
  function renderDestination() {
    const current = state()?.destination;
    if (current) destinations.set(current.id, current);
    $('copyDestination').replaceChildren();
    if (!current) {
      const option = element(
        'option',
        '',
        state()?.items.length ? 'Choose a destination chat' : 'Load source polls first',
      );
      option.value = '';
      $('copyDestination').append(option);
    }
    for (const value of destinations.values()) {
      const option = element('option', '', value.title);
      option.value = value.id;
      option.selected = value.id === current?.id;
      $('copyDestination').append(option);
    }
  }
  function edit(index: number, update: (content: PollContent) => void, redraw = false) {
    change(() => {
      const item = state()!.items[index];
      update(item);
      publishing.edit(index, item);
    }, redraw);
  }
  function renderEditors() {
    $('copyEditors').replaceChildren();
    state()?.items.forEach((item, index) => {
      const panel = element('fieldset', 'copy-item');
      panel.disabled = busy || !isEditable(item);
      panel.append(element('legend', '', `Copy ${index + 1}`));
      const source = element('a', 'small', 'Source poll');
      source.href = item.source;
      source.target = '_blank';
      source.rel = 'noopener noreferrer';
      panel.append(source);
      const questionLabel = element('label', '', 'Question');
      const question = element('textarea');
      question.value = item.question;
      question.required = true;
      question.rows = 2;
      question.setAttribute('aria-label', `Copy ${index + 1} question`);
      question.addEventListener('input', () =>
        edit(index, (content) => {
          content.question = question.value;
        }),
      );
      questionLabel.append(question);
      panel.append(questionLabel);
      const answers = element('div', 'copy-answers');
      item.answers.forEach((text, answerIndex) => {
        const row = element('div', 'copy-answer');
        const label = element('label', '', `Option ${answerIndex + 1}`);
        const input = element('input');
        input.value = text;
        input.required = true;
        input.setAttribute('aria-label', `Copy ${index + 1} option ${answerIndex + 1}`);
        input.addEventListener('input', () =>
          edit(index, (content) => {
            content.answers[answerIndex] = input.value;
          }),
        );
        label.append(input);
        row.append(label);
        for (const [labelText, offset] of [
          ['Move up', -1],
          ['Move down', 1],
        ] as const) {
          const button = element('button', 'text', offset < 0 ? '↑' : '↓');
          button.type = 'button';
          button.setAttribute(
            'aria-label',
            `${labelText} option ${answerIndex + 1} in copy ${index + 1}`,
          );
          button.disabled = answerIndex + offset < 0 || answerIndex + offset >= item.answers.length;
          button.addEventListener('click', () =>
            edit(
              index,
              (content) => {
                const other = answerIndex + offset;
                [content.answers[answerIndex], content.answers[other]] = [
                  content.answers[other],
                  content.answers[answerIndex],
                ];
              },
              true,
            ),
          );
          row.append(button);
        }
        const remove = element('button', 'text', 'Remove');
        remove.type = 'button';
        remove.setAttribute(
          'aria-label',
          `Remove option ${answerIndex + 1} from copy ${index + 1}`,
        );
        remove.disabled = item.answers.length <= 2;
        remove.addEventListener('click', () =>
          edit(
            index,
            (content) => {
              content.answers.splice(answerIndex, 1);
            },
            true,
          ),
        );
        row.append(remove);
        answers.append(row);
      });
      panel.append(answers);
      const add = element('button', 'text', 'Add option');
      add.type = 'button';
      add.setAttribute('aria-label', `Add option to copy ${index + 1}`);
      add.addEventListener('click', () =>
        edit(
          index,
          (content) => {
            content.answers.push('');
          },
          true,
        ),
      );
      panel.append(add);
      const settings = element('div', 'copy-settings');
      for (const [key, text] of SETTINGS) {
        const label = element('label', 'check');
        const input = element('input');
        input.type = 'checkbox';
        input.checked = item.settings[key];
        input.setAttribute('aria-label', `${text} in copy ${index + 1}`);
        input.addEventListener('change', () =>
          edit(index, (content) => {
            content.settings[key] = input.checked;
          }),
        );
        label.append(input, document.createTextNode(text));
        settings.append(label);
      }
      panel.append(settings);
      const receipt = element('div', 'copy-receipt');
      receipt.setAttribute('role', 'status');
      if (item.delivery.state === 'sent') {
        receipt.append(element('strong', '', 'Published'));
        if (item.delivery.url) {
          const link = element('a', '', 'Open new poll');
          link.href = item.delivery.url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          receipt.append(link);
        }
      } else if (item.delivery.state === 'sending') receipt.textContent = 'Publishing…';
      else if (item.delivery.state === 'failed' || item.delivery.state === 'unknown') {
        receipt.append(element('p', '', item.delivery.message));
        if (item.delivery.state === 'unknown') {
          if (state()?.destination?.url) {
            const link = element('a', '', 'Check destination in Telegram');
            link.href = state()!.destination!.url!;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            receipt.append(link);
          }
          for (const [text, published] of [
            ['I found this poll in Telegram', true],
            ['I checked: allow retry', false],
          ] as const) {
            const button = element('button', 'text', text);
            button.type = 'button';
            button.disabled = busy;
            button.addEventListener('click', () => {
              void run(async () => {
                await publishing.resolveUnknown(index, published);
                status('Sending check recorded.');
              });
            });
            receipt.append(button);
          }
        }
      }
      $('copyEditors').append(panel, receipt);
    });
  }
  function render() {
    renderSources();
    renderDestination();
    renderEditors();
    renderState();
  }

  $('copyDetails').addEventListener('toggle', () => {
    if ($('copyDetails').open && !state() && !restoreFailed) {
      publishing.start(sourceLinks());
      render();
      void save();
    }
  });
  $('copyAddSource').addEventListener('click', () =>
    change(() => {
      publishing.setSources([...state()!.sources, '']);
    }, true),
  );
  $('copyUseAnalysis').addEventListener('click', () =>
    change(() => {
      const links = sourceLinks();
      publishing.setSources(links.length ? links : ['']);
    }, true),
  );
  $('copyReset').addEventListener('click', () => {
    if (
      (state()?.items.length || restoreFailed) &&
      !window.confirm('Replace this draft? Already published polls will remain in Telegram.')
    )
      return;
    void run(async () => {
      await publishing.reset(sourceLinks());
      restoreFailed = false;
      status('New draft created.');
      $('copySaveHint').textContent = 'Draft saved in this browser.';
    });
  });
  $('copySave').addEventListener('click', () => {
    void save().then(() => {
      if (publishing.isSaved()) status('Draft saved.');
    });
  });
  $('copyForm').addEventListener('submit', (event) => {
    event.preventDefault();
    authenticated(async () => {
      await run(async () => {
        await publishing.load();
        $('copySaveHint').textContent = 'Draft saved in this browser.';
        status(
          'Source polls loaded. Existing edits were kept. Choose the destination and review the copies.',
        );
      });
    });
  });
  $('copyChats').addEventListener('click', () =>
    authenticated(async () => {
      await run(async () => {
        const values = await publishing.destinations();
        values.forEach((value) => destinations.set(value.id, value));
        status('Choose one destination for all copies.');
      });
    }),
  );
  $('copyDestination').addEventListener('change', () =>
    change(() => {
      const value = destinations.get($('copyDestination').value);
      if (value) publishing.setDestination(value);
    }),
  );
  $('copyPreview').addEventListener('click', () => {
    try {
      publishing.validate();
      const draft = state()!;
      const items = draft.items.filter(isEditable);
      $('publishSummary').replaceChildren(
        element('p', '', `Destination: ${draft.destination!.title}`),
      );
      const list = element('ol');
      items.forEach((item) => {
        const poll = element('li');
        poll.append(element('h3', '', item.question));
        const options = element('ol');
        item.answers.forEach((answer) => options.append(element('li', '', answer)));
        poll.append(
          options,
          element(
            'p',
            'small',
            SETTINGS.map(([key, label]) => `${label}: ${item.settings[key] ? 'Yes' : 'No'}`).join(
              ' · ',
            ),
          ),
        );
        list.append(poll);
      });
      $('publishSummary').append(list);
      $('publishConfirm').textContent =
        `Publish ${items.length} ${items.length === 1 ? 'poll' : 'polls'}`;
      $('publishPreview').showModal();
    } catch (error) {
      report(error);
    }
  });
  $('publishCancel').addEventListener('click', () => $('publishPreview').close());
  $('publishConfirm').addEventListener('click', () => {
    $('publishPreview').close();
    authenticated(async () => {
      await run(async () => {
        await publishing.publish(render);
        status('All ready polls were published.');
        $('copySaveHint').textContent = 'Publication results saved in this browser.';
      });
    });
  });
  try {
    const saved = publishing.restore();
    if (saved) {
      $('copyDetails').open = true;
      $('copySaveHint').textContent = 'Saved draft restored from this browser.';
    }
  } catch (error) {
    restoreFailed = true;
    $('copyDetails').open = true;
    report(error);
  }
  render();
}
