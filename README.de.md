<div align="center">

# EZNotepad

> Ein **5 MB** großes Desktop-Werkzeug: Markdown schreiben, Text bearbeiten, Dateien vergleichen.
> Portabel, offline, per Doppelklick startklar.
> Die Oberfläche spricht 9 Sprachen und folgt der Systemsprache; umschaltbar unter **Einstellungen → Sprache**.

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Français](README.fr.md) | **Deutsch** | [Español](README.es.md) | [Português](README.pt.md)

[![Release](https://img.shields.io/github/v/release/EZLive00/EZNotepad)](https://github.com/EZLive00/EZNotepad/releases)
[![License](https://img.shields.io/badge/license-AGPL--v3-blue)](./LICENSE)

</div>

---

## Download

| Datei | Wofür |
|---|---|
| `EZNotepad_<Version>_x64-setup.exe` | **Installer** — Einrichtungsassistent und Dateizuordnungen; ein Doppelklick auf `.md` / `.txt` öffnet hier |
| `EZNotepad_<Version>_x64-portable.zip` | **Portabel** — irgendwohin entpacken und `EZNotepad.exe` starten (keine Registry, keine Zuordnungen) |

Die Builds sind nicht signiert: SmartScreen blockt den ersten Start einmal — **Weitere Informationen → Trotzdem ausführen**.
Bislang nur Windows x64; die portable Variante nutzt die WebView2-Runtime des Systems (bei Windows 10 / 11 vorinstalliert).

## Screenshots

| Hell | Dunkel |
|---|---|
| ![Hauptfenster, helles Design](docs/screenshots/light.png) | ![Hauptfenster, dunkles Design](docs/screenshots/dark.png) |

| Links schreiben, rechts Vorschau | Vergleich: Marken pro Zeile und pro Zeichen |
|---|---|
| ![Zwei Spalten](docs/screenshots/split.png) | ![Vergleichsfenster](docs/screenshots/compare.png) |

## Was es ersetzt

| Bisher | Warum | Hier |
|---|---|---|
| Notepad | Beliebige Texte öffnen, Kodierung wechseln, Logs lesen | Dasselbe, plus Zeilennummern, Hervorhebung und Gliederung |
| Typora | Markdown mit Live-Vorschau | Drei Modi, 20× leichter |
| BeyondCompare | Zwei Dateien vergleichen | Nebeneinander, Marken bis aufs Zeichen, `F7` / `F8` durch die Unterschiede |

## Drei Modi

| Modus | Was er tut | Tastenkürzel |
|---|---|---|
| **WYSIWYG** | `# ` am Zeilenanfang ergibt eine Überschrift, `**fett**` wird beim Tippen fett | `Ctrl+1` |
| **Bearbeiten** | Rohes Markdown / Quelltext, CodeMirror 6 mit Zeilennummern und Faltung | `Ctrl+2` |
| **Vorschau** | Schreibgeschütztes Rendering, zum Lesen gedacht | `Ctrl+3` |

`.md` kann alle drei. `.json` bekommt Prüfung samt Fehlerstelle; `.txt` `.log` `.csv` und Codedateien
(`.js .ts .py .rs .go .html .css .sql .yml` …) haben nur Bearbeiten / Vorschau und verhalten sich wie ein Texteditor.
Neue Dateien fragen zuerst nach dem Typ (Markdown / reiner Text / JSON / CSV / Code).

## Bearbeiten

| | |
|---|---|
| **Blöcke** | `# ` Überschrift, `- ` / `1. ` / `- [ ] ` Liste (6 Ebenen), `> ` Zitat, ` ``` ` Code, `---` Trennlinie — das Zeichen muss nur am Zeilenanfang stehen |
| **Inline** | `**fett**`, `*kursiv*`, `~~durchgestrichen~~`, `` `Code` ``, `[Text](Link)` werden beim Tippen gesetzt |
| **Rückgängig / Wiederholen** | Die beiden Pfeile ganz links in der Werkzeugleiste (an den Enden grau), `Strg+Z` / `Strg+Y`; `Strg+Shift+Z` wiederholt ebenfalls — WYSIWYG und Klartext führen je einen eigenen Verlauf |
| **Tabellen** | `Ctrl+Shift+T` fügt eine ein; `Tab` wandert durch die Zellen, `Enter` springt in dieselbe Spalte darunter, Rechtsklick fügt Zeilen und Spalten hinzu oder entfernt sie |
| **Bilder** | Screenshot einfügen, Datei hineinziehen oder **Einfügen → Bild**: die Datei landet in `assets/` neben dem Dokument. Unten rechts ziehen ändert die Breite, `![Alt\|300](a.png)` geht auch |
| **Formeln** | `$a^2+b^2=c^2$` inline, `$$ … $$` als Block, in der Vorschau von KaTeX gesetzt (lädt nur, wenn eine Formel vorkommt) |
| **Hinweisblöcke** | `> [!info]` / `warning` / `danger` / `success`, GitHub-Aliase werden ebenfalls erkannt |
| **Blockgriffe** | Am Zeilenanfang schweben `+` und `⋮⋮`: Block einfügen oder diesen in einen anderen Typ umwandeln |
| **Einfügen** | Mehrzeiliger Text wird als Markdown gelesen und zu echten Überschriften, Listen und Tabellen |

Typwechsel (`Ctrl+Shift+Q` Zitat, `Ctrl+Shift+K` Code…), **Format**-Menü, Kontextmenü und
`Ctrl+Shift+P` (Befehlspalette) laufen über dieselben Befehle; Unpassendes wird von selbst ausgegraut.

### Suchen und Ersetzen

Eine Leiste, zwei Zustände: `Ctrl+F` fokussiert sie, `Ctrl+H` klappt das Ersetzen auf.
Die Suche läuft **im WYSIWYG** ohne Moduswechsel — Treffer werden gezeichnet, nie in den Text geschrieben.

`Aa` Groß-/Kleinschreibung · `.*` Regex · ganzes Wort (Grenzen nur, wenn beide Enden lateinische Buchstaben sind — Chinesisch
kennt keine Wortgrenzen) · nur in der Auswahl · `↵` fügt einen Zeilenumbruch in die Suche ein. Ein Treffer innerhalb eines
Textlaufs wird direkt ersetzt; nur bei Fett oder Links wird der Wechsel in den Bearbeiten-Modus angeboten.

## Notiz

`Ctrl+Shift+M` (oder **Notiz** in der Menüleiste) öffnet eine Notiz an einem festen Ort:

- **Kein Speichern** — Änderungen gehen etwa 0,35 s nach dem letzten Tastendruck auf die Platte und werden vor dem Schließen eines Tabs oder des Fensters nachgeschrieben; kein „ungespeichert"-Punkt, keine Rückfrage
- **Fester Ort** — `<App-Datenordner>/quicknote.md`; unter **Datei → Notiz** steht, wo sie liegt, und lässt sie im Explorer öffnen
- **Weiterschreiben, wo man aufgehört hat** — der Cursor steht am Ende; **Aktuelle Uhrzeit einfügen** setzt `2026-11-03 09:20`
- **Leeren bleibt umkehrbar** — **Notiz leeren** legt vorher eine Kopie im Versionsverlauf ab

Sie bleibt ein gewöhnlicher Markdown-Tab (Modi, Export, Suche) – erscheint aber weder unter „Zuletzt geöffnet" noch in der wiederhergestellten Sitzung.

## Vergleichen

`Ctrl+D` (oder `Ctrl+Shift+N`) öffnet das Vergleichsfenster. Es startet absichtlich leer:

- **Zwei Dateien** — im Seitenleisten-Reiter „Dateien“ mit `Ctrl` / `Shift` auswählen, dann Rechtsklick → **Diese zwei Dateien vergleichen** (die angeklickte bleibt links)
- **Zwei Texte** — **Zwei Texte einfügen** drücken, beidseitig einfügen, fertig (ohne Datei)
- **Beide Seiten bearbeiten** — **Bearbeiten** schaltet beide Spalten frei; **Speichern** schreibt nur dorthin zurück, wo wirklich eine Datei liegt

Marken pro Zeile zeigen, welche Zeile sich änderte, Marken pro Zeichen, welche Zeichen. `F7` / `F8` springen zwischen den
Unterschieden, **Bericht exportieren** schreibt einen eigenständigen HTML-Vergleich. Das Lineal rechts verortet jede Änderung in der ganzen Datei: Zeilennummer beim Überfahren, Sprung per Klick
oder Ziehen. **Unterschiede** listet jede Änderung in einer sortier- und filterbaren Liste (Position, Typ, Zeilen).
**Sortieren** ordnet beide Seiten alphabetisch (Leerzeilen ans Ende), damit Reihenfolge-Rauschen die echten Unterschiede nicht mehr verdeckt; `Ctrl+Z` macht es rückgängig.
Im Editiermodus lassen sich Tippen, Zeilenumbrüche, Einrückungen, gelöschte Auswahlen und Sortieren mit `Ctrl+Z` rückgängig machen und mit `Ctrl+Y` wiederherstellen — auch bei Fokus in der Werkzeugleiste.
Das Vergleichsfenster hat dieselben zwei Schaltflächen in seiner Werkzeugleiste (am Ende des Verlaufs ausgegraut); wird das Fenster schmal, klappt die Leiste auf Symbole um, statt eine Schaltfläche abzuschneiden.
**Nur Unterschiede** ist standardmäßig an: gleiche Zeilen werden eingeklappt, drei Zeilen Kontext bleiben um jede Änderung — 2.000 Zeilen mit 20 Änderungen schrumpfen auf ein paar Dutzend. Um eine weiter entfernte gleiche Zeile zu bearbeiten, das Häkchen in der Werkzeugleiste entfernen.
`Strg+F` sucht in beiden Bereichen gleichzeitig; Trefferzeilen werden eingefärbt, `Enter` / `Umschalt+Enter` springen weiter.

Pro Seite gilt ein Limit von 8 MB / 50.000 Zeilen; darüber nennt das Fenster den Grund, statt still zu scheitern.

**Ordner vergleichen** listet rekursiv *nur links / nur rechts / geändert / gleich*; ein Klick auf die Zeile öffnet diesen
Dateivergleich. **Drei-Wege-Zusammenführung** nimmt Basis + A + B, führt zusammen und listet Konflikte — das Ergebnis öffnet
sich in einem neuen Tab und überschreibt nie ein Original.

## Dateien und Suche

Die Seitenleiste hat zwei Reiter: **Gliederung** (hebt beim Scrollen den aktuellen Abschnitt hervor) und **Dateien**.

- Baum lädt bei Bedarf; Rechtsklick zum Anlegen, Umbenennen, Löschen — Löschen geht in den **Papierkorb**, Ordner nur wenn leer
- Die Suche läuft in Rust, überspringt Binärdateien und alles über 4 MB, liefert höchstens 200 Treffer nach Datei gruppiert mit Zeilennummer
- `.*` schaltet Regex, `Aa` die Groß-/Kleinschreibung
- **Alle ersetzen** über alle Dateien: eine Rückfrage vorab, und vor jeder Änderung ein Schnappschuss
- Offene Dokumente werden live überwacht (`ReadDirectoryChangesW`): der aktuelle Tab lädt still neu, ein Hintergrund-Tab bekommt einen gelben Punkt und fragt beim Wechsel

## Alles Weitere

| | |
|---|---|
| **Formatieren** | `Ctrl+Shift+F` — JSON prüfen und neu einrücken (bei Fehler bleibt die Datei unberührt, Zeile / Spalte werden gemeldet), Markdown: Leerzeilen und Aufzählungszeichen vereinheitlicht, Rest: Leerzeichen am Zeilenende weg. Ein `Ctrl+Z` macht alles rückgängig |
| **Versionsverlauf** | Jedes Speichern sichert den vorherigen Stand (60 pro Datei, 20 MB gesamt). **Ansehen** öffnet schreibgeschützt, **Wiederherstellen** schreibt in den Editor — auf die Platte geht es erst mit `Ctrl+S` |
| **Export** | Einzelne HTML-Datei mit eingebetteten Stilen und Bildern als data URI; PDF über den Druckdialog des Systems |
| **Tastenkürzel** | Einstellungen → Tastenkürzel ändert jedes; eigene Belegungen gewinnen, **Zurücksetzen** stellt eines wieder her, **Standard wiederherstellen** löscht alle |
| **Fokusmodus** | `F9` klappt Tabs, Seitenleiste, Statusleiste und Menüs weg; die Titelleiste blasst auf 28 % ab, statt zu verschwinden — sonst ließe sich das Fenster weder ziehen noch schließen |
| **Einzelinstanz** | Ein Doppelklick auf eine weitere Datei startet keinen zweiten Prozess, der Pfad geht an das laufende Fenster |
| **Kodierung** | `UTF-8` oder `LF` in der Statusleiste anklicken, um Kodierung (GBK / UTF-16 / BOM) oder Zeilenenden zu ändern |

## Tastenkürzel

| Aktion | Tasten |
|---|---|
| Neu / Öffnen / Speichern / Speichern unter | `Ctrl+N` / `Ctrl+O` / `Ctrl+S` / `Ctrl+Shift+S` |
| Tab schließen / nächster Tab | `Ctrl+W` / `Ctrl+Tab` |
| Notiz öffnen | `Ctrl+Shift+M` |
| Suchen / Ersetzen / Gehe zu Zeile | `Ctrl+F` / `Ctrl+H` / `Ctrl+G` |
| Befehlspalette / Einstellungen | `Ctrl+Shift+P` / `Ctrl+,` |
| Formatieren / Vergleichen | `Ctrl+Shift+F` / `Ctrl+D` |
| Nächster / vorheriger Unterschied | `F8` / `F7` |
| Diesen Unterschied ganz auf die andere Seite übernehmen (mit `Ctrl` weiter) | `Alt+←` / `Alt+→` |
| In beiden Bereichen suchen (Vergleichsfenster) | `Strg+F` |
| Eine ⇄ zwei Spalten / Gliederung | `Ctrl+Shift+L` / `Ctrl+Shift+O` |
| Fokusmodus / Vollbild | `F9` / `F11` |
| Fett / Kursiv / Durchgestrichen / Code | `Ctrl+B` / `Ctrl+I` / `Ctrl+Shift+X` / `Ctrl+Shift+K` |
| Link / Tabelle / Zitat | `Ctrl+K` / `Ctrl+Shift+T` / `Ctrl+Shift+Q` |
| Fließtext / Überschrift 1–3 | `Ctrl+Alt+0` / `Ctrl+Alt+1~3` |
| Aufzählung / Nummeriert / Aufgabe | `Ctrl+Shift+8` / `Ctrl+Shift+7` / `Ctrl+Shift+9` |
| Liste ein-/ausrücken | `Tab` / `Shift+Tab` |
| Zoom + / − / zurücksetzen | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` |
| PDF exportieren | `Ctrl+P` |

## Leistung

Lokal gemessen (Windows 11, x64, Release-Build):

| Szenario | Wert |
|---|---|
| Tippen in einem Dokument mit 600 Absätzen | **9,1 ms** pro Anschlag |
| 10,8 MB / 77.866 Blöcke öffnen | **1,14 s**, ~48 Blöcke im DOM, kein Einfrieren |
| Tippen / Scrollen / Rückgängig in diesem Dokument | p50 **0,3 ms** / ~**17 ms** pro Frame / **37 ms** pro Schritt |
| CodeMirror 6, reiner Text | 50.000 Zeilen in **49 ms**, 100.000 in **20 ms** |
| Speicher / Installer | ~**170 MB** im Kaltstart / **2,63 MB** |

Riesige Markdown-Dateien laufen über Viewport-Rendering: nur sichtbare Blöcke liegen im DOM, alles andere sind Datensätze.
Rückgängig-Schnappschüsse sind diese Datensatz-Arrays, ein Tastendruck kopiert also nie das ganze Dokument.

## Daten

Alles bleibt auf diesem Rechner — **kein Netzwerk, kein Upload, keine Telemetrie**. Entwürfe aller ungespeicherten Tabs
liegen im lokalen App-Datenordner und werden beim nächsten Start angeboten; Verlaufs-Schnappschüsse liegen in `history/`
am selben Ort, getrennt von deinen Dokumenten.

## Bekannte Grenzen

- PDF läuft über den Druckdialog des Systems, das Layout folgt also der Druckausgabe
- Die Drei-Wege-Zusammenführung führt automatisch zusammen und listet Konflikte; keinen vierspaltigen visuellen Merger (nutze den Textvergleich Block für Block)
- Formeln werden nur in der Vorschau gesetzt und im WYSIWYG als Quelle gezeigt; Mermaid wird nicht unterstützt
- Ersetzen über Dateien hinweg verarbeitet nur UTF-8 — GBK-Dateien werden übersprungen statt still umkodiert
- Der Dateibaum selbst wird nicht überwacht; **Aktualisieren** im Kontextmenü nach externen Änderungen
- Installer müssen auf dem jeweiligen System gebaut werden (siehe `docs/构建说明.md`); Architektur- und Portierungsnotizen liegen in `docs/`

## Lizenz

[GNU Affero General Public License v3.0](LICENSE) — frei nutzbar, studierbar, veränderbar und weitergebbar. Abgeleitete Werke,
auch ein darauf aufbauender gehosteter Dienst, müssen ebenfalls unter AGPL-3.0 veröffentlicht werden.
