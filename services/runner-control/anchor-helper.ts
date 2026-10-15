import { pinWorkspaceInHost, validWorkspaceIdentity } from './workspaceAnchor'
if(import.meta.main){
    const [state,projectId,rootPath,device,inode]=process.argv.slice(2)
    try{
        if(process.argv.length!==7||!state||!projectId||!rootPath)throw new Error('Invalid helper arguments')
        const expected=device||inode?{device:device!,inode:inode!}:undefined
        if(expected&&!validWorkspaceIdentity(expected))throw new Error('Invalid workspace identity')
        console.log(JSON.stringify(await pinWorkspaceInHost(state,projectId,rootPath,expected)))
    }catch{console.error('Workspace anchor validation failed');process.exit(1)}
}
