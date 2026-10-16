# Prüfberichte: HAPI-eVolved 0.1.0

Dieser datierte Bericht belegt den damaligen Quellstand, nicht automatisch die
aktuelle Veröffentlichung. Einstieg und heutiger Umfang: [Quickstart](QUICKSTART.md)
und [Projekt](PROJECT.md).

## Graph-Memory im Browser am 16.10.2026

`feat/browser-memory-setup` ergänzt die projektbezogene Einrichtung unter
**Gedächtnis → Graph-Memory einrichten**: verschlüsselter API-Key, live geladener
Modellkatalog, Preise, Datenbank-/Katalogtest und nachvollziehbare Budgetfreigabe.
Design und die Übernahme alter leerer Graphen wurden mit tatsächlichem Claude
Opus 5.5 geprüft. Die [abschließende Reviewdisposition](./reviews/browser-memory-2026-10-16.json)
dokumentiert die umgesetzten Korrekturen, Quellprüfsummen und verbleibenden Grenzen.

Der vollständige lokale Paketlauf bestand 9.880 Tests. Nach den engen
Reviewkorrekturen bestanden nochmals 1.893 Hub- und 3.970 Web-Tests sowie die
betroffenen Typechecks; alle sieben Paket-Typechecks sind abgedeckt. Ein bestehender
Benachrichtigungstest mit 20-ms-Abklingzeit schlug während paralleler CPU-Last fehl;
die vollständige Hub-Wiederholung ohne konkurrierende Suites bestand. 13 bedingte
CLI- und drei Hub-Integrationstests bleiben übersprungen.

39 Python-Tests prüfen Konfigurationsisolierung, Schlüsselredaktion, positive
Preise, Budget-/Receipt-Verhalten, echte SDK-Embeddingdimensionen und die dauerhafte
Modellbindung gegen verspätete Aufträge. Die gesonderte Integration mit tatsächlichem
Neo4j und Graphiti bestand; nur der Modelltransport wird dabei ersetzt.
Der enge Abschlusslauf bestand zusätzlich 35 Hub- und 17 Web-Tests. Er deckt die
Reparatur einer unterbrochenen Modellbindung, Schlüsselwechsel bei vorhandenem Graph
und die Freigabe ausschließlich neuer, nachweislich noch nicht versandter
Kostenreservierungen ab. Alle sieben Paket-Typechecks bestanden erneut.

Der isolierte Browserlauf verwendet echten Hub, Vault und WebAuthn. Sechs Prüfgruppen
decken Einrichtung, beliebige neue Katalog-IDs, Embeddingwechsel bei leerem Graph,
Schlüsselwechsel, Projektwechsel, Entfernen und erneutes Verbinden ab. Ein zusätzlicher Komponententest stellt sicher,
dass ein Verbindungstest keine vorhandene Hybridsuche erneut ausführt. Bei 1.440,
390 und 320 Pixeln gab es keinen horizontalen Überlauf oder unerwartete Seitenfehler.
Der interne Memory-Katalog-/Prüfdienst ist in diesem Browserlauf eine synthetische
Fixture; Datenbank und SDK werden durch die getrennte Integration geprüft.

Es wurden keine echten API-Keys verwendet und keine kostenpflichtigen Inferenzaufrufe
ausgeführt. Der Modellkatalog und der Verbindungstest beweisen weder verfügbares
API-Guthaben noch die Graphiti-Kompatibilität beliebiger Modelle. Bereits fehlgeschlagene
Altaufträge werden durch das Speichern einer Konfiguration nicht automatisch wiederholt.
Der tatsächliche Rollout samt Sicherung und Datenerhalt wird getrennt privat dokumentiert.

## Integrierter Projektablauf am 15.10.2026

Der Ausbau auf `feat/integrated-project-workflow` verbindet Bereitschaftsprüfung,
explizite Repository-Sitzungen, lokale Git-Diffs, Codegraph-Auswirkungen und
quellengebundene Wissensvorschläge. Claude Fable 5.1 priorisierte diese Ausbaustufe;
tatsächliche Aufrufe von Claude Opus 5.5 prüften Design, Gesamtumsetzung und
Korrekturen. Plan, Grenzen und Prüfsummen stehen im
[Projektablauf](PROJECT_WORKFLOW.md) und im
[Reviewbeleg](reviews/project-workflow-2026-10-15.json).

Der vollständige lokale Paketlauf bestand 9.783 Tests: CLI 3.252, Hub 1.871,
Web 3.956, Shared 470, Relay 118, Runner-Proxy 50, Deployment 11,
Runner-Auth 34 und Runner-Control 21. Zwölf bedingte CLI-Tests und drei
Hub-Integrationstests wurden übersprungen. Alle sieben Paket-Typechecks bestanden.
Nachfolgende kleine Reviewkorrekturen erhalten zusätzlich gezielte Regressionen;
der finale PR-Stand muss die erforderlichen CI-Prüfungen erneut bestehen.

Der neue isolierte Browsertest bestand acht Prüfgruppen bei 1.440, 390 und 320
Pixeln: echte WebAuthn-Anmeldung, Hub, Vault, Socket.IO, Git-Arbeitsstand und
Codegraph. GitHub-Providerantworten sowie native Agentverfügbarkeit, Verzeichnis-
prüfungen und Ausführung sind kontrollierte Fixtureantworten. Geprüft werden
Repositoryordner und Hub-Sitzungszuordnung, ausdrücklicher Spezialistenstart,
Index-/Arbeitskopie-Diff, ausgeschlossene Inhalte, Review-Übergabe, Datei- und
Nachrichtenwissen sowie Projektwechsel ohne übernommene Fremddaten. Es gibt keine
kostenpflichtigen Provideraufrufe oder entfernten Git-Transfers.

Die Berichte enthalten keine React-/Seitenfehler oder horizontalen Überläufe.
Bewusst blockierte Serviceworker, bei vollständiger Seitennavigation abgebrochene
Statusanfragen und genau benannte nicht verfügbare Fixture-/Legacy-Endpunkte
werden separat protokolliert; andere Konsolen- und HTTP-Fehler lassen den Test
scheitern. Auch der bestehende umfassende Evolved-Browsertest bestand. Seine
Profilwechselprüfung bestätigt nun die Serverantwort, den neu geladenen Profil-
zustand und den Widerruf der vorherigen Lease statt einer durch den notwendigen
Berechtigungswechsel verworfenen flüchtigen Erfolgsmeldung.

Diese Quell- und Fixtureprüfungen sind kein Beleg einer bereits aktualisierten
Testinstallation. Der private Betriebsbeleg dokumentiert den tatsächlich
ausgerollten Commit, die Imagekennungen, Sicherung und Datenerhalt getrennt.

## Wiederverwendete Runner-Kennungen am 15.10.2026

Bei der Testinstallation wurde ein zweiter Startfehler reproduziert: Nach dem
Ersetzen eines Containers konnte Linux dieselbe PID-Namespace-Kennung erneut
vergeben. Der bisherige Marker hielt diese Kennung zusammen mit der Boot-ID
für dieselbe Runner-Generation. Alte Prozessdateien blieben dadurch bestehen,
und der native Runner meldete irrtümlich einen bereits laufenden Prozess.

Der Folgefix auf `fix/runner-start-generation`, ausgehend von
`9188df4703c2f27722b3829793bcd25866b38787`, berücksichtigt zusätzlich die
Startzeit des Container-Initprozesses. Ein begrenzter Parser liest diese
Kennung aus `/proc/1/stat`. Die Migration des bisherigen Markers bleibt auf
den verifizierten Containerstart unter der vorhandenen exklusiven Sperre
beschränkt. Ausschließlich die beiden bisherigen transienten Prozessdateien
werden bei einer neuen Generation bereinigt; Zugangsdaten und Arbeitsordner
gehören nicht zu dieser Bereinigung.

Die vollständige Runner-Proxy-Suite bestand 34 Tests mit 262 Assertions,
einschließlich elf Entry-Tests. Der Typecheck bestand ebenfalls. Die übrigen
Produktdateien und ihre vorherigen Paketprüfungen sind unverändert.

Design und Abschlussprüfung sind im
[separaten Reviewbeleg](reviews/runner-start-generation-2026-10-15.json)
festgehalten. Der neue Marker ist für das alte Runnerimage nicht lesbar;
ein späterer Hub-Rückfall muss daher die bereits geprüfte Runner-Reparatur
beibehalten. Die vorherigen Quell- und Prüfbelege bleiben unverändert.

## Runner-Wiederverbindung und RPC-Zuordnung am 15.10.2026

Der Folgefix auf `fix/runner-rpc-reconnect` basiert auf dem zusammengeführten
Stand `0c32b0efa6048814f19c3c0d28b9d441dd3c9b3f`. Ein echter Socket.IO-Test
reproduzierte verlorene Runner-Befehle nach Hub-Neustart und erneuerter
Zugangsfreigabe. Der Proxy stellt jetzt ausschließlich begrenzte, geprüfte
Methodenregistrierungen wieder her; ausgeführte Befehle werden nicht erneut
gesendet. Die native Verbindung bleibt bestehen, damit ihre Browser-Terminals
bei einer regelmäßigen Zugangserneuerung nicht geschlossen werden.

Verspätete Bestätigungen bleiben an ihre ursprüngliche Verbindung gebunden.
Ein gesonderter Negativtest ohne diesen Schutz reproduzierte die falsche
Zuordnung einer alten Antwort zu einem neuen Aufruf. Der Hub prüft die
aktuelle Projektzugehörigkeit und Zugangsfreigabe bei Registrierung, vor
Versand und nach der Antwort. Maschinen- und Sitzungsmethoden haben getrennte
Registrierungsschlüssel.

Die vollständigen betroffenen Suiten bestanden 1.807 Hub-Tests und
30 Runner-Proxy-Tests; drei bestehende bedingte Hub-Integrationstests wurden
übersprungen. Beide Typechecks bestanden. Vierzehn neue Hub-Tests prüfen die
Zuordnung und Berechtigungsänderungen über echte Socket.IO-Verbindungen.
Die Prüfungen verwenden isolierte
Testdienste und synthetische Berechtigungen, keine persönlichen Providerkonten
oder kostenpflichtigen Modellaufrufe. Die unveränderten Web-, CLI- und
Landingpage-Prüfungen des nachfolgenden Abschnitts bleiben deren Beleg.
Die tatsächlichen Opus-Designgespräche, Reviewbefunde und deren Abschluss
stehen im [separaten Reviewbeleg](reviews/runner-rpc-reconnect-2026-10-15.json).

## Projektordner und öffentliche Dokumentation am 15.10.2026

Die Änderung auf `docs/evolved-public-launch` basiert auf
`4600d764281bc1f2ca0a4e66485c9ce479a3db91`. Neue Projektsitzungen verwenden
automatisch den gespeicherten Projektordner. Formularentwürfe, frühere Pfade,
URL-Parameter und verspätete Ergebnisse eines Projektwechsels dürfen diesen
Ordner nicht ersetzen. Der Hub prüft Ordner, aktuelle Berechtigung und
Maschinenzugehörigkeit erneut unmittelbar vor dem Start. Ein fehlender oder
ausgetauschter Ordner führt zu einer verständlichen Fehlermeldung; dieser
Startweg legt keinen Ersatzordner und keinen externen Worktree an.

Die vollständigen betroffenen Paketsuiten bestanden 1.793 Hub-Tests und
3.886 Web-Tests; drei bestehende bedingte Hub-Integrationstests wurden
übersprungen. Beide Typechecks bestanden. Weitere 17 Veröffentlichungstests
und 22 Deployment-Prüfungen bestanden ebenfalls. Diese Zahlen bezeichnen
diesen Lauf, nicht eine erneute Abnahme der unveränderten übrigen Pakete.
Zusätzlich bestanden 15 vorhandene CLI-Tests zur Verzeichnisprüfung. Der
Evolved-Start übermittelt ausdrücklich `approvedNewDirectoryCreation: false`
bis zum Runner; ein fehlender Ordner löst keine automatische Neuanlage aus.

Web- und Landingpage-Build sowie Dokumentationsbuild bestanden. Die Landingpage
wurde bei 1440, 390 und 320 Pixeln in Englisch/Chinesisch, mit Themewechsel und
mobiler Navigation geprüft. Ein isolierter echter Hub mit Passkeys und
automatisch angelegten Projektordnern bestand sechs Browser-Prüfgruppen mit
19 Ansichten. Der Sitzungsstart übermittelte ausschließlich den jeweiligen
Projektordner und die passende Projekt-ID, auch nach Projektwechsel; ein
fehlender Runnerordner verhinderte den Start. Maschinen-RPCs und
Providerantworten waren dabei kontrollierte Testantworten. Es wurden keine
persönlichen Anbieteranmeldungen oder kostenpflichtigen Agentenaufträge ausgeführt.

README, About, Landingpage, Komponenten- und Benutzerdokumentation erklären
den unabhängigen Fork, den unterstützten Preview-Umfang und die erhaltene
Upstream-Zuordnung. Der [Veröffentlichungsbericht](PUBLICATION_READINESS.md)
trennt Quellprüfung und GitHub-Sichtbarkeit. Die tatsächlichen Opus-Aufrufe
stehen im [Reviewbeleg](reviews/public-launch-2026-10-15.json).

## Ursprüngliche Abnahme am 14.10.2026

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

## Browser-Anmeldung, Erweiterungen und Modelle am 15.10.2026

Die Erweiterung auf `feat/browser-provider-login` baut auf
`71d5bb50b8429f5b8a02161d3605eb67ad2284e6` auf. Sie umfasst native Browser-Anmeldung,
verwaltete dauerhafte Projektdienste, globale Agentenvorlagen, deklarative GitHub-Plugins,
Farbprofile und dynamische native Modellkataloge.

Die abschließenden Paketläufe bestanden 9.378 Tests; 15 bestehende bedingte Tests wurden
übersprungen. Aufteilung: CLI 3.170, Hub 1.784, Web 3.877, Shared 342, Relay 118,
Runner-Proxy 21, Deployment 11, native Anmeldung/Modelle 34 und Runner-Control 21.
Alle sieben Typechecks sowie Web- und Dokumentationsbuild bestanden.

- Die vollständige echte Hub-/WebAuthn-Browserregression bestand einschließlich GitHub,
  Codegraph, Projektordnern, dauerhaften Runnerfreigaben, Memory, Vault, Historie und Vorschau.
- Ein separater echter Hub-/WebAuthn-Lauf prüfte globale Agenten über zwei Projekte,
  Plugin-Vorschau/Installation/Update/Deaktivierung/Entfernung, Skill-Abhängigkeiten,
  Theme-Fallback sowie dynamische und manuelle Modellwahl. GitHub- und Modellantworten
  waren dabei ausdrücklich kontrollierte Testantworten; kein Agentenprompt wurde ausgeführt.
- Die Sichtprüfung umfasste 18 Ansichten und fünf Prüfgruppen bei 1440, 390 und 320 Pixeln,
  einschließlich heller/dunkler Farbprofile, kompakter Auswahlfelder und Anmeldezustände.
  Die dargestellten Provider-Challenges waren synthetisch.
- Separat wurden auf VM180 die echten anonymen Codex- und Claude-Anmelde-Challenges
  unter denselben systemd-Schutzoptionen wie der Steuerdienst geprüft. Abbruch,
  Sitzungstrennung, falscher Callback-State, Berechtigungswiderruf und dauerhafter
  Runner-Wiederanlauf bestanden. Ausgetauschte Ordner und Symlinks wurden abgewiesen,
  der gebundene Workspace behielt seine ursprüngliche Verzeichnisidentität.
- Die echten gepinnten CLIs wurden zusätzlich in einem frischen privaten HOME über ihre
  Modellprotokolle abgefragt: Codex 0.157.0 meldete sieben, Claude 2.1.285 fünf Einträge.
  Dieser anonyme Protokolltest belegt weder aktuelle Konto-Freigaben noch einen
  ungepufferten Anbieterabruf. Die Produktabfrage unterscheidet diese Grenzen sichtbar.

Die VM-Integration verwendet ausschließlich eigene temporäre Konten, Netzwerke und
Container. Persönliche Anbieteranmeldungen und kostenpflichtige Modellaufrufe wurden
nicht ausgeführt. Die abschließende Installation und die tatsächlich laufenden
Image-/Quellstände werden zusätzlich im privaten Infrastruktur-Repository unter
`hapi-evolved/update-2026-10-15-browser-login.json` dokumentiert.

Tatsächliche Claude-Opus-5.5-Aufrufe und abgearbeitete Befunde sind in
[Browser-Anmeldung](./reviews/browser-provider-login-2026-10-15.json) und
[Agenten/Plugins](./reviews/agents-plugins-2026-10-15.json) protokolliert.
Der zusätzliche [Opus-Modellreview](./reviews/native-models-opus-2026-10-15.json)
prüft Katalogrechte, parallele Anmeldungen, Zeitlimits und die Modellauswahl.
Der [native Modell-Prüfbericht](./reviews/native-models-2026-10-15.json) trennt
Protokollnachweise, kontrollierte Testantworten und Grenzen der Anbieterfreigabe.
