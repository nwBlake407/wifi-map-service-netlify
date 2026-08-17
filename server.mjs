#!/usr/bin/env node
/**
 * server.mjs — tiny HTTP wrapper so the collect→Neon pipeline can run on a
 * free Render web service (cron jobs and background workers require a paid
 * plan on this workspace).
 *
 * Behavior:
 *   - On startup, runs the full pipeline once in the background.
 *   - GET /       → JSON status (state, last result)
 *   - GET /run    → trigger the pipeline again (409 if already running)
 *   - GET /health → 200 for Render health checks
 *
 * Pipeline: collect-wifi.mjs (Overpass, full Vietnam bbox) → out/wifi_vn.csv
 *           → export-neon.mjs → Neon PostgreSQL (DATABASE_CONNECTION).
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const PORT = process.env.PORT || 10000;
const OUT_CSV = 'out/wifi_vn.csv';
const CONTACT = process.env.PIPELINE_CONTACT || '';

const state = {
  running: false,
  startedAt: null,
  finishedAt: null,
  lastExitCode: null,
  lastLog: [],
};

function runPipeline() {
  if (state.running) return false;
  state.running = true;
  state.startedAt = new Date().toISOString();
  state.lastLog = [];
  const collectArgs = ['-v', '-o', OUT_CSV];
  if (CONTACT) collectArgs.push('--contact', CONTACT);
  const sh = [
    `node collect-wifi.mjs ${collectArgs.join(' ')};`,
    `node export-neon.mjs ${OUT_CSV}`,
  ].join(' ');
  const child = spawn('/bin/sh', ['-c', sh], { cwd: process.cwd() });
  const push = (buf) => {
    const lines = buf.toString().split('\n').filter(Boolean).slice(-200);
    state.lastLog.push(...lines);
    if (state.lastLog.length > 500) state.lastLog.splice(0, state.lastLog.length - 500);
    for (const l of lines) console.log(l);
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('close', (code) => {
    state.running = false;
    state.finishedAt = new Date().toISOString();
    state.lastExitCode = code;
    console.log(`pipeline finished with exit code ${code}`);
  });
  return true;
}

mkdirSync('out', { recursive: true });
runPipeline();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/health') {
    res.end('{"ok":true}');
  } else if (url.pathname === '/run') {
    if (runPipeline()) {
      res.statusCode = 202;
      res.end('{"started":true}');
    } else {
      res.statusCode = 409;
      res.end('{"started":false,"reason":"already running"}');
    }
  } else {
    res.end(JSON.stringify(state));
  }
});

server.listen(PORT, () => console.log(`pipeline server listening on ${PORT}`));
