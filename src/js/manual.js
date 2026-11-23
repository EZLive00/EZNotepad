/* ============================================================
   manual.js —— 内置使用手册（帮助 → 使用手册，以及首次启动自动打开的那一份）

   为什么单独放一个文件：它是一整篇 Markdown（多行、带表格），塞进 i18n
   词条表会跟几百条短标签混在一起，改起来找不到。

   这份手册是**内置文档**：没有磁盘路径、只允许预览模式、关不掉。
   它的内容随程序走，所以每次改文案都要记得这里和「关于」对话框同步。

   简体是母本，繁体由 OpenCC s2twp 转出；其余 7 种语言手写。
   ============================================================ */

const DOCS = {
  'zh-CN': `# EZNotepad 使用手册

简单、轻量、好用的文本与 Markdown 编辑器。文件只在本机读写，不联网、不上传。

> 这份手册内置在程序里：磁盘上没有对应文件、只能预览、也关不掉。想留下其中内容，把文字复制到自己的文档即可。

## 三种模式

- **所见即所得**：输入 # 加空格立刻变标题，**粗体**当场加粗
- **编辑模式**：编辑 Markdown 原文，带行号与语法着色
- **预览模式**：只读渲染

用工具栏的「模式」下拉切换，或按 Ctrl+1 / 2 / 3。

## 块

每一行就是一个块。鼠标移到行首会出现 ⋮⋮ 抓手：

| 想做什么 | 怎么做 |
|---|---|
| 换块类型 | 点抓手，选一种类型 |
| 搬动某一块 | 按住抓手上下拖，落点会出现一条指示线 |
| 选中一块 | Shift + 点抓手 |
| 加选不连续的块 | 选择模式里 Ctrl + 点抓手 |
| 整块上下移 | Ctrl+Shift+↑ / ↓ |
| 折叠标题 | 点标题左侧的三角 |

进入选择模式后，顶部会出现一条提示。这时：

- 点别的块 → 把选中扩成连续一段
- Ctrl + 点某块 → 单独加选 / 取消这一块
- 右键 → 对选中的那几块统一操作：删除、转类型、上移下移、复制为 Markdown
- Esc → 退出选择模式

选中的块可以整组拖动。上移下移只对连续的一段有效 —— 隔开的几块没有合理的「挪一格」落点。

## 常用语法

- 标题 # 到 ######，列表 - 或 1.，引用 >，代码块用三个反引号
- 行内 **粗体**、*斜体*、\`代码\`、==高亮==、~~删除线~~
- 提示块：行首输入 [!info] 加空格，info / warning / danger / success 四种配色
- 表格：输入 | 列 1 | 列 2 | 后回车，或按 Ctrl+Shift+T

## 文件

- 左侧文件树可以新建、重命名、删除，右键看历史版本
- 标签可以拖出成独立窗口，拖回标签栏就合并
- 钉住的标签不会被误关
- 草稿自动保存，关窗时统一问一次

## 查找与对比

- 查找 Ctrl+F，替换 Ctrl+H，都支持正则
- 文本对比 Ctrl+D；文件夹对比与三向合并在「对比」菜单

## 更多快捷键

见「帮助 → 快捷键一览」。

## 数据

设置、草稿、历史快照都只存在本机。没有账号，不上传，不联网。
`,

  'zh-TW': `# EZNotepad 使用手冊

簡單、輕巧、好用的文字與 Markdown 編輯器。檔案只在本機讀寫，不連網、不上傳。

> 這份手冊內建在程式裡：磁碟上沒有對應檔案、只能預覽、也關不掉。想留下其中內容，把文字複製到自己的文件即可。

## 三種模式

- **所見即所得**：輸入 # 加空格立刻變標題，**粗體**當場加粗
- **編輯模式**：編輯 Markdown 原文，帶行號與語法著色
- **預覽模式**：唯讀渲染

用工具列的「模式」下拉切換，或按 Ctrl+1 / 2 / 3。

## 區塊

每一行就是一個區塊。滑鼠移到行首會出現 ⋮⋮ 握把：

| 想做什麼 | 怎麼做 |
|---|---|
| 換區塊類型 | 點握把，選一種類型 |
| 搬動某一個區塊 | 按住握把上下拖，落點會出現一條指示線 |
| 選取一個區塊 | Shift + 點握把 |
| 加選不連續的區塊 | 選擇模式裡 Ctrl + 點握把 |
| 整塊上下移 | Ctrl+Shift+↑ / ↓ |
| 摺疊標題 | 點標題左側的三角形 |

進入選擇模式後，頂端會出現一條提示。這時：

- 點別的區塊 → 把選取擴成連續一段
- Ctrl + 點某個區塊 → 單獨加選 / 取消這一個
- 右鍵 → 對選取的那幾個區塊統一操作：刪除、轉類型、上移下移、複製為 Markdown
- Esc → 退出選擇模式

選取的區塊可以整組拖動。上移下移只對連續的一段有效 —— 隔開的幾個區塊沒有合理的「挪一格」落點。

## 常用語法

- 標題 # 到 ######，清單 - 或 1.，引用 >，程式碼區塊用三個反引號
- 行內 **粗體**、*斜體*、\`程式碼\`、==醒目==、~~刪除線~~
- 提示區塊：行首輸入 [!info] 加空格，info / warning / danger / success 四種配色
- 表格：輸入 | 欄 1 | 欄 2 | 後按 Enter，或按 Ctrl+Shift+T

## 檔案

- 左側檔案樹可以新建、重新命名、刪除，右鍵看歷史版本
- 分頁可以拖出成獨立視窗，拖回分頁列就合併
- 釘住的分頁不會被誤關
- 草稿自動儲存，關窗時統一問一次

## 尋找與比對

- 尋找 Ctrl+F，取代 Ctrl+H，都支援正規表達式
- 文字比對 Ctrl+D；資料夾比對與三向合併在「比對」功能表

## 更多快速鍵

見「說明 → 快速鍵一覽」。

## 資料

設定、草稿、歷史快照都只存在本機。沒有帳號，不上傳，不連網。
`,

  en: `# EZNotepad manual

A simple, light and pleasant editor for Markdown and plain text. Files are read and written on this machine only — no network, no upload.

> This manual is built into the program: there is no file on disk, it opens in preview only, and it cannot be closed. To keep any of it, copy the text into your own document.

## Three modes

- **WYSIWYG**: type # and a space to make a heading; **bold** turns bold as you type
- **Edit**: edit the raw Markdown with line numbers and syntax colours
- **Preview**: read-only rendering

Switch with the Mode dropdown in the toolbar, or press Ctrl+1 / 2 / 3.

## Blocks

Every line is a block. Hover the start of a line and a ⋮⋮ grip appears:

| To | Do this |
|---|---|
| Change the block type | Click the grip, pick a type |
| Move a block | Hold the grip and drag up or down; a line shows where it lands |
| Select one block | Shift + click the grip |
| Add a separate block | In selection mode, Ctrl + click the grip |
| Move the block up or down | Ctrl+Shift+↑ / ↓ |
| Fold a heading | Click the triangle left of the heading |

Selection mode puts a hint bar at the top of the editor. While it is on:

- click another block to extend the selection into a range
- Ctrl + click a block to add or remove just that one
- right-click for delete, convert type, move up/down, copy as Markdown
- Esc to leave

Selected blocks drag as a group. Moving up or down only works on a contiguous run — separate blocks have no sensible "one slot down" target.

## Common syntax

- Headings # to ######, lists - or 1., quotes >, code fences with three backticks
- Inline **bold**, *italic*, \`code\`, ==highlight==, ~~strikethrough~~
- Callouts: type [!info] then a space at the start of a line — info / warning / danger / success
- Tables: type | a | b | and press Enter, or press Ctrl+Shift+T

## Files

- The file tree on the left can create, rename and delete; right-click for version history
- Tabs can be dragged out into their own window and dragged back to merge
- Pinned tabs cannot be closed by accident
- Drafts save automatically; closing the window asks once

## Find and compare

- Find Ctrl+F, replace Ctrl+H, both support regular expressions
- Text compare Ctrl+D; folder compare and three-way merge live under the Compare menu

## More shortcuts

See Help → Keyboard shortcuts.

## Data

Settings, drafts and history live on this machine only. No account, no upload, no network.
`,

  ja: `# EZNotepad 取扱説明書

シンプルで軽く、使いやすい Markdown / テキストエディタです。ファイルはこの PC 内だけで読み書きし、ネットワークにも接続しません。

> このマニュアルは本体に組み込まれています：ディスク上にファイルはなく、プレビューのみ、閉じることもできません。残したい部分はご自分の文書にコピーしてください。

## 3 つのモード

- **WYSIWYG**：# とスペースで見出しに、**太字**はその場で太くなります
- **編集モード**：Markdown の原文を、行番号とシンタックスカラー付きで編集
- **プレビュー**：読み取り専用の表示

ツールバーの「モード」から切り替えるか、Ctrl+1 / 2 / 3 を押します。

## ブロック

1 行が 1 ブロックです。行頭にマウスを置くと ⋮⋮ のグリップが出ます：

| やりたいこと | 操作 |
|---|---|
| ブロックの種類を変える | グリップをクリックして種類を選ぶ |
| ブロックを動かす | グリップを押したまま上下にドラッグ（挿入位置に線が出ます） |
| 1 ブロックを選択 | Shift + グリップをクリック |
| 離れたブロックを追加選択 | 選択モードで Ctrl + グリップをクリック |
| ブロックを上下に移動 | Ctrl+Shift+↑ / ↓ |
| 見出しを折りたたむ | 見出しの左の三角形をクリック |

選択モードではエディタ上部にヒントが出ます。この状態で：

- 別のブロックをクリック → 連続した範囲に拡張
- Ctrl + クリック → そのブロックだけ追加 / 解除
- 右クリック → 選択したブロックをまとめて操作（削除・種類変換・上下移動・Markdown としてコピー）
- Esc → 選択モードを終了

選択したブロックはまとめてドラッグできます。上下移動は連続した範囲のみ有効です（離れたブロックには「1 つずらす」落ち着く先がありません）。

## よく使う記法

- 見出し # 〜 ######、リスト - または 1.、引用 >、コードブロックはバッククォート 3 つ
- インライン **太字**、*斜体*、\`コード\`、==ハイライト==、~~取り消し線~~
- コールアウト：行頭で [!info] とスペース（info / warning / danger / success）
- 表：| 列 1 | 列 2 | と入力して Enter、または Ctrl+Shift+T

## ファイル

- 左のファイルツリーで作成・名前変更・削除、右クリックで履歴を表示
- タブは別ウィンドウに切り離せます。タブバーに戻せば合流します
- ピン留めしたタブは誤って閉じられません
- 下書きは自動保存。ウィンドウを閉じるときに一度だけ確認します

## 検索と比較

- 検索 Ctrl+F、置換 Ctrl+H（どちらも正規表現に対応）
- テキスト比較 Ctrl+D。フォルダ比較と 3 方向マージは「比較」メニュー

## その他のショートカット

「ヘルプ → ショートカット一覧」を参照してください。

## データ

設定・下書き・履歴はこの PC 内だけに保存されます。アカウントもアップロードも通信もありません。
`,

  ko: `# EZNotepad 사용 설명서

간단하고 가볍고 쓰기 좋은 Markdown / 텍스트 편집기입니다. 파일은 이 PC 안에서만 읽고 쓰며 네트워크에 연결하지 않습니다.

> 이 설명서는 프로그램에 내장되어 있습니다: 디스크에 파일이 없고, 미리보기만 되며, 닫을 수도 없습니다. 남기고 싶은 부분은 직접 문서로 복사하세요.

## 세 가지 모드

- **위지윅**: # 과 공백으로 제목이 되고, **굵게**는 그 자리에서 굵어집니다
- **편집 모드**: Markdown 원문을 줄 번호와 구문 강조와 함께 편집
- **미리보기**: 읽기 전용 렌더링

툴바의 모드 드롭다운으로 바꾸거나 Ctrl+1 / 2 / 3 을 누릅니다.

## 블록

한 줄이 한 블록입니다. 줄 앞에 마우스를 두면 ⋮⋮ 손잡이가 나타납니다:

| 하고 싶은 일 | 방법 |
|---|---|
| 블록 종류 바꾸기 | 손잡이를 클릭해 종류 선택 |
| 블록 옮기기 | 손잡이를 잡고 위아래로 드래그 (들어갈 자리에 선이 표시됩니다) |
| 블록 하나 선택 | Shift + 손잡이 클릭 |
| 떨어진 블록 추가 선택 | 선택 모드에서 Ctrl + 손잡이 클릭 |
| 블록 위아래로 이동 | Ctrl+Shift+↑ / ↓ |
| 제목 접기 | 제목 왼쪽의 삼각형 클릭 |

선택 모드에서는 편집기 위쪽에 안내가 나옵니다. 이때:

- 다른 블록을 클릭 → 연속된 범위로 확장
- Ctrl + 클릭 → 그 블록만 추가 / 해제
- 마우스 오른쪽 클릭 → 선택한 블록을 한꺼번에 처리 (삭제, 종류 변환, 위아래 이동, Markdown 으로 복사)
- Esc → 선택 모드 종료

선택한 블록은 한꺼번에 끌 수 있습니다. 위아래 이동은 연속된 범위에서만 동작합니다.

## 자주 쓰는 문법

- 제목 # ~ ######, 목록 - 또는 1., 인용 >, 코드 블록은 백틱 세 개
- 인라인 **굵게**, *기울임*, \`코드\`, ==형광펜==, ~~취소선~~
- 콜아웃: 줄 앞에 [!info] 와 공백 (info / warning / danger / success)
- 표: | 열 1 | 열 2 | 를 입력하고 Enter, 또는 Ctrl+Shift+T

## 파일

- 왼쪽 파일 트리에서 만들기·이름 바꾸기·삭제, 오른쪽 클릭으로 이전 버전 보기
- 탭을 끌어내 별도 창으로 만들 수 있고, 탭 막대로 되돌리면 합쳐집니다
- 고정한 탭은 실수로 닫히지 않습니다
- 초안은 자동 저장되고, 창을 닫을 때 한 번 확인합니다

## 찾기와 비교

- 찾기 Ctrl+F, 바꾸기 Ctrl+H (둘 다 정규식 지원)
- 텍스트 비교 Ctrl+D, 폴더 비교와 3방향 병합은 비교 메뉴에 있습니다

## 그 밖의 단축키

도움말 → 단축키 목록을 보세요.

## 데이터

설정·초안·기록은 이 PC 안에만 저장됩니다. 계정도, 업로드도, 네트워크도 없습니다.
`,

  fr: `# Manuel d'EZNotepad

Un éditeur Markdown et texte simple, léger et agréable. Les fichiers sont lus et écrits uniquement sur cette machine — sans réseau, sans envoi.

> Ce manuel est intégré au programme : aucun fichier sur le disque, aperçu uniquement, et il ne peut pas être fermé. Pour en garder un passage, copiez le texte dans votre propre document.

## Trois modes

- **WYSIWYG** : tapez # et une espace pour un titre ; **gras** s'affiche en gras immédiatement
- **Édition** : le Markdown brut, avec numéros de ligne et coloration syntaxique
- **Aperçu** : rendu en lecture seule

Basculez avec la liste Mode de la barre d'outils, ou Ctrl+1 / 2 / 3.

## Blocs

Chaque ligne est un bloc. Approchez la souris du début d'une ligne et une poignée ⋮⋮ apparaît :

| Pour | Faire |
|---|---|
| Changer le type du bloc | Cliquer la poignée, choisir un type |
| Déplacer un bloc | Maintenir la poignée et glisser ; un trait montre l'arrivée |
| Sélectionner un bloc | Maj + clic sur la poignée |
| Ajouter un bloc isolé | En mode sélection, Ctrl + clic sur la poignée |
| Monter / descendre le bloc | Ctrl+Maj+↑ / ↓ |
| Replier un titre | Cliquer le triangle à gauche du titre |

Le mode sélection affiche un bandeau en haut de l'éditeur. Pendant ce temps :

- cliquer un autre bloc étend la sélection en plage continue
- Ctrl + clic ajoute ou retire ce seul bloc
- clic droit : supprimer, changer le type, monter/descendre, copier en Markdown
- Échap pour sortir

Les blocs sélectionnés se déplacent en groupe. Monter/descendre ne vaut que pour une suite continue — des blocs isolés n'ont pas de « une case plus bas » cohérent.

## Syntaxe courante

- Titres # à ######, listes - ou 1., citations >, blocs de code avec trois accents graves
- En ligne **gras**, *italique*, \`code\`, ==surligné==, ~~barré~~
- Encadrés : tapez [!info] puis une espace en début de ligne — info / warning / danger / success
- Tableaux : tapez | a | b | puis Entrée, ou Ctrl+Maj+T

## Fichiers

- L'arborescence à gauche permet créer, renommer, supprimer ; clic droit pour l'historique
- Les onglets se détachent en fenêtre et se rattachent en les ramenant
- Un onglet épinglé ne se ferme pas par accident
- Les brouillons sont enregistrés automatiquement ; la fermeture demande une fois

## Rechercher et comparer

- Rechercher Ctrl+F, remplacer Ctrl+H, tous deux avec expressions régulières
- Comparer des textes Ctrl+D ; comparer des dossiers et la fusion à trois se trouvent dans le menu Comparer

## Autres raccourcis

Voir Aide → Raccourcis clavier.

## Données

Réglages, brouillons et historique restent sur cette machine. Aucun compte, aucun envoi, aucun réseau.
`,

  de: `# EZNotepad Handbuch

Ein einfacher, leichter und angenehmer Editor für Markdown und reinen Text. Dateien werden nur auf diesem Rechner gelesen und geschrieben — ohne Netzwerk, ohne Upload.

> Dieses Handbuch ist ins Programm eingebaut: keine Datei auf der Festplatte, nur Vorschau, und es lässt sich nicht schließen. Um etwas daraus zu behalten, kopieren Sie den Text in ein eigenes Dokument.

## Drei Modi

- **WYSIWYG**: # und ein Leerzeichen ergeben eine Überschrift; **fett** wird sofort fett
- **Bearbeiten**: reines Markdown mit Zeilennummern und Syntaxfarben
- **Vorschau**: schreibgeschützte Darstellung

Umschalten über das Modus-Menü in der Werkzeugleiste oder mit Strg+1 / 2 / 3.

## Blöcke

Jede Zeile ist ein Block. Fährt man an den Zeilenanfang, erscheint ein ⋮⋮-Griff:

| Ziel | Vorgehen |
|---|---|
| Blocktyp ändern | Griff anklicken, Typ wählen |
| Block verschieben | Griff halten und ziehen; eine Linie zeigt das Ziel |
| Einen Block auswählen | Umschalt + Klick auf den Griff |
| Einzelnen Block hinzufügen | Im Auswahlmodus Strg + Klick auf den Griff |
| Block nach oben/unten | Strg+Umschalt+↑ / ↓ |
| Überschrift falten | Dreieck links der Überschrift anklicken |

Im Auswahlmodus erscheint oben ein Hinweisband. Dann gilt:

- Klick auf einen anderen Block erweitert die Auswahl zu einem Bereich
- Strg + Klick fügt genau diesen Block hinzu oder entfernt ihn
- Rechtsklick: löschen, Typ ändern, nach oben/unten, als Markdown kopieren
- Esc beendet den Modus

Ausgewählte Blöcke lassen sich als Gruppe ziehen. Nach oben/unten geht nur bei einer zusammenhängenden Folge — getrennte Blöcke haben kein sinnvolles „eine Position tiefer".

## Häufige Syntax

- Überschriften # bis ######, Listen - oder 1., Zitate >, Codeblöcke mit drei Backticks
- Inline **fett**, *kursiv*, \`Code\`, ==markiert==, ~~durchgestrichen~~
- Hinweisblöcke: am Zeilenanfang [!info] und ein Leerzeichen — info / warning / danger / success
- Tabellen: | a | b | tippen und Enter, oder Strg+Umschalt+T

## Dateien

- Der Dateibaum links kann anlegen, umbenennen, löschen; Rechtsklick zeigt den Verlauf
- Tabs lassen sich in ein eigenes Fenster ziehen und wieder andocken
- Angeheftete Tabs lassen sich nicht versehentlich schließen
- Entwürfe werden automatisch gespeichert; beim Schließen wird einmal gefragt

## Suchen und vergleichen

- Suchen Strg+F, Ersetzen Strg+H, beide mit regulären Ausdrücken
- Textvergleich Strg+D; Ordnervergleich und Drei-Wege-Zusammenführung im Menü Vergleichen

## Weitere Tastenkürzel

Siehe Hilfe → Tastenkürzel.

## Daten

Einstellungen, Entwürfe und Verlauf bleiben auf diesem Rechner. Kein Konto, kein Upload, kein Netzwerk.
`,

  es: `# Manual de EZNotepad

Un editor de Markdown y texto plano sencillo, ligero y agradable. Los archivos se leen y escriben solo en este equipo: sin red, sin subidas.

> Este manual está integrado en el programa: no hay archivo en el disco, solo vista previa, y no se puede cerrar. Para conservar algo, copia el texto en tu propio documento.

## Tres modos

- **WYSIWYG**: escribe # y un espacio para un título; **negrita** se aplica al momento
- **Edición**: el Markdown original, con números de línea y colores de sintaxis
- **Vista previa**: representación de solo lectura

Cambia con el desplegable Modo de la barra de herramientas, o con Ctrl+1 / 2 / 3.

## Bloques

Cada línea es un bloque. Al pasar el ratón por el inicio de una línea aparece un asa ⋮⋮:

| Para | Haz esto |
|---|---|
| Cambiar el tipo de bloque | Clic en el asa, elige un tipo |
| Mover un bloque | Mantén el asa y arrastra; una línea marca el destino |
| Seleccionar un bloque | Mayús + clic en el asa |
| Añadir un bloque suelto | En el modo selección, Ctrl + clic en el asa |
| Subir o bajar el bloque | Ctrl+Mayús+↑ / ↓ |
| Plegar un título | Clic en el triángulo a la izquierda del título |

El modo selección muestra una banda de ayuda arriba. Mientras está activo:

- clic en otro bloque amplía la selección a un rango continuo
- Ctrl + clic añade o quita solo ese bloque
- clic derecho: borrar, cambiar tipo, subir/bajar, copiar como Markdown
- Esc para salir

Los bloques seleccionados se arrastran en grupo. Subir y bajar solo funciona en una secuencia continua: bloques sueltos no tienen un «una posición más abajo» coherente.

## Sintaxis habitual

- Títulos # a ######, listas - o 1., citas >, bloques de código con tres acentos graves
- En línea **negrita**, *cursiva*, \`código\`, ==resaltado==, ~~tachado~~
- Avisos: escribe [!info] y un espacio al inicio de la línea — info / warning / danger / success
- Tablas: escribe | a | b | y pulsa Intro, o Ctrl+Mayús+T

## Archivos

- El árbol de la izquierda permite crear, renombrar y borrar; clic derecho para el historial
- Las pestañas se pueden sacar a su propia ventana y volver a unir
- Las pestañas fijadas no se cierran por error
- Los borradores se guardan solos; al cerrar se pregunta una vez

## Buscar y comparar

- Buscar Ctrl+F, reemplazar Ctrl+H, ambos con expresiones regulares
- Comparar textos Ctrl+D; comparar carpetas y la fusión a tres están en el menú Comparar

## Más atajos

Consulta Ayuda → Atajos de teclado.

## Datos

Ajustes, borradores e historial se quedan en este equipo. Sin cuenta, sin subidas, sin red.
`,

  pt: `# Manual do EZNotepad

Um editor de Markdown e texto simples, leve e agradável. Os arquivos são lidos e gravados só nesta máquina: sem rede, sem envio.

> Este manual é embutido no programa: não há arquivo no disco, só visualização, e não pode ser fechado. Para guardar algum trecho, copie o texto para o seu próprio documento.

## Três modos

- **WYSIWYG**: digite # e um espaço para virar título; **negrito** aplica na hora
- **Edição**: o Markdown original, com números de linha e cores de sintaxe
- **Pré-visualização**: renderização somente leitura

Alterne pelo menu Modo na barra de ferramentas, ou com Ctrl+1 / 2 / 3.

## Blocos

Cada linha é um bloco. Ao passar o mouse no início da linha aparece uma alça ⋮⋮:

| Para | Faça |
|---|---|
| Trocar o tipo do bloco | Clique na alça e escolha um tipo |
| Mover um bloco | Segure a alça e arraste; uma linha mostra o destino |
| Selecionar um bloco | Shift + clique na alça |
| Adicionar um bloco avulso | No modo seleção, Ctrl + clique na alça |
| Subir ou descer o bloco | Ctrl+Shift+↑ / ↓ |
| Recolher um título | Clique no triângulo à esquerda do título |

O modo seleção mostra uma faixa de dica no topo. Enquanto ele está ativo:

- clicar em outro bloco estende a seleção para um intervalo contínuo
- Ctrl + clique adiciona ou remove só aquele bloco
- clique direito: excluir, trocar tipo, subir/descer, copiar como Markdown
- Esc para sair

Os blocos selecionados arrastam em grupo. Subir e descer só vale para uma sequência contínua — blocos separados não têm um «uma posição abaixo» coerente.

## Sintaxe comum

- Títulos # a ######, listas - ou 1., citações >, blocos de código com três crases
- Em linha **negrito**, *itálico*, \`código\`, ==destacado==, ~~riscado~~
- Avisos: digite [!info] e um espaço no início da linha — info / warning / danger / success
- Tabelas: digite | a | b | e pressione Enter, ou Ctrl+Shift+T

## Arquivos

- A árvore à esquerda cria, renomeia e exclui; clique direito mostra o histórico
- Abas podem ser arrastadas para uma janela própria e trazidas de volta
- Abas fixadas não fecham por acidente
- Rascunhos salvam sozinhos; ao fechar o programa pergunta uma vez

## Localizar e comparar

- Localizar Ctrl+F, substituir Ctrl+H, ambos com expressões regulares
- Comparar textos Ctrl+D; comparar pastas e a mesclagem a três ficam no menu Comparar

## Mais atalhos

Veja Ajuda → Atalhos de teclado.

## Dados

Configurações, rascunhos e histórico ficam nesta máquina. Sem conta, sem envio, sem rede.
`,
};

/** 取当前语言的手册，缺条目时退到英文 */
export const manualDoc = (lang) => DOCS[lang] || DOCS.en;
