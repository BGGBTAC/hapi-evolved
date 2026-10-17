# Development-Modi: Image und Rezepte

Dieses Verzeichnis gehört zum optionalen Development-Runner-Image
(`deploy/evolved/Runner.development.Dockerfile`). Es enthält `hapi-dev`, die geprüften
Einrichtungs- und Testhelfer, auf die die Rezepte der Entwicklungsmodi verweisen.
Nutzerdoku mit Abläufen und Grenzen: [docs/evolved/DEVELOPMENT_MODES.md](../../../docs/evolved/DEVELOPMENT_MODES.md).

## Grundsätze

- `hapi-dev` läuft nur, wenn eine Agentensitzung oder ein Mensch es ausdrücklich aufruft.
  Aktivierung eines Modus, Doctor und Statusabfragen führen es nie aus.
- Alles landet im Projektordner: Werkzeuge unter `<projekt>/.hapi/.cache/toolchain`, Logs und
  Artefakte mit `SHA256SUMS` unter `<projekt>/.hapi/.cache/artifacts/<art>/<UTC-Zeit>/`.
  Das Root-Dateisystem des Runners bleibt schreibgeschützt.
- Vorhandene Ordner werden wiederverwendet, nie ersetzt, zurückgesetzt oder gelöscht.
  Die einzige Löschaktion ist `db drop <slug> --confirm hapi_test_<slug>` für eine
  Wegwerf-Datenbank des Projekt-Clusters.
- Jedes Programm startet mit festem argv ohne Shell und minimaler Umgebung; Modulnamen,
  Datenbank-Slugs, Gradle-Module/Varianten, Versionen und Pfade werden vorher geprüft.
  Jeder Befehl nennt vor der Ausführung seine Effekte. `--dry-run` zeigt nur den Plan.
- Keine Zugangsdaten im Image, in Logs oder in Artefakten. Downloads sind fest
  hinterlegt und werden geprüft (Prüfsumme bzw. PGP-Signatur), wo der Anbieter das anbietet.

## Befehle

```text
hapi-dev [--project-root <dir>] [--dry-run] <befehl>
  paths
  odoo source --major 19|20            öffentliches odoo/odoo, Branch <major>.0, Tiefe 1; Commit → source.json
  odoo venv --major 19|20              venv neben dem Quellcode, pip install -r requirements.txt (nur ins venv)
  odoo test --major N --repository <checkout> --modules a,b [--addons addons] [--db-slug dev] [--http-port 8069]
  odoo upgrade-dry-run --repository <checkout> [--addons …] [--from 19.0 --to 20.0]
  postgres init|start|stop|status      Projekt-Cluster, nur Unix-Socket, TCP aus
  db list | db drop <slug> --confirm hapi_test_<slug>
  android sdk bootstrap|licenses|install --compile-sdk 35 [--build-tools 35.0.0] [--platform-tools] [--emulator]
  android gradle unit-test|lint|assemble --project <checkout>/<dir> [--module :app] [--variant debug]
  android cli install
  swift install [--version 6.4.1]
  swift test --package <dir>
```

Im Development-Image liegt das Programm unter `/app/deploy/evolved/development/bin/hapi-dev` und ist als `/usr/local/bin/hapi-dev` verlinkt. Im Basis-Image fehlt es; die Rezepte setzen das Development-Image voraus.
Außerhalb des Images: `bun deploy/evolved/development/hapi-dev.ts …` mit `--project-root`.

## Feste Downloads (Stand 2026-10-17)

| Werkzeug | Quelle | Prüfung |
|---|---|---|
| Android cmdline-tools | `https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip` | SHA-256 `4e4c464f…edf583` von developer.android.com/studio |
| Offizielle Android CLI | `https://dl.google.com/android/cli/latest/linux_x86_64/android` | Google veröffentlicht keine Prüfsumme; die SHA-256 der geladenen Datei wird in `install.json` festgehalten |
| Swift-Toolchain | `https://download.swift.org/swift-<v>-release/<platform>/…tar.gz` + `.sig` | PGP-Signatur gegen `https://www.swift.org/keys/all-keys.asc` |
| Odoo Community | `https://github.com/odoo/odoo.git`, Branch `19.0`/`20.0` | Commit wird in `source.json` protokolliert |

Neue Versionen werden durch eine geprüfte Änderung an `hapi-dev.ts` aktualisiert, nicht zur Laufzeit.

## Android-SDK-Lizenzen

1. Ein Projektadmin bestätigt in HAPI (Entwicklung → Android) die Lizenzprüfung. Nur diese
   menschliche Einstellung zählt im verwalteten Runner; Agenten können sie nicht setzen.
2. `hapi-dev android sdk bootstrap` lädt die cmdline-tools in das Projekt-SDK.
3. `hapi-dev android sdk licenses` läuft nur in einem interaktiven Terminal; der Mensch liest
   und beantwortet jede Lizenz selbst. In einer Agentensitzung (kein TTY) wird abgebrochen.
4. `hapi-dev android sdk install …` installiert Pakete mit geschlossener Standardeingabe:
   eine neue, noch nicht angenommene Lizenz führt zum Abbruch statt zur stillen Annahme.

## Image bauen (Betreiber)

```sh
# im geprüften Quellbaum, nachdem hapi-evolved:0.1.0 aus derselben Revision gebaut wurde
docker build -f deploy/evolved/Runner.development.Dockerfile -t hapi-evolved-runner-development:0.1.0 .
```

`Runner.Dockerfile` bleibt das Basis-Image und wird nicht verändert.

Voraussetzung ist das lokal gebaute Core-Image `hapi-evolved:0.1.0` derselben Revision.
runner-control startet Projektrunner mit dem festen Tag `hapi-evolved-runner:0.1.0`; es gibt
keine Projekt- oder Laufzeit-Auswahl des Images. Wer das Development-Image für alle
Projektrunner verwenden will, baut es bewusst unter diesem Tag (siehe Nutzerdoku). Nicht im
Image: Docker, Android-SDK-Pakete, Swift, Odoo-Quellen, Chromium, wkhtmltopdf.

## Tests

```sh
bun test deploy/evolved/development/hapi-dev.test.ts
```
