import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { archiveCreatesSchema, assertBackupDir, BackupError, parseToolMajor, pgToolEnv, restoreCheckDatabaseName } from './backup.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

test('a backup is restored into its own check database, never into a database that ends that way', () => {
  assert.equal(restoreCheckDatabaseName('morrow'), 'morrow_restore_check');
  assert.equal(restoreCheckDatabaseName('morrow_test'), 'morrow_test_restore_check');
  assert.throws(() => restoreCheckDatabaseName('morrow_restore_check'), BackupError);
});

test('the backup folder is absolute and outside the repository', () => {
  assert.doesNotThrow(() => assertBackupDir(path.join(os.tmpdir(), 'morrow-backups')));
  assert.throws(() => assertBackupDir('backups'), /absolute path/);
  assert.throws(() => assertBackupDir(REPO_ROOT), /outside the repository/);
  assert.throws(() => assertBackupDir(path.join(REPO_ROOT, 'backups')), /outside the repository/);
  assert.doesNotThrow(() => assertBackupDir(`${REPO_ROOT.replace(/[\\/]$/, '')}-backups`), 'a sibling folder is outside');
});

test('the tools get the connection in PG* variables, so the password is never on a command line', () => {
  const previous = process.env['PGSERVICE'];
  process.env['PGSERVICE'] = 'somewhere-else';
  try {
    const env = pgToolEnv('postgres://mor%40row:p%40ss%3Aw0rd@127.0.0.1:54317/morrow');
    assert.equal(env['PGHOST'], '127.0.0.1');
    assert.equal(env['PGPORT'], '54317');
    assert.equal(env['PGUSER'], 'mor@row');
    assert.equal(env['PGPASSWORD'], 'p@ss:w0rd');
    assert.equal(env['PGDATABASE'], 'morrow');
    assert.equal(env['PGSERVICE'], undefined, 'an inherited PG* variable cannot redirect the tools');
    assert.equal(pgToolEnv('postgres://morrow@127.0.0.1:54317/morrow', 'morrow_restore_check')['PGDATABASE'], 'morrow_restore_check');
  } finally {
    if (previous === undefined) delete process.env['PGSERVICE'];
    else process.env['PGSERVICE'] = previous;
  }
});

test('the major version is read from the tool itself', () => {
  assert.equal(parseToolMajor('pg_dump (PostgreSQL) 17.6'), 17);
  assert.equal(parseToolMajor('pg_dump (PostgreSQL) 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)'), 16);
  assert.equal(parseToolMajor('something else'), null);
});

test('whether an archive creates its schema is read from its table of contents', () => {
  // Real `pg_restore --list` lines (PostgreSQL 16), comments left out.
  const publicSelected = ['4; 2615 2200 SCHEMA - public pg_database_owner', '216; 1259 638344 TABLE public t morrow'].join('\n');
  const wholeDatabase = ['6; 2615 638347 SCHEMA - s2 morrow', '216; 1259 638344 TABLE public t morrow', '217; 1259 638348 TABLE s2 u morrow'].join('\r\n');
  assert.equal(archiveCreatesSchema(publicSelected, 'public'), true);
  assert.equal(archiveCreatesSchema(wholeDatabase, 'public'), false, 'a whole-database dump takes public as given');
  assert.equal(archiveCreatesSchema(wholeDatabase, 's2'), true);
  assert.equal(archiveCreatesSchema('216; 1259 638344 TABLE public t morrow', 'public'), false, 'a table in it is not the schema');
});
