import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import type { ListQuery, Page } from '@sil/hr-shared';
import { badRequest } from './problem';

export interface SortField {
  /** Entity property (for ORDER BY through TypeORM). */
  prop: string;
  /** SQL column (for the keyset WHERE). Must be NOT NULL. */
  column: string;
  cast?: 'text' | 'timestamptz' | 'int' | 'date';
}

export interface CursorOptions {
  alias: string;
  sortable: Record<string, SortField>;
  defaultSort: string;
}

const STANDARD: Record<string, SortField> = {
  created_at: { prop: 'createdAt', column: 'created_at', cast: 'timestamptz' },
  updated_at: { prop: 'updatedAt', column: 'updated_at', cast: 'timestamptz' },
};

function encode(value: unknown, id: string): string {
  return Buffer.from(JSON.stringify([value instanceof Date ? value.toISOString() : value, id])).toString('base64url');
}

function decode(cursor: string): [unknown, string] {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[1] === 'string') return parsed as [unknown, string];
  } catch {
    /* fall through */
  }
  throw badRequest('invalid_cursor', 'The cursor is not valid; start again without it');
}

/**
 * Keyset (cursor) pagination with one sort key plus `id` as the tie-breaker.
 *
 * `updated_since` switches to incremental-sync mode: soft-deleted rows are included
 * (the caller maps them to tombstones) and the order is `updated_at, id` ascending,
 * so a consumer can store the last `updated_at` it saw and resume from it.
 */
export async function paginate<T extends ObjectLiteral & { id: string }>(
  qb: SelectQueryBuilder<T>,
  query: ListQuery,
  options: CursorOptions,
): Promise<Page<T>> {
  const a = options.alias;
  const sortable = { ...STANDARD, ...options.sortable };
  let sortKey = query.sort ?? options.defaultSort;
  let desc = sortKey.startsWith('-');
  if (desc) sortKey = sortKey.slice(1);

  if (query.updated_since) {
    qb.withDeleted().andWhere(`${a}.updated_at > :updatedSince`, { updatedSince: query.updated_since });
    sortKey = 'updated_at';
    desc = false;
  }
  const field = sortable[sortKey];
  if (!field) {
    throw badRequest('invalid_sort', `Cannot sort by "${sortKey}". Sortable: ${Object.keys(sortable).join(', ')}`);
  }

  if (query.cursor) {
    const [value, id] = decode(query.cursor);
    const cast = field.cast ? `::${field.cast}` : '';
    qb.andWhere(`(${a}.${field.column}, ${a}.id) ${desc ? '<' : '>'} (:cursorValue${cast}, :cursorId::uuid)`, {
      cursorValue: value,
      cursorId: id,
    });
  }

  const rows = await qb
    .orderBy(`${a}.${field.prop}`, desc ? 'DESC' : 'ASC')
    .addOrderBy(`${a}.id`, desc ? 'DESC' : 'ASC')
    .limit(query.limit + 1)
    .getMany();

  const hasMore = rows.length > query.limit;
  const data = hasMore ? rows.slice(0, query.limit) : rows;
  const last = data[data.length - 1];
  return {
    data,
    next_cursor: hasMore && last ? encode((last as Record<string, unknown>)[field.prop], last.id) : null,
  };
}

export function mapPage<T, U>(page: Page<T>, fn: (row: T) => U): Page<U> {
  return { data: page.data.map(fn), next_cursor: page.next_cursor };
}

/** Escapes LIKE wildcards in user search input. */
export function likeTerm(search: string): string {
  return `%${search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
