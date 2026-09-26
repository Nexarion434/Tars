KO (47 OK / 11 KO / 44 non lancés ; faux CLI .cjs de la fixture : `win/test-portability`) | Vérification | Statut | Chiffres / cause |
|---|---|---|
| `npm ci` | **KO** | exit 1 : npm force `node-gyp rebuild` sur better-sqlite3 (présence de `binding.gyp`) et node-gyp exige Visual Studio. `npm ci --ignore-scripts` + `npm rebuild node-pty unrs-resolver electron-winstaller` : 875 paquets, exit 0 |
| Binaire Electron | OK | `npx install-electron` : 44.4.4 |
| `@electron/rebuild` | KO, inutile | « Could not find any Visual Studio installation » |
| Modules natifs dans Electron 44 | **OK** | prebuilds Windows : better-sqlite3 ouvre une base en mémoire, node-pty exécute `cmd.exe /c echo ok` et lit `ok` |
| 7 serveurs MCP | OK | 7/7 install + build, aucun lockfile modifié |
| `npx tsc --noEmit` | OK | 0 erreur |
| `npx tsc -p electron/tsconfig.json` | OK | 0 erreur |
| `npm test` | **KO** | 250 fichiers : 123 KO / 127 OK ; 2605 tests : 573 KO, 1932 OK, 100 ignorés. 463 des 573 viennent de la garde de `home-isolation.ts` (elle protège `C:\Users\nicol`, qui contient `%TEMP%`) |
| `npm test`, garde adaptée à Windows (diagnostic) | KO | 249 fichiers : 68 KO / 181 OK ; 458 tests KO, 2991 OK. `hook-registration.test.ts` bloque indéfiniment |
| `npm run lint` | OK | 0 erreur, 132 avertissements |
| `npm run lint:design` | KO tel quel | `bash` = WSL sans distribution. Via Git Bash : 228 fichiers lus, 6/6 contrôles verts |
| `npm run e2e:guard` | OK | pages OK, overlays 3 sur 14 |
| `npm run electron:dev` | **KO** | `'NODE_ENV' n'est pas reconnu` |
| App lancée à la main (dev) | OK, dégradé | fenêtre « Tars \| Agent Control Center » chargée, `/api/health` 200. Cadre natif + barre de menus (`hiddenInset` ignoré). Hooks enregistrés en `.sh`, bundles MCP introuvables en dev |
| `npm run e2e` | **KO** | 93 tests : 11 KO, 1 OK, 1 ignoré, 80 non lancés. La vérification de dossiers du fixture rejette chaque lancement : Electron rapporte `home = C:\Users\nicol` quel que soit l'environnement |

Causes des 458 échecs (run diagnostic) :

| Cause | Fichiers | Tests | Nature |
|---|---|---|---|
| binaires POSIX en dur (`/bin/bash`, `/bin/sh`, `ps`, `touch`) | 14 | 160 | test non portable, bug produit derrière |
| création de symlink refusée (EPERM) | 13 | 81 | environnement (mode développeur) |
| le test ne redirige que `HOME` | 7 | 41 | test non portable |
| le faux `gh` est contourné, le vrai `gh.exe` s'exécute | 2 | 38 | test non portable, **sécurité** |
| `bash` nu = WSL | 1 | 29 | test non portable |
| encodage `C--Users-...` des dossiers de projets Claude | 5 | 27 | **bug produit** (B/H-01..H-03) |
| `split('/')` dans les messages des bots | 2 | 21 | bug produit (B/J-01) |
| séparateurs `/` et littéraux POSIX dans les assertions | 4 | 16 | test non portable |
| modes POSIX (0600) | 4 | 9 | test non portable ; bug produit P1 (B/S-01) |
| jq absent | 2 | 0 | environnement |
| divers | 14 | 36 | mixte |

Constats ajoutés par la phase 0 (en plus des audits) :

| fichier:ligne | Problème | P | Agent |
|---|---|---|---|
| `__tests__/setup/home-isolation.ts:103,119,121` | ne redirige que `HOME` ; la garde protège un dossier qui contient `%TEMP%` (97 fichiers KO) | P0 | win-qa |
| `e2e/fixture.mjs:561`, `:574-592` | l'app démarre sur le `USERPROFILE` du parent avant la vérification ; `getPath('home')` d'Electron ne suit pas l'environnement | P0 | win-qa |
| `__tests__/scripts/fake-gh.ts`, `release.test.ts`, `prune-releases.test.ts` | le vrai `gh.exe` s'exécute au lieu du faux (avec la session GitHub de l'utilisateur si `APPDATA` n'est pas isolé) | P0 | win-qa |
| `__tests__/hooks/hook-registration.test.ts:117,140` | `spawn('/bin/bash')` n'attend que `exit` : blocage infini | P0 | win-qa |
| 45 fichiers de tests + `e2e/chat-rooms.spec.ts:37`, `e2e/left-fullscreen.live.spec.ts:45` | `/tmp` en dur, écrit dans `C:\tmp` | P1 | win-qa |
| `electron/services/acp/client.ts:148,155` | `ps` introuvable : arrêter ou quitter une délégation lève ENOENT | P0 | win-process |
| pont OpenAI | prend le port API + 1 : un bac à sable sur 31497 prend 31498, le port de l'E2E | P2 | win-build |
| `mcp-orchestrator.ts` en dev | bundles cherchés dans les ressources d'Electron (sans doute pareil sur mac, à confirmer) | P2 | win-build |
| `api-token` | hérite d'ACL larges (dont `CodexSandboxUsers`) : aucun équivalent de 0600 | P1 | win-platform |

Logs complets : dossier scratchpad de la session du 2026-09-25 (`phase0/`), non versionnés.

---

## 2. Matrice de parité

| # | Fonctionnalité | Statut | Constats | Agent | Preuve attendue |
|---|---|---|---|---|---|
| 1 | Installation (`npm ci`, modules natifs, 7 MCP) | **OK** (`npm ci` exit 0 avec VS Build Tools, gate 2026-09-25) | B/B-02 | win-build | `npm ci` exit 0, node-pty + better-sqlite3 chargés dans Electron 44 |
| 2 | Compilation (`tsc` x2) | **OK** | | win-build | les deux `tsc` exit 0 |
| 3 | `npm test` | **OK** (0 échec sur 4169 hors 1 flake de charge `pty-kill` 8 ; 177 sautés sous win32 avec raison ; était 573 / 2605) | B/T-01..T-03 | win-qa | vert, isolé du vrai profil |
| 4 | `lint`, `lint:design`, `e2e:guard` | **OK** (lint:design en Node) | B/P-05 | win-build | exit 0 depuis PowerShell |
| 5 | Démarrage dev (`electron:dev`) | **OK** depuis PowerShell (fenêtre + `/api/health` 200) ; fonctions dégradées | B/B-01 | win-build | la fenêtre s'ouvre depuis PowerShell |
| 6 | Créer un agent (UI) | KO | B/A-01, A1 | win-process + win-platform | E2E : PTY créé, carte au repos |
| 7 | Lancer un agent (UI, API, bots, restauration) | KO | A1, A3, A4, B/A-02, B/A-04 | win-providers + win-platform | E2E : le faux CLI reçoit l'argv exact |
| 8 | Trouver les CLIs (npm `.cmd`, `claude.exe` natif, PATHEXT) | KO | A5, A16, A17, B/C-01..C-03 | win-platform | unit : résolution `.exe` / shim `.cmd` vers `node <script>` |
| 9 | Envoi de messages dans un CLI lancé (bracketed paste, ConPTY) | ? | A23, A6 | win-process | spec : 5 Ko multi-ligne arrive en un tour, 10/10 |
| 10 | « Le CLI tourne-t-il ? » (bots, dispatch, agent:get) | KO | A6 | win-process | unit + E2E démarrage via le chemin Telegram |
| 11 | Hooks Claude (statut, session, mémoire) | KO | A7, A8, A9, A14 | win-hooks | E2E : SessionStart enregistré, statuts reçus |
| 12 | Hooks Gemini | KO | A10, A11, A13 ; A12 (bug upstream) | win-hooks | E2E : AfterAgent poste le statut avec le jeton |
| 13 | Statusline et chiffres d'Usage qui en dépendent | KO | A15 | win-hooks | E2E : `token-stats.json` écrit |
| 14 | Terminal rapide, Projects > Terminal | KO | A2, B/A-05 | win-platform + win-process | E2E : invite de shell affichée |
| 15 | Installation de skills / plugins | KO | A25, B/A-06, B/A-07 | win-process | E2E ou manuel en bac à sable |
| 16 | Délégation ACP (retour de résultat) | KO | A20, A21 | win-process | E2E : délégation à un faux agent ACP, stop reason reçu, aucun process orphelin |
| 17 | Fermeture d'un terminal sans dialogue d'erreur | **OK** (`killPty` aux 18 sites, E2E `pty-kill.spec` : 0 AttachConsole) | A22 | win-process | spec : 20 kills, aucune erreur non gérée |
| 18 | 7 serveurs MCP (build + enregistrement) | build OK, enregistrement ? | A18, A19, B/M-01, B/M-02 | win-platform + win-providers | 7 builds exit 0 ; `config.toml` Codex valide |
| 19 | Mise à jour auto des CLIs | KO (silencieux) | A28 | win-process | décision : porter ou désactiver sous Windows |
| 20 | Worktrees | **OK** (garde, `isInsideWorktreesDir`) | B/W-01..W-03 | win-platform | unit : noms de périphériques refusés, chemins `\` |
| 21 | Review git | ? (argv, a priori OK) | B/R-01, B/U-02 | win-shell-ui | E2E surface review |
| 22 | Usage | ? (a priori OK) | B/G-01, A15 | win-qa | E2E surface usage |
| 23 | Memory, Projects, reprise de session (`~/.claude/projects`) | KO | B/H-01..H-05 | win-platform | unit encodage `C--Users-...` ; E2E Projects |
| 24 | Hermes, Tailscale, Tasmania | ? | B/I-01..I-03 | win-platform | unit emplacements par plateforme |
| 25 | Bots Telegram / Slack / Discord | lancement **OK** ; noms de projets **OK** (bots) ; checklist manuelle : ? | B/A-04, B/J-01 | win-providers | checklist manuelle §4 |
| 26 | Tray (icône, panneau, menu) | **OK** (`.ico` grille orange, panneau au-dessus de la barre des tâches, clic droit Show/Quit, K-02 ; E2E `desktop-shell.win32.spec`) ; netteté 125-150 % : checklist manuelle | B/K-01..K-04 | win-shell-ui (visuel) | capture validée par Nicolas |
| 27 | Ouvrir dans un terminal | KO | B/L-01 | win-platform | unit win32 : `wt.exe -d`, puis PowerShell, puis cmd |
| 28 | Fenêtre, barre de titre, déplacement | **OK** (D5 : titleBarOverlay 32 px, suit le thème, zones de déplacement ; D15 panneaux sous la bande) | B/N-01, B/N-02 | win-shell-ui (visuel) | capture validée par Nicolas |
| 29 | Cycle de vie (fermer, instance unique, notifications) | **OK** (D6 : fermer masque dans le tray, instance unique, fin de session Windows sauvegarde et arrête, AUMID) ; toast packagé : checklist manuelle | B/N-03..N-05 | win-shell-ui | manuel : fermer la fenêtre ne tue pas les agents |
| 30 | Raccourcis clavier (Ctrl+W/R/chiffres) | **OK** (D7 : pas de menu, Ctrl+chiffre pages, Alt+chiffre panneaux, Ctrl+C/V terminal, collage multi-ligne entre crochets) | B/N-07..N-09 | win-shell-ui | E2E touche Ctrl+chiffre : une seule action |
| 31 | Textes et chemins affichés (noms de projets, `~`, copies Mac) | **OK** noms de projets, arborescence Code, `~` (`src/lib/display-path.ts`) ; textes mac : D10 en attente | B/U-01..U-08 | win-shell-ui | E2E surfaces avec chemins Windows |
| 32 | Secrets (modes POSIX sans effet, écritures atomiques) | KO | B/S-01, B/S-02 | win-platform | stress test rename ; SECURITY.md documenté |
| 33 | Packaging NSIS + `.ico` | **OK** (NSIS par utilisateur + zip, `.ico`, `release:win` ; install/lancement/désinstall prouvés en bac à sable ; 127 Mo) ; install réelle : checklist manuelle | B/P-01..P-03 | win-build | install / désinstall / mise à jour sur cette machine |
| 34 | Auto-update depuis le fork | **OK** en local (1.9.0-win.1 vers 1.9.0-win.2 via flux local, agents conservés) ; flux GitHub réel : à la première release | B/P-09, B/P-10 | win-build | 1.x.0 packagée se met à jour vers 1.x.1 |
| 35 | Bac à sable (`npm run sandbox`) | **OK** (`npm run sandbox` : `win-unpacked`, profil isolé, port 31499) | B/P-04 | win-build | lance `win-unpacked` sur 31499, USERPROFILE isolé |
| 36 | E2E (38 surfaces, références Windows dédiées) | **OK** (46/46 surfaces sur références `win32/`, stables quel que soit `%TEMP%` ; 7 tests à entrée OS réelle à relancer sur bureau libre) | B/E-01..E-07 | win-qa | 38/38, `__screenshots__/win32/` |
| 37 | CI `windows-latest` | **OK** (`CI - Windows` vert sur windows-latest : unit + E2E 46/46, run 36250753440 ; `CI - Tests` ubuntu vert ; synchro quotidienne 04:17 UTC opérationnelle, premier run : rien à synchroniser) | B/P-11 | win-build | job vert sur PR vers `windows` |
| 38 | Zéro régression macOS / Linux | ? | | win-reviewer | CI ubuntu verte, diffs darwin/linux prouvés identiques |

## 3. Sécurité (priorité dans chaque lot)

| Constat | Risque | Lot |
|---|---|---|
| A4 | Un saut de ligne dans un prompt tapé dans PowerShell exécute la suite comme une commande (prouvé) | lancement direct, sans shell (décision 2) |
| B/N-06 | Chemin du son de notification interpolé dans du code PowerShell ; modifiable par tout agent via `app-settings.json` | plateforme |
| B/M-03 | Garde d'envoi de fichiers Telegram : ne bloque pas `%APPDATA%` / `%LOCALAPPDATA%` | plateforme |
| B/T-01, B/E-01 | Tests et E2E écrivent dans le vrai profil tant que `USERPROFILE` n'est pas redirigé | harnais (premier lot) |
| B/S-01 | Modes 0600/0700 sans effet : ne pas le prétendre dans SECURITY.md | plateforme (doc) |
| A26, A27 | Quoting de ligne de commande Windows (guillemets, `\n`, `%`, limite 8191 de cmd) | plateforme |

Bugs préexistants hors Windows, à remonter plus tard (jamais sans l'accord de Nicolas) : A12 (Gemini
supprime le jeton des hooks, `UserPromptSubmit` n'existe pas chez Gemini), A29 (20 générateurs de
scripts bash morts, injection latente), B/§4 `git-review.ts:318-331` (lecture hors dépôt d'un fichier
« untracked »), `/api/local-file` suit un lien planté dans `vault/attachments`.

### Limites Windows connues (assumées, documentées)

- Un CLI lancé **à la main** dans le PowerShell d'attente d'un agent n'est pas vu comme « CLI en cours » : ConPTY ne donne pas le processus au premier plan (`pty.process` renvoie le nom du terminal). Tars refuse de remplacer ce terminal si une session s'y est enregistrée (Claude, via le hook SessionStart) ; un CLI qui n'enregistre pas de session (codex, gemini) lancé à la main n'est pas détectable et meurt avec le shell si l'agent est démarré depuis Tars (lot `win/agent-launch`).
- Transcript Claude : si la dernière réponse de l'assistant est à plus de 8 Mo de la fin du fichier, le hook Stop/SessionEnd ne la poste pas (lecture bornée ; idle et agent-stopped restent postés).

## 4. Checklist manuelle (ce que l'E2E ne couvre pas)

- [ ] Bot Telegram : `/start_agent` lance l'agent, la réponse revient
- [ ] Bot Slack : idem
- [ ] Bot Discord : idem
- [ ] Tray : icône nette à 100 et 150 %, panneau au-dessus de la barre des tâches, clic droit
- [ ] Notification Windows (toast) en dev et packagé
- [ ] Fermer la fenêtre : les agents continuent, le tray rouvre
- [ ] Deuxième lancement : focalise la première instance
- [ ] Installeur NSIS : install, lancement depuis le menu Démarrer, désinstallation propre
- [ ] Mise à jour auto : 1.x.0 vers 1.x.1 depuis le fork
- [ ] Ouvrir dans un terminal : Windows Terminal s'ouvre dans le bon dossier

## 5. Décisions d'architecture

| # | Sujet | Décision | Date | Validée par |
|---|---|---|---|---|
| D1 | Hooks | Un runner Node unique (`hooks/tars-hook.mjs <event>`, `statusline.mjs`), appelé `node <script> <event>`. Activé sous Windows d'abord ; les `.sh` restent identiques sur mac/Linux. Proposition upstream pour toutes les plateformes plus tard (corrige aussi A12, A14) | 2026-09-25 | Nicolas |
| D2 | Lancement des providers | Lancement direct sans shell : une fonction plateforme retokenise la commande POSIX du provider (grammaire fermée, déjà verrouillée par `exec-into-cli.test.ts`), résout le binaire (`.exe`, shim npm `.cmd` vers `node <script>`), construit la ligne de commande Windows et lance le CLI dans ConPTY avec `cwd`. 0 provider modifié. Le changement de contrat (`buildInteractiveArgs`) sera proposé upstream plus tard | 2026-09-25 | Nicolas |
| D3 | Shell par défaut (terminaux humains) | `pwsh.exe` si présent, sinon `powershell.exe`, sinon `%ComSpec%` ; surchargeable par un réglage (Git Bash sélectionnable). `-l` seulement pour bash/zsh. L'interface du réglage attend un dessin de Nicolas | 2026-09-25 | Nicolas |
| D5 | Barre de titre Windows | Option A : `titleBarStyle: 'hidden'` + `titleBarOverlay` (boutons natifs 32 px, couleur du token de fond, suit le thème clair/sombre), bande haute + en-tête comme zone de déplacement, actions de l'en-tête inchangées. Captures : scratchpad `ui-proposals/` | 2026-09-25 | Nicolas |
| D6 | Fermeture de la fenêtre | Masquer dans le tray, agents actifs ; « Quitter Tars » depuis le menu du tray ; explication au premier clic sur fermer (mémorisée) ; instance unique (un 2e lancement ramène la fenêtre) | 2026-09-25 | Nicolas |
| D7 | Menu et raccourcis | Aucune barre de menus sous Windows (Ctrl+W/R/Shift+R/Shift+I/zoom ne ferment ni ne rechargent plus) ; Ctrl+chiffre = pages, Alt+chiffre = panneaux de terminal ; terminal : Ctrl+C copie si sélection, Ctrl+V colle | 2026-09-25 | Nicolas |
| D8 | Tray | `.ico` multi-taille (16 à 48 px) de la grille orange (la marque, jamais `>_`), panneau ouvert au-dessus de la barre des tâches, clic droit : Afficher Tars / Quitter Tars | 2026-09-25 | Nicolas |
| D9 | UI du réglage de shell | Premier réglage de Settings > General > Terminal, **sous Windows seulement** : liste des shells détectés (chemin en aide) + « Chemin personnalisé » ; composants `src/components/ui` uniquement | 2026-09-25 | Nicolas |
| D10 | Textes propres à mac | **En attente** : Nicolas relit les formulations de `PROPOSALS.md` ; aucun texte modifié d'ici là | | |
| D11 | Version des builds Windows | `<version de Jean>-win.<n>` (ex. `1.9.0-win.1`), n incrémenté à chaque release du fork | 2026-09-26 | Nicolas |
| D12 | Signature de l'installeur | Aucune (SmartScreen au premier lancement ; auto-update fonctionnel) | 2026-09-26 | Nicolas |
| D13 | Synchro avec Jean | GitHub Action quotidienne (`upstream-sync.yml`) : merge de `upstream/main` dans `win/sync-<date>`, CI Windows + ubuntu lancée par le workflow lui-même sur ce merge (pas de PR : GitHub ne lance pas la CI sur une PR ouverte par son propre jeton), **avance automatique de `windows` si tout est vert**, puis release Windows (auto-update) ; conflit : issue listant les fichiers. Prérequis : branche par défaut du fork = `windows`, Issues activées, `SYNC_TOKEN` recommandé | 2026-09-26 | Nicolas |
| D14 | Textes du lot desktop-shell | Validés tels quels : dialogue de première fermeture (« Keep your agents running? », « Keep running in the tray » / « Quit and stop agents »), menu du tray « Show Tars » / « Quit Tars », lignes « Shell » / « Shell path » et libellés des shells ; badge d'alerte du tray : point rouge actuel conservé | 2026-09-26 | Nicolas |
| D15 | Panneaux fixés en haut sous Windows | Tiroirs, terminal plein écran et tout panneau `fixed top-0` démarrent sous la bande de 32 px des boutons natifs (Windows seulement) | 2026-09-26 | Nicolas |
| D4 | Environnement de dev | VS Build Tools C++ installés (`npm ci` tel quel). Mode développeur **non** activé : les tests qui créent des symlinks sont sautés sous Windows sans privilège, avec la raison affichée, et tournent en CI `windows-latest` | 2026-09-25 | Nicolas |

## 5bis. Reprise (état au 2026-09-25 soir)

Phases 0 à 5 mergées, CI Windows verte sur GitHub (2414b187). Fork configuré (branche par défaut `windows`, Issues, `SYNC_TOKEN`). Reste : première release `1.9.0-win.1` (accord de Nicolas), checklist manuelle §4, textes D10, suivis de `tasks/todo.md`, phase 6 (upstream, sur go de Nicolas).

Ensuite : phase 4 (références visuelles win32 dans `e2e/__screenshots__/win32/`, CI `windows-latest`), renderer (noms de projets U-02, chemins U-01..U-08, raccourcis N-07/N-08), phase 5 (NSIS, `.ico`, auto-update depuis le fork : voir `.claude/win-port/dorothy-windows.md`), décisions visuelles de Nicolas (barre de titre, tray, fermeture = masquer ou quitter, texte « Additional PATH », UI du réglage de shell), phase 6 (upstream, sur go de Nicolas).

## 6. Journal des lots

| Date | Lot | Branche | QA | Review | Merge |
|---|---|---|---|---|---|
| 2026-09-25 | Phase 0 + 1 : baseline, audit, roster | `windows` | n/a | n/a | c8d904ae |
| 2026-09-25 | Harnais de test Windows (isolation du profil, garde, faux gh, jonctions, références win32) | `win/test-harness` | gate win-qa | APPROVE (3 tours) | 8a6945e1 |
| 2026-09-25 | Primitives plateforme (shell, PATH, résolution des CLIs, tokenizer, ligne de commande Windows, toLaunch, killTree) | `win/platform-launch` | PASS (intégration) | APPROVE (2 tours) | 8bddb6c8 |
| 2026-09-25 | Scripts npm cross-platform (electron-dev, design-lint.mjs, build-renderer, npm-command) | `win/npm-scripts` | PASS (intégration) | APPROVE (2 tours) | aac7547b |
| 2026-09-25 | Phase 3 : hooks Node (D1), appels CLI, ACP + cli-updater, lancement direct (D2/D3), chemins/mémoire/sécurité | `win/integration-p3` (5 lots) | PASS (2e gate, 0 régression, 66 tests réparés) | APPROVE (2 à 3 tours chacun) | 33ca3429 |
| 2026-09-26 | Suivis phase 3 (killPty, garde home et ancêtres toutes plateformes, dédoublonnage platform, projectName bots, check:dashes) + portabilité des tests (npm test 0 échec sous Windows, E2E 46 surfaces atteintes) | `win/integration-p3b` | PASS | APPROVE | e1c759c0 |
| 2026-09-26 | Bureau Windows D5 à D9, D14, D15 (barre de titre, tray, fermeture, raccourcis, sélecteur de shell) + affichage des chemins dans le renderer | `win/integration-p4` (`win/desktop-shell`, `win/renderer-paths`) | PASS (sous charge) | APPROVE | e00b7ba9 |
| 2026-09-26 | Phase 5 : packaging NSIS + auto-update depuis le fork, références visuelles win32 (46), CI windows-latest + synchro quotidienne avec Jean + release automatique | `win/integration-p5` (`win/packaging`, `win/win32-visual-refs`, `win/ci-windows`) | PASS (2e gate) | APPROVE | 742f2077 |
| 2026-09-26 | CI Windows réelle au vert : temp 8.3 canonique, tests de layout POSIX sautés sous win32 + scénarios portés, nettoyage sûr vis-à-vis des PID réattribués, E2E en fr-FR et texte en niveaux de gris, écran 1920x1080 sur le runner, références win32 réenregistrées (runner = machine locale), préchauffage des pages | `win/ci-short-temp` | CI verte | APPROVE | 2414b187 |
