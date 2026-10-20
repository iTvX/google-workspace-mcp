/**
 * The changes that bring the server in line with the claude.ai Gmail connector, plus the
 * one thing it adds — two mailboxes in one place:
 *
 *   1. GWS_SERVICES loads only the services the accounts authorized;
 *   3. a default account, and `email: "all"` for list operations;
 *   4. consent asks only for the served services and can pre-select the account;
 *   5. the audit log records who did what, not what the mail said;
 *   6. spam, whole-thread trash, label rename and delete.
 *
 * (Drafts, item 2, are in services/gmail/draft-editing.test.ts.)
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';

const listAccounts = vi.hoisted(() => vi.fn());
vi.mock('../../accounts/registry.js', () => ({ listAccounts }));
vi.mock('../../google/client.js');

const { call } = await import('../../google/client.js');
const { generateHandler, generateSchema, loadManifest } = await import('../../factory/generator.js');
const { patches } = await import('../../factory/patches.js');
const { filterManifest, parseServices, servicesToAuthorize } = await import('../../factory/services.js');
const { redactForAudit, auditLog, configurePolicies } = await import('../../factory/safety.js');
const { buildAuthUrl, ALL_SERVICES } = await import('../../accounts/oauth.js');

const mockCall = call as MockedFunction<typeof call>;
const manifest = loadManifest();
const MAX = 'max@example.com';
const ALLY = 'ally@example.com';

beforeEach(() => {
  mockCall.mockReset();
  mockCall.mockResolvedValue({ labels: [] } as never);
  listAccounts.mockResolvedValue([
    { email: MAX, category: 'personal', hasCredential: true },
    { email: ALLY, category: 'other', hasCredential: true },
  ]);
});

afterEach(() => configurePolicies([]));

describe('1. GWS_SERVICES', () => {
  it('keeps gmail and its split-off send tool, and nothing else', () => {
    const served = filterManifest(manifest, parseServices('gmail'));
    expect(Object.keys(served.services).sort()).toEqual(['gmail', 'gmail-send']);
  });

  it('loads everything when unset, as before', () => {
    expect(filterManifest(manifest, parseServices(undefined))).toBe(manifest);
    expect(filterManifest(manifest, parseServices('  '))).toBe(manifest);
  });

  it('fails the start on a name it does not know, rather than loading nothing', () => {
    expect(() => filterManifest(manifest, parseServices('gmial'))).toThrow('Unknown service(s) in GWS_SERVICES: gmial');
  });
});

describe('3. default account and "all"', () => {
  const gmail = manifest.services.gmail;
  const send = manifest.services['gmail-send'];

  it('makes email optional where a default exists, and names it', () => {
    const schema = generateSchema(gmail, { defaultAccount: MAX });
    expect(schema.inputSchema.required).toEqual(['operation']);
    expect((schema.inputSchema.properties as any).email.description).toContain(`Defaults to ${MAX}`);
    expect((schema.inputSchema.properties as any).email.description).toContain('"all"');
  });

  it('never defaults the account send_email sends from', () => {
    const schema = generateSchema(send, { defaultAccount: MAX });
    expect(schema.inputSchema.required).toContain('email');
    expect((schema.inputSchema.properties as any).email.description).not.toContain(MAX);
  });

  it('acts as the default account when none is named', async () => {
    const handler = generateHandler(gmail, patches.gmail, 'gmail', { defaultAccount: MAX });
    await handler({ operation: 'labels' });
    expect(mockCall).toHaveBeenCalledWith('gmail', 'users.labels.list', expect.anything(), expect.objectContaining({ account: MAX }));
  });

  it('refuses an unnamed sender even with a default set', async () => {
    const handler = generateHandler(send, patches.gmail, 'gmail', { defaultAccount: MAX });
    await expect(handler({ operation: 'send', to: 'x@example.com', subject: 's', body: 'b' }))
      .rejects.toThrow('A valid email address is required');
  });

  it('runs a list operation once per account, each under its own heading', async () => {
    const handler = generateHandler(gmail, patches.gmail, 'gmail');
    const result = await handler({ operation: 'labels', email: 'all' });

    const accounts = mockCall.mock.calls.map((c) => (c[3] as { account: string }).account).sort();
    expect(accounts).toEqual([ALLY, MAX]);
    expect(result.text).toContain(`### ${MAX}`);
    expect(result.text).toContain(`### ${ALLY}`);
    expect(Object.keys(result.refs.accounts as object).sort()).toEqual([ALLY, MAX]);
  });

  it('reports one account failing without losing the other', async () => {
    mockCall.mockImplementation(async (_s, _m, _p, opts) => {
      if ((opts as { account: string }).account === ALLY) throw new Error('token revoked');
      return { labels: [] } as never;
    });
    const handler = generateHandler(gmail, patches.gmail, 'gmail');
    const result = await handler({ operation: 'labels', email: 'all' });

    expect(result.text).toContain(`### ${ALLY}\n\n**Error:** token revoked`);
    expect(result.text).toContain(`### ${MAX}`);
  });

  it('refuses "all" for anything that changes mail', async () => {
    const handler = generateHandler(gmail, patches.gmail, 'gmail');
    await expect(handler({ operation: 'trash', email: 'all', messageId: 'm1' })).rejects.toThrow('list operations only');
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('refuses "all" as a sender', async () => {
    const handler = generateHandler(send, patches.gmail, 'gmail');
    await expect(handler({ operation: 'send', email: 'all', to: 'x@example.com', subject: 's', body: 'b' }))
      .rejects.toThrow('one account at a time');
  });
});

describe('4. consent scope and account', () => {
  it('requests only GWS_SERVICES when set, else everything as upstream did', () => {
    expect(servicesToAuthorize('gmail')).toBe('gmail');
    expect(servicesToAuthorize(undefined)).toBe(ALL_SERVICES);
  });

  it('pre-selects the account with login_hint when one is given', () => {
    const url = new URL(buildAuthUrl('cid', 'http://127.0.0.1:1/callback', ['s'], 'st', MAX));
    expect(url.searchParams.get('login_hint')).toBe(MAX);
    const plain = new URL(buildAuthUrl('cid', 'http://127.0.0.1:1/callback', ['s'], 'st'));
    expect(plain.searchParams.has('login_hint')).toBe(false);
  });
});

describe('5. audit log', () => {
  it('keeps who, what and where, and replaces content with its length', () => {
    const redacted = redactForAudit({ to: 'bob@example.com', subject: 'Hi', body: 'secret text', messageId: 'm1' });
    expect(redacted).toEqual({ to: 'bob@example.com', subject: 'Hi', body: '[11 chars]', messageId: 'm1' });
  });

  it('writes the redacted form', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await auditLog.evaluate([], { operation: 'send', account: MAX, params: { to: 'bob@example.com', body: 'secret text' } }, 'gmail');
      const line = write.mock.calls.map((c) => String(c[0])).find((l) => l.includes('AUDIT'))!;
      expect(line).toContain('bob@example.com');
      expect(line).toContain('[11 chars]');
      expect(line).not.toContain('secret text');
    } finally {
      write.mockRestore();
    }
  });
});

describe('6. spam, whole threads, labels', () => {
  const handler = generateHandler(manifest.services.gmail, patches.gmail, 'gmail');
  const lastCall = () => mockCall.mock.calls.at(-1)!;

  it('markSpam moves a message to Spam and out of the inbox', async () => {
    await handler({ operation: 'markSpam', email: MAX, messageId: 'm1' });
    expect(lastCall()[1]).toBe('users.messages.modify');
    expect(lastCall()[2]).toMatchObject({ id: 'm1', addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] });
  });

  it('unmarkSpam puts it back', async () => {
    await handler({ operation: 'unmarkSpam', email: MAX, messageId: 'm1' });
    expect(lastCall()[2]).toMatchObject({ id: 'm1', addLabelIds: ['INBOX'], removeLabelIds: ['SPAM'] });
  });

  it('trashThread and untrashThread act on the whole conversation', async () => {
    await handler({ operation: 'trashThread', email: MAX, threadId: 't1' });
    expect(lastCall()[1]).toBe('users.threads.trash');
    expect(lastCall()[2]).toMatchObject({ id: 't1' });
    await handler({ operation: 'untrashThread', email: MAX, threadId: 't1' });
    expect(lastCall()[1]).toBe('users.threads.untrash');
  });

  it('updateLabel renames by id, sending only what was given', async () => {
    await handler({ operation: 'updateLabel', email: MAX, labelId: 'Label_1', name: 'Receipts' });
    expect(lastCall()[1]).toBe('users.labels.patch');
    expect(lastCall()[2]).toEqual({ userId: 'me', id: 'Label_1', name: 'Receipts' });
  });

  it('deleteLabel deletes the label by id', async () => {
    await handler({ operation: 'deleteLabel', email: MAX, labelId: 'Label_1' });
    expect(lastCall()[1]).toBe('users.labels.delete');
    expect(lastCall()[2]).toEqual({ userId: 'me', id: 'Label_1' });
  });
});

describe('7. archive means Gmail archive, and whole-thread parity', () => {
  const handler = generateHandler(manifest.services.gmail, patches.gmail, 'gmail');
  const send = generateHandler(manifest.services['gmail-send'], patches.gmail, 'gmail');
  const lastCall = () => mockCall.mock.calls.at(-1)!;

  it.each([
    ['archive', { removeLabelIds: ['INBOX'] }],
    ['unarchive', { addLabelIds: ['INBOX'] }],
    ['markRead', { removeLabelIds: ['UNREAD'] }],
    ['markUnread', { addLabelIds: ['UNREAD'] }],
  ])('%s changes the message\'s labels in Gmail', async (operation, change) => {
    await handler({ operation, email: MAX, messageId: 'm1' });
    expect(lastCall()[1]).toBe('users.messages.modify');
    expect(lastCall()[2]).toEqual({ userId: 'me', id: 'm1', ...change });
  });

  it('archive writes no local file — there is no archive-to-file any more', () => {
    expect(manifest.services.gmail.operations.archive.resource).toBe('users.messages.modify');
    expect((patches.gmail.customHandlers ?? {}).archive).toBeUndefined();
  });

  it.each([
    ['archiveThread', { removeLabelIds: ['INBOX'] }],
    ['unarchiveThread', { addLabelIds: ['INBOX'] }],
    ['markThreadSpam', { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] }],
    ['unmarkThreadSpam', { addLabelIds: ['INBOX'], removeLabelIds: ['SPAM'] }],
  ])('%s acts on the whole thread', async (operation, change) => {
    await handler({ operation, email: MAX, threadId: 't1' });
    expect(lastCall()[1]).toBe('users.threads.modify');
    expect(lastCall()[2]).toEqual({ userId: 'me', id: 't1', ...change });
  });

  it('modifyThread adds and removes labels on every message of a thread', async () => {
    mockCall.mockResolvedValue({ id: 't1', messages: [{}, {}, {}] } as never);
    const result = await handler({
      operation: 'modifyThread', email: MAX, threadId: 't1', addLabelIds: 'Label_1, STARRED', removeLabelIds: 'UNREAD',
    });
    expect(lastCall()[1]).toBe('users.threads.modify');
    expect(lastCall()[2]).toEqual({ userId: 'me', id: 't1', addLabelIds: ['Label_1', 'STARRED'], removeLabelIds: ['UNREAD'] });
    expect(result.refs).toMatchObject({ threadId: 't1', messageCount: 3 });
  });

  it('getThread returns each message body, not just headers', async () => {
    mockCall.mockResolvedValue({
      id: 't1',
      messages: [{
        id: 'm1',
        payload: {
          mimeType: 'text/plain',
          headers: [{ name: 'From', value: 'alice@example.com' }, { name: 'Subject', value: 'Lunch?' }],
          body: { data: Buffer.from('Are you free at noon?').toString('base64url') },
        },
      }],
    } as never);
    const result = await handler({ operation: 'getThread', email: MAX, threadId: 't1' });
    expect(lastCall()[2]).toMatchObject({ id: 't1', format: 'full' });
    expect(result.text).toContain('Are you free at noon?');

    await handler({ operation: 'getThread', email: MAX, threadId: 't1', format: 'metadata' });
    expect(lastCall()[2]).toMatchObject({ format: 'metadata' });
  });

  it('sendDraft sends the saved draft itself, by its draft id', async () => {
    mockCall.mockResolvedValue({ id: 'sent-9', threadId: 't9' } as never);
    const result = await send({ operation: 'sendDraft', email: MAX, draftId: 'r-123' });
    expect(lastCall()[1]).toBe('users.drafts.send');
    expect(lastCall()[2]).toEqual({ userId: 'me', id: 'r-123' });
    expect(result.text).toContain('sent');
    expect(result.refs).toMatchObject({ draftId: 'r-123', id: 'sent-9' });
  });

  it('sendDraft will not report success without a message id', async () => {
    mockCall.mockResolvedValue({} as never);
    await expect(send({ operation: 'sendDraft', email: MAX, draftId: 'r-123' })).rejects.toThrow('cannot be confirmed');
  });
});
