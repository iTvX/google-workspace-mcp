/**
 * Drafts you can make and change without sending: createDraft, getDraft, updateDraft.
 *
 * The parity gap with the claude.ai Gmail connector was that a draft could only be made
 * by asking send_email not to send, and never edited. These live in manage_email because
 * none of them makes mail leave the account; the assertions are on the upload that would
 * create or replace the draft — never users.messages.send.
 */
import { beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';

vi.mock('../../../google/client.js');
import { call, upload } from '../../../google/client.js';
import { generateHandler, loadManifest } from '../../../factory/generator.js';
import { patches } from '../../../factory/patches.js';

const mockCall = call as MockedFunction<typeof call>;
const mockUpload = upload as MockedFunction<typeof upload>;

const ACCOUNT = 'max@example.com';
const handler = generateHandler(loadManifest().services.gmail, patches.gmail, 'gmail');

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64url');
const uploadedMime = (i = 0) => (mockUpload.mock.calls[i][3].media as Buffer).toString('utf-8');
const uploadedResource = (i = 0) => mockUpload.mock.calls[i][1];
const uploadedMetadata = (i = 0) => mockUpload.mock.calls[i][3].metadata;

beforeEach(() => {
  mockCall.mockReset();
  mockUpload.mockReset();
  mockUpload.mockResolvedValue({ id: 'r-123', message: { id: 'm-9', threadId: 't-1' } } as never);
});

describe('createDraft', () => {
  it('saves a new message as a draft and sends nothing', async () => {
    const result = await handler({
      operation: 'createDraft', email: ACCOUNT, to: 'bob@example.com', subject: 'Plan', body: 'Draft text',
    });

    expect(uploadedResource()).toBe('users.drafts.create');
    expect(uploadedMime()).toContain('To: bob@example.com');
    expect(uploadedMime()).toContain('Subject: Plan');
    expect(result.text).toContain('Not sent');
    expect(result.refs).toMatchObject({ draftId: 'r-123', isDraft: true });
  });

  it('makes a reply draft in the original thread when given replyToMessageId', async () => {
    mockCall.mockResolvedValueOnce({
      id: 'orig-1', threadId: 'thread-7',
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: 'Alice <alice@example.com>' },
          { name: 'To', value: ACCOUNT },
          { name: 'Subject', value: 'Lunch?' },
          { name: 'Message-ID', value: '<orig@mail>' },
          { name: 'Date', value: 'Mon, 19 Oct 2026 10:00:00 -0700' },
        ],
        body: { data: b64('Are you free?') },
      },
    } as never);

    const result = await handler({
      operation: 'createDraft', email: ACCOUNT, replyToMessageId: 'orig-1', body: 'Yes, noon works',
    });

    expect(uploadedResource()).toBe('users.drafts.create');
    expect(uploadedMetadata()).toEqual({ message: { threadId: 'thread-7' } });
    expect(uploadedMime()).toContain('Subject: Re: Lunch?');
    expect(uploadedMime()).toContain('In-Reply-To: <orig@mail>');
    expect(uploadedMime()).toContain('alice@example.com');
    expect(result.text).toContain('Reply draft saved');
  });

  it('needs to and subject for a new message', async () => {
    await expect(handler({ operation: 'createDraft', email: ACCOUNT, body: 'x' })).rejects.toThrow('to is required');
    expect(mockUpload).not.toHaveBeenCalled();
  });
});

describe('getDraft', () => {
  it('reads the draft by its draft id and shows the message', async () => {
    mockCall.mockResolvedValueOnce({
      id: 'r-123',
      message: {
        id: 'm-9', threadId: 't-1',
        payload: {
          mimeType: 'text/plain',
          headers: [{ name: 'To', value: 'bob@example.com' }, { name: 'Subject', value: 'Plan' }],
          body: { data: b64('Draft text') },
        },
      },
    } as never);

    const result = await handler({ operation: 'getDraft', email: ACCOUNT, draftId: 'r-123' });

    expect(mockCall).toHaveBeenCalledWith(
      'gmail', 'users.drafts.get', expect.objectContaining({ id: 'r-123', format: 'full' }),
      expect.objectContaining({ account: ACCOUNT }),
    );
    expect(result.text).toContain('**Draft ID:** r-123');
    expect(result.text).toContain('Plan');
    expect(result.refs).toMatchObject({ draftId: 'r-123' });
  });
});

describe('updateDraft', () => {
  /** A reply draft with one attachment, as drafts.get returns it. */
  const existingDraft = () => ({
    id: 'r-123',
    message: {
      id: 'm-9', threadId: 'thread-7',
      payload: {
        mimeType: 'multipart/mixed',
        headers: [
          { name: 'To', value: 'alice@example.com' },
          { name: 'Cc', value: 'carol@example.com' },
          { name: 'Subject', value: 'Re: Lunch?' },
          { name: 'In-Reply-To', value: '<orig@mail>' },
          { name: 'References', value: '<orig@mail>' },
        ],
        parts: [
          { mimeType: 'text/plain', body: { data: b64('Old text') } },
          { mimeType: 'application/pdf', filename: 'menu.pdf', body: { attachmentId: 'att-1', size: 4 } },
        ],
      },
    },
  });

  it('changes only what is given and keeps the rest, the thread and the attachment', async () => {
    mockCall.mockImplementation(async (_svc, method) => {
      if (method === 'users.drafts.get') return existingDraft() as never;
      if (method === 'users.messages.attachments.get') return { data: b64('%PDF') } as never;
      throw new Error(`unexpected ${method}`);
    });

    const result = await handler({ operation: 'updateDraft', email: ACCOUNT, draftId: 'r-123', body: 'New text' });

    expect(uploadedResource()).toBe('users.drafts.update');
    expect(mockUpload.mock.calls[0][2]).toEqual({ userId: 'me', id: 'r-123' });
    expect(uploadedMetadata()).toEqual({ id: 'r-123', message: { threadId: 'thread-7' } });
    const mime = uploadedMime();
    expect(mime).toContain('To: alice@example.com');
    expect(mime).toContain('Cc: carol@example.com');
    expect(mime).toContain('Subject: Re: Lunch?');
    expect(mime).toContain('In-Reply-To: <orig@mail>');
    expect(mime).toContain('menu.pdf');
    expect(mime).toContain(Buffer.from('New text').toString('base64'));
    expect(mime).not.toContain(Buffer.from('Old text').toString('base64'));
    expect(result.text).toContain('Not sent');
  });

  it('refuses a draft that still has no recipient when none is given', async () => {
    mockCall.mockResolvedValueOnce({ id: 'r-5', message: { id: 'm-5', payload: { headers: [], body: {} } } } as never);
    await expect(handler({ operation: 'updateDraft', email: ACCOUNT, draftId: 'r-5', body: 'x' }))
      .rejects.toThrow('has no recipient');
    expect(mockUpload).not.toHaveBeenCalled();
  });
});
