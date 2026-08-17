#!/usr/bin/env node
/**
 * ============================================================================
 * vn-wifi-collector — public Wi-Fi / internet access point collector (Vietnam)
 * ============================================================================
 *
 * Collects *publicly available* information about places offering Wi-Fi /
 * internet access in Vietnam (or any bounding box you choose).
 *
 * PRIMARY SOURCE (no authentication, no API key):
 *   OpenStreetMap via the Overpass API — nodes/ways/relations tagged with
 *   internet_access=wlan|yes|terminal or amenity=internet_cafe (the legacy
 *   wifi=yes key is opt-in via --include-legacy-wifi: it is unindexed and
 *   often dispatcher-timeouts public mirrors).
 *
 * OPTIONAL SECONDARY ENRICHMENT (no authentication):
 *   If you supply a CSV/JSON list of BSSIDs you are authorized to query,
 *   each one is looked up via the free, keyless Mylnikov Geo API
 *   (https://api.mylnikov.org/) for approximate coordinates, and enriched
 *   with a vendor string from a local OUI table (IEEE oui.csv, the `oui`
 *   npm package if installed, or a tiny built-in fallback table).
 *
 * ---------------------------------------------------------------------------
 * LEGAL / ETHICAL USE
 * ---------------------------------------------------------------------------
 * - Only public, user-contributed OpenStreetMap data (ODbL licence) and free,
 *   keyless public lookup endpoints are used. If you redistribute OSM-derived
 *   records, credit "© OpenStreetMap contributors" under ODbL.
 * - The BSSID path is strictly opt-in: the script never generates, harvests
 *   or guesses BSSIDs — it only looks up MACs *you* supply and are entitled
 *   to query (e.g. your own fleet).
 * - This script NEVER requires (and never asks for) a WiGLE API name+token.
 *
 * ---------------------------------------------------------------------------
 * RATE-LIMIT AWARENESS
 * ---------------------------------------------------------------------------
 * - The country is split into small tiles (default 1°) so each Overpass query
 *   stays well inside timeouts; tiles run strictly sequentially with a pause
 *   between requests (default 2 s).
 * - HTTP 429 / 5xx / overload responses trigger exponential back-off with
 *   jitter (base 5 s, cap 120 s), honouring any `Retry-After` header.
 * - Overpass "remark" (partial result) responses cause the tile to be split
 *   into quadrants and retried, up to 3 levels deep.
 * - Set a descriptive `--contact` so maintainers can reach you if needed.
 *
 * ---------------------------------------------------------------------------
 * LIMITATIONS (read this)
 * ---------------------------------------------------------------------------
 * - OSM gives you *locations of places that offer public Wi-Fi* (cafés,
 *   libraries, hotels, internet cafés…), NOT full BSSID/SSID/encryption/
 *   channel datasets. For AP-level data, a registered WiGLE account remains
 *   the de-facto source; that is intentionally out of scope here.
 * - `first_seen` is generally unavailable: Overpass only exposes the element's
 *   *last edit* timestamp, which is exported as `last_seen`.
 * - BSSID coordinates from Mylnikov are crowd-sourced approximations.
 *
 * ---------------------------------------------------------------------------
 * QUICK START
 * ---------------------------------------------------------------------------
 *   npm install                 # commander + pino (script also runs without
 *                               # them, using built-in fallbacks)
 *   node collect-wifi.mjs --dry-run
 *   node collect-wifi.mjs -v -o out/wifi_vn.csv
 *   node collect-wifi.mjs --bssid-list examples/bssids.example.csv \
 *        --oui-file ~/Downloads/oui.csv
 *
 * Interrupted runs checkpoint automatically; simply re-run the same command
 * to resume where you left off (`--fresh` discards previous partial state).
 * Exit codes: 0 = OK, 1 = fatal error, 2 = usage error, 3 = finished but
 * with some failed tiles/BSSID lookups, 130 = interrupted (Ctrl-C).
 * ============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';

// ────────────────────────────── constants ─────────────────────────────────

const TOOL = 'vn-wifi-collector';
const VERSION = '1.0.0';

/** Approximate Vietnam bounding box (lat 8.0–23.5, lon 102.0–110.0). */
const DEFAULT_BBOX = { south: 8.0, west: 102.0, north: 23.5, east: 110.0 };

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const MYLNIKOV_URL = 'https://api.mylnikov.org/geolocation/wifi';

/** Max times a "remark"-carrying tile is split into quadrants (size / 2^depth). */
const MAX_SPLIT_DEPTH = 3;
// Public mirrors intermittently answer with dispatcher "server is probably
// too busy" pages even for small queries, so prefer several quick retries
// across rotating mirrors over a few long waits.
const BACKOFF_BASE_MS = 3_000;
const BACKOFF_MAX_MS = 60_000;

/**
 * Specific Vietnamese internet service providers. Each record is matched
 * against these and carries the result in a dedicated `isp` field
 * ('Unknown' when nothing matches).
 */
const VN_ISPS = [
  { label: 'Viettel', re: /viettel/i },
  { label: 'VNPT', re: /vnpt|vinaphone/i },
  { label: 'FPT', re: /\bfpt\b/i },
  { label: 'CMC', re: /\bcmc\b|cmc\s*telecom/i },
  { label: 'SCTV', re: /sctv/i },
  { label: 'NetNam', re: /netnam/i },
  { label: 'MobiFone', re: /mobifone|mobi\s?fone/i },
  { label: 'Vietnamese Government Free WiFi', re: /free\s*wi[\s-]?fi|wi[\s-]?fi\s*(miễn\s*phí|mien\s*phi)/i },
];

/**
 * Vietnam ISP / public-WiFi brand patterns used for post-filtering and
 * enrichment. Matched against name, ssid, operator and the raw tag JSON.
 */
const VN_WIFI_PATTERNS = [
  { label: 'Viettel', re: /viettel/i },
  { label: 'VNPT/VinaPhone', re: /vnpt|vinaphone/i },
  { label: 'FPT', re: /\bfpt\b/i },
  { label: 'SCTV', re: /sctv/i },
  { label: 'MobiFone', re: /mobifone|mobi\s?fone/i },
  { label: 'VinGroup', re: /vin\s?wifi|vinwonder|vinpearl|vinhomes/i },
  { label: 'FreeWiFi', re: /free\s*wi[\s-]?fi/i },
  { label: 'WiFiMienPhi', re: /wi[\s-]?fi\s*(miễn\s*phí|mien\s*phi)/i },
  { label: 'MienPhi', re: /miễn\s*phí|mien\s*phi/i },
  { label: 'InternetCafe', re: /internet\s*caf[eé]|tiệm\s*net|quán\s*net|tiem\s*net|quan\s*net/i },
];

/**
 * Tiny, clearly-illustrative OUI fallback. NOT authoritative — for real
 * coverage pass `--oui-file <ieee oui.csv>` (download from the IEEE
 * Registration Authority, https://standards-ieee.org/products-programs/
 * regauth/oui/) or `npm i oui`.
 */
const BUILTIN_OUI = {
  'B827EB': 'Raspberry Pi Trading',
  'DCA632': 'Raspberry Pi Trading',
  'E45F01': 'Raspberry Pi Trading',
  '28CDC1': 'Raspberry Pi Trading',
  'D83ADD': 'Raspberry Pi Trading',
  '2CCF67': 'Raspberry Pi Trading',
  '001A11': 'Google, Inc.',
  'F09FC2': 'Ubiquiti Networks',
};

const CSV_COLUMNS = [
  'osm_id', 'osm_type', 'name', 'ssid_hint', 'internet_access', 'amenity',
  'wifi', 'operator', 'isp', 'lat', 'lon', 'vendor', 'bssid', 'country', 'region',
  'first_seen', 'last_seen', 'matched_patterns', 'source', 'tags',
];

// ────────────────────────────── JSDoc types ───────────────────────────────

/**
 * @typedef {Object} BBox
 * @property {number} south
 * @property {number} west
 * @property {number} north
 * @property {number} east
 *
 * @typedef {Object} Tile
 * @property {number} s @property {number} w @property {number} n @property {number} e
 *
 * @typedef {Object} OverpassElement
 * @property {'node'|'way'|'relation'} type
 * @property {number} id
 * @property {number} [lat]
 * @property {number} [lon]
 * @property {{lat:number, lon:number}} [center]
 * @property {string} [timestamp]
 * @property {Record<string,string>} [tags]
 *
 * @typedef {Object} WifiRecord
 * @property {string} id unique dedup key ("node/123" or "bssid/AA:BB:..")
 * @property {string} osm_type @property {string} osm_id
 * @property {string} name @property {string} ssid_hint
 * @property {string} internet_access @property {string} amenity @property {string} wifi
 * @property {string} operator
 * @property {string} isp specific Vietnamese ISP ('Viettel', 'VNPT', … or 'Unknown')
 * @property {number|string} lat @property {number|string} lon
 * @property {string} vendor @property {string} bssid
 * @property {string} country @property {string} region
 * @property {string} first_seen @property {string} last_seen
 * @property {string[]} matched_patterns
 * @property {string} source
 * @property {Record<string,string>} tags
 *
 * @typedef {Object} RunContext
 * @property {import('pino').Logger | FallbackLogger} log
 * @property {object} opts validated CLI options
 * @property {string} userAgent
 * @property {string} outClause current Overpass `out` clause (self-heals)
 * @property {{v:boolean}} shutdownFlag
 */

// ────────────────────────────── errors ────────────────────────────────────

class UsageError extends Error {}
class FatalHttpError extends Error {}
class OverpassRemarkError extends Error {
  constructor(remark) { super(`overpass remark: ${remark}`); this.remark = remark; }
}

// ────────────────────────────── small utils ───────────────────────────────

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Exponential back-off with ±20 % jitter. */
function backoffMs(attempt, base = BACKOFF_BASE_MS, max = BACKOFF_MAX_MS) {
  const exp = Math.min(base * 2 ** (attempt - 1), max);
  return Math.round(exp * (0.8 + Math.random() * 0.4));
}

/** Minimal RFC-4180 CSV field escaping. */
function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Parse one line of the IEEE oui.csv (handles quoted commas). */
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (ch === ',' && !inQ) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Atomic JSON write (tmp + rename) so checkpoints never half-write. */
function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// ────────────────────────────── logging ───────────────────────────────────

/** Shape-compatible fallback logger used when `pino` is not installed. */
function fallbackLogger(level) {
  const lvls = { fatal: 60, error: 50, warn: 40, info: 30, debug: 20, trace: 10 };
  const threshold = lvls[level] ?? 30;
  const mk = (lvl) => (obj, msg) => {
    const rec = { level: lvls[lvl], time: Date.now(), ...(typeof obj === 'string' ? { msg: obj } : { ...obj, msg }) };
    if (lvls[lvl] >= threshold) {
      process[lvls[lvl] >= 50 ? 'stderr' : 'stdout'].write(`${JSON.stringify(rec)}\n`);
    }
  };
  return { level, trace: mk('trace'), debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error'), fatal: mk('fatal') };
}

/** Prefer pino (structured JSON lines); degrade gracefully without it. */
async function makeLogger(verbose) {
  const level = verbose >= 2 ? 'trace' : verbose === 1 ? 'debug' : 'info';
  try {
    const { default: pino } = await import('pino');
    return pino({ level, base: { tool: TOOL, version: VERSION } });
  } catch {
    return fallbackLogger(level);
  }
}

// ────────────────────────────── CLI ───────────────────────────────────────

/** Single source of truth for options — feeds commander AND the fallback parser. */
const CLI_SPEC = [
  { short: 'b', long: 'bbox', value: 'south,west,north,east', def: '8.0,102.0,23.5,110.0',
    desc: 'bounding box (default: Vietnam approx.)' },
  { short: 't', long: 'tile-size', value: 'degrees', def: 1.0, coerce: Number,
    desc: 'Overpass tile size in degrees, 0.05–5 (default 1)' },
  { short: 'm', long: 'max-results', value: 'count', def: 0, coerce: Number,
    desc: 'stop after this many unique records (0 = unlimited)' },
  { short: 'o', long: 'output', value: 'path', def: 'wifi_vn.csv',
    desc: 'CSV output path (.json/.jsonl/.ckpt/.summary derived from it)' },
  { short: 'n', long: 'dry-run', def: false,
    desc: 'enumerate tiles and print a sample query without any network calls' },
  { short: 'v', long: 'verbose', def: 0, cumulative: true,
    desc: 'more logging (-vv for trace)' },
  { long: 'bssid-list', value: 'path', def: '',
    desc: 'CSV/JSON list of BSSIDs you are authorized to look up (opt-in)' },
  { long: 'bssid-delay-ms', value: 'ms', def: 350, coerce: Number,
    desc: 'pause between Mylnikov lookups (be polite; default 350)' },
  { long: 'require-pattern', def: false,
    desc: 'export only records matching known VN WiFi patterns' },
  { long: 'include-legacy-wifi', def: false,
    desc: 'also query the legacy wifi=yes tag (unindexed key — often dispatcher-timeouts on public mirrors)' },
  { long: 'endpoint', value: 'url', def: OVERPASS_ENDPOINTS[0],
    desc: `Overpass endpoint (mirrors: ${OVERPASS_ENDPOINTS.slice(1).join(', ')})` },
  { long: 'sleep-ms', value: 'ms', def: 2000, coerce: Number,
    desc: 'pause between tiles (default 2000)' },
  { long: 'max-attempts', value: 'count', def: 8, coerce: Number,
    desc: 'max attempts per Overpass request (default 8; mirrors are flaky)' },
  { long: 'overpass-timeout', value: 'seconds', def: 180, coerce: Number,
    desc: 'per-query Overpass timeout (default 180)' },
  { long: 'checkpoint', value: 'path', def: '',
    desc: 'explicit checkpoint path (default: derived from output)' },
  { long: 'fresh', def: false,
    desc: 'discard existing checkpoint/JSONL for this output and start over' },
  { long: 'oui-file', value: 'path', def: '',
    desc: 'IEEE oui.csv for authoritative vendor lookup' },
  { long: 'sqlite', value: 'path', def: '',
    desc: 'optional SQLite export (requires better-sqlite3)' },
  { long: 'sample-tiles', value: 'count', def: 0, coerce: Number,
    desc: 'process only the first N tiles (smoke tests)' },
  { long: 'contact', value: 'email-or-url', def: '',
    desc: 'contact embedded in the User-Agent (politeness best practice)' },
];

function longToCamel(long) {
  return long.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

async function parseCli(argv) {
  let commander = null;
  try { commander = await import('commander'); } catch { /* fallback below */ }

  if (commander) {
    const { Command } = commander;
    const program = new Command();
    program.name(TOOL).description('Collect public Wi-Fi / internet-access POIs from OpenStreetMap (Overpass) with optional BSSID geolocation enrichment.').version(VERSION);
    for (const o of CLI_SPEC) {
      const flags = `${o.short ? `-${o.short}, ` : ''}--${o.long}${o.value ? ` <${o.value}>` : ''}`;
      // NB: commander's 3rd positional doubles as default when not a function,
      // so pass the default as 3rd arg for options without a coerce fn.
      if (o.cumulative) program.option(flags, o.desc, (_, prev) => prev + 1, o.def);
      else if (o.coerce) program.option(flags, o.desc, o.coerce, o.def);
      else program.option(flags, o.desc, o.def);
    }
    program.addHelpText('after', `

Examples:
  node collect-wifi.mjs --dry-run
  node collect-wifi.mjs -v -o out/wifi_vn.csv --sample-tiles 3
  node collect-wifi.mjs --bssid-list my-aps.csv --oui-file oui.csv
Runs are checkpointed; re-run the same command to resume. Exit codes: 0 OK, 1 fatal, 2 usage, 3 partial, 130 interrupted.`);
    program.parse(argv, { from: 'user' });
    return program.opts();
  }

  // Hand-rolled fallback parser (works without npm install).
  const specByLong = new Map(CLI_SPEC.map((o) => [o.long, o]));
  const specByShort = new Map(CLI_SPEC.filter((o) => o.short).map((o) => [o.short, o]));
  const opts = {};
  for (const o of CLI_SPEC) opts[longToCamel(o.long)] = o.def;

  const help = () => {
    const lines = [`${TOOL} v${VERSION} — collect public Wi-Fi POIs from OSM/Overpass`, '', 'Options:'];
    for (const o of CLI_SPEC) {
      const left = `  ${o.short ? `-${o.short}, ` : '    '}--${o.long}${o.value ? ` <${o.value}>` : ''}`;
      lines.push(`${left.padEnd(38)} ${o.desc}`);
    }
    lines.push('  -h, --help                             show this help');
    console.log(lines.join('\n'));
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { help(); process.exit(0); }
    if (a === '-V' || a === '--version') { console.log(VERSION); process.exit(0); }
    const m = a.match(/^--([a-z0-9-]+)(?:=(.*))?$/);
    let spec = null; let inlineVal;
    if (m) { spec = specByLong.get(m[1]); inlineVal = m[2]; }
    else if (a.startsWith('-') && a.length === 2) { spec = specByShort.get(a.slice(1)); }
    if (!spec) {
      console.error(`Unknown option: ${a}`); help(); process.exit(2);
    }
    const key = longToCamel(spec.long);
    if (spec.cumulative) { opts[key] = (opts[key] || 0) + 1; continue; }
    if (!spec.value) { opts[key] = true; continue; }
    let val = inlineVal;
    if (val === undefined) {
      if (i + 1 >= argv.length) { console.error(`Missing value for --${spec.long}`); process.exit(2); }
      val = argv[++i]; // consume next token even if it starts with '-'
    }
    opts[key] = spec.coerce ? spec.coerce(val) : val;
  }
  return opts;
}

/** Cross-validate and normalize options shared by both parsers. */
function validateOpts(opts) {
  const parts = String(opts.bbox).split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new UsageError(`--bbox must be 4 numbers "south,west,north,east", got: ${opts.bbox}`);
  }
  const [south, west, north, east] = parts;
  if (south >= north || west >= east) throw new UsageError('--bbox: south<north and west<east required');
  if (south < -90 || north > 90 || west < -180 || east > 180) throw new UsageError('--bbox out of terrestrial range');
  if (!Number.isFinite(opts.tileSize) || opts.tileSize < 0.05 || opts.tileSize > 5) {
    throw new UsageError('--tile-size must be between 0.05 and 5 degrees');
  }
  for (const [k, min, max] of [['sleepMs', 0, 600000], ['maxAttempts', 1, 20], ['overpassTimeout', 30, 900], ['bssidDelayMs', 0, 60000], ['maxResults', 0, Infinity], ['sampleTiles', 0, Infinity]]) {
    if (!Number.isFinite(opts[k]) || opts[k] < min || opts[k] > max) throw new UsageError(`--${k.replace(/([A-Z])/g, '-$1').toLowerCase()} must be between ${min} and ${max}`);
  }
  if (!OVERPASS_ENDPOINTS.concat([]).includes(opts.endpoint) && !/^https?:\/\//.test(opts.endpoint)) {
    throw new UsageError('--endpoint must be an http(s) URL');
  }
  return {
    ...opts,
    bbox: { south, west, north, east },
    tileSize: opts.tileSize,
  };
}

// ────────────────────────────── output paths ──────────────────────────────

function derivePaths(output, checkpointOverride) {
  const abs = path.resolve(output);
  const base = abs.replace(/\.[^/.]+$/, '') || abs; // strip one extension
  return {
    csv: abs,
    jsonl: `${base}.jsonl`,
    json: `${base}.json`,
    ckpt: checkpointOverride ? path.resolve(checkpointOverride) : `${base}.ckpt.json`,
    summary: `${base}.summary.json`,
  };
}

// ────────────────────────────── tiling ────────────────────────────────────

/** @param {BBox} bbox @param {number} size @returns {Tile[]} */
function enumerateTiles(bbox, size) {
  const r6 = (v) => +v.toFixed(6);
  const tiles = [];
  for (let s = bbox.south; s < bbox.north - 1e-9; s += size) {
    for (let w = bbox.west; w < bbox.east - 1e-9; w += size) {
      tiles.push({ s: r6(s), w: r6(w), n: r6(Math.min(s + size, bbox.north)), e: r6(Math.min(w + size, bbox.east)) });
    }
  }
  return tiles;
}

const tileKey = (t) => `${t.s},${t.w},${t.n},${t.e}`;

function splitQuadrants(t) {
  const latMid = +((t.s + t.n) / 2).toFixed(6);
  const lonMid = +((t.w + t.e) / 2).toFixed(6);
  return [
    { s: t.s, w: t.w, n: latMid, e: lonMid },
    { s: t.s, w: lonMid, n: latMid, e: t.e },
    { s: latMid, w: t.w, n: t.n, e: lonMid },
    { s: latMid, w: lonMid, n: t.n, e: t.e },
  ];
}

// ────────────────────────────── Overpass ──────────────────────────────────

/**
 * @param {Tile} tile
 * @param {RunContext} ctx
 */
function buildQuery(tile, ctx) {
  const bb = `${tile.s},${tile.w},${tile.n},${tile.e}`;
  const lines = [
    `[out:json][timeout:${ctx.opts.overpassTimeout}];`,
    '(',
    `  nwr["internet_access"~"^(wlan|yes|terminal)$"](${bb});`,
    `  nwr["amenity"="internet_cafe"](${bb});`,
  ];
  // The legacy `wifi=yes` key is not indexed on public Overpass mirrors and
  // reliably triggers dispatcher timeouts, so it is opt-in only.
  if (ctx.opts.includeLegacyWifi) lines.push(`  nwr["wifi"="yes"](${bb});`);
  lines.push(');', ctx.outClause, '');
  return lines.join('\n');
}

/**
 * One Overpass request with exponential back-off. Retryable: 429 (honours
 * Retry-After), 5xx, HTML bodies carrying "runtime error"/dispatcher notices
 * (mirrors sometimes emit these even with HTTP 400), non-JSON 200 bodies,
 * network errors and timeouts. Between attempts the client rotates across
 * the known mirrors (only when the endpoint was not a custom URL). Fatal:
 * genuine 4xx query errors.
 * @param {string} query @param {RunContext} ctx
 */
async function overpassRequest(query, ctx) {
  const { log, opts } = ctx;
  let lastErr = null;
  let lastBody = '';
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    if (ctx.shutdownFlag.v) throw new UsageError('shutdown requested');
    try {
      const endpoint = ctx.endpoints[ctx.endpointIdx];
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), (opts.overpassTimeout + 90) * 1000);
      let res;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            'User-Agent': ctx.userAgent,
          },
          body: `data=${encodeURIComponent(query)}`,
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const text = await res.text();
      const isJson = text.trimStart().startsWith('{');
      // Overpass emits error pages as HTML regardless of the underlying cause
      // (overload, dispatcher failures, and — on flaky mirrors — transient
      // parse failures of perfectly valid queries). Any non-JSON body is
      // therefore retried with mirror rotation; a genuinely broken query
      // fails on every mirror and surfaces via the exhaustion error below.
      if (res.status === 429 || res.status >= 500 || !isJson) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt);
        if (!isJson && res.status !== 429 && res.status < 500) {
          lastBody = `HTTP ${res.status}: ${text.replace(/\s+/g, ' ').slice(0, 500)}`;
        }
        log.warn({ status: res.status, attempt, delayMs: delay }, 'overpass error page — backing off');
        rotateEndpoint(ctx, log);
        await sleep(delay);
        continue;
      }
      if (!res.ok) {
        throw new FatalHttpError(`overpass HTTP ${res.status}: ${text.slice(0, 2000)}`);
      }
      const json = JSON.parse(text);
      if (json.remark) throw new OverpassRemarkError(json.remark);
      return json;
    } catch (err) {
      if (err instanceof FatalHttpError || err instanceof OverpassRemarkError || err instanceof UsageError) throw err;
      lastErr = err; // network / abort / parse-level retryable
      if (attempt < opts.maxAttempts) {
        log.warn({ attempt, err: String(err), delayMs: backoffMs(attempt) }, 'overpass request failed — retrying');
        rotateEndpoint(ctx, log);
        await sleep(backoffMs(attempt));
      }
    }
  }
  throw new FatalHttpError(`overpass: giving up after ${opts.maxAttempts} attempts (last error: ${lastErr || lastBody})`);
}

/** Rotate to the next known mirror (no-op for custom endpoints). */
function rotateEndpoint(ctx, log) {
  if (ctx.endpoints.length < 2) return;
  ctx.endpointIdx = (ctx.endpointIdx + 1) % ctx.endpoints.length;
  log.warn({ endpoint: ctx.endpoints[ctx.endpointIdx] }, 'switching overpass mirror');
}

/**
 * Fetch one tile; on Overpass "remark" (partial results, usually runtime
 * limits) recursively split into quadrants up to MAX_SPLIT_DEPTH.
 * @param {Tile} tile @param {RunContext} ctx @param {number} [depth]
 * @returns {Promise<OverpassElement[]>}
 */
async function fetchTileElements(tile, ctx, depth = 0) {
  const { log } = ctx;
  try {
    const json = await overpassRequest(buildQuery(tile, ctx), ctx);
    return json.elements || [];
  } catch (err) {
    // Self-heal: older mirrors reject `out meta center;` — drop meta once.
    if (err instanceof FatalHttpError && /parse error/i.test(err.message) && ctx.outClause !== 'out center;') {
      ctx.outClause = 'out center;';
      log.warn('mirror rejected "out meta center" — switching to "out center" (no timestamps)');
      return fetchTileElements(tile, ctx, depth);
    }
    if (err instanceof OverpassRemarkError && depth < MAX_SPLIT_DEPTH) {
      log.warn({ tile: tileKey(tile), depth, remark: err.remark }, 'partial result — splitting tile into quadrants');
      const out = [];
      for (const sub of splitQuadrants(tile)) out.push(...(await fetchTileElements(sub, ctx, depth + 1)));
      return out;
    }
    throw err;
  }
}

// ────────────────────────── record mapping ────────────────────────────────

function defaultCountryFor(lat, lon, bboxIsDefault) {
  const inVn = lat >= DEFAULT_BBOX.south && lat <= DEFAULT_BBOX.north
    && lon >= DEFAULT_BBOX.west && lon <= DEFAULT_BBOX.east;
  return bboxIsDefault && inVn ? 'VN' : '';
}

/** Vietnam ISP / brand pattern matching over the textual haystack. */
function matchPatterns(haystack) {
  if (!haystack) return [];
  return VN_WIFI_PATTERNS.filter((p) => p.re.test(haystack)).map((p) => p.label);
}

/** Detect the specific Vietnamese ISP for a record ('Unknown' when no match). */
function detectIsp(haystack) {
  if (haystack) for (const p of VN_ISPS) if (p.re.test(haystack)) return p.label;
  return 'Unknown';
}

/**
 * Map an Overpass element to a WifiRecord (null when it has no usable coords).
 * @param {OverpassElement} el @param {RunContext} ctx
 * @returns {WifiRecord|null}
 */
function elementToRecord(el, ctx) {
  const tags = el.tags || {};
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const name = tags.name || tags['name:vi'] || tags['name:en'] || tags.brand || tags.operator || '';
  const ssidHint = tags['internet_access:ssid'] || tags['wifi:ssid'] || tags.ssid || '';
  const operator = tags.operator || tags['internet_access:operator'] || '';
  const region = tags['addr:province'] || tags['addr:city'] || tags['addr:state'] || '';

  const haystack = [name, ssidHint, operator, JSON.stringify(tags)].join('\n');
  return {
    id: `${el.type}/${el.id}`,
    osm_type: el.type,
    osm_id: String(el.id),
    name,
    ssid_hint: ssidHint,
    internet_access: tags.internet_access || '',
    amenity: tags.amenity || '',
    wifi: tags.wifi || '',
    operator,
    isp: detectIsp(haystack),
    lat,
    lon,
    vendor: '', // OSM carries no MAC-level data
    bssid: '',
    country: tags['addr:country'] || defaultCountryFor(lat, lon, ctx.bboxIsDefault),
    region,
    first_seen: '', // not exposed by Overpass element payloads
    last_seen: el.timestamp || '', // last edit time (with `out meta`)
    matched_patterns: matchPatterns(haystack),
    source: 'osm_overpass',
    tags,
  };
}

// ──────────────────────── checkpoint + JSONL store ────────────────────────

/**
 * Incremental store: records are appended to JSONL per tile; the checkpoint
 * (completed tiles) is only saved AFTER a successful append — a crash between
 * the two simply re-runs a tile and dedup absorbs the overlap.
 */
function appendRecordsToJsonl(file, recs) {
  if (!recs.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function loadRecordsFromJsonl(file, log) {
  /** @type {Map<string, WifiRecord>} */
  const map = new Map();
  if (!fs.existsSync(file)) return map;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let bad = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && r.id) map.set(r.id, r); } catch { bad++; }
  }
  if (bad) log.warn({ file, bad }, 'skipped malformed JSONL lines');
  return map;
}

function loadCheckpoint(file) {
  const ck = readJsonSafe(file);
  if (!ck || ck.schema !== 1) return null;
  return {
    completedTiles: new Set(ck.completedTiles || []),
    failedTiles: new Map(Object.entries(ck.failedTiles || {})),
    bssidDone: new Set(ck.bssidDone || []),
  };
}

function saveCheckpoint(file, state, opts, recordsSize, startedAt) {
  atomicWriteJson(file, {
    schema: 1,
    updatedAt: new Date().toISOString(),
    startedAt,
    config: { bbox: opts.bbox, tileSize: opts.tileSize, endpoint: opts.endpoint },
    completedTiles: [...state.completedTiles],
    failedTiles: Object.fromEntries(state.failedTiles),
    bssidDone: [...state.bssidDone],
    records: recordsSize,
  });
}

// ────────────────────────── OUI vendor lookup ─────────────────────────────

/** Strip separators → 12 lowercase hex chars, or null if invalid. */
function normalizeMacInput(v) {
  const hex = String(v || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  return hex.length === 12 ? hex : null;
}

const macDisplay = (hex) => hex.toUpperCase().match(/../g).join(':');

/** Load the IEEE Registration Authority oui.csv into a prefix→org map. */
function loadOuiCsv(file) {
  const table = new Map();
  const text = fs.readFileSync(file, 'utf8');
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const cols = splitCsvLine(line);
    if (cols[0] === 'Registry') continue; // header
    const assign = (cols[1] || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
    if (assign.length !== 6) { skipped++; continue; } // MA-M/MA-R rows lack 6-hex prefixes
    table.set(assign, cols[2] || '');
  }
  return { table, skipped };
}

/**
 * Build the vendor resolver. Priority: --oui-file (IEEE csv) → `oui` npm
 * package (if installed) → tiny built-in illustrative table.
 * @returns {Promise<(macHex: string) => string>}
 */
async function buildOuiResolver(opts, log) {
  if (opts.ouiFile) {
    if (!fs.existsSync(opts.ouiFile)) throw new UsageError(`--oui-file not found: ${opts.ouiFile}`);
    const { table, skipped } = loadOuiCsv(opts.ouiFile);
    log.info({ entries: table.size, skipped }, 'loaded IEEE oui.csv');
    return (macHex) => table.get(macHex.slice(0, 6).toUpperCase()) || '';
  }
  try {
    const mod = await import('oui');
    const fn = mod.default || mod;
    const probe = fn('B8:27:EB:00:00:00');
    if (probe) {
      log.info('using `oui` npm package for vendor lookup');
      return (macHex) => {
        try {
          const r = fn(`${macHex.slice(0, 2)}:${macHex.slice(2, 4)}:${macHex.slice(4, 6)}:00:00:00`);
          return typeof r === 'string' ? r : r?.organization || '';
        } catch { return ''; }
      };
    }
  } catch { /* not installed — fall through */ }
  log.info('using built-in illustrative OUI table (pass --oui-file for authoritative data)');
  return (macHex) => BUILTIN_OUI[macHex.slice(0, 6).toUpperCase()] || '';
}

// ────────────────────────── BSSID geolocation ─────────────────────────────

/**
 * Parse a user-supplied BSSID list (.json array or CSV with a bssid column
 * or the MAC in the first column).
 * @returns {string[]} normalized 12-hex lowercase MACs
 */
function parseBssidList(file) {
  if (!fs.existsSync(file)) throw new UsageError(`--bssid-list not found: ${file}`);
  let raw = [];
  if (file.toLowerCase().endsWith('.json')) {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw = Array.isArray(j) ? j : j.bssids || j.data || j.macs || [];
    if (!Array.isArray(raw)) throw new UsageError('bssid JSON must be an array or {bssids:[…]}');
    raw = raw.map((x) => (typeof x === 'string' ? x : x?.bssid || x?.mac || x?.BSSID || ''));
  } else {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim());
    let col = 0;
    if (/\bbssid\b|\bmac\b/i.test(lines[0])) {
      const hdr = splitCsvLine(lines[0]);
      col = hdr.findIndex((h) => /bssid|mac/i.test(h));
      lines.shift();
    }
    raw = lines.map((l) => splitCsvLine(l)[col] || '');
  }
  const macs = [];
  let invalid = 0;
  for (const v of raw) {
    const hex = normalizeMacInput(v);
    if (hex) macs.push(hex); else if (String(v).trim()) invalid++;
  }
  if (invalid) throw new UsageError(`${invalid} entries in the BSSID list are not valid MAC addresses`);
  return [...new Set(macs)];
}

/**
 * Mylnikov Geo API lookup (free, keyless). Returns null when not found;
 * throws on transport/server errors so the caller can retry.
 * @param {string} macHex
 * @returns {Promise<{lat:number, lon:number, rangeM:number|null}|null>}
 */
async function mylnikovLookup(macHex, ctx) {
  const url = `${MYLNIKOV_URL}?v=1.1&bssid=${encodeURIComponent(macDisplay(macHex))}`;
  const res = await fetch(url, { headers: { 'User-Agent': ctx.userAgent, Accept: 'application/json' } });
  if (res.status === 429 || res.status >= 500) throw new Error(`mylnikov HTTP ${res.status}`);
  if (!res.ok) throw new FatalHttpError(`mylnikov HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const lat = parseFloat(j?.data?.lat);
  const lon = parseFloat(j?.data?.lon);
  if (j?.result === 200 && Number.isFinite(lat) && Number.isFinite(lon)) {
    return { lat, lon, rangeM: Number.isFinite(parseFloat(j.data.range)) ? parseFloat(j.data.range) : null };
  }
  return null; // result 404 = unknown BSSID — not an error
}

async function lookupBssidWithRetry(macHex, ctx) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await mylnikovLookup(macHex, ctx); }
    catch (err) {
      if (err instanceof FatalHttpError) throw err;
      if (attempt === 3) throw err;
      ctx.log.warn({ attempt, err: String(err) }, 'mylnikov lookup failed — retrying');
      await sleep(backoffMs(attempt, 1000, 30000));
    }
  }
  return null;
}

// ────────────────────────── export writers ────────────────────────────────

/**
 * @param {string} file @param {WifiRecord[]} rows
 */
function writeCsv(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // BOM so Excel renders Vietnamese diacritics correctly.
  const out = ['\uFEFF' + CSV_COLUMNS.join(','), ...rows.map((r) => CSV_COLUMNS.map((c) => {
    let v = r[c];
    if (c === 'tags') v = v ? JSON.stringify(v) : '';
    if (c === 'matched_patterns') v = Array.isArray(v) ? v.join('; ') : '';
    return csvEscape(v);
  }).join(','))];
  fs.writeFileSync(file, out.join('\n') + '\n');
}

function writeJsonExport(file, rows, meta) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ generated_at: new Date().toISOString(), tool: `${TOOL}/${VERSION}`, ...meta, count: rows.length, records: rows }, null, 2));
}

/** Optional SQLite export via better-sqlite3 (listed as optionalDependency). */
async function writeSqliteExport(file, rows, log) {
  let Database;
  try {
    ({ default: Database } = await import('better-sqlite3'));
  } catch {
    log.warn('better-sqlite3 not installed — skipping SQLite export (npm i better-sqlite3)');
    return false;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(`CREATE TABLE IF NOT EXISTS wifi_points (
    id TEXT PRIMARY KEY, osm_id TEXT, osm_type TEXT, name TEXT, ssid_hint TEXT,
    internet_access TEXT, amenity TEXT, wifi TEXT, operator TEXT, isp TEXT,
    lat REAL, lon REAL, vendor TEXT, bssid TEXT, country TEXT, region TEXT,
    first_seen TEXT, last_seen TEXT, matched_patterns TEXT, source TEXT, tags TEXT)`);
  const cols = CSV_COLUMNS;
  const ins = db.prepare(`INSERT OR REPLACE INTO wifi_points (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  db.transaction(() => {
    for (const r of rows) {
      ins.run(r.id, ...cols.map((c) => {
        let v = r[c];
        if (c === 'tags') v = v ? JSON.stringify(v) : '';
        if (c === 'matched_patterns') v = Array.isArray(v) ? v.join('; ') : '';
        return v ?? null;
      }));
    }
  })();
  db.close();
  return true;
}

// ────────────────────────────── main ──────────────────────────────────────

async function main() {
  const opts = validateOpts(await parseCli(process.argv.slice(2)));
  const log = await makeLogger(opts.verbose);
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const paths = derivePaths(opts.output, opts.checkpoint);

  const ctx = {
    log,
    opts,
    userAgent: `${TOOL}/${VERSION} (+https://openstreetmap.org; public-data collector)${opts.contact ? ` contact=${opts.contact}` : ''}`,
    outClause: 'out meta center;',
    shutdownFlag: { v: false },
    bboxIsDefault: ['south', 'west', 'north', 'east'].every((k) => opts.bbox[k] === DEFAULT_BBOX[k]),
    // Failover order: user's endpoint first, then the other known mirrors.
    endpoints: OVERPASS_ENDPOINTS.includes(opts.endpoint)
      ? [opts.endpoint, ...OVERPASS_ENDPOINTS.filter((e) => e !== opts.endpoint)]
      : [opts.endpoint],
    endpointIdx: 0,
  };

  const tilesAll = enumerateTiles(opts.bbox, opts.tileSize);
  const tiles = opts.sampleTiles > 0 ? tilesAll.slice(0, opts.sampleTiles) : tilesAll;
  log.info({ bbox: opts.bbox, tileSize: opts.tileSize, tilesTotal: tilesAll.length, running: tiles.length, endpoint: opts.endpoint }, 'collection plan');

  if (opts.dryRun) {
    log.info(`dry-run: ${tiles.length} tile(s), sample query follows`);
    console.log(buildQuery(tiles[0], ctx));
    return { code: 0, log };
  }

  // ── state: resume or fresh ──
  if (opts.fresh) {
    for (const f of [paths.ckpt, paths.jsonl]) {
      if (fs.existsSync(f)) { fs.unlinkSync(f); log.info({ file: f }, 'removed previous partial state (--fresh)'); }
    }
  }
  /** @type {Map<string, WifiRecord>} */
  const records = loadRecordsFromJsonl(paths.jsonl, log);
  const ck = loadCheckpoint(paths.ckpt);
  const state = ck ?? { completedTiles: new Set(), failedTiles: new Map(), bssidDone: new Set() };
  if (ck) log.info({ completedTiles: state.completedTiles.size, records: records.size }, 'resuming from checkpoint');
  else if (records.size) log.info({ records: records.size }, 'continuing existing dataset (dedup by id)');

  process.on('SIGINT', () => {
    if (ctx.shutdownFlag.v) { log.error('forced exit'); process.exit(130); }
    ctx.shutdownFlag.v = true;
    log.warn('SIGINT — finishing current operation and checkpointing (Ctrl-C again to force)');
  });
  process.on('SIGTERM', () => { ctx.shutdownFlag.v = true; });

  // ── phase 1: Overpass tile collection ──
  let interrupted = false;
  let hitMax = false;
  for (let i = 0; i < tiles.length; i++) {
    if (ctx.shutdownFlag.v) { interrupted = true; break; }
    const tile = tiles[i];
    const key = tileKey(tile);
    if (state.completedTiles.has(key)) continue;

    let elements;
    try {
      elements = await fetchTileElements(tile, ctx);
    } catch (err) {
      if (ctx.shutdownFlag.v) { interrupted = true; break; }
      state.failedTiles.set(key, String(err));
      log.error({ tile: key, err: String(err) }, 'tile failed (re-run later to retry)');
      continue;
    }

    const batch = [];
    for (const el of elements) {
      const rec = elementToRecord(el, ctx);
      if (!rec || records.has(rec.id)) continue;
      records.set(rec.id, rec);
      batch.push(rec);
    }
    appendRecordsToJsonl(paths.jsonl, batch); // append BEFORE checkpointing
    state.completedTiles.add(key);
    state.failedTiles.delete(key);
    saveCheckpoint(paths.ckpt, state, opts, records.size, startedAt);
    log.info({ progress: `${i + 1}/${tiles.length}`, tile: key, newRecords: batch.length, total: records.size }, 'tile complete');

    if (opts.maxResults > 0 && records.size >= opts.maxResults) { hitMax = true; break; }
    if (i < tiles.length - 1) await sleep(opts.sleepMs);
  }
  if (hitMax) log.info({ max: opts.maxResults, total: records.size }, 'max-results reached — stopping collection');
  if (interrupted) log.warn('interrupted — partial results will be exported and the checkpoint kept');

  // ── phase 2: optional BSSID geolocation (opt-in) ──
  let bssidStats = null;
  if (opts.bssidList && !ctx.shutdownFlag.v) {
    const macs = parseBssidList(opts.bssidList);
    const resolveVendor = await buildOuiResolver(opts, log);
    const randomized = macs.filter((m) => /[26ae]/.test(m[1])).length;
    if (randomized) log.info({ randomized, total: macs.length }, 'locally-administered (randomized) MACs detected — likely unresolvable');
    log.info({ total: macs.length, done: macs.filter((m) => state.bssidDone.has(m)).length }, 'BSSID geolocation phase (Mylnikov)');

    bssidStats = { total: macs.length, located: 0, notFound: 0, errors: 0 };
    for (const macHex of macs) {
      if (ctx.shutdownFlag.v) { interrupted = true; break; }
      if (state.bssidDone.has(macHex)) continue;

      const nowIso = new Date().toISOString();
      /** @type {WifiRecord} */
      let rec;
      try {
        const loc = await lookupBssidWithRetry(macHex, ctx);
        rec = {
          id: `bssid/${macHex}`, osm_type: '', osm_id: '', name: '', ssid_hint: '',
          internet_access: '', amenity: '', wifi: '', operator: '',
          isp: 'Unknown',
          lat: loc ? loc.lat : '', lon: loc ? loc.lon : '',
          vendor: resolveVendor(macHex), bssid: macDisplay(macHex),
          country: loc ? defaultCountryFor(loc.lat, loc.lon, ctx.bboxIsDefault) : 'VN',
          region: '', first_seen: nowIso, last_seen: nowIso,
          matched_patterns: [], source: loc ? 'mylnikov_geo' : 'bssid_list_no_location', tags: {},
        };
        if (loc) bssidStats.located++; else bssidStats.notFound++;
        state.bssidDone.add(macHex); // only mark done on a definite answer
        records.set(rec.id, rec);
        appendRecordsToJsonl(paths.jsonl, [rec]);
        saveCheckpoint(paths.ckpt, state, opts, records.size, startedAt);
      } catch (err) {
        bssidStats.errors++;
        log.error({ bssid: macDisplay(macHex), err: String(err) }, 'BSSID lookup failed (will retry on next run)');
      }
      await sleep(opts.bssidDelayMs);
    }
    log.info({ ...bssidStats }, 'BSSID phase complete');
  }

  // ── phase 3: finalize exports ──
  let rows = [...records.values()];
  const beforeFilter = rows.length;
  if (opts.requirePattern) {
    rows = rows.filter((r) => r.matched_patterns.length > 0);
    log.info({ before: beforeFilter, after: rows.length }, 'applied --require-pattern filter');
  }
  const meta = {
    source_endpoint: opts.endpoint,
    bbox: opts.bbox,
    tile_size: opts.tileSize,
    attribution: '© OpenStreetMap contributors (ODbL)',
  };
  writeCsv(paths.csv, rows);
  writeJsonExport(paths.json, rows, meta);
  if (opts.sqlite) await writeSqliteExport(opts.sqlite, rows, log);

  const bySource = {};
  for (const r of rows) bySource[r.source] = (bySource[r.source] || 0) + 1;
  const byPattern = {};
  for (const r of rows) for (const p of r.matched_patterns) byPattern[p] = (byPattern[p] || 0) + 1;
  const byIsp = {};
  for (const r of rows) byIsp[r.isp || 'Unknown'] = (byIsp[r.isp || 'Unknown'] || 0) + 1;
  const stats = {
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsed: fmtDur(Date.now() - t0),
    tiles: { total: tiles.length, done: state.completedTiles.size, failed: state.failedTiles.size },
    records: { collected: records.size, exported: rows.length, withCoords: rows.filter((r) => r.lat !== '').length },
    bySource,
    byPattern,
    byIsp,
    bssid: bssidStats,
    partial: interrupted || state.failedTiles.size > 0,
  };
  atomicWriteJson(paths.summary, stats);
  log.info(stats, 'run summary');
  log.info({ csv: paths.csv, json: paths.json, jsonl: paths.jsonl, summary: paths.summary }, 'outputs written');

  const complete = !interrupted && state.failedTiles.size === 0 && !hitMax
    && (!bssidStats || bssidStats.errors === 0);
  if (complete) {
    if (fs.existsSync(paths.ckpt)) fs.unlinkSync(paths.ckpt); // done — drop checkpoint, keep JSONL
    log.info('collection complete — checkpoint cleared');
  } else {
    log.warn('run is partial — re-run the same command to resume');
  }

  const code = interrupted ? 130 : state.failedTiles.size > 0 || bssidStats?.errors ? 3 : 0;
  return { code, log };
}

// ────────────────────────── entry point ───────────────────────────────────

// Internals exported for tests; VNWIFI_NO_RUN=1 prevents auto-run on import.
export { parseCli, validateOpts, enumerateTiles, buildQuery, elementToRecord, parseBssidList, CSV_COLUMNS };

if (process.env.VNWIFI_NO_RUN !== '1') {
  main().then(
    ({ code }) => { process.exitCode = code; },
    (err) => {
      const msg = err instanceof UsageError ? `usage error: ${err.message}` : `fatal: ${err.stack || err}`;
      console.error(JSON.stringify({ level: 60, time: Date.now(), msg }));
      process.exitCode = err instanceof UsageError ? 2 : 1;
    },
  );
}
