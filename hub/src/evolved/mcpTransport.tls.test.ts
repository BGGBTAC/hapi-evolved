import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Actual Bun HTTPS sockets against an isolated Node TLS server and ephemeral CA.
// The fixture changes only port/CA and passes loopback to the shared socket-options
// builder. Production resolves and rejects non-public addresses before that builder.
test('Bun pins TLS destination/Host/SNI, verifies certificates, and refuses proxy environment before any request', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hapi-mcp-tls-'))
    const key = join(directory, 'fixture.key'), cert = join(directory, 'fixture.crt')
    let proxyRequests = 0
    const proxy = createServer((_request, response) => { proxyRequests++; response.writeHead(502); response.end() })
    proxy.on('connect', (_request, socket) => { proxyRequests++; socket.destroy() })
    let server: ReturnType<typeof Bun.spawn> | undefined
    try {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key, '-out', cert, '-subj', '/CN=mcp-rebind.invalid', '-addext', 'subjectAltName=DNS:mcp-rebind.invalid'], { stdio: 'ignore' })
        server = Bun.spawn(['node', '-e', `
            const https=require('node:https'),fs=require('node:fs');
            const server=https.createServer({key:fs.readFileSync(process.argv[1]),cert:fs.readFileSync(process.argv[2])},(req,res)=>{
                res.setHeader('content-type','application/json');
                res.end(JSON.stringify({host:req.headers.host,servername:req.socket.servername,destination:req.socket.localAddress,path:req.url}));
            });
            server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port})));
        `, key, cert], { stdout: 'pipe', stderr: 'pipe' })
        const stream = server.stdout as ReadableStream<Uint8Array>, reader = stream.getReader()
        const initial = await reader.read(); reader.releaseLock()
        const port = JSON.parse(new TextDecoder().decode(initial.value)).port as number
        await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
        const proxyPort = (proxy.address() as { port: number }).port
        const source = new URL('./mcpTransport.ts', import.meta.url).pathname
        const script = `
            import {request} from 'node:https';
            import {readFileSync} from 'node:fs';
            import {pinnedMcpRequestOptions,createPinnedMcpFetch} from ${JSON.stringify(source)};
            const requestOnce=async(hostname,trusted)=>{
                let lookups=0;
                const opts=pinnedMcpRequestOptions(new URL('https://'+hostname+'/mcp'),{address:'127.0.0.1',family:4},{'content-type':'application/json'},AbortSignal.timeout(3000));
                const pin=opts.lookup;
                opts.lookup=(...args)=>{lookups++;return pin(...args)};
                return await new Promise((resolve,reject)=>{
                    const req=request({...opts,port:${port},...(trusted?{ca:readFileSync(${JSON.stringify(cert)})}:{})},response=>{
                        let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>resolve({body:JSON.parse(body),lookups}));
                    });
                    req.on('error',reject);req.end('{}');
                });
            };
            const valid=await requestOnce('mcp-rebind.invalid',true);
            let wrongNameRejected=false,untrustedRejected=false;
            try{await requestOnce('wrong-name.invalid',true)}catch{wrongNameRejected=true}
            try{await requestOnce('mcp-rebind.invalid',false)}catch{untrustedRejected=true}
            const proxyGuards=[];
            for(const variable of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy']){
                process.env[variable]='http://127.0.0.1:${proxyPort}';
                // NO_PROXY must not override the safety boundary.
                process.env.NO_PROXY='*';
                let lookups=0,code;
                const fetcher=createPinnedMcpFetch({endpoint:'https://mcp-rebind.invalid/mcp',credential:{mode:'none'}},async()=>{},AbortSignal.timeout(3000),{lookup:async()=>{lookups++;return[{address:'93.184.216.34',family:4}]}});
                try{await fetcher('https://mcp-rebind.invalid/mcp',{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})})}catch(error){code=error.code}
                proxyGuards.push({variable,lookups,code});delete process.env[variable];
            }
            console.log(JSON.stringify({valid,wrongNameRejected,untrustedRejected,proxyGuards}));
        `
        const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe', env: {
            ...process.env, HTTPS_PROXY: '', HTTP_PROXY: '', ALL_PROXY: '', https_proxy: '', http_proxy: '', all_proxy: '', NO_PROXY: '', no_proxy: '',
        } })
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
        expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
        const result = JSON.parse(stdout)
        expect(result.valid.body).toEqual({ host: `mcp-rebind.invalid:${port}`, servername: 'mcp-rebind.invalid', destination: '127.0.0.1', path: '/mcp' })
        expect(result.valid.lookups).toBe(1)
        expect(result.wrongNameRejected).toBe(true)
        expect(result.untrustedRejected).toBe(true)
        expect(result.proxyGuards).toHaveLength(6)
        for (const guard of result.proxyGuards) expect(guard).toMatchObject({ lookups: 0, code: 'mcp_proxy_unsupported' })
        expect(proxyRequests).toBe(0)
    } finally {
        server?.kill(); await server?.exited
        await new Promise<void>(resolve => { proxy.closeAllConnections(); proxy.close(() => resolve()) })
        rmSync(directory, { recursive: true, force: true })
    }
}, 15_000)
