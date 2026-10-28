/**
 * Source of "now" for every timestamp the service writes. Injected so tests can
 * pin the UTC month deterministically. Timestamps are generated in the app (ms
 * precision) rather than by Postgres (µs precision) so keyset pagination cursors
 * round-trip through JavaScript Dates without losing precision.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
