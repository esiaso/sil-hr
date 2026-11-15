import { BRAND } from '@sil/hr-shared';

/**
 * PeopleTrack mark and wordmark: a PLACEHOLDER drawn in code (no official vector logo was
 * supplied with the brand framework). A navy tile with a rising track line that ends in the
 * PeopleTrack amber dot. Replace with the final artwork when it arrives.
 */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden focusable="false">
      <rect width="32" height="32" rx="8" fill="#16345B" />
      <circle cx="11" cy="10.5" r="3.2" fill="#FFFFFF" />
      <path d="M6.5 24.5 L13 18 L18 21.5 L24.5 13" fill="none" stroke="#FFFFFF" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="25" cy="12.5" r="3" fill="#D97706" />
    </svg>
  );
}

/** "People" in Corporate Navy, "Track" in the PeopleTrack amber (dark enough to read). */
export function Wordmark({ size = 'md', compact }: { size?: 'sm' | 'md' | 'lg'; compact?: boolean }) {
  const text = { sm: 'text-base', md: 'text-lg', lg: 'text-2xl' }[size];
  const mark = { sm: 24, md: 28, lg: 36 }[size];
  return (
    <span className="flex items-center gap-2" aria-label={BRAND.name}>
      <BrandMark size={mark} />
      {!compact && (
        <span className={`font-display font-bold tracking-tight ${text}`} aria-hidden>
          <span style={{ color: 'var(--title)' }}>People</span>
          <span style={{ color: 'var(--highlight-text)' }}>Track</span>
        </span>
      )}
    </span>
  );
}

/** "Part of the SynergyOne Suite", for sign-in, the careers site and document footers. */
export function Endorsement({ className = '' }: { className?: string }) {
  return <span className={`muted text-xs ${className}`}>{BRAND.endorsement}</span>;
}
