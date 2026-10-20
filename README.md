# GreatWait delayed callback action

This Node 24 JavaScript action sends **one** `POST /v1/schedules` to GreatWait. It schedules a one-shot callback to an **existing endpoint ID** and exits, so the CI runner does not wait for the delay. It does not create an endpoint, verify delivery, retry a request, or cancel a schedule. There are no runtime packages, install step, build step, or network calls during tests.

## Inputs

| Input | Required | Meaning |
| --- | --- | --- |
| `api_key` | Yes | GreatWait API key scoped to the endpoint's project and environment with `schedules:write` only. Pass as a GitHub secret. |
| `endpoint` | Yes | Previously verified endpoint ID (`ep_...`). A URL is rejected so the action cannot implicitly create an endpoint. |
| `delay_seconds` | Yes | Whole-number delay, 1–158,000,000 seconds. GreatWait resolves this relative to acceptance time. |
| `idempotency_key` | Yes | Caller-generated 16–255 printable ASCII characters. Keep it stable for one logical request and identical body, including manual reruns within GreatWait's 24-hour receipt window. |
| `data_json` | No | JSON value for the default signed callback envelope, up to 65,536 UTF-8 bytes serialized. Do not include secrets. |

The action calls the fixed `https://api.greatwait.dev/v1/schedules` origin. It sets `redirect: manual`, a 10-second request deadline, and never logs the key, payload, response body, or raw exception. It does not call any GreatWait endpoint other than schedule creation. GreatWait may retry **callback delivery** according to its own policy; this action does not retry **schedule creation**.

## Outputs

On a validated HTTP 201 response, the action writes `schedule_id`, `occurrence_id`, and `planned_for` to `GITHUB_OUTPUT`. These mean **GreatWait returned a schedule**, not **callback delivered**. An idempotency replay may show a schedule that has since been paused, cancelled, or completed. Verify delivery later through GreatWait's occurrence and attempt records if your workflow requires that distinction. A malformed 201 response, timeout, lost connection, HTTP 408, or 5xx response has an **uncertain** scheduling outcome; inspect GreatWait before deciding whether to submit anything again. For 401, 403, 429, and other explicit non-201 client responses, the action fails without retrying. Never generate a new idempotency key for an uncertain replay. GreatWait honors a key for 24 hours and requires the identical request body; a rerun after that window can create a second schedule.

## Manual workflow example

See [`.github/workflows/manual-example.yml`](.github/workflows/manual-example.yml). It runs only through `workflow_dispatch`, uses `./` after checkout, and grants the GitHub token only `contents: read`. In another repository, use `flowxo/greatwait-action@v1.0.0` after the release tag is verified. Supply a secret named `GREATWAIT_SCHEDULES_WRITE_KEY` and an endpoint that already belongs to the key's GreatWait project and environment. Keep the same idempotency key when manually rerunning the same operation; `github.run_attempt` is unsuitable because it changes on rerun. A later run with a different delay or data must use a different key.

The example has not been run with credentials. The `api_key` input must contain a credential issued elsewhere; this action does not issue or store one.

## Local checks

With Node 24 installed, run `npm test` and `node --check main.js`. Tests use a mocked `fetch`; they make no HTTP requests.

## Contract sources

- [GitHub action metadata, including `node24`](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax)
- [GitHub JavaScript action packaging](https://docs.github.com/en/actions/tutorials/create-actions/create-a-javascript-action)
- [GreatWait schedule creation](https://docs.greatwait.dev/reference/api/schedules-create)
- [GreatWait limits and defaults](https://docs.greatwait.dev/reference/limits)
- [GreatWait errors and retries](https://docs.greatwait.dev/guides/errors-and-retries)

Released under the [MIT License](LICENSE), copyright 2026 Flow XO.
