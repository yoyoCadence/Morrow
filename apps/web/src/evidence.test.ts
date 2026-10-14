import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REQUEST_OUTCOMES } from '@morrow/core';
import { formatSize, indentJson, observationIdOf, outcomeTone, prettyBody, shortSubject } from './evidence.js';

test('asset subjects are shortened to the ends of the reference, keeping namespace and network', () => {
  assert.equal(shortSubject('solana:mainnet-beta:So11111111111111111111111111111111111111112'), 'solana:mainnet-beta · So11…1112');
  assert.notEqual(
    shortSubject('solana:devnet:So11111111111111111111111111111111111111112'),
    shortSubject('solana:mainnet-beta:So11111111111111111111111111111111111111112'),
    'the same reference on another network is another asset',
  );
  assert.equal(shortSubject('system:worker'), 'system:worker');
  assert.equal(shortSubject('provider:okx'), 'provider:okx');
});

test('only raw observation references lead to an observation', () => {
  assert.equal(observationIdOf('raw_observation:1234'), '1234');
  assert.equal(observationIdOf('raw_observation:0'), null);
  assert.equal(observationIdOf('event:1234'), null);
  assert.equal(observationIdOf('raw_observation:12; drop'), null);
});

test('every request outcome has a tone, and only OK is good', () => {
  const tones = Object.fromEntries(REQUEST_OUTCOMES.map((outcome) => [outcome, outcomeTone(outcome)]));
  assert.equal(tones['OK'], 'good');
  assert.deepEqual(
    REQUEST_OUTCOMES.filter((outcome) => tones[outcome] === 'good'),
    ['OK'],
  );
  for (const bad of ['UNAUTHORIZED', 'PAYMENT_REQUIRED', 'SERVER_ERROR', 'TIMEOUT', 'TLS_UNTRUSTED', 'NETWORK_ERROR']) {
    assert.equal(tones[bad], 'bad', bad);
  }
});

test('sizes read in powers of 1024', () => {
  assert.equal(formatSize(812), '812 B');
  assert.equal(formatSize(53_856), '52.6 KB');
  assert.equal(formatSize(262_144), '256.0 KB');
  assert.equal(formatSize(1_258_291), '1.2 MB');
});

test('JSON is indented without changing a single number or string', () => {
  const raw = '{"price":0.00000001234,"supply":12345678901234567890,"name":"a,b:{c}[\\"d\\"]","list":[1, 2],"empty":{},"none":[ ]}';
  const indented = indentJson(raw);
  assert.equal(
    indented,
    [
      '{',
      '  "price": 0.00000001234,',
      '  "supply": 12345678901234567890,',
      '  "name": "a,b:{c}[\\"d\\"]",',
      '  "list": [',
      '    1,',
      '    2',
      '  ],',
      '  "empty": {},',
      '  "none": []',
      '}',
    ].join('\n'),
  );
  // Removing the layout gives back the original tokens exactly.
  assert.equal(indented.replace(/\n\s*/g, '').replace(/": /g, '":'), raw.replace(/, /g, ',').replace('[ ]', '[]'));
});

test('a body is indented only when it is complete JSON', () => {
  assert.equal(prettyBody('[{"a":1}]', false), '[\n  {\n    "a": 1\n  }\n]');
  assert.equal(prettyBody('not json {', false), 'not json {');
  assert.equal(prettyBody('{"a":', true), '{"a":', 'a cut-off body is shown as received');
});
