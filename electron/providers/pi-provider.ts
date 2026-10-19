import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { AppSettings } from '../types';
import { keyEnvFor } from '../services/cli-keys';
import type {
  CLIProvider,
  InteractiveCommandParams,
  OneShotCommandParams,
  ProviderModel,
  HookConfig,
} from './cli-provider';

export class PiProvider implements CLIProvider {
  readonly id = 'pi' as const;
  readonly displayName = 'Pi Terminal';
  readonly binaryName = 'pi';
  readonly configDir = path.join(os.homedir(), '.pi');

  getModels(): ProviderModel[] {
    return [
      { id: 'default', name: 'Default', description: 'Use configured model' },
      { id: 'anthropic/claude-sonnet-4-20250514', name: 'Claude Sonnet', description: 'Anthropic' },
      { id: 'anthropic/claude-opus-4-20250514', name: 'Claude Opus', description: 'Anthropic' },
      { id: 'openai/gpt-4o', name: 'GPT-4o', description: 'OpenAI' },
      { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Google' },
    ];
  }

  resolveBinaryPath(appSettings: AppSettings): string {
    return appSettings.cliPaths?.pi || 'pi';
  }

  buildInteractiveCommand(params: InteractiveCommandParams): string {
    let command = `'${params.binaryPath.replace(/'/g, "'\\''")}'`;

    // For interactive PTY sessions, launch the TUI (no subcommand).
    if (params.model && params.model !== 'default') {
      if (!/^[a-zA-Z0-9._:\/-]+$/.test(params.model)) {
        throw new Error('Invalid model name');
      }
      command += ` --model '${params.model}'`;
    }

    // A delegated task arrives as params.prompt. Dropping it launched a bare
    // TUI and reported success while the task went nowhere.
    // No task, no prompt: the skills line alone was a turn nobody asked for.
    let finalPrompt = params.prompt?.trim() ? params.prompt : '';
    if (finalPrompt && params.skills && params.skills.length > 0 && !params.isSuperAgent) {
      finalPrompt = `[IMPORTANT: Use these skills for this session: ${params.skills.join(', ')}. Invoke them with /<skill-name> when relevant to the task.] ${params.prompt}`;
    }
    if (finalPrompt) {
      command += ` '${finalPrompt.replace(/'/g, "'\\''")}'`;
    }

    return command;
  }

  buildOneShotCommand(params: OneShotCommandParams): string {
    let command = `'${params.binaryPath.replace(/'/g, "'\\''")}'`;

    command += ' -p';

    if (params.model) {
      command += ` --model ${params.model}`;
    }

    const escaped = params.prompt.replace(/'/g, "'\\''");
    command += ` '${escaped}'`;

    return command;
  }

  getPtyEnvVars(agentId: string, projectPath: string, skills: string[] | undefined, appSettings?: AppSettings): Record<string, string> {
    return {
      DOROTHY_SKILLS: (skills ?? []).join(','),
      DOROTHY_AGENT_ID: agentId,
      DOROTHY_PROJECT_PATH: projectPath,
      // The orchestrator MCP and the hooks both read the CLAUDE_ names. Without
      // them the agent has no identity, so whoami fails and list_agents falls
      // back to every project's agents instead of its own.
      CLAUDE_AGENT_ID: agentId,
      CLAUDE_PROJECT_PATH: projectPath,
      CLAUDE_PROVIDER: this.id,
      // Its API key from Settings, under the variable it reads (services/cli-keys.ts).
      ...keyEnvFor('pi', appSettings),
    };
  }

  getEnvVarsToDelete(): string[] {
    return [];
  }

  getHookConfig(): HookConfig {
    return {
      supportsNativeHooks: false,
      configDir: this.configDir,
      settingsFile: path.join(this.configDir, 'config.json'),
    };
  }

  async configureHooks(_hooksDir: string): Promise<void> {
    // Pi uses extensions for hooks, no native hook configuration needed
    console.log('Pi Terminal: hooks configured via extensions, skipping native hook setup');
  }

  getMcpConfigStrategy(): 'flag' | 'config-file' {
    return 'config-file';
  }

  async registerMcpServer(name: string, command: string, args: string[]): Promise<void> {
    // Pi doesn't have built-in MCP support; it uses extensions instead.
    // We can try writing to a config file if Pi supports it in the future.
    const configPath = path.join(this.configDir, 'config.json');

    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }

    let config: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      } catch {
        // Ignore parse errors
      }
    }

    if (!config.mcpServers || typeof config.mcpServers !== 'object') {
      config.mcpServers = {};
    }

    (config.mcpServers as Record<string, unknown>)[name] = { command, args };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log(`[pi] Registered MCP server ${name} in config.json`);
  }

  async removeMcpServer(name: string): Promise<void> {
    const configPath = path.join(this.configDir, 'config.json');
    if (!fs.existsSync(configPath)) return;

    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.mcpServers && typeof config.mcpServers === 'object') {
        delete config.mcpServers[name];
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log(`[pi] Removed MCP server ${name} from config.json`);
      }
    } catch {
      // Ignore errors
    }
  }

  isMcpServerRegistered(name: string, expectedServerPath: string): boolean {
    const configPath = path.join(this.configDir, 'config.json');
    if (!fs.existsSync(configPath)) return false;
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (!config.mcpServers?.[name]) return false;
      // The path as JSON writes it too: a Windows path has every backslash
      // doubled there, never matched, and was registered again at every launch.
      const entry = JSON.stringify(config.mcpServers[name]);
      return entry.includes(expectedServerPath) || entry.includes(JSON.stringify(expectedServerPath).slice(1, -1));
    } catch {
      return false;
    }
  }

  getSkillDirectories(): string[] {
    // Pi uses extensions/packages rather than skills directories
    return [path.join(os.homedir(), '.pi', 'packages')];
  }

  getInstalledSkills(): string[] {
    const skills: string[] = [];
    for (const dir of this.getSkillDirectories()) {
      if (fs.existsSync(dir)) {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() || entry.isSymbolicLink()) {
              skills.push(entry.name);
            }
          }
        } catch {
          // Ignore read errors
        }
      }
    }
    return skills;
  }

  supportsSkills(): boolean {
    return false;
  }

  getMemoryBasePath(): string {
    return this.configDir;
  }

  getAddDirFlag(): string {
    return '';
  }
}
