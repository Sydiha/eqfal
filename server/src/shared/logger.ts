import pino from 'pino';
import config from '../config';

const logger = pino(
  config.env === 'test'
    ? { level: 'silent' }
    : config.env === 'development'
    ? {
        level: config.logLevel,
        transport: { target: 'pino-pretty', options: { colorize: true } },
      }
    : { level: config.logLevel },
);

export default logger;
