<div align="center">

# EZNotepad

> Un petit outil de bureau de **5 Mo** : écriture Markdown + lecture/écriture de texte + comparaison de fichiers.
> Sans installation, sans connexion Internet, prêt au double-clic.
> L'interface est disponible en 9 langues, suit par défaut la langue du système et se change manuellement dans « Paramètres → Langue ».

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | **Français** | [Deutsch](README.de.md) | [Español](README.es.md) | [Português](README.pt.md)

[![Release](https://img.shields.io/github/v/release/EZLive00/EZNotepad)](https://github.com/EZLive00/EZNotepad/releases)
[![License](https://img.shields.io/badge/license-AGPL--v3-blue)](./LICENSE)

</div>

---

## Téléchargement et installation

Téléchargez depuis les [Releases](https://github.com/EZLive00/EZNotepad/releases) :

| Fichier | Pour qui |
|---|---|
| `EZNotepad_<版本>_x64-setup.exe` | **Version installée** : assistant d'installation + associations de fichiers, double-cliquez sur un `.md` / `.txt` pour l'ouvrir directement |
| `EZNotepad_<版本>_x64-portable.zip` | **Version portable** : décompressez dans n'importe quel dossier, double-cliquez sur `EZNotepad.exe` et c'est parti |

- Les deux ne sont pas signés numériquement ; SmartScreen bloquera une première fois au lancement : cliquez sur « Plus d'informations » → « Exécuter quand même »
- La version portable dépend du runtime système WebView2 (déjà intégré à Win10 / Win11) ; elle n'écrit rien dans le registre et n'enregistre aucune association de fichiers
- Pour l'instant, seuls des builds Windows x64 sont fournis

---

## Captures d'écran

**Thème clair**

![Interface principale d'EZNotepad avec le thème clair](docs/screenshots/light.png)

**Thème sombre**

![Interface principale d'EZNotepad avec le thème sombre](docs/screenshots/dark.png)

---

## Ce qu'il remplace

| Ce que vous utilisiez | Pourquoi | Avec lui |
|---|---|---|
| Bloc-notes | ouvrir n'importe quel texte, changer l'encodage, consulter des logs | ouvre pareil, avec en plus numéros de ligne, coloration et plan |
| Typora | écrire et voir le Markdown en même temps | trois modes au choix, 20 fois plus léger |
| BeyondCompare | comparer deux fichiers | côte à côte avec surlignage, diff au caractère près, F7/F8 pour sauter d'une différence à l'autre |

---

## Trois modes (un seul menu déroulant, adaptation automatique au type de fichier)

| Mode | À quoi ça sert | Raccourci |
|---|---|---|
| **WYSIWYG** | tapez `# ` et c'est un titre, `**粗**` passe aussitôt en gras | `Ctrl+1` |
| **Mode édition** | voir le Markdown brut / le code source, avec numéros de ligne, coloration syntaxique et pliage | `Ctrl+2` |
| **Mode aperçu** | rendu en lecture seule, pour lire sans distraction | `Ctrl+3` |

**Types de fichiers pris en charge** : `.md` (les trois modes actifs), `.json` (validation + coloration + localisation des erreurs),
`.txt` `.log` `.csv`, fichiers de code courants (`.js/.ts/.py/.rs/.go/.html/.css/.sql/.yml/...`).
**À la création, on vous demande d'abord le type** (Markdown / texte brut / JSON / CSV / code) ; les fichiers non Markdown
n'ouvrent que « Édition / Aperçu » et servent alors d'éditeur de texte ordinaire.

## Le mode édition tourne sur CodeMirror 6

Ce n'est pas un simple `<textarea>`. Tout ce qui fait un vrai éditeur de code :

| | Description |
|---|---|
| **Coloration syntaxique** | JS/TS/JSX, Python, Rust, Go, Java, C/C++, JSON, CSS, HTML, SQL, YAML, Shell, INI, Markdown, avec parsing incrémental |
| **Numéros de ligne / ligne courante** | gouttière des numéros, fond de ligne courante, appariement des parenthèses, pliage de code |
| **Annulation** | history au niveau transaction propre à CM6, bien plus fiable que le contenteditable du navigateur |
| **Gros fichiers** | seules les lignes visibles sont rendues. En pratique : 50 000 lignes ouvertes en 49 ms, 100 000 en 20 ms, une centaine de lignes seulement dans le DOM |
| **Indentation** | Tab indente la sélection entière s'il y en a une, sinon la ligne courante ; Shift+Tab désindente ; Entrée reprend l'indentation de la ligne précédente |
| **Appariement des parenthèses** | taper `(` insère automatiquement `)`, pareil pour les guillemets ; quand le curseur est entre une paire, taper la parenthèse fermante « passe au-dessus » au lieu d'en insérer une nouvelle |
| **Thèmes** | deux jeux clair/sombre qui suivent l'application, la coloration syntaxique partage les mêmes variables CSS que l'aperçu |

Les couleurs sont définies une seule fois dans `body[data-theme]` du fichier `styles.css` ; l'éditeur et le moteur d'aperçu
y puisent chacun de leur côté, et il n'existe donc pas deux jeux de couleurs qui ne concordent pas.

Les options non disponibles sont automatiquement grisées — à l'ouverture d'un JSON, « WYSIWYG » passe en gris, pas de clic par erreur.

---

## Organisation de l'interface (une seule entrée par fonction)

```
┌──────────────────────────────────────────────┐
│ ▣ Fichier Édition Format Affichage Outils Aide  Bienvenue.md  － □ ✕│ ← Barre de titre (40px)
├──────────────────────────────────────────────┤
│ Bienvenue.md × │ test.json × │ +      Édition▾ ⌕ Enregistrer │ ← Onglets et outils sur la même ligne
├────────┬──────────────────┬──────────────────┤
│        │                  │                  │
│ Plan   │ Édition / WYSIWYG │     Aperçu      │
│        │                  │                  │
├────────┴──────────────────┴──────────────────┤
│ Ligne 1, Col. 1 │ 36 lignes │ 243 car. │ Markdown │ LF │ UTF-8 │ Enregistré │
└──────────────────────────────────────────────┘
```

Au-dessus de la zone de contenu, deux lignes seulement : la barre de titre (menus + titre du document + boutons de fenêtre), puis la ligne
combinée onglets et outils (onglets à gauche ; à droite, uniquement les trois actions fréquentes **changement de mode / recherche / enregistrement**,
tout le reste vit dans les menus, sans doublon). Quand la fenêtre rétrécit, les outils se réduisent à des icônes pures.

La fenêtre n'a pas de barre de titre système (`decorations: false`) : menus, titre du document et boutons de fenêtre occupent la ligne du haut,
la zone vide au milieu permet de déplacer la fenêtre, un double-clic l'agrandit — comme VS Code, WorkBuddy et consorts.
Les quatre coins de la fenêtre utilisent les arrondis natifs du DWM de Win11 ; tirer les bords redimensionne toujours.
« Affichage → Afficher le nom du fichier dans la barre de titre » masque le texte du titre, ne laissant que menus et boutons.

- **Plan** — uniquement la navigation
- **Panneau latéral** — deux pages : plan du document (surlignage de la section courante au fil du défilement) / fichiers (arborescence + recherche dans tout le dossier)
- **Barre d'outils** — seulement trois actions fréquentes : mode, recherche, enregistrement ; toutes les autres commandes passent par les menus
- **Zone de texte** — uniquement l'édition
- **Barre d'état** — uniquement l'information ; encodage et fins de ligne cliquables pour modification
- **Menus** — l'ensemble complet des entrées
- **Paramètres** — `Ctrl+,` un seul panneau : thème, taille de police, interface, sauvegarde automatique, dossier de travail
- **Centre de comparaison** — panneau plein écran indépendant, pas mélangé à l'éditeur

---

### Page « Fichiers » du panneau latéral : arborescence et recherche multi-fichiers

- Un niveau chargé à la fois (lazy loading) : ouvrir un gros dépôt ne lit pas d'emblée des dizaines de milliers de fichiers
- **Clic droit pour tout faire** : créer un fichier / dossier dans n'importe quel répertoire, renommer un fichier, ou supprimer
  - La suppression passe par la **corbeille système**, une erreur se rattrape ; les dossiers ne sont supprimés que s'ils sont vides, jamais en cascade
  - Renommer ou supprimer emmène avec lui l'onglet déjà ouvert (il ne réécrira pas vers l'ancien chemin)
- La recherche scanne en Rust, ignore les binaires et les fichiers de plus de 4 Mo, renvoie au plus 200 résultats
- Le bouton `.*` du champ de recherche active les regex, `Aa` la distinction de casse
- Les résultats sont groupés par fichier, avec numéro de ligne et extrait ; un clic ouvre et saute à la ligne
- **Remplacement multi-fichiers** : renseignez « Remplacer par » sous le champ de recherche, cliquez sur « Tout remplacer ». Une question est posée au préalable, précisant que le disque va être modifié ;
  un instantané d'historique est conservé avant chaque fichier modifié, récupérable en cas de souci
- Le dernier dossier ouvert est mémorisé ; remplaçable ou vidable depuis le panneau Paramètres

---

### Recherche (`Ctrl+F` / `Ctrl+H`)

Un seul panneau flottant, deux états : cliquez sur la flèche tout à gauche pour déployer les deux lignes « Rechercher + Remplacer », repliez pour ne garder que la recherche.
`Ctrl+F` se contente de focaliser (il ne replie pas la ligne de remplacement déjà déployée), `Ctrl+H` déploie directement.

| Capacité | Description |
|---|---|
| **Recherche en place dans le WYSIWYG** | plus besoin de passer en mode édition pour chercher ; les surlignages sont dessinés sur la couche de rendu (CSS Highlight API), sans insérer de balises dans le texte |
| **Interrupteurs de mode** | quatre petits carrés à droite du champ : `Aa` respecter la casse, `.*` regex, `全词` (mot entier), `选区` (sélection). Actifs, ils prennent la couleur d'accent |
| **Mot entier** | les bornes ne sont ajoutées que si les deux bouts de la requête sont des caractères de mot latins — le chinois n'a pas de frontière de mots, imposer `\b` ne matcherait jamais rien |
| **Dans la sélection** | la recherche/le remplacement ne portent que sur le passage sélectionné ; sans sélection, l'option est grisée |
| **Saut de ligne** | le `↵` en bout de champ (ou `Ctrl+Enter`) insère un retour à la ligne, le champ grandit tout seul ; une requête sans saut de ligne ne produit toujours pas de fausse correspondance entre paragraphes |
| **Remplacement** | quand les occurrences sont dans le même paragraphe, **la modification est directe**, sans boîte de dialogue ; seule une traversée de frontière de format (gras, lien…) demande « passer en mode édition ? » |
| **Multi-fichiers** | le champ de recherche de la page « Fichiers » du panneau latéral, qui liste les lignes trouvées groupées par fichier |

---

## Raccourcis clavier

| Action | Raccourci |
|---|---|
| Nouveau / Ouvrir / Enregistrer / Enregistrer sous | `Ctrl+N` / `Ctrl+O` / `Ctrl+S` / `Ctrl+Shift+S` |
| Fermer l'onglet / changer d'onglet | `Ctrl+W` / `Ctrl+Tab` |
| Rechercher / Remplacer / aller à la ligne | `Ctrl+F` / `Ctrl+H` / `Ctrl+G` |
| **Palette de commandes** | `Ctrl+Shift+P` |
| Paramètres | `Ctrl+,` |
| **Formatage en un clic** | `Ctrl+Shift+F` |
| **Comparaison de texte** | `Ctrl+D` |
| Différence suivante / précédente | `F8` / `F7` |
| Une colonne ⇄ deux colonnes | `Ctrl+Shift+L` |
| Afficher / masquer le plan | `Ctrl+Shift+O` |
| Mode focus (`Esc` pour sortir) / plein écran | `F9` / `F11` |
| Gras / italique | `Ctrl+B` / `Ctrl+I` |
| Barré / code en ligne | `Ctrl+Shift+X` / — |
| Insérer un lien / insérer un tableau | `Ctrl+K` / `Ctrl+Shift+T` |
| Corps de texte / titres niveaux 1 à 3 | `Ctrl+Alt+0` / `Ctrl+Alt+1~3` |
| Liste à puces / numérotée / de tâches | `Ctrl+Shift+8` / `Ctrl+Shift+7` / `Ctrl+Shift+9` |
| Citation / bloc de code | `Ctrl+Shift+Q` / `Ctrl+Shift+K` |
| Indenter / désindenter une liste | `Tab` / `Shift+Tab` |
| Agrandir / réduire / réinitialiser la police | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` |
| Exporter en PDF | `Ctrl+P` |

---

## Quelques fonctions parmi les plus utilisées

### WYSIWYG : vraiment utilisable comme éditeur

Ce n'est pas seulement « taper `# ` fait un titre » : toutes les structures de bloc se manipulent directement, avec une cohérence bidirectionnelle entre syntaxe Markdown et WYSIWYG. Le marqueur a seulement besoin d'être **en début de ligne**, inutile de l'écrire en fin de ligne — écrivez d'abord le texte, revenez ensuite en début de ligne pour ajouter `## ` et il devient un titre ; le texte qui suit le marqueur (gras et liens compris) est conservé tel quel :

| Capacité | Utilisation |
|---|---|
| **Titre / corps de texte** | tapez `# ` à `###### ` en début de ligne (aussi devant un texte déjà écrit) ; `Ctrl+Alt+1~3` change de niveau, un appui de plus revient au corps |
| **Liste à puces / numérotée / de tâches** | tapez `- ` / `1. ` / `- [ ] ` en début de ligne ; `Tab` indente en sous-élément, `Shift+Tab` remonte d'un niveau |
| **Listes imbriquées** | jusqu'à 6 niveaux ; basculer entre numérotée et à puces ne perd pas la hiérarchie, les numéros se réordonnent tout seuls |
| **Citation** | tapez `> ` en début de ligne ; `Tab` augmente le niveau de citation, Entrée sur une ligne vide en sort |
| **Bloc de code / séparateur** | tapez ` ``` ` / `---` en début de ligne ; dans un bloc de code, Entrée insère un retour à la ligne avec indentation de deux espaces |
| **Tableau** | `Ctrl+Shift+T` insère un 3×3, ou « Format → Insérer un tableau (taille personnalisée) » |
| **Édition de tableau** | `Tab` / `Shift+Tab` se déplacent de cellule en cellule (ajout automatique d'une ligne à la fin), `Enter` descend à la même colonne de la ligne suivante, clic droit pour ajouter/supprimer lignes et colonnes et régler l'alignement des colonnes |
| **Styles en ligne** | tapez `**粗**`, `*斜*`, `~~删~~`, `` `码` ``, `[文字](链接)` et tout se met en forme à la frappe |
| **Formules mathématiques** | en ligne `$a^2+b^2=c^2$`, en bloc `$$ … $$` (sur plusieurs lignes possible), composé par KaTeX dans l'aperçu |
| **Table des matières** | « Insertion → Table des matières… » parcourt les titres et génère une liste cliquable ; `Ctrl+clic` sur une entrée saute à la section correspondante |
| **Insertion d'image** | collez une capture avec `Ctrl+V`, glissez un fichier image dans la fenêtre, ou « Insertion → Image… » : dans tous les cas, l'image est copiée dans `assets/` à côté du document et référencée en chemin relatif ; on peut aussi saisir directement une adresse web |
| **Dimensions d'image** | dans le WYSIWYG, tirez le coin inférieur droit de l'image pour changer la largeur (écrite automatiquement en suffixe alt une fois le tirage terminé) ; ou écrivez à la main `![说明\|300](a.png)` pour borner la largeur, `![说明\|300x200](a.png)` pour largeur et hauteur ; sans rien, affichage au ratio d'origine (au plus 320px) |
| **Sémantique du Backspace** | en début d'un titre, Backspace révèle d'abord `###` puis efface un `#` après l'autre ; en début d'élément de liste, il dégrade d'abord, puis transforme en paragraphe ; en début de paragraphe, il fusionne avec la ligne précédente ; `Delete` fait la même chose en sens inverse |
| **Collage** | un texte multiligne est analysé comme Markdown pour devenir de vrais blocs titres/listes/tableaux, jamais une bouillie |

**Poignées de bloc en début de ligne** : à gauche de la ligne où se trouve le curseur ou la souris apparaissent deux petits boutons `+` et `⋮⋮` (ils ne recouvrent pas le texte et restent insélectionnables).
`⋮⋮` transforme ce bloc en un autre type (corps / titre 1~3 / liste / citation / bloc de code), `+` insère un nouveau bloc en dessous.
Ils exécutent les mêmes commandes que le menu « Format » de la barre supérieure, seule l'entrée a été placée à portée de main.

Le `###` d'un titre n'apparaît que lorsque vous voulez changer le niveau : en début de ligne, un premier Backspace révèle le marqueur (le corps du texte ne bouge pas d'un caractère), un appui de plus supprime un `#`, et quand tout est effacé on revient au corps — un Backspace malencontreux ne fait pas perdre niveau et texte en même temps. Dès que le curseur quitte la ligne ou que vous appuyez sur Entrée, le marqueur se replie automatiquement.

Le marqueur se reconnaît à « ce petit segment juste avant le curseur » et non à toute la fin de ligne, donc les trois écritures sont équivalentes : taper `## ` puis écrire le titre, écrire le titre puis revenir en début de ligne pour ajouter `## `, ou promouvoir un paragraphe ordinaire en titre. Seul le marqueur seul est reconnu (`## ` suivi immédiatement d'un espace), ainsi `#话题` dans le corps du texte ne sera pas transformé par erreur en titre ; et taper `- ` quand le curseur n'est pas en début de ligne ne scinde pas la phrase en liste.

Toutes les opérations de bloc se trouvent aussi dans le **menu « Format »** et le **menu contextuel (clic droit)**, avec mise en gris automatique des entrées inutilisables (par exemple, hors d'un tableau, toutes les commandes de tableau sont grisées).

### Formules mathématiques

- En ligne `$a^2 + b^2 = c^2$`, en bloc `$$ … $$` (plusieurs lignes autorisées, matrices et démonstrations multi-lignes ne tiennent pas obligatoirement sur une ligne)
- Le rendu n'a lieu que **du côté aperçu** : KaTeX est « chargé seulement quand une formule apparaît » (environ 546 Ko), les documents sans formule ne paient rien
- Dans le WYSIWYG, les formules ne sont pas rendues, elles ne reçoivent qu'un fond coloré — injecter le DOM de KaTeX dans un contenteditable le rendrait impossible à effacer au Backspace et ferait gripper le curseur ; le coût dépasse largement le bénéfice. Passez en `Ctrl+3` pour les voir, ou activez le mode deux colonnes pour avoir l'aperçu à côté
- Les segments de formule sont protégés **avant** l'analyse de la syntaxe d'emphase, ainsi dans `$x_1 * y$`, `_` et `*` sont bien indice et signe de multiplication, pas de l'italique

### Mode focus (`F9`, `Esc` pour sortir)

Ligne d'onglets, panneau latéral, barre d'état, menus — tout se replie, il ne reste que le texte. La barre de titre s'estompe presque complètement et ne réapparaît qu'au survol de la souris — la fenêtre est sans bordure ; sans barre de titre, plus moyen de la déplacer, de la réduire ou de la fermer, autant vous enfermer dans votre propre document.

### Ouverture par double-clic / une seule fenêtre

Une fois l'installateur exécuté, `.md` `.markdown` `.txt` `.log` `.json` `.csv` ont toutes leurs associations de fichiers enregistrées ;
dans l'Explorateur, un clic droit « Ouvrir avec » fait apparaître « EZNotepad ».

Le même programme ne garde qu'une seule fenêtre : re-double-cliquez sur un fichier, pas de second processus,
le chemin est confié à la fenêtre déjà ouverte (qui est au passage restaurée depuis sa minimisation).
Deux fenêtres qui modifient le même fichier et s'écrasent mutuellement : le problème disparaît à la source.

> Seule la **version installée** enregistre les associations. La version portable comme l'exe nu issu de `cargo build` n'écrivent rien dans le registre.

### Surveillance des modifications de fichiers

Les documents ouverts sont surveillés en temps réel (côté backend, `ReadDirectoryChangesW` / `inotify` du système, en n'écoutant que le niveau du dossier du fichier et en ne laissant passer que les noms sur liste). Quand un autre programme modifie le fichier :

- Fichier dans **l'onglet actif** : sans modification locale, rechargement silencieux avec notification ; avec des modifications non enregistrées, une question est posée d'abord
- Fichier dans **un onglet en arrière-plan** : pas de fenêtre intrusive, un petit point ambre apparaît sur l'onglet, la question n'arrive qu'au basculement

S'enregistrer soi-même ne se déclenche pas (l'horodatage est synchronisé après la sauvegarde). Tout peut être désactivé dans les Paramètres.

### Formatage en un clic (traitement intelligent selon le type de fichier)

| Type | Ce qui est fait |
|---|---|
| **JSON** | validation + réalignement de l'indentation ; correction automatique des guillemets pleine chasse, des virgules superflues et des commentaires ; **en cas d'erreur de syntaxe, le fichier n'est pas touché, un message « ligne X, colonne Y » s'affiche** |
| **Markdown** | lignes vides ajoutées autour des titres, symboles de liste unifiés, espaces de fin de ligne supprimés, lignes vides consécutives compressées |
| **TXT / logs / code** | fins de ligne unifiées, espaces de fin de ligne supprimés, lignes vides consécutives compressées |

Après formatage, un « Annuler » en un clic restaure l'original.

### Historique des versions (Fichier → Historique des versions…)

À chaque enregistrement, le contenu **d'avant la sauvegarde** est conservé en instantané dans le dossier local de données de l'application (rien n'est rangé dans votre dossier de documents).
Après un formatage en un clic, un tri-dédoublonnage ou un remplacement de masse, si vous regrettez, `Ctrl+Z` ne remontera pas toujours assez loin — voici le dernier rempart.

- Au plus 60 instantanés par fichier, 20 Mo au total ; au-delà, la purge commence par les plus anciens
- « Afficher » ouvre cette version en nouvel onglet en lecture seule, « Restaurer » la réécrit dans l'éditeur — **dans les deux cas, c'est vous qui devez appuyer sur `Ctrl+S` pour toucher au disque**
- Même principe que la comparaison de fichiers et la fusion à trois : le retour arrière n'écrase jamais directement le fichier original

### Export en page web (Fichier → Exporter en page web…)

Enregistre le document courant en un **HTML mono-fichier** : styles embarqués, images converties en data URI,
envoyé à quelqu'un ou posé sur un site statique, il s'ouvre directement, sans « toutes les images cassées ».
Les images de plus de 4 Mo ne sont pas embarquées (leur adresse d'origine est conservée) ; le message d'export indique combien ont été embarquées.

### Palette de commandes (`Ctrl+Shift+P`)

Les centaines de commandes des menus se retrouvent en tapant quelques lettres : `专注` (focus), `格式` (format), `替换` (remplacer),
`↑` `↓` pour choisir, `Enter` pour lancer, `Esc` pour fermer. La liste est générée directement depuis l'arborescence des menus : toute nouvelle commande de menu apparaît ici automatiquement.
Les commandes inutilisables dans l'état courant sont grisées, et un clic vous dit pourquoi.

### Raccourcis personnalisables (Paramètres → Raccourcis)

Le panneau Paramètres liste toutes les commandes dotées d'un raccourci ; après un clic sur « Modifier », tapez directement la nouvelle combinaison (avec `Ctrl` / `Alt`,
ou une seule touche `F1`–`F12`), `Esc` pour annuler. Les touches personnalisées priment sur les touches par défaut ; en cas de fausse manœuvre, « Restaurer » remet les choses en place,
et « Restaurer les paramètres par défaut » efface le tout.

### Comparaison de texte (`Ctrl+D`)

- Côte à côte, double surlignage **au niveau de la ligne et du caractère** (seuls les quelques caractères réellement modifiés sont marqués)
- Ignorer les espaces / ignorer la casse
- `F7` / `F8` pour sauter de différence en différence
- Chaque bloc de différence porte un bouton **→** pour synchroniser d'un clic ce bloc de gauche vers la droite
- Export du rapport de comparaison en HTML en un clic

### Comparaison de dossiers

Compare récursivement deux répertoires et liste **uniquement à gauche / uniquement à droite / modifié / identique** ; un clic sur une ligne ouvre directement la comparaison de texte de ce fichier.

### Fusion à trois (Outils → Fusion à trois)

Choisissez « version de base + côté A + côté B », les modifications des deux côtés sont fusionnées automatiquement, les conflits sont listés.
**Le résultat s'ouvre uniquement dans un nouvel onglet, aucun fichier original n'est jamais écrasé.**

### Encodage et fins de ligne

En bas à droite de la barre d'état, cliquez sur `UTF-8` pour réenregistrer dans un autre encodage (UTF-8 / GBK / UTF-16, avec BOM possible) ;
cliquez sur `LF` pour basculer en CRLF. Un vieux txt en GBK s'ouvre sans caractères parasites.

---

## Mesures de performance

Mesures relevées sur machine locale (Windows 11, x64, build release) :

| Scénario | Mesure |
|---|---|
| Saisie courante (document de 600 paragraphes, WYSIWYG) | en moyenne **9.1 ms** par caractère saisi |
| Ouverture d'un document très volumineux (10.8 MB / 77,866 blocs) | **1.14 s**, interface non gelée (rendu par viewport, environ 48 blocs permanents dans le DOM) |
| Saisie dans un document très volumineux | latence p50 **0.3 ms** |
| Défilement d'un document très volumineux | environ **17 ms** par image, fréquence maximale |
| Annulation dans un document très volumineux | **37 ms** par étape, aller-retour identique octet par octet |
| Gros fichiers texte brut (CodeMirror 6) | 50 000 lignes ouvertes en **49 ms**, 100 000 en **20 ms**, seules les lignes visibles sont rendues |
| Empreinte mémoire | environ **170 MB** au démarrage propre (processus GPU WebView2 compris) |
| Taille | paquet d'installation **2.63 MB** |

---

## Données et confidentialité

- Tous les fichiers sont lus et écrits uniquement sur votre ordinateur, **aucune connexion Internet, aucun envoi**
- Les brouillons sont gardés dans le dossier local de données de l'application et ne disparaissent pas à la fermeture de la fenêtre : **tous** les onglets non enregistrés sont conservés,
  et au prochain démarrage on vous demande si vous voulez les restaurer (pas seulement le dernier)
- Les instantanés d'historique vivent aussi dans `history/` de ce même dossier, totalement séparé de votre dossier de documents
- Si des brouillons non enregistrés sont détectés au premier lancement, une question de restauration est posée

---

## Limitations connues

- L'export PDF passe par la boîte de dialogue d'impression du système (« Enregistrer au format PDF »), la mise en page suit le rendu à l'impression
- La fusion à trois est semi-automatique : fusion automatique + liste de conflits, sans fusionneur visuel à quatre colonnes (pour les conflits complexes, préférez la comparaison de texte bloc par bloc)
- Les paquets d'installation de chaque plateforme doivent être construits sur le système correspondant (voir `构建说明.md`)
- La recherche multi-fichiers est par défaut littérale et insensible à la casse, avec bascule regex possible ; plafond à 200 résultats
- Le remplacement multi-fichiers ne traite que les fichiers **UTF-8** : les GBK et autres sont sautés tels quels, sans changer discrètement l'encodage de tout le fichier
- Les suppressions dans l'arborescence passent par la corbeille système ; **les dossiers ne peuvent être supprimés que s'ils sont vides**, jamais récursivement
- L'**arborescence** elle-même n'écoute pas : les fichiers créés/supprimés ailleurs demandent un clic droit « Actualiser » sur une zone vide ou une réouverture du dossier (les documents ouverts, eux, sont surveillés en temps réel, voir plus haut)
- Les formules mathématiques ne sont rendues que côté aperçu, le WYSIWYG affiche le code source ; les diagrammes Mermaid ne sont pas encore pris en charge

---

## Licence

Ce projet est distribué sous [GNU Affero General Public License v3.0 (AGPL-3.0)](./LICENSE) : libre d'utilisation, d'étude, de modification et de redistribution. Les œuvres dérivées — y compris un service hébergé reposant dessus — doivent également être publiées sous AGPL-3.0.
