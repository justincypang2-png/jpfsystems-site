// Live eBay source, with eBay's API mocked: token, search results with delivery estimates, caching, filtering.
import { DatabaseSync } from 'node:sqlite';
const { default: worker } = await import('../../worker.js');
const ok=(c,m)=>{ if(!c){ console.error('FAIL',m); process.exitCode=1;} else console.log('ok  ',m); };
const iso=d=>new Date(Date.now()+d*864e5).toISOString();
let calls=[];
globalThis.fetch = async (u, o={}) => {
  calls.push(String(u).split('?')[0]);
  if (String(u).includes('oauth2/token')) return new Response(JSON.stringify({access_token:'T', expires_in:7200}));
  ok(o.headers['X-EBAY-C-MARKETPLACE-ID']==='EBAY_GB' && o.headers['X-EBAY-C-ENDUSERCTX'].includes('zip%3DSE15'), 'asks eBay UK with the searcher\'s area (SE15)');
  return new Response(JSON.stringify({ itemSummaries: [
    { title:'Sony PlayStation 5 Console Slim Disc Edition', price:{value:'449.00'}, image:{imageUrl:'https://i.ebayimg.com/1.jpg'}, itemWebUrl:'https://www.ebay.co.uk/itm/1', seller:{username:'shopA'}, shippingOptions:[{shippingCost:{value:'0.00'}, maxEstimatedDeliveryDate: iso(1)}] },
    { title:'PS5 Console Digital Edition Slim', price:{value:'379.99'}, image:{imageUrl:'https://i.ebayimg.com/2.jpg'}, itemWebUrl:'https://www.ebay.co.uk/itm/2', itemAffiliateWebUrl:'https://www.ebay.co.uk/itm/2?aff=1', seller:{username:'shopB'}, shippingOptions:[{shippingCost:{value:'4.99'}, maxEstimatedDeliveryDate: iso(0)}] },
    { title:'PS5 Console stand with cooling fan', price:{value:'19.99'}, image:{imageUrl:'x'}, itemWebUrl:'https://www.ebay.co.uk/itm/3', shippingOptions:[{shippingCost:{value:'0.00'}, maxEstimatedDeliveryDate: iso(1)}] },
    { title:'PlayStation 5 console bundle', price:{value:'499'}, itemWebUrl:'https://www.ebay.co.uk/itm/4', shippingOptions:[{maxEstimatedDeliveryDate: iso(6)}] },
    { title:'Xbox Series X', price:{value:'399'}, itemWebUrl:'https://www.ebay.co.uk/itm/5', shippingOptions:[{maxEstimatedDeliveryDate: iso(1)}] }
  ]}));
};
const db=new DatabaseSync(':memory:');
const env={ EBAY_CLIENT_ID:'id', EBAY_CLIENT_SECRET:'secret', DB:{ prepare(sql){ let a=[]; const st=(()=>{try{return db.prepare(sql)}catch(e){return null}})(); return { bind(...x){a=x;return this;}, async all(){ if(!st) throw new Error('no table'); return {results:st.all(...a)}; } }; } } };
const s=async q=>(await (await worker.fetch(new Request('https://api.test/search?q='+encodeURIComponent(q)+'&area=SE15 4AB'),env)).json()).products;
const r=await s('PS5 console');
console.log(r.map(p=>`${p.speed} | ${p.shop} (${p.seller}) | ${p.name} | £${p.price} | ${p.fee} | ${p.arrive}${p.accessory?' | accessory':''}`).join('\n'));
ok(r.length===4, 'keeps PS5 consoles and the stand, drops the Xbox (got '+r.length+')');
ok(r[0].speed==='today' && r[0].url.includes('aff=1'), 'arrives-today item first, using the commission link when there is one');
ok(r[1].speed==='tomorrow' && !r[1].accessory && r[2].accessory, 'tomorrow: the console comes before the stand (accessory)');
ok(r.at(-1).speed==='later' && /by \w{3} \d+ \w{3}/.test(r.at(-1).arrive), '6-day delivery goes to "later" with its date');
const before=calls.length; await s('PS5 console'); ok(calls.length===before, 'same search again within 15 minutes uses the memory, no eBay call');
delete env.EBAY_CLIENT_ID; ok((await s('kettle')).length===0, 'without eBay keys the search still works (returns feed products only)');
