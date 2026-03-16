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
SLACK_APPLY_LEAVE_COMMAND=/kd-apply-leave
SLACK_SICK_COMMAND=/kd-sick
SLACK_TODAY_LEAVES_COMMAND=/kd-leaves
SLACK_WORKFLOW_STEP_APPLY_LEAVE_CALLBACK_ID=kd_apply_leave_step
SLACK_WORKFLOW_STEP_SICK_CALLBACK_ID=kd_sick_step
SLACK_WORKFLOW_STEP_LEAVES_CALLBACK_ID=kd_leaves_step
SLACK_SICK_CHANNEL_ID=
SLACK_SICK_CHANNEL=tmp-kd-off
SLACK_SICK_KEYWORDS=feeling sick,under the weather,not well,sick leave,unwell

KEKA_CLIENT_ID=
KEKA_CLIENT_SECRET=
KEKA_API_KEY=
KEKA_BASE_URL=https://kickdrum.keka.com
KEKA_AUTH_URL=https://login.keka.com/connect/token

SICK_LEAVE_TYPE_ID=
EARNED_LEAVE_TYPE_ID=
UNEARNED_LEAVE_TYPE_ID=
WFH_LEAVE_TYPE_ID=

LEAVE_IDEMPOTENCY_MINUTES=10
ENABLE_DEBUG_ENDPOINTS=false
ALLOW_LOCAL_TEST_USER=false
LOCAL_TEST_USER_EMAIL=
```

## Install and Run

```bash
npm install
npm run dev
```

## Slash Command Usage

Default behavior:
- `/kd-apply-leave` -> opens a Slack modal to collect leave details
- `/kd-sick` -> directly applies sick leave for today
- `/kd-leaves` -> shows today's leave board grouped by leave type across the workspace

Optional prefill text:
- Command text can prefill the modal fields before submit.
- Final leave request is created only after user clicks `Apply` in modal.

Optional prefill date input:
- `/kd-apply-leave today`
- `/kd-apply-leave tomorrow`
- `/kd-apply-leave 2026-03-03`
- `/kd-apply-leave 2026-03-03 2026-03-04`

Optional prefill session input:
- append one of `fullday`, `firsthalf`, `secondhalf`
- example: `/kd-apply-leave 2026-03-03 firsthalf`

Optional prefill leave type input:
- use alias `sick|paid|unpaid|wfh` or explicit UUID
- examples: `/kd-apply-leave 2026-03-03 paid` or `/kd-apply-leave 2026-03-03 leaveTypeId=ABBE47B9-1AEF-4364-91E9-50EAD6C22E95`

Optional prefill reason and note:
- append reason text after date/session/type
- add note with `note: ...`
- example: `/kd-apply-leave 2026-03-03 firsthalf paid Health Issue note: casual Leave`

## Endpoints

- `POST /slack/commands`
- `POST /slack/events`
- `POST /slack/interactions`
- `POST /slack/workflows`
- `GET /health`

## Workflow Steps (From Apps)

The app supports 3 workflow step callback IDs:
- `kd_apply_leave_step` -> same behavior as `/kd-apply-leave`
- `kd_sick_step` -> same behavior as `/kd-sick`
- `kd_leaves_step` -> same behavior as `/kd-leaves`

Recommended step inputs:
- `kd_apply_leave_step`: `user_id` or `email` or `employee_id`, optional `from_date`, `to_date`, `session`, `leave_type_id`, `reason`, `note`
- `kd_sick_step`: `user_id` or `email` or `employee_id`, optional `reason`
- `kd_leaves_step`: no required inputs

Step outputs returned by the app:
- `result_text` (all 3 steps)
- `is_duplicate` (apply/sick)
- `from_date`, `to_date`, `leave_type_id` (apply)
- `leave_date` (sick)
- `leave_count`, `date` (leaves)

Debug-only endpoints (enabled when `ENABLE_DEBUG_ENDPOINTS=true`):
- `GET /test-keka/:email`
- `GET /keka/leave-types`
- `POST /keka/create-leave`
- `POST /keka/create-leave-by-email`
