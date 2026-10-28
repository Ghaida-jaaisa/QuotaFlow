import { pino, type DestinationStream, type Logger } from 'pino';

// Credential headers must never reach log output, even at debug level.
export const REDACTED_PATHS = [
  'req.headers["x-api-key"]',
  'req.headers["x-admin-token"]',
  'req.headers.authorization',
  'req.headers.cookie',
  'apiKey',
  '*.apiKey',
];

export function createLogger(level: string, destination?: DestinationStream): Logger {
  const options = {
    level,
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: { service: 'quotaflow-api' },
  };
  return destination ? pino(options, destination) : pino(options);
}
