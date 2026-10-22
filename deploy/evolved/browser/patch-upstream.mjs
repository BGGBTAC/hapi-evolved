// Build-time integration patch for jo-inc/camofox-browser 1.18.1 server.js.
// Exact, asserted replacements only; the build fails if upstream text differs.
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
let source = readFileSync(file, 'utf8');
const patches = [
  // HAPI supplies a static, public-only egress proxy through the hapi-egress plugin.
  // GeoIP lookup would otherwise download a MaxMind database at runtime.
  ['        geoip: !!launchProxy,\n        locale:', '        geoip: false,\n        locale:'],
  // Upstream logs and swallows plugin registration errors. Refuse to listen (and so to launch any
  // browser) unless the HAPI egress plugin registered.
  ['const loadedPlugins = await loadPlugins(app, pluginCtx);\n',
   "const loadedPlugins = await loadPlugins(app, pluginCtx);\nif (!loadedPlugins.includes('hapi-egress')) throw new Error('hapi-egress plugin not loaded; refusing to start');\n"],
];
for (const [from, to] of patches) {
  const count = source.split(from).length - 1;
  if (count !== 1) { console.error(`patch-upstream: expected exactly one match, found ${count}`); process.exit(1); }
  source = source.replace(from, to);
}
writeFileSync(file, source);
console.log(`patch-upstream: applied ${patches.length} patch(es)`);
