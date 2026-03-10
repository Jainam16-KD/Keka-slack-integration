const log = (level, message, meta = {}) => {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...meta,
    })
  );
};

module.exports = {
  info: (msg, meta) => log("INFO", msg, meta),
  error: (msg, meta) => log("ERROR", msg, meta),
};
