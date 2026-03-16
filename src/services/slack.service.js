const logger = require("../utils/logger");
const { WebClient } = require("@slack/web-api");
const axios = require("axios");
const kekaService = require("./keka.service");
const config = require("../config/config");

const slackClient = new WebClient(config.slack.botToken);
const leaveIdempotencyCache = new Map();

const SESSION_MAP = {
  fullday: { fromSession: 0, toSession: 1 },
  firsthalf: { fromSession: 0, toSession: 0 },
  secondhalf: { fromSession: 1, toSession: 1 },
};

const LEAVE_TYPE_ALIASES = {
  sick: () => config.leaveTypes.sick,
  paid: () => config.leaveTypes.paid,
  unpaid: () => config.leaveTypes.unpaid,
  wfh: () => config.leaveTypes.wfh,
};

const LEAVE_MODAL_CALLBACK_ID = "apply_leave_modal";
const WORKFLOW_STEP_CALLBACKS = {
  applyLeave: config.slack.workflowSteps.applyLeave,
  sick: config.slack.workflowSteps.sick,
  leaves: config.slack.workflowSteps.leaves,
};
const LEAVE_MODAL_BLOCKS = {
  fromDate: { blockId: "from_date_block", actionId: "from_date" },
  toDate: { blockId: "to_date_block", actionId: "to_date" },
  session: { blockId: "session_block", actionId: "session" },
  leaveType: { blockId: "leave_type_block", actionId: "leave_type" },
  reason: { blockId: "reason_block", actionId: "reason" },
  note: { blockId: "note_block", actionId: "note" },
};

const SESSION_OPTIONS = [
  {
    text: { type: "plain_text", text: "Full Day" },
    value: "fullday",
  },
  {
    text: { type: "plain_text", text: "First Half" },
    value: "firsthalf",
  },
  {
    text: { type: "plain_text", text: "Second Half" },
    value: "secondhalf",
  },
];

function utcDateOnly(date = new Date()) {
  return date.toISOString().split("T")[0];
}

function getDateOffset(baseDate, offsetDays) {
  const date = new Date(baseDate);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return utcDateOnly(date);
}

function parseDateText(input) {
  if (!input) return null;
  const normalized = input.trim().toLowerCase();
  if (normalized === "today") return utcDateOnly();
  if (normalized === "tomorrow") return getDateOffset(new Date(), 1);

  const isoRegex = /^\d{4}-\d{2}-\d{2}$/;
  return isoRegex.test(normalized) ? normalized : null;
}

function parseLeaveCommand(rawText = "") {
  const args = rawText.trim().split(/\s+/).filter(Boolean);
  const today = utcDateOnly();
  const parsed = {
    fromDate: today,
    toDate: today,
    reason: rawText?.trim() || "Applied via Slack",
    note: "Applied via Slack",
    leaveTypeId: null,
    fromSession: SESSION_MAP.fullday.fromSession,
    toSession: SESSION_MAP.fullday.toSession,
  };

  if (args.length === 0) return parsed;

  const consumedIndices = new Set();
  const firstDate = parseDateText(args[0]);
  if (firstDate) {
    parsed.fromDate = firstDate;
    parsed.toDate = firstDate;
    consumedIndices.add(0);

    if (args[1]) {
      const secondDate = parseDateText(args[1]);
      if (secondDate) {
        parsed.toDate = secondDate;
        consumedIndices.add(1);
      }
    }
  }

  const sessionIndex = args.findIndex((arg) => SESSION_MAP[arg.toLowerCase()]);
  if (sessionIndex >= 0) {
    const session = SESSION_MAP[args[sessionIndex].toLowerCase()];
    parsed.fromSession = session.fromSession;
    parsed.toSession = session.toSession;
    consumedIndices.add(sessionIndex);
  }

  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const leaveTypeIndex = args.findIndex((arg) => {
    const value = arg.toLowerCase();
    return (
      Object.keys(LEAVE_TYPE_ALIASES).includes(value) ||
      value.startsWith("type=") ||
      value.startsWith("type:") ||
      value.startsWith("leavetypeid=") ||
      value.startsWith("leavetypeid:") ||
      uuidRegex.test(arg)
    );
  });

  if (leaveTypeIndex >= 0) {
    const rawValue = args[leaveTypeIndex];
    const normalized = rawValue.toLowerCase();
    const extractedValue = normalized.includes("=") || normalized.includes(":")
      ? rawValue.split(/[=:]/).slice(1).join(":").trim()
      : rawValue;
    const aliasResolver = LEAVE_TYPE_ALIASES[extractedValue.toLowerCase()];
    parsed.leaveTypeId = aliasResolver ? aliasResolver() : extractedValue;
    consumedIndices.add(leaveTypeIndex);
  }

  const freeText = args
    .filter((_, index) => !consumedIndices.has(index))
    .join(" ")
    .trim();

  if (freeText) {
    const noteMarker = /\bnote\s*:\s*/i;
    const markerMatch = freeText.match(noteMarker);
    if (markerMatch?.index !== undefined) {
      const markerStart = markerMatch.index;
      const noteStart = markerStart + markerMatch[0].length;
      const reasonText = freeText.slice(0, markerStart).trim();
      const noteText = freeText.slice(noteStart).trim();
      parsed.reason = reasonText || "Applied via Slack";
      parsed.note = noteText || "Applied via Slack";
    } else {
      parsed.reason = freeText;
    }
  }

  return parsed;
}

function getLeaveTypeOptions() {
  const options = [];
  if (config.leaveTypes.sick) {
    options.push({
      text: { type: "plain_text", text: "Sick Leave" },
      value: config.leaveTypes.sick,
    });
  }
  if (config.leaveTypes.paid) {
    options.push({
      text: { type: "plain_text", text: "Paid Leave" },
      value: config.leaveTypes.paid,
    });
  }
  if (config.leaveTypes.unpaid) {
    options.push({
      text: { type: "plain_text", text: "Unpaid Leave" },
      value: config.leaveTypes.unpaid,
    });
  }
  if (config.leaveTypes.wfh) {
    options.push({
      text: { type: "plain_text", text: "Work From Home" },
      value: config.leaveTypes.wfh,
    });
  }
  return options;
}

function getSessionKey(fromSession, toSession) {
  if (fromSession === 0 && toSession === 0) return "firsthalf";
  if (fromSession === 1 && toSession === 1) return "secondhalf";
  return "fullday";
}

function buildApplyLeaveModal(parsedLeave) {
  const leaveTypeOptions = getLeaveTypeOptions();
  const selectedLeaveType =
    leaveTypeOptions.find((option) => option.value === parsedLeave.leaveTypeId) ||
    leaveTypeOptions.find((option) => option.value === config.leaveTypes.sick) ||
    leaveTypeOptions[0];
  const selectedSession = SESSION_OPTIONS.find(
    (option) => option.value === getSessionKey(parsedLeave.fromSession, parsedLeave.toSession)
  );

  return {
    type: "modal",
    callback_id: LEAVE_MODAL_CALLBACK_ID,
    title: {
      type: "plain_text",
      text: "Apply Leave",
    },
    submit: {
      type: "plain_text",
      text: "Apply",
    },
    close: {
      type: "plain_text",
      text: "Cancel",
    },
    blocks: [
      {
        type: "input",
        block_id: LEAVE_MODAL_BLOCKS.fromDate.blockId,
        label: {
          type: "plain_text",
          text: "From Date",
        },
        element: {
          type: "datepicker",
          action_id: LEAVE_MODAL_BLOCKS.fromDate.actionId,
          initial_date: parsedLeave.fromDate,
        },
      },
      {
        type: "input",
        block_id: LEAVE_MODAL_BLOCKS.toDate.blockId,
        label: {
          type: "plain_text",
          text: "To Date",
        },
        element: {
          type: "datepicker",
          action_id: LEAVE_MODAL_BLOCKS.toDate.actionId,
          initial_date: parsedLeave.toDate,
        },
      },
      {
        type: "input",
        block_id: LEAVE_MODAL_BLOCKS.session.blockId,
        label: {
          type: "plain_text",
          text: "Session",
        },
        element: {
          type: "static_select",
          action_id: LEAVE_MODAL_BLOCKS.session.actionId,
          options: SESSION_OPTIONS,
          initial_option: selectedSession || SESSION_OPTIONS[0],
        },
      },
      {
        type: "input",
        block_id: LEAVE_MODAL_BLOCKS.leaveType.blockId,
        label: {
          type: "plain_text",
          text: "Leave Type",
        },
        element: {
          type: "static_select",
          action_id: LEAVE_MODAL_BLOCKS.leaveType.actionId,
          options: leaveTypeOptions,
          initial_option: selectedLeaveType,
        },
      },
      {
        type: "input",
        block_id: LEAVE_MODAL_BLOCKS.reason.blockId,
        optional: true,
        label: {
          type: "plain_text",
          text: "Reason",
        },
        element: {
          type: "plain_text_input",
          action_id: LEAVE_MODAL_BLOCKS.reason.actionId,
          initial_value: parsedLeave.reason || "",
        },
      },
      {
        type: "input",
        block_id: LEAVE_MODAL_BLOCKS.note.blockId,
        optional: true,
        label: {
          type: "plain_text",
          text: "Note",
        },
        element: {
          type: "plain_text_input",
          action_id: LEAVE_MODAL_BLOCKS.note.actionId,
          initial_value: parsedLeave.note || "",
        },
      },
    ],
  };
}

function readInteractionPayload(reqBody) {
  if (typeof reqBody?.payload === "string") {
    return JSON.parse(reqBody.payload);
  }
  return reqBody;
}

function getViewStateValue(view, blockId, actionId) {
  return view?.state?.values?.[blockId]?.[actionId];
}

function buildSubmissionFromView(payload) {
  const view = payload.view;
  const fromDate = getViewStateValue(
    view,
    LEAVE_MODAL_BLOCKS.fromDate.blockId,
    LEAVE_MODAL_BLOCKS.fromDate.actionId
  )?.selected_date;
  const toDate = getViewStateValue(
    view,
    LEAVE_MODAL_BLOCKS.toDate.blockId,
    LEAVE_MODAL_BLOCKS.toDate.actionId
  )?.selected_date;
  const sessionKey =
    getViewStateValue(
      view,
      LEAVE_MODAL_BLOCKS.session.blockId,
      LEAVE_MODAL_BLOCKS.session.actionId
    )?.selected_option?.value || "fullday";
  const leaveTypeId =
    getViewStateValue(
      view,
      LEAVE_MODAL_BLOCKS.leaveType.blockId,
      LEAVE_MODAL_BLOCKS.leaveType.actionId
    )?.selected_option?.value || config.leaveTypes.sick;
  const reason =
    getViewStateValue(
      view,
      LEAVE_MODAL_BLOCKS.reason.blockId,
      LEAVE_MODAL_BLOCKS.reason.actionId
    )?.value?.trim() || "Applied via Slack";
  const note =
    getViewStateValue(
      view,
      LEAVE_MODAL_BLOCKS.note.blockId,
      LEAVE_MODAL_BLOCKS.note.actionId
    )?.value?.trim() || "Applied via Slack";
  const session = SESSION_MAP[sessionKey] || SESSION_MAP.fullday;

  return {
    userId: payload.user?.id,
    fromDate,
    toDate,
    leaveTypeId,
    fromSession: session.fromSession,
    toSession: session.toSession,
    reason,
    note,
  };
}

function validateModalSubmission(submission) {
  const errors = {};
  if (!submission.fromDate) {
    errors[LEAVE_MODAL_BLOCKS.fromDate.blockId] = "From date is required";
  }
  if (!submission.toDate) {
    errors[LEAVE_MODAL_BLOCKS.toDate.blockId] = "To date is required";
  }
  if (submission.fromDate && submission.toDate && submission.toDate < submission.fromDate) {
    errors[LEAVE_MODAL_BLOCKS.toDate.blockId] = "To date must be on or after from date";
  }
  if (!submission.leaveTypeId) {
    errors[LEAVE_MODAL_BLOCKS.leaveType.blockId] = "Leave type is required";
  }
  return errors;
}

function normalizeLeaveRequestRecords(response) {
  if (Array.isArray(response?.data)) return response.data;
  if (Array.isArray(response)) return response;
  return [];
}

function toDateOnly(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().split("T")[0];
}

function isActiveStatus(status) {
  const normalized = String(status || "").toLowerCase();
  const statusCode = Number(status);
  if (!Number.isNaN(statusCode)) {
    return ![2, 3].includes(statusCode);
  }
  if (!normalized) return true;
  return !["cancelled", "rejected"].includes(normalized);
}

function getLeaveTypeLabel(record) {
  return (
    record.selection?.[0]?.leaveTypeName ||
    record.leaveTypeName ||
    record.leaveType?.name ||
    record.leaveType?.displayName ||
    record.selection?.[0]?.leaveTypeIdentifier ||
    record.leaveTypeId ||
    "Unknown Leave Type"
  );
}

function getRecordEmployeeId(record) {
  return String(record.employeeId || record.employeeIdentifier || record.employee?.id || "")
    .trim()
    .toLowerCase();
}

function getEmployeeDisplayLabel(record, employeeDirectory = new Map()) {
  const employeeId = getRecordEmployeeId(record);
  const directoryEntry = employeeDirectory.get(employeeId);
  const employeeName = String(directoryEntry?.employeeName || "").trim();
  const employeeNumber = String(
    directoryEntry?.employeeNumber || record.employeeNumber || ""
  ).trim();
  if (employeeName && employeeNumber) {
    return `${employeeName} (#${employeeNumber})`;
  }
  if (employeeName) {
    return `${employeeName} (${employeeId.slice(0, 8)})`;
  }
  if (employeeNumber && employeeId) {
    return `#${employeeNumber} (${employeeId.slice(0, 8)})`;
  }
  if (employeeNumber) {
    return `#${employeeNumber}`;
  }
  if (employeeId) {
    return employeeId.slice(0, 8);
  }
  return "Unknown";
}

function getStatusBucket(status) {
  const statusCode = Number(status);
  if (!Number.isNaN(statusCode)) {
    if (statusCode === 0) return "pending";
    if (statusCode === 1) return "approved";
    if (statusCode === 2) return "rejected";
    if (statusCode === 3) return "cancelled";
  }

  const normalized = String(status || "").toLowerCase();
  if (!normalized) return "approved";
  if (normalized.includes("pending")) return "pending";
  if (normalized.includes("approve")) return "approved";
  if (normalized.includes("reject")) return "rejected";
  if (normalized.includes("cancel")) return "cancelled";
  return "approved";
}

function getRecordStatusLabel(record) {
  return record.status || "Applied";
}

function isDateWithinRange(date, startDate, endDate) {
  return startDate <= date && date <= endDate;
}

function getTodayLeaveRecords(records) {
  const today = utcDateOnly();
  return records.filter((record) => {
    const fromDate = toDateOnly(record.fromDate || record.startDate);
    const toDate = toDateOnly(record.toDate || record.endDate || record.fromDate || record.startDate);
    if (!fromDate || !toDate) return false;
    if (!isActiveStatus(record.status)) return false;
    return isDateWithinRange(today, fromDate, toDate);
  });
}

function buildTodayLeavesText(todayRecords, employeeDirectory = new Map()) {
  if (todayRecords.length === 0) {
    return "ℹ️ No leave requests found for today.";
  }

  const grouped = new Map();

  for (const record of todayRecords) {
    const leaveType = getLeaveTypeLabel(record);
    if (!grouped.has(leaveType)) {
      grouped.set(leaveType, {
        people: new Set(),
        pending: 0,
        approved: 0,
      });
    }

    const entry = grouped.get(leaveType);
    entry.people.add(getEmployeeDisplayLabel(record, employeeDirectory));
    const status = getStatusBucket(record.status);
    if (status === "pending") {
      entry.pending += 1;
    } else if (status === "approved") {
      entry.approved += 1;
    }
  }

  const ordered = [...grouped.entries()].sort((a, b) => b[1].people.size - a[1].people.size);
  const lines = ordered.map(([leaveType, info]) => {
    const people = [...info.people].sort();
    const peoplePreview = people.slice(0, 12).join(", ");
    const overflow =
      people.length > 12 ? `, +${people.length - 12} more` : "";
    return `- ${leaveType}: ${people.length} people (Approved: ${info.approved}, Pending: ${info.pending}) -> ${peoplePreview}${overflow}`;
  });

  return `📋 Today's leave board (${utcDateOnly()}):\n${lines.join("\n")}`;
}

async function notifyUser(userId, text) {
  await slackClient.chat.postMessage({
    channel: userId,
    text,
  });
}

async function postSlashFollowup(responseUrl, text) {
  if (!responseUrl) {
    throw new Error("Missing response_url for slash follow-up");
  }

  await axios.post(responseUrl, {
    response_type: "ephemeral",
    replace_original: false,
    text,
  });
}

function parseWorkflowStepExecuteEvent(body) {
  if (!body) return null;

  if (body.type === "workflow_step_execute") {
    return body;
  }

  if (body.type === "event_callback" && body.event?.type === "workflow_step_execute") {
    return body.event;
  }

  return null;
}

function getWorkflowInputValue(inputs, key, fallback = "") {
  const input = inputs?.[key];
  if (!input) return fallback;

  if (typeof input === "string") {
    return input;
  }

  if (typeof input.value === "string") {
    return input.value;
  }

  return fallback;
}

async function resolveEmployeeForWorkflow(event) {
  const inputs = event.workflow_step?.inputs || {};
  const explicitEmployeeId = getWorkflowInputValue(inputs, "employee_id", "").trim();
  const explicitEmail = getWorkflowInputValue(inputs, "email", "").trim();
  const explicitUserId = getWorkflowInputValue(inputs, "user_id", "").trim();
  const eventUserId = event.user?.id || "";

  if (explicitEmployeeId) {
    return { id: explicitEmployeeId };
  }

  if (explicitEmail) {
    return kekaService.getEmployeeByEmail(explicitEmail);
  }

  const userId = explicitUserId || eventUserId;
  if (!userId) {
    throw new Error("Workflow step requires one of: employee_id, email, or user_id");
  }

  const email = await getUserEmail(userId);
  return kekaService.getEmployeeByEmail(email);
}

function parseSessionInput(sessionInput = "") {
  const normalized = String(sessionInput).trim().toLowerCase();
  return SESSION_MAP[normalized] || SESSION_MAP.fullday;
}

async function completeWorkflowStep(workflowStepExecuteId, outputs) {
  const payload = {
    workflow_step_execute_id: workflowStepExecuteId,
  };
  if (outputs && Object.keys(outputs).length > 0) {
    payload.outputs = outputs;
  }
  await slackClient.workflows.stepCompleted(payload);
}

async function failWorkflowStep(workflowStepExecuteId, message) {
  await slackClient.workflows.stepFailed({
    workflow_step_execute_id: workflowStepExecuteId,
    error: {
      message: message || "Workflow step failed",
    },
  });
}

async function executeWorkflowApplyLeave(event) {
  const inputs = event.workflow_step?.inputs || {};
  const employee = await resolveEmployeeForWorkflow(event);

  const fromDate = parseDateText(getWorkflowInputValue(inputs, "from_date", "")) || utcDateOnly();
  const toDate = parseDateText(getWorkflowInputValue(inputs, "to_date", "")) || fromDate;
  const session = parseSessionInput(getWorkflowInputValue(inputs, "session", "fullday"));
  const leaveTypeId =
    getWorkflowInputValue(inputs, "leave_type_id", "").trim() || config.leaveTypes.sick;
  const reason = getWorkflowInputValue(inputs, "reason", "").trim() || "Applied via workflow step";
  const note = getWorkflowInputValue(inputs, "note", "").trim() || "Applied via workflow step";

  const result = await applyLeaveIfNotDuplicate({
    employeeId: employee.id,
    leaveTypeId,
    fromDate,
    toDate,
    fromSession: session.fromSession,
    toSession: session.toSession,
    reason,
    note,
  });

  return {
    result_text: result.duplicate
      ? "A matching leave request already exists"
      : "Leave request applied successfully",
    is_duplicate: result.duplicate ? "true" : "false",
    from_date: fromDate,
    to_date: toDate,
    leave_type_id: leaveTypeId,
  };
}

async function executeWorkflowSick(event) {
  const inputs = event.workflow_step?.inputs || {};
  const employee = await resolveEmployeeForWorkflow(event);
  const today = utcDateOnly();
  const reason = getWorkflowInputValue(inputs, "reason", "").trim() || "Applied via workflow / sick step";

  const result = await applyLeaveIfNotDuplicate({
    employeeId: employee.id,
    leaveTypeId: config.leaveTypes.sick,
    fromDate: today,
    toDate: today,
    fromSession: SESSION_MAP.fullday.fromSession,
    toSession: SESSION_MAP.fullday.toSession,
    reason,
    note: "Applied via workflow / sick step",
  });

  return {
    result_text: result.duplicate
      ? "A matching sick leave request already exists"
      : "Sick leave applied successfully",
    is_duplicate: result.duplicate ? "true" : "false",
    leave_date: today,
  };
}

async function executeWorkflowLeaves() {
  const { todayRecords, employeeDirectory } = await getTodayLeavesForWorkspace();
  return {
    result_text: buildTodayLeavesText(todayRecords, employeeDirectory),
    leave_count: todayRecords.length,
    date: utcDateOnly(),
  };
}

async function applySickLeaveForToday(userId, reasonText) {
  const email = await getUserEmail(userId);
  const employee = await kekaService.getEmployeeByEmail(email);
  const today = utcDateOnly();
  const result = await applyLeaveIfNotDuplicate({
    employeeId: employee.id,
    leaveTypeId: config.leaveTypes.sick,
    fromDate: today,
    toDate: today,
    fromSession: SESSION_MAP.fullday.fromSession,
    toSession: SESSION_MAP.fullday.toSession,
    reason: reasonText || "Applied via /kd-sick",
    note: "Applied via /kd-sick",
  });

  return { result, today };
}

async function getTodayLeavesForWorkspace() {
  const rawLeaveRequests = await kekaService.getLeaveRequests();
  const records = normalizeLeaveRequestRecords(rawLeaveRequests);
  const employeeDirectory = await kekaService.getEmployeeDirectory();
  return {
    todayRecords: getTodayLeaveRecords(records),
    employeeDirectory,
  };
}

async function processLeaveSubmission(submission) {
  const email = await getUserEmail(submission.userId);
  const employee = await kekaService.getEmployeeByEmail(email);
  const result = await applyLeaveIfNotDuplicate({
    employeeId: employee.id,
    leaveTypeId: submission.leaveTypeId,
    fromDate: submission.fromDate,
    toDate: submission.toDate,
    fromSession: submission.fromSession,
    toSession: submission.toSession,
    reason: submission.reason,
    note: submission.note,
  });

  if (result.duplicate) {
    await notifyUser(
      submission.userId,
      `ℹ️ A matching leave request already exists (${submission.fromDate} to ${submission.toDate}).`
    );
    return;
  }

  await notifyUser(
    submission.userId,
    `✅ Leave applied in Keka (${submission.fromDate} to ${submission.toDate}).`
  );
}

function makeLeaveCacheKey({ employeeId, leaveTypeId, fromDate, toDate, fromSession, toSession }) {
  return [
    employeeId,
    leaveTypeId,
    fromDate,
    toDate,
    fromSession,
    toSession,
  ].join("|");
}

function cleanupIdempotencyCache() {
  const now = Date.now();
  for (const [key, expiry] of leaveIdempotencyCache.entries()) {
    if (expiry <= now) {
      leaveIdempotencyCache.delete(key);
    }
  }
}

function cacheLeaveApplication(cacheKey) {
  cleanupIdempotencyCache();
  const ttl = config.app.leaveIdempotencyMinutes * 60 * 1000;
  leaveIdempotencyCache.set(cacheKey, Date.now() + ttl);
}

function hasRecentApplication(cacheKey) {
  cleanupIdempotencyCache();
  const expiry = leaveIdempotencyCache.get(cacheKey);
  return Boolean(expiry && expiry > Date.now());
}

async function applyLeaveIfNotDuplicate({
  employeeId,
  leaveTypeId,
  fromDate,
  toDate,
  fromSession,
  toSession,
  reason,
  note,
}) {
  const cacheKey = makeLeaveCacheKey({
    employeeId,
    leaveTypeId,
    fromDate,
    toDate,
    fromSession,
    toSession,
  });

  if (hasRecentApplication(cacheKey)) {
    return { applied: false, duplicate: true, source: "idempotency-cache" };
  }

  const existsInKeka = await kekaService.hasExistingLeaveRequest({
    employeeId,
    leaveTypeId,
    fromDate,
    toDate,
  });

  if (existsInKeka) {
    cacheLeaveApplication(cacheKey);
    return { applied: false, duplicate: true, source: "keka-existing-record" };
  }

  await kekaService.createLeaveRequest({
    employeeId,
    leaveTypeId,
    fromDate,
    toDate,
    fromSession,
    toSession,
    reason,
    note,
  });

  cacheLeaveApplication(cacheKey);
  return { applied: true, duplicate: false };
}

async function getUserEmail(userId) {
  if (
    config.app.allowLocalTestUser &&
    config.app.localTestUserEmail &&
    config.nodeEnv !== "production"
  ) {
    logger.info("Using local test user email override", {
      userId,
      localTestUserEmail: config.app.localTestUserEmail,
    });
    return config.app.localTestUserEmail;
  }

  const userInfo = await slackClient.users.info({ user: userId });
  const email = userInfo?.user?.profile?.email;
  if (!email) {
    throw new Error("Unable to resolve Slack user email");
  }
  return email;
}

async function isConfiguredSickChannel(channelId) {
  if (config.slack.sickChannelId) {
    return channelId === config.slack.sickChannelId;
  }

  const channelInfo = await slackClient.conversations.info({ channel: channelId });
  const actualChannel = channelInfo?.channel?.name;
  return actualChannel === config.slack.sickChannel;
}

/**
 * Handle Slash Command
 */
exports.handleSlashCommand = async (req, res) => {
  const { command, user_id, text, trigger_id, response_url: responseUrl } = req.body;

  logger.info("Slash command received", { command, user_id });
  const supportedCommands = [
    config.slack.commands.applyLeave,
    config.slack.commands.sick,
    config.slack.commands.todayLeaves,
  ].filter(Boolean);

  if (!supportedCommands.includes(command)) {
    return res.json({
      response_type: "ephemeral",
      text: `Unknown command. Use one of: ${supportedCommands.join(", ")}`,
    });
  }

  if (command === config.slack.commands.applyLeave) {
    try {
      const parsedLeave = parseLeaveCommand(text);
      await slackClient.views.open({
        trigger_id,
        view: buildApplyLeaveModal(parsedLeave),
      });
      return res.status(200).send();
    } catch (err) {
      logger.error("Apply leave command failed", { error: err.message });
      return res.json({
        response_type: "ephemeral",
        text: "❌ Failed to open leave modal",
      });
    }
  }

  if (command === config.slack.commands.sick) {
    res.json({
      response_type: "ephemeral",
      text: "Processing sick leave request...",
    });

    setImmediate(async () => {
      try {
        const { result, today } = await applySickLeaveForToday(user_id, text?.trim());
        const finalText = result.duplicate
          ? "ℹ️ A matching sick leave request already exists for today."
          : `✅ Sick leave applied for today (${today}).`;
        await postSlashFollowup(responseUrl, finalText);
      } catch (err) {
        logger.error("Sick command failed", { error: err.message });
        try {
          await postSlashFollowup(responseUrl, "❌ Failed to apply sick leave");
        } catch (followupError) {
          logger.error("Failed to send sick command follow-up", {
            error: followupError.message,
          });
          await notifyUser(user_id, "❌ Failed to apply sick leave");
        }
      }
    });
    return;
  }

  if (command === config.slack.commands.todayLeaves) {
    res.json({
      response_type: "ephemeral",
      text: "Fetching today's leave requests...",
    });

    setImmediate(async () => {
      try {
        const { todayRecords, employeeDirectory } = await getTodayLeavesForWorkspace();
        await postSlashFollowup(
          responseUrl,
          buildTodayLeavesText(todayRecords, employeeDirectory)
        );
      } catch (err) {
        logger.error("Today leaves command failed", { error: err.message });
        try {
          await postSlashFollowup(responseUrl, "❌ Failed to fetch today's leaves");
        } catch (followupError) {
          logger.error("Failed to send today leaves follow-up", {
            error: followupError.message,
          });
          await notifyUser(user_id, "❌ Failed to fetch today's leaves");
        }
      }
    });
    return;
  }

  return res.status(200).send();
};

/**
 * Handle Slack Events (Channel messages)
 */
exports.handleEvent = async (req, res) => {
  const body = req.body;
  const event = body.event;
  const eventContext = {
    eventId: body.event_id,
    eventType: event?.type,
    channel: event?.channel,
    user: event?.user,
  };

  if (body.type === "url_verification") {
    logger.info("Slack URL verification challenge received");
    return res.json({ challenge: body.challenge });
  }

  logger.info("Slack event received", eventContext);
  res.status(200).send(); // Immediately respond

  if (!event || event.type !== "message") return;
  if (!event.text) return;
  if (event.subtype) return;
  if (event.bot_id) return;
  if (!event.user) return;

  try {
    const isSickChannel = await isConfiguredSickChannel(event.channel);
    if (!isSickChannel) {
      logger.info("Skipped Slack message outside configured sick channel", eventContext);
      return;
    }

    const text = event.text.toLowerCase();
    const isSick = config.slack.sickKeywords.some((keyword) =>
      text.includes(keyword)
    );
    if (!isSick) {
      logger.info("Skipped Slack message without sick keywords", eventContext);
      return;
    }

    const email = await getUserEmail(event.user);

    const employee = await kekaService.getEmployeeByEmail(email);

    const today = utcDateOnly();
    const leaveTypeId = config.leaveTypes.sick;

    const result = await applyLeaveIfNotDuplicate({
      employeeId: employee.id,
      leaveTypeId,
      fromDate: today,
      toDate: today,
      fromSession: SESSION_MAP.fullday.fromSession,
      toSession: SESSION_MAP.fullday.toSession,
      reason: "Auto-applied via Slack sick detection",
      note: "Auto-applied via Slack sick detection",
    });

    if (result.duplicate) {
      logger.info("Skipped duplicate sick leave request", {
        ...eventContext,
        source: result.source,
      });
      return;
    }

    await slackClient.chat.postMessage({
      channel: event.channel,
      text: `🤒 Sick leave applied for <@${event.user}>`,
    });

    logger.info("Sick leave applied from Slack event", {
      ...eventContext,
      employeeId: employee.id,
      fromDate: today,
      toDate: today,
    });
  } catch (err) {
    logger.error("Event handling failed", { ...eventContext, error: err.message });
  }
};

exports.handleInteraction = async (req, res) => {
  try {
    const payload = readInteractionPayload(req.body);
    logger.info("Interaction received", {
      type: payload.type,
      callbackId: payload.view?.callback_id,
      user: payload.user?.id,
    });

    if (payload.type !== "view_submission") {
      return res.status(200).send();
    }

    if (payload.view?.callback_id !== LEAVE_MODAL_CALLBACK_ID) {
      return res.status(200).send();
    }

    const submission = buildSubmissionFromView(payload);
    const validationErrors = validateModalSubmission(submission);

    if (Object.keys(validationErrors).length > 0) {
      return res.json({
        response_action: "errors",
        errors: validationErrors,
      });
    }

    res.json({ response_action: "clear" });

    setImmediate(async () => {
      try {
        await processLeaveSubmission(submission);
      } catch (error) {
        logger.error("Failed to process leave submission", {
          user: submission.userId,
          error: error.message,
        });
        try {
          await notifyUser(submission.userId, "❌ Failed to apply leave in Keka.");
        } catch (notifyError) {
          logger.error("Failed to notify user for leave submission error", {
            user: submission.userId,
            error: notifyError.message,
          });
        }
      }
    });
    return;
  } catch (error) {
    logger.error("Interaction handling failed", { error: error.message });
    return res.status(400).send("Invalid interaction payload");
  }
};

exports.handleWorkflow = async (req, res) => {
  const event = parseWorkflowStepExecuteEvent(req.body);
  if (!event) {
    logger.info("Unsupported workflow payload received");
    return res.status(200).send();
  }

  const callbackId = event.callback_id || event.workflow_step?.callback_id;
  const workflowStepExecuteId = event.workflow_step_execute_id;
  logger.info("Workflow step execute received", {
    callbackId,
    workflowStepExecuteId,
  });

  res.status(200).send();

  setImmediate(async () => {
    try {
      if (!workflowStepExecuteId) {
        throw new Error("Missing workflow_step_execute_id");
      }

      let outputs = {};
      if (callbackId === WORKFLOW_STEP_CALLBACKS.applyLeave) {
        outputs = await executeWorkflowApplyLeave(event);
      } else if (callbackId === WORKFLOW_STEP_CALLBACKS.sick) {
        outputs = await executeWorkflowSick(event);
      } else if (callbackId === WORKFLOW_STEP_CALLBACKS.leaves) {
        outputs = await executeWorkflowLeaves();
      } else {
        throw new Error(`Unknown workflow callback_id: ${callbackId}`);
      }

      await completeWorkflowStep(workflowStepExecuteId, outputs);
      logger.info("Workflow step completed", {
        callbackId,
        workflowStepExecuteId,
      });
    } catch (error) {
      logger.error("Workflow step failed", {
        callbackId,
        workflowStepExecuteId,
        error: error.message,
      });

      if (workflowStepExecuteId) {
        try {
          await failWorkflowStep(workflowStepExecuteId, error.message);
        } catch (stepFailError) {
          logger.error("Unable to report workflow step failure", {
            callbackId,
            workflowStepExecuteId,
            error: stepFailError.message,
          });
        }
      }
    }
  });
};
