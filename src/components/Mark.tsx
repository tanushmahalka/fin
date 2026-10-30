/** The mark: two equal bars, because in double entry both sides always match. */
export function Mark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="currentColor" />
      <rect x="8" y="10.4" width="16" height="3.8" rx="1.9" fill="var(--bg)" />
      <rect x="8" y="17.8" width="16" height="3.8" rx="1.9" fill="var(--bg)" opacity="0.55" />
    </svg>
  );
}
