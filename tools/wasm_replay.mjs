#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const buttons = new Set(['a', 'b', 'select', 'start', 'right', 'left', 'up', 'down', 'r', 'l']);

const defaultOutputDir = 'wasm-replay-output';

function usage() {
  console.error('usage: node tools/wasm_replay.mjs <events.txt> [output-dir] [--no-build] [--keep-browser] [--view=classic|hd2d] [--shading=0..1] [--zoom=0..1] [--perspective=0..1] [--render-scale=1|2|3|4|6|8] [--save=path/to/game.sav]');
  console.error('event frame numbers are emulated game frames, not display frames');
  console.error('events: screenshot [name], button <name> <on|off>, warp <group> <map> <x> <y>, avatar <mode>, running-shoes <on|off>, weather <0..15>, view <classic|hd2d>, gpu-loss, probe <name>');
  process.exit(2);
}

function parseArgs(argv) {
  const options = { build: true, keepBrowser: false, view: 'hd2d', shading: 0.50, zoom: 1.00, perspective: 0.50, renderScale: 4, savePath: null };
  const paths = [];
  for (const arg of argv) {
    if (arg === '--no-build') options.build = false;
    else if (arg === '--keep-browser') options.keepBrowser = true;
    else if (arg.startsWith('--view=')) {
      options.view = arg.slice('--view='.length);
      if (!['classic', 'hd2d'].includes(options.view)) usage();
    } else if (arg.startsWith('--shading=')) {
      options.shading = Number(arg.slice('--shading='.length));
      if (!Number.isFinite(options.shading) || options.shading < 0 || options.shading > 1) usage();
    } else if (arg.startsWith('--zoom=')) {
      options.zoom = Number(arg.slice('--zoom='.length));
      if (!Number.isFinite(options.zoom) || options.zoom < 0 || options.zoom > 1) usage();
    } else if (arg.startsWith('--perspective=')) {
      options.perspective = Number(arg.slice('--perspective='.length));
      if (!Number.isFinite(options.perspective) || options.perspective < 0 || options.perspective > 1) usage();
    } else if (arg.startsWith('--render-scale=')) {
      options.renderScale = Number(arg.slice('--render-scale='.length));
      if (![1, 2, 3, 4, 6, 8].includes(options.renderScale)) usage();
    } else if (arg.startsWith('--save=')) {
      options.savePath = resolve(arg.slice('--save='.length));
    } else paths.push(arg);
  }
  if (paths.length < 1 || paths.length > 2) usage();
  return { inputPath: resolve(paths[0]), outputDir: resolve(paths[1] || defaultOutputDir), options };
}

function parseEvents(text) {
  const events = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;

    const fields = line.split(/\s+/);
    const frame = Number(fields[0]);
    if (!Number.isInteger(frame) || frame < 0) throw new Error(`${index + 1}: frame must be a non-negative integer`);

    if (fields[1] === 'screenshot') {
      events.push({ frame, type: 'screenshot', name: fields[2] || `frame-${frame}` });
      continue;
    }

    if (fields[1] === 'view') {
      if ((fields.length !== 3 && fields.length !== 4)
          || !['classic', 'hd2d'].includes(fields[2])
          || (fields.length === 4 && fields[3] !== 'animated'))
        throw new Error(`${index + 1}: expected "<frame> view <classic|hd2d> [animated]"`);
      events.push({ frame, type: 'view', mode: fields[2], animate: fields[3] === 'animated' });
      continue;
    }

    if (fields[1] === 'weather') {
      const weather = Number(fields[2]);
      if (fields.length !== 3 || !Number.isInteger(weather) || weather < 0 || weather > 15)
        throw new Error(`${index + 1}: expected "<frame> weather <0..15>"`);
      events.push({ frame, type: 'weather', weather });
      continue;
    }

    if (fields[1] === 'avatar') {
      if (fields.length !== 3 || !['on-foot', 'mach-bike', 'acro-bike', 'surfing', 'underwater'].includes(fields[2]))
        throw new Error(`${index + 1}: expected "<frame> avatar <on-foot|mach-bike|acro-bike|surfing|underwater>"`);
      events.push({ frame, type: 'avatar', mode: fields[2] });
      continue;
    }

    if (fields[1] === 'warp') {
      const values = fields.slice(2).map(Number);
      if (values.length !== 4 || values.some((value) => !Number.isInteger(value)))
        throw new Error(`${index + 1}: expected "<frame> warp <group> <map> <x> <y>"`);
      events.push({ frame, type: 'warp', mapGroup: values[0], mapNum: values[1], x: values[2], y: values[3] });
      continue;
    }

    if (fields[1] === 'encounters') {
      if (fields.length !== 3 || !['on', 'off'].includes(fields[2]))
        throw new Error(`${index + 1}: expected "<frame> encounters <on|off>"`);
      events.push({ frame, type: 'encounters', enabled: fields[2] === 'on' });
      continue;
    }

    if (fields[1] === 'running-shoes') {
      if (fields.length !== 3 || !['on', 'off'].includes(fields[2]))
        throw new Error(`${index + 1}: expected "<frame> running-shoes <on|off>"`);
      events.push({ frame, type: 'running-shoes', enabled: fields[2] === 'on' });
      continue;
    }

    if (fields[1] === 'probe') {
      if (fields.length !== 3 || !['hblank-dma-win0h', 'trainer-id-nonzero', 'renderer-fps', 'object-descriptors', 'object-events', 'state', 'map-grid'].includes(fields[2])) {
        throw new Error(`${index + 1}: expected "<frame> probe <hblank-dma-win0h|trainer-id-nonzero|renderer-fps|object-descriptors|object-events|state|map-grid>"`);
      }
      events.push({ frame, type: 'probe', name: fields[2] });
      continue;
    }

    if (fields[1] === 'gpu-loss') {
      if (fields.length !== 2) throw new Error(`${index + 1}: expected "<frame> gpu-loss"`);
      events.push({ frame, type: 'gpu-loss' });
      continue;
    }

    if (fields[1] !== 'button' || fields.length !== 4) {
      throw new Error(`${index + 1}: expected "<frame> button <name> <on|off>", "<frame> screenshot [name]", or "<frame> probe hblank-dma-win0h"`);
    }
    const name = fields[2];
    const state = fields[3];
    if (!buttons.has(name)) throw new Error(`${index + 1}: unknown button "${name}"`);
    if (state !== 'on' && state !== 'off') throw new Error(`${index + 1}: button state must be on or off`);
    events.push({ frame, type: 'button', name, pressed: state === 'on' });
  }
  return events.sort((a, b) => a.frame - b.frame || (a.type === 'button' ? -1 : 1));
}

function run(command, args, log, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: resolve('.'), env: process.env, ...options });
    child.stdout.on('data', (chunk) => log(`${command} stdout: ${chunk}`));
    child.stderr.on('data', (chunk) => log(`${command} stderr: ${chunk}`));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
    });
  });
}

function browserPath() {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ].filter(Boolean);
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error('Chrome/Chromium not found; set CHROME_BIN to a browser executable');
  return found;
}

async function startServer(log) {
  const child = spawn('node', ['web/server.mjs'], { cwd: resolve('.'), env: { ...process.env, PORT: '0' } });
  return await new Promise((resolveStart, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for wasm web server')), 10000);
    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      log(`server stdout: ${text}`);
      const match = text.match(/http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolveStart({ child, url: `http://localhost:${match[1]}` });
      }
    });
    child.stderr.on('data', (chunk) => log(`server stderr: ${chunk}`));
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`server exited before ready with ${code}`)));
  });
}

async function startBrowser(userDataDir, log) {
  const child = spawn(browserPath(), [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--enable-unsafe-webgpu',
    'about:blank',
  ]);
  return await new Promise((resolveStart, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for Chrome DevTools')), 10000);
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      log(`browser stderr: ${text}`);
      const match = text.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolveStart({ child, browserWs: match[1] });
      }
    });
    child.stdout.on('data', (chunk) => log(`browser stdout: ${chunk}`));
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`browser exited before ready with ${code}`)));
  });
}

class Cdp {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolveReady, reject) => {
      this.socket.addEventListener('open', resolveReady, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => this.receive(JSON.parse(event.data)));
  }

  receive(message) {
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    const handler = this.handlers.get(message.method);
    if (handler) handler(message.params);
  }

  on(method, handler) {
    this.handlers.set(method, handler);
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return await new Promise((resolveSend, reject) => this.pending.set(id, { resolve: resolveSend, reject }));
  }

  close() {
    this.socket.close();
  }
}

async function newPage(browserWs) {
  const endpoint = new URL(browserWs);
  const response = await fetch(`http://${endpoint.host}/json/new`, { method: 'PUT' });
  const target = await response.json();
  return new Cdp(target.webSocketDebuggerUrl);
}

async function evaluate(cdp, expression, awaitPromise = true) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    const exception = details.exception?.description || details.exception?.value;
    const location = `${details.url || '<anonymous>'}:${details.lineNumber ?? 0}:${details.columnNumber ?? 0}`;
    throw new Error([details.text, exception, location].filter(Boolean).join('\n'));
  }
  return result.result.value;
}

function safeName(name) {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_');
}

async function saveScreenshot(cdp, outputDir, event) {
  const dataUrl = await evaluate(cdp, `window.pokeemerald.automation.screenshot()`);
  const state = await evaluate(cdp, `window.pokeemerald.automation.state()`);
  const png = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
  const file = `${String(event.frame).padStart(6, '0')}-${safeName(event.name)}.png`;
  await writeFile(resolve(outputDir, 'screenshots', file), png);
  return { file, state };
}

async function runProbe(cdp, event) {
  if (event.name === 'map-grid') {
    const result = await evaluate(cdp, `window.pokeemerald.automation.mapGrid()`);
    return { frame: event.frame, name: event.name, result };
  }
  if (event.name === 'state') {
    const result = await evaluate(cdp, `window.pokeemerald.automation.state()`);
    return { frame: event.frame, name: event.name, result };
  }
  if (event.name === 'renderer-fps') {
    const result = await evaluate(cdp, `window.pokeemerald.automation.benchmarkPresentation(120)`);
    return { frame: event.frame, name: event.name, result };
  }
  if (event.name === 'object-descriptors') {
    const result = await evaluate(cdp, `window.pokeemerald.automation.objectDescriptors()`);
    return { frame: event.frame, name: event.name, result };
  }
  if (event.name === 'object-events') {
    const result = await evaluate(cdp, `window.pokeemerald.automation.objectEvents()`);
    return { frame: event.frame, name: event.name, result };
  }
  if (event.name === 'trainer-id-nonzero') {
    const state = await evaluate(cdp, `window.pokeemerald.automation.state()`);
    if (state.trainerId === 0)
      throw new Error(`unexpected zero trainer ID at frame ${event.frame}`);
    return { frame: event.frame, name: event.name, result: state.trainerId };
  }

  const result = await evaluate(cdp, `window.pokeemerald.automation.hblankDmaWin0HProbe()`);
  const stoppedControls = { fixed: 0x0040, reload: 0x0060 };
  for (const mode of ['fixed', 'reload']) {
    const actual = result[mode];
    if (actual?.activeLine0 !== 0
        || actual.activeLine1 !== 63
        || actual.activeLine2 !== 0
        || actual.activeCached !== true
        || actual.stoppedControl !== stoppedControls[mode]
        || actual.stoppedLine0 !== 0
        || actual.stoppedLine1 !== 0
        || actual.stoppedLine2 !== 0
        || actual.stoppedCached !== false) {
      throw new Error(`unexpected ${event.name} ${mode} probe result: ${JSON.stringify(result)}`);
    }
  }
  return { frame: event.frame, name: event.name, result };
}

async function main() {
  const { inputPath, outputDir, options } = parseArgs(process.argv.slice(2));
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(resolve(outputDir, 'screenshots'), { recursive: true });
  const logLines = [];
  const errors = [];
  const log = (line) => logLines.push(String(line).trimEnd());
  const userDataDir = await mkdtemp(resolve(tmpdir(), 'pokeemerald-3d-replay-'));
  let server;
  let browser;
  let cdp;

  try {
    const events = parseEvents(await readFile(inputPath, 'utf8'));
    await writeFile(resolve(outputDir, 'events.json'), JSON.stringify(events, null, 2));
    if (options.build) await run('make', ['wasm'], log);

    server = await startServer(log);
    browser = await startBrowser(userDataDir, log);
    cdp = await newPage(browser.browserWs);
    cdp.on('Runtime.consoleAPICalled', (params) => log(`console ${params.type}: ${params.args.map((arg) => arg.value ?? arg.description).join(' ')}`));
    cdp.on('Runtime.exceptionThrown', (params) => errors.push(params.exceptionDetails.text));
    cdp.on('Log.entryAdded', (params) => log(`page ${params.entry.level}: ${params.entry.text}`));
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: `${server.url}/?automate=1&view=${options.view}&shading=${options.shading}&zoom=${options.zoom}&perspective=${options.perspective}&renderScale=${options.renderScale}` });
    await evaluate(cdp, `new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for wasm automation')), 30000);
      const check = () => {
        if (window.pokeemerald?.automation?.ready) {
          window.pokeemerald.automation.ready.then(() => {
            clearTimeout(timeout);
            resolve();
          });
        } else {
          setTimeout(check, 20);
        }
      };
      check();
    })`, true);

    if (options.savePath) {
      const save = await readFile(options.savePath);
      await evaluate(cdp, `window.pokeemerald.automation.loadSave(${JSON.stringify(save.toString('base64'))})`);
    }

    const screenshots = [];
    const probes = [];
    for (const event of events) {
      await evaluate(cdp, `window.pokeemerald.automation.runToFrame(${event.frame})`);
      if (event.type === 'button') {
        await evaluate(cdp, `window.pokeemerald.automation.setButton(${JSON.stringify(event.name)}, ${event.pressed})`);
      } else if (event.type === 'warp') {
        await evaluate(cdp, `window.pokeemerald.automation.warp(${event.mapGroup}, ${event.mapNum}, ${event.x}, ${event.y})`);
      } else if (event.type === 'avatar') {
        await evaluate(cdp, `window.pokeemerald.automation.setAvatar(${JSON.stringify(event.mode)})`);
      } else if (event.type === 'weather') {
        await evaluate(cdp, `window.pokeemerald.automation.setWeather(${event.weather})`);
      } else if (event.type === 'encounters') {
        await evaluate(cdp, `window.pokeemerald.automation.setEncounters(${event.enabled})`);
      } else if (event.type === 'running-shoes') {
        await evaluate(cdp, `window.pokeemerald.automation.setRunningShoes(${event.enabled})`);
      } else if (event.type === 'view') {
        await evaluate(cdp, `window.pokeemerald.automation.setVisualMode(${JSON.stringify(event.mode)}, ${event.animate})`);
      } else if (event.type === 'gpu-loss') {
        probes.push({ frame: event.frame, name: 'gpu-loss', result: await evaluate(cdp, `window.pokeemerald.automation.simulateDeviceLoss()`) });
      } else if (event.type === 'screenshot') {
        screenshots.push(await saveScreenshot(cdp, outputDir, event));
      } else if (event.type === 'probe') {
        probes.push(await runProbe(cdp, event));
      }
    }
    await writeFile(resolve(outputDir, 'summary.json'), JSON.stringify({ input: basename(inputPath), frameUnit: 'emulated_game_frame', view: options.view, shading: options.shading, zoom: options.zoom, perspective: options.perspective, renderScale: options.renderScale, screenshots, probes, errors }, null, 2));
  } catch (error) {
    errors.push(error.stack || String(error));
    process.exitCode = 1;
  } finally {
    await writeFile(resolve(outputDir, 'console.log'), `${logLines.join('\n')}\n`);
    await writeFile(resolve(outputDir, 'errors.log'), `${errors.join('\n')}\n`);
    if (cdp) cdp.close();
    if (browser && !options.keepBrowser) browser.child.kill();
    if (server) server.child.kill();
    if (!options.keepBrowser) {
      try {
        await rm(userDataDir, { recursive: true, force: true });
      } catch {
        // Chrome can leave profile files behind briefly after shutdown.
      }
    }
  }
}

main();
