import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React, {useMemo,useState} from 'react';
import {createRoot} from 'react-dom/client';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import {PrerequisitePicker} from '/src/products/roadmap/board/PrerequisitePicker.jsx';
import {StepDraft} from '/src/products/roadmap/board/StepDraft.js';
import {SkillTree} from '/src/products/roadmap/model/SkillTree.js';
const completed = new Set(['wind']);
window.mount = ({total=8,selected=[],name='Reefing basics'}={}) => {
  const original = [{id:'wind',label:'Read the wind',prerequisites:[],color:'sky'},
    ...Array.from({length:total-1},(_,i)=>({id:'step-'+i,label:'Chart '+i,prerequisites:['wind'],color:'olive'}))];
  function App() {
    const [open,setOpen] = useState(false);
    const [nodes,setNodes] = useState(original);
    const [draft,setDraft] = useState(()=>new StepDraft({name,prerequisites:selected}));
    const tree = useMemo(()=>new SkillTree({id:'sail',title:'Learn to sail',nodes}),[nodes]);
    window.remove = () => setNodes(original.filter(n=>n.id!=='wind'));
    window.restore = () => setNodes(original);
    return React.createElement('div',{className:'st-board-composer-layer '+(innerWidth<744?'is-phone':'is-wide')},
      React.createElement('button',{onClick:()=>setOpen(true)},'Open picker'),
      open && React.createElement(PrerequisitePicker,{tree,completed,draft,band:innerWidth<744?'phone':'desktop',
        onCancel:()=>{window.cancelled=true;setOpen(false);},onApply:ids=>{window.applied=ids;setDraft(draft.with({prerequisites:ids}));setOpen(false);}}));
  }
  createRoot(document.getElementById('root')).render(React.createElement(App));
};
window.entryReady=true;
`;
let server, browser, origin;
const ready = (async()=>{
  server = await createServer({configFile:false,root,cacheDir:`${root}/node_modules/.vite-prerequisite-picker-test`,
    plugins:[{name:'picker-test',resolveId(id){
      if(id==='/picker-test-entry.js') return '\0picker-entry';
      if(id.endsWith('/telemetry/beacon.js')) return '\0picker-beacon';
      if(id==='./acts.js') return '\0picker-acts';
    },load(id){
      if(id==='\0picker-entry') return entry;
      if(id==='\0picker-beacon') return 'export function track(name,props){(window.events??=[]).push({name,props});}';
      if(id==='\0picker-acts') return "export function countBucket(n){return n===0?'0':n===1?'1':n<=5?'2-5':n<=20?'6-20':'21+';}";
    },configureServer(server){server.middlewares.use('/picker-test',(_request,response)=>{response.setHeader('Content-Type','text/html');response.end('<!doctype html><meta name="viewport" content="width=device-width"><div id="root"></div><script type="module" src="/picker-test-entry.js"></script>');});}}],
    optimizeDeps:{include:['react','react-dom/client','lucide-react']},server:{host:'127.0.0.1',port:0,fs:{allow:[fileURLToPath(new URL('../../../../../',import.meta.url))]}}});
  await server.listen(0);origin=`http://127.0.0.1:${server.httpServer.address().port}`;browser=await chromium.launch({headless:true});
})();
after(async()=>{try{await ready;}finally{await browser?.close();await server?.close();}});
async function open(width,options={}) {
  const page=await browser.newPage({viewport:{width,height:844}});
  await page.goto(`${origin}/picker-test`);await page.waitForFunction(()=>window.entryReady);await page.evaluate(options=>window.mount(options),options);
  await page.getByRole('button',{name:'Open picker'}).click();return page;
}
for(const width of [390,1440]) {
  test(`Chromium ${width}: selection survives search; Apply only when changed; Cancel keeps draft`,async()=>{
    await ready;const page=await open(width,{selected:['wind']});
    try{
      assert.equal(await page.getByRole('button',{name:'Apply',exact:true}).isDisabled(),true);
      await page.getByLabel('Find a step',{exact:true}).fill('Chart 2');
      await page.getByRole('checkbox',{name:'Chart 2 Up next'}).click();
      await page.getByLabel('Find a step',{exact:true}).fill('no match');
      assert.deepEqual(await page.locator('.st-board-picker-chip').allTextContents(),['Read the wind','Chart 2']);
      assert.equal(await page.getByRole('status').getByRole('heading').textContent(),'No steps match “no match”');
      await page.getByRole('button',{name:'Remove Chart 2',exact:true}).click();
      assert.equal(await page.getByLabel('Find a step',{exact:true}).evaluate(el=>el===document.activeElement),width>=744);
      assert.equal(await page.getByRole('button',{name:'Apply',exact:true}).isDisabled(),true);
      await page.keyboard.press('Escape');
      assert.deepEqual(await page.evaluate(()=>({applied:window.applied??null,cancelled:window.cancelled,focus:document.activeElement.textContent,events:window.events})),{
        applied:null,cancelled:true,focus:'Open picker',events:[{name:'roadmap_board_picker',props:{step:'cancel'}}],
      });
      await page.getByRole('button',{name:'Open picker'}).click();
      assert.deepEqual(await page.locator('.st-board-picker-chip').allTextContents(),['Read the wind']);
      await page.getByRole('checkbox',{name:'Chart 2 Up next'}).click();
      await page.getByRole('button',{name:'Apply',exact:true}).click();
      assert.deepEqual(await page.evaluate(()=>({applied:window.applied,last:window.events.at(-1)})),{applied:['wind','step-2'],last:{name:'roadmap_board_picker',props:{step:'apply',count:'2-5'}}});
    }finally{await page.close();}
  });
  test(`Chromium ${width}: pages by 20; bounded more event; Backspace removes last selected`,async()=>{
    await ready;const page=await open(width,{total:65,selected:['wind','step-0']});
    try{
      assert.equal(await page.getByRole('checkbox').count(),20);
      await page.getByLabel('Find a step',{exact:true}).fill('Chart');
      assert.equal(await page.locator('.st-board-picker-count').textContent(),width<744?'20 of 64 matches':'20 of 64 matches in 65 steps');
      await page.getByRole('button',{name:'Show 20 more'}).click();
      assert.equal(await page.getByRole('checkbox').count(),40);
      assert.deepEqual(await page.evaluate(()=>window.events),[{name:'roadmap_board_picker',props:{step:'more'}}]);
      await page.getByLabel('Find a step',{exact:true}).fill('');
      await page.keyboard.press('Backspace');
      assert.deepEqual(await page.locator('.st-board-picker-chip').allTextContents(),['Read the wind']);
      await page.getByRole('button',{name:'Apply',exact:true}).focus();await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(()=>document.activeElement.closest('[role="dialog"]')!==null),true);
    }finally{await page.close();}
  });
  test(`Chromium ${width}: remote removal persists after a step returns`,async()=>{
    await ready;const page=await open(width,{selected:['wind']});
    try{
      await page.evaluate(()=>window.remove());await page.getByRole('checkbox',{name:'Read the wind Done'}).waitFor({state:'detached'});
      await page.evaluate(()=>window.restore());await page.getByRole('checkbox',{name:'Read the wind Done'}).waitFor();
      assert.equal(await page.getByRole('checkbox',{name:'Read the wind Done'}).getAttribute('aria-checked'),'false');
      assert.equal(await page.locator('.st-board-picker-chip').count(),0);
    }finally{await page.close();}
  });
}
test('Chromium phone: eight candidates keep keyboard down; nine focus search; unnamed draft omits context',async()=>{
  await ready;
  for(const total of [8,9]) {
    const page=await open(390,{total,name:''});
    try{
      assert.equal(await page.getByLabel('Find a step',{exact:true}).evaluate(el=>el===document.activeElement),total===9);
      assert.equal(await page.locator('.st-board-picker-context').count(),0);
    }finally{await page.close();}
  }
});

test('Chromium phone: search and Apply remain above the visual keyboard viewport',async()=>{
  await ready;const page=await open(390,{total:65});
  try{
    await page.evaluate(()=>{
      Object.defineProperties(window.visualViewport,{height:{configurable:true,value:500},offsetTop:{configurable:true,value:40}});
      window.visualViewport.dispatchEvent(new Event('resize'));
    });
    await page.waitForFunction(()=>document.querySelector('.st-board-picker').getBoundingClientRect().height===500);
    assert.deepEqual(await page.locator('.st-board-picker').evaluate(el=>({top:el.getBoundingClientRect().top,height:el.getBoundingClientRect().height})),{top:40,height:500});
    assert.equal(await page.getByRole('button',{name:'Apply',exact:true}).evaluate(el=>el.getBoundingClientRect().bottom<=540),true);
  }finally{await page.close();}
});
