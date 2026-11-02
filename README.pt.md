<div align="center">

# EZNotepad

> Um utilitário de desktop de **5 MB**: escrita Markdown, edição de texto e comparação de arquivos.
> Portátil, offline, pronto no duplo clique.
> A interface fala 9 idiomas e segue o do sistema; troque em **Configurações → Idioma**.

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Español](README.es.md) | **Português**

[![Release](https://img.shields.io/github/v/release/EZLive00/EZNotepad)](https://github.com/EZLive00/EZNotepad/releases)
[![License](https://img.shields.io/badge/license-AGPL--v3-blue)](./LICENSE)

</div>

---

## Download

| Arquivo | Para quem |
|---|---|
| `EZNotepad_<versão>_x64-setup.exe` | **Instalador** — assistente de instalação e associações: um duplo clique em `.md` / `.txt` abre aqui |
| `EZNotepad_<versão>_x64-portable.zip` | **Portátil** — extraia em qualquer pasta e rode `EZNotepad.exe` (sem registro, sem associações) |

As compilações não são assinadas: o SmartScreen bloqueia o primeiro início, clique em **Mais informações → Executar assim mesmo**.
Por enquanto só Windows x64; a versão portátil usa o WebView2 do sistema (já vem no Windows 10 / 11).

## Capturas

| Tema claro | Tema escuro |
|---|---|
| ![Janela principal, tema claro](docs/screenshots/light.png) | ![Janela principal, tema escuro](docs/screenshots/dark.png) |

| Escreva à esquerda, visualize à direita | Comparação: marcas por linha e por caractere |
|---|---|
| ![Dois painéis](docs/screenshots/split.png) | ![Janela de comparação](docs/screenshots/compare.png) |

## O que ele substitui

| Antes | Por quê | Aqui |
|---|---|---|
| Notepad | Abrir qualquer texto, trocar codificação, ler logs | O mesmo, com números de linha, realce e estrutura |
| Typora | Markdown com visualização ao digitar | Três modos, 20× mais leve |
| BeyondCompare | Comparar dois arquivos | Lado a lado, marcas por caractere, `F7` / `F8` pelas diferenças |

## Três modos

| Modo | O que faz | Atalho |
|---|---|---|
| **WYSIWYG** | `# ` no início da linha vira título, `**negrito**` aplica enquanto você digita | `Ctrl+1` |
| **Edição** | Markdown / código-fonte, CodeMirror 6 com números de linha e dobramento | `Ctrl+2` |
| **Visualização** | Renderização somente leitura, feita para ler | `Ctrl+3` |

`.md` aceita os três. `.json` ganha validação e localização de erro; `.txt` `.log` `.csv` e arquivos de código
(`.js .ts .py .rs .go .html .css .sql .yml` …) têm só Edição / Visualização, como um editor de texto comum.
Arquivos novos pedem o tipo primeiro (Markdown / Texto simples / JSON / CSV / Código).

## Edição

| | |
|---|---|
| **Blocos** | Título `# `, listas `- ` / `1. ` / `- [ ] ` (6 níveis), citação `> `, código ` ``` `, separador `---` — a marca só precisa estar no início da linha |
| **Em linha** | `**negrito**`, `*itálico*`, `~~riscado~~`, `` `código` ``, `[texto](link)` aparecem enquanto você digita |
| **Tabelas** | `Ctrl+Shift+T` insere uma; `Tab` percorre células, `Enter` desce na mesma coluna, o botão direito adiciona ou remove linhas e colunas |
| **Imagens** | Cole uma captura, arraste um arquivo ou use **Inserir → Imagem**: ela é copiada para `assets/`, ao lado do documento. Arraste o canto inferior direito para a largura, ou escreva `![texto\|300](a.png)` |
| **Matemática** | `$a^2+b^2=c^2$` em linha, `$$ … $$` em bloco, composto pelo KaTeX na visualização (só carrega se houver fórmula) |
| **Avisos** | `> [!info]` / `warning` / `danger` / `success`, com os apelidos do GitHub também |
| **Alças de bloco** | `+` e `⋮⋮` surgem no início da linha: inserir um bloco ou converter este em outro tipo |
| **Colar** | Texto de várias linhas é lido como Markdown e vira títulos, listas e tabelas de verdade |

Trocar o tipo do bloco (`Ctrl+Shift+Q` citação, `Ctrl+Shift+K` código…), o menu **Formatar**, o menu de contexto e
`Ctrl+Shift+P` (paleta de comandos) usam o mesmo conjunto de comandos; o que não se aplica fica cinza sozinho.

### Localizar e substituir

Uma camada, dois estados: `Ctrl+F` só foca, `Ctrl+H` abre a linha de substituição.
A busca funciona **dentro do WYSIWYG** sem trocar de modo — os realces são pintados, nunca injetados no texto.

`Aa` diferenciar maiúsculas · `.*` regex · palavra inteira (os limites só entram quando as duas pontas são letras latinas;
o chinês não tem limites de palavra) · só na seleção · `↵` insere quebra de linha na busca. Um resultado dentro do mesmo
trecho é substituído no lugar; só ao cruzar negrito ou link o app oferece o modo Edição.

## Comparação

`Ctrl+D` (ou `Ctrl+Shift+N`) abre a janela de comparação. Ela começa vazia de propósito:

- **Dois arquivos** — selecione com `Ctrl` / `Shift` na página «Arquivos» da barra lateral, clique com o botão direito → **Comparar estes dois arquivos** (o clicado fica à esquerda)
- **Dois textos** — clique em **Colar dois textos**, cole nos dois lados e pronto (sem arquivo)
- **Editar os dois lados** — **Edição** libera os dois painéis; **Salvar** grava só onde existe um arquivo real

As marcas por linha mostram qual linha mudou e as por caractere, quais caracteres. `F7` / `F8` percorrem as diferenças
e **Exportar relatório** gera um diff HTML independente.
A régua da direita situa cada mudança no arquivo inteiro.

**Comparar pastas** lista recursivamente *só à esquerda / só à direita / modificado / idêntico*; clique numa linha para abrir
a comparação daquele arquivo. **Mesclagem de três vias** pega base + A + B, mescla e lista os conflitos — o resultado abre em
outra aba e nunca sobrescreve o original.

## Arquivos e busca

A barra lateral tem duas páginas: **Estrutura** (realça a seção que você está lendo) e **Arquivos**.

- Árvore carregada sob demanda; clique direito para criar, renomear ou excluir — a exclusão vai para a **Lixeira**, e pastas só podem ser excluídas vazias
- A busca roda em Rust, ignora binários e arquivos acima de 4 MB, e devolve no máximo 200 resultados agrupados por arquivo com número de linha
- `.*` ativa regex, `Aa` a diferenciação de maiúsculas
- **Substituir tudo** entre arquivos: pergunta uma vez e tira um instantâneo de cada arquivo antes de alterar
- Documentos abertos são monitorados em tempo real (`ReadDirectoryChangesW`): a aba atual recarrega em silêncio, uma aba de fundo ganha um ponto âmbar e pergunta ao entrar

## Todo o resto

| | |
|---|---|
| **Formatar** | `Ctrl+Shift+F` — JSON validado e reindentado (em caso de erro o arquivo não é tocado e a linha / coluna é informada), Markdown: linhas em branco e marcadores unificados, o resto: espaços finais removidos. Um `Ctrl+Z` desfaz tudo |
| **Histórico** | Cada salvamento guarda o conteúdo anterior (60 por arquivo, 20 MB no total). **Ver** abre em somente leitura, **Restaurar** devolve ao editor — o disco só muda com `Ctrl+S` |
| **Exportar** | HTML de arquivo único, estilos embutidos e imagens em data URI; PDF pelo diálogo de impressão do sistema |
| **Atalhos** | Configurações → Atalhos muda qualquer um; o personalizado vence, **Redefinir** recupera um, **Restaurar padrões** limpa todos |
| **Modo concentração** | `F9` recolhe abas, barra lateral, barra de status e menus; a barra de título esmaece para 28% em vez de sumir, senão não dá para arrastar nem fechar a janela |
| **Instância única** | Abrir outro arquivo não inicia um segundo processo: o caminho vai para a janela já aberta |
| **Codificação** | Clique em `UTF-8` ou `LF` na barra de status para trocar codificação (GBK / UTF-16 / BOM) ou fim de linha |

## Atalhos

| Ação | Teclas |
|---|---|
| Novo / Abrir / Salvar / Salvar como | `Ctrl+N` / `Ctrl+O` / `Ctrl+S` / `Ctrl+Shift+S` |
| Fechar aba / Próxima aba | `Ctrl+W` / `Ctrl+Tab` |
| Localizar / Substituir / Ir para linha | `Ctrl+F` / `Ctrl+H` / `Ctrl+G` |
| Paleta de comandos / Configurações | `Ctrl+Shift+P` / `Ctrl+,` |
| Formatar / Comparar | `Ctrl+Shift+F` / `Ctrl+D` |
| Próxima / anterior diferença | `F8` / `F7` |
| Um painel ⇄ dois painéis / Estrutura | `Ctrl+Shift+L` / `Ctrl+Shift+O` |
| Modo concentração / Tela cheia | `F9` / `F11` |
| Negrito / Itálico / Riscado / Código | `Ctrl+B` / `Ctrl+I` / `Ctrl+Shift+X` / `Ctrl+Shift+K` |
| Link / Tabela / Citação | `Ctrl+K` / `Ctrl+Shift+T` / `Ctrl+Shift+Q` |
| Corpo / Títulos 1–3 | `Ctrl+Alt+0` / `Ctrl+Alt+1~3` |
| Marcadores / Numerada / Tarefas | `Ctrl+Shift+8` / `Ctrl+Shift+7` / `Ctrl+Shift+9` |
| Indentar / desindentar lista | `Tab` / `Shift+Tab` |
| Zoom + / − / redefinir | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` |
| Exportar PDF | `Ctrl+P` |

## Desempenho

Medido localmente (Windows 11, x64, build release):

| Cenário | Métrica |
|---|---|
| Digitar em um documento de 600 parágrafos | **9,1 ms** por tecla |
| Abrir 10,8 MB / 77.866 blocos | **1,14 s**, ~48 blocos no DOM, sem travar |
| Digitar / rolar / desfazer nesse documento | p50 **0,3 ms** / ~**17 ms** por quadro / **37 ms** por passo |
| CodeMirror 6, texto simples | 50 mil linhas em **49 ms**, 100 mil em **20 ms** |
| Memória / instalador | ~**170 MB** na partida limpa / **2,63 MB** |

Markdown gigantes usam renderização por janela: só os blocos visíveis existem no DOM, o resto são registros.
Os instantâneos de desfazer são essas matrizes de registros, então uma tecla nunca copia o documento inteiro.

## Dados

Tudo fica nesta máquina — **sem rede, sem upload, sem telemetria**. Rascunhos de todas as abas não salvas ficam na pasta de
dados local e são oferecidos na próxima abertura; os instantâneos de histórico ficam em `history/`, na mesma pasta, separados
dos seus documentos.

## Limitações conhecidas

- O PDF passa pelo diálogo de impressão do sistema, então o layout segue a saída impressa
- A mesclagem de três vias mescla e lista conflitos; não há mesclador visual de quatro painéis (use a comparação bloco a bloco)
- Fórmulas são renderizadas só na visualização e aparecem como código no WYSIWYG; Mermaid não é suportado
- A substituição entre arquivos trata só UTF-8: arquivos GBK são ignorados em vez de recodificados em silêncio
- A árvore de arquivos não é monitorada; use **Atualizar** no menu de contexto após mudanças externas
- Cada instalador precisa ser compilado no próprio sistema (veja `构建说明.md`)

## Licença

[GNU Affero General Public License v3.0](LICENSE) — livre para usar, estudar, modificar e redistribuir. Obras derivadas,
incluindo um serviço hospedado construído sobre ele, também precisam ser publicadas sob AGPL-3.0.
