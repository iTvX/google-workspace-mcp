/**
 * Factory generator — reads the manifest and produces MCP tools.
 *
 * For each service in the manifest, generates:
 * 1. A JSON Schema tool definition (operation enum, typed params)
 * 2. A handler function (maps operations to Google API calls, applies formatting)
 *
 * Patches are optional per-service hooks that override default behavior.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from '../factory/yaml.js';
import { call as googleCall } from '../google/client.js';
import type { GoogleService, ServiceMethods } from '../google/methods.js';
import { requireEmail, clamp } from '../server/handlers/validate.js';
import { formatDefault } from './defaults.js';
import { nextSteps } from '../server/formatting/next-steps.js';
import { evaluatePolicies } from './safety.js';
import { listAccounts } from '../accounts/registry.js';
import type {
  Manifest,
  ServiceDef,
  OperationDef,
  ServicePatch,
  PatchContext,
  GeneratedTool,
  GeneratedToolSchema,
  GeneratedHandler,
} from './types.js';
import type { HandlerResponse } from '../server/formatting/markdown.js';

/**
 * This module's own directory, used to resolve the manifest relative to the
 * built output — which is what makes `npx` and the .mcpb bundle work, where cwd
 * is not the project root.
 *
 * This used to be injected by registry.ts via a `setModuleDir()` setter, purely
 * because the CJS Jest runner could not parse `import.meta`. The test runner was
 * shaping the source. Vitest runs ESM natively (ADR-101), so the module can just
 * ask where it is.
 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Load the manifest from `src/factory/manifest/` — one YAML file per service,
 * each file's root being that service's definition; the filename (minus
 * `.yaml`) is the service key (ADR-304). Assembles a `Manifest` with the same
 * shape the old single-file `manifest.yaml` produced.
 *
 * A malformed file fails the whole load (parseYaml throws) — same whole-or-
 * nothing behavior as before the split.
 *
 * @param dir Optional explicit manifest directory (used by tests/tools);
 *   otherwise resolved relative to the built output, then cwd.
 */
export function loadManifest(dir?: string): Manifest {
  const manifestDir = dir ?? resolveManifestDir();
  const files = readdirSync(manifestDir).filter((f) => f.endsWith('.yaml')).sort();
  if (files.length === 0) {
    throw new Error(`No manifest files (*.yaml) found in ${manifestDir}`);
  }

  const services: Record<string, ServiceDef> = {};
  for (const file of files) {
    const name = basename(file, '.yaml');
    services[name] = parseYaml(readFileSync(resolve(manifestDir, file), 'utf-8')) as ServiceDef;
  }
  return { services };
}

/**
 * Locate the manifest directory: always a sibling of this module.
 *
 * This resolves to `src/factory/manifest` when running the sources (vitest, tsx)
 * and `build/factory/manifest` in the built server — which is what makes `npx`
 * and the .mcpb bundle work, where cwd is not the project root.
 *
 * There is deliberately NO fallback chain. An earlier version tried three more
 * candidates (back to `src/` from `build/`, then two cwd-relative paths), which
 * sounds like resilience and is actually concealment: the only time a fallback
 * fires is when the built manifest is missing, and the `src/` fallback exists
 * *only in the dev checkout*. A build shipped without its manifest therefore
 * resolved fine on this machine and in CI, and threw on the consumer's first
 * `npx` start. Failing here, immediately and everywhere, is the point.
 */
function resolveManifestDir(): string {
  const dir = resolve(MODULE_DIR, 'manifest');
  try {
    readdirSync(dir);
  } catch {
    throw new Error(
      `Could not read the manifest directory at ${dir}. ` +
      `In a built server this directory is copied from src/factory/manifest by ` +
      `the build; if it is missing, the build did not complete. Run \`npm run build\`.`,
    );
  }
  return dir;
}

/** Server-wide choices the generated tools depend on. */
export interface GenerateOptions {
  /**
   * The account a call acts as when it names none (GWS_DEFAULT_ACCOUNT). Not applied to
   * a service marked explicit_account.
   */
  defaultAccount?: string;
}

/** `email: "all"` — run a list operation once per configured account. */
export const ALL_ACCOUNTS = 'all';

/** Generate all tools from the manifest with optional patches. */
export function generateTools(
  manifest: Manifest,
  patches?: Record<string, ServicePatch>,
  options: GenerateOptions = {},
): GeneratedTool[] {
  const tools: GeneratedTool[] = [];

  for (const [fileKey, serviceDef] of Object.entries(manifest.services)) {
    // A split-off tool (gmail-send) is its parent service in everything but its name:
    // the parent's patch handles its operations, the parent's scopes authorize them.
    const serviceName = serviceDef.parent_service ?? fileKey;
    const patch = patches?.[serviceName];
    const schema = generateSchema(serviceDef, options);
    const handler = generateHandler(serviceDef, patch, serviceName, options);
    tools.push({ schema, handler });
  }

  return tools;
}

/** The `_meta` key Claude Code reads to prompt on every call, in every permission mode. */
export const REQUIRES_USER_INTERACTION = 'anthropic/requiresUserInteraction';

/** Generate the JSON Schema tool definition from a service declaration. */
export function generateSchema(service: ServiceDef, options: GenerateOptions = {}): GeneratedToolSchema {
  const operationNames = Object.keys(service.operations);
  const operationDescriptions = operationNames
    .map(name => `${name}: ${service.operations[name].description}`)
    .join(' | ');

  // Collect all unique params across operations
  const allParams: Record<string, { type: string; description: string; enum?: string[] }> = {};
  for (const op of Object.values(service.operations)) {
    if (!op.params) continue;
    for (const [paramName, paramDef] of Object.entries(op.params)) {
      if (!allParams[paramName]) {
        allParams[paramName] = {
          type: paramDef.type,
          description: paramDef.description,
          ...(paramDef.enum ? { enum: paramDef.enum } : {}),
        };
      }
    }
  }

  const properties: Record<string, unknown> = {
    operation: {
      type: 'string',
      enum: operationNames,
      description: operationDescriptions,
    },
  };

  const defaultAccount = service.explicit_account ? undefined : options.defaultAccount;
  if (service.requires_email) {
    properties.email = {
      type: 'string',
      description: service.explicit_account
        ? 'Account email address this acts as. Required: there is no default account here.'
        : [
          'Account email address.',
          defaultAccount ? `Defaults to ${defaultAccount} when omitted.` : '',
          `On list operations, "${ALL_ACCOUNTS}" runs it once for every configured account.`,
        ].filter(Boolean).join(' '),
    };
  }

  for (const [name, def] of Object.entries(allParams)) {
    properties[name] = { type: def.type, description: def.description, ...(def.enum ? { enum: def.enum } : {}) };
  }

  const required = service.requires_email && !defaultAccount ? ['operation', 'email'] : ['operation'];

  return {
    name: service.tool_name,
    description: service.description,
    inputSchema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
    // Must be the JSON Boolean true — Claude Code ignores any other value.
    ...(service.requires_user_interaction === true
      ? { _meta: { [REQUIRES_USER_INTERACTION]: true } }
      : {}),
  };
}

/** Generate a handler function for a service. */
export function generateHandler(
  service: ServiceDef,
  patch?: ServicePatch,
  /**
   * The manifest key for this service — `contacts`, not `people`. Scope maps are keyed by
   * it, so the access policy cannot resolve a service without it. Optional because tests
   * construct ServiceDefs directly; when absent the policy has nothing to look up and
   * allows, which is the same fail-open stance it takes everywhere else.
   */
  serviceName?: string,
  options: GenerateOptions = {},
): GeneratedHandler {
  const defaultAccount = service.explicit_account ? undefined : options.defaultAccount;
  // Map tool_name to the next-steps domain key
  const domainMap: Record<string, string> = {
    manage_email: 'email',
    send_email: 'email',
    manage_calendar: 'calendar',
    manage_drive: 'drive',
  };
  const domain = domainMap[service.tool_name] ?? service.google_service;

  const run = async (params: Record<string, unknown>, framed: boolean): Promise<HandlerResponse> => {
    const operation = params.operation as string;
    const opDef = service.operations[operation];
    if (!opDef) {
      throw new Error(`Unknown ${service.google_service} operation: ${operation}`);
    }

    if (service.requires_email) {
      const named = typeof params.email === 'string' ? params.email.trim() : '';
      if (named.toLowerCase() === ALL_ACCOUNTS) {
        return runForEveryAccount(params, opDef, framed);
      }
      // Fill the default in on the params themselves: custom handlers and the session
      // context read `params.email`, not just the resolved account.
      if (!named && defaultAccount) params = { ...params, email: defaultAccount };
    }

    const account = service.requires_email ? requireEmail(params) : '';
    const ctx: PatchContext = { operation, params, account };

    // Safety policies — run before anything else, including custom handlers.
    // A blocked operation never reaches the handler or Google.
    const policyResult = await evaluatePolicies([], ctx, service.google_service, serviceName ? {
      service: serviceName,
      googleService: service.google_service,
      resource: opDef.resource,
      type: opDef.type,
    } : undefined);
    if (policyResult.action === 'block') {
      return {
        text: `**Blocked by safety policy:** ${policyResult.reason}`,
        refs: { blocked: true, policy: policyResult.reason },
      };
    }

    // Context map for next-steps placeholder resolution — built once,
    // used whether the request goes through a custom handler or the
    // factory path.
    const contextMap: Record<string, string> = { email: account };
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string') contextMap[key] = value;
    }

    const framingFooter = (): string => !framed ? '' : (
      patch?.nextSteps
        ? patch.nextSteps(operation, contextMap)
        : nextSteps(domain, operation, contextMap));

    // Check for a fully custom handler first. The generator still owns
    // framing (next-steps append) — handlers produce the response text;
    // the factory frames it. See ADR-303.
    if (patch?.customHandlers?.[operation]) {
      const response = await patch.customHandlers[operation](params, account);
      return {
        ...response,
        text: response.text + framingFooter(),
      };
    }

    // THE SEAM (ADR-103). Every operation goes to the Google API client we own, driven
    // by the generated descriptor. There is no second path, and nothing shells out. An
    // operation names a Google method, or a custom handler composes several, or it does
    // not exist.
    let data: unknown;

    if (opDef.resource) {
      let callParams = buildResourceParams(opDef, params);

      // beforeExecute takes PARAMS. Hooks mutate the param object directly; there is
      // no command line to do surgery on.
      if (patch?.beforeExecute?.[operation]) {
        callParams = await patch.beforeExecute[operation](callParams, ctx);
      }

      // The one place a cast is honest. Here the service and the resource path come
      // from the MANIFEST — YAML, read at runtime — so no compile-time type can
      // check them. That is fine, because this path has its own guard at a
      // different stage:
      //
      //   hand-written call sites  -> COMPILE time  (ServiceMethods[S]; see src/google/methods.ts)
      //   manifest-driven ops      -> BUILD time    (check-conformance: manifest ⊆ descriptor)
      //
      // Between them, every route to Google is checked before it can reach a user.
      // The conformance check is probed and goes red on a bogus resource path, so
      // a typo in the YAML fails the build rather than the call.
      data = await googleCall(
        service.google_service as GoogleService,
        opDef.resource as ServiceMethods[GoogleService],
        callParams,
        { account },
      );
    } else {
      // No resource, and no custom handler took it. There is nothing left to call.
      // An operation is a Google method or a composition of them — there is no third
      // kind. See ADR-103.
      throw new Error(
        `${service.google_service}.${operation} declares no 'resource' and has no custom handler.`,
      );
    }

    // afterExecute hook — takes DATA. This is the hook that turns raw Google into OUR
    // shape (see gmailPatch.afterExecute.search, which walks payload.headers). It is
    // the right place for interpretation.
    if (patch?.afterExecute?.[operation]) {
      data = await patch.afterExecute[operation](data, ctx);
    }

    let formatted: HandlerResponse;

    // Check for patch formatters by operation type
    if (opDef.type === 'list' && patch?.formatList) {
      formatted = patch.formatList(data, ctx);
    } else if (opDef.type === 'detail' && patch?.formatDetail) {
      formatted = patch.formatDetail(data, ctx);
    } else if (opDef.type === 'action' && patch?.formatAction) {
      formatted = patch.formatAction(data, ctx);
    } else {
      formatted = formatDefault(data, opDef);
    }

    return {
      ...formatted,
      text: formatted.text + framingFooter(),
    };
  };

  /**
   * `email: "all"` — the same list operation once per configured account, each result
   * under its account's heading.
   *
   * List operations only. They read; anything that changes mail must name the one
   * account it changes, and a message id from one mailbox means nothing in another. Each
   * account runs through `run` in full, safety policies included, so a read-only or
   * unauthorized account is refused for itself without failing the others.
   */
  const runForEveryAccount = async (
    params: Record<string, unknown>,
    opDef: OperationDef,
    framed: boolean,
  ): Promise<HandlerResponse> => {
    const operation = params.operation as string;
    if (service.explicit_account) {
      throw new Error(`${service.tool_name} acts as one account at a time: name it in \`email\`.`);
    }
    if (opDef.type !== 'list') {
      throw new Error(
        `email "${ALL_ACCOUNTS}" works on list operations only. '${operation}' acts on a specific ` +
        `item, so name the account it belongs to in \`email\`.`,
      );
    }

    // listAccounts enriches each entry with hasCredential; its declared type predates that.
    const listed = await listAccounts() as Array<{ email: string; hasCredential?: boolean }>;
    const accounts = listed.filter((a) => a.hasCredential).map((a) => a.email);
    if (accounts.length === 0) {
      throw new Error('No authorized accounts. Add one with manage_accounts {operation: "authenticate"}.');
    }

    const results = await Promise.all(accounts.map(async (email) => {
      try {
        return { email, response: await run({ ...params, email }, false) };
      } catch (err) {
        return { email, error: err instanceof Error ? err.message : String(err) };
      }
    }));

    const sections = results.map((r) => `### ${r.email}\n\n${'response' in r && r.response ? r.response.text.trim() : `**Error:** ${r.error}`}`);
    const note = '_Message, thread and draft ids belong to the account they are listed under: ' +
      'pass that account as `email` to act on one._';
    const footer = framed ? nextSteps(domain, operation, { email: accounts[0] }) : '';

    return {
      text: `## ${operation} — ${accounts.length} accounts\n\n${sections.join('\n\n')}\n\n${note}${footer}`,
      refs: {
        accounts: Object.fromEntries(results.map((r) => [
          r.email,
          'response' in r && r.response ? r.response.refs : { error: r.error },
        ])),
      },
    };
  };

  return (params) => run(params, true);
}

/**
 * Build the params a resource operation sends to Google.
 *
 * This is the manifest's mapping — declared params, `maps_to` renames, defaults,
 * clamps. A resource operation never becomes a command line: the output here is
 * the request params, handed straight to the client. See ADR-103.
 */
export function buildResourceParams(
  opDef: OperationDef,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...opDef.defaults };

  if (opDef.params) {
    for (const [paramName, paramDef] of Object.entries(opDef.params)) {
      if (paramDef.client_only) continue; // formatter-only; never reaches Google
      const value = params[paramName];
      const targetKey = paramDef.maps_to ?? paramName;

      if (value !== undefined && value !== null) {
        out[targetKey] = paramDef.max
          ? clamp(value, paramDef.default as number ?? 10, paramDef.max)
          : value;
      } else if (paramDef.default !== undefined) {
        out[targetKey] = paramDef.default;
      }
    }
  }

  for (const [key, val] of Object.entries(out)) {
    if (val === undefined) delete out[key];
  }
  return out;
}

