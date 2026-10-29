import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const file = path.join(os.homedir(), '.dsh', 'voice-ayuan-report.jsonl')
const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((x) => { try { return JSON.parse(x) } catch { return null } }).filter(Boolean)
const metrics = rows.filter((o) => o.kind === 'launcher-metrics')
console.log('metrics rows:', metrics.length)
for (const row of metrics.slice(-4)) {
  const m = row.metrics
  console.log('---', new Date(row.t).toISOString(), 'reason=' + row.reason, 'mode=' + m.mode, 'pass=' + m.pass)
  console.log('  viewport', JSON.stringify(m.viewport))
  console.log('  phone  ', m.phone ? JSON.stringify(m.phone.rect) : null)
  console.log('  light  ', m.lightning ? JSON.stringify(m.lightning.rect) : null)
  console.log('  bubble ', m.bubble ? JSON.stringify(m.bubble.rect) : null)
  console.log('  fails  ', Object.entries(m.invariants || {}).filter(([, v]) => v === false).map(([k]) => k).join(','))
}
