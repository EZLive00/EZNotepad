<div align="center">

# EZNotepad

> Ein **5 MB** großes Desktop-Werkzeug: Markdown-Schreiben + Text lesen/schreiben + Dateivergleich.
> Keine Installation nötig, kein Internetzugang, doppelklicken und loslegen.
> Die Oberfläche unterstützt 9 Sprachen und folgt standardmäßig der Systemsprache; unter „Einstellungen → Sprache" lässt sich manuell umschalten.

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Français](README.fr.md) | **Deutsch** | [Español](README.es.md) | [Português](README.pt.md)

[![Release](https://img.shields.io/github/v/release/EZLive00/EZNotepad)](https://github.com/EZLive00/EZNotepad/releases)
[![License](https://img.shields.io/badge/license-PolyForm--NC--1.0.0-orange)](./LICENSE)

</div>

---

## Download und Installation

Von den [Releases](https://github.com/EZLive00/EZNotepad/releases) herunterladen:

| Paket | Für wen geeignet |
|---|---|
| `EZNotepad_<版本>_x64-setup.exe` | **Installationsversion**: Installationsassistent + Dateizuordnungen, `.md` / `.txt` per Doppelklick direkt öffnen |
| `EZNotepad_<版本>_x64-portable.zip` | **Portable Version**: in einen beliebigen Ordner entpacken, `EZNotepad.exe` doppelklicken und los |

- Beide sind nicht codesigniert; beim ersten Start blockt SmartScreen einmal: „Weitere Informationen" → „Trotzdem ausführen"
- Die portable Version benötigt die WebView2-Runtime des Systems (unter Win10 / Win11 bereits integriert); sie schreibt nichts in die Registry und registriert keine Dateizuordnungen
- Derzeit gibt es nur Builds für Windows x64

---

## Screenshots

**Helles Design**

![Hauptoberfläche von EZNotepad im hellen Design](docs/screenshots/light.png)

**Dunkles Design**

![Hauptoberfläche von EZNotepad im dunklen Design](docs/screenshots/dark.png)

---

## Was es ersetzt

| Bisher | Wozu | Danach |
|---|---|---|
| Windows-Editor (Notepad) | beliebigen Text öffnen, Kodierung ändern, Logs ansehen | öffnet genauso, dazu Zeilennummern, Hervorhebung und Gliederung |
| Typora | Markdown beim Schreiben direkt sehen | drei Modi zur Auswahl, 20-mal leichter |
| BeyondCompare | zwei Dateien auf Unterschiede prüfen | nebeneinander mit Hervorhebung, Rotmarkierung auf Zeichenebene, F7/F8 springt zwischen Unterschieden |

---

## Drei Modi (ein Dropdown, passt sich dem Dateityp automatisch an)

| Modus | Was er macht | Tastenkürzel |
|---|---|---|
| **WYSIWYG** | `# ` eintippen wird zur Überschrift, `**fett**` sofort fett | `Ctrl+1` |
| **Bearbeitungsmodus** | rohes Markdown / den Quellcode sehen, mit Zeilennummern, Syntaxfärbung, Codefaltung | `Ctrl+2` |
| **Vorschaumodus** | nur lesende Darstellung, zum konzentrierten Lesen | `Ctrl+3` |

**Unterstützte Dateitypen**: `.md` (alle drei Modi), `.json` (Validierung + Hervorhebung + Fehlerlokalisierung),
`.txt` `.log` `.csv`, gängige Codedateien (`.js/.ts/.py/.rs/.go/.html/.css/.sql/.yml/...`).
**Beim Neuanlegen wirst du zuerst nach dem Typ gefragt** (Markdown / Klartext / JSON / CSV / Code); Nicht-Markdown-Dateien
bieten nur „Bearbeiten / Vorschau" und dienen als gewöhnlicher Texteditor.

## Der Bearbeitungsmodus basiert auf CodeMirror 6

Kein simples `<textarea>`, sondern das komplette Paket eines Code-Editors:

| | Beschreibung |
|---|---|
| **Syntaxfärbung** | JS/TS/JSX, Python, Rust, Go, Java, C/C++, JSON, CSS, HTML, SQL, YAML, Shell, INI, Markdown, mit inkrementellem Parsing |
| **Zeilennummern / aktive Zeile** | Zeilennummernleiste, Hintergrundfarbe der aktiven Zeile, Klammernpaarung, Codefaltung |
| **Rückgängig** | CM6s eigene transaktionsbasierte History – zuverlässiger als das contenteditable des Browsers |
| **Große Dateien** | es werden nur die sichtbaren Zeilen gerendert. Im Test: 50.000 Zeilen in 49 ms geöffnet, 100.000 Zeilen in 20 ms; im DOM bleiben nur gut hundert Zeilen |
| **Einrückung** | Tab rückt bei Auswahl den ganzen Absatz ein, ohne Auswahl die aktuelle Zeile; Shift+Tab rückt zurück; Enter übernimmt die Einrückung der Zeile darüber |
| **Klammernpaarung** | `(` eintippen ergänzt automatisch `)`, ebenso Anführungszeichen; steht der Cursor zwischen einem Paar, springt ein weiteres schließendes Zeichen zum Partner, statt es einzufügen |
| **Themen** | helles und dunkles Thema wechseln mit der App; die Syntaxfarben teilen sich dieselben CSS-Variablen mit der Vorschau |

Die Farbwerte sind nur einmal in `styles.css` unter `body[data-theme]` definiert; Editor- und Vorschau-Renderer greifen jeweils darauf zu,
so dass es nie zwei Farbpaletten gibt, die nicht zueinander passen.

Nicht verfügbare Optionen werden automatisch ausgegraut – öffnet man JSON, ist „WYSIWYG" ausgegraut, damit man es nicht versehentlich anklickt.

---

## Aufbau der Oberfläche (jede Funktion hat genau einen Einstieg)

```
┌──────────────────────────────────────────────┐
│ ▣ Datei Bearbeiten Format Ansicht Werkzeuge Hilfe  willkommen.md  － □ ✕│ ← Titelleiste (40px)
├──────────────────────────────────────────────┤
│ willkommen.md × │ test.json × │ +        Bearbeiten▾ ⌕ Speichern │ ← Tabs und Werkzeuge in einer Zeile
├────────┬──────────────────┬──────────────────┤
│        │                  │                  │
│ Gliederung │   Bearbeiten / WYSIWYG │      Vorschau        │
│        │                  │                  │
├────────┴──────────────────┴──────────────────┤
│ Zeile 1, Spalte 1 │ 36 Zeilen │ 243 Zeichen │ Markdown │ LF │ UTF-8 │ Gespeichert │
└──────────────────────────────────────────────┘
```

Über dem Inhaltsbereich gibt es nur zwei Zeilen: die Titelleiste (Menü + Dokumenttitel + Fensterknöpfe) sowie eine Zeile, in der Tabs und Werkzeuge vereint sind
(links die Tabs, rechts nur die drei häufigsten Aktionen **Moduswechsel / Suchen / Speichern**; alles andere liegt im Menü und wird nicht doppelt platziert).
Wird das Fenster schmal, schrumpfen die Werkzeuge zu reinen Symbolen.

Das Fenster hat keine System-Titelleiste (`decorations: false`): Menü, Dokumenttitel und Fensterknöpfe liegen alle in der obersten Zeile,
der freie Bereich in der Mitte dient zum Ziehen des Fensters, ein Doppelklick maximiert – wie bei VS Code, WorkBuddy und Co.
Die vier Fensterecken nutzen die nativen Win11-DWM-Rundungen; am Rand ziehen funktioniert weiterhin für die Größenänderung.
Unter „Ansicht → Dateinamen in der Titelleiste" lässt sich der Titeltext ausblenden, sodass nur Menü und Knöpfe übrig bleiben.

- **Gliederung** – nur Navigation
- **Seitenleiste** – zwei Seiten: Gliederung (hervorhebt beim Scrollen den aktuellen Abschnitt) / Dateien (Verzeichnisbaum + Inhaltssuche im ganzen Verzeichnis)
- **Werkzeugzeile** – nur die drei häufigsten Aktionen Modus, Suchen, Speichern; alle anderen Befehle laufen über das Menü
- **Textbereich** – nur Bearbeitung
- **Statusleiste** – nur Informationen; Kodierung und Zeilenende lassen sich anklicken und ändern
- **Menü** – der vollständige Einstieg für alles
- **Einstellungen** – ein Panel unter `Ctrl+,`: Thema, Schriftgröße, Oberfläche, Autospeichern, Arbeitsordner
- **Vergleichszentrale** – eigenes Vollbild-Panel, nicht mit dem Editor vermischt

---

### Seitenleiste „Dateien": Verzeichnisbaum und dateiübergreifende Suche

- Ebenen werden einzeln beim Aufklappen nachgeladen (Lazy Loading); bei großen Repos werden nicht sofort Zehntausende Dateien eingelesen
- **Rechtsklick genügt zum Ändern**: in jedem Verzeichnis neue Dateien / Ordner anlegen, Dateien umbenennen oder löschen
  - Gelöschtes landet im **System-Papierkorb** und lässt sich bei Versehen zurückholen; Ordner werden nur geleert, wenn sie leer sind – pauschal wird nichts ausradiert
  - Bei Umbenennen oder Löschen wandert der bereits geöffnete Tab mit (niemand schreibt auf den alten Pfad zurück)
- Die Suche läuft in Rust, überspringt Binärdateien und Dateien ab 4 MB und liefert höchstens 200 Treffer
- `.*` am Suchfeld schaltet Regex ein, `Aa` beachtet Groß-/Kleinschreibung
- Treffer werden je Datei gruppiert angezeigt, mit Zeilennummer und Textausschnitt; ein Klick öffnet und springt zur betreffenden Zeile
- **Dateiübergreifendes Ersetzen**: unter dem Suchfeld „Ersetzen durch" eintragen und „Alle ersetzen" klicken. Zuerst wird einmal nachgefragt, weil auf die Festplatte geschrieben wird;
  vor jeder Änderung einer Datei bleibt ein Verlaufs-Snapshot erhalten, falls etwas schiefgeht
- Merkt sich den zuletzt geöffneten Ordner; im Einstellungspanel lässt er sich wechseln oder leeren

---

### Suchen (`Ctrl+F` / `Ctrl+H`)

Ein Overlay, zwei Zustände: über den Pfeil ganz links klappt es zu zwei Zeilen „Suchen + Ersetzen" auf; eingeklappt bleibt nur das Suchen.
`Ctrl+F` fokussiert nur (klappt eine bereits ausgeklappte Ersetzen-Zeile nicht wieder ein), `Ctrl+H` klappt direkt aus.

| Fähigkeit | Beschreibung |
|---|---|
| **Suchen an Ort und Stelle im WYSIWYG** | kein Wechsel in den Bearbeitungsmodus mehr fürs Suchen; die Hervorhebung wird auf der Render-Ebene gezeichnet (CSS Highlight API), statt Markierungen in den Text einzufügen |
| **Modusschalter** | vier kleine Kästchen rechts neben dem Eingabefeld: `Aa` Groß-/Kleinschreibung, `.*` Regex, `Ganzes Wort`, `Auswahl`; aktiviert erscheinen sie in Akzentfarbe |
| **Ganze Wörter** | Grenzen nur setzen, wenn an beiden Enden der Suchzeichenfolge englische Wortzeichen stehen – im Chinesischen gibt es keine Wortgrenzen, `\b` würde sonst nie treffen |
| **Auswahl einschränken** | Suchen/Ersetzen nur innerhalb des markierten Abschnitts; ohne Auswahl ist der Punkt ausgegraut |
| **Zeilenumbruch** | `↵` am rechten Rand des Feldes (oder `Ctrl+Enter`) fügt einen Zeilenumbruch ein, das Feld wächst von selbst mit; Suchmuster ohne Umbruch erzeugen weiterhin keine Fehltreffer über Absatzgrenzen hinweg |
| **Ersetzen** | liegt der Treffer im selben Textabschnitt, wird **direkt geändert** – ohne Dialog; erst wenn er über Formatgrenzen wie Fett oder Links hinausgeht, wird gefragt, ob in den Bearbeitungsmodus gewechselt werden soll |
| **Dateiübergreifend** | das Suchfeld im Seitenleisten-Tab „Dateien" listet Trefferzeilen je Datei gruppiert |

---

## Tastenkürzel

| Aktion | Tastenkürzel |
|---|---|
| Neu / Öffnen / Speichern / Speichern unter | `Ctrl+N` / `Ctrl+O` / `Ctrl+S` / `Ctrl+Shift+S` |
| Tab schließen / Tab wechseln | `Ctrl+W` / `Ctrl+Tab` |
| Suchen / Ersetzen / Gehe zu Zeile | `Ctrl+F` / `Ctrl+H` / `Ctrl+G` |
| **Befehlspalette** | `Ctrl+Shift+P` |
| Einstellungen | `Ctrl+,` |
| **Ein-Klick-Formatierung** | `Ctrl+Shift+F` |
| **Textvergleich** | `Ctrl+D` |
| Nächster / vorheriger Unterschied | `F8` / `F7` |
| Einspaltig ⇄ Zweispaltig | `Ctrl+Shift+L` |
| Gliederung anzeigen / ausblenden | `Ctrl+Shift+O` |
| Fokusmodus (`Esc` beendet) / Vollbild | `F9` / `F11` |
| Fett / Kursiv | `Ctrl+B` / `Ctrl+I` |
| Durchgestrichen / Inline-Code | `Ctrl+Shift+X` / — |
| Link einfügen / Tabelle einfügen | `Ctrl+K` / `Ctrl+Shift+T` |
| Text / Überschrift Ebene 1–3 | `Ctrl+Alt+0` / `Ctrl+Alt+1~3` |
| Unsortierte / nummerierte / Aufgabenliste | `Ctrl+Shift+8` / `Ctrl+Shift+7` / `Ctrl+Shift+9` |
| Zitat / Codeblock | `Ctrl+Shift+Q` / `Ctrl+Shift+K` |
| Liste einrücken / ausrücken | `Tab` / `Shift+Tab` |
| Schrift vergrößern / verkleinern / zurücksetzen | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` |
| PDF exportieren | `Ctrl+P` |

---

## Die meistgenutzten Funktionen

### WYSIWYG: als echter Editor brauchbar

Nicht nur „`# ` eintippen wird zur Überschrift": Blockstrukturen lassen sich direkt bedienen, Markdown-Syntax und WYSIWYG stimmen in beide Richtungen überein. Die Markierung darf nur am **Zeilenanfang** stehen, muss aber nicht ans Zeilenende – schreibe erst den Text, setze später am Zeilenanfang `## ` nach, und er wird ebenso zur Überschrift; der Text hinter der Markierung (einschließlich Fett und Links) bleibt unverändert:

| Fähigkeit | Bedienung |
|---|---|
| **Überschrift / Fließtext** | am Zeilenanfang `# `–`###### ` eingeben (auch nachträglich vor vorhandenen Text); `Ctrl+Alt+1~3` wechselt die Ebene, nochmaliges Drücken kehrt zum Text zurück |
| **Unsortierte / nummerierte / Aufgabenliste** | am Zeilenanfang `- ` / `1. ` / `- [ ] ` eingeben; `Tab` rückt zum Unterelement ein, `Shift+Tab` eine Ebene zurück |
| **Verschachtelte Listen** | bis zu 6 Ebenen; der Wechsel zwischen nummeriert und unnummeriert verliert keine Ebene, die Nummern ordnen sich neu |
| **Zitat** | am Zeilenanfang `> ` eingeben; `Tab` erhöht die Zitatebene, Enter auf einer leeren Zeile beendet |
| **Codeblock / Trennlinie** | am Zeilenanfang ``` ``` ``` / `---` eingeben; im Codeblock bricht Enter selbst um, Einrückung zwei Leerzeichen |
| **Tabelle** | `Ctrl+Shift+T` fügt 3×3 ein, oder „Format → Tabelle einfügen (eigene Größe)" |
| **Tabellenbearbeitung** | `Tab` / `Shift+Tab` springt zwischen Zellen (am Ende wird automatisch eine Zeile ergänzt), `Enter` in die nächste Zeile derselben Spalte; Rechtsklick fügt Zeilen und Spalten hinzu oder entfernt sie und stellt die Spaltenausrichtung ein |
| **Inline-Formatierung** | `**fett**`, `*kursiv*`, `~~durch~~`, `` `Code` ``, `[Text](Link)` wirken beim Tippen sofort |
| **Mathematische Formeln** | inline `$a^2+b^2=c^2$`, als Block `$$ … $$` (mehrzeilig möglich), gesetzt von KaTeX in der Vorschau |
| **Inhaltsverzeichnis** | „Einfügen → Inhaltsverzeichnis…" scannt die Überschriften und erzeugt eine klickbare Liste; `Ctrl+Klick` auf einen Eintrag springt zum Abschnitt |
| **Bilder einfügen** | nach dem Screenshot direkt `Ctrl+V`, eine Bilddatei ins Fenster ziehen oder „Einfügen → Bild…": alles wird in `assets/` im Ordner des Dokuments kopiert und per relativen Pfad eingebunden; eine Netzadresse geht ebenso |
| **Bildgröße** | im WYSIWYG die untere rechte Ecke des Bilds ziehen, um die Breite zu ändern (sie wird nach dem Ziehen automatisch in den alt-Suffix geschrieben); manuell `![Beschreibung\|300](a.png)` für die Breite bzw. `![Beschreibung\|300x200](a.png)` für Breite und Höhe; ohne Angabe gilt das Originalverhältnis (maximal 320px hoch) |
| **Backspace-Semantik** | Backspace am Anfang einer Überschriftzeile zeigt zuerst `###` an und löscht dann Ebene für Ebene; am Anfang eines Listenelements wird erst degradiert, dann zum Absatz; am Anfang eines Absatzes fügt Backspace mit der Zeile darüber zusammen; `Delete` macht es umgekehrt genauso |
| **Einfügen** | mehrzeiliger Text wird als Markdown in echte Überschriften-, Listen- und Tabellenblöcke geparst und verklebt nicht zu einem Brei |

**Blockgriffe am Zeilenanfang**: links neben der Zeile, auf der Cursor oder Maus steht, erscheinen zwei kleine Schaltflächen `+` und `⋮⋮` (sie verdecken keinen Text und lassen sich nicht markieren).
`⋮⋮` wandelt diesen Block in einen anderen Typ (Text / Überschrift 1–3 / Liste / Zitat / Codeblock), `+` fügt darunter einen neuen Block ein.
Sie lösen dieselben Befehle aus wie das Menü „Format" in der Werkzeugleiste, nur eben direkt zur Hand.

Das `###` der Überschrift erscheint nur, wenn du die Ebene ändern willst: Backspace am Zeilenanfang zeigt die Markierung (der Text bleibt unangetastet), noch einmal drücken löscht ein `#`, erst wenn alles weg ist, kehrt der Block zum Absatz zurück – ein versehentlicher Backspace verliert weder Ebene noch Text. Zieht der Cursor von der Zeile fort oder drückst du Enter, zieht sich die Markierung von selbst zurück.

Die Markierung erkennt „das kurze Stück vor dem Cursor", nicht das ganze Zeilenende – alle drei Schreibweisen sind gleichwertig: erst `## ` tippen und dann die Überschrift schreiben; die Überschrift schreiben und am Zeilenanfang `## ` ergänzen; einen normalen Absatz zur Überschrift hochstufen. Erkannt wird nur die Markierung allein (`## ` mit unmittelbar folgendem Leerzeichen), deshalb wird `#Thema` im Fließtext nicht fälschlich zur Überschrift; steht der Cursor nicht am Zeilenanfang, zerschneidet `- ` auch keinen Satz in eine Liste.

Alle Blockoperationen gibt es auch im **Menü „Format"** und im **Kontextmenü**; unpassende Einträge werden automatisch ausgegraut (steht der Cursor z. B. nicht in einer Tabelle, sind sämtliche Tabellenbefehle grau).

### Mathematische Formeln

- inline `$a^2 + b^2 = c^2$`, als Block `$$ … $$` (mehrzeilig erlaubt, damit Matrizen und lange Herleitungen nicht in eine Zeile gepresst werden müssen)
- gerendert wird nur **in der Vorschau**: KaTeX lädt „erst, wenn wirklich eine Formel auftaucht" (rund 546 KB); Dokumente ohne Formeln zahlen nichts
- im WYSIWYG werden Formeln nicht gerendert, nur eine Hintergrundfarbe hinterlegt – KaTeX-DOM in ein contenteditable zu stecken lässt sich per Backspace nicht entfernen und blockiert den Cursor; der Aufwand übersteigt den Nutzen. Zum Ansehen `Ctrl+3` oder den Zweispaltenmodus mit der Vorschau daneben öffnen
- Formelabschnitte werden geschützt, **bevor** die Hervorhebungs-Syntax geparst wird; deshalb sind in `$x_1 * y$` das `_` und `*` Tiefstellung und Multiplikationszeichen und werden nicht als Kursivierung interpretiert

### Fokusmodus (`F9`, `Esc` beendet)

Tab-Zeile, Seitenleiste, Statusleiste und Menü klicken sich alle ein, nur der Text bleibt. Die Titelleiste verblasst fast vollständig und kehrt erst zurück, wenn die Maus sie berührt – das Fenster ist rahmenlos; gäbe es auch keine Titelleiste, ließe es sich weder verschieben noch minimieren oder schließen, und man säße in seinem eigenen Dokument gefangen.

### Mit Doppelklick öffnen / nur ein Fenster

Nach der Installation sind `.md` `.markdown` `.txt` `.log` `.json` `.csv` alle mit Dateizuordnungen registriert,
im Explorer per Rechtsklick „Öffnen mit" findest du „EZNotepad".

Dasselbe Programm hat immer nur ein Fenster: doppelklickst du eine weitere Datei an, startet kein zweiter Prozess,
sondern der Pfad geht an das bereits geöffnete Fenster (das dabei aus der Minimierung zurückgeholt wird).
Zwei Fenster, die dieselbe Datei ändern und sich gegenseitig überschreiben – das gibt es von vornherein nicht mehr.

> Nur die **Installationsversion** registriert Dateizuordnungen. Die portable Version und der nackte exe-Build aus `cargo build` schreiben nichts in die Registry.

### Dateiänderungen beobachten

Geöffnete Dokumente werden in Echtzeit beobachtet (im Backend über `ReadDirectoryChangesW` / `inotify` des Systems; überwacht wird nur die Verzeichnisebene der Datei, und freigegeben werden nur Dateinamen auf der Liste). Ändert ein anderes Programm die Datei:

- Datei im **aktuellen Tab**: ohne eigene Änderungen wird sie still neu geladen und gemeldet; mit ungespeicherten Änderungen wird vorher gefragt
- Datei im **Hintergrund-Tab**: kein störender Dialog, nur ein bernsteinfarbener Punkt auf dem Tab; gefragt wird erst beim Umschalten dorthin

Das eigene Speichern triggert nichts (nach dem Speichern ist der Änderungszeitpunkt synchron). In den Einstellungen lässt sich das Ganze abschalten.

### Ein-Klick-Formatierung (je nach Dateityp intelligent)

| Typ | Was passiert |
|---|---|
| **JSON** | Validierung + Einrückung neu ordnen; Vollbreit-Anführungszeichen, überflüssige Kommas und Kommentare werden automatisch korrigiert; **bei Syntaxfehlern bleibt die Datei unangetastet, stattdessen erscheint „Zeile X, Spalte Y"** |
| **Markdown** | Leerzeilen vor und nach Überschriften ergänzen, Listenzeichen vereinheitlichen, Leerzeichen am Zeilenende entfernen, Leerzeilen verdichten |
| **TXT / Logs / Code** | Zeilenenden vereinheitlichen, Leerzeichen am Zeilenende entfernen, aufeinanderfolgende Leerzeilen verdichten |

Nach dem Formatieren kehrt ein Klick auf „Rückgängig" zum Original zurück.

### Verlaufsversionen (Datei → Verlaufsversionen…)

Bei jedem Speichern bleibt der Inhalt **vor** dem Speichern als Snapshot im lokalen Anwendungsdaten-Ordner (dein Dokumentenordner wird nicht vollgemüllt).
Wenn du nach Ein-Klick-Formatierung, Sortieren/Deduplizieren oder Bulk-Ersetzen zurück willst und `Ctrl+Z` nicht mehr reicht, ist das hier die letzte Instanz.

- pro Datei höchstens 60 Snapshots, insgesamt 20 MB; darüber hinaus wird vom ältesten an aufgeräumt
- „Ansehen" öffnet die Version als schreibgeschützten neuen Tab, „Wiederherstellen" schreibt sie in den Editor – **auf die Festplatte geht beides erst, wenn du selbst `Ctrl+S` drückst**
- dasselbe Prinzip wie beim Dateivergleich und Drei-Wege-Merge: ein Rollback überschreibt nie direkt die Originaldatei

### Webseite exportieren (Datei → Webseite exportieren…)

Speichert das aktuelle Dokument als **einzeldateiiges HTML**: Styles eingebettet, Bilder in data-URIs umgewandelt –
direkt an andere verschickbar oder in eine statische Seite einbaubar, ohne dass „alle Bilder kaputt" sind.
Bilder über 4 MB werden nicht eingebettet (die Originaladresse bleibt erhalten); der Export-Hinweis sagt, wie viele eingebettet wurden.

### Befehlspalette (`Ctrl+Shift+P`)

Von den gut hundert Befehlen aus dem Menü genügen ein paar Zeichen, um sie zu finden: `Fokus`, `Format`, `Ersetzen` –
`↑` `↓` wählen, `Enter` führt aus, `Esc` schließt. Die Liste entsteht direkt aus dem Menübaum; neue Menübefehle tauchen hier automatisch auf.
Befehle, die im aktuellen Zustand nicht nutzbar sind, werden ausgegraut, und beim Klick erfährst du, warum.

### Tastenkürzel selbst ändern (Einstellungen → Tastenkürzel)

Im Einstellungspanel stehen alle Befehle mit Tastenkürzel; nach einem Klick auf „Ändern" einfach die neue Kombination drücken (mit `Ctrl` / `Alt`,
oder allein `F1`–`F12`), `Esc` bricht ab. Eigene Kombinationen haben Vorrang vor den Standardtasten; geht etwas schief, bringt „Wiederherstellen" alles zurück,
„Standardeinstellungen wiederherstellen" leert sie gleich mit.

### Textvergleich (`Ctrl+D`)

- nebeneinander, doppelte Hervorhebung auf **Zeilen- und Zeichenebene** (nur die wirklich geänderten Zeichen werden markiert)
- Leerzeichen ignorieren / Groß-/Kleinschreibung ignorieren
- `F7` / `F8` springt zwischen den Unterschieden
- jeder Unterschiedsblock hat einen **→**-Knopf, der den linken Block mit einem Klick auf die rechte Seite überträgt
- HTML-Vergleichsbericht mit einem Klick exportieren

### Ordnervergleich

Vergleicht zwei Verzeichnisse rekursiv und listet **nur links / nur rechts / geändert / identisch**; ein Klick auf eine Zeile öffnet den Textvergleich dieser Datei.

### Drei-Wege-Merge (Werkzeuge → Drei-Wege-Merge)

Wähle „Basisversion + Seite A + Seite B"; die Änderungen beider Seiten werden automatisch zusammengeführt, Konflikte landen in einer Liste.
**Das Ergebnis öffnet sich nur in einem neuen Tab und überschreibt niemals eine Originaldatei.**

### Kodierung und Zeilenenden

Unten rechts in der Statusleiste kannst du `UTF-8` anklicken und in einer anderen Kodierung speichern (UTF-8 / GBK / UTF-16, mit BOM möglich);
ein Klick auf `LF` wechselt zu CRLF. Alte GBK-txt-Dateien öffnen ohne Zeichensalat.

---

## Performance-Messwerte

Gemessen auf dem eigenen Rechner (Windows 11, x64, Release-Build):

| Szenario | Messwert |
|---|---|
| Alltägliches Tippen (600-Absatz-Dokument, WYSIWYG) | durchschnittlich **9.1 ms** pro Zeichen |
| Öffnen eines sehr großen Dokuments (10.8 MB / 77,866 Blöcke) | **1.14 s**, die Oberfläche friert nicht ein (Viewport-Rendering, im DOM bleiben rund 48 Blöcke) |
| Tippen im sehr großen Dokument | Latenz p50 **0.3 ms** |
| Scrollen im sehr großen Dokument | etwa **17 ms** pro Frame, volle Bildrate |
| Rückgängig im sehr großen Dokument | ein Schritt **37 ms**, Hin- und Rückweg Byte für Byte identisch |
| Große Klartext-Dateien (CodeMirror 6) | 50.000 Zeilen in **49 ms** geöffnet, 100.000 Zeilen in **20 ms**, nur die sichtbaren Zeilen werden gerendert |
| Speicherverbrauch | rund **170 MB** nach sauberem Start (inkl. WebView2-GPU-Prozess) |
| Größe | Installationspaket **2.63 MB** |

---

## Daten und Privatsphäre

- Alle Dateien werden ausschließlich auf deinem Rechner gelesen und geschrieben: **kein Netz, kein Upload**
- Entwürfe liegen im lokalen Anwendungsdaten-Ordner und gehen beim Schließen des Fensters nicht verloren: **alle** ungespeicherten Tabs werden gesichert,
  beim nächsten Start wird gemeinsam gefragt, ob sie wiederhergestellt werden sollen (nicht nur der letzte)
- Die Verlaufs-Snapshots liegen ebenfalls dort unter `history/`, vollständig getrennt von deinem Dokumentenordner
- Findet der erste Start ungespeicherte Entwürfe, fragt er, ob sie wiederhergestellt werden sollen

---

## Bekannte Einschränkungen

- Der PDF-Export läuft über den Systemdruckdialog („Als PDF speichern"); das Layout richtet sich nach dem Druckbild
- Der Drei-Wege-Merge ist halbautomatisch: automatische Zusammenführung + Konfliktliste, kein viergeteilter visueller Merger (komplexe Konflikte besser Block für Block im Textvergleich bearbeiten)
- Installationspakete für jede Plattform müssen auf dem jeweiligen System gebaut werden (siehe `构建说明.md`)
- Die dateiübergreifende Suche sucht standardmäßig wörtlich und ohne Groß-/Kleinschreibung, umschaltbar auf Regex; Obergrenze 200 Treffer
- Das dateiübergreifende Ersetzen verarbeitet nur **UTF-8**-Dateien: GBK & Co. werden unverändert übersprungen, ohne still die Kodierung der ganzen Datei umzustellen
- Löschen im Dateibaum geht in den Papierkorb; **Ordner lassen sich nur löschen, wenn sie leer sind** – kein rekursives Löschen
- Der Datei**baum** selbst wird nicht überwacht: woanders neu angelegte oder gelöschte Dateien erscheinen erst nach einem Rechtsklick „Aktualisieren" auf der freien Fläche oder beim erneuten Aufklappen des Verzeichnisses (geöffnete Dokumente werden in Echtzeit überwacht, siehe oben)
- Formeln werden nur in der Vorschau gerendert, im WYSIWYG erscheint der Quellcode; Mermaid-Diagramme werden noch nicht unterstützt

---

## Lizenz

Dieses Projekt steht unter der [PolyForm Noncommercial License 1.0.0](./LICENSE):

- **Nichtkommerzielle Nutzung** (persönliche Nutzung, Lernen, Forschung, gemeinnützige Organisationen usw.): freie Nutzung, Änderung und Verbreitung
- **Kommerzielle Nutzung**: die vorherige Zustimmung des Projektteams ist erforderlich – einfach [ein Issue mit Angabe des Verwendungszwecks eröffnen](https://github.com/EZLive00/EZNotepad/issues)
- Der Quellcode ist offen, die kommerzielle Nutzung bleibt lizenziert – eine bewusste Entscheidung; beim Weitergeben muss dieser Lizenzhinweis beiliegen
