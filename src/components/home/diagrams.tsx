/**
 * Small diagrams for the home page's "how it works" section.
 *
 * Inline SVG rather than images: they are a dozen shapes each, they inherit the
 * page's colours, and they stay sharp at any size without a request. Each one
 * shows the actual step rather than decorating it — the scatter really is a
 * cloud of coordinates, the clusters really are drawn around the dense parts.
 *
 * Server components. Nothing here reacts to anything.
 */

const STROKE = "var(--muted-foreground)";
const ACCENT = "var(--roam-accent)";

interface DiagramProps {
  className?: string;
}

const FRAME = "h-20 w-full text-muted-foreground";

/** Step one: a photograph carrying coordinates in its metadata. */
export function ExifDiagram({ className }: DiagramProps) {
  return (
    <svg
      viewBox="0 0 120 64"
      fill="none"
      aria-hidden
      className={className ?? FRAME}
    >
      {/* the photograph */}
      <rect x="6" y="10" width="46" height="36" rx="3" stroke={STROKE} strokeWidth="1.5" />
      <path d="M6 36l12-10 9 7 8-9 17 14" stroke={STROKE} strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx="18" cy="20" r="3" stroke={STROKE} strokeWidth="1.5" />

      {/* the metadata read out of it */}
      <path d="M58 22h10M58 22h10" stroke={STROKE} strokeWidth="1.5" strokeLinecap="round" />
      <path d="M60 20l4 2-4 2" stroke={ACCENT} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="72" y="14" width="42" height="7" rx="2" fill={ACCENT} opacity="0.85" />
      <rect x="72" y="25" width="34" height="5" rx="2" fill={STROKE} opacity="0.4" />
      <rect x="72" y="34" width="38" height="5" rx="2" fill={STROKE} opacity="0.4" />
      <rect x="72" y="43" width="26" height="5" rx="2" fill={STROKE} opacity="0.4" />
    </svg>
  );
}

/** Step two: scattered points gathered into two dense groups. */
export function ClusterDiagram({ className }: DiagramProps) {
  const left: [number, number][] = [
    [22, 20], [30, 16], [27, 27], [35, 24], [19, 30], [31, 34], [24, 38],
  ];
  const right: [number, number][] = [
    [82, 30], [90, 25], [95, 34], [86, 40], [93, 44], [79, 39],
  ];
  const strays: [number, number][] = [[56, 22], [62, 46], [50, 40]];

  return (
    <svg
      viewBox="0 0 120 64"
      fill="none"
      aria-hidden
      className={className ?? FRAME}
    >
      {/* the boundaries density found */}
      <circle cx="27" cy="27" r="17" fill={ACCENT} opacity="0.12" />
      <circle cx="27" cy="27" r="17" stroke={ACCENT} strokeWidth="1.25" strokeDasharray="3 3" />
      <circle cx="88" cy="35" r="14" fill={ACCENT} opacity="0.12" />
      <circle cx="88" cy="35" r="14" stroke={ACCENT} strokeWidth="1.25" strokeDasharray="3 3" />

      {left.concat(right).map(([cx, cy]) => (
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="2.4" fill={ACCENT} />
      ))}

      {/* photographs taken between the stops belong to neither */}
      {strays.map(([cx, cy]) => (
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="2.2" fill={STROKE} opacity="0.55" />
      ))}
    </svg>
  );
}

/** Step three: a cluster given a name from the map. */
export function NameDiagram({ className }: DiagramProps) {
  return (
    <svg
      viewBox="0 0 120 64"
      fill="none"
      aria-hidden
      className={className ?? FRAME}
    >
      {/* an outline the centroid falls inside */}
      <path
        d="M14 40l6-18 20-6 18 10-4 18-22 6z"
        stroke={STROKE}
        strokeWidth="1.5"
        strokeLinejoin="round"
        opacity="0.6"
      />
      <circle cx="33" cy="31" r="3" fill={ACCENT} />

      {/* the label that comes back */}
      <rect x="62" y="20" width="50" height="22" rx="4" stroke={ACCENT} strokeWidth="1.5" />
      <rect x="68" y="26" width="30" height="4" rx="2" fill={ACCENT} opacity="0.9" />
      <rect x="68" y="33" width="20" height="3" rx="1.5" fill={STROKE} opacity="0.5" />
      <path d="M40 31h18" stroke={STROKE} strokeWidth="1.5" strokeDasharray="3 3" />
    </svg>
  );
}

/** Step four: the places laid out in the order they were reached. */
export function TimelineDiagram({ className }: DiagramProps) {
  const rows = [
    { y: 14, width: 44 },
    { y: 30, width: 60 },
    { y: 46, width: 34 },
  ];

  return (
    <svg
      viewBox="0 0 120 64"
      fill="none"
      aria-hidden
      className={className ?? FRAME}
    >
      <path d="M14 10v44" stroke={STROKE} strokeWidth="1.5" opacity="0.5" />

      {rows.map((row, index) => (
        <g key={row.y}>
          <circle cx="14" cy={row.y} r="4" fill={index === 1 ? ACCENT : "transparent"} stroke={ACCENT} strokeWidth="1.5" />
          <rect x="26" y={row.y - 5} width={row.width} height="4" rx="2" fill={STROKE} opacity="0.7" />
          <rect x="26" y={row.y + 2} width={row.width * 0.55} height="3" rx="1.5" fill={STROKE} opacity="0.35" />
        </g>
      ))}
    </svg>
  );
}
