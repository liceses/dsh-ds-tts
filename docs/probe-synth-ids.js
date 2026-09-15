/* ============================================================================
 * ds-tts · 合成探针（用你会话里**已有的**消息 id，不投递任何东西）
 * ----------------------------------------------------------------------------
 * 为什么用它：前面只读探针里 P2/P3 被跳过了（因为早期实现按小写 'user'/'assistant'
 * 比对，而实测 role 是**大写** USER/ASSISTANT）。现在直接用真实 id 测合成，
 * 一次就能回答唯一剩下的关键问题：
 *
 *   ★ DS 官方 TTS 到底接不接受**用户消息**的 message_id？
 *     接受 → ds-tts 走 user 模式（把文本作为用户消息投递，朗读它，文本 100% 精确）
 *     不接受 → 只能走 echo 模式（投递"请原样输出…"，朗读模型的助手回复）
 *
 * 用法：在已登录的 chat.deepseek.com、且打开着**同一条对话**（URL 里的 sid 必须与
 *       这些 id 属于同一会话）时，F12 → Console → 粘贴 → 回车。
 *       输出每行都以 [ds-tts-synth] 开头。
 *
 * 若你的会话里 id 不是 1/2，把下面底部的 synth(...) 参数改成你实际看到的值即可
 * （用 probe-v3-oneliner.js 能看到每个消息的 id）。
 * ==========================================================================*/
(async () => {
  const raw = localStorage.getItem('userToken')
  let token = ''
  try {
    const parsed = JSON.parse(raw)
    token = typeof parsed === 'string' ? parsed : (parsed && parsed.value) || ''
  } catch {
    token = raw || ''
  }
  if (token === '') {
    console.log('%c[ds-tts-synth] ❌ 没拿到登录态', 'color:crimson')
    return
  }
  const sid = (location.pathname.match(/\/a\/chat\/s\/([0-9a-fA-F-]{8,})/i) || [])[1]
  if (!sid) {
    console.log('%c[ds-tts-synth] ⚠️ 请先打开一条具体对话（URL 形如 /a/chat/s/<uuid>）', 'color:orange')
    return
  }

  const api = (path, init = {}) =>
    fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(init.headers || {}) },
    }).then((r) => r.json())

  async function synth(label, messageId, format) {
    format = format || 'pcm'
    const ticketRes = await api('/api/v0/auth/ticket', { method: 'POST', body: JSON.stringify({ scope: 'tts' }) })
    const ticket = ticketRes && ticketRes.data && ticketRes.data.biz_data && ticketRes.data.biz_data.ticket
    if (!ticket) {
      console.log('[ds-tts-synth]', label, '取票失败 →', JSON.stringify(ticketRes).slice(0, 300))
      return
    }
    const query = new URLSearchParams({
      chat_session_id: sid,
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
            const bytes = totalBytes()
            finish({
              code: control.code,
              msg: control.msg,
              frames: frames.size,
              bytes,
              format: realFormat,
              seconds: realFormat === 'pcm' ? Math.round((bytes / 48000) * 100) / 100 : null,
            })
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
    console.log('[ds-tts-synth]', label, 'message_id=' + String(messageId), '→', JSON.stringify(result))
  }

  console.log('[ds-tts-synth] sid =', sid, '（下面两条必须属于这条会话）')
  // 先测助手（基线），再测用户（关键）
  await synth('ASSISTANT 基线 ', 2)
  await synth('USER 关键   ', 1)
  console.log(
    '%c[ds-tts-synth] 判读：USER 那行 code=0 且有 bytes → user 模式可用（文本精确）；\n' +
      '              USER 报 6(NO_CONTENT)/2 之类而 ASSISTANT 成功 → 只能 echo 模式。',
    'color:#4c9aff',
  )
})()
