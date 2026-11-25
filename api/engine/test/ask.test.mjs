// Search assistant (/ask) with Workers AI mocked.
const { default: worker } = await import('../../worker.js');
const ok=(c,m)=>{ if(!c){ console.error('FAIL',m); process.exitCode=1;} else console.log('ok  ',m); };
let seen=[];
const AI={ async run(model, input){ seen.push({model,input}); const u=input.messages[1].content;
  if(u.includes('"tv"') && !u.includes('answers')) return {response:{done:false,question:'What size TV do you need?',options:['32 inch','43 inch','55 inch','65 inch','Not sure'],search:'smart TV'}};
  if(u.includes('43 inch')) return {response:JSON.stringify({done:true,question:'',options:[],search:'43 inch smart TV'})};
  if(u.includes('broken')) return {response:'not json at all'};
  return {response:{done:false,question:'Still asking <script>?',options:['a','b'],search:'x'}}; } };
const env={AI};
const ask=(body,origin='https://www.jpfsystems.co',ip='1.1.1.1')=>worker.fetch(new Request('https://api.test/ask',{method:'POST',headers:{Origin:origin,'Content-Type':'text/plain','CF-Connecting-IP':ip},body:JSON.stringify(body)}),env).then(r=>r.json());
let r=await ask({q:'tv'}); console.log(r);
ok(r.ai && !r.done && r.options.length===5 && /size/i.test(r.question),'vague "tv" -> one question with 5 tap-able answers');
ok(seen[0].model.includes('llama-3.1-8b') && seen[0].input.response_format.type==='json_schema','uses the small free model with structured output');
r=await ask({q:'tv',history:[{q:'What size TV do you need?',a:'43 inch'}]}); console.log(r);
ok(r.done && r.search==='43 inch smart TV','after the answer -> precise search "43 inch smart TV"');
r=await ask({q:'something',history:[{q:'a?',a:'b'},{q:'c?',a:'d'}]});
ok(r.done && r.question==='' && !r.search.includes('<'),'never more than 2 questions; output cleaned');
r=await ask({q:'vodka'}); ok(r.done && r.search==='','blocked items: no questions, no search');
r=await ask({q:'broken'}); ok(r.ai===false,'unreadable AI answer -> site falls back to its own questions');
r=await ask({q:'tv'},'https://evil.example'); ok(r.ai===false,'other websites cannot use your AI allowance');
let busy=0; for(let i=0;i<25;i++){ const x=await ask({q:'tv'},undefined,'9.9.9.9'); if(x.reason==='busy') busy++; }
ok(busy===5,'one visitor is limited to 20 questions a minute (blocked '+busy+' of 25)');
r=await worker.fetch(new Request('https://api.test/ask',{method:'POST',headers:{Origin:'https://www.jpfsystems.co'},body:'{"q":"tv"}'}),{}).then(r=>r.json());
ok(r.ai===false,'without the AI switched on, it says so and the site uses its own questions');
