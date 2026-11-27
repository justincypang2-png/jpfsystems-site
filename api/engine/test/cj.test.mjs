// Live CJ source (e.g. Argos), with CJ's Product Search API mocked: query, tracked links, Argos delivery facts, filtering, caching.
import { DatabaseSync } from 'node:sqlite';
const { default: worker } = await import('../../worker.js');
const ok=(c,m)=>{ if(!c){ console.error('FAIL',m); process.exitCode=1;} else console.log('ok  ',m); };
let calls=0, sent=null;
const item=(o)=>({advertiserId:'111',advertiserName:'Argos',title:'x',price:{amount:'10.00',currency:'GBP'},salePrice:null,imageLink:'https://media.argos.test/i.jpg',link:'https://www.argos.co.uk/p/1',availability:'in stock',linkCode:{clickUrl:'https://www.anrdoezrs.net/click-999-111?url=x'},...o});
globalThis.fetch = async (u, o={}) => {
  if (!String(u).includes('ads.api.cj.com')) return new Response('{}');
  calls++; sent=JSON.parse(o.body).query;
  ok(o.headers.Authorization==='Bearer TOKEN','signs in to CJ with the access token');
  return new Response(JSON.stringify({data:{products:{resultList:[
    item({title:'Anker 20W USB-C Phone Charger',price:{amount:'19.99',currency:'GBP'},salePrice:{amount:'14.99',currency:'GBP'}}),
    item({title:'Belkin USB-C Phone Charger 25W',price:{amount:'24.99',currency:'GBP'}}),
    item({title:'USB-C Phone Charger no link',linkCode:null}),
    item({title:'USB-C Phone Charger sold out',availability:'out of stock'}),
    item({title:'USB-C Phone Charger in dollars',price:{amount:'9',currency:'USD'}}),
    item({advertiserName:'Some Gadget Shop UK',title:'USB C phone charger 30W',price:{amount:'12.50',currency:'GBP'}}),
  ]}}}));
};
const db=new DatabaseSync(':memory:');
const env={ CJ_TOKEN:'TOKEN', CJ_COMPANY_ID:'7654321', CJ_WEBSITE_ID:'101010', CJ_ADVERTISER_IDS:'111, 222',
  DB:{ prepare(sql){ let a=[]; const st=(()=>{try{return db.prepare(sql)}catch(e){return null}})(); return { bind(...x){a=x;return this;}, async all(){ if(!st) throw new Error('no table'); return {results:st.all(...a)}; } }; } } };
const s=async q=>(await (await worker.fetch(new Request('https://api.test/search?q='+encodeURIComponent(q)+'&area=SE15 4AB'),env)).json()).products;
const r=await s('phone charger usb c');
console.log(r.map(p=>`${p.speed} | ${p.shop} | ${p.name} | £${p.price}${p.was?' was £'+p.was:''} | ${p.fee} | ${p.arrive} | cutoff ${p.cutoff}`).join('\n'));
ok(/companyId: "7654321"/.test(sent) && /linkCode\(pid: "101010"\)/.test(sent) && /partnerIds: \["111", "222"\]/.test(sent) && /keywords: \["phone", "charger", "usb", "c"\]/.test(sent),'asks CJ with our account, website ID (tracked links), the chosen shops and the search words');
ok(r.length===3,'keeps 3; drops the one without a tracked link, the sold-out one and the one priced in dollars (got '+r.length+')');
const a=r.filter(p=>p.shop==='Argos');
ok(a.length===2 && a.every(p=>p.speed==='today' && p.cutoff===17 && p.arrive==='by 10pm' && /5\.95/.test(p.fee)),'Argos items get Argos same-day facts: today by 10pm, order by 5pm, delivery charge');
ok(a.find(p=>/Anker/.test(p.name)).price===14.99 && a.find(p=>/Anker/.test(p.name)).was===19.99,'sale price used, normal price shown as was');
ok(r.every(p=>p.url.includes('click-999-111')),'every link is CJ\'s tracked link');
const other=r.find(p=>p.shop==='Some Gadget Shop'); ok(other && other.speed==='unknown','a CJ shop we have no facts for: delivery time shown as not listed, " UK" trimmed from its name');
const n=calls; await s('phone charger usb c'); ok(calls===n,'same search within 15 minutes uses memory, no CJ call');
delete env.CJ_TOKEN; ok((await s('kettle')).length===0,'without CJ keys the search still works');
