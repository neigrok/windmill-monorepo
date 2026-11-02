import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import { StepComposer } from '/src/products/roadmap/board/StepComposer.jsx';
import { SkillTree } from '/src/products/roadmap/model/SkillTree.js';
const completed = new Set();
const legend = [{hue:'terracotta',label:'Build'},{hue:'olive',label:'Learn'},{hue:'gold',label:'Milestone'}];
window.mount = () => {
  function App() {
    const [open, setOpen] = useState(false);
    const [nodes, setNodes] = useState([{id:'wind',label:'Read the wind',prerequisites:[],color:'sky'}]);
    const tree = useMemo(() => new SkillTree({id:'sail',title:'Learn to sail',nodes}), [nodes]);
    window.remove = () => setNodes([]);
    return React.createElement('div', null,
      React.createElement('button', {onClick:()=>setOpen(true)}, 'Open composer'),
      open && React.createElement(StepComposer, {tree,completed,legend,band:innerWidth < 744 ? 'phone' : innerWidth < 1024 ? 'tablet' : 'desktop',
        onClose:()=>setOpen(false),onCreate:request=>{ (window.requests ??= []).push(request); return {ok:!!window.succeed}; }}));
  }
  createRoot(document.getElementById('root')).render(React.createElement(App));
};
window.entryReady = true;
`;
let server, browser, origin;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-step-composer-test`,
    plugins: [{ name: 'composer-test', resolveId(id) {
      if (id === '/composer-test-entry.js') return '\0composer-entry';
      if (id.endsWith('/telemetry/beacon.js')) return '\0composer-beacon';
      if (id === './acts.js') return '\0composer-acts';
    }, load(id) {
      if (id === '\0composer-entry') return entry;
      if (id === '\0composer-beacon') return 'export function track(name, props) { (window.events ??= []).push({name,props}); }';
      if (id === '\0composer-acts') return "export function countBucket(n) { return n===0?'0':n===1?'1':n<=5?'2-5':n<=20?'6-20':'21+'; }";
    }, configureServer(server) {
      server.middlewares.use('/composer-test', (_request, response) => { response.setHeader('Content-Type','text/html'); response.end('<!doctype html><meta name="viewport" content="width=device-width"><div id="root"></div><script type="module" src="/composer-test-entry.js"></script>'); });
    } }], optimizeDeps: { include: ['react', 'react-dom/client', 'lucide-react'] },
    server: {host:'127.0.0.1',port:0,fs:{allow:[fileURLToPath(new URL('../../../../../',import.meta.url))]}} });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({headless:true});
})();
after(async () => { try { await ready; } finally { await browser?.close(); await server?.close(); } });
async function open(width) {
  const page = await browser.newPage({viewport:{width,height:960}});
  await page.goto(`${origin}/composer-test`);
  await page.waitForFunction(() => window.entryReady);
  await page.evaluate(() => window.mount());
  await page.getByRole('button',{name:'Open composer'}).click();
  return page;
}
for (const width of [390, 1440]) {
  test(`Chromium ${width}: required name, failure retains fields, Retry sends the identical request and restores opener focus`, async () => {
    await ready; const page = await open(width);
    try {
      await page.getByRole('button',{name:'Create step',exact:true}).click();
      assert.equal(await page.getByLabel('Name',{exact:true}).getAttribute('aria-invalid'),'true');
      const errorId = await page.getByLabel('Name',{exact:true}).getAttribute('aria-describedby');
      assert.equal(await page.locator(`[id="${errorId}"]`).textContent(),'Enter a name for this step.');
      await page.getByLabel('Name',{exact:true}).fill('  Reefing basics  ');
      await page.getByLabel('Description · optional').fill('Reduce sail in strong wind.');
      await page.getByRole('radio',{name:'Learn',exact:true}).click();
      await page.getByRole('button',{name:'Create step',exact:true}).click();
      assert.equal(await page.getByRole('alert').textContent(),'Couldn’t save. Your draft is kept.');
      assert.deepEqual(await page.evaluate(() => {
        const {id,...fields} = window.requests[0]; return {fields, frozen:Object.isFrozen(window.requests[0]), frozenNeeds:Object.isFrozen(window.requests[0].prerequisites), id:!!id};
      }), {fields:{label:'Reefing basics',description:'Reduce sail in strong wind.',color:'olive',prerequisites:[]},frozen:true,frozenNeeds:true,id:true});
      await page.evaluate(() => { window.succeed = true; });
      await page.getByRole('button',{name:'Retry',exact:true}).click();
      assert.deepEqual(await page.evaluate(() => ({same:window.requests[0]===window.requests[1],focus:document.activeElement.textContent,events:window.events})), {
        same:true,focus:'Open composer',events:[{name:'roadmap_board_create',props:{step:'failed'}},{name:'roadmap_board_create',props:{step:'retry'}}],
      });
      assert.equal(await page.getByRole('dialog').count(),0);
    } finally { await page.close(); }
  });
  test(`Chromium ${width}: clean Escape writes nothing; dirty Escape asks once and nested cancellation restores focus`, async () => {
    await ready; const page = await open(width);
    try {
      await page.keyboard.press('Escape');
      assert.deepEqual(await page.evaluate(() => ({requests:window.requests??[],focus:document.activeElement.textContent})),{requests:[],focus:'Open composer'});
      await page.getByRole('button',{name:'Open composer'}).click();
      await page.getByLabel('Name',{exact:true}).fill('Reefing basics');
      const cancel = page.getByRole('button',{name:'Cancel',exact:true});
      await cancel.click();
      assert.equal(await page.getByRole('dialog',{name:'Discard draft?',exact:true}).count(),1);
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => document.activeElement.textContent),'Cancel');
      await cancel.click();
      await page.getByRole('button',{name:'Discard',exact:true}).click();
      assert.deepEqual(await page.evaluate(() => ({requests:window.requests??[],events:window.events,focus:document.activeElement.textContent})), {
        requests:[],events:[{name:'roadmap_board_create',props:{step:'cancel'}},{name:'roadmap_board_create',props:{step:'discard'}}],focus:'Open composer',
      });
    } finally { await page.close(); }
  });
  test(`Chromium ${width}: Keep editing focuses form; picker writes only on Apply and remote deletion clears failed prerequisites`, async () => {
    await ready; const page = await open(width);
    try {
      await page.getByLabel('Name',{exact:true}).fill('Reefing basics');
      await page.getByRole('button',{name:'Prerequisites None'}).click();
      await page.getByRole('checkbox',{name:'Read the wind Up next'}).click();
      await page.getByRole('button',{name:'Apply',exact:true}).click();
      assert.equal(await page.evaluate(() => document.activeElement.textContent),'PrerequisitesRead the wind');
      await page.getByRole('button',{name:'Create step',exact:true}).click();
      await page.getByRole('button',{name:'Keep editing',exact:true}).click();
      assert.equal(await page.getByLabel('Name',{exact:true}).evaluate(el=>el===document.activeElement),true);
      await page.getByRole('button',{name:'Create step',exact:true}).click();
      await page.evaluate(() => window.remove());
      await page.getByRole('button',{name:'Prerequisites None'}).waitFor();
      assert.equal(await page.getByRole('alert').count(),0);
      await page.getByRole('button',{name:'Create step',exact:true}).click();
      assert.deepEqual(await page.evaluate(() => ({ids:window.requests.map(r=>r.id),needs:window.requests.map(r=>r.prerequisites)})).then(({ids,needs})=>({sameId:ids.every(id=>id===ids[0]),needs})), {sameId:true,needs:[['wind'],['wind'],[]]});
    } finally { await page.close(); }
  });
}

test('Chromium tablet: 600px composer stays centred, picker overlays its right edge at drawn width',async()=>{
  await ready;const page=await open(744);
  try{
    await page.getByRole('button',{name:'Prerequisites None'}).click();
    assert.deepEqual(await page.evaluate(()=>{
      const composer=document.querySelector('.st-board-composer').getBoundingClientRect();
      const picker=document.querySelector('.st-board-picker').getBoundingClientRect();
      return {composer:{left:composer.left,width:composer.width},picker:{left:picker.left,width:picker.width}};
    }),{composer:{left:72,width:600},picker:{left:336,width:384}});
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(()=>document.activeElement.textContent),'PrerequisitesNone');
    await page.getByRole('button',{name:'Create step',exact:true}).focus();await page.keyboard.press('Tab');
    assert.equal(await page.getByLabel('Name',{exact:true}).evaluate(el=>el===document.activeElement),true);
  }finally{await page.close();}
});
