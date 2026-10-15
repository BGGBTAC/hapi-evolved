# Vollständige Backlog-Runde vom 15.10.2026

Veröffentlichungshinweis: Persönliche absolute Arbeitsverzeichnisse wurden in der
Matrix und dem historischen Review-Artefakt zu repository-relativen Referenzen
normalisiert. Befunde und Quellcommits bleiben historische Nachweise. Frühere
Git-Versionen dieser Dateien sind dadurch nicht bereinigt; vor einer öffentlichen
Sichtbarkeitsänderung gilt die Historienprüfung aus der Releaseanleitung.

Ausgangspunkt ist HAPI evolved 0.1 auf Commit
`8033c3df01eed9fb7d28318ba5e1aa5aa2478543`. Die Runde umfasst sämtliche **113 offenen
Upstream-Issues einschließlich 169 Kommentaren** im erfassten Stand. 209 offene PRs
dienten als Lösungskandidaten. Das private Evolved-Repository hatte keine zusätzlichen
offenen Issues. Upstream-Issues wurden weder geschlossen noch kommentiert.

## Bewertung und Ergebnis

Funktionalität: 1 kosmetisch, 2 Nische, 3 nützliche Option, 4 wesentlicher wiederkehrender
Arbeitsgewinn, 5 Kernproduktivität/Zuverlässigkeit, 6 Sicherheit/Datenintegrität.
Umsetzbarkeit: 1 Forschung/Architekturwechsel, 2 großer ungewisser Umfang,
3 größerer handhabbarer Umbau, 4 mittlerer Aufwand, 5 kleine Änderung, 6 trivial/bereits
nachgewiesen. Der Projektnutzen wird zusätzlich begründet.

**Pflichtregel: F ≥ 4 und U ≥ 3.** Alle 56 passenden Einträge sind umgesetzt oder bereits
erfüllt und nachgeprüft. Vier davon waren bereits abgedeckt. Hinzu kommen zwölf
Umsetzungen nach positiver Kosten-Nutzen-Abwägung unterhalb der Pflichtschwelle.

| Entscheidung | Anzahl | Bedeutung |
|---|---:|---|
| Umsetzen | 64 | 52 Pflichtpunkte und 12 zusätzliche Entscheidungen; mehrere Issues können denselben zusammenhängenden Fix betreffen |
| Bereits erfüllt, nachgeprüft | 4 | Bestehende Korrekturen und Regressionen statt unnötiger Neuentwicklung |
| Zurückgestellt | 40 | Aufwand, Unsicherheit oder geringer Nutzen mit einzelner Begründung |
| Abgelehnt | 3 | Widerspricht Projektumfang oder bewusstem Berechtigungsmodell |
| Nicht anwendbar | 1 | Betrifft einen nicht integrierten Anbieter |
| Bestehender Teilumfang | 1 | Private statische Vorschau erfüllt nicht das vollständige Devserver-Proxy-Issue |

Die [vollständige Matrix als CSV](backlog-decisions-2026-10-15.csv) eignet sich zum Filtern;
die [JSON-Fassung](backlog-decisions-2026-10-15.json) enthält pro Issue Kriterien, Begründung,
Kosten/Nutzen, tatsächlichen Stand, Quellenfingerabdruck, Codebelege und Prüfgrenzen.
Die neue Bedienung und Betreiberkonfiguration stehen in [BACKLOG_FEATURES.md](BACKLOG_FEATURES.md).

## Umsetzung

Die Änderungen umfassen persistente Anhangsoriginale mit sicherem Download und
Runner-Übergabe, Volltextsuche samt historischen Treffern, begrenzte Verlaufsfenster,
verlustfreie Behandlung langer Texte, Bildkompression mit Originalauswahl, Werkzeugbilder,
persönliche Prompts, Aktivitäts-/Blockiert-Filter, Terminalentwürfe und Dateivorschau.
PR-Verknüpfungen und der separate Textdialog sind ausdrücklich aktivierbare Funktionen.

Peer-Aufträge, Herkunftsnachweise, automatische Codex-Abschlussberichte und persistente
UTC-Zeitpläne bleiben an Projektrechte, Profile und widerrufbare Runner-Leases gebunden.
Laufzeitkorrekturen betreffen unter anderem Reconnect, Resume, Prozessende, Fähigkeiten,
Modellfehler, Thinking, Kontext und Diktat. Der bestehende eigene Vault, Graphiti/Neo4j
und Codegraph bleiben erhalten; Infisical und HAPIimprovr sind keine Produktabhängigkeiten.

## Adversarielle Prüfung mit Claude Opus

Für Kriterien, komplexe Teilentwürfe, Umsetzung und die abschließende Gesamtprüfung
wurde tatsächlich **`claude-opus-5-5`** verwendet. Die Antworten enthalten diesen Namen
auch in den Modellmetadaten. Das [Review-Artefakt](reviews/opus-2026-10-15.json) bewahrt
die historischen Befunde, Modellnachweise und Quellenprüfsummen. Historische Befunde
beschreiben jeweils ihren damaligen Code; sie sind nicht mit dem Endzustand gleichzusetzen.

Wesentliche bestätigte Befunde und ihre Behandlung:

| Befund | Behandlung und Nachweis |
|---|---|
| Upgrade von Schema 26 überspringt neue Anhangstabellen | Vollständige Migration bis Schema 32; echte alte DB wird geöffnet und kann anschließend Anhänge speichern |
| Löschen einer Sitzung überspringt Benachrichtigungen anderer Sitzungen | Retentionsgrenze nur durch echte Aufbewahrungsbereinigung; verschachtelte Lösch-, Merge- und Restore-Regressionen |
| Kopierte Historie erzeugt neue Fertigmeldungen | Journal schreibt nur neue Live-Ereignisse; Import/Fork bleiben historische Daten |
| Agent überschreibt menschlichen PR-Hauptlink | Quellpriorität und atomare Aktualisierung; 409 bei widersprechendem menschlichem Hauptlink |
| Anhangsprüfung dekodiert synchron den gesamten Verlauf | Eigener Referenzindex, begrenzter wiederaufnehmbarer Backfill und sichere Sperre destruktiver Aktionen während des Upgrades; Prüfung mit 50.000 Nachrichten |
| SQLite-Leser bleibt beim Kopieren von Anhängen über asynchrone Arbeit offen | Begrenzte abgeschlossene Seiten, obere Sequenzgrenze und Prüfung auf geänderte Historie |
| Bildwechsel verwechselt parallelen Upload oder verliert Original | Eigene Ersatz-ID, bestätigter Uploadzustand, Rücknahme und Sperre bei inkonsistentem Paar; begrenzte Bilddekodierung |
| TXT-Auswahl schließt trotz unvollständigem Upload | Originaltext bleibt verfügbar; React-Zustand wird nach bestätigtem Upload abgewartet; echter Browser prüft exakte UTF-8-Bytes |
| Diktat überschreibt späteren Entwurf oder startet nach Widerruf | Kontextgeneration, begrenzte Finalisierung, erneute Zustimmungskontrolle und Widerruf über andere Tabs |
| Aktivitätswerte und Blockiert-Status aktualisieren sich erst nach Reload | Vollständige SSE-/Detail-Patches einschließlich null und sinkender Uhr; vorhandene Aktivität bleibt beim Suchbackfill erhalten |
| Automatischer Bericht verschwindet bei Rate-Limit | Dauerhafter Ausgang `rate_limited` im Journal, keine automatische Doppelzustellung |
| Native Slash-Konfiguration kann Projektprofil umgehen | Zusätzlicher lokaler Profilcheck und Tests für verweigerte Rechteausweitung |
| Älterer Runner verliert Nachricht mit neuer Anhangs-ID | Explizite Capability; verständliches 409 vor dem Versand statt stillen Textverlusts |
| Restore verliert Anhangsdateien oder verwendet alte Cursor | Gemeinsame gestoppte Sicherung, rein lesender Integritätsprüfer und explizite Cursorinvalidierung vor Neustart |

Weitere Behauptungen wurden am vollständigen Code widerlegt: Die Evolved-Middleware
prüft den exakten Browser-Origin bereits vor den Teilroutern und begrenzt Bodies;
inaktive Sitzungen erzeugen bereits keine wiederholten Offline-Ereignisse. Negative
Regressionen bestätigen diese Grenzen. Unsichere Archivierung ohne bestätigtes
Prozessende bleibt verweigert. Ein abgewiesener Quell-Löschvorgang bei nicht gesicherten
Fork-Anhängen bewahrt die Originale; der dokumentierte Ausweg ist Kind löschen oder
Speicher freigeben, ohne automatisch Daten zu verwerfen.

## Abnahme

Die vollständigen lokalen Paketsuiten wurden auf dem gepushten Implementierungscommit
`f8a1716527d8a18cca537db8001563432619309e` erneut ausgeführt: **8964 bestandene Tests
und 15 bedingte Skips**, keine Fehler. Die GitHub-CI führt die Gesamtsuiten auf dem gepushten Commit erneut
aus, sobald die unten dokumentierte Kontosperre aufgehoben ist.

| Prüfung | Ergebnis |
|---|---|
| CLI / Hub / Web | 3136 / 1637 / 3712 bestanden; 12 / 3 / 0 bedingte Skips |
| Shared / Relay / Runner-Proxy / Deployment | 342 / 118 / 9 / 10 bestanden |
| Serielle Runner-Integration mit echten Prozessbäumen | 14 bestanden, 1 ausdrücklich optionaler Stresstest übersprungen |
| Playwright-Fixtures | 19 bestanden |
| Codegraph-Service / Memory-Service / PR-Automation | 3 / 9 / 36 bestanden |
| Letzte Profil-, Restore- und Sprachregressionen | 110 / 6 / 30 bestanden |
| Echter Codex 0.157.0, isolierter lokaler Testprovider | Neustart-/Resume-/Profilprüfung bestanden, 75,53 Sekunden |
| Typprüfung / vollständiger Produktbuild | Alle fünf Pakete / Build bestanden |
| Fixture-Reproduktion | 91 Dateien ohne zusätzliche Abweichung |
| Vollständiger Evolved-Browserablauf | Bestanden, einschließlich exakter Original- und TXT-Bytes |

**Externe CI-Sperre:** [PR #2](https://github.com/BGGBTAC/hapi-evolved/pull/2),
Implementierungscommit `f8a1716527d8a18cca537db8001563432619309e`. GitHub hat am
15.10.2026 sämtliche Jobs vor dem ersten Schritt abgewiesen. Es liegt deshalb für
diesen historischen Lauf keine erfolgreiche Remote-Abnahme vor. Belege:
[Test](https://github.com/BGGBTAC/hapi-evolved/actions/runs/38664511945),
[iOS](https://github.com/BGGBTAC/hapi-evolved/actions/runs/38664511950),
[Android](https://github.com/BGGBTAC/hapi-evolved/actions/runs/38664511958).
Es gibt daher keine erfolgreiche CI-Abnahme dieses Commits. Abrechnung, Limits und
Produktionsinfrastruktur wurden nicht verändert. Nach Wiederverfügbarkeit müssen
diese Prüfungen erneut laufen; die native Freigabe steht bis dahin aus.

Swift- und Android-Änderungen gleichen die nativen Anhangsmodelle und Fixtureversion 2
an. Mangels lokaler Apple-/Android-Toolchain werden deren Kompilierung, Pakettests und
Simulator-/Emulatortests über die dafür vorgesehenen GitHub-Jobs geprüft. Ein grüner
Weblauf wird nicht als Nachweis nativer Kompatibilität ausgegeben.

Der echte Browsertest verwendet einen isolierten Hub und Vault, einen virtuellen
Passkey und synthetische Daten. Er prüft Anmeldung/Recovery, Rechteentzug, Preview-
Sandbox, Memory, Suche und alte Treffer, lange Verläufe, PR-Link/Unlink, private
Originaldownloads, lokale Markdown-Bilder und relative Links, `/btw` mit genau einem
Textaufruf sowie TXT-Upload, Kompression und Originalwechsel. Ein echter Codex 0.157.0
testet laufende Arbeit und Geschwistersitzungen über Runner-/Hub-Neustarts, Archivierung
und erneutes Öffnen. Für neue leere Shared-Threads nutzt der nachgewiesene Versionspfad
explizit den kompatiblen History-Modus; bestehende explizite Modi werden nicht umgeschrieben.

## Verbleibende Grenzen

- Innerhalb eines Projekt-Runners teilen Prozesse weiterhin UID, Home und Proxy.
  Eine behauptete Sitzungs-ID ist keine OS-Identität; #1535 bleibt F6/U2 zurückgestellt.
- Native Evolved-Ausführung unterstützt Claude Code und Codex. Korrekturen geerbter
  Adapter oder nativer Datenmodelle sind keine vollständige Anbieter-/Mobile-Freigabe.
- Große Chats nutzen begrenzte Fenster und überspringen Layout/Zeichnen unsichtbarer
  Elemente; nicht sämtliche unsichtbaren DOM-Knoten werden entfernt.
- Providerverträge, Tokenabrechnung und Cloud-Diktat sind mit kontrollierten Antworten
  geprüft. Reale Audioqualität, Graph-Extraktionsqualität und Anbieterabrechnung werden
  dadurch nicht belegt. Neue Cloudfunktionen benötigen explizite Konfiguration.
- Das globale Anhangslimit schützt den Host; es garantiert keine reservierte Kapazität
  für jedes Projekt. Gemeinsame Backups und Betreiberwartung bleiben erforderlich.
- Diese Runde liefert einen geprüften Entwicklungsstand als Pull Request. Bestehende
  Produktivdienste, Infrastruktur, DNS und öffentliche Veröffentlichungen werden nicht
  durch diesen Codeabgleich umgestellt.
