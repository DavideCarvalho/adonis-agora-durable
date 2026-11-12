import AgoraDoctor from './agora_doctor.js';

/** `node ace durable:doctor`: `agora:doctor` for durable's checks only (same flags). */
export default class DurableDoctor extends AgoraDoctor {
  static override commandName = 'durable:doctor';
  static override description = 'Check the @adonis-agora/durable configuration';
  protected override presetLib: string | undefined = 'durable';
}
