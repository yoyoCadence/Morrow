import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coverageSegments, type GapSpan, type SessionSpan } from './coverage.js';

const H = 3_600_000;
const session = (start: number, end: number, mode = 'RESEARCH', lost = false): SessionSpan => ({ start, end, mode, lost });
const gap = (kind: GapSpan['kind'], start: number, end: number): GapSpan => ({ kind, start, end });
const brief = (segments: ReturnType<typeof coverageSegments>) =>
  segments.map((segment) => [segment.start / H, segment.end / H, segment.reason ?? 'OBSERVING']);

test('with no session at all, the whole window is unrecorded, not quiet', () => {
  assert.deepEqual(brief(coverageSegments(0, 24 * H, [], [])), [[0, 24, 'NO_RECORD']]);
});

test('sessions observe, recorded gaps say why they did not, and the segments cover the window exactly', () => {
  const segments = coverageSegments(
    0,
    24 * H,
    [session(2 * H, 10 * H), session(12 * H, 24 * H)],
    [gap('OFFLINE', 10 * H, 12 * H)],
  );
  assert.deepEqual(brief(segments), [
    [0, 2, 'NO_RECORD'],
    [2, 10, 'OBSERVING'],
    [10, 12, 'OFFLINE'],
    [12, 24, 'OBSERVING'],
  ]);
  for (let index = 1; index < segments.length; index += 1) assert.equal(segments[index]?.start, segments[index - 1]?.end);
});

test('a stall inside a session is a gap, and OFF mode runs without observing', () => {
  assert.deepEqual(
    brief(coverageSegments(0, 10 * H, [session(0, 6 * H), session(6 * H, 10 * H, 'OFF')], [gap('HEARTBEAT_STALL', 2 * H, 3 * H)])),
    [
      [0, 2, 'OBSERVING'],
      [2, 3, 'HEARTBEAT_STALL'],
      [3, 6, 'OBSERVING'],
      [6, 10, 'MODE_OFF'],
    ],
  );
});

test('a crash is a gap until the next start, and a silent session that is still marked running is lost', () => {
  assert.deepEqual(
    brief(
      coverageSegments(
        0,
        10 * H,
        [session(0, 3 * H), session(4 * H, 7 * H, 'PAPER', true)],
        [gap('UNCLEAN_SHUTDOWN', 3 * H, 4 * H)],
      ),
    ),
    [
      [0, 3, 'OBSERVING'],
      [3, 4, 'UNCLEAN_SHUTDOWN'],
      [4, 7, 'OBSERVING'],
      [7, 10, 'HEARTBEAT_LOST'],
    ],
  );
});

test('back-to-back sessions merge, and spans reaching outside the window are clipped', () => {
  assert.deepEqual(brief(coverageSegments(10 * H, 20 * H, [session(0, 15 * H), session(15 * H, 30 * H)], [])), [[10, 20, 'OBSERVING']]);
  assert.deepEqual(coverageSegments(5, 5, [], []), [], 'an empty window has no segments');
});

test('the seam between a restart gap and the next session is not a hole', () => {
  // The gap ends when the new session's transaction began; the session row is stamped 0.2 s later.
  assert.deepEqual(
    brief(coverageSegments(0, 10 * H, [session(0, 3 * H), session(4 * H + 200, 10 * H)], [gap('UNCLEAN_SHUTDOWN', 3 * H, 4 * H)])),
    [
      [0, 3, 'OBSERVING'],
      [3, 4 + 200 / H, 'UNCLEAN_SHUTDOWN'],
      [4 + 200 / H, 10, 'OBSERVING'],
    ],
  );
  // A real stretch without any record stays visible.
  assert.deepEqual(
    brief(coverageSegments(0, 10 * H, [session(0, 3 * H), session(5 * H, 10 * H)], [gap('OFFLINE', 3 * H, 4 * H)])),
    [
      [0, 3, 'OBSERVING'],
      [3, 4, 'OFFLINE'],
      [4, 5, 'NO_RECORD'],
      [5, 10, 'OBSERVING'],
    ],
  );
});
