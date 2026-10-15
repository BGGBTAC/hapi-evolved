# Oberfläche für Desktop und PWA

Die Oberfläche verwendet ein gemeinsames Teal-/Ink-Design für Arbeitsplatz,
Anmeldung, Projekte, Chat und Einstellungen. Helle, dunkle und OLED-Darstellung
sowie gespeicherte Farbpaletten und eigene Farben bleiben verfügbar.
Die Gestaltung wurde mit Claude Opus 5.5 abgestimmt; die überprüften Befunde
werden im [Reviewnachweis](reviews/design-capacity-2026-10-15.json) dokumentiert.

## Navigation und Projektkontext

Am Desktop ordnet die Seitenleiste Übersicht, Projekte, Kapazität und Sessions
sowie Projektwerkzeuge und Verwaltung. Auf schmalen Displays stehen Übersicht,
Sessions, Projekte und „Mehr“ in der unteren Navigation. Der Mehr-Dialog hält
den Tastaturfokus, lässt sich mit Escape schließen und gibt den Fokus zurück.
Einstellungen und Abmelden sind auch dort erreichbar.

Das aktive Projekt bleibt oben sichtbar. Links wie
`/evolved?tab=memory&project=PROJECT_ID` funktionieren mit Zurück/Vorwärts und
Neuladen; die URL gewährt niemals Projektzugriff. Unbekannte Projekt-IDs werden
nicht geladen. Beim Projekt- oder Kontowechsel werden alte Abfragen verworfen
und Entwürfe der Projektformulare zurückgesetzt. Die zuletzt verwendete
Arbeitsplatzseite wird pro Hub und Benutzer lokal gemerkt.

Die Übersicht zeigt tatsächliche Sessions, offene Freigaben/Antworten und
verbundene Runner. Bei fehlender Verbindung wird kein Nullwert vorgetäuscht.
Aktualisieren lädt erneut beim Hub. Die Projektsuche erscheint ab fünf
zugänglichen Projekten. Ein neues Projekt erhält weiterhin automatisch einen
eigenen Ordner; die manuelle Auswahl bleibt optional.

## Abo-Kapazität

In Übersicht und Projekte steht pro Anbieter die neueste frische numerische
Sitzungsmeldung, andernfalls die jüngste Statusmeldung. Sie kann zu einem anderen
Anbieterkonto eines Teammitglieds gehören und ist keine kontenübergreifende
Restkapazität. Die Detailseite zeigt weitere Sessions und
Fenster, ihre Herkunft, den Meldungsstand und Reset-Zeitpunkte. Mehrere
Anbieterkonten werden weder gleichgesetzt noch addiert. Fehlende Meldungen
bleiben unbekannt; abgelaufene Werte werden nicht automatisch auf null gesetzt.
Quellen, Aktualität und technische Grenzen stehen in [CAPACITY.md](CAPACITY.md).

## Mobile Bedienung und Zugänglichkeit

- Hauptnavigation und zentrale Touch-Aktionen sind mindestens 44 Pixel hoch.
- Formulare verwenden mobil mindestens 16 Pixel Schrift; der Chat-Platzhalter
  bleibt lesbar und kürzt lange Texte mit Auslassung statt winziger Schrift.
  Seine vollständige Beschriftung bleibt für assistive Technik verfügbar.
- Chatwerkzeuge teilen eine horizontal verschiebbare Leiste. Die Kopfzeile
  trennt auf kleinen Displays Titel und Werkzeuge, damit der Titel lesbar bleibt.
- Safe Areas, einblendbare Tastatur und bestehende Chat-Scrollbegrenzungen werden
  berücksichtigt. Browser-Zoom und Querformat sind erlaubt.
- Sichtbarer Tastaturfokus, Sprung zum Inhalt, beschriftete Bedienelemente und
  reduzierte Bewegung sind vorgesehen. Die deutschsprachigen Arbeitsbereiche
  kennzeichnen ihre Sprache ausdrücklich; die bestehenden Chat-Übersetzungen
  bleiben erhalten.

Die PWA verwendet neue Icons aus einem kleinen SVG-Begleitzeichen der
Graph-e-Marke. Der Export erfolgt reproduzierbar mit
`node web/scripts/export-evolved-icons.mjs`; Details stehen in
`assets/brand/evolved/README.md`.
Ein Service-Worker-Update lädt weiterhin erst nach Benutzerbestätigung neu;
laufende Entwürfe dürfen durch ein Designupdate nicht ungefragt verschwinden.
Eine Installation allein ermöglicht keinen Offlinezugriff auf Hub-Projektdaten.
Falls noch die bisherige Oberfläche erscheint, beschreibt
[PWA_UPDATES.md](PWA_UPDATES.md) den direkten Einstieg und das geprüfte
Aktualisierungsverhalten einschließlich älterer offener Tabs.

## Reproduzierbare Prüfung

```bash
bun run typecheck
bun run test
bun run gen:fixtures
bun run build:web
node web/scripts/evolved-browser-check.mjs
node web/scripts/evolved-design-check.mjs
EVOLVED_DESIGN_EXTENDED=1 node web/scripts/evolved-design-check.mjs
```

Falls Playwrights Standardbrowser fehlt, setzt `PLAYWRIGHT_CHROME_PATH` den Pfad
zu einem vorhandenen Chromium. Der Designcheck startet einen separaten lokalen
Hub und Vault, erstellt virtuelle Passkeys, synthetische Projekte und native
Protokollmeldungen und schreibt seinen Bericht samt Screenshots in ein eigenes
temporäres Verzeichnis. Er verändert keine bestehende Installation.

Die numerischen Abo-Meldungen in dieser Abnahme sind synthetisch. Ein separater
Integrationstest verwendet eine echte installierte Codex-CLI mit isoliertem
Benutzerverzeichnis und lokalem Testanbieter. Echte Abonnentenkonten und reale
iOS-/Android-Geräte werden damit nicht als geprüft ausgegeben.

Die erweiterten Browserprüfungen decken Tablets, Querformat, OLED und 130 %
App-Schriftgröße ab. Diese Einstellung vergrößert die Grundschrift; einzelne
fest dimensionierte Überschriften skalieren darüber nicht mit. Browser-Zoom
bleibt zusätzlich verfügbar.

### Abnahmestand vom 15.10.2026

| Prüfung | Ergebnis |
| --- | --- |
| Vollständige Paketsuiten, jeweils letzter Lauf | CLI 3.170, Hub 1.683, Web 3.775, Shared 342, Relay 118, Proxy 19, Deployment 11 bestanden |
| Summe dieser Paketsuiten | 9.118 bestanden, 15 optionale/integrationsabhängige Tests übersprungen |
| TypeScript | Alle fünf Paketprüfungen bestanden |
| Fixtures | Neu generiert, ohne Vertragsdrift |
| Produktions- und Dokumentationsbuild | Bestanden, Dokumentationslinks geprüft |
| Bestehende Browserregression | Alle neun Gruppen bestanden |
| Standard-Designcheck | 69 Ansichten ohne Befund |

Die Summe stammt aus den vollständigen Paketsuiten, nicht aus einem einzigen
durchgehenden Root-Aufruf. Späte Korrekturen wurden zusätzlich gezielt geprüft;
die erweiterten Browserergebnisse, Review-Befunde und abschließenden Quellhashes
stehen im verlinkten Reviewnachweis. Numerische Kontingente in den
Browsernachweisen sind ausdrücklich Testdaten.
