import type { RunReply, RunRequest, StartRunMessage, TenantEvent } from '../../src/interfaces.js';
import type { ProxyTransport } from '../../src/run-gateway/proxy-run-gateway.js';
import type { ResponderTransport } from '../../src/run-gateway/run-request-responder.js';

/**
 * A single-process in-memory P4 transport wiring a {@link ProxyRunGateway} (tenant side) to a
 * {@link RunRequestResponder} (control-plane side): a `dispatch*` on the tenant side is delivered
 * straight to the responder's consumer, whose reply is fanned back to every `onRunReply`/`onTenantEvent`
 * listener — so the FULL round-trip runs with no Redis. Failure injection (`dropRequests`, `failDispatch`)
 * proves the proxy's fail-fast paths.
 */
export class FakeP4Transport implements ProxyTransport, ResponderTransport {
  #onStartRun: ((msg: StartRunMessage) => Promise<void>) | undefined;
  #onRunRequest: ((msg: RunRequest) => Promise<void>) | undefined;
  readonly #replyHandlers = new Set<(r: RunReply) => void>();
  readonly #tenantHandlers = new Map<string, Set<(e: TenantEvent) => void>>();

  /** Swallow a dispatch without delivering it to the responder — models a down/silent control plane. */
  dropRequests = false;
  /** Make a dispatch throw — models a transport-level failure. */
  failDispatch = false;

  async dispatchStartRun(msg: StartRunMessage): Promise<void> {
    if (this.failDispatch) throw new Error('transport unavailable');
    if (this.dropRequests) return;
    await this.#onStartRun?.(msg);
  }
  async dispatchRunRequest(msg: RunRequest): Promise<void> {
    if (this.failDispatch) throw new Error('transport unavailable');
    if (this.dropRequests) return;
    await this.#onRunRequest?.(msg);
  }
  onRunReply(handler: (reply: RunReply) => void): void {
    this.#replyHandlers.add(handler);
  }
  onTenantEvent(tenant: string, handler: (evt: TenantEvent) => void): () => void {
    let set = this.#tenantHandlers.get(tenant);
    if (!set) {
      set = new Set();
      this.#tenantHandlers.set(tenant, set);
    }
    set.add(handler);
    return () => set?.delete(handler);
  }
  onStartRun(handler: (msg: StartRunMessage) => Promise<void>): void {
    this.#onStartRun = handler;
  }
  onRunRequest(handler: (msg: RunRequest) => Promise<void>): void {
    this.#onRunRequest = handler;
  }
  async publishRunReply(reply: RunReply): Promise<void> {
    for (const h of this.#replyHandlers) h(reply);
  }
  async publishTenantEvent(evt: TenantEvent): Promise<void> {
    for (const h of this.#tenantHandlers.get(evt.tenant) ?? []) h(evt);
  }
}
