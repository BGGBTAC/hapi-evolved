# Gemeinsame Grundlagen für Agentensitzungen

HAPI-eVolved übergibt seine Betriebsgrundlagen automatisch an die unterstützten
Claude- und Codex-Sitzungen. Benutzer müssen diese Hinweise weder in jede
Nachricht kopieren noch pro Projekt einen Spezialisten konfigurieren. Normale
Sitzungen und Spezialisten verwenden dieselbe Grundlage.

Der versionierte Text in
[`operatingContext.ts`](../../cli/src/evolved/operatingContext.ts) erklärt:

- den zugewiesenen Projektordner und die maßgebliche Repository-Dokumentation;
- lokale persistente Wissenssuche, Quellen und Wissensvorschläge;
- die davon getrennte optionale Graphsuche und die Bedeutung ihres 503-Fehlers;
- Repository-Freigaben, exakte GitHub-Namen, Klonen/Pullen und den Zugang über
  den Credential-Broker;
- den Zustand des Codegraph-Index sowie den Umgang mit fehlenden Indizes;
- Ressourcenaktionen, Geheimnisse, Anbieteranmeldungen und Grenzen der Rechte;
- die Übergabe dieser Regeln und relevanter Projektinformationen an Unteragenten.

Der Text enthält keine Geheimnisse, Projektinhalte oder gespeicherten
Verfügbarkeitsaussagen. Aktuelle Informationen werden mit den freigegebenen
Werkzeugen gelesen. Die Hinweise verleihen keine zusätzlichen Rechte.

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

## Übertragung und Lebenszyklus

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
[Reviewprotokoll](reviews/agent-operating-context-2026-10-16.json).
