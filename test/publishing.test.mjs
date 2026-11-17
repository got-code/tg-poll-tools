import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublishing } from '../src/modules/publishing/application/publishing.ts';
import { PublicationFailure } from '../src/modules/publishing/application/contracts.ts';
import { readStoredDraft } from '../src/modules/publishing/infrastructure/codec.ts';

const settings = {
  anonymous: true,
  multiple: true,
  shuffle: true,
  allowRevoting: false,
  openAnswers: true,
  hideResults: true,
};
const target = { id: '-1000000000010', title: 'Source chat', url: 'https://t.me/sourcechat' };
const sources = ['https://t.me/sourcechat/10', '', ''];
const failure = (outcome = 'failed') =>
  new PublicationFailure('Telegram refused this operation.', outcome, {
    service: 'Telegram',
    kind: 'rpc',
    rpcCode: 'CHAT_WRITE_FORBIDDEN',
    status: 403,
  });

function fixture() {
  let saved = null,
    sequence = 0,
    locked = false;
  const sent = [];
  const store = {
    read: () => structuredClone(saved),
    write(draft, expected) {
      if (expected !== undefined && (saved?.revision ?? null) !== expected)
        throw new Error('stale revision');
      saved = { revision: String(++sequence), draft: structuredClone(draft) };
      return saved.revision;
    },
    remove(expected) {
      if (expected !== undefined && (saved?.revision ?? null) !== expected)
        throw new Error('stale revision');
      saved = null;
    },
    async exclusive(action) {
      if (locked) throw new Error('another tab');
      locked = true;
      try {
        return await action();
      } finally {
        locked = false;
      }
    },
  };
  const gateway = {
    accountId: async () => '7',
    destinations: async () => [target],
    load: async (links) => ({
      accountId: '7',
      polls: links.map((link) => ({
        content: {
          question: `Question ${link.messageId}`,
          answers: ['First', 'Second'],
          settings: { ...settings },
        },
        destination: { ...target },
      })),
    }),
    async publish(destination, content, key) {
      assert.equal(
        store.read().draft.items.find((item) => item.sendKey === key).delivery.state,
        'sending',
      );
      sent.push({
        destination: structuredClone(destination),
        content: structuredClone(content),
        key,
      });
      return `https://t.me/sourcechat/${100 + sent.length}`;
    },
    async publishMessage(destination, text, key) {
      const draft = store.read().draft;
      assert.equal(
        [draft.beforeMessage, draft.afterMessage].find((item) => item?.sendKey === key).delivery
          .state,
        'sending',
      );
      sent.push({ destination: structuredClone(destination), content: { text }, key });
      return `https://t.me/sourcechat/${100 + sent.length}`;
    },
  };
  let key = 0;
  const create = () =>
    createPublishing({ gateway, store, newKey: () => (++key).toString(16).padStart(16, '0') });
  return { create, store, gateway, sent };
}

test('draft sources are independent, use sequential links and preserve all six settings', async () => {
  const f = fixture(),
    editor = f.create();
  const analysis = [...sources];
  editor.start(analysis);
  analysis[0] = 'changed';
  await editor.load();
  const draft = editor.getDraft();
  assert.deepEqual(
    draft.items.map((item) => item.source),
    [10, 11, 12].map((id) => `https://t.me/sourcechat/${id}`),
  );
  assert.deepEqual(draft.destination, target);
  assert.ok(draft.items.every((item) => assert.deepEqual(item.settings, settings) === undefined));
  draft.items[0].question = 'mutated snapshot';
  assert.equal(editor.getDraft().items[0].question, 'Question 10');
});

test('edits, settings, answer order and destination survive restoration without sending', async () => {
  const f = fixture(),
    editor = f.create();
  editor.start(sources);
  await editor.load();
  editor.setMessage('before', 'Before all polls\nA second line');
  editor.setMessage('after', 'After all polls');
  editor.edit(0, {
    question: 'New question',
    answers: ['Second', 'First', 'Third'],
    settings: { ...settings, shuffle: false },
  });
  editor.setDestination({
    id: '-1000000000020',
    title: 'Other chat',
    url: 'https://t.me/otherchat',
  });
  await editor.save();
  const restored = f.create();
  assert.deepEqual(restored.restore(), editor.getDraft());
  assert.equal(f.sent.length, 0);
  const decoded = readStoredDraft({ version: 1, ...f.store.read(), credentials: 'SECRET' });
  assert.deepEqual(decoded.draft, editor.getDraft());
  assert.ok(!JSON.stringify(decoded).includes('SECRET'));
});

test('optional messages publish once in order for every before/after combination', async () => {
  for (const before of [false, true]) {
    for (const after of [false, true]) {
      const f = fixture(),
        editor = f.create();
      editor.start(sources);
      editor.setMessage('before', before ? 'Introduction' : '  \n');
      editor.setMessage('after', after ? 'Closing message' : '');
      await editor.load();
      await editor.load({ replace: true });
      const draft = editor.getDraft();
      assert.equal(draft.beforeMessage?.text ?? null, before ? 'Introduction' : null);
      assert.equal(draft.afterMessage?.text ?? null, after ? 'Closing message' : null);
      await editor.publish(() => {});
      assert.deepEqual(
        f.sent.map(({ content }) => content.text ?? content.question),
        [
          ...(before ? ['Introduction'] : []),
          'Question 10',
          'Question 11',
          'Question 12',
          ...(after ? ['Closing message'] : []),
        ],
      );
      assert.ok(f.sent.every(({ destination }) => destination.id === target.id));
      assert.equal(new Set(f.sent.map(({ key }) => key)).size, f.sent.length);
      await assert.rejects(
        editor.publish(() => {}),
        /no remaining/,
      );
      if (before) assert.throws(() => editor.setMessage('before', ''), /already been sent/);
      if (after) assert.throws(() => editor.setMessage('after', 'Changed'), /already been sent/);
    }
  }
});

test('message failures stop later items, and retry skips the sent prefix with stable keys', async () => {
  for (const position of ['before', 'after']) {
    const f = fixture(),
      editor = f.create();
    editor.start(sources);
    await editor.load();
    editor.setMessage('before', 'Introduction');
    editor.setMessage('after', 'Closing message');
    const draft = editor.getDraft();
    const key = draft[`${position}Message`].sendKey;
    const send = f.gateway.publishMessage;
    f.gateway.publishMessage = async (...args) => {
      if (args[2] === key) throw failure();
      return send(...args);
    };
    await assert.rejects(
      editor.publish(() => {}),
      /refused/,
    );
    assert.equal(f.sent.length, position === 'before' ? 0 : 4);
    assert.equal(editor.getDraft()[`${position}Message`].delivery.state, 'failed');
    editor.setMessage(position, `Updated ${position}`);
    assert.equal(editor.getDraft()[`${position}Message`].sendKey, key);
    f.gateway.publishMessage = send;
    await editor.publish(() => {});
    assert.equal(f.sent.length, 5);
    assert.equal(new Set(f.sent.map(({ key }) => key)).size, 5);
    assert.deepEqual(
      f.sent.map(({ key }) => key),
      [
        draft.beforeMessage.sendKey,
        ...draft.items.map(({ sendKey }) => sendKey),
        draft.afterMessage.sendKey,
      ],
    );
  }
});

test('an uncertain intro blocks all later sends until checked, including after reload', async () => {
  const f = fixture(),
    editor = f.create();
  editor.start(sources);
  await editor.load();
  editor.setMessage('before', 'Introduction');
  editor.setMessage('after', 'Closing message');
  const key = editor.getDraft().beforeMessage.sendKey;
  const send = f.gateway.publishMessage;
  f.gateway.publishMessage = async () => {
    throw failure('unknown');
  };
  await assert.rejects(editor.publish(() => {}));
  const restored = f.create();
  restored.restore();
  assert.equal(restored.getDraft().beforeMessage.delivery.state, 'unknown');
  await assert.rejects(
    restored.publish(() => {}),
    /Check the uncertain/,
  );
  assert.throws(() => restored.setDestination(target), /cannot change/);
  assert.throws(() => restored.setSource(0, sources[0]), /new draft/);
  await assert.rejects(restored.load(), /new draft/);
  assert.equal(f.sent.length, 0);
  await restored.resolveUnknown('before', false);
  assert.equal(restored.getDraft().beforeMessage.sendKey, key);
  f.gateway.publishMessage = send;
  await restored.publish(() => {});
  assert.equal(f.sent.length, 5);
  assert.equal(f.sent[0].key, key);
});

test('an uncertain poll blocks the final message and acknowledgement continues without resending it', async () => {
  const f = fixture(),
    editor = f.create();
  editor.start([sources[0]]);
  await editor.load();
  editor.setMessage('before', 'Introduction');
  editor.setMessage('after', 'Closing message');
  f.gateway.publish = async () => {
    throw failure('unknown');
  };
  await assert.rejects(editor.publish(() => {}));
  await assert.rejects(
    editor.publish(() => {}),
    /Check the uncertain/,
  );
  assert.equal(f.sent.length, 1);
  await editor.resolveUnknown(0, true);
  await editor.publish(() => {});
  assert.deepEqual(
    f.sent.map(({ content }) => content.text),
    ['Introduction', 'Closing message'],
  );
});

test('message sending intent survives a storage failure without automatically duplicating a message', async () => {
  for (const phase of ['sending', 'sent']) {
    const f = fixture(),
      editor = f.create();
    editor.start([sources[0]]);
    await editor.load();
    editor.setMessage('before', 'Introduction');
    const write = f.store.write;
    f.store.write = (draft, revision) => {
      if (draft.beforeMessage.delivery.state === phase) throw new Error('storage full');
      return write(draft, revision);
    };
    await assert.rejects(
      editor.publish(() => {}),
      /storage full/,
    );
    assert.equal(f.sent.length, phase === 'sending' ? 0 : 1);
    f.store.write = write;
    const restored = f.create();
    restored.restore();
    assert.equal(
      restored.getDraft().beforeMessage.delivery.state,
      phase === 'sending' ? 'ready' : 'unknown',
    );
    if (phase === 'sent') {
      await restored.resolveUnknown('before', true);
      await restored.publish(() => {});
      assert.equal(f.sent.length, 2);
      assert.equal(f.sent[1].content.question, 'Question 10');
    }
  }
});

test('messages validate before any send, can be removed unsent, and cannot be prepended after polls', async () => {
  const f = fixture(),
    editor = f.create();
  editor.start([sources[0]]);
  await editor.load();
  editor.setMessage('after', 'x'.repeat(4097));
  await assert.rejects(
    editor.publish(() => {}),
    /4096/,
  );
  assert.equal(f.sent.length, 0);
  editor.setMessage('after', '  ');
  assert.equal(editor.getDraft().afterMessage, null);
  await editor.publish(() => {});
  assert.throws(() => editor.setMessage('before', 'Too late'), /after sending has begun/);
  editor.setMessage('after', 'A closing message');
  await editor.publish(() => {});
  assert.equal(f.sent.length, 2);
});

test('old drafts restore without messages; invalid message data and shared sending keys are rejected', async () => {
  const f = fixture(),
    editor = f.create();
  editor.start(sources);
  await editor.load();
  const old = { version: 1, ...f.store.read() };
  delete old.draft.beforeMessage;
  delete old.draft.afterMessage;
  assert.equal(readStoredDraft(old).draft.beforeMessage, null);
  assert.equal(readStoredDraft(old).draft.afterMessage, null);
  editor.setMessage('before', '<script>Literal text</script>');
  editor.setMessage('after', 'Closing message');
  await editor.save();
  for (const alter of [
    (draft) => {
      draft.beforeMessage.text = 7;
    },
    (draft) => {
      draft.afterMessage.delivery = { state: 'sent', url: 'https://evil.example/1' };
    },
    (draft) => {
      draft.beforeMessage.sendKey = draft.items[0].sendKey;
    },
    (draft) => {
      draft.afterMessage.sendKey = draft.beforeMessage.sendKey;
    },
  ]) {
    const value = { version: 1, ...f.store.read() };
    alter(value.draft);
    assert.throws(() => readStoredDraft(value), /saved draft cannot be read/);
  }
});

test('changing the source list preserves edits and sending keys of unchanged copies', async () => {
  const f = fixture(),
    editor = f.create();
  editor.start([sources[0]]);
  await editor.load();
  const first = editor.getDraft().items[0];
  editor.edit(0, { ...first, question: 'Keep this edit' });
  editor.setSources([sources[0], '']);
  await editor.load();
  assert.equal(editor.getDraft().items[0].question, 'Keep this edit');
  assert.equal(editor.getDraft().items[0].sendKey, first.sendKey);
  assert.equal(editor.getDraft().items[1].question, 'Question 11');
});

test('another tab cannot save or publish while a batch holds the storage lock', async () => {
  const f = fixture(),
    first = f.create();
  first.start([sources[0]]);
  await first.load();
  const other = f.create();
  other.restore();
  const gate = Promise.withResolvers(),
    started = Promise.withResolvers(),
    send = f.gateway.publish;
  f.gateway.publish = async (...args) => {
    started.resolve();
    await gate.promise;
    return send(...args);
  };
  const running = first.publish(() => {});
  await started.promise;
  await assert.rejects(
    other.publish(() => {}),
    /another tab/,
  );
  gate.resolve();
  await running;
  assert.equal(f.sent.length, 1);
});

test('publishing stores intent first, blocks concurrent clicks and never resends successes', async () => {
  const f = fixture(),
    editor = f.create();
  editor.start(sources);
  await editor.load();
  const original = f.gateway.publish,
    gate = Promise.withResolvers();
  f.gateway.publish = async (...args) => {
    await gate.promise;
    return original(...args);
  };
  const first = editor.publish(() => {});
  await assert.rejects(
    editor.publish(() => {}),
    /Wait/,
  );
  gate.resolve();
  await first;
  assert.equal(f.sent.length, 3);
  assert.ok(editor.getDraft().items.every((item) => item.delivery.state === 'sent'));
  await assert.rejects(
    editor.publish(() => {}),
    /no remaining/,
  );
  assert.throws(() => editor.setDestination(target), /cannot change/);
  assert.throws(() => editor.setSources(sources), /new draft/);
  assert.throws(() => editor.edit(0, editor.getDraft().items[0]), /already been sent/);
});

test('a confirmed failure stops the batch; retry preserves keys and skips the sent prefix', async () => {
  const f = fixture(),
    editor = f.create();
  editor.start(sources);
  await editor.load();
  const keys = editor.getDraft().items.map((item) => item.sendKey);
  const original = f.gateway.publish;
  f.gateway.publish = async (...args) => {
    if (args[2] === keys[1]) throw failure();
    return original(...args);
  };
  await assert.rejects(
    editor.publish(() => {}),
    /refused/,
  );
  assert.deepEqual(
    editor.getDraft().items.map((item) => item.delivery.state),
    ['sent', 'failed', 'ready'],
  );
  f.gateway.publish = original;
  await editor.publish(() => {});
  assert.deepEqual(
    f.sent.map((item) => item.key),
    keys,
  );
});

test('uncertain sending requires an explicit check before retry and retains its deduplication key', async () => {
  const f = fixture(),
    editor = f.create();
  editor.start([sources[0]]);
  await editor.load();
  const key = editor.getDraft().items[0].sendKey,
    original = f.gateway.publish;
  f.gateway.publish = async () => {
    throw failure('unknown');
  };
  await assert.rejects(editor.publish(() => {}));
  const restored = f.create();
  restored.restore();
  assert.equal(restored.getDraft().items[0].delivery.state, 'unknown');
  await assert.rejects(
    restored.publish(() => {}),
    /no remaining/,
  );
  assert.throws(() => restored.edit(0, restored.getDraft().items[0]), /already been sent/);
  await restored.resolveUnknown(0, false);
  f.gateway.publish = original;
  await restored.publish(() => {});
  assert.equal(f.sent[0].key, key);
});

test('restoring an interrupted sending intent never sends and can be acknowledged as published', async () => {
  const f = fixture(),
    editor = f.create();
  editor.start([sources[0]]);
  await editor.load();
  const saved = f.store.read();
  saved.draft.items[0].delivery = { state: 'sending' };
  f.store.write(saved.draft, saved.revision);
  const restored = f.create();
  restored.restore();
  assert.equal(restored.getDraft().items[0].delivery.state, 'unknown');
  await restored.resolveUnknown(0, true);
  assert.equal(restored.getDraft().items[0].delivery.state, 'sent');
  assert.equal(f.sent.length, 0);
});

test('storage failure before intent prevents any send and preserves editability', async () => {
  const f = fixture(),
    editor = f.create();
  editor.start([sources[0]]);
  await editor.load();
  const write = f.store.write;
  f.store.write = (draft, expected) => {
    if (draft.items.some((item) => item.delivery.state === 'sending'))
      throw new Error('storage full');
    return write(draft, expected);
  };
  await assert.rejects(
    editor.publish(() => {}),
    /storage full/,
  );
  assert.equal(f.sent.length, 0);
  assert.equal(editor.getDraft().items[0].delivery.state, 'ready');
});

test('storage failure after success leaves a durable uncertain outcome rather than a retryable poll', async () => {
  const f = fixture(),
    editor = f.create();
  editor.start([sources[0]]);
  await editor.load();
  const write = f.store.write;
  f.store.write = (draft, expected) => {
    if (draft.items.some((item) => item.delivery.state === 'sent')) throw new Error('storage full');
    return write(draft, expected);
  };
  await assert.rejects(
    editor.publish(() => {}),
    /storage full/,
  );
  assert.equal(f.sent.length, 1);
  const restored = f.create();
  restored.restore();
  assert.equal(restored.getDraft().items[0].delivery.state, 'unknown');
  await assert.rejects(
    restored.publish(() => {}),
    /no remaining/,
  );
});

test('stale tabs and a different signed-in account cannot publish a saved draft', async () => {
  const f = fixture(),
    first = f.create();
  first.start([sources[0]]);
  await first.load();
  const other = f.create();
  other.restore();
  first.edit(0, { ...first.getDraft().items[0], question: 'Updated in first tab' });
  await first.save();
  await assert.rejects(
    other.publish(() => {}),
    /stale revision/,
  );
  f.gateway.accountId = async () => '8';
  await assert.rejects(
    first.publish(() => {}),
    /different Telegram account/,
  );
  assert.equal(f.sent.length, 0);
});

test('changed source addresses and incomplete content are rejected before publishing', async () => {
  const f = fixture(),
    editor = f.create();
  editor.start([sources[0]]);
  await editor.load();
  editor.setSources(['https://t.me/sourcechat/99']);
  await assert.rejects(
    editor.publish(() => {}),
    /links changed/,
  );
  editor.setSources([sources[0]]);
  editor.edit(0, { ...editor.getDraft().items[0], question: '' });
  await assert.rejects(
    editor.publish(() => {}),
    /question/,
  );
  editor.edit(0, { ...editor.getDraft().items[0], question: 'Valid', answers: ['Only one'] });
  await assert.rejects(
    editor.publish(() => {}),
    /two answer/,
  );
  assert.equal(f.sent.length, 0);
});

test('saved-data decoding rejects unsafe links, unknown versions and duplicate send keys', async () => {
  const f = fixture(),
    editor = f.create();
  editor.start(sources);
  await editor.load();
  for (const alter of [
    (value) => {
      value.version = 2;
    },
    (value) => {
      value.draft.destination.url = 'javascript:alert(1)';
    },
    (value) => {
      value.draft.items[0].delivery = { state: 'sent', url: 'https://evil.example/1' };
    },
    (value) => {
      value.draft.items[1].sendKey = value.draft.items[0].sendKey;
    },
  ]) {
    const value = { version: 1, ...f.store.read() };
    alter(value);
    assert.throws(() => readStoredDraft(value), /saved draft cannot be read/);
  }
});

test('loading sources under another account preserves the saved edited draft', async () => {
  const f = fixture(),
    editor = f.create();
  editor.start([sources[0]]);
  await editor.load();
  editor.edit(0, { ...editor.getDraft().items[0], question: 'An important edit' });
  await editor.save();
  const before = editor.getDraft(),
    stored = f.store.read(),
    load = f.gateway.load;
  f.gateway.load = async (links) => ({ ...(await load(links)), accountId: '8' });
  await assert.rejects(editor.load(), /different Telegram account/);
  assert.deepEqual(editor.getDraft(), before);
  assert.deepEqual(f.store.read(), stored);
});

test('a failed save after loading new content is explicitly unsaved and can be retried', async () => {
  const f = fixture(),
    editor = f.create();
  editor.start([sources[0]]);
  await editor.load();
  editor.setSources([sources[0], '']);
  await editor.save();
  const write = f.store.write;
  f.store.write = (draft, expected) => {
    if (draft.items.length === 2) throw new Error('storage full');
    return write(draft, expected);
  };
  await assert.rejects(editor.load(), /storage full/);
  assert.equal(editor.isSaved(), false);
  assert.equal(editor.getDraft().items.length, 2);
  f.store.write = write;
  await editor.save();
  assert.equal(editor.isSaved(), true);
});

test('deleting waits for queued saves and removes both memory and storage', async () => {
  const f = fixture(),
    editor = f.create();
  editor.start(sources);
  await editor.load();
  editor.edit(0, { ...editor.getDraft().items[0], question: 'Pending edit' });
  const saving = editor.save();
  await editor.deleteDraft();
  await saving;
  assert.equal(editor.getDraft(), null);
  assert.equal(f.store.read(), null);
  assert.equal(f.create().restore(), null);
  editor.start(['https://t.me/sourcechat/42']);
  await editor.load();
  assert.equal(editor.getDraft().items[0].question, 'Question 42');
  assert.equal(f.sent.length, 0);
});

test('failed or stale deletion keeps the current draft', async () => {
  const f = fixture(),
    editor = f.create();
  editor.start(sources);
  await editor.load();
  const other = f.create();
  other.restore();
  editor.edit(0, { ...editor.getDraft().items[0], question: 'Updated' });
  await editor.save();
  await assert.rejects(other.deleteDraft(), /stale/);
  assert.ok(other.getDraft());
  const before = editor.getDraft();
  f.store.remove = () => {
    throw new Error('Storage unavailable');
  };
  await assert.rejects(editor.deleteDraft(), /Storage unavailable/);
  assert.deepEqual(editor.getDraft(), before);
  assert.equal(editor.isBusy(), false);
});

test('whole cards add, remove and restore together without shifting surviving copies', async () => {
  const f = fixture(),
    editor = f.create();
  editor.start(sources);
  assert.equal(editor.getDraft().items.length, 3);
  await editor.load();
  const middle = editor.getDraft().items[1];
  editor.edit(1, { ...middle, question: 'Keep this manual edit' });
  editor.remove(0);
  assert.equal(editor.getDraft().sources[0], 'https://t.me/sourcechat/11');
  assert.equal(editor.getDraft().items[0].question, 'Keep this manual edit');
  assert.equal(editor.getDraft().items[0].sendKey, middle.sendKey);
  for (let i = 0; i < 25; i++) editor.add();
  const draft = editor.getDraft();
  assert.equal(draft.sources.length, 27);
  assert.equal(draft.items.length, 27);
  assert.equal(draft.items.at(-1).source, '');
  await editor.save();
  assert.deepEqual(f.create().restore(), draft);
  assert.deepEqual(readStoredDraft({ version: 1, ...f.store.read() }).draft, draft);
  while (editor.getDraft().items.length) editor.remove(0);
  await editor.save();
  assert.equal(readStoredDraft({ version: 1, ...f.store.read() }).draft.items.length, 0);
  assert.equal(f.create().restore().items.length, 0);
  editor.add();
  assert.equal(editor.getDraft().items.length, 1);
});

test('source changes preserve manual content until explicit refill of all cards', async () => {
  const f = fixture(),
    editor = f.create();
  editor.start(sources);
  await editor.load();
  editor.edit(0, { ...editor.getDraft().items[0], question: 'Manual content' });
  editor.setSource(0, 'https://t.me/sourcechat/20');
  assert.equal(editor.getDraft().items[0].question, 'Manual content');
  assert.throws(() => editor.validate(), /links changed/);
  await editor.save();
  const restored = f.create();
  restored.restore();
  assert.equal(restored.getDraft().items[0].question, 'Manual content');
  assert.throws(() => restored.validate(), /links changed/);
  await restored.load({ replace: true });
  assert.deepEqual(
    restored.getDraft().items.map((item) => item.question),
    ['Question 20', 'Question 21', 'Question 22'],
  );
  restored.validate();
});
