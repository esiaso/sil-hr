/**
 * Display helpers shared by the web app and generated documents. Formats come from
 * settings (`locale.date_format`, `locale.timezone`), never hardcoded at call sites.
 */

/** Formats a `YYYY-MM-DD` date with a DD/MM/YYYY-style pattern (DD, MM, YYYY, YY tokens). */
export function formatDate(isoDate: string | null | undefined, pattern = 'DD/MM/YYYY'): string {
  if (!isoDate) return '';
  const [y, m, d] = isoDate.slice(0, 10).split('-');
  if (!y || !m || !d) return isoDate;
  return pattern.replace('YYYY', y).replace('YY', y.slice(2)).replace('MM', m).replace('DD', d);
}

/** Formats a UTC timestamp in a timezone, date pattern + 24h time. */
export function formatDateTime(iso: string | null | undefined, timeZone = 'Africa/Nairobi', pattern = 'DD/MM/YYYY'): string {
  if (!iso) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${formatDate(`${get('year')}-${get('month')}-${get('day')}`, pattern)} ${get('hour')}:${get('minute')}`;
}

/** Formats a decimal string amount with thousands separators; never goes through a float. */
export function formatMoney(amount: string | null | undefined, currency = 'KES'): string {
  if (amount === null || amount === undefined || amount === '') return '';
  const negative = amount.startsWith('-');
  const [whole, frac = ''] = amount.replace('-', '').split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${currency} ${grouped}.${(frac + '00').slice(0, 2)}`;
}
