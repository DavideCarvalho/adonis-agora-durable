import type { RunRequestResponder } from './run-request-responder.js';

/** The part of an AdonisJS `HttpContext` the route reads and writes. */
export interface MessageKeyRouteContext {
  request: { header(name: string): string | undefined; body(): unknown };
  response: { status(code: number): { json(body: unknown): unknown } };
}

/**
 * The control plane's `POST /__durable/message-key` handler: a tenant pod's message-key request over
 * HTTPS (the token as a bearer, the request in the body), answered like the broker one. Status: 200
 * granted, 403 unauthorized or another partition, 409 already used (a replay), 404 nothing answers
 * key requests here, else 400.
 */
export function messageKeyRoute(
  responder: () => Promise<Pick<RunRequestResponder, 'grantMessageKey'> | null>,
): (ctx: MessageKeyRouteContext) => Promise<unknown> {
  return async ({ request, response }) => {
    const auth = request.header('authorization') ?? '';
    const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    const body = (request.body() ?? {}) as Record<string, unknown>;
    const answering = await responder();
    if (!answering) {
      return response.status(404).json({
        ok: false,
        error: { message: 'this app answers no message-key requests', code: 'unsupported' },
      });
    }
    const { requestId, ...rest } = body;
    const result = await answering.grantMessageKey(token, rest, String(requestId ?? ''));
    const code = result.ok
      ? 200
      : result.error.code === 'unauthorized' || result.error.code === 'cross-tenant'
        ? 403
        : result.error.code === 'replayed'
          ? 409
          : 400;
    return response.status(code).json(result);
  };
}
