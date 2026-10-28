import { z } from 'zod';
import { AppError } from './errors.js';

/**
 * Opaque keyset cursor: the (timestamp, id) of the last row on the previous page.
 * Ordering by a timestamp plus a unique id keeps pagination stable even when
 * many rows share a timestamp.
 */
const cursorSchema = z.object({ t: z.iso.datetime(), id: z.uuid() });

export interface Cursor {
  timestamp: Date;
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.timestamp.toISOString(), id: cursor.id })).toString('base64url');
}

export function decodeCursor(raw: string): Cursor {
  try {
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    return { timestamp: new Date(parsed.t), id: parsed.id };
  } catch {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid pagination cursor', [
      { path: 'cursor', message: 'Cursor is malformed; use the nextCursor value from a previous page' },
    ]);
  }
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

/** Callers fetch `limit + 1` rows; the extra row only signals that another page exists. */
export function toPage<Row, Item>(
  rows: Row[],
  limit: number,
  cursorOf: (row: Row) => Cursor,
  serialize: (row: Row) => Item,
): Page<Item> {
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    data: pageRows.map(serialize),
    nextCursor: rows.length > limit && last ? encodeCursor(cursorOf(last)) : null,
  };
}
