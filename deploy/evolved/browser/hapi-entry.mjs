// HAPI-eVolved entrypoint for jo-inc/camofox-browser 1.18.1 (MIT).
// Reads the operator-generated per-project access key from a private file, so the
// key never appears in Compose files, image layers or `docker inspect`, then starts
// the upstream server in this same process. Refuses to start without a valid key
// or without the HAPI egress plugin (checked before the server listens).
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

const fail = (message) => { console.error(`hapi-entry: ${message}`); process.exit(78); };
const keyFile = process.env.CAMOFOX_ACCESS_KEY_FILE;
if (!keyFile) fail('CAMOFOX_ACCESS_KEY_FILE is required');
let key = '';
try {
  const fd = openSync(keyFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size < 32 || info.size > 256) fail('invalid access key file');
    const buffer = Buffer.alloc(info.size);
    readSync(fd, buffer, 0, info.size, 0);
    key = buffer.toString('utf8').trim();
  } finally { closeSync(fd); }
} catch { fail('access key file unreadable'); }
if (!/^[A-Za-z0-9_-]{43,128}$/.test(key)) fail('invalid access key');
for (const name of ['CAMOFOX_API_KEY', 'CAMOFOX_ADMIN_KEY', 'PROXY_HOST', 'PROXY_PORT', 'PROXY_PORTS', 'PROXY_USERNAME', 'PROXY_PASSWORD', 'PROXY_BACKCONNECT_HOST', 'SENTRY_DSN', 'CAMOFOX_CRASH_REPORT_URL', 'FLY_API_TOKEN', 'FLY_MACHINE_ID']) delete process.env[name];
if (process.env.CAMOFOX_CRASH_REPORT_ENABLED !== 'false' || process.env.NODE_ENV !== 'production' || !process.env.CAMOFOX_BIND_HOST) fail('unsafe runtime configuration');
process.env.CAMOFOX_ACCESS_KEY = key;
delete process.env.CAMOFOX_ACCESS_KEY_FILE;
// The patched server.js throws before app.listen unless the hapi-egress plugin registered.
try { await import('./server.js'); } catch { fail('upstream server refused to start (hapi-egress plugin missing or invalid configuration)'); }
// Belt and braces; the hapi-egress plugin already removed it before any browser launch.
delete process.env.CAMOFOX_ACCESS_KEY;
if (!globalThis.__hapiEgressRegistered) fail('hapi-egress plugin did not register');
