#!/usr/bin/env node
// Disposable local PostgreSQL cluster for tests when Docker is unavailable.
//   node tools/pg-local.mjs start            → prints DATABASE_URL (trust auth, localhost only)
//   node tools/pg-local.mjs stop
//   node tools/pg-local.mjs run -- <command…> → start, run command with DATABASE_URL, always stop
// Uses PG_BIN or /usr/lib/postgresql/<ver>/bin. When run as root, server commands run as the
// "postgres" OS user (PostgreSQL refuses to run as root). Data lives in $TMPDIR/cwk-pg-<port>.
// With Docker available, prefer: docker compose up -d postgres (see docker-compose.yml).

import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.CWK_PG_PORT || 54329);
const DATA = path.join(os.tmpdir(), `cwk-pg-${PORT}`);
const DB = 'cwk_test';
const USER = 'cwk';

function pgBin() {
  if (process.env.PG_BIN) return process.env.PG_BIN;
  const base = '/usr/lib/postgresql';
  if (fs.existsSync(base)) {
    const vers = fs.readdirSync(base).filter((v) => fs.existsSync(path.join(base, v, 'bin', 'pg_ctl'))).sort((a, b) => Number(b) - Number(a));
    if (vers.length) return path.join(base, vers[0], 'bin');
  }
  throw new Error('PostgreSQL binaries not found; set PG_BIN or use docker compose');
}

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
function asPg(cmd, args, opts = {}) {
  const full = isRoot ? ['runuser', ['-u', 'postgres', '--', cmd, ...args]] : [cmd, args];
  const r = spawnSync(full[0], full[1], { encoding: 'utf8', ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} failed (${r.status}): ${r.stderr || r.stdout}`);
  }
  return r;
}

export function databaseUrl() {
  return `postgres://${USER}@127.0.0.1:${PORT}/${DB}`;
}

export function start() {
  const bin = pgBin();
  if (!fs.existsSync(path.join(DATA, 'PG_VERSION'))) {
    fs.mkdirSync(DATA, { recursive: true });
    if (isRoot) spawnSync('chown', ['-R', 'postgres:postgres', DATA]);
    asPg(path.join(bin, 'initdb'), ['-D', DATA, '-U', 'postgres', '--auth=trust', '--encoding=UTF8', '--locale=C.UTF-8']);
  }
  const running = asPg(path.join(bin, 'pg_ctl'), ['-D', DATA, 'status'], { allowFail: true });
  if (running.status !== 0) {
    asPg(path.join(bin, 'pg_ctl'), ['-D', DATA, '-l', path.join(DATA, 'server.log'), '-w', '-o', `-p ${PORT} -k ${DATA} -c listen_addresses=127.0.0.1 -c timezone=UTC`, 'start']);
  }
  const psql = path.join(bin, 'psql');
  const sql = (s, db = 'postgres') => asPg(psql, ['-h', '127.0.0.1', '-p', String(PORT), '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-tAc', s]);
  if (!sql(`SELECT 1 FROM pg_roles WHERE rolname='${USER}'`).stdout.trim()) sql(`CREATE ROLE ${USER} LOGIN SUPERUSER`);
  if (!sql(`SELECT 1 FROM pg_database WHERE datname='${DB}'`).stdout.trim()) sql(`CREATE DATABASE ${DB} OWNER ${USER}`);
  return databaseUrl();
}

export function stop() {
  const bin = pgBin();
  if (fs.existsSync(path.join(DATA, 'PG_VERSION'))) asPg(path.join(bin, 'pg_ctl'), ['-D', DATA, '-m', 'fast', 'stop'], { allowFail: true });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'start') { console.log(start()); return; }
  if (cmd === 'stop') { stop(); return; }
  if (cmd === 'run') {
    const sep = rest.indexOf('--');
    const argv = sep >= 0 ? rest.slice(sep + 1) : rest;
    const url = process.env.DATABASE_URL || start();
    const startedHere = !process.env.DATABASE_URL;
    const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url }, shell: false });
    const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c ?? 1)));
    if (startedHere) stop();
    process.exit(code);
  }
  console.error('usage: pg-local.mjs start|stop|run -- <command>');
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message); process.exit(1); });
