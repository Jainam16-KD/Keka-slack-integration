## Kickdrum Slack-Keka Bot

Slack bot that applies leave in Keka via:
- slash command: `/apply-leave`
- automatic sick message detection in a configured channel

## Features

- Keka OAuth token flow with in-memory token cache
- Slack signature verification for all Slack routes
- Sick leave auto-apply based on channel + keywords
- Channel matching supports `SLACK_SICK_CHANNEL_ID` (preferred) with channel-name fallback
- Duplicate prevention:
  - in-memory idempotency window
  - best-effort existing leave lookup in Keka
- Optional debug endpoints (disabled by default)

## Required Environment Variables

```env
PORT=3000
NODE_ENV=development

SLACK_SIGNING_SECRET=
SLACK_BOT_TOKEN=
SLACK_SICK_CHANNEL_ID=
SLACK_SICK_CHANNEL=tmp-kd-off
SLACK_SICK_KEYWORDS=feeling sick,under the weather,not well,sick leave,unwell

KEKA_CLIENT_ID=
KEKA_CLIENT_SECRET=
KEKA_API_KEY=
KEKA_BASE_URL=https://kickdrum.keka.com
KEKA_AUTH_URL=https://login.keka.com/connect/token

SICK_LEAVE_TYPE_ID=
PAID_LEAVE_TYPE_ID=
UNPAID_LEAVE_TYPE_ID=
WFH_LEAVE_TYPE_ID=

LEAVE_IDEMPOTENCY_MINUTES=10
ENABLE_DEBUG_ENDPOINTS=false
```

## Install and Run

```bash
npm install
npm run dev
```

## Slash Command Usage

Default behavior:
- `/apply-leave` -> applies sick leave for today

Optional date input:
- `/apply-leave today`
- `/apply-leave tomorrow`
- `/apply-leave 2026-03-03`
- `/apply-leave 2026-03-03 2026-03-04`

Optional session input:
- append one of `fullday`, `firsthalf`, `secondhalf`
- example: `/apply-leave 2026-03-03 firsthalf`

Optional leave type input:
- use alias `sick|paid|unpaid|wfh` or explicit UUID
- examples: `/apply-leave 2026-03-03 paid` or `/apply-leave 2026-03-03 leaveTypeId=ABBE47B9-1AEF-4364-91E9-50EAD6C22E95`

Optional reason and note:
- append reason text after date/session/type
- add note with `note: ...`
- example: `/apply-leave 2026-03-03 firsthalf paid Health Issue note: casual Leave`

## Endpoints

- `POST /slack/commands`
- `POST /slack/events`
- `POST /slack/interactions`
- `POST /slack/workflows`
- `GET /health`

Debug-only endpoints (enabled when `ENABLE_DEBUG_ENDPOINTS=true`):
- `GET /test-keka/:email`
- `GET /keka/leave-types`
- `POST /keka/create-leave`
- `POST /keka/create-leave-by-email`
