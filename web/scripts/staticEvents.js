import { DEV_OPT_IN_STORAGE, SESSION_KEY_STORAGE } from '../src/telemetry/beacon.js';

// The site's events on the plain HTML pages in public/ that wear the instrument look, served as /events.js by
// scripts/staticPageAssets.js and linked deferred by those pages only. Plain ES5, no imports: the file is served raw.
// It tells what src/shell/marketing/SiteChrome.jsx tells, through the same intake, under the same session key and with
// the same localhost mute as src/telemetry/beacon.js: `front_open` once per load, `front_link` for a link that carries
// `data-to` inside a `data-area`, and `front_control` for a pick /appearance.js announces as `wm-appearance`.

// Every label the file can send. A page or link naming anything else tells nothing.
export const LABELS = {
  page: ['pricing'],
  area: ['header', 'ways', 'sitemap', 'footer'],
  to: ['home', 'landing', 'app', 'sign_in', 'settings', 'pricing', 'connect', 'changelog', 'gallery', 'support', 'privacy', 'terms', 'refunds', 'feedback'],
  product: ['roadmap', 'journal', 'gym'],
};

// What the switch stores, and the word the shared footer tells for it.
const CHOICE_LABELS = { system: 'auto', light: 'light', dark: 'dark' };

// A send is one beacon, or one keepalive request where the browser refuses the beacon; its failure is silent.
export function staticEventsScript() {
  return `(function(){var L=${JSON.stringify(LABELS)},CHOICE=${JSON.stringify(CHOICE_LABELS)},KEY=${JSON.stringify(SESSION_KEY_STORAGE)},DEV=${JSON.stringify(DEV_OPT_IN_STORAGE)},
page=document.documentElement.getAttribute('data-page'),key=null;
function known(list,value){return value!==null&&list.indexOf(value)>=0}
if(!known(L.page,page))return;
function muted(){if(window.location.hostname!=='localhost')return false;try{return !localStorage.getItem(DEV)}catch(e){return true}}
function sessionKey(){if(key)return key;var c=window.crypto,minted=c&&c.randomUUID?c.randomUUID():Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
try{key=localStorage.getItem(KEY);if(!key){key=minted;localStorage.setItem(KEY,key)}}catch(e){key=minted}return key}
function tell(name,props){if(muted())return;var body=JSON.stringify({sessionKey:sessionKey(),events:[{name:name,clientMs:Date.now(),props:props}]});
try{if(navigator.sendBeacon&&navigator.sendBeacon('/v1/events',new Blob([body],{type:'application/json'})))return}catch(e){}
try{fetch('/v1/events',{method:'POST',credentials:'include',keepalive:true,headers:{'Content-Type':'application/json'},body:body}).catch(function(){})}catch(e){}}
tell('front_open',{page:page});
document.addEventListener('click',function(e){var link=e.target&&e.target.closest?e.target.closest('a[data-to]'):null,place=link?link.closest('[data-area]'):null;if(!place)return;
var area=place.getAttribute('data-area'),to=link.getAttribute('data-to'),product=link.getAttribute('data-product');
if(!known(L.area,area)||!known(L.to,to)||(product!==null&&!known(L.product,product)))return;
var props={page:page,area:area,to:to};if(product!==null)props.product=product;tell('front_link',props)});
document.addEventListener('wm-appearance',function(e){if(!CHOICE.hasOwnProperty(e.detail))return;tell('front_control',{page:page,control:'appearance',choice:CHOICE[e.detail]})})})();`;
}
