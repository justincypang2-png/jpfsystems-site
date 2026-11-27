// Local shops' own product lists: Google Sheet (CSV), Shopify, WooCommerce and Google Shopping file -> importer -> SQLite (stands in for D1) -> /search.
import http from 'node:http'; import { rmSync, writeFileSync } from 'node:fs'; import { DatabaseSync } from 'node:sqlite';
const ok=(c,m)=>{ if(!c){ console.error('FAIL',m); process.exitCode=1;} else console.log('ok  ',m); };
const DBFILE='/tmp/nolag-local-test.sqlite', SHOPS='/tmp/nolag-local-shops.json'; rmSync(DBFILE,{force:true});
const sheet='Name,Price,In stock,Link,Image,Category\nBouquet of seasonal flowers,25.00,yes,,https://img.test/b.jpg,Flowers\nHelium balloon number 30,4.50,12,,,Party\nRed wine gift box,20,yes,,,Gifts\nVase,12,no,,,Home\n';
const shopify={products:[
  {id:11,title:'USB-C Phone Charger 20W',handle:'usb-c-charger',vendor:'Anker',product_type:'Chargers',images:[{src:'https://cdn.test/c.jpg'}],variants:[{price:'14.99',compare_at_price:'19.99',available:true},{price:'12.99',available:false}]},
  {id:12,title:'iPhone 15 Screen Protector',handle:'protector',vendor:'X',product_type:'Accessories',images:[],variants:[{price:'7.99',available:false}]},
]};
const woo=[{id:21,name:'Claw Hammer &amp; Nails Set',permalink:'https://hardware.test/p/hammer',prices:{price:'1299',regular_price:'1499',currency_minor_unit:2},images:[{src:'https://hardware.test/h.jpg'}],is_in_stock:true,categories:[{name:'Tools'}]},
  {id:22,name:'Extension lead 4 way',permalink:'https://hardware.test/p/lead',prices:{price:'899',regular_price:'899',currency_minor_unit:2},images:[],is_in_stock:true,low_stock_remaining:2,categories:[]}];
const xml=`<?xml version="1.0"?><rss xmlns:g="http://base.google.com/ns/1.0" version="2.0"><channel><title>Cakes</title>
<item><g:id>c1</g:id><g:title><![CDATA[Chocolate birthday cake (8")]]></g:title><g:link>https://cakes.test/choc</g:link><g:price>32.00 GBP</g:price><g:availability>in_stock</g:availability><g:image_link>https://cakes.test/c.jpg</g:image_link><g:brand>Peckham Bakes</g:brand></item>
<item><g:id>c2</g:id><g:title>Lemon drizzle loaf</g:title><g:link>https://cakes.test/lemon</g:link><g:price>9.50 GBP</g:price><g:sale_price>8.00 GBP</g:sale_price><g:availability>in stock</g:availability></item>
</channel></rss>`;
let files={'/flowers.csv':sheet,'/phones/products.json':JSON.stringify(shopify),'/hw/wp-json/wc/store/v1/products':JSON.stringify(woo),'/cakes/feed.xml':xml};
const srv=http.createServer((req,res)=>{ const u=req.url.split('?')[0], f=files[u]; if(u==='/phones/products.json' && /page=[2-9]/.test(req.url)) return res.end('{"products":[]}');
  if(u.startsWith('/hw/wp-json') && /page=[2-9]/.test(req.url)) return res.end('[]'); if(!f){res.statusCode=404;return res.end();} res.end(f); });
srv.listen(8790);
// online shops are read from the shop's own address (the root of its website), so each gets its own port here
const one=(port,prefix)=>http.createServer((req,res)=>{ req.url=prefix+req.url; srv.emit('request',req,res); }).listen(port);
const s2=one(8791,'/phones'), s3=one(8792,'/hw');
const B='http://127.0.0.1:8790';
const wd=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'], today=wd.indexOf(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',weekday:'short'}).format(new Date()));
const shops=[
  {id:'peckham-flowers',name:'Peckham Flowers',areas:['SE15','SE5'],how:['own','collect'],cutoff:23.9,fee:'£4.95, free over £40',phone:'020 7000 0000',url:'https://flowers.test',list:{url:B+'/flowers.csv'}},
  {id:'phone-fix',name:'Rye Lane Phone Fix',areas:['SE'],how:['collect'],cutoff:23.9,phone:'020 7000 0001',url:'https://phones.test',list:{url:'http://127.0.0.1:8791/collections/all',type:'shopify'}},
  {id:'hw',name:'Nunhead Hardware',areas:['SE15'],how:['courier'],cutoff:23.9,list:{url:'http://127.0.0.1:8792/'}},
  {id:'cakes',name:'Peckham Bakes',areas:['SE15'],how:['own'],cutoff:23.9,days:[(today+1)%7],list:{url:B+'/cakes/feed.xml'}},
  {id:'manc',name:'Northern Quarter Gifts',areas:['M1'],how:['own'],cutoff:23.9,url:'https://nqgifts.test',list:{url:B+'/flowers.csv'}},
];
writeFileSync(SHOPS,JSON.stringify({shops}));
Object.assign(process.env,{LOCAL_DB:DBFILE,LOCAL_SHOPS_FILE:SHOPS,LOCAL_ONLY:'1'});
const { main, sheetLink } = await import('../import.mjs');
ok(sheetLink('https://docs.google.com/spreadsheets/d/AbC-123/edit#gid=77')==='https://docs.google.com/spreadsheets/d/AbC-123/export?format=csv&gid=77','normal Google Sheets link becomes its CSV download');
ok(sheetLink('https://docs.google.com/spreadsheets/d/e/2PACX-x/pubhtml')==='https://docs.google.com/spreadsheets/d/e/2PACX-x/pub?output=csv','"publish to web" link becomes CSV');
const r1=await main();
ok(r1.local.changes===9,'loads 9 products: 2 from the florist sheet (wine and sold-out vase left out) for each of 2 shops, 1 Shopify charger, 2 WooCommerce, 2 bakery (got '+r1.local.changes+')');
const r2=await main(); ok(r2.local.changes===0 && r2.local.removed===0,'second run with nothing changed writes nothing');
// shop changes its sheet: balloon sold out, flowers price up; hardware site goes down (kept from last time)
files['/flowers.csv']=sheet.replace('25.00','27.50').replace('number 30,4.50,12','number 30,4.50,0'); delete files['/hw/wp-json/wc/store/v1/products'];
const r3=await main(); ok(r3.local.changes===2 && r3.local.removed===2,'price change updates both shops using that sheet; sold-out balloon removed from both (got '+r3.local.changes+'/'+r3.local.removed+')');
const db=new DatabaseSync(DBFILE);
ok(db.prepare("SELECT COUNT(*) n FROM products WHERE id LIKE 'local:hw:%'").get().n===2,'hardware list failed to load: its products are kept, not wiped');
ok(db.prepare("SELECT COUNT(*) n FROM products WHERE name LIKE '%wine%'").get().n===0,'wine never imported');
// search through the worker
const { default: worker } = await import('../../worker.js');
globalThis.fetch=async()=>new Response('{}');
const env={ DB:{ prepare(sql){ let a=[]; const st=db.prepare(sql); return { bind(...x){a=x;return this;}, async all(){ return {results:st.all(...a)}; } }; } } };
const s=async(q,pc)=>(await (await worker.fetch(new Request('https://api.test/search?q='+encodeURIComponent(q)+(pc?'&area='+encodeURIComponent(pc):'')),env)).json()).products;
let r=await s('bouquet flowers','SE15 4AB'); console.log(r.map(p=>`${p.speed} | ${p.shop} | ${p.name} | £${p.price} | ${p.fee} | ${p.arrive}`).join('\n'));
ok(r.length===1 && r[0].local && r[0].shop==='Peckham Flowers' && r[0].price===27.5 && r[0].speed==='today' && /4\.95/.test(r[0].fee),'SE15: the Peckham florist, delivering today, with its delivery charge');
ok(r[0].url==='https://flowers.test' && r[0].phone,'no product link in the sheet: links to the shop website, phone included');
ok((await s('bouquet flowers','M1 1AE')).every(p=>p.shop==='Northern Quarter Gifts'),'M1: only the Manchester shop, never the Peckham one');
ok((await s('bouquet flowers','')).length===0,'no postcode: local products are not shown');
r=await s('phone charger','SE22 9AA'); ok(r.length===1 && r[0].shop==='Rye Lane Phone Fix' && r[0].collect && r[0].was===19.99 && r[0].price===14.99,'whole-area shop ("SE") shows in SE22, collect-only, cheapest available variant with its was-price');
ok((await s('screen protector','SE15 4AB')).length===0,'sold-out Shopify item not shown');
r=await s('hammer','SE15 4AB'); ok(r.length===1 && r[0].name==='Claw Hammer & Nails Set' && r[0].arrive==='By courier','WooCommerce item, name cleaned, arrives by courier');
r=await s('lead','SE15 4AB'); ok(r[0].stock==='low','WooCommerce low stock flagged');
r=await s('chocolate cake','SE15 4AB'); ok(r.length===1 && r[0].speed==='tomorrow' && r[0].name.includes('8"'),'bakery closed today, open tomorrow: shows as tomorrow; Google file title with CDATA read');
r=await s('lemon loaf','SE15 4AB'); ok(r[0].price===8 && r[0].was===9.5,'Google file sale price used, normal price shown as was');
srv.close(); s2.close(); s3.close();
