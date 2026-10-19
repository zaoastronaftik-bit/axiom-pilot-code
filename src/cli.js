#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { LMStudioClient } from './backend.js';
import { processPrompt } from './agent.js';
import { getSessions, loadSettings, newSession, saveSession, saveSettings } from './storage.js';
import { installedVersion, installUpdate, latestVersion, versionCompare } from './updater.js';

const blue = '\x1b[96m';
const green = '\x1b[92m';
const grey = '\x1b[90m';
const reset = '\x1b[0m';
const bold = '\x1b[1m';
const interactive = stdin.isTTY && stdout.isTTY;
const color = (text, code) => interactive ? `${code}${text}${reset}` : text;

function logo(version) {
  console.log(color(`
       ╱╲   ╳  ╻  ◇  ███   ╭─╮  ╻  ╻   ╭─╮  ╭─╮  ╭─╮
      ╱──╲ ╱ ╲ ┃  │  ┃ ┃   ├─╯  │  │   │    │ │  │ │
     ╱    ╲   ╳ ╹  ◇  ╹ ╹   ╹    ╰──╯  ╹    ╰─╯  ╰─╯
`, blue));
  console.log(`${color('  AXIOM PILOT CODE', bold)}  ${color('v' + version, grey)}  ·  Local-first coding agent`);
  console.log(color('  /help  /model  /mode  /resume  /status  /update\n', grey));
}

export function parseArgs(args) {
  const result = { project: process.cwd(), help: false, version: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') result.help = true;
    else if (args[i] === '--version' || args[i] === '-v') result.version = true;
    else if (args[i] === '--project' && args[i + 1]) result.project = resolve(args[++i]);
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const version = await installedVersion();
  if (options.help) { console.log('AxiomPilotCode — local coding agent\nUsage: pilotcode [--project PATH] [--version]\nInside CLI: /help /model /mode /resume /new /status /plugins /settings /update /exit'); return; }
  if (options.version) { console.log(version); return; }
  const root = await realpath(options.project);
  const settings = await loadSettings();
  const client = new LMStudioClient(settings.baseUrl);
  const rl = createInterface({ input: stdin, output: stdout, terminal: interactive, historySize: 100 });
  let activeAbort = null;
  let session = newSession(root, settings.model, settings.mode);
  let quitting = false;

  const ask = async question => {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return ['y', 'yes', 'д', 'да'].includes(answer);
  };
  const textAnswer = async question => (await rl.question(question)).trim();
  const saveAll = async () => { await saveSession(session); await saveSettings(settings); };

  rl.on('SIGINT', () => {
    if (activeAbort) { activeAbort.abort(); console.log('\nInterrupted request.'); }
    else { quitting = true; rl.close(); }
  });

  const chooseModel = async () => {
    const models = await client.models();
    if (!models.length) { console.log('No models available. Load a model in LM Studio.'); return; }
    console.log('\nModels from LM Studio:');
    models.forEach((m, i) => console.log(`  ${i + 1}. ${m}${m === session.model ? '  [selected]' : ''}`));
    const answer = await textAnswer('Select number (Enter cancels): ');
    if (!answer) return;
    const idx = Number(answer) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= models.length) { console.log('Invalid selection.'); return; }
    session.model = settings.model = models[idx];
    await saveAll();
    console.log(`${color('✓', green)} Active model: ${session.model}`);
  };

  const changeMode = async arg => {
    const selection = (arg || await textAnswer('Mode [fast/deep]: ')).toLowerCase();
    if (!['fast', 'deep'].includes(selection)) { console.log('Choose fast or deep.'); return; }
    session.mode = settings.mode = selection;
    await saveAll();
    console.log(`${color('✓', green)} Mode: ${selection}`);
  };

  const resume = async () => {
    const sessions = (await getSessions(root)).filter(s => s.history.length).slice(0, 10);
    if (!sessions.length) { console.log('No saved sessions in this project.'); return; }
    sessions.forEach((s, i) => {
      const excerpt = s.history.find(h => h.role === 'user')?.content.replace(/\s+/g, ' ').slice(0, 55) || '(empty)';
      console.log(`  ${i + 1}. ${s.updatedAt.slice(0, 16).replace('T', ' ')} | ${s.mode} | ${excerpt}`);
    });
    const answer = await textAnswer('Resume number (Enter cancels): ');
    if (!answer) return;
    const index = Number(answer) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= sessions.length) { console.log('Invalid selection.'); return; }
    session = sessions[index];
    settings.model = session.model;
    settings.mode = session.mode;
    await saveSettings(settings);
    console.log(`Resumed ${session.id.slice(0, 8)} (${session.history.length / 2} turns).`);
  };

  const checkUpdate = async () => {
    try {
      const latest = await latestVersion();
      if (!latest) { console.log('Not published to npm yet. Updates will be available after the first release.'); return; }
      if (versionCompare(latest, version) <= 0) { console.log(`You are on the latest stable version (${version}).`); return; }
      console.log(`Update available: ${version} → ${latest}`);
      if (!await ask('Install via npm now? [y/N] ')) return;
      await saveAll();
      console.log('Installing update. Close this terminal afterward and start pilotcode again.');
      const result = installUpdate();
      if (result.error) console.log(`Update failed: ${result.error.message}`);
      else if (result.status !== 0) console.log(`npm exited with status ${result.status}. You may run: npm install -g axiom-pilot-code@latest`);
      else { console.log('Update installed. Please restart the CLI.'); quitting = true; }
    } catch (error) { console.log(`Could not check npm registry: ${error.message}`); }
  };

  try {
    logo(version);
    console.log(`Project: ${root}`);
    console.log(`Backend: ${settings.baseUrl}`);
    try {
      const models = await client.models();
      if (models.length) {
        if (!session.model || !models.includes(session.model)) {
          session.model = settings.model = models[0];
          await saveSettings(settings);
        }
        console.log(`${color('●', green)} Connected · ${models.length} model(s) · ${session.model}`);
      } else console.log('LM Studio online; no models available. Use /model after loading one.');
    } catch { console.log('○ LM Studio offline — enable Local Server, then use /model.'); }
    console.log(`Mode: ${session.mode}. Changes to files or commands need your approval.\n`);
    if (settings.autoUpdateCheck && (!settings.lastUpdateCheck || Date.now() - Date.parse(settings.lastUpdateCheck) > 86_400_000)) {
      try {
        const latest = await latestVersion(AbortSignal.timeout(1_500));
        settings.lastUpdateCheck = new Date().toISOString();
        await saveSettings(settings);
        if (latest && versionCompare(latest, version) > 0) {
          console.log(`⬆ Version ${latest} available. Run /update when ready.\n`);
        }
      } catch { /* Offline use does not require network. */ }
    }

    while (!quitting) {
      let input;
      try { input = await textAnswer(color('❯ ', blue)); }
      catch (error) { if (error.code === 'ERR_USE_AFTER_CLOSE') break; throw error; }
      if (!input) continue;
      if (input.startsWith('/')) {
        const [command, ...args] = input.slice(1).split(/\s+/);
        try {
          switch (command.toLowerCase()) {
            case 'help': console.log('\n/model  Choose LM Studio model\n/mode   fast | deep\n/new    Start new session\n/resume Continue saved session\n/status Show project and connection\n/plugins Show built-in tools\n/settings update-check on|off\n/update Check npm for updates\n/clear  Clear terminal\n/exit   Quit\n'); break;
            case 'model': await chooseModel(); break;
            case 'mode': await changeMode(args[0]); break;
            case 'new': session = newSession(root, settings.model, settings.mode); await saveSession(session); console.log('New session started.'); break;
            case 'resume': await resume(); break;
            case 'status': {
              let online = false; try { online = (await client.models()).length > 0; } catch { /* offline */ }
              console.log(`\nBackend: ${settings.baseUrl}\nLM Studio: ${online ? 'connected' : 'offline / no model'}\nModel: ${session.model || '(not selected)'}\nMode: ${session.mode}\nProject: ${root}\nSession: ${session.id}\nTurns: ${Math.floor(session.history.length / 2)}\n`);
              break;
            }
            case 'plugins': console.log('Built-in tools: list_files, read_file, write_file (approval), run_command (approval). External MCP and image generation are planned, not present in V1.'); break;
            case 'settings': {
              if (args[0] === 'update-check' && ['on', 'off'].includes(args[1])) {
                settings.autoUpdateCheck = args[1] === 'on'; await saveSettings(settings);
                console.log(`Automatic update checks: ${args[1]}`);
              } else console.log(`Update check: ${settings.autoUpdateCheck ? 'on' : 'off'}. Use /settings update-check on|off.`);
              break;
            }
            case 'update': await checkUpdate(); break;
            case 'clear': console.clear(); break;
            case 'exit': case 'quit': quitting = true; break;
            default: console.log(`Unknown command: /${command}. Type /help.`);
          }
        } catch (error) { console.error(color(`Error: ${error.message}`, '\x1b[91m')); }
        continue;
      }
      try {
        activeAbort = new AbortController();
        console.log(color('◇ Thinking / working…', grey));
        await processPrompt({ client, session, prompt: input, root, ask, signal: activeAbort.signal });
        await saveSession(session);
      } catch (error) {
        console.error(color(`Error: ${error.message}`, '\x1b[91m'));
        console.log('Tip: verify the selected model, backend connection, and context length in LM Studio.');
      } finally { activeAbort = null; }
      console.log();
    }
  } finally { rl.close(); }
}

main().catch(error => { console.error(`pilotcode: ${error.message}`); process.exitCode = 1; });
