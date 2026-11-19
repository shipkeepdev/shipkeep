import { Pool } from 'pg';

/**
 * Every database session of the API runs in UTC (#322). The `pg` driver sends a `Date` as text
 * without an offset, and PostgreSQL reads such text in the session time zone: in any other zone, a
 * value written by the API and an instant PostgreSQL computes (`now()`) would disagree by the
 * offset, and expiry checks would move with it.
 *
 * The zone is set on every physical connection, as its first statement, rather than through the
 * connection string: it then holds against a server, database or role default and against a
 * login trigger, and the connection string stays exactly what the operator wrote. A pooler that
 * shares server sessions between clients (transaction pooling) is not supported.
 */
export const UTC_SESSION = "SET TIME ZONE 'UTC'";

/**
 * A pool whose every connection runs UTC_SESSION before it is handed out: `onConnect` is awaited
 * during connection setup, and a failure closes the connection and fails the checkout, so nothing
 * ever runs on it in another zone.
 */
export function utcPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    // pg-pool awaits the returned promise, although its type says void.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- awaited by pg-pool
    onConnect: async (client) => {
      await client.query(UTC_SESSION);
    },
  });
}

/** Thrown when a session runs in another zone despite UTC_SESSION. */
export class NonUtcSessionError extends Error {
  constructor(zone: string) {
    // The zone name comes from the server setting, never from the connection string.
    super(
      `The database session time zone is ${JSON.stringify(zone.slice(0, 64))}, not UTC. A pooler that shares server sessions between clients is not supported.`,
    );
    this.name = 'NonUtcSessionError';
  }
}

/** Refuses a session time zone other than UTC. */
export function assertUtcSession(zone: string): void {
  if (zone !== 'UTC') throw new NonUtcSessionError(zone);
}

/** The query that reads a session's zone, for the startup checks. */
export const SESSION_ZONE = "SELECT current_setting('TimeZone') AS zone";
