/**
 * Every database session of the API runs in UTC (#322). The `pg` driver sends a `Date` as text
 * without an offset, and PostgreSQL reads such text in the session time zone: in any other zone, a
 * value written by the API and an instant PostgreSQL computes (`now()`) would disagree by the
 * offset, and expiry checks would move with it.
 */

/** The startup parameter that sets the session time zone, as libpq writes it. */
const UTC_OPTION = '-c TimeZone=UTC';

/**
 * The connection URL with the UTC session parameter added to its `options`, after any options the
 * operator set: for a repeated `-c`, the last one wins.
 */
export function utcSessionUrl(url: string): string {
  const parsed = new URL(url);
  const options = parsed.searchParams.get('options');
  parsed.searchParams.set('options', options ? `${options} ${UTC_OPTION}` : UTC_OPTION);
  return parsed.toString();
}

/** Thrown when the session runs in another zone: a pooler may drop startup parameters. */
export class NonUtcSessionError extends Error {
  constructor(zone: string) {
    // The zone name comes from the server setting, never from the connection string.
    super(
      `The database session time zone is ${JSON.stringify(zone.slice(0, 64))}, not UTC. Connect without a pooler that drops startup parameters, or set the timezone of the API's database roles to UTC.`,
    );
    this.name = 'NonUtcSessionError';
  }
}

/** Refuses a session time zone other than UTC. */
export function assertUtcSession(zone: string): void {
  if (zone !== 'UTC') throw new NonUtcSessionError(zone);
}
