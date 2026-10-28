import { and, desc, eq, gte, lt, or } from 'drizzle-orm';
import type { Executor } from '../../db/client.js';
import { usageRequests } from '../../db/schema.js';
import { monthBounds, type MonthKey } from '../../domain/month.js';
import { decodeCursor, toPage, type Page } from '../../http/cursor.js';
import { assertUserInAccount } from '../users/users.service.js';
import { toDecisionView, type DecisionView } from './decision.view.js';

export interface HistoryQuery {
  userId?: string | undefined;
  status?: 'accepted' | 'rejected' | undefined;
  month?: MonthKey | undefined;
  limit: number;
  cursor?: string | undefined;
}

/**
 * Newest first, keyset-paginated on (processed_at, id). The month filter is
 * expressed as a processed_at range so it is served by the history indexes.
 */
export async function listRequestHistory(
  db: Executor,
  accountId: string,
  query: HistoryQuery,
): Promise<Page<DecisionView>> {
  if (query.userId) {
    // A foreign or unknown user is a 404, not an empty page.
    await assertUserInAccount(db, accountId, query.userId);
  }
  const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
  const bounds = query.month ? monthBounds(query.month) : undefined;
  const rows = await db
    .select()
    .from(usageRequests)
    .where(
      and(
        eq(usageRequests.accountId, accountId),
        query.userId ? eq(usageRequests.userId, query.userId) : undefined,
        query.status ? eq(usageRequests.status, query.status) : undefined,
        bounds ? gte(usageRequests.processedAt, bounds.start) : undefined,
        bounds ? lt(usageRequests.processedAt, bounds.end) : undefined,
        cursor
          ? or(
              lt(usageRequests.processedAt, cursor.timestamp),
              and(eq(usageRequests.processedAt, cursor.timestamp), lt(usageRequests.id, cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(usageRequests.processedAt), desc(usageRequests.id))
    .limit(query.limit + 1);
  return toPage(rows, query.limit, (row) => ({ timestamp: row.processedAt, id: row.id }), toDecisionView);
}
