import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createVoiceStack } from '../lib/stack.js'
import { GatewayProcess } from '../lib/gateway.js'
import { SshTunnel } from '../lib/tunnel.js'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

test('unloading while the tunnel starts cancels startup and never starts the gateway', async () => {
  const ready = deferred()
  const events = []
  const stack = createVoiceStack({
    tunnel: { start: () => ready.promise, stop: () => events.push('tunnel.stop') },
    gateway: { start: () => events.push('gateway.start'), stop: () => events.push('gateway.stop') },
  })
  const boot = stack.start()
  assert.equal(stack.start(), boot, 'overlapping starts share one operation')
  await stack.dispose()
  assert.equal(await boot, null)
  ready.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(events, ['tunnel.stop', 'gateway.stop'])
  await assert.rejects(stack.start(), /disposed/)
})

test('explicit stop cancels the old start and a subsequent start belongs to a new lifetime', async () => {
  const first = deferred()
  let attempts = 0, gateways = 0
  const stack = createVoiceStack({
    tunnel: { start: () => ++attempts === 1 ? first.promise : Promise.resolve(), stop() {} },
    gateway: { start: async () => { gateways++; return 'http://127.0.0.1:1' }, stop() {} },
  })
  const old = stack.start()
  await stack.stop()
  assert.equal(await old, null)
  assert.equal(await stack.start(), 'http://127.0.0.1:1')
  first.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(gateways, 1)
  await stack.dispose()
})

test('dispose also settles a start waiting for gateway readiness', async () => {
  const ready = deferred()
  let started = false, stopped = 0
  const stack = createVoiceStack({
    tunnel: { start: async () => {}, stop() {} },
    gateway: { start: () => { started = true; return ready.promise }, stop: () => { stopped++ } },
  })
  const boot = stack.start()
  await Promise.resolve()
  assert.equal(started, true)
  await stack.dispose()
  assert.equal(await boot, null)
  ready.reject(new Error('late cancelled process'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(stopped, 1)
})

test('gateway stop settles readiness and stale child messages cannot overwrite a replacement', async () => {
  const children = []
  const gateway = new GatewayProcess({
    forkProcess() {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => { child.killed = true }
      children.push(child)
      return child
    },
  })
  const starting = gateway.start()
  const cancelled = assert.rejects(starting, /cancelled/)
  await gateway.stop()
  await cancelled
  assert.equal(children[0].killed, true)
  const replacement = gateway.start()
  children[0].emit('message', { type: 'qwen-audio-agent:gateway-ready', origin: 'http://stale.invalid' })
  children[0].emit('exit', 0, null)
  assert.equal(gateway.child, children[1])
  children[1].emit('message', { type: 'qwen-audio-agent:gateway-ready', origin: 'http://127.0.0.1:2' })
  assert.equal(await replacement, 'http://127.0.0.1:2')
  assert.equal(gateway.origin, 'http://127.0.0.1:2')
  await gateway.stop()
})

test('a stopped tunnel cannot become ready later or clear a replacement child', async () => {
  const readiness = [], children = []
  const tunnel = new SshTunnel({
    host: 'unused.invalid', localPort: 1,
    spawnProcess() {
      const child = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => { child.killed = true }
      children.push(child)
      return child
    },
    waitForPort() { const next = deferred(); readiness.push(next); return next.promise },
  })
  const first = tunnel.start()
  tunnel.stop()
  const second = tunnel.start()
  children[0].emit('exit', 0)
  readiness[0].resolve()
  await first
  assert.equal(tunnel.child, children[1])
  assert.equal(tunnel.phase, 'starting')
  readiness[1].resolve()
  await second
  assert.equal(tunnel.phase, 'ready')
  tunnel.stop()
  assert.equal(tunnel.phase, 'stopped')
})
