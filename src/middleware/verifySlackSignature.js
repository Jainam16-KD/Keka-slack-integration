const crypto = require("crypto");
const config = require("../config/config");
const logger = require("../utils/logger");

module.exports = (req, res, next) => {
  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];

  if (!timestamp || !signature) {
    return res.status(400).send("Missing Slack headers");
  }

  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (Number(timestamp) < fiveMinutesAgo) {
    return res.status(400).send("Request too old");
  }

  const sigBaseString = `v0:${timestamp}:${req.rawBody}`;
  const mySignature =
    "v0=" +
    crypto
      .createHmac("sha256", config.slack.signingSecret)
      .update(sigBaseString)
      .digest("hex");

  const expected = Buffer.from(mySignature);
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length) {
    logger.error("Invalid Slack signature length");
    return res.status(400).send("Invalid signature");
  }

  if (!crypto.timingSafeEqual(expected, provided)) {
    logger.error("Invalid Slack signature");
    return res.status(400).send("Invalid signature");
  }

  next();
};
