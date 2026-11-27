// Live Amazon source, with Amazon's Creators API mocked: sign-in, search request, Prime/arrival mapping, caching, merging with eBay.
import { DatabaseSync } from 'node:sqlite';
const { default: worker } = await import('../../worker.js');
const ok=(c,m)=>{ if(!c){ console.error('FAIL',m); process.exitCode=1;} else console.log('ok  ',m); };
let calls=[], sent=null, tokenCalls=0;
const item=(asin,title,amount,extra={})=>({ asin, detailPageURL:`https://www.amazon.co.uk/dp/${asin}?tag=nolag-21`,
  images:{primary:{large:{url:`https://m.media-amazon.com/images/I/${asin}.jpg`,width:500,height:500}}},
  itemInfo:{title:{displayValue:title}},
  offersV2:{listings:[{ isBuyBoxWinner:true, availability:{type:extra.type||'IN_STOCK',message:extra.msg||'In stock'}, condition:{value:extra.cond||'New'},
    merchantInfo:{name:extra.seller||'Amazon.co.uk'}, price:{money:{amount,currency:'GBP',displayAmount:'£'+amount}, ...(extra.was?{savingBasis:{money:{amount:extra.was},savingBasisType:extra.basis||'WAS_PRICE'}}:{})},
    ...(extra.deal?{dealDetails:{badge:extra.deal,accessType:'ALL'}}:{}) }]} });
globalThis.fetch = async (u, o={}) => {
  u=String(u); calls.push(u.split('?')[0]);
  if (u.includes('auth/o2/token')) { tokenCalls++; const b=JSON.parse(o.body); ok(b.scope==='creatorsapi::default' && b.grant_type==='client_credentials','signs in to Amazon with client credentials'); return new Response(JSON.stringify({access_token:'A', expires_in:3600})); }
  if (u.includes('creatorsapi.amazon')) {
    sent=JSON.parse(o.body);
    ok(o.headers['x-marketplace']==='www.amazon.co.uk' && o.headers.Authorization==='Bearer A','asks Amazon UK with the token');
    return new Response(JSON.stringify({ searchResult:{ items:[
      item('B0CHARGER1','Anker USB C Charger 20W, Fast Phone Charger Plug', 12.99, {was:15.99, deal:'Black Friday Deal'}),
      item('B0CHARGER2','Apple 20W USB-C Power Adapter', 17.0, {basis:'LIST_PRICE', was:19}),
      item('B0CHARGER3','USB C Phone Charger 3 Pack', 9.49, {type:'IN_STOCK_SCARCE', seller:'GadgetHub UK'}),
      item('B0CHARGER4','Phone charger refurbished', 5, {cond:'Used'}),
      item('B0CHARGER5','USB C phone charger import', 6, {type:'LEADTIME', msg:'Usually dispatched within 1 to 2 months'}),
      item('B0CHARGER6','Garden hose 30m', 20),
    ]}}));
  }
  if (u.includes('oauth2/token')) return new Response(JSON.stringify({access_token:'T', expires_in:7200}));
  return new Response(JSON.stringify({ itemSummaries:[{ title:'USB C Phone Charger 25W', price:{value:'8.99'}, itemWebUrl:'https://www.ebay.co.uk/itm/9', seller:{username:'s'}, shippingOptions:[{shippingCost:{value:'0.00'}, maxEstimatedDeliveryDate:new Date(Date.now()+864e5).toISOString()}] }]}));
};
const db=new DatabaseSync(':memory:');
const env={ AMAZON_CREDENTIAL_ID:'id', AMAZON_CREDENTIAL_SECRET:'sec', AMAZON_PARTNER_TAG:'nolag-21', EBAY_CLIENT_ID:'e', EBAY_CLIENT_SECRET:'s',
  DB:{ prepare(sql){ let a=[]; const st=(()=>{try{return db.prepare(sql)}catch(e){return null}})(); return { bind(...x){a=x;return this;}, async all(){ if(!st) throw new Error('no table'); return {results:st.all(...a)}; } }; } } };
const s=async q=>(await (await worker.fetch(new Request('https://api.test/search?q='+encodeURIComponent(q)+'&area=M1 1AE'),env)).json()).products;
const r=await s('phone charger usb c');
console.log(r.map(p=>`${p.speed} | ${p.shop}${p.seller?' ('+p.seller+')':''} | ${p.name} | £${p.price}${p.was?' was £'+p.was:''} | ${p.fee} | ${p.deal||''}`).join('\n'));
ok(sent.partnerTag==='nolag-21' && sent.deliveryFlags[0]==='Prime' && sent.marketplace==='www.amazon.co.uk' && sent.resources.includes('images.primary.large'), 'asks for Prime items, UK, with photos and offers');
const amz=r.filter(p=>p.shop==='Amazon');
ok(amz.length===3, 'keeps 3 Amazon chargers; drops used, months-away import and the garden hose (got '+amz.length+')');
ok(amz.every(p=>p.img.startsWith('https://m.media-amazon.com/') && p.url.includes('tag=nolag-21')), 'photos come straight from Amazon; links carry the NoLag tag');
ok(amz[0].was===15.99 && amz[0].deal==='Black Friday Deal' && amz[1].was===null, 'shows a "was" price only when Amazon calls it a was-price; keeps deal badges');
ok(amz.every(p=>p.speed==='tomorrow' && p.prime && /Prime/.test(p.fee) && /Prime delivery/.test(p.arrive)), 'Prime items go under tomorrow, with free Prime delivery');
ok(amz.find(p=>p.seller==='GadgetHub UK').stock==='low', 'marketplace seller named; low stock shown');
ok(r.some(p=>p.shop==='eBay'), 'eBay listings still come through alongside Amazon');
const n=calls.length; await s('phone charger usb c'); ok(calls.length===n, 'same search within 15 minutes uses memory (no Amazon or eBay call)');
ok(tokenCalls===1, 'signs in once and reuses the token');
delete env.AMAZON_PARTNER_TAG; ok((await s('kettle')).every(p=>p.shop!=='Amazon'), 'without Amazon keys the search still works');
