#!/usr/bin/env node
/**
 * export-neon.mjs — Load collected Wi-Fi CSV into a Neon PostgreSQL database.
 *
 * Usage:
 *   DATABASE_CONNECTION=postgres://... node export-neon.mjs out/wifi_vn.csv
 *
 * Reads the CSV produced by collect-wifi.mjs (RFC-4180, UTF-8 BOM) and upserts
 * rows into the `wifi_points` table, deduplicated by (osm_type, osm_id, bssid).
 * Existing rows are updated (tags, last_seen, matched_patterns, updated_at).
 *
 * The table layout:
 *   wifi_points(
 *     id            serial PK,
 *     osm_type      text,          -- 'node' | 'way' | 'relation' | 'bssid'
 *     osm_id        text,          -- OSM id or normalized BSSID
 *     name          text,
 *     ssid_hint     text,
 *     internet_access text,
 *     amenity       text,
 *     wifi          text,
 *     operator      text,
 *     lat           double precision,
 *     lon           double precision,
 *     vendor        text,
 *     bssid         text,
 *     country       text,
 *     region        text,
 *     first_seen    timestamptz,
 *     last_seen     timestamptz,
 *     matched_patterns text,
 *     source        text,
 *     tags          jsonb,
 *     updated_at    timestamptz DEFAULT now()
 *   )
 * Indexes on (osm_type, osm_id) unique, lat/lon, and bssid.
 */

import { readFile } from 'node:fs/promises';
import pg from 'pg';

const { Client } = pg;

const DDL = `
CREATE TABLE IF NOT EXISTS wifi_points (
  id serial PRIMARY KEY,
  osm_type text,
  osm_id text,
  name text,
  ssid_hint text,
  internet_access text,
  amenity text,
  wifi text,
  operator text,
  lat double precision,
  lon double precision,
  vendor text,
  bssid text,
  country text,
  region text,
  first_seen timestamptz,
  last_seen timestamptz,
  matched_patterns text,
  source text,
  tags jsonb,
  updated_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS wifi_points_dedup_idx
  ON wifi_points (osm_type, osm_id);
CREATE INDEX IF NOT EXISTS wifi_points_geo_idx ON wifi_points (lat, lon);
CREATE INDEX IF NOT EXISTS wifi_points_bssid_idx ON wifi_points (bssid);
`;

/** Strip UTF-8 BOM if present. */
function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Parse one RFC-4180 CSV line into fields (handles quoted commas/quotes/newlines not spanning lines). */
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** Convert a CSV string field to a JS value for pg parameters. */
function coerce(col, v) {
  if (v === '' || v === undefined || v === null) return null;
  if (col === 'lat' || col === 'lon') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (col === 'first_seen' || col === 'last_seen') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (col === 'tags') {
    try { return JSON.parse(v); } catch { return null; }
  }
  return v;
}

/**
 * Main: read CSV, create schema, upsert rows in batches.
 * @param {string} csvPath
 */
async function main() {
  const csvPath = process.argv[2] || 'out/wifi_vn.csv';
  const conn = process.env.DATABASE_CONNECTION;
  if (!conn) {
    console.error('error: DATABASE_CONNECTION env var is required (Neon connection string)');
    process.exit(2);
  }

  const raw = stripBom(await readFile(csvPath, 'utf8'));
  const lines = raw.split('\n').filter((l) => l.trim() !== '');
  if (lines.length < 2) {
    console.error(`error: ${csvPath} has no data rows (${lines.length} lines)`);
    process.exit(1);
  }
  const header = splitCsvLine(lines[0]);
  const cols = header;
  const numCols = cols.length;
  console.log(`export-neon: ${lines.length - 1} rows, ${numCols} columns from ${csvPath}`);

  const client = new Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query(DDL);

  const upsertSql = `
    INSERT INTO wifi_points (${cols.join(', ')}, updated_at)
    VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, now())
    ON CONFLICT (osm_type, osm_id) DO UPDATE SET
      ${cols.filter((c) => !['osm_type', 'osm_id'].includes(c)).map((c, i) => `${c} = EXCLUDED.${c}`).join(', ')},
      updated_at = now()
  `;

  let inserted = 0;
  let skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const fields = splitCsvLine(lines[i]);
    if (fields.length !== numCols) {
      console.warn(`warn: line ${i + 1} has ${fields.length} fields, expected ${numCols}; padding`);
      while (fields.length < numCols) fields.push('');
      fields.length = numCols;
    }
    if (!fields[cols.indexOf('osm_id')]) { skipped++; continue; }
    const params = cols.map((c, ci) => coerce(c, fields[ci]));
    try {
      await client.query(upsertSql, params);
      inserted++;
    } catch (err) {
      if (err.code === '23505' || err.code === '23502') { skipped++; continue; }
      throw err;
    }
    if (inserted % 500 === 0) console.log(`export-neon: ${inserted} rows upserted...`);
  }
  await client.end();
  return { inserted, skipped };
}

main().then(
  (r) => {
    if (r) console.log(`export-neon: done — ${r.inserted} rows upserted, ${r.skipped} skipped`);
    process.exit(0);
  },
  (err) => {
    console.error('export-neon: fatal:', err.message);
    process.exit(1);
  }
);
