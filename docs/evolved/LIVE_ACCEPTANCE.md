# HTTPS-Abnahme eines neuen Teststacks

`web/scripts/evolved-live-check.mjs` prüft den laufenden Stack über den Browser und
öffentliche HTTPS-APIs. Es greift weder direkt auf Datenbanken noch auf interne
Dienstschlüssel zu und ruft keine Modellanbieter auf. Die lokale Memory-Suche
prüft den Hub-Ledger; sie ersetzt keine getrennte Graphiti-/Neo4j-Dienstabnahme.
Der Codegraph-Nachweis verwendet den tatsächlich konfigurierten Dienst.

**Ausschließlich mit einem frischen, getrennten Abnahmestand ausführen.** `seed`
registriert einen synthetischen Installationsadmin mit einem virtuellen Passkey
und verweigert bereits initialisierte Instanzen. Dieser Abnahmestand ist nicht
die abschließende Installation für menschliche Benutzer. Für deren Einrichtung
einen eigenen frischen Zustand und eigenen Passkey verwenden. Das Skript setzt
keine Installation zurück und löscht keine Teams, Projekte oder Betreiberdateien.

## Vorbereitung

Benötigt werden installierte Web-Abhängigkeiten einschließlich Playwright, Node.js
und ein vorhandener Chromium-Browser. Der Stack muss unter seiner HTTPS-Origin mit
gültiger Zertifikatskette erreichbar sein. TLS-Prüfungen bleiben aktiviert. Auf
dem Aufrufrechner sind weder Docker- noch Serverdateisystemzugriff erforderlich.

Der Betreiber legt diese Dateien im synthetischen Testworkspace an. Unter Compose
entsprechen `/workspaces/acceptance/...` den Hostdateien
`<EVOLVED_STATE_DIR>/workspaces/acceptance/...`:

```typescript
// example.ts
export function evolvedAcceptanceSquare(value: number) { return value * value }
export function evolvedAcceptanceCalculate(value: number) { return evolvedAcceptanceSquare(value) }
```

```html
<!-- dist/index.html -->
<!doctype html><html><head><meta charset="utf-8"><title>Acceptance</title></head>
<body><h1>Evolved acceptance preview</h1></body></html>
```

`dist/asset.txt` enthält `acceptance-asset-ok` und optional einen abschließenden
Zeilenumbruch. Der Browser prüft echte Laufzeitbeschränkungen des Vorschau-Dokuments:
kein Cookie-/LocalStorage-Zugriff, kein API-Fetch und kein Zugriff auf das
Elterndokument; die freigegebene statische Datei bleibt abrufbar.

Die private lokale Kopie von `hub/bootstrap.token` muss eine reguläre Datei mit
Modus `0600`, einem einzigen Hardlink und dem Besitzer der ausführenden UID sein.
Symlinks werden auch in Pfadkomponenten abgewiesen. Den Inhalt nicht anzeigen,
nicht in Shellargumente übernehmen und nicht in Berichte kopieren.

## Erstlauf und private Übergabe

```sh
export EVOLVED_TEST_URL=https://hapi-evolved.example.internal
export EVOLVED_BOOTSTRAP_FILE=/privater/pfad/acceptance-bootstrap.token
export EVOLVED_TEST_WORKSPACE=/workspaces/acceptance
export EVOLVED_TEST_OUTPUT_DIR=/privater/pfad/acceptance-browser
export EVOLVED_TEST_GRAPH_SYMBOL=evolvedAcceptanceSquare
# Nur bei abweichendem Browserpfad:
# export PLAYWRIGHT_CHROME_PATH=/absoluter/pfad/zu/chrome
node web/scripts/evolved-live-check.mjs seed
```

Das Ausgabeverzeichnis darf beim Erstlauf nur neu oder leer sein. Es muss der
ausführenden UID gehören, Modus `0700` haben und darf kein Symlink sein. Ohne
`EVOLVED_TEST_OUTPUT_DIR` entsteht ein privates temporäres Verzeichnis; dessen Pfad
steht im Ergebnis. Alle angelegten Dateien haben Modus `0600`:

| Datei | Zweck |
| --- | --- |
| `handoff.json` | Origin, Testprojekt-/Team-/Benutzer-ID, Namespace, Profil, Workspace, Objekt-IDs und Ergebnisse; keine Secretwerte |
| `runner.lease` | Runner-Lease, ausschließlich für Betreiber/Runner-Proxy |
| `session-cookie.txt` | Synthetisches Sitzungscookie als Cookie-Headerwert |
| `browser-state.json` | Browserzustand für den nächsten Prüflauf |
| `virtual-authenticator.json` | Privater Schlüssel des virtuellen Testpasskeys; wie ein Passwort behandeln |
| `recovery-codes.json` | Wiederherstellungscodes des synthetischen Kontos |
| `last-checks.json` | Im Fehlerfall: sichere Prüfnamen und Fehlercodes |

Die Runner-Lease gilt eine Stunde für das `restricted`-Testprojekt und hat nur
`runner:connect`, `memory:read` und `codegraph:read`. Für die Runnerabnahme kopiert
der Betreiber die Datei mit Besitzer der Proxy-UID und Modus `0600` an einen Ort
außerhalb von Workspace und Runner-Home. `handoff.json` liefert die übrigen Werte
für die [Runnerkonfiguration](DEPLOYMENT.md#einen-isolierten-projekt-runner-starten).
Die Lease niemals mit `cat`, Debug-Ausgaben oder Shell-Tracing ausgeben.

`seed` prüft Passkeyregistrierung, Team/Projekt, Vault-Schreiben und reinen
Metadatenkatalog, gesperrten Klartextabruf, Memory-Vorschlag/Verifikation/lokale
Suche/Löschung, Codegraph-Quelle/Kanten/Auswirkungen, private Vorschauen,
Sandboxgrenzen, Freigabelink/Widerruf sowie den projektgebundenen JWT-Zugang zur
bestehenden Sitzungs-API. Ein verifiziertes Memory und ein synthetischer Vaultwert
bleiben für den Persistenztest erhalten.

`EVOLVED_TEST_GRAPH_SYMBOL` ist optional; ohne Symbol erscheint der Codegraph-Test
ausdrücklich als `skipped`. Für eine vollständige Stackabnahme wie oben setzen.
Ein konfiguriertes, aber fehlendes Symbol oder ein ausgefallener Dienst ist ein
Fehler. Cloud-Memory bleibt deaktiviert, beide Projektbudgets sind null.

## Neustart, Wiederanlauf und Widerruf

Nach einem vom Betreiber ausgeführten Neustart **desselben Teststacks**:

```sh
node web/scripts/evolved-live-check.mjs persist
```

Dieselbe Origin, denselben Workspace und dasselbe Ausgabeverzeichnis verwenden.
Der virtuelle Passkey wird wiederhergestellt und durch eine echte Anmeldung erneut
geprüft. Vault-Metadaten, verifiziertes Memory, Codegraph, Vorschau und bestehende
Runner-Lease müssen erhalten sein. Die Lease muss noch gültig sein; das Skript
verlängert sie nicht stillschweigend. Sitzungscookie und Browserzustand werden
privat aktualisiert. Der Bootstrapcode wird nicht erneut gelesen.

Ist ein Erstlauf **nach** Konto- und Projektanlage fehlgeschlagen, lässt sich die
Abnahme ohne Datenbankeingriff fortsetzen:

```sh
node web/scripts/evolved-live-check.mjs resume
```

`resume` verlangt den privaten Handoff und virtuellen Testpasskey. Nach der
Anmeldung müssen synthetischer Anzeigename, Benutzer-ID, Adminrolle, Team,
Projekt-ID, Workspace und eingeschränktes Profil übereinstimmen. Bereits im
Handoff verzeichnete Objekte werden wiederverwendet; fehlende Abnahmeobjekte
werden ergänzt. Das ist kein Ersatz für den getrennten `persist`-Nachweis nach
einem echten Neustart. Vor Konto-/Projektanlage fehlgeschlagene Erstläufe bleiben
zur Untersuchung erhalten und erfordern einen kontrolliert neu eingerichteten
isolierten Teststand.

Nachdem die Runnerabnahme abgeschlossen ist:

```sh
node web/scripts/evolved-live-check.mjs revoke
```

Das widerruft ausschließlich die im Handoff gespeicherte Testlease und prüft,
dass deren Authority-Endpunkt mit `401` antwortet. Der Betreiber prüft zusätzlich,
dass der echte Runner daraufhin beendet wird. Das Skript stoppt selbst keine
Container. Weitere Prüf-/Kontodaten bleiben bis zum gezielten Abbau des
synthetischen Stands bestehen.

Die abschließende JSON-Ausgabe enthält nur Prüfergebnisse, Projekt-ID und den
privaten Ausgabepfad, keine Cookie-/Lease-/Passkeywerte. Debug-Logging von
Playwright wird vorsorglich abgeschaltet. Bei Fehlern bleibt der private Zustand
erhalten; `seed` darf diesen nicht überschreiben.

Lokale Regressionen für HTTPS-/Workspace-Grenzen und private Dateien:

```sh
node --test web/scripts/evolved-live-check.test.mjs
node --check web/scripts/evolved-live-check.mjs
```
