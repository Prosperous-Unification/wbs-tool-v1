import { buildApp } from './app';
import { loadConfig } from './config';

const cfg = loadConfig();
const app = buildApp({
  beUrl: cfg.BE_URL,
  internalAuthSecret: cfg.INTERNAL_AUTH_SECRET,
  jwtKey: cfg.JWT_SIGNING_KEY_CURRENT,
  previousJwtKey: cfg.JWT_SIGNING_KEY_PREVIOUS,
  ...cfg.wsAuth,
});
app.listen(cfg.PORT);
console.log(`gw-01 listening on ${String(cfg.PORT)}`);
