import type { ApplicationService } from '@adonisjs/core/types';
import type { DurableConfig } from '../define_config.js';
import { describeMessagesMode, type TransportMessagesOptions } from '../messages/resolve.js';
import type { MessagesProtection } from '../protection.js';
import type { AgoraDoctorCheck, AgoraDoctorResult } from './agora_doctor.js';

const DOCS = 'https://davidecarvalho.github.io/agora/docs/durable/transports/encrypting-messages';

/** The `messages` options a transport / control-plane factory carries (see `transports.*`). */
function messagesOf(factory: unknown): TransportMessagesOptions | undefined {
  if (factory === null || (typeof factory !== 'function' && typeof factory !== 'object')) {
    return undefined;
  }
  const value = (factory as { messages?: unknown }).messages;
  return value !== null && typeof value === 'object'
    ? (value as TransportMessagesOptions)
    : undefined;
}

/** Every broker transport's (and the control plane's) resolved messages mode, from the config. */
async function configuredModes(
  app: ApplicationService,
): Promise<Array<[string, Awaited<ReturnType<typeof describeMessagesMode>>]>> {
  const config = app.config.get<DurableConfig | undefined>('durable', undefined);
  const entries: Array<[string, TransportMessagesOptions]> = [];
  for (const [name, factory] of Object.entries(config?.transports ?? {})) {
    const options = messagesOf(factory);
    if (options) entries.push([name, options]);
  }
  const plane = messagesOf(config?.controlPlane);
  if (plane) entries.push(['control plane', plane]);
  // A tenant pod asks the control plane for its key with its token (explicit, or authkit's).
  const tenantConfig = (
    config as { tenant?: { partition?: string; token?: unknown; url?: unknown } } | undefined
  )?.tenant;
  const hasAuthkit =
    typeof app.container?.hasBinding === 'function' && app.container.hasBinding('authkit.client');
  const hasToken = tenantConfig?.token !== undefined || hasAuthkit;
  // With the control plane's URL (explicit, or from authkit-client) the key is asked over HTTPS.
  const hasUrl = tenantConfig?.url !== undefined || hasAuthkit;
  const tenant =
    config?.topology === 'tenant'
      ? {
          partition: tenantConfig?.partition ?? '(from authkit)',
          ...(hasToken ? { token: async () => '' } : {}),
          ...(hasUrl ? { url: async () => '' } : {}),
        }
      : undefined;
  const modes: Array<[string, Awaited<ReturnType<typeof describeMessagesMode>>]> = [];
  for (const [name, options] of entries) {
    modes.push([name, await describeMessagesMode(app as never, name, options, undefined, tenant)]);
  }
  return modes;
}

/**
 * How each configured broker transport (and the control plane) seals its messages, from the config
 * alone: what the console shows where no engine runs in this process (a store-less `tenant` pod).
 * A transport whose mode does not resolve is left out.
 */
export async function configuredMessagesProtection(
  app: ApplicationService,
): Promise<MessagesProtection[]> {
  const out: MessagesProtection[] = [];
  for (const [transport, mode] of await configuredModes(app)) {
    if ('error' in mode) continue;
    out.push({
      transport,
      mode: mode.sealing ? mode.mode : 'plain',
      acceptPlain: mode.sealing ? mode.acceptPlain : true,
    });
  }
  return out;
}

/**
 * `durable.messages`: how each configured broker transport (and the Redis control plane) seals its
 * messages, as the app would resolve it at boot. One result per transport. In-process transports
 * (`memory`, `eventEmitter`) carry nothing across processes and are not listed.
 */
export async function checkMessages(app: ApplicationService): Promise<AgoraDoctorResult[]> {
  const modes = await configuredModes(app);
  if (modes.length === 0) {
    return [
      {
        status: 'skip',
        message: 'No broker transport is configured: messages stay in this process.',
      },
    ];
  }
  const results: AgoraDoctorResult[] = [];
  for (const [name, mode] of modes) {
    if ('error' in mode) {
      results.push({ status: 'error', message: `${name}: ${mode.error}`, docs: DOCS });
      continue;
    }
    if (mode.mode === 'plain') {
      results.push({
        status: 'warn',
        message: `${name} messages: ${mode.label}: not sealed, anyone who can write to the broker can read and inject run data.`,
        fix:
          mode.why === 'no-key'
            ? `To seal them: ${mode.hint}.`
            : `Remove \`messages: { ${mode.why === 'insecure' ? 'insecure: true' : 'crypto: false'} }\` from the ${name} transport (or set \`secret\` / \`crypto\`).`,
        docs: DOCS,
      });
      continue;
    }
    if (!mode.sealing) {
      results.push({
        status: 'warn',
        message: `${name} messages: sent plain; sealed ones are opened (${mode.label}).`,
        fix: 'Once every process runs @adonis-agora/durable 1.2.1 or later, set `messages: { seal: true }` in config/durable.ts (or on this transport). It becomes the default in the next major.',
        docs: DOCS,
      });
      continue;
    }
    if (mode.acceptPlain) {
      results.push({
        status: 'warn',
        message: `${name} messages: ${mode.label}, accepting plain messages too (the 1.x default, for jobs queued before sealing was turned on).`,
        fix: `Once the queues hold no job from before sealing was turned on, set \`messages: { acceptPlain: false }\` on the ${name} transport (the default of the next major).`,
        docs: DOCS,
      });
      continue;
    }
    results.push({
      status: 'ok',
      message: `${name} messages: ${mode.label}, plain messages refused.${
        mode.mode === 'tenant-key' &&
        mode.role === 'control-plane' &&
        mode.label.includes('(app key)')
          ? " No @adonis-agora/crypto here: the tenants' keys derive from this APP_KEY (rotating it rotates them all)."
          : ''
      }`,
    });
  }
  return results;
}

export const messagesDoctorChecks: AgoraDoctorCheck[] = [
  {
    id: 'durable.messages',
    lib: 'durable',
    title: 'Transport messages are sealed',
    run: (app) => checkMessages(app),
  },
];
