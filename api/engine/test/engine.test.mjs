// End-to-end test with made-up test feeds: feed list -> importer -> SQLite (stands in for D1) -> worker /search.
import http from 'node:http'; import { gzipSync } from 'node:zlib'; import { rmSync } from 'node:fs'; import { DatabaseSync } from 'node:sqlite';
const DBFILE='/tmp/nolag-engine-test.sqlite'; rmSync(DBFILE,{force:true});
const csv = rows => rows.map(r=>r.map(v=>/[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v).join(',')).join('\n');
const H=['aw_deep_link','product_name','aw_product_id','merchant_image_url','search_price','merchant_name','category_name','brand_name','in_stock','stock_quantity','delivery_time','delivery_cost','rrp_price'];
const shopA = csv([H,
 ['https://t.test/a1','Sony PlayStation 5 Console Slim','1','https://img.test/ps5.jpg','479.99','Argos','Games consoles','Sony','1','12','','','499.99'],
 ['https://t.test/a2','PS5 DualSense Wireless Controller - White','2','https://img.test/pad.jpg','64.99','Argos','Games accessories','Sony','1','40','',''],
 ['https://t.test/a3','Apple AirPods Pro (2nd generation)','3','https://img.test/ap.jpg','199.00','Argos','Headphones','Apple','1','3','',''],
 ['https://t.test/a4','Apple AirPods 4','4','https://img.test/ap4.jpg','119.00','Argos','Headphones','Apple','0','0','',''],
 ['https://t.test/a5','Red Wine Gift Set, "Merlot"','5','https://img.test/w.jpg','15.00','Argos','Wine','X','1','5','',''],
]);
const shopB = csv([H,
 ['https://t.test/b1','PlayStation 5 Console Digital Edition','9','https://img.test/b1.jpg','389.00','Currys','Gaming','Sony','1','','Next day delivery','0'],
 ['https://t.test/b2','AirPods Pro 2 with MagSafe case','10','https://img.test/b2.jpg','189.00','Currys','Audio','Apple','1','','Next day delivery','4.99'],
]);
const shopC = csv([['title','link','id','image_link','price','availability','brand','google_product_category','shipping_label'],
 ['Wireless earbuds compatible with AirPods case cover','https://t.test/c1','c1','https://img.test/c1.jpg','3.49 GBP','in_stock','NoName','Electronics','5-14 working days'],
 ['Silicone PS5 controller skin','https://t.test/c2','c2','https://img.test/c2.jpg','2.99 GBP','in_stock','NoName','Gaming','5-14 working days'],
]);
const list = csv([['Advertiser ID','Advertiser Name','Primary Region','Membership Status','Datafeed Format','Feed ID','Feed Name','Language','Vertical','Last Imported','Last Checked','No of products','URL'],
 ['1','Argos','GB','active','Awin','101','Argos feed','en','retail','','','5','http://127.0.0.1:8787/a.csv.gz'],
 ['2','Currys','GB','active','Awin','102','Currys feed','en','retail','','','2','http://127.0.0.1:8787/b.csv'],
 ['3','Temu UK','GB','active','Google','103','Temu feed','en','retail','','','2','http://127.0.0.1:8787/c.csv'],
 ['4','Some Shop','GB','not joined','Awin','104','x','en','retail','','','9','http://127.0.0.1:8787/none.csv'],
]);
const files={'/list.csv':list,'/a.csv.gz':gzipSync(shopA),'/b.csv':shopB,'/c.csv':shopC};
const srv=http.createServer((req,res)=>{ const f=files[req.url]; if(!f){res.statusCode=404;return res.end();} res.end(f); }).listen(8787);
Object.assign(process.env,{FEED_LIST_URL:'http://127.0.0.1:8787/list.csv',LOCAL_DB:DBFILE,FAST_RETRY:'1'});
const { main, speedOf } = await import('../import.mjs');
const ok=(c,m)=>{ if(!c){ console.error('FAIL',m); process.exitCode=1;} else console.log('ok  ',m); };
ok(speedOf('Same day delivery')==='today','same day -> today');
ok(speedOf('1-2 working days')==='later','1-2 days -> later (not promised tomorrow)');
ok(speedOf('Next day')==='tomorrow','next day -> tomorrow');
ok(speedOf('Delivered within 30 mins')==='today','30 mins -> today');
const r1=await main(); ok(r1.changes===7,'first run loads 7 in-stock, allowed products (got '+r1.changes+')');
const r2=await main(); ok(r2.changes===0 && r2.removed===0,'second run with no feed changes writes nothing');
// a price change and a product going out of stock
files['/b.csv']=shopB.replace('389.00','379.00').replace(/\n.*AirPods Pro 2 with MagSafe case.*$/m,'');
const r3=await main(); ok(r3.changes===1 && r3.removed===1,'price change updates 1, sold-out item removed 1');
srv.close();
// worker search over the same database
const { default: worker } = await import('../../worker.js');
const db=new DatabaseSync(DBFILE);
const env={ DB:{ prepare(sql){ let a=[]; const st=db.prepare(sql); return { bind(...x){a=x;return this;}, async all(){ return {results:st.all(...a)}; }, async run(){ st.run(...a); } }; } } };
const s=async q=>(await (await worker.fetch(new Request('https://api.test/search?q='+encodeURIComponent(q)),env)).json()).products;
const ps5=await s('ps5'), console1=await s('playstation 5 console');
console.log('ps5 ->', ps5.map(p=>`${p.speed} | ${p.shop} | ${p.name} | £${p.price}`).join('\n        '));
console.log('playstation 5 console ->', console1.map(p=>`${p.speed} | ${p.shop} | ${p.name} | £${p.price}`).join('\n        '));
ok(console1[0].name.includes('Console') && console1[0].speed==='today','console search: Argos console first, arrives today');
const ap=await s('airpod'); console.log('airpod ->', ap.map(p=>`${p.speed} | ${p.shop} | ${p.name} | £${p.price} | ${p.stock}`).join('\n        '));
ok(ap[0].shop==='Argos' && ap[0].stock==='low','airpod: Argos AirPods Pro first, low stock flagged');
ok(ap.at(-1).speed==='later','Temu-style items go last under "later"');
ok(!ap.some(p=>p.name.includes('AirPods 4')),'out-of-stock AirPods 4 not shown');
ok((await s('wine')).length===0,'wine never imported');
const ctrl=await s('ps5 controller'); ok(ctrl[0].name.includes('Controller'),'asking for a controller puts the controller first');
ok((await s('')).length===0 && (await s('benz')).length===0,'empty and unknown searches return nothing');
const p5=await s('ps5'); console.log('ps5 (after synonyms) ->', p5.map(p=>`${p.speed} | ${p.shop} | ${p.name}`).join('\n        '));
ok(/Console/.test(p5[0].name),'ps5 now finds the consoles first');
const pc=await s('PS5 console'); ok(/Console/.test(pc[0].name) && pc.length>=2,'"PS5 console" (what the site sends) finds both consoles');
const wordy=await s('apple airpods pro 2nd gen white'); ok(wordy.length && /AirPods Pro/.test(wordy[0].name),'wordy search falls back to best partial match');
