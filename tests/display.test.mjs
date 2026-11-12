import test from 'node:test';
import assert from 'node:assert/strict';
import { smartInterfacePercent } from '../web/display.mjs';

test('Smart sizing uses usable logical space after Windows DPI scaling', () => {
  const examples = [
    [{width:1280,height:820},1,100],
    [{width:1280,height:680},1,90],
    [{width:1280,height:590},1,80],
    [{width:1024,height:530},1,75],
    [{width:1600,height:1025},1.25,100],
    [{width:1920,height:1020},1.5,90],
    [{width:1366,height:690},1.25,80],
    [{width:1366,height:690},1.5,75],
    [{width:2560,height:1640},2,100],
    [{width:720,height:820},1,75],
  ];
  for (const [pixels,dpi,expected] of examples) assert.equal(smartInterfacePercent(pixels,dpi),expected);
});

test('Smart sizing handles unavailable display metrics without shrinking text', () => {
  for (const [pixels,dpi] of [[{width:0,height:820},1],[{width:1280,height:820},0],[{width:NaN,height:820},1]]) {
    assert.equal(smartInterfacePercent(pixels,dpi),100);
  }
});

let instance = 0;
async function appearance({saved={},dark=true,pixels={width:1280,height:680},dpi=1}={}) {
  const values = new Map(Object.entries(saved)), calls = [], events = {};
  const system = {matches:dark,addEventListener(){}};
  const desktop = {setTheme:async value=>calls.push(['theme',value]),innerSize:async()=>pixels,scaleFactor:async()=>dpi};
  for (const event of ['onResized','onMoved','onScaleChanged']) desktop[event]=async callback=>{events[event]=callback;return()=>{};};
  globalThis.matchMedia=()=>system;
  globalThis.localStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
  globalThis.document={documentElement:{dataset:{}},querySelector:()=>null,querySelectorAll:()=>[]};
  globalThis.__TAURI__={window:{getCurrentWindow:()=>desktop},webview:{getCurrentWebview:()=>({setZoom:async value=>calls.push(['zoom',value])})}};
  const module=await import(`../web/appearance.mjs?test=${++instance}`);
  await module.displayReady;
  return {module,values,calls,events,pixels,system,desktop};
}

test('new workspaces start Light and Smart even when Windows uses Dark', async () => {
  const {module,calls}=await appearance();
  assert.equal(module.appearanceMode(),'light');
  assert.equal(module.interfaceSize(),'smart');
  assert.equal(document.documentElement.dataset.theme,'light');
  assert.deepEqual(calls,[['theme','light'],['zoom',.9]]);
});

test('existing theme and manual size choices survive startup and display changes', async () => {
  const {module,calls,events}=await appearance({saved:{'invoicer-appearance':'dark','invoicer-interface-size':'80'}});
  assert.equal(module.appearanceMode(),'dark');
  assert.equal(module.interfaceSize(),'80');
  events.onScaleChanged();
  await new Promise(resolve=>setTimeout(resolve,230));
  assert.deepEqual(calls,[['theme','dark'],['zoom',.8]]);
});

test('Smart reacts to resize and DPI changes, and manual override stops adaptation', async () => {
  const {module,pixels,calls,events,values,desktop}=await appearance();
  pixels.height=820;events.onResized();
  await new Promise(resolve=>setTimeout(resolve,230));
  assert.equal(module.interfaceSizeLabel(),'Smart ✨ · 100%');
  desktop.scaleFactor=async()=>1.5;events.onMoved();events.onScaleChanged();
  await new Promise(resolve=>setTimeout(resolve,230));
  assert.equal(module.interfaceSizeLabel(),'Smart ✨ · 75%');
  await module.setInterfaceSize('90');
  const before=calls.length;pixels.height=400;events.onResized();
  await new Promise(resolve=>setTimeout(resolve,230));
  assert.equal(calls.length,before);
  assert.equal(module.interfaceSizeLabel(),'90%');
  assert.equal(values.get('invoicer-interface-size'),'90');
});

test('an in-flight display query cannot replace a newer manual choice', async () => {
  const {module,desktop,calls,values}=await appearance();
  let release;
  desktop.innerSize=()=>new Promise(resolve=>{release=resolve;});
  const automatic=module.setInterfaceSize('smart');
  await module.setInterfaceSize('100');
  release({width:720,height:500});await automatic;
  assert.equal(module.interfaceSize(),'100');
  assert.equal(values.get('invoicer-interface-size'),'100');
  assert.deepEqual(calls.at(-1),['zoom',1]);
});

test('Match Windows remains available as an explicit saved preference', async () => {
  const {module,calls}=await appearance({saved:{'invoicer-appearance':'auto'}});
  assert.equal(module.appearanceMode(),'auto');
  assert.equal(document.documentElement.dataset.theme,'dark');
  assert.deepEqual(calls[0],['theme',null]);
});
