import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SEED_RECORDS, SEED_VERSION, DEFAULT_SETTINGS } from './seed.js';
import { dbEnabled, loadKv, saveKv } from './db.js';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'store.json');

// replays: captured, scrubbed reply sets per USx region (docs/REPLAY.md); never seeded, only uploaded
let state = { records: structuredClone(SEED_RECORDS), settings: { ...DEFAULT_SETTINGS }, seedVersion: SEED_VERSION, replays: [] };

/**
 * When the seed set changes (SEED_VERSION in seed.js), refresh the seed records (ids starting with
 * "seed-") and keep every record that was added or imported. Edits made to a seed record are replaced.
 * Returns true if anything changed.
 */
function applySeedUpgrade() {
  if (state.seedVersion === SEED_VERSION) return false;
  const custom = state.records.filter((r) => !String(r.id).startsWith('seed-'));
  state.records = [...structuredClone(SEED_RECORDS), ...custom];
  state.seedVersion = SEED_VERSION;
  return true;
}

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    state = {
      records: Array.isArray(saved.records) ? saved.records : state.records,
      settings: { ...DEFAULT_SETTINGS, ...(saved.settings ?? {}) },
      seedVersion: saved.seedVersion,
      replays: Array.isArray(saved.replays) ? saved.replays : [],
    };
    if (applySeedUpgrade()) save();
  } catch {
    // First run, or no writable volume: start from the seed.
  }
  if (process.env.CALLBACK_URL && !state.settings.callbackUrl) state.settings.callbackUrl = process.env.CALLBACK_URL;
}

/** With a database configured, records and settings live there; otherwise in a JSON file under DATA_DIR. */
export async function initStore() {
  if (!dbEnabled) return;
  const [records, savedSettings, seedVersion, savedReplays] = await Promise.all([loadKv('records'), loadKv('settings'), loadKv('seedVersion'), loadKv('replays')]);
  state.replays = Array.isArray(savedReplays) ? savedReplays : [];
  if (Array.isArray(records)) {
    state.records = records;
    state.seedVersion = seedVersion ?? undefined;
  }
  state.settings = { ...DEFAULT_SETTINGS, ...(savedSettings ?? {}) };
  if (process.env.CALLBACK_URL && !state.settings.callbackUrl) state.settings.callbackUrl = process.env.CALLBACK_URL;
  if (!Array.isArray(records) || applySeedUpgrade()) save();
}

function save() {
  if (dbEnabled) {
    saveKv('records', state.records);
    saveKv('settings', state.settings);
    saveKv('seedVersion', state.seedVersion);
    saveKv('replays', state.replays);
    return;
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn(`store: could not persist to ${FILE}: ${err.code ?? err.message}`);
  }
}

load();

export const records = () => state.records;
export const settings = () => state.settings;
export const replays = () => state.replays;

/** Replaces one region's replay records with a validated pack's records; other regions are kept. */
export function setRegionReplays(region, list) {
  state.replays = [...state.replays.filter((r) => r.region !== region), ...list];
  save();
  return state.replays.filter((r) => r.region === region).length;
}

/** Removes one region's replay records. */
export function clearRegionReplays(region) {
  const before = state.replays.length;
  state.replays = state.replays.filter((r) => r.region !== region);
  save();
  return before - state.replays.length;
}

export function upsertRecord(input) {
  const record = { enabled: true, results: [], match: {}, ...input, id: input.id || randomUUID() };
  const i = state.records.findIndex((r) => r.id === record.id);
  if (i >= 0) state.records[i] = record;
  else state.records.push(record);
  save();
  return record;
}

export function deleteRecord(id) {
  const before = state.records.length;
  state.records = state.records.filter((r) => r.id !== id);
  save();
  return state.records.length < before;
}

/** Adds or updates many records with a single save. With `replace`, everything else is removed first. */
export function importRecords(list, { replace = false } = {}) {
  const next = replace ? [] : [...state.records];
  for (const input of list) {
    const record = { enabled: true, results: [], match: {}, ...input, id: input.id || randomUUID() };
    const i = next.findIndex((r) => r.id === record.id);
    if (i >= 0) next[i] = record;
    else next.push(record);
  }
  state.records = next;
  save();
  return state.records.length;
}

export function resetRecords() {
  state.records = structuredClone(SEED_RECORDS);
  state.seedVersion = SEED_VERSION;
  save();
}

export function updateSettings(patch) {
  const next = { ...state.settings };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (patch[key] === undefined) continue;
    next[key] = typeof DEFAULT_SETTINGS[key] === 'number' ? Math.max(0, Number(patch[key]) || 0) : patch[key];
  }
  state.settings = next;
  save();
  return state.settings;
}
