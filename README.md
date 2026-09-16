# Forest Explorer

A map-based tool for finding good mushroom/berry foraging spots in Norway.
Click anywhere on the map and it scores the surrounding area by combining
real terrain (slope, aspect, elevation), weather history (recent rainfall,
temperature, humidity, wind), and forest-cover data (species, land type,
canopy density) into a single suitability score, tunable per foraging
target (chanterelles, ceps, blueberries, lingonberries, cloudberries, or a
general blend).

**[Live demo](https://forest-explorer-nine.vercel.app)**

## What it does

- **Composite scoring:** weather, rainfall recency, forest type, and terrain
  (slope/aspect/wetness) combine into one 0–1 suitability score per point,
  re-weighted by zoom level and foraging target.
- **Per-layer breakdown:** toggle any individual signal (temperature,
  humidity, wind, solar radiation, VPD, topographic wetness index, forest
  type) as its own heatmap or grid overlay, not just the blended score.
- **Top-spot highlighting:** the best-scoring points within your chosen
  radius are marked distinctly on the map.
- **Protected-area awareness:** national parks, nature reserves, and
  landscape protection areas are excluded from suggestions entirely, with a
  visible boundary and explanation rather than an unexplained gap.
- **Reference overlays:** stand-age class, crown cover, and historical
  clear-cut data shown as raw map layers for context.

## Data sources

- [MET Norway](https://www.met.no/): Locationforecast (forward-looking
  weather) and Frost (real historical station observations)
- [NIBIO](https://www.nibio.no/): AR5 land-cover classification and SR16
  forest-resource maps (tree species, crown cover, stand age)
- [Miljødirektoratet](https://www.miljodirektoratet.no/): protected-areas
  register and historical harvest/clear-cut satellite data
- Terrain elevation via [Mapbox](https://www.mapbox.com/) Terrain-RGB tiles

None of this data is redistributed. The app queries these services live.

## Tech stack

React 19 + TypeScript + Vite, Leaflet/react-leaflet for the map, TanStack
Query for data fetching, Vitest for unit tests, Playwright for e2e.

## Running it locally

```bash
npm install
cp .env.example .env   # see below for what to fill in
npm run dev
```

The app works with `.env` completely empty: every external data source
degrades gracefully rather than crashing. Two optional keys unlock more:

- `VITE_MAPBOX_TOKEN`: real terrain (slope/aspect/elevation). Without it,
  terrain scoring is simply skipped. Get a free one at
  [account.mapbox.com](https://account.mapbox.com/).
- `FROST_CLIENT_ID`: real historical weather-station observations instead
  of forecast-derived estimates. Free at
  [frost.met.no](https://frost.met.no/auth/requestCredentials.html).

See `.env.example` for details on both.

## Other commands

```bash
npm run build       # production build
npm run typecheck   # tsc --noEmit
npm run lint         # eslint
npm test             # vitest
npm run test:e2e     # playwright (hits live upstream APIs, no mocking)
```

The e2e suite deliberately hits real upstream APIs (thredds.met.no, Frost, Yr)
instead of mocking them. Two real bugs this project hit only ever showed up
against the live network: a CORS failure invisible to Node's fetch, and a
query-encoding bug that only broke against the real server. No mocked test
would have caught either before shipping.

## Deployment

Configured for [Vercel](https://vercel.com/): the `/api/*` routes in this
repo are serverless functions mirroring the same proxies the Vite dev server
runs locally (see `api/` and `server/`), so no code changes are needed
between environments. Push to GitHub, import the repo in Vercel, and set
`VITE_MAPBOX_TOKEN`/`FROST_CLIENT_ID` under Project Settings → Environment
Variables (both are optional, same as local dev).

If you set a Mapbox token, restrict it to your deployed domain under your
Mapbox account's token settings. It's a public-type token that ends up in
the shipped client JS either way, so the restriction, not secrecy, is what
actually limits misuse.

## Project notes

`TODO.md` tracks known gaps and open investigations: a land-mask edge case,
ongoing work on detecting recently-disturbed stands.
