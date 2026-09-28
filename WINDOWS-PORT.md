# Tars pour Windows : état du portage

Source de vérité du portage Windows natif (pas WSL) sur la branche `windows` du fork
`Nexarion434/Tars`. Base upstream : `JeanBrasse/Tars` `ca2bef37` (1.9.0).
Mission et règles : `CLAUDE.local.md` (local), `.claude/win-port/CONVENTIONS.md`, `.claude/agents/win-*.md`.

Détail des constats (fichier:ligne, preuves, sources) : `.claude/win-port/audit-a.md` (lancement des
agents, hooks, PTY, ACP) et `.claude/win-port/audit-b.md` (tout le reste). Dans ce document, `A12`
renvoie au constat 12 de l'audit A, `B/N-03` au constat N-03 de l'audit B.

Statuts : **KO** cassé (vérifié), **?** non testé, **OK** vérifié avec la preuve indiquée.

**État au 2026-09-28.** Le portage tourne : `windows` à 89e7bf38, `CI - Windows` verte sur windows-latest
(unit + E2E, 119 surfaces, run 36320171886, tentative 2) et `CI - Tests` verte sur ubuntu au même commit.
Deux releases publiées sur `Nexarion434/Tars` (`v1.9.0-win.1`, `v1.9.0-win.2`), et la checklist manuelle
du §4 passée en entier par Nicolas le 2026-09-28 avec un vrai installeur et un vrai agent Claude
(« tout à l'air de marcher »). Matrice (§2) : 33 lignes OK sur 38 ; restent partielles 9 (envoi
programmatique), 12 (vrai Gemini), 15 (vraie installation de skill), 24 (Hermes Desktop, Tailscale,
Tasmania) et 31 (textes mac, D10). Ce qui reste ouvert : §5bis.

---

## 1. Phase 0 : baseline (2026-09-25, Windows 11 26200 x64, Node 22.23.3)

Lancé par `win-build` avec `HOME`, `USERPROFILE`, `APPDATA` et `LOCALAPPDATA` redirigés vers un dossier
jetable. Le vrai profil a été vérifié intact après coup (8 fichiers de `~/.dorothy` identiques à
l'empreinte, hash de `~/.claude/settings.json` inchangé).

| Vérification | Statut | Chiffres / cause |
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
| 6 | Créer un agent (UI) | **OK** (E2E `agent-launch.spec` : agent créé, terminal PowerShell au repos ; lot `win/agent-launch`, f9daecf2 ; checklist §4 du 2026-09-28 ; sans tâche, l'agent attend dans son shell : comportement voulu, voir « Comportements connus ») | B/A-01, A1 | win-process + win-platform | E2E : PTY créé, carte au repos |
| 7 | Lancer un agent (UI, API, bots, restauration) | **OK** (E2E `agent-launch.spec` : fenêtre, API et bot, argv exact, jamais par un shell, prompt multi-ligne piégé A4 ; `launch-call-sites.test` : chaque site, dont `initAgentPty` ; vrai agent Claude, bots et mise à jour win.1 vers win.2 dans la checklist du 2026-09-28) | A1, A3, A4, B/A-02, B/A-04 | win-providers + win-platform | E2E : le faux CLI reçoit l'argv exact |
| 8 | Trouver les CLIs (npm `.cmd`, `claude.exe` natif, PATHEXT) | **OK** (`cli-binary.test`, `cli-exec.test`, `path-env.test`, `cli-paths-platforms.test` ; E2E `agent-launch.spec` par un shim npm `.cmd`, `acp-delegation.spec` par `npx.cmd` ; `claude.exe` réel dans la checklist du 2026-09-28 ; lots `win/platform-launch` 8bddb6c8, `win/cli-invocation` 0487ce10) | A5, A16, A17, B/C-01..C-03 | win-platform | unit : résolution `.exe` / shim `.cmd` vers `node <script>` |
| 9 | Envoi de messages dans un CLI lancé (bracketed paste, ConPTY) | partiel : collage de l'utilisateur **OK** sous ConPTY (E2E `desktop-shell.win32.spec` : deux lignes en un seul collage entre crochets ; `terminal-replay-modes.spec`) ; la séquence de `writeProgrammaticInput` est tenue par `pty-manager.test`, vert sous win32. Manque : une spec qui envoie 5 Ko multi-ligne par `/dispatch` ou `/message` à un CLI vivant sous ConPTY, 10/10 | A23, A6 | win-process | spec : 5 Ko multi-ligne arrive en un tour, 10/10 |
| 10 | « Le CLI tourne-t-il ? » (bots, dispatch, agent:get) | **OK** (E2E `agent-launch.spec` : le démarrage par le bot lance le CLI au lieu de taper la tâche dans le shell ; `launch-call-sites.test` point 10 ; bots dans la checklist du 2026-09-28) ; un CLI lancé à la main reste invisible : limite connue ci-dessous | A6 | win-process | unit + E2E démarrage via le chemin Telegram |
| 11 | Hooks Claude (statut, session, mémoire) | **OK** (D1, lot `win/hooks-node`, 33ca3429 : `node-hook-runner.test`, `node-hook-wiring.test`, `node-hook-api.test` contre le vrai serveur API par Git Bash et PowerShell ; `__tests__/hooks/app-hooks-e2e.mjs` : SessionStart enregistré, statuts reçus ; vrai agent Claude dans la checklist du 2026-09-28) | A7, A8, A9, A14 | win-hooks | E2E : SessionStart enregistré, statuts reçus |
| 12 | Hooks Gemini | partiel : **OK** en test (`node-hook-api.test` « SessionStart registers, BeforeAgent runs, AfterAgent waits » par PowerShell contre le vrai serveur API avec le jeton ; `node-hook-wiring.test` points 4 à 6 ; lot `win/hooks-node`, 33ca3429). Manque : un vrai CLI Gemini n'a jamais tourné sous Windows | A10, A11, A13 ; A12 (bug upstream) | win-hooks | E2E : AfterAgent poste le statut avec le jeton |
| 13 | Statusline et chiffres d'Usage qui en dépendent | **OK** (`node-statusline.test` ; `app-hooks-e2e.mjs` : `token-stats.json` écrit par Git Bash et PowerShell ; course du verrou corrigée, lot `win/statusline-race` 4fcc52ab ; page Usage dans la checklist du 2026-09-28) | A15 | win-hooks | E2E : `token-stats.json` écrit |
| 14 | Terminal rapide, Projects > Terminal | **OK** (E2E `agent-launch.spec` : terminal de projet ouvert, invite PowerShell affichée ; `launch-call-sites.test` point 3 ; sélecteur de shell D9 dans la checklist du 2026-09-28) | A2, B/A-05 | win-platform + win-process | E2E : invite de shell affichée |
| 15 | Installation de skills / plugins | partiel : argv **OK** en test (`launch-call-sites.test` point 4 : `npx` résolu au lieu du nom nu, aucun `-c` ni `&&` donné à un shell, 2e étape d'un plugin sautée si la 1re échoue ; lot `win/agent-launch`, f9daecf2). Manque : une vraie installation de skill et de plugin, E2E ou à la main en bac à sable | A25, B/A-06, B/A-07 | win-process | E2E ou manuel en bac à sable |
| 16 | Délégation ACP (retour de résultat) | **OK** (E2E `acp-delegation.spec` : stop reason reçu, aucun process orphelin, 15/15 après `win/acp-econnreset` 22a6947d ; `acp-windows-launch.test`, `kill-tree.test` ; lot `win/acp-delegation`, bd527aee) | A20, A21 | win-process | E2E : délégation à un faux agent ACP, stop reason reçu, aucun process orphelin |
| 17 | Fermeture d'un terminal sans dialogue d'erreur | **OK** (`killPty` aux 18 sites, E2E `pty-kill.spec` : 0 AttachConsole) | A22 | win-process | spec : 20 kills, aucune erreur non gérée |
| 18 | 7 serveurs MCP (build + enregistrement) | **OK** (build : 7/7 en phase 0 et à chaque CI Windows ; enregistrement : `mcp-registration-cli.test`, `mcp-registered.test`, `codex-toml.test`, `tasmania-setup.test`, 7 mutants tués, 12d4fad8 du lot `win/cli-invocation`, 0487ce10) | A18, A19, B/M-01, B/M-02 | win-platform + win-providers | 7 builds exit 0 ; `config.toml` Codex valide |
| 19 | Mise à jour auto des CLIs | **OK** (porté, pas désactivé : `cli-updater-windows.test`, `cli-updater-scenarios-windows.test` sur copies de `claude.exe` et shims `.cmd` npm, `cli-updater-scratch-held.test` ; lots `win/acp-delegation` bd527aee et `win/file-retry` ec79a885) ; une vraie mise à jour d'un CLI installé n'a pas été observée | A28 | win-process | décision : porter ou désactiver sous Windows |
| 20 | Worktrees | **OK** (garde, `isInsideWorktreesDir`) | B/W-01..W-03 | win-platform | unit : noms de périphériques refusés, chemins `\` |
| 21 | Review git | **OK** (surface E2E review sur référence `win32/`, CI Windows verte ; noms de projets U-02 : `project-names.spec` ; page Review dans la checklist du 2026-09-28) | B/R-01, B/U-02 | win-shell-ui | E2E surface review |
| 22 | Usage | **OK** (surface E2E usage sur référence `win32/` et `usage-unreadable.spec`, CI Windows verte ; statusline : ligne 13 ; page Usage dans la checklist du 2026-09-28) | B/G-01, A15 | win-qa | E2E surface usage |
| 23 | Memory, Projects, reprise de session (`~/.claude/projects`) | **OK** (encodage `C--Users-...` : `claude-project-dir.test`, `claude-projects-windows.test`, `memory-known-project-path.test` ; E2E `claude-projects-paths.spec` (Projects et Memory) et `panel-history.spec` (H-02, H-05) ; lot `win/paths-memory-security`, 9e715b0b ; page Brain dans la checklist du 2026-09-28) | B/H-01..H-05 | win-platform | unit encodage `C--Users-...` ; E2E Projects |
| 24 | Hermes, Tailscale, Tasmania | partiel : commande MCP de Tasmania **OK** (`tasmania-setup.test`) ; page Brain ouverte dans la checklist du 2026-09-28. Non portés : I-01 (config Hermes Desktop cherchée seulement sous `~/Library`, `hermes-handlers.ts:44`), I-02 (`tailscale.exe` hors PATH jamais cherché, `hermes-handlers.ts:125`), I-03 (jeton Tasmania sous `~/Library`, `tasmania-client.ts:6`) | B/I-01..I-03 | win-platform | unit emplacements par plateforme |
| 25 | Bots Telegram / Slack / Discord | **OK** (lancement : E2E `agent-launch.spec` ; noms de projets : `project-names-in-messages.test` ; Telegram, Slack et Discord dans la checklist du 2026-09-28) | B/A-04, B/J-01 | win-providers | checklist manuelle §4 |
| 26 | Tray (icône, panneau, menu) | **OK** (`.ico` grille orange, panneau au-dessus de la barre des tâches, clic droit Show/Quit, K-02 ; E2E `desktop-shell.win32.spec`) ; netteté et panneau : checklist du 2026-09-28 | B/K-01..K-04 | win-shell-ui (visuel) | capture validée par Nicolas |
| 27 | Ouvrir dans un terminal | **OK** (`open-terminal.test`, branche win32 : `wt.exe -d`, puis le shell résolu dans conhost ; lot `win/paths-memory-security`, 9e715b0b ; « ouvrir dans un terminal » dans la checklist du 2026-09-28) | B/L-01 | win-platform | unit win32 : `wt.exe -d`, puis PowerShell, puis cmd |
| 28 | Fenêtre, barre de titre, déplacement | **OK** (D5 : titleBarOverlay 32 px, suit le thème, zones de déplacement ; D15 panneaux sous la bande) | B/N-01, B/N-02 | win-shell-ui (visuel) | capture validée par Nicolas |
| 29 | Cycle de vie (fermer, instance unique, notifications) | **OK** (D6 : fermer masque dans le tray, instance unique, fin de session Windows sauvegarde et arrête, AUMID) ; fermer vers le tray, 2e lancement et toast packagé : checklist du 2026-09-28 | B/N-03..N-05 | win-shell-ui | manuel : fermer la fenêtre ne tue pas les agents |
| 30 | Raccourcis clavier (Ctrl+W/R/chiffres) | **OK** (D7 : pas de menu, Ctrl+chiffre pages, Alt+chiffre panneaux, Ctrl+C/V terminal, collage multi-ligne entre crochets) | B/N-07..N-09 | win-shell-ui | E2E touche Ctrl+chiffre : une seule action |
| 31 | Textes et chemins affichés (noms de projets, `~`, copies Mac) | **OK** noms de projets, arborescence Code, `~` (`src/lib/display-path.ts`) ; textes mac : D10 en attente | B/U-01..U-08 | win-shell-ui | E2E surfaces avec chemins Windows |
| 32 | Secrets (modes POSIX sans effet, écritures atomiques) | **OK** (S-01 documenté : `SECURITY.md` §7, les ACL du profil tiennent lieu de 0600, aucune ACL resserrée par Tars ; S-02 : `rename-replacing.test` (198 renames sur 200 échouaient sous 20 lecteurs), `agents-save-while-read.test`, branchés dans `secret-file.ts` et `shared-file.ts`) | B/S-01, B/S-02 | win-platform | stress test rename ; SECURITY.md documenté |
| 33 | Packaging NSIS + `.ico` | **OK** (NSIS par utilisateur + zip, `.ico`, `release:win` ; install/lancement/désinstall prouvés en bac à sable ; 127 Mo) ; install réelle, menu Démarrer et désinstallation : checklist du 2026-09-28 | B/P-01..P-03 | win-build | install / désinstall / mise à jour sur cette machine |
| 34 | Auto-update depuis le fork | **OK** en local (1.9.0-win.1 vers 1.9.0-win.2 via flux local, agents conservés) ; flux GitHub réel **OK** : `v1.9.0-win.1` vers `v1.9.0-win.2` sur la machine de Nicolas, checklist du 2026-09-28 | B/P-09, B/P-10 | win-build | 1.x.0 packagée se met à jour vers 1.x.1 |
| 35 | Bac à sable (`npm run sandbox`) | **OK** (`npm run sandbox` : `win-unpacked`, profil isolé, port 31499) | B/P-04 | win-build | lance `win-unpacked` sur 31499, USERPROFILE isolé |
| 36 | E2E (38 surfaces, références Windows dédiées) | **OK** (46/46 surfaces sur références `win32/`, stables quel que soit `%TEMP%` ; 7 tests à entrée OS réelle à relancer sur bureau libre) | B/E-01..E-07 | win-qa | 38/38, `__screenshots__/win32/` |
| 37 | CI `windows-latest` | **OK** (`CI - Windows` vert sur windows-latest : unit + E2E 46/46, run 36250753440 ; dernier vert : 89e7bf38, unit + E2E (119 surfaces), run 36320171886 tentative 2 ; `CI - Tests` ubuntu vert ; synchro quotidienne 04:17 UTC opérationnelle, premier run : rien à synchroniser) | B/P-11 | win-build | job vert sur PR vers `windows` |
| 38 | Zéro régression macOS / Linux | **OK** dans la limite de ces preuves : `CI - Tests` verte sur ubuntu à 89e7bf38 ; APPROVE de win-reviewer sur chaque lot du journal (§6), qui vérifie les branches darwin/linux à l'octet près ; tests épinglés sur les valeurs d'avant le port (`posix-byte-identical.test`, `launch-call-sites.test`, `node-hook-wiring.test`). Aucune machine macOS n'a rien lancé | | win-reviewer | CI ubuntu verte, diffs darwin/linux prouvés identiques |

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

- Quand tous les cœurs sont saturés, quitter prend 20 à 90 s : l'arrêt de Chromium est affamé (mesuré aussi sur une app Electron 44 vide, 20 à 59 s contre 85 ms au repos). Pas propre à Tars, non remonté à Electron.
- Un CLI lancé **à la main** dans le PowerShell d'attente d'un agent n'est pas vu comme « CLI en cours » : ConPTY ne donne pas le processus au premier plan (`pty.process` renvoie le nom du terminal). Tars refuse de remplacer ce terminal si une session s'y est enregistrée (Claude, via le hook SessionStart) ; un CLI qui n'enregistre pas de session (codex, gemini) lancé à la main n'est pas détectable et meurt avec le shell si l'agent est démarré depuis Tars (lot `win/agent-launch`).
- Transcript Claude : si la dernière réponse de l'assistant est à plus de 8 Mo de la fin du fichier, le hook Stop/SessionEnd ne la poste pas (lecture bornée ; idle et agent-stopped restent postés).

### Comportements connus (voulus, pas des bugs)

- Un agent créé sans tâche ouvre un shell au repos (l'invite PowerShell sous Windows) ; Claude ne démarre qu'au clic sur Start. C'est le comportement de l'upstream, identique sur macOS : la création ne lance l'agent que si un prompt a été donné (`src/app/agents/page.tsx:150-153`, `src/app/projects/page.tsx:319-323`). Observé par Nicolas le 2026-09-28.

## 4. Checklist manuelle (ce que l'E2E ne couvre pas)

Passée en entier le 2026-09-28 par Nicolas sur sa machine : vrai installeur `v1.9.0-win.1`, vrai agent Claude,
tray, fermer vers le tray, deuxième lancement, notification, raccourcis, sélecteur de shell, « ouvrir dans un
terminal », pages Brain, Usage et Review, mise à jour auto de win.1 vers win.2, quitter, bots, désinstallation.
Son verdict : « tout à l'air de marcher ».

- [x] Bot Telegram : `/start_agent` lance l'agent, la réponse revient (Nicolas, 2026-09-28)
- [x] Bot Slack : idem (Nicolas, 2026-09-28)
- [x] Bot Discord : idem (Nicolas, 2026-09-28)
- [x] Tray : icône nette à 100 et 150 %, panneau au-dessus de la barre des tâches, clic droit (Nicolas, 2026-09-28)
- [x] Notification Windows (toast) en dev et packagé (Nicolas, 2026-09-28, sur l'app packagée)
- [x] Fermer la fenêtre : les agents continuent, le tray rouvre (Nicolas, 2026-09-28)
- [x] Deuxième lancement : focalise la première instance (Nicolas, 2026-09-28)
- [x] Installeur NSIS : install, lancement depuis le menu Démarrer, désinstallation propre (Nicolas, 2026-09-28)
- [x] Mise à jour auto : 1.x.0 vers 1.x.1 depuis le fork (Nicolas, 2026-09-28)
- [x] Ouvrir dans un terminal : Windows Terminal s'ouvre dans le bon dossier (Nicolas, 2026-09-28)

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

## 5bis. Reprise (état au 2026-09-28)

**Fait.** Phases 0 à 5 mergées dans `windows` (tête 89e7bf38), puis les lots de robustesse du journal (§6).
`CI - Windows` verte sur windows-latest à 89e7bf38 (unit + E2E, 119 surfaces, run 36320171886, tentative 2),
`CI - Tests` verte sur ubuntu au même commit. Releases publiées sur `Nexarion434/Tars` : `v1.9.0-win.1`
(2026-09-26, depuis 389e9e04, run 36267386561) et `v1.9.0-win.2` (2026-09-27, depuis 89e7bf38, run 36328847825),
`latest.yml` vérifié pour les deux. Checklist manuelle §4 passée en entier par Nicolas le 2026-09-28, mise à
jour auto win.1 vers win.2 comprise. Fork configuré (branche par défaut `windows`, Issues, `SYNC_TOKEN`,
synchro quotidienne D13).

**Ouvert.**
- D10 : textes propres à mac, en attente de la relecture de Nicolas (`PROPOSALS.md`) ; aucun texte modifié d'ici là.
- Upstream (phase 6) : PR JeanBrasse/Tars #216, #217 et #218 ouvertes, en attente de Noah. Deux autres
  préparées en local, non ouvertes : `up/file-id-bigint` et `up/discord-bot-test-wait` (go de Nicolas requis).
- Un brouillon d'avis de sécurité privé attend le go de Nicolas ; rien n'est publié sans lui.
- Matrice (§2), lignes encore partielles : 9 (envoi programmatique de 5 Ko multi-ligne à un CLI vivant sous
  ConPTY, sans spec), 12 (aucun vrai CLI Gemini lancé), 15 (aucune vraie installation de skill ou de plugin),
  24 (I-01 Hermes Desktop, I-02 `tailscale.exe`, I-03 jeton Tasmania : non portés), 31 (textes mac, D10).
  Ligne 38 : aucune machine macOS n'a rien lancé.

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
| 2026-09-26 | CI Windows stabilisée : les surfaces d'historique de panneau attendent le terminal de chaque panneau vivant avant la capture, le faux installeur claude réessaie ses opérations de fichiers quand Windows garde le lanceur ouvert | `win/flaky-panel-history` | 2 runs CI verts (36257247678, 36258784927) | APPROVE | e02a63a4 |
| 2026-09-26 | API locale : garde une connexion inactive 60 s au lieu de 6 s (course keep-alive qui donnait ECONNRESET sur la délégation ACP) ; 8/30 resets avant, 0/40 après | `win/acp-econnreset` | test keep-alive + spec ACP 15/15 | APPROVE | 22a6947d |
| 2026-09-26 | Suppressions de fichiers sous Windows : réessai borné à 1 s sur un fichier tenu (cli-updater, memory, status line, pièces jointes du vault) ; un échec de nettoyage ne remplace plus le résultat d'une mise à jour CLI | `win/file-retry` | vrais handles, 8 mutants tués | APPROVE | ec79a885 |
| 2026-09-26 | Sécurité : les gardes de chemin Telegram et vault comparent les ids de fichier en bigint (au-delà de 2^53 deux fichiers NTFS voisins semblaient identiques : refus à tort, et contrôle « dans le home » contournable) | `win/tg-hardlink-flake` | 0/5000 après, 2 mutants tués, balayage du repo sans autre site | APPROVE | da99d90f |
| 2026-09-26 | Status line Node : le verrou de token-stats.json n'est libéré qu'une fois (la libération à la sortie supprimait le verrou d'un autre rendu et faisait perdre une session) | `win/statusline-race` | 0/250 tours après, test 9 rouge 10/10 sur l'ancien code | APPROVE | 4fcc52ab |
| 2026-09-26 | Première release publiée : `v1.9.0-win.1` (installeur NSIS non signé 127 Mo, zip, `latest.yml` vérifié), construite par `release-windows.yml` depuis `windows` 389e9e04 | release | run 36267386561 | accord de Nicolas (« publie ») | 389e9e04 |
| 2026-09-26 | E2E agent-launch : les deux attentes de l'invite PowerShell échouent tout de suite si le terminal est mort et laissent 90 s à un shell vivant (démarrage à froid mesuré 9 à 17 s sous charge), avec l'état et l'écran dans le message | `win/agent-launch-prompt` | 10/10 solo, 3/3 après ACP, 4 mutants | APPROVE | 80336b41 |
| 2026-09-26 | Test du bot Discord : chaque message attend le nombre de réponses qui lui sont dues au lieu d'un délai fixe de 450 ms, et chaque test a son propre journal (une réponse en retard du démarrage à froid tombait dans le test suivant) | `win/discord-bot-flake` | 50/50 sous charge, mutant 400 ms reproduit la CI | APPROVE | d196d6ca |
| 2026-09-27 | Test keep-alive de l'API : reprend un autre port quand un autre worker a pris celui qu'il avait choisi (course de port qui faisait échouer tout le fichier), setup à 60 s pour l'import à froid | `win/keep-alive-test-port` | squatter : ancien 3/3 rouge, nouveau 3/3 vert ; 24/24 | APPROVE | c74fd563 |
| 2026-09-27 | Sécurité : les gardes de fichiers (fs:read/write-text-file, fs:read-project-files, local-file://, /api/local-file) jugent la vraie cible, liens suivis ; un lien sous ~/.dorothy vers le home n'ouvre plus ~/.ssh ni ~/.tars-private ; exception étroite pour un markdown relié à des dotfiles (canaux renderer seulement) ; /api/local-file refuse aussi une pièce jointe à liens physiques | `win/fs-realpath` | 14 mutants rouges, clé servie en 200 avant, refusée après | APPROVE (2 tours) | 43d44a71 |
| 2026-09-27 | E2E : l'en-tête Windows est mesuré une fois ses règles de déplacement appliquées, et l'écran de démarrage attend l'hydratation puis tient à son propre plafond (délais fixes remplacés par de vrais signaux) | `win/d5-caption-wait` | 3 + 2 mutants | APPROVE | 0df2851d |
| 2026-09-27 | Quitter sous Windows : la fin des terminaux ConPTY faisait courir le thread de sortie de node-pty contre l'arrêt de Node (processus bloqué après exit, ou plantage 0xC0000409 avec profil tenu) ; le quit attend au plus 5 s la fin de chaque terminal, et les notifications de statut s'arrêtent au début du quit | `win/quit-hang` | 10/10 quits propres en ~150 ms (avant : 7 blocages, 3 plantages) ; E2E quit-time | APPROVE (2 tours) | 18478a91 |
| 2026-09-27 | Test de `release.test.ts` : les trois describes qui lancent le script reçoivent le délai de 30 s que le fichier donne déjà à ses autres lancements (sur le runner chargé, la vérification du checkout propre dépassait les 5 s par défaut de vitest) | `windows` | CI Windows verte, run 36320171886 (tentative 2) ; CI ubuntu verte | n/a | 89e7bf38 |
| 2026-09-27 | Deuxième release publiée : `v1.9.0-win.2` (installeur NSIS, zip, `latest.yml` vérifié), construite par `release-windows.yml` depuis `windows` 89e7bf38 ; mise à jour auto depuis win.1 vérifiée par Nicolas le 2026-09-28 | release | run 36328847825 | accord de Nicolas | 89e7bf38 |
