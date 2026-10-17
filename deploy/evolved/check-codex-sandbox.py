#!/usr/bin/env python3
"""Synthetic native Codex sandbox acceptance. No model turns or stored credentials.
Run inside an already isolated runner container; creates only a temporary directory.
"""
import ctypes, errno, json, os, pathlib, platform, queue, shutil, socketserver, subprocess, tempfile, threading, time
root=pathlib.Path(tempfile.mkdtemp(prefix='hapi-codex-network-probe-'))
native_home=root/'codex'; native_home.mkdir()
workspace=root/'workspace'; workspace.mkdir()
(native_home/'config.toml').write_text('''model = "mock-model"
model_provider = "mock"
check_for_update_on_startup = false
[model_providers.mock]
name = "Synthetic no inference"
base_url = "http://127.0.0.1:9/v1"
wire_api = "responses"
requires_openai_auth = false
[analytics]
enabled = false
[feedback]
enabled = false
''')
environment={'PATH':os.environ['PATH'],'HOME':str(root),'CODEX_HOME':str(native_home),'LANG':'C.UTF-8'}
proc=subprocess.Popen(['codex','app-server','-c','sandbox_workspace_write.network_access=true'],cwd=workspace,env=environment,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,bufsize=1)
messages=queue.Queue()
def reader():
 for line in proc.stdout:
  try: messages.put(json.loads(line))
  except ValueError: pass
threading.Thread(target=reader,daemon=True).start()
class Echo(socketserver.BaseRequestHandler):
 def handle(self): self.request.sendall(b'synthetic-network-proof')
endpoint=socketserver.TCPServer(('127.0.0.1',0),Echo)
threading.Thread(target=endpoint.serve_forever,daemon=True).start()
seq=0
notifications=[]
def rpc(method,params):
 global seq
 seq+=1
 proc.stdin.write(json.dumps({'id':seq,'method':method,'params':params})+'\n'); proc.stdin.flush()
 deadline=time.monotonic()+10
 while time.monotonic()<deadline:
  msg=messages.get(timeout=max(.01,deadline-time.monotonic()))
  if msg.get('id')==seq:
   if 'error' in msg: raise RuntimeError(json.dumps(msg['error']))
   return msg.get('result')
  notifications.append(msg)
 raise RuntimeError('RPC timeout')
# Even outside Codex's inner sandbox, an ordinary process cannot create a mount
# namespace without a new user namespace, or mount over an arbitrary path.
libc=ctypes.CDLL(None,use_errno=True)
result={'inferenceCalls':0,'cases':[]}
def assert_confined(pid):
 status=dict(line.split(':',1) for line in pathlib.Path(f'/proc/{pid}/status').read_text().splitlines() if ':' in line)
 assert all(int(uid)!=0 for uid in status['Uid'].split()), 'Native process must not run as root'
 assert all(int(status[key].strip(),16)==0 for key in ['CapEff','CapPrm','CapBnd']), 'Native process retains capabilities'
 assert status['NoNewPrivs'].strip()=='1' and status['Seccomp'].strip()=='2'
 assert pathlib.Path(f'/proc/{pid}/attr/current').read_text().strip()=='hapi-evolved-runner (enforce)'
try:
 namespace_denied=libc.unshare(0x00020000)==-1 and ctypes.get_errno()==errno.EPERM
 mount_denied=libc.mount(b'tmpfs',str(workspace).encode(),b'tmpfs',0,None)==-1 and ctypes.get_errno() in (errno.EPERM,errno.EACCES)
 assert namespace_denied and mount_denied, 'Outer container unexpectedly permits privileged namespace/mount operations'
 network_namespace_denied=libc.unshare(0x50000000)==-1 and ctypes.get_errno()==errno.EPERM
 clone_probe='''import ctypes,errno,json,os,platform
libc=ctypes.CDLL(None,use_errno=True)
number={'x86_64':56,'aarch64':220}[platform.machine()]
pid=libc.syscall(number,ctypes.c_ulong(0x78020011),None,None,None,0)
error=ctypes.get_errno()
if pid==0:os._exit(0)
if pid>0:os.waitpid(pid,0)
print(json.dumps(pid==-1 and error==errno.EPERM))
'''
 clone_network_denied=json.loads(subprocess.check_output(['python3','-c',clone_probe],env=environment,text=True,timeout=5))
 assert network_namespace_denied and clone_network_denied, 'Network namespace creation must remain denied'
 assert_confined('self');assert_confined(proc.pid)
 result.update({'outerNamespaceDenied':namespace_denied,'outerMountDenied':mount_denied,
  'networkNamespaceDenied':network_namespace_denied,'cloneNetworkNamespaceDenied':clone_network_denied,
  'appServerUnprivileged':True,'outerEnforceAndSeccomp':True,
  'version':subprocess.check_output(['codex','--version'],env=environment,text=True).strip()})
 rpc('initialize',{'clientInfo':{'name':'hapi-network-proof','version':'1'},'capabilities':{'experimentalApi':True}})
 proc.stdin.write(json.dumps({'method':'initialized'})+'\n');proc.stdin.flush()
 for mode in ('read-only','workspace-write'):
  started=rpc('thread/start',{'cwd':str(workspace),'sandbox':mode,'approvalPolicy':'never' if mode=='read-only' else 'on-request','historyMode':'legacy','config':{'sandbox_workspace_write.writable_roots':[str(workspace)],'sandbox_workspace_write.exclude_tmpdir_env_var':True,'sandbox_workspace_write.exclude_slash_tmp':True}})
  tid=started['thread']['id']
  rpc('thread/metadata/update',{'threadId':tid,'gitInfo':{'branch':'synthetic-proof'}})
  original=started['sandbox']
  policy=dict(original,networkAccess=True)
  rpc('thread/settings/update',{'threadId':tid,'sandboxPolicy':policy})
  # Settings ACK only queues a mutation. A subscription resume serializes after it.
  resumed=rpc('thread/resume',{'threadId':tid,'excludeTurns':True})
  after=resumed['sandbox']
  assert after==policy,(mode,original,after)
  again=rpc('thread/resume',{'threadId':tid,'excludeTurns':True})
  assert again['sandbox']==policy
  command_code='''import json,pathlib,socket,subprocess,sys
s=socket.create_connection(('127.0.0.1',int(sys.argv[1])),2)
network=s.recv(64)==b'synthetic-network-proof';s.close()
status=pathlib.Path('/proc/self/status').read_text()
assert 'NoNewPrivs:\t1' in status
assert 'CapEff:\t0000000000000000' in status
assert 'CapPrm:\t0000000000000000' in status
assert 'CapBnd:\t0000000000000000' in status
assert 'Seccomp:\t2' in status
assert pathlib.Path('/proc/self/attr/current').read_text().strip()=='hapi-evolved-runner (enforce)'
tools={name:subprocess.check_output([name,'--version'],text=True,timeout=3).strip() for name in ['git','node','bun']}
writes=[]
for filename in sys.argv[2:]:
 try:pathlib.Path(filename).write_text('synthetic');writes.append(True)
 except OSError:writes.append(False)
print(json.dumps({'network':network,'writes':writes,'tools':tools}))
'''
  execution=rpc('command/exec',{'command':['python3','-c',command_code,str(endpoint.server_address[1]),str(workspace/(mode+'-inside')),str(root/(mode+'-outside'))],'cwd':str(workspace),'sandboxPolicy':after,'timeoutMs':5000,'outputBytesCap':2048})
  assert execution['exitCode']==0,execution
  proof=json.loads(execution['stdout'])
  assert proof['network'] is True and proof['writes']==[mode=='workspace-write',False],proof
  assert set(proof['tools'])=={'git','node','bun'} and all(proof['tools'].values())
  result['cases'].append({'mode':mode,'initialPolicy':original,'updatedPolicy':after,'actualCommandProof':proof,'secondResumePreservesPolicy':True,'filesystemFieldsUnchanged':{k:v for k,v in original.items() if k!='networkAccess'}=={k:v for k,v in after.items() if k!='networkAccess'}})
 result['passed']=True
finally:
 endpoint.shutdown();endpoint.server_close()
 proc.terminate()
 try:proc.wait(timeout=5)
 except subprocess.TimeoutExpired:proc.kill();proc.wait()
 result['processExited']=proc.poll() is not None
 shutil.rmtree(root)
 print(json.dumps(result,indent=2))
