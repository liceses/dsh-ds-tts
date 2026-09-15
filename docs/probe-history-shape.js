/* ============================================================================
 * ds-tts · 追问探针：history_messages 的真实字段结构
 * ----------------------------------------------------------------------------
 * 用法：在**已登录的 chat.deepseek.com**、且打开着某个具体对话
 *       （URL 形如 /a/chat/s/<uuid>）的标签页里，F12 → Console → 整段粘贴 → 回车。
 *
 * 它只做一次 GET /api/v0/chat/history_messages，**不合成、不发送任何消息**。
 * 目的：ds-tts 目前按 `role === 'user' | 'assistant'` 与 `content` 取消息 id，
 *       但实测那两条消息两个条件都没命中，需要看清真实字段名与取值。
 * ==========================================================================*/
(async () => {
  const token = (() => {
    try {
      const raw = localStorage.getItem('userToken')
      if (!raw) return ''
      const parsed = JSON.parse(raw)
      return typeof parsed === 'string' ? parsed : parsed && typeof parsed.value === 'string' ? parsed.value : ''
    } catch {
      return ''
    }
  })()
  if (token === '') {
    console.log('%c[ds-tts] ❌ 没拿到登录态', 'color:crimson')
    return
  }
  const sid = (location.pathname.match(/\/a\/chat\/s\/([0-9a-fA-F-]{8,})/i) || [])[1]
  if (!sid) {
    console.log('%c[ds-tts] ⚠️ 请先打开一个具体对话（URL 形如 /a/chat/s/<uuid>）', 'color:orange')
    return
  }

  const res = await fetch('/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(sid), {
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
  })
  const json = await res.json()
  const biz = json && json.data && json.data.biz_data
  const msgs = (biz && biz.chat_messages) || []

  console.log('[ds-tts] envelope →', { code: json && json.code, biz_code: json && json.data && json.data.biz_code, biz_keys: biz ? Object.keys(biz) : null })
  console.log('[ds-tts] count =', msgs.length)

  msgs.forEach((m, i) => {
    if (!m || typeof m !== 'object') {
      console.log(`#${i} 非对象：`, m)
      return
    }
    console.log(`#${i} keys →`, Object.keys(m).join(', '))
    const keys = Object.keys(m)
    console.log(`#${i} 疑似字段：`, {
      message_id: m.message_id,
      id: m.id,
      role: m.role,
      type: m.type,
      role_lower: typeof m.role === 'string' ? m.role.toLowerCase() : m.role,
      content_type: Array.isArray(m.content) ? 'array' : typeof m.content,
      content_len: typeof m.content === 'string' ? m.content.length : undefined,
      content_head: typeof m.content === 'string' ? m.content.slice(0, 60) : undefined,
      has_thinking: Boolean(m.thinking_content),
      // 把任何看起来像角色/正文的键都列出来，防止漏判
      other: keys.filter((k) => /role|type|content|message|status|finish/i.test(k)).reduce((acc, k) => {
        const v = m[k]
        acc[k] = typeof v === 'string' ? v.slice(0, 40) : Array.isArray(v) ? `[array ${v.length}]` : typeof v
        return acc
      }, {}),
    })
  })

  console.log('[ds-tts] 第一条原始 JSON（截断 1500 字符）→', JSON.stringify(msgs[0]).slice(0, 1500))
  console.log('%c[ds-tts] 请把 [ds-tts] 开头的输出整段贴回', 'color:#4c9aff')
})()
