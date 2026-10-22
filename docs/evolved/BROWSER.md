# Projektbrowser (Camofox)

Optional bekommt ein Projekt einen eigenen Browser für seine Agenten: das Upstream-Projekt
[`jo-inc/camofox-browser`](https://github.com/jo-inc/camofox-browser) 1.18.1 (MIT, Commit
`39c82094013480b373df6600d44c7f036f58356e`) mit dem Firefox-basierten
[Camoufox](https://github.com/daijro/camoufox) `152.0.4-beta.30` (MPL-2.0). Der Browser läuft als
eigener Sidecar **nur für dieses Projekt**, neben dem aktiven Entwicklungsmodul (z. B. Odoo, iOS,
Android) und neben Remote-MCPs. Er ändert weder das Entwicklungsmodul noch MCP-Verbindungen.

## Für Projektadministratoren

1. Verwalteten Projektdienst verbinden (Anbieter-Anmeldung), falls noch nicht geschehen.
2. **Projekt → MCP-Shop → Projektbrowser (Camofox)** öffnen, Werkzeuge auswählen und
   **Für Agenten dieses Projekts aktivieren**. Speichern verlangt einen frischen Passkey.
3. Der Status zeigt ehrlich, was gerade gilt: *Browser-Image fehlt*, *Projektdienst nicht verbunden*,
   *Gestoppt*, *Startet …*, *Dienst erreichbar, Browser ungeprüft*, *Bereit* (Firefox hat eine
   Seite geladen), *Fehler* oder *Keine aktuelle Rückmeldung*. Ein erreichbarer Dienst allein ist
   noch kein startfähiger Browser. Beim Start lädt HAPI selbst eine leere Testseite;
   **Browser prüfen** wiederholt diese Prüfung bei Bedarf.
4. **Deaktivieren** stoppt den Browser sofort und verwirft Tabs, Cookies und Anmeldungen.
   War die Projektdienst-Steuerung dabei nicht erreichbar, gleicht der Operator den Zustand innerhalb
   von etwa 30 Sekunden (spätestens nach einem Neustart) mit der Hub-Konfiguration ab und stoppt den Browser.
5. Die drei Browserdienste starten wie der verwaltete Runner **nicht** automatisch neu (Neustartrichtlinie
   `no`). Nach einem Absturz oder Speicherlimit zeigt der Status *Fehler*; **Erneut starten** behebt das.
   Agenten sehen denselben Zustand: fehlendes Image, Startfehler oder lange ausbleibende Rückmeldungen
   melden `available: false`.

Standardmäßig freigegeben sind Tabs öffnen/auflisten, Snapshot, Screenshot, Klicken, Tippen,
Navigieren, Scrollen und Tab schließen. `camofox_evaluate` (JavaScript in der Seite) muss
ausdrücklich freigegeben werden. Als „nur lesend“ lassen sich ausschließlich `camofox_list_tabs`,
`camofox_snapshot` und `camofox_screenshot` einstufen; Browseraktionen sind nie „nur lesend“.
Im eingeschränkten Profil erhalten Agenten nur diese lesenden Freigaben.

Nicht angeboten werden Cookie-Import, Datei-Upload, Downloads, Traces und Browserverwaltung.

### Geteilter, flüchtiger Zustand

Es gibt **einen** Browserzustand je Projekt und verwalteter Projektdienst-Lease. Alle
Agentensitzungen dieses Projektdienstes teilen Tabs, Cookies und Anmeldungen. Eine Trennung
zwischen Sitzungen gibt es nicht; HAPI kennt am Proxy keine authentisierte Sitzungs-ID und
übernimmt keine vom Aufrufer gewählte Identität. Andere Projekte haben eigene Browser und können
weder Tabs noch Cookies dieses Projekts sehen. Der Zustand liegt im Arbeitsspeicher (tmpfs) und
geht bei Neustart, Deaktivieren oder neuer Lease verloren. Persönliche Konten nur nach
ausdrücklicher Anweisung im Projekt anmelden.

### Netz

Erreichbar sind alle öffentlichen Websites über HTTP (Port 80) und HTTPS (Port 443), ohne
Website-Liste. Private, Loopback-, Link-Local-, Carrier-NAT- und Metadatenadressen (IPv4/IPv6)
sind gesperrt, auch bei Weiterleitungen, Unterressourcen und `fetch()` aus Seiten-JavaScript.
Der Browser hat keinen Weg zum Hub, zum Runner, zu Vault, Datenbanken oder Projektdiensten.
Die Anti-Erkennung ist eine Eigenschaft des Upstream-Projekts und keine Zusage, jede
Bot-Erkennung zu bestehen; die Nutzungsbedingungen der Zielseiten bleiben Sache des Betreibers.

## Für Agenten

`evolved_browser_status` und `evolved_browser_tools` lesen beim Hub (`GET /api/evolved/projects/<id>/browser/agent`,
Runner-Capability) ob der Browser aktiviert ist, ob die Sitzung im verwalteten Projektdienst läuft (`managedRunner`),
den vom Hub zuletzt bestätigten Laufzeitzustand, das Profil und die genauen Freigaben (Name, Schema, nur lesend,
`version`, `catalogRevision`). Das funktioniert auch, wenn der Browser deaktiviert oder gestoppt ist; jede
Agentsitzung kennt damit ihre tatsächlichen Browserrechte. Handeln kann nur der aktuelle verwaltete Projektdienst. `evolved_browser_query` nutzt nur-lesend
freigegebene Werkzeuge, `evolved_browser_call` alle übrigen mit der normalen Aktionsfreigabe.
`available: true` erscheint erst nach einer erfolgreichen Firefox-Testseite; vorher bleiben
Werkzeuge und Rechte sichtbar, Aktionen antworten sicher mit `browser_not_ready` und können
nach `Bereit` erneut versucht werden.
Die Grenze setzt der Hub: Mitgliedschaft, aktuelle verwaltete Lease, Profil und jede einzelne
Freigabe werden vor dem Absenden und erneut vor der Rückgabe des Ergebnisses geprüft. Die
native Freigabe ist Transparenz, keine Sicherheitsgrenze. `browser_outcome_unknown` und
`browser_outcome_withheld` nie automatisch wiederholen.
Widerruft der Hub die Berechtigung während einer Aktion, wird das Ergebnis zurückgehalten und der gemeinsame
Browserzustand geschlossen. Ist der Hub nur kurz nicht erreichbar, wird das Ergebnis ebenfalls zurückgehalten
(`browser_outcome_withheld`, 503), der Browserzustand bleibt aber erhalten.

## Architektur

```
runner ─▶ runner-proxy ─(/evolved-browser/query|call, fest)─▶ browser-gateway ─(Schlüssel)─▶ browser ─▶ browser-egress ─▶ Internet
                 ▲                                         │
                 └──── /browser/authorize|report ◀─────────┘   (nur vom Gateway-Peer, Grant des Proxys)
```

| Dienst | Image | Netze |
|---|---|---|
| `browser-gateway` | `hapi-evolved:0.1.0` (`services/runner-proxy/browserGateway.ts`) | `project`, `browser-control` |
| `browser` | `hapi-evolved-browser:0.1.0` (`deploy/evolved/Browser.Dockerfile`) | `browser-control`, `browser-outbound` |
| `browser-egress` | `hapi-evolved:0.1.0` (`services/runner-proxy/browserEgress.ts`) | `browser-outbound`, `browser-internet` |

Alle drei stehen in `deploy/evolved/runner.compose.yml` unter `profiles: [browser]`. Ohne Profil ist
`docker compose config` bitgleich zum Stand ohne Browser; `runner`, `runner-proxy` und `egress`
bleiben unverändert. Der `runner-proxy` bedient gewöhnliche Routen nur dem Peer `runner`; dem Peer
`browser-gateway` erlaubt er ausschließlich `POST /api/evolved/projects/<eigenes Projekt>/browser/authorize|report`.
Beim Kaltstart wartet Compose mit dem Gateway auf den authentifizierten Healthcheck des Browsers
und dessen bestätigte Firefox-Verbindung;
so ist dessen Docker-DNS-Name vor dem ersten Aufruf vorhanden. Der anschließende Firefox-Test
meldet erst dann `Bereit`, wenn eine leere Seite erfolgreich geladen wurde.

Der Browser-Zugriffsschlüssel (`CAMOFOX_ACCESS_KEY`) wird bei jedem Start vom Operator zufällig
erzeugt (`<state>/runners/<projekt>/browser.key`, UID-Besitz, 0600) und nur in `browser-gateway` und
`browser` gemountet; er steht nicht in `runner.env`, Agentumgebung, Runner-Home, Workspace, Vault,
Hub-API oder Logs. `hapi-entry.mjs` liest ihn aus der Datei und verweigert den Start ohne gültigen
Schlüssel, mit Telemetrie oder außerhalb von `NODE_ENV=production`; das HAPI-Plugin entfernt ihn vor dem ersten
Browserstart aus der Prozessumgebung, Firefox-Prozesse erben ihn nicht. Ein Integrationspatch lässt `server.js`
vor `listen` abbrechen, wenn das Plugin `hapi-egress` nicht geladen wurde (Upstream protokolliert Plugin-Fehler
sonst nur). Camofox-Identität (`userId`)
ist `hapi-` + sha256(Projekt, Lease) und wird vom Hub geliefert.

Laufzeit: `CAMOFOX_CRASH_REPORT_ENABLED=false`, kein `SENTRY_DSN`, Plugins `youtube`, `persistence`,
`vnc` aus, `CAMOFOX_DISABLE_DEFAULT_ADDONS=1`, `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, GeoIP aus
(Integrationspatch `geoip: false`). Firefox-Prefs: Proxy auch für `localhost`, kein DoH, kein
WebRTC, keine Update-/Telemetrie-/Safe-Browsing-Verbindungen. Die Firefox-Content-Sandbox bleibt
aktiv; Container mit `read_only`, `cap_drop: ALL`, `no-new-privileges`, Docker-Standard-Seccomp,
2 GiB RAM, 512 PIDs.

## Für Installationsbetreiber

Das Image wird **nicht** automatisch gebaut oder gezogen; der Operator startet mit `--pull never`.
Auf dem Host mit Netz zu `registry.npmjs.org` und `github.com`:

```bash
docker build -f deploy/evolved/Browser.Dockerfile -t hapi-evolved-browser:0.1.0 .
```

Der Build prüft Größe und SHA-256 der Camoufox-ZIP (`deploy/evolved/browser/SHA256SUMS`), die
npm-Integrität des Upstream-Tarballs (64 Dateien bytegleich mit Commit `39c82094…`), installiert
mit `npm ci --ignore-scripts` aus `deploy/evolved/browser/package-lock.json` (Upstream-Lock, nur
`@modelcontextprotocol/sdk` 1.32.0, `hono` 4.13.11, `proxy-addr` 2.0.8 aktualisiert). Das native
`better-sqlite3`-Modul stammt aus dem integritätsgeprüften npm-Paket; ein SQLite-Aufruf prüft es
ohne Netz. Es wird nicht aus Quellcode neu kompiliert. Das Basis-Image ist per Digest gepinnt; Debian-Pakete stammen aus den
signierten Paketquellen des Basis-Images, ohne Versionspin. Zur Laufzeit wird nichts geladen.

Nach einem Update von `runner.compose.yml` oder `services/runner-proxy/*` auch
`hapi-evolved:0.1.0` neu bauen. Ressourcen: zusätzlich bis 2 GiB RAM je aktivem Projektbrowser
(Startwert, nicht gemessen).

Rollback auf einen Stand ohne Browser: zuerst je Projekt mit aktivem Browser
`docker compose --env-file runner.env --profile browser -f deploy/evolved/runner.compose.yml rm --stop --force browser-gateway browser browser-egress`
ausführen (ein älterer Operator kennt das Profil nicht und würde die Dienste weiterlaufen lassen),
dann den alten Stand installieren. Die Hub-Tabelle `evolved_project_browser` bleibt von älteren
Versionen unbenutzt; es gibt keine Migration.

Lizenzhinweise: `deploy/evolved/browser/THIRD_PARTY_NOTICES.md` (im Image unter
`/usr/share/doc/hapi-evolved/`).
