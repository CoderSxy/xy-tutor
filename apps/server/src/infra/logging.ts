export const loggerOptions = {
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "password",
      "token",
      "apiKey",
      "secret",
      "signedUrl",
    ],
    censor: "[REDACTED]",
  },
};
