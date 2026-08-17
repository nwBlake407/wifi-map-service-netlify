# vn-wifi-collector

Collects **publicly available** information about Wi-Fi / internet access
points and related places in Vietnam (or any bounding box), for mapping and
analysis use cases such as a Wi-Fi map service.

- **Primary source:** OpenStreetMap via the Overpass API — no authentication,
  no API key. Collects nodes/ways/relations tagged `internet_access=wlan|yes|terminal`,
  `amenity=internet_cafe`, or `wifi=yes`.
- **Optional enrichment:** supply a CSV/JSON list of BSSIDs you are authorized
  to query and each is looked up via the free, keyless
  [Mylnikov Geo API](https://api.mylnikov.org/) for approximate coordinates,
  plus vendor enrichment from a local OUI table.

## Install & run

```bash
npm install          # commander + pino (script also runs without them)
node collect-wifi.mjs --dry-run
node collect-wifi.mjs -v -o out/wifi_vn.csv          # full Vietnam run
npm run smoke                                         # 1-tile HCMC smoke test
```

Requires Node.js ≥ 18 (native `fetch`). Interrupted runs checkpoint
automatically after every tile — re-run the same command to resume; use
`--fresh` to discard previous partial state.

## Key options

| Option | Default | Meaning |
|---|---|---|
| `--bbox s,w,n,e` | `8.0,102.0,23.5,110.0` | bounding box override |
| `--tile-size deg` | `1` | Overpass tile size (0.05–5) |
| `--max-results n` | unlimited | stop after n unique records |
| `--output path` | `wifi_vn.csv` | CSV path; `.json`, `.jsonl`, `.ckpt.json`, `.summary.json` derived |
| `--dry-run` | – | enumerate tiles, print sample query, no network |
| `--bssid-list path` | – | opt-in BSSID CSV/JSON for Mylnikov lookup |
| `--oui-file path` | – | IEEE `oui.csv` for authoritative vendor lookup |
| `--sqlite path` | – | also export SQLite (needs `better-sqlite3`) |
| `--require-pattern` | off | export only rows matching VN WiFi patterns (Viettel, VNPT, FPT, "Free WiFi", "WiFi miễn phí", …) |
| `--include-legacy-wifi` | off | also query the legacy `wifi=yes` tag — unindexed key, often dispatcher-timeouts on public mirrors |
| `--endpoint url` | overpass-api.de | mirror override (kumi.systems, private.coffee) |
| `--sleep-ms`, `--max-attempts`, `--overpass-timeout` | 2000 / 5 / 180 | rate-limit handling |
| `-v` / `-vv` | info | debug / trace logging (structured JSON via pino) |
| `--sample-tiles n` | – | smoke tests |
| `--fresh`, `--checkpoint path`, `--contact email` | – | state & politeness |

Exit codes: `0` OK · `1` fatal · `2` usage · `3` finished with failed
tiles/BSSID lookups · `130` interrupted.

## Output

CSV columns (also the SQLite/JSON fields):
`osm_id, osm_type, name, ssid_hint, internet_access, amenity, wifi, operator,
lat, lon, vendor, bssid, country, region, first_seen, last_seen,
matched_patterns, source, tags`

- Rows are deduplicated by `osm_type/osm_id` (or normalized BSSID).
- `last_seen` is the OSM last-edit timestamp; `first_seen` is generally not
  available from Overpass (only for BSSID rows = collection date).
- `matched_patterns` lists VN ISP / public-WiFi brand hits (Viettel, VNPT,
  FPT, "Free WiFi", "WiFi miễn phí", internet-café patterns, …).

## Legal & ethical use

- Uses only public, user-contributed OSM data (ODbL) and free keyless lookup
  endpoints. Credit **“© OpenStreetMap contributors”** when redistributing
  OSM-derived records.
- The BSSID path is opt-in and only looks up MACs **you supply and are
  entitled to query**; the script never generates or harvests BSSIDs.
- **This tool never requires (or asks for) a WiGLE API name + token.**

## Rate-limit awareness

Sequential tiles with a pause between requests, exponential back-off with
jitter on HTTP 429/5xx/overload pages (honouring `Retry-After`), and
recursive quadrant-splitting when Overpass returns a "remark" (partial
result). Please keep `--sleep-ms` ≥ 2 s against the public endpoints.

## Limitations

- OSM gives you **locations of places that offer public Wi-Fi** (cafés,
  libraries, hotels, internet cafés…), **not** full BSSID/SSID/encryption/
  channel datasets. For AP-level data, a registered **WiGLE** account remains
  the de-facto source — that is intentionally out of scope here.
- Mylnikov BSSID coordinates are crowd-sourced approximations.
- The built-in OUI table is illustrative only; pass `--oui-file` with the
  IEEE Registration Authority `oui.csv` (or `npm i oui`) for real coverage.
