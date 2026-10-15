# HAPI evolved bedienen

Öffne die vom Betreiber eingerichtete private HTTPS-Adresse. Der Arbeitsbereich
ist unter `/evolved` erreichbar. Über „Sessions öffnen“ gelangst du zu den
Agentengesprächen; „Evolved“ führt zurück. Oben wählst du das aktive Projekt.
Tresor, Wissen, Codegraph, Runner und Sessions beziehen sich auf dieses Projekt.
Auf dem Smartphone lässt sich die Tab-Leiste horizontal verschieben. Die PWA
kann über die Installationsfunktion des Browsers zum Startbildschirm hinzugefügt
werden; Anmeldung und aktuelle Projektdaten benötigen eine Verbindung zum Hub.

## Erstes Konto und Wiederherstellung

1. Trage deinen Benutzernamen und den Einrichtungscode des Betreibers ein.
2. Wähle „Passkey erstellen“ und bestätige mit deinem Gerät oder Sicherheitsschlüssel.
3. Sichere die einmalig angezeigten Wiederherstellungscodes außerhalb von HAPI.
   Jeder Code ist einmal verwendbar. Bestätige die sichere Ablage und fahre fort.
4. Erstelle unter „Team & Konto“ ein Team und unter „Projekte“ dein erstes Projekt.

Eingeladene Personen öffnen ihren Einladungslink und erstellen einen eigenen
Passkey. Einladungen sind befristet. Das Konto verwendet den vom Administrator
festgelegten Benutzernamen. Nach einem Seitenneuladen kannst du eine bereits
begonnene Passkeyeinrichtung innerhalb von zehn Minuten fortsetzen. Ist dieses
Zeitfenster abgelaufen, benötigst du eine neue Einladung beziehungsweise beim
allerersten Konto einen neuen Einrichtungscode vom Betreiber.

Unter „Team & Konto“ kannst du weitere Passkeys hinzufügen, Passkeys entfernen
und Wiederherstellungscodes erneuern. Der letzte Passkey lässt sich erst nach
Anlegen eines Ersatzes entfernen. Das Entfernen eines Passkeys widerruft auch
andere Anmeldungen und Runner-Zugänge dieses Kontos. Die aktuelle, frisch
bestätigte Anmeldung bleibt erhalten.

Bei Verlust des Passkeys wähle auf der Anmeldeseite „Passkey verloren“, gib
Benutzername und einen Wiederherstellungscode ein und lege anschließend unter
„Team & Konto“ einen Ersatz-Passkey an. Entferne den verlorenen Passkey danach.
Sensible Änderungen verlangen eine Passkey-Bestätigung, die höchstens fünf
Minuten zurückliegt. HAPI fordert diese bei Bedarf während der Aktion an.

## Teams, Projekte und Profile

Teamadministratoren können Personen einladen, deren Teamrolle ändern oder sie
aus dem Team entfernen. Unter „Projektrollen“ lassen sich abweichende Rollen
für vorhandene Teammitglieder setzen. „Teamrolle verwenden“ entfernt eine solche
Überschreibung und stellt die Teamrolle wieder her; der Projektzugriff bleibt bestehen.
Für vollständigen Rechteentzug das Mitglied aus dem Team entfernen.
Ein Projekt verleiht keinen Zugang zu einem fremden Team.

| Rolle | Möglichkeiten im Projekt |
| --- | --- |
| Lesend | Sessions, Wissenseinträge, Codegraph, Tresormetadaten und registrierte Vorschauen ansehen |
| Mitglied | Zusätzlich reguläre Agentenarbeit, Wissen vorschlagen/verifizieren/vergessen, Indizierung und freigegebene Ressourcenaktionen |
| Administrator | Zusätzlich Rollen, Profil, Tresorwerte, Verarbeitungsbudget, Runner-Zugänge und Vorschaufreigaben verwalten |

Nur Systemadministratoren können beim Anlegen eines Projekts ein absolutes
Repository-Verzeichnis verknüpfen; dafür ist eine frische Passkey-Anmeldung nötig.
Der Betreiber muss diesen Verzeichnisbereich freigegeben haben. Der Pfad wird für
Codegraph, belegte Dateiquellen und Vorschauen verwendet. Teamadministratoren können
Projekte ohne Verzeichnis für Tresor und Memory anlegen.

Das Ausführungsprofil ist eine weitere Grenze für Agentenaktionen:

- **Eingeschränkt (`restricted`)** ist der Standard für Planung und lesende Arbeit.
- **Arbeitsbereich (`workspace`)** erlaubt projektbezogene Bearbeitung innerhalb
  der dafür eingerichteten Agenten- und Runnergrenzen.
- **Erweitert (`extended`)** erlaubt erweiterte Agentenmodi für ausdrücklich
  freigegebene Projekte.

Ein Profilwechsel benötigt eine frische Passkey-Anmeldung und macht vorhandene
Runner-Zugänge für das bisherige Profil unbrauchbar. Rollen, Ressourcenfreigaben
und die vom Betreiber eingerichtete Isolation gelten weiterhin.

## Tresor und Ressourcenaktionen

Als Projektadministrator öffnest du „Tresor“, vergibst einen Namen und trägst
den geheimen Wert ein. „Verschlüsselt speichern“ legt ihn im separaten lokalen
Vault ab. Nach dem Speichern zeigt die Übersicht nur Name, Version und
Änderungszeit. Das Eingabefeld wird geleert. Gespeicherte Werte lassen sich nicht
im Browser zurücklesen.

„Rotieren“ ersetzt einen Wert; „Löschen“ entfernt ihn nach Bestätigung.
Unter „Freigegebene Ressourcen“ stehen die vom Betreiber vorkonfigurierten
Aktionen. „Ausführen“ verwendet die benötigten Zugangsdaten im Broker und liefert
einen Status zurück. Agenten und Browser erhalten dabei keine Geheimwerte oder
beliebigen Antwortinhalte. Ein leerer Ressourcenbereich bedeutet, dass für das
Projekt noch keine Aktion eingerichtet wurde.

## Persistentes Gedächtnis

Unter „Gedächtnis“ kannst du eine Erkenntnis mit Titel, Inhalt und Quelle
vorschlagen. Bei Quellcode oder Anhängen gibst du den projektbezogenen Dateipfad
an; bei manuellen Sessionreferenzen die Session- und Nachrichten-ID. Solche
Referenzen werden als nicht automatisch verifiziert gekennzeichnet. Der Server
berechnet bei Dateiquellen die Prüfsumme des Dateiinhalts, bei manuellen
Erkenntnissen und Chatreferenzen die Prüfsumme des eingereichten Inhalts. Zugangsdaten und ausgeschlossene sensible Dateien werden nicht
als Wissen aufgenommen.

Ein neuer Eintrag hat den Status „Vorgeschlagen“. Prüfe Inhalt und Quelle und
wähle erst danach „Verifizieren“. Quellen und Prüfsummen sind am Eintrag
aufklappbar. „Vergessen“ entfernt den Eintrag aus den Suchergebnissen und veranlasst
die Bereinigung abgeleiteter Graphdaten. Bei einem vorübergehend nicht
verfügbaren Graphdienst wird diese Bereinigung später wiederholt.

Die lokale Textsuche funktioniert ohne Cloud-Verarbeitung. Die ausdrücklich
gewählte Hybridsuche verwendet den verbundenen Graphdienst und das
Verarbeitungsbudget. Statusfilter grenzen die angezeigten Ergebnisse ein.

Projektadministratoren konfigurieren unter „Verarbeitung und Budget“:

1. Cloud-Verarbeitung für dieses Projekt erlauben.
2. Monatslimit und Limit je Auftrag in USD festlegen.
3. Automatische Wissensverarbeitung aktivieren und speichern.

Ein Budget von null gibt keine Ausgaben frei. Der Betreiber muss zusätzlich
Provider und Modell konfigurieren. Die Anzeige zeigt Verbrauch, Reservierungen
und Monatslimit. Bei ausgeschöpftem Budget oder fehlendem Provider bleiben
lokale Einträge und die lokale Suche nutzbar.

## Codegraph erkunden

Ein eingerichtetes Repository und ein erreichbarer Codegraphdienst sind nötig.
Die Statusanzeige nennt Indexzustand, Dateiüberwachung und ausstehende Dateien.
„Neu indizieren“ fordert eine Aktualisierung an.

Suche nach Symbol oder Dateiname und wähle einen Treffer. Im Graphen kannst du
Knoten anklicken oder per Tastatur auswählen, die Ansicht ziehen und mit Mausrad
oder den Zoomtasten vergrößern. „Ansicht zurücksetzen“ stellt den Ausgang zurück.
Die Detailansicht zeigt Quelltext, Aufrufer und aufgerufene Symbole. „Graph auf
dieses Symbol fokussieren“ beschränkt den Ausschnitt.

„Auswirkungen“ zeigt abhängige Symbole. Unter „Betroffene Dateien und Tests“
trägst du geänderte, repository-relative Pfade ein, einen pro Zeile. Ergebnisse
stammen aus dem Codeindex und ersetzen keinen tatsächlichen Testlauf.

## Runner anbinden

Unter „Runner“ erstellt ein Projektadministrator einen befristeten Zugang:

1. Namen und Gültigkeitsdauer zwischen einer und 168 Stunden wählen.
2. Nur die benötigten Berechtigungen aktivieren. Ressourcenaktionen erfordern
   zusätzlich die freigegebenen Ressourcen-IDs.
3. Mit frischem Passkey bestätigen und die einmalige Operator-Datei herunterladen.
4. Dem Betreiber zur geschützten Ablage beim Runner-Proxy übergeben. Die Datei
   enthält den Lease-Schlüssel als Text und benötigt Zugriffsrechte `0600`.
   Der Proxy verwendet sie über `EVOLVED_RUNNER_LEASE_FILE`.
5. Sichere Ablage bestätigen und den Schlüssel schließen.

Der Schlüssel gehört außerhalb des Projektverzeichnisses und bleibt beim
Operator beziehungsweise Runner-Proxy. Er wird weder in Agentenprompts noch in
Logs oder Wissenseinträge kopiert. Der Proxy tauscht ihn gegen kurzlebige,
projektgebundene Berechtigungen. Die Übersicht zeigt Laufzeit und Status;
„Widerrufen“ entzieht den Zugang. Nach Ablauf oder Profilwechsel ist ein neuer
Zugang nötig. Die eigentliche Runnerinstallation beschreibt die Betreiberanleitung.

## Vorschauen und Freigaben

Baue die gewünschte Webseite im Projekt. Ein Projektadministrator registriert
unter „Vorschauen“ einen Namen und das absolute Buildverzeichnis, zum Beispiel
`/work/projekt/dist`. Der Ordner muss im Projekt liegen und für die Startseite
eine `index.html` enthalten. Relative Assetpfade ermöglichen die Darstellung
unter der Vorschauadresse.

„Vorschau öffnen“ öffnet einen neuen Tab. Die Vorschau läuft in einer
Browsersandbox: Sie kann weder auf die angemeldete HAPI-Oberfläche noch auf deren
Cookies, lokalen Browserspeicher oder API zugreifen. Webseiten, die solche
Funktionen benötigen, laufen in dieser statischen Vorschau daher nur eingeschränkt.

Über „Freigaben“ kann ein Administrator einen Link für bis zu 24 Stunden
anlegen. Empfänger benötigen dafür keine HAPI-Anmeldung, müssen aber die private
Hubadresse erreichen können. Der Link ist selbst die Zugangsberechtigung; gib ihn
gezielt weiter. „Freigabe widerrufen“ deaktiviert ihn sofort. „Vorschau entfernen“
entfernt die Registrierung und ihre Freigaben; die gebauten Dateien bleiben bestehen.
