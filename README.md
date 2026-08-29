# Roam

Roam reads the coordinates buried in holiday photographs and turns them back
into the journey they came from — the places you stopped, how long you stayed,
and what you pointed the camera at.

A photograph carries a latitude, a longitude and a timestamp. A folder of them
carries a trip. Roam clusters the coordinates into places, cuts each place back
apart along the time axis into separate visits, names them from OpenStreetMap,
and draws the result as a map and a timeline.

The demo trip is at `/rome-may-2026`.

## Running it

```bash
npm install
cp .env.example .env      # then fill in DATABASE_URL and NEXT_PUBLIC_MAPBOX_TOKEN
npm run db:generate       # generate the Prisma client
npm run db:push           # create the schema
npm run seed:demo         # build the Rome demo trip
npm run dev
```

## Environment

| Variable | Needed for | Notes |
| --- | --- | --- |
| `DATABASE_URL` | everything | PostgreSQL. Prisma 7 talks to it through the `pg` driver adapter. |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | the map | Free tier is plenty. Without it the trip page renders the timeline and explains what is missing. |
| `ALLOW_EDITS` | manual place corrections | Must be exactly `true`. See below. |
| `UNSPLASH_ACCESS_KEY` | rebuilding the demo photography | Only needed to regenerate `data/unsplash-rome.json`, which is committed. |
| `NOMINATIM_CONTACT` | politeness | Goes in the User-Agent sent to Nominatim and Overpass so an operator can reach you rather than block you. |
| `OVERPASS_ENDPOINT` | optional | Point at a mirror or your own instance; defaults to the public one. |
| `NEXT_PUBLIC_GITHUB_URL` | the footer link | Defaults to a placeholder. |

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
| `npm run seed:demo` | Rebuilds the Rome demo trip from `data/rome-trip.json`. `--placeholder` swaps in stand-in imagery; `--force-geocode` re-looks-up every place name. |
| `npm run generate:trip` | Regenerates the synthetic dataset. Seeded, so the same seed gives the same trip. |
| `npm run evaluate:clustering` | Scores clustering against the dataset's ground truth. `--sweep` tries every parameter combination. |
| `npm run fetch:unsplash` | Rebuilds the committed photography cache. Needs `UNSPLASH_ACCESS_KEY`. |
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
