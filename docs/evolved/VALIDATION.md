# Abnahme von HAPI evolved 0.1.0

Prüfung am 14.10.2026 auf einer isolierten Linux-Testinstallation. Grundlage ist
`tiann/hapi@5847b034e5cb84f2617766945c994b7905c5c03e`; Entwicklung auf `feat/evolved-v1`.
Bestehende HAPI-, Vault- und Infrastruktur-Dienste wurden nicht umgestellt.

## Ausgeführte Prüfungen

- `bun run typecheck`: CLI, Hub, Web, Relay, Runner-Proxy und Deployment-Helfer.
- `bun run test`: vollständige Pakettests einschließlich vorhandener Upstream-Regressionen.
  Der abschließende vollständige Lauf bestand 8.278 Tests; 14 bedingte Tests wurden übersprungen.
  Der nachfolgende gezielte Schutz beim Logout/Projektwechsel bestand weitere 58 Cache-/Auth-Tests.
- `bun run --cwd web test:evolved:e2e`: echter `startHub`, separater verschlüsselter Vault,
  Chromium mit virtuellem WebAuthn-Authentikator. Bootstrap samt Seitenreload, Passkey-Anmeldung,
  erneute Authentisierung, Kontowiederherstellung und Ersatzpasskey, Projekte, Vault-Verwaltung,
  persistente Memory-Vorschläge, Sitzungs-JWT-Brücke, Runner-Freigabe/Download/Widerruf,
  private Vorschau, Share-Link/Widerruf und mobile Darstellung.
- Aktive Browser-Sandbox-Prüfung: Preview konnte weder Kontocookies/LocalStorage noch das
  Eltern-Dokument oder authentisierte Hub-APIs lesen; eigene relative Assets waren erreichbar.
- Echte Codegraph-SDK-Tests unter Node 24: Aufrufkanten, Source-Vorschau, Ausschluss von
  Credentials, Änderungsabgleich und Löschung. Kein Ersatzgraph aus fest codierten Antworten.
- Python-Tests mit installiertem Graphiti-SDK sowie Budgettransport: Modellbindung, Tokenlimits,
  Reservierung, konservative Fehlerabrechnung, Idempotenz und ausgeschlossene Nebenclients.
  Die echte Graphiti-0.30.2-Pipeline wurde zusätzlich gegen Neo4j ausgeführt: `add_episode`,
  persistierte Episode, Suche, Kostenbeleg und Purge. Ausschließlich der Providertransport war
  durch drei synthetische Antworten ersetzt; keine kostenpflichtige Modellanfrage.
- Compose-Integration mit echtem Neo4j: vollständige Projektgenerations-Löschung einschließlich
  Beziehungen, Isolation ähnlich benannter Projekte, Wiederholung ohne Löschung einer neueren
  Generation, abgewiesene veraltete Generationen und Fehler ohne Providerkosten.
- Runner im eigenen Docker-Netz: echter nativer HAPI-Runner registrierte seine Maschine am Hub
  über den Lease-Proxy. Native Agentprogramme melden Claude Code 2.1.285 und Codex 0.157.0.
  Agent-UID/GID waren 1000, zusätzliche Gruppen leer, effektive und Bounding-Capabilities null.
  Signalisierung des Root-Supervisors und Schreiben in den `restricted`-Workspace wurden verweigert.
  HTTPS-CONNECT zu `api.anthropic.com` funktionierte ohne Anmeldung; ein privates Ziel erhielt 403.
  Nach Lease-Widerruf verschwanden Runner, Subreaper und ein zusätzlicher Hintergrundprozess
  im gemessenen Lauf nach 722 ms. Neustarts mit derselben widerrufenen Lease wurden verweigert.
- Betreiber-Preflight prüft Lease-Dateirechte, Besitzer, Hardlinks/Symlinks und die Trennung von
  Workspace, Runner-Home und Lease, ohne den Dateiinhalt einzulesen.

Die Dienstprüfungen sind in `services/codegraph/validate_stack.mjs` und
`services/memory/validate_stack.py` beschrieben. Lokale Browser ohne Playwright-Download können
`PLAYWRIGHT_CHROME_PATH` auf einen vorhandenen passenden Chromium-Browser setzen.
GitHub CI führt Pakettests, Evolved-Browserprüfung sowie separate Node-/Python-Diensttests aus.
Geerbte Upstream-Veröffentlichungs- und KI-Bot-Workflows sind auf `tiann/hapi` begrenzt.

## Übernommene Stabilitätskorrekturen

| Upstream-Vorlage | Änderung in Evolved | Nachweis / Grenze |
|---|---|---|
| [PR #1886](https://github.com/tiann/hapi/pull/1886), unter anderem [Issue #1887](https://github.com/tiann/hapi/issues/1887) | Usage-Backfill in Keyset-Seiten, weniger dekodierte Nachrichten, begrenzter Export, Cache gegen verspätete Ergebnisse geschützt; interne Codex-Resume-Abfragen ohne Turns | Paging/Modellfallbacks, gleichzeitige Namespace-Abfragen, Löschung während Backfill und Exportfilter getestet; SQLite-Snapshot bleibt kurz synchron, kein vollständiger Umbau aller Codex-Historienpfade |
| [PR #1934](https://github.com/tiann/hapi/pull/1934), insbesondere [Issue #1933](https://github.com/tiann/hapi/issues/1933) | Angeforderte Claude-Resume-ID bleibt dauerhaft erhalten; unerwartete neue ID erzeugt sichtbare Warnung; expliziter Fork bleibt möglich | Lokale und Remote-Launcher lassen Native Claude die Resume-Datei suchen; keine unzuverlässige Vorprüfung und kein stiller Wechsel auf eine neue Sitzung. Nicht sämtliche verwandten Transcript-Probleme werden als gelöst bezeichnet |
| [PR #1875](https://github.com/tiann/hapi/pull/1875), [Issue #1874](https://github.com/tiann/hapi/issues/1874) | Bereits persistierte lokale Nachricht löst beim Replay keine doppelten Seiteneffekte/Broadcasts aus | ACL-Prüfung bleibt davor, separate Consumption-ACKs bleiben erhalten; Handler-Regressionen |
| [PR #1876](https://github.com/tiann/hapi/pull/1876) | Historische Child-Traces starten keine falschen Laufzeittimer; tatsächliche Toolkarten behalten ihren Zustand | Timeline- und Fixture-/Window-Konformität; explizites Wiederaufnehmen entfernt alten Abschlusszeitpunkt |

Die Vorlagen wurden geprüft und angepasst, nicht pauschal übernommen. Urheber- und Lizenzhinweise
des Upstream-Projekts bleiben erhalten. Die 113 offenen Issues sind vollständig triagiert; diese
Abnahme erklärt ausdrücklich nicht alle Issues für gelöst. Der restliche Umfang steht im CSV-/JSON-Backlog.

## Review und Vertrauensgrenzen

Architektur, Stabilitätsvorlagen und abschließende Sicherheitsgrenzen wurden mit Claude Code,
explizit angefordertem Modell `claude-opus-5-5`, besprochen. Der Runner-Review lieferte auch
Modellmetadaten für diesen Namen. Konkrete Befunde führten unter anderem zu eindeutigem Compose-
Scope, expliziter Linux-Rechteabgabe, Subreaper und einer echten CONNECT-Prüfung. Codegraph
verarbeitet sicher kopierte Quelldateien in einem privaten Dienstverzeichnis; Workspacecode
kann weder den SDK-Index austauschen noch dessen SQLite-Pfade manipulieren. Interne Reviews
ergänzten unmittelbare Socket-Ausgabesperren, Operatorbindung für Workspacepfade und erneute
ACL-Prüfung nach asynchronen Dienstaufrufen. Dies ist eine interne Abnahme, kein externes Audit.

Hostroot und der Betreiber des Linux-Kontos bleiben vertrauenswürdig. Native Claude-/Codex-
Anmeldedaten im jeweiligen Runner-Home sind für diesen nativen Agenten zugänglich; Vault-Master,
Hub-Lease und Datenbankzugänge sind getrennt. Recovery-Codes berechtigen bewusst zur vollständigen
Kontowiederherstellung und müssen entsprechend geschützt werden. Teamrollen werden an Projekte
vererbt; das Entfernen einer Projektrollen-Ausnahme setzt die Teamrolle wieder ein.

Nicht ausgeführt wurden kostenpflichtige Modellanfragen, reale Provideranmeldungen, die öffentliche
Veröffentlichung sowie Änderungen an vorhandener Infrastruktur. Eine echte Graphiti-Extraktion mit
einem Cloudmodell verlangt Betreiberkonfiguration, aktuelle Preise und ein ausdrücklich aktiviertes
Projektbudget. Modellqualität und reale Anbieterabrechnung sind durch Offline-Tests nicht belegt.
Backups und darin verbleibende gelöschte Quellen benötigen eine Betreiber-Aufbewahrungsregel.
