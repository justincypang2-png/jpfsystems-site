import json,re
A='/home/claude/audit/'
S=json.load(open(A+'strings.json')); N=json.load(open(A+'names.json'))
src=open('/home/claude/nolag-site/index.html').read()
names=set(N['labels'])|set(N['browse'])|set(N['shops'])|{'eBay','AliExpress','Temu','NoLag','J.P. Freglien Systems','enquiries@jpfsystems.co','SE15 4AB','Aa','char','Enter'}
# templates: English pattern with {0},{1}; order = match priority
T=[
 "1 way to get “{0}” today","{#0} ways to get “{1}” today","Nothing can still deliver “{0}” today","No match for “{0}” yet",
 "{0}: 1 way today | NoLag","{0}: {#1} ways today | NoLag","{0} | NoLag",
 "Search for “{0}” instead","Search “{0}”","Search {0}","Buy at {0}","Buy on {0}",
 "{#0} h {#1} min left","{#0} min left","{#0} h {#1} min","{#0} min",
 "Opens at {0}, orders until {1}","Opens at {0}","Tomorrow, {0}","Arrives by {0}","Cheapest ways to have it by {0}","Showing what arrives by {0}.",", arrives by {0}",
 "£{#0} with delivery","£{#0} to £{#1} delivery","£{#0} next-day delivery","£{#0} delivery","£{#0} fee","Delivery: from £{#0} to £{#1}","Delivery: £{#0} next-day","Delivery: {0}",
 "Delivering to {0}.","We don't recognise “{0}” yet, so these are general shops that might have it.","Showing shops that sell {0}.","Prices vary; filter by up to £{#0} on the shop's site.",
 "Closed for today: orders stopped at {0}.","today's orders closed at {0}","orders closed at {0}","Order by {0}:","then order by {0}, arrives {1}","order by {0}, arrives {1}",
 "Updated {0}.","1 product","{#0} products","{#0} from {1}",": {0}, £{#1} (opens in a new tab)","for {0} (opens in a new tab)","on {0} (opens in a new tab)",", sold by {0}","Ideas: {0}","Copy this link: {0}","Today by {0}",
 "Need it today? {0} stops taking same-day orders in","Same-day delivery is open. {0} takes orders until","Same-day: {0} closes in","What kind of {0} are you after?","Language: {0}","Run a local shop near {0}?","Postcode set to {0}.",
]
def rx(t):
    e=re.escape(t)
    for i in range(3): e=e.replace(re.escape('{#%d}'%i),'([\\d.,]+)').replace(re.escape('{%d}'%i),'(.+?)')
    return re.compile('^'+e+'$')
TR=[rx(t) for t in T]
DATE=re.compile(r'^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*( \d{1,2})?( [A-Z][a-z]+)?$')
TIME=re.compile(r'^\d{1,2}(:\d\d)?[ap]m$')
def split_sent(s): return re.split(r'(?<![A-Z]\.[A-Z]\.)(?<=[.!?])\s+(?=[A-Z“])',s)
X=[]
def add(s):
    s=s.strip()
    if s and s not in X and s not in names and not DATE.match(s) and not TIME.match(s) and re.search(r'[A-Za-z]',s): X.append(s)
skip_where=('H4.pname','SPAN.t','SPAN.sbadge','SPAN.pseller','P.pshop','MARK')
for k,v in S.items():
    if any(w.startswith(skip_where) for w in v['where']) and not k in ('Fastest','Cheapest'): 
        if not k in ('Fastest','Cheapest'): continue
    if k in names: continue
    parts=split_sent(k) if len(k)>60 or '. ' in k else [k]
    for p in parts:
        p=p.strip()
        if any(r.match(p) for r in TR): continue
        add(p)
# extra strings from the code that the walkthrough did not reach
extra="""Sending…|That postcode doesn't look right. Try one like SE15 4AB, or leave it blank.|NoLag searches all the shops for you, so type the item you need, for example “kettle” or “phone charger”.|Showing everything, including slower options.|Cheapest overall, any delivery day|Best overall|Delivery time not listed|Order latest|Delivery apps open from 8am.|Shops on the delivery apps open from 8am. Same-day orders are open until this evening.|Cut-off varies by item|Some items must be ordered by 1pm|Search in the Deliveroo app or site|Link copied. Paste it anywhere to share this search.|Sample products for now. Real photos, prices and stock from the shops appear here soon.|Which one do you need?|Which one?|Which kind?|Which charger?|Which cable?|Which fan?|Which fitting?|Which phone?|Which laptop?|Which tablet?|Which watch?|Which vacuum?|Which speaker?|Which coffee machine?|Which printer item?|Which iPhone item?|Which Xbox item?|Which Nintendo item?|Which PS5 item?|Before a trip|Date night|Feeling ill|Game night|Heating broken|Hosting tonight|Moving in|Power cut|Work emergency|Baby essentials|Christmas things|Last-minute birthday|Language|Shop and product names stay in English, because the shops' own websites are in English.|Choose your language|Close language settings|recent|Sorry, that language could not load. Check your connection and try again.""".split('|')
for e in extra: add(e)
# holiday notes, kinds, idea titles, family asks straight from the code
for m in re.findall(r"note:'([^']+)'",src): 
    for p in split_sent(m): add(p)
for m in re.findall(r"\bt:'([^']+)'",src): add(m)
for m in re.findall(r"ask:'([^']+)'",src): add(m)
for m in re.findall(r"\bn:'([^']+)'",src): add(m)
for m in re.findall(r"(?:promise|eta|fee|how|via|note|areaNote|etaBig|etaSmall):'([^']+)'",src):
    for p in split_sent(m): add(p)
for m in re.findall(r'(?:promise|eta|fee|how|via|note):"([^"]+)"',src):
    for p in split_sent(m): add(p)
X=[x for x in X if x not in names and x not in ('doit','help','Amazon takes orders until')]
for late in ['Search for tomorrow','Menu',"Local shops near","Run a local shop?","List it free","Local shop","Example","Delivers itself","Courier delivery","On delivery apps","Collect today","Closed for today","Website","Call","List your shop","Your shop here","An independent shop near you","set by the shop","Delivery:","For local shops","Run an independent shop that can deliver today?","List it on NoLag for free","This page is only in English for now.","Use my location","Finding your location…","Location is off for this site. Type your postcode instead.","We couldn't find a UK postcode near you. Type it instead.","We couldn't get your location. Type your postcode instead."]:
    if late not in X: X.append(late)
json.dump({'x':X,'t':T},open('master.json','w'),indent=0,ensure_ascii=False)
print(len(X),'exact,',len(T),'templates,', sum(len(x.split()) for x in X)+sum(len(t.split()) for t in T),'words')
