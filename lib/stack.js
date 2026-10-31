/** Own the asynchronous tunnel -> gateway startup as one plugin lifetime. */
export function createVoiceStack({ tunnel, gateway }) {
  let disposed = false
  let current = null

  function start() {
    if (disposed) return Promise.reject(new Error('voice stack is disposed'))
    if (current) return current.promise
    let cancel
    const state = { cancelled: false }
    const cancelled = new Promise(resolve => { cancel = resolve })
    state.cancel = () => { state.cancelled = true; cancel(null) }
    const boot = (async () => {
      await tunnel.start()
      if (state.cancelled || disposed) return null
      const origin = await gateway.start()
      return state.cancelled || disposed ? null : origin
    })()
    state.promise = Promise.race([boot, cancelled]).finally(() => {
      if (current === state) current = null
    })
    current = state
    return state.promise
  }

  async function stop() {
    current?.cancel()
    current = null
    tunnel.stop()
    await gateway.stop()
  }

  return {
    start,
    stop,
    async dispose() { disposed = true; await stop() },
  }
}
