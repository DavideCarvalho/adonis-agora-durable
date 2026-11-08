import type { QueryClientContract } from '@adonisjs/lucid/types/database';

/**
 * The Lucid store's hot path on Postgres: the statements a workflow turn and a step result run on
 * every step, sent as constant SQL text straight to the `pg` connection instead of being rebuilt by
 * Knex's query builder on every call. Building a statement costs more CPU than sending it (profiled
 * at ~20% of an engine's CPU with dispatched steps: Knex's compiler, Lucid's query runner, lodash),
 * and these statements never change shape.
 *
 * Only a Postgres connection takes it, and only with Lucid's `debug` off: a connection being debugged
 * keeps the builder, so Lucid's `db:query` events and the query reporter see every statement as
 * before. The rows come back from the same `pg` driver Knex uses, so the store's row mappers read
 * them unchanged. Each statement is still announced as Knex's `query` event, so a listener on the
 * Knex client (statement counters, tracing) keeps seeing it.
 */

interface PgQueryConfig {
  name?: string;
  text: string;
  values: unknown[];
}

/** The `pg` Client surface the hot path uses. */
interface PgConnection {
  query(
    config: PgQueryConfig,
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

/** The Knex instance surface the hot path uses: its pool, and its event emitter. */
interface KnexLike {
  client: {
    acquireConnection(): Promise<PgConnection>;
    releaseConnection(connection: PgConnection): Promise<unknown>;
  };
  emit?(event: string, payload: unknown): boolean;
}

export interface PgHotPathOptions {
  /**
   * Send the hot statements as NAMED prepared statements (parsed once per connection). Saves Postgres
   * a parse per statement, but needs a direct connection or a pooler that supports protocol-level
   * prepared statements (PgBouncer in transaction mode before 1.21 does not). Default off.
   */
  preparedStatements?: boolean | undefined;
}

/** A short stable hash, for statement names. */
function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export class LucidPgHotPath {
  private constructor(
    private readonly knex: KnexLike,
    private readonly prepared: boolean,
  ) {}

  /** The hot path for `client`, or `undefined` when it is not Postgres or is being debugged. */
  static for(
    client: QueryClientContract,
    options: PgHotPathOptions = {},
  ): LucidPgHotPath | undefined {
    if (client.dialect.name !== 'postgres' || client.debug) return undefined;
    const knex = client.getWriteClient() as unknown as KnexLike;
    if (typeof knex?.client?.acquireConnection !== 'function') return undefined;
    return new LucidPgHotPath(knex, options.preparedStatements === true);
  }

  /**
   * Run one statement, written with `?` placeholders (the store's texts carry no other `?`);
   * resolves its rows as the driver decoded them, and the affected-row count. The connection comes
   * from the Knex client's own pool: inside a (global) transaction, that is the transaction's.
   */
  async run(
    sql: string,
    values: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; count: number }> {
    const text = numbered(sql);
    this.knex.emit?.('query', { method: 'raw', sql: text, bindings: values });
    const config: PgQueryConfig = { text, values };
    if (this.prepared) config.name = `durable_${hash(text)}`;
    const connection = await this.knex.client.acquireConnection();
    try {
      const result = await connection.query(config);
      return { rows: result.rows, count: result.rowCount ?? result.rows.length };
    } finally {
      await this.knex.client.releaseConnection(connection);
    }
  }

  /** {@link run}'s rows. */
  async rows(text: string, values: unknown[]): Promise<Record<string, unknown>[]> {
    return (await this.run(text, values)).rows;
  }
}

/** Statement texts with `?` placeholders, numbered once (`$1`, `$2`, …). */
const numberedTexts = new Map<string, string>();
function numbered(sql: string): string {
  let text = numberedTexts.get(sql);
  if (text === undefined) {
    let n = 0;
    text = sql.replace(/\?/g, () => {
      n += 1;
      return `$${n}`;
    });
    numberedTexts.set(sql, text);
  }
  return text;
}

/** A quoted identifier. */
export const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;
