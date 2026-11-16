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
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let restoreFailed = false;
  let sourceInputs: HTMLInputElement[] = [];
  let sourceHintUpdates: (() => void)[] = [];
  const destinations = new Map<string, Destination>();
  const expandedCopies = new Map<string, boolean>();

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
    $('copyLoad').disabled = busy || locked || !draft?.items.length;
    $('copyReset').disabled = busy || (!draft && !restoreFailed);
    $('copySave').hidden = !draft || saving || publishing.isSaved();
    $('copySave').disabled = busy;
    $('copyDestination').disabled = busy || locked || !draft?.accountId;
    $('copyChats').disabled = busy || locked || !draft?.accountId;
    $('copyPreview').disabled =
      busy ||
      saving ||
      !publishing.isSaved() ||
      !draft?.items.some((item) => item.source && isEditable(item));
    if (!draft) $('copySaveHint').textContent = 'Drafts are saved only in this browser.';
    if (draft && !saving)
      $('copySaveHint').textContent = publishing.isSaved()
        ? 'Draft saved in this browser.'
        : 'Changes are not saved. Retry saving before publishing.';
    $('copyLoad').textContent = busy ? 'Working…' : 'Fill drafts from sources';
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = undefined;
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
      clearTimeout(saveTimer);
      saving = true;
      $('copySaveHint').textContent = 'Saving draft…';
      renderState();
      saveTimer = setTimeout(() => void save(), 300);
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
      if (saveTimer !== undefined) await save();
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
  function renderDestination() {
    const current = state()?.destination;
    if (current) destinations.set(current.id, current);
    $('copyDestination').replaceChildren();
    if (!current) {
      const option = element(
        'option',
        '',
        state()?.accountId ? 'Choose a destination chat' : 'Fill drafts from sources first',
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
    sourceInputs = [];
    sourceHintUpdates = [];
    const sources = state()?.sources ?? [];
    const resolved = resolveLinkValues(sources);
    const sourceLocked = state()?.items.some((item) => !isEditable(item)) ?? false;
    state()?.items.forEach((item, index) => {
      const card = element('details', 'copy-card');
      card.open = expandedCopies.get(item.sendKey) ?? index === 0;
      const heading = element('summary');
      const title = element(
        'span',
        'copy-title',
        `Copy ${index + 1} · ${item.question || 'Untitled poll'}`,
      );
      heading.append(title);
      card.append(heading);
      card.addEventListener('toggle', () => {
        if (card.isConnected) expandedCopies.set(item.sendKey, card.open);
      });
      const sourceRow = element('div', 'copy-source');
      const sourceLabel = element('label', '', 'Source poll link');
      const sourceInput = element('input');
      sourceInput.type = 'url';
      sourceInput.value = sources[index];
      sourceInput.placeholder = resolved[index] || 'https://t.me/group/123';
      sourceInput.autocomplete = 'off';
      sourceInput.spellcheck = false;
      sourceInput.required = index === 0;
      sourceInput.setAttribute('aria-label', `Source poll ${index + 1} link`);
      sourceInput.disabled = busy || sourceLocked;
      sourceInputs.push(sourceInput);
      sourceLabel.append(sourceInput);
      const hint = element('span', 'field-hint');
      const updateHint = () => {
        const current = state()!;
        const links = resolveLinkValues(current.sources);
        hint.textContent = !item.source
          ? 'Fill drafts from sources to load this poll.'
          : links[index] !== item.source
            ? 'Source changed. Fill drafts from sources to update this copy.'
            : 'This copy was filled from this source.';
        if (!current.sources[index].trim() && links[index])
          hint.textContent += ` Automatic · ${links[index]}`;
      };
      updateHint();
      sourceHintUpdates.push(updateHint);
      sourceInput.addEventListener('input', () =>
        change(() => {
          publishing.setSource(index, sourceInput.value);
          const links = resolveLinkValues(state()!.sources);
          sourceInputs.forEach((input, position) => {
            input.placeholder = links[position] || 'https://t.me/group/123';
          });
          sourceHintUpdates.forEach((update) => update());
        }),
      );
      const remove = element('button', 'text', 'Remove poll');
      remove.type = 'button';
      remove.disabled = busy || sourceLocked;
      remove.setAttribute('aria-label', `Remove poll ${index + 1}`);
      remove.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        change(() => publishing.remove(index), true);
      });
      heading.append(remove);
      sourceRow.append(sourceLabel, hint);
      card.append(sourceRow);
      const panel = element('fieldset', 'copy-item');
      panel.disabled = busy || !isEditable(item);
      panel.setAttribute('aria-label', `Copy ${index + 1}`);
      const questionLabel = element('label', '', 'Question');
      const question = element('textarea');
      question.value = item.question;
      question.rows = 2;
      question.setAttribute('aria-label', `Copy ${index + 1} question`);
      question.addEventListener('input', () =>
        edit(index, (content) => {
          content.question = question.value;
          title.textContent = `Copy ${index + 1} · ${question.value || 'Untitled poll'}`;
        }),
      );
      questionLabel.append(question);
      panel.append(questionLabel);
      const answersLabel = element('label', '', 'Answer options');
      const answers = element('textarea');
      answers.value = item.answers.join('\n');
      answers.rows = Math.max(4, Math.min(item.answers.length, 10));
      answers.placeholder = 'First option\nSecond option\nThird option';
      answers.setAttribute('aria-label', `Copy ${index + 1} answer options`);
      const answersHint = element('span', 'field-hint', 'One option per line.');
      answersHint.id = `copyAnswersHint${index}`;
      answers.setAttribute('aria-describedby', answersHint.id);
      answers.addEventListener('input', () =>
        edit(index, (content) => {
          content.answers = answers.value.split('\n');
        }),
      );
      answersLabel.append(answers, answersHint);
      panel.append(answersLabel);
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
      card.append(panel, receipt);
      $('copyEditors').append(card);
    });
  }
  function render() {
    renderDestination();
    renderEditors();
    renderState();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && saveTimer !== undefined) void save();
  });
  window.addEventListener('beforeunload', (event) => {
    if (!publishing.isSaved()) {
      if (saveTimer !== undefined) void save();
      event.preventDefault();
      event.returnValue = '';
    }
  });
  $('copyDetails').addEventListener('toggle', () => {
    if ($('copyDetails').open && !state() && !restoreFailed) {
      publishing.start(sourceLinks());
      render();
      void save();
    }
  });
  $('copyAddSource').addEventListener('click', () =>
    change(() => {
      const before = state()!.items.length;
      publishing.add();
      expandedCopies.set(state()!.items[before].sendKey, true);
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
      (state() || restoreFailed) &&
      !window.confirm(
        'Delete this draft and its saved edits? Already published polls will remain in Telegram.',
      )
    )
      return;
    clearTimeout(saveTimer);
    saveTimer = undefined;
    saving = false;
    void run(async () => {
      await publishing.deleteDraft({ unreadable: restoreFailed });
      saving = false;
      expandedCopies.clear();
      destinations.clear();
      $('copyDetails').open = false;
      restoreFailed = false;
      status('Draft deleted.');
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
    if (
      state()?.items.some(
        (item) => item.question.trim() || item.answers.some((answer) => answer.trim()),
      ) &&
      !window.confirm(
        'Replace the questions, answers and settings in all copies with their source polls?',
      )
    )
      return;
    authenticated(async () => {
      await run(async () => {
        await publishing.load({ replace: true });
        $('copySaveHint').textContent = 'Draft saved in this browser.';
        status(
          'All drafts filled from their sources. Choose the destination and review the copies.',
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
        const settings = element('div', 'copy-settings');
        SETTINGS.forEach(([key, text]) => {
          const label = element('label', 'check');
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.checked = item.settings[key];
          input.disabled = true;
          label.append(input, document.createTextNode(text));
          settings.append(label);
        });
        poll.append(options, settings);
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
        if (state()?.items.every((item) => item.delivery.state === 'sent'))
          $('copyDetails').open = false;
      });
    });
  });
  try {
    const saved = publishing.restore();
    if (saved) {
      $('copyDetails').open = saved.items.some(
        (item) =>
          item.delivery.state !== 'sent' &&
          (item.source || item.question.trim() || item.answers.some((answer) => answer.trim())),
      );
      $('copySaveHint').textContent = 'Saved draft restored from this browser.';
    }
  } catch (error) {
    restoreFailed = true;
    $('copyDetails').open = true;
    report(error);
  }
  render();
}
