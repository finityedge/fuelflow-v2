interface ProgressRingProps {
  /** How many are in the good state. */
  value: number;
  total: number;
  /** Diameter in px. The stroke scales with it so proportions stay constant. */
  size?: number;
  /** Ring colour, in the ring's own token form. */
  className?: string;
}

/**
 * A donut showing `value` of `total`.
 *
 * Deliberately `aria-hidden`: every caller prints the same two numbers as text beside it,
 * and a screen reader announcing "8, 10" after the sentence "8 of 10 read cleanly" is
 * noise. The ring is the visual form of a fact that is already stated in words.
 *
 * A zero total draws an empty track rather than a full ring — an empty ring is the honest
 * picture of nothing having happened yet.
 */
export function ProgressRing({ value, total, size = 60, className = 'text-primary' }: ProgressRingProps) {
  const stroke = size / 8;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const ratio = total > 0 ? Math.min(Math.max(value / total, 0), 1) : 0;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.15}
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        // Starts at 12 o'clock instead of 3 o'clock, which is where a reader looks first.
        strokeDashoffset={circumference * (1 - ratio)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}
