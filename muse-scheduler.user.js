// ==UserScript==
// @name         Muse 定时发信（指定会话）
// @namespace    https://github.com/pingmike2/muse-scheduler
// @version      1.0.0
// @description  在 muse.ai 上按计划把文本消息定时发送到指定会话（/thread/xxx）。muse2api 的对话接口是无状态的，只有网页端才能真正发进已有会话。
// @author       pingmike2
// @match        https://muse.ai/*
// @match        https://*.muse.ai/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '1.0.0';
  const STATE_KEY = 'm2a_sched_state_v1';
  const TABS_KEY = 'm2a_sched_tabs';
  const NAV_KEY = 'm2a_sched_nav';
  const PENDING_NAV_KEY = 'm2a_sched_pending_nav';
  const LOCK_PREFIX = 'm2a_sched_lock_';
  const TAB_ID = 'tab_' + Math.random().toString(36).slice(2, 10);
  const TICK_MS = 3000;
  const RETRY_MS = 5 * 60 * 1000;
  const LOCK_TTL = 4 * 60 * 1000;
  const SEND_TIMEOUT = 6 * 60 * 1000;
  const MAX_LOGS = 40;

  let busy = false;
  let busySince = 0;
  let busyTaskId = null;
  let tickRunning = false;
  let editId = null;
  let panelEl = null;
  let lastTitleScan = 0;
  const warnCache = new Map();

  /* ---------------- 存储 ---------------- */

  const DEFAULTS = () => ({
    settings: { autoNav: true, paused: false },
    tasks: [],
    logs: [],
  });

  function readState() {
    let st = null;
    try {
      if (typeof GM_getValue === 'function') st = GM_getValue(STATE_KEY, null);
    } catch (_) {}
    if (!st) {
      try { st = JSON.parse(localStorage.getItem(STATE_KEY) || 'null'); } catch (_) {}
    }
    if (!st || typeof st !== 'object') st = DEFAULTS();
    const base = DEFAULTS();
    st.settings = Object.assign(base.settings, st.settings || {});
    st.tasks = Array.isArray(st.tasks) ? st.tasks : [];
    st.logs = Array.isArray(st.logs) ? st.logs : [];
    return st;
  }

  function writeState(st) {
    let ok = false;
    try {
      if (typeof GM_setValue === 'function') { GM_setValue(STATE_KEY, st); ok = true; }
    } catch (_) {}
    if (!ok) {
      try { localStorage.setItem(STATE_KEY, JSON.stringify(st)); } catch (_) {}
    }
  }

  function patchTask(id, patch) {
    const st = readState();
    const t = st.tasks.find(x => x.id === id);
    if (!t) return;
    Object.assign(t, patch);
    writeState(st);
  }

  function saveSettings(patch) {
    const st = readState();
    Object.assign(st.settings, patch);
    writeState(st);
  }

  function addLog(msg, type) {
    const st = readState();
    st.logs.unshift({ ts: Date.now(), msg: String(msg), type: type || 'info' });
    st.logs = st.logs.slice(0, MAX_LOGS);
    writeState(st);
    renderLog();
  }

  /* ---------------- 工具 ---------------- */

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const now = () => Date.now();

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function fmt(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function threadOfPath(p) {
    const m = String(p || '').match(/^\/thread\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : '';
  }

  function normThread(v) {
    const s = String(v || '').trim();
    if (!s) return '';
    let m = s.match(/thread\/([A-Za-z0-9_-]+)/);
    if (m) return '/thread/' + m[1];
    if (/^[A-Za-z0-9_-]{4,}$/.test(s)) return '/thread/' + s;
    return '';
  }

  function cleanTitle(s) {
    let t = String(s || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    t = t.replace(/\s*[|·\-–—]\s*(muse(\.ai)?|muse\s*ai|koda)\s*$/i, '').trim();
    if (/^(muse|muse\.ai|koda|new thread|untitled|新对话|新会话|新聊天|新话题)$/i.test(t)) return '';
    if (t.length > 120) t = t.slice(0, 120) + '…';
    return t;
  }

  function looksLikeId(t, id) {
    if (!t) return true;
    if (id && t.indexOf(id) >= 0) return true;
    if (/^https?:\/\//i.test(t) || /\/thread\//i.test(t)) return true;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return true;
    return false;
  }

  function textOf(el, id) {
    const raw = String(el.innerText || el.textContent || '').trim();
    if (!raw || raw.length > 200) return '';
    const first = raw.split('\n')[0];
    if (looksLikeId(first, id)) return '';
    return cleanTitle(first);
  }

  function sidebarActiveTitle(id) {
    let scopes = [];
    try {
      scopes = [...document.querySelectorAll('aside, nav, [role="navigation"], [class*="sidebar" i]')];
    } catch (_) {}
    const uiWords = /^(chats?|all chats|我全部的会话|new chat|新对话|设置|settings|搜索|search)$/i;
    for (const scope of scopes) {
      if (!isVisible(scope)) continue;
      let act = null;
      try {
        act = scope.querySelector(
          '[aria-current="page"], [data-active="true"], [aria-selected="true"], .active, .selected'
        );
      } catch (_) {}
      if (!act || !isVisible(act)) continue;
      const t = textOf(act, id);
      if (t && !uiWords.test(t)) return t;
    }
    return '';
  }

  function navChatTitle(id) {
    let items = [];
    try {
      items = [...document.querySelectorAll('[data-testid="hatch-nav-chat"]')];
    } catch (_) {}
    if (!items.length) return '';

    const titleOf = el => {
      const raw = String(el.innerText || el.textContent || '').trim();
      if (!raw) return '';
      return cleanTitle(raw.split('\n')[0]);
    };

    const idAttrs = ['href', 'data-href', 'data-thread-id', 'data-threadid', 'data-chat-id', 'data-id', 'data-key'];
    for (const it of items) {
      let matched = false;
      for (const a of idAttrs) {
        const v = it.getAttribute(a);
        if (v && v.indexOf(id) >= 0) { matched = true; break; }
      }
      if (!matched && it.querySelector) {
        try { matched = !!it.querySelector(`a[href*="${id}"]`); } catch (_) {}
      }
      if (!matched) continue;
      const t = titleOf(it);
      if (t && !looksLikeId(t, id)) return t;
    }

    const act = items.find(it => {
      if (it.getAttribute('aria-current') === 'page') return true;
      if (it.getAttribute('data-active') === 'true') return true;
      const cls = String(it.className || '');
      return /(^|[\s_-])(active|selected|current)([\s_-]|$)/i.test(cls);
    });
    if (act) {
      const t = titleOf(act);
      if (t && !looksLikeId(t, id)) return t;
    }
    return '';
  }

  function getThreadTitle() {
    const id = threadOfPath(location.pathname);
    if (!id) return '';

    const navTitle = navChatTitle(id);
    if (navTitle) return navTitle;

    const refs = [];
    const actionLike = /^(复制|分享|打开|继续|删除|重命名|置顶|取消置顶|open|copy|share|continue|delete|rename|pin)$/i;
    try {
      const nodes = document.querySelectorAll(
        `a[href*="${id}"], [data-thread-id*="${id}"], [data-threadid*="${id}"], [data-id*="${id}"]`
      );
      for (const el of nodes) {
        let t = textOf(el, id);
        if (!t && typeof el.closest === 'function') {
          const wrap = el.closest('li, [role="listitem"], [role="option"], [data-testid*="thread"]');
          if (wrap) t = textOf(wrap, id);
        }
        if (!t || actionLike.test(t)) continue;
        refs.push({ t, visible: isVisible(el) });
      }
    } catch (_) {}

    const visibleRef = refs.find(r => r.visible);
    if (visibleRef) return visibleRef.t;
    if (refs.length) return refs[0].t;

    const inSidebar = sidebarActiveTitle(id);
    if (inSidebar) return inSidebar;

    try {
      const heads = document.querySelectorAll(
        '.hatch-route-header-title, main h1, main h2, [role="main"] h1, [role="main"] h2, header h1, header h2'
      );
      for (const h of heads) {
        if (!isVisible(h)) continue;
        const t = textOf(h, id);
        if (t) return t;
      }
    } catch (_) {}

    const docTitle = cleanTitle(document.title);
    return looksLikeId(docTitle, id) ? '' : docTitle;
  }

  function titleDiagnostics() {
    const id = threadOfPath(location.pathname);
    const lines = [
      'URL: ' + location.href,
      'threadId: ' + (id || '(none)'),
      'document.title: ' + JSON.stringify(document.title),
      'chosen: ' + JSON.stringify(getThreadTitle()),
      'busy: ' + busy + ' (since ' + (busySince ? Math.round((Date.now() - busySince) / 1000) + 's' : '-') + ')',
      'paused: ' + readState().settings.paused,
      '--- elements referencing thread id ---',
    ];
    try {
      const nodes = document.querySelectorAll(
        `a[href*="${id}"], [data-thread-id*="${id}"], [data-threadid*="${id}"], [data-id*="${id}"]`
      );
      let n = 0;
      for (const el of nodes) {
        if (n++ >= 20) break;
        lines.push(
          `<${el.tagName.toLowerCase()}> href=${JSON.stringify(el.getAttribute('href') || '')} ` +
          `data-id=${JSON.stringify(el.getAttribute('data-id') || '')} ` +
          `visible=${isVisible(el)} text=${JSON.stringify(String(el.innerText || '').slice(0, 100))}`
        );
      }
      if (!n) lines.push('(none)');
    } catch (_) {}
    lines.push('--- sidebar active ---');
    try {
      const act = document.querySelector(
        'aside [aria-current="page"], nav [aria-current="page"], aside [data-active="true"], nav [data-active="true"]'
      );
      lines.push(act ? `<${act.tagName.toLowerCase()}> ${JSON.stringify(String(act.innerText || '').slice(0, 120))}` : '(none)');
    } catch (_) {}
    lines.push('--- hatch-nav-chat items ---');
    try {
      const items = [...document.querySelectorAll('[data-testid="hatch-nav-chat"]')].slice(0, 10);
      if (!items.length) lines.push('(none)');
      for (const it of items) {
        const attrs = {};
        for (const a of ['href', 'data-href', 'data-thread-id', 'data-threadid', 'data-chat-id', 'data-id', 'aria-current']) {
          const v = it.getAttribute(a);
          if (v) attrs[a] = v;
        }
        lines.push(
          `<${it.tagName.toLowerCase()}> cls=${JSON.stringify(String(it.className || '').slice(0, 60))} ` +
          `attrs=${JSON.stringify(attrs)} text=${JSON.stringify(String(it.innerText || '').slice(0, 90))}`
        );
      }
    } catch (_) {}
    return lines.join('\n');
  }

  function nextDaily(hhmm, from) {    const parts = String(hhmm || '09:00').split(':').map(Number);
    const d = new Date(from);
    d.setHours(parts[0] || 0, parts[1] || 0, 0, 0);
    if (d.getTime() <= from) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  function computeNext(task, from) {
    const s = task.schedule || {};
    if (s.type === 'interval') return from + Math.max(1, Number(s.minutes) || 30) * 60000;
    if (s.type === 'daily') return nextDaily(s.time, from);
    if (s.type === 'once') return Number(s.at) || 0;
    return from + 3600000;
  }

  function describe(task) {
    const s = task.schedule || {};
    if (s.type === 'interval') return `每 ${Math.max(1, Number(s.minutes) || 30)} 分钟`;
    if (s.type === 'daily') return `每天 ${s.time || '09:00'}`;
    return `一次 ${fmt(Number(s.at) || 0)}`;
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  function waitFor(fn, timeout, interval) {
    return new Promise(resolve => {
      const t0 = now();
      const step = interval || 250;
      (function loop() {
        let v = null;
        try { v = fn(); } catch (_) {}
        if (v) return resolve(v);
        if (now() - t0 >= timeout) return resolve(null);
        setTimeout(loop, step);
      })();
    });
  }

  /* ---------------- 页面操作 ---------------- */

  function findComposer() {
    const all = [...document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]')]
      .filter(isVisible);
    if (!all.length) return null;
    const boxed = all.filter(el => {
      try { return !!el.closest('[data-testid*="composer" i]'); } catch (_) { return false; }
    });
    const inForm = all.filter(el => {
      try {
        const f = el.closest('form');
        return !!(f && f.querySelector('[data-testid*="composer" i]'));
      } catch (_) { return false; }
    });
    const pool = inForm.length ? inForm : (boxed.length ? boxed : all);
    const score = el => {
      const r = el.getBoundingClientRect();
      let s = Math.max(1, r.width) * Math.max(1, r.height);
      if (el.isContentEditable) s *= 2.5;
      if (r.bottom > window.innerHeight * 0.55) s *= 3;
      return s;
    };
    pool.sort((a, b) => score(b) - score(a));
    return pool[0];
  }

  function composerText(el) {
    if (!el) return '';
    return (el.isContentEditable ? el.innerText : el.value) || '';
  }

  function composerHasDraft() {
    const el = findComposer();
    return !!(el && composerText(el).trim());
  }

  function panelHasDraft() {
    if (!panelEl) return false;
    const t = panelEl.querySelector('#m2a-thread');
    const x = panelEl.querySelector('#m2a-text');
    return !!((t && t.value.trim()) || (x && x.value.trim()));
  }

  function isGenerating() {
    const btns = [...document.querySelectorAll('button,[role="button"]')].filter(isVisible);
    return btns.some(b => /stop|停止/i.test(
      (b.getAttribute('aria-label') || '') + (b.getAttribute('data-testid') || '') + (b.innerText || '')
    ));
  }

  function scrollChatToBottom() {
    try {
      const els = [...document.querySelectorAll('*')].filter(e => {
        const s = getComputedStyle(e);
        return (s.overflowY === 'auto' || s.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 100;
      });
      els.sort((a, b) => b.scrollHeight - a.scrollHeight);
      if (els[0]) els[0].scrollTop = els[0].scrollHeight;
      const sc = document.scrollingElement || document.body;
      if (sc) sc.scrollTop = sc.scrollHeight;
    } catch (_) {}
  }

  function userBubbles() {
    try {
      return [...document.querySelectorAll('div[class*="hatch-chat-groupable-bubble"]')]
        .filter(el => !/hatch-agent-bubble-bg/.test(String(el.className || '')));
    } catch (_) { return []; }
  }

  function userBubbleCount() {
    return userBubbles().length;
  }

  function lastUserBubbleText() {
    const bubbles = userBubbles();
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const t = String(bubbles[i].innerText || '').trim();
      if (t) return t;
    }
    return '';
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function fillComposer(el, text) {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    el.focus();
    if (!el.isContentEditable) {
      setNativeValue(el, text);
      return;
    }
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch (_) {}
    if (!ok) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    }
  }

  function sendLabel(btn) {
    return (btn.getAttribute('aria-label') || '') + ' ' +
      (btn.getAttribute('data-testid') || '') + ' ' +
      (btn.getAttribute('title') || '') + ' ' +
      (btn.innerText || '');
  }

  function hasReadySend(composer) {
    const cRect = composer.getBoundingClientRect();
    const dist = el => {
      const r = el.getBoundingClientRect();
      return Math.abs((r.left + r.width / 2) - (cRect.right - 16)) +
        Math.abs((r.top + r.height / 2) - (cRect.top + cRect.height / 2));
    };
    const btns = [...document.querySelectorAll('button,[role="button"]')]
      .filter(isVisible)
      .sort((a, b) => dist(a) - dist(b));
    const exact = btns.find(b => /^(send|send message|发送|发送消息)$/i.test(
      (b.getAttribute('aria-label') || b.getAttribute('title') || '').trim()
    ));
    const loose = btns.filter(b => dist(b) < 300).find(b => /send|发送/i.test(sendLabel(b)));
    const t = exact || loose;
    return !!t && !t.disabled && t.getAttribute('aria-disabled') !== 'true';
  }

  async function clickSend(composer, beforeBtns) {
    const cRect = composer.getBoundingClientRect();
    const dist = el => {
      const r = el.getBoundingClientRect();
      return Math.abs((r.left + r.width / 2) - (cRect.right - 16)) +
        Math.abs((r.top + r.height / 2) - (cRect.top + cRect.height / 2));
    };
    const bad = b => /attach|upload|file|image|photo|mic|voice|stop|model|tool|设置|附件|图片|语音|停止/i.test(sendLabel(b));
    const deadline = now() + 3000;
    let disabledLabel = '';
    while (now() < deadline) {
      if (beforeBtns) {
        const fresh = [...document.querySelectorAll('button,[role="button"]')]
          .filter(b => !beforeBtns.has(b) && isVisible(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true' && !bad(b));
        const sendFresh = fresh.find(b => /send|发送/i.test(sendLabel(b)));
        const t = sendFresh || (fresh.length === 1 ? fresh[0] : null);
        if (t) {
          t.click();
          return { how: 'button', label: '新出现按钮:' + (sendLabel(t).trim().slice(0, 30) || t.tagName.toLowerCase()) };
        }
      }
      const btns = [...document.querySelectorAll('button,[role="button"]')]
        .filter(isVisible)
        .sort((a, b) => dist(a) - dist(b));
      const exact = btns.find(b => /^(send|send message|发送|发送消息)$/i.test(
        (b.getAttribute('aria-label') || b.getAttribute('title') || '').trim()
      ));
      const near = btns.filter(b => dist(b) < 300);
      const loose = near.find(b => /send|发送/i.test(sendLabel(b)));
      const target = exact || loose;
      if (target) {
        const off = !!target.disabled || target.getAttribute('aria-disabled') === 'true';
        if (off) {
          disabledLabel = sendLabel(target).trim().slice(0, 40);
        } else {
          target.click();
          return { how: 'button', label: sendLabel(target).trim().slice(0, 40) || target.tagName.toLowerCase() };
        }
      }
      await sleep(120);
    }
    const scope = (() => {
      try {
        return composer.closest('[data-testid*="composer" i]') || composer.closest('form') || composer.parentElement;
      } catch (_) { return composer.parentElement; }
    })();
    if (scope && scope.querySelectorAll) {
      const inner = [...scope.querySelectorAll('button,[role="button"]')]
        .filter(b => isVisible(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true')
        .filter(b => !/attach|upload|file|image|photo|mic|voice|stop|model|tool|设置|附件|图片|语音|停止/i.test(sendLabel(b)));
      const last = inner[inner.length - 1];
      if (last) {
        last.click();
        return { how: 'button', label: '输入框旁按钮:' + (sendLabel(last).trim().slice(0, 30) || last.tagName.toLowerCase()) };
      }
    }

    const cy = cRect.top + cRect.height / 2;
    const nearRow = [...document.querySelectorAll('button,[role="button"]')].filter(b => {
      if (!isVisible(b) || b.disabled || b.getAttribute('aria-disabled') === 'true' || bad(b)) return false;
      const r = b.getBoundingClientRect();
      return Math.abs((r.top + r.height / 2) - cy) < 90 && r.left > cRect.left - 40;
    });
    nearRow.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
    if (nearRow[0]) {
      const t = nearRow[0];
      t.click();
      return { how: 'button', label: '输入框右侧按钮:' + (sendLabel(t).trim().slice(0, 30) || t.tagName.toLowerCase()) };
    }

    composer.focus();
    const pressEnter = mod => {
      for (const type of ['keydown', 'keypress', 'keyup']) {
        composer.dispatchEvent(new KeyboardEvent(type, Object.assign({
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
        }, mod)));
      }
    };
    pressEnter({ ctrlKey: true });
    await sleep(600);
    if (!composerText(composer).trim()) return { how: 'enter', label: 'Ctrl+Enter' };
    pressEnter({});
    let label = '';
    if (disabledLabel) {
      label = '按钮被禁用：' + disabledLabel;
    } else {
      try {
        const all = [...document.querySelectorAll('button,[role="button"]')].filter(isVisible);
        const sendish = all.filter(b => /send|发送/i.test(sendLabel(b))).length;
        label = `未识别到发送按钮（可见按钮 ${all.length} 个，含 send 字样 ${sendish} 个，输入框 ${composer.tagName.toLowerCase()}）`;
      } catch (_) {}
    }
    return { how: 'enter', label };
  }

  async function performSend(task) {
    if (threadOfPath(location.pathname) !== threadOfPath(task.thread)) {
      throw new Error('当前页面不是目标会话');
    }
    const composer = await waitFor(findComposer, 30000);
    if (!composer) throw new Error('未找到聊天输入框（可能未登录或页面未加载完）');

    const existing = composerText(composer).trim();
    if (existing && existing !== task.text.trim()) {
      throw new Error('输入框已有未发送内容，已跳过以免覆盖草稿');
    }

    const idle = await waitFor(() => !isGenerating(), 180000);
    if (!idle) throw new Error('会话一直在生成中，本次跳过（5 分钟后重试）');

    const beforeBtns = new Set([...document.querySelectorAll('button,[role="button"]')]);
    try {
      for (const type of ['mousedown', 'mouseup', 'click']) {
        composer.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
      }
    } catch (_) {}
    fillComposer(composer, task.text);
    await sleep(150);
    if (composerText(composer).trim() !== task.text.trim()) {
      fillComposer(composer, task.text);
      await sleep(150);
    }
    if (composerText(composer).trim() !== task.text.trim()) {
      throw new Error('无法写入输入框（页面可能未就绪或输入框被禁用）');
    }
    if (!hasReadySend(composer) && !composer.isContentEditable) {
      try {
        composer.focus();
        composer.setSelectionRange(0, composer.value.length);
        document.execCommand('insertText', false, task.text);
      } catch (_) {}
      await sleep(250);
      if (!composerText(composer).trim()) fillComposer(composer, task.text);
    }
    const how = await clickSend(composer, beforeBtns);
    addLog(`已触发发送（${how.how === 'button' ? '按钮：' + how.label : '回车兜底' + (how.label ? '（' + how.label + '）' : '')}），等待页面确认…`, 'info');
    await sleep(300);
    scrollChatToBottom();

    const needle = task.text.trim().slice(0, 40);
    const baseCount = userBubbleCount();
    const baseLast = lastUserBubbleText();
    const stillMine = () => composerText(composer).trim() === task.text.trim();
    const newBubble = () => {
      if (userBubbleCount() > baseCount) return true;
      const last = lastUserBubbleText();
      return !!needle && last !== baseLast && last.includes(needle);
    };
    const ok = () => newBubble() || isGenerating() || !composerText(composer).trim();

    let confirmed = await waitFor(ok, 6000, 300);
    if (!confirmed && stillMine()) {
      addLog('第一次点击未生效，再试一次…', 'warn');
      await clickSend(composer);
      await sleep(300);
      scrollChatToBottom();
      confirmed = await waitFor(ok, 14000, 300);
    }
    if (!confirmed) {
      throw new Error(
        `未能确认发送成功（${how.how === 'button' ? '点了按钮' : '没找到可用发送按钮，只试了回车'}；输入框内容仍在，且未检测到新消息）`
      );
    }
    if (stillMine() && (newBubble() || isGenerating())) fillComposer(composer, '');
  }

  /* ---------------- 跨标签页协调 ---------------- */

  function readTabs() {
    try { return JSON.parse(localStorage.getItem(TABS_KEY) || '{}') || {}; } catch (_) { return {}; }
  }

  function heartbeat() {
    const tabs = readTabs();
    const t = now();
    for (const k of Object.keys(tabs)) {
      if (!tabs[k] || t - tabs[k].ts > 20000) delete tabs[k];
    }
    tabs[TAB_ID] = { p: location.pathname, ts: t };
    try { localStorage.setItem(TABS_KEY, JSON.stringify(tabs)); } catch (_) {}
  }

  function otherTabMatches(thread) {
    const tabs = readTabs();
    const t = now();
    return Object.keys(tabs).some(k =>
      k !== TAB_ID && tabs[k] && t - tabs[k].ts < 20000 &&
      threadOfPath(tabs[k].p) === threadOfPath(thread)
    );
  }

  function claim(taskId) {
    const key = LOCK_PREFIX + taskId;
    const t = now();
    let prev = null;
    try { prev = JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) {}
    if (prev && t - prev.ts < LOCK_TTL && prev.tab !== TAB_ID) return false;
    try { localStorage.setItem(key, JSON.stringify({ ts: t, tab: TAB_ID })); } catch (_) { return false; }
    return true;
  }

  async function confirmClaim(taskId) {
    await sleep(180);
    try {
      const cur = JSON.parse(localStorage.getItem(LOCK_PREFIX + taskId) || 'null');
      return !!(cur && cur.tab === TAB_ID);
    } catch (_) { return false; }
  }

  function release(taskId) {
    try {
      const key = LOCK_PREFIX + taskId;
      const cur = JSON.parse(localStorage.getItem(key) || 'null');
      if (!cur || cur.tab === TAB_ID) localStorage.removeItem(key);
    } catch (_) {}
  }

  function resetRuntime() {
    try {
      for (const k of Object.keys(localStorage)) {
        if (k.indexOf(LOCK_PREFIX) === 0) localStorage.removeItem(k);
      }
      localStorage.removeItem(NAV_KEY);
    } catch (_) {}
    busy = false;
    busySince = 0;
    busyTaskId = null;
    tickRunning = false;
    addLog('已复位发送状态并清除发送锁', 'warn');
    renderHint();
    tick();
  }

  /* ---------------- 调度 ---------------- */

  function warnOnce(task, msg, windowMs) {
    const last = warnCache.get(task.id) || 0;
    if (now() - last < (windowMs || 10 * 60 * 1000)) return;
    warnCache.set(task.id, now());
    addLog(msg, 'warn');
  }

  function refreshTitles() {
    const cur = threadOfPath(location.pathname);
    if (!cur) return;
    if (now() - lastTitleScan < 15000) return;
    lastTitleScan = now();
    const title = getThreadTitle();
    if (!title) return;
    const st = readState();
    let changed = false;
    for (const t of st.tasks) {
      if (threadOfPath(t.thread) !== cur) continue;
      if (t.titleManual) continue;
      if (t.title !== title) { t.title = title; changed = true; }
    }
    if (changed) {
      writeState(st);
      renderTasks();
      renderHint();
    }
  }

  function maybeNavigate(task) {
    const st = readState();
    if (!st.settings.autoNav) {
      warnOnce(task, `到点但当前页面不是 ${task.thread}，未开启自动跳转，暂不发送`);
      return;
    }
    if (otherTabMatches(task.thread)) {
      warnOnce(task, `另一个标签页已在目标会话，跳过跳转`);
      return;
    }
    const t = now();
    const lastNav = Number(localStorage.getItem(NAV_KEY) || 0);
    if (t - lastNav < 90000) {
      warnOnce(task, '刚刚跳转过一次，90 秒内不重复跳转');
      return;
    }
    if (composerHasDraft() || panelHasDraft()) {
      warnOnce(task, '当前页面或面板里有未完成的内容，暂不跳转');
      return;
    }
    try {
      localStorage.setItem(NAV_KEY, String(t));
      sessionStorage.setItem(PENDING_NAV_KEY, JSON.stringify({ id: task.id, thread: task.thread, ts: t }));
    } catch (_) {}
    addLog(`跳转到 ${task.thread} 以发送定时消息`, 'info');
    location.href = location.origin + task.thread;
  }

  function resolvePendingNav() {
    let p = null;
    try { p = JSON.parse(sessionStorage.getItem(PENDING_NAV_KEY) || 'null'); } catch (_) {}
    if (!p) return;
    if (now() - p.ts > 10 * 60 * 1000) {
      try { sessionStorage.removeItem(PENDING_NAV_KEY); } catch (_) {}
      return;
    }
    if (threadOfPath(location.pathname) === threadOfPath(p.thread)) {
      try { sessionStorage.removeItem(PENDING_NAV_KEY); } catch (_) {}
      return;
    }
    if (now() - p.ts < 25000) return;
    try { sessionStorage.removeItem(PENDING_NAV_KEY); } catch (_) {}
    patchTask(p.id, { nextRun: now() + 30 * 60 * 1000 });
    addLog(`跳转后仍未进入 ${p.thread}，可能链接无效或无权限；该任务 30 分钟后再试`, 'err');
    renderTasks();
  }

  async function runTask(task) {
    if (busy) return;
    busy = true;
    busySince = now();
    busyTaskId = task.id;
    let keepAlive = null;
    let ok = false;
    let err = '';
    try {
      if (!claim(task.id)) {
        warnOnce(task, '跳过：该任务正被另一个标签页发送，或发送锁尚未过期', 60000);
        return;
      }
      if (!(await confirmClaim(task.id))) {
        warnOnce(task, '跳过：发送锁被其他标签页抢占', 60000);
        return;
      }
      keepAlive = setInterval(() => {
        try {
          const key = LOCK_PREFIX + task.id;
          const cur = JSON.parse(localStorage.getItem(key) || 'null');
          if (cur && cur.tab === TAB_ID) {
            localStorage.setItem(key, JSON.stringify({ ts: now(), tab: TAB_ID }));
          }
        } catch (_) {}
      }, 30000);
      addLog(`开始发送 → ${task.thread}：${task.text.slice(0, 40)}${task.text.length > 40 ? '…' : ''}`, 'info');

      await Promise.race([
        performSend(task),
        sleep(SEND_TIMEOUT).then(() => { throw new Error('发送整体超时（6 分钟）'); }),
      ]);
      ok = true;
    } catch (e) {
      err = (e && e.message) || String(e);
    } finally {
      if (keepAlive) clearInterval(keepAlive);
      release(task.id);
      busy = false;
      busySince = 0;
      busyTaskId = null;
    }

    const t = now();
    const retry = ok ? 0 : (task.retry || 0) + 1;
    let next;
    let enabled = task.enabled;
    if (ok) {
      next = task.schedule.type === 'once' ? 0 : computeNext(task, t);
      if (task.schedule.type === 'once') enabled = false;
    } else if (retry >= 3) {
      next = task.schedule.type === 'once' ? 0 : computeNext(task, t);
      if (task.schedule.type === 'once') enabled = false;
      addLog(`连续失败 3 次，改为按计划等待下一次`, 'err');
    } else {
      next = t + RETRY_MS;
    }

    patchTask(task.id, {
      lastRun: t,
      lastResult: ok ? 'ok' : 'fail',
      lastError: err,
      retry,
      nextRun: next,
      enabled,
    });

    addLog(ok ? `✓ 已发送到 ${task.thread}` : `✗ 发送失败：${err}`, ok ? 'ok' : 'err');
    renderTasks();
  }

  async function tick() {
    if (tickRunning) return;
    tickRunning = true;
    try { await tickBody(); } finally { tickRunning = false; }
  }

  async function tickBody() {
    if (busy) {
      if (now() - busySince > SEND_TIMEOUT + 60000) {
        addLog('发送流程长时间未结束，已自动复位', 'warn');
        if (busyTaskId) release(busyTaskId);
        busy = false;
        busySince = 0;
        busyTaskId = null;
      } else {
        warnOnce({ id: '__busy' }, '上一次发送尚未结束，本次检查跳过');
        return;
      }
    }
    heartbeat();
    refreshTitles();
    const st = readState();
    if (st.settings.paused) {
      if (st.tasks.some(t => t.enabled && t.nextRun && now() >= t.nextRun)) {
        warnOnce({ id: '__paused' }, '有任务已到点，但「暂停所有任务」勾选着，未发送');
      }
      renderHint();
      return;
    }

    const current = threadOfPath(location.pathname);
    for (const task of st.tasks) {
      if (!task.enabled) continue;
      if (!task.nextRun) {
        patchTask(task.id, { nextRun: computeNext(task, now()) });
        continue;
      }
    }

    for (const task of st.tasks) {
      if (!task.enabled || !task.nextRun || now() < task.nextRun) continue;
      if (threadOfPath(task.thread) !== current) continue;
      await runTask(task);
      renderHint();
      return;
    }

    for (const task of st.tasks) {
      if (!task.enabled || !task.nextRun || now() < task.nextRun) continue;
      maybeNavigate(task);
      renderHint();
      return;
    }

    renderHint();
  }

  /* ---------------- 面板 ---------------- */

  const CSS = `
    #m2a-sched-ball{position:fixed;bottom:24px;left:24px;z-index:999995;width:44px;height:44px;border-radius:50%;
      background:linear-gradient(135deg,#7c3aed,#2563eb);color:#fff;display:flex;align-items:center;justify-content:center;
      cursor:grab;touch-action:none;box-shadow:0 8px 24px rgba(37,99,235,.45);font-size:20px;user-select:none;
      transition:transform .2s,box-shadow .2s}
    #m2a-sched-ball:hover{transform:scale(1.08)}
    #m2a-sched-ball.dragging{cursor:grabbing;transition:none;transform:none;box-shadow:0 12px 32px rgba(37,99,235,.6)}
    #m2a-sched-panel{position:fixed;top:20px;right:20px;z-index:999996;width:400px;max-width:calc(100vw - 40px);
      max-height:calc(100vh - 40px);overflow:auto;background:linear-gradient(180deg,rgba(15,23,42,.97),rgba(8,13,26,.98));
      color:#f8fafc;border-radius:16px;padding:16px 18px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
      font-size:13px;line-height:1.45;box-shadow:0 20px 50px rgba(0,0,0,.6),0 0 0 1px rgba(96,165,250,.25);backdrop-filter:blur(16px)}
    #m2a-sched-panel .m2a-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;
      padding-bottom:10px;border-bottom:1px solid #1e293b}
    #m2a-sched-panel .m2a-title{font-size:15px;font-weight:700;color:#f1f5f9;letter-spacing:.3px;display:flex;align-items:center;gap:8px}
    #m2a-sched-panel .m2a-dot{width:9px;height:9px;border-radius:50%;background:#38bdf8;box-shadow:0 0 10px #38bdf8}
    #m2a-sched-panel .m2a-ver{font-size:11px;background:#1e293b;color:#94a3b8;padding:1px 6px;border-radius:6px}
    #m2a-sched-panel .m2a-x{background:transparent;border:none;color:#64748b;font-size:18px;cursor:pointer;padding:0 4px;line-height:1}
    #m2a-sched-panel label{display:block;font-size:11px;color:#94a3b8;margin:0 0 5px;font-weight:500}
    #m2a-sched-panel input[type=text],#m2a-sched-panel input[type=number],#m2a-sched-panel input[type=time],
    #m2a-sched-panel input[type=datetime-local],#m2a-sched-panel textarea,#m2a-sched-panel select{
      width:100%;box-sizing:border-box;padding:8px 10px;background:#0b1120;border:1px solid #334155;border-radius:8px;
      color:#f1f5f9;font-size:12px;outline:none;font-family:inherit}
    #m2a-sched-panel textarea{resize:vertical;min-height:70px;line-height:1.5}
    #m2a-sched-panel .m2a-row{display:flex;gap:8px;align-items:center;margin-bottom:10px}
    #m2a-sched-panel .m2a-row>*{margin-bottom:0}
    #m2a-sched-panel .m2a-grow{flex:1;min-width:0}
    #m2a-sched-panel button.m2a-btn{border:none;border-radius:9px;padding:9px 12px;font-size:12px;font-weight:600;cursor:pointer;
      background:linear-gradient(135deg,#0284c7,#2563eb);color:#fff;transition:opacity .2s}
    #m2a-sched-panel button.m2a-btn:hover{opacity:.9}
    #m2a-sched-panel button.m2a-ghost{background:#0f172a;border:1px solid #334155;color:#cbd5e1;border-radius:9px;
      padding:8px 10px;font-size:12px;cursor:pointer;white-space:nowrap}
    #m2a-sched-panel .m2a-section{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.6px;margin:14px 0 8px;
      padding-top:12px;border-top:1px solid #1e293b}
    #m2a-sched-panel .m2a-task{background:#0f172a;border:1px solid #1e293b;border-radius:10px;padding:9px 10px;margin-bottom:8px}
    #m2a-sched-panel .m2a-task.off{opacity:.55}
    #m2a-sched-panel .m2a-task-top{display:flex;align-items:center;gap:6px;margin-bottom:4px}
    #m2a-sched-panel .m2a-name{flex:1;min-width:0;font-size:12px;font-weight:600;color:#f1f5f9;
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
    #m2a-sched-panel .m2a-name:hover{color:#7dd3fc}
    #m2a-sched-panel .m2a-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:#7dd3fc;
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:1px 0 3px}
    #m2a-sched-panel .m2a-meta{font-size:11px;color:#94a3b8;display:flex;gap:8px;flex-wrap:wrap}
    #m2a-sched-panel .m2a-text{font-size:12px;color:#e2e8f0;margin:2px 0 6px;word-break:break-word;
      display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    #m2a-sched-panel .m2a-acts{display:flex;gap:6px;margin-top:6px}
    #m2a-sched-panel .m2a-acts button{background:#111c33;border:1px solid #334155;color:#cbd5e1;border-radius:7px;
      padding:4px 8px;font-size:11px;cursor:pointer}
    #m2a-sched-panel .m2a-acts button.danger{color:#fca5a5;border-color:#7f1d1d}
    #m2a-sched-panel .m2a-hint{font-size:11px;color:#94a3b8;background:#0b1120;border:1px solid #1e293b;border-radius:9px;
      padding:8px 10px;margin-bottom:10px}
    #m2a-sched-panel .m2a-hint b{color:#fbbf24;font-weight:600}
    #m2a-sched-panel .m2a-log{margin-top:8px;max-height:150px;overflow:auto;font-size:11px;font-family:ui-monospace,Menlo,monospace}
    #m2a-sched-panel .m2a-log div{padding:2px 0;color:#94a3b8;border-bottom:1px dashed #16233b;word-break:break-all}
    #m2a-sched-panel .m2a-log .ok{color:#4ade80}
    #m2a-sched-panel .m2a-log .err{color:#f87171}
    #m2a-sched-panel .m2a-log .warn{color:#fbbf24}
    #m2a-sched-panel .m2a-empty{color:#64748b;font-size:12px;padding:8px 0}
    #m2a-sched-panel .m2a-check{display:flex;align-items:center;gap:7px;font-size:12px;color:#cbd5e1;margin-top:8px}
    #m2a-sched-panel .m2a-check input{margin:0}
  `;

  function injectCss() {
    if (document.getElementById('m2a-sched-css')) return;
    const style = document.createElement('style');
    style.id = 'm2a-sched-css';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function applyBallPos(ball, left, top) {
    ball.style.left = Math.round(left) + 'px';
    ball.style.top = Math.round(top) + 'px';
    ball.style.right = 'auto';
    ball.style.bottom = 'auto';
  }

  function clampBall(left, top) {
    const w = 44;
    const maxLeft = Math.max(6, window.innerWidth - w - 6);
    const maxTop = Math.max(6, window.innerHeight - w - 6);
    return {
      left: Math.min(Math.max(6, Math.round(left)), maxLeft),
      top: Math.min(Math.max(6, Math.round(top)), maxTop),
    };
  }

  function mountBall() {
    if (document.getElementById('m2a-sched-ball')) return;
    const ball = document.createElement('div');
    ball.id = 'm2a-sched-ball';
    ball.title = 'Muse 定时发信（可拖动位置；单击打开面板）';
    ball.textContent = '⏰';
    document.body.appendChild(ball);

    const pos = readState().settings.ballPos;
    if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
      const p = clampBall(pos.left, pos.top);
      applyBallPos(ball, p.left, p.top);
    }

    let drag = null;
    ball.addEventListener('pointerdown', ev => {
      if (ev.button !== 0) return;
      const r = ball.getBoundingClientRect();
      drag = {
        id: ev.pointerId,
        ox: ev.clientX - r.left,
        oy: ev.clientY - r.top,
        sx: ev.clientX,
        sy: ev.clientY,
        left: r.left,
        top: r.top,
        moved: false,
      };
      try { ball.setPointerCapture(ev.pointerId); } catch (_) {}
      ball.classList.add('dragging');
      ev.preventDefault();
    });
    ball.addEventListener('pointermove', ev => {
      if (!drag || ev.pointerId !== drag.id) return;
      if (!drag.moved && Math.abs(ev.clientX - drag.sx) + Math.abs(ev.clientY - drag.sy) < 5) return;
      drag.moved = true;
      const p = clampBall(ev.clientX - drag.ox, ev.clientY - drag.oy);
      drag.left = p.left;
      drag.top = p.top;
      applyBallPos(ball, p.left, p.top);
    });
    const finish = ev => {
      if (!drag || (ev && ev.pointerId !== drag.id)) return;
      const d = drag;
      drag = null;
      ball.classList.remove('dragging');
      try { ball.releasePointerCapture(d.id); } catch (_) {}
      if (d.moved) {
        const p = clampBall(d.left, d.top);
        applyBallPos(ball, p.left, p.top);
        saveSettings({ ballPos: p });
      } else {
        togglePanel();
      }
    };
    ball.addEventListener('pointerup', finish);
    ball.addEventListener('pointercancel', finish);

    window.addEventListener('resize', () => {
      if (!readState().settings.ballPos) return;
      const r = ball.getBoundingClientRect();
      const p = clampBall(r.left, r.top);
      applyBallPos(ball, p.left, p.top);
      saveSettings({ ballPos: p });
    });
  }

  function togglePanel() {
    if (panelEl) { panelEl.remove(); panelEl = null; return; }
    showPanel();
  }

  function showPanel() {
    if (panelEl) panelEl.remove();
    injectCss();

    const st = readState();
    const panel = document.createElement('div');
    panel.id = 'm2a-sched-panel';
    panel.innerHTML = `
      <div class="m2a-head">
        <div class="m2a-title"><span class="m2a-dot"></span>定时发信
          <span class="m2a-ver">v${VERSION}</span></div>
        <button class="m2a-x" id="m2a-close" title="关闭">✕</button>
      </div>

      <div class="m2a-hint">
        到点后由<b>本浏览器</b>在目标会话里直接填入并发送。请保持 muse.ai 标签页打开（可固定）；
        标签页被切到后台时，定时精度可能被浏览器限制到约 1 分钟。
        会话<b>标题</b>会在你打开该会话时自动抓取并显示；点标题可手动改名。
      </div>
      <div style="margin:-2px 0 10px">
        <span id="m2a-diag" role="button"
              style="color:#7dd3fc;font-size:11px;cursor:pointer;user-select:none">标题不对？点此复制诊断信息</span>
      </div>

      <label>目标会话（粘贴 /thread/xxx 链接，或只填会话 ID）</label>
      <div class="m2a-row">
        <input type="text" id="m2a-thread" class="m2a-grow" placeholder="https://muse.ai/thread/xxxxxxxx">
        <button class="m2a-ghost" id="m2a-use-current">用当前</button>
      </div>

      <label>消息内容</label>
      <textarea id="m2a-text" placeholder="定时发送的文本…"></textarea>

      <label style="margin-top:10px">发送计划</label>
      <div class="m2a-row">
        <select id="m2a-type" style="width:110px">
          <option value="interval">每隔</option>
          <option value="daily">每天</option>
          <option value="once">一次性</option>
        </select>
        <span id="m2a-field-interval" class="m2a-row m2a-grow" style="margin:0">
          <input type="number" id="m2a-minutes" min="1" step="1" value="30" style="width:80px">
          <span style="color:#94a3b8;font-size:12px">分钟</span>
        </span>
        <input type="time" id="m2a-time" value="09:00" style="width:120px;display:none">
        <input type="datetime-local" id="m2a-at" style="display:none">
      </div>

      <div class="m2a-row">
        <button class="m2a-btn m2a-grow" id="m2a-save">添加定时任务</button>
        <button class="m2a-ghost" id="m2a-cancel" style="display:none">取消编辑</button>
      </div>

      <label class="m2a-check"><input type="checkbox" id="m2a-autonav"> 到点自动跳转到目标会话（否则需手动保持该会话打开）</label>
      <label class="m2a-check"><input type="checkbox" id="m2a-paused"> 暂停所有任务</label>

      <div class="m2a-section">任务列表 <span id="m2a-count"></span></div>
      <div id="m2a-tasks"></div>

      <div class="m2a-section" style="display:flex;justify-content:space-between;align-items:center">
        <span>运行日志</span>
        <span>
          <button class="m2a-ghost" id="m2a-reset" style="padding:3px 8px;font-size:11px" title="清除发送锁、复位卡住的发送">复位</button>
          <button class="m2a-ghost" id="m2a-clear-log" style="padding:3px 8px;font-size:11px">清空</button>
        </span>
      </div>
      <div class="m2a-log" id="m2a-log"></div>
      <div id="m2a-hint" style="font-size:11px;color:#64748b;margin-top:10px"></div>
    `;
    document.body.appendChild(panel);
    panelEl = panel;

    panel.querySelector('#m2a-close').onclick = togglePanel;

    panel.querySelector('#m2a-diag').onclick = ev => {
      ev.preventDefault();
      const text = titleDiagnostics();
      console.log('[muse-sched] 标题诊断\n' + text);
      copyText(text).then(ok => {
        toast(ok ? '诊断信息已复制，可直接发给作者' : '复制失败，请从控制台复制', ok ? 'ok' : 'warn');
      });
    };

    const threadIn = panel.querySelector('#m2a-thread');
    const textIn = panel.querySelector('#m2a-text');
    const typeIn = panel.querySelector('#m2a-type');
    const minIn = panel.querySelector('#m2a-minutes');
    const timeIn = panel.querySelector('#m2a-time');
    const atIn = panel.querySelector('#m2a-at');
    const saveBtn = panel.querySelector('#m2a-save');
    const cancelBtn = panel.querySelector('#m2a-cancel');
    const autoIn = panel.querySelector('#m2a-autonav');
    const pausedIn = panel.querySelector('#m2a-paused');

    autoIn.checked = !!st.settings.autoNav;
    pausedIn.checked = !!st.settings.paused;
    autoIn.onchange = () => saveSettings({ autoNav: autoIn.checked });
    pausedIn.onchange = () => { saveSettings({ paused: pausedIn.checked }); renderHint(); };

    function syncFields() {
      const type = typeIn.value;
      panel.querySelector('#m2a-field-interval').style.display = type === 'interval' ? 'flex' : 'none';
      timeIn.style.display = type === 'daily' ? 'block' : 'none';
      atIn.style.display = type === 'once' ? 'block' : 'none';
    }
    typeIn.onchange = syncFields;
    syncFields();

    panel.querySelector('#m2a-use-current').onclick = () => {
      const id = threadOfPath(location.pathname);
      if (!id) return toast('当前页面不是会话页面', 'err');
      threadIn.value = location.origin + '/thread/' + id;
    };

    function resetForm() {
      editId = null;
      threadIn.value = '';
      textIn.value = '';
      typeIn.value = 'interval';
      minIn.value = '30';
      syncFields();
      saveBtn.textContent = '添加定时任务';
      cancelBtn.style.display = 'none';
      panel.querySelectorAll('.m2a-task').forEach(el => el.classList.remove('editing'));
    }

    cancelBtn.onclick = resetForm;

    saveBtn.onclick = () => {
      const thread = normThread(threadIn.value);
      const text = textIn.value.trim();
      if (!thread) return toast('请填写有效的会话链接或 ID', 'err');
      if (!text) return toast('请填写消息内容', 'err');

      const type = typeIn.value;
      const schedule = { type };
      if (type === 'interval') {
        const m = Math.max(1, parseInt(minIn.value, 10) || 30);
        schedule.minutes = m;
      } else if (type === 'daily') {
        schedule.time = timeIn.value || '09:00';
      } else {
        if (!atIn.value) return toast('请选择发送时间', 'err');
        schedule.at = new Date(atIn.value).getTime();
        if (!schedule.at) return toast('发送时间格式不正确', 'err');
        if (schedule.at < now() - 60000) return toast('发送时间已经过去了', 'err');
      }

      const st2 = readState();
      const onCurrent = threadOfPath(location.pathname) === threadOfPath(thread);
      const title = onCurrent ? getThreadTitle() : '';
      if (editId) {
        const t = st2.tasks.find(x => x.id === editId);
        if (!t) { resetForm(); return; }
        const sameThread = threadOfPath(t.thread) === threadOfPath(thread);
        const keepManual = sameThread && !!t.titleManual;
        Object.assign(t, {
          thread, text, schedule,
          title: keepManual ? t.title : (title || (sameThread ? t.title : '')),
          titleManual: keepManual,
          nextRun: computeNext({ schedule }, now()), retry: 0,
        });
        writeState(st2);
        addLog(`已更新任务 ${thread}`, 'info');
      } else {
        st2.tasks.push({
          id: 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          thread,
          title,
          text,
          schedule,
          enabled: true,
          retry: 0,
          nextRun: computeNext({ schedule }, now()),
          createdAt: now(),
        });
        writeState(st2);
        addLog(`已添加任务 → ${thread}（${describe({ schedule })}）`, 'info');
      }
      resetForm();
      renderTasks();
      renderHint();
      toast('✓ 已保存', 'ok');
    };

    panel.querySelector('#m2a-clear-log').onclick = () => {
      const s = readState();
      s.logs = [];
      writeState(s);
      renderLog();
    };

    panel.querySelector('#m2a-reset').onclick = resetRuntime;

    panel.querySelector('#m2a-tasks').addEventListener('click', ev => {
      const btn = ev.target.closest('[data-act]');
      if (!btn) return;
      const id = btn.getAttribute('data-id');
      const act = btn.getAttribute('data-act');
      const st3 = readState();
      const task = st3.tasks.find(x => x.id === id);
      if (!task) return;

      if (act === 'rename') {
        const v = prompt('修改会话标题（留空则恢复自动抓取）', task.title || '');
        if (v === null) return;
        const trimmed = v.trim();
        patchTask(id, { title: trimmed, titleManual: !!trimmed });
        renderTasks();
        if (trimmed) toast('标题已修改', 'ok');
        else { lastTitleScan = 0; tick(); }
      } else if (act === 'toggle') {
        const enabled = !task.enabled;
        patchTask(id, {
          enabled,
          retry: 0,
          nextRun: enabled ? computeNext(task, now()) : task.nextRun,
        });
        renderTasks(); renderHint();
      } else if (act === 'run') {
        if (busy) { toast('上一次发送还没结束，请稍候再试', 'warn'); return; }
        const s4 = readState();
        if (s4.settings.paused) toast('当前已暂停所有任务，请先取消「暂停」', 'warn');
        patchTask(id, { enabled: true, nextRun: now(), retry: 0 });
        addLog(`已加入立即发送队列：${task.thread}`, 'info');
        renderTasks();
        tick();
      } else if (act === 'edit') {
        editId = id;
        threadIn.value = location.origin + task.thread;
        textIn.value = task.text;
        typeIn.value = task.schedule.type || 'interval';
        if (task.schedule.minutes) minIn.value = task.schedule.minutes;
        if (task.schedule.time) timeIn.value = task.schedule.time;
        if (task.schedule.at) {
          const d = new Date(task.schedule.at);
          atIn.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        }
        syncFields();
        saveBtn.textContent = '保存修改';
        cancelBtn.style.display = 'block';
        panel.scrollTop = 0;
      } else if (act === 'del') {
        if (!confirm('删除这个定时任务？')) return;
        const s = readState();
        s.tasks = s.tasks.filter(x => x.id !== id);
        writeState(s);
        if (editId === id) resetForm();
        addLog('已删除任务', 'info');
        renderTasks(); renderHint();
      }
    });

    renderTasks();
    renderLog();
    renderHint();
  }

  function toast(msg, type) {
    const el = document.createElement('div');
    el.textContent = msg;
    const bg = type === 'ok' ? '#059669' : type === 'err' ? '#dc2626' : '#2563eb';
    el.style.cssText = `position:fixed;bottom:84px;left:50%;transform:translateX(-50%);z-index:9999999;padding:10px 18px;
      background:${bg};color:#fff;border-radius:10px;font-size:13px;font-weight:500;font-family:-apple-system,BlinkMacSystemFont,sans-serif;
      box-shadow:0 12px 30px rgba(0,0,0,.5);max-width:420px;text-align:center;line-height:1.5;pointer-events:none;`;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 2600);
  }

  async function copyText(text) {
    try {
      if (typeof GM_setClipboard === 'function') { GM_setClipboard(text); return true; }
    } catch (_) {}
    try {
      if (navigator.clipboard) { await navigator.clipboard.writeText(text); return true; }
    } catch (_) {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (_) { return false; }
  }

  function renderTasks() {
    if (!panelEl) return;
    const box = panelEl.querySelector('#m2a-tasks');
    const count = panelEl.querySelector('#m2a-count');
    if (!box) return;
    const st = readState();
    count.textContent = st.tasks.length ? `(${st.tasks.length})` : '';

    if (!st.tasks.length) {
      box.innerHTML = '<div class="m2a-empty">还没有任务。填写会话链接和消息后点「添加定时任务」。</div>';
      return;
    }

    box.innerHTML = st.tasks.map(t => {
      const on = !!t.enabled;
      const stateTxt = t.lastResult === 'ok' ? '上次成功' : t.lastResult === 'fail' ? '上次失败' : '未运行';
      const resultColor = t.lastResult === 'ok' ? '#4ade80' : t.lastResult === 'fail' ? '#f87171' : '#94a3b8';
      return `<div class="m2a-task${on ? '' : ' off'}">
        <div class="m2a-task-top">
          <input type="checkbox" ${on ? 'checked' : ''} data-act="toggle" data-id="${esc(t.id)}" title="启用/暂停">
          <span class="m2a-name" data-act="rename" data-id="${esc(t.id)}"
                title="点击修改标题">${esc(t.title || '（未获取标题）')}</span>
        </div>
        <div class="m2a-id" title="${esc('https://muse.ai' + t.thread)}">${esc(t.thread.replace('/thread/', ''))}</div>
        <div class="m2a-text">${esc(t.text)}</div>
        <div class="m2a-meta">
          <span>${esc(describe(t))}</span>
          <span>下次 ${esc(on ? fmt(t.nextRun) : '—')}</span>
          <span style="color:${resultColor}">${stateTxt}</span>
          ${t.retry ? `<span style="color:#fbbf24">重试 ${t.retry}/3</span>` : ''}
          ${t.lastError ? `<span style="color:#f87171" title="${esc(t.lastError)}">${esc(String(t.lastError).slice(0, 22))}</span>` : ''}
        </div>
        <div class="m2a-acts">
          <button data-act="run" data-id="${esc(t.id)}">立即发送</button>
          <button data-act="edit" data-id="${esc(t.id)}">编辑</button>
          <button class="danger" data-act="del" data-id="${esc(t.id)}">删除</button>
        </div>
      </div>`;
    }).join('');
  }

  function renderLog() {
    if (!panelEl) return;
    const box = panelEl.querySelector('#m2a-log');
    if (!box) return;
    const logs = readState().logs;
    if (!logs.length) {
      box.innerHTML = '<div class="m2a-empty">暂无日志</div>';
      return;
    }
    box.innerHTML = logs.map(l => {
      const d = new Date(l.ts);
      return `<div class="${esc(l.type)}">${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${esc(l.msg)}</div>`;
    }).join('');
  }

  function renderHint() {
    if (!panelEl) return;
    const el = panelEl.querySelector('#m2a-hint');
    if (!el) return;
    const st = readState();
    const id = threadOfPath(location.pathname);
    const parts = [];
    parts.push(id ? `当前会话：${id}` : '当前页面不是会话页');
    if (st.settings.paused) parts.push('<span style="color:#fbbf24">已暂停</span>');
    else parts.push('调度运行中');
    el.innerHTML = parts.join(' · ');
  }

  function sendDiagnostics() {
    const lines = [];
    const vis = el => isVisible(el);
    lines.push('URL: ' + location.href);
    const all = [...document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]')].filter(vis);
    lines.push('编辑区(可见): ' + all.length);
    all.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      let box = '';
      try { const c = el.closest('[data-testid]'); box = c ? c.getAttribute('data-testid') : ''; } catch (_) {}
      const val = el.isContentEditable ? el.innerText : el.value;
      lines.push(`  [${i}] <${el.tagName.toLowerCase()}> ce=${el.isContentEditable} ph=${JSON.stringify(el.getAttribute('placeholder') || '')} val=${JSON.stringify(String(val || '').slice(0, 40))} rect=${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}x${Math.round(r.height)} box=${box}`);
    });
    const cur = findComposer();
    if (cur) {
      const r = cur.getBoundingClientRect();
      lines.push(`选中: <${cur.tagName.toLowerCase()}> ce=${cur.isContentEditable} rect=${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}x${Math.round(r.height)}`);
    } else {
      lines.push('选中: 无');
    }
    const cRect = cur ? cur.getBoundingClientRect() : null;
    const btns = [...document.querySelectorAll('button,[role="button"]')].filter(vis);
    lines.push('按钮(可见): ' + btns.length);
    btns.slice(0, 40).forEach((b, i) => {
      const r = b.getBoundingClientRect();
      const near = cRect ? Math.abs((r.top + r.height / 2) - (cRect.top + cRect.height / 2)) < 90 : false;
      lines.push(`  [${i}] tid=${b.getAttribute('data-testid') || ''} aria=${JSON.stringify(b.getAttribute('aria-label') || '')} title=${JSON.stringify(b.getAttribute('title') || '')} text=${JSON.stringify((b.innerText || '').trim().slice(0, 20))} dis=${b.disabled} near=${near} rect=${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}x${Math.round(r.height)}`);
    });
    return lines.join('\n');
  }

  /* ---------------- 启动 ---------------- */

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('⏰ 打开发信面板', togglePanel);
    GM_registerMenuCommand('▶ 立即检查一次任务', () => tick());
    GM_registerMenuCommand('🧹 复位发送状态（清除卡住的锁）', resetRuntime);
    GM_registerMenuCommand('🧪 复制发送诊断信息', () => {
      const text = sendDiagnostics();
      console.log('[muse-sched] 发送诊断\n' + text);
      copyText(text).then(ok => toast(ok ? '发送诊断信息已复制' : '复制失败，见控制台', ok ? 'ok' : 'warn'));
    });
    GM_registerMenuCommand('🔍 复制标题诊断信息', () => {
      const text = titleDiagnostics();
      console.log('[muse-sched] 标题诊断\n' + text);
      copyText(text).then(ok => toast(ok ? '诊断信息已复制' : '复制失败，见控制台', ok ? 'ok' : 'warn'));
    });
  }

  function boot() {
    injectCss();
    mountBall();
    resolvePendingNav();
    setTimeout(tick, 1500);
    setTimeout(resolvePendingNav, 25000);
    setInterval(() => { tick(); }, TICK_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
    window.addEventListener('focus', () => tick());
    window.addEventListener('storage', ev => {
      if (ev.key === STATE_KEY) { renderTasks(); }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
