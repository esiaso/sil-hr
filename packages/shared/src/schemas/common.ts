import { z } from 'zod';

export const uuid = z.uuid();
/** Calendar date with no time, `YYYY-MM-DD`. */
export const isoDate = z.iso.date();
export const isoDateTime = z.iso.datetime({ offset: true });
export const code = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Letters, digits, dot, dash and underscore only');
export const name = z.string().trim().min(1).max(200);
export const optionalText = (max = 1000) => z.string().trim().max(max).nullish();
export const email = z.email().max(200);
/** Kenyan or international phone, digits with optional leading +. */
export const phone = z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, 'Not a valid phone number');

/** Money travels as a decimal string with at most 2 dp, never a float. */
export const money = z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/, 'Amount with up to 2 decimal places');

/** Query parameters every collection accepts. */
export const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  cursor: z.string().max(500).optional(),
  sort: z.string().max(200).optional(),
  search: z.string().trim().max(200).optional(),
  updated_since: isoDateTime.optional(),
});
export type ListQuery = z.infer<typeof listQuery>;

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

export const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), next_cursor: z.string().nullable() });

/** Soft-deleted rows returned to incremental-sync consumers. */
export const tombstone = z.object({ id: uuid, deleted: z.literal(true), deleted_at: isoDateTime });
export type Tombstone = z.infer<typeof tombstone>;

/** RFC 9457 problem details, as every error response. */
export const problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  correlation_id: z.string().optional(),
  code: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type Problem = z.infer<typeof problem>;

export const auditStamps = {
  created_at: isoDateTime,
  updated_at: isoDateTime,
  version: z.number().int(),
};
