require("dotenv").config();

module.exports = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || "development",

  slack: {
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    botToken: process.env.SLACK_BOT_TOKEN,
    commands: {
      applyLeave: process.env.SLACK_APPLY_LEAVE_COMMAND || "/kd-apply-leave",
      sick: process.env.SLACK_SICK_COMMAND || "/kd-sick",
      todayLeaves: process.env.SLACK_TODAY_LEAVES_COMMAND || "/kd-leaves",
    },
    workflowSteps: {
      applyLeave:
        process.env.SLACK_WORKFLOW_STEP_APPLY_LEAVE_CALLBACK_ID ||
        "kd_apply_leave_step",
      sick:
        process.env.SLACK_WORKFLOW_STEP_SICK_CALLBACK_ID ||
        "kd_sick_step",
      leaves:
        process.env.SLACK_WORKFLOW_STEP_LEAVES_CALLBACK_ID ||
        "kd_leaves_step",
    },
    sickChannelId: process.env.SLACK_SICK_CHANNEL_ID,
    sickChannel: process.env.SLACK_SICK_CHANNEL || "tmp-kd-off",
    sickKeywords: (
      process.env.SLACK_SICK_KEYWORDS ||
      "feeling sick,under the weather,not well,sick leave,unwell"
    )
      .split(",")
      .map((keyword) => keyword.trim().toLowerCase())
      .filter(Boolean),
  },

  keka: {
    clientId: process.env.KEKA_CLIENT_ID,
    clientSecret: process.env.KEKA_CLIENT_SECRET,
    apiKey: process.env.KEKA_API_KEY,
    baseUrl: process.env.KEKA_BASE_URL,
    authUrl: process.env.KEKA_AUTH_URL,
  },

  leaveTypes: {
    sick: process.env.SICK_LEAVE_TYPE_ID,
    paid: process.env.EARNED_LEAVE_TYPE_ID,
    unpaid: process.env.UNEARNED_LEAVE_TYPE_ID,
    wfh: process.env.WFH_LEAVE_TYPE_ID,
  },

  app: {
    leaveIdempotencyMinutes: Number(process.env.LEAVE_IDEMPOTENCY_MINUTES || 10),
    enableDebugEndpoints: process.env.ENABLE_DEBUG_ENDPOINTS === "true",
    allowLocalTestUser: process.env.ALLOW_LOCAL_TEST_USER === "true",
    localTestUserEmail: process.env.LOCAL_TEST_USER_EMAIL || "",
  },
};
