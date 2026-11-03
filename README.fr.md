<div align="center">

# EZNotepad

> Un utilitaire de bureau de **5 Mo** : écriture Markdown, édition de texte et comparaison de fichiers.
> Portable, hors ligne, prêt au double-clic.
> L'interface parle 9 langues et suit celle du système ; changez-la dans **Paramètres → Langue**.

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | **Français** | [Deutsch](README.de.md) | [Español](README.es.md) | [Português](README.pt.md)

[![Release](https://img.shields.io/github/v/release/EZLive00/EZNotepad)](https://github.com/EZLive00/EZNotepad/releases)
[![License](https://img.shields.io/badge/license-AGPL--v3-blue)](./LICENSE)

</div>

---

## Téléchargement

| Fichier | Pour qui |
|---|---|
| `EZNotepad_<version>_x64-setup.exe` | **Installateur** — assistant d'installation et associations de fichiers : un double-clic sur un `.md` / `.txt` l'ouvre ici |
| `EZNotepad_<version>_x64-portable.zip` | **Portable** — décompressez n'importe où et lancez `EZNotepad.exe` (aucune écriture au registre, aucune association) |

Les versions ne sont pas signées : SmartScreen bloque le premier lancement, cliquez **Informations complémentaires → Exécuter quand même**.
Windows x64 uniquement pour l'instant ; la version portable utilise le WebView2 du système (fourni avec Windows 10 / 11).

## Captures

| Thème clair | Thème sombre |
|---|---|
| ![Fenêtre principale, thème clair](docs/screenshots/light.png) | ![Fenêtre principale, thème sombre](docs/screenshots/dark.png) |

| Écrire à gauche, prévisualiser à droite | Comparaison : marques par ligne et par caractère |
|---|---|
| ![Deux volets](docs/screenshots/split.png) | ![Fenêtre de comparaison](docs/screenshots/compare.png) |

## Ce qu'il remplace

| Avant | Pourquoi | Ici |
|---|---|---|
| Notepad | Ouvrir n'importe quel texte, changer d'encodage, lire des logs | La même chose, avec numéros de ligne, coloration et plan |
| Typora | Markdown rendu pendant la frappe | Trois modes, 20× plus léger |
| BeyondCompare | Comparer deux fichiers | Côte à côte, marques au caractère près, `F7` / `F8` pour parcourir les différences |

## Trois modes

| Mode | Ce qu'il fait | Raccourci |
|---|---|---|
| **WYSIWYG** | `# ` en début de ligne donne un titre, `**gras**` s'affiche pendant la frappe | `Ctrl+1` |
| **Édition** | Markdown / source brut, CodeMirror 6, numéros de ligne et pliage | `Ctrl+2` |
| **Aperçu** | Rendu en lecture seule, pensé pour lire | `Ctrl+3` |

`.md` accepte les trois. `.json` gagne la validation et la localisation des erreurs ; `.txt` `.log` `.csv` et les fichiers
de code (`.js .ts .py .rs .go .html .css .sql .yml` …) n'ont qu'Édition / Aperçu, comme un éditeur de texte simple.
Les nouveaux fichiers demandent d'abord un type (Markdown / Texte brut / JSON / CSV / Code).

## Édition

| | |
|---|---|
| **Blocs** | Titre `# `, listes `- ` / `1. ` / `- [ ] ` (6 niveaux), citation `> `, code ` ``` `, filet `---` — le marqueur doit seulement être en début de ligne |
| **En ligne** | `**gras**`, `*italique*`, `~~barré~~`, `` `code` ``, `[texte](lien)` se rendent à la frappe |
| **Annuler / rétablir** | Les deux flèches à gauche de la barre d'outils (grisées aux extrémités), `Ctrl+Z` / `Ctrl+Y` ; `Ctrl+Shift+Z` rétablit aussi — WYSIWYG et texte brut gardent chacun leur propre historique |
| **Tableaux** | `Ctrl+Shift+T` en insère un ; `Tab` circule entre les cellules, `Enter` va à la même colonne en dessous, le clic droit ajoute ou retire lignes et colonnes |
| **Images** | Collez une capture, glissez un fichier, ou **Insertion → Image** : l'image est copiée dans `assets/` à côté du document. Tirez le coin inférieur droit pour la largeur, ou écrivez `![légende\|300](a.png)` |
| **Maths** | `$a^2+b^2=c^2$` en ligne, `$$ … $$` en bloc, composé par KaTeX dans l'aperçu (chargé seulement s'il y a une formule) |
| **Encadrés** | `> [!info]` / `warning` / `danger` / `success`, les alias de GitHub sont acceptés |
| **Poignées de bloc** | `+` et `⋮⋮` apparaissent en début de ligne : insérer un bloc, ou convertir celui-ci en un autre type |
| **Collage** | Un texte multiligne est analysé comme du Markdown et devient de vrais titres, listes et tableaux |

Changement de type (`Ctrl+Shift+Q` citation, `Ctrl+Shift+K` code…), menu **Format**, menu contextuel et
`Ctrl+Shift+P` (palette de commandes) passent par les mêmes commandes ; les entrées inapplicables se grisent d'elles-mêmes.

### Rechercher et remplacer

Une seule surcouche, deux états : `Ctrl+F` la met au focus, `Ctrl+H` déplie le remplacement.
La recherche fonctionne **en WYSIWYG** sans changer de mode — les surlignages sont peints, jamais injectés dans le texte.

`Aa` casse · `.*` regex · mot entier (la limite n'est ajoutée que si les deux extrémités sont des lettres latines, le chinois
n'a pas de limites de mots) · dans la sélection · `↵` insère un saut de ligne dans la requête. Une correspondance dans un même
morceau de texte est remplacée sur place ; seule une correspondance traversant du gras ou un lien propose le mode Édition.

## Note rapide

`Ctrl+Shift+M` (ou **Note rapide** dans la barre de menus) ouvre une note brouillon à emplacement fixe :

- **Aucun enregistrement** — les modifications vont sur le disque environ 0,35 s après la dernière frappe, et sont écrites avant la fermeture d'un onglet ou de la fenêtre ; pas de point « non enregistré », pas de question « enregistrer ? »
- **Emplacement fixe** — `<dossier de données>/quicknote.md` ; **Fichier → Note rapide** indique où elle se trouve et permet de l'ouvrir dans l'explorateur
- **Reprise là où vous en étiez** — le curseur se place à la fin ; **Insérer l'heure actuelle** ajoute `2026-11-03 09:20`
- **Effacer reste réversible** — **Vider la note rapide** en garde d'abord une copie dans l'historique des versions

Elle reste un onglet Markdown ordinaire (modes, export, recherche) : simplement, elle n'apparaît ni dans les fichiers récents ni dans la session restaurée.

## Comparaison

`Ctrl+D` (ou `Ctrl+Shift+N`) ouvre la fenêtre de comparaison avec **deux volets vides et modifiables**, le curseur déjà à gauche — il suffit de coller :

- **Deux fichiers** — cliquez sur l'icône de dossier à gauche d'un nom de fichier en haut ; ou sélectionnez-les avec `Ctrl` / `Shift` dans la page « Fichiers » de la barre latérale, puis clic droit → **Comparer ces deux fichiers** (celui du clic droit reste à gauche)
- **Deux textes** — collez-en un de chaque côté, aucun fichier requis
- **Éditer les deux côtés** — les deux volets sont modifiables dès l'ouverture ; **Enregistrer** n'écrit que là où un fichier existe vraiment

Les marques par ligne montrent ce qui a changé, celles par caractère montrent quels caractères. `F7` / `F8` parcourent
les différences et **Exporter le rapport** produit un diff HTML autonome.
La règle de droite situe chaque différence dans le fichier entier : survolez pour le numéro de ligne,
cliquez ou faites glisser pour vous déplacer. **Différences** liste chaque changement dans un tableau triable
et filtrable (position, type, nombre de lignes).
**Trier** réordonne les deux côtés par ordre alphabétique (lignes vides à la fin) : le bruit d'ordre ne masque plus les vraies différences ; `Ctrl+Z` annule.
En mode édition, `Ctrl+Z` / `Ctrl+Y` annulent et rétablissent la saisie, les sauts de ligne, l'indentation, la suppression de sélections et le tri — même quand le focus est sur la barre d'outils.
La fenêtre de comparaison propose les deux mêmes boutons dans sa barre (grisés aux extrémités de l'historique) ; quand la fenêtre se rétrécit, la rangée se replie en icônes au lieu de tronquer un bouton.
**Différences seules** est actif par défaut : les lignes identiques sont repliées, trois lignes de contexte restent autour de chaque changement — 2 000 lignes avec 20 modifications se réduisent à quelques dizaines. Pour modifier une ligne identique plus loin, décochez la case de la barre d'outils.
`Ctrl+F` cherche dans les deux volets à la fois ; les lignes trouvées sont teintées et `Entrée` / `Maj+Entrée` passent de l'une à l'autre.

Chaque côté est limité à 8 Mo / 50 000 lignes ; au-delà, la fenêtre explique pourquoi au lieu d'échouer en silence.

**Comparer des dossiers** liste récursivement *gauche seule / droite seule / modifié / identique* ; cliquez une ligne pour
ouvrir la comparaison de ce fichier. **Fusion à trois** prend base + A + B, fusionne et liste les conflits — le résultat
s'ouvre dans un nouvel onglet et n'écrase jamais l'original.

## Fichiers et recherche

La barre latérale a deux pages : **Plan** (souligne la section en cours de lecture) et **Fichiers**.

- Arborescence chargée à la demande ; clic droit pour créer, renommer, supprimer — la suppression va à la **corbeille**, et un dossier ne se supprime que vide
- La recherche tourne en Rust, ignore les binaires et les fichiers de plus de 4 Mo, renvoie au plus 200 résultats groupés par fichier avec les numéros de ligne
- `.*` active la regex, `Aa` la casse
- Les documents ouverts sont surveillés en temps réel (`ReadDirectoryChangesW`) : l'onglet courant se recharge en silence, un onglet en arrière-plan reçoit un point ambre et demande à être affiché

## Le reste

| | |
|---|---|
| **Formatage** | `Ctrl+Alt+L` — JSON validé et réindenté (le fichier reste intact et l'erreur est signalée ligne / colonne), Markdown : lignes vides et puces harmonisées, le reste : espaces de fin supprimés. Un `Ctrl+Z` annule tout |
| **Historique** | Chaque enregistrement conserve le contenu précédent (60 par fichier, 20 Mo au total). **Voir** l'ouvre en lecture seule, **Restaurer** le renvoie dans l'éditeur — le disque ne change qu'au `Ctrl+S` |
| **Export** | HTML en un seul fichier, styles intégrés et images en data URI ; PDF via la boîte d'impression du système |
| **Raccourcis** | Paramètres → Raccourcis permet tout changer ; le personnalisé gagne, **Réinitialiser** en restaure un, **Rétablir les valeurs** efface tout |
| **Mode concentration** | `F9` replie onglets, barre latérale, barre d'état et menus ; la barre de titre s'estompe à 28 % au lieu de disparaître, sinon la fenêtre ne se déplace plus ni ne se ferme |
| **Instance unique** | Double-cliquer un autre fichier ne lance pas un second processus : le chemin est remis à la fenêtre ouverte |
| **Encodage** | Cliquez `UTF-8` ou `LF` dans la barre d'état pour changer d'encodage (GBK / UTF-16 / BOM) ou de fin de ligne |

## Raccourcis

| Action | Touches |
|---|---|
| Nouveau / Ouvrir / Enregistrer / Enregistrer sous | `Ctrl+N` / `Ctrl+O` / `Ctrl+S` / `Ctrl+Shift+S` |
| Fermer l'onglet / onglet suivant | `Ctrl+W` / `Ctrl+Tab` |
| Ouvrir la note rapide | `Ctrl+Shift+M` |
| Rechercher / Remplacer / Aller à la ligne | `Ctrl+F` / `Ctrl+H` / `Ctrl+G` |
| Palette de commandes / Paramètres | `Ctrl+Shift+P` / `Ctrl+,` |
| Formater / Comparer | `Ctrl+Alt+L` / `Ctrl+D` |
| Différence suivante / précédente | `F8` / `F7` |
| Copier cette différence de l'autre côté (+`Ctrl` pour enchaîner) | `Alt+←` / `Alt+→` |
| Rechercher dans les deux volets (fenêtre de comparaison) | `Ctrl+F` |
| Un volet ⇄ deux volets / Plan | `Ctrl+Shift+L` / `Ctrl+Shift+O` |
| Mode concentration / Plein écran | `F9` / `F11` |
| Gras / Italique / Barré / Code en ligne | `Ctrl+B` / `Ctrl+I` / `Ctrl+Shift+X` / `Ctrl+Shift+K` |
| Lien / Tableau / Citation | `Ctrl+K` / `Ctrl+Shift+T` / `Ctrl+Shift+Q` |
| Corps / Titres 1–3 | `Ctrl+Alt+0` / `Ctrl+Alt+1~3` |
| Puce / Numérotée / Tâches | `Ctrl+Shift+8` / `Ctrl+Shift+7` / `Ctrl+Shift+9` |
| Indenter / désindenter une liste | `Tab` / `Shift+Tab` |
| Zoom + / − / réinitialiser | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` |
| Exporter en PDF | `Ctrl+P` |

## Performances

Mesuré en local (Windows 11, x64, build release) :

| Scénario | Mesure |
|---|---|
| Frappe dans un document de 600 paragraphes | **9,1 ms** par touche |
| Ouverture de 10,8 Mo / 77 866 blocs | **1,14 s**, ~48 blocs dans le DOM, aucun gel |
| Frappe / défilement / annulation dans ce document | p50 **0,3 ms** / ~**17 ms** par image / **37 ms** par pas |
| CodeMirror 6, texte brut | 50 k lignes en **49 ms**, 100 k en **20 ms** |
| Mémoire / installateur | ~**170 Mo** au démarrage à froid / **2,63 Mo** |

Les gros fichiers Markdown utilisent le rendu par fenêtre : seuls les blocs visibles existent dans le DOM, le reste est
une liste d'enregistrements. Les instantanés d'annulation sont ces tableaux, donc une touche ne copie jamais tout le document.

## Données

Tout reste sur cette machine — **aucun réseau, aucun envoi, aucune télémétrie**. Les brouillons de tous les onglets non
enregistrés vivent dans le dossier de données local et sont proposés au démarrage suivant ; les instantanés d'historique
sont dans `history/` au même endroit, séparés de vos documents.

## Limites connues

- Le PDF passe par la boîte d'impression du système, la mise en page suit donc la sortie imprimée
- La fusion à trois fusionne automatiquement et liste les conflits ; pas de fusion visuelle à quatre volets (utilisez la comparaison bloc par bloc)
- Les maths ne sont rendues que dans l'aperçu et s'affichent en source en WYSIWYG ; Mermaid n'est pas pris en charge
- Le remplacement multi-fichiers ne traite que l'UTF-8 : les fichiers GBK sont ignorés plutôt que réencodés en silence
- L'arborescence n'est pas surveillée ; **Actualiser** dans le menu contextuel après une modification externe
- Chaque installateur doit être construit sur son propre système (voir `docs/构建说明.md`) ; notes d'architecture et de portage dans `docs/`

## Licence

[GNU Affero General Public License v3.0](LICENSE) — libre d'usage, d'étude, de modification et de redistribution. Les œuvres
dérivées, y compris un service hébergé bâti dessus, doivent aussi être publiées sous AGPL-3.0.
