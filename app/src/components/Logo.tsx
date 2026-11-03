/** The Ledgerly mark: an "L" whose inner corner holds three rising bars, with a gold coin at its top. Same artwork as public/logo.svg. */
export function Logo({ size = 28, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Ledgerly logo" className={className}>
      <defs><linearGradient id="lg-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#1b8f76" /><stop offset="1" stopColor="#0d5546" /></linearGradient></defs>
      <rect width="64" height="64" rx="15" fill="url(#lg-g)" />
      <path d="M17 12h8v32h26v8H17z" fill="#fff" />
      <rect x="31" y="34" width="5" height="6" rx="1" fill="#9be3cf" /><rect x="38" y="27" width="5" height="13" rx="1" fill="#9be3cf" /><rect x="45" y="19" width="5" height="21" rx="1" fill="#9be3cf" />
      <circle cx="46" cy="13" r="5.5" fill="#f5c542" /><path d="M46 10.5v5M44.2 12.2h3.2" stroke="#8a5d00" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
