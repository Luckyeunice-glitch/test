/* Hồ sơ học tập cá nhân. Nạp sau quiz-account-sync.js. */
(() => {
  'use strict';
  if (window.quizProfile) return;
  const store = () => window.quizStudyStorage;
  const SESSION = 'quiz_profile_session_';
  const SUBJECT = 'quiz_profile_subject_';
  const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };
  const hash = (text) => {
    let a = 0xdeadbeef, b = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
      a = Math.imul(a ^ text.charCodeAt(i), 2654435761);
      b = Math.imul(b ^ text.charCodeAt(i), 1597334677);
    }
    a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
    b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
    return (4294967296 * (2097151 & b) + (a >>> 0)).toString(16).padStart(14, '0');
  };
  const newId = () => window.crypto?.randomUUID?.() || Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);
  const safeId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,60}$/.test(id);
  function emit() { window.dispatchEvent(new CustomEvent('quiz-profile-changed')); }
  function set(key, value) { store().setItem(key, JSON.stringify(value)); emit(); }
  function canonical(q) { return JSON.stringify([q.text || '', [...(q.options || [])].sort(), q.options?.[q.answer] ?? '']); }

  function prepare(subjectId, subject) {
    if (!safeId(subjectId) || !Array.isArray(subject?.chapters)) return null;
    const bank = [];
    for (const chapter of subject.chapters) {
      (chapter.questions || []).forEach((q, i) => {
        q._studyId = hash(subjectId + ':' + chapter.id + ':' + i + ':' + canonical(q));
        bank.push(q._studyId);
      });
    }
    const key = SUBJECT + hash(subjectId);
    const previous = parse(store().getItem(key));
    const meta = {
      subjectId, name: String(subject.name || subjectId), icon: String(subject.icon || '📚'),
      color: /^#[0-9a-f]{6}$/i.test(subject.color || '') ? subject.color : '#7564e8',
      total: bank.length, bankHash: hash(bank.join(','))
    };
    const same = previous && Object.keys(meta).every((k) => previous[k] === meta[k]);
    meta.updatedAt = same ? previous.updatedAt : Math.max(Date.now(), (previous?.updatedAt || 0) + 1);
    if (!same) set(key, meta);
    return meta;
  }

  function ensureSession(cfg) {
    if (!cfg.studySessionId) {
      cfg.studySessionId = newId();
      cfg.studyStartedAt = Date.now();
      try { sessionStorage.setItem('quiz_config', JSON.stringify(cfg)); } catch {}
    }
    return cfg.studySessionId;
  }

  function capture(cfg, questions, states, options = {}) {
    if (!cfg || !Array.isArray(questions) || !questions.length || !safeId(cfg.subjectId)) return;
    const id = ensureSession(cfg);
    const old = parse(store().getItem(SESSION + id));
    const meta = cfg.studyMeta || {
      subjectId: cfg.subjectId, name: cfg.subject?.name || cfg.subjectId,
      icon: cfg.subject?.icon || '📚', color: cfg.subject?.color || '#7564e8',
      bankHash: 'legacy', total: 0, updatedAt: 0
    };
    const first = { ...(old?.first || {}) };
    const now = Date.now();
    const judged = cfg.mode !== 'end' || options.submitted;
    if (judged) questions.forEach((q, index) => {
      const state = states[index];
      if (!state || state.selected === null || state.selected === undefined) return;
      const key = q._studyId || hash(canonical(q));
      if (!first[key]) first[key] = { correct: state.selected === q.answer, at: now };
    });
    const completed = !!old?.completed || !!options.completed;
    if (!Object.keys(first).length && !completed) return;
    const value = {
      id, meta, mode: cfg.studyMode === 'pk' ? 'pk' : cfg._retryWrong ? 'review' : 'practice',
      startedAt: old?.startedAt || cfg.studyStartedAt || now,
      updatedAt: 0, completed, finishedAt: old?.finishedAt || (completed ? now : 0),
      total: questions.length, first,
      correct: completed ? (old?.completed ? old.correct : questions.reduce((n, q, i) => n + (states[i]?.selected === q.answer ? 1 : 0), 0)) : 0
    };
    if (old && JSON.stringify({ ...old, updatedAt: 0 }) === JSON.stringify(value)) return;
    value.updatedAt = now;
    set(SESSION + id, value);
  }

  // Phép hợp nhất giữ câu đã ghi nhận và lần nộp đầu tiên của một phiên.
  function mergeSession(a, b) {
    if (!a) return b;
    if (!b || a.id !== b.id) return a;
    const latest = a.updatedAt > b.updatedAt ? a : b;
    const first = {};
    for (const id of [...new Set([...Object.keys(a.first || {}), ...Object.keys(b.first || {})])].sort()) {
      const x = a.first?.[id], y = b.first?.[id];
      first[id] = !x ? y : !y ? x : x.at < y.at ? x : y.at < x.at ? y : { at: x.at, correct: x.correct && y.correct };
    }
    const submissions = [a, b].filter((s) => s.completed).sort((x, y) => x.finishedAt - y.finishedAt || x.correct - y.correct);
    return {
      ...latest, startedAt: Math.min(a.startedAt, b.startedAt),
      updatedAt: Math.max(a.updatedAt, b.updatedAt), first,
      completed: submissions.length > 0,
      finishedAt: submissions[0]?.finishedAt || 0,
      correct: submissions[0]?.correct || 0
    };
  }
  function mergeRecords(key, incoming, old) {
    if (!key.startsWith(SESSION) || !old || old.deleted || incoming.deleted) return null;
    const a = parse(old.value), b = parse(incoming.value);
    if (!a?.id || !b?.id || a.id !== b.id) return null;
    const value = JSON.stringify(mergeSession(a, b));
    if (value === old.value) return old;
    return { ...incoming, value, changedAt: Math.max(incoming.changedAt, old.changedAt) + 1 };
  }

  function summarize(items) {
    const groups = new Map(), sessions = [];
    function group(meta) {
      if (!safeId(meta?.subjectId)) return null;
      meta = { ...meta, name: String(meta.name || meta.subjectId), icon: String(meta.icon || '📚') };
      let item = groups.get(meta.subjectId);
      if (!item) {
        item = { meta, sessions: [], first: {}, latest: {}, answered: 0, completed: 0 };
        groups.set(meta.subjectId, item);
      } else if ((meta.updatedAt || 0) > (item.meta.updatedAt || 0)) item.meta = meta;
      return item;
    }
    for (const [key, text] of Object.entries(items)) {
      const value = parse(text);
      if (key.startsWith(SUBJECT)) group(value);
      if (key.startsWith(SESSION) && value?.id && value.first && typeof value.first === 'object' && !Array.isArray(value.first) && Object.values(value.first).every((a) => a && typeof a.correct === 'boolean' && Number.isFinite(a.at)) && Number.isFinite(value.updatedAt) && Number.isFinite(value.total) && ['practice','review','pk'].includes(value.mode)) {
        const item = group(value.meta);
        if (item) { value.meta = { ...value.meta, name: String(value.meta.name || value.meta.subjectId) }; item.sessions.push(value); sessions.push(value); }
      }
    }
    for (const item of groups.values()) {
      for (const session of item.sessions) {
        const entries = Object.entries(session.first);
        item.answered += entries.length;
        if (session.completed) item.completed++;
        if (session.meta.bankHash !== item.meta.bankHash) continue;
        for (const [id, answer] of entries) {
          if (session.mode === 'practice' && (!item.first[id] || answer.at < item.first[id].at || (answer.at === item.first[id].at && !answer.correct))) item.first[id] = answer;
          if (session.mode !== 'pk' && (!item.latest[id] || answer.at > item.latest[id].at || (answer.at === item.latest[id].at && answer.correct))) item.latest[id] = answer;
        }
      }
      item.unique = Object.keys(item.first).length;
      item.firstCorrect = Object.values(item.first).filter((a) => a.correct).length;
      item.accuracy = item.unique ? Math.round(item.firstCorrect / item.unique * 100) : null;
      item.wrongIds = Object.keys(item.latest).filter((id) => !item.latest[id].correct);
      item.last = item.sessions.sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
      item.coverage = item.meta.total ? Math.min(100, Math.round(item.unique / item.meta.total * 100)) : null;
    }
    const subjects = [...groups.values()].filter((item) => item.sessions.length).sort((a, b) => (b.last?.updatedAt || 0) - (a.last?.updatedAt || 0));
    const unique = subjects.reduce((n, s) => n + s.unique, 0);
    const correct = subjects.reduce((n, s) => n + s.firstCorrect, 0);
    return {
      subjects, sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt),
      completed: sessions.filter((s) => s.completed).length,
      answered: subjects.reduce((n, s) => n + s.answered, 0),
      unique, accuracy: unique ? Math.round(correct / unique * 100) : null
    };
  }
  function snapshot() { return summarize(store().list('quiz_profile_')); }
  function subjectUrl(id) { return 'quiz.html?subject=' + encodeURIComponent(id); }

  async function review(item) {
    if (!item.wrongIds.length) return;
    const D = await import('./pk-data.js');
    const dataset = await D.loadDataset('data/' + item.meta.subjectId + '.dat', true);
    const meta = prepare(item.meta.subjectId, dataset.subject);
    if (meta.bankHash !== item.meta.bankHash) throw Error('Bộ đề đã cập nhật. Bạn mở môn học và ôn lại phiên bản mới nhé.');
    const ids = new Set(item.wrongIds);
    const questions = dataset.subject.chapters.flatMap((c) => c.questions || []).filter((q) => ids.has(q._studyId)).map((q) => JSON.parse(JSON.stringify(q)));
    if (!questions.length) throw Error('Không tìm thấy câu sai trong bộ đề hiện tại.');
    D.shuffle(questions);
    const cfg = {
      subjectId: meta.subjectId, subject: { name: meta.name, icon: meta.icon, color: meta.color },
      studyMeta: meta, questions, mode: 'instant', timePerQ: 0,
      retryWrong: true, sound: true, theme: localStorage.getItem('quiz_theme') || 'theme-normal',
      _retryWrong: true, _resume: false, batchInfo: null
    };
    sessionStorage.setItem('quiz_config', JSON.stringify(cfg));
    store().lockOwner();
    location.href = 'quiz-play.html';
  }
  function resume(subjectId) {
    const progress = parse(store().getItem('quiz_progress'));
    if (!progress || progress.subjectId !== subjectId || !progress.questions?.length) {
      location.href = subjectUrl(subjectId); return;
    }
    const cfg = { ...progress, _resume: true, _retryWrong: !!progress._retryWrong };
    sessionStorage.setItem('quiz_config', JSON.stringify(cfg));
    store().lockOwner();
    location.href = 'quiz-play.html';
  }
  function recordPk({ code, createdAt, rid, uid, ds, resolved, picks }) {
    const match = /^data\/([A-Za-z0-9_-]{1,60})\.dat$/.exec(ds.path);
    if (!match) return;
    const meta = prepare(match[1], ds.subject);
    const questions = resolved.map((q) => ({ ...q, _studyId: ds.flat[q.g]?.q?._studyId }));
    const states = questions.map((q, i) => ({ selected: /^[0-8]$/.test(picks[i] || '') ? Number(picks[i]) : null }));
    capture({
      subjectId: match[1], studyMeta: meta, studyMode: 'pk', mode: 'instant',
      studySessionId: 'pk_' + hash(code + ':' + createdAt + ':' + rid + ':' + uid)
    }, questions, states, { completed: true, submitted: true });
  }
  window.quizProfile = { recordPk, prepare, capture, ensureSession, mergeSession, mergeRecords, summarize, snapshot, review, resume, hash };

  async function bindAvatar() {
    if (document.body.dataset.page === 'profile') return;
    const K = await import('./pk-core.js');
    await K.initAccount();
    const draw = () => {
      let link = document.getElementById('account-shortcut');
      if (!link) {
        const top = document.querySelector('.topbar');
        if (!top) return;
        link = document.createElement('a'); link.id = 'account-shortcut';
        link.style.cssText = 'margin-left:auto;display:inline-flex;align-items:center;gap:8px;color:inherit;text-decoration:none;font:inherit;font-size:.75rem';
        top.append(link);
      }
      const account = K.getAccount();
      link.href = 'profile.html'; link.title = 'Mở hồ sơ và tiến độ học';
      link.style.display = 'inline-flex'; link.style.alignItems = 'center'; link.style.gap = '8px';
      link.replaceChildren();
      if (account?.photoURL && /^https:\/\//.test(account.photoURL)) {
        const img = document.createElement('img'); img.src = account.photoURL; img.alt = '';
        img.referrerPolicy = 'no-referrer'; img.width = img.height = 28; img.style.borderRadius = '50%'; img.onerror = () => img.remove(); link.append(img);
      }
      const label = document.createElement('span'); label.textContent = 'Hồ sơ'; link.append(label);
      const avatar = document.getElementById('account-avatar');
      if (avatar) {
        avatar.style.cursor = 'pointer'; avatar.setAttribute('role', 'link'); avatar.tabIndex = 0; avatar.title = 'Mở hồ sơ';
        avatar.onclick = () => { location.href = 'profile.html'; };
        avatar.onkeydown = (e) => { if (e.key === 'Enter') location.href = 'profile.html'; };
      }
    };
    K.watchAccount(draw);
    window.addEventListener('quiz-study-status', draw);
  }
  const boot = () => { bindAvatar().catch(() => {}); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
