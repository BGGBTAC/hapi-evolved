# HAPI-eVolved bedienen

Öffne die vom Betreiber eingerichtete private HTTPS-Adresse. Der Arbeitsbereich
ist unter `/evolved` erreichbar. Über „Sessions“ gelangst du zu den
Agentengesprächen; die Marke oben in der Sessionliste führt zurück. Oben wählst du das aktive Projekt.
Tresor, Wissen, Codegraph, Runner und Sessions beziehen sich auf dieses Projekt.
Auf dem Smartphone erreichst du Übersicht, Sessions und Projekte über die untere
Navigation. „Mehr“ öffnet alle weiteren Werkzeuge, Einstellungen und Abmelden.
Am Desktop stehen dieselben Bereiche in der Seitenleiste. Direktlinks und
Zurück/Vorwärts behalten den Projektkontext; siehe [DESIGN.md](DESIGN.md). Die PWA
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

Die Projektübersicht zeigt unter „Kapazität“ gemeldete Claude-/Codex-Limits mit
Stand und Rücksetzzeit. Diese Werte gelten für das jeweilige Anbieterkonto,
nicht allein für das Projekt. Fehlende Werte bleiben unbekannt; veraltete
Fenster werden gekennzeichnet. Datenquellen, Aktualisierung und API erklärt
[Gemeldete Abo-Kapazität](CAPACITY.md).

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

Beim Anlegen reichen **Projektname und Team**: Im Hintergrund entsteht für jedes
neue Projekt ein eigener Ordner. Gleiche Namen führen trotzdem zu getrennten
Verzeichnissen. Die Projektkarte zeigt nach dem Anlegen den tatsächlichen Pfad.

**Neue Sessions starten automatisch im Ordner des aktiven Projekts.** Du musst
den Pfad weder suchen noch eingeben. Das Formular zeigt den Projektordner nur
zur Orientierung; alte Pfadvorschläge, gespeicherte Formulare und Direktlinks
ändern ihn nicht. Beim Projektwechsel wird der Ordner des neuen Projekts verwendet.
Der Server prüft den Projektordner ebenfalls. Ist er nicht erreichbar, wird der
Start mit einer verständlichen Meldung gestoppt; es gibt keinen Ausweichordner.
Zusätzliche Worktrees außerhalb dieses Ordners und der Import fremder nativer
Sessions sind in diesem Startformular nicht verfügbar.

Systemadministratoren können optional **„Ordner manuell festlegen oder wählen“**
öffnen und einen vorhandenen, vom Betreiber freigegebenen Serverordner verknüpfen.
Die Auswahl lädt Verzeichnisse vom Server, nicht vom eigenen Rechner. Das Verknüpfen
verlangt eine frische Passkey-Anmeldung. Schon belegte, verschachtelte oder über
Symlinks erreichbare Projektordner werden nicht erneut vergeben. Ein deaktivierter
manueller Modus verwendet immer einen neuen automatischen Ordner.

Bestehende Projekte und ihre Pfade werden nicht automatisch umgestellt. Das Entfernen
eines Projekts löscht dessen Quelldateien nicht. Der Pfad dient Codegraph, belegten
Dateiquellen, Vorschauen und dem isolierten Projekt-Runner.

Unter **GitHub** verbindet ein Projektadministrator GitHub und vergibt Repository-
Lese- oder Schreibrechte. Danach verwenden Projekt-Agenten normale Git-Befehle
ohne eigene GitHub-Anmeldung. Einrichtung und Grenzen stehen in [GITHUB.md](GITHUB.md).

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
Der Index wird automatisch aufgebaut; du musst keinen Graphen von Hand anlegen.
**Index wird aufgebaut** aktualisiert sich automatisch. **Noch kein Code im Index**
ist bei einem neuen Projekt normal: Klone ein Repository in dessen Projektordner
oder füge unterstützte Codedateien hinzu. Eine GitHub-Freigabe allein klont noch
kein Repository. Die Dateiüberwachung erkennt neue und geänderte Quellen.

**Nicht eingerichtet** bedeutet, dass ein Projektordner oder die Anbindung des
Codegraph-Dienstes fehlt; der Hinweis nennt den nächsten Schritt. Ein nicht
erreichbarer Dienst und eine fehlgeschlagene Indizierung werden dagegen als echte
Fehler angezeigt. **Status aktualisieren** prüft die Verbindung erneut;
**Neu indizieren** fordert für schreibberechtigte Mitglieder einen neuen Indexlauf
an. Ein Fehler beim Laden eines Ausschnitts wird nicht als leerer Index ausgegeben.

Suche nach Symbol oder Dateiname und wähle einen Treffer. Im Graphen kannst du
Knoten anklicken oder per Tastatur auswählen, die Ansicht ziehen und mit Mausrad
oder den Zoomtasten vergrößern. „Ansicht zurücksetzen“ stellt den Ausgang zurück.
Die Detailansicht zeigt Quelltext, Aufrufer und aufgerufene Symbole. „Graph auf
dieses Symbol fokussieren“ beschränkt den Ausschnitt.

„Auswirkungen“ zeigt abhängige Symbole. Unter „Betroffene Dateien und Tests“
trägst du geänderte, repository-relative Pfade ein, einen pro Zeile. Ergebnisse
stammen aus dem Codeindex und ersetzen keinen tatsächlichen Testlauf.

## Codex- und Claude-Abos verbinden

Öffne **Abos verbinden**, wähle das Projekt und klicke beim Anbieter auf **Verbinden**. HAPI richtet einen fehlenden Projektdienst automatisch ein und führt dich durch die offizielle Anbieteranmeldung: Codex mit Gerätecode, Claude mit Bestätigungscode. Status, Abbruch und Abmeldung stehen direkt in der Oberfläche. Ein Terminal ist dafür nicht erforderlich.

Die Anmeldung bleibt im privaten Projektdienst erhalten. Die Einzelheiten, Schutzgrenzen und Wiederaufnahme nach einem Neuladen stehen unter [Abos verbinden](PROVIDER_LOGIN.md).

## Wiederverwendbare Agenten, Plugins und Darstellung

Unter **Agenten** legst du Spezialisten mit Namen, Aufgabe, Anweisungen, bevorzugtem Anbieter/Modell und optionalen Plugin-Skills an. Die Definitionen sind in allen Projekten und Ausführungsprofilen verfügbar. Beim Start wählst du ein Projekt und gibst den konkreten Auftrag an. Dateien, Sitzungen und Rechte bleiben an dieses Projekt gebunden. Globale Definitionen verwaltet der Installationsadministrator.

**Plugins** importiert Erweiterungen aus öffentlichen GitHub-Repositorys. Vor der Installation siehst du Version, Commit und Inhalt. Aktualisierungen werden ebenfalls zuerst geprüft; Deaktivieren und Entfernen sind jederzeit möglich. Plugins können Agentenvorlagen, Skills und Farbprofile beisteuern. Das Format und seine Grenzen beschreibt [Erweiterungen](EXTENSIONS.md).

Über **Darstellung** wählst du ein Farbprofil mit Vorschau und den hellen, dunklen oder OLED-Modus. Die abgestimmten Profile Ocean, Iris und Sand passen sich dem hellen oder dunklen Modus an; weitere vorhandene Profile bleiben aufklappbar. Deine Auswahl bleibt für diesen Browser gespeichert, individuelle Farbanpassungen haben weiterhin Vorrang. Installierte Plugin-Profile erscheinen ebenfalls dort und wählen ihren vorgesehenen hellen oder dunklen Modus. Nach Deaktivierung des Plugins oder Abmeldung fällt die Oberfläche auf das Standardprofil zurück.

## Runner anbinden

Ein **Runner** ist der Arbeitsdienst auf deinem Server. Er startet Claude oder
Codex, bearbeitet Projektdateien und führt Git-Befehle aus. Damit du ihn über HAPI
steuern kannst, benötigt er einen HAPI-Zugang für das Projekt.

Unter **Runner** verwaltest du zusätzliche manuelle Zugänge. Der normale Browserweg über **Abos verbinden** richtet einen verwalteten Projektdienst automatisch ein. Zusätzliche externe Runner installiert der Betreiber gemäß [Deployment-Anleitung](DEPLOYMENT.md).

**Dauerhaft – bis zum Widerruf** ist für deinen eigenen Runner vorausgewählt.
Dieser Zugang hat kein Ablaufdatum. Wähle **Befristet**, wenn du den Zugang nur für
eine bestimmte Zeit erlauben möchtest: maximal 168 Stunden, also 7 Tage. Die
Stunden sind kein Rechenstundenkontingent und kein Zeitlimit für dein Anbieterabo.

Nach Ablauf eines befristeten Zugangs stoppt der verwaltete Runner; für weitere
Arbeit muss ein Administrator einen neuen Zugang erstellen und der Betreiber ihn
beim Runner hinterlegen. Widerruf, Profilwechsel oder Änderungen der zugehörigen
Rollen machen auch dauerhafte Zugänge ungültig und stoppen die Arbeit.
Projektdateien und gespeicherte Anbieteranmeldungen bleiben erhalten.

So erstellst du den Zugang:

1. Einen Namen vergeben und **Dauerhaft – bis zum Widerruf** oder **Befristet**
   wählen. Nur bei befristetem Zugang eine Gültigkeitsdauer zwischen einer und
   168 Stunden angeben.
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
projektgebundene Berechtigungen. Die Übersicht zeigt Gültigkeit und Status;
„Widerrufen“ entzieht auch einem dauerhaften Zugang die Berechtigung. Bereits
vorhandene befristete Zugänge behalten ihr Ablaufdatum; sie werden nicht
automatisch in dauerhafte Zugänge umgewandelt. Die eigentliche Runnerinstallation
beschreibt die Betreiberanleitung.

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

## Sitzungsübersicht und Entwürfe

Die angezeigte Zeit folgt der letzten sichtbaren Gesprächsnachricht. Heartbeats,
Titeländerungen und sonstige Metadaten schieben ältere Gespräche nicht nach oben.
Unter „Filter“ wählst du alle, aktive, arbeitende oder blockierte Sessions,
kombiniert mit „Nur ungelesene“. Diese Filter sind vorübergehend. Die Sortierung
„Letzte Agentenantwort“ bleibt als Browserpräferenz erhalten; Anheftungen und
Projektgruppen bleiben bestehen. Exakte lokale Zeitpunkte erscheinen beim
Überfahren der relativen Zeit. Die Metadatensuche kann Treffer einschließen oder
ausschließen, auch mit `*` und `?`; eine leere Suche zeigt weiterhin alle Sessions.

„Blockiert“ stammt ausschließlich aus einem ausdrücklichen
`AGENT_NOTIFY_SUMMARY` mit Status `blocked`. Berechtigungsfragen und ungelesene
Nachrichten bleiben getrennte Signale. Eine neue Nutzernachricht beziehungsweise
ein neuer arbeitender Turn beendet die Blockiert-Anzeige. Gelbe Zeilen und
Hinweise am oberen/unteren Listenrand führen auch zu eingeklappten oder weiter
entfernten Blockierern. Das bloße Öffnen bestätigt keinen gelösten Blocker.

Eine ausgewählte Session wird in der Seitenleiste sichtbar gemacht, ohne bereits
sichtbare Zeilen unnötig zu verschieben. Auf Desktop kannst du eine Session mit
Gesprächsinhalt in das Eingabefeld ziehen, um einen Verweis einzufügen. Das sendet
keine Nachricht. `#` am Eingabebeginn beziehungsweise Pfeil-hoch im leeren Entwurf
öffnet die Historie bereits geladener eigener Nachrichten. Persönliche Prompts
lassen sich über „Prompts“ speichern, ordnen, bearbeiten und am Cursor einfügen.
Anhänge werden bei der Textwiederverwendung nicht automatisch erneut gesendet.

## Anhänge und Dateivorschau

Neue Chat-Anhänge werden als Originaldateien im privaten Hub-Speicher abgelegt.
Sie bleiben nach Ende des Agentenprozesses abrufbar. Projektzugriff wird bei
jedem Abruf erneut geprüft; der Browser speichert Originalantworten nicht im
HTTP-Cache. Hub und CLI müssen gemeinsam auf diese Version aktualisiert werden.
Die nativen Protokollmodelle übernehmen Anhangs-IDs und Fixtureformat 2; das
ist keine Freigabe der nativen Apps für Evolved-Anmeldung oder Anhangsverwaltung.
Alte, ausschließlich temporär gespeicherte CLI-Dateien lassen sich nicht
nachträglich wiederherstellen. Die Standardquoten betragen 50 MiB je Datei,
512 MiB und 1000 Dateien je Namespace sowie 2 GiB insgesamt. Nicht gesendete
Uploads zählen mit; Sessionlöschung bereinigt ihre Originale. Die Gesamtgrenze schützt
auch den gemeinsamen Datenträger; sie reserviert keinen garantierten Anteil für
jedes Projekt. Der Betreiber kann beide Bytequoten konfigurieren.

Die Quelle eines Shared-Forks lässt sich erst löschen, wenn dessen Anhänge sicher
im Kind vorhanden sind. Bei voller Quota zuerst unbenutzte Uploads entfernen oder
den Betreiber um mehr Quota bitten. Wird das Kind nicht benötigt, kann es zuerst
gelöscht werden. Fehlt die belegbare Forkgrenze, bleibt die Quelle ebenfalls
erhalten; es wird keine Grenze geraten und kein Original stillschweigend gelöscht.
Alte laufende CLI-Prozesse ohne Anhangsfähigkeit erhalten beim Sendeversuch einen
Upgradefehler; der Text wird dabei ebenfalls nicht gesendet.

Geeignete undurchsichtige Bilder über 4 MiB werden automatisch auf maximal
2048 Pixel Kantenlänge verkleinert und als JPEG mit Qualitätswert 85 hochgeladen,
sofern das kleiner ist. GIF, SVG, transparente Bilder und nicht unterstützte
Formate bleiben unverändert. Dekodierung erfolgt einzeln; außergewöhnlich große
Raster über 40 Millionen Pixel bleiben ebenfalls unverändert. Unter
Einstellungen → Chat → Bild-Uploads kannst du Originale als Standard wählen.
Der Anhang zeigt eine erfolgte Verkleinerung und bietet in aktiven Sessions
„Original senden“. Während eines Versionswechsels ist Senden gesperrt. Die
unveränderte Originaldatei bleibt für diesen Wechsel im geöffneten Entwurf
verfügbar; nach einem vollständigen Neuladen muss ein nicht mehr vorhandenes
Original gegebenenfalls erneut ausgewählt werden.

Lange eingefügte Texte bieten ausdrücklich „Als Text einfügen“ oder „Als Datei
anhängen“. Bei fehlgeschlagenem Upload bleibt die Auswahl erhalten. Lange eigene
Nachrichten werden eingeklappt angezeigt; Kopieren verwendet weiterhin den
vollständigen Text. Terminalauswahlen können ebenfalls in den Chatentwurf
übernommen werden.

Markdown-Dateivorschauen öffnen relative Links aus dem Verzeichnis der gerade
angezeigten Datei. Lokale Bilder werden mit Projektberechtigung geladen
(maximal 5 MiB je Vorschaubild). Externe HTTPS-Bilder laden erst nach „Externe
HTTPS-Bilder laden“ direkt im Browser, ohne Hub-Proxy und ohne Referer. Der
externe Anbieter sieht dabei die IP-Adresse. Pfade außerhalb des Workspace und
unsichere URL-Schemata bleiben gesperrt. Ist der zuständige Runner offline,
zeigt die Dateiansicht dies mit einer Wiederöffnen-/Erneut-laden-Möglichkeit an.

## Textnebenkanal und Browser-Diktat

Wenn der Betreiber Anbieter, Modell und Tokenbudget konfiguriert hat, öffnet
`/btw` eine separate Textfrage. Anbieter und Budget sind vor dem Senden sichtbar.
Nur die ausdrücklich eingegebene Frage verlässt den Host; es gibt weder
Werkzeuge noch automatisches Weiterleiten an den Agenten. Die Antwort wird als
Text angezeigt. Bei unklarem Netzwerkausgang erfolgt keine automatische erneute
Anfrage. Ein nicht verfügbarer Nebenkanal leitet `/btw` nicht an den Agenten um.
Der Frageentwurf bleibt beim Schließen erhalten und lässt sich über `/btw`
wieder öffnen; ein Sitzungs- oder Projektwechsel verwirft ihn.

Browser-Cloud-Spracherkennung ist standardmäßig aus. Der Betreiber muss
`EVOLVED_BROWSER_CLOUD_STT_ENABLED=1` setzen; anschließend bestätigst du unter
Einstellungen → Sprache die Audioübertragung und wählst „Browser Cloud“ als
Diktatanbieter. Der Browseranbieter verarbeitet das Audio; HAPI erhält Text.
Das ist keine lokale Spracherkennung. Anmeldung, Abmeldung und Projektwechsel
entziehen diese Zustimmung. Der vorhandene lokale Spracherkennungsmodus behält
seine strengeren Plattformprüfungen und fällt nicht automatisch auf Cloud zurück.

## Automatisierung und Projekt-Agenten

Projektadministratoren können unter „Automatisierung“ nach frischer
Passkey-Bestätigung Zeitpläne für vorhandene Sessions anlegen. Cron-Ausdrücke
verwenden fünf numerische Felder und UTC. Ein Lauf wird bei beschäftigter Session,
fehlender Berechtigung oder ungültigem Runner-Zugang übersprungen. Verpasste
Läufe werden nicht nachgeholt. „Dauerhaft eingereiht“ bestätigt nur die Annahme
der Nachricht, keinen erfolgreichen Agentenlauf; der Verlauf weist Fehler,
übersprungene und unklare Läufe gesondert aus.

Die Zusammenarbeit zwischen Projekt-Agenten ist zunächst ausgeschaltet. Nach
Freigabe benötigen Runner zusätzlich die passenden Rechte `peers:read`,
`peers:send` beziehungsweise `peers:manage`. Das Badge „Projekt-Agent“ bestätigt
die vom Hub geprüfte Projektherkunft. Die verlinkte Absendersession ist eine
behauptete Antwortadresse und keine sicher attestierte Einzelidentität.
