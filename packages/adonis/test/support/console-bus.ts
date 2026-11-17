import { decodeConsoleValue, encodeConsoleValue } from '../../src/console-commands.js';
import type {
  ConsoleCommand,
  ConsoleCommandReply,
  ControlMessage,
  ControlPlane,
} from '../../src/interfaces.js';

/**
 * An in-memory stand-in for one app's Redis control plane, console commands included: every plane
 * made from it shares the channel. A command goes to the first instance that listens (Redis' claim
 * picks one), its arguments and answer through the same JSON trip as on Redis.
 */
export function consoleBus() {
  const controlSubs = new Set<(m: ControlMessage) => void>();
  const commandHandlers: Array<(c: ConsoleCommand) => Promise<unknown>> = [];
  const sent: ConsoleCommand[] = [];
  const plane = (): ControlPlane => ({
    async publishControl(m) {
      const copy = JSON.parse(JSON.stringify(m)) as ControlMessage;
      for (const s of controlSubs) s(copy);
    },
    onControl(h) {
      controlSubs.add(h);
    },
    onConsoleCommand(h) {
      commandHandlers.push(h);
    },
    async sendConsoleCommand(command): Promise<ConsoleCommandReply> {
      sent.push(command);
      const handler = commandHandlers[0];
      if (!handler) throw new Error('no instance of the app listens for console commands');
      const wire = JSON.parse(
        JSON.stringify({ ...command, args: encodeConsoleValue(command.args) }),
      ) as ConsoleCommand;
      try {
        const data = await handler({ ...wire, args: decodeConsoleValue(wire.args) as unknown[] });
        const encoded = JSON.parse(JSON.stringify(encodeConsoleValue(data)));
        return { id: command.id, ok: true, data: decodeConsoleValue(encoded) };
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        return {
          id: command.id,
          ok: false,
          error: {
            message: (err as Error).message,
            ...(typeof code === 'string' ? { code } : {}),
          },
        };
      }
    },
  });
  return { plane, sent };
}
