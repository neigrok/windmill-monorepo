import { resolveTheme } from './appBoot.js';

// The appearance switch on the plain HTML pages in public/, served as /appearance.js by
// scripts/staticPageAssets.js and linked deferred beside /nav-auth.js. Plain ES5, no imports: the
// file is served raw. It fills the empty `.wm-appearance` box each page already carries (the box is
// reserved in the HTML so the deferred mount moves nothing) with a radiogroup of the choices the box
// names in `data-choices`, Light and Dark when it names none. A switch without Auto checks the
// RESOLVED appearance (the stored choice, else the device); a switch with Auto checks the CHOICE,
// Auto while nothing is stored, as the front page's footer does. On a pick it stores the value (a
// pick holds for this page where storage refuses it, until another tab's choice arrives),
// stamps or clears `data-theme="dark"` on <html> the way /boot.js does, and repaints the browser's
// own chrome the way src/shell/appearance.js paintBrowserChrome does — the ground read off
// `--surface-canvas` after the stamp, never a literal.
const SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';

// Every choice a switch can offer, in the order it offers them: the value src/shell/appearance.js
// stores, its word, and lucide's glyph, the one src/design-system/Icon.jsx draws for it. `system`
// is Auto: it follows the device.
export const CHOICES = [
  ['system', 'Auto', `${SVG_OPEN}<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>`],
  ['light', 'Light', `${SVG_OPEN}<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`],
  ['dark', 'Dark', `${SVG_OPEN}<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`],
];

export function staticAppearanceScript(storageKey) {
  return `(function(){var d=document.documentElement,group=document.querySelector('.wm-appearance');if(!group)return;
var KEY=${JSON.stringify(storageKey)},ALL=${JSON.stringify(CHOICES)},named=(group.getAttribute('data-choices')||'light dark').split(' '),S=[],radios=[],picked=null,
mq=window.matchMedia?window.matchMedia('(prefers-color-scheme: dark)'):null;
for(var c=0;c<ALL.length;c++){for(var o=0;o<named.length;o++){if(named[o]===ALL[c][0])S.push(ALL[c])}}
var withAuto=named.indexOf('system')>=0;
function chosen(){if(picked)return picked;var s=null;try{s=localStorage.getItem(KEY)}catch(e){}return(s==='light'||s==='dark')?s:'system'}
function resolved(){var t=picked==='light'||picked==='dark'?picked:null;${resolveTheme(storageKey)}return t}
function paint(t){if(t==='dark'){d.setAttribute('data-theme','dark');d.setAttribute('data-brand','clay')}else{d.removeAttribute('data-theme');d.removeAttribute('data-brand');d.style.removeProperty('--wm-boot-ground')}
var g=window.getComputedStyle(d).getPropertyValue('--surface-canvas').trim(),P=[['theme-color',g],['color-scheme',t]];
for(var i=0;i<P.length;i++){var m=document.querySelector('meta[name="'+P[i][0]+'"]');if(!m||!P[i][1])continue;
if(!m.getAttribute('data-was'))m.setAttribute('data-was',m.getAttribute('content'));m.setAttribute('content',P[i][1])}}
function render(){var t=resolved(),v=withAuto?chosen():t;group.setAttribute('data-resolved',t);for(var i=0;i<radios.length;i++){var on=S[i][0]===v;radios[i].setAttribute('aria-checked',on?'true':'false');radios[i].setAttribute('tabindex',on?'0':'-1')}}
function apply(){paint(resolved());render()}
function choose(v){picked=v;try{localStorage.setItem(KEY,v)}catch(e){}apply()}
group.removeAttribute('aria-hidden');group.setAttribute('role','radiogroup');group.setAttribute('aria-label','Appearance');
var thumb=document.createElement('span');thumb.className='wm-appearance-thumb';thumb.setAttribute('aria-hidden','true');group.appendChild(thumb);
for(var n=0;n<S.length;n++){(function(n,value,label,icon){var b=document.createElement('button');b.type='button';b.className='wm-appearance-segment';
b.setAttribute('role','radio');b.setAttribute('aria-label',label);b.setAttribute('data-value',value);b.innerHTML=icon;
var w=document.createElement('span');w.className='wm-appearance-word';w.textContent=label;b.appendChild(w);
b.addEventListener('click',function(){choose(value)});
b.addEventListener('keydown',function(e){var k=e.key,to=-1;if(k==='ArrowRight'||k==='ArrowDown')to=(n+1)%S.length;else if(k==='ArrowLeft'||k==='ArrowUp')to=(n+S.length-1)%S.length;else if(k==='Home')to=0;else if(k==='End')to=S.length-1;
if(to<0)return;e.preventDefault();choose(S[to][0]);radios[to].focus()});
radios.push(b);group.appendChild(b)})(n,S[n][0],S[n][1],S[n][2])}
if(mq){var onMedia=function(){if(chosen()!=='system')return;apply()};if(mq.addEventListener)mq.addEventListener('change',onMedia);else if(mq.addListener)mq.addListener(onMedia)}
window.addEventListener('storage',function(e){if(e.key!==null&&e.key!==KEY)return;picked=null;apply()});
render()})();`;
}
