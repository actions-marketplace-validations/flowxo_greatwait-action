import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scheduleOnce, run, validateInputs } from '../main.js';

const secret = 'gw_secret_not_for_logs';
const input = {
  api_key: secret,
  endpoint: 'ep_01h8xyz9k2m4n6p8r0t2v4w6y8',
  delay_seconds: '300',
  idempotency_key: 'ch109-run-1234567890',
  data_json: '{"job":"check"}',
};
const accepted = {
  schedule: { id: 'sch_01h8xyz9k2m4n6p8r0t2v4w6y8', endpoint: input.endpoint,
    recurrence: { kind: 'at' }, status: 'active' },
  occurrence: { id: 'occ_01h8xyz9k2m4n6p8r0t2v4w6y8',
    schedule: 'sch_01h8xyz9k2m4n6p8r0t2v4w6y8',
    plannedFor: '2026-10-20T20:00:00.000Z', state: 'planned' },
};
const response = (status, value) => ({ status, json: async () => value });

test('sends exactly one POST to fixed origin and only existing endpoint', async () => {
  const calls = [];
  const result = await scheduleOnce(input, async (...args) => {
    calls.push(args);
    return response(201, accepted);
  });
  assert.equal(calls.length, 1);
  const [url, options] = calls[0];
  assert.equal(url, 'https://api.greatwait.dev/v1/schedules');
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'manual');
  assert.equal(options.headers.Authorization, `Bearer ${secret}`);
  assert.equal(options.headers['Idempotency-Key'], input.idempotency_key);
  assert.deepEqual(JSON.parse(options.body), {
    endpoint: input.endpoint, delaySeconds: 300, data: { job: 'check' },
  });
  assert.deepEqual(result, {
    schedule_id: accepted.schedule.id, occurrence_id: accepted.occurrence.id,
    planned_for: accepted.occurrence.plannedFor,
  });
});

test('accepts documented idempotency replay states without claiming delivery', async () => {
  for (const state of ['cancelled', 'skipped_stale']) {
    const replay = {
      schedule: { ...accepted.schedule, status: 'cancelled' },
      occurrence: { ...accepted.occurrence, state },
    };
    const result = await scheduleOnce(input, async () => response(201, replay));
    assert.equal(result.schedule_id, accepted.schedule.id);
  }
  await scheduleOnce(input, async () => response(201, {
    schedule: { ...accepted.schedule, status: 'paused' }, occurrence: accepted.occurrence,
  }));
});

test('invalid inputs fail before any request', async () => {
  const cases = [
    { api_key: '' }, { api_key: `a\n${secret}` }, { endpoint: 'https://example.test/hook' },
    { endpoint: 'ep_bad\nURL' }, { delay_seconds: '0' }, { delay_seconds: '158000001' },
    { delay_seconds: '1.5' }, { delay_seconds: '1e2' }, { delay_seconds: '01' },
    { idempotency_key: 'k'.repeat(15) }, { idempotency_key: 'k'.repeat(256) },
    { idempotency_key: `key-123456789012\n` }, { idempotency_key: `${'k'.repeat(15)}\x7f` },
    { data_json: '{bad' },
    { data_json: JSON.stringify('x'.repeat(65_537)) },
  ];
  let calls = 0;
  for (const variant of cases) {
    await assert.rejects(scheduleOnce({ ...input, ...variant }, async () => { calls++; }),
      { outcome: 'not_sent' });
  }
  assert.equal(calls, 0);
  assert.deepEqual(validateInputs({ ...input, data_json: '' }).body,
    { endpoint: input.endpoint, delaySeconds: 300 });
  for (const delay_seconds of ['1', '158000000']) {
    for (const idempotency_key of ['k'.repeat(16), 'k'.repeat(255)]) {
      assert.equal(validateInputs({ ...input, delay_seconds, idempotency_key }).body.delaySeconds,
        Number(delay_seconds));
    }
  }
});

test('authorization, authentication, rate limit, redirect and other rejections never retry', async () => {
  for (const [status, phrase] of [[401, 'authentication'], [403, 'authorization'],
    [429, 'rate limit'], [302, 'redirect refused'], [400, 'request rejected'],
    [409, 'request rejected']]) {
    let calls = 0;
    await assert.rejects(scheduleOnce(input, async () => {
      calls++;
      return response(status, { detail: secret });
    }), error => error.outcome === 'rejected' && error.message.includes(phrase) &&
      !error.message.includes(secret));
    assert.equal(calls, 1);
  }
});

test('server errors, network loss, timeouts and malformed success remain uncertain', async () => {
  for (const status of [408, 500, 503]) {
    let calls = 0;
    await assert.rejects(scheduleOnce(input, async () => {
      calls++;
      return response(status, { detail: secret });
    }), { outcome: 'uncertain' });
    assert.equal(calls, 1);
  }
  await assert.rejects(scheduleOnce(input, async () => { throw new Error(secret); }),
    error => error.outcome === 'uncertain' && !error.message.includes(secret));
  await assert.rejects(scheduleOnce(input, async (_url, options) => {
    assert.ok(options.signal);
    throw new DOMException(secret, 'TimeoutError');
  }), { outcome: 'uncertain' });
  await assert.rejects(scheduleOnce(input, async () => ({ status: 201, json: async () => { throw new Error(secret); } })),
    { outcome: 'uncertain' });
  for (const mutation of [
    { schedule: { ...accepted.schedule, id: 'sch_bad\nunauthorized=true' } },
    { schedule: { ...accepted.schedule, id: 'sch_goodgoodgood::error::injected' } },
    { occurrence: { ...accepted.occurrence, plannedFor: '2026-02-30T20:00:00.000Z' } },
    { occurrence: { ...accepted.occurrence, plannedFor: '2026-10-20T20:00:00.000Z\nextra_output=bad' } },
    { occurrence: { ...accepted.occurrence, schedule: 'sch_wrongwrongwrong' } },
    { schedule: { ...accepted.schedule, endpoint: 'ep_otherotherother' } },
    { occurrence: { ...accepted.occurrence, state: 'made_up' } },
  ]) {
    await assert.rejects(scheduleOnce(input, async () => response(201, { ...accepted, ...mutation })),
      { outcome: 'uncertain' });
  }
});

test('validated outputs cannot inject workflow commands or additional output lines', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ch109-test-')), 'output');
  const env = {
    INPUT_API_KEY: secret, INPUT_ENDPOINT: input.endpoint, INPUT_DELAY_SECONDS: '300',
    INPUT_IDEMPOTENCY_KEY: input.idempotency_key, GITHUB_OUTPUT: path,
  };
  const malicious = {
    ...accepted,
    schedule: { ...accepted.schedule, id: 'sch_goodgoodgood\nextra_output=bad' },
  };
  const oldWrite = process.stderr.write;
  let errors = '';
  process.stderr.write = chunk => { errors += chunk; return true; };
  try {
    assert.equal(await run(env, async () => response(201, malicious)), 1);
  } finally {
    process.stderr.write = oldWrite;
  }
  assert.equal(errors.includes(secret), false);
  assert.equal(errors.includes('extra_output'), false);
  assert.throws(() => readFileSync(path));

  const oldAuthErrorWrite = process.stderr.write;
  let authErrors = '';
  process.stderr.write = chunk => { authErrors += chunk; return true; };
  try {
    assert.equal(await run(env, async () => response(401, { detail: secret })), 1);
    assert.equal(await run(env, async () => { throw new Error(secret); }), 1);
  } finally {
    process.stderr.write = oldAuthErrorWrite;
  }
  assert.equal(authErrors.includes(secret), false);
  assert.throws(() => readFileSync(path));

  const oldOut = process.stdout.write;
  let logs = '';
  process.stdout.write = chunk => { logs += chunk; return true; };
  try {
    assert.equal(await run(env, async () => response(201, accepted)), 0);
  } finally {
    process.stdout.write = oldOut;
  }
  assert.equal(logs.includes(secret), false);
  assert.match(logs, /returned the schedule.*not yet verified/);
  assert.equal(readFileSync(path, 'utf8'),
    `schedule_id=${accepted.schedule.id}\noccurrence_id=${accepted.occurrence.id}\nplanned_for=${accepted.occurrence.plannedFor}\n`);
});
