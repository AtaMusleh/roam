import type { TripStats as TripStatsData } from "@/lib/queries";

interface TripStatsProps {
  stats: TripStatsData;
}

/**
 * The trip in four numbers.
 *
 * A server component: nothing here reacts to anything. Deliberately plain —
 * hairlines and small caps rather than cards with borders and shadows, so the
 * header stays quiet and the map and photographs carry the page.
 */
export function TripStats({ stats }: TripStatsProps) {
  const cards: { label: string; value: number }[] = [
    { label: "Places", value: stats.placeCount },
    { label: "Photos", value: stats.photoCount },
    { label: "Days", value: stats.dayCount },
    { label: "Visits", value: stats.visitCount },
  ];

  return (
    <dl className="flex items-stretch divide-x divide-border/60 rounded-lg border border-border/60">
      {cards.map((card) => (
        <div key={card.label} className="flex-1 px-4 py-2.5 sm:px-6">
          <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {card.label}
          </dt>
          <dd className="mt-0.5 text-xl font-semibold tabular-nums sm:text-2xl">
            {card.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
