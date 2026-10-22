# Projektweiter MCP-Shop

Unter **Projekt → MCP-Shop** verbindest du Context7 oder eigene Remote-MCP-Server
zentral. Die freigegebenen Werkzeuge stehen den unterstützten Claude- und
Codex-Sitzungen dieses Projekts über den vorhandenen HAPI-Zugang zur Verfügung.
Es sind keine API-Schlüssel oder zusätzlichen MCP-Konfigurationen im Runner nötig.

Der optionale [Projektbrowser (Camofox)](BROWSER.md) erscheint als eigene Karte im MCP-Shop. Er ist
kein Remote-MCP: eigene Konfiguration, eigene Werkzeuge `evolved_browser_*`, eigener Sidecar je Projekt.
Die Regeln für Remote-MCPs (nur öffentliches HTTPS) gelten unverändert.

## Context7 einrichten

1. Öffne im gewünschten Projekt den **MCP-Shop** und wähle **Context7**.
2. Trage optional deinen Context7-API-Schlüssel ein. Ohne Schlüssel hängt die
   Nutzung von den anonymen Kontingenten des Anbieters ab.
3. Speichere die Verbindung und prüfe sie mit **Verbindung prüfen**.
4. Gib die gefundenen Werkzeuge frei und aktiviere die Verbindung.

Der vorbereitete Eintrag verwendet den offiziellen Endpunkt
`https://mcp.context7.com/mcp`. Schlüssel werden als Bearer-Authentisierung
übertragen; siehe die [Context7-Anleitung](https://context7.com/docs/resources/all-clients).
`resolve-library-id` findet eine Bibliothek, `query-docs` liefert passende
Dokumentation. Beide werden für Context7 als lesend vorgeschlagen. Die Freigabe
bleibt eine ausdrückliche Entscheidung des Projektadministrators.

Der Verbindungstest führt ausschließlich Initialisierung und Werkzeugabfrage
(`tools/list`) aus. Er startet keine Dokumentationssuche und keine schreibende
Aktion. Ein erfolgreicher Test bestätigt deshalb noch keinen erfolgreichen
Werkzeugaufruf oder ein verbleibendes Anbieter-Kontingent.

## Eigene Server und Freigaben

Unterstützt sind öffentliche HTTPS-Endpunkte auf Port 443 mit **Streamable HTTP**,
JSON- oder SSE-Antworten. Wähle keine Anmeldung, Bearer-Schlüssel oder einen
zulässigen `X-*`-Schlüsselheader. Lokale Prozesse, `npx`, private Netzadressen,
Weiterleitungen und OAuth-Anmeldung gehören nicht zu dieser Version. Der Hub
benötigt direkten HTTPS-Zugang. Mit gesetzten HTTP-Proxy-Umgebungsvariablen
verweigert diese Version die Verbindung, bevor sie Netzwerkdaten versendet;
der Status nennt dann die erforderliche Betreiberkorrektur.

Neue Verbindungen starten deaktiviert. Nur menschliche Projektadministratoren
mit frischer Passkey-Anmeldung dürfen Schlüssel und Freigaben ändern. Mitglieder
können freigegebene Werkzeuge benutzen, Betrachter nur Metadaten ansehen. Das
Zielfeld einer gespeicherten Verbindung ist unveränderlich; für einen anderen
Server legst du eine neue Verbindung an.

**„Nur lesend“ ist deine Sicherheitsentscheidung.** Der Server kann diese
Freigabe nicht selbst erteilen. Ein so freigegebenes Werkzeug kann der Agent ohne
Einzelbestätigung aufrufen. Es kann trotzdem Daten an den Anbieter senden und
Kosten verursachen. Markiere Werkzeuge mit Änderungen an externen Systemen
niemals als lesend. Im eingeschränkten Projektprofil sind ausschließlich diese
lesenden Werkzeuge verfügbar. Allgemeine Aufrufe verwenden die normale
Freigabe des Agentenclients; dessen ausdrücklich gewählter unbeaufsichtigter
Betriebsmodus kann diese Freigabe beeinflussen.

Ändert ein Server die Beschreibung oder das Eingabeschema eines freigegebenen
Werkzeugs, stoppt der Aufruf. Prüfe die Verbindung erneut und gib geänderte
Werkzeuge neu frei. Gleichzeitige Änderungen in zwei Browserfenstern werden
abgewiesen; lade den aktuellen Stand neu.

## Verwendung durch Agenten

| Werkzeug | Zweck |
| --- | --- |
| `evolved_mcp_servers` | Aktivierte Verbindungen im aktuellen Projekt finden |
| `evolved_mcp_tools` | Freigegebene Werkzeuge, Eingabeschemas und aktuelle Version lesen |
| `evolved_mcp_query` | Ausschließlich ausdrücklich als lesend freigegebene Werkzeuge ausführen |
| `evolved_mcp_call` | Andere freigegebene Werkzeuge mit normaler Aktionsfreigabe ausführen |

Der Agent übergibt bei jedem Aufruf die aktuelle Verbindungs- und Katalogversion.
Nach einer Konfigurationsänderung muss er die Werkzeugliste neu laden. Der Hub
prüft Projektmitgliedschaft, Profil, Runner-Zugang und Freigabe erneut vor dem
Versenden. Bestehende `runner:connect`-Capabilities bleiben auf ihr Projekt
begrenzt; der Shop erweitert keine Lease oder deren Laufzeit.

Neue Verbindungen werden dynamisch sichtbar. Bereits laufende Agentenprozesse
mit einer älteren HAPI-Version brauchen nach dem Softwareupdate einmal einen
Neustart beziehungsweise eine Wiederaufnahme, damit die vier Gateway-Werkzeuge
registriert werden. Andere geerbte Agentadapter sind hier nicht als unterstützt
getestet. Serverbeschreibungen und Ergebnisse sind externe Daten, keine
Berechtigung oder vertrauenswürdige Anweisung.

## Fehler, Historie und Abschalten

Die Oberfläche trennt Aktivierung und Verbindungszustand: ungeprüft, erreichbar,
Anmeldung erforderlich, nicht erreichbar oder Katalog geändert. **Letzte Aufrufe**
zeigt höchstens 50 abgeschlossene Versuche je Verbindung mit Werkzeugname,
Zeitpunkt, Dauer und Ergebnisstatus. Argumente, Antworten und Schlüssel werden
dort nicht gespeichert. Ein Werkzeugfehler bleibt auch für den Agenten ein
MCP-Fehler (`isError`), statt als Erfolg ausgegeben zu werden.

Deaktivieren sperrt weitere Aufrufe auch während eines laufenden Verbindungstests.
Ein verspätetes Testergebnis kann die Verbindung nicht wieder aktivieren. Bereits
beim Anbieter gestartete Aktionen lassen sich dadurch nicht rückgängig machen.
Nach einem Timeout oder nach einer Berechtigungsänderung **nach dem Absenden**
lautet der Zustand „Ergebnis unklar – nicht erneut ausführen“
(`mcp_outcome_unknown`). Der Anbieter könnte die Aktion bereits ausgeführt haben.
Prüfe dort den tatsächlichen Zustand, bevor du über einen neuen Aufruf entscheidest.
Ein normaler Versionskonflikt vor dem Absenden bleibt davon getrennt.

Die Verbindung begrenzt Antwortgröße, Kataloggröße, Laufzeit und parallele
Aufrufe. Der Hub prüft alle aufgelösten IP-Adressen und bindet die tatsächliche
HTTPS-Verbindung an eine geprüfte öffentliche Adresse. Schlüssel liegen
verschlüsselt im getrennten Vault; nur der Hub löst sie intern für den jeweiligen
Aufruf auf. Browser und Agenten erhalten keine Schlüssel zurück.

**Verbindung entfernen** entfernt Konfiguration und gespeicherten Schlüssel in
HAPI-eVolved. Das widerruft den Schlüssel nicht beim externen Anbieter. Eine
Projektlöschung entfernt ebenfalls die zugehörigen Verbindungen und Historie.
