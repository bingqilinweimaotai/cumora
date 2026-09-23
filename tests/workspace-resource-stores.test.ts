import assert from 'node:assert/strict'
import { after, before, test, mock } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer, type ViteDevServer } from 'vite'

let server: ViteDevServer
let auth: typeof import('../src/stores/auth')
let api: typeof import('../src/api/client')['api']
let documents: typeof import('../src/stores/documents')['useDocuments']
let boards: typeof import('../src/stores/boards')['useBoards']
let calendar: typeof import('../src/stores/calendar')['useCalendar']
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

before(async () => {
  const storage = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  } })
  // Load the real frontend modules with Vite's env and alias handling.
  server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('..', import.meta.url)),
    resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
    server: { middlewareMode: true, watch: null },
    appType: 'custom',
  })
  auth = await server.ssrLoadModule('/src/stores/auth.ts') as typeof auth
  const client = await server.ssrLoadModule('/src/api/client.ts')
  api = client.api
  mock.method(client.ws, 'reconnect', () => {})
  documents = (await server.ssrLoadModule('/src/stores/documents.ts')).useDocuments
  boards = (await server.ssrLoadModule('/src/stores/boards.ts')).useBoards
  calendar = (await server.ssrLoadModule('/src/stores/calendar.ts')).useCalendar
})

after(async () => {
  mock.restoreAll()
  await server?.close()
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor)
  else Reflect.deleteProperty(globalThis, 'localStorage')
})

async function switchWorkspace(id: string) {
  const resets = [documents, boards, calendar].map((store) => new Promise<void>((resolve) => {
    const unsubscribe = store.subscribe(() => { unsubscribe(); resolve() })
  }))
  auth.useAuth.getState().setActiveCompany(id)
  await Promise.all(resets)
}

function deferred() {
  let resolve!: (value: any) => void
  let reject!: (error: Error) => void
  const promise = new Promise<any>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

for (const path of ['documents.load', 'documents.reload', 'boards.loadList', 'calendar.load', 'calendar.reload']) {
  for (const outcome of ['success', 'failure', 'before-new-result', 'failure-before-new-result', 'switch-back']) {
    test(`${path}: ignores stale ${outcome} after a workspace switch`, async () => {
      await switchWorkspace(`${path}-${outcome}-A`)
      const isDocuments = path.startsWith('documents')
      const isBoards = path.startsWith('boards')
      const store = isDocuments ? documents : isBoards ? boards : calendar
      const method = path.split('.')[1]
      const load = () => (store.getState() as any)[method]() as Promise<void>
      const response = (id: string) => {
        const rows = [{ id, title: id, startAt: '2026-09-16T00:00:00Z' }]
        return isDocuments ? { documents: rows } : isBoards ? rows : { events: rows }
      }
      const requestA = deferred()
      const requestB = deferred()
      const beforeNewResult = outcome.endsWith('before-new-result')
      const apiMethod = isDocuments ? 'listDocuments' : isBoards ? 'listBoards' : 'listCalendarEvents'
      let calls = 0
      const stub = mock.method(api, apiMethod, () => (++calls === 1 ? requestA.promise : requestB.promise))
      try {
        // Observe rejection immediately: documents/boards intentionally propagate API errors.
        const oldLoad = load().catch(() => {})
        await switchWorkspace(`${path}-${outcome}-B`)
        if (outcome === 'switch-back') await switchWorkspace(`${path}-${outcome}-A`)
        const newLoad = load()
        if (!beforeNewResult) {
          requestB.resolve(response('current'))
          await newLoad
          if (isDocuments) documents.getState().select('current')
        }
        const expected = store.getState()
        if (outcome.startsWith('failure')) requestA.reject(new Error('old workspace failed'))
        else requestA.resolve(response('stale'))
        await oldLoad
        assert.deepEqual(store.getState(), expected)
        if (beforeNewResult) {
          requestB.resolve(response('current'))
          await newLoad
        }
        const state = store.getState() as any
        assert.equal((isDocuments || isBoards ? state.list : state.events)[0].id, 'current')
        if (!isBoards) {
          assert.equal(state.loaded, true)
          await (store.getState() as any).load()
          assert.equal(calls, 2)
        }
      } finally {
        stub.mock.restore()
      }
    })
  }
}
