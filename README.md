# Roam

Roam reads the coordinates buried in holiday photographs and turns them back
into the journey they came from — the places you stopped, how long you stayed,
and what you pointed the camera at.

A photograph carries a latitude, a longitude and a timestamp. A folder of them
carries a trip. Roam clusters the coordinates into places, cuts each place back
apart along the time axis into separate visits, names them from OpenStreetMap,
and draws the result as a map and a timeline.

The demo trips are indexed at `/trips`; Rome, the one everything was built
against, is at `/rome-may-2026`.

## Running it

```bash
npm install
cp .env.example .env      # then fill in DATABASE_URL and NEXT_PUBLIC_MAPBOX_TOKEN
npm run db:generate       # generate the Prisma client
npm run db:push           # create the schema
npm run seed:all          # build every demo trip
npm run dev
```

## Trips

Each demo trip starts as an itinerary in `data/itineraries/<city>.json`: a name,
a date range, a UTC offset, and an ordered list of real places with the
coordinates, visit durations and photograph counts a traveller might plausibly
have produced. Four are included — Rome, Barcelona, Lisbon and Athens.

Nothing downstream knows a city by name. The generator turns an itinerary into a
synthetic dataset, the fetch script builds that dataset's photography cache, and
the seed loads it; each takes `--city <slug>` and reads and writes the files for
that city alone.

```bash
npx tsx scripts/generate-trip.ts --city lisbon        # -> data/lisbon-trip.json
npx tsx scripts/fetch-unsplash.ts --city lisbon       # -> data/unsplash-lisbon.json
npx tsx scripts/seed-demo-trip.ts --city lisbon       # -> /lisbon-march-2026
```

Adding a fifth city means writing a fifth itinerary and running those three.

`npm run seed:all` does the seed step for every itinerary in one process, which
matters: the rate limiter that keeps Nominatim and Overpass requests to one a
second lives in module state, so seeding cities as separate processes would run
several limiters at once and hit those free services at several times the agreed
rate.

The Unsplash demo tier allows fifty requests an hour and one city costs roughly
twenty-five, so the caches cannot all be built in one sitting. A fetch that runs
out of budget writes the buckets it filled and names the ones it did not; running
it again later merges into what is already on disk rather than starting over. A
city with no cache seeds with `picsum.photos` stand-ins — right shapes, wrong
subjects — and one with a partial cache borrows the missing places' photographs
from the nearest place it does have some for.

## Environment

| Variable | Needed for | Notes |
| --- | --- | --- |
| `DATABASE_URL` | everything | PostgreSQL. Prisma 7 talks to it through the `pg` driver adapter. |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | the map | Free tier is plenty. Without it the trip page renders the timeline and explains what is missing. |
| `ALLOW_EDITS` | manual place corrections | Must be exactly `true`. See below. |
| `UNSPLASH_ACCESS_KEY` | rebuilding the demo photography | Only needed to regenerate the `data/unsplash-<city>.json` caches, which are committed. |
| `NOMINATIM_CONTACT` | politeness | Goes in the User-Agent sent to Nominatim and Overpass so an operator can reach you rather than block you. |
| `OVERPASS_ENDPOINT` | optional | Point at a mirror or your own instance; defaults to the public one. |
| `NEXT_PUBLIC_GITHUB_URL` | the footer link | Defaults to a placeholder. |
| `NEXT_PUBLIC_FEATURED_TRIP` | the home page | Slug of the trip offered as a direct link beside the index. Defaults to `rome-may-2026`; falls back to the most recent trip if that slug is absent. |

## Manual place corrections

Clustering is a heuristic and gets things wrong: on the Rome demo, several
places end up named after something standing inside them rather than the place
itself. Rather than chase that with more tuning, the places can be corrected by
hand — renamed, merged, split at a chosen visit, or deleted with their
photographs returning to the trip unassigned.

The controls appear in the place panel, and the routes behind them
(`/api/places/[id]`, `.../merge`, `.../split`) all refuse with a 403 unless:

```
ALLOW_EDITS=true
```

It is off by default so a public deployment stays read-only — forgetting to set
it fails closed rather than open. Every edit recomputes the affected place's
centroid and photo count and renumbers the trip's visit sequences.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Development server. |
| `npm run seed:all` | Rebuilds every trip in one process, sharing one rate limiter. `-- --only rome,athens` narrows it. |
| `npm run seed:demo` | Rebuilds one trip: `-- --city athens`. `--placeholder` swaps in stand-in imagery; `--force-geocode` re-looks-up every place name. |
| `npm run generate:trip` | Regenerates one city's dataset from its itinerary: `-- --city athens`. Seeded, so the same seed gives the same trip. |
| `npm run evaluate:clustering` | Scores clustering against the dataset's ground truth. `--sweep` tries every parameter combination. |
| `npm run fetch:unsplash` | Rebuilds one city's committed photography cache: `-- --city athens`. Needs `UNSPLASH_ACCESS_KEY`. Skips buckets already cached; `--refetch` searches them again. |
| `npm run db:apply` | Applies the schema as raw DDL, for machines where Prisma's native schema engine cannot run. |
| `npm run typecheck` | `next typegen` then `tsc --noEmit`. |

## How the clustering works

1. **DBSCAN over the photographs that have GPS.** Density-based, because the
   number of places is not known in advance, because a place can be nine
   photographs or fifty-eight, and because photographs taken walking between
   stops genuinely belong to no place at all. The metric is great-circle
   distance in metres — Euclidean distance on raw degrees describes an ellipse
   on the ground, 34% wider east-west than north-south at Rome's latitude.

2. **Temporal splitting.** Clustering answers *where*, not *when*: the same café
   on Monday and Thursday is one set of coordinates. Each cluster is cut at gaps
   longer than 90 minutes, so a return visit is a return.

3. **Interpolation.** Around one photograph in seven arrives with no position.
   Where the nearest positioned photographs either side in time are close enough
   together — two hours by default — the position between them is inferred.
   Past that the photograph is left unplaced rather than given a plausible
   guess.

4. **Naming.** Overpass is asked what is mapped within 150m of each centroid,
   preferring a named area that *contains* the centroid over anything standing
   inside it. Nominatim's reverse geocoding is the fallback, and a formatted
   coordinate the fallback to that. Results are cached in `GeocodeCache`, and a
   name obtained while a service was failing is deliberately not cached.

`npm run evaluate:clustering -- --sweep` scores all of it against known ground
truth. At the defaults (ε=60m, minPoints=4) it recovers 11 of 12 places with 94%
per-photo accuracy; the two places it cannot separate are 90m apart.

## Attribution

Demo photography from [Unsplash](https://unsplash.com), each photograph credited
to its photographer wherever it appears. Place names and map data ©
[OpenStreetMap contributors](https://www.openstreetmap.org/copyright).
