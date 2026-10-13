import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatBytes, formatStorageReport } from './storage.js';

test('byte sizes are shown in binary units', () => {
  assert.deepEqual(
    [0, 1023, 1536, 5 * 1024 ** 2, 20.7 * 1024 ** 3].map(formatBytes),
    ['0 B', '1023 B', '1.5 KB', '5.0 MB', '20.7 GB'],
  );
});

const events = { table: 'events', rows: 100, totalBytes: 2048 * 100, rowsLastDay: 50, bytesLastDay: 2048 * 50 };
const health = { table: 'source_health', rows: 4, totalBytes: 16_384, rowsLastDay: null, bytesLastDay: null };
const measuredAt = new Date('2026-10-13T12:00:00Z');

test('the storage table marks unknown growth as "?" and projects 30 days from the known part', () => {
  const text = formatStorageReport({
    measuredAt,
    databaseBytes: 10 * 1024 ** 2,
    tables: [events, health],
    knownBytesLastDay: 2048 * 50,
    unknownGrowth: ['source_health'],
  });
  const lines = text.split('\n');
  assert.match(lines[0] ?? '', /^table\s+rows\s+size\s+rows\/24h\s+growth\/24h$/);
  assert.match(lines[1] ?? '', /^events\s+100\s+200\.0 KB\s+50\s+100\.0 KB$/);
  assert.match(lines[2] ?? '', /^source_health\s+4\s+16\.0 KB\s+\?\s+\?$/);
  assert.match(text, /Database total: 10\.0 MB/);
  // A partial sum is labelled as one, with the tables it leaves out.
  assert.match(text, /tables with known growth only: 100\.0 KB; at that rate, 2\.9 MB per 30 days\. Not included \(growth unknown\): source_health\./);
});

test('growth is stated plainly only when every table is counted, and is unknown when none is', () => {
  const complete = formatStorageReport({ measuredAt, databaseBytes: 1024, tables: [events], knownBytesLastDay: 2048 * 50, unknownGrowth: [] });
  assert.match(complete, /Growth in the last 24 hours: 100\.0 KB; at that rate, 2\.9 MB per 30 days\.$/m);
  const none = formatStorageReport({ measuredAt, databaseBytes: 1024, tables: [health], knownBytesLastDay: null, unknownGrowth: ['source_health'] });
  assert.match(none, /Growth in the last 24 hours: unknown for every table\./);
});
