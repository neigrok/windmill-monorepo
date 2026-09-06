import { resolveTheme } from './appBoot.js';

// The appearance toggle on the plain HTML pages in public/, served as /appearance.js by
// scripts/staticPageAssets.js and linked deferred beside /nav-auth.js. Plain ES5, no imports: the
// file is served raw. It fills the empty `.wm-appearance` box each page already carries first in
// `.navr` (the box is reserved in the HTML so the deferred mount moves nothing) with a two-segment
// Light · Dark radiogroup, checks the
// RESOLVED appearance (the stored choice, else the device), and on a pick stores the value, stamps
// or clears `data-theme="dark"` on <html> the way /boot.js does, and repaints the browser's own
// chrome the way src/shell/appearance.js paintBrowserChrome does — the ground read off
// `--surface-canvas` after the stamp, never a literal.
const SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';

// lucide's sun and moon, the glyphs src/design-system/Icon.jsx draws for the same two choices.
export const SEGMENTS = [
  ['light', 'Light', `${SVG_OPEN}<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`],
  ['dark', 'Dark', `${SVG_OPEN}<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`],
];

export function staticAppearanceScript(storageKey) {
  return `(function(){var d=document.documentElement,group=document.querySelector('.navr .wm-appearance');if(!group)return;
var KEY=${JSON.stringify(storageKey)},S=${JSON.stringify(SEGMENTS)},mq=window.matchMedia?window.matchMedia('(prefers-color-scheme: dark)'):null,radios=[];
function stored(){var s=null;try{s=localStorage.getItem(KEY)}catch(e){}return(s==='light'||s==='dark')?s:null}
function resolved(){var t=null;${resolveTheme(storageKey)}return t}
function paint(t){if(t==='dark'){d.setAttribute('data-theme','dark');d.setAttribute('data-brand','clay')}else{d.removeAttribute('data-theme');d.removeAttribute('data-brand');d.style.removeProperty('--wm-boot-ground')}
var g=window.getComputedStyle(d).getPropertyValue('--surface-canvas').trim(),P=[['theme-color',g],['color-scheme',t]];
for(var i=0;i<P.length;i++){var m=document.querySelector('meta[name="'+P[i][0]+'"]');if(!m||!P[i][1])continue;
if(!m.getAttribute('data-was'))m.setAttribute('data-was',m.getAttribute('content'));m.setAttribute('content',P[i][1])}}
function render(t){group.setAttribute('data-resolved',t);for(var i=0;i<radios.length;i++){var on=S[i][0]===t;radios[i].setAttribute('aria-checked',on?'true':'false');radios[i].setAttribute('tabindex',on?'0':'-1')}}
function apply(t){paint(t);render(t)}
function choose(v){try{localStorage.setItem(KEY,v)}catch(e){}apply(v)}
group.removeAttribute('aria-hidden');group.setAttribute('role','radiogroup');group.setAttribute('aria-label','Appearance');
var thumb=document.createElement('span');thumb.className='wm-appearance-thumb';thumb.setAttribute('aria-hidden','true');group.appendChild(thumb);
for(var n=0;n<S.length;n++){(function(n,value,label,icon){var b=document.createElement('button');b.type='button';b.className='wm-appearance-segment';
b.setAttribute('role','radio');b.setAttribute('aria-label',label);b.setAttribute('data-value',value);b.innerHTML=icon;
var w=document.createElement('span');w.className='wm-appearance-word';w.textContent=label;b.appendChild(w);
b.addEventListener('click',function(){choose(value)});
b.addEventListener('keydown',function(e){var k=e.key,to=-1;if(k==='ArrowRight'||k==='ArrowDown')to=(n+1)%S.length;else if(k==='ArrowLeft'||k==='ArrowUp')to=(n+S.length-1)%S.length;else if(k==='Home')to=0;else if(k==='End')to=S.length-1;
if(to<0)return;e.preventDefault();choose(S[to][0]);radios[to].focus()});
radios.push(b);group.appendChild(b)})(n,S[n][0],S[n][1],S[n][2])}
if(mq){var onMedia=function(){if(stored())return;apply(resolved())};if(mq.addEventListener)mq.addEventListener('change',onMedia);else if(mq.addListener)mq.addListener(onMedia)}
window.addEventListener('storage',function(e){if(e.key!==null&&e.key!==KEY)return;apply(resolved())});
render(resolved())})();`;
}
