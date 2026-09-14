# TODO

## Repo hygiene: initialize git

This directory has never been a git repository — no version history, no
revert path, nothing to diff against. From the 2026-09-14 audit:

1. ~~Add `.claude/settings.local.json` and `.claude/scheduled_tasks.lock` to
   `.gitignore` first~~ — done (`.gitignore` also now covers `.vercel/`).
2. `git init`, confirm `git status` doesn't show `.env`, `node_modules`,
   `test-results`, or the local-only files above.
3. ~~Add a minimal README~~ — done (`README.md`, written for the public repo
   this is about to become). Still open: a CI workflow running
   `tsc --noEmit` + `vitest run` + `playwright test`.

## Land-mask gap: Tjøme / southern Nøtterøy show no map data

`src/lib/water/norway-land.json` (the simplified coastline polygon used by
`isLand()` in `waterExclusion.ts`) is missing land coverage for Tjøme and the
southern part of Nøtterøy (Torød) — confirmed live by testing real
coordinates across the island (village center, Verdens Ende, the bridge
connection, several other spots) against the actual polygon: all came back
`WATER`. Since `loadGridData.ts` filters every candidate grid point through
`isLand()` before any weather/terrain/forest fetching happens, this means
zero points ever get generated there — no heatmap, no grid dots, nothing.

Northern Nøtterøy (near the Tønsberg bridge) and other tested peninsulas
elsewhere in Norway (Hurum, Nesodden) work fine, so this isn't a general
"small islands get lost" problem — something specific to this stretch of
coastline is missing or was dropped from whatever process produced
`norway-land.json`. No generation script or documented source exists in the
repo for that file, so it can't just be re-run with a gentler simplification
tolerance.

**Fix options (not yet decided):**
1. Scoped patch — fetch the real coastline for just this area (e.g. via
   OpenStreetMap's Overpass API) and merge it into the existing polygon with
   a turf union. Fast, fixes exactly what was found, but doesn't rule out
   similar gaps elsewhere in Norway's coastline that haven't been tested.
2. Full regeneration — source a proper coastline dataset for all of Norway
   (OSM coastline extract, Kartverket, or Natural Earth) and reprocess/
   simplify it from scratch with a tolerance tuned to preserve smaller
   islands. More thorough (would catch any other similar gaps), but a bigger
   job — needs a data source decision and broad re-verification, not just at
   this one spot.

## Stand-disturbance detection: data sources investigated

Triggered by a field trip that scored ~0.9/1.0 composite but turned out to
have been recently thinned (branch/slash debris everywhere, hard to walk,
almost no mushrooms). Goal: find a data source that can flag "this forest
was recently cut/thinned" — either as a map overlay or eventually wired into
`forestScore.ts`. Three reference-overlay layers were added to
`ReferenceOverlays`/`LayerControls.tsx`/`MapView.tsx` as pure visual WMS
layers (no scoring changes) so the signals could be eyeballed before
deciding whether any are worth integrating. Findings so far:

**A second, independent field trip confirmed the hogstklasse and
recent-cut-satellite blind spots live, twice over** (details in a local,
git-ignored field-notes log — not part of this repo): two points, both
recently disturbed (one thinned, one cut), both read as ordinary mature
forest with no disturbance signal from any data source checked (hogstklasse
5 at one; the satellite layer showed stale 2010/2017 records at both,
missing the real 2026 events entirely). The two points had very different
foraging outcomes despite the identical blind spot, so whatever actually
distinguishes them isn't something this list's sources can see yet — cut
*type* and tree *species* are the more promising open threads, not recency
of disturbance.

- **Hogstklasse** (NIBIO `skogbruksplan` WMS, layer `hogstklasser`) — a
  5-class harvest/age-class system (HKL1=bare/regenerating through
  HKL5=mature). **Not useful for "recently thinned"**: thinning is a normal
  operation *within* HKL3/4 and doesn't change the class, so a freshly
  thinned mature stand still reads as mature. Only catches young/clear-cut
  stands (HKL1-2), not thinning.
- **Crown cover** (NIBIO `sr16` WMS, layer `SRRKRONEDEK`) — LiDAR-derived
  canopy-density %, 16×16m resolution. **Not time-queryable** — confirmed via
  GetCapabilities, no time dimension, no year-versioned layers, just NIBIO's
  current SR16 snapshot. Also too noisy in practice: normal mature forest
  already has patchy 40-70% crown cover, so there's no clean threshold that
  separates "recently opened" from ordinary variation.
- **Recent clear-cuts by year** (Miljødirektoratet "Naturskog v1" WMS, layer
  `stoettelag_hogst_satelitt`, `https://image001.miljodirektoratet.no/arcgis/services/naturskog/naturskog_v1/MapServer/WMSServer`)
  — the best one found: satellite-derived, **actual per-pixel harvest year**
  (confirmed via GetFeatureInfo, e.g. returns `2012`, `2021` directly),
  covering 1985–2024. **Frozen at 2024** — Miljødirektoratet/Landbruksdirektoratet
  have a 2025-2026 development mandate, v2 not expected until end of 2026, so
  nothing cut in 2025/2026 (i.e. anything actually "recent" right now) is in
  it. Tried filtering the overlay to show only the last 2 years of the
  available range (2023-2024): no clean way to do this server-side — the
  service's REST `export`/`dynamicLayers`/`renderingRule` operations all
  return 403 (locked down, WMS-only public access), and OGC `SLD_BODY`
  wasn't confirmed working either. Client-side pixel-color filtering was
  considered but rejected as too hacky/imprecise (color is a continuous
  39-year gradient, can't reliably threshold "last 2 years" from RGB alone
  without the real per-pixel values, which WMS GetMap doesn't expose in
  bulk). Currently shown as the full unfiltered gradient.
- **GLAD / RADD near-real-time deforestation alerts** (Global Forest Watch)
  — confirmed **tropical-only** (~30°N to 30°S), does not cover Norway at
  all. Dead end, not worth revisiting unless GFW extends coverage.
- **NIBIO "hogstflater" as a standalone dataset, Sentinel-2/Landsat DIY
  change detection** — no confirmed public WMS/API found; DIY change
  detection from raw Copernicus imagery would be a materially bigger project
  than anything else in this app.

**Untapped layers in the same Miljødirektoratet "Naturskog v1" service**,
not yet added as overlays but worth a look — these flip the question from
"was this damaged?" to "is this a well-established, undisturbed stand?",
which may correlate with good foraging ground better than any disturbance
signal tried so far:
- `skog_etablert_foer_1940_ikke_flatehogd` — binary Ja/Nei: forest
  established before 1940 and never clear-cut.
- `naturskogssannsynlighet` — continuous 0-100% "natural forest probability".
- `naturskogsnaerhet` — 1-7 "natural forest proximity/closeness" (more of a
  landscape-context metric, less directly useful for a single point).
- `stoettelag_hogst_flybilde` — same idea as the satellite layer but
  aerial-photo-based, covering 1950-1989 (older sibling, doesn't help with
  "recent").

**Current state:** three overlays live (`hogstklasser`, `crownCover`,
`recentCutSatellite` in `ReferenceOverlays`), visual-only, not wired into
scoring. No data source found yet that reliably answers "was this cut in
the last few months" for Norway. Revisit if Miljødirektoratet ships
Naturskog v2 (expected end of 2026), or if it's worth trying the two
untapped "natural forest" layers above as a positive-signal alternative to
chasing disturbance detection further.
