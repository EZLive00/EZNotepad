import { localizeShortcuts } from './i18n.js';

/* ============================================================
   welcome.js —— 首次启动时自动建的那个「欢迎.md」

   为什么单独放一个文件：它是一整篇 Markdown（多行、带表格和任务列表），
   塞进 i18n 词条表会跟几百条短标签混在一起，改起来找不到。

   简体是母本，繁体由 OpenCC s2twp 转出（工具列、檔案、儲存这些短语级转换
   是手写容易出错的地方，交给字典）；其余 7 种语言手写。
   ============================================================ */

const DOCS = {
  'zh-CN': `# 欢迎使用 EZNotepad

安装包不到 10MB、免安装、不联网：把 **Markdown 写作**、**纯文本编辑**、**文件对比** 收在一个窗口里。

## 三种模式

- **所见即所得**：输入 # 加空格立刻变标题，**粗体**马上加粗
- **编辑模式**：显示原始 Markdown，带行号、语法着色、代码折叠
- **预览模式**：只读渲染

用工具栏的「模式」下拉切换，或按 Ctrl+1 / Ctrl+2 / Ctrl+3。

## 常用快捷键

| 操作 | 快捷键 |
|---|---|
| 新建 / 打开 / 保存 | Ctrl+N / Ctrl+O / Ctrl+S |
| 查找 / 替换 | Ctrl+F / Ctrl+H |
| 文本对比 | Ctrl+D |

## 提示块

行首输入 [!info] 加空格，就能生成提示块；info / warning / danger / success 四种配色，和 GitHub、Obsidian 的写法互通。

- [x] 多标签页
- [x] 自动保存草稿
- [ ] 去写点什么
`,

  'zh-TW': `# 歡迎使用 EZNotepad

安裝包不到 10MB、免安裝、不聯網：把 **Markdown 寫作**、**純文字編輯**、**檔案對比** 收在一個視窗裡。

## 三種模式

- **所見即所得**：輸入 # 加空格立刻變標題，**粗體**馬上加粗
- **編輯模式**：顯示原始 Markdown，帶行號、語法著色、程式碼摺疊
- **預覽模式**：只讀渲染

用工具列的「模式」下拉切換，或按 Ctrl+1 / Ctrl+2 / Ctrl+3。

## 常用快速鍵

| 操作 | 快速鍵 |
|---|---|
| 新建 / 開啟 / 儲存 | Ctrl+N / Ctrl+O / Ctrl+S |
| 查詢 / 替換 | Ctrl+F / Ctrl+H |
| 文字對比 | Ctrl+D |

## 提示區塊

行首輸入 [!info] 加空格，就能生成提示區塊；info / warning / danger / success 四種配色，和 GitHub、Obsidian 的寫法互通。

- [x] 多分頁
- [x] 自動儲存草稿
- [ ] 去寫點什麼
`,

  en: `# Welcome to EZNotepad

Under 10 MB, no installation, no network: **Markdown writing**, **plain-text editing** and **file comparison** in a single window.

## Three modes

- **WYSIWYG**: type # and a space to get a heading; **bold** turns bold as you type
- **Editing**: the raw Markdown, with line numbers, syntax colors and code folding
- **Preview**: read-only rendering

Switch from the Mode dropdown in the toolbar, or press Ctrl+1 / Ctrl+2 / Ctrl+3.

## Shortcuts

| Action | Shortcut |
|---|---|
| New / Open / Save | Ctrl+N / Ctrl+O / Ctrl+S |
| Find / Replace | Ctrl+F / Ctrl+H |
| Compare text | Ctrl+D |

## Callouts

Type [!info] plus a space at the start of a line to create a callout — four colors: info / warning / danger / success, compatible with GitHub and Obsidian syntax.

- [x] Multiple tabs
- [x] Auto-saved drafts
- [ ] Write something
`,

  ja: `# EZNotepad へようこそ

10MB 未満、インストール不要、ネット接続不要。**Markdown 執筆**、**テキスト編集**、**ファイル比較** を 1 つのウィンドウに。

## 3 つのモード

- **WYSIWYG**：# と空白を入力すると見出しに、**太字** はその場で太字に
- **編集モード**：生の Markdown を行番号・色分け・コード折りたたみ付きで表示
- **プレビュー**：読み取り専用の表示

ツールバーの「モード」から切り替えるか、Ctrl+1 / Ctrl+2 / Ctrl+3 を押します。

## 主なショートカット

| 操作 | ショートカット |
|---|---|
| 新規 / 開く / 保存 | Ctrl+N / Ctrl+O / Ctrl+S |
| 検索 / 置換 | Ctrl+F / Ctrl+H |
| テキスト比較 | Ctrl+D |

## コールアウト

行頭で [!info] と空白を入力するとコールアウトになります。info / warning / danger / success の 4 色で、GitHub や Obsidian の記法と互換です。

- [x] 複数タブ
- [x] 下書きの自動保存
- [ ] 何か書いてみる
`,

  ko: `# EZNotepad에 오신 것을 환영합니다

10MB 미만, 설치 없음, 네트워크 없음. **Markdown 작성**, **텍스트 편집**, **파일 비교**를 한 창에서.

## 세 가지 모드

- **위지윅**: # 과 공백을 입력하면 제목이 되고, **굵게**는 바로 굵게 표시됩니다
- **편집 모드**: 원본 Markdown을 줄 번호, 구문 강조, 코드 접기와 함께 표시
- **미리보기**: 읽기 전용 렌더링

도구 모음의 '모드'에서 바꾸거나 Ctrl+1 / Ctrl+2 / Ctrl+3을 누르세요.

## 주요 단축키

| 동작 | 단축키 |
|---|---|
| 새로 만들기 / 열기 / 저장 | Ctrl+N / Ctrl+O / Ctrl+S |
| 찾기 / 바꾸기 | Ctrl+F / Ctrl+H |
| 텍스트 비교 | Ctrl+D |

## 콜아웃

줄 맨 앞에서 [!info] 와 공백을 입력하면 콜아웃이 만들어집니다. info / warning / danger / success 네 가지 색이며 GitHub, Obsidian 표기와 호환됩니다.

- [x] 여러 탭
- [x] 초안 자동 저장
- [ ] 무엇이든 써 보세요
`,

  fr: `# Bienvenue dans EZNotepad

Moins de 10 Mo, sans installation, sans réseau : **écriture Markdown**, **édition de texte brut** et **comparaison de fichiers** dans une seule fenêtre.

## Trois modes

- **WYSIWYG** : tapez # puis une espace pour obtenir un titre ; **gras** s'applique aussitôt
- **Édition** : le Markdown brut, avec numéros de ligne, coloration et repli du code
- **Aperçu** : rendu en lecture seule

Basculez par la liste « Mode » de la barre d'outils, ou avec Ctrl+1 / Ctrl+2 / Ctrl+3.

## Raccourcis

| Action | Raccourci |
|---|---|
| Nouveau / Ouvrir / Enregistrer | Ctrl+N / Ctrl+O / Ctrl+S |
| Rechercher / Remplacer | Ctrl+F / Ctrl+H |
| Comparer des textes | Ctrl+D |

## Encadrés

Tapez [!info] suivi d'une espace en début de ligne pour créer un encadré — quatre couleurs : info / warning / danger / success, compatible avec GitHub et Obsidian.

- [x] Onglets multiples
- [x] Brouillons enregistrés automatiquement
- [ ] Écrivez quelque chose
`,

  de: `# Willkommen bei EZNotepad

Unter 10 MB, ohne Installation, ohne Netzwerk: **Markdown schreiben**, **Text bearbeiten** und **Dateien vergleichen** in einem Fenster.

## Drei Modi

- **WYSIWYG**: # und ein Leerzeichen ergibt eine Überschrift; **fett** wird sofort fett
- **Bearbeiten**: das rohe Markdown, mit Zeilennummern, Syntaxfarben und Code-Faltung
- **Vorschau**: schreibgeschützte Darstellung

Umschalten über die Auswahl „Modus“ in der Werkzeugleiste oder mit Strg+1 / Strg+2 / Strg+3.

## Tastenkürzel

| Aktion | Kürzel |
|---|---|
| Neu / Öffnen / Speichern | Strg+N / Strg+O / Strg+S |
| Suchen / Ersetzen | Strg+F / Strg+H |
| Texte vergleichen | Strg+D |

## Hinweisblöcke

[!info] plus Leerzeichen am Zeilenanfang erzeugt einen Hinweisblock — vier Farben: info / warning / danger / success, kompatibel mit GitHub und Obsidian.

- [x] Mehrere Tabs
- [x] Automatisch gespeicherte Entwürfe
- [ ] Schreiben Sie etwas
`,

  es: `# Bienvenido a EZNotepad

Menos de 10 MB, sin instalación y sin conexión: **escritura Markdown**, **edición de texto plano** y **comparación de archivos** en una sola ventana.

## Tres modos

- **WYSIWYG**: escribe # y un espacio para obtener un título; **negrita** se aplica al momento
- **Edición**: el Markdown original, con números de línea, colores de sintaxis y plegado de código
- **Vista previa**: representación de solo lectura

Cambia desde la lista «Modo» de la barra de herramientas o con Ctrl+1 / Ctrl+2 / Ctrl+3.

## Atajos

| Acción | Atajo |
|---|---|
| Nuevo / Abrir / Guardar | Ctrl+N / Ctrl+O / Ctrl+S |
| Buscar / Reemplazar | Ctrl+F / Ctrl+H |
| Comparar textos | Ctrl+D |

## Bloques de aviso

Escribe [!info] y un espacio al inicio de una línea para crear un bloque de aviso; cuatro colores: info / warning / danger / success, compatible con GitHub y Obsidian.

- [x] Varias pestañas
- [x] Borradores guardados automáticamente
- [ ] Escribe algo
`,

  pt: `# Bem-vindo ao EZNotepad

Menos de 10 MB, sem instalação e sem rede: **escrita Markdown**, **edição de texto simples** e **comparação de arquivos** numa única janela.

## Três modos

- **WYSIWYG**: digite # e um espaço para criar um título; **negrito** aplica-se na hora
- **Edição**: o Markdown original, com números de linha, cores de sintaxe e recolhimento de código
- **Pré-visualização**: visualização apenas de leitura

Alterne na lista «Modo» da barra de ferramentas ou com Ctrl+1 / Ctrl+2 / Ctrl+3.

## Atalhos

| Ação | Atalho |
|---|---|
| Novo / Abrir / Salvar | Ctrl+N / Ctrl+O / Ctrl+S |
| Localizar / Substituir | Ctrl+F / Ctrl+H |
| Comparar textos | Ctrl+D |

## Blocos de aviso

Digite [!info] e um espaço no início da linha para criar um bloco de aviso — quatro cores: info / warning / danger / success, compatível com GitHub e Obsidian.

- [x] Várias abas
- [x] Rascunhos salvos automaticamente
- [ ] Escreva algo
`,
};

/** 取当前语言的欢迎文档，缺条目时退到英文 */
export const welcomeDoc = (lang) => localizeShortcuts(DOCS[lang] || DOCS.en);
