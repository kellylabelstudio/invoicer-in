export const defaultAccents = {light:'#086e66', dark:'#b59bff'};
export const accentPresets = [
  ['Teal','#086e66','#66dbc9'], ['Purple','#7050d3','#b59bff'],
  ['Blue','#285cc4','#8cb4ff'], ['Rose','#ba3868','#ff9bbf'],
  ['Amber','#996200','#f3ca78'], ['Graphite','#414651','#c5c9d4']
];

export function normalizeColor(value) {
  if (typeof value !== 'string') return null;
  const color = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(color)) return color;
  if (/^#[0-9a-f]{3}$/.test(color)) return '#' + [...color.slice(1)].map(v=>v+v).join('');
  return null;
}
const channels = hex => [1,3,5].map(i=>parseInt(hex.slice(i,i+2),16));
export function mixColor(a,b,weight) {
  const left=channels(a),right=channels(b);
  return '#'+left.map((v,i)=>Math.round(v*(1-weight)+right[i]*weight).toString(16).padStart(2,'0')).join('');
}
function luminance(color) {
  const [r,g,b]=channels(color).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});
  return .2126*r+.7152*g+.0722*b;
}
export function contrastRatio(a,b) {
  const x=luminance(a),y=luminance(b);
  return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
}
function readableColor(color,background,minimum=4.5) {
  if(contrastRatio(color,background)>=minimum)return color;
  const target=contrastRatio('#ffffff',background)>contrastRatio('#000000',background)?'#ffffff':'#000000';
  for(let amount=.05;amount<=1;amount+=.05) {
    const candidate=mixColor(color,target,Math.min(1,amount));
    if(contrastRatio(candidate,background)>=minimum)return candidate;
  }
  return target;
}
export function accentTokens(value,theme) {
  const dark=theme==='dark', color=normalizeColor(value)??defaultAccents[dark?'dark':'light'];
  const background=dark?'#111113':'#ffffff';
  const text=contrastRatio('#ffffff',color)>contrastRatio('#000000',color)?'#ffffff':'#000000';
  const soft=mixColor(background,color,dark?.15:.1),ink=readableColor(color,soft);
  return {
    '--accent':color, '--accent-hover':mixColor(color,dark?'#ffffff':'#000000',.1),
    '--accent-text':text, '--accent-soft':soft, '--accent-ink':ink,
    '--accent-edge':readableColor(color,background,3), '--focus':readableColor(color,background,3),
    '--sidebar-hover':mixColor(background,color,.08), '--sidebar-selected-text':ink,
    '--feature':mixColor(background,color,dark?.05:.07), '--feature-edge':mixColor(background,color,.25),
    '--feature-ink':ink, '--ambient-color':color,
  };
}
