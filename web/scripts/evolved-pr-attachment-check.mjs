export async function checkPrAndAttachments(page, origin, {sessionId}) {
    const prepared = await page.evaluate(async sid => {
        const me = await (await fetch('/api/evolved/me')).json(); const projectId = me.accessibleProjects.find(p => p.name === 'Browsercheck').id;
        const {token} = await (await fetch(`/api/evolved/session-token?projectId=${projectId}`)).json();
        const headers = {authorization:`Bearer ${token}`, 'x-hapi-project-id':projectId, 'content-type':'application/json'};
        const request = async (path,method='GET',body) => fetch(path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
        const enabled = await request('/api/features','PATCH',{githubPrAwareness:true}); if(!enabled.ok)throw Error(`PR enable: ${enabled.status}`);
        const uploaded = await request(`/api/sessions/${sid}/upload`,'POST',{filename:'durable-browser.txt',content:btoa('SYNTHETIC_DURABLE_ATTACHMENT'),mimeType:'text/plain'});
        const body=await uploaded.json(); if(!uploaded.ok||!body.attachmentId) throw Error(`Durable upload: ${uploaded.status} ${JSON.stringify(body)}`);
        const original=await request(`/api/sessions/${sid}/attachments/${body.attachmentId}/original`);
        if(await original.text()!=='SYNTHETIC_DURABLE_ATTACHMENT')throw Error('Durable attachment bytes mismatch');
        if(original.headers.get('cache-control')!=='private, no-store')throw Error('Durable attachment cache policy');
        const foreign=await fetch(`/api/sessions/${sid}/attachments/${body.attachmentId}/original`,{headers:{...headers,'x-hapi-project-id':'foreign-project'}});
        if(![401,403,404].includes(foreign.status))throw Error('Crossproject attachment access succeeded');
        return {projectId};
    },sessionId);
    await page.goto(`${origin}/sessions/${sessionId}`);
    for(let i=0;i<5;i++){const fue=page.getByRole('button',{name:'Got it',exact:true}).first();if(!await fue.isVisible())break;await fue.click()}
    await page.getByRole('button',{name:'Link GitHub PR',exact:true}).click();
    await page.getByRole('textbox',{name:'PR URL or owner/repository#number'}).fill('BGGBTAC/hapi-evolved#1');
    await page.getByRole('button',{name:'Save PR link',exact:true}).click();
    const pr=page.getByRole('link',{name:'BGGBTAC/hapi-evolved#1',exact:true});await pr.waitFor();
    if(await pr.getAttribute('href')!=='https://github.com/BGGBTAC/hapi-evolved/pull/1')throw Error('Canonical PR link missing');
    await page.reload();await pr.waitFor();
    await page.getByRole('button',{name:'Link GitHub PR',exact:true}).click();
    await page.getByRole('button',{name:'Unlink PR',exact:true}).click();
    await pr.waitFor({state:'detached'});
    console.log('PASS real passkey-scoped PR link persistence/unlink and durable attachment upload/original with foreign-project denial');
    return prepared;
}
