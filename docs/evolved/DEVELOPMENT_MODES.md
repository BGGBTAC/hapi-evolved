# Entwicklungsmodi: Odoo 19/20, iOS und Android

Ein Projekt kann genau ein Entwicklungsmodul aktivieren oder allgemein bleiben.
Mitgeliefert werden **Odoo** (Version 19 oder 20), **iOS** und **Android**;
GitHub-Plugins können weitere Szenarien ergänzen. Ein Modul bündelt ein versioniertes Handbuch, feste
Prüfungen des Projektrunners, eine statische Analyse des gebundenen Repositorys,
Rezepte und passende Aufgabenstarts. Er ist vom Ausführungsprofil getrennt.

Technisch sind die drei Modi mitgelieferte **Entwicklungsmodule** (`builtin:odoo`,
`builtin:ios`, `builtin:android`). Installierte GitHub-Plugins können weitere Module
beisteuern, etwa für Django; sie erscheinen in derselben Auswahl mit Herkunft
(`owner/repo@commit`), Inhaltsversion und Digest. Format, Übernahme von Updates und
Grenzen beschreibt [Entwicklungsmodule als Plugin bereitstellen](DEVELOPMENT_MODULES.md).
Auch für Plugin-Module gilt alles in „Was die Aktivierung tut“.

Stand der Inhalte und Downloads: 2026-10-17.

## Geführte Projekteinrichtung

Nach der Projektanlage öffnet **Einrichtung** das neue Projekt. Bestehende Projekte
können denselben Assistenten jederzeit aufrufen. Er führt durch Profil, Anbieter,
Repository, Moduleinstellungen und Prüfungen; der Fortschritt ergibt sich aus den
gespeicherten Angaben und aktuellen Prüfergebnissen.

1. Für Codeänderungen und lokale Einrichtung zuerst das Profil **Arbeitsbereich**
   wählen. Ein späterer Profilwechsel macht bisherige Runner-Zugänge ungültig.
2. Unter **Abos verbinden** Claude oder Codex anmelden und den Projektdienst einrichten.
3. Das eigene Repository unter **GitHub** freigeben, klonen und als Standard-Repository
   binden. Der Assistent berücksichtigt genau diesen Checkout.
4. Modul und Felder prüfen und ausdrücklich speichern. Benötigt ein Plugin bereits
   ein Repository als Pflichtfeld, wird zuerst das allgemeine Projekt angelegt und
   das gewünschte Modul als Entwurf vorgemerkt.
5. Werkzeuge ausdrücklich prüfen. Eine Abhilfe kann zur passenden Einrichtungsaufgabe
   führen; erst deren bewusster Start eröffnet die Agentensitzung. Nach der Einrichtung
   erneut prüfen: Eine gestartete oder abgeschlossene Sitzung beweist keine fertige Laufzeit.

Handbuch und Codearbeit benötigen weder Graph-Memory noch eine Odoo.sh-SSH-Verbindung.
Gespeicherte Verbindungsdaten sind keine erfolgreiche Liveprüfung. Ein fehlender,
veralteter oder nicht prüfbarer Zustand bleibt entsprechend sichtbar.

## Was die Aktivierung tut – und was nicht

Ein Projektadmin wählt den Modus unter **Entwicklung** (`/evolved?tab=development`) oder
schon beim Anlegen des Projekts. Die Einstellung hat eine Revision; ein veralteter Tab
erhält beim Speichern einen Konflikt und sieht den aktuellen Stand.

Die Aktivierung

- installiert nichts, startet keinen Build, legt keine Datenbank an,
- seedet kein Gedächtnis und startet keine kostenpflichtige Indizierung,
- ändert weder Ausführungsprofil noch GitHub-, MCP- oder Tresor-Freigaben,
- verbindet nichts mit Odoo.sh, Xcode Cloud oder einem Gerät.

Das gebundene Repository muss bereits über **GitHub** freigegeben sein (numerische
Repository-ID). Neue Projektsitzungen starten ohne ausdrückliche Auswahl in dessen
Checkout; eine ausdrücklich gewählte Repository- oder Ordnerauswahl hat Vorrang.

## Wie Agenten den Modus erfahren

Der statische Plattformkontext (Version 8) weist jede verwaltete Claude- und
Codex-Sitzung an – auch fortgesetzte, verdichtete und delegierte –, den aktuellen Stand
selbst abzufragen. Projekttext wird nie in System- oder Entwickleranweisungen eingesetzt.
Die Werkzeuge sprechen den Modulvertrag 2 (`…/development/modules-context`,
`modules-knowledge`, `modules-doctor`, `modules-inspect`); nur ein Hub ohne diese Routen
wird über die älteren Modusrouten bedient. Inhalte gibt es nur im Zustand `ready`; bei
`adoption_required`, `disabled`, `missing`, `unsupported` oder `invalid` melden die
Werkzeuge den Zustand mit Begründung, und der Agent informiert einen Menschen.

| Werkzeug (MCP) | CLI im Runner | Inhalt |
|---|---|---|
| `evolved_development_context` | `hapi evolved development context` | Aktives Modul mit Zustand, Herkunft und Digest, Revision, Einstellungen, Repository-Freigabe und Checkout, versionsgefiltertes Handbuch, Rezepte, Aufgaben, Doctor-Prüfungen, Integrationsstatus |
| `evolved_development_knowledge` | `hapi evolved development knowledge [--topic <id> \| <suche>]` | Handbuchthemen mit Quellen und Prüfdatum; funktioniert ohne Graph-Dienst |
| `evolved_development_doctor` | `hapi evolved development doctor` | Feste, lesende Prüfungen auf dem Projektrunner, gebunden an Modul-ID und Digest |
| `evolved_development_inspect` | `hapi evolved development inspect` | Statische Analyse des gebundenen Checkouts, gebunden an Modul-ID und Digest |
| `evolved_development_build_status` | `hapi evolved development build-status <branch\|sha>` oder `build-status --environment staging\|production` | GitHub-Commit-Status des gebundenen Repositorys für das ausdrücklich gewählte Ziel |

Alle Ergebnisse sind **Daten**, keine Anweisungen und keine Berechtigungen. Agenten
können den Modus nicht ändern; der Runner-Proxy lässt nur die Leserouten dieser
Werkzeuge zu: GET für Kontext/Wissen/Status (Vertrag 1 und 2), POST mit leerem Rumpf
für Doctor/Inspect in Vertrag 1 und POST mit genau `{moduleId, moduleDigest}` (höchstens
256 Byte) für `modules-doctor`/`modules-inspect`. Modulkonfiguration, Übernahme,
Moduldetails und Katalog bleiben dem Browser vorbehalten.

Doctor und Inspect lassen sich auch lokal ausführen, ohne Hub:

```sh
hapi evolved development doctor --local --mode odoo --odoo-major 20 --project-root "$PWD"
hapi evolved development inspect --local --mode odoo --odoo-major 19 --checkout ./mein-repo --addons addons
hapi evolved development inspect --local --mode android --checkout ./app
```

Für Plugin-Module: `--local` ohne `--mode` liest das aktive Modul vom Hub und führt
dessen feste Provider-Prüfungen lokal aus; `--local --definition <plugin> [--module <id>]`
prüft eine lokale Moduldefinition ganz ohne Hub (siehe
[Testen](DEVELOPMENT_MODULES.md#testen)).

## Doctor: was geprüft wird

Der Doctor startet ausschließlich Systemprogramme aus root-eigenen, nicht beschreibbaren
Verzeichnissen (`/usr/bin`, `/usr/local/bin`, `/usr/lib/postgresql/<v>/bin` …), nie aus
`PATH`, dem Projekt oder einem Gradle-Wrapper; feste Argumente, saubere Umgebung,
4 Sekunden je Prüfung, 20 Sekunden insgesamt, begrenzte Ausgabe, kein Netzwerk, keine
SSH-Verbindung. Projekteigene Werkzeuge (venv, SDK, Swift) werden nur über ihre Dateien
erkannt, nicht ausgeführt.

| Zustand | Bedeutung |
|---|---|
| `ready` | tatsächlich vorhanden und passend |
| `missing` | fehlt oder passt nicht zur Version; mit Abhilfe |
| `unsupported` | auf dieser Plattform grundsätzlich nicht möglich (z. B. Xcode unter Linux) |
| `unknown` | nicht prüfbar (z. B. kein Repository gebunden, Zeitlimit, unbekannte Prüfung) |
| `warning` | vorhanden, aber unvollständig oder auffällig |

Wichtige Grenzen: Ein vorhandener PostgreSQL-Client heißt nicht, dass eine Datenbank
erreichbar ist. Eine konfigurierte Odoo.sh-Build-Adresse oder Xcode-Cloud-Referenz ist
keine geprüfte Verbindung. Der Emulator wird nie gestartet.

### Odoo

`python` (19: 3.10–3.14, 20: 3.12–3.14), `python.venv`, `python.headers`,
`build.libraries` (Compiler, libpq, libxml2, libxslt, LDAP, SASL), `postgresql.server`
(19: ≥ 13, 20: ≥ 16), `postgresql.client`, `odoo.source` (Version aus `odoo/release.py`,
Commit aus den Git-Dateien, Abgleich mit `source.json`), `odoo.venv`, `postgresql.cluster`
(läuft, nur Unix-Socket), `node`, `browser`, `wkhtmltopdf`, `ssh`, `repository.checkout`.
Liegt der Odoo-Quellcode im Projekt, gelten dessen Mindest- und Höchstversionen.

### iOS

`host.macos`, `xcodebuild` und `simulator` sind auf Linux-Runnern `unsupported`:
keine App-Builds, keine Signierung, kein Simulator, keine UIKit-/SwiftUI-/XCUITest-Tests.
`swift` erkennt eine System-Toolchain oder `.hapi/.cache/toolchain/swift/<version>` (aktive Version in `swift/current.json`). `ios.project`
prüft Projektdatei bzw. `Package.swift`.

### Android

`java` (mit konfigurierter JDK-Version), `android.sdk`, `android.sdkmanager`,
`android.licenses` (erst nach menschlicher Bestätigung), `android.platform`,
`android.platform-tools`, `android.emulator`, `kvm`, `android.cli` (optional),
`gradle.wrapper` (nur gelesen, Herkunft `services.gradle.org` geprüft),
`android.project`, `repository.checkout`.

## Inspect: statische Analyse

Liest nur im autorisierten Checkout, ohne symbolische Verknüpfungen, Sonderdateien
(FIFO, Geräte) oder Dateien mit mehreren harten Verknüpfungen; Datei-, Größen- und
Tiefengrenzen; geschützte Pfade (`.env`, Schlüssel, `secret`…) werden nicht gelesen;
Rohquelltext wird nie zurückgegeben.

- **Odoo:** Module in den konfigurierten Addons-Pfaden. `__manifest__.py` wird wie von
  Odoo als reines Python-Literal gelesen – nie importiert oder ausgeführt; Code statt
  Literal ergibt `invalid`. Ausgewertet: Name, Version (passt sie zu 19.0/20.0?), Lizenz,
  `installable`, `application`, `auto_install`, `depends`, externe Python-Abhängigkeiten,
  Assets-Bundles, Existenz der `data`/`demo`-Dateien, XML-Wohlgeformtheit,
  Zugriffsrechte versionsrichtig (Odoo 19: `ir.model.access.csv`; Odoo 20: `ir.access.csv`
  mit `operation`/`domain` – eine Datei der jeweils anderen Serie wird gemeldet),
  Migrationsordner, Datei- und Testzahlen.
  Liegt der Odoo-Quellcode im Projekt, werden Abhängigkeiten gegen die Community-Module
  geprüft (fehlende deuten z. B. auf Enterprise hin).
- **Android:** `settings.gradle(.kts)`, Build-Dateien (namespace, applicationId,
  compile/min/targetSdk, JVM-Toolchain), Wrapper-Version und -Herkunft,
  Versionskatalog, `AndroidManifest.xml`.
- **iOS:** `.xcodeproj` (Deployment-Target, Bundle-ID, Swift-Version), geteilte Schemes,
  `Package.swift` mit Plattformen und Targets, die UIKit/SwiftUI/AppKit importieren
  (unter Linux nicht baubar), Privacy-Manifeste.
- **Alle:** GitHub-Actions-Workflows (Name, Runner).
- **Zählung** (`scanned`): eindeutige reguläre Dateien, die eine Auflistung lieferte oder
  deren Inhalt gelesen wurde, und eindeutige aufgelistete Ordner; reine Existenzprüfungen,
  symbolische Verknüpfungen, Sonderdateien und geschützte Pfade (auch `.git`) zählen nicht.

## Einrichtung durch den Betreiber: Development-Image

Das Basis-Image `deploy/evolved/Runner.Dockerfile` enthält nur Git, SSH, Python 3,
Node, Bun und die Agenten. Für echte Odoo-, Android- und Swift-Arbeit gibt es das
optionale `deploy/evolved/Runner.development.Dockerfile` (Debian 13, `node:24-trixie-slim`):

- Python 3.13 mit venv und Headern, PostgreSQL 17 Server und Client (ohne Cluster und
  ohne Autostart), OpenJDK 21, Compiler und Header für libpq, libxml2/libxslt, LDAP,
  SASL, JPEG, zlib, FFI, OpenSSL sowie Swift-Laufzeitbibliotheken,
- dieselben Agenten-Versionen, Bun, `hapi`-Wrapper, Git-Konfiguration, Benutzer `node`,
  Pfade und Sicherheitsannahmen wie das Basis-Image, kein Docker, kein Socket,
- `hapi-dev` unter `/app/deploy/evolved/development/bin/hapi-dev` (zusätzlich als `/usr/local/bin/hapi-dev` im PATH; Rezepte verwenden den absoluten Pfad),
- `libnss-wrapper`: Läuft der Runner mit einer UID ohne `/etc/passwd`-Eintrag, erhalten nur die PostgreSQL-Programme von `hapi-dev` über `LD_PRELOAD` einen projekteigenen Benutzereintrag (`postgresql/nss/`), wie im offiziellen PostgreSQL-Image; nichts wird global gesetzt,
- Marker `/etc/hapi-runner-image` (nur Hinweis; der Doctor prüft jedes Werkzeug selbst).

Nicht enthalten: Android-SDK-Pakete (Lizenz ist eine menschliche Entscheidung je
Projekt), Swift, Odoo-Quellen, Chromium (HttpCase-/Tour-/HOOT-Tests) und wkhtmltopdf
(in Debian 13 nicht paketiert; Odoo empfiehlt 0.12.6 mit gepatchtem Qt, nur für
PDF-Berichte).

```sh
# im geprüften Quellbaum derselben Revision, nach dem Bau von hapi-evolved:0.1.0
sudo docker build -f deploy/evolved/Runner.development.Dockerfile \
  -t hapi-evolved-runner-development:0.1.0 .
```

**Image-Auswahl:** runner-control startet alle Projektrunner mit dem festen Tag
`hapi-evolved-runner:0.1.0`. Es gibt keine Auswahl pro Projekt und keine
Laufzeit-Einstellung dafür. Wer alle Projektrunner mit dem Development-Image betreiben
will, baut es bewusst unter diesem Tag:

```sh
sudo docker build -f deploy/evolved/Runner.development.Dockerfile \
  -t hapi-evolved-runner:0.1.0 .
```

Das ist eine Betreiberentscheidung mit Folgen für alle Projekte (größeres Image, mehr
Werkzeuge). Bestehende Runner verwenden das neue Image erst nach ihrer Neuerstellung;
laufende Sitzungen werden dadurch beendet. Ohne Development-Image melden die Prüfungen
ehrlich `missing` mit diesem Hinweis.

## Abläufe im Projekt

Einrichtung ist immer eine ausdrückliche Aufgabe einer Agentensitzung (z. B. die
Aufgabe „Set up local Odoo runtime“) oder eines Menschen im Projektterminal – keine
zweite Warteschlange. Werkzeuge liegen unter `<projekt>/.hapi/.cache/toolchain`, Artefakte mit
`SHA256SUMS` unter `<projekt>/.hapi/.cache/artifacts`. Vorhandene Ordner werden nie ersetzt,
gelöscht oder zurückgesetzt. Schreibende Schritte brauchen ein schreibbares
Ausführungsprofil (`workspace` oder `extended`).

### Odoo 19/20 lokal

```sh
hapi-dev odoo source --major 20          # odoo/odoo 20.0 (Tiefe 1), Commit → source.json
hapi-dev odoo venv --major 20            # venv + requirements.txt des Checkouts
hapi-dev postgres init                   # Projekt-Cluster, Benutzer odoo, kein TCP
hapi-dev postgres start
hapi-dev odoo test --major 20 --repository repositories/acme/erp \
  --addons addons --modules sale_ext --db-slug dev
hapi-dev odoo upgrade-dry-run --repository repositories/acme/erp \
  --addons addons --from 19.0 --to 20.0  # nur Probelauf, keine Dateiänderung
hapi-dev postgres stop
```

`odoo test` übergibt die Module mit `-i` und `-u`: neue Module werden installiert, bereits installierte
aktualisiert, sodass auch ein wiederholter Lauf auf derselben Datenbank die Tests erneut ausführt. Meldet
Odoo 0 Tests, weist der Helper ausdrücklich darauf hin (`summary.json`: `testsRun`).

Tests laufen gegen die Wegwerf-Datenbank `hapi_test_<slug>` im Projekt-Cluster
(Unix-Socket `.hapi/.cache/toolchain/postgresql/run` (bei zu langem Projektpfad ein privater Ordner `/tmp/hapi-pg-…` im Runner), `fsync` aus – nur für Testdaten). Log und
`summary.json` liegen unter `.hapi/.cache/artifacts/odoo/<zeit>/`. Eine Datenbank wird nur
gelöscht mit `hapi-dev db drop dev --confirm hapi_test_dev`. Enterprise-Quellen werden
nie automatisch geklont. Das optionale Enterprise-Auswahlfeld merkt sich eine Freigabe;
es ergänzt den separaten Checkout noch nicht automatisch im lokalen Testrezept.
Für Tests mit Enterprise-Abhängigkeiten muss der Agent die autorisierten Zusatzquellen
ausdrücklich in der lokalen Odoo-Konfiguration berücksichtigen. Checkout- und
Paketpfade dürfen auch direkt der Projektordner sein; Pfade außerhalb werden abgelehnt.

**Upgrade-Probelauf:** `upgrade_code --dry-run` ändert keine Dateien. Upstream beendet sich mit
`sys.exit(int(is_dirty))`: Exit 0 heißt „keine Änderungen nötig“, Exit 1 heißt „Änderungen
vorgeschlagen“ (siehe Log) – kein Werkzeugfehler. `hapi-dev` gibt den Exit-Code unverändert weiter,
schreibt `summary.json` mit `outcome` (`clean`, `changes_proposed`, `failed`) und wertet Exit 1 mit
Python-Traceback oder andere Codes weiter als Fehler. Upstream analysiert außer den angegebenen
Addons-Pfaden auch die Odoo-Kernmodule; Vorschläge zu Kernmodulen betreffen nicht das Projekt.

### Odoo.sh: Staging und Produktion

Beide Umgebungen haben eigene Angaben. Der Projektlink ist gemeinsam; je Umgebung
werden Branch, Build-ID, Build-Host und optionale Tresorverweise getrennt gespeichert.
Build- und Editorlinks entstehen aus dem jeweiligen Host. Der **Arbeitsbranch** ist
eine eigene Angabe und schaltet den Checkout nicht automatisch um. Entspricht er dem
Produktionsbranch, kann ein späterer Push die Produktion aktualisieren.

| Feld | Herkunft und Beispiel |
| --- | --- |
| Projektlink | Adresszeile des Odoo.sh-Projekts, etwa `https://www.odoo.sh/project/acme` |
| Staging-Branch | Name des in Odoo.sh der Stufe Staging zugeordneten Git-Branches, etwa `staging-q4` |
| Produktionsbranch | Name des Produktionsbranches, etwa `main`; der Name allein beweist seine Stufe nicht |
| Build-ID | Zahl vor `@` im von Odoo.sh angezeigten SSH-Befehl, etwa `25004381` |
| Build-Host | Host nach `@`, etwa `acme-staging-25004381.dev.odoo.com`; keine GitHub-Adresse |
| SSH-Ressource | Verweis auf eine vorhandene freigegebene Tresoraktion; kein privater Schlüssel |
| Anwendungs-API-Ressource | Optionaler Tresorverweis auf die JSON-2-API genau dieser Datenbank; keine Odoo.sh-Steuer-API |

Öffne in Odoo.sh den gewünschten Branch und Build und übernimm dessen Angaben in
die passende Karte. Ein kopierter Build bleibt eine Momentaufnahme. Die öffentliche
Website-Adresse ist nicht automatisch der SSH-Buildhost. Die GitHub-Schaltflächen
eines Builds führen zum eigenen Projektbranch oder Commit, nicht zu Enterprise-Quellen.
Siehe [Branches und SSH](https://www.odoo.com/documentation/20.0/administration/odoo_sh/getting_started/branches.html)
und [Build-Oberfläche](https://www.odoo.com/documentation/20.0/administration/odoo_sh/getting_started/builds.html).

Alte eindeutig als Staging oder Produktion deklarierte Angaben werden nur dieser
Umgebung zugeordnet. Unklare Altangaben bleiben sichtbar zur ausdrücklichen Zuordnung;
die andere Umgebung wird nicht automatisch befüllt. Auch beim Wechsel der Betriebsart
bleiben die Werte erhalten. Speichern verwendet weiterhin eine Revisionsprüfung.

Statusabfragen beziehen sich ausdrücklich auf eine Umgebung oder einen Git-Ref.
HAPIs GitHub-Token benötigt **Commit statuses: Read-only**. Odoo.sh muss seinerseits
Statusmeldungen veröffentlichen; dessen Einstellungen verwenden dafür **Commit statuses:
write**. `no_status` und `unknown` sind kein Erfolg. Ein GitHub-Commitstatus beweist
weder die aktuell laufende Produktionsdatenbank noch die Frische des kopierten Buildhosts.
Siehe [Odoo.sh-Einstellungen](https://www.odoo.com/documentation/20.0/administration/odoo_sh/getting_started/settings.html).

Der Assistent baut keine SSH-Verbindung auf, startet keinen Build und kopiert keine
Schlüssel. Das Speichern einer Produktionsverbindung ist keine Ausführungsfreigabe.

### Enterprise: Odoo.sh und lokale Quellen unterscheiden

Das eigene GitHub-Repository enthält die eigenen Erweiterungen. **Odoo.sh stellt
Enterprise selbst unter `/home/odoo/src/enterprise` bereit**, neben Community und dem
eigenen Repository. Eine Buildnummer oder ein Subscriptioncode wird deshalb nicht
als Enterprise-Repository eingetragen.
[Offizielle Editor- und Quellstruktur](https://www.odoo.com/documentation/20.0/administration/odoo_sh/getting_started/online_editor.html).

Das optionale Enterprise-Repository in HAPI betrifft zusätzliche lokale Entwicklung:

1. Mit dem vorgesehenen GitHub-Konto prüfen, ob Zugriff auf die autorisierten
   Enterprise-Quellen besteht. Ein Odoo.sh-Abo allein bestätigt keine GitHub-Einladung.
2. Ein mit HAPIs GitHub-Verbindung erreichbares, berechtigtes Repository fürs Projekt
   freigeben; zum Lesen der Quellen reichen Leserechte. Separat klonen und im
   Enterprise-Feld auswählen. Passenden Versionsbranch `19.0` oder `20.0` verwenden.
3. Für lokale Enterprise-Tests auch die passenden Community-Quellen und den zusätzlichen
   Enterprise-Addons-Pfad einrichten. Die Auswahl allein erledigt das nicht.
   [Quellinstallation](https://www.odoo.com/documentation/20.0/administration/on_premise/source.html).

**Grenze der GitHub-Verbindung:** HAPI unterstützt derzeit ein Fine-grained Token je
Projekt. GitHub bindet dieses an einen Resource Owner und begrenzt den Zugriff für
Outside Collaborators. Ein Kundenrepository und das private `odoo/enterprise` können
deshalb nicht allgemein mit demselben Token freigegeben werden. Den Token nicht als
vermeintlichen Einrichtungsschritt wechseln: Erneutes Verbinden entfernt bisherige
Repositoryfreigaben. HAPI beschafft keine zusätzlichen Nutzungs- oder Zugriffsrechte.
[GitHub-Tokenregeln](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

### Android

1. **Projektadmin:** Lizenzbedingungen des Android-SDK lesen
   (<https://developer.android.com/studio/terms>) und unter **Entwicklung → Android** die
   Lizenzprüfung bestätigen. Agenten können das nicht.
2. `hapi-dev android sdk bootstrap` lädt die cmdline-tools
   (`commandlinetools-linux-15859902_latest.zip`, SHA-256 geprüft) in das Projekt-SDK.
3. **Mensch im Projektterminal:** `hapi-dev android sdk licenses` – jede Lizenz wird selbst
   gelesen und beantwortet. In Agentensitzungen bricht der Befehl ab.
4. `hapi-dev android sdk install --compile-sdk 35 --build-tools 35.0.0 --platform-tools`
   (neue, nicht angenommene Lizenzen führen zum Abbruch).
5. Tests und Artefakte:

```sh
hapi-dev android gradle unit-test --project repositories/acme/app --module :app --variant debug
hapi-dev android gradle lint      --project repositories/acme/app
hapi-dev android gradle assemble  --project repositories/acme/app --variant freeDebug   # nur Debug-Varianten; APK + SHA256SUMS
```

`assemble` baut ausschließlich `debug` oder `<flavor>Debug` (keine Release-Signierung). APKs werden über `output-metadata.json` (`variantName`) bzw. die übliche Ordnerstruktur `apk/<flavor>/debug` gefunden und mit ihrem relativen Pfad (`apk/free/debug/…`) samt `SHA256SUMS` abgelegt; ohne APK endet der Befehl mit Code 3. Gradle führt Projekt-Buildskripte aus; das ist der ausdrückliche Effekt dieser Befehle,
nie des Doctors. Der Gradle-Cache liegt in `.hapi/.cache/toolchain/android/gradle-home`. Ein
Emulator braucht KVM, das Projektrunner normalerweise nicht haben; Debug-APKs lassen sich
auf ein eigenes Gerät übertragen. Die offizielle Android CLI ist optional:
`hapi-dev android cli install` (Google veröffentlicht keine Prüfsumme; die SHA-256 der
geladenen Datei wird protokolliert), Aufrufe immer mit `--no-metrics`; `android init`
wird nicht ausgeführt, damit keine globalen Skills überschrieben werden.

### iOS

Unter Linux sind Codearbeit, Review, CI-Konfiguration und **portable Swift-Pakete**
möglich:

```sh
hapi-dev swift install                     # Swift 6.4.1 von swift.org, PGP-Signatur geprüft
hapi-dev swift test --package repositories/acme/ios/Packages/Core
```

Im offiziellen Tarball ist `usr/bin/swift` eine Verknüpfung auf `swift-driver`. Doctor und
`hapi-dev` akzeptieren sie nur, wenn das Ziel eine ausführbare Datei im selben Versionsordner
ist (nur Metadaten gelesen, nichts ausgeführt); `swift test` startet den Link selbst, weil
`swift-driver` seinen Modus aus dem Programmnamen ableitet. `swift test` setzt für den Kindprozess `TMPDIR=.hapi/.cache/toolchain/tmp`
(wird bei Bedarf angelegt), weil SwiftPM das kompilierte Manifest aus `TMPDIR` startet und `/tmp` im
Runner `noexec` ist.

App-Builds, Signierung, Simulator und UI-Tests laufen auf einem eigenen Mac, in GitHub
Actions (macOS) oder in Xcode Cloud. **Xcode Cloud** wird einmalig von Hand in Xcode auf
einem Mac mit dem Repository verbunden
(<https://developer.apple.com/documentation/xcode/configuring-your-first-xcode-cloud-workflow>).
HAPI stellt keine Live-Verbindung her und startet nie Builds oder TestFlight-Uploads –
jeder Lauf kostet Kontingent. Eine vorhandene, ausdrücklich freigegebene Tresor-Ressource
oder ein Projekt-MCP-Server kann als Referenz eingetragen werden.

## Fehlerbilder

| Meldung | Ursache und Abhilfe |
|---|---|
| Runner `upgrade_required` | Der Projektrunner ist älter als diese Funktion; Runner mit aktuellem Image neu erstellen. |
| Alle Werkzeuge `missing`, Image-Hinweis | Basis-Image; Betreiber baut das Development-Image (siehe oben). |
| `odoo.source` `warning`: source.json weicht ab | Der Checkout wurde nach der Einrichtung verändert; bewusst prüfen, nichts wird überschrieben. |
| `postgresql.cluster` lauscht auf TCP | Der Cluster wurde nicht mit `hapi-dev postgres start` gestartet; dieser erzwingt `listen_addresses=''`, Socketordner und Port per Startoption, unabhängig von `postgresql.conf`. |
| `postgres init`: „kein vollständig von HAPI eingerichteter Cluster“ | Ein abgebrochenes `initdb` oder ein fremder Ordner liegt unter `postgresql/17/data`. Es wird nichts gelöscht; Ordner prüfen und selbst umbenennen. |
| „ist eine Verknüpfung oder kein Verzeichnis“ | Ein Teil von `.hapi/.cache/…` ist ein Symlink oder gehört einem anderen Benutzer; `hapi-dev` schreibt dann nicht hinein. |
| `assemble` endet mit Code 3 | Gradle meldete Erfolg, aber für die Variante wurde kein APK gefunden; es gibt kein Artefakt. |
| `android.licenses` `missing` | Projektadmin bestätigt in den Einstellungen; danach interaktiv im Terminal annehmen. |
| Inspect `blocked` | Checkout-Pfad ist eine Verknüpfung oder unsicher; Ordner prüfen. |
