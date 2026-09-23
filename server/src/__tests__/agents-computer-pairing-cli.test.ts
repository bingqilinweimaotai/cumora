import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Exercise the actual CLI dispatcher, PATH scan, .cmd version probes, and
// pairing request. The local server refuses pairing before config/service writes.
test('Windows pairing CLI distinguishes policy refusal from missing engines', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-pairing-cli-'))
  const requests: Array<{ path: string; body: Record<string, unknown> }> = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ path: req.url ?? '', body: JSON.parse(body) })
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'fixture pairing rejected' }))
  })
  try {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const serverUrl = `http://127.0.0.1:${address.port}`

    async function run(name: string, engines: Record<string, string>, preferred: string, compatibility = false) {
      const dir = join(root, name)
      const bin = join(dir, 'bin')
      const home = join(dir, 'home')
      await mkdir(bin, { recursive: true })
      await mkdir(home)
      for (const [id, version] of Object.entries(engines)) {
        await writeFile(join(bin, `${id}.cmd`), `@echo off\r\necho ${version}\r\n`)
      }
      // Windows env names are case-insensitive; remove inherited Path variants.
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['path', 'node_options', 'cumora_byoa_allow_unsandboxed'].includes(key.toLowerCase())))
      Object.assign(env, {
        PATH: [bin, join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(delimiter),
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
        USERPROFILE: home,
        HOME: home,
        CUMORA_BYOA_ALLOW_UNSANDBOXED: compatibility ? '1' : '0',
      })
      let output = ''
      try {
        await execFileAsync(process.execPath, [
          '--import', import.meta.resolve('tsx'),
          fileURLToPath(new URL('../cli-bin.ts', import.meta.url)),
          'agent', 'computer', '--pair', 'fixture-code', '--server', serverUrl,
          '--engine', preferred, '--install-service',
        ], { cwd: dir, env, timeout: 20_000, windowsHide: true })
        assert.fail('the fixture must stop before installing a service')
      } catch (error) {
        const result = error as Error & { code?: number; killed?: boolean; stdout?: string; stderr?: string }
        assert.equal(result.code, 1, result.message)
        assert.ok(!result.killed, 'CLI must fail promptly, not time out')
        output = `${result.stdout ?? ''}${result.stderr ?? ''}`
      }
      assert.deepEqual(await readdir(home), [], 'pairing failure must not write config or supervisor files')
      return output
    }

    await t.test('installed Pi with runnable Codex produces the PowerShell compatibility hint', async () => {
      const output = await run('installed-pi', { claude: '2.1.199', codex: '0.138.0', pi: '0.85.1' }, 'pi')
      assert.match(output, /pi is installed but cannot run/)
      assert.ok(output.includes("$env:CUMORA_BYOA_ALLOW_UNSANDBOXED = '1'"))
      assert.doesNotMatch(output, /pi (?:is not installed|was not found)/)
      assert.equal(requests.length, 0)
      const assignment = output.split('\n').find((line) => line.trim().startsWith('$env:'))?.trim()
      assert.ok(assignment)
      const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const result = await execFileAsync(powershell, [
        '-NoProfile', '-NonInteractive', '-Command',
        `${assignment}; [Console]::Write($env:CUMORA_BYOA_ALLOW_UNSANDBOXED)`,
      ], { timeout: 10_000, windowsHide: true })
      assert.equal(result.stdout, '1', 'the displayed assignment must work in PowerShell')
    })
    await t.test('missing Pi is diagnosed from the unfiltered PATH inventory', async () => {
      const output = await run('missing-pi', { claude: '2.1.199', codex: '0.138.0' }, 'pi')
      assert.match(output, /pi was not found on PATH\. Installed: claude, codex\./)
      assert.equal(requests.length, 0)
    })
    await t.test('Pi alone still receives its specific policy refusal', async () => {
      const output = await run('only-pi', { pi: '0.85.1' }, 'pi')
      assert.match(output, /pi is installed but cannot run/)
      assert.equal(requests.length, 0)
    })
    await t.test('an old Codex receives the version refusal and PowerShell hint', async () => {
      const output = await run('old-codex', { codex: '0.137.9' }, 'codex')
      assert.match(output, /version 0.137.9 is older than the secure minimum 0.138.0/)
      assert.ok(output.includes("$env:CUMORA_BYOA_ALLOW_UNSANDBOXED = '1'"))
      assert.equal(requests.length, 0)
    })
    await t.test('compatibility opt-in reaches pairing with Pi as the default engine', async () => {
      const output = await run('compatibility', { codex: '0.138.0', pi: '0.85.1' }, 'pi', true)
      assert.match(output, /fixture pairing rejected/)
      assert.equal(requests.length, 1)
      assert.equal(requests[0].path, '/api/computers/pair')
      assert.deepEqual(requests[0].body.engines, ['pi', 'codex'])
    })
    await t.test('secure Codex still reaches pairing without exposing Pi as runnable', async () => {
      const output = await run('secure-codex', { codex: '0.138.0', pi: '0.85.1' }, 'codex')
      assert.match(output, /fixture pairing rejected/)
      assert.equal(requests.length, 2)
      assert.deepEqual(requests[1].body.engines, ['codex'])
    })
  } finally {
    await new Promise<void>((done) => server.close(() => done()))
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`))
    await rm(root, { recursive: true, force: true })
  }
})
