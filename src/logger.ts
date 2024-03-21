import pino from 'pino';

export const logger = pino({});

export function createLogger(ns: string) {
    return logger.child({ ns });
}
