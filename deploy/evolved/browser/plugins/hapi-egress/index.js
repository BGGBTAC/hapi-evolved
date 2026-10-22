// HAPI-eVolved integration plugin for jo-inc/camofox-browser 1.18.1 (MIT).
// Routes every Firefox connection, including localhost, through the per-project
// public-only browser-egress proxy and disables side channels. Fails closed: the
// HAPI entrypoint exits if this plugin did not register.
const PREFS = {
  // Also proxy loopback, so page JavaScript cannot reach the local Camofox REST API directly.
  'network.proxy.allow_hijacking_localhost': true,
  'network.proxy.no_proxies_on': '',
  'network.proxy.socks_remote_dns': true,
  // No DNS-over-HTTPS, prefetch or speculative connections outside the proxy.
  'network.trr.mode': 5,
  'network.dns.disablePrefetch': true,
  'network.prefetch-next': false,
  'network.predictor.enabled': false,
  'network.http.speculative-parallel-limit': 0,
  // WebRTC/UDP could bypass the HTTP proxy.
  'media.peerconnection.enabled': false,
  'media.peerconnection.ice.proxy_only': true,
  // No background update, telemetry or captive-portal traffic.
  'app.update.enabled': false,
  'extensions.update.enabled': false,
  'datareporting.healthreport.uploadEnabled': false,
  'toolkit.telemetry.enabled': false,
  'network.captive-portal-service.enabled': false,
  'network.connectivity-service.enabled': false,
  'browser.safebrowsing.malware.enabled': false,
  'browser.safebrowsing.phishing.enabled': false,
  'browser.safebrowsing.downloads.remote.enabled': false,
};

export async function register(_app, ctx) {
  const server = String(process.env.HAPI_BROWSER_EGRESS_PROXY || '');
  if (!/^http:\/\/[a-z0-9-]{1,63}:[0-9]{2,5}$/.test(server)) throw new Error('HAPI browser egress proxy is not configured');
  ctx.events.on('browser:launching', ({ options }) => {
    options.proxy = { server };
    options.firefoxUserPrefs = { ...(options.firefoxUserPrefs || {}), ...PREFS };
  });
  // server.js has already read CONFIG; Firefox (spawned with process.env) must not inherit the key.
  delete process.env.CAMOFOX_ACCESS_KEY;
  globalThis.__hapiEgressRegistered = true;
  ctx.log('info', 'hapi egress plugin registered');
}
