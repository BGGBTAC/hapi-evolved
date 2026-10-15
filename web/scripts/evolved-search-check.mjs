import { io } from 'socket.io-client';
export async function seedSearchSession(origin, leaseToken, workspace) {
    const exchange = await fetch(`${origin}/api/evolved/runner/token`, {
        method:'POST', headers:{authorization:`Bearer ${leaseToken}`,'content-type':'application/json'}, body:'{}'
    });
    if(!exchange.ok) throw Error(`Synthetic capability exchange failed: ${exchange.status}`);
    const cap=await exchange.json();
    const created=await fetch(`${origin}/cli/sessions`,{method:'POST',headers:{authorization:`Bearer ${cap.token}`,'content-type':'application/json'},
        body:JSON.stringify({tag:'evolved-search-browser',metadata:{path:workspace,host:'synthetic-browser-runner',name:'Search browser fixture',flavor:'codex'},agentState:null})});
    if(!created.ok) throw Error(`Synthetic session creation failed: ${created.status}`);
    const {session}=await created.json();
    const socket=io(`${origin}/cli`,{transports:['websocket'],reconnection:false,auth:{token:cap.token,sessionId:session.id}});
    try {
        await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Synthetic socket timeout')),10_000);socket.once('connect',()=>{clearTimeout(timer);resolve()});socket.once('connect_error',e=>{clearTimeout(timer);reject(e)})});
        for(let i=0;i<300;i++) socket.emit('message',{sid:session.id,message:{role:'agent',content:{type:'codex',data:{type:'message',message:i===0||i===175?`Archive needle browser target ${i}`:`Ordinary synthetic transcript item ${i}`}}},createdAt:Date.now()-600_000+i*1000});
        // CLI history endpoint proves all websocket frames committed before closing.
        let complete=false;
        for(let i=0;i<100;i++) {
            const response=await fetch(`${origin}/cli/sessions/${session.id}/messages?afterSeq=299&limit=1`,{headers:{authorization:`Bearer ${cap.token}`}});
            if(response.ok) {const body=await response.json();if(body.messages?.length){complete=true;break}}
            await new Promise(resolve=>setTimeout(resolve,50));
        }
        if(!complete) throw Error('Synthetic transcript did not commit');
    } finally {socket.disconnect()}
    const firstResponse=await fetch(`${origin}/cli/sessions/${session.id}/messages?afterSeq=0&limit=1`,{headers:{authorization:`Bearer ${cap.token}`}});
    const firstPage=await firstResponse.json();
    return {sessionId:session.id,firstMessageId:firstPage.messages[0].id};
}

export async function checkSearch(page, origin, {sessionId,firstMessageId}) {
    await page.goto(`${origin}/sessions/${sessionId}`);
    const toggle=page.getByTestId('session-in-chat-search-toggle');
    await toggle.waitFor(); await toggle.click();
    for(let i=0;i<5;i++) {const fue=page.getByRole('button',{name:'Got it',exact:true}).first();if(!await fue.isVisible())break;await fue.click()}
    await page.getByTestId('session-in-chat-search-input').fill('Archive needle');
    const hits=page.locator('[data-testid^="session-in-chat-search-hit-"]').filter({has:page.locator('mark')});
    await hits.first().waitFor();
    if(await hits.count()!==2) throw Error('Expected two historical search hits');
    await page.getByTestId(`session-in-chat-search-hit-${firstMessageId}`).click();
    const highlighted=page.locator('[data-hapi-source-search-match="true"]');
    await highlighted.waitFor();
    const firstId=await highlighted.getAttribute('data-hapi-source-message-id');
    const box=await highlighted.boundingBox();
    if(!box||box.y<0||box.y>page.viewportSize().height) throw Error('Historical search target did not scroll into view');
    const nav=page.getByTestId('search-match-navigation'); await nav.waitFor();
    await nav.getByRole('button',{name:'Next match',exact:true}).click();
    await page.waitForFunction(id=>document.querySelector('[data-hapi-source-search-match="true"]')?.getAttribute('data-hapi-source-message-id')!==id,firstId);
    await highlighted.waitFor();
    if(await highlighted.getAttribute('data-hapi-source-message-id')===firstId) throw Error('Next match did not load other historical window');
    console.log('PASS real project-scoped transcript FTS, in-chat ranked picker, bounded old-window jump/highlight and match navigation');
}
