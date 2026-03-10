const express = require("express");
const verifySlackSignature = require("../middleware/verifySlackSignature");
const slackService = require("../services/slack.service");

const router = express.Router();

router.post(
  "/commands",
  verifySlackSignature,
  slackService.handleSlashCommand
);
  
router.post(
  "/events",
  verifySlackSignature,
  slackService.handleEvent
);
  
router.post(
  "/interactions",
  verifySlackSignature,
  slackService.handleInteraction
);
  
router.post(
  "/workflows",
  verifySlackSignature,
  slackService.handleWorkflow
);

module.exports = router;
