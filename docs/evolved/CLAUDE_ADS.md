# Claude Ads (mitgeliefertes Paid-Media-Modul)

HAPI-eVolved liefert [AgriciDaniel/claude-ads](https://github.com/AgriciDaniel/claude-ads)
(MIT) als **mitgeliefertes, unveränderliches Plugin** aus. Es bringt die unveränderten
Upstream-Skills, -Agenten und den deterministischen Python-Kern in HAPI-Projekte: als
Entwicklungsmodul im Browser, als Spezialisten für Claude und Codex, als native
Skill-Dateien im Projekt und als feste Offline-CLI `hapi evolved ads`.

| Stand | Wert |
|---|---|
| Upstream-Commit | `fc3908e786c318776df89a3a098333da377364be` (GitHub-Repository-ID 1155383451) |
| Skill/Plugin | 2.1.0 · deterministischer Kern `claude_ads_core` 2.0.0 |
| HAPI-Plugin | `claude-ads` 2.1.0+hapi.1 · Plugin-ID `d6608d8c-e211-5d30-9735-6712fee7c5e9` (UUIDv5) |
| Modul | `plugin:d6608d8c-e211-5d30-9735-6712fee7c5e9:ads` · Inhaltsfassung 2.1.0-hapi.1 |

## Was upstream bei fc3908e kann – und was nicht

Diese Grenzen gelten unverändert; HAPI erfindet nichts dazu:

- **Keine Live-Lese-Adapter.** HAPI liest keine Werbekonten. Evidenz sind Exporte (CSV).
- **Alle 12 `account-mutation`-Fähigkeiten (live-write) sind deaktiviert.** Entwürfe sind
  Dateien (z. B. `mutation-plan`), nie Kontoänderungen.
- **Alle Health-Scoring-Profile sind deaktiviert.** Bundles enthalten
  `health_score: null`, Status `insufficient_evidence`, Abdeckung 0 %; Berichte zeigen
  „Not scored“. Niemand – weder HAPI noch ein Agent – berechnet ersatzweise einen Score.
- **Export-Normalisierung:** generisches CSV für alle 12 Plattformen; exakte native
  Exportprofile für 10 Plattformen, **nicht für Amazon und X**.
- **Kern-CLI:** validate, ingest-export, score/portfolio, status/next, render/report,
  optional cockpit. **Es gibt keinen Audit-Befehl**; das Audit ist Skill-Orchestrierung.
- **Codex:** upstream als experimentell markiert. HAPI hat getestet, dass die
  unveränderten Dateien unter `.agents/skills` liegen und die festen Befehle laufen –
  nicht die Modellqualität.
- **PDF** ist nicht verfügbar (optionale Abhängigkeit WeasyPrint wird nicht bereitgestellt
  und nicht nachinstalliert). Die optionale Cockpit-Werkbank wird nicht aktiviert.

`hapi evolved ads capabilities` liest diese Angaben direkt aus den vendorten Manifesten.

## Aufbau in HAPI

| Teil | Ort | Herkunft |
|---|---|---|
| Unveränderte Upstream-Dateien (215) | `vendor/claude-ads/upstream/` | byte-identisch, SHA-256 in `vendor/claude-ads/PROVENANCE.json` |
| HAPI-Adapter-Skill `hapi-ads` | `vendor/claude-ads/hapi/hapi-ads/SKILL.md` | HAPI |
| Modul, Routing-Agenten, Manifest-Builder | `vendor/claude-ads/hapi/manifest.ts` | HAPI |
| Generiertes Plugin-Manifest | `vendor/claude-ads/hapi-evolved.plugin.json`, `hub/src/evolved/bundled/claudeAdsPlugin.generated.ts` | generiert |
| Importer/Generator | `scripts/claude-ads/vendor.ts` (`import`, `generate`, `check`) | HAPI |
| Registry für mitgelieferte Plugins | `hub/src/evolved/bundledPlugins.ts`, `shared/src/bundledPlugins.ts` | HAPI (generisch) |
| Offline-CLI und Python-Brücke | `cli/src/evolved/ads/` | HAPI |

Vendort sind: `ads/SKILL.md`, `ads/references/*.md`, `ads/agents/openai.yaml`, 33
Unter-Skills mit `ads-plan/assets`, 25 Agenten, `claude_ads_core` (Python und
`schemas/v1`), die 29 öffentlichen Laufzeitressourcen aus
`control-plane/runtime-resources.txt` samt Liste, `LICENSE`, `THIRD_PARTY_NOTICES.md`,
`README.md`, `pyproject.toml` und ausgewählte öffentliche Test-Fixtures (Exporte,
native Exporte, ein Bericht-Bundle). **Nicht** vendort: Installer, `scripts/`
(Netzabruf, Screenshots, Bildgenerierung, Release), `mods/` (Cockpit), `evals/`, `docs/`,
private Review- und Evidenzdateien, Git-Historie.

Aktualisieren (nur bewusst, mit Review): Checkout auf dem neuen Commit prüfen, Commit in
`shared/src/bundledPlugins.ts` anpassen, `vendor/claude-ads/upstream` entfernen,
`bun scripts/claude-ads/vendor.ts import <checkout>`, dann `generate` und `check`. Der
Importer führt nichts aus dem Checkout aus (nur `git rev-parse`/`git status`), lehnt
Symlinks und fremde Dateitypen ab und schreibt jede Datei mit Prüfsumme.

### Hauptskill in zwei Teilen

`ads/SKILL.md` hat 19 831 Bytes; HAPI-Skill-Anweisungen sind auf 16 384 Zeichen begrenzt.
Der Builder teilt die Datei verlustfrei an einer Überschrift: `ads-main-1` + Leerzeile +
`ads-main-2` + Zeilenende ergibt exakt die Originalbytes (Test in
`hub/src/evolved/bundledPlugins.test.ts`). Die nativen Skill-Dateien bleiben vollständig.

## Mitgeliefertes Plugin

- Wird immer im Erweiterungskatalog angezeigt, „Mitgeliefert · unveränderlich“.
- Plugin-Routen lehnen Update, Deaktivieren, Deinstallieren und Ersetzen mit
  `plugin_bundled` (409) ab; ein GitHub-Plugin mit gleichem Repository, gleicher
  Repository-ID oder gleicher Manifest-ID kann nicht installiert werden.
- Es gibt keine Tabellenzeile, keine DDL, keine automatische Aktivierung, kein Seeding
  beim Lesen. Das Modul wird **je Projekt** ausdrücklich gespeichert (Digest-Übernahme
  wie bei jedem Plugin-Modul). Eine neue HAPI-Fassung mit geändertem Modul verlangt die
  bestehende Übernahme durch einen Projektadministrator.
- Gespeicherte Projekteinstellungen nutzen das gewöhnliche Format
  (`schemaVersion: 3`, `plugin:<uuid>:ads`). Ein HAPI ohne dieses Bundle zeigt das Modul
  als `missing`, behält die Einstellungen und ersetzt nichts.

## Im Browser

1. **Entwicklung** (oder beim Anlegen des Projekts): Modul „Claude Ads (Paid Media)“
   wählen, Felder ausfüllen, speichern. Speichern schreibt nur die Projekteinstellungen,
   nichts im Repository.
2. **Doctor** prüfen: Python 3.11/3.12, Assets, native Skills (Claude/Codex), Ablage.
3. **Aufgaben** starten (Spezialistenstart mit Konfigurationsrevision und Modul-Digest):

| Aufgabe | Spezialist | Wirkung |
|---|---|---|
| Native Skills einrichten | `hapi-ads-setup` (HAPI-Routing) | installiert im Projektordner |
| Konto-Intake | `hapi-ads-setup` | schreibt validierte Profile |
| Leitfaden prüfen (nur lesend) | `hapi-ads-audit` | liest nur; auch im Profil „nur lesend“ |
| Audit (Orchestrierung) | `hapi-ads-audit` | Exporte → Bundle → Bericht |
| *Plattform* prüfen (12×) | Upstream `audit-<plattform>` | audit-worker-result |
| Tracking, Budget, Creatives, Richtlinien, Regulierung | Upstream `audit-tracking`, `audit-budget`, `audit-creative`, `audit-policy-compliance`, `audit-regulatory-compliance` | audit-worker-result |
| Strategie und Budgetplan | `hapi-ads-plan` | media-plan |
| Entwürfe (nur Dateien) | `hapi-ads-draft` | Texte, creative-brief, mutation-plan |
| Bericht erstellen | `hapi-ads-report` | Bundle, Markdown/HTML, Status |

Upstream-Agenten bekommen ihren unveränderten Text plus die Skills `ads` (beide Teile),
den passenden Plattform-/Workflow-Skill und `hapi-ads`. Die fünf HAPI-Routing-Agenten
enthalten nur eine kurze Weiterleitung auf diese unveränderten Skills. Keine Aufgabe pinnt
ein Modell (`providerPreference: either`). Schreibende Aufgaben verlangen ein beschreibbares
Projektprofil.

### Einstellungen

Kunde, Geschäftsziel, Hauptconversion, primäre und aktive Plattformen (12), Konten
(„Bezeichnung: ID“), Währung, Zeitzone, Datenzeitraum, Bezug der Evidenzpfade
(Projektordner oder Checkout), Exportdateien, Exportformat, Pfad der
`data-lifecycle.json`, Vertraulichkeit, Berichtsordner und -formate, optionale
Tresor- und MCP-Ressourcen-ID, Hinweise. **Keine** Token-, Passwort- oder API-Key-Felder;
eine Ressourcen-ID ist nur ein Verweis und kein Nachweis einer Verbindung. Ein GitHub-Repository
ist nicht nötig; ohne Repository arbeitet alles im verwalteten Projektordner.

## Native Skills für Claude und Codex

`hapi evolved ads install-skills [--target claude|codex|both] [--workspace <dir>] [--dry-run]`
kopiert die geprüften Dateien in den Arbeitsordner der Sitzung. Ohne `--workspace` ist das
das aktuelle Verzeichnis, sofern es der Projektordner oder ein Ordner darin ist – eine
HAPI-Sitzung mit gebundenem Repository läuft im Checkout, und nur dort findet Codex 0.157
die Projekt-Skills (geprüft: ein verschachtelter Git-Checkout sieht Skills des
Projektordners nicht). Liegt das aktuelle Verzeichnis außerhalb des Projekts (z. B. ein
Administrationsaufruf mit `--project-root`), gilt der Projektordner. Ein GitHub-Repository
ist nicht nötig. Die Ausgabe nennt `workspace` und `workspaceSource` (`explicit`, `cwd`,
`project_root`); dieselbe Regel gilt für `skills-status`, `doctor` und Eingabepfade.

```text
.claude/skills/ads/SKILL.md                     (Claude Code: /ads)
.claude/skills/ads/references/*.md
.claude/skills/ads/agents/openai.yaml
.claude/skills/ads/control-plane/…              (öffentliche Laufzeitressourcen)
.claude/skills/ads/claude_ads_core/schemas/v1/*.json
.claude/skills/ads-<name>/SKILL.md (+ assets)   (/ads-audit, /ads-google, …)
.claude/skills/hapi-ads/SKILL.md                (HAPI-Adapter)
.claude/agents/<upstream-agent>.md              (Claude-Subagenten)
.agents/skills/…                                (gleiche Skills für Codex: $ads, $ads-audit, …)
```

`ads/` folgt dem Quell-Layout, auf das `ads/SKILL.md` relativ verweist
(`references/…`, `control-plane/…`, `claude_ads_core/schemas/v1/`). Python-Code, Installer
und Hilfsskripte werden nicht kopiert. Vertrauensgrundlage sind ausschließlich die mit
diesem HAPI-Release ausgelieferten Bytes:

- Fehlende Dateien werden exklusiv neu angelegt (eine zwischenzeitlich entstandene Datei
  wird nie ersetzt, der Aufruf bricht dann ab); byte-gleiche vorhandene Dateien werden
  übernommen, ohne sie neu zu schreiben.
- Jede abweichende Datei an einem ausgelieferten Pfad ist ein Konflikt. Alle angefragten
  Ziele (`--target both`) werden vorher geplant; bei einem Konflikt irgendwo wird
  **nichts** geändert (Exit-Code 3, Liste der Konflikte).
- Es wird nie etwas ersetzt oder gelöscht. `.hapi-claude-ads.json` im `skills`-Ordner ist
  eine ausgelieferte, deterministische Liste der Pfade und Prüfsummen dieser Fassung, aber
  kein Eigentumsnachweis: eine Projektdatei kann HAPI nicht zum Löschen oder Überschreiben
  bewegen. Eine ältere Fassung muss bewusst entfernt werden; einen Upgrade- oder
  Deinstallationsautomaten gibt es in dieser Fassung nicht.
- Symbolische Links werden nie verfolgt; das Ziel muss im Projektordner liegen. Vergleich und
  Schreiben laufen über die Dateigrenze unten (gehaltene Verzeichnis-Deskriptoren, Lesen
  höchstens in der ausgelieferten Länge).
- Nie global (`~/.claude`, `~/.codex`). Aktivierung und Doctor installieren nichts.
- In einem Git-Checkout erscheinen die Dateien als unversionierte Dateien; ob sie
  committet oder ausgeschlossen werden, entscheidet das Projekt.

## Offline-CLI `hapi evolved ads`

```bash
hapi evolved ads doctor
hapi evolved ads capabilities
hapi evolved ads ingest --platform google --input exports/google-2026-06.csv --run june-01
hapi evolved ads ingest --platform meta --format native --input exports/meta.csv --context currency=EUR --run june-02
hapi evolved ads validate --contract audit-worker-result --file work/google-worker.json
hapi evolved ads prepare --run june-01 --lifecycle ops/data-lifecycle.json [--findings work/google-worker.json]
hapi evolved ads report --run june-01 --format markdown
hapi evolved ads report --run june-01 --format html
hapi evolved ads status --run june-01
hapi evolved ads run --from-settings          # alle gespeicherten Exportdateien, alle Schritte
```

- Projektordner: `EVOLVED_RUNNER_ROOT` oder `--project-root`: kanonischer absoluter Pfad
  (Leerzeichen, Umlaute und `@` erlaubt, z. B. `…/Ads Projekt ä@2026`), ohne Steuerzeichen,
  gleich seinem `realpath`, kein Systemordner. Eingaben sind relative Pfade im Arbeitsordner
  (siehe oben), Pfade unter `.hapi/.cache/artifacts/ads/` beziehen sich auf den Projektordner.
  Kein `..`, keine absoluten Pfade, keine mit `-` beginnenden Segmente, keine Symlinks (auch
  nicht in Zwischenordnern).
- Dateigrenze (nur Linux mit `/proc`, sonst Abbruch ohne unsicheren Ersatzweg): jedes
  Verzeichnis wird ab `/` Komponente für Komponente mit `O_DIRECTORY|O_NOFOLLOW` relativ zum
  bereits geöffneten Elternverzeichnis geöffnet; Lesen, temporäre Datei, `link` und Aufräumen
  geschehen über diesen gehaltenen Deskriptor (`/proc/self/fd/<fd>/<name>`). Ein nachträglich
  durch einen Symlink ersetzter Pfadbestandteil lenkt Lesen oder Schreiben deshalb nicht um.
  Gelesen wird `O_NOFOLLOW|O_NONBLOCK`, nur reguläre Dateien bis zur Grenze, mit Inode-Abgleich;
  verkürzte, gewachsene oder währenddessen geänderte Dateien werden abgelehnt.
  Grenze: Ein anderer Prozess desselben Benutzers kann den Inhalt bekannter Dateien ändern
  oder ein gehaltenes Verzeichnis verschieben – die Operation wirkt dann auf genau dieses
  Verzeichnis, nie auf ein anderes Ziel; vollständige Isolation gegen denselben Benutzer
  bietet das nicht.
- Ausgaben nur unter `.hapi/.cache/artifacts/ads/<ordner>/<run>/` (`snapshot.json`,
  `ingest.json`, `report-bundle.json`, `report.md`, `report.html`), Rechte 0600/0700,
  exklusiv angelegt; vorhandene Dateien werden nie überschrieben.
- Unbekannte Befehle und Optionen (auch `--policy-root`) werden abgelehnt; Werte, die mit
  `--` beginnen, gelten nicht als Optionswert.
- `run --from-settings` liest die gespeicherten Werte über die Hub-API (gebunden an das
  aktive, bereite Ads-Modul, mit Revision und Digest im Ergebnis). Werte gelangen nie in
  eine Shell.
- Fehler erscheinen als JSON auf stderr (`{"status":"error","error":…}`), Exit-Code 2.
- Der Befehl lädt die übrige CLI nicht und schreibt nichts nach `HAPI_HOME` oder `HOME`
  (Unterprozess-Test). Nur `run --from-settings` lädt den Hub-Client.
- Die Python-Brücke reicht nur `validate`, `render` und `status` an den Kern weiter, und
  nur mit dem gepinnten Policy-Root.

### Lieferumfang

Unterstützt ist die Quell-CLI unter `/app`: beide Runner-Images kopieren `/app` aus dem
Hub-Image (`COPY . .` ohne Ausschluss von `vendor/` oder `bridge.py`), und
`/usr/local/bin/hapi` startet `bun /app/cli/src/index.ts`. Eine eigenständig kompilierte
`hapi`-Datei enthält die Ads-Assets **nicht**: `doctor` meldet `ads.assets` als `missing`,
alle Ads-Befehle brechen mit einem klaren Hinweis ab; es wird nichts entpackt.

### Python-Laufzeit

Upstream unterstützt CPython 3.11 und 3.12. Gesucht wird in fester Reihenfolge
`/opt/hapi-ads-python/bin/hapi-ads-python`, `/usr/local/bin/python3.12`,
`/usr/bin/python3.12`, `/usr/local/bin/python3.11`, `/usr/bin/python3.11` (oder ein
absoluter `HAPI_ADS_PYTHON` des Betreibers). Python 3.13 (Debian-13-Entwicklungsimage)
gilt als **nicht unterstützt** und macht das Modul nicht bereit. Aufruf:
`python -I -S -B cli/src/evolved/ads/bridge.py <vendor-root> …` in einem frischen
privaten Temp-Ordner, Umgebung nur `PATH=/usr/bin:/bin`, `LANG/LC_ALL=C.UTF-8`, `HOME`/`TMPDIR`
= Temp-Ordner. Der Kern sieht nur private Kopien der Eingaben (über `O_NOFOLLOW` gelesen);
die Brücke prüft, dass `claude_ads_core` aus dem gepinnten Vendor-Ordner geladen wurde, und
setzt den Policy-Root fest darauf. Vor jedem Aufruf werden alle 215 Dateien gegen
`PROVENANCE.json` und dessen eingebaute Prüfsumme geprüft.

### Eingabeformat (generisches CSV)

Pflichtspalten: `date, account_id, account_name, campaign_id, campaign_name,
campaign_status, creative_id, creative_name, conversion_action, conversions, budget,
spend, currency`. Genau ein Konto, ein Kontoname und eine Währung je Datei; ISO-Daten;
Zahlen endlich und ≥ 0; Währung als dreistelliger Großbuchstabencode; jede Kombination
(date, campaign_id, creative_id) nur einmal; Budget je Kampagne und Tag eindeutig.
Grenzen 50 MiB, 500 000 Zeilen, 128 Spalten; zusätzliche Spalten werden ignoriert.
Native Profile verlangen exakt ihre Kopfspalten (keine zusätzlichen) und teils Kontext
(`currency` für Meta, TikTok, Reddit; `account_id`+`currency` für LinkedIn, Snapchat;
`account_id`+`campaign_id`+`currency` für Pinterest); `capabilities` listet sie genau.

### Datenlebenszyklus

`prepare` verlangt eine vom Betreiber bestätigte `data-lifecycle.json` (Upstream-Vertrag).
Für nicht öffentliche Daten fordert upstream belegte Verschlüsselung (`verified` mit
`evidence_refs`); `privacy_class` des Bundles muss zur Klassifizierung passen (ohne
Angabe übernimmt HAPI sie aus der Datei). HAPI erzeugt keine solchen Angaben ungeprüft.

## Doctor (`hapi.claude-ads` v1)

Nur lesend, auf dem Projekt-Runner (Fähigkeit `evolvedDevelopment.provider.hapi.claude-ads.v1`)
oder lokal mit `hapi evolved ads doctor`:

| Prüfung | Bedeutung |
|---|---|
| `ads.python` | CPython 3.11/3.12 vorhanden (3.13: `unsupported`) |
| `ads.assets` | vendorte Dateien stimmen mit der Provenienz überein |
| `ads.skills.claude` / `ads.skills.codex` | Eigentumsstand der nativen Skills im Arbeitsordner |
| `ads.artifacts` | Berichtsablage ist ein normaler Ordner (oder wird angelegt) |

Es werden keine Projektdateien ausgeführt und keine Umgebungswerte gemeldet. Die
Prüfung sendet keine Einstellungen an den Runner.

## Runner-Images

- **Standard** (`Runner.Dockerfile`, Debian 12): System-Python 3.11 ist unterstützt; unverändert.
- **Entwicklung** (`Runner.development.Dockerfile`, Debian 13): System-Python 3.13 und Odoo
  bleiben unverändert. Eine private Stufe
  `python:3.12-slim-trixie@sha256:cb33f7f771ecec2ef1225cf39b159591a040391bd73e4c01f00fdfc4c47611d2`
  (Python 3.12.15, linux/amd64-Manifest `sha256:e8a38829…f345c`) liefert Interpreter,
  Standardbibliothek und `libpython3.12.so.1.0` nach `/opt/hapi-ads-python`; ohne
  `site-packages`, `ensurepip`, Tests, IDLE und Tk. `deploy/evolved/hapi-ads-python` setzt den
  Bibliothekspfad nur für diesen Kindprozess. Der Build schlägt fehl, wenn Version,
  benötigte Standardmodule, `sys.prefix` oder die HAPI-Brücke mit dem vendorten Kern nicht
  stimmen oder das System-Python nicht mehr 3.13 ist. Die Basis-Images (`oven/bun:1.3.14`,
  `node:24-trixie-slim`, `node:24-bookworm-slim`) sind unverändert. Das Image selbst wurde
  in dieser Arbeit nicht gebaut.

## Einschränkungen

- Keine Live-Konten, keine Kontoänderungen, kein Health-Score, kein PDF (siehe oben).
- Die Erkennung der nativen Skills durch Claude Code und Codex folgt deren dokumentierten
  Projektordnern; HAPI prüft die Dateien, nicht das Modellverhalten.
- Upstream-Agenten deklarieren `tools:`/`maxTurns:` im Frontmatter; HAPI setzt das nicht
  durch, Berechtigungen kommen aus dem Projektprofil (Hinweis im Adapter-Skill).
- Upstream-Helfer wie der Landing-Page-Fetcher (`scripts/fetch_page.py`) sind nicht
  enthalten; die Skills melden das als Lücke.
- `GET /agent-catalog` liefert die Skill-Texte aller aktivierten Plugins; mit dem
  mitgelieferten Plugin sind das rund 240 KB mehr.
