/**
 * The approval gate, for when it is turned back on.
 *
 * send_email ships without one (see gmail-send.yaml), but the mechanism stays: a manifest
 * marked `requires_user_interaction` makes Claude Code prompt on every call, and the
 * server keeps such a tool out of bulk_operations, where only the outer call would be
 * prompted. This file stands in for that one-line manifest change by marking send_email
 * as gated, and checks the server half: a queue refuses it, nested queues included.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';

const readCredential = vi.hoisted(() => vi.fn());
vi.mock('../../accounts/credentials.js', () => ({ readCredential }));
vi.mock('../../google/client.js');
vi.mock('../../server/tools.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/tools.js')>()),
  requiresUserInteraction: (name: string) => name === 'send_email',
}));

const { handleToolCall } = await import('../../server/handler.js');
const { configurePolicies } = await import('../../factory/safety.js');
const { call, upload } = await import('../../google/client.js');

const mockCall = call as MockedFunction<typeof call>;
const mockUpload = upload as MockedFunction<typeof upload>;

const ACCOUNT = 'someone@example.com';
const SEND = { operation: 'send', email: ACCOUNT, to: 'bob@example.com', subject: 'hello', body: 'hi bob' };

beforeEach(() => {
  mockCall.mockResolvedValue({} as never);
  mockUpload.mockResolvedValue({ id: 'sent-1', threadId: 'thread-1' } as never);
  configurePolicies([]);
});

afterEach(() => {
  mockCall.mockReset();
  mockUpload.mockReset();
});

describe('a gated send_email', () => {
  it('still runs when called directly — the client is the one that prompts', async () => {
    await handleToolCall('send_email', SEND);
    expect(mockUpload).toHaveBeenCalled();
  });

  it('will not run from a queue', async () => {
    const result = await handleToolCall('bulk_operations', {
      operations: [{ tool: 'send_email', args: SEND }],
    });

    expect(result.text).toContain('cannot run inside bulk_operations');
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('will not run from a queue nested inside a queue either', async () => {
    const result = await handleToolCall('bulk_operations', {
      operations: [{
        tool: 'bulk_operations',
        args: { operations: [{ tool: 'send_email', args: SEND }] },
      }],
      detail: 'full',
    });

    expect(result.text).toContain('cannot run inside bulk_operations');
    expect(mockUpload).not.toHaveBeenCalled();
  });
});
