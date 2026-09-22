/**
 * Baize session — browser half.
 *
 * Two additive seats, nothing replaced:
 *   • `conversation.view` — the 整理 tab. The content is always THIS
 *     conversation (you are already in it), so the page is just two dropdowns
 *     and a button: ① pick the target workspace → ② pick the target conversation
 *     (existing, or a new one) → ③ relocate. Dropdowns keep it compact; only the
 *     message list is laid out flat, because its rows are checkboxes.
 *   • `conversation.chat.assistant-actions` — a "＋" beside each assistant reply
 *     for grabbing content without leaving the chat.
 *
 * Everything goes through `/baize-session.api`, the same runtime the
 * `/baize-session` command drives.
 *
 * Hand-authored like `dsh-baize-rules`' client: the official `clientBundle`
 * tsdown preset is not published, so a plugin outside the dsh repository
 * reproduces the `window.__ModuleLoader__.load({id, factory})` shell itself and
 * keeps only the seed modules external (react / primitives).
 *
 * @module dsh-baize-session/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-baize-session',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const react = require('react');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const { useState, useEffect, useCallback, useRef } = react;
    const h = react.createElement;

    const inject = ['slots', 'locale'];
    const NS = 'baize-session';
    /** Dropdown sentinel for "type a path myself"; never sent to the host. */
    const CUSTOM = '\u0000custom';

    /**
     * Short local timestamp (MM-DD HH:mm) used to tell identically-named
     * conversations apart — most sessions are named from their first prompt, so
     * duplicates like "测试" are normal.
     */
    function when(ms) {
      if (!ms) return '';
      const d = new Date(ms);
      const p = (n) => String(n).padStart(2, '0');
      return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }

    const dictionaries = {
      zh: {
        'view.tidy': '整理',
        'collect': '收进篮子',
        'collected': '已收集（点击取消）',
        'project': '目标工作区',
        'conversation': '目标对话',
        'thisSession': '当前对话',
        'thisProject': '当前工作区',
        'ungrouped': '未分组',
        'untitled': '（无标题）',
        'newSession': '新建对话',
        'newSessionMeta': '作为新对话的开场',
        'open': '已打开',
        'notOpen': '未打开',
        'custom': '手填绝对路径…',
        'noChoice': '未选择',
        'needWorkspace': '请先选择目标工作区',
        'messages': '条消息',
        'empty': '这个对话还没有消息。',
        'coldTargetTip': '未打开的会话不能直接追加，先在侧边栏打开它，或改成新建对话',
        'basket': '已选',
        'pieces': '段',
        'from': '来自',
        'sessions': '个会话',
        'tokens': '约 tokens',
        'go': '迁移',
        'clear': '清空',
        'detailHint': '点击查看完整内容',
        'chars': '字',
        'doneNew': '已新建对话',
        'doneExisting': '已追加到对话',
        'hint': '到侧边栏打开它即可继续',
        'error': '操作失败',
      },
      en: {
        'view.tidy': 'Tidy',
        'collect': 'Collect',
        'collected': 'Collected (click to undo)',
        'project': 'Target workspace',
        'conversation': 'Target conversation',
        'thisSession': 'Current conversation',
        'thisProject': 'Current workspace',
        'ungrouped': 'Ungrouped',
        'untitled': '(untitled)',
        'newSession': 'New conversation',
        'newSessionMeta': 'carry this content as its opening',
        'open': 'open',
        'notOpen': 'not open',
        'custom': 'Type an absolute path…',
        'noChoice': 'none selected',
        'needWorkspace': 'Pick a target workspace first',
        'messages': 'messages',
        'empty': 'This conversation has no messages yet.',
        'coldTargetTip': 'A closed session cannot be appended to — open it from the sidebar first, or pick "New conversation"',
        'basket': 'Selected',
        'pieces': 'items',
        'from': 'from',
        'sessions': 'sessions',
        'tokens': '~ tokens',
        'go': 'Relocate',
        'clear': 'Clear',
        'detailHint': 'Click to read the whole message',
        'chars': 'chars',
        'doneNew': 'Created conversation',
        'doneExisting': 'Appended to conversation',
        'hint': 'open it from the sidebar to continue',
        'error': 'Failed',
      },
    };

    // --- Module-scoped panel state, shared by both seats. ---
    let panelState = null;
    const listeners = new Set();
    function setPanelState(next) {
      panelState = next;
      listeners.forEach((fn) => fn(next));
    }
    function usePanelState() {
      const [value, setValue] = useState(panelState);
      useEffect(() => {
        const fn = (v) => setValue(v);
        listeners.add(fn);
        fn(panelState);
        return () => { listeners.delete(fn); };
      }, []);
      return value;
    }

    const CSS = [
      '.baize-collect{box-sizing:border-box;cursor:pointer;border:none;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;padding:2px 6px;font-family:inherit;font-size:12px;line-height:16px}',
      '.baize-collect:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.baize-collect.baize-on{color:var(--dsw-alias-state-business-primary);font-weight:600}',
      // The official view host is a flex column that already claims the
      // remaining height (`.viewArea{flex-direction:column;flex:1;min-height:0;
      // display:flex}`, dsh-client-ui-conversation). So the page claims that
      // height too and becomes a flex column itself: the pickers and the action
      // bar keep their natural size, and the table takes everything left over —
      // no fixed max-height, it grows and shrinks with the window.
      '.baize-page{box-sizing:border-box;display:flex;flex-direction:column;flex:1 1 auto;min-height:0;height:100%;padding:16px;font-family:inherit;color:var(--dsw-alias-label-primary)}',
      '.baize-h1{font-size:15px;line-height:22px;font-weight:600;margin:0 0 12px;flex:none}',
      // Compact picker rows: label + dropdown on one line.
      '.baize-field{display:flex;align-items:center;gap:10px;margin-bottom:8px;flex:none}',
      '.baize-label{width:76px;flex:none;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.baize-dd{position:relative;flex-grow:1;min-width:0}',
      '.baize-ddbtn{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;cursor:pointer;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px;text-align:left}',
      '.baize-ddbtn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.baize-ddbtn .baize-ddmain{flex-grow:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.baize-ddbtn .baize-ddmeta{color:var(--dsw-alias-label-secondary);font-size:11px;flex:none}',
      '.baize-ddbtn .baize-caret{color:var(--dsw-alias-label-secondary);flex:none}',
      '.baize-ddmenu{position:absolute;top:100%;left:0;right:0;z-index:60;margin-top:4px;padding:4px;max-height:280px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 6px 20px rgba(0,0,0,.18)}',
      '.baize-dditem{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;cursor:pointer;padding:6px 10px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px;text-align:left}',
      '.baize-dditem:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.baize-dditem.baize-on{border-color:var(--dsw-alias-state-business-primary);font-weight:600}',
      '.baize-dditem .baize-ddmain{flex-grow:1;word-break:break-all}',
      '.baize-dditem .baize-ddmeta{color:var(--dsw-alias-label-secondary);font-size:11px;flex:none}',
      '.baize-ddempty{padding:6px 10px;color:var(--dsw-alias-label-secondary);font-size:12px}',
      // Message list
      '.baize-list{flex:1 1 auto;min-height:120px;margin-top:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;overflow:auto;background:var(--dsw-alias-bg-layer-2)}',
      '.baize-row{display:flex;gap:8px;align-items:flex-start;padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,var(--dsw-alias-border-l2));cursor:pointer}',
      '.baize-row:last-child{border-bottom:none}',
      '.baize-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.baize-row input{margin-top:2px;flex:none}',
      '.baize-seq{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;flex:none;min-width:26px}',
      // Role badge, copied from the official Trajectory view's own kind tags
      // (`TrajectoryTable.module.css` in dsh-client-ui-trajectory): its
      // `KIND_LABEL` maps user/context/message(ASSISTANT)/tool and the classes
      // `.user` / `.contextGreen` / `.assistantVioletBright` / `.toolAmber`
      // carry the colours. Same sizes too — 19px tall, 10px/650 label, 4px
      // radius, uppercase, letter-spacing .035em.
      '.baize-role{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none;min-width:68px;height:19px;padding:0 5px;border:1px solid transparent;border-radius:4px;font-size:10px;font-weight:650;line-height:16px;letter-spacing:.035em;text-transform:uppercase;user-select:none;white-space:nowrap;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.baize-role-user{color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}',
      '.baize-role-context{color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 68%, var(--dsw-alias-label-secondary));background:var(--dsw-alias-state-success-tertiary)}',
      '.baize-role-assistant{color:color-mix(in srgb, var(--dsw-alias-brand-primary-new-colorprimary-new-color) 60%, var(--dsw-alias-state-error-secondary));background:color-mix(in srgb, color-mix(in srgb, var(--dsw-alias-brand-primary-new-colorprimary-new-color) 55%, var(--dsw-alias-state-error-secondary)) 15%, var(--dsw-alias-bg-layer-1))}',
      '.baize-role-tool{color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary)}',
      '.baize-text{flex-grow:1;font-size:13px;line-height:19px;word-break:break-word}',
      '.baize-rowopen{background:var(--dsw-alias-interactive-bg-hover)}',
      '.baize-detail{padding:6px 10px 10px 44px;border-bottom:1px solid var(--dsw-alias-border-l1,var(--dsw-alias-border-l2));background:var(--dsw-alias-bg-layer-1)}',
      '.baize-detailmeta{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;margin-bottom:4px}',
      '.baize-detailbody{white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:19px;color:var(--dsw-alias-label-primary);max-height:40vh;overflow:auto;user-select:text}',
      // Action bar
      '.baize-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:none;margin-top:12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-specific-sidebar-fill);font-size:12px;line-height:18px}',
      '.baize-bar b{color:var(--dsw-alias-label-primary)}',
      '.baize-grow{flex-grow:1}',
      '.baize-btn{box-sizing:border-box;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:16px;padding:4px 12px}',
      '.baize-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.baize-btn.baize-primary{border-color:var(--dsw-alias-state-business-primary);font-weight:600}',
      '.baize-btn[disabled]{opacity:.45;cursor:not-allowed}',
      '.baize-note{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:8px}',
      '.baize-err{flex:none;color:var(--dsw-alias-state-error-primary);font-size:12px;margin-top:8px}',
    ].join('');
    let stylesInjected = false;
    function injectStyles() {
      if (stylesInjected || typeof document === 'undefined') return;
      stylesInjected = true;
      const tag = document.createElement('style');
      tag.dataset.plugin = NS;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // --- Host API (same source of truth as /baize-session). ---
    async function apiGet(sessionId, sourceId) {
      const q = new URLSearchParams({ sessionId });
      if (sourceId) q.set('source', sourceId);
      const res = await fetch('/baize-session.api?' + q.toString());
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'get failed');
      return body;
    }
    async function apiPost(sessionId, payload) {
      const res = await fetch('/baize-session.api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, ...payload }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || body.text || 'post failed');
      return body;
    }

    /** The framework standard kit carries sessionId on every session-scope seat. */
    function sessionIdOf(props) {
      return String(props?.sessionId ?? props?.session?.sessionId ?? props?.session?.id ?? '');
    }

    /** Compact dropdown: one line closed, an overlay list when open. */
    function Dropdown(props) {
      const { label, value, options, placeholder, onPick, disabled } = props;
      const [open, setOpen] = useState(false);
      const box = useRef(null);
      useEffect(() => {
        if (!open || typeof document === 'undefined') return undefined;
        const onDown = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('mousedown', onDown);
          document.removeEventListener('keydown', onKey);
        };
      }, [open]);
      const current = options.find((o) => o.value === value);
      return h('div', { className: 'baize-field' },
        label ? h('span', { className: 'baize-label' }, label) : null,
        h('div', { className: 'baize-dd', ref: box },
          h('button', {
            type: 'button', className: 'baize-ddbtn', disabled,
            onClick: () => setOpen(!open),
          },
            h('span', { className: 'baize-ddmain' }, current ? current.label : placeholder),
            current && current.meta ? h('span', { className: 'baize-ddmeta' }, current.meta) : null,
            h('span', { className: 'baize-caret' }, open ? '▴' : '▾'),
          ),
          open
            ? h('div', { className: 'baize-ddmenu', role: 'listbox' },
                options.length === 0
                  ? h('div', { className: 'baize-ddempty' }, props.emptyText || '—')
                  : options.map((o) => h('button', {
                      key: o.value, type: 'button', role: 'option',
                      'aria-selected': o.value === value,
                      className: 'baize-dditem' + (o.value === value ? ' baize-on' : ''),
                      title: o.title,
                      onClick: () => { onPick(o.value); setOpen(false); },
                    },
                      h('span', { className: 'baize-ddmain' }, o.label),
                      o.meta ? h('span', { className: 'baize-ddmeta' }, o.meta) : null,
                    )))
            : null,
        ),
      );
    }

    /** "＋" beside one assistant reply — grab it without opening the tab. */
    function CollectButton(props) {
      const t = props.t;
      const sessionId = sessionIdOf(props);
      const messageId = props.messageId;
      const state = usePanelState();
      const [busy, setBusy] = useState(false);
      const [err, setErr] = useState('');
      const collected = !!((state && state.basket) || []).some((item) => item.messageId === messageId);

      const toggle = async () => {
        if (busy || !sessionId || !messageId) return;
        setBusy(true);
        try {
          const body = collected
            ? await apiPost(sessionId, { op: 'untake', messageId, sourceId: sessionId })
            : await apiPost(sessionId, { op: 'take', messageIds: [messageId], sourceId: sessionId });
          setPanelState(body.state);
          setErr('');
        } catch (e) {
          setErr(String(e));
        }
        setBusy(false);
      };

      return h('button', {
        type: 'button',
        className: 'baize-collect' + (collected ? ' baize-on' : ''),
        title: err ? t('error') + ': ' + err : (collected ? t('collected') : t('collect')),
        onClick: (e) => { e.stopPropagation(); void toggle(); },
      }, collected ? '✓' : '＋');
    }

    /** The 整理 tab: ① target workspace → ② target conversation → ③ go. */
    function TidyPage(props) {
      const t = props.t;
      const sessionId = sessionIdOf(props);
      const [state, setLocal] = useState(null);
      const [err, setErr] = useState('');
      const [notice, setNotice] = useState('');
      const [busy, setBusy] = useState(false);
      const [targetCwd, setTargetCwd] = useState('');
      const [targetSession, setTargetSession] = useState('');
      const [custom, setCustom] = useState('');
      const [customOpen, setCustomOpen] = useState(false);
      const [tokens, setTokens] = useState(null);
      // seq of the row whose full text is expanded, or null.
      const [detail, setDetail] = useState(null);

      const load = useCallback(async () => {
        if (!sessionId) return;
        try {
          const body = await apiGet(sessionId);
          setLocal(body);
          setPanelState(body);
          setErr('');
        } catch (e) {
          setErr(String(e));
        }
      }, [sessionId]);

      useEffect(() => { void load(); }, [load]);

      const basket = (state && state.basket) || [];
      const projects = (state && state.projects) || [];
      const sessions = (state && state.sessions) || [];
      // The content list is always THIS conversation's — you are already looking
      // at it, so there is nothing to pick. Extra material still arrives here
      // through the ＋ button on any reply (the basket is cross-session), which
      // is why the footer keeps counting distinct source sessions.
      const messages = (state && state.messages) || [];
      const myCwd = (state && state.cwd) || '';
      const sources = new Set(basket.map((i) => i.sessionId)).size;
      const inBasket = (seq) => basket.some((item) => item.sessionId === sessionId && item.seq === seq);

      useEffect(() => {
        if (targetCwd === '' && myCwd) setTargetCwd(myCwd);
      }, [myCwd]);

      useEffect(() => {
        if (basket.length === 0 || !sessionId) { setTokens(null); return; }
        const target = targetSession
          ? { kind: 'existing', sessionId: targetSession }
          : { kind: 'new', cwd: targetCwd };
        let alive = true;
        apiPost(sessionId, { op: 'estimate', target })
          .then((r) => { if (alive) setTokens(r.tokens); })
          .catch(() => {});
        return () => { alive = false; };
      }, [basket.length, sessionId, targetCwd, targetSession]);

      // ① workspace options. The list comes from the workspace registry, in its
      // own durable order (the current one first); a workspace that has no real
      // conversation yet just shows no count. The last entry reveals a
      // free-text field instead of adding a permanently visible input row — the
      // page stays dropdown-only.
      const projectOptions = projects.map((p) => ({
        value: p.path,
        label: p.path,
        meta: p.isCurrent ? t('thisProject')
          : (p.ungrouped ? t('ungrouped')
            : (p.sessions > 0 ? p.sessions + ' ' + t('sessions') : '')),
      }));
      if (custom.trim() && !projectOptions.some((o) => o.value === custom.trim())) {
        projectOptions.push({ value: custom.trim(), label: custom.trim(), meta: '' });
      }
      projectOptions.push({ value: CUSTOM, label: t('custom'), meta: '' });

      // ② target conversation options — shown by NAME (the session's own logged
      // title), never by id; the id stays in the tooltip for disambiguation.
      //
      // Only real conversations are offered. The official sidebar's visibility
      // rule is `origin !== 'subagent' && !archived && (!blank || isCurrent)`
      // (dsh-client-ui-workspace/lib/client.js:100), and `blank` means "no turn
      // has run" — the sidebar renders those as the workspace's provisional
      // "New Session" row, with a fixed label and no real title. Listing them
      // here produced a wall of 「（无标题）」, so they are filtered the same way;
      // "新建对话" is exactly that row's equivalent in this picker.
      const convOptions = [
        { value: '', label: t('newSession'), meta: t('newSessionMeta') },
        ...sessions.filter((s) => s.cwd === targetCwd && s.id !== sessionId && !s.blank && !s.archived).map((s) => ({
          value: s.id,
          label: s.name || t('untitled'),
          meta: when(s.createdAt) + (s.live ? '' : ' · ' + t('notOpen')),
          title: s.id + ' · ' + s.messages + ' ' + t('messages'),
        })),
      ];

      const toggle = async (seq) => {
        try {
          const body = inBasket(seq)
            ? await apiPost(sessionId, { op: 'untake', seq, sourceId: sessionId })
            : await apiPost(sessionId, { op: 'take', seqs: [seq], sourceId: sessionId });
          setLocal(body.state);
          setPanelState(body.state);
          setNotice('');
        } catch (e) { setNotice(String(e)); }
      };

      const clear = async () => {
        try {
          const body = await apiPost(sessionId, { op: 'drop' });
          setLocal(body.state);
          setPanelState(body.state);
          setNotice('');
        } catch (e) { setNotice(String(e)); }
      };

      const go = async () => {
        const target = targetSession
          ? { kind: 'existing', sessionId: targetSession }
          : { kind: 'new', cwd: targetCwd.trim() };
        if (target.kind === 'new' && target.cwd.length === 0) { setNotice(t('needWorkspace')); return; }
        setBusy(true);
        try {
          const body = await apiPost(sessionId, { op: 'relocate', target });
          setLocal(body.state);
          setPanelState(body.state);
          setNotice((body.mode === 'existing' ? t('doneExisting') : t('doneNew'))
            + ' ' + String(body.sessionId).slice(0, 24) + ' · ' + t('hint'));
        } catch (e) { setNotice(String(e)); }
        setBusy(false);
      };

      return h('div', { className: 'baize-page' },
        h('h2', { className: 'baize-h1' }, t('view.tidy')),

        // ① target workspace; choosing 手填绝对路径… reveals the field in place
        h(Dropdown, {
          label: t('project'),
          value: customOpen ? CUSTOM : targetCwd,
          options: projectOptions,
          placeholder: t('noChoice'),
          emptyText: t('noChoice'),
          onPick: (v) => {
            setTargetSession('');
            if (v === CUSTOM) { setCustomOpen(true); setTargetCwd(custom.trim()); return; }
            setCustomOpen(false);
            setTargetCwd(v);
          },
        }),
        customOpen
          ? h('div', { className: 'baize-field' },
              h('span', { className: 'baize-label' }, ''),
              h('input', {
                className: 'baize-input', value: custom, placeholder: t('custom'), autoFocus: true,
                onChange: (e) => {
                  setCustom(e.target.value);
                  setTargetCwd(e.target.value.trim());
                },
                style: { flexGrow: 1, minWidth: 0, padding: '5px 8px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit', fontSize: 12 },
              }),
            )
          : null,

        // ② target conversation
        h(Dropdown, {
          label: t('conversation'),
          value: targetSession,
          options: convOptions,
          placeholder: t('newSession'),
          onPick: setTargetSession,
          emptyText: t('noChoice'),
        }),

        // ③ the action bar, directly under the conversation picker: what is
        // selected and the button that commits it, before the list it acts on.
        h('div', { className: 'baize-bar' },
          h('span', null, t('basket') + ' ', h('b', null, String(basket.length)), ' ' + t('pieces'),
            basket.length > 0 ? '（' + t('from') + ' ' + sources + ' ' + t('sessions') + '）' : ''),
          tokens !== null ? h('span', null, '· ' + t('tokens') + ' ' + tokens) : null,
          h('span', { className: 'baize-grow' }),
          basket.length > 0
            ? h('button', { type: 'button', className: 'baize-btn', onClick: () => void clear() }, t('clear'))
            : null,
          h('button', {
            type: 'button', className: 'baize-btn baize-primary',
            disabled: busy || basket.length === 0,
            onClick: () => void go(),
          }, t('go')),
        ),

        // Result of the action above belongs next to its button, not at the
        // bottom of the page.
        err ? h('div', { className: 'baize-err' }, t('error') + ': ' + err) : null,
        notice ? h('div', { className: 'baize-note' }, notice) : null,

        // content
        messages.length === 0
          ? h('div', { className: 'baize-note' }, t('empty'))
          : h('div', { className: 'baize-list' },
              messages.map((m) => h(react.Fragment, { key: m.seq },
                // Clicking the row shows its details; only the checkbox selects.
                // (It used to be a <label>, which made every click a selection.)
                h('div', {
                  className: 'baize-row' + (detail === m.seq ? ' baize-rowopen' : ''),
                  title: t('detailHint'),
                  onClick: () => setDetail(detail === m.seq ? null : m.seq),
                },
                  h('input', {
                    type: 'checkbox',
                    checked: inBasket(m.seq),
                    // Keep a tick from also toggling this row's detail.
                    onClick: (e) => e.stopPropagation(),
                    onChange: () => void toggle(m.seq),
                  }),
                  h('span', { className: 'baize-seq' }, String(m.seq)),
                  h('span', { className: 'baize-role baize-role-' + m.role }, m.role),
                  h('span', { className: 'baize-text' }, m.preview),
                ),
                detail === m.seq
                  ? h('div', { className: 'baize-detail' },
                      h('div', { className: 'baize-detailmeta' },
                        h('span', { className: 'baize-role baize-role-' + m.role }, m.role),
                        ' #' + m.seq + ' · ' + m.text.length + ' ' + t('chars')),
                      h('div', { className: 'baize-detailbody' }, m.text))
                  : null,
              ))),
      );
    }

    function apply(ctx) {
      injectStyles();
      ctx.effect(() => ctx.locale.register(NS, dictionaries), 'baize-session: dictionaries');

      ctx.slots.inject('conversation.view', () => {
        const t = ctx.locale.bind(NS);
        return ctx.slots.register({
          name: 'conversation.view',
          id: 'baize-session-tidy',
          order: 40,
          locale: NS,
          label: () => t('view.tidy'),
        }, (props) => h(TidyPage, { ...props, t }));
      });

      ctx.slots.inject('conversation.chat.assistant-actions', () => {
        const t = ctx.locale.bind(NS);
        return ctx.slots.register({
          name: 'conversation.chat.assistant-actions',
          id: 'baize-session-collect',
          order: 20,
          locale: NS,
        }, (props) => h(CollectButton, { ...props, t }));
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
