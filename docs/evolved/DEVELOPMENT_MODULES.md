# Entwicklungsmodule als Plugin bereitstellen

Ein **Entwicklungsmodul** beschreibt ein Entwicklungsszenario für ein Projekt: ein
Einstellungsformular, ein versioniertes Handbuch, Rezepte, vorbereitete Aufgaben für
Spezialisten und Verweise auf feste Prüfungen des Hosts. HAPI bringt drei Module mit
(`builtin:odoo`, `builtin:ios`, `builtin:android`, siehe
[Entwicklungsmodi](DEVELOPMENT_MODES.md)). Weitere Module kommen ausschließlich über
den bestehenden [GitHub-Plugin-Installer](EXTENSIONS.md) in die Installation.

Diese Seite richtet sich an Plugin-Autoren und an alle, die ein neues Szenario
ergänzen wollen. Ein vollständiges Beispiel ist das
[Django-Plugin](https://github.com/BGGBTAC/hapi-evolved/blob/main/examples/plugins/django/hapi-evolved.plugin.json).

## Was ein Modul ist – und was nicht

Ein Modul ist **begrenzte, deklarative Daten**. Es enthält keinen Code, keine Hooks,
keine regulären Ausdrücke, keine Vorlagen, keine ausführbaren Programme und keine
Rechte. Konkret:

- Jedes Projekt hat **höchstens ein aktives Modul**. Ein Projektadmin wählt es unter
  **Entwicklung**; Agenten können es weder wählen noch ändern.
- Die Aktivierung installiert nichts, lädt nichts herunter, startet keinen Build,
  akzeptiert keine Lizenz und indiziert nichts. Sie vergibt keine Repository-, MCP-,
  Tresor- oder Profilrechte.
- Doctor und Inspect sind **Provider des Hosts** mit fest eingebauten Prüfungen. Ein
  Modul wählt nur, welche dieser Prüfungen gelten. Es kann weder Programme noch
  Argumente noch Pfade (außer einem geprüften, repository-relativen Ordner) vorgeben.
- Handbuch, Rezepte und Aufgabentexte sind **Daten**. Agenten erhalten sie über die
  Entwicklungswerkzeuge mit dem Hinweis, dass es sich nicht um Anweisungen handelt.
  Beim Aufgabenstart stehen sie im menschlichen Auftrag, nie in System- oder
  Entwickleranweisungen.
- Rezeptbefehle (`argv`) sind **Beispiele für die Agentensitzung**. HAPI führt sie nie
  selbst aus. Eine Sitzung führt sie nur aus, wenn ihr Auftrag es verlangt, und nur mit
  den Rechten des aktuellen Projektprofils.

## Verträge und Versionen

| Begriff | Wo | Bedeutung |
|---|---|---|
| `schemaVersion: 2` | Plugin-Manifest | Nur Manifeste mit `schemaVersion` 2 dürfen `developmentModules` enthalten. Manifeste mit Version 1 bleiben unverändert gültig. |
| `apiVersion: 1` | je Moduldefinition | Version des Definitionsformats. Eine unbekannte `apiVersion` lehnt der Installer ab. |
| `contentVersion` | je Moduldefinition | Frei gewählte Inhaltsversion zur Anzeige, z. B. `2026.10.18-1` (`^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$`). |
| `version` | Plugin-Manifest | SemVer des Plugins (`1.2.0`). |
| Vertrag 2 | Hub-API und Runner-RPC | Routen `/development/modules…`, `module_doctor`/`module_inspect`. Der ältere Vertrag 1 bleibt für die mitgelieferten Module erhalten. |
| `schemaVersion: 3` | Gespeicherte Projektkonfiguration | Neues Speicher-Envelope für unabhängige Odoo.sh-Umgebungen. Kein Plugin-Manifestwechsel. V1/V2 bleiben lesbar; erst ein ausdrückliches Speichern schreibt V3. Ältere Binaries verweigern dieses Format statt Werte zu verwerfen. |
| Modul-ID | Hub | `plugin:<Plugin-UUID>:<lokale ID>`. Die UUID vergibt die Installation. |
| Digest | Hub | `sha256:<64 hex>` über die kanonische Definition plus die Spezialisten und Skills desselben Plugins, auf die Aufgaben verweisen. |

**Identität.** Ein Modul ist durch ID und Digest bestimmt. Jede Aktivierung, jede
Übernahme, jeder Doctor-/Inspect-Lauf und jeder Aufgabenstart bindet den Digest, den
der Mensch bzw. Agent gesehen hat. Ändert sich das Modul dazwischen, lehnt der Hub mit
`development_module_changed` ab, statt eine andere Fassung auszuführen.

**Umbenennen ist ein neues Modul.** Die lokale ID (`id` der Moduldefinition,
`^[a-z][a-z0-9-]{0,63}$`) darf sich nie ändern. Eine Neuinstallation desselben
Repositorys erhält eine neue Plugin-UUID und damit eine neue Modul-ID; Projekte müssen
das Modul dann neu wählen. Verwaiste Einstellungen werden nicht automatisch
übertragen.

## Lebenszyklus

Der allgemeine Einrichtungsassistent verwendet auch Module aus Plugins. Felder,
Prüfungen, Rezepte und Aufgaben stammen aus derselben geprüften Definition wie auf
der Entwicklungsseite. Ein Modul mit einem obligatorischen Repository-Feld wird bei
der Projektanlage zunächst vorgemerkt: erst Projekt und Repository einrichten, dann
die gültigen Modulwerte speichern. Eine Vormerkung ist kein aktives Modul und keine
Freigabe. Dafür ist kein neues `setup`-Skript im Manifest erforderlich.

1. **Installation.** Ein Installationsadmin gibt `owner/repo` und Branch, Tag oder
   Commit an. Die Vorschau zeigt Quelle, Commit, Manifest-Prüfsumme und je Modul Titel,
   Inhaltsversion, Digest und Zustand. Der Digest der Vorschau ist derselbe wie nach
   der Installation und derselbe, den `hapi evolved plugin validate` lokal ausgibt.
2. **Aktivierung je Projekt.** Ein Projektadmin wählt das Modul, füllt die Felder aus
   und speichert. Die Einstellungen haben eine Revision (Compare-and-Swap); ein
   veralteter Tab erhält einen Konflikt.
3. **Update.** Ein Plugin-Update mit geänderter Definition (jede Änderung, auch
   Tippfehler) bringt jedes Projekt mit diesem Modul in den Zustand
   `adoption_required`. Bis ein Projektadmin die neue Fassung **übernimmt** (Speichern
   mit dem neuen Digest), gibt es für dieses Projekt keine Aufgaben, keinen Doctor,
   keine Inspektion und keinen Modulinhalt im Kontext. Die gespeicherten Werte bleiben
   erhalten; HAPI ergänzt oder entfernt keine Felder automatisch. Die Vorschau eines
   Updates nennt die Zahl der betroffenen Projekte. Ein Update, das ein in einem
   Projekt aktives Modul entfernt, wird mit `plugin_dependency` abgelehnt.
   Zum Digest gehören auch die Spezialisten desselben Plugins, auf die Aufgaben
   verweisen, und deren Skills: Ändern sich deren Name, Anweisungen, Anbieterwahl, Modell oder Skill-Auswahl,
   ist eine Übernahme nötig, selbst wenn der Modultext gleich bleibt. Farbprofile,
   Beschreibungen und nicht verwendete Agenten oder Skills ändern den Digest nicht.
4. **Deaktivieren und Deinstallieren.** Projekte zeigen dann `disabled` bzw. `missing`.
   Die Einstellungen bleiben erhalten; es gibt keinen Rückfall auf ein anderes Modul
   und kein stilles `none`. Wird ein Plugin unverändert wieder aktiviert, ist keine
   erneute Übernahme nötig. Jedes wirksame Aktivieren oder Deaktivieren macht laufende
   Vorgänge ungültig, die das Modul vorher gelesen haben (Start, Doctor, Inspect,
   Speichern), sowie eine offene Update-Vorschau; diese muss neu erstellt werden.
5. **Mitgelieferte Module** aktualisieren sich mit dem HAPI-Release (Richtlinie
   `release`); sie brauchen keine Übernahme.

| Zustand | Bedeutung |
|---|---|
| `none` | Kein Modul aktiv. |
| `ready` | Modul installiert, aktiviert und mit dem installierten Digest übernommen. Nur hier gibt es Inhalt, Aufgaben und Prüfungen. |
| `adoption_required` | Eine neue Fassung ist installiert; ein Projektadmin muss sie übernehmen. |
| `disabled` | Das Plugin ist deaktiviert. |
| `missing` | Das Plugin ist deinstalliert. |
| `unsupported` | Das Modul verlangt einen Provider oder eine Provider-Version, die dieses HAPI nicht kennt. Installierbar, aber nicht aktivierbar. |
| `invalid` | Die gespeicherte Plugin-Definition ist nicht mehr lesbar. |

## Aufbau einer Moduldefinition

Ein Plugin enthält in `developmentModules` bis zu vier Definitionen. Ein Plugin darf
ausschließlich Module enthalten.

```json
{
  "schemaVersion": 2,
  "id": "acme-flutter",
  "name": "Flutter",
  "description": "Flutter-App-Entwicklung",
  "version": "1.0.0",
  "developmentModules": [
    {
      "apiVersion": 1,
      "id": "flutter",
      "title": "Flutter",
      "summary": "Flutter/Dart-Apps",
      "contentVersion": "2026.10.18-1",
      "brief": ["Flutter-Projekte verwenden pubspec.yaml …"],
      "constraints": ["Keine iOS-Builds auf Linux-Runnern."],
      "fields": [],
      "topics": [],
      "recipes": [],
      "tasks": [],
      "doctor": { "provider": { "id": "hapi.toolchain", "version": 1 }, "checks": [{ "id": "git", "required": true }] },
      "inspect": { "provider": { "id": "hapi.repository-inventory", "version": 1 }, "directoryField": null },
      "integrations": []
    }
  ]
}
```

| Feld | Pflicht | Inhalt |
|---|---|---|
| `apiVersion` | ja | `1` |
| `id` | ja | Lokale, unveränderliche Modul-ID |
| `title`, `summary` | ja | Einzeilig ≤ 80 bzw. Text ≤ 600 Zeichen |
| `contentVersion` | ja | Inhaltsversion (siehe oben) |
| `brief` | nein | Orientierung im Kontext, ≤ 16 × 400 Zeichen |
| `constraints` | nein | Grenzen des Szenarios, ≤ 16 × 300 Zeichen |
| `fields` | nein | Einstellungsformular, siehe unten |
| `topics` | nein | Handbuch |
| `recipes` | nein | Abläufe mit Effekten und Beispielbefehlen |
| `tasks` | nein | Startbare Aufgaben für Spezialisten |
| `doctor` | nein | Provider und gewählte Prüfungen; `null` = kein Doctor |
| `inspect` | nein | Provider und optional das Feld mit dem Projektordner; `null` = keine Inspektion |
| `integrations` | nein | Live-Lesezugriffe des Hubs, Verweise oder manuelle Schritte |

Alle Texte werden auf versteckte Steuer- und Formatzeichen geprüft. Unbekannte
Eigenschaften werden überall abgelehnt.

## Feldarten

Felder bilden ein **flaches** Formular. Es gibt keine Gruppen und keine
feldübergreifenden Regeln.

| `kind` | Zusätzliche Eigenschaften | Gespeicherter Wert |
|---|---|---|
| `text` | `format` (`plain`, `identifier`, `dotted_identifier`, `version`; Standard `plain`), `maxLength` 1–500 (Standard 200), `default` Text oder `null` | Text oder `null` |
| `number` | `min`, `max` (ganze Zahlen, Betrag ≤ 10⁹), `default` Zahl oder `null` | ganze Zahl oder `null` |
| `boolean` | `default` (Standard `false`); `required` ist wirkungslos | `true`/`false` |
| `select` | `options` (1–24 × `{value, label}`), `default` Wert oder `null` | Wert oder `null` |
| `multi_select` | `options`, `maxItems` 1–24, `default` Liste | Liste von Werten |
| `text_list` | `format`, `maxItems` 1–32, `maxLength` 1–200 (Standard 100), `default` Liste | Liste von Texten |
| `repo_path` | `default` Pfad oder `null` (`.` = Repository-Stamm) | relativer Pfad ohne `..`, absolute Pfade oder versteckte Segmente |
| `branch` | `default: null` | Git-Branchname oder `null` |
| `repository` | `default: null` | numerische ID eines **bereits für das Projekt freigegebenen** Repositorys oder `null` |
| `resource` | `default: null` | Verweis auf eine vorhandene Tresor-/MCP-Ressource, nie ein Geheimnis |
| `https_url` | `default: null` | kanonische `https`-Adresse ohne Zugangsdaten, Query oder Fragment |

Gemeinsam: `id` (`^[a-z][a-zA-Z0-9_]{0,39}$`), `label` (≤ 80 Zeichen), `help`
(optional, ≤ 300), `required` (Standard `false`; Pflicht heißt: nicht `null`, Text nicht
leer, Liste mit mindestens einem Eintrag). Optionswerte folgen
`^[a-z0-9][a-z0-9_.-]{0,63}$`. Höchstens 24 Felder und 96 Optionen je Modul. Standardwerte
müssen zum Feld passen.

Der Hub prüft Werte beim Speichern mit derselben gemeinsamen Funktion wie die
Oberfläche. Unbekannte Feld-IDs werden abgelehnt; fehlende Werte nehmen den Standardwert
an. Ein `repository`-Feld kann keine Freigabe erzeugen: Ausgewählt werden nur bereits
freigegebene Repositorys, frisch beim Hub geprüft.

### Bedingungen (`when`)

Themen, Rezepte, Aufgaben und Doctor-Prüfungen können eine Bedingung
`{ "field": "<id>", "in": [ … ] }` tragen. Sie gilt, wenn der gespeicherte Wert eines
`select`-, `boolean`- oder `number`-Felds in der Liste steht. Ein nicht gesetzter Wert
(`null`) erfüllt jede Bedingung. Mehr Logik gibt es bewusst nicht.

## Handbuch (`topics`)

Ein Thema hat `id` (`^[a-z0-9][a-z0-9_.-]{0,79}$`), `title` (≤ 160), `summary` (≤ 600),
`body` (≤ 8.000 Zeichen), `tags` und **1–8 Quellen**. Eine Quelle hat `title`, eine
`https`-`url`, `verifiedAt` (`JJJJ-MM-TT`) und optional `version`. Schreibe nur
Aussagen, die du in der genannten Quelle am genannten Tag geprüft hast. Der Validator
warnt bei Prüfdaten in der Zukunft.

Agenten sehen im Kontext nur Titel und Zusammenfassungen; den Text eines Themas holen
sie gezielt mit `evolved_development_knowledge` (`topic=<id>` oder Suche `q=`).

## Rezepte (`recipes`)

| Eigenschaft | Inhalt |
|---|---|
| `kind` | `setup`, `develop`, `test`, `upgrade`, `review`, `diagnose`, `release` |
| `effects` | siehe Tabelle unten; ehrlich und vollständig angeben |
| `prerequisites` | IDs von Doctor-Prüfungen **dieses Moduls**, die vorher `ready` sein sollten |
| `steps` | 1–20 Schritte mit `title`, `detail` (≤ 1.200) und optional `argv` (1–40 Elemente ≤ 300) |
| `outputs`, `guardrails`, `sources` | erwartete Ergebnisse, Leitplanken, Quellen |

**Platzhalter in `argv`:** `{checkout}` (Checkout des gebundenen Repositorys),
`{toolchainDir}` (`<Projekt>/.hapi/.cache/toolchain`), `{artifactsDir}`
(`<Projekt>/.hapi/.cache/artifacts`) und `{<Feld-ID>}` der eigenen Felder. Jeder andere
Ausdruck in geschweiften Klammern wird abgelehnt. Platzhalter werden von HAPI nicht
ersetzt oder ausgeführt; sie zeigen der Agentensitzung, welche Werte gemeint sind.

| Effekt | Bedeutung |
|---|---|
| `reads_repository` | liest den Checkout |
| `writes_repository` | ändert Dateien im Checkout |
| `network_download` | lädt aus dem Internet |
| `installs_in_project` | installiert in den Projektordner (venv, SDK, Pakete) |
| `creates_local_database` | legt lokale (Test-)Datenbanken an |
| `runs_project_code` | führt Code des Projekts aus (Tests, Build-Skripte, Einstellungsmodule) |
| `git_push_may_deploy` | ein Push kann ein Deployment auslösen |
| `remote_cost` | kann externe Kosten oder Kontingent verbrauchen |
| `manual_handoff` | braucht einen Schritt eines Menschen |
| `requires_license_acknowledgement` | nur für mitgelieferte Module (z. B. Android-SDK); Plugins dürfen keine menschliche Zustimmung erzeugen |

## Aufgaben (`tasks`)

Eine Aufgabe startet über den bestehenden Agentenkatalog eine Sitzung mit einem
Spezialisten. Sie hat `id`, `title` (≤ 120), `description`, `kind`, `specialist`,
`recipeIds` (≤ 8), `topicIds` (≤ 12), `defaultTask` (Vorschlag für den Auftragstext,
≤ 2.000), `effects`, `requiresRepository`, `notes` und optional `when`.

- `specialist` ist `builtin:implementation`, `builtin:tests`, `builtin:review`,
  `builtin:architecture` oder die ID eines Agenten **im selben Manifest**. Bei der
  Installation wird daraus `plugin:<Plugin-UUID>:<Agent-ID>`; ein gleichnamiger Agent
  eines anderen Plugins wird nie verwendet.
- Die Effekte einer Aufgabe sind die Vereinigung ihrer eigenen und aller Effekte der
  verwendeten Rezepte. Der Host berechnet sie; ein Modul kann sie nicht verkleinern.
- `preconditions` gibt es nur für mitgelieferte Module.
- Aufgabe samt Rezepten darf höchstens 24 KiB groß sein.
- Ein Start bindet Modul-ID, Digest, Aufgaben-ID und Konfigurationsrevision. Der Hub
  prüft sie vor dem Start, nach dem Reservieren, nach dem Start des Agenten und vor der
  Auftragsübergabe erneut. Es gibt keine zusätzliche Freigabe für gewöhnliche Starts.

## Provider

Provider sind feste Implementierungen des Hosts. Ein Modul verweist mit
`{ "id": …, "version": … }` darauf.

| Provider | Version | Art | für Plugins | Runner-Fähigkeit |
|---|---|---|---|---|
| `hapi.toolchain` | 1 | Doctor | ja | `evolvedDevelopment.provider.hapi.toolchain.v1` |
| `hapi.repository-inventory` | 1 | Inspect | ja | `evolvedDevelopment.provider.hapi.repository-inventory.v1` |
| `github.commit-status` | 1 | Integration (Hub, über die Projektfreigabe) | ja | – |
| `builtin.odoo`, `builtin.ios`, `builtin.android` | 1 | Doctor und Inspect | nein | `evolved-development` |

Unbekannte Provider-IDs oder -Versionen machen ein Modul `unsupported` (installierbar,
nicht aktivierbar). Ein Runner ohne die passende Fähigkeit meldet `upgrade_required`;
es gibt nie ein leeres grünes Ergebnis.

### `hapi.toolchain` v1

Prüfungen ohne Einstellungen: Vorhandensein und Version. Programme werden nur in
root-eigenen, nicht beschreibbaren Systemverzeichnissen (`/usr/local/bin`, `/usr/bin`,
`/bin`, `/usr/local/sbin`, `/usr/sbin`, `/sbin`) gesucht, nie in `PATH`, im Projekt oder
im Home-Verzeichnis. Sie laufen mit genau diesen Argumenten, leerer Umgebung
(`PATH=/usr/bin:/bin`, `LANG=C`, `HOME=/nonexistent`), Arbeitsverzeichnis `/`, 4 Sekunden
je Prüfung, 20 Sekunden insgesamt und höchstens 16 KiB Ausgabe.

| Prüfung | Kategorie | Vorgehen |
|---|---|---|
| `image.marker` | image | liest `/etc/hapi-runner-image` (nur Hinweis) |
| `repository.checkout` | project | liest `.git/HEAD` und die Referenz im gebundenen Checkout, ohne Git auszuführen |
| `git` | toolchain | `git --version` |
| `python` | toolchain | `python3 --version` (System-Python; Projekt-venvs werden nicht geprüft) |
| `node` | toolchain | `node --version` (Projektabhängigkeiten werden nicht geprüft) |
| `java` | toolchain | `java -Xmx64m -XX:+UseSerialGC -version`; `javac` wird nur gesucht, nicht ausgeführt (fehlt es: `warning`) |
| `ssh` | integration | `ssh -V`; es wird keine Verbindung aufgebaut |
| `kvm` | device | prüft, ob `/dev/kvm` ein zugängliches Gerät ist |

Unbekannte Prüf-IDs ergeben `unknown`. Ergebnisse: `ready`, `missing`, `unsupported`,
`unknown`, `warning`; nur `ready` ist ein Nachweis.

### `hapi.repository-inventory` v1

Statische, begrenzte Übersicht des gebundenen Checkouts. Der Projektordner ist der Wert
des `repo_path`-Felds aus `inspect.directoryField` (sonst der Repository-Stamm).

- Bekannte Projektdateien **direkt im Projektordner**, nur ihr Vorhandensein (nicht
  gelesen): `package.json`, Lockdateien von npm/pnpm/yarn/bun, `pyproject.toml`,
  `requirements.txt`, `setup.py`, `setup.cfg`, `Pipfile`, `uv.lock`, `poetry.lock`,
  `manage.py`, `Gemfile`, `go.mod`, `Cargo.toml`, `composer.json`, `pom.xml`,
  `build.gradle(.kts)`, `settings.gradle(.kts)`, `Package.swift`, `pubspec.yaml`,
  `mix.exs`, `CMakeLists.txt`, `Makefile`, `Dockerfile`, `compose.yaml`,
  `docker-compose.yml`. Ergebnis: `buildFiles` mit `kind: "other"` und den Fakten
  `projectFile` und `ecosystem`.
- Dateizahlen nach Endung unterhalb des Projektordners (Tiefe ≤ 6, ≤ 5.000 Dateien, die
  acht häufigsten Endungen). Nicht durchsucht werden `node_modules`, virtuelle
  Umgebungen, Build-, Cache- und Werkzeugordner sowie `.hapi`.
- GitHub-Actions-Workflows (Name, Runner) und HEAD/Branch aus den Git-Dateien.
- Symbolische Verknüpfungen, Sonderdateien (FIFO, Geräte) und geschützte Pfade (`.git`,
  `.env*`, Schlüssel, `secret`, `credential` …) werden weder gelesen noch gezählt.
  Dateien mit mehreren harten Verknüpfungen erscheinen in Verzeichnislisten als normale
  Dateien und zählen deshalb als Metadaten mit (Projektdatei vorhanden, Dateizahl); ihr
  Inhalt wird nie gelesen – ein so verknüpfter Workflow erscheint ohne Name und Runner.
  Es werden keine Dateiinhalte zurückgegeben und kein Projektcode ausgeführt. Ein unsicherer Projektordner (Pfad mit
  `..`, absolut, Verknüpfung) wird abgelehnt bzw. als Warnung gemeldet.

### Integrationen

`kind: "live_read"` braucht `provider: "github.commit-status"` (kombinierter
Commit-Status des gebundenen Repositorys über die bestehende Projektfreigabe).
`reference` und `manual` haben keinen Provider und zeigen ihre `links`
(kanonische `https`-Adressen) und Quellen.

## Mitgelieferte Werkzeuge und Projektabhängigkeiten

Auseinanderhalten:

- **Werkzeuge des Runners** (Git, System-Python, Node, JDK, SSH) bringt das
  Runner-Image mit. Der Doctor prüft nur sie. Fehlen sie, ist das eine Sache des
  Betreibers (Development-Image), nicht des Moduls.
- **Abhängigkeiten des Projekts** (venv, `node_modules`, Gradle-Abhängigkeiten,
  Framework-Version) installiert ausschließlich eine **ausdrücklich gestartete
  Aufgabe**, deren Rezept die Effekte `network_download` und `installs_in_project`
  nennt. Sie landen im Projektordner (`.hapi/.cache/toolchain/…`), nie global. Die
  Aktivierung eines Moduls installiert nichts.

## Grenzen

| Grenze | Wert |
|---|---|
| Manifestgröße | 512 KiB |
| Module je Plugin | 4 |
| Felder / Optionen je Feld / Optionen je Modul | 24 / 24 / 96 |
| Themen / Rezepte / Aufgaben / Integrationen | 64 / 32 / 24 / 12 |
| Doctor-Prüfungen je Modul | 32 |
| Aufgabe samt Rezepten | 24 KiB |
| Standardwerte bzw. gespeicherte Werte eines Moduls (JSON) | je 8 KiB |
| Modul-Einstellungen je Projekt (aktive und inaktive) | 16 Einträge, zusammen höchstens 28 KiB (unter der 32-KiB-Anfragegrenze, damit Lesen und Zurückschreiben immer passt) |
| Aufgabe mit plugin-eigenem Spezialisten | Spezialist + Skills + Aufgabe/Rezepte + 8 KiB Werte + 8 KiB Reserve für den Auftragstext ≤ 64 KiB Gesamtauftrag |
| Katalogeinträge im Hub | 256 |

## Was Agenten sehen

Claude- und Codex-Sitzungen erfahren über den Betriebskontext (ab Version 8) und das
Thema `development` von Modulen. Sie verwenden dieselben fünf Werkzeuge wie für die
mitgelieferten Module:

| Werkzeug | Hub-Route (Vertrag 2) |
|---|---|
| `evolved_development_context` | `GET …/development/modules-context` |
| `evolved_development_knowledge` | `GET …/development/modules-knowledge` |
| `evolved_development_doctor` | `GET modules-context`, dann `POST …/development/modules-doctor` mit `{moduleId, moduleDigest}` |
| `evolved_development_inspect` | ebenso mit `POST …/development/modules-inspect` |
| `evolved_development_build_status` | `GET …/development/build-status` mit ausdrücklich gewähltem `ref` oder Odoo.sh-`environment` (`staging` / `production`) |

Der Runner-Proxy lässt genau diese Routen zu (Body der Aktionen höchstens 256 Byte,
exakt `{moduleId, moduleDigest}`). Konfiguration, Übernahme, Moduldetails und der
Katalog bleiben dem Browser vorbehalten. Gegen einen Hub ohne Vertrag 2 fallen die
Werkzeuge auf die älteren Modusrouten zurück; ein älterer Runner gegen ein aktives
Plugin-Modul erhält `development_client_upgrade_required`.

## Ein neues Szenario ergänzen – Schritt für Schritt

1. **Abgrenzen.** Was soll ein Agent im Projekt tun können (einrichten, testen,
   prüfen, reviewen)? Was ausdrücklich nicht (Deployment, Produktionsdaten)?
2. **Felder festlegen.** Nur Werte, die Aufgaben wirklich brauchen: Projektordner
   (`repo_path`), Versionsreihe (`select`), Bezeichner (`text` mit `format`), Listen.
3. **Handbuch schreiben.** Je Thema eine klar begrenzte Aussage mit Primärquelle und
   Prüfdatum. Versionsabhängiges mit `when` an ein `select`-Feld hängen. Die im Projekt
   festgelegte Version hat immer Vorrang; das ins `brief` schreiben.
4. **Rezepte formulieren.** Schritte mit Beispiel-`argv`, nur erlaubte Platzhalter,
   Effekte vollständig, Leitplanken (kein `sudo`, nichts löschen, keine
   Produktionsdatenbank).
5. **Aufgaben anlegen.** Je Aufgabe ein passender Spezialist (`builtin:*` oder ein
   eigener Agent im selben Manifest), Rezepte und Themen verknüpfen, einen klaren
   `defaultTask` vorschlagen.
6. **Prüfungen wählen.** `doctor` mit `hapi.toolchain` v1 und den nötigen Prüf-IDs
   (Rezept-`prerequisites` müssen darunter sein); `inspect` mit
   `hapi.repository-inventory` v1 und `directoryField`.
7. **Lokal validieren** (siehe unten), Fehler mit Pfadangabe beheben.
8. **Veröffentlichen.** Die Datei als `hapi-evolved.plugin.json` in den
   **Stamm eines öffentlichen GitHub-Repositorys** legen. Ein Unterordner wie
   `examples/plugins/django/` in diesem Repository wird vom Installer nicht gefunden.
9. **Installieren und aktivieren.** Vorschau prüfen (Digest vergleichen),
   installieren, in einem Testprojekt aktivieren, Doctor und Inspect starten, eine
   Aufgabe starten.
10. **Pflegen.** Jede Inhaltsänderung verlangt in jedem Projekt eine Übernahme.
    `contentVersion` und Plugin-`version` erhöhen; die lokale `id` nie ändern.

Braucht ein Szenario eine Prüfung, die kein Provider kennt (etwa eine bestimmte
Framework-Version im Projekt), gehört das in ein Rezept einer ausdrücklichen Aufgabe,
nicht in den Doctor. Neue Provider sind Änderungen an HAPI selbst (Host-Code mit
festen Programmen und Tests), nie Inhalte eines Plugins.

## Testen

```sh
# Manifest prüfen: gleiche Schemaprüfung wie der Installer, Pfade zu Fehlern,
# Digest je Modul, Hinweise (Dateiname, Prüfdaten in der Zukunft, nicht unterstützte Provider)
hapi evolved plugin validate ./mein-plugin

# Doctor der Moduldefinition lokal (hapi.toolchain-Prüfungen des Moduls, Feldstandards für "when")
hapi evolved development doctor --local --definition ./mein-plugin [--module <id>] [--checkout <repo>]

# Inventar eines lokalen Checkouts (Projektordner aus --subdirectory oder dem Feldstandard)
hapi evolved development inspect --local --definition ./mein-plugin --checkout ./mein-repo [--subdirectory app]
```

Alle drei Befehle arbeiten offline: Sie laden nichts nach, installieren nichts und
führen keinen Projektcode aus. `validate` endet bei einem ungültigen Manifest mit
Exit-Code 1. Außerhalb eines Runners lässt sich die CLI aus dem Quellbaum starten
(`bun run cli/src/index.ts evolved plugin validate …`).

Danach in einer Testinstallation: Vorschau (Digest muss dem lokalen entsprechen),
Installation, Aktivierung in einem Testprojekt mit freigegebenem Repository, Doctor,
Inspect und je Aufgabe ein Start. Ein Plugin-Update testen: Projekt zeigt
`adoption_required`, nach der Übernahme wieder `ready`.

## Aktuelle Einschränkungen

- Nur **öffentliche** GitHub-Repositorys; private Quellen unterstützt der Installer
  nicht.
- Ein aktives Modul je Projekt; keine Feldgruppen oder feldübergreifenden Regeln.
- Keine eigenen Provider, keine Vorlagen in Links, keine Ausführung von Rezepten durch
  HAPI.
- Ältere Fassungen eines Plugin-Moduls werden nicht aufbewahrt: Ein Projekt im Zustand
  `adoption_required` kann die vorher übernommene Fassung nicht mehr ausführen.
- Ältere Hub-Versionen lesen Projektkonfigurationen mit Plugin-Modul als ungültig
  (ausdrücklicher Fehler, kein stilles `none`); reine Builtin-Konfigurationen bleiben
  für sie lesbar.

## Beispiel: Django

[`examples/plugins/django/hapi-evolved.plugin.json`](https://github.com/BGGBTAC/hapi-evolved/blob/main/examples/plugins/django/hapi-evolved.plugin.json)
enthält ein Modul mit fünf Feldern (Projektordner, Django-Reihe, Einstellungsmodul,
Test-Labels, `--keepdb`), sechs Handbuchthemen mit Primärquellen (geprüft am
2026-10-18), vier Rezepten (venv, Tests, Migrationsprüfung, Systemprüfung), vier
Aufgaben (davon eine mit dem plugin-eigenen Spezialisten `django-reviewer`), Doctor über
`hapi.toolchain` v1, Inspect über `hapi.repository-inventory` v1 und zwei Integrationen.
Zum Ausprobieren die Datei in den Stamm eines eigenen öffentlichen Repositorys kopieren
und dieses installieren; siehe [Beispiel-README](https://github.com/BGGBTAC/hapi-evolved/blob/main/examples/plugins/django/README.md).
