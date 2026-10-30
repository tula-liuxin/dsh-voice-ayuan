// 入口：把电话悬浮按钮注册到 shell.overlay。
import { createLauncher } from './launcher.js'

window.__ModuleLoader__.load({
  id: 'voice-ayuan',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const VoiceLauncher = createLauncher({ React, h })

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'voice-ayuan-launcher', order: 60,
        }, VoiceLauncher))
      },
    }
  },
})
