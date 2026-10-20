/**
 * Shared factory registry — single instance of manifest + generated tools.
 * Both handler.ts and tools.ts import from here instead of loading independently.
 *
 * generator.ts resolves the manifest relative to its own module directory, so
 * this works under npx and .mcpb where cwd is NOT the project root.
 */

import { loadManifest, generateTools } from './generator.js';
import { patches } from './patches.js';
import { filterManifest, parseServices } from './services.js';
import type { GeneratedTool } from './types.js';
import type { Manifest } from './types.js';

/** The manifest this server serves — narrowed by GWS_SERVICES when set (see services.ts). */
export const manifest: Manifest = filterManifest(loadManifest(), parseServices(process.env.GWS_SERVICES));
export const generatedTools: GeneratedTool[] = generateTools(manifest, patches, {
  defaultAccount: process.env.GWS_DEFAULT_ACCOUNT,
});
