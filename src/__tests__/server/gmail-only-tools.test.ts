/**
 * A server started with GWS_SERVICES=gmail offers the Gmail tools and what they need,
 * and nothing else: no other services, no queue_operations alias, no scratchpad.
 *
 * The registry reads GWS_SERVICES when it is first imported, so the variable is set
 * before anything is imported here. A hidden tool must be unreachable, not just
 * unlisted — by name and from inside bulk_operations alike.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';

const before = process.env.GWS_SERVICES;
process.env.GWS_SERVICES = 'gmail';
afterAll(() => {
  if (before === undefined) delete process.env.GWS_SERVICES;
  else process.env.GWS_SERVICES = before;
});

vi.mock('../../google/client.js');

const { toolSchemas, getToolSchema } = await import('../../server/tools.js');
const { handleToolCall, BULK_TOOL_NAMES } = await import('../../server/handler.js');

describe('GWS_SERVICES=gmail', () => {
  it('offers exactly the Gmail tools and what they need', () => {
    expect(toolSchemas.map((t) => t.name).sort()).toEqual([
      'bulk_operations', 'manage_accounts', 'manage_email', 'manage_workspace', 'send_email',
    ]);
  });

  it('leaves queue_operations out of the bulk tool names and the bulk enum', () => {
    expect(BULK_TOOL_NAMES).toEqual(['bulk_operations']);
    const enumNames = (getToolSchema('bulk_operations')!.inputSchema as any)
      .properties.operations.items.properties.tool.enum as string[];
    expect(enumNames).not.toContain('manage_scratchpad');
    expect(enumNames).not.toContain('queue_operations');
    expect(enumNames).not.toContain('manage_calendar');
  });

  it.each(['manage_scratchpad', 'queue_operations', 'manage_calendar', 'manage_drive'])(
    'cannot reach %s by name',
    async (name) => {
      await expect(handleToolCall(name, { operation: 'list' })).rejects.toThrow(`Unknown tool: ${name}`);
    },
  );

  it('cannot reach a hidden tool from inside bulk_operations either', async () => {
    const result = await handleToolCall('bulk_operations', {
      operations: [{ tool: 'manage_scratchpad', args: { operation: 'list' } }],
    });
    expect(result.text).toContain('Unknown tool: manage_scratchpad');
  });
});
