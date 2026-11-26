import type { ApplicationService } from '@adonisjs/core/types';
import type { ControlPlaneConfig } from '../config_types.js';
import type { ConsoleTokenVerifier } from '../control-plane-redis/console-auth.js';
import {
  type AuthkitClientLike,
  authkitClientOf,
  type CryptoRuntimeLike,
  checkTenantConsoleKey,
  classifyConsoleKeyError,
  consoleSideCipher,
  cryptoRuntimeOf,
  probeConsoleKey,
} from '../control-plane-redis/console-crypto.js';
import {
  type AppConsoleResolution,
  type ConsoleSideResolution,
  resolveAppConsoleAuth,
  resolveConsoleSideAuth,
} from '../control-plane-redis/console-resolve.js';
import {
  consoleAppKey,
  type FederatedConsoleApp,
  federatedAppPartition,
  federatedConsoleEntry,
} from '../dashboard/federation.js';
import type { DurableConfig, DurableConsoleCommandsConfig } from '../define_config.js';
import { type ContractClassMaker, resolveTenantVerifier } from '../run-gateway/tenant-auth.js';
import type { AgoraDoctorCheck, AgoraDoctorResult } from './agora_doctor.js';

const DOCS = 'https://davidecarvalho.github.io/agora/docs/durable/observability/federated-console';

/** Both sides of the federated console as this app resolves them, as the doctor reports them. */
interface ResolvedSides {
  app?: AppConsoleResolution | undefined;
  /** `@adonis-agora/authkit-client` as booted here (for the key-directory note). */
  authkit?: AuthkitClientLike | undefined;
  consoles: Array<{ id: string; partition: string; resolved: ConsoleSideResolution }>;
}

async function resolveSides(app: ApplicationService): Promise<ResolvedSides> {
  const container = app.container as never;
  const durable = app.config.get<DurableConfig | undefined>('durable', undefined);
  const dashboard = app.config.get<{
    enabled?: boolean;
    apps?: Record<string, FederatedConsoleApp>;
  }>('durable_dashboard', {});
  const crypto = await cryptoRuntimeOf(container).catch(() => undefined);
  const authkit = await authkitClientOf(container).catch(() => undefined);
  const sides: ResolvedSides = { consoles: [], authkit };

  if (durable?.consoleCommands) {
    const options: DurableConsoleCommandsConfig =
      typeof durable.consoleCommands === 'object' ? durable.consoleCommands : {};
    const make: ContractClassMaker = (Class) => app.container.make(Class);
    const fallback =
      durable.topology === 'control-plane' && options.verifyTenant === undefined
        ? (durable as ControlPlaneConfig).verifyTenant
        : undefined;
    sides.app = resolveAppConsoleAuth({
      secret: options.secret,
      crypto: options.crypto,
      verifyTenant:
        options.verifyTenant === false
          ? false
          : options.verifyTenant !== undefined
            ? (resolveTenantVerifier(options.verifyTenant, make) as ConsoleTokenVerifier)
            : undefined,
      fallbackVerifier: fallback
        ? (resolveTenantVerifier(fallback, make) as ConsoleTokenVerifier)
        : undefined,
      appKey: await consoleAppKey(app),
      prefix: (() => {
        const prefix = (durable.controlPlane as { prefix?: unknown } | undefined)?.prefix;
        return typeof prefix === 'string' && prefix !== '' ? prefix : 'durable';
      })(),
      cryptoRuntime: options.crypto === undefined ? crypto : undefined,
      authkit: options.verifyTenant === undefined ? authkit : undefined,
    });
  }
  if (dashboard.enabled !== false) {
    for (const [id, entry] of Object.entries(dashboard.apps ?? {})) {
      const partition = federatedAppPartition(id, entry);
      sides.consoles.push({
        id,
        partition,
        resolved: resolveConsoleSideAuth(id, partition, federatedConsoleEntry(entry), {
          crypto,
          authkit,
        }),
      });
    }
  }
  return sides;
}

/** `durable.console-commands`: each side of the federated console resolves an authentication. */
export async function checkConsoleCommands(app: ApplicationService): Promise<AgoraDoctorResult[]> {
  const sides = await resolveSides(app);
  const results: AgoraDoctorResult[] = [];
  if (sides.app) {
    const options = app.config.get<DurableConfig>('durable', {}).consoleCommands;
    const actions = typeof options === 'object' && options.actions === true;
    results.push(
      sides.app.auth
        ? {
            status: 'ok',
            message: `App side: ${sides.app.modes.join(' + ')}; ${actions ? 'actions on' : 'actions off (set consoleCommands.actions to let the console act)'}.`,
          }
        : {
            status: 'error',
            message: 'App side: consoleCommands is set but no authentication resolves.',
            fix: "Install @adonis-agora/crypto (automatic), or configure authkit-client's `service` (the console then uses an app-call token; grant it durable:console:* on this app), or set consoleCommands.secret, or consoleCommands.verifyTenant (needs an APP_KEY).",
            docs: DOCS,
          },
    );
    // §13e: with crypto the token key is not published, and that is fine (unless crypto commands
    // must carry a token too: then it is published, like token mode).
    const appAuth = sides.app.auth;
    if (appAuth?.appKey !== undefined && appAuth.crypto && appAuth.crypto.requireToken !== true) {
      results.push({
        status: 'ok',
        message:
          "console commands: this app's token key is not published: crypto is enough to reach it.",
      });
    }
  }
  for (const { id, resolved } of sides.consoles) {
    results.push(
      resolved.error
        ? {
            status: 'error',
            message: `Console side, app "${id}": no authentication resolves for its commands.`,
            fix: `Install @adonis-agora/crypto here (automatic), or set apps.${id}.controlPlane.secret, or apps.${id}.controlPlane.token + publicKey; or apps.${id}.actions: false to browse it only.`,
            docs: DOCS,
          }
        : {
            status: 'ok',
            message: `Console side, app "${id}": ${resolved.modes.join(' + ')}.`,
          },
    );
  }
  if (results.length === 0) {
    return [{ status: 'skip', message: 'No consoleCommands and no federated apps.' }];
  }
  return results;
}

async function keyPresent(
  service: NonNullable<CryptoRuntimeLike['service']>,
  partition: string,
): Promise<boolean> {
  return !!(await service.store.getKey(partition, 'console-durable'));
}

/**
 * `durable.console-commands-key` (deep): in the automatic crypto mode, the `console-durable` key
 * exists and this process can use it — the app opens what is sealed for it, the console seals.
 */
export async function checkConsoleCommandsCrypto(
  app: ApplicationService,
): Promise<AgoraDoctorResult[]> {
  const sides = await resolveSides(app);
  const results: AgoraDoctorResult[] = [];
  const fail = (message: string, fix: string): AgoraDoctorResult => ({
    status: 'error',
    message,
    fix,
    docs: DOCS,
  });

  const appRuntime = sides.app?.autoCrypto;
  if (appRuntime) {
    const partition = appRuntime.partition;
    try {
      if (appRuntime.service) {
        if (!(await keyPresent(appRuntime.service, partition))) {
          results.push({
            status: 'warn',
            message: `App side: the key console-durable does not exist yet in "${partition}"; it is created at the first command.`,
          });
        } else {
          // Sealed as a console would (encrypt only), opened with this app's own operations.
          const seal = consoleSideCipher(appRuntime, partition);
          await probeConsoleKey(await seal(), appRuntime.operations);
          results.push({
            status: 'ok',
            message: `App side: console-durable of "${partition}" seals and opens.`,
          });
        }
      } else {
        const check = await checkTenantConsoleKey(appRuntime);
        const detail = check?.line.replace(/^\[@adonis-agora\/durable\] console commands: /, '');
        results.push(
          check?.level === 'warn'
            ? fail(
                `App side: ${detail}`,
                `Check this app's crypto token is for partition ${partition} and the crypto server is up and current (an app opens its own console-* keys with no grant).`,
              )
            : {
                status: 'ok',
                // Missing on a crypto tenant is fine: the server creates it on the console's first seal.
                message: check
                  ? `App side: ${detail}`
                  : `App side: console-durable exists in "${partition}".`,
              },
        );
      }
    } catch (error) {
      results.push(
        fail(
          `App side: the probe failed (${error instanceof Error ? error.message : String(error)}).`,
          `Check this app's crypto token is for partition ${partition} and the crypto server is up and current (an app opens its own console-* keys with no grant).`,
        ),
      );
    }
  }
  for (const { id, partition, resolved } of sides.consoles) {
    const runtime = resolved.autoCrypto;
    if (!runtime) continue;
    try {
      if (runtime.service && !(await keyPresent(runtime.service, partition))) {
        results.push({
          status: 'warn',
          message: `Console side, app "${id}": the key console-durable does not exist yet in "${partition}"; it is created at the first command.`,
        });
        continue;
      }
      await probeConsoleKey(await consoleSideCipher(runtime, partition)(), undefined);
      results.push({
        status: 'ok',
        message: `Console side, app "${id}": seals with console-durable of "${partition}".`,
      });
    } catch (error) {
      results.push(
        fail(
          `Console side, app "${id}": cannot seal for "${partition}" (${error instanceof Error ? error.message : String(error)}).`,
          (() => {
            // The same classifier the app side's key watch uses.
            const outcome = classifyConsoleKeyError(error);
            if (outcome === 'missing') {
              return `Run \`node ace crypto:keys:create console-durable --type aes256-gcm --application ${partition}\` on the crypto server, and check apps.${id}.controlPlane.partition equals that app's crypto partition.`;
            }
            if (outcome === 'unreachable')
              return 'Check that the crypto server is up and reachable.';
            return runtime.service
              ? `Check the crypto partition "${partition}" (apps.${id}.controlPlane.partition).`
              : "Give this app's crypto client crypto:seal:console-*, and run a current @adonis-agora/crypto on the crypto server.";
          })(),
        ),
      );
    }
  }
  if (results.length === 0) return [{ status: 'skip', message: 'No automatic crypto mode.' }];
  return results;
}

/** The federated console's checks (both sides), registered by the durable provider. */
export const consoleCommandsDoctorChecks: AgoraDoctorCheck[] = [
  {
    id: 'durable.console-commands',
    lib: 'durable',
    title: 'Console commands are authenticated',
    run: (app) => checkConsoleCommands(app),
  },
  {
    id: 'durable.console-commands-key',
    lib: 'durable',
    title: 'Console commands crypto key',
    cost: 'deep',
    run: (app) => checkConsoleCommandsCrypto(app),
  },
];
