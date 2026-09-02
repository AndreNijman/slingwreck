import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'shots/p2-render.png');
const materials = ['glass', 'wood', 'stone', 'iron', 'tnt', 'spring', 'gel', 'sand'];
const pigs = ['runt', 'swine', 'hogg', 'helm', 'tusk', 'zep', 'sarge', 'king'];
const html = `<!doctype html><meta charset="utf-8">
<style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}canvas{display:block;width:1280px;height:720px}</style>
<canvas id="frame" width="1280" height="720"></canvas>
<script type="module">
import { makeRound } from '/sim.js?v=20260902-1';
import { draw, makeCamera, makeRenderer } from '/render.js?v=20260902-1';
const xs = [1, 4.1, 7.2, 10.3, 13.4, 16.5, 19.6, 22.7];
const materials = ${JSON.stringify(materials)};
const pigs = ${JSON.stringify(pigs)};
const blocks = materials.map((material, index) => ['beam', material, xs[index], .25, 0]);
blocks.push(
  ['pillar', 'wood', 9, 2.25, 0], ['pillar', 'wood', 15, 2.25, 0],
  ['plank', 'stone', 12, 4.25, 0], ['post', 'glass', 10.5, 5.5, 0],
  ['post', 'iron', 13.5, 5.5, 0], ['plank', 'wood', 12, 6.75, 0],
  ['cube', 'tnt', 12, 7.5, 0], ['tri', 'sand', 8.35, .333, 0],
  ['cube', 'gel', 15.9, .5, 0], ['cube', 'spring', 17.05, .5, 0]
);
const pigRows = pigs.map((pig, index) => [pig, xs[index], .5 +
  ({ runt:.30, swine:.40, hogg:.58, helm:.42, tusk:.44, zep:.34, sarge:.46, king:.68 })[pig]]);
pigRows[3][2] = 4.5 + .42; pigRows[4][2] = 4.5 + .44;
const round = makeRound({ mode:'campaign', seed:0x51a9, bag:['nib'],
  blueprint:{ v:1, blocks, pigs:pigRows } });
round.blocks.find((body) => body.materialId === 'stone').hp *= .18;
const renderer = makeRenderer(document.querySelector('#frame'));
renderer.now = () => 0;
draw(renderer, round, makeCamera(), 1);
document.documentElement.dataset.ready = 'yes';
</script>`;
const mime = { '.js':'text/javascript', '.mjs':'text/javascript', '.json':'application/json' };

const server = createServer(async (request, response) => {
  try {
    if (request.url === '/') {
      response.writeHead(200, { 'content-type':'text/html; charset=utf-8' });
      response.end(html);
      return;
    }
    const path = resolve(root, `.${decodeURIComponent(request.url.split('?')[0])}`);
    if (!path.startsWith(`${root}/`)) throw new Error('path outside project');
    response.writeHead(200, { 'content-type':mime[extname(path)] ?? 'application/octet-stream' });
    response.end(await readFile(path));
  } catch (error) {
    response.writeHead(404, { 'content-type':'text/plain' }); response.end(String(error));
  }
});

await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
const address = server.address();
let browser;
try {
  await mkdir(dirname(output), { recursive:true });
  browser = await chromium.launch({ headless:true });
  const page = await browser.newPage({ viewport:{ width:1280, height:720 }, deviceScaleFactor:1 });
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil:'networkidle' });
  await page.waitForSelector('html[data-ready="yes"]');
  await page.locator('canvas').screenshot({ path:output });
  console.log(`wrote ${output}`);
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
