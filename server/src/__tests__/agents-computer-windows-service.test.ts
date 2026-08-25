import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isWindowsSupervisorProcess,
  parseWindowsProcessList,
  renderWindowsSupervisor,
  resolveNpx,
  windowsScheduledTaskCommand,
  windowsScheduledTaskCreateArgs,
  windowsScheduledTaskQueryCommand,
  windowsScheduledTaskSettingsCommand,
  windowsTaskName,
} from '../agents/computer/daemon.js'

test('Windows service resolves the executable command shim', () => {
  assert.equal(resolveNpx('win32', 'Z:\\missing\\node.exe'), 'npx.cmd')
  assert.equal(resolveNpx('linux', '/missing/node'), 'npx')
})

test('Windows supervisor restarts the latest daemon with supervision enabled', () => {
  const script = renderWindowsSupervisor(
    'C:\\Program Files\\nodejs\\npx.cmd',
    "https://example.test/tenant's-api",
    "C:\\Users\\O'Brien\\.cumora\\daemon.log",
    "C:\\Users\\O'Brien\\.cumora\\daemon-supervisor.disabled",
    "C:\\Program Files\\nodejs;C:\\Users\\O'Brien\\bin",
  )

  assert.match(script, /\$env:CUMORA_SUPERVISED = '1'/)
  assert.match(script, /while \(-not \(Test-Path -LiteralPath/)
  assert.match(script, /& 'C:\\Program Files\\nodejs\\npx\.cmd' -y cumora@latest agent computer --server/)
  assert.match(script, /tenant''s-api/)
  assert.match(script, /O''Brien/)
  assert.match(script, /2>&1 \| ForEach-Object/)
  assert.match(script, /\[System\.IO\.File\]::AppendAllText/)
  assert.doesNotMatch(script, /Out-File/)
  assert.doesNotMatch(script, /\*>>/)
  assert.match(script, /Start-Sleep -Seconds 5/)
})

test('Windows scheduled task runs the watchdog at login with limited privileges', () => {
  const scriptPath = 'C:\\Users\\Test User\\.cumora\\daemon-supervisor.ps1'
  const taskName = windowsTaskName('C:\\Users\\Test User')
  assert.equal(
    windowsScheduledTaskCommand(scriptPath),
    'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\\Users\\Test User\\.cumora\\daemon-supervisor.ps1"',
  )
  assert.deepEqual(windowsScheduledTaskCreateArgs(scriptPath, taskName), [
    '/Create', '/TN', taskName,
    '/TR', windowsScheduledTaskCommand(scriptPath),
    '/SC', 'ONLOGON', '/RL', 'LIMITED', '/IT', '/F',
  ])

  const settings = windowsScheduledTaskSettingsCommand(taskName)
  assert.match(settings, /ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/)
  assert.match(settings, /-AllowStartIfOnBatteries/)
  assert.match(settings, /-DontStopIfGoingOnBatteries/)
  assert.match(settings, /-StartWhenAvailable/)
})

test('Windows task names are stable and isolated per user home', () => {
  assert.equal(windowsTaskName('C:\\Users\\Alice'), windowsTaskName('c:\\users\\alice'))
  assert.notEqual(windowsTaskName('C:\\Users\\Alice'), windowsTaskName('C:\\Users\\Bob'))
})

test('Windows task query distinguishes absence from scheduler failures', () => {
  const query = windowsScheduledTaskQueryCommand("Cumora O'Brien")
  assert.match(query, /Get-ScheduledTask -TaskName 'Cumora O''Brien' -ErrorAction Stop/)
  assert.match(query, /CmdletizationQuery_NotFound_TaskName,\*/)
  assert.match(query, /exit 3/)
  assert.match(query, /Write-Error \$_; exit 1/)
})

test('Windows CIM process output accepts both singleton and array JSON', () => {
  assert.deepEqual(parseWindowsProcessList('{"ProcessId":42,"CommandLine":"node cli.js agent computer"}'), [
    { ProcessId: 42, CommandLine: 'node cli.js agent computer' },
  ])
  assert.deepEqual(parseWindowsProcessList('[{"ProcessId":42,"CommandLine":"a"},{"ProcessId":0,"CommandLine":"b"}]'), [
    { ProcessId: 42, CommandLine: 'a' },
  ])
  assert.deepEqual(parseWindowsProcessList(''), [])
})

test('Windows watchdog matching requires PowerShell -File with the exact script', () => {
  const scriptPath = 'C:\\Users\\Test User\\.cumora\\daemon-supervisor.ps1'
  assert.equal(isWindowsSupervisorProcess({
    ProcessId: 42,
    Name: 'powershell.exe',
    CommandLine: `powershell.exe -NoProfile -File "${scriptPath}"`,
  }, scriptPath), true)
  assert.equal(isWindowsSupervisorProcess({
    ProcessId: 43,
    Name: 'notepad.exe',
    CommandLine: `notepad.exe "${scriptPath}"`,
  }, scriptPath), false)
  assert.equal(isWindowsSupervisorProcess({
    ProcessId: 44,
    Name: 'powershell.exe',
    CommandLine: `powershell.exe -Command "Get-Content '${scriptPath}'"`,
  }, scriptPath), false)
  assert.equal(isWindowsSupervisorProcess({
    ProcessId: 45,
    Name: 'powershell.exe',
    CommandLine: 'powershell.exe -File "C:\\other\\daemon-supervisor.ps1"',
  }, scriptPath), false)
})
