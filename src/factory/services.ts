/**
 * Which manifest services this server loads — GWS_SERVICES, a comma-separated list of
 * service names (gmail, calendar, drive, ...). Unset means all of them, as before.
 *
 * A deployment whose accounts authorized only Gmail has no use for manage_drive and the
 * rest: every call would be refused for want of a scope, and the tools crowd what the
 * client has to choose from. Filtering the manifest keeps them out of tools/list, the
 * dispatcher and batch alike, because all three are built from the registry's manifest.
 *
 * The same list is what `manage_accounts authenticate` asks Google for, so a Gmail-only
 * server never requests Drive or Calendar access it would not use.
 */

import { ALL_SERVICES } from '../accounts/oauth.js';
import type { Manifest, ServiceDef } from './types.js';

/** The service a manifest file belongs to: its own key, or its parent (gmail-send -> gmail). */
export function serviceOf(fileKey: string, def: Pick<ServiceDef, 'parent_service'>): string {
  return def.parent_service ?? fileKey;
}

/** `"gmail, calendar"` -> `['gmail', 'calendar']`; unset or blank -> undefined (all services). */
export function parseServices(value: string | undefined): string[] | undefined {
  const names = (value ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return names.length ? [...new Set(names)] : undefined;
}

/**
 * Keep only the manifest files whose service is wanted. A split-off tool goes with its
 * parent: asking for `gmail` keeps both manage_email and send_email.
 *
 * An unknown name fails the start, the same stance GWS_SAFETY_POLICY takes: a typo that
 * silently loaded nothing would look like a broken server rather than a bad setting.
 */
export function filterManifest(manifest: Manifest, wanted: string[] | undefined): Manifest {
  if (!wanted) return manifest;
  const known = new Set(Object.entries(manifest.services).map(([key, def]) => serviceOf(key, def)));
  const unknown = wanted.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown service(s) in GWS_SERVICES: ${unknown.join(', ')}. ` +
      `Known: ${[...known].sort().join(', ')}`,
    );
  }
  return {
    services: Object.fromEntries(
      Object.entries(manifest.services).filter(([key, def]) => wanted.includes(serviceOf(key, def))),
    ),
  };
}

/**
 * The services to request at consent time: GWS_SERVICES when set, else every service
 * with a scope mapping (the upstream default).
 */
export function servicesToAuthorize(env: string | undefined = process.env.GWS_SERVICES): string {
  return parseServices(env)?.join(',') ?? ALL_SERVICES;
}
