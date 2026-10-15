# Erweiterungen aus dem Backlog

Die Entscheidungsdatei `backlog-decisions-2026-10-15.json` enthält die Bewertung jedes
Upstream-Issues. Diese Anleitung beschreibt die neuen Bedien- und Betriebsregeln.
Der eigene Vault, Graphiti/Neo4j und Codegraph bleiben die Komponenten aus v0.1;
Infisical und HAPIimprovr sind keine Abhängigkeiten.

## Suche und lange Unterhaltungen

Die Sitzungsübersicht durchsucht Metadaten und optional sichtbare Nachrichteninhalte.
Im Chat öffnet die Suchlupe eine eigene Trefferliste mit Textvorschau. Ein Treffer kann
älter als das geladene Nachrichtenfenster sein; der Client lädt dann begrenzten Kontext
nach und markiert die Fundstelle. Vor/Zurück führt chronologisch durch die Treffer.
Werkzeugrohdaten, verborgenes Reasoning und Anhangsbytes gehören nicht zum Textindex.

Bestehende Nachrichten werden nach einem Upgrade im Hintergrund indexiert. Solange
der resumierbare Backfill läuft oder Index-/Suchgrenzen greifen, kennzeichnet die API
die Ergebnisse als möglicherweise unvollständig. Indexierter Nachrichtentext ist auf
32.768 Zeichen begrenzt; die Zweizeichensuche hat einen kleineren Hilfsindex.

Beim Einfügen von mehr als 4.000 Zeichen oder 40 Zeilen bietet der Composer Text oder
eine unveränderte UTF-8-Datei an. Die Auswahl bereitet den Entwurf vor; anschließend
wird normal gesendet. Lange Benutzernachrichten erscheinen zunächst gekürzt. Aufklappen
und Kopieren beziehen sich auf das vollständige Original; nur die Anzeige ist gekürzt.

## Explizite GitHub-PR-Verknüpfungen

Standardmäßig ausgeschaltet. Ein Hubadministrator aktiviert „GitHub PR links“ unter
den allgemeinen Einstellungen. `HAPI_GITHUB_PR_AWARENESS=1` bzw. `0` überschreibt und
sperrt diese Einstellung. Ohne Umgebungswert bleibt die Auswahl privat in
`HAPI_HOME/features.json` erhalten.

Der PR-Knopf am Chat akzeptiert eine `github.com`-PR-URL oder `owner/repository#123`.
Die Verknüpfung erscheint am Chat und in der Übersicht. „Unlink PR“ entfernt sie.
Der Hub fragt weder GitHub ab noch leitet er PRs aus Titeln ab. GitHub Enterprise und
Status-/Merge-Abfragen sind nicht Teil dieser Funktion.

`hapi link-pr owner/repository#123` und das MCP-Werkzeug `link_pr` adressieren die
aktuelle `HAPI_SESSION_ID`. Das Werkzeug erscheint bei einer neuen MCP-Verbindung,
wenn die Funktion freigeschaltet ist. Nach Aktivierung Agentensitzungen neu verbinden;
Deaktivierung verweigert Schreibzugriffe sofort. Gespeicherte Links bleiben erhalten.
Neue Sitzungsidentitäten übernehmen keine Links, Kontinuität derselben Identität schon.
Agenten können eigene Hauptlinks ersetzen und Nebenlinks erhalten; einen menschlich
gesetzten anderen Hauptlink müssen Menschen zuerst im Browser lösen.

## Separater Textdialog `/btw`

`/btw` öffnet eine separate Frage. Nur der ausdrücklich eingegebene Text wird gesendet:
kein Chatverlauf, kein Mikrofon, keine Werkzeuge, keine automatische Übernahme in den
Agentenchat. Der Dialog zeigt Anbieteradresse, Modell und verbleibendes Tokenbudget
vor dem Senden. Antworten sind reiner Text und verschwinden beim Wechsel des Kontextes.

Ohne vollständige Betreiberkonfiguration ist die Funktion aus. Der Betreiber setzt
im Hub-Prozess bzw. einem lokalen Compose-Override:

```dotenv
EVOLVED_SIDECHANNEL_ADAPTER=openai-chat-completions-v1
EVOLVED_SIDECHANNEL_URL=https://provider.example/v1/chat/completions
EVOLVED_SIDECHANNEL_MODEL=EXPLIZITER_MODELLNAME
EVOLVED_SIDECHANNEL_KEY_FILE=/run/private/side-provider.key
EVOLVED_SIDECHANNEL_DAILY_TOKENS=100000
```

Das Beispiel benennt keinen getesteten Cloudanbieter. Der feste Adaptervertrag ist
`messages:[{role:"user",content:TEXT}]`, `max_tokens:1024`, `stream:false` plus Modell.
Er erwartet JSON mit `choices[0].message.content` und optionaler Tokenverbrauchsangabe.
Reasoning-Modelle, die andere Parameter verlangen, werden nicht automatisch umgestellt.
Die private Schlüsseldatei gehört der Hub-UID, hat Modus `0600`, maximal 4 KiB und
wird ausschließlich in den Hub gemountet. Kein Provider-Schlüssel gehört in den
Workspace oder den Runner. Loopback-HTTP ist nur mit
`EVOLVED_SIDECHANNEL_ALLOW_LOOPBACK_HTTP=1` für `127.0.0.1`/`[::1]` zulässig.

Das Budget gilt pro Projekt und UTC-Tag, unabhängig vom Memory-Budget. Es begrenzt
Tokens, nicht Geld; Anbieterpreise verantwortet der Betreiber. Vor jedem Aufruf werden
UTF-8-Eingabebytes plus Antwortlimit und Protokollreserve gebucht. Bestätigter Verbrauch
wird auf dem ursprünglichen Tag abgerechnet. Unklare Ausgänge behalten ihre Reserve.
Eine Anfrage-ID wird nie automatisch wiederholt. Die Datenbank enthält nur IDs,
Zeitpunkte und Verbrauch, keine Fragen, Antworten oder Inhalts-Hashes.

Meldet ein Provider mehr Tokens als reserviert, wird der tatsächliche Verbrauch gebucht
und diese Konfiguration dauerhaft gesperrt. Der Betreiber muss den Adapter/Modellvertrag
prüfen; ein Neustart hebt die Sperre nicht auf. Browser-Runner-Capabilities und Viewer
haben keinen Zugriff. Rechte und Sitzungszugehörigkeit werden auch nach der Antwort
erneut geprüft; eine entzogene Berechtigung verwirft die Antwort, nicht die Abrechnung.

Widersprüchliche Verbrauchswerte werden konservativ zum größeren Wert abgerechnet.
Negative, nicht ganzzahlige oder außerhalb sicher darstellbarer Ganzzahlen liegende
Werte sperren die Konfiguration ebenfalls und verbrauchen mindestens das Tagesbudget.

## Dauerhafte Benachrichtigungsnachlieferung

`GET /api/notifications/events?after=CURSOR&limit=100` liefert neue `ready`-, `task`-
und Sitzungsabschlussereignisse des aktuell berechtigten Projekts. Ein Ereignis enthält
Quellreferenzen, keine Textkopie. Historische Imports/Forks erzeugen keine neuen
Fertigmeldungen. Offene Berechtigungsanfragen müssen aus dem aktuellen Sitzungszustand
gelesen werden; das Journal wiederholt keine veralteten Freigabeaufforderungen.

Verbraucher verbinden zunächst SSE, puffern eingehende Ereignisse, lesen das Journal
bis zur `highWater`-Grenze und deduplizieren über die Ereignis-ID. Folgeseiten verwenden
`after=nextCursor&until=highWater`. Live-SSE trägt bei zugehörigen Ereignissen
`notificationCursor`. Danach wird der gespeicherte Cursor für spätere Nachlieferungen
verwendet. Ein leerer Rest kann trotzdem den Cursor bis `highWater` fortschreiben.

Pro Namespace bleiben höchstens 20.000 Ereignisse bzw. 30 Tage erhalten.
`gap:true` verlangt einen aktuellen Zustandssync; alle noch vorhandenen Ereignisse
werden trotzdem geliefert. Gelöschte Quellen sind nicht mehr zugänglich. Normale
Hubneustarts erhalten die Cursor. Ein fremder/veralteter Cursor liefert HTTP 400 und
verlangt einen neuen Zustandssync. Endgeräte müssen ihre eigene Anzeige deduplizieren.

**Wiederherstellung eines Backups:** Die DB selbst kann einen Rollback ihrer Historie
nicht erkennen. Datenbank und vollständiges Anhangsverzeichnis müssen deshalb aus
demselben gestoppten Backup stammen; alle absoluten Laufzeitpfade der Originaldateien
müssen erhalten bleiben. Erst bei konsistenten Dateien die Cursor-Epoche rotieren,
danach den Hub starten. Beispiel innerhalb des Compose-Hubs (weiterhin gestoppt):

```sh
bun hub/scripts/check-restored-attachments.ts /data/hapi.db /data/attachments
bun hub/scripts/invalidate-restored-notifications.ts /data/hapi.db
```

Der erste Befehl prüft unter Linux ausschließlich lesend DB-Zeilen und Dateien (Größe, SHA-256, sichere Pfade, Orphans und erwartetes Löschjournal), höchstens 100 Beispielbefunde. Bei Exitcode 1 oder 2 nicht starten; vollständige zusammengehörige Sicherung prüfen. Details und Containeraufruf stehen im [Betriebsleitfaden](./DEPLOYMENT.md#betrieb-sicherung-und-aktualisierung). Der Hub und alle Schreiber müssen für beide Schritte gestoppt sein. Er invalidiert ausschließlich die
Journalcursor und markiert keine alten Berechtigungsanfragen als neu. Die neue
Cursor-Epoche verhindert das stille Wiederverwenden alter Ereignisidentitäten.


## Peer-Hilfssitzungen und Herkunft

Peer-Werkzeuge sind pro Projekt zunächst ausgeschaltet. Ein Administrator schaltet
sie mit aktueller Passkey-Anmeldung ein und erteilt Runner-Leases die benötigten
Scopes `peers:read`, `peers:send` und/oder `peers:manage`. Neue MCP-Verbindungen
zeigen nur freigegebene Werkzeuge. Nach einer Aktivierung neu verbinden; Widerruf,
Profilwechsel oder Abschalten werden bei jeder Aktion sofort geprüft. Die
Projektrestriktionen gelten auch bei Spawn und Resume: keine automatische YOLO-Freigabe.

`list_peers`, `search_peers` und `inspect_peer` lesen ausschließlich das Projekt.
`ping_peer` sendet einen als Daten gekennzeichneten Auftrag. `spawn_peer` startet
Claude oder Codex mit einem dauerhaft gespeicherten Auftrag; `archive_peer` darf
nur vom Hub registrierte Peer-Workers stoppen und archivieren. Primäre menschliche
Sitzungen bleiben über den Browser bedienbar. Unsichere Stop-/Spawn-Ausgänge werden
nicht als Erfolg bestätigt und nicht automatisch erneut gestartet.

Jeder Schreibaufruf braucht eine vom Aufrufer gewählte stabile ID: `deliveryId`
für Nachrichten, `operationId` für Spawn/Archivierung. Bei Wiederholung ID und
Argumente unverändert lassen. Die CLI verwendet entsprechend `--delivery-id ID`
und `--operation-id ID`; `--reply-to ID` bindet eine Antwort an eine frühere Zustellung.
Eine Bestätigung bedeutet dauerhafte Annahme, nicht erfolgreichen Aufgabenabschluss.
Abgeschlossene Wiederholungen verbrauchen kein weiteres Rate-Kontingent. Unklare
Spawns behalten ihre ID-Sperre; nach einem Absturz muss der vorhandene Workerbestand
geprüft werden. Alte Inflight-Reservierungen blockieren die Kapazität höchstens zehn
Minuten, ohne einen erneuten Start derselben Operation zu erlauben.

Der Hub attestiert die Projekt-Runner-Herkunft separat vom frei beschreibbaren
Nachrichteninhalt. **Eine behauptete Sender-Sitzungs-ID ist keine authentifizierte
Sitzungsidentität.** Prozesse eines Projekt-Runners teilen weiterhin Betriebssystem-
Identität und lokalen Proxy. Diese Grenze aus #1535 bleibt offen; sie berechtigt
nie zum Zugriff auf andere Projekte. Fremde oder nachträglich veränderte
Nachrichtenmetadaten erhalten keine Hub-Herkunftskennzeichnung.

Pro Projekt gelten 60 Zustellungen und 8 Spawns pro Minute sowie höchstens 32 aktive
registrierte Peer-Workers (einschließlich laufender Spawn-Reservierungen). Zusätzlich begrenzen Elternzuordnung und Tiefe die normale Delegation
auf 8 Kinder und 3 Ebenen; gegen böswillige behauptete Elternadressen schützt die
Projektobergrenze. Das Operationsjournal und automatische Berichte sind auf je
50.000 Einträge pro Projekt begrenzt; danach ist Betreiberwartung erforderlich.

`autoReport:true` ist für Codex verfügbar und benötigt zusätzlich `peers:send`.
Das Ziel stammt ausschließlich aus der Hub-Spawn-Zuordnung. Pro angenommenem
Ausgangsauftrag gibt es höchstens einen automatischen Abschlussbericht; gewöhnliche
Peer-Antworten starten keine Berichtsschleife. Ein unklarer Ausgang bleibt im
Journal sichtbar. Automatische Berichte sind ebenfalls auf 30 pro Minute begrenzt;
abgewiesene Berichte bleiben als `rate_limited` im Journal und werden nicht erneut versendet.

## Zeitpläne und sichtbare Aktivität

Projektadministratoren können mit aktueller Passkey-Anmeldung einen Prompt an eine
bestehende Claude-/Codex-Sitzung planen. Es gilt numerisches Cron mit fünf Feldern
in **UTC**: Minuten, Stunden, Monatstag, Monat und Wochentag (0 oder 7 = Sonntag).
Listen, Bereiche und Schritte sind erlaubt. Die Oberfläche zeigt den nächsten Lauf.
Maximal 100 Zeitpläne pro Projekt; Laufprotokolle bleiben 30 Tage erhalten.

Ein Lauf benötigt weiterhin die Rechte des bestätigenden Administrators, dasselbe
Projektprofil und eine aktuell berechtigte Runner-Lease. Profiländerungen verlangen
erneute Bestätigung. Beschäftigte Ziele und offene Freigabeanfragen werden
übersprungen. Verpasste oder während der Vorbereitung über eine Minute verspätete
Läufe werden nicht nachgeholt. Nach einem Absturz während der Zustellung lautet der
Ausgang „indeterminate“; es gibt keine automatische Wiederholung unbekannter Arbeit.
Planannahme erteilt keine zusätzlichen Werkzeug- oder Vault-Rechte.

Die Sitzungsübersicht trennt echte sichtbare Gesprächsaktivität von Keepalive- und
Metadatenverkehr. Das explizite Notify-Footer-Signal `status:"blocked"` markiert eine
Sitzung als blockiert; Berechtigungsanfragen oder ungelesene Nachrichten erzeugen
dieses Signal nicht. Eine neue sichtbare Nutzernachricht hebt es auf; während der
Agent arbeitet, zeigt die Übersicht keinen veralteten Blockiert-Status. Ohne sichtbare
Nachrichten ist der Aktivitätszeitpunkt unbekannt; die Übersicht verwendet dann den
Sitzungszeitpunkt. Ein Suchindex-Neuaufbau erhält vorhandene Aktivitätswerte. Die
Ermittlung des letzten Nutzerauftrags kann währenddessen begrenzte, asynchrone
Transkriptseiten lesen; Herkunft und aktuelle Rechte werden vor einem Bericht erneut geprüft.

## Anhänge, Diktat und Entwürfe

Neue Uploads werden im Hub mit Projekt- und Sitzungszuordnung dauerhaft gespeichert.
Nachrichten enthalten eine Anhangs-ID; der Runner lädt die erlaubten Bytes vor der
Übergabe an das native Modell lokal. Originaldownloads sind authentisiert und privat.
Forks und Zusammenführungen erhalten die zugehörigen Referenzen. Entfernen eines noch
verwendeten Anhangs ist gesperrt. Bestehende reine Dateipfad-Referenzen werden nicht
automatisch zu einer bereits gesicherten Hub-Datei erklärt.

Große unterstützte Bilder werden bei automatischer Optimierung im Browser verarbeitet.
Transparente Bilder und nicht sicher dekodierbare Formate bleiben unverändert; JPEG
wird nur verwendet, wenn es tatsächlich kleiner ist. Am Entwurf lässt sich vor dem
Senden wieder das Original auswählen. Diese Auswahl sperrt den Versand bis zum Ende
des Uploads. Unter Einstellungen lässt sich das Original als Standard festlegen. Werkzeugantworten können
begrenzte eingebettete Rasterbilder mit Vorschau zeigen; beliebige externe Bild-URLs
und SVG-Daten werden darüber nicht nachgeladen.

Persönliche gespeicherte Prompts werden über die Benutzeroberfläche verwaltet und an
der Cursorposition eingefügt. Sie starten keinen Auftrag automatisch. Terminaleingaben
und Chatentwürfe bleiben beim Wechsel innerhalb der Sitzung erhalten.

Browser-Cloud-Diktat ist eine zusätzliche, zunächst deaktivierte Option. Es braucht
`EVOLVED_BROWSER_CLOUD_STT_ENABLED=1` beim Betreiber und ausdrückliche Zustimmung in den
Spracheinstellungen. Audio geht unmittelbar an den Anbieter des Browsers; der Hub sieht
nur das Transkript. Der lokale Browsermodus bleibt separat. Die Verfügbarkeit hängt vom
Browser und dessen Anbieter ab; die Abnahme simuliert Erkennungsereignisse und belegt
keine reale Cloud-Audioverarbeitung. Wechsel von Konto, Projekt oder Sitzung verwirft
überholte Ergebnisse. Ein nicht fertiggestelltes Diktat darf keinen späteren Entwurf
überschreiben.

## Laufzeit und große Verläufe

Codex- und Claude-Einstellungen stammen aus den gemeldeten Fähigkeiten der Laufzeit.
Gemeinsame Deskriptoren transportieren Wertebereiche, Abhängigkeiten und native Schlüssel;
unbekannte Werte werden verweigert. Das ersetzt nicht automatisch alle bisherigen
anbieterspezifischen Steuerelemente. Native Evolved-Runner unterstützen weiterhin
Claude Code und Codex; Korrekturen anderer bestehender Adapter erweitern diese Liste nicht.

Nachrichtenfenster und Verlaufscaches sind begrenzt. Außerhalb des sichtbaren Bereichs
überspringt der Browser Layout und Zeichnen über `content-visibility`, erhält dabei aber
Komponenten- und Werkzeugzustand. Das ist keine vollständige Entfernung unsichtbarer
DOM-Knoten. Historische Suchtreffer laden ihren eigenen begrenzten Kontext nach.
