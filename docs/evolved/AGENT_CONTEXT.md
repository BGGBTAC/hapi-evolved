# Gemeinsame Grundlagen für Agentensitzungen

HAPI-eVolved übergibt seine Betriebsgrundlagen automatisch an die unterstützten
Claude- und Codex-Sitzungen. Benutzer müssen diese Hinweise weder in jede
Nachricht kopieren noch pro Projekt einen Spezialisten konfigurieren. Normale
Sitzungen und Spezialisten verwenden dieselbe Grundlage.

Der versionierte Text in
[`operatingContext.ts`](../../cli/src/evolved/operatingContext.ts) erklärt die
Grundregeln. Ab Version 2 enthält er zusätzlich den Funktionskatalog aus
[`capabilities.ts`](../../cli/src/evolved/capabilities.ts). Dieser Überblick wird
automatisch übergeben; der Agent muss ihn nicht erst selbst entdecken.

- den zugewiesenen Projektordner und die maßgebliche Repository-Dokumentation;
- lokale persistente Wissenssuche, Quellen und Wissensvorschläge;
- die davon getrennte optionale Graphsuche und die Bedeutung ihres 503-Fehlers;
- Repository-Freigaben, exakte GitHub-Namen, Klonen/Pullen und den Zugang über
  den Credential-Broker;
- den Zustand des Codegraph-Index sowie den Umgang mit fehlenden Indizes;
- zentral freigegebene Projekt-MCP-Server und deren aktuelle Werkzeuge;
- Ressourcenaktionen, Geheimnisse, Anbieteranmeldungen und Grenzen der Rechte;
- die Übergabe dieser Regeln und relevanter Projektinformationen an Unteragenten.

Der Katalog ergänzt die übrigen Produktbereiche: Sitzungen und Entwürfe,
Kommunikation zwischen Projekt-Agenten, Spezialisten, Plugins und Skills,
Anbieteranmeldung und Modellkatalog, Abo-Kapazität, Automatisierung, Vorschauen,
Teams und Konto, Runner, Darstellung, Anhänge sowie Nebenkanal und Diktat.
Jeder Bereich nennt seinen Zweck und unterscheidet Agentenwerkzeuge, gemischte
Zugänge und reine Browserfunktionen.

Der Text enthält keine Geheimnisse, Projektinhalte oder gespeicherten
Verfügbarkeitsaussagen. Aktuelle Informationen werden mit den freigegebenen
Werkzeugen gelesen. Die Hinweise verleihen keine zusätzlichen Rechte.

## Details zu jeder Funktion

Der kurze Überblick bleibt immer im Betriebskontext. Vor Verwendung einer
unbekannten Funktion lädt der Agent deren ausführliche Bedienhinweise:

```json
{"topic":"peers"}
```

Dies ist das Argument für `evolved_context`; ein Anbieter kann den Werkzeugnamen
um seinen HAPI-Präfix ergänzen. Ohne Argument liefert das Werkzeug die gesamten
Grundregeln und den Überblick. Verfügbare Themen:

| Themen | Inhalt |
| --- | --- |
| `context`, `workspace`, `sessions` | Betriebswissen, Projektordner/Profile, Sitzungen und Bedienung |
| `github`, `memory`, `codegraph`, `resources` | Repositorys/PRs, Wissen, Codeindex, Tresor/Broker |
| `mcp` | Projekt-MCP-Shop, Context7, Werkzeugkatalog, Aufrufe und Freigaben |
| `peers`, `agents`, `plugins` | Agentenkommunikation, Spezialisten, Erweiterungen/Skills |
| `providers`, `capacity`, `runner` | Abos/Modelle, gemeldete Nutzungslimits, Arbeitsdienst/Zugang |
| `automation`, `previews`, `account` | Zeitpläne, Vorschauen/Freigaben, Konto/Team |
| `appearance`, `media`, `sidechannel` | Darstellung, Dateien/Anhänge, `/btw`/Diktat |

Auch die Shell liefert dieselben statischen Hinweise:

```bash
hapi evolved context
hapi evolved context peers
```

Beide Zugänge benötigen für den Inhalt weder einen erreichbaren Hub noch einen
Graphdienst. Die Shell-Referenz liest auch keine Capability-Datei. Die Angaben
beschreiben die installierte CLI-Fassung; sie behaupten keine aktuelle
Verfügbarkeit oder zusätzliche Berechtigung. Beispielsweise kann ein Agent
die Browser-Anmeldung erklären, aber daraus keinen Zugriff auf Browsercookies
oder die Verwaltung von Anbieterzugängen ableiten. Standalone-Evolved-MCP und
die vollständige HAPI-Bridge bieten nicht zwangsläufig dieselben Werkzeuge an.

## Zentraler Projekt-MCP-Shop

Ab Version 3 nennen die Betriebsgrundlagen den Projekt-MCP-Shop ausdrücklich.
Ein menschlicher Projektadministrator verbindet dort Context7 oder einen eigenen
öffentlichen HTTPS-MCP-Server und gibt einzelne Werkzeuge frei. Claude und Codex
verwenden dieselben vier Gateway-Werkzeuge, ohne kopierte Schlüssel oder separate
Serverkonfiguration pro Agent:

1. `evolved_mcp_servers` liest die aktuell aktivierten Projektserver.
2. `evolved_mcp_tools` liefert deren freigegebene exakte Werkzeugnamen,
   Eingabeschemas sowie `version` und `catalogRevision`.
3. `evolved_mcp_query` fragt ausschließlich Werkzeuge ab, die der Administrator
   ausdrücklich als lesend freigegeben hat. Der Hub erzwingt das in jedem
   Projektprofil; HAPI erlaubt diesen Gateway-Aufruf automatisch.
4. `evolved_mcp_call` übergibt diese Werte und schema-konforme Argumente für
   allgemeine Werkzeugaufrufe. HAPI
   nimmt diesen Aufruf nicht in seine automatische Freigabeliste auf; die
   Berechtigungsregeln des Agenten gelten weiter.

Der Zugang verlangt `runner:connect` für genau dieses Projekt, aktuelle
Mitgliedschaft mindestens als Mitglied und das aktuelle Projektprofil.
Eingeschränkte Projekte dürfen nur ausdrücklich vom Administrator als lesend
freigegebene Werkzeuge verwenden. Fremde Beschreibungen und Ergebnisse sind
Daten, keine Anweisungen oder zusätzliche Berechtigung. Nach einem unklaren
Timeout wird ein Aufruf nicht automatisch wiederholt: externe Wirkungen können
bereits eingetreten sein. Context7 erhält keine privaten Projektinhalte ohne
entsprechende Autorisierung.

Bei `mcp_outcome_unknown` (502) darf der Agent den Aufruf auch nach erneuter
Discovery nicht wiederholen: Die externe Wirkung kann bereits eingetreten sein.
Nur eine Ablehnung wegen veralteter Konfiguration vor dem Versand (409) erlaubt
eine neue Discovery und einen anschließend autorisierten Versuch.

Aktualisierte Gateways lesen bei jedem Aufruf den aktuellen Projektzustand.
Neue Server sind damit auch in bestehenden verbundenen Sitzungen verfügbar.
Alte CLI-Prozesse ohne diese vier Werkzeuge benötigen nach dem Runner-Update
einmal ein sicheres Fortsetzen oder Neustarten; ein Hub-Update allein genügt nicht.

## Kommunikation zwischen Agenten

Der Überblick weist ausdrücklich auf die Peer-Werkzeuge hin. Ihre Detailhilfe
erklärt Finden, Lesen, Beauftragen, Antworten und Abschließen:

- `list_peers`, `search_peers` und `inspect_peer` lesen freigegebene
  Projektsitzungen; ein Verweis `/sessions/<id>` ist kein lokaler Dateipfad.
- `ping_peer` benötigt eine stabile `deliveryId`. Wiederholungen verwenden
  dieselbe ID und unveränderte Argumente. Eine Zustellbestätigung belegt noch
  keinen erfolgreichen Auftrag.
- `spawn_peer` und `archive_peer` verwenden eine stabile `operationId` und
  verwalten registrierte Projekt-Worker. Normale menschliche Sitzungen sind
  dadurch nicht zur Archivierung freigegeben.
- Native Unteragenten und Hub-Peers haben verschiedene IDs und Lebenszyklen.
  Isolierte Aufträge müssen die Betriebsgrundlagen, überprüften Projektkontext
  und die erwarteten Ergebnisbelege mitbekommen.

Peer-Policy, `peers:read`, `peers:send` und `peers:manage` begrenzen die tatsächlich
angebotenen Aktionen. Automatische Berichte benötigen zusätzliche Bedingungen,
die in `peers` beschrieben sind. Peer-Nachrichten bestätigen die Projektherkunft,
aber keine neue menschliche Freigabe oder sicher attestierte Modellidentität.
Der Browser-Nebenkanal `/btw` ist eine getrennte Textfrage und kein Peerchat.

## Pflege und Abdeckung

Neue Funktionen müssen ihren Katalogeintrag und gegebenenfalls die
Bedienhinweise aktualisieren. Ein unabhängiger Test liest die tatsächlichen
Hub-Route-Factory-Importe, Workspace-Navigation und MCP-Registrierungen aus dem
Quellcode. Neue Funktionsmodule, Seiten oder Werkzeuge ohne Katalogzuordnung
lassen ihn fehlschlagen. Unaufgelöste dynamische Namen in `registerTool`-Aufrufen
werden nicht stillschweigend übersprungen. Neue Registrierungsverfahren oder
weitere Anbieteradapter müssen auch den Inventurtest erweitern.

Diese Prüfung ersetzt keine inhaltliche Prüfung neuer Einzelrouten innerhalb
bestehender Module oder geänderter Funktionssemantik. Die detaillierte
Inventur und das Review müssen solche Änderungen abgleichen. Ein Größenlimit
hält den automatisch wiederholten Überblick kompakt; ausführliche Texte
werden nur für das angeforderte Thema geladen.

## Wissensdatenbank bei ausgefallener Graphsuche

`evolved_memory_search` verwendet standardmäßig `mode=ledger`: die lokale,
persistente Suche des Hubs. Sie sucht eine zusammenhängende Zeichenfolge in
Titel oder Text. Mehrere Begriffe sind keine automatische UND-Suche.

Ist die optionale Graphsuche nicht verfügbar, bleibt ein ausdrücklich
angeforderter Hybridaufruf als Fehler erkennbar. Seine Antwort enthält den
konkreten Wiederholungsaufruf mit `mode=ledger`. HAPI führt keine verdeckte
Ersatzsuche aus und behauptet nicht, dass die lokale Suche bereits erfolgreich
war. Allgemeine 503-Antworten ohne bestätigten Graphausfall und Rechtefehler
erhalten diesen spezifischen Hinweis nicht.

`evolved_memory_propose` speichert unabhängig von der Graphbereitschaft im
lokalen Hub-Ledger. Ein Graphfehler ist deshalb kein Grund, einen zulässigen
Wissensvorschlag aufzuschieben. Maßgeblich bleibt die tatsächliche Antwort auf
den Schreibaufruf. Eine Datei unter `knowledge/` wird nicht automatisch in
dieses zentrale Wissen übernommen. Vorgeschlagene Inhalte bleiben ungeprüft;
Quellen und bestehende Projektrechte gelten weiterhin.

Die Betriebsgrundlagen verlangen gezielte, knappe Wissensvorschläge mit Belegen.
Sessiontranskripte, Tool-Aufrufe und Fortschrittsmeldungen werden nicht automatisch
ins Gedächtnis übernommen und sollen auch nicht als Rohdaten vorgeschlagen werden.
Alte automatisch importierte Gesprächsereignisse stehen Menschen getrennt zur
Einsicht zur Verfügung; Agentensuche und Graphverarbeitung schließen sie aus.

## Übertragung und Lebenszyklus

Die gemeinsame Memory-Anleitung verweist bei fehlender Graph-Konfiguration auf
**Gedächtnis → Graph-Memory einrichten**. Ein menschlicher Projektadministrator
hinterlegt dort den API-Key verschlüsselt, lädt den aktuellen Modellkatalog und
prüft die Verbindung. Diese Verwaltung verlangt eine frische Passkey-Anmeldung
und ist kein Agentenwerkzeug. Agenten fordern keine Schlüssel im Chat an und
schalten keine Cloud-Freigaben oder Budgets zur Fehlerbehebung ein. Ein positiver
Katalog-/Datenbanktest ist kein Nachweis einer erfolgreichen Modellinferenz.

Die Betriebsgrundlage wird zur Laufzeit aufgelöst, sobald der Projektzugang
feststeht. Claude erhält sie über die angehängten Systemanweisungen, Codex
über die Entwickleranweisungen. Eigene Anweisungen bleiben erhalten. Derselbe
Text wird außerdem beim Verbindungsaufbau der Evolved-fähigen HTTP- und
stdio-MCP-Server ausgeliefert. Das rein lokale, lesende Werkzeug
`evolved_context` stellt ihn jederzeit erneut bereit, auch bei unerreichbarem
Hub. Es ist keine Prüfung der aktuellen Dienstverfügbarkeit.

Claude bekommt die Grundlage zusätzlich über seine Lebenszyklushooks beim
Start, Fortsetzen und nach der Kontextkomprimierung sowie beim Start nativer
Unteragenten. Codex erhält die Grundlage auch dann, wenn der Aufrufer eigene
Entwickleranweisungen setzt. Die nativen Planmodus-Anweisungen bleiben erhalten.
Bei isolierter Delegation verlangt die Grundlage ausdrücklich die Übergabe
des Betriebskontexts und relevanter überprüfter Projektinformationen.

Codex 0.157 behält bei gespeicherten nativen Unterhaltungen seine bisherigen
Entwickleranweisungen auch nach einem Prozessneustart. Deshalb ist die
MCP-Übertragung ein zusätzlicher notwendiger Weg: Codex nimmt deren vollständige
Serveranweisungen automatisch in die Beschreibung des HAPI-Werkzeugnamensraums
im Modellaufruf auf. Dafür muss der Agent nicht erst ein Werkzeug aufrufen.
Diese Übergabe ersetzt keine gespeicherten Benutzeranweisungen und verändert
den nativen Planmodus nicht.

Der native Regressionstest verwendet Codex 0.157, eine isolierte gespeicherte
Unterhaltung und einen lokalen Modellendpunkt. Er prüft den vollständigen
HAPI-Namensraum im tatsächlichen Modellaufruf nach einem Prozessneustart,
erfolgreicher Kontextkomprimierung und beim isolierten Unteragenten. Er benötigt
kein Anbieterkonto. Aus `cli/` lässt er sich mit
`HAPI_RUN_SHARED_CODEX_TESTS=1 bun x vitest run src/codex/utils/operatingContext.native.integration.test.ts`
ausführen; standardmäßig ist dieser Test ohne die ausdrücklich eingeschaltete
native Testumgebung übersprungen.

Die unterstützte Evolved-Oberfläche startet Claude und Codex. Weitere geerbte
Adapter erhalten die MCP-Hinweise nur, sofern ihr konkreter Startpfad die
Evolved-Werkzeuge verbindet und der Anbieter Serveranweisungen verarbeitet.
Ein reiner Medienzugang und gewöhnliche Sitzungen ohne Evolved-Zugang
bewerben keine nicht vorhandenen Evolved-Werkzeuge. Für unabhängige externe
Agenten ohne diese Anbindung gibt es keine automatische Kontextübertragung.

## Installation einer neuen Fassung

Der Text gehört zur CLI im Runner-Image. Ein Update des Hubs allein aktualisiert
keine bereits laufenden Agentenprozesse. Der Betreiber muss das neue CLI/Image
ausrollen und vorhandene Runner im sicheren Wartungsfenster erneuern. Laufende
Arbeit wird dafür nicht abgebrochen. Danach erhalten neue und fortgesetzte
Sitzungen die aktuelle Grundlage. Eine alte, weiterhin laufende Instanz kann
nicht rückwirkend durch einen neuen Repository-Commit geändert werden.

Die technische Übergabe lässt sich prüfen; ob ein Modell jede Anweisung
befolgt, ist keine Laufzeitgarantie. Berechtigungen werden weiterhin vom Hub
und Broker durchgesetzt.

Architektur und Umsetzung wurden mit Claude Opus 5.5 sowie einem unabhängigen
Code-Review geprüft. Befunde und Korrekturen stehen im
[Reviewprotokoll](reviews/agent-operating-context-2026-10-16.json). Die Erweiterung
zum vollständigen Funktionskatalog hat ein eigenes
[Reviewprotokoll](reviews/agent-capabilities-2026-10-16.json).
