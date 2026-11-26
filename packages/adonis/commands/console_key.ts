import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { consoleCommandPublicKey } from '../src/control-plane-redis/console-auth.js';
import { consoleAppKey } from '../src/dashboard/federation.js';
import type { DurableConfig } from '../src/define_config.js';

/**
 * `node ace durable:console-key` — the public key another app's federated console seals this app's
 * console commands to (token mode): derived from this app's `APP_KEY` and its control plane's
 * `prefix`, so the same on every instance. Put it in the console's `apps.<key>.controlPlane.publicKey`. Only the
 * public half is printed; nothing connects to Redis.
 */
export default class DurableConsoleKey extends BaseCommand {
  static override commandName = 'durable:console-key';
  static override description =
    "Print this app's console-command public key, for a federated console's `publicKey`";
  static override options: CommandOptions = { startApp: false };

  @flags.string({
    description: "The control plane's prefix (default: controlPlanes.redis's in config/durable.ts)",
  })
  declare prefix?: string;

  override async run(): Promise<void> {
    const appKey = await consoleAppKey(this.app);
    if (!appKey) {
      this.logger.error('No APP_KEY (16+ characters): token-mode console commands need one.');
      this.exitCode = 1;
      return;
    }
    const plane = this.app.config.get<DurableConfig>('durable', {}).controlPlane as
      | { prefix?: unknown }
      | undefined;
    const configured = typeof plane?.prefix === 'string' ? plane.prefix : undefined;
    const prefix = this.prefix?.trim() || configured;
    if (!prefix) {
      this.logger.error(
        "Cannot tell the control plane's prefix from config/durable.ts: pass --prefix=<the prefix of controlPlanes.redis>.",
      );
      this.exitCode = 1;
      return;
    }
    this.logger.log(consoleCommandPublicKey(appKey, prefix));
  }
}
