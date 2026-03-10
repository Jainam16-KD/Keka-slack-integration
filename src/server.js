const express = require("express");
const bodyParser = require("body-parser");
const slackRoutes = require("./routes/slack.routes");
const config = require("./config/config");
const kekaService = require("./services/keka.service");
const logger = require("./utils/logger");

const app = express();

const requiredEnv = [
  ["SLACK_SIGNING_SECRET", config.slack.signingSecret],
  ["SLACK_BOT_TOKEN", config.slack.botToken],
  ["KEKA_CLIENT_ID", config.keka.clientId],
  ["KEKA_CLIENT_SECRET", config.keka.clientSecret],
  ["KEKA_API_KEY", config.keka.apiKey],
  ["KEKA_BASE_URL", config.keka.baseUrl],
  ["KEKA_AUTH_URL", config.keka.authUrl],
  ["SICK_LEAVE_TYPE_ID", config.leaveTypes.sick],
];

const missingEnv = requiredEnv.filter(([, value]) => !value).map(([key]) => key);
if (missingEnv.length > 0) {
  logger.error("Missing required environment variables", { missingEnv });
  process.exit(1);
}

app.use(
  bodyParser.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);

app.use(
  bodyParser.urlencoded({
    extended: true,
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);

app.use("/slack", slackRoutes);

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptimeSeconds: Math.floor(process.uptime()),
    environment: config.nodeEnv,
    timestamp: new Date().toISOString(),
  });
});

if (config.app.enableDebugEndpoints) {
  app.get("/test-keka/:email", async (req, res) => {
    try {
      const employee = await kekaService.getEmployeeByEmail(req.params.email);
      const balance = await kekaService.getLeaveBalance(employee.id);

      res.json({
        success: true,
        employee,
        balance,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/keka/leave-types", async (req, res) => {
    try {
      const leaveTypes = await kekaService.getLeaveTypes();

      res.json({
        success: true,
        data: leaveTypes,
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  });

  app.post("/keka/create-leave", async (req, res) => {
    try {
      const { employeeId, leaveTypeId, fromDate, toDate, reason, note, fromSession, toSession } = req.body;

      if (!employeeId || !leaveTypeId || !fromDate || !toDate) {
        return res.status(400).json({
          success: false,
          error: "Missing required fields",
        });
      }

      const result = await kekaService.createLeaveRequest({
        employeeId,
        leaveTypeId,
        fromDate,
        toDate,
        reason,
        note,
        fromSession,
        toSession,
      });

      return res.json({
        success: true,
        data: result,
      });
    } catch (err) {
      return res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  });

  app.post("/keka/create-leave-by-email", async (req, res) => {
    try {
      const { email, leaveTypeId, fromDate, toDate, reason, note, fromSession, toSession } = req.body;

      if (!email || !leaveTypeId || !fromDate || !toDate) {
        return res.status(400).json({
          success: false,
          error: "Missing required fields",
        });
      }

      const employee = await kekaService.getEmployeeByEmail(email);
      const result = await kekaService.createLeaveRequest({
        employeeId: employee.id,
        leaveTypeId,
        fromDate,
        toDate,
        reason,
        note,
        fromSession,
        toSession,
      });

      return res.json({
        success: true,
        employeeId: employee.id,
        data: result,
      });
    } catch (err) {
      return res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  });

  logger.info("Debug endpoints enabled");
} else {
  logger.info("Debug endpoints disabled");
}

app.use((err, req, res, next) => {
  logger.error("Unhandled application error", { error: err.message });
  res.status(500).json({ error: "Internal server error" });
});

app.listen(config.port, () => {
  logger.info("Server started", {
    port: config.port,
    environment: config.nodeEnv,
  });
});
