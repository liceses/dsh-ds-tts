/* ============================================================================
 * ds-tts · Step 0 只读探针（v2：容错版）
 * ----------------------------------------------------------------------------
 * 用法：在**已登录**的 chat.deepseek.com、且打开着某个具体对话
 *       （URL 形如 /a/chat/s/<uuid>）的标签页里，F12 → Console → 整段粘贴 → 回车。
 *       然后把 [ds-tts] 开头的输出贴回。
 *
 * 它只做只读调用（voices / ticket / history_messages + wss 合成），
 * **不会往你的会话里发任何消息**。
 *
 *   P1a 服务端是否放行：GET  /api/v0/chat/tts/voices
 *   P1b 取票是否成功：  POST /api/v0/auth/ticket {scope:"tts"}
 *   P2  对**助手**消息合成（基线）
 *   P3  对**用户**消息合成 ← 决定 ds-tts 走 user 还是 echo 投递模式
 *
 * v2 的变化：不再假设角色字段就叫 `role` 且取值是小写 user/assistant。
 * 现在会用别名表归一化（user/human/request… → user；assistant/ai/response… → assistant），
 * 并且**如果还是分不出角色，直接把真实字段名与取值打出来**，一次跑完就能定位改版。
 * ==========================================================================*/
(async () => {
  const readToken = () => {
    try {
      const raw = localStorage.getItem('userToken')
      if (!raw) return ''
      const parsed = JSON.parse(raw)
      if (typeof parsed === 'string') return parsed
      return parsed && typeof parsed.value === 'string' ? parsed.value : ''
    } catch {
      return ''
    }
  }

  const token = readToken()
  if (token === '') {
    console.log('%c[ds-tts] ❌ 没拿到登录态（localStorage.userToken 为空）：请先登录 chat.deepseek.com', 'color:crimson')
    return
  }
  console.log('%c[ds-tts] 已拿到登录态，开始只读探针（不会发送任何消息）', 'color:green')

  const api = (path, init = {}) =>
    fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(init.headers || {}) },
    }).then((r) => r.json())

  /* ── 角色/正文归一化（与插件宿主侧 ds/history.ts 同一套别名） ────────── */
  const ROLE_ALIASES = {
    user: 'user', human: 'user', request: 'user', question: 'user', prompt: 'user',
    assistant: 'assistant', ai: 'assistant', bot: 'assistant', response: 'assistant',
    answer: 'assistant', reply: 'assistant', model: 'assistant',
  }
  const ID_KEYS = ['message_id', 'messageId', 'msg_id', 'msgId', 'id']
  const ROLE_KEYS = ['role', 'role_type', 'roleType', 'sender', 'from', 'type']

  const pick = (row, keys) => {
    for (const key of keys) {
      const value = row[key]
      if (typeof value === 'string' && value !== '') return value
      if (typeof value === 'number') return String(value)
    }
    return ''
  }
  const textOf = (value) => {
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n')
    if (value && typeof value === 'object') {
      for (const key of ['text', 'content', 'value', 'body']) if (typeof value[key] === 'string') return value[key]
      for (const key of ['parts', 'fragments', 'children', 'blocks']) if (Array.isArray(value[key])) return textOf(value[key])
    }
    return ''
  }
  const normalize = (row) => {
    const id = pick(row, ID_KEYS)
    if (id === '') return null
    const rawRole = pick(row, ROLE_KEYS)
    const content = textOf(row.content) || textOf(row.text) || textOf(row.parts) || ''
    return { id, rawRole, role: ROLE_ALIASES[rawRole.trim().toLowerCase()] || 'other', content }
  }

  /* ── 会话 id ─────────────────────────────────────────────────────────── */
  const match = location.pathname.match(/\/a\/chat\/s\/([0-9a-fA-F-]{8,})/i)
  const sessionId = match ? match[1] : ''
  if (sessionId === '') {
    console.log('%c[ds-tts] ⚠️ 当前不在具体对话里：请打开任意一个对话（URL 形如 /a/chat/s/<uuid>）后重跑', 'color:orange')
    return
  }

  /* ── P1：音色列表 + 取票 ─────────────────────────────────────────────── */
  const voices = await api('/api/v0/chat/tts/voices')
  console.log('P1a voices →', {
    code: voices && voices.code,
    biz_code: voices && voices.data && voices.data.biz_code,
    voices: ((voices && voices.data && voices.data.biz_data && voices.data.biz_data.voices) || []).map((v) => v.voice_id),
    current_voice_id: voices && voices.data && voices.data.biz_data && voices.data.biz_data.current_voice_id,
  })

  const ticketProbe = await api('/api/v0/auth/ticket', { method: 'POST', body: JSON.stringify({ scope: 'tts' }) })
  const ticketOk = ticketProbe && ticketProbe.code === 0 && ticketProbe.data && ticketProbe.data.biz_code === 0
  console.log('P1b ticket →', {
    code: ticketProbe && ticketProbe.code,
    biz_code: ticketProbe && ticketProbe.data && ticketProbe.data.biz_code,
    biz_msg: ticketProbe && ticketProbe.data && ticketProbe.data.biz_msg,
    gotTicket: Boolean(ticketProbe && ticketProbe.data && ticketProbe.data.biz_data && ticketProbe.data.biz_data.ticket),
    expires_in_secs: ticketProbe && ticketProbe.data && ticketProbe.data.biz_data && ticketProbe.data.biz_data.expires_in_secs,
  })
  if (!ticketOk) {
    console.log('%c[ds-tts] ❌ 服务端没放行（9=NOT_AVAILABLE 10=RESUME_EXPIRED 11=FORBIDDEN）。把输出贴回即可。', 'color:crimson')
    return
  }

  /* ── 历史消息：容错地挑最后一条 user / assistant ─────────────────────── */
  const history = await api('/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(sessionId))
  const raw = (history && history.data && history.data.biz_data && history.data.biz_data.chat_messages) || []
  const rows = raw.map((row) => (row && typeof row === 'object' ? normalize(row) : null)).filter(Boolean)
  const reversed = [...rows].reverse()
  const lastUser = reversed.find((m) => m.role === 'user' && m.content)
  const lastAssistant = reversed.find((m) => m.role === 'assistant' && m.content)

  console.log('history →', {
    rawCount: raw.length,
    normalizedCount: rows.length,
    rolesSeen: [...new Set(rows.map((m) => m.rawRole))],
    firstRowKeys: raw[0] && typeof raw[0] === 'object' ? Object.keys(raw[0]).slice(0, 14) : null,
    lastUserMessageId: lastUser ? lastUser.id : null,
    lastAssistantMessageId: lastAssistant ? lastAssistant.id : null,
  })
  if (!lastUser || !lastAssistant) {
    console.log(
      '%c[ds-tts] ⚠️ 角色没能归一出 user/assistant —— 下面是真实结构，请一并贴回（这决定投递逻辑怎么改）：',
      'color:orange',
    )
    rows.slice(-3).forEach((m, i) => console.log(`  row-${i} →`, { id: m.id, rawRole: m.rawRole, normalized: m.role, contentLen: m.content.length }))
    console.log('  第一条原始 JSON →', JSON.stringify(raw[0]).slice(0, 1200))
  }

  /* ── 合成探针（一次一票，票据一次性） ───────────────────────────────── */
  async function synthOne(label, messageId, format) {
    if (!messageId) {
      console.log(label, '→ 跳过（没有可用的消息 id）')
      return
    }
    const t = await api('/api/v0/auth/ticket', { method: 'POST', body: JSON.stringify({ scope: 'tts' }) })
    const ticket = t && t.data && t.data.biz_data && t.data.biz_data.ticket
    if (!ticket) {
      console.log(label, '→ 取票失败', t)
      return
    }
    const query = new URLSearchParams({
      chat_session_id: sessionId,
      message_id: String(messageId),
      ticket,
      mode: 'manual',
      format,
    })
    const result = await new Promise((resolve) => {
      const frames = new Map()
      let realFormat = format
      let settled = false
      const ws = new WebSocket('wss://' + location.host + '/api/v0/chat/tts/?' + query.toString())
      ws.binaryType = 'arraybuffer'
      const totalBytes = () => {
        let total = 0
        for (const value of frames.values()) total += value.length
        return total
      }
      const finish = (payload) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { ws.close() } catch {}
        resolve(payload)
      }
      const timer = setTimeout(() => finish({ timeout: true, frames: frames.size, bytes: totalBytes(), format: realFormat }), 30000)
      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          let control
          try { control = JSON.parse(event.data) } catch { return }
          if (control.event === 'ready') {
            realFormat = control.format || realFormat
            ws.send(JSON.stringify({ event: 'ack', received_seq: 0, played_seq: 0 }))
          }
          if (control.event === 'finish') {
            finish({ code: control.code, msg: control.msg, frames: frames.size, bytes: totalBytes(), format: realFormat })
          }
          return
        }
        const view = new DataView(event.data)
        const seq = view.getUint32(0, false)
        if (!frames.has(seq)) frames.set(seq, new Uint8Array(event.data, 4))
        ws.send(JSON.stringify({ event: 'ack', received_seq: seq, played_seq: seq }))
      }
      ws.onerror = () => finish({ error: 'websocket error' })
      ws.onclose = () => finish({ closed: true, frames: frames.size, bytes: totalBytes(), format: realFormat })
    })
    console.log(label, '→', result)
  }

  await synthOne('P2 assistant(基线)', lastAssistant ? lastAssistant.id : null, 'pcm')
  await synthOne('P3 user(关键)', lastUser ? lastUser.id : null, 'pcm')

  console.log(
    '%c[ds-tts] 探针结束。请把 [ds-tts] / P1a / P1b / history / P2 / P3 的输出贴回。\n' +
      '判读：P3 code=0 且有字节 → 走 user 模式（文本精确）；\n' +
      '      P3 报 6(NO_CONTENT) 之类而 P2 成功 → 只能走 echo 模式（让模型原样复述）。',
    'color:#4c9aff',
  )
})()
