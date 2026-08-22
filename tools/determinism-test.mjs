const BODY_FIELDS = ['x', 'y', 'c', 's', 'vx', 'vy', 'av'];
const CHECKPOINT_STEPS = [0, 300, 600, 900, 1200, 1500, 1800];
const ENGINE_NAMES = ['Node', 'Chromium', 'Firefox', 'WebKit'];
const SHAPE_IDS = ['cube', 'slab', 'beam', 'plank', 'post', 'pillar', 'tri', 'ball'];
const MATERIAL_IDS = ['glass', 'wood', 'stone', 'iron', 'tnt', 'spring', 'gel', 'sand'];

function bitsOf(value, view) {
  view.setFloat64(0, value);
  return view.getUint32(0).toString(16).padStart(8, '0') +
    view.getUint32(4).toString(16).padStart(8, '0');
}

function snapshot(world) {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  return world.bodies.slice().sort((a, b) => a.id - b.id).map((body) => ({
    id: body.id,
    values: BODY_FIELDS.map((field) => body[field]),
    bits: BODY_FIELDS.map((field) => bitsOf(body[field], view))
  }));
}

export function runScenario(physics) {
  const { addBody, digest, fromDegrees, makeWorld, rng, rngInt, step } = physics;
  const random = rng(1337);
  const world = makeWorld();

  for (let i = 0; i < 40; i++) {
    const rotation = fromDegrees(rngInt(random, 24) * 15);
    const body = addBody(world, {
      shape: SHAPE_IDS[rngInt(random, SHAPE_IDS.length)],
      mat: MATERIAL_IDS[rngInt(random, MATERIAL_IDS.length)],
      x: -10 + random() * 44,
      y: 3 + random() * 24,
      c: rotation.c,
      s: rotation.s,
      hpScale: 0.75 + random() * 0.5,
      tag: `test-${i}`
    });
    body.vx = -12 + random() * 24;
    body.vy = -4 + random() * 16;
    body.av = -8 + random() * 16;
  }

  const digests = [];
  const snapshots = [];
  const capture = () => {
    digests.push(digest(world));
    snapshots.push(snapshot(world));
  };

  capture();
  for (let stepNumber = 1; stepNumber <= 1800; stepNumber++) {
    step(world);
    if (stepNumber % 300 === 0) capture();
  }

  return { steps: CHECKPOINT_STEPS, digests, snapshots };
}

function formatError(error) {
  const lines = String(error?.message ?? error).split('\n')
    .map((line) => line.replace(/[╔╗╚╝═║]/g, '').trim())
    .filter(Boolean);
  return lines.find((line) => /missing|does not exist|doesn't exist|cannot find|unavailable/i.test(line)) ??
    lines[0] ?? 'unknown error';
}

function formatNumber(value) {
  if (Object.is(value, -0)) return '-0';
  if (!Number.isFinite(value)) return String(value);
  return value.toPrecision(17);
}

function printDigestTable(results, skipped, errors) {
  const headers = ['engine', ...CHECKPOINT_STEPS.map((step, i) =>
    i === CHECKPOINT_STEPS.length - 1 ? `final ${step}` : `step ${step}`)];
  const rows = ENGINE_NAMES.map((engine) => {
    const completed = results.find((entry) => entry.engine === engine);
    if (completed) return [engine, ...completed.result.digests];
    const state = errors.some((entry) => entry.engine === engine) ? 'ERROR' :
      skipped.some((entry) => entry.engine === engine) ? 'SKIPPED' : 'MISSING';
    return [engine, ...CHECKPOINT_STEPS.map(() => state)];
  });

  const widths = headers.map((header, column) => Math.max(
    header.length,
    ...rows.map((row) => row[column].length)
  ));
  const line = (row) => row.map((cell, column) => cell.padEnd(widths[column])).join(' | ');
  console.log(line(headers));
  console.log(widths.map((width) => '-'.repeat(width)).join('-+-'));
  for (const row of rows) console.log(line(row));
}

function firstMismatch(results) {
  if (results.length < 2) return null;
  const baseline = results[0];
  for (let checkpoint = 0; checkpoint < CHECKPOINT_STEPS.length; checkpoint++) {
    for (let i = 1; i < results.length; i++) {
      if (baseline.result.digests[checkpoint] !== results[i].result.digests[checkpoint]) {
        return { baseline, other: results[i], checkpoint };
      }
    }
  }
  return null;
}

function firstBodyDifference(aBodies, bBodies) {
  const count = Math.max(aBodies.length, bBodies.length);
  for (let i = 0; i < count; i++) {
    const a = aBodies[i];
    const b = bBodies[i];
    if (!a || !b || a.id !== b.id) return { a, b, field: null };
    for (let field = 0; field < BODY_FIELDS.length; field++) {
      if (a.bits[field] !== b.bits[field]) {
        return { a, b, field: BODY_FIELDS[field] };
      }
    }
  }
  return null;
}

function reportMismatch(mismatch) {
  const { baseline, other, checkpoint } = mismatch;
  const stepNumber = CHECKPOINT_STEPS[checkpoint];
  console.error(
    `\nFAIL: ${baseline.engine} and ${other.engine} first differ at step ${stepNumber} ` +
    `(checkpoint ${checkpoint + 1}).`
  );

  const aBodies = baseline.result.snapshots[checkpoint];
  const bBodies = other.result.snapshots[checkpoint];
  const difference = firstBodyDifference(aBodies, bBodies);
  if (!difference) {
    console.error('Body values agree bit-for-bit; the digest implementation itself diverged.');
    return;
  }

  const { a, b, field } = difference;
  if (!a || !b || a.id !== b.id) {
    console.error(
      `First divergent body slot has ${baseline.engine} id ${a?.id ?? 'missing'} and ` +
      `${other.engine} id ${b?.id ?? 'missing'}.`
    );
    return;
  }

  console.error(`First divergent body: id ${a.id}; first differing field: ${field}.`);
  console.error(`field | ${baseline.engine} value [bits] | ${other.engine} value [bits]`);
  console.error(`------+--------------------------+--------------------------`);
  for (let i = 0; i < BODY_FIELDS.length; i++) {
    console.error(
      `${BODY_FIELDS[i].padEnd(5)} | ${formatNumber(a.values[i])} [${a.bits[i]}] | ` +
      `${formatNumber(b.values[i])} [${b.bits[i]}]`
    );
  }
}

function contentType(pathname) {
  if (pathname.endsWith('.js') || pathname.endsWith('.mjs')) {
    return 'text/javascript; charset=utf-8';
  }
  if (pathname.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function startServer(root, createServer, readFile, resolve, sep) {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url, 'http://127.0.0.1');
    if (requestUrl.pathname === '/__determinism__.html') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
      });
      response.end('<!doctype html><meta charset="utf-8"><title>determinism</title>');
      return;
    }

    let relative;
    try {
      relative = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '');
    } catch {
      response.writeHead(400);
      response.end('bad path');
      return;
    }
    const filePath = resolve(root, relative);
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      response.writeHead(403);
      response.end('forbidden');
      return;
    }

    readFile(filePath).then((contents) => {
      response.writeHead(200, {
        'content-type': contentType(requestUrl.pathname),
        'cache-control': 'no-store'
      });
      response.end(contents);
    }, () => {
      response.writeHead(404);
      response.end('not found');
    });
  });

  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      resolveListen({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function runBrowsers(root, results, skipped, errors) {
  let playwright;
  try {
    playwright = await import('@playwright/test');
  } catch (error) {
    const reason = `@playwright/test unavailable: ${formatError(error)}`;
    for (const engine of ENGINE_NAMES.slice(1)) skipped.push({ engine, reason });
    return;
  }

  const [{ createServer }, { readFile }, { resolve, sep }] = await Promise.all([
    import('node:http'),
    import('node:fs/promises'),
    import('node:path')
  ]);
  const { server, origin } = await startServer(root, createServer, readFile, resolve, sep);

  try {
    for (const [engine, browserType] of [
      ['Chromium', playwright.chromium],
      ['Firefox', playwright.firefox],
      ['WebKit', playwright.webkit]
    ]) {
      let browser;
      try {
        browser = await browserType.launch({ headless: true });
      } catch (error) {
        skipped.push({ engine, reason: `browser unavailable: ${formatError(error)}` });
        continue;
      }

      try {
        const page = await browser.newPage();
        await page.goto(`${origin}/__determinism__.html`, { waitUntil: 'load' });
        const result = await page.evaluate(async () => {
          const physics = await import('/physics.js');
          const { runScenario } = await import('/tools/determinism-test.mjs');
          return runScenario(physics);
        });
        results.push({ engine, result });
      } catch (error) {
        errors.push({ engine, reason: formatError(error) });
      } finally {
        await browser.close();
      }
    }
  } finally {
    await closeServer(server);
  }
}

async function main() {
  const [{ dirname, resolve }, { fileURLToPath }] = await Promise.all([
    import('node:path'),
    import('node:url')
  ]);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const physics = await import('../physics.js');
  const results = [{ engine: 'Node', result: runScenario(physics) }];
  const skipped = [];
  const errors = [];

  if (process.env.SKIP_BROWSERS === '1') {
    for (const engine of ENGINE_NAMES.slice(1)) {
      skipped.push({ engine, reason: 'SKIP_BROWSERS=1' });
    }
  } else {
    await runBrowsers(root, results, skipped, errors);
  }

  printDigestTable(results, skipped, errors);
  for (const { engine, reason } of skipped) console.warn(`SKIPPED ${engine}: ${reason}`);
  for (const { engine, reason } of errors) console.error(`FAILED ${engine}: ${reason}`);

  const mismatch = firstMismatch(results);
  if (mismatch) reportMismatch(mismatch);

  if (process.env.SKIP_BROWSERS === '1') {
    console.warn('\nWARNING: browser comparison skipped by SKIP_BROWSERS=1; Node-only run passed.');
    return;
  }
  if (mismatch || skipped.length || errors.length) process.exitCode = 1;
  else console.log('\nAll four engines agree at all seven checkpoints.');
}

const runningInNode = typeof process !== 'undefined' && process.versions?.node;
if (runningInNode) {
  const { pathToFileURL } = await import('node:url');
  if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main().catch((error) => {
      console.error(`determinism test failed: ${error.stack ?? error}`);
      process.exitCode = 1;
    });
  }
}
