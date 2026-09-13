import { type } from '@wbs/validation';

export const Port = type('string.integer.parse').narrow(
  (n, ctx) => (n >= 1 && n <= 65_535) || ctx.mustBe('a valid TCP port 1-65535'),
);

export const LogLevel = type("'trace'|'debug'|'info'|'warn'|'error'|'fatal'");

export const JwtKey = type('string>=32');

export const InternalAuthSecret = type('string>=32');
