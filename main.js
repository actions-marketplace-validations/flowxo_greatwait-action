import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const API_URL = 'https://api.greatwait.dev/v1/schedules';
const TIMEOUT_MS = 10_000;
const ID = {
  endpoint: /^ep_[A-Za-z0-9_-]{8,128}$/,
  schedule: /^sch_[A-Za-z0-9_-]{8,128}$/,
  occurrence: /^occ_[A-Za-z0-9_-]{8,128}$/,
};

export class ActionError extends Error {
  constructor(message, outcome) {
    super(message);
    this.outcome = outcome;
  }
}

function required(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ActionError(`Invalid ${name} input.`, 'not_sent');
  }
  return value;
}

export function validateInputs(input) {
  const apiKey = required(input.api_key, 'api_key');
  if (/[\r\n]/.test(apiKey)) throw new ActionError('Invalid api_key input.', 'not_sent');
  const endpoint = required(input.endpoint, 'endpoint');
  if (!ID.endpoint.test(endpoint)) throw new ActionError('Invalid endpoint input.', 'not_sent');
  const delayText = required(input.delay_seconds, 'delay_seconds');
  if (!/^[1-9]\d*$/.test(delayText)) throw new ActionError('Invalid delay_seconds input.', 'not_sent');
  const delaySeconds = Number(delayText);
  if (!Number.isSafeInteger(delaySeconds) || delaySeconds > 158_000_000) {
    throw new ActionError('Invalid delay_seconds input.', 'not_sent');
  }
  const idempotencyKey = required(input.idempotency_key, 'idempotency_key');
  if (idempotencyKey.length < 16 || idempotencyKey.length > 255 || !/^[\x20-\x7e]+$/.test(idempotencyKey)) {
    throw new ActionError('Invalid idempotency_key input.', 'not_sent');
  }

  const body = { delaySeconds, endpoint };
  if (input.data_json !== undefined && input.data_json !== '') {
    if (typeof input.data_json !== 'string') throw new ActionError('Invalid data_json input.', 'not_sent');
    try {
      body.data = JSON.parse(input.data_json);
    } catch {
      throw new ActionError('Invalid data_json input: expected JSON.', 'not_sent');
    }
    if (Buffer.byteLength(JSON.stringify(body.data), 'utf8') > 65_536) {
      throw new ActionError('Invalid data_json input: too large.', 'not_sent');
    }
  }
  return { apiKey, idempotencyKey, body };
}

function validInstant(value) {
  return typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function validateAcceptedResponse(value, endpoint) {
  const schedule = value?.schedule;
  const occurrence = value?.occurrence;
  if (!schedule || !occurrence || !ID.schedule.test(schedule.id) ||
      !ID.occurrence.test(occurrence.id) || occurrence.schedule !== schedule.id ||
      schedule.endpoint !== endpoint || schedule.recurrence?.kind !== 'at' ||
      !['active', 'paused', 'cancelled', 'completed'].includes(schedule.status) ||
      !['planned', 'due', 'dispatching', 'retry_wait', 'ambiguous', 'succeeded', 'terminal_failed', 'cancelled', 'skipped_stale'].includes(occurrence.state) ||
      !validInstant(occurrence.plannedFor)) {
    throw new ActionError('GreatWait returned a malformed success response; scheduling outcome is uncertain.', 'uncertain');
  }
  return {
    schedule_id: schedule.id,
    occurrence_id: occurrence.id,
    planned_for: occurrence.plannedFor,
  };
}

export async function scheduleOnce(input, fetchImpl = fetch) {
  const { apiKey, idempotencyKey, body } = validateInputs(input);
  let response;
  try {
    response = await fetchImpl(API_URL, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ActionError('No definitive response from GreatWait; scheduling outcome is uncertain. Inspect the schedule before any manual retry.', 'uncertain');
  }

  if (response.status !== 201) {
    if (response.status === 408 || response.status >= 500) {
      throw new ActionError('GreatWait timeout or server error; scheduling outcome is uncertain. Inspect the schedule before any manual retry.', 'uncertain');
    }
    const category = response.status === 401 ? 'authentication' :
      response.status === 403 ? 'authorization' :
      response.status === 429 ? 'rate limit' :
      response.status >= 300 && response.status < 400 ? 'redirect refused' :
      'request rejected';
    throw new ActionError(`GreatWait ${category} response (HTTP ${response.status}); no automatic retry.`, 'rejected');
  }

  let value;
  try {
    value = await response.json();
  } catch {
    throw new ActionError('GreatWait returned an unreadable success response; scheduling outcome is uncertain.', 'uncertain');
  }
  return validateAcceptedResponse(value, body.endpoint);
}

export function readInputs(env) {
  return {
    api_key: env.INPUT_API_KEY,
    endpoint: env.INPUT_ENDPOINT,
    delay_seconds: env.INPUT_DELAY_SECONDS,
    idempotency_key: env.INPUT_IDEMPOTENCY_KEY,
    data_json: env.INPUT_DATA_JSON,
  };
}

export function writeOutputs(path, output) {
  if (!path) throw new ActionError('GITHUB_OUTPUT is unavailable; accepted schedule IDs must be checked in GreatWait.', 'accepted');
  // Output values have already passed strict ID/timestamp validation. Never use workflow command stdout.
  appendFileSync(path, `schedule_id=${output.schedule_id}\noccurrence_id=${output.occurrence_id}\nplanned_for=${output.planned_for}\n`, 'utf8');
}

export async function run(env = process.env, fetchImpl = fetch) {
  try {
    const output = await scheduleOnce(readInputs(env), fetchImpl);
    writeOutputs(env.GITHUB_OUTPUT, output);
    process.stdout.write('GreatWait returned the schedule. Callback delivery is not yet verified.\n');
    return 0;
  } catch (error) {
    const message = error instanceof ActionError ? error.message :
      'Action failed after scheduling may have been accepted; inspect GreatWait before any manual retry.';
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run();
}
