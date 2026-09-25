# Tars pour Windows : Ã©tat du portage

Source de vÃ©ritÃ© du portage Windows natif (pas WSL) sur la branche `windows` du fork
`Nexarion434/Tars`. Base upstream : `JeanBrasse/Tars` `ca2bef37` (1.9.0).
Mission et rÃ¨gles : `CLAUDE.local.md` (local), `.claude/win-port/CONVENTIONS.md`, `.claude/agents/win-*.md`.

DÃ©tail des constats (fichier:ligne, preuves, sources) : `.claude/win-port/audit-a.md` (lancement des
agents, hooks, PTY, ACP) et `.claude/win-port/audit-b.md` (tout le reste). Dans ce document, `A12`
renvoie au constat 12 de l'audit A, `B/N-03` au constat N-03 de l'audit B.

Statuts : **KO** cassÃ© (vÃ©rifiÃ©), **?** non testÃ©, **OK** vÃ©rifiÃ© avec la preuve indiquÃ©e.

---

## 1. Phase 0 : baseline (2026-09-25, Windows 11 26200 x64, Node 22.23.3)

LancÃ© par `win-build` avec `HOME`, `USERPROFILE`, `APPDATA` et `LOCALAPPDATA` redirigÃ©s vers un dossier
jetable. Le vrai profil a Ã©tÃ© vÃ©rifiÃ© intact aprÃ¨s coup (8 fichiers de `~/.dorothy` identiques Ã 
l'empreinte, hash de `~/.claude/settings.json` inchangÃ©).

| VÃ©rification | Statut | Chiffres / cause |
|---|---|---|
| `npm ci` | **KO** | exit 1 : npm force `node-gyp rebuild` sur better-sqlite3 (prÃ©sence de `binding.gyp`) et node-gyp exige Visual Studio. `npm ci --ignore-scripts` + `npm rebuild node-pty unrs-resolver electron-winstaller` : 875 paquets, exit 0 |
| Binaire Electron | OK | `npx install-electron` : 44.4.4 |
| `@electron/rebuild` | KO, inutile | Â« Could not find any Visual Studio installation Â» |
| Modules natifs dans Electron 44 | **OK** | prebuilds Windows : better-sqlite3 ouvre une base en mÃ©moire, node-pty exÃ©cute `cmd.exe /c echo ok` et lit `ok` |
| 7 serveurs MCP | OK | 7/7 install + build, aucun lockfile modifiÃ© |
| `npx tsc --noEmit` | OK | 0 erreur |
| `npx tsc -p electron/tsconfig.json` | OK | 0 erreur |
| `npm test` | **KO** | 250 fichiers : 123 KO / 127 OK ; 2605 tests : 573 KO, 1932 OK, 100 ignorÃ©s. 463 des 573 viennent de la garde de `home-isolation.ts` (elle protÃ¨ge `C:\Users\nicol`, qui contient `%TEMP%`) |
| `npm test`, garde adaptÃ©e Ã  Windows (diagnostic) | KO | 249 fichiers : 68 KO / 181 OK ; 458 tests KO, 2991 OK. `hook-registration.test.ts` bloque indÃ©finiment |
| `npm run lint` | OK | 0 erreur, 132 avertissements |
| `npm run lint:design` | KO tel quel | `bash` = WSL sans distribution. Via Git Bash : 228 fichiers lus, 6/6 contrÃ´les verts |
| `npm run e2e:guard` | OK | pages OK, overlays 3 sur 14 |
| `npm run electron:dev` | **KO** | `'NODE_ENV' n'est pas reconnu` |
| App lancÃ©e Ã  la main (dev) | OK, dÃ©gradÃ© | fenÃªtre Â« Tars \| Agent Control Center Â» chargÃ©e, `/api/health` 200. Cadre natif + barre de menus (`hiddenInset` ignorÃ©). Hooks enregistrÃ©s en `.sh`, bundles MCP introuvables en dev |
| `npm run e2e` | **KO** | 93 tests : 11 KO, 1 OK, 1 ignorÃ©, 80 non lancÃ©s. La vÃ©rification de dossiers du fixture rejette chaque lancement : Electron rapporte `home = C:\Users\nicol` quel que soit l'environnement |

Causes des 458 Ã©checs (run diagnostic) :

| Cause | Fichiers | Tests | Nature |
|---|---|---|---|
| binaires POSIX en dur (`/bin/bash`, `/bin/sh`, `ps`, `touch`) | 14 | 160 | test non portable, bug produit derriÃ¨re |
| crÃ©ation de symlink refusÃ©e (EPERM) | 13 | 81 | environnement (mode dÃ©veloppeur) |
| le test ne redirige que `HOME` | 7 | 41 | test non portable |
| le faux `gh` est contournÃ©, le vrai `gh.exe` s'exÃ©cute | 2 | 38 | test non portable, **sÃ©curitÃ©** |
| `bash` nu = WSL | 1 | 29 | test non portable |
| encodage `C--Users-...` des dossiers de projets Claude | 5 | 27 | **bug produit** (B/H-01..H-03) |
| `split('/')` dans les messages des bots | 2 | 21 | bug produit (B/J-01) |
| sÃ©parateurs `/` et littÃ©raux POSIX dans les assertions | 4 | 16 | test non portable |
| modes POSIX (0600) | 4 | 9 | test non portable ; bug produit P1 (B/S-01) |
| jq absent | 2 | 0 | environnement |
| divers | 14 | 36 | mixte |

Constats ajoutÃ©s par la phase 0 (en plus des audits) :

| fichier:ligne | ProblÃ¨me | P | Agent |
|---|---|---|---|
| `__tests__/setup/home-isolation.ts:103,119,121` | ne redirige que `HOME` ; la garde protÃ¨ge un dossier qui contient `%TEMP%` (97 fichiers KO) | P0 | win-qa |
| `e2e/fixture.mjs:561`, `:574-592` | l'app dÃ©marre sur le `USERPROFILE` du parent avant la vÃ©rification ; `getPath('home')` d'Electron ne suit pas l'environnement | P0 | win-qa |
| `__tests__/scripts/fake-gh.ts`, `release.test.ts`, `prune-releases.test.ts` | le vrai `gh.exe` s'exÃ©cute au lieu du faux (avec la session GitHub de l'utilisateur si `APPDATA` n'est pas isolÃ©) | P0 | win-qa |
| `__tests__/hooks/hook-registration.test.ts:117,140` | `spawn('/bin/bash')` n'attend que `exit` : blocage infini | P0 | win-qa |
| 45 fichiers de tests + `e2e/chat-rooms.spec.ts:37`, `e2e/left-fullscreen.live.spec.ts:45` | `/tmp` en dur, Ã©crit dans `C:\tmp` | P1 | win-qa |
| `electron/services/acp/client.ts:148,155` | `ps` introuvable : arrÃªter ou quitter une dÃ©lÃ©gation lÃ¨ve ENOENT | P0 | win-process |
| pont OpenAI | prend le port API + 1 : un bac Ã  sable sur 31497 prend 31498, le port de l'E2E | P2 | win-build |
| `mcp-orchestrator.ts` en dev | bundles cherchÃ©s dans les ressources d'Electron (sans doute pareil sur mac, Ã  confirmer) | P2 | win-build |
| `api-token` | hÃ©rite d'ACL larges (dont `CodexSandboxUsers`) : aucun Ã©quivalent de 0600 | P1 | win-platform |

Logs complets : dossier scratchpad de la session du 2026-09-25 (`phase0/`), non versionnÃ©s.

---

## 2. Matrice de paritÃ©

| # | FonctionnalitÃ© | Statut | Constats | Agent | Preuve attendue |
|---|---|---|---|---|---|
| 1 | Installation (`npm ci`, modules natifs, 7 MCP) | voir Â§1 | B/B-02 | win-build | `npm ci` exit 0, node-pty + better-sqlite3 chargÃ©s dans Electron 44 |
| 2 | Compilation (`tsc` x2) | voir Â§1 | | win-build | les deux `tsc` exit 0 |
| 3 | `npm test` | voir Â§1 | B/T-01..T-03 | win-qa | vert, isolÃ© du vrai profil |
| 4 | `lint`, `lint:design`, `e2e:guard` | voir Â§1 | B/P-05 | win-build | exit 0 depuis PowerShell |
| 5 | DÃ©marrage dev (`electron:dev`) | KO | B/B-01 | win-build | la fenÃªtre s'ouvre depuis PowerShell |
| 6 | CrÃ©er un agent (UI) | KO | B/A-01, A1 | win-process + win-platform | E2E : PTY crÃ©Ã©, carte au repos |
| 7 | Lancer un agent (UI, API, bots, restauration) | KO | A1, A3, A4, B/A-02, B/A-04 | win-providers + win-platform | E2E : le faux CLI reÃ§oit l'argv exact |
| 8 | Trouver les CLIs (npm `.cmd`, `claude.exe` natif, PATHEXT) | KO | A5, A16, A17, B/C-01..C-03 | win-platform | unit : rÃ©solution `.exe` / shim `.cmd` vers `node <script>` |
| 9 | Envoi de messages dans un CLI lancÃ© (bracketed paste, ConPTY) | ? | A23, A6 | win-process | spec : 5 Ko multi-ligne arrive en un tour, 10/10 |
| 10 | Â« Le CLI tourne-t-il ? Â» (bots, dispatch, agent:get) | KO | A6 | win-process | unit + E2E dÃ©marrage via le chemin Telegram |
| 11 | Hooks Claude (statut, session, mÃ©moire) | KO | A7, A8, A9, A14 | win-hooks | E2E : SessionStart enregistrÃ©, statuts reÃ§us |
| 12 | Hooks Gemini | KO | A10, A11, A13 ; A12 (bug upstream) | win-hooks | E2E : AfterAgent poste le statut avec le jeton |
| 13 | Statusline et chiffres d'Usage qui en dÃ©pendent | KO | A15 | win-hooks | E2E : `token-stats.json` Ã©crit |
| 14 | Terminal rapide, Projects > Terminal | KO | A2, B/A-05 | win-platform + win-process | E2E : invite de shell affichÃ©e |
| 15 | Installation de skills / plugins | KO | A25, B/A-06, B/A-07 | win-process | E2E ou manuel en bac Ã  sable |
| 16 | DÃ©lÃ©gation ACP (retour de rÃ©sultat) | KO | A20, A21 | win-process | E2E : dÃ©lÃ©gation Ã  un faux agent ACP, stop reason reÃ§u, aucun process orphelin |
| 17 | Fermeture d'un terminal sans dialogue d'erreur | KO | A22 | win-process | spec : 20 kills, aucune erreur non gÃ©rÃ©e |
| 18 | 7 serveurs MCP (build + enregistrement) | build OK, enregistrement ? | A18, A19, B/M-01, B/M-02 | win-platform + win-providers | 7 builds exit 0 ; `config.toml` Codex valide |
| 19 | Mise Ã  jour auto des CLIs | KO (silencieux) | A28 | win-process | dÃ©cision : porter ou dÃ©sactiver sous Windows |
| 20 | Worktrees | ? (garde saine) | B/W-01..W-03 | win-platform | unit : noms de pÃ©riphÃ©riques refusÃ©s, chemins `\` |
| 21 | Review git | ? (argv, a priori OK) | B/R-01, B/U-02 | win-shell-ui | E2E surface review |
| 22 | Usage | ? (a priori OK) | B/G-01, A15 | win-qa | E2E surface usage |
| 23 | Memory, Projects, reprise de session (`~/.claude/projects`) | KO | B/H-01..H-05 | win-platform | unit encodage `C--Users-...` ; E2E Projects |
| 24 | Hermes, Tailscale, Tasmania | ? | B/I-01..I-03 | win-platform | unit emplacements par plateforme |
| 25 | Bots Telegram / Slack / Discord | KO (lancement) | B/A-04, B/J-01 | win-providers | checklist manuelle Â§4 |
| 26 | Tray (icÃ´ne, panneau, menu) | KO | B/K-01..K-04 | win-shell-ui (visuel) | capture validÃ©e par Nicolas |
| 27 | Ouvrir dans un terminal | KO | B/L-01 | win-platform | unit win32 : `wt.exe -d`, puis PowerShell, puis cmd |
| 28 | FenÃªtre, barre de titre, dÃ©placement | KO | B/N-01, B/N-02 | win-shell-ui (visuel) | capture validÃ©e par Nicolas |
| 29 | Cycle de vie (fermer, instance unique, notifications) | KO | B/N-03..N-05 | win-shell-ui | manuel : fermer la fenÃªtre ne tue pas les agents |
| 30 | Raccourcis clavier (Ctrl+W/R/chiffres) | ? | B/N-07..N-09 | win-shell-ui | E2E touche Ctrl+chiffre : une seule action |
| 31 | Textes et chemins affichÃ©s (noms de projets, `~`, copies Mac) | KO | B/U-01..U-08 | win-shell-ui | E2E surfaces avec chemins Windows |
| 32 | Secrets (modes POSIX sans effet, Ã©critures atomiques) | KO | B/S-01, B/S-02 | win-platform | stress test rename ; SECURITY.md documentÃ© |
| 33 | Packaging NSIS + `.ico` | KO | B/P-01..P-03 | win-build | install / dÃ©sinstall / mise Ã  jour sur cette machine |
| 34 | Auto-update depuis le fork | KO | B/P-09, B/P-10 | win-build | 1.x.0 packagÃ©e se met Ã  jour vers 1.x.1 |
| 35 | Bac Ã  sable (`npm run sandbox`) | KO | B/P-04 | win-build | lance `win-unpacked` sur 31499, USERPROFILE isolÃ© |
| 36 | E2E (38 surfaces, rÃ©fÃ©rences Windows dÃ©diÃ©es) | KO | B/E-01..E-07 | win-qa | 38/38, `__screenshots__/win32/` |
| 37 | CI `windows-latest` | KO | B/P-11 | win-build | job vert sur PR vers `windows` |
| 38 | ZÃ©ro rÃ©gression macOS / Linux | ? | | win-reviewer | CI ubuntu verte, diffs darwin/linux prouvÃ©s identiques |

## 3. SÃ©curitÃ© (prioritÃ© dans chaque lot)

| Constat | Risque | Lot |
|---|---|---|
| A4 | Un saut de ligne dans un prompt tapÃ© dans PowerShell exÃ©cute la suite comme une commande (prouvÃ©) | lancement direct, sans shell (dÃ©cision 2) |
| B/N-06 | Chemin du son de notification interpolÃ© dans du code PowerShell ; modifiable par tout agent via `app-settings.json` | plateforme |
| B/M-03 | Garde d'envoi de fichiers Telegram : ne bloque pas `%APPDATA%` / `%LOCALAPPDATA%` | plateforme |
| B/T-01, B/E-01 | Tests et E2E Ã©crivent dans le vrai profil tant que `USERPROFILE` n'est pas redirigÃ© | harnais (premier lot) |
| B/S-01 | Modes 0600/0700 sans effet : ne pas le prÃ©tendre dans SECURITY.md | plateforme (doc) |
| A26, A27 | Quoting de ligne de commande Windows (guillemets, `\n`, `%`, limite 8191 de cmd) | plateforme |

Bugs prÃ©existants hors Windows, Ã  remonter plus tard (jamais sans l'accord de Nicolas) : A12 (Gemini
supprime le jeton des hooks, `UserPromptSubmit` n'existe pas chez Gemini), A29 (20 gÃ©nÃ©rateurs de
scripts bash morts, injection latente), B/Â§4 `git-review.ts:318-331` (lecture hors dÃ©pÃ´t d'un fichier
Â« untracked Â»), `/api/local-file` suit un lien plantÃ© dans `vault/attachments`.

## 4. Checklist manuelle (ce que l'E2E ne couvre pas)

- [ ] Bot Telegram : `/start_agent` lance l'agent, la rÃ©ponse revient
- [ ] Bot Slack : idem
- [ ] Bot Discord : idem
- [ ] Tray : icÃ´ne nette Ã  100 et 150 %, panneau au-dessus de la barre des tÃ¢ches, clic droit
- [ ] Notification Windows (toast) en dev et packagÃ©
- [ ] Fermer la fenÃªtre : les agents continuent, le tray rouvre
- [ ] DeuxiÃ¨me lancement : focalise la premiÃ¨re instance
- [ ] Installeur NSIS : install, lancement depuis le menu DÃ©marrer, dÃ©sinstallation propre
- [ ] Mise Ã  jour auto : 1.x.0 vers 1.x.1 depuis le fork
- [ ] Ouvrir dans un terminal : Windows Terminal s'ouvre dans le bon dossier

## 5. DÃ©cisions d'architecture

| # | Sujet | DÃ©cision | Date | ValidÃ©e par |
|---|---|---|---|---|
| D1 | Hooks | en attente | | |
| D2 | Lancement des providers | en attente | | |
| D3 | Shell par dÃ©faut | en attente | | |

## 6. Journal des lots

| Date | Lot | Branche | QA | Review | Merge |
|---|---|---|---|---|---|
| 2026-09-25 | Phase 0 + 1 : baseline, audit, roster | `windows` | n/a | n/a | commit local |
