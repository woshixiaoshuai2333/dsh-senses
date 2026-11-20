/**
 * dsh-senses — 浏览器半侧（设置页）。
 *
 * 由 DSH 外壳以包的 "./client" 导出加载，没有打包器，模块契约手写。
 *
 * 契约（参照 dsh-cookie431 / dsh-better-sidebar 实证）：
 *   window.__ModuleLoader__.load({ id, factory })
 *   factory(require) -> { name, inject, apply }
 *
 * 注意：这里的 inject 是 Cordis 的**服务名**（'slots'），不是包名。
 * 写成包名会让整个 DSH 弹崩溃框。
 *
 * 界面按「渐进式披露」组织：
 *   第一眼只看到「现在什么状态」，
 *   key、降级链、高级设置全部折叠，想改才展开。
 */
;(() => {
  // 这个 ID 必须是**包名**：外壳按包名加载 plugins/??dsh-senses/client.js，
  // 加载完会核对是否用同一个名字注册过；写成别的会报
  // "loaded without registering "dsh-senses""。
  const ID = 'dsh-senses'

  function makeFactory() {
    return (require) => {
      const module = { exports: {} }

      let react = null
      try {
        react = require('react')
      } catch (err) {
        console.error('[dsh-senses] 拿不到 react，设置页跳过', err)
        module.exports = { name: ID, inject: [], apply: () => {} }
        return module.exports
      }

      const h = react.createElement
      const useState = react.useState
      const useEffect = react.useEffect

      // ---------- 找到宿主 HTTP 服务的地址 ----------
      // 桌面版界面跑在 dsh-app:// 协议下，相对路径到不了 HTTP 服务器；
      // 而且端口每次重启都变，所以只能从 __DSH_BOOT__ 里挖。

      function findBase() {
        try {
          const origin = String(location.origin)
          if (origin.indexOf('http') === 0) return origin
        } catch { /* ignore */ }

        const seen = new Set()
        const walk = (value, depth) => {
          if (depth > 6) return null
          if (typeof value === 'string') {
            return /^https?:\/\/127\.0\.0\.1:\d+/.test(value) ? value.replace(/\/+$/, '') : null
          }
          if (value === null || typeof value !== 'object') return null
          if (seen.has(value)) return null
          seen.add(value)
          for (const key of Object.keys(value)) {
            const hit = walk(value[key], depth + 1)
            if (hit) return hit
          }
          return null
        }

        try {
          return walk(window.__DSH_BOOT__, 0)
        } catch {
          return null
        }
      }

      async function call(path, init) {
        // 桌面版界面可能跑在 dsh-app:// 自定义协议下，拿不到 http 端口；
        // 而 dsh-aliyun-balance 等插件证明「相对路径」能被外壳正确转给本地服务。
        // 所以两条都试：先相对路径，再退回绝对地址，都不行才报错。
        const base = findBase()
        const urls = base ? [`/dsh-senses${path}`, `${base}/dsh-senses${path}`] : [`/dsh-senses${path}`]
        let lastErr = null
        for (const url of urls) {
          try {
            const res = await fetch(url, init)
            const text = await res.text()
            let json = null
            try {
              json = text ? JSON.parse(text) : null
            } catch {
              throw new Error(`接口返回的不是 JSON：${text.slice(0, 120)}`)
            }
            if (!res.ok) throw new Error((json && json.error) || `HTTP ${res.status}`)
            return json
          } catch (err) {
            lastErr = err
          }
        }
        throw new Error(`设置接口连不上（${lastErr && lastErr.message ? lastErr.message : '未知原因'}）`)
      }

      // ---------- 样式 ----------
      const S = {
        wrap: { display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 2px 24px' },
        title: { fontSize: 14, fontWeight: 600, marginBottom: 2 },
        hint: { fontSize: 12, opacity: 0.62, lineHeight: 1.6 },
        card: {
          border: '1px solid rgba(127,127,127,.22)',
          borderRadius: 10,
          padding: '12px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        },
        cardTitle: { fontSize: 13, fontWeight: 600 },
        row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
        head: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' },
        caret: { fontSize: 10, opacity: 0.55, width: 12, display: 'inline-block' },
        body: { display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 10 },
        label: { fontSize: 12, opacity: 0.75, minWidth: 78 },
        input: {
          flex: 1,
          minWidth: 180,
          padding: '6px 9px',
          fontSize: 12,
          borderRadius: 7,
          border: '1px solid rgba(127,127,127,.35)',
          background: 'transparent',
          color: 'inherit',
          fontFamily: 'inherit',
        },
        area: {
          width: '100%',
          boxSizing: 'border-box',
          padding: '7px 9px',
          fontSize: 12,
          borderRadius: 7,
          border: '1px solid rgba(127,127,127,.35)',
          background: 'transparent',
          color: 'inherit',
          fontFamily: 'ui-monospace, Consolas, monospace',
          lineHeight: 1.7,
          resize: 'vertical',
        },
        btn: {
          padding: '7px 16px',
          fontSize: 12,
          borderRadius: 7,
          border: '1px solid rgba(127,127,127,.35)',
          background: 'rgba(127,127,127,.14)',
          color: 'inherit',
          cursor: 'pointer',
        },
        btnOn: {
          padding: '7px 16px',
          fontSize: 12,
          borderRadius: 7,
          border: '1px solid rgba(64,158,255,.7)',
          background: 'rgba(64,158,255,.16)',
          color: 'inherit',
          cursor: 'pointer',
          fontWeight: 600,
        },
        ok: { fontSize: 12, color: '#18a058' },
        bad: { fontSize: 12, color: '#d03050' },
        warn: { fontSize: 12, color: '#c47f00' },
        tag: {
          fontSize: 11,
          padding: '1px 7px',
          borderRadius: 999,
          border: '1px solid rgba(127,127,127,.32)',
          opacity: 0.85,
          whiteSpace: 'nowrap',
        },
        tutorial: {
          fontSize: 12,
          lineHeight: 1.9,
          padding: '10px 12px',
          borderRadius: 8,
          background: 'rgba(127,127,127,.08)',
          border: '1px solid rgba(127,127,127,.18)',
        },
        mono: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11.5 },
        link: { color: '#409eff', textDecoration: 'none' },
      }

      const CAP_LABELS = {
        see: '看视频',
        hear: '听声音（转文字）',
        hear_qa: '听声音并回答',
        image_gen: '生成图片',
        video_gen: '生成视频',
        speak: '文字转语音',
      }

      // ---------- 小组件 ----------

      // 折叠面板：标题一行（带摘要），点一下才展开内容
      function Panel(props) {
        const [open, setOpen] = useState(Boolean(props.defaultOpen))
        return h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: S.head, onClick: () => setOpen(!open) },
            h('span', { style: S.caret }, open ? '▾' : '▸'),
            h('span', { style: S.cardTitle }, props.title),
            props.summary ? h('span', { style: { ...S.hint, marginLeft: 'auto' } }, props.summary) : null,
          ),
          open ? h('div', { style: S.body }, props.children) : null,
        )
      }

      function Line(props) {
        return h('div', { style: S.row }, h('span', { style: S.label }, props.label), props.children)
      }

      // 顶部一句话状态：不用展开就知道现在是什么情况
      function statusSentence(status) {
        if (!status) return '正在读取…'
        const bits = []
        const ffmpegOk = status.ffmpeg && status.ffmpeg.found
        const qwenOk = status.providers && status.providers.qwen && status.providers.qwen.hasKey

        bits.push('5 个能力')
        if (!qwenOk) bits.push('千问 key 还没配')
        bits.push(ffmpegOk ? 'ffmpeg 已就绪' : '没找到 ffmpeg：本地视频看不了（公网链接不受影响）')
        return bits.join(' · ')
      }

      // ffmpeg 没有时的三步小教程
      function FfmpegTutorial() {
        return h(
          'div',
          { style: S.tutorial },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '看本地视频需要 ffmpeg'),
          h(
            'div',
            { style: S.hint },
            '只有「看本地存的视频文件」这一件事需要它 —— 得先把视频抽成一组画面才能发给模型。听声音、画图、出片、说话、看公网视频链接都不需要 ffmpeg。',
          ),
          h('div', { style: { marginTop: 8, fontWeight: 600 } }, '装的话三步：'),
          h('div', null, '① 打开 ' + 'gyan.dev/ffmpeg/builds' + '（免安装，不用敲命令）'),
          h('div', null, '② 下「ffmpeg-release-essentials.zip」，解压，进 bin 文件夹找到 ffmpeg.exe'),
          h('div', null, '③ 把这行 exe 的完整路径粘到上面那个框里，点保存'),
          h(
            'div',
            { style: { ...S.hint, marginTop: 6 } },
            '嫌麻烦也可以先把视频传到网上（B站、网盘直链都行），用链接看，那条路不需要 ffmpeg。',
          ),
        )
      }

      // ---------- 主组件 ----------
      function Section() {
        const [busy, setBusy] = useState(true)
        const [cfg, setCfg] = useState(null)
        const [status, setStatus] = useState(null)
        const [error, setError] = useState('')
        const [saved, setSaved] = useState('')
        const [warn, setWarn] = useState('')
        const [dirty, setDirty] = useState(false)
        const [keys, setKeys] = useState({ qwen: '' })
        const [chains, setChains] = useState({})

        useEffect(() => {
          let alive = true
          ;(async () => {
            try {
              const [c, s] = await Promise.all([call('/api/config'), call('/api/status')])
              if (!alive) return
              setCfg(c.config)
              setStatus(s)
              setKeys({ qwen: '' })
              const next = {}
              for (const cap of Object.keys(CAP_LABELS)) {
                const raw = (c.config.chains && c.config.chains[cap]) || (c.defaults && c.defaults[cap]) || []
                next[cap] = raw.join('\n')
              }
              setChains(next)
            } catch (err) {
              if (alive) setError(err && err.message ? err.message : String(err))
            } finally {
              if (alive) setBusy(false)
            }
          })()
          return () => { alive = false }
        }, [])

        function patch(field, value) {
          setCfg((prev) => (prev ? { ...prev, [field]: value } : prev))
          setSaved('')
          setDirty(true)
        }

        function patchProvider(id, field, value) {
          setCfg((prev) => {
            if (!prev) return prev
            return { ...prev, providers: { ...prev.providers, [id]: { ...(prev.providers[id] || {}), [field]: value } } }
          })
          setSaved('')
          setDirty(true)
        }

        async function onSave() {
          setBusy(true)
          setError('')
          setSaved('')
          try {
            const providers = {}
            for (const id of Object.keys((cfg && cfg.providers) || {})) {
              const src = cfg.providers[id] || {}
              providers[id] = { ...src }
              // key 输入框留空表示「不改」，绝不能把脱敏值写回去
              if (keys[id]) providers[id].apiKey = keys[id]
              else delete providers[id].apiKey
              delete providers[id].apiKeyMasked
              delete providers[id].hasKey
            }

            const chainPayload = {}
            for (const cap of Object.keys(chains)) {
              chainPayload[cap] = chains[cap].split('\n').map((x) => x.trim()).filter(Boolean)
            }

            const payload = {
              config: {
                outputDir: cfg.outputDir,
                ffmpegPath: cfg.ffmpegPath,
                framesPerSecond: cfg.framesPerSecond,
                maxFrames: cfg.maxFrames,
                frameWidth: cfg.frameWidth,
                providers,
                chains: chainPayload,
              },
            }

            const res = await call('/api/config', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            })
            setCfg(res.config)
            setKeys({ qwen: '' })
            const s = await call('/api/status')
            setStatus(s)
            setDirty(false)
            // 服务端把被丢掉的行放在 warnings 里——不能吞掉，否则用户以为存上了
            const warnings = Array.isArray(res && res.warnings) ? res.warnings : []
            if (warnings.length > 0) {
              setWarn(warnings.join('；'))
              setSaved('已保存，但有几行没存进去。')
            } else {
              setWarn('')
              setSaved('已保存。下一次调用工具就按新配置走，不用重启。')
            }
          } catch (err) {
            setError(err && err.message ? err.message : String(err))
          } finally {
            setBusy(false)
          }
        }

        if (busy && !cfg) return h('div', { style: S.wrap }, h('div', { style: S.hint }, '正在读取配置…'))
        if (error && !cfg) return h('div', { style: S.wrap }, h('div', { style: S.bad }, error))

        const ffmpegOk = Boolean(status && status.ffmpeg && status.ffmpeg.found)
        const qwenOk = Boolean(status && status.providers && status.providers.qwen && status.providers.qwen.hasKey)

        // 折叠面板标题右侧的摘要，一眼看到内部状态
        const keySummary = '千问' + (qwenOk ? '✓' : '✗') + (qwenOk ? ' · 已就绪' : ' · 待填')

        const chainSummaryPromise = (function () {
          const usable = Object.keys(CAP_LABELS).filter((cap) => {
            const list = (chains[cap] || '').split('\n').map((x) => x.trim()).filter(Boolean)
            return list.length > 0
          })
          return usable.length + '/' + Object.keys(CAP_LABELS).length + ' 项有配置'
        })()

        const advancedSummary = (cfg.outputDir || '') + (ffmpegOk ? '' : ' · 无 ffmpeg')

        return h(
          'div',
          { style: S.wrap },

          h('div', { style: S.title }, '多模态感官'),

          // ---- 一句话状态 ----
          h(
            'div',
            { style: { ...S.card, gap: 6 } },
            h('div', { style: S.row }, h('span', { style: S.tag }, statusSentence(status))),
            !ffmpegOk
              ? h('div', { style: S.hint }, '提示：没找到 ffmpeg 不影响看视频，本地视频会整个发给模型。')
              : null,
          ),

          // ---- 服务商与 key（折叠）----
          h(
            Panel,
            { title: '服务商与 key', summary: keySummary },
            h(
              'div',
              { style: S.hint },
              '千问那把 key 已经在 ~/.dsh/.credentials.yaml 里的话，这里留空就行。所有 AI 能力都走这一把 key。',
            ),
            h(
              Line,
              { label: '千问 key' },
              h('input', {
                style: S.input,
                type: 'password',
                placeholder: qwenOk ? '已配置（' + status.providers.qwen.keyMasked + '），留空不改' : 'sk-...',
                value: keys.qwen,
                onChange: (e) => setKeys({ ...keys, qwen: e.target.value }),
              }),
            ),
            h(
              Line,
              { label: '千问地址' },
              h('input', {
                style: S.input,
                value: (cfg.providers.qwen && cfg.providers.qwen.compatibleBase) || '',
                onChange: (e) => patchProvider('qwen', 'compatibleBase', e.target.value),
              }),
            ),
            h(
              Line,
              { label: '千问原生地址' },
              h('input', {
                style: S.input,
                placeholder: 'https://maas.qianwenaiapi.com/api/v1',
                value: (cfg.providers.qwen && cfg.providers.qwen.nativeBase) || '',
                onChange: (e) => patchProvider('qwen', 'nativeBase', e.target.value),
              }),
            ),
            h(
              'div',
              { style: S.hint },
              '「千问地址」是 OpenAI 兼容那套（看图、画图走它）；「千问原生地址」是另一套（听声音转写、说话、生视频走它）。换别家平台时两个可能不一样，不确定就都留默认。',
            ),
            h(
              Line,
              { label: '系统音色' },
              h('input', {
                style: S.input,
                placeholder: 'auto',
                value: (cfg.providers.sapi && cfg.providers.sapi.voice) || 'auto',
                onChange: (e) => patchProvider('sapi', 'voice', e.target.value),
              }),
            ),
          ),

          // ---- 降级链（折叠）----
          h(
            Panel,
            { title: '每个能力用哪家', summary: chainSummaryPromise },
            h(
              'div',
              { style: S.hint },
              '一行一个，写法是「服务商/模型名」。上面那个失败了才轮到下一个。正常情况下不用动这里。',
            ),
            Object.keys(CAP_LABELS).map((cap) =>
              h(
                'div',
                { key: cap, style: { display: 'flex', flexDirection: 'column', gap: 5 } },
                h(
                  'div',
                  { style: { fontSize: 12, fontWeight: 600 } },
                  CAP_LABELS[cap],
                ),
                h('textarea', {
                  style: S.area,
                  rows: 3,
                  spellCheck: false,
                  value: chains[cap] === undefined ? '' : chains[cap],
                  onChange: (e) => {
                    setChains({ ...chains, [cap]: e.target.value })
                    setSaved('')
                    setDirty(true)
                  },
                }),
              ),
            ),
          ),

          // ---- 高级设置（折叠）----
          h(
            Panel,
            { title: '高级设置', summary: advancedSummary },
            h(
              Line,
              { label: '存哪儿' },
              h('input', {
                style: S.input,
                value: cfg.outputDir || '',
                onChange: (e) => patch('outputDir', e.target.value),
              }),
            ),
            h(
              'div',
              { style: S.hint },
              '生成的图片、视频、语音都放在这个目录下，按时间分文件夹。',
            ),
            h(
              Line,
              { label: 'ffmpeg' },
              h('input', {
                style: S.input,
                placeholder: ffmpegOk ? '已自动找到，留空即可' : '留空会自动找；也可以填 exe 的完整路径',
                value: cfg.ffmpegPath || '',
                onChange: (e) => patch('ffmpegPath', e.target.value),
              }),
            ),
            ffmpegOk
              ? h('div', { style: S.hint }, '当前用的：' + status.ffmpeg.path)
              : h(FfmpegTutorial, null),
            h(
              Line,
              { label: '抽帧密度' },
              h('input', {
                style: { ...S.input, minWidth: 80, flex: '0 0 90px' },
                type: 'number',
                min: 0.2,
                step: 0.2,
                value: cfg.framesPerSecond,
                onChange: (e) => patch('framesPerSecond', Number(e.target.value) || 1),
              }),
              h('span', { style: S.hint }, '每秒几张'),
              h('input', {
                style: { ...S.input, minWidth: 80, flex: '0 0 90px' },
                type: 'number',
                min: 4,
                max: 64,
                value: cfg.maxFrames,
                onChange: (e) => patch('maxFrames', Number(e.target.value) || 16),
              }),
              h('span', { style: S.hint }, '最多几张'),
            ),
            h(
              'div',
              { style: S.hint },
              '只有「视频太大直传失败」时才用抽帧。改大一点抽得更细，但更慢更贵。',
            ),
          ),

          // ---- 保存 ----
          h(
            'div',
            { style: { ...S.row, paddingTop: 2 } },
            h('button', { style: S.btn, disabled: busy, onClick: onSave }, busy ? '保存中…' : '保存'),
            dirty ? h('span', { style: S.warn }, '有没保存的改动') : null,
            saved ? h('span', { style: warn ? S.warn : S.ok }, saved) : null,
            warn ? h('span', { style: { ...S.warn, display: 'block', marginTop: 6 } }, warn) : null,
            error ? h('span', { style: S.bad }, error) : null,
          ),

          h(
            'div',
            { style: S.hint },
            '配置存在 ' + ((status && status.configFile) || '~/.dsh/dsh-senses/config.json') + '，想手改直接编辑它也行。',
          ),
        )
      }

      function apply(ctx) {
        try {
          if (!ctx || !ctx.slots) {
            console.warn('[dsh-senses] ctx.slots 不存在，设置页跳过')
            return
          }
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register({ name: 'settings.section', id: ID, order: 160, label: () => '多模态感官' }, Section),
          )
          console.info('[dsh-senses] 设置页已注册')
        } catch (err) {
          console.error('[dsh-senses] 注册设置页失败', err)
        }
      }

      module.exports = { name: ID, inject: ['slots'], apply }
      return module.exports
    }
  }

  try {
    if (window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
      window.__ModuleLoader__.load({ id: ID, factory: makeFactory() })
    } else {
      console.warn('[dsh-senses] __ModuleLoader__ 不存在，浏览器半侧无法加载')
    }
  } catch (err) {
    console.error('[dsh-senses] 浏览器半侧加载失败', err)
  }
})()