import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const file = path.join(os.homedir(), '.dsh', 'voice-ayuan-report.jsonl')
const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
const rows = lines.map((x) => { try { return JSON.parse(x) } catch { return null } }).filter(Boolean)
const rem = rows.filter((o) => o.source === 'voice-ayuan-remounter')
console.log('total rows:', rows.length, '| remount rows:', rem.length)
for (const o of rem.slice(-12)) console.log(new Date(o.t).toISOString(), '|', o.phase, '|', JSON.stringify(o).slice(0, 320))
const tail = rows.slice(-6).map((o) => new Date(o.t).toISOString() + ' ' + (o.source || '') + ' ' + (o.reason || '') + ' ' + (o.buildTag || ''))
console.log('--- tail ---')
console.log(tail.join('\n'))
