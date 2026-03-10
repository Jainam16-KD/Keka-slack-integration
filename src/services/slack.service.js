const logger = require("../utils/logger");
const { WebClient } = require("@slack/web-api");
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
  const { command, user_id, text } = req.body;

  logger.info("Slash command received", { command, user_id });

  if (command !== "/apply-leave") {
    return res.json({
      response_type: "ephemeral",
      text: "Unknown command",
    });
  }

  try {
    const email = await getUserEmail(user_id);
    const employee = await kekaService.getEmployeeByEmail(email);
    const parsedLeave = parseLeaveCommand(text);
    const leaveTypeId = parsedLeave.leaveTypeId || config.leaveTypes.sick;
    const result = await applyLeaveIfNotDuplicate({
      employeeId: employee.id,
      leaveTypeId,
      fromDate: parsedLeave.fromDate,
      toDate: parsedLeave.toDate,
      fromSession: parsedLeave.fromSession,
      toSession: parsedLeave.toSession,
      reason: parsedLeave.reason,
      note: parsedLeave.note,
    });

    if (result.duplicate) {
      return res.json({
        response_type: "ephemeral",
        text: "ℹ️ A matching leave request already exists.",
      });
    }

    return res.json({
      response_type: "ephemeral",
      text: `✅ Sick leave applied in Keka (${parsedLeave.fromDate} to ${parsedLeave.toDate})`,
    });
  } catch (err) {
    logger.error("Slash command failed", { error: err.message });

    return res.json({
      response_type: "ephemeral",
      text: "❌ Failed to apply leave",
    });
  }
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
  logger.info("Interaction received", req.body);
  res.status(200).send();
};

exports.handleWorkflow = async (req, res) => {
  logger.info("Workflow event received", req.body);
  res.status(200).send();
};
