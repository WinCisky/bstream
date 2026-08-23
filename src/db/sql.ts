/**
 * The seam between this service and whichever Postgres it is talking to.
 *
 * Two drivers implement it: `npm:postgres` in production (`postgres.ts`) and `npm:@electric-sql/
 * pglite` in the tests (`test/support/pglite.ts`), which is what lets the suite run the real SQL
 * and the real migrations with no daemon. The interface is deliberately the *intersection* of the
 * two and nothing more — anything richer leaks one driver's shape into the other and the tests stop
 * proving anything about production.
 *
 * Three behaviours were measured rather than assumed, and they are why this file looks like it does:
 *
 *  - **There is no `rowCount`.** postgres.js reports affected rows on the result array's `.count`,
 *    PGlite on `affectedRows`, and the two disagree for a `SELECT` (PGlite says 0). Every statement
 *    whose outcome is branched on therefore ends in `RETURNING`, and the branch reads `rows.length`,
 *    which is identical under both.
 *  - **`exec` is separate from `query`.** A migration file is several statements, which needs the
 *    simple query protocol; a parameterised statement is the extended protocol and can only ever be
 *    one. Splitting them is honest about that rather than discovering it at runtime.
 *  - **`transaction` is on `Database`, not `Executor`.** That makes "opens its own transaction"
 *    (`persist`) and "a read that runs anywhere, including inside someone else's transaction"
 *    (`readIndex`) a type-level distinction, and makes accidental nesting unrepresentable.
 */

/**
 * Values both drivers serialise identically.
 *
 * Objects and arrays are passed through **as values**, never pre-stringified: postgres.js
 * JSON-encodes an object bound to a `jsonb` column correctly, but double-encodes a string bound to
 * `$n::jsonb` — it stores the JSON *text* as a JSON string. PGlite accepts both, so that mistake
 * passes the test suite and rots production. Pass the object.
 */
export type SqlParam =
  | string
  | number
  | boolean
  | null
  | Uint8Array
  | readonly string[]
  | readonly unknown[]
  | Record<string, unknown>;

export interface QueryResult<Row> {
  readonly rows: Row[];
}

export interface Executor {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly SqlParam[],
  ): Promise<QueryResult<Row>>;
  /** A multi-statement script with no parameters. Migrations only. */
  exec(text: string): Promise<void>;
}

export interface Database extends Executor {
  transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Raised when the database cannot be reached at all, as opposed to refusing a statement.
 *
 * The distinction is the whole point: a connection failure is transient and becomes a 503 that
 * tells sl-stream to back off, while a constraint violation is a bug in this service and deserves
 * the 500 it gets. Only the former is wrapped.
 */
export class DbUnavailableError extends Error {
  override readonly name = "DbUnavailableError";
}

/**
 * Postgres hands back `bigint` as a string under postgres.js and a number under PGlite, so every
 * numeric read goes through here rather than trusting either.
 *
 * `Number(null)` is `0`, which would turn a missing timestamp into 1970 rather than an absence, so
 * null and undefined are preserved instead of coerced.
 */
export function num(value: unknown): number {
  return Number(value);
}

/** As `num`, for a column that is legitimately nullable. */
export function numOrNull(value: unknown): number | null {
  return value == null ? null : Number(value);
}

/**
 * Normalise a `bytea` read to a plain `Uint8Array`.
 *
 * postgres.js returns a `Buffer` (Deno's `node:buffer` polyfill) and PGlite a `Uint8Array`. Both
 * satisfy `instanceof Uint8Array` and both work with `decodePieceHashes`, but `assertEquals` calls
 * them unequal, so a round-trip test would fail against production and pass in CI. Copying with the
 * constructor is also why this is not `.slice()` — `Buffer.prototype.slice` returns a view.
 */
export function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  throw new TypeError(`expected bytea, got ${typeof value}`);
}

/**
 * Reject a string Postgres cannot store.
 *
 * A NUL byte is legal in a JavaScript string and was legal in a Deno KV value; `text` and `jsonb`
 * both refuse it outright. Every string that reaches a column here came from an unauthenticated
 * peer or a caller's magnet, so this is a validation boundary, not a sanity check.
 */
export function hasNul(value: string): boolean {
  return value.includes("\u0000");
}
