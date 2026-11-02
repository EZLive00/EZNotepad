<div align="center">

# EZNotepad

> Um pequeno utilitário de desktop de **5 MB**: escrita em Markdown + leitura e escrita de texto + comparação de arquivos.
> Sem instalação, sem internet, basta dar dois cliques para usar.
> A interface suporta 9 idiomas, por padrão segue o idioma do sistema, e também pode ser trocado manualmente em "Configurações → Idioma".

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Español](README.es.md) | **Português**

[![Release](https://img.shields.io/github/v/release/EZLive00/EZNotepad)](https://github.com/EZLive00/EZNotepad/releases)
[![License](https://img.shields.io/badge/license-PolyForm--NC--1.0.0-orange)](./LICENSE)

</div>

---

## Download e instalação

Baixe em [Releases](https://github.com/EZLive00/EZNotepad/releases):

| Artefato | Para quem é |
|---|---|
| `EZNotepad_<版本>_x64-setup.exe` | **Versão instalável**: assistente de instalação + associação de arquivos; dê dois cliques em `.md` / `.txt` para abrir diretamente |
| `EZNotepad_<版本>_x64-portable.zip` | **Versão portátil**: extraia em qualquer diretório, dê dois cliques em `EZNotepad.exe` e pronto |

- Nenhuma das duas possui assinatura de código; na primeira execução o SmartScreen vai bloquear uma vez: clique em "Mais informações" → "Executar mesmo assim"
- A versão portátil depende do runtime WebView2 do sistema (já embutido no Win10 / Win11), não escreve no registro e não registra associações de arquivos
- Por enquanto, apenas pacotes para Windows x64 estão disponíveis

---

## Capturas de tela

**Tema claro**

![Interface principal do EZNotepad no tema claro](docs/screenshots/light.png)

**Tema escuro**

![Interface principal do EZNotepad no tema escuro](docs/screenshots/dark.png)

---

## O que ele substitui

| O que você usava antes | Por que usava | Com ele, depois |
|---|---|---|
| Bloco de notas | Abrir qualquer texto, mudar codificação, ver logs | Abre igual, e ainda ganha números de linha, realce e estrutura do documento |
| Typora | Escrever e ver o Markdown ao mesmo tempo | Três modos à sua escolha, 20 vezes mais leve |
| BeyondCompare | Comparar onde dois arquivos diferem | Lado a lado com realce, diferenças marcadas caractere a caractere, salto entre diferenças com F7/F8 |

---

## Três modos (um menu suspenso, adaptação automática por tipo de arquivo)

| Modo | O que faz | Atalho |
|---|---|---|
| **WYSIWYG** | Digite `# ` vira título, `**粗**` fica em negrito na hora | `Ctrl+1` |
| **Modo de edição** | Vê o Markdown original / código-fonte, com números de linha, coloração de sintaxe e dobramento | `Ctrl+2` |
| **Modo de visualização** | Renderização somente leitura, focada na leitura | `Ctrl+3` |

**Tipos de arquivo suportados**: `.md` (os três modos habilitados), `.json` (validação + realce + localização de erros),
`.txt` `.log` `.csv`, arquivos de código comuns (`.js/.ts/.py/.rs/.go/.html/.css/.sql/.yml/...`).
**Ao criar um novo, você escolhe primeiro o tipo** (Markdown / texto simples / JSON / CSV / código); arquivos que não são Markdown
têm apenas "Editar / Visualizar" disponíveis, funcionando como um editor de texto comum.

## O modo de edição usa CodeMirror 6

Não é um `<textarea>` disfarçado. É o pacote completo de um verdadeiro editor de código:

| | Descrição |
|---|---|
| **Coloração de sintaxe** | JS/TS/JSX, Python, Rust, Go, Java, C/C++, JSON, CSS, HTML, SQL, YAML, Shell, INI, Markdown, com parsing incremental |
| **Números de linha / linha atual** | Calha de números de linha, fundo da linha atual, correspondência de parênteses, dobramento de código |
| **Desfazer** | Histórico transacional próprio do CM6, mais confiável que o contenteditable do navegador |
| **Arquivos grandes** | Renderiza apenas as linhas visíveis. Na prática, 50 mil linhas abrem em 49 ms, 100 mil em 20 ms, com pouco mais de cem linhas no DOM |
| **Indentação** | Tab indenta a seleção inteira se houver seleção, ou a linha atual se não houver; Shift+Tab remove indentação; Enter herda a indentação da linha anterior |
| **Pares de parênteses** | Digitar `(` insere `)` automaticamente, o mesmo vale para aspas; quando o cursor está entre um par, digitar o fechamento "pula por cima" em vez de inserir outro |
| **Temas** | Dois conjuntos, claro e escuro, que acompanham a troca do aplicativo; as cores de sintaxe compartilham as mesmas variáveis CSS da visualização |

As cores são definidas uma única vez em `body[data-theme]` no `styles.css`; o editor e o renderizador de visualização
usam-nas separadamente, sem o problema de dois conjuntos de valores que não batem.

As opções não suportadas ficam esmaecidas automaticamente — ao abrir um JSON, o modo "WYSIWYG" fica cinza, para você não clicar por engano.

---

## Layout da interface (cada função tem uma única entrada)

```
┌──────────────────────────────────────────────┐
│ ▣ Arquivo Editar Formatar Exibir Ferramentas Ajuda  Bem-vindo.md  － □ ✕│ ← Barra de título (40px)
├──────────────────────────────────────────────┤
│ Bem-vindo.md × │ test.json × │ +         Editar▾ ⌕ Salvar │ ← Abas e ferramentas na mesma linha
├────────┬──────────────────┬──────────────────┤
│        │                  │                  │
│ Estrutura │   Editar / WYSIWYG │      Visualizar        │
│        │                  │                  │
├────────┴──────────────────┴──────────────────┤
│ Linha 1, Coluna 1 │ 36 linhas │ 243 caracteres │ Markdown │ LF │ UTF-8 │ Salvo │
└──────────────────────────────────────────────┘
```

Acima da área de conteúdo há apenas duas linhas: a barra de título (menu + título do documento + botões da janela) e a linha
que combina abas e ferramentas (abas à esquerda; à direita ficam apenas as três ações de alta frequência — **troca de modo / localizar / salvar** —, todo o resto fica nos menus, sem duplicação).
Quando a janela fica estreita, as ferramentas reduzem-se a ícones puros.

A janela não tem barra de título do sistema (`decorations: false`): menu, título do documento e botões da janela ficam todos na linha do topo;
a área vazia no meio serve para arrastar a janela, e um duplo clique maximiza — igual a aplicativos como VS Code e WorkBuddy.
Os quatro cantos da janela usam os cantos arredondados nativos do DWM do Win11, e arrastar as bordas ainda redimensiona.
"Exibir → Mostrar nome do arquivo na barra de título" permite desligar o texto do título, deixando apenas o menu e os botões.

- **Estrutura** — serve apenas para navegação
- **Barra lateral** — duas páginas: Estrutura (acompanha a rolagem e realça a seção atual) / Arquivos (árvore de diretórios + busca de conteúdo em todo o diretório)
- **Barra de ferramentas** — apenas três ações de alta frequência: modo, localizar e salvar; todos os outros comandos vão pelo menu
- **Área de texto** — serve apenas para editar
- **Barra de status** — serve apenas para informações; codificação e quebra de linha são clicáveis e podem ser alteradas
- **Menu** — guarda a coleção completa de entradas
- **Configurações** — um painel só, via `Ctrl+,`: tema, tamanho da fonte, interface, salvamento automático, pasta de trabalho
- **Central de comparação** — painel independente em tela cheia, não misturado ao editor

---

### Página "Arquivos" da barra lateral: árvore de diretórios e busca entre arquivos

- Expande um nível e lê um nível (carregamento preguiçoso); abrir um repositório grande não lê dezenas de milhares de arquivos de uma vez
- **O clique direito já permite alterar**: criar arquivo / pasta em qualquer diretório, renomear arquivos ou excluí-los
  - A exclusão vai para a **lixeira do sistema**; se você errar o clique, ainda dá para recuperar; pastas só são excluídas se estiverem vazias, sem apagar tudo de uma vez
  - Ao renomear ou excluir, a aba que já está aberta acompanha a mudança (não fica apontando para o caminho antigo e gravando por cima)
- A busca é feita em Rust, pulando binários e arquivos acima de 4 MB, com no máximo 200 resultados
- O `.*` na caixa de busca ativa regex, o `Aa` diferencia maiúsculas de minúsculas
- Os resultados são agrupados por arquivo, com número de linha e trecho; um clique abre e pula para a linha
- **Substituição entre arquivos**: preencha "Substituir por" abaixo da caixa de busca e clique em "Substituir tudo". Pergunta uma vez antes, avisando que vai mexer no disco;
  antes de alterar cada arquivo, deixa um instantâneo do histórico, para recuperar caso algo dê errado
- Lembra da última pasta aberta; no painel de configurações dá para trocar ou limpar

---

### Localizar (`Ctrl+F` / `Ctrl+H`)

Um painel flutuante com dois estados: clicar na seta mais à esquerda expande para duas linhas "Localizar + Substituir"; recolher deixa apenas a localização.
`Ctrl+F` apenas foca (não recolhe a linha de substituição já aberta), e `Ctrl+H` abre direto expandido.

| Capacidade | Descrição |
|---|---|
| **Localização in-loco no WYSIWYG** | Não é mais preciso trocar para o modo de edição para localizar; o realce é desenhado na camada de renderização (CSS Highlight API), sem inserir marcações no texto |
| **Interruptores de modo** | Quatro quadradinhos à direita da caixa de entrada: `Aa` diferencia maiúsculas, `.*` regex, `palavra inteira`, `seleção`. Ativados, usam a cor de destaque |
| **Palavra inteira** | Adiciona limites apenas quando as pontas da consulta são caracteres de palavra em inglês — chinês não tem fronteira de palavra, e forçar `\b` nunca encontraria nada |
| **Dentro da seleção** | Localiza/substitui apenas no trecho selecionado; sem seleção, este item fica cinza |
| **Quebra de linha** | O `↵` na ponta direita da caixa de entrada (ou `Ctrl+Enter`) insere uma quebra de linha e a caixa cresce sozinha; consultas sem quebra de linha continuam sem dar falso positivo atravessando parágrafos |
| **Substituir** | Quando os acertos estão no mesmo trecho de texto, **altera direto**, sem janela popup; só pergunta "deseja trocar para o modo de edição" quando cruza fronteiras de formatação como negrito/links |
| **Entre arquivos** | A caixa de busca da página "Arquivos" da barra lateral, listando as linhas com acertos agrupadas por arquivo |

---

## Atalhos de teclado

| Ação | Atalho |
|---|---|
| Novo / Abrir / Salvar / Salvar como | `Ctrl+N` / `Ctrl+O` / `Ctrl+S` / `Ctrl+Shift+S` |
| Fechar aba / Alternar abas | `Ctrl+W` / `Ctrl+Tab` |
| Localizar / Substituir / Ir para linha | `Ctrl+F` / `Ctrl+H` / `Ctrl+G` |
| **Paleta de comandos** | `Ctrl+Shift+P` |
| Configurações | `Ctrl+,` |
| **Formatação com um clique** | `Ctrl+Shift+F` |
| **Comparação de texto** | `Ctrl+D` |
| Próxima diferença / Diferença anterior | `F8` / `F7` |
| Coluna única ⇄ coluna dupla | `Ctrl+Shift+L` |
| Mostrar / ocultar estrutura | `Ctrl+Shift+O` |
| Modo foco (`Esc` para sair) / Tela cheia | `F9` / `F11` |
| Negrito / Itálico | `Ctrl+B` / `Ctrl+I` |
| Riscado / Código inline | `Ctrl+Shift+X` / — |
| Inserir link / Inserir tabela | `Ctrl+K` / `Ctrl+Shift+T` |
| Corpo / Títulos de 1 a 3 níveis | `Ctrl+Alt+0` / `Ctrl+Alt+1~3` |
| Lista não ordenada / ordenada / de tarefas | `Ctrl+Shift+8` / `Ctrl+Shift+7` / `Ctrl+Shift+9` |
| Citação / Bloco de código | `Ctrl+Shift+Q` / `Ctrl+Shift+K` |
| Aumentar / diminuir indentação da lista | `Tab` / `Shift+Tab` |
| Aumentar / diminuir / redefinir tamanho da fonte | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` |
| Exportar PDF | `Ctrl+P` |

---

## Alguns recursos mais usados

### WYSIWYG: dá para usar de verdade como editor

Não é só "digitar `# ` e virar título": todas as estruturas de bloco podem ser manipuladas diretamente, e a sintaxe Markdown e o WYSIWYG são consistentes nos dois sentidos. Basta que a marcação esteja no **início da linha**, não precisa ficar no final — escreva o texto primeiro e, depois, adicione `## ` no começo da linha para transformá-lo em título; o texto depois da marcação (incluindo negrito e links) fica como está:

| Capacidade | Como usar |
|---|---|
| **Títulos / corpo** | Digite no início da linha `# ` até `###### ` (dá para adicionar antes de um texto existente); `Ctrl+Alt+1~3` troca o nível, e pressionar de novo volta ao corpo |
| **Lista não ordenada / ordenada / de tarefas** | Digite no início da linha `- ` / `1. ` / `- [ ] `; `Tab` indenta como subitem, `Shift+Tab` sobe um nível |
| **Listas aninhadas** | Até 6 níveis; alternar entre ordenada/não ordenada não perde a hierarquia, e os números se reorganizam sozinhos |
| **Citação** | Digite no início da linha `> `; `Tab` aumenta o nível da citação, e Enter em uma linha vazia encerra |
| **Bloco de código / linha divisória** | Digite no início da linha ` ``` ` / `---`; dentro do bloco de código, Enter quebra a linha automaticamente com indentação de dois espaços |
| **Tabela** | `Ctrl+Shift+T` insere uma 3×3, ou "Formatar → Inserir tabela (tamanho personalizado)" |
| **Edição de tabela** | `Tab` / `Shift+Tab` movem entre as células (chegando ao fim, adiciona uma linha automaticamente), `Enter` vai para a linha seguinte na mesma coluna, e o clique direito adiciona/remove linhas e colunas e define o alinhamento das colunas |
| **Estilos inline** | Digite `**粗**`, `*斜*`, `~~删~~`, `` `码` ``, `[文字](链接)` e a formatação aparece enquanto digita |
| **Fórmulas matemáticas** | Inline `$a^2+b^2=c^2$`, em bloco `$$ … $$` (pode atravessar linhas), renderizadas pela KaTeX na visualização |
| **Sumário** | "Inserir → Sumário…" varre os títulos e gera uma lista clicável; `Ctrl+点击` em um item pula para a seção correspondente |
| **Inserir imagem** | Cole com `Ctrl+V` direto após uma captura de tela, arraste um arquivo de imagem para a janela, ou "Inserir → Imagem…": em todos os casos, a imagem é copiada para `assets/` no mesmo diretório do documento e referenciada com caminho relativo; também dá para colar um endereço da web |
| **Tamanho da imagem** | No WYSIWYG, arraste o canto inferior direito da imagem para mudar a largura (ao soltar, o sufixo alt é atualizado automaticamente); também dá para escrever `![说明\|300](a.png)` para limitar a largura, `![说明\|300x200](a.png)` para largura e altura; sem definição, exibe na proporção original (máximo 320px) |
| **Semântica do backspace** | Dar backspace no início de um título primeiro revela `###`, depois apaga um nível por vez; no começo de um item de lista, primeiro desce o nível, depois vira parágrafo; no começo de um parágrafo, junta com a linha anterior; `Delete` faz o inverso |
| **Colar** | Texto de várias linhas é analisado como Markdown em blocos reais de título/lista/tabela, sem virar uma bagunça |

**Alças de bloco no início da linha**: à esquerda da linha onde está o cursor ou o mouse aparecem dois botõezinhos flutuantes, `+` e `⋮⋮` (não cobrem o texto e não podem ser selecionados).
`⋮⋮` troca este bloco por outro tipo (corpo / título 1~3 / lista / citação / bloco de código), e `+` insere um novo bloco abaixo.
Eles executam os mesmos comandos do menu "Formatar" no topo; apenas aproximaram a entrada da mão.

O `###` do título só aparece quando você quer mudar o nível: um backspace no início da linha revela a marcação (o texto do corpo não se move), e outro apaga um `#`; só quando apaga tudo volta ao corpo — um backspace por engano não faz você perder o nível e o texto juntos. Ao mover o cursor para fora da linha ou pressionar Enter, a marcação se recolhe sozinha.

A posição reconhecida pela marcação é "o pequeno trecho antes do cursor", não a linha inteira até o fim, então as três formas são equivalentes: digitar `## ` e depois escrever o título, escrever o título e voltar ao início da linha para adicionar `## `, ou transformar um trecho de texto comum em título. Só reconhece quando resta apenas a marcação (`## ` seguido imediatamente de espaço), então `#话题` no meio do texto não é convertido em título por engano; e digitar `- ` com o cursor fora do início da linha não parte a frase em uma lista.

Todas as operações de bloco também estão no **menu "Formatar"** e no **menu de contexto (clique direito)**, e os itens inaplicáveis ficam esmaecidos automaticamente (por exemplo, com o cursor fora de uma tabela, todos os comandos de tabela ficam cinza).

### Fórmulas matemáticas

- Inline `$a^2 + b^2 = c^2$`, em bloco `$$ … $$` (pode atravessar linhas; matrizes e derivações de várias linhas não precisam ser espremidas em uma linha)
- A renderização acontece apenas **no lado da visualização**: a KaTeX "só é carregada quando realmente encontra uma fórmula" (cerca de 546 KB); documentos sem fórmulas não pagam nada
- No WYSIWYG, as fórmulas não são renderizadas, apenas ganham um fundo colorido — enfiar o DOM da KaTeX dentro de um contenteditable faz o backspace não apagar e o cursor travar; o custo é muito maior que o benefício. Para ver renderizado, use `Ctrl+3`, ou ative a coluna dupla para ter a visualização ao lado
- Os trechos de fórmula são protegidos **antes** da análise da sintaxe de ênfase, então o `_` e o `*` em `$x_1 * y$` são subscrito e sinal de multiplicação, não interpretados como itálico

### Modo foco (`F9`, `Esc` para sair)

A linha de abas, a barra lateral, a barra de status e o menus se recolhem, restando apenas o texto. A barra de título esmaece quase até desaparecer e só reaparece quando o mouse passa por cima — como a janela é sem bordas, se a barra de título desaparecesse também, não daria para arrastar, minimizar ou fechar, o que equivaleria a trancar você dentro do seu próprio documento.

### Abertura por duplo clique / apenas uma janela

Depois de instalar o pacote, `.md` `.markdown` `.txt` `.log` `.json` `.csv` têm todas as associações de arquivo registradas;
no Explorador de Arquivos, o clique direito em "Abrir com" já mostra o "EZNotepad".

O mesmo programa mantém apenas uma janela: dar duplo clique em outro arquivo não inicia um segundo processo,
mas entrega o caminho à janela que já está aberta (aproveitando para chamá-la de volta da minimização).
Duas janelas editando o mesmo arquivo ao mesmo tempo e sobrescrevendo uma à outra: isso acabou na raiz.

> Apenas a **versão instalável** registra as associações. A versão portátil e o exe simples gerado com `cargo build` não escrevem no registro.

### Monitoramento de mudanças de arquivo

Os documentos abertos são observados em tempo real (o backend usa `ReadDirectoryChangesW` / `inotify` do sistema, ouvindo apenas o nível do diretório do arquivo e só deixando passar os nomes na lista). Quando outro programa altera o arquivo:

- Arquivo na **aba atual**: se você não alterou nada, recarrega em silêncio e avisa; há modificações não salvas, pergunta antes
- Arquivo em **aba em segundo plano**: sem popup atrapalhando; um pontinho âmbar aparece na aba, e só pergunta quando você troca para ela

Salvar o próprio arquivo não dispara o evento (após salvar, o horário de modificação já está sincronizado). Nas configurações, dá para desligar tudo.

### Formatação com um clique (tratamento inteligente por tipo de arquivo)

| Tipo | O que faz |
|---|---|
| **JSON** | Validação + reorganização da indentação; corrige automaticamente aspas de meia largura invertidas, vírgulas extras e comentários; **com erro de sintaxe, não mexe no arquivo e mostra "linha X, coluna Y"** |
| **Markdown** | Adiciona linhas em branco antes e depois de títulos, unifica marcadores de lista, remove espaços no fim das linhas, comprime linhas em branco |
| **TXT / logs / código** | Unifica quebras de linha, remove espaços no fim das linhas, comprime linhas em branco consecutivas |

Depois de formatar, um clique em "Desfazer" volta ao original.

### Versões históricas (Arquivo → Versões históricas…)

A cada salvamento, o conteúdo **de antes de salvar** deixa um instantâneo, guardado no diretório de dados do aplicativo no seu computador (sem encher sua pasta de documentos).
Depois de formatar com um clique, ordenar/deduplicar ou substituir em lote, se quiser voltar atrás, `Ctrl+Z` pode não alcançar; aqui é a última linha de defesa.

- Cada arquivo guarda no máximo 60 versões, total de 20 MB; ao ultrapassar, limpa a partir da mais antiga
- "Visualizar" abre aquela versão como uma nova aba somente leitura, e "Restaurar" grava de volta no editor — **em ambos os casos, só toca no disco quando você mesmo aperta `Ctrl+S`**
- Mesmo princípio da comparação de arquivos e da mesclagem de três vias: reverter não sobrescreve o arquivo original diretamente

### Exportar página web (Arquivo → Exportar página web…)

Salva o documento atual como um **HTML de arquivo único**: estilos embutidos, imagens convertidas em data URI;
envie para outra pessoa ou jogue em um site estático, e ele abre direto, sem aquela história de "todas as imagens quebradas".
Imagens acima de 4 MB não são embutidas (o endereço original é mantido), e a mensagem de exportação informa quantas foram embutidas.

### Paleta de comandos (`Ctrl+Shift+P`)

Mais de cem comandos dos menus: digite algumas letras e localize; `foco`, `formatar`, `substituir` — tudo funciona,
com `↑` `↓` para escolher, `Enter` para executar e `Esc` para fechar. A lista é gerada diretamente da árvore de menus, então comandos novos nos menus aparecem aqui automaticamente.
Comandos indisponíveis no estado atual ficam cinza, e ao clicar, ele explica o porquê.

### Personalize seus atalhos (Configurações → Atalhos)

O painel de configurações lista todos os comandos que têm atalhos; clique em "Alterar" e pressione a nova combinação (deve incluir `Ctrl` / `Alt`,
ou usar apenas `F1`–`F12`); `Esc` cancela. As teclas personalizadas têm prioridade sobre as padrão; se estragar, clique em "Restaurar" para voltar,
e "Restaurar configurações padrão" limpa tudo de uma vez.

### Comparação de texto (`Ctrl+D`)

- Lado a lado, com realce duplo **em nível de linha + de caractere** (apenas os poucos caracteres realmente alterados são marcados)
- Ignorar espaços em branco / ignorar maiúsculas e minúsculas
- `F7` / `F8` saltam entre as diferenças
- Cada bloco de diferença tem um botão **→** que sincroniza o bloco da esquerda para a direita com um clique
- Exportação de relatório de comparação em HTML com um clique

### Comparação de pastas

Compara dois diretórios recursivamente, listando **somente à esquerda / somente à direita / modificados / idênticos**; clicar em uma linha leva direto à comparação de texto daquele arquivo.

### Mesclagem de três vias (Ferramentas → Mesclagem de três vias)

Escolha "versão base + lado A + lado B"; as mudanças dos dois lados são mescladas automaticamente, e os conflitos são listados.
**O resultado abre apenas em uma nova aba; nenhum arquivo original é jamais sobrescrito.**

### Codificação e quebra de linha

Clique em `UTF-8` no canto inferior direito da barra de status para salvar com outra codificação (UTF-8 / GBK / UTF-16, com BOM opcional);
clique em `LF` para alternar para CRLF. Abrir um txt antigo em GBK não gera caracteres corrompidos.

---

## Desempenho medido

Medido na própria máquina (Windows 11, x64, build release):

| Cenário | Métrica |
|---|---|
| Digitação cotidiana (documento de 600 parágrafos, WYSIWYG) | Média de **9.1 ms** por caractere digitado |
| Abertura de documento gigante (10.8 MB / 77,866 blocos) | **1.14 s**, sem congelar a interface (renderização por viewport, cerca de 48 blocos no DOM) |
| Digitação em documento gigante | Latência p50 de **0.3 ms** |
| Rolagem em documento gigante | Cerca de **17 ms** por quadro, taxa cheia |
| Desfazer em documento gigante | **37 ms** por passo, ida e volta idêntica byte a byte |
| Arquivo grande de texto simples (CodeMirror 6) | 50 mil linhas abrem em **49 ms**, 100 mil em **20 ms**, renderizando apenas as linhas visíveis |
| Uso de memória | Cerca de **170 MB** em inicialização limpa (incluindo o processo de GPU do WebView2) |
| Tamanho | Pacote de instalação de **2.63 MB** |

---

## Dados e privacidade

- Todos os arquivos são lidos e gravados apenas no seu computador, **sem internet, sem upload**
- Os rascunhos são salvos no diretório de dados do aplicativo local; fechar a janela não os perde: **todas** as abas não salvas são guardadas,
  e na próxima inicialização pergunta se você quer recuperá-las (não é só a última)
- Os instantâneos históricos também ficam em `history/` dentro desse diretório, completamente separados da sua pasta de documentos
- Ao abrir pela primeira vez, se detectar rascunhos não salvos, pergunta se deseja restaurar

---

## Limitações conhecidas

- A exportação para PDF usa o diálogo de impressão do sistema ("Salvar como PDF"); o layout segue o resultado da impressão
- A mesclagem de três vias é semiautomática: mesclagem automática + lista de conflitos, sem um mesclador visual de quatro colunas (conflitos complexos: use a comparação de texto e trate bloco a bloco)
- Cada pacote de instalação precisa ser compilado no sistema correspondente (veja `构建说明.md`)
- A busca entre arquivos é literal por padrão, sem diferenciar maiúsculas; pode alternar para regex; limite de 200 resultados
- A substituição entre arquivos processa apenas arquivos **UTF-8**: GBK e similares são pulados como estão, sem trocar silenciosamente a codificação do arquivo inteiro
- A exclusão na árvore de arquivos vai para a lixeira do sistema; **pastas só podem ser excluídas se estiverem vazias**, sem exclusão recursiva
- A própria **árvore** de arquivos não é monitorada: arquivos criados/excluídos em outros lugares exigem clique direito em uma área vazia → "Atualizar", ou reexpandir o diretório (os documentos abertos são monitorados em tempo real, como descrito acima)
- As fórmulas matemáticas só são renderizadas no lado da visualização; no WYSIWYG, o código-fonte é exibido; diagramas Mermaid ainda não são suportados

---

## Licença

Este projeto é distribuído sob a [PolyForm Noncommercial License 1.0.0](./LICENSE):

- **Uso não comercial** (uso pessoal, estudo, pesquisa, organizações sem fins lucrativos etc.): uso, modificação e distribuição livres
- **Uso comercial**: requer consentimento prévio da equipe do projeto — basta [abrir uma Issue descrevendo a finalidade](https://github.com/EZLive00/EZNotepad/issues)
- O código-fonte é aberto, mas a autorização para uso comercial é reservada — essa é uma escolha deliberada; ao redistribuir, é obrigatório incluir este aviso de licença
