import { Store } from '../src/store'

// Offline restore step. Stop this instance before restoring its database.
const path = process.argv[2]
if (!path || process.argv.length !== 3) {
    console.error('Usage: bun hub/scripts/invalidate-restored-notifications.ts /absolute/path/to/restored-hub.db')
    process.exit(1)
}
if (!path.startsWith('/') || !(await Bun.file(path).exists())) throw new Error('An existing absolute database path is required.')
const store = new Store(path)
try { store.notificationEvents.invalidateCursorsAfterRestore(); console.log('Restored notification cursors invalidated. Consumers must resynchronize.') }
finally { store.close() }
