# Tars pour Windows : état du portage

Source de vérité du portage Windows natif (pas WSL) sur la branche `windows` du fork
`Nexarion434/Tars`. Base upstream : `JeanBrasse/Tars` `ca2bef37` (1.9.0).
Mission et règles : `CLAUDE.local.md` (local), `.claude/win-port/CONVENTIONS.md`, `.claude/agents/win-*.md`.

Détail des constats (fichier:ligne, preuves, sources) : `.claude/win-port/audit-a.md` (lancement des
agents, hooks, PTY, ACP) et `.claude/win-port/audit-b.md` (tout le reste). Dans ce document, `A12`
renvoie au constat 12 de l'audit A, `B/N-03` au constat N-03 de l'audit B.

Statuts : **KO** cassé (vérifié), **?** non testé, **OK** vérifié avec la preuve indiquée.

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
| 3 | `npm test` | KO (307 / 3733, était 573 / 2605) | B/T-01..T-03 | win-qa | vert, isolé du vrai profil |
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
| 17 | Fermeture d'un terminal sans dialogue d'erreur | KO | A22 | win-process | spec : 20 kills, aucune erreur non gérée |
| 18 | 7 serveurs MCP (build + enregistrement) | build OK, enregistrement ? | A18, A19, B/M-01, B/M-02 | win-platform + win-providers | 7 builds exit 0 ; `config.toml` Codex valide |
| 19 | Mise à jour auto des CLIs | KO (silencieux) | A28 | win-process | décision : porter ou désactiver sous Windows |
| 20 | Worktrees | ? (garde saine) | B/W-01..W-03 | win-platform | unit : noms de périphériques refusés, chemins `\` |
| 21 | Review git | ? (argv, a priori OK) | B/R-01, B/U-02 | win-shell-ui | E2E surface review |
| 22 | Usage | ? (a priori OK) | B/G-01, A15 | win-qa | E2E surface usage |
| 23 | Memory, Projects, reprise de session (`~/.claude/projects`) | KO | B/H-01..H-05 | win-platform | unit encodage `C--Users-...` ; E2E Projects |
| 24 | Hermes, Tailscale, Tasmania | ? | B/I-01..I-03 | win-platform | unit emplacements par plateforme |
| 25 | Bots Telegram / Slack / Discord | KO (lancement) | B/A-04, B/J-01 | win-providers | checklist manuelle §4 |
| 26 | Tray (icône, panneau, menu) | KO | B/K-01..K-04 | win-shell-ui (visuel) | capture validée par Nicolas |
| 27 | Ouvrir dans un terminal | KO | B/L-01 | win-platform | unit win32 : `wt.exe -d`, puis PowerShell, puis cmd |
| 28 | Fenêtre, barre de titre, déplacement | KO | B/N-01, B/N-02 | win-shell-ui (visuel) | capture validée par Nicolas |
| 29 | Cycle de vie (fermer, instance unique, notifications) | KO | B/N-03..N-05 | win-shell-ui | manuel : fermer la fenêtre ne tue pas les agents |
| 30 | Raccourcis clavier (Ctrl+W/R/chiffres) | ? | B/N-07..N-09 | win-shell-ui | E2E touche Ctrl+chiffre : une seule action |
| 31 | Textes et chemins affichés (noms de projets, `~`, copies Mac) | KO | B/U-01..U-08 | win-shell-ui | E2E surfaces avec chemins Windows |
| 32 | Secrets (modes POSIX sans effet, écritures atomiques) | KO | B/S-01, B/S-02 | win-platform | stress test rename ; SECURITY.md documenté |
| 33 | Packaging NSIS + `.ico` | KO | B/P-01..P-03 | win-build | install / désinstall / mise à jour sur cette machine |
| 34 | Auto-update depuis le fork | KO | B/P-09, B/P-10 | win-build | 1.x.0 packagée se met à jour vers 1.x.1 |
| 35 | Bac à sable (`npm run sandbox`) | KO | B/P-04 | win-build | lance `win-unpacked` sur 31499, USERPROFILE isolé |
| 36 | E2E (38 surfaces, références Windows dédiées) | KO (44 OK / 10 KO / 44 non lancés ; bloqué au lancement des agents) | B/E-01..E-07 | win-qa | 38/38, `__screenshots__/win32/` |
| 37 | CI `windows-latest` | KO | B/P-11 | win-build | job vert sur PR vers `windows` |
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

- Un CLI lancé **à la main** dans le PowerShell d'attente d'un agent n'est pas vu comme « CLI en cours » : ConPTY ne donne pas le processus au premier plan (`pty.process` renvoie le nom du terminal). Tars ne tue pas ce terminal s'il porte une session active (lot `win/agent-launch`).
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
| D4 | Environnement de dev | VS Build Tools C++ installés (`npm ci` tel quel). Mode développeur **non** activé : les tests qui créent des symlinks sont sautés sous Windows sans privilège, avec la raison affichée, et tournent en CI `windows-latest` | 2026-09-25 | Nicolas |

## 5bis. Reprise (état au 2026-09-25 soir)

Phase 3 en cours. Branches de lot locales (worktrees sous `.claude/worktrees/`, non poussées) :

| Branche | Contenu | État |
|---|---|---|
| `win/hooks-node` | hooks Node D1 (tars-hook.mjs, statusline.mjs, câblage win32 Claude/Gemini) | APPROVE, prête à intégrer (df7923f4) |
| `win/cli-invocation` | appels CLI hors PTY (MCP add/remove, codex TOML, kanban argv, détection CLI, gws), `--` claude/gemini, `mcpEntryRuns` | 2e relecture |
| `win/paths-memory-security` | encodage dossiers projets Claude, samePath/isUnder, noms de périphériques, son de notification (sécu), garde credential stores, rename avec retry, open-terminal win32 | 1re relecture |
| `win/agent-launch` | D2/D3 : lancement direct via toLaunch, terminaux humains, installeurs, sécu A4 | corrections de relecture en cours (4 points + extractions) |
| `win/acp-delegation` | ACP (resolveAgentLaunch, killTree), cli-updater Windows, `pty-kill.ts` (non branché) | corrections de relecture en cours (5 points) |

Ordre d'intégration prévu : une branche `win/integration-p3` depuis `windows`, merge des lots approuvés, gate win-qa (tsc x2, npm test comparé test par test, lint, lint:design, e2e:guard, e2e), puis fast-forward de `windows` et push. Conflits attendus : `claude-provider.ts` / `gemini-provider.ts` (imports, hooks-node vs cli-invocation), `ipc-handlers.ts` (agent-launch vs 2 lignes de cli-invocation).

Suivis déjà décidés (voir aussi `tasks/todo.md`, local) : brancher `killPty` aux call sites ; remplacer la regex worktrees `ipc-handlers.ts` par `isInsideWorktreesDir` ; exporter depuis `electron/platform` les copies de `cli-exec.ts` ; fixture E2E : fake CLI via shim npm `.cmd` ; `api-token`/`app-settings.json` restreints par icacls (avec preuve) ; `check:dashes` probablement muet sous Windows ; déplacer `hook-command.ts` dans `electron/platform/`.

Restent ensuite : phase 4 (références visuelles win32, CI `windows-latest`), phase 5 (NSIS, `.ico`, auto-update depuis le fork, voir `.claude/win-port/dorothy-windows.md`), décisions visuelles de Nicolas (barre de titre, tray, fermeture = masquer ou quitter, texte « Additional PATH », UI du réglage de shell), phase 6 (upstream, sur go de Nicolas).

## 6. Journal des lots

| Date | Lot | Branche | QA | Review | Merge |
|---|---|---|---|---|---|
| 2026-09-25 | Phase 0 + 1 : baseline, audit, roster | `windows` | n/a | n/a | c8d904ae |
| 2026-09-25 | Harnais de test Windows (isolation du profil, garde, faux gh, jonctions, références win32) | `win/test-harness` | gate win-qa | APPROVE (3 tours) | 8a6945e1 |
| 2026-09-25 | Primitives plateforme (shell, PATH, résolution des CLIs, tokenizer, ligne de commande Windows, toLaunch, killTree) | `win/platform-launch` | PASS (intégration) | APPROVE (2 tours) | 8bddb6c8 |
| 2026-09-25 | Scripts npm cross-platform (electron-dev, design-lint.mjs, build-renderer, npm-command) | `win/npm-scripts` | PASS (intégration) | APPROVE (2 tours) | aac7547b |
