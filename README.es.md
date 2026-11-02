<div align="center">

# EZNotepad

> Una pequeña utilidad de escritorio de **5 MB**: escritura en Markdown + lectura y escritura de texto + comparación de archivos.
> Portable, sin conexión a Internet, lista para usar con solo un doble clic.
> La interfaz está disponible en 9 idiomas; sigue el idioma del sistema de forma predeterminada y también se puede cambiar manualmente en «Ajustes → Idioma».

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | **Español** | [Português](README.pt.md)

[![Release](https://img.shields.io/github/v/release/EZLive00/EZNotepad)](https://github.com/EZLive00/EZNotepad/releases)
[![License](https://img.shields.io/badge/license-AGPL--v3-blue)](./LICENSE)

</div>

---

## Descarga e instalación

Descarga desde [Releases](https://github.com/EZLive00/EZNotepad/releases):

| Producto | Para quién |
|---|---|
| `EZNotepad_<版本>_x64-setup.exe` | **Versión instalable**: asistente de instalación + asociación de archivos; haz doble clic en un `.md` / `.txt` y se abre directamente |
| `EZNotepad_<版本>_x64-portable.zip` | **Versión portable**: descomprime en cualquier carpeta y haz doble clic en `EZNotepad.exe` para usarla |

- Ninguna de las dos lleva firma de código; la primera vez SmartScreen la bloqueará una vez: pulsa «Más información» → «Ejecutar de todos modos»
- La versión portable depende del runtime WebView2 del sistema (Win10 / Win11 ya lo traen integrado); no escribe en el registro ni registra asociaciones de archivos
- Por ahora solo se distribuyen paquetes para Windows x64

---

## Capturas de pantalla

**Tema claro**

![Interfaz principal de EZNotepad con el tema claro](docs/screenshots/light.png)

**Tema oscuro**

![Interfaz principal de EZNotepad con el tema oscuro](docs/screenshots/dark.png)

---

## Qué sustituye

| Qué usabas | Para qué | Qué ganas |
|---|---|---|
| Bloc de notas | Abrir cualquier texto, cambiar la codificación, revisar registros | Abre igual, y además añade números de línea, resaltado y esquema |
| Typora | Ver el Markdown mientras escribes | Tres modos a elegir, 20 veces más ligero |
| BeyondCompare | Comparar dos archivos y ver en qué difieren | Comparación lado a lado, cambios marcados a nivel de carácter y salto entre diferencias con F7/F8 |

---

## Tres modos (un desplegable, adaptación automática según el tipo de archivo)

| Modo | Qué hace | Atajo |
|---|---|---|
| **WYSIWYG** | Escribe `# ` y se convierte en título, `**粗**` se pone en negrita al instante | `Ctrl+1` |
| **Modo de edición** | Ver el Markdown original / código fuente, con números de línea, color de sintaxis y plegado | `Ctrl+2` |
| **Modo de vista previa** | Renderizado de solo lectura, para leer concentrado | `Ctrl+3` |

**Tipos de archivo admitidos**: `.md` (los tres modos activados), `.json` (validación + resaltado + localización de errores),
`.txt` `.log` `.csv` y los archivos de código habituales (`.js/.ts/.py/.rs/.go/.html/.css/.sql/.yml/...`).
**Al crear un archivo nuevo primero se te pide elegir el tipo** (Markdown / texto plano / JSON / CSV / código); los archivos que no son Markdown
solo ofrecen «Edición / Vista previa» y se manejan como un editor de texto normal.

## El modo de edición usa CodeMirror 6

No es un `<textarea>` disfrazado. Es, de verdad, todo lo que trae un editor de código:

| | Descripción |
|---|---|
| **Coloreado de sintaxis** | JS/TS/JSX, Python, Rust, Go, Java, C/C++, JSON, CSS, HTML, SQL, YAML, Shell, INI, Markdown, con análisis incremental |
| **Números de línea / línea actual** | Gutter de números de línea, fondo de la línea actual, emparejamiento de llaves y plegado de código |
| **Deshacer** | El historial a nivel de transacciones propio de CM6, más fiable que el contenteditable del navegador |
| **Archivos grandes** | Solo se renderizan las líneas visibles. En pruebas: 50 000 líneas se abren en 49 ms y 100 000 en 20 ms, dejando en el DOM apenas un centenar de líneas |
| **Sangría** | Tab con selección indenta el bloque entero, sin selección indenta la línea actual; Shift+Tab desindenta; al pulsar Enter se hereda la sangría de la línea anterior |
| **Paréntesis emparejados** | Al escribir `(` se añade `)` automáticamente, igual con las comillas; si el cursor está entre un par, escribir el de cierre «salta» al otro lado en vez de insertar otro |
| **Temas** | Un tema claro y uno oscuro que cambian con la aplicación; los colores de sintaxis y la vista previa comparten las mismas variables CSS |

Los colores se definen una sola vez en `body[data-theme]` de `styles.css`, y el editor y el renderizador de vista previa los toman de ahí,
así que no puede ocurrir que haya dos juegos de colores que no coincidan.

Las opciones no aplicables se ponen en gris automáticamente: al abrir un JSON, «WYSIWYG» aparece deshabilitado, para que no lo pulses por error.

---

## Distribución de la interfaz (cada función tiene una sola entrada)

```
┌──────────────────────────────────────────────┐
│ ▣ Archivo Editar Formato Ver Herramientas Ayuda  Hola.md  － □ ✕│ ← Barra de título (40px)
├──────────────────────────────────────────────┤
│ Hola.md × │ test.json × │ +        Edición▾ ⌕ Guardar │ ← Pestañas y herramientas en la misma fila
├────────┬──────────────────┬──────────────────┤
│        │                  │                  │
│ Esquema│  Edición / WYSIWYG│    Vista previa  │
│        │                  │                  │
├────────┴──────────────────┴──────────────────┤
│ Línea 1, Col 1 │ 36 líneas │ 243 caracteres │ Markdown │ LF │ UTF-8 │ Guardado │
└──────────────────────────────────────────────┘
```

Encima del área de contenido solo hay dos filas: la barra de título (menú + título del documento + botones de ventana) y una fila que combina pestañas y herramientas
(a la izquierda las pestañas; a la derecha solo las tres acciones más frecuentes: **cambio de modo / Buscar / Guardar**; todo lo demás está en el menú, sin duplicar entradas).
Cuando la ventana se estrecha, las herramientas pasan a ser solo iconos.

La ventana no tiene barra de título del sistema (`decorations: false`): menú, título del documento y botones de ventana están en la fila superior,
el espacio vacío del centro sirve para arrastrar la ventana y un doble clic la maximiza, igual que en apps como VS Code o WorkBuddy.
Las cuatro esquinas usan los bordes redondeados nativos de DWM de Win11, y arrastrando los bordes se sigue pudiendo redimensionar.
Con «Ver → Mostrar el nombre del archivo en la barra de título» puedes ocultar el texto del título y dejar solo el menú y los botones.

- **Esquema** — solo para navegar
- **Barra lateral** — dos páginas: esquema (resalta la sección actual siguiendo el desplazamiento) / archivos (árbol de directorios + búsqueda de contenido en todo el directorio)
- **Fila de herramientas** — solo tres acciones frecuentes: modo, buscar y guardar; el resto de comandos va siempre por el menú
- **Área de contenido** — solo para editar
- **Barra de estado** — solo información; la codificación y el salto de línea se cambian haciendo clic
- **Menú** — la entrada al conjunto completo de funciones
- **Ajustes** — `Ctrl+,` un solo panel: tema, tamaño de fuente, interfaz, autoguardado, carpeta de trabajo
- **Centro de comparación** — panel independiente a pantalla completa, sin mezclarse con el editor

---

### Página «Archivos» de la barra lateral: árbol de directorios y búsqueda entre archivos

- Se lee un nivel cada vez que se expande (carga perezosa), así que abrir un repositorio grande no lee decenas de miles de archivos de golpe
- **Clic derecho para todo**: crear archivos / carpetas en cualquier directorio, renombrar archivos o eliminarlos
  - Lo eliminado va a la **papelera de reciclaje** del sistema, así que si te equivocas puedes recuperarlo; las carpetas solo se borran si están vacías, nunca en cascada
  - Al renombrar o eliminar, la pestaña que ya estaba abierta se actualiza con él (no vuelve a escribir sobre la ruta antigua)
- La búsqueda se ejecuta en Rust; omite los binarios y los archivos de más de 4 MB, y devuelve como máximo 200 resultados
- El botón `.*` del cuadro de búsqueda activa las expresiones regulares y `Aa` distingue mayúsculas de minúsculas
- Los resultados se agrupan por archivo, con número de línea y fragmento; un clic abre el archivo y salta a esa línea
- **Reemplazo entre archivos**: rellena «Reemplazar por» bajo el cuadro de búsqueda y pulsa «Reemplazar todo». Antes pregunta una vez, avisando de que va a tocar el disco;
  y antes de modificar cada archivo deja una instantánea en el historial, por si hay que recuperar algo
- Recuerda la última carpeta abierta; se puede cambiar o vaciar desde el panel de ajustes

---

### Buscar (`Ctrl+F` / `Ctrl+H`)

Un panel flotante con dos estados: pulsa la flecha del extremo izquierdo para desplegar dos líneas, «Buscar + Reemplazar»; al plegar queda solo la búsqueda.
`Ctrl+F` solo enfoca (no vuelve a plegar la línea de reemplazo ya desplegada), y `Ctrl+H` la despliega directamente.

| Capacidad | Descripción |
|---|---|
| **Búsqueda in situ en WYSIWYG** | Ya no hace falta cambiar al modo de edición para buscar; el resaltado se dibuja en la capa de renderizado (CSS Highlight API), sin insertar marcas en el texto |
| **Interruptores de modo** | Cuatro cuadraditos a la derecha del cuadro de entrada: `Aa` distingue mayúsculas y minúsculas, `.*` expresión regular, `全词` palabra completa, `选区` solo la selección. Al activarse usan el color de acento |
| **Palabras completas** | Solo se añade el límite de palabra si a ambos lados de la consulta hay caracteres de palabra en inglés; el chino no tiene límites de palabra y aplicar `\b` a la fuerza haría que nunca coincidiera |
| **Dentro de la selección** | Busca/reemplaza solo dentro del texto seleccionado; sin selección, esta opción aparece en gris |
| **Salto de línea** | El `↵` del extremo derecho del cuadro (o `Ctrl+Enter`) inserta un salto de línea y el cuadro crece solo; las consultas sin salto de línea siguen sin dar falsas coincidencias entre párrafos |
| **Reemplazar** | Si las coincidencias están dentro del mismo tramo de texto, **se cambia directamente**, sin diálogos; solo se pregunta «¿cambiar al modo de edición?» cuando cruza límites de formato como negritas o enlaces |
| **Entre archivos** | El cuadro de búsqueda de la página «Archivos» de la barra lateral, que lista las líneas con coincidencias agrupadas por archivo |

---

## Atajos de teclado

| Acción | Atajo |
|---|---|
| Nuevo / Abrir / Guardar / Guardar como | `Ctrl+N` / `Ctrl+O` / `Ctrl+S` / `Ctrl+Shift+S` |
| Cerrar pestaña / Cambiar de pestaña | `Ctrl+W` / `Ctrl+Tab` |
| Buscar / Reemplazar / Ir a línea | `Ctrl+F` / `Ctrl+H` / `Ctrl+G` |
| **Paleta de comandos** | `Ctrl+Shift+P` |
| Ajustes | `Ctrl+,` |
| **Formatear con un clic** | `Ctrl+Shift+F` |
| **Comparar textos** | `Ctrl+D` |
| Diferencia siguiente / anterior | `F8` / `F7` |
| Una columna ⇄ dos columnas | `Ctrl+Shift+L` |
| Mostrar / ocultar esquema | `Ctrl+Shift+O` |
| Modo enfoque (salir con `Esc`) / Pantalla completa | `F9` / `F11` |
| Negrita / Cursiva | `Ctrl+B` / `Ctrl+I` |
| Tachado / Código en línea | `Ctrl+Shift+X` / — |
| Insertar enlace / Insertar tabla | `Ctrl+K` / `Ctrl+Shift+T` |
| Cuerpo / Títulos de nivel 1 a 3 | `Ctrl+Alt+0` / `Ctrl+Alt+1~3` |
| Lista sin orden / con orden / de tareas | `Ctrl+Shift+8` / `Ctrl+Shift+7` / `Ctrl+Shift+9` |
| Cita / Bloque de código | `Ctrl+Shift+Q` / `Ctrl+Shift+K` |
| Aumentar / reducir sangría de la lista | `Tab` / `Shift+Tab` |
| Agrandar / reducir / restablecer el tamaño de fuente | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` |
| Exportar a PDF | `Ctrl+P` |

---

## Funciones más usadas

### WYSIWYG: sirve de verdad como editor

No es solo «escribir `# ` y que se vuelva título»: las estructuras de bloque se manejan directamente y la sintaxis Markdown y el WYSIWYG son bidireccionales y coherentes. Las marcas solo tienen que estar al **principio de la línea**, no hace falta escribirlas al final: escribe primero el texto y añade después un `## ` al principio de la línea, y se convierte en título igualmente, conservando tal cual el texto que va tras la marca (negritas y enlaces incluidos):

| Capacidad | Cómo se usa |
|---|---|
| **Título / Cuerpo** | Escribe al principio de la línea `# ` hasta `###### ` (también delante de un texto ya escrito); `Ctrl+Alt+1~3` cambia de nivel, y al pulsar de nuevo se vuelve al cuerpo |
| **Lista sin orden / con orden / de tareas** | Escribe al principio `- ` / `1. ` / `- [ ] `; `Tab` indenta como subelemento y `Shift+Tab` sube un nivel |
| **Listas anidadas** | Hasta 6 niveles; al alternar entre ordenada y sin orden no se pierde el nivel y la numeración se reordena sola |
| **Cita** | Escribe al principio `> `; `Tab` aumenta el nivel de la cita, y con Enter en una línea vacía se sale |
| **Bloque de código / Línea divisoria** | Escribe al principio ` ``` ` / `---`; dentro del bloque de código, Enter inserta un salto de línea con sangría de dos espacios |
| **Tabla** | `Ctrl+Shift+T` inserta una de 3×3, o bien «Formato → Insertar tabla (tamaño personalizado)» |
| **Edición de tablas** | `Tab` / `Shift+Tab` mueve entre celdas (al llegar al final añade una fila automáticamente), `Enter` pasa a la misma columna en la fila siguiente, y con clic derecho se añaden o eliminan filas y columnas y se ajusta la alineación de las columnas |
| **Estilos en línea** | Escribe `**粗**`, `*斜*`, `~~删~~`, `` `码` ``, `[文字](链接)` y se formatea al instante mientras escribes |
| **Fórmulas matemáticas** | En línea `$a^2+b^2=c^2$`, en bloque `$$ … $$` (pueden ocupar varias líneas); en la vista previa las compone KaTeX |
| **Índice** | «Insertar → Índice…» recorre los títulos y genera una lista clicable; `Ctrl+clic` en una entrada salta a la sección correspondiente |
| **Insertar imágenes** | Pega directamente con `Ctrl+V` después de una captura, arrastra el archivo de imagen a la ventana o usa «Insertar → Imagen…»: en todos los casos se copia a `assets/` junto al documento y se referencia con ruta relativa; también puedes escribir directamente una dirección web |
| **Tamaño de las imágenes** | En WYSIWYG arrastra la esquina inferior derecha de la imagen para cambiar el ancho (al soltar se escribe automáticamente como sufijo del alt); también puedes escribir a mano `![说明\|300](a.png)` para limitar el ancho o `![说明\|300x200](a.png)` para ancho y alto; si no se especifica, se muestra a la proporción original (máximo 320px) |
| **Semántica de retroceso** | Al pulsar Backspace al inicio de un título, primero se muestra `###` y después se borra nivel a nivel; al inicio de un elemento de lista, primero baja de nivel y luego pasa a párrafo; al inicio de un párrafo, se une a la línea anterior; con `Delete` es lo mismo al revés |
| **Pegar** | El texto multilínea se interpreta como Markdown y se convierte en bloques reales de título/lista/tabla, sin quedar todo apelmazado |

**Manipuladores de bloque al inicio de la línea**: a la izquierda de la línea donde están el cursor o el ratón flotan dos botones pequeños, `+` y `⋮⋮` (no tapan el texto y no se pueden seleccionar).
`⋮⋮` cambia este bloque a otro tipo (cuerpo / título 1~3 / lista / cita / bloque de código) y `+` inserta un bloque nuevo debajo.
Ejecutan los mismos comandos que el menú «Formato» de la barra superior, solo que con la entrada al alcance de la mano.

El `###` de los títulos solo aparece cuando quieres cambiar el nivel: pulsa Backspace una vez al inicio de la línea y la marca se ilumina (sin tocar ni un carácter del texto), púlsalo otra vez y se borra un `#`, y solo cuando se han borrado todos vuelve a ser cuerpo; así, un Backspace accidental no te hace perder el nivel y el texto a la vez. Al sacar el cursor de la línea o pulsar Enter, la marca se recoge sola.

La marca reconoce «el pequeño trozo justo delante del cursor», no todo el final de la línea, así que las tres formas son equivalentes: escribir `## ` antes del título, escribir el título y añadir después `## ` al inicio de la línea, o convertir un texto normal en título. Solo se reconoce si queda la marca por sí sola (`## ` seguido inmediatamente de un espacio), así que un `#tema` en el cuerpo no se convierte por error en título; y si el cursor no está al inicio de la línea, escribir `- ` tampoco parte la frase en una lista.

Todas las operaciones de bloque están también en el **menú «Formato»** y en el **menú contextual (clic derecho)**, y las opciones que no aplican se ponen en gris automáticamente (por ejemplo, todos los comandos de tabla salen en gris si el cursor no está dentro de una tabla).

### Fórmulas matemáticas

- En línea `$a^2 + b^2 = c^2$`, en bloque `$$ … $$` (se permiten varias líneas, así las matrices y las deducciones largas no tienen que apretujarse en una sola)
- El renderizado ocurre solo **en la vista previa**: KaTeX se carga «solo cuando de verdad hay una fórmula» (unos 546 KB); los documentos sin fórmulas no pagan ni un céntimo
- En WYSIWYG las fórmulas no se renderizan y solo llevan un fondo suave: meter el DOM de KaTeX dentro de un contenteditable hace que el retroceso no funcione y el cursor se atasque, un coste mayor que el beneficio. Para verlas pulsa `Ctrl+3`, o abre dos columnas y ten la vista previa al lado
- Los bloques de fórmula se protegen **antes** de interpretar la sintaxis de énfasis, así que en `$x_1 * y$` el `_` y el `*` son subíndice y signo de multiplicación, y no se toman como cursiva

### Modo enfoque (`F9`, salir con `Esc`)

La fila de pestañas, la barra lateral, la barra de estado y el menú se recogen y queda solo el texto. La barra de título se desvanece hasta casi desaparecer y se recupera al pasar el ratón: la ventana no tiene bordes, y si desapareciera también la barra de título no se podría arrastrar, minimizar ni cerrar; sería encerrarte en tu propio documento.

### Doble clic para abrir / una sola ventana

Cuando el instalador termina, `.md` `.markdown` `.txt` `.log` `.json` `.csv` quedan registrados como asociaciones de archivos,
y en el Explorador, con clic derecho → «Abrir con», aparece «EZNotepad».

De este programa solo hay una ventana: si haces doble clic en otro archivo, no se lanza un segundo proceso,
sino que la ruta se pasa a la ventana ya abierta para que la abra (y de paso se la devuelve desde minimizado).
Que dos ventanas editen el mismo archivo a la vez y se pisen mutuamente desapareció de raíz.

> Solo la **versión instalable** registra las asociaciones. La versión portable y el exe desnudo resultante de `cargo build` no escriben en el registro.

### Vigilancia de cambios de archivos

Los documentos ya abiertos se vigilan en tiempo real (el backend usa el `ReadDirectoryChangesW` / `inotify` del sistema, escucha solo el nivel del directorio donde está el archivo y solo deja pasar los nombres de una lista). Cuando otro programa modifica el archivo:

- Si está en la **pestaña actual**: si tú no lo has modificado, se recarga en silencio y se avisa; si hay cambios sin guardar, pregunta primero
- Si está en una **pestaña en segundo plano**: no molesta con ventanas; aparece un puntito ámbar en la pestaña y pregunta cuando cambies a ella

Guardar tú mismo no dispara el aviso (tras guardar, la fecha de modificación ya está sincronizada). Se puede desactivar por completo en los ajustes.

### Formateo con un clic (según el tipo de archivo)

| Tipo | Qué hace |
|---|---|
| **JSON** | Validación + reordenar la sangría; corrige automáticamente las comillas de ancho completo, las comas sobrantes y los comentarios; **si hay un error de sintaxis no toca el archivo y muestra un aviso «línea X, columna Y»** |
| **Markdown** | Añade líneas en blanco alrededor de los títulos, unifica las marcas de las listas, quita los espacios al final de línea y comprime las líneas en blanco |
| **TXT / registros / código** | Unifica los saltos de línea, quita los espacios al final de línea y comprime las líneas en blanco consecutivas |

Después de formatear, un clic en «Deshacer» lo devuelve todo a como estaba.

### Versiones históricas (Archivo → Versiones históricas…)

Con cada guardado se conserva una instantánea del contenido **anterior al guardado**, en el directorio de datos de la aplicación en tu equipo (no mete nada en tu carpeta de documentos).
Si después de un formateo, un ordenado/deduplicación o un reemplazo masivo te arrepientes y `Ctrl+Z` no alcanza para volver atrás, aquí está la última red de seguridad.

- Como máximo 60 instantáneas por archivo y 20 MB en total; al pasarse, se limpia desde la más antigua
- «Ver» abre esa versión como pestaña nueva de solo lectura y «Restaurar» la escribe en el editor: **en ambos casos solo tocan el disco si tú pulsas `Ctrl+S`**
- El mismo principio que la comparación de archivos y la fusión de tres vías: la reversión no sobrescribe directamente el archivo original

### Exportar página web (Archivo → Exportar página web…)

Guarda el documento actual como un **HTML de un solo archivo**: estilos incrustados e imágenes convertidas a data URI,
que se abre directamente al enviárselo a alguien o subirlo a un sitio estático, sin el clásico «todas las imágenes rotas».
Las imágenes de más de 4 MB no se incrustan (se conserva la dirección original), y el aviso de exportación indica cuántas se incrustaron.

### Paleta de comandos (`Ctrl+Shift+P`)

De los más de cien comandos que hay en el menú, bastan unas letras para localizarlos: `专注` (enfoque), `格式` (formato) o `替换` (reemplazar), por ejemplo;
con `↑` `↓` eliges, `Enter` ejecuta y `Esc` cierra. La lista se genera directamente del árbol de menús, así que si el menú añade un comando nuevo, aquí aparece solo.
Los comandos que no se pueden usar en el estado actual salen en gris, y al pulsarlos te dice por qué.

### Personaliza los atajos (Ajustes → Atajos de teclado)

El panel de ajustes lista todos los comandos con atajo; pulsa «Cambiar» y a continuación marca directamente la combinación nueva (debe llevar `Ctrl` / `Alt`,
o ser una tecla sola de `F1`–`F12`), con `Esc` se cancela. Las teclas personalizadas tienen prioridad sobre las predeterminadas; si algo sale mal, con «Restaurar» vuelve todo,
y «Restablecer los ajustes predeterminados» lo borra todo junto.

### Comparación de textos (`Ctrl+D`)

- Lado a lado, doble resaltado a **nivel de línea + de carácter** (solo se marcan los pocos caracteres realmente cambiados)
- Ignorar espacios / ignorar mayúsculas y minúsculas
- `F7` / `F8` saltan entre las diferencias
- Cada bloque de diferencia lleva un botón **→** que sincroniza ese bloque de la izquierda a la derecha con un clic
- Exporta con un clic un informe HTML de la comparación

### Comparación de carpetas

Compara recursivamente dos directorios y lista **solo a la izquierda / solo a la derecha / modificado / idéntico**; un clic en una fila abre directamente la comparación de texto de ese archivo.

### Fusión de tres vías (Herramientas → Fusión de tres vías)

Elige «versión base + lado A + lado B», fusiona automáticamente los cambios de ambos lados y lista los conflictos.
**El resultado se abre solo en una pestaña nueva; jamás sobrescribe ningún archivo original.**

### Codificación y saltos de línea

En la esquina inferior derecha de la barra de estado, pulsa `UTF-8` para guardar con otra codificación (UTF-8 / GBK / UTF-16, con BOM opcional);
pulsa `LF` para cambiar a CRLF. Un txt antiguo en GBK se abre sin que aparezcan caracteres extraños.

---

## Rendimiento medido

Medido en una máquina real (Windows 11, x64, compilación release):

| Escenario | Métrica |
|---|---|
| Escritura cotidiana (documento de 600 bloques, WYSIWYG) | Media por carácter: **9.1 ms** |
| Apertura de documento enorme (10,8 MB / 77 866 bloques) | **1,14 s**, sin congelar la interfaz (renderizado por viewport, unos 48 bloques permanentes en el DOM) |
| Escritura en documento enorme | Latencia p50: **0,3 ms** |
| Desplazamiento en documento enorme | Unos **17 ms** por fotograma, a fotogramas completos |
| Deshacer en documento enorme | **37 ms** por paso, idéntico byte a byte en el recorrido de ida y vuelta |
| Archivos de texto grandes (CodeMirror 6) | 50 000 líneas se abren en **49 ms** y 100 000 en **20 ms**, renderizando solo las líneas visibles |
| Uso de memoria | Unos **170 MB** tras un arranque limpio (incluido el proceso GPU de WebView2) |
| Tamaño | Instalador de **2,63 MB** |

---

## Datos y privacidad

- Todos los archivos se leen y escriben solo en tu equipo: **sin conexión y sin subidas**
- Los borradores se guardan en el directorio de datos de la aplicación local y no se pierden al cerrar la ventana: se guardan **todas** las pestañas sin guardar,
  y al arrancar de nuevo se te pregunta si quieres recuperarlas (no solo la última)
- Las instantáneas del historial están en `history/` dentro de ese mismo directorio, completamente separadas de tu carpeta de documentos
- Si al abrir por primera vez se detectan borradores sin guardar, se pregunta si quieres recuperarlos

---

## Limitaciones conocidas

- La exportación a PDF pasa por el diálogo de impresión del sistema («Guardar como PDF»); el diseño es el del resultado impreso
- La fusión de tres vías es semiautomática: fusión automática + lista de conflictos, sin fusor visual de cuatro columnas (para conflictos complejos se recomienda tratarlos bloque a bloque con la comparación de textos)
- Los paquetes de cada plataforma deben compilarse en el sistema correspondiente (ver `构建说明.md`)
- La búsqueda entre archivos es por defecto literal e insensible a mayúsculas y minúsculas, y se puede cambiar a expresiones regulares; máximo 200 resultados
- El reemplazo entre archivos solo procesa archivos **UTF-8**: los GBK y similares se saltan tal cual, sin cambiarles la codificación en silencio
- Las eliminaciones del árbol de archivos van a la papelera de reciclaje del sistema; **las carpetas solo se pueden eliminar si están vacías**, no se borran en cascada
- El propio árbol de archivos **no** se vigila: los archivos creados o eliminados desde fuera hay que refrescarlos con clic derecho → «Actualizar» sobre una zona vacía o reexpandiendo el directorio (los documentos ya abiertos sí se vigilan en tiempo real, ver arriba)
- Las fórmulas matemáticas solo se renderizan en la vista previa; en WYSIWYG se muestra el código fuente; los diagramas Mermaid aún no están soportados

---

## Licencia

Este proyecto se distribuye bajo la [GNU Affero General Public License v3.0 (AGPL-3.0)](./LICENSE): libre para usar, estudiar, modificar y redistribuir. Las obras derivadas —incluido un servicio alojado basado en él— también deben publicarse bajo AGPL-3.0.
