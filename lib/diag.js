// 宿主侧诊断：所有升级请求/代理结果写 JSONL，客户端实机指标写 report 文件。
// 目的：Electron 应用内没有浏览器控制，靠服务端日志 + 客户端上报做客观定位。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = path.join(os.homedir(), '.dsh', 'logs')
const file = path.join(dir, 'voice-ayuan.log')
const reportFile = path.join(os.homedir(), '.dsh', 'voice-ayuan-report.json')
const MAX_LINES = 4000
let trimming = false

function trim() {
  if (trimming) return
  trimming = true
  const timer = setTimeout(() => {
    trimming = false
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n')
      if (lines.length > MAX_LINES) fs.writeFileSync(file, lines.slice(-MAX_LINES).join('\n'))
    } catch {}
  }, 300)
  timer.unref?.()
}

export function diag(event) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...event }) + '\n')
    trim()
  } catch {}
}

export function tailLog(n = 200) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-n).join('\n')
  } catch {
    return ''
  }
}

const reportLogFile = path.join(os.homedir(), '.dsh', 'voice-ayuan-report.jsonl')

export function appendReport(payload) {
  try {
    fs.mkdirSync(path.dirname(reportLogFile), { recursive: true })
    fs.appendFileSync(reportLogFile, JSON.stringify({ t: new Date().toISOString(), ...payload }) + '\n')
    const lines = fs.readFileSync(reportLogFile, 'utf8').split('\n')
    if (lines.length > 4000) fs.writeFileSync(reportLogFile, lines.slice(-4000).join('\n'))
    return reportLogFile
  } catch (error) {
    return 'error: ' + String(error && error.message)
  }
}

export function writeReport(payload) {
  try {
    fs.mkdirSync(path.dirname(reportFile), { recursive: true })
    fs.writeFileSync(reportFile, JSON.stringify({ t: new Date().toISOString(), ...payload }, null, 2))
    return reportFile
  } catch (error) {
    return 'error: ' + String(error && error.message)
  }
}

export function diagPaths() {
  return { log: file, report: reportFile, reportLog: reportLogFile }
}
