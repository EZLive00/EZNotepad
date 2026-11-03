<div align="center">

# EZNotepad

> Una utilidad de escritorio de **5 MB**: escritura Markdown, edición de texto y comparación de archivos.
> Portable, sin conexión, lista al doble clic.
> La interfaz habla 9 idiomas y sigue el del sistema; cámbialo en **Ajustes → Idioma**.

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | **Español** | [Português](README.pt.md)

[![Release](https://img.shields.io/github/v/release/EZLive00/EZNotepad)](https://github.com/EZLive00/EZNotepad/releases)
[![License](https://img.shields.io/badge/license-AGPL--v3-blue)](./LICENSE)

</div>

---

## Descarga

| Archivo | Para quién |
|---|---|
| `EZNotepad_<versión>_x64-setup.exe` | **Instalador** — asistente de instalación y asociaciones: un doble clic en `.md` / `.txt` se abre aquí |
| `EZNotepad_<versión>_x64-portable.zip` | **Portable** — descomprime donde quieras y ejecuta `EZNotepad.exe` (sin registro, sin asociaciones) |

Las compilaciones no están firmadas: SmartScreen bloquea el primer arranque, pulsa **Más información → Ejecutar de todos modos**.
Por ahora solo Windows x64; la versión portable usa el WebView2 del sistema (incluido en Windows 10 / 11).

## Capturas

| Tema claro | Tema oscuro |
|---|---|
| ![Ventana principal, tema claro](docs/screenshots/light.png) | ![Ventana principal, tema oscuro](docs/screenshots/dark.png) |

| Escribe a la izquierda, previsualiza a la derecha | Comparación: marcas por línea y por carácter |
|---|---|
| ![Dos paneles](docs/screenshots/split.png) | ![Ventana de comparación](docs/screenshots/compare.png) |

## Qué sustituye

| Antes | Por qué | Aquí |
|---|---|---|
| Notepad | Abrir cualquier texto, cambiar codificación, leer logs | Lo mismo, más números de línea, resaltado y esquema |
| Typora | Markdown con vista previa al escribir | Tres modos, 20× más ligero |
| BeyondCompare | Comparar dos archivos | En paralelo, marcas al carácter, `F7` / `F8` para recorrer diferencias |

## Tres modos

| Modo | Qué hace | Atajo |
|---|---|---|
| **WYSIWYG** | `# ` al inicio de línea crea un título, `**negrita**` se aplica mientras escribes | `Ctrl+1` |
| **Edición** | Markdown / código fuente, CodeMirror 6 con números de línea y plegado | `Ctrl+2` |
| **Vista previa** | Representación de solo lectura, pensada para leer | `Ctrl+3` |

`.md` admite los tres. `.json` añade validación y localización de errores; `.txt` `.log` `.csv` y archivos de código
(`.js .ts .py .rs .go .html .css .sql .yml` …) solo tienen Edición / Vista previa, como un editor de texto normal.
Los archivos nuevos piden primero el tipo (Markdown / Texto plano / JSON / CSV / Código).

## Edición

| | |
|---|---|
| **Bloques** | Título `# `, listas `- ` / `1. ` / `- [ ] ` (6 niveles), cita `> `, código ` ``` `, separador `---` — la marca solo debe estar al inicio de la línea |
| **En línea** | `**negrita**`, `*cursiva*`, `~~tachado~~`, `` `código` ``, `[texto](enlace)` se dibujan al escribir |
| **Deshacer / rehacer** | Las dos flechas a la izquierda de la barra de herramientas (en gris en los extremos), `Ctrl+Z` / `Ctrl+Y`; `Ctrl+Shift+Z` también rehace — WYSIWYG y texto plano guardan cada uno su propio historial |
| **Tablas** | `Ctrl+Shift+T` inserta una; `Tab` recorre celdas, `Enter` baja a la misma columna, el clic derecho añade o quita filas y columnas |
| **Imágenes** | Pega una captura, arrastra un archivo o usa **Insertar → Imagen**: se copia a `assets/`, junto al documento. Arrastra la esquina inferior derecha para el ancho, o escribe `![texto\|300](a.png)` |
| **Matemáticas** | `$a^2+b^2=c^2$` en línea, `$$ … $$` en bloque, compuesto por KaTeX en la vista previa (solo se carga si hay fórmulas) |
| **Avisos** | `> [!info]` / `warning` / `danger` / `success`, también con los alias de GitHub |
| **Asas de bloque** | `+` y `⋮⋮` aparecen al inicio de la línea: insertar un bloque o convertir este en otro tipo |
| **Pegar** | El texto de varias líneas se analiza como Markdown y se convierte en títulos, listas y tablas reales |

Cambiar el tipo de bloque (`Ctrl+Shift+Q` cita, `Ctrl+Shift+K` código…), el menú **Formato**, el menú contextual y
`Ctrl+Shift+P` (paleta de comandos) usan el mismo conjunto de comandos; lo que no aplica se atenúa solo.

### Buscar y reemplazar

Una sola capa, dos estados: `Ctrl+F` la enfoca, `Ctrl+H` despliega el reemplazo.
La búsqueda funciona **dentro de WYSIWYG** sin cambiar de modo: los resaltados se pintan, nunca se inyectan en el texto.

`Aa` distinguir mayúsculas · `.*` regex · palabra completa (los límites solo se añaden si ambos extremos son letras latinas;
el chino no tiene límites de palabra) · solo en la selección · `↵` inserta un salto de línea en la consulta. Un resultado dentro
de un mismo tramo se reemplaza en el sitio; solo al cruzar negrita o un enlace se ofrece cambiar a Edición.

## Nota rápida

`Ctrl+Shift+M` (o **Nota rápida** en la barra de menús) abre una nota temporal en una ubicación fija:

- **Sin guardar** — los cambios llegan al disco unos 0,35 s después de dejar de escribir, y se escriben antes de cerrar una pestaña o la ventana; sin punto de «sin guardar» y sin preguntar «¿guardar?»
- **Ubicación fija** — `<carpeta de datos>/quicknote.md`; **Archivo → Nota rápida** muestra dónde está y permite abrirla en el explorador
- **Sigue donde lo dejaste** — el cursor queda al final; **Insertar la hora actual** añade `2026-11-03 09:20`
- **Vaciar es reversible** — **Vaciar la nota rápida** guarda antes una copia en el historial de versiones

Sigue siendo una pestaña Markdown normal (modos, exportar, buscar): solo que no aparece en recientes ni en la sesión restaurada.

## Comparación

`Ctrl+D` (o `Ctrl+Shift+N`) abre la ventana de comparación. Empieza vacía a propósito:

- **Dos archivos** — selecciónalos con `Ctrl` / `Shift` en la página «Archivos» de la barra lateral, luego clic derecho → **Comparar estos dos archivos** (el del clic derecho queda a la izquierda)
- **Dos textos** — pulsa **Pegar dos textos**, pega en ambos lados y listo (sin archivos)
- **Editar ambos lados** — **Edición** habilita los dos paneles; **Guardar** solo escribe donde hay un archivo real

Las marcas por línea señalan qué línea cambió y las de carácter qué caracteres. `F7` / `F8` recorren las diferencias
y **Exportar informe** genera un diff HTML independiente.
La regla de la derecha sitúa cada cambio en el archivo completo: pasa el cursor para ver el número de línea
y haz clic o arrastra para saltar. **Diferencias** lista cada cambio en una tabla ordenable y filtrable
(posición, tipo, líneas).
**Ordenar** reordena ambos lados alfabéticamente (las líneas vacías al final) para que el desorden no oculte las diferencias reales; `Ctrl+Z` lo deshace.
En modo edición, `Ctrl+Z` / `Ctrl+Y` deshacen y rehacen lo escrito, los saltos de línea, la sangría, el borrado de selecciones y la ordenación — incluso con el foco en la barra de herramientas.
La ventana de comparación tiene esos mismos dos botones en su barra (en gris al llegar a los extremos); si la ventana se estrecha, la fila se reduce a iconos en vez de recortar un botón.
**Solo diferencias** viene activado: las líneas iguales se pliegan y quedan tres de contexto alrededor de cada cambio — 2000 líneas con 20 cambios se reducen a unas decenas. Para editar una línea igual que esté lejos, desmarca la casilla de la barra.
`Ctrl+F` busca en ambos paneles a la vez; las líneas coincidentes se tiñen y `Enter` / `Mayús+Intro` avanzan.

Cada lado tiene un límite de 8 MB / 50 000 líneas; al superarlo, la ventana explica el motivo.

**Comparar carpetas** lista de forma recursiva *solo izquierda / solo derecha / modificado / idéntico*; al pulsar una fila
se abre esa comparación. **Fusión de tres vías** toma base + A + B, fusiona y lista los conflictos: el resultado se abre en una
pestaña nueva y nunca sobrescribe el original.

## Archivos y búsqueda

La barra lateral tiene dos páginas: **Esquema** (resalta la sección que estás leyendo) y **Archivos**.

- Árbol cargado bajo demanda; clic derecho para crear, renombrar o borrar — el borrado va a la **Papelera**, y las carpetas solo se borran si están vacías
- La búsqueda corre en Rust, omite binarios y archivos de más de 4 MB, y devuelve como máximo 200 resultados agrupados por archivo con número de línea
- `.*` activa regex, `Aa` la distinción de mayúsculas
- **Reemplazar todo** entre archivos: pregunta una vez y guarda una instantánea de cada archivo antes de tocarlo
- Los documentos abiertos se vigilan en tiempo real (`ReadDirectoryChangesW`): la pestaña actual se recarga en silencio, una de fondo recibe un punto ámbar y pregunta al entrar

## Todo lo demás

| | |
|---|---|
| **Formatear** | `Ctrl+Shift+F` — JSON validado y reindentado (si hay error no toca el archivo e indica línea / columna), Markdown: líneas en blanco y viñetas unificadas, el resto: espacios finales fuera. Un `Ctrl+Z` lo deshace todo |
| **Historial** | Cada guardado conserva el contenido anterior (60 por archivo, 20 MB en total). **Ver** lo abre en solo lectura, **Restaurar** lo devuelve al editor — el disco solo cambia al pulsar `Ctrl+S` |
| **Exportar** | HTML de un solo archivo, estilos incrustados e imágenes en data URI; PDF mediante el diálogo de impresión del sistema |
| **Atajos** | Ajustes → Atajos permite cambiar cualquiera; lo personalizado gana, **Restablecer** recupera uno, **Valores por defecto** borra todos |
| **Modo concentración** | `F9` pliega pestañas, barra lateral, barra de estado y menús; la barra de título se atenúa al 28 % en vez de desaparecer, si no la ventana no se puede arrastrar ni cerrar |
| **Instancia única** | Abrir otro archivo no lanza un segundo proceso: la ruta pasa a la ventana que ya corre |
| **Codificación** | Pulsa `UTF-8` o `LF` en la barra de estado para cambiar codificación (GBK / UTF-16 / BOM) o fin de línea |

## Atajos

| Acción | Teclas |
|---|---|
| Nuevo / Abrir / Guardar / Guardar como | `Ctrl+N` / `Ctrl+O` / `Ctrl+S` / `Ctrl+Shift+S` |
| Cerrar pestaña / Siguiente pestaña | `Ctrl+W` / `Ctrl+Tab` |
| Abrir la nota rápida | `Ctrl+Shift+M` |
| Buscar / Reemplazar / Ir a línea | `Ctrl+F` / `Ctrl+H` / `Ctrl+G` |
| Paleta de comandos / Ajustes | `Ctrl+Shift+P` / `Ctrl+,` |
| Formatear / Comparar | `Ctrl+Shift+F` / `Ctrl+D` |
| Siguiente / anterior diferencia | `F8` / `F7` |
| Copiar esta diferencia al otro lado (con `Ctrl` para seguir) | `Alt+←` / `Alt+→` |
| Buscar en ambos paneles (ventana de comparación) | `Ctrl+F` |
| Un panel ⇄ dos paneles / Esquema | `Ctrl+Shift+L` / `Ctrl+Shift+O` |
| Modo concentración / Pantalla completa | `F9` / `F11` |
| Negrita / Cursiva / Tachado / Código | `Ctrl+B` / `Ctrl+I` / `Ctrl+Shift+X` / `Ctrl+Shift+K` |
| Enlace / Tabla / Cita | `Ctrl+K` / `Ctrl+Shift+T` / `Ctrl+Shift+Q` |
| Cuerpo / Títulos 1–3 | `Ctrl+Alt+0` / `Ctrl+Alt+1~3` |
| Viñetas / Numerada / Tareas | `Ctrl+Shift+8` / `Ctrl+Shift+7` / `Ctrl+Shift+9` |
| Indentar / desindentar lista | `Tab` / `Shift+Tab` |
| Zoom + / − / restablecer | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` |
| Exportar PDF | `Ctrl+P` |

## Rendimiento

Medido en local (Windows 11, x64, compilación release):

| Escenario | Métrica |
|---|---|
| Escribir en un documento de 600 párrafos | **9,1 ms** por pulsación |
| Abrir 10,8 MB / 77.866 bloques | **1,14 s**, ~48 bloques en el DOM, sin congelarse |
| Escribir / desplazar / deshacer en ese documento | p50 **0,3 ms** / ~**17 ms** por fotograma / **37 ms** por paso |
| CodeMirror 6, texto plano | 50 k líneas en **49 ms**, 100 k en **20 ms** |
| Memoria / instalador | ~**170 MB** en arranque limpio / **2,63 MB** |

Los Markdown enormes usan renderizado por ventana: solo los bloques visibles están en el DOM, el resto son registros.
Las instantáneas de deshacer son esas matrices de registros, así que una tecla nunca copia el documento entero.

## Datos

Todo se queda en este equipo — **sin red, sin subidas, sin telemetría**. Los borradores de todas las pestañas sin guardar
viven en la carpeta de datos local y se ofrecen al siguiente arranque; las instantáneas de historial están en `history/`,
en esa misma carpeta, separadas de tus documentos.

## Limitaciones conocidas

- El PDF pasa por el diálogo de impresión del sistema, así que el diseño sigue la salida impresa
- La fusión de tres vías fusiona y lista conflictos; no hay fusionador visual de cuatro paneles (usa la comparación bloque a bloque)
- Las fórmulas solo se dibujan en la vista previa y se ven como fuente en WYSIWYG; Mermaid no está soportado
- El reemplazo entre archivos solo trata UTF-8: los archivos GBK se omiten en lugar de recodificarse en silencio
- El árbol de archivos no se vigila; pulsa **Actualizar** en el menú contextual tras cambios externos
- Cada instalador debe compilarse en su propio sistema (ver `docs/构建说明.md`); las notas de arquitectura y portabilidad están en `docs/`

## Licencia

[GNU Affero General Public License v3.0](LICENSE) — libre para usar, estudiar, modificar y redistribuir. Las obras derivadas,
incluido un servicio alojado construido sobre él, también deben publicarse bajo AGPL-3.0.
