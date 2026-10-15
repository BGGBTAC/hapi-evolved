# Wenn nach einem Update noch die alte Oberfläche erscheint

Ein erfolgreicher Serverwechsel aktualisiert nicht automatisch ein bereits
geöffnetes Browserdokument. Die installierte PWA kann außerdem die Startseite
`/` aus dem Cache ihres noch aktiven Service Workers laden. Ein gewöhnlicher
Reload reicht dann nicht aus.

## Bereits geöffnete ältere Version

Öffne **`/evolved` auf demselben Hub in einem separaten Tab**. Dieser Pfad wird
nicht vorab im Service Worker gespeichert und lädt die aktuelle Oberfläche vom
Server. Dabei wird kein wartender Worker aktiviert und kein anderer Tab neu
geladen. Anmeldung, lokale Einstellungen und Entwürfe anderer Tabs bleiben
erhalten. Dieser Ablauf wurde mit zwei echten Produktionsbuilds und einem
ungesendeten Entwurf im zweiten Tab geprüft.

Alternativ: zuerst offene Entwürfe sichern, dann sämtliche Tabs und PWA-Fenster
dieses Hubs schließen und erneut öffnen. Der wartende Worker kann dann regulär
aktiv werden. Die Anwendung verlangt dafür keine Cache-, Cookie- oder
Speicherlöschung und keine Neuinstallation.

## Dauerhafte Korrektur

Der Updatehinweis wird einmal oberhalb der Anmeldung angezeigt, auch ohne
ausgewähltes Projekt und bei Verbindungsfehlern. Die Registrierung lädt einen
anderen bereits aktualisierten Tab nicht mehr automatisch neu, wenn ein Update
in einem Tab bestätigt wird. Nur der bestätigende Tab fordert einen Reload an.
Noch laufender alter JavaScript-Code kann allerdings seine bisherigen
automatischen Reload-Listener behalten. Deshalb vor einer ausdrücklichen
Aktivierung offene Arbeit in älteren Tabs sichern; für die reine Ansicht der
neuen Oberfläche genügt der direkte Einstieg oben.

HTML, Service Worker und Manifest erhalten bei beiden Auslieferungswegen
explizite `no-store`-Header. Dateien mit Versionshash im Namen dürfen lange im
HTTP-Cache bleiben. Diese Header löschen keinen bestehenden Service-Worker-Cache.

Eine ausdrücklich gewählte Hub-Adresse hat weiterhin Vorrang vor der Adresse
der Webseite. Bei einer abweichenden Oberfläche deshalb auch den verbundenen
Hub prüfen. Die Aktualisierung verändert diese Auswahl nicht automatisch.

## Reproduktion

`web/scripts/evolved-pwa-upgrade-check.mjs` startet einen eigenen Hub und Vault
mit synthetischem Konto, virtuellen Passkeys und zwei Browser-Tabs. Ein alter
und ein neuer Produktionsbuild werden am gleichen lokalen Origin angeboten.
`EVOLVED_PWA_OLD_DIST` bestimmt den alten Build, `EVOLVED_PWA_NEW_DIST` optional
den neuen. `PLAYWRIGHT_CHROME_PATH` kann ein vorhandenes Chromium auswählen.
Der Nachweis enthält keine Daten einer bestehenden Installation.
Die [Review- und Testergebnisse](reviews/pwa-update-2026-10-15.json) dokumentieren
auch den widerlegten ursprünglichen Tab-Sicherheitsclaim und dessen Korrektur.
