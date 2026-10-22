import { io } from 'socket.io-client';

export async function checkComposer(page, origin, {sessionId}) {
    const lease = await page.evaluate(async () => {
        const me=await (await fetch('/api/evolved/me')).json(), projectId=me.accessibleProjects.find(p=>p.name==='Browsercheck').id;
        const response=await fetch(`/api/evolved/projects/${projectId}/runner-leases`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Synthetic composer browser',scopes:['runner:connect'],expiresInSeconds:600})});
        if(!response.ok)throw Error(`Synthetic composer lease failed: ${response.status}`);
        return {...await response.json(),projectId};
    });
    let socket;
    try {
        const exchange=await fetch(`${origin}/api/evolved/runner/token`,{method:'POST',headers:{authorization:`Bearer ${lease.token}`,'content-type':'application/json'},body:'{}'});
        if(!exchange.ok)throw Error(`Synthetic composer exchange failed: ${exchange.status}`);
        const {token}=await exchange.json();
        socket=io(`${origin}/cli`,{transports:['websocket'],reconnection:false,auth:{token,sessionId,clientType:'session-scoped'}});
        await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Synthetic composer socket timeout')),10_000);socket.once('connect',()=>{clearTimeout(timer);resolve()});socket.once('connect_error',e=>{clearTimeout(timer);reject(e)})});
        socket.emit('session-alive',{sid:sessionId,time:Date.now(),thinking:false});
        await page.goto(`${origin}/sessions/${sessionId}`);
        await page.getByTestId('composer-shell').waitFor();
        for(let i=0;i<5;i++){const fue=page.getByRole('button',{name:'Got it',exact:true}).first();if(!await fue.isVisible())break;await fue.click()}
        const editor=page.getByTestId('composer-shell').getByRole('textbox').first();
        const text='EXACT_LONG_PASTE\n'+Array.from({length:45},(_,i)=>`synthetic original line ${i}`).join('\n');
        await editor.evaluate((element,text)=>{const clipboardData=new DataTransfer();clipboardData.setData('text/plain',text);element.dispatchEvent(new ClipboardEvent('paste',{clipboardData,bubbles:true,cancelable:true}))},text);
        await page.getByRole('dialog',{name:'Large pasted text'}).waitFor();
        const textUpload=page.waitForRequest(r=>new URL(r.url()).pathname===`/api/sessions/${sessionId}/upload`&&r.method()==='POST');
        await page.getByRole('button',{name:'Send as .txt',exact:true}).click();
        const uploadedText=(await textUpload).postDataJSON();
        if(Buffer.from(uploadedText.content,'base64').toString('utf8')!==text||uploadedText.mimeType!=='text/plain')throw Error('Long paste content changed');
        await page.getByRole('dialog',{name:'Large pasted text'}).waitFor({state:'detached'});
        const png=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;const c=canvas.getContext('2d');c.fillStyle='#b45128';c.fillRect(0,0,32,32);return canvas.toDataURL('image/png').split(',')[1]});
        const original=Buffer.concat([Buffer.from(png,'base64'),Buffer.alloc(5*1024*1024)]);
        const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Attach file',exact:true}).click();
        const imageUpload=page.waitForRequest(r=>new URL(r.url()).pathname===`/api/sessions/${sessionId}/upload`&&r.method()==='POST');
        await (await chooser).setFiles({name:'synthetic-opaque.png',mimeType:'image/png',buffer:original});
        const optimized=(await imageUpload).postDataJSON();
        if(optimized.mimeType!=='image/jpeg'||!optimized.filename.endsWith('.jpg')||Buffer.from(optimized.content,'base64').length>=original.length)throw Error('Large opaque image was not compressed');
        const originalUpload=page.waitForRequest(r=>new URL(r.url()).pathname===`/api/sessions/${sessionId}/upload`&&r.method()==='POST');
        await page.getByRole('button',{name:'Original senden',exact:true}).click();
        const restored=(await originalUpload).postDataJSON();
        if(restored.mimeType!=='image/png'||!Buffer.from(restored.content,'base64').equals(original))throw Error('Original image bytes not preserved');
        // Upstream #2026: any pasted file attaches, not only images. Clipboard text next to the files
        // (as file managers provide) must neither open the long-text dialog nor reach the editor.
        const pdf=Buffer.concat([Buffer.from('%PDF-1.4\n%synthetic\n'),Buffer.from(Array.from({length:4096},(_,i)=>(i*37+11)%256)),Buffer.from('\n%%EOF\n')]);
        const zip=Buffer.concat([Buffer.from([0x50,0x4b,0x05,0x06]),Buffer.alloc(18)]);
        const sidecarText='SYNTHETIC_FILE_PASTE_TEXT\n'+Array.from({length:45},(_,i)=>`sidecar line ${i}`).join('\n');
        const fileUploads=[];const collect=request=>{if(new URL(request.url()).pathname===`/api/sessions/${sessionId}/upload`&&request.method()==='POST')fileUploads.push(request.postDataJSON())};
        page.on('request',collect);
        try {
            const editorBefore=await editor.evaluate(element=>'value' in element?element.value:element.textContent);
            await editor.evaluate((element,{pdf,zip,text})=>{const clipboardData=new DataTransfer();clipboardData.items.add(new File([new Uint8Array(pdf)],'synthetic-report.pdf',{type:'application/pdf'}));clipboardData.items.add(new File([new Uint8Array(zip)],'synthetic-archive.zip',{type:'application/zip'}));clipboardData.setData('text/plain',text);element.dispatchEvent(new ClipboardEvent('paste',{clipboardData,bubbles:true,cancelable:true}))},{pdf:[...pdf],zip:[...zip],text:sidecarText});
            for(let i=0;i<100&&fileUploads.length<2;i++)await page.waitForTimeout(100);
            if(fileUploads.length!==2)throw Error(`Expected two non-image paste uploads, saw ${fileUploads.length}`);
            const byName=Object.fromEntries(fileUploads.map(upload=>[upload.filename,upload]));
            const pdfUpload=byName['synthetic-report.pdf'], zipUpload=byName['synthetic-archive.zip'];
            if(pdfUpload?.mimeType!=='application/pdf'||!Buffer.from(pdfUpload.content,'base64').equals(pdf))throw Error('Pasted PDF bytes or type changed');
            if(zipUpload?.mimeType!=='application/zip'||!Buffer.from(zipUpload.content,'base64').equals(zip))throw Error('Pasted ZIP bytes or type changed');
            if(await page.getByRole('dialog',{name:'Large pasted text'}).count())throw Error('File paste opened the long-text dialog');
            const editorAfter=await editor.evaluate(element=>'value' in element?element.value:element.textContent);
            if(editorAfter!==editorBefore||editorAfter.includes('SYNTHETIC_FILE_PASTE_TEXT'))throw Error('Clipboard text beside pasted files reached the editor');
            for(const name of ['synthetic-report.pdf','synthetic-archive.zip'])await page.getByTestId('composer-shell').getByText(name,{exact:false}).first().waitFor();
        } finally {page.off('request',collect)}
        console.log('PASS real long-paste .txt choice and exact bytes; browser canvas optimization of >4MiB opaque PNG and exact original-version switch; pasted PDF+ZIP clipboard files attach with exact bytes/types while sidecar text stays out of the editor and long-text dialog');
    } finally {
        socket?.disconnect();
        await page.evaluate(async lease=>{await fetch(`/api/evolved/projects/${lease.projectId}/runner-leases/${lease.id}`,{method:'DELETE'})},lease);
    }
}
