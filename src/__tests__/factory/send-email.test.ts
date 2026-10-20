/**
 * send_email — the one way mail leaves the account.
 *
 * Sending moved out of manage_email into its own tool, so outbound mail can be gated,
 * audited or switched off in one place. It sends without a per-call prompt, like the
 * claude.ai Gmail connector (send-approval-gate.test.ts covers turning one on). These
 * tests drive the real dispatcher — not a policy in isolation — and assert on the upload
 * that would deliver the message:
 *
 *   - send_email works, and is still the gmail service to the safety layer;
 *   - the old manage_email operations are gone rather than quietly still routed;
 *   - bulk_operations can queue send_email but not batch it;
 *   - a filter can never forward, since that sends every future match unasked.
 *
 * The session tracker reads a few counts through `call` on the first call per account,
 * so "nothing was sent" is asserted on `upload` (every send) and on the filter methods,
 * never on `call` as a whole.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';

const readCredential = vi.hoisted(() => vi.fn());
vi.mock('../../accounts/credentials.js', () => ({ readCredential }));
vi.mock('../../google/client.js');

const { handleToolCall } = await import('../../server/handler.js');
const { configurePolicies, evaluatePolicies, accountAccess, draftOnlyEmail, noAutoForward } =
  await import('../../factory/safety.js');
const { SERVICE_SCOPE_MAP, SERVICE_SCOPE_MAP_READONLY } = await import('../../accounts/oauth.js');
const { call, upload } = await import('../../google/client.js');

const mockCall = call as MockedFunction<typeof call>;
const mockUpload = upload as MockedFunction<typeof upload>;

const ACCOUNT = 'someone@example.com';
const SEND = { operation: 'send', email: ACCOUNT, to: 'bob@example.com', subject: 'hello', body: 'hi bob' };

function grant(services: string[], level: 'read' | 'readwrite'): void {
  const map = level === 'read' ? SERVICE_SCOPE_MAP_READONLY : SERVICE_SCOPE_MAP;
  readCredential.mockResolvedValue({ scopes: services.flatMap((s) => map[s] ?? []) });
}

/** Every Google method `call` was asked for, e.g. 'users.settings.filters.create'. */
const calledMethods = (): string[] => mockCall.mock.calls.map((c) => String(c[1]));

beforeEach(() => {
  mockCall.mockResolvedValue({} as never);
  mockUpload.mockResolvedValue({ id: 'sent-1', threadId: 'thread-1' } as never);
  configurePolicies([accountAccess, noAutoForward]);
  grant(['gmail'], 'readwrite');
});

afterEach(() => {
  configurePolicies([]);
  readCredential.mockReset();
  mockCall.mockReset();
  mockUpload.mockReset();
});

describe('send_email', () => {
  it('sends from the account named in `email`', async () => {
    const result = await handleToolCall('send_email', SEND);

    expect(mockUpload).toHaveBeenCalledWith(
      'gmail', 'users.messages.send', { userId: 'me' },
      expect.objectContaining({ account: ACCOUNT, contentType: 'message/rfc822' }),
    );
    expect(result.text).toContain('Email sent to bob@example.com');
  });

  it('is refused for an account authorized read-only — it is still gmail to the safety layer', async () => {
    // gmail-send.yaml is a file of its own. Were its operations checked under that file's
    // name, the scope map would know nothing about them and the check would fail open.
    grant(['gmail'], 'read');

    const result = await handleToolCall('send_email', SEND);

    expect(result.text).toContain('Blocked by safety policy');
    expect(result.text).toContain(`services:'gmail'`);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('is still refused by draft-only-email', async () => {
    configurePolicies([accountAccess, noAutoForward, draftOnlyEmail]);

    for (const operation of ['send', 'reply', 'replyAll', 'forward']) {
      const result = await handleToolCall('send_email', { ...SEND, operation, messageId: 'm1' });
      expect(result.text, operation).toContain('Blocked by safety policy');
    }
    expect(mockUpload).not.toHaveBeenCalled();
  });
});

describe('manage_email', () => {
  it.each(['send', 'reply', 'replyAll', 'forward'])('no longer has %s', async (operation) => {
    await expect(handleToolCall('manage_email', { ...SEND, operation, messageId: 'm1' }))
      .rejects.toThrow(`Unknown gmail operation: ${operation}`);
    expect(mockUpload).not.toHaveBeenCalled();
  });
});

describe('bulk_operations', () => {
  it('can queue send_email, since nothing gates it per call', async () => {
    const result = await handleToolCall('bulk_operations', {
      operations: [{ tool: 'send_email', args: SEND }],
    });

    expect(result.text).not.toContain('cannot run inside bulk_operations');
    expect(mockUpload).toHaveBeenCalledWith(
      'gmail', 'users.messages.send', { userId: 'me' }, expect.objectContaining({ account: ACCOUNT }),
    );
  });

  it('will not batch it — there is no batch send', async () => {
    const result = await handleToolCall('bulk_operations', {
      mode: 'batch', tool: 'send_email', operation: 'send', email: ACCOUNT,
      items: [{ to: 'a@example.com' }, { to: 'b@example.com' }],
    });

    expect(result.text).toContain('cannot be batched');
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('still runs everything else', async () => {
    mockCall.mockResolvedValue({ labels: [] } as never);
    const result = await handleToolCall('bulk_operations', {
      operations: [{ tool: 'manage_email', args: { operation: 'labels', email: ACCOUNT } }],
    });

    expect(result.text).not.toContain('cannot run inside bulk_operations');
    expect(calledMethods()).toContain('users.labels.list');
  });
});

describe('filters that forward', () => {
  const FILTER = { email: ACCOUNT, matchFrom: 'billing@example.com', forwardTo: 'me@elsewhere.example' };

  it.each(['previewFilter', 'createFilter', 'updateFilter'])('are refused at %s', async (operation) => {
    const result = await handleToolCall('manage_email', {
      ...FILTER, operation, filterId: 'f1', previewToken: 'tok',
    });

    expect(result.text).toContain('Blocked by safety policy');
    expect(result.text).toContain('me@elsewhere.example');
    expect(calledMethods().filter((m) => m.startsWith('users.settings.'))).toEqual([]);
  });

  it('are refused with no GWS_SAFETY_POLICY set — the policy is not an opt-in', async () => {
    // What createServer configures when the variable is unset. If this list loses
    // no-auto-forward, a default install can forward again.
    const { createServer } = await import('../../server/server.js');
    const before = process.env.GWS_SAFETY_POLICY;
    delete process.env.GWS_SAFETY_POLICY;
    configurePolicies([]); // start from nothing, so only createServer can turn it on
    try {
      createServer();
    } finally {
      if (before !== undefined) process.env.GWS_SAFETY_POLICY = before;
    }

    const result = await evaluatePolicies([], { operation: 'createFilter', params: FILTER, account: ACCOUNT }, 'gmail');
    expect(result.action).toBe('block');
  });

  it('leave filters that only label or archive alone', async () => {
    const result = await evaluatePolicies(
      [], { operation: 'createFilter', params: { matchFrom: 'x@example.com', removeLabelIds: 'INBOX' }, account: ACCOUNT }, 'gmail',
    );
    expect(result.action).toBe('allow');
  });

  it('are not offered in the schema at all', async () => {
    const { getToolSchema } = await import('../../server/tools.js');
    const props = (getToolSchema('manage_email')!.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props.forwardTo).toBeUndefined();
  });
});
