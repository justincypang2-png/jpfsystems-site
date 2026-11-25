import json,re,sys,os
M=json.load(open('/home/claude/i18n/master.json'))
def compile_lang(code, lines):
    tr={}
    for ln in lines:
        if not ln.strip() or ln.startswith('#'): continue
        k,_,v=ln.partition('|'); tr[k.strip()]=v.strip()
    X={}; T=[]; missing=[]; bad=[]
    for i,en in enumerate(M['x']):
        v=tr.get(str(i))
        if v: X[en]=v
        else: missing.append(str(i))
    for i,en in enumerate(M['t']):
        v=tr.get('t%d'%i)
        if not v: missing.append('t%d'%i); continue
        need=sorted(set(re.findall(r'\{#?(\d)\}',en))); got=sorted(set(re.findall(r'\{#?(\d)\}',v)))
        if need!=got: bad.append(('t%d'%i,en,v)); continue
        T.append([en,v])
    os.makedirs('/home/claude/nolag-site/i18n',exist_ok=True)
    json.dump({'x':X,'t':T},open(f'/home/claude/nolag-site/i18n/{code}.json','w'),ensure_ascii=False,separators=(',',':'))
    return missing,bad
if __name__=='__main__':
    for code in sys.argv[1:]:
        m,b=compile_lang(code,open(f'/home/claude/i18n/src/{code}.txt').read().split('\n'))
        print(code,'missing',len(m),m[:15],'bad',b)
