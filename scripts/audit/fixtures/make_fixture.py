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
# slash command turn is a prompt
s.add({"type":"user","message":{"role":"user","content":"<command-message>review</command-message>\n<command-name>/review</command-name>"},"origin":{"kind":"human"}})
s.edit(REPO+"/src/a.ts"); s.bash("pnpm test","ok")
exp.append({"label":"slash command turn","status":"checked","reason":"c-passed"})
# subagent: Agent call, transcript edits and tests
s.prompt("delegate to subagent")
tid=s.tool("Agent",{"description":"impl","prompt":"do it","subagent_type":"general-purpose"},"done",tur={"status":"completed","agentId":"abc","prompt":"p"})
exp.append({"label":"delegate to subagent","status":"checked","reason":"c-passed"})
s.write_file(SID+".jsonl")
# subagent transcript (timestamps fall inside the parent turn: use times just before the parent's Agent result)
sub=S(SID+"-sub")
sub.recs=[]; sub.sid=SID
os.makedirs(f"{OUT}/{ENC}/{SID}/subagents",exist_ok=True)
base=s.recs[-2]["timestamp"]
# write sub records with explicit timestamps earlier than the Agent result
def subrec(rec,tsv):
    rec.update({"uuid":uid(),"sessionId":SID,"cwd":REPO,"timestamp":tsv,"isSidechain":True}); return rec
secs=int(base[-3:-1])
def tsb(k): return base[:-3]+"%02dZ"%(secs-k)
recs=[]
def sub_tool(name,inp,res,k,err=False):
    tid="toolu_sub_%d"%k
    recs.append(subrec({"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":tid,"name":name,"input":inp}]}},tsb(k)))
    recs.append(subrec({"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":tid,"content":res,"is_error":err}]},"toolUseResult":{"stdout":res,"stderr":"","interrupted":False}},tsb(k)))
sub_tool("Edit",{"file_path":REPO+"/src/c.ts","old_string":"a","new_string":"b"},"edited",3)
sub_tool("Bash",{"command":"pnpm test"},"ok",2)
with open(f"{OUT}/{ENC}/{SID}/subagents/agent-abc.jsonl","w") as fh:
    for r in recs: fh.write(json.dumps(r)+"\n")
json.dump({"agentType":"general-purpose","description":"impl","toolUseId":tid},open(f"{OUT}/{ENC}/{SID}/subagents/agent-abc.meta.json","w"))
# fork copy: second session repeats the first two prompts with the same uuids
f=S(SID2); cut=next(i for i,r in enumerate(s.recs) if r.get("message",{}).get("content")=="edit then test fails")
f.recs=[dict(r,sessionId=SID2) for r in s.recs[:cut]]
f.prev=f.recs[-1]["uuid"]
f.prompt("new prompt in the fork"); f.edit(REPO+"/src/a.ts"); f.bash("pnpm test","ok")
f.write_file(SID2+".jsonl")
json.dump({"prompts":exp,"fork":{"session":SID2,"newPrompt":{"status":"checked","reason":"c-passed"}}},open(f"{OUT}/../expected.json","w"),indent=1)
print(len(exp),"prompts")
