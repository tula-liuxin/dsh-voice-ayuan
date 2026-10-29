// 验证宿主 base / WS URL 解析（回归：桌面 dsh-app://app 页面绝不能用 location.host）。
import assert from 'node:assert'
import {
  resolveHostBase,
  buildRealtimeUrl,
  REALTIME_PATH,
} from '../src/client/session.js'

let pass = 0
let fail = 0
const check = (name, fn) => {
  try {
    fn()
    pass += 1
    console.log('PASS ' + name)
  } catch (error) {
    fail += 1
    console.error('FAIL ' + name + ' :: ' + (error && error.message))
  }
}

const dshAppLocation = { protocol: 'dsh-app:', origin: 'dsh-app://app', host: 'app' }

check('desktop: transport 优先于 dsh-app location', () => {
  const result = resolveHostBase({
    __DSH_TRANSPORT__: { ownsHost: true, streamBaseUrl: 'http://127.0.0.1:4273' },
    location: dshAppLocation,
  })
  assert.equal(result.base, 'http://127.0.0.1:4273')
  assert.equal(result.source, 'transport')
  assert.equal(result.error, null)
  assert.equal(buildRealtimeUrl(result.base), 'ws://127.0.0.1:4273/voice-ayuan/rt')
})

check('desktop: streamBaseUrl 带尾斜杠/路径时归一化为 origin', () => {
  const result = resolveHostBase({
    __DSH_TRANSPORT__: { streamBaseUrl: 'http://127.0.0.1:4273/' },
    location: dshAppLocation,
  })
  assert.equal(result.base, 'http://127.0.0.1:4273')
  assert.equal(buildRealtimeUrl(result.base), 'ws://127.0.0.1:4273/voice-ayuan/rt')
})

check('desktop: https transport → wss', () => {
  const result = resolveHostBase({
    __DSH_TRANSPORT__: { streamBaseUrl: 'https://127.0.0.1:8443' },
    location: dshAppLocation,
  })
  assert.equal(result.base, 'https://127.0.0.1:8443')
  assert.equal(buildRealtimeUrl(result.base), 'wss://127.0.0.1:8443/voice-ayuan/rt')
})

check('web: 无 transport 时用 http location.origin', () => {
  const result = resolveHostBase({
    location: { protocol: 'http:', origin: 'http://127.0.0.1:8080', host: '127.0.0.1:8080' },
  })
  assert.equal(result.base, 'http://127.0.0.1:8080')
  assert.equal(result.source, 'location')
  assert.equal(buildRealtimeUrl(result.base), 'ws://127.0.0.1:8080/voice-ayuan/rt')
})

check('web: https location → wss', () => {
  const result = resolveHostBase({
    location: { protocol: 'https:', origin: 'https://dsh.example.com', host: 'dsh.example.com' },
  })
  assert.equal(result.base, 'https://dsh.example.com')
  assert.equal(buildRealtimeUrl(result.base), 'wss://dsh.example.com/voice-ayuan/rt')
})

check('desktop: dsh-app 页面且无 transport → base=null 且 error 非空（明确报错，不静默拼 host）', () => {
  const result = resolveHostBase({ location: dshAppLocation })
  assert.equal(result.base, null)
  assert.equal(result.source, 'none')
  assert.ok(typeof result.error === 'string' && result.error.length > 0)
  assert.equal(buildRealtimeUrl(result.base), null)
})

check('desktop: transport 非法时回退 location(http)', () => {
  const result = resolveHostBase({
    __DSH_TRANSPORT__: { streamBaseUrl: 'dsh-app://app' },
    location: { protocol: 'http:', origin: 'http://127.0.0.1:5000' },
  })
  assert.equal(result.base, 'http://127.0.0.1:5000')
  assert.equal(result.source, 'location')
})

check('desktop: transport 非法且无 http location → 报错', () => {
  const result = resolveHostBase({ __DSH_TRANSPORT__: { streamBaseUrl: 'dsh-app://app' }, location: dshAppLocation })
  assert.equal(result.base, null)
  assert.ok(/不是可用|无法确定|缺少/.test(result.error || ''), 'error=' + result.error)
})

check('无 globals → 报错不崩溃', () => {
  const result = resolveHostBase({})
  assert.equal(result.base, null)
  assert.ok(result.error)
})

check('buildRealtimeUrl 拒绝非法 base', () => {
  assert.equal(buildRealtimeUrl(null), null)
  assert.equal(buildRealtimeUrl(''), null)
  assert.equal(buildRealtimeUrl('ftp://127.0.0.1'), null)
  assert.equal(buildRealtimeUrl('not a url'), null)
})

check('回归对照：旧逻辑用 location.host 会得到 ws://app/...（失败根因）', () => {
  const oldUrl = 'ws://' + dshAppLocation.host + REALTIME_PATH
  assert.equal(oldUrl, 'ws://app/voice-ayuan/rt')
  assert.notEqual(oldUrl, buildRealtimeUrl(resolveHostBase({
    __DSH_TRANSPORT__: { streamBaseUrl: 'http://127.0.0.1:4273' },
    location: dshAppLocation,
  }).base))
})

console.log('\nwsurl: ' + pass + ' pass, ' + fail + ' fail')
process.exit(fail === 0 ? 0 : 1)
