// Browser half of dsh-media-gen: a dedicated Settings section ("媒体生成").
//
// Reads/writes the plugin config through the host routes:
//   GET  /media-gen/config          -> { config }
//   POST /media-gen/config          -> save patch
//   GET  /media-gen/providers?probe=1 -> { providers }
//
// No API keys ever reach the browser; the backend resolves credentials from
// DSH's own model settings.
window.__ModuleLoader__.load({
  id: 'dsh-media-gen',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var TEXT = {
      zh: {
        settingsNav: '媒体生成',
        subtitle: '在会话中生成图片与视频（OpenAI 兼容接口），输出保存到工作区 media_gen。',
        loading: '加载中…',
        save: '保存设置',
        saving: '保存中…',
        saved: '已保存',
        refresh: '刷新模型列表',
        refreshing: '刷新中…',
        refreshed: '已刷新',
        error: '加载失败',
        outputDir: '输出目录',
        outputDirHint: '固定为当前工作区的 media_gen 目录，不可修改',
        t2i: '文生图模型',
        t2iHint: '图片生成（/images/generations）',
        i2i: '图生图模型',
        i2iHint: '图片编辑（/images/edits），需要配置支持图生图的模型',
        video: '视频生成模型',
        videoHint: '视频生成（/videos 或 /videos/generations）',
        videoEndpoint: '视频接口路径（可选）',
        videoEndpointHint: '留空自动尝试 /videos 再 /videos/generations',
        provider: 'Provider',
        model: 'Model',
        noProviders: '未在 DSH 模型设置中发现 OpenAI 兼容 Provider，请先在“设置→模型”中添加。',
        providerMissing: '该 Provider 未在模型配置中',
        modelsEmpty: '该 Provider 暂无模型，可点“刷新模型列表”',
        anyModel: '（所有模型）',
        openHint: '配置后会话中可直接说“生成图片 / 图生图 / 生成视频”。',
      },
      en: {
        settingsNav: 'Media Gen',
        subtitle: 'Generate images and videos in chat via OpenAI-compatible providers; output defaults to workspace media_gen.',
        loading: 'loading…',
        save: 'Save settings',
        saving: 'saving…',
        saved: 'saved',
        refresh: 'Refresh models',
        refreshing: 'refreshing…',
        refreshed: 'refreshed',
        error: 'load failed',
        outputDir: 'Output directory',
        outputDirHint: 'Fixed to <current workspace>/media_gen; not editable',
        t2i: 'Text-to-image model',
        t2iHint: 'Image generation (/images/generations)',
        i2i: 'Image-to-image model',
        i2iHint: 'Image editing (/images/edits); requires a model that supports image editing',
        video: 'Video generation model',
        videoHint: 'Video generation (/videos or /videos/generations)',
        videoEndpoint: 'Video endpoint path (optional)',
        videoEndpointHint: 'Leave empty to auto-try /videos then /videos/generations',
        provider: 'Provider',
        model: 'Model',
        noProviders: 'No OpenAI-compatible provider found in DSH Model settings. Add one under Settings → Models first.',
        providerMissing: 'Provider not found in model config',
        modelsEmpty: 'No models for this provider yet; click Refresh models',
        anyModel: '(any model)',
        openHint: 'After saving, you can directly ask in chat to generate an image, edit an image, or generate a video.',
      },
    }

    function labels() {
      var lang = (document.documentElement.lang || navigator.language || 'en').toLowerCase()
      return lang.indexOf('zh') === 0 ? TEXT.zh : TEXT.en
    }

    function parseToolResult(block) {
      if (!block) return null
      var raw = block
      if (typeof block === 'object') {
        if (block.result !== undefined && block.result !== null) raw = block.result
        else if (block.value !== undefined && block.value !== null) raw = block.value
        else if (typeof block.text === 'string') raw = block.text
        else if (Array.isArray(block.content)) {
          raw = block.content
            .map(function (part) {
              return typeof part === 'string' ? part : part && typeof part.text === 'string' ? part.text : ''
            })
            .join('\n')
        }
      }
      if (typeof raw === 'string') {
        try {
          return JSON.parse(raw)
        } catch {
          // Fall back to markdown link extraction below.
          return { __text: raw }
        }
      }
      return raw && typeof raw === 'object' ? raw : null
    }

    function markdownUrlOf(text) {
      if (typeof text !== 'string') return ''
      var m = /\]\((https?:\/\/[^)\s]+)\)/.exec(text)
      return m ? m[1] : ''
    }

    function urlOf(text) {
      if (typeof text !== 'string') return ''
      var fromMarkdown = markdownUrlOf(text)
      if (fromMarkdown) return fromMarkdown
      var plain = /https?:\/\/[^\s)]+/.exec(text)
      return plain ? plain[0] : ''
    }

    function VideoToolCard(react) {
      var h = react.createElement
      return function VideoToolCardComponent(props) {
        var parsed = parseToolResult(props && props.block)
        var url = parsed && typeof parsed.url === 'string' ? parsed.url : ''
        if (!url && parsed && typeof parsed.__text === 'string') {
          url = urlOf(parsed.__text)
        }
        if (!url) {
          var fallback = props && props.block ? props.block.result : null
          if (typeof fallback === 'string') fallback = urlOf(fallback) || fallback
          return h(
            'div',
            { style: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary)', padding: '4px 0' } },
            typeof fallback === 'string' ? fallback : String(fallback || ''),
          )
        }
        var mime = parsed && typeof parsed.mime === 'string' && parsed.mime ? parsed.mime : 'video/mp4'
        var path = parsed && typeof parsed.path === 'string' ? parsed.path : ''
        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '6px 0', alignItems: 'flex-start' } },
          h('video', {
            src: url,
            type: mime,
            controls: true,
            preload: 'metadata',
            style: { width: '100%', maxWidth: 640, borderRadius: 12, display: 'block', background: '#000' },
          }),
          h(
            'div',
            { style: { display: 'flex', gap: 12, alignItems: 'center', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
            h(
              'a',
              {
                href: url,
                download: true,
                style: {
                  color: 'var(--dsw-alias-brand-primary, #4c8bf5)',
                  textDecoration: 'none',
                  fontWeight: 500,
                },
              },
              '下载视频',
            ),
            path
              ? h('span', { style: { color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'anywhere' } }, path)
              : null,
          ),
        )
      }
    }

    function mediaFilenameFromSrc(src) {
      var m = /\/media-gen\/raw\/([^/?#]+)/.exec(src || '')
      return m ? decodeURIComponent(m[1]) : ''
    }

    function closeMediaPopups() {
      var lightbox = document.querySelector('.dsh-media-gen-lightbox')
      if (lightbox) lightbox.remove()
      var menu = document.querySelector('.dsh-media-gen-menu')
      if (menu) menu.remove()
    }

    function showMediaLightbox(src, kind) {
      closeMediaPopups()
      var overlay = document.createElement('div')
      overlay.className = 'dsh-media-gen-lightbox'
      var media
      if (kind === 'video') {
        media = document.createElement('video')
        media.src = src
        media.controls = true
        media.autoplay = true
        media.style.maxWidth = '92vw'
        media.style.maxHeight = '92vh'
        media.style.borderRadius = '12px'
        media.style.background = '#000'
        media.style.boxShadow = '0 20px 60px rgba(0,0,0,.6)'
      } else {
        media = document.createElement('img')
        media.src = src
        media.alt = 'large preview'
      }
      overlay.appendChild(media)
      document.body.appendChild(overlay)
      var close = function () {
        overlay.remove()
        document.removeEventListener('keydown', onKey, true)
      }
      var onKey = function (e) {
        if (e.key === 'Escape') close()
      }
      overlay.addEventListener('click', close)
      document.addEventListener('keydown', onKey, true)
    }

    function findComposerInput() {
      var seat = document.querySelector('[data-composer-seat]')
      if (seat) {
        var inSeat = seat.querySelector('textarea') || seat.querySelector('[contenteditable="true"], [contenteditable="plaintext-only"]')
        if (inSeat) return inSeat
      }
      var fallback = document.querySelector('textarea[data-phase], [data-composer-card] textarea, [data-composer-card] [contenteditable="true"]')
      if (fallback) return fallback
      var active = document.activeElement
      if (active && (active.tagName === 'TEXTAREA' || active.isContentEditable)) return active
      return null
    }

    function insertIntoComposer(text) {
      var el = findComposerInput()
      if (!el) return false
      el.focus()
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        var inserted = false
        try {
          inserted = document.execCommand('insertText', false, text)
        } catch (error) {
          inserted = false
        }
        if (inserted) {
          el.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        }
        var proto = window.HTMLTextAreaElement.prototype
        var setter = Object.getOwnPropertyDescriptor(proto, 'value').set
        var start = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length
        var end = typeof el.selectionEnd === 'number' ? el.selectionEnd : el.value.length
        var next = el.value.slice(0, start) + text + el.value.slice(end)
        setter.call(el, next)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        var pos = start + text.length
        try {
          el.setSelectionRange(pos, pos)
        } catch (error) {
          /* ignore */
        }
        return true
      }
      if (el.isContentEditable) {
        try {
          document.execCommand('insertText', false, text)
          return true
        } catch (error) {
          var selection = window.getSelection()
          if (selection && selection.rangeCount > 0) {
            selection.deleteFromDocument()
            selection.getRangeAt(0).insertNode(document.createTextNode(text))
            return true
          }
        }
      }
      return false
    }

    function showMediaContextMenu(x, y, src) {
      closeMediaPopups()
      var filename = mediaFilenameFromSrc(src)
      var menu = document.createElement('div')
      menu.className = 'dsh-media-gen-menu'
      menu.style.left = Math.max(4, Math.min(x, window.innerWidth - 140)) + 'px'
      menu.style.top = Math.max(4, Math.min(y, window.innerHeight - 60)) + 'px'

      var citeBtn = document.createElement('button')
      citeBtn.type = 'button'
      citeBtn.textContent = '引用'
      citeBtn.addEventListener('click', function () {
        menu.remove()
        if (!filename) return
        fetch('/media-gen/path?name=' + encodeURIComponent(filename))
          .then(function (r) {
            return r.json().then(function (body) {
              if (!r.ok) throw new Error(body.error || 'load failed')
              return body.path
            })
          })
          .then(function (path) {
            if (!insertIntoComposer(path)) {
              if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                navigator.clipboard.writeText(path).catch(function () {})
              }
              console.warn('[dsh-media-gen] composer not found; path = ' + path)
            }
          })
          .catch(function (error) {
            console.error('[dsh-media-gen] cite failed: ' + (error && error.message ? error.message : error))
          })
      })
      menu.appendChild(citeBtn)
      document.body.appendChild(menu)

      var cleanup = function () {
        menu.remove()
        document.removeEventListener('click', outside, true)
        document.removeEventListener('contextmenu', outside, true)
        document.removeEventListener('keydown', onKey, true)
      }
      var outside = function (e) {
        if (!menu.contains(e.target)) cleanup()
      }
      var onKey = function (e) {
        if (e.key === 'Escape') cleanup()
      }
      setTimeout(function () {
        document.addEventListener('click', outside, true)
        document.addEventListener('contextmenu', outside, true)
        document.addEventListener('keydown', onKey, true)
      }, 0)
    }

    function installMediaImagePolish() {
      if (document.getElementById('dsh-media-gen-style')) return
      var style = document.createElement('style')
      style.id = 'dsh-media-gen-style'
      style.textContent =
        'img[src*="/media-gen/raw/"]{max-width:280px;max-height:280px;width:auto;height:auto;border-radius:10px;cursor:zoom-in;}' +
        'video[src*="/media-gen/raw/"]{max-width:360px;max-height:360px;width:auto;height:auto;border-radius:10px;cursor:zoom-in;background:#000;display:block;}' +
        '.dsh-media-gen-lightbox{position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:2147483000;display:flex;align-items:center;justify-content:center;cursor:zoom-out;}' +
        '.dsh-media-gen-lightbox img,.dsh-media-gen-lightbox video{max-width:92vw;max-height:92vh;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.6);}' +
        '.dsh-media-gen-menu{position:fixed;z-index:2147483001;min-width:120px;background:var(--dsw-alias-bg-layer-3,#fff);color:var(--dsw-alias-label-primary,#111);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));border-radius:8px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,.25);}' +
        '.dsh-media-gen-menu button{display:block;width:100%;text-align:left;font:inherit;font-size:13px;line-height:1.6;padding:6px 10px;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;}' +
        '.dsh-media-gen-menu button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.15));}'
      document.head.appendChild(style)

      function mediaSrcOf(target) {
        if (!target) return ''
        var src = target.getAttribute && target.getAttribute('src')
        if (target.tagName === 'VIDEO' && !src) {
          var source = target.querySelector('source')
          src = source && source.getAttribute && source.getAttribute('src')
        }
        return src || ''
      }

      function isMediaTarget(target) {
        return target && (target.tagName === 'IMG' || target.tagName === 'VIDEO') && /\/media-gen\/raw\//.test(mediaSrcOf(target))
      }

      document.addEventListener(
        'click',
        function (e) {
          var t = e.target
          if (isMediaTarget(t)) {
            if (t.closest && t.closest('.dsh-media-gen-lightbox')) return
            e.preventDefault()
            e.stopPropagation()
            showMediaLightbox(mediaSrcOf(t), t.tagName === 'VIDEO' ? 'video' : 'image')
          }
        },
        true,
      )

      document.addEventListener(
        'contextmenu',
        function (e) {
          var t = e.target
          if (isMediaTarget(t)) {
            if (t.closest && t.closest('.dsh-media-gen-lightbox')) return
            e.preventDefault()
            showMediaContextMenu(e.clientX, e.clientY, mediaSrcOf(t))
          }
        },
        true,
      )
    }

    function installVideoFenceHydration() {
      if (window.__dshMediaGenVideoHydrated) return
      window.__dshMediaGenVideoHydrated = true
      var processing = false
      var VIDEO_JSON_RE = /\{\s*"type"\s*:\s*"video"\s*,\s*"src"\s*:\s*"(https?:\/\/[^"]+)"[^}]*\}/

      function videoFromSrc(src) {
        var video = document.createElement('video')
        video.src = src
        video.controls = true
        video.preload = 'metadata'
        video.style.maxWidth = '360px'
        video.style.maxHeight = '360px'
        video.style.width = 'auto'
        video.style.height = 'auto'
        video.style.borderRadius = '10px'
        video.style.background = '#000'
        video.style.display = 'block'
        return video
      }

      function hydrate(node) {
        if (processing || !node || node.nodeType !== Node.TEXT_NODE) return
        var raw = node.data || ''
        var trimmed = raw.trim()
        var inner = trimmed
        if (inner.indexOf('<dsh-ui>') === 0 && inner.lastIndexOf('</dsh-ui>') === inner.length - 9) {
          inner = inner.slice(8, -9)
        }
        var match = VIDEO_JSON_RE.exec(inner)
        if (!match) return
        processing = true
        try {
          var parent = node.parentNode
          if (parent && parent.childNodes.length === 1) {
            parent.replaceWith(videoFromSrc(match[1]))
          } else {
            node.replaceWith(videoFromSrc(match[1]))
          }
        } catch (error) {
          /* ignore */
        } finally {
          processing = false
        }
      }

      function scan(root) {
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null)
        var nodes = []
        while (walker.nextNode()) nodes.push(walker.currentNode)
        nodes.forEach(hydrate)
      }

      scan(document.body)

      var observer = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var m = mutations[i]
          if (m.type === 'childList') {
            for (var j = 0; j < m.addedNodes.length; j++) {
              var added = m.addedNodes[j]
              if (added.nodeType === Node.TEXT_NODE) hydrate(added)
              else if (added.nodeType === Node.ELEMENT_NODE) scan(added)
            }
          } else if (m.type === 'characterData') {
            hydrate(m.target)
          }
        }
      })
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    }

    function MediaGenSection(react) {
      var h = react.createElement

      return function DshMediaGenSection() {
        var t = labels()
        var configState = react.useState(null)
        var providersState = react.useState(null)
        var draftState = react.useState(null)
        var messageState = react.useState(null)
        var busyState = react.useState(false)

        var config = configState[0]
        var providers = providersState[0] || []
        var draft = draftState[0]
        var message = messageState[0]
        var busy = busyState[0]

        var loadAll = react.useCallback(function (probe) {
          busyState[1](true)
          messageState[1](null)
          var url = probe ? '/media-gen/providers?probe=1' : '/media-gen/providers'
          Promise.all([
            fetch('/media-gen/config').then(function (r) {
              return r.json().then(function (body) {
                if (!r.ok) throw new Error(body.error || t.error)
                return body.config
              })
            }),
            fetch(url).then(function (r) {
              return r.json().then(function (body) {
                if (!r.ok) throw new Error(body.error || t.error)
                return body.providers || []
              })
            }),
          ])
            .then(function (results) {
              configState[1](results[0])
              providersState[1](results[1])
              draftState[1](Object.assign({}, results[0]))
              busyState[1](false)
              messageState[1](probe ? { ok: true, text: t.refreshed } : null)
            })
            .catch(function (error) {
              busyState[1](false)
              messageState[1]({ ok: false, text: String(error && error.message ? error.message : error) })
            })
        }, [])

        react.useEffect(function () {
          loadAll(false)
        }, [loadAll])

        function setField(key, value) {
          draftState[1](function (prev) {
            var next = Object.assign({}, prev || {})
            next[key] = value
            return next
          })
        }

        function onProviderChange(providerField, modelField, providerId) {
          draftState[1](function (prev) {
            var next = Object.assign({}, prev || {})
            next[providerField] = providerId
            next[modelField] = ''
            return next
          })
        }

        function modelsOf(providerId) {
          var p = providers.find(function (item) {
            return item.id === providerId
          })
          return p ? p.models || [] : []
        }

        function saveSettings() {
          if (!draft) return
          busyState[1](true)
          messageState[1](null)
          var payload = {
            imageProvider: draft.imageProvider || '',
            imageModel: draft.imageModel || '',
            imageEditProvider: draft.imageEditProvider || '',
            imageEditModel: draft.imageEditModel || '',
            videoProvider: draft.videoProvider || '',
            videoModel: draft.videoModel || '',
            videoEndpoint: draft.videoEndpoint || '',
          }
          fetch('/media-gen/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
            .then(function (r) {
              return r.json().then(function (body) {
                if (!r.ok) throw new Error(body.error || 'save failed')
                return body
              })
            })
            .then(function (body) {
              configState[1](body.config)
              draftState[1](Object.assign({}, body.config))
              busyState[1](false)
              messageState[1]({ ok: true, text: t.saved })
            })
            .catch(function (error) {
              busyState[1](false)
              messageState[1]({ ok: false, text: String(error && error.message ? error.message : error) })
            })
        }

        var rowContainer = {
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          padding: '12px 0',
          borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
        }
        var labelStyle = {
          fontSize: '13px',
          color: 'var(--dsw-alias-label-primary, inherit)',
          fontWeight: 600,
        }
        var hintStyle = {
          fontSize: '12px',
          color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
          lineHeight: 1.5,
        }
        var selectStyle = {
          appearance: 'none',
          font: 'inherit',
          fontSize: '13px',
          lineHeight: 1.5,
          padding: '6px 10px',
          borderRadius: '8px',
          border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
          background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.10))',
          color: 'var(--dsw-alias-label-primary, inherit)',
          width: '100%',
        }
        var inputStyle = Object.assign({}, selectStyle, { appearance: 'textfield' })
        var twoCol = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }
        var fieldTitle = { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, inherit)', marginBottom: '3px' }

        function sectionRow(title, hint, providerField, modelField) {
          var providerId = draft ? draft[providerField] : ''
          var modelId = draft ? draft[modelField] : ''
          var models = modelsOf(providerId)
          var providerOptions = [h('option', { key: '', value: '' }, '—')].concat(
            providers.map(function (p) {
              return h('option', { key: p.id, value: p.id }, p.id + (p.name && p.name !== p.id ? ' · ' + p.name : ''))
            }),
          )
          var modelOptions = [h('option', { key: '', value: '' }, t.anyModel)].concat(
            models.map(function (m) {
              return h('option', { key: m.id, value: m.id }, m.name && m.name !== m.id ? m.id + ' · ' + m.name : m.id)
            }),
          )
          return h(
            'div',
            { key: title, style: rowContainer },
            h('div', { style: labelStyle }, title),
            h('div', { style: hintStyle }, hint),
            h(
              'div',
              { style: twoCol },
              h(
                'div',
                null,
                h('div', { style: fieldTitle }, t.provider),
                h(
                  'select',
                  {
                    value: providerId,
                    disabled: busy,
                    onChange: function (event) {
                      onProviderChange(providerField, modelField, event.target.value)
                    },
                    style: selectStyle,
                  },
                  providerOptions,
                ),
              ),
              h(
                'div',
                null,
                h('div', { style: fieldTitle }, t.model),
                h(
                  'select',
                  {
                    value: modelId,
                    disabled: busy || !providerId,
                    onChange: function (event) {
                      setField(modelField, event.target.value)
                    },
                    style: selectStyle,
                  },
                  modelOptions,
                ),
              ),
            ),
          )
        }

        var statusStyle = {
          fontSize: '12px',
          lineHeight: 1.5,
          margin: '8px 0 4px',
          color: message && message.ok
            ? 'var(--dsw-alias-success, #7ed18c)'
            : 'var(--dsw-alias-danger, #ff7a7a)',
        }

        var body = null
        if (!config || !draft) {
          body = h('div', { style: { padding: '12px 0', fontSize: '13px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))' } }, t.loading)
        } else {
          body = h(
            'div',
            { style: { padding: '4px 0 12px' } },
            providers.length === 0
              ? h('div', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))', padding: '8px 0' } }, t.noProviders)
              : null,
            h(
              'div',
              { style: rowContainer },
              h('div', { style: labelStyle }, t.outputDir),
              h('div', { style: hintStyle }, t.outputDirHint),
              h(
                'div',
                {
                  style: Object.assign({}, inputStyle, {
                    background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.10))',
                    color: 'var(--dsw-alias-label-secondary, inherit)',
                    cursor: 'not-allowed',
                  }),
                },
                draft.outputDir || 'media_gen',
              ),
            ),
            sectionRow(t.t2i, t.t2iHint, 'imageProvider', 'imageModel'),
            sectionRow(t.i2i, t.i2iHint, 'imageEditProvider', 'imageEditModel'),
            sectionRow(t.video, t.videoHint, 'videoProvider', 'videoModel'),
            h(
              'div',
              { style: rowContainer },
              h('div', { style: labelStyle }, t.videoEndpoint),
              h('div', { style: hintStyle }, t.videoEndpointHint),
              h('input', {
                type: 'text',
                value: draft.videoEndpoint || '',
                disabled: busy,
                onChange: function (event) {
                  setField('videoEndpoint', event.target.value)
                },
                style: inputStyle,
                placeholder: '/videos/generations',
              }),
            ),
            message
              ? h('div', { role: 'status', style: statusStyle }, message.text)
              : null,
            h(
              'div',
              { style: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '8px', paddingTop: '4px' } },
              h(
                'button',
                {
                  type: 'button',
                  disabled: busy,
                  onClick: function () {
                    loadAll(true)
                  },
                  style: secondaryBtn(),
                },
                busy ? t.refreshing : t.refresh,
              ),
              h(
                'button',
                {
                  type: 'button',
                  disabled: busy,
                  onClick: saveSettings,
                  style: primaryBtn(busy),
                },
                busy ? t.saving : t.save,
              ),
            ),
            h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))', lineHeight: 1.5, marginTop: '6px' } }, t.openHint),
          )
        }

        function secondaryBtn() {
          return {
            appearance: 'none',
            font: 'inherit',
            fontSize: '13px',
            lineHeight: 1.5,
            cursor: 'pointer',
            border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
            borderRadius: '8px',
            padding: '5px 12px',
            background: 'transparent',
            color: 'var(--dsw-alias-label-primary, inherit)',
          }
        }
        function primaryBtn(disabled) {
          return {
            appearance: 'none',
            font: 'inherit',
            fontSize: '13px',
            lineHeight: 1.5,
            cursor: disabled ? 'default' : 'pointer',
            border: '1px solid transparent',
            borderRadius: '8px',
            padding: '5px 14px',
            background: 'var(--dsw-alias-label-primary, currentColor)',
            color: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))',
            opacity: disabled ? 0.5 : 1,
          }
        }

        return h(
          'div',
          {
            style: {
              border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
              background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.10))',
              borderRadius: '12px',
              padding: '16px',
            },
          },
          h('div', { style: { fontSize: '14px', fontWeight: 600, marginBottom: '4px' } }, t.settingsNav),
          h('div', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))', lineHeight: 1.5, marginBottom: '8px' } }, t.subtitle),
          body,
        )
      }
    }

    function apply(ctx) {
      try {
        var react = require('react')
        installMediaImagePolish()
        var Section = MediaGenSection(react)
        ctx.slots.inject('settings.section', function* () {
          yield ctx.slots.register(
            {
              name: 'settings.section',
              id: 'dsh-media-gen',
              order: 40,
              label: function () {
                return labels().settingsNav
              },
              inject: function () {
                return {}
              },
            },
            Section,
          )
        })
      } catch (error) {
        console.error('[dsh-media-gen] client apply skipped: ' + error)
      }
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})