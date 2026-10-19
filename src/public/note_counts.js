(() => {
  const root = window;
  const storagePrefix = 'im-planner:notes-read:';

  const keyFor = (experimentId, entityType = '', entityId = '') => {
    const userId = document.body?.dataset.notesUserId || 'anonymous';
    return `${storagePrefix}${userId}:${experimentId}:${entityType || 'all'}:${entityId || ''}`;
  };

  const readStored = (key) => {
    try { return window.localStorage.getItem(key) || ''; } catch (_) { return ''; }
  };

  const storeRead = (experimentId, entityType, entityId, latest) => {
    if (!experimentId) return;
    const value = latest || new Date().toISOString();
    try { window.localStorage.setItem(keyFor(experimentId, entityType, entityId), value); } catch (_) { /* storage can be unavailable */ }
  };

  const markBadge = (badge, count, latest) => {
    const value = Number(count || 0);
    badge.textContent = value > 99 ? '99+' : value > 0 ? String(value) : '';
    badge.classList.toggle('is-empty', value <= 0);
    badge.dataset.notesLatest = latest || '';
    const experimentId = badge.dataset.notesExperimentId || '';
    const entityType = badge.dataset.notesEntityType || '';
    const entityId = badge.dataset.notesEntityId || '';
    const readAt = readStored(keyFor(experimentId, entityType, entityId));
    const isNew = value > 0 && (!readAt || !latest || new Date(latest).getTime() > new Date(readAt).getTime());
    badge.classList.toggle('is-new', isNew);
    badge.classList.toggle('is-read', value > 0 && !isNew);
    badge.setAttribute('aria-label', `${value} journal entr${value === 1 ? 'y' : 'ies'}`);
  };

  const fetchSummary = async (group) => {
    const first = group[0];
    const experimentId = first.dataset.notesExperimentId;
    if (!experimentId) return;
    const params = new URLSearchParams();
    const entityType = first.dataset.notesEntityType || '';
    const entityId = first.dataset.notesEntityId || '';
    if (entityType) params.set('entity_type', entityType);
    if (entityId) params.set('entity_id', entityId);
    try {
      const response = await fetch(`/experiments/${encodeURIComponent(experimentId)}/notes/count.json?${params}`);
      if (!response.ok) return;
      const data = await response.json();
      group.forEach((badge) => markBadge(badge, data.count, data.latest_activity_at));
      document.querySelectorAll('[data-notes-journal-link]').forEach((link) => {
        if (link.dataset.notesExperimentId !== experimentId) return;
        if ((link.dataset.notesEntityType || '') !== entityType || (link.dataset.notesEntityId || '') !== entityId) return;
        link.dataset.notesLatest = data.latest_activity_at || '';
      });
    } catch (_) { /* count is an enhancement; keep the link usable */ }
  };

  const refresh = () => {
    const groups = new Map();
    document.querySelectorAll('[data-note-count]').forEach((badge) => {
      const key = [badge.dataset.notesExperimentId || '', badge.dataset.notesEntityType || '', badge.dataset.notesEntityId || ''].join(':');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(badge);
    });
    groups.forEach((group) => fetchSummary(group));
  };

  const markReadFor = async (element) => {
    const source = element?.querySelector?.('[data-note-count]') || element;
    if (!source) return;
    const experimentId = source.dataset.notesExperimentId;
    if (!experimentId) return;
    const entityType = source.dataset.notesEntityType || '';
    const entityId = source.dataset.notesEntityId || '';
    const params = new URLSearchParams();
    if (entityType) params.set('entity_type', entityType);
    if (entityId) params.set('entity_id', entityId);
    try {
      const response = await fetch(`/experiments/${encodeURIComponent(experimentId)}/notes/count.json?${params}`);
      const data = response.ok ? await response.json() : null;
      storeRead(experimentId, entityType, entityId, data?.latest_activity_at || source.dataset.notesLatest || '');
      refresh();
    } catch (_) {
      storeRead(experimentId, entityType, entityId, source.dataset.notesLatest || '');
      refresh();
    }
  };

  root.NoteCounts = { keyFor, markRead: storeRead, markReadFor, refresh };

  document.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest('[data-notes-journal-link]') : null;
    if (!link) return;
    storeRead(
      link.dataset.notesExperimentId,
      link.dataset.notesEntityType || '',
      link.dataset.notesEntityId || '',
      link.dataset.notesLatest || ''
    );
    refresh();
  });

  document.addEventListener('DOMContentLoaded', refresh);
})();
