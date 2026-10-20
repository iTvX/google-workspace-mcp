import { handleAccounts } from './handlers/accounts.js';
import { handleWorkspace } from './handlers/workspace.js';
import { handleScratchpad } from './scratchpad/handler.js';
import { handleQueue } from './queue.js';
import { handleBatch } from './batch.js';
import { generatedTools } from '../factory/registry.js';
import { requiresUserInteraction, getToolSchema } from './tools.js';
import { getSessionTracker, sessionContext } from './session/index.js';
import { runAsToolCall } from './call-context.js';

export type { HandlerResponse } from './formatting/markdown.js';
import type { HandlerResponse } from './formatting/markdown.js';

type ToolHandler = (params: Record<string, unknown>) => Promise<HandlerResponse>;

// ── Epoch counter ─────────────────────────────────────────
// Server-wide monotonic counter incremented on every tool call.
// Used by ScratchpadManager for activity-based garbage collection.

let epoch = 0;

/** Current epoch value. */
export function getEpoch(): number {
  return epoch;
}

/** Increment and return the new epoch. Called once per tool dispatch. */
export function advanceEpoch(): number {
  return ++epoch;
}

// ── Handler dispatch ──────────────────────────────────────

const domainHandlers: Record<string, ToolHandler> = {
  manage_accounts: handleAccounts,
  manage_workspace: handleWorkspace,
  manage_scratchpad: handleScratchpad,
};

// Register factory-generated handlers
for (const tool of generatedTools) {
  domainHandlers[tool.schema.name] = tool.handler;
}

// A tool the server does not advertise (hidden by GWS_SERVICES, see tools.ts) is not
// reachable either — not by name, and not from inside bulk_operations.
for (const name of Object.keys(domainHandlers)) {
  if (!getToolSchema(name)) delete domainHandlers[name];
}

/**
 * The names that reach the bulk handler. `queue_operations` is the former name, kept
 * working for one minor release — ADR-308. Both are advertised and both dispatch here.
 */
export const BULK_TOOL_NAMES = ['bulk_operations', 'queue_operations'].filter((name) => getToolSchema(name));

/**
 * What a queued operation may call: every tool, including `bulk_operations` itself.
 *
 * A bulk call is a tool call like any other, so the set of things it can name is the set
 * of tools — no carve-out, and nothing for a caller to discover by being refused. Nesting
 * is bounded by depth inside handleQueue rather than by omission here, so the limit
 * arrives as a sentence saying what it is instead of an "Unknown tool" for something the
 * server plainly advertises.
 *
 * The old name is queueable too. An agent that learned it before the rename should not
 * find it working at the top level and failing one level down.
 */
function queueableHandlers(depth: number): Record<string, ToolHandler> {
  const nested: ToolHandler = (params) => handleQueue(params, queueableHandlers(depth + 1), depth + 1);
  return {
    ...domainHandlers,
    ...Object.fromEntries(BULK_TOOL_NAMES.map((name) => [name, nested])),
    // The one exception. The client asks a person to approve each call to these tools,
    // and the client only sees the outer bulk call — so from inside a queue they would
    // run approved by nobody. Refused with a sentence rather than left out, so an agent
    // that names one learns what to do instead of meeting "Unknown tool".
    ...Object.fromEntries(Object.keys(domainHandlers)
      .filter(requiresUserInteraction)
      .map((name) => [name, refuseInQueue(name)])),
  };
}

function refuseInQueue(name: string): ToolHandler {
  return async () => {
    throw new Error(
      `${name} cannot run inside bulk_operations: the user approves each ${name} call, and ` +
      `inside a queue only the bulk call would be shown to them. Call ${name} directly, ` +
      `once per message.`,
    );
  };
}

/**
 * Dispatch one tool call from the client. Everything it runs, a queue's operations
 * included, shares one call id (see call-context.ts).
 */
export function handleToolCall(
  toolName: string,
  params: Record<string, unknown>,
): Promise<HandlerResponse> {
  return runAsToolCall(() => dispatchToolCall(toolName, params));
}

async function dispatchToolCall(
  toolName: string,
  params: Record<string, unknown>,
): Promise<HandlerResponse> {
  const currentEpoch = advanceEpoch();
  const tracker = getSessionTracker();

  // Bulk wraps the domain handlers (each queued op also advances the epoch)
  if (BULK_TOOL_NAMES.includes(toolName)) {
    if (params.mode === 'batch') return await handleBatch(params);
    const result = await handleQueue(params, queueableHandlers(1), 1);
    const queueEmail = extractEmailFromQueue(params);
    if (queueEmail) {
      await tracker.ensureBaseline(queueEmail, currentEpoch);
      tracker.refresh(queueEmail, currentEpoch);
      const ctx = await sessionContext(toolName, queueEmail, tracker);
      if (ctx) result.text += ctx;
    }
    return result;
  }

  const handler = domainHandlers[toolName];
  if (!handler) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  // `email: "all"` is not an account; each account's run is tracked by nothing here.
  const email = typeof params.email === 'string' && params.email.trim().toLowerCase() !== 'all'
    ? params.email
    : undefined;

  if (email) {
    await tracker.ensureBaseline(email, currentEpoch);
  }

  const result = await handler(params);

  if (email) {
    tracker.refresh(email, currentEpoch);
    const ctx = await sessionContext(toolName, email, tracker);
    if (ctx) result.text += ctx;
  }

  return result;
}

/** Extract email from the first queue operation that has one. */
function extractEmailFromQueue(params: Record<string, unknown>): string | undefined {
  const operations = params.operations as Array<{ args?: Record<string, unknown> }> | undefined;
  if (!Array.isArray(operations)) return undefined;
  for (const op of operations) {
    if (typeof op.args?.email === 'string') return op.args.email;
  }
  return undefined;
}
