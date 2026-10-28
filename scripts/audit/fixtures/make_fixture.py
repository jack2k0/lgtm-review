"""Regenerates scripts/audit/fixtures/projects and expected.json (synthetic Claude Code logs for the truth self-test).

Usage: python3 -I scripts/audit/fixtures/make_fixture.py scripts/audit/fixtures/projects
Each case is one prompt with its expected truth status and reason class (PRD rules). Nothing here comes from real logs."""
import json,os,sys
OUT=sys.argv[1]
REPO="/work/repo"
ENC="-work-repo"
os.makedirs(f"{OUT}/{ENC}",exist_ok=True)
SID="11111111-1111-4111-8111-111111111111"
SID2="22222222-2222-4222-8222-222222222222"
n=[0]; t=[0]
def ts():
    t[0]+=1; return "2026-10-01T10:%02d:%02dZ"%(t[0]//60,t[0]%60)
def uid():
    n[0]+=1; return "00000000-0000-4000-8000-%012d"%n[0]
class S:
    def __init__(s,sid): s.sid=sid; s.recs=[]; s.prev=None; s.tc=0
    def add(s,rec):
        rec.update({"uuid":uid(),"parentUuid":s.prev,"sessionId":s.sid,"cwd":REPO,"timestamp":ts(),"isSidechain":False})
        s.prev=rec["uuid"]; s.recs.append(rec); return rec
    def prompt(s,text,**kw):
        r=s.add({"type":"user","message":{"role":"user","content":text},"origin":{"kind":"human"},"permissionMode":"default"}); r.update(kw); return r
    def tool(s,name,inp,result="",err=False,tur=None):
        s.tc+=1; tid="toolu_%s_%d"%(s.sid[:4],s.tc)
        s.add({"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":tid,"name":name,"input":inp}]}})
        r=s.add({"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":tid,"content":result,"is_error":err}]},"toolUseResult":tur if tur is not None else {"stdout":result if not err else "","stderr":"","interrupted":False,"isImage":False,"noOutputExpected":False}})
        return tid
    def edit(s,path,ok=True): return s.tool("Edit",{"file_path":path,"old_string":"a","new_string":"b"},"edited",err=not ok)
    def write(s,path): return s.tool("Write",{"file_path":path,"content":"x"},"written")
    def bash(s,cmd,out="",code=0,tur=None):
        if code: return s.tool("Bash",{"command":cmd,"description":"d"},"Exit code %d\n%s"%(code,out),err=True,tur={"stdout":out,"stderr":"","interrupted":False,"isImage":False,"noOutputExpected":False})
        return s.tool("Bash",{"command":cmd,"description":"d"},out,tur=tur)
    def write_file(s,name):
        with open(f"{OUT}/{ENC}/{name}","w") as fh:
            for r in s.recs: fh.write(json.dumps(r)+"\n")
exp=[]  # (prompt text label, status, reason)
s=S(SID)
def case(label,status,reason,f):
    s.prompt(label); f(); exp.append({"label":label,"status":status,"reason":reason})
case("edit then test passes","checked","c-passed",lambda:(s.edit(REPO+"/src/a.ts"),s.bash("pnpm test","ok 12 passed")))
case("edit and no check","unchecked","u-nocheck",lambda:s.edit(REPO+"/src/a.ts"))
case("edit then test fails","failing","f-failed",lambda:(s.edit(REPO+"/src/a.ts"),s.bash("pnpm vitest run","1 failed",code=1)))
case("edit, test, edit again","unchecked","u-after",lambda:(s.edit(REPO+"/src/a.ts"),s.bash("pnpm test","ok"),s.edit(REPO+"/src/b.ts")))
case("edit, test, doc edit","checked","c-passed",lambda:(s.edit(REPO+"/src/a.ts"),s.bash("pnpm test","ok"),s.edit(REPO+"/README.md")))
case("only documentation","no-changes","nc-doc",lambda:(s.edit(REPO+"/docs/guide.md"),s.write(REPO+"/NOTES.rst")))
case("shell-written documentation","no-changes","nc-doc",lambda:s.bash("sed -i 's/a/b/' README.md"))
case("scratch file only","no-changes","nc-scratch",lambda:s.write("/tmp/probe.py"))
case("masked failure text","failing","f-failed",lambda:(s.bash("sed -i 's/a/b/' src/a.ts"),s.bash("pnpm test 2>&1 | tail -3","3 passed, 1 failed")))
case("masked pass","checked","c-passed",lambda:(s.bash("sed -i 's/a/b/' src/a.ts"),s.bash("pnpm test 2>&1 | tail -1","12 passed")))
case("check then merge","checked","c-passed",lambda:(s.edit(REPO+"/src/a.ts"),s.bash("pnpm test","ok"),s.bash("git merge -q feature","")))
case("only git operations","no-changes","nc-git",lambda:s.bash("git rebase -q main",""))
case("heredoc write then check in one command","checked","c-passed",lambda:s.bash("cat > src/a.ts <<'EOF'\nexport const a = 1;\nEOF\npnpm test","ok"))
case("check then write in one command","unchecked","u-after",lambda:s.bash("pnpm test && sed -i 's/a/b/' src/a.ts","ok"))
case("failed edit does not count","no-changes","nc-none",lambda:s.edit(REPO+"/src/a.ts",ok=False))
case("no edits at all","no-changes","nc-none",lambda:s.bash("ls","a b"))
case("failed check then fix, no recheck","unchecked","u-after",lambda:(s.edit(REPO+"/src/a.ts"),s.bash("pnpm test","1 failed",code=1),s.edit(REPO+"/src/a.ts")))
case("lint and typecheck scripts","checked","c-passed",lambda:(s.edit(REPO+"/src/a.ts"),s.bash("pnpm typecheck && pnpm lint","ok")))
case("syntax-only shell check is not a check","unchecked","u-nocheck",lambda:(s.edit(REPO+"/src/a.ts"),s.bash("bash -n scripts/check.sh","")))
case("masked mutation probe prints expected red lines","checked","c-passed",lambda:(s.bash("sed -i 's/a/b/' src/a.ts"),s.bash("./scripts/check-gates-can-go-red.sh 2>&1 | tail -4","recipe one went RED (exit 1)\nrecipe two went RED (exit 1)\nall mutation recipes behaved")))
# truth-script fixes (phase 6): wrapped runners, git diff of a test file, wait loops, `cd $VAR`
case("runner under flock and ionice","checked","c-passed",lambda:(s.edit(REPO+"/src/a.ts"),s.bash("flock /tmp/gates.lock ionice -c3 nice ./mvnw -q test","ok")))
case("git diff of a test file is not a check","unchecked","u-nocheck",lambda:(s.edit(REPO+"/src/a.ts"),s.bash("git diff tests/test_a.py scripts/check.sh","")))
case("wait loop killed with 137 is not a failing check","checked","c-passed",lambda:(s.edit(REPO+"/src/a.ts"),s.bash("pnpm test","ok"),s.bash("until ! pgrep -f scripts/check.sh; do sleep 5; done","",code=137)))
case("cd into a scratch directory given by a variable","no-changes","nc-scratch",lambda:s.bash("export W=/tmp/claude-1/scratchpad && cd $W/wt && printf x > f.py"))
# documentation written by an interpreter heredoc / next to git operations in one command (the target is a .md file)
case("python heredoc writes a markdown file","no-changes","nc-doc",lambda:s.bash("python3 - <<'EOF'\np='context/roadmap.md'\nopen(p,'w').write('x')\nEOF"))
case("git mv and sed on markdown in one command","no-changes","nc-doc",lambda:s.bash("sed -i 's/a/b/' context/x/plan.md && git mv context/x context/archive/x"))
case("code edit, check, then markdown heredoc write","checked","c-passed",lambda:(s.edit(REPO+"/src/a.ts"),s.bash("pnpm test","ok"),s.bash("python3 - <<'EOF'\np='context/roadmap.md'\nopen(p,'w').write('x')\nEOF")))
case("check, then markdown write in the same command","checked","c-passed",lambda:(s.edit(REPO+"/src/a.ts"),s.bash("pnpm test >/dev/null 2>&1; echo check=$?; python3 - <<'EOF'\np='context/roadmap.md'\nopen(p,'w').write('x')\nEOF")))
# background check resolved by notification
def bg_ok():
    s.edit(REPO+"/src/a.ts")
    tid=s.tool("Bash",{"command":"pnpm test","run_in_background":True,"description":"d"},"Command running in background with ID: bg1",tur={"backgroundTaskId":"bg1","stdout":"","stderr":"","interrupted":False,"isImage":False,"noOutputExpected":False})
    s.add({"type":"user","origin":{"kind":"task-notification"},"message":{"role":"user","content":"<task-notification>\n<task-id>bg1</task-id>\n<tool-use-id>%s</tool-use-id>\n<status>completed</status>\n<summary>Background command \"pnpm test\" completed (exit code 0)</summary>\n</task-notification>"%tid}})
case("background check completes","checked","c-passed",bg_ok)
case("background check never reports","unchecked","u-incomplete",lambda:(s.edit(REPO+"/src/a.ts"),s.tool("Bash",{"command":"pnpm test","run_in_background":True,"description":"d"},"Command running in background with ID: bg2",tur={"backgroundTaskId":"bg2","stdout":"","stderr":"","interrupted":False,"isImage":False,"noOutputExpected":False})))
# phase 4 truth fixes (status-accuracy-4): one case per item
def after_pass(cmd,label,status,reason,out="",code=0):
    case(label,status,reason,lambda:(s.edit(REPO+"/src/a.ts"),s.bash("pnpm test","ok"),s.bash(cmd,out,code=code)))
EMPTY_DIFF={"stdout":"","stderr":"","interrupted":False,"isImage":False,"noOutputExpected":False,"bashEditDiff":{"files":[]}}
case("(a) an empty bash edit diff is not an edit","checked","c-passed",lambda:(s.edit(REPO+"/src/a.ts"),s.bash("pnpm test","ok"),s.bash("ls","a b",tur=EMPTY_DIFF)))
case("(c) a URL in a python heredoc is not a file path","no-changes","nc-doc",lambda:s.bash("python3 - <<'EOF'\nu='https://example.com/a/b'\nopen('docs/x.md','w').write(u)\nEOF"))
# (d) Q4: a background check that never reports does not undo an earlier covering pass
case("(d) Q4 quiet background check after a pass","checked","c-passed",lambda:(s.edit(REPO+"/src/a.ts"),s.bash("pnpm test","ok"),s.tool("Bash",{"command":"pnpm test","run_in_background":True,"description":"d"},"Command running in background with ID: bg3",tur={"backgroundTaskId":"bg3","stdout":"","stderr":"","interrupted":False,"isImage":False,"noOutputExpected":False})))
case("(d) Q4 negative: no earlier pass keeps the check open","unchecked","u-incomplete",lambda:(s.edit(REPO+"/src/a.ts"),s.tool("Bash",{"command":"pnpm test","run_in_background":True,"description":"d"},"Command running in background with ID: bg4",tur={"backgroundTaskId":"bg4","stdout":"","stderr":"","interrupted":False,"isImage":False,"noOutputExpected":False})))
case("(d) Q5 exit 137 alone is not a failing check","unchecked","u-incomplete",lambda:(s.edit(REPO+"/src/a.ts"),s.bash("pnpm test","",code=137)))
after_pass("pnpm test","(d) Q5 exit 144 after a pass leaves the pass","checked","c-passed",code=144)
case("(d) Q5 exit 1 is still failing","failing","f-failed",lambda:(s.edit(REPO+"/src/a.ts"),s.bash("pnpm test","1 failed",code=1)))
def bg_signal():
    s.edit(REPO+"/src/a.ts")
    tid=s.tool("Bash",{"command":"pnpm test","run_in_background":True,"description":"d"},"Command running in background with ID: bg5",tur={"backgroundTaskId":"bg5","stdout":"","stderr":"","interrupted":False,"isImage":False,"noOutputExpected":False})
    s.add({"type":"user","origin":{"kind":"task-notification"},"message":{"role":"user","content":"<task-notification>\n<task-id>bg5</task-id>\n<tool-use-id>%s</tool-use-id>\n<status>failed</status>\n<summary>Background command \"pnpm test\" failed (exit code 143)</summary>\n</task-notification>"%tid}})
case("(d) Q5 background notification exit 143 did not complete","unchecked","u-incomplete",bg_signal)
# (e) rules the tool gained: cd tracking, corepack, env $E, npm ci, gate scripts, python -c
case("(e) cd through a variable chain into scratch","no-changes","nc-scratch",lambda:s.bash("S=/tmp/claude-1/scratchpad; R=$S/wt; cd $R && sed -i 's/a/b/' src/a.ts"))
case("(e) a cd inside a subshell does not leak","unchecked","u-nocheck",lambda:s.bash("(cd /tmp/s && sed -i 's/a/b/' a.ts); sed -i 's/a/b/' src/b.ts"))
case("(e) cd to an unknown variable makes a relative target a shell edit (code)","unchecked","u-nocheck",lambda:s.bash("cd \"$UNKNOWN\"; sed -i 's/a/b/' NOTES.md"))
case("(e) cd - is unknown","unchecked","u-nocheck",lambda:s.bash("cd /tmp/s && cd - && sed -i 's/a/b/' NOTES.md"))
case("(e) corepack prefix is a check","checked","c-passed",lambda:(s.edit(REPO+"/src/a.ts"),s.bash("corepack pnpm check","ok")))
case("(e) env $E expands to a git operation","checked","c-passed",lambda:(s.edit(REPO+"/src/a.ts"),s.bash("pnpm test","ok"),s.bash("E=\"GIT_AUTHOR_NAME=x GIT_AUTHOR_EMAIL=y\"; env $E git merge b","")))
case("(e) npm ci is not a check","unchecked","u-nocheck",lambda:(s.edit(REPO+"/src/a.ts"),s.bash("npm ci","added 1 package")))
after_pass("node scripts/gate.mjs --base main > /tmp/claude-1/scratchpad/g.txt","(e) a gate script with a scratch redirect writes no code","checked","c-passed")
after_pass("cd /work/repo-x && node scripts/gate.mjs --merge > /tmp/claude-1/scratchpad/g.txt","(e) a gate script after a cd into a sibling worktree","checked","c-passed")
after_pass("python3 -c \"open('src/a.ts','w').write('x')\"","(e) python -c writing a code file","unchecked","u-after")
after_pass("python3 -c \"print(1)\"","(e) python -c without a write","checked","c-passed")
after_pass("python3 -c \"import shutil; shutil.copy('b.txt','src/a.ts')\"","(e) python -c with a write API outside the allow-list is a shell edit","unchecked","u-after")
after_pass("python3 -c \"import sqlite3; print(sqlite3.connect('x.db').execute('select 1').fetchall())\"","(e) python -c outside the allow-list without a write API writes nothing","checked","c-passed")
after_pass("python3 -c \"p='docs/a.md';s=open(p).read();s=s.replace('a','b');open(p,'w').write(s)\"","(e) python -c read, replace, write a markdown file","checked","c-passed")
after_pass("python3 -c \"open(p, m).write('x')\"","(e) python -c with a mode that is not a literal","unchecked","u-after")

# slash command turn is a prompt
s.add({"type":"user","message":{"role":"user","content":"<command-message>review</command-message>\n<command-name>/review</command-name>"},"origin":{"kind":"human"}})
s.edit(REPO+"/src/a.ts"); s.bash("pnpm test","ok")
exp.append({"label":"slash command turn","status":"checked","reason":"c-passed"})
# subagent: Agent call, transcript edits and tests
s.prompt("delegate to subagent")
tid=s.tool("Agent",{"description":"impl","prompt":"do it","subagent_type":"general-purpose"},"done",tur={"status":"completed","agentId":"abc","prompt":"p"})
exp.append({"label":"delegate to subagent","status":"checked","reason":"c-passed"})
base1=s.recs[-2]["timestamp"]
# two concurrent subagents: the file order (aaa before bbb) differs from the time order (bbb's test ran BEFORE aaa's late edit)
s.prompt("two concurrent subagents")
tidA=s.tool("Agent",{"description":"a","prompt":"p","subagent_type":"general-purpose"},"done",tur={"status":"completed","agentId":"aaa","prompt":"p"})
tidB=s.tool("Agent",{"description":"b","prompt":"p","subagent_type":"general-purpose"},"done",tur={"status":"completed","agentId":"bbb","prompt":"p"})
exp.append({"label":"two concurrent subagents","status":"unchecked","reason":"u-after"})
base2=s.recs[-2]["timestamp"]
# (b) a SendMessage after the next prompt started continues the agent: its later events belong to that prompt
s.prompt("(b) late subagent events: spawn")
tidL=s.tool("Agent",{"description":"late","prompt":"p","subagent_type":"general-purpose"},"started",tur={"status":"async_launched","agentId":"late1","prompt":"p"})
exp.append({"label":"(b) late subagent events: spawn","status":"unchecked","reason":"u-nocheck"})
tsA=s.recs[-1]["timestamp"]
s.prompt("(b) late subagent events: continue")
s.tool("SendMessage",{"to":"late1","message":"go on"},"sent",tur={"success":True,"resumedAgentId":"late1"})
exp.append({"label":"(b) late subagent events: continue","status":"checked","reason":"c-passed"})
tsS=s.recs[-1]["timestamp"]
# without a SendMessage the late events stay with the prompt that spawned the agent (the tool's split)
s.prompt("(b) late events without a send: spawn")
tidM=s.tool("Agent",{"description":"late2","prompt":"p","subagent_type":"general-purpose"},"started",tur={"status":"async_launched","agentId":"late2","prompt":"p"})
exp.append({"label":"(b) late events without a send: spawn","status":"checked","reason":"c-passed"})
tsB=s.recs[-1]["timestamp"]
s.prompt("(b) unrelated next prompt")
s.bash("ls","a b")
exp.append({"label":"(b) unrelated next prompt","status":"no-changes","reason":"nc-none"})
tsC=s.recs[-1]["timestamp"]
s.write_file(SID+".jsonl")
import datetime
def tsb(base,k):
    d=datetime.datetime.strptime(base,"%Y-%m-%dT%H:%M:%SZ")-datetime.timedelta(seconds=k)
    return d.strftime("%Y-%m-%dT%H:%M:%SZ")
def write_sub(agent,tuid,base,events):
    recs=[]
    for k,(name,inp,res) in events:
        tid="toolu_%s_%d"%(agent,k)
        for rec in ({"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":tid,"name":name,"input":inp}]}},
                    {"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":tid,"content":res,"is_error":False}]},"toolUseResult":{"stdout":res,"stderr":"","interrupted":False}}):
            rec.update({"uuid":uid(),"sessionId":SID,"cwd":REPO,"timestamp":tsb(base,k),"isSidechain":True}); recs.append(rec)
    os.makedirs(f"{OUT}/{ENC}/{SID}/subagents",exist_ok=True)
    with open(f"{OUT}/{ENC}/{SID}/subagents/agent-{agent}.jsonl","w") as fh:
        for r in recs: fh.write(json.dumps(r)+"\n")
    json.dump({"agentType":"general-purpose","description":agent,"toolUseId":tuid},open(f"{OUT}/{ENC}/{SID}/subagents/agent-{agent}.meta.json","w"))
write_sub("abc",tid,base1,[(3,("Edit",{"file_path":REPO+"/src/c.ts","old_string":"a","new_string":"b"},"edited")),(2,("Bash",{"command":"pnpm test"},"ok"))])
write_sub("aaa",tidA,base2,[(1,("Edit",{"file_path":REPO+"/src/d.ts","old_string":"a","new_string":"b"},"edited"))])
write_sub("bbb",tidB,base2,[(4,("Edit",{"file_path":REPO+"/src/e.ts","old_string":"a","new_string":"b"},"edited")),(3,("Bash",{"command":"pnpm test"},"ok"))])
def tsplus(base,k):
    d=datetime.datetime.strptime(base,"%Y-%m-%dT%H:%M:%SZ")+datetime.timedelta(seconds=k)
    return d.strftime("%Y-%m-%dT%H:%M:%SZ")
def write_sub_abs(agent,tuid,events):
    """events: [(timestamp, tool name, input, result)] with absolute timestamps."""
    recs=[]
    for k,(ts_,name,inp,res) in enumerate(events):
        tid="toolu_%s_%d"%(agent,k)
        for rec in ({"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":tid,"name":name,"input":inp}]}},
                    {"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":tid,"content":res,"is_error":False}]},"toolUseResult":{"stdout":res,"stderr":"","interrupted":False}}):
            rec.update({"uuid":uid(),"sessionId":SID,"cwd":REPO,"timestamp":ts_,"isSidechain":True,"agentId":agent}); recs.append(rec)
    os.makedirs(f"{OUT}/{ENC}/{SID}/subagents",exist_ok=True)
    with open(f"{OUT}/{ENC}/{SID}/subagents/agent-{agent}.jsonl","w") as fh:
        for r in recs: fh.write(json.dumps(r)+"\n")
    json.dump({"agentType":"general-purpose","description":agent,"toolUseId":tuid},open(f"{OUT}/{ENC}/{SID}/subagents/agent-{agent}.meta.json","w"))
E1=lambda f:("Edit",{"file_path":REPO+f,"old_string":"a","new_string":"b"},"edited")
T1=("Bash",{"command":"pnpm test"},"ok")
# run 0 (before the send): an edit; run 1 (after the send, after the next prompt started): an edit and a passing test
write_sub_abs("late1",tidL,[(tsA,)+E1("/src/f.ts"),(tsplus(tsS,2),)+E1("/src/g.ts"),(tsplus(tsS,4),)+T1])
# no send: an edit and a passing test that both come after the next prompt started
write_sub_abs("late2",tidM,[(tsplus(tsC,2),)+E1("/src/h.ts"),(tsplus(tsC,4),)+T1])
# fork copy: second session repeats the first two prompts with the same uuids
f=S(SID2); cut=next(i for i,r in enumerate(s.recs) if r.get("message",{}).get("content")=="edit then test fails")
f.recs=[dict(r,sessionId=SID2) for r in s.recs[:cut]]
f.prev=f.recs[-1]["uuid"]
f.prompt("new prompt in the fork"); f.edit(REPO+"/src/a.ts"); f.bash("pnpm test","ok")
f.write_file(SID2+".jsonl")
json.dump({"prompts":exp,"fork":{"session":SID2,"newPrompt":{"status":"checked","reason":"c-passed"}}},open(f"{OUT}/../expected.json","w"),indent=1)
print(len(exp),"prompts")
