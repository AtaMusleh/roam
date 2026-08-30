# Roam

Roam reads the coordinates buried in holiday photographs and turns them back into the journey they came from — the places you stopped, how long you stayed, and what you pointed the camera at.

**Live demo: [roam-khaki.vercel.app](https://roam-khaki.vercel.app)** — start at [/trips](https://roam-khaki.vercel.app/trips), which indexes every reconstructed journey. Each card opens a map, a timeline, and the photographs.

A photograph carries a latitude, a longitude and a timestamp. A folder of them carries a trip. Roam clusters the coordinates into places, cuts each place back apart along the time axis into separate visits, names them from OpenStreetMap, and draws the result as a map and a timeline.

## Features

- **Place detection from coordinates alone.** DBSCAN over the photographs that have GPS, scored against ground truth by an evaluation harness in the repository.
- **Visits, not just places.** The same café on Monday and Thursday is one place with two visits, because a trip has a shape in time as well as in space.
- **Recovery of photographs that arrived without GPS.** Positions interpolated from the neighbours either side in time, and refused rather than guessed when those neighbours are too far apart to mean anything.
- **Place names from OpenStreetMap**, chosen by polygon containment rather than by nearest address.
- **A map and a timeline that share one selection.** Clicking a marker highlights its timeline row and scrolls to it; clicking a row selects and pans to its marker.
- **A full-screen lightbox** with keyboard navigation, swipe gestures, focus trapping, and photographer attribution.
- **Manual corrections.** Rename, merge, split at a chosen visit, or delete a place, with centroids and visit ordering recomputed afterwards. Gated behind an owner password.
- **Four demo trips** — Rome, Barcelona, Lisbon and Athens — generated from itineraries in the repository, illustrated with real Unsplash photography of the actual places.
- **Motion throughout**, including a route line that draws itself across the map on load, and a strict `prefers-reduced-motion` path that renders everything in its final state instead.

## Tech stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router, React 19, React Compiler) |
| Language | TypeScript, strict, no `any` |
| Database | PostgreSQL on Neon |
| ORM | Prisma 7 with the `@prisma/adapter-pg` driver adapter |
| Map | Mapbox GL JS |
| Images | Cloudinary (configured; upload unimplemented), Unsplash for the demo photography |
| Geocoding | Nominatim and Overpass, both OpenStreetMap |
| Styling | Tailwind CSS v4, Radix primitives |
| Motion | Motion, GSAP ScrollTrigger, Lenis |
| Hosting | Vercel |

## Data model

Four models. A `Trip` owns `Photo`s and `Place`s. A `Place` is somewhere the traveller stopped; a `Visit` is one bounded stay at that place, which is what makes the same café on two mornings one place and two occasions. Photographs attach to the trip on import and to a visit later, once clustering has decided where and when they were taken.

```prisma
enum GpsSource {
  EXIF          // what the camera recorded
  INTERPOLATED  // inferred from neighbouring photos in time
  MANUAL        // a correction made by the traveller
  NONE          // no position at all
}

model Trip {
  id           String   @id @default(cuid())
  name         String
  startDate    DateTime
  endDate      DateTime
  /// Photo.id of the cover image. Deliberately not a relation: it would create
  /// a cycle with Photo.tripId and force a nullable two-step insert.
  coverPhotoId String?
  slug         String   @unique
  /// Minutes to add to a stored UTC instant to get the traveller's wall clock.
  utcOffsetMinutes Int  @default(0)
  isPublic     Boolean  @default(false)
  createdAt    DateTime @default(now())

  photos Photo[]
  places Place[]
}

model Place {
  id         String   @id @default(cuid())
  tripId     String
  name       String
  lat        Float
  lng        Float
  address    String?
  /// Denormalised count of photos across all of this place's visits.
  photoCount Int      @default(0)
  createdAt  DateTime @default(now())

  trip   Trip    @relation(fields: [tripId], references: [id], onDelete: Cascade)
  visits Visit[]

  @@index([tripId])
}

model Visit {
  id         String   @id @default(cuid())
  placeId    String
  arrivedAt  DateTime
  departedAt DateTime
  /// Position in the trip's chronological order, starting at 0.
  sequence   Int

  place  Place   @relation(fields: [placeId], references: [id], onDelete: Cascade)
  photos Photo[]

  @@index([placeId, arrivedAt])
}

model Photo {
  id           String  @id @default(cuid())
  tripId       String
  /// Null until clustering assigns the photo to a visit, and set back to null
  /// if that visit is later removed.
  visitId      String?

  cloudinaryId String
  url          String
  width        Int
  height       Int
  blurhash     String?

  /// Unsplash's terms require the photographer to be credited with a link
  /// wherever the photograph is shown.
  photographerName String?
  photographerUrl  String?

  takenAt   DateTime?
  lat       Float?
  lng       Float?
  gpsSource GpsSource @default(NONE)
  createdAt DateTime  @default(now())

  trip  Trip   @relation(fields: [tripId], references: [id], onDelete: Cascade)
  visit Visit? @relation(fields: [visitId], references: [id], onDelete: SetNull)

  @@index([tripId, takenAt])
}
```

`Photo.visitId` is `onDelete: SetNull` on purpose. Deleting a place is a statement that the *grouping* was wrong, not that the photographs were — so they return to the trip unassigned rather than being destroyed.

## Engineering notes

What follows is what was measured, not what was assumed.

### Clustering

DBSCAN, written from scratch rather than pulled from a library, over the photographs that carry GPS. Density-based because the number of places is not known in advance and k-means would demand it; because clusters are whatever shape a piazza is; and because photographs taken walking between places should be left out rather than forced into the nearest one.

Distance is **haversine, in metres** — not Euclidean distance over raw degrees. A degree of longitude is about 111km at the equator and nothing at all at the poles, so a radius expressed in degrees is an ellipse on the ground that stretches as you move away from the equator. At Rome's latitude it is already 34% wider east-to-west than north-to-south. Measuring in metres means a 60m radius is 60m everywhere.

`npm run evaluate:clustering` scores the pipeline against the generator's ground truth and sweeps the parameters. At **ε=60m, minPoints=4** it reaches **94% photo accuracy and 96% pairwise F1**.

The finding worth stating plainly is that **no single global epsilon fits a real trip.** Epsilon has to satisfy two constraints at once: it must be *smaller* than the gap to the nearest neighbouring place, or the two merge; and *larger* than the spread of the widest place, or that place shatters. On this data those constraints are incompatible — there is no value that satisfies both everywhere, and 94% is what the best compromise buys. A variable-density algorithm is the real fix: **OPTICS or HDBSCAN**, which derive a neighbourhood scale per cluster instead of taking one as a parameter.

The failure is visible in the demo. Lisbon's **Tram 28 fragments into four places**, because a tram route is a line several hundred metres long, not a dense blob — a photograph taken at one end has no near neighbours at the other. No epsilon fixes that, because the object is not a cluster. In the other direction, Athens' Acropolis and Parthenon sit 88m apart and merge into one place at any epsilon wide enough to hold the Acropolis together.

The manual corrections exist because of this. Clustering is a heuristic over data that is itself only accurate to a few metres, and being able to fix its answers by hand is what makes an imperfect algorithm shippable rather than something to keep tuning.

### Temporal splitting

Clustering alone cannot tell Monday from Thursday: the same café on both mornings is one set of coordinates. Each cluster is therefore cut back along the time axis wherever a gap longer than 90 minutes appears, and each fragment becomes a `Visit`.

That is what makes a return visit a return, rather than one implausible nine-hour stay. It is also why `Place` and `Visit` are separate tables and not one.

### GPS interpolation

About one photograph in seven arrives with no position — location services off, a screenshot, a messaging app that stripped the metadata. Those photographs are placed by interpolating along the great circle between the nearest positioned neighbours in time.

It **refuses rather than guesses** when the surrounding gap is longer than two hours: a photograph between a morning in one district and an evening in another could have been taken anywhere in between, and a confident wrong answer is worse than an honest gap. Those stay unplaced.

Measured on the Rome dataset: **51 of 56 unpositioned photographs recovered, at a median error of 26m** — comfortably inside a place, which is all the accuracy the clustering needs. The five refusals are the ones spanning a long enough gap that no answer would have meant anything.

### Place naming

Reverse geocoding answers the question "what address is here", and that is the wrong question. Addresses are streets and house numbers, so a centroid resolves to whatever is nearest rather than to what it is standing in — the Colosseum's centroid comes back as a **defibrillator** registered inside it.

The fix is to ask a different question first. An Overpass query fetches named features near the centroid *with their geometry*, and ranks them primarily by **polygon containment**: if the centroid falls inside a named area, that area is the place. Ties go to the smallest containing polygon, so the answer is the most specific thing that actually encloses the point. Features that are things *inside* places rather than places — memorials, artworks, fountains, entrances — are demoted, so a piazza beats the statue standing in the middle of it. Reverse geocoding remains only as the fallback when nothing contains the point at all.

Ranking by distance alone, before containment was added, left five of Rome's eleven places named after something inside them. Containment fixes most of that, and it does not fix all of it: three of the eleven on the live demo still carry the name of a feature rather than the place — the statue in Campo de' Fiori, the fountain in Piazza Navona, and a basilica within the Forum. Where the containing polygon is not in OpenStreetMap, there is nothing for the ranking to find. Those are what the manual corrections are for.

### A caching bug worth recording

Nominatim allows one request a second, so results are cached by rounded coordinate. The first version cached whatever came back — including failures.

A single transient error therefore became permanent. The place was written with a degraded fallback name, the cache recorded that as the answer, and every subsequent run read it back without asking again. The whole point of a cache is that it never asks twice, which is exactly what makes it the wrong place to put a temporary failure. Only real answers are cached now; a failure leaves nothing behind, so the next run tries again.

### An unmount bug worth recording

Navigating away from a trip page broke the page being navigated *to*: `/trips` would render blank, and Next reported it as "This page couldn't load".

The cause was in neither page. `TripMap` has two effects — one creating the Mapbox instance, one adding markers and the route. React runs a component's cleanups in the order the effects were **declared**, so on unmount the first called `map.remove()`, destroying the map's style, and the second then called `map.getLayer()`, which reads a property off the style that no longer existed and threw.

An exception thrown during unmount takes the React tree down with it. So a mistake in the teardown of the page being *left* surfaced as a failure on the page being *arrived at*, which is a long way from where anyone would look — and it only ever happened on client-side navigation, because a full page load has no previous tree to unmount. The fix is a guard: skip the layer teardown when the map is already gone. Nothing leaks, because `map.remove()` disposes its own layers.

Two general lessons, both now in comments at the site of the bug: cleanup order within a component is declaration order, not reverse; and an error during unmount is attributed to the wrong page.

## Running locally

### Services

| Service | Needed for | Notes |
| --- | --- | --- |
| [Neon](https://neon.tech) | everything | Any PostgreSQL works. Copy the pooled connection string. |
| [Mapbox](https://mapbox.com) | the map | Free tier is plenty. Without a token the trip page renders the timeline and explains what is missing. |
| [Unsplash](https://unsplash.com/developers) | rebuilding the demo photography | Only to regenerate the committed caches. Seeding works without it. |
| [Cloudinary](https://cloudinary.com) | nothing yet | Configured for the unimplemented upload pipeline. |

### Environment

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL. Prisma 7 talks to it through the `pg` driver adapter. |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | for the map | Public token. |
| `ADMIN_PASSWORD` | for editing | The owner's password. Unset means nobody can sign in and the site is read-only. |
| `SESSION_SECRET` | for editing | At least 32 characters, and secret. `openssl rand -base64 24`. |
| `UNSPLASH_ACCESS_KEY` | to refetch photos | Register a free application. |
| `NOMINATIM_CONTACT` | politeness | An email or project URL, sent in the User-Agent so an operator can reach you rather than block you. |
| `OVERPASS_ENDPOINT` | optional | A mirror or your own instance. Defaults to the public one, which is free and frequently saturated. |
| `CLOUDINARY_CLOUD_NAME` | optional | Unused until upload is built. |
| `CLOUDINARY_API_KEY` | optional | As above. |
| `CLOUDINARY_API_SECRET` | optional | As above. |
| `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME` | optional | As above. |
| `ALLOW_EDITS` | development only | Exactly `true` unlocks editing with no password. Ignored when `NODE_ENV=production`. |
| `NEXT_PUBLIC_FEATURED_TRIP` | optional | Slug of the trip the home page links to directly. Defaults to `rome-may-2026`. |
| `NEXT_PUBLIC_GITHUB_URL` | optional | Footer link. |

### Setup

```bash
npm install
cp .env.example .env      # then fill it in
npm run db:generate       # generate the Prisma client
npm run db:push           # create the schema
npm run seed:all          # build every demo trip
npm run dev
```

`npm run db:apply` is an alternative to `db:push` for machines where Prisma's native schema engine cannot run; it applies the same schema as idempotent raw DDL.

### Building a trip from scratch

Each demo trip starts as an itinerary in `data/itineraries/<city>.json` — a name, a date range, a UTC offset, and an ordered list of real places with coordinates, visit durations and photograph counts. Three commands turn one into a browsable trip, and each takes `--city`:

```bash
npx tsx scripts/generate-trip.ts   --city lisbon   # -> data/lisbon-trip.json
npx tsx scripts/fetch-unsplash.ts  --city lisbon   # -> data/unsplash-lisbon.json
npx tsx scripts/seed-demo-trip.ts  --city lisbon   # -> /lisbon-march-2026
```

Adding a fifth city means writing a fifth itinerary and running those three.

### Rate limits

Both matter, and both are enforced in the code rather than left to luck.

- **Unsplash allows 50 requests an hour** on the demo tier, and one city costs roughly 25. Four cities cannot be fetched in one sitting. A run that exhausts the budget writes the buckets it filled and names the ones it did not; running it again later merges into what is already on disk rather than starting over. The caches are committed, so seeding needs no key at all.
- **Nominatim allows one request a second**, and Overpass expects the same courtesy. Both are free services run by volunteers. A serialising limiter enforces the spacing, and every result is cached by rounded coordinate so the same place is never looked up twice. This is why `npm run seed:all` runs every city inside one process: the limiter is per-process, and seeding cities as separate processes would run several limiters at once and hit those services at several times the agreed rate.

### Other commands

| Command | What it does |
| --- | --- |
| `npm run seed:all` | Rebuilds every trip in one process. `-- --only rome,athens` narrows it. |
| `npm run seed:demo` | Rebuilds one trip: `-- --city athens`. |
| `npm run generate:trip` | Regenerates one city's dataset from its itinerary. Seeded, so the same seed gives the same trip. |
| `npm run fetch:unsplash` | Rebuilds one city's photography cache. Skips buckets already cached. |
| `npm run evaluate:clustering` | Scores clustering against ground truth. `--sweep` tries every parameter combination. |
| `npm run typecheck` | `next typegen` then `tsc --noEmit`. |

## Owner access

Roam has one writer and any number of readers. That is narrow enough that a full identity system would be more code than the problem deserves: there are no accounts to create, no roles to resolve, nothing to reset. One password and one signed cookie is the whole of it.

Sign in at `/admin`. A correct password sets a session cookie; five wrong ones in fifteen minutes locks that address out, and the error is the same sentence either way, so a failed guess reveals nothing. Once signed in, every page carries an "Owner" indicator in the navigation bar with sign-out beside it, and `/admin` states the date the session expires.

The cookie is:

| Flag | Value | Why |
| --- | --- | --- |
| `httpOnly` | true | Unreadable from JavaScript, so an XSS bug cannot exfiltrate the session. |
| `secure` | true in production | Never sent over plain HTTP. Off in development so it works on `localhost`. |
| `sameSite` | `Lax` | Not sent on cross-site POSTs, which is the CSRF case that matters. |
| `path` | `/` | The session applies to the whole site. |
| `maxAge` | 30 days | Long, because it is one person on their own machine. |

It carries a version marker, an expiry and a nonce, signed with HMAC-SHA256 over `SESSION_SECRET`. The signature proves the cookie was minted by this deployment: the expiry cannot be pushed forward and the token cannot be forged without the secret. It is a signature, not encryption — nothing secret is in the payload, because nothing secret needs to be.

Every mutation verifies the cookie on the server. The corrections panel hiding its controls from a signed-out visitor is a courtesy; the 403 from the API is the enforcement.

### Losing a device

Sessions are **stateless by design** — nothing is stored server-side, so there is no session table, no cleanup job, and no database round trip on the path of every mutation. The trade-off is real and worth stating: **an individual session cannot be revoked.** Signing out clears the cookie in that browser, but a copy taken beforehand stays valid until its thirty days are up.

If a device is lost or a session is believed compromised, the remedy is to **rotate `SESSION_SECRET` in the environment and redeploy.** Every outstanding token then fails its signature check at once, and every browser is signed out — including yours. Changing `ADMIN_PASSWORD` alone does *not* do this: it stops new sign-ins, but existing cookies are already signed and keep working.

## Known limitations

- **Photo upload is designed but not implemented.** `/upload` has a working drag-and-drop zone, a file list with thumbnails and sizes read in the browser, and a trip selector — and then the import button reports that there is no pipeline behind it. Nothing is uploaded and no trip is changed. The page says so at the top rather than after you have spent ten minutes selecting photographs. The four steps behind it would be: read EXIF in the browser, resize before upload, store on Cloudinary, then run the same `ingestTrip` clustering the demo trips went through.
- **The demo trips are synthetic.** The coordinates are real and so are the places, but the photographs and their EXIF are generated by `scripts/generate-trip.ts`, which is in the repository and seeded so the same seed gives the same trip. The imagery is real Unsplash photography of the actual places, credited to its photographers, but it is not the output of a real camera roll.
- **One UTC offset per trip.** `Trip.utcOffsetMinutes` is a single number, which is wrong for a trip crossing time zones — an overnight train from Rome to Paris would file its photographs under the wrong local day at one end. Handling it properly means an offset per photograph, derived from EXIF local timestamps compared against the UTC instant.
- **The rate limiters are per-process.** Both the outbound geocoding limiter and the sign-in attempt limiter live in module state. Two server instances would each keep their own, so the outbound rate doubles and five sign-in attempts become ten. For a single-instance deployment this is right-sized; anything larger wants a shared store such as a Redis token bucket.
- **The trips index cache is per-process too**, with a five-minute TTL. A correction made against one instance is invisible to the others until their window expires.

## Attribution

- Photographs from [Unsplash](https://unsplash.com), each credited to its photographer with the referral links Unsplash's API terms require. Images are hotlinked from Unsplash rather than copied.
- Place names and geocoding from [OpenStreetMap](https://www.openstreetmap.org/copyright), via Nominatim and Overpass. Map data © OpenStreetMap contributors, available under the Open Database License.
- Map rendering by [Mapbox](https://www.mapbox.com/about/maps/).

## Other repositories

- [fx-convert](https://github.com/AtaMusleh/fx-convert)
- [linksnip](https://github.com/AtaMusleh/linksnip)
- [taskflow-api](https://github.com/AtaMusleh/taskflow-api)
