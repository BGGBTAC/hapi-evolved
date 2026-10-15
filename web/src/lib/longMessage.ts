export function isLongMessage(text: string): boolean {
    return text.length > 4000 || text.split('\n').length > 40
}
export function longMessagePreview(text: string): string {
    return text.split('\n').slice(0, 10).join('\n').slice(0, 4000)
}

type TextAttachmentComposer = {
    addAttachment(file: File): Promise<unknown>
    getState(): { attachments: readonly { id: string; file?: File; attachmentId?: string; path?: string; status: { type: string } }[] }
    attachment(selector: { id: string }): { remove(): unknown }
}
export async function addLongTextAttachment(composer: TextAttachmentComposer, file: File, isCurrent: () => boolean): Promise<void> {
    if (!isCurrent()) throw new Error('Composer changed')
    await composer.addAttachment(file)
    if (!isCurrent()) throw new Error('Composer changed')
    // Text uploads preserve File identity. Never guess from the first newly added ID:
    // another upload may have finished concurrently.
    // Aui's client snapshot is updated by a React commit, which may lag behind
    // the adapter promise. Wait for that snapshot; never delete a running upload.
    const deadline = Date.now() + 3000
    let item = composer.getState().attachments.find(item => item.file === file)
    while ((!item || item.status.type === 'running') && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25))
        if (!isCurrent()) throw new Error('Composer changed')
        item = composer.getState().attachments.find(item => item.file === file)
    }
    if (!item || !['requires-action', 'complete'].includes(item.status.type) || (!item.attachmentId && !item.path)) {
        if (item) await composer.attachment({ id: item.id }).remove()
        throw new Error('Text attachment did not finish uploading')
    }
}
