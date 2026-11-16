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
