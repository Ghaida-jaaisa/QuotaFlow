import type { Clock } from './clock.js';
import type { Database } from './db/client.js';

/** Dependencies shared by routers and services, wired once in createApp. */
export interface AppDeps {
  db: Database;
  clock: Clock;
  adminToken: string | undefined;
}
