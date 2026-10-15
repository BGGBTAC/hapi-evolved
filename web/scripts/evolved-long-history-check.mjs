import { io } from 'socket.io-client';

export async function seedLongHistory(origin, leaseToken, workspace) {
    const exchange=await fetch(`${origin}/api/evolved/runner/token`,{method:'POST',headers:{authorization:`Bearer ${leaseToken}`,'content-type':'application/json'},body:'{}'});
    if(!exchange.ok)throw Error(`History fixture capability failed: ${exchange.status}`);
    const {token}=await exchange.json();
    const response=await fetch(`${origin}/cli/sessions`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({tag:'bounded-long-history',metadata:{path:workspace,host:'synthetic-runner',name:'Long history rendering fixture',flavor:'codex'},agentState:null})});
    if(!response.ok)throw Error(`History fixture session failed: ${response.status}`);
    const {session}=await response.json();
    const socket=io(`${origin}/cli`,{transports:['websocket'],reconnection:false,auth:{token,sessionId:session.id}});
    try {
        await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('History fixture socket timeout')),10000);socket.once('connect',()=>{clearTimeout(timer);resolve()});socket.once('connect_error',reject)});
        for(let i=0;i<700;i++) {
            const data=i===698?{type:'tool-call',callId:'long-history-tool',name:'Bash',input:{command:'printf long-history-expanded-tool'}}
                :i===699?{type:'tool-call-result',callId:'long-history-tool',output:{stdout:'Long history tool result retained',exit_code:0}}
                :{type:'message',message:`History item ${i}\n\n${i===101?'historicalneedlecheck\n\n':''}${'Synthetic prose for layout and anchor checks. '.repeat(25)}`};
            const message=i%2===0&&i!==698?{role:'user',content:{type:'text',text:`Synthetic instruction ${i}`}}:{role:'agent',content:{type:'codex',data}};
            socket.emit('message',{sid:session.id,message,createdAt:Date.now()-900000+i*1000});
        }
        let persisted=false;
        for(let i=0;i<160;i++) {
            const response=await fetch(`${origin}/cli/sessions/${session.id}/messages?afterSeq=699&limit=1`,{headers:{authorization:`Bearer ${token}`}});
            if(response.ok&&(await response.json()).messages?.length){persisted=true;break}
            await new Promise(resolve=>setTimeout(resolve,50));
        }
        if(!persisted)throw Error('Long history did not commit');
    } finally {socket.disconnect()}
    return session.id;
}

export async function checkLongHistory(page, origin, sessionId) {
    await page.addInitScript(()=>{window.__historySkipped=0;document.addEventListener('contentvisibilityautostatechange',event=>{if(event.skipped)window.__historySkipped++},true)});
    await page.goto(`${origin}/sessions/${sessionId}`);
    await page.locator('[data-hapi-virtual-message]').first().waitFor();
    const viewport=page.locator('.chat-scroll-y').first();
    // Grow the real bounded window through its normal older-page loader.
    await page.waitForTimeout(800);
    for(let i=0;i<4;i++) {await viewport.hover();await page.mouse.wheel(0,-100000);await page.waitForTimeout(600)}
    const count=await page.locator('[data-hapi-virtual-message]').count();
    if(count<50||count>800)throw Error(`Unexpected bounded history DOM count: ${count}`);
    const skipped=await page.evaluate(()=>window.__historySkipped);
    if(!skipped)throw Error('Browser did not skip offscreen layout/paint');
    // Native content-visibility retains component state and anchor elements.
    await viewport.evaluate(element=>{element.scrollTop=element.scrollHeight;element.dispatchEvent(new Event('scroll'))});
    const toolToggle=page.locator('button[aria-expanded]').filter({hasText:/1 tool|command|Bash|long-history/i}).last();
    await toolToggle.waitFor({timeout:10000});
    if(await toolToggle.getAttribute('aria-expanded')!=='true')await toolToggle.click();
    const toggleText=await toolToggle.innerText();
    const toolAnchor=await toolToggle.evaluate(element=>element.closest('[data-hapi-virtual-message]')?.getAttribute('data-hapi-virtual-message'));
    await viewport.evaluate(element=>{element.scrollTop=Math.max(0,element.scrollHeight-10000);element.dispatchEvent(new Event('scroll'))});
    await page.waitForTimeout(150);
    await viewport.evaluate(element=>{element.scrollTop=element.scrollHeight;element.dispatchEvent(new Event('scroll'))});
    if(await toolToggle.getAttribute('aria-expanded')!=='true')throw Error('Expanded tool state was lost while offscreen');
    const anchorCount=await page.locator(`[data-hapi-virtual-message="${toolAnchor}"]`).count();
    if(anchorCount!==1)throw Error('Stable tool anchor disappeared/duplicated');
    await page.keyboard.press('Escape');
    await page.getByTestId('session-in-chat-search-toggle').click();
    for(let i=0;i<5;i++){const hint=page.getByRole('button',{name:'Got it',exact:true}).first();if(!await hint.isVisible())break;await hint.click()}
    await page.getByTestId('session-in-chat-search-input').fill('historicalneedlecheck');
    const hit=page.locator('[data-testid^="session-in-chat-search-hit-"]').first();
    await hit.waitFor(); await hit.click();
    const match=page.locator('[data-hapi-source-search-match="true"]');await match.waitFor();
    await page.waitForFunction(()=>{const el=document.querySelector('[data-hapi-source-search-match="true"]');if(!el)return false;const rect=el.getBoundingClientRect();return rect.top>=0&&rect.top<innerHeight});
    const before=await match.evaluate(element=>element.getBoundingClientRect().top);
    await page.waitForTimeout(500);
    const after=await match.evaluate(element=>element.getBoundingClientRect().top);
    if(Math.abs(before-after)>3)throw Error(`Search anchor drifted after render: ${before} -> ${after}`);
    console.log(`PASS long-history: ${count} bounded rendered wrappers, ${skipped} offscreen skips, retained expanded tool (${toggleText.slice(0,60)}), stable historical search anchor`);
}
