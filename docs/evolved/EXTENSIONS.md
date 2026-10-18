# Spezialisten und GitHub-Plugins

Der globale Agentenkatalog enthält wiederverwendbare Spezialisten für Architektur,
Implementierung, Review und Tests. Eine Definition kann in verschiedenen Projekten
verwendet werden. Jeder Start erzeugt eine eigene Sitzung im ausgewählten Projekt;
Dateien, Gedächtnis und Berechtigungen werden dadurch nicht projektübergreifend geteilt.

## Spezialisten verwenden

Wähle einen Spezialisten, ein Projekt, dessen laufenden Runner und einen konkreten
Auftrag. Claude oder Codex kann ausdrücklich ausgewählt werden. Die bevorzugte
Anbieterwahl und ein optionales Modell sind Voreinstellungen der Definition.
Ein Modell wird nur bei einer konkreten Anbieterpräferenz übernommen. Bei „Claude
oder Codex“ bleibt das Startmodell zunächst leer und kann für den Auftrag gewählt werden.

Der Start übernimmt immer das aktuelle Projektprofil. Ein eingeschränktes Projekt
bleibt für Claude im Planmodus bzw. für Codex schreibgeschützt. Vorlagen können weder
Profile noch Zugänge, Umgebungsvariablen oder zusätzliche Ausführungsargumente setzen.
Lesende Projektmitglieder können keine Sitzung starten.

Installationsadministratoren können eigene globale Definitionen anlegen, ändern und
entfernen. Dafür ist eine frische Passkey-Bestätigung erforderlich. Eingebaute und aus
Plugins geladene Definitionen sind schreibgeschützt. Eigene Definitionen dürfen aktive
Plugin-Skills referenzieren. Wird ein benötigtes Plugin deaktiviert oder entfernt, ist
die Definition bis zur Anpassung ihrer Skill-Auswahl nicht startbar.

Bei einer unterbrochenen Startantwort zuerst die Projektsitzungen prüfen. Die Oberfläche
verwendet für denselben Start dieselbe Vorgangs-ID: Ein bestätigter Start liefert dieselbe
Sitzung zurück; ein unklarer Ausgang erzeugt bei Wiederholung keine zweite Sitzung.
Nach der Sitzungsprüfung kann ausdrücklich ein neuer Auftrag vorbereitet werden.
Dieser erhält eine neue Vorgangs-ID und kann eine zusätzliche Sitzung erzeugen;
ein bereits laufender Auftrag wird dadurch nicht abgebrochen.

## Ein Plugin installieren

Plugins stammen zunächst aus **öffentlichen GitHub-Repositories**. Im Stammverzeichnis
muss eine Datei `hapi-evolved.plugin.json` liegen. Ein beliebiges GitHub-Repository ist
noch kein kompatibles Plugin. Private Repositories und native Pluginformate anderer
Agenten werden von diesem Installer nicht importiert.

1. Gib `owner/repository` und einen Branch, Tag oder vollständigen Commit-SHA ein.
2. Öffne die Vorschau und prüfe Quelle, Commit, Manifest-Prüfsumme und enthaltene
   Agenten, Skills, Farbprofile und Entwicklungsmodule (mit Digest).
3. Bestätige die Installation. Sie übernimmt genau die gezeigten Inhalte und den
   aufgelösten Commit; zwischenzeitliche Änderungen am Branch werden nicht nachgeladen.

Die Vorschau gilt zehn Minuten und ist an die angemeldete Sitzung gebunden. Eine neue
Anmeldung kann deshalb eine neue Vorschau erfordern. Updates haben denselben Ablauf mit
eigener Vorschau und ausdrücklicher Bestätigung. Es gibt keine automatischen Updates.
Ein Austausch des GitHub-Repositories unter demselben Namen wird über dessen numerische
Repository-ID erkannt. Updates, die von eigenen Agenten verwendete Skills entfernen,
werden abgelehnt, bis diese Agenten angepasst wurden.
GitHub-Weiterleitungen werden nicht verfolgt. Nach einer Repository-Umbenennung muss
die neue Quelle ausdrücklich geprüft werden.

Aktivieren, Deaktivieren und Deinstallieren ändern ausschließlich den globalen
Erweiterungskatalog. Vorhandene Projektsitzungen und Projektdateien werden nicht gelöscht.
Ein deaktiviertes Farbprofil fällt in der Oberfläche auf ein verfügbares Profil zurück.
Projekte mit einem Entwicklungsmodul des Plugins zeigen danach `disabled` bzw. `missing`;
ihre Einstellungen bleiben erhalten. Ein Update, das ein in einem Projekt aktives Modul
entfernt, wird abgelehnt; ein Update mit geänderter Moduldefinition muss in jedem
betroffenen Projekt übernommen werden.

## Manifestformat

Das [vollständige Beispiel](../../examples/plugins/quality/hapi-evolved.plugin.json)
enthält eine Agentenvorlage, einen Skill und ein Farbprofil. Das Format lautet:

```json
{
  "schemaVersion": 1,
  "id": "quality-kit",
  "name": "Quality Kit",
  "description": "Review-Anweisungen für ein Projekt",
  "version": "1.0.0",
  "skills": [
    {
      "id": "regressions",
      "name": "Regressionen prüfen",
      "description": "Verhalten vor und nach einer Änderung vergleichen",
      "instructions": "Prüfe konkrete Auslöser, Randfälle und passende Regressionstests."
    }
  ],
  "agents": [
    {
      "id": "reviewer",
      "name": "Qualitätsreview",
      "description": "Belegbares Review einer Änderung",
      "instructions": "Prüfe die Änderung und melde Befunde mit Datei, Zeile und Auslöser.",
      "providerPreference": "either",
      "skills": ["regressions"]
    }
  ],
  "themes": []
}
```

Agenten unterstützen `providerPreference` mit `either`, `claude` oder `codex`, ein
optionales `model` und Skill-IDs aus demselben Manifest. Skills sind Anweisungstext;
sie installieren keine Dateien in den nativen Claude- oder Codex-Konfigurationen.
Importierte Anweisungen werden beim ausdrücklichen Start als Bestandteil des
menschlichen Auftrags übergeben. Prüfe die Quelle auch dann, wenn die technische
Manifestvalidierung erfolgreich ist.

Farbprofile besitzen `id`, `name`, `mode` (`light` oder `dark`) sowie `colors` mit
genau `background`, `surface`, `text`, `muted`, `accent`, `accentText` und `border`.
Die Werte müssen sechsstellige Hex-Farben sein. Text, Sekundärtext und Links in Akzentfarbe müssen auf
Hintergrund und Oberfläche mindestens 4,5:1 Kontrast erreichen; ebenso Buttontext
gegen Akzentfarbe. Die Auswahl bleibt eine persönliche Oberflächeneinstellung.
Die Berechnung folgt der [WCAG-Kontrastdefinition](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).

Ein Manifest ist höchstens 512 KiB groß und enthält höchstens 32 Agenten, 64 Skills,
16 Farbprofile und 4 Entwicklungsmodule. Anweisungen sind auf 16.384 Zeichen je Eintrag begrenzt; ein
zusammengesetzter Startauftrag auf 64 KiB. Beim Speichern einer Vorlage bleiben
mindestens 8 KiB für den konkreten Auftrag frei. Unbekannte Felder, offene Skill-Verweise,
doppelte IDs und unzureichender Textkontrast werden abgelehnt. Es werden keine
Installationsskripte, Hooks, ausführbarer Hubcode, freie CSS-Regeln oder MCP-Server
aus Plugins ausgeführt.

## Entwicklungsmodule (`schemaVersion: 2`)

Mit `"schemaVersion": 2` darf ein Manifest zusätzlich `developmentModules` enthalten:
deklarative Entwicklungsszenarien mit Einstellungsfeldern, Handbuch, Rezepten,
Aufgaben für Spezialisten und Verweisen auf feste Prüfungen des Hosts. Ein Plugin darf
auch ausschließlich Module enthalten. Manifeste mit `schemaVersion` 1 bleiben gültig,
dürfen aber keine Module enthalten. Aufgaben können eingebaute Spezialisten oder Agenten
desselben Manifests verwenden. Module führen keinen Code aus, liefern keine Befehle für
Prüfungen und vergeben keine Rechte.

Format, Feldarten, Provider, Übernahme von Updates und Grenzen beschreibt
[Entwicklungsmodule als Plugin bereitstellen](DEVELOPMENT_MODULES.md); ein vollständiges
Beispiel ist das [Django-Plugin](../../examples/plugins/django/hapi-evolved.plugin.json).

## Manifest lokal prüfen

```sh
hapi evolved plugin validate ./mein-plugin        # Ordner mit hapi-evolved.plugin.json oder die Datei
```

Der Befehl verwendet dieselbe Schemaprüfung wie der Installer, meldet Fehler mit Pfad
(z. B. `developmentModules.0.recipes.1.steps.0.argv.2: Unknown placeholder {home}`),
gibt für jedes Modul den Digest aus, den die Installationsvorschau zeigen wird, und
weist auf nicht unterstützte Provider und Prüfdaten in der Zukunft hin. Er arbeitet
offline, lädt und installiert nichts und endet bei einem ungültigen Manifest mit
Exit-Code 1.
