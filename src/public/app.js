(() => {
  const root = (window.IMPlanner = window.IMPlanner || {});

  const normalizeText = (value) => String(value ?? "").trim();
  const escapeHtml = (value) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
  root.escapeHtml = escapeHtml;

  const toastTypes = {
    success: { icon: "check_circle", title: "Done", dismissAfter: 4500, iconClasses: "bg-green-100 text-green-500" },
    info: { icon: "info", title: "Information", dismissAfter: 5000, iconClasses: "bg-blue-100 text-blue-500" },
    warning: { icon: "warning", title: "Attention", dismissAfter: 7000, iconClasses: "bg-orange-100 text-orange-500" },
    error: { icon: "error", title: "Action failed", dismissAfter: 0, iconClasses: "bg-red-100 text-red-500" }
  };

  /**
   * Display a deduplicated, accessible application notification. It is
   * intentionally framework-agnostic so legacy pages and new Flowbite pages
   * use the same API during migration.
   */
  root.notify = ({ type = "info", title, message, dismissAfter } = {}) => {
    const config = toastTypes[type] || toastTypes.info;
    const text = normalizeText(message);
    if (!text) return null;
    const viewport = document.getElementById("appToastViewport");
    if (!viewport) return null;
    const fingerprint = `${type}:${normalizeText(title || config.title)}:${text}`;
    const duplicate = Array.from(viewport.children).find((node) => node.dataset.toastFingerprint === fingerprint);
    if (duplicate) return duplicate;

    while (viewport.children.length >= 3) viewport.firstElementChild?.remove();

    const toast = document.createElement("div");
    toast.className = "pointer-events-auto flex w-full items-start rounded-lg bg-white p-4 text-gray-500 shadow-sm ring-1 ring-gray-200";
    toast.dataset.toastFingerprint = fingerprint;
    toast.setAttribute("role", type === "error" ? "alert" : "status");

    const icon = document.createElement("span");
    icon.className = `material-symbols-rounded inline-flex size-8 shrink-0 items-center justify-center rounded-lg ${config.iconClasses}`;
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = config.icon;

    const content = document.createElement("div");
    content.className = "ms-3 min-w-0 text-sm";
    const heading = document.createElement("strong");
    heading.className = "block font-medium text-gray-900";
    heading.textContent = normalizeText(title || config.title);
    const body = document.createElement("span");
    body.className = "mt-1 block text-gray-500";
    body.textContent = text;
    content.append(heading, body);

    const close = document.createElement("button");
    close.className = "-mx-1.5 -my-1.5 ms-auto inline-flex size-8 items-center justify-center rounded-lg bg-white p-1.5 text-sm text-gray-400 hover:bg-gray-100 hover:text-gray-900 focus:ring-2 focus:ring-gray-300";
    close.type = "button";
    close.setAttribute("aria-label", "Dismiss notification");
    close.textContent = "×";
    close.addEventListener("click", () => toast.remove());

    toast.append(icon, content, close);
    viewport.appendChild(toast);

    const timeout = Number.isFinite(Number(dismissAfter)) ? Number(dismissAfter) : config.dismissAfter;
    if (timeout > 0) window.setTimeout(() => toast.remove(), timeout);
    return toast;
  };

  // CSRF Protection
  const getCsrfToken = () => {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : '';
  };

  const csrfToken = getCsrfToken();

  const csrfHeaders = () => {
    const token = getCsrfToken();
    return token ? { 'X-CSRF-Token': token } : {};
  };

  // Keep same-origin state-changing requests protected even when a page uses
  // fetch directly instead of the IMPlanner request helpers. Never attach the
  // token to cross-origin requests.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const requestUrl = input instanceof Request ? input.url : String(input);
    const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const isUnsafeMethod = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    let isSameOrigin = false;
    try {
      isSameOrigin = new URL(requestUrl, window.location.href).origin === window.location.origin;
    } catch {
      return nativeFetch(input, init);
    }
    if (!isUnsafeMethod || !isSameOrigin) return nativeFetch(input, init);

    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers || undefined).forEach((value, name) => headers.set(name, value));
    const token = getCsrfToken();
    if (token && !headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', token);
    return nativeFetch(input, { ...init, headers });
  };

  const ensureFormCsrfToken = (form) => {
    if (!(form instanceof HTMLFormElement)) return;
    if (String(form.method || 'get').toLowerCase() !== 'post') return;
    if (form.querySelector('input[name="_csrf"]')) return;
    const token = getCsrfToken();
    if (!token) return;
    const field = document.createElement('input');
    field.type = 'hidden';
    field.name = '_csrf';
    field.value = token;
    field.dataset.csrfInjected = 'true';
    form.appendChild(field);
  };

  // Forms may be rendered or created after the initial page load. A capture
  // listener ensures the hidden token exists before the browser serializes a
  // same-origin POST form, including forms that use FormData in submit handlers.
  document.addEventListener('submit', (event) => ensureFormCsrfToken(event.target), true);
  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.dataset.confirm) return;
    if (!window.confirm(form.dataset.confirm)) event.preventDefault();
  }, true);
  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (form instanceof HTMLFormElement && form.dataset.clientOnlyForm === 'true') event.preventDefault();
  }, true);
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('form').forEach(ensureFormCsrfToken);
  });

  root.templateMap = {};
  root.setTemplateMap = (map) => {
    root.templateMap = map || {};
    root.initTemplateInputs?.(document);
  };

  const resolveTemplate = (value) => {
    const text = String(value ?? "");
    const missing = [];
    // Replace %machineId:paramId% tokens with machine param values.
    const resolved = text.replace(/%(\d+:\d+)%/g, (match, token) => {
      if (Object.prototype.hasOwnProperty.call(root.templateMap, token)) {
        return String(root.templateMap[token]);
      }
      missing.push(match);
      return match;
    });
    return { resolved, missing };
  };
  root.resolveTemplate = resolveTemplate;

  root.initTemplateInputs = (rootEl = document) => {
    const inputs = rootEl.querySelectorAll("[data-template-input]");
    inputs.forEach((input) => {
      const row = input.closest("[data-custom-field]") || input.parentElement;
      if (!row) return;
      let preview = row.querySelector("[data-template-preview]");
      if (!preview) {
        preview = document.createElement("div");
        preview.className = "template-preview";
        preview.dataset.templatePreview = "1";
        input.insertAdjacentElement("afterend", preview);
      }
      const useFlowbitePreview = preview.dataset.templatePreviewUi === "flowbite";
      const update = () => {
        const raw = input.value || "";
        if (!/%\d+:\d+%/.test(raw)) {
          preview.textContent = "";
          if (useFlowbitePreview) {
            preview.className = "mt-2 hidden rounded-lg border px-3 py-2 text-xs";
          } else {
            preview.classList.remove("is-visible", "is-missing");
          }
          return;
        }
        // Inline preview (green when resolved, red when missing).
        const { resolved, missing } = resolveTemplate(raw);
        if (missing.length) {
          preview.textContent = `Missing: ${missing.join(", ")}`;
          if (useFlowbitePreview) {
            preview.className = "mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700";
          } else {
            preview.classList.add("is-visible", "is-missing");
            preview.classList.remove("is-resolved");
          }
          return;
        }
        preview.textContent = `= ${resolved}`;
        if (useFlowbitePreview) {
          preview.className = "mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700";
        } else {
          preview.classList.add("is-visible", "is-resolved");
          preview.classList.remove("is-missing");
        }
      };
      if (!input.dataset.templateBound) {
        input.addEventListener("input", update);
        input.dataset.templateBound = "1";
      }
      update();
    });
  };

  root.updateTemplateOutputs = (rootEl = document) => {
    const outputs = rootEl.querySelectorAll("[data-template-output]");
    outputs.forEach((el) => {
      const sourceId = el.dataset.templateSource || "";
      const source = sourceId ? document.getElementById(sourceId) : null;
      const rawValue = source ? source.value : el.dataset.templateValue || "";
      const text = String(rawValue ?? "").trim();
      // Summary outputs: keep inputs as token, render resolved value in UI.
      if (!text) {
        el.textContent = el.dataset.templateFallback || "-";
        return;
      }
      if (/%\d+:\d+%/.test(text) && root.resolveTemplate) {
        const result = root.resolveTemplate(text);
        if (result?.missing?.length) {
          el.textContent = text;
          return;
        }
        el.textContent = String(result?.resolved ?? text);
        return;
      }
      el.textContent = text;
    });
  };

  const initTagSelect = (container) => {
    if (!container || container.dataset.tagSelectInit) return;
    container.dataset.tagSelectInit = "1";
    const selectedEl = container.querySelector("[data-tag-selected]");
    const panelEl = container.querySelector("[data-tag-panel]");
    const filterInput = container.querySelector("[data-tag-filter]");
    if (!selectedEl || !panelEl) return;
    const usesUiKit = document.body.hasAttribute("data-ui-kit");

    const appendChevron = () => {
      if (!usesUiKit) return;
      const chevron = document.createElement("span");
      chevron.className = "material-symbols-rounded ms-auto shrink-0 text-body";
      chevron.setAttribute("aria-hidden", "true");
      chevron.textContent = "expand_more";
      selectedEl.appendChild(chevron);
    };

    const applyUiKitClasses = () => {
      if (!usesUiKit) return;
      container.classList.add("inline-block", "min-w-40", "max-w-64", "align-top");
      selectedEl.classList.add("flex", "min-h-10", "w-full", "items-center", "gap-1.5", "rounded-base", "border", "border-default-medium", "bg-neutral-secondary-medium", "px-3", "py-2", "text-left", "text-sm", "text-heading", "shadow-xs", "focus:border-brand", "focus:ring-2", "focus:ring-brand");
      panelEl.classList.add("w-64", "rounded-base", "border", "border-default-medium", "bg-neutral-primary", "p-2", "shadow-lg");
      filterInput?.classList.add("mb-2", "block", "w-full", "rounded-base", "border", "border-default-medium", "bg-neutral-secondary-medium", "px-3", "py-2", "text-sm", "text-heading", "placeholder:text-body", "focus:border-brand", "focus:ring-brand");
      panelEl.querySelectorAll("[data-tag-option]").forEach((option) => option.classList.add("flex", "cursor-pointer", "items-center", "gap-2", "rounded-base", "px-2", "py-2", "text-sm", "text-heading", "hover:bg-neutral-secondary"));
      panelEl.querySelectorAll("[data-tag-option] .tag-chip").forEach((chip) => chip.classList.add("rounded-none", "bg-transparent", "p-0", "text-sm", "text-heading"));
    };

    const getInputRoot = () =>
      panelEl.parentElement === document.body ? panelEl : container;

    const updateSelected = () => {
      const selectedTags = Array.from(
        getInputRoot().querySelectorAll('input[type="checkbox"][data-tag-value]')
      )
        .filter((input) => input.checked)
        .map((input) => input.dataset.tagValue || "");
      selectedEl.innerHTML = "";
      if (selectedTags.length === 0) {
        const placeholder = document.createElement("span");
        placeholder.className = usesUiKit ? "min-w-0 flex-1 truncate text-body" : "tag-placeholder";
        placeholder.textContent = "Select...";
        selectedEl.appendChild(placeholder);
        appendChevron();
        return;
      }
      selectedTags.forEach((tag) => {
        const chip = document.createElement("span");
        chip.className = usesUiKit
          ? "inline-flex max-w-full min-w-0 items-center truncate rounded-full bg-brand-soft px-2 py-0.5 text-xs font-medium text-fg-brand"
          : "tag-chip";
        chip.textContent = tag;
        selectedEl.appendChild(chip);
      });
      appendChevron();
    };

    const applyFilter = () => {
      if (!filterInput) return;
      const term = normalizeText(filterInput.value).toLowerCase();
      const options = Array.from(container.querySelectorAll("[data-tag-option]"));
      options.forEach((option) => {
        const text = normalizeText(option.dataset.tagLabel || option.textContent).toLowerCase();
        option.style.display = !term || text.includes(term) ? "" : "none";
      });
    };

    const ensureContainerId = () => {
      if (!container.id) {
        container.id = `tag-select-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      }
    };

    applyUiKitClasses();
    ensureContainerId();
    if (usesUiKit) {
      selectedEl.setAttribute("role", "button");
      selectedEl.tabIndex = 0;
      selectedEl.setAttribute("aria-haspopup", "listbox");
      selectedEl.setAttribute("aria-expanded", "false");
      panelEl.id = panelEl.id || `${container.id}-menu`;
      selectedEl.setAttribute("aria-controls", panelEl.id);
      panelEl.setAttribute("role", "listbox");
      panelEl.setAttribute("aria-multiselectable", "true");
    }

    const positionPanel = () => {
      const rect = selectedEl.getBoundingClientRect();
      const top = rect.bottom + 6;
      const left = rect.left;
      panelEl.style.top = `${top}px`;
      panelEl.style.left = `${left}px`;
      panelEl.style.minWidth = `${Math.max(rect.width, 220)}px`;
    };

    const attachPanelToBody = () => {
      ensureContainerId();
      if (panelEl.parentElement !== document.body) {
        panelEl.dataset.tagOrigin = container.id;
        document.body.appendChild(panelEl);
      }
      panelEl.classList.add("is-portal");
      positionPanel();
    };

    const detachPanelFromBody = () => {
      if (panelEl.parentElement !== document.body) return;
      const originId = panelEl.dataset.tagOrigin;
      const origin = originId ? document.getElementById(originId) : null;
      if (origin) {
        origin.appendChild(panelEl);
      }
      panelEl.classList.remove("is-portal");
      panelEl.style.top = "";
      panelEl.style.left = "";
      panelEl.style.minWidth = "";
    };

    let repositionHandler = null;

    const closeSelect = () => {
      container.classList.remove("is-open");
      selectedEl.setAttribute("aria-expanded", "false");
      if (repositionHandler) {
        window.removeEventListener("scroll", repositionHandler, true);
        window.removeEventListener("resize", repositionHandler);
        repositionHandler = null;
      }
      panelEl.style.display = "none";
      updateSelected();
      detachPanelFromBody();
    };

    selectedEl.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      document.querySelectorAll("[data-tag-select].is-open").forEach((el) => {
        if (el !== container) {
          el.classList.remove("is-open");
          const panel = el.querySelector("[data-tag-panel]");
          if (panel) {
            panel.style.display = "none";
            panel.classList.remove("is-portal");
            if (panel.parentElement === document.body) {
              const originId = panel.dataset.tagOrigin;
              const origin = originId ? document.getElementById(originId) : null;
              if (origin) origin.appendChild(panel);
            }
          }
        }
      });
      if (!container.classList.contains("is-open")) {
        container.classList.add("is-open");
        selectedEl.setAttribute("aria-expanded", "true");
        attachPanelToBody();
        panelEl.style.display = "block";
        repositionHandler = () => {
          if (container.classList.contains("is-open")) positionPanel();
        };
        window.addEventListener("scroll", repositionHandler, true);
        window.addEventListener("resize", repositionHandler);
        updateSelected();
        if (filterInput) {
          filterInput.focus();
          filterInput.select();
        }
      } else {
        closeSelect();
      }
    });

    selectedEl.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      selectedEl.click();
    });

    panelEl.addEventListener("click", (event) => {
      event.stopPropagation();
    });

    const handleTagChange = (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (!target.dataset.tagValue) return;
      updateSelected();
    };
    container.addEventListener("change", handleTagChange);
    panelEl.addEventListener("change", handleTagChange);

    filterInput?.addEventListener("input", applyFilter);
    container._tagUpdate = updateSelected;
    container._tagClose = closeSelect;
    container._tagPanel = panelEl;
    updateSelected();
  };

  const initTagSelects = (rootEl = document) => {
    rootEl.querySelectorAll("[data-tag-select]").forEach((el) => initTagSelect(el));
  };

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      document.querySelectorAll("[data-tag-select].is-open").forEach((el) => {
        const panel = el._tagPanel || el.querySelector("[data-tag-panel]");
        const inside =
          (target instanceof Node && el.contains(target)) ||
          (target instanceof Node && panel && panel.contains(target));
        if (inside) return;
        if (typeof el._tagClose === "function") {
          el._tagClose();
        } else {
          el.classList.remove("is-open");
        }
      });
    },
    true
  );
  document.addEventListener("DOMContentLoaded", () => {
    initTagSelects();
    root.initTemplateInputs?.(document);
    root.updateTemplateOutputs?.(document);
  });
  root.initTagSelects = initTagSelects;

  const parseResponseByType = async (resp) => {
    const contentType = resp.headers.get("content-type") || "";
    if (contentType.includes("application/json")) return resp.json();
    return resp.text();
  };

  root.postForm = async (url, data) => {
    const params =
      data instanceof URLSearchParams
        ? data
        : data instanceof FormData
          ? new URLSearchParams(Array.from(data.entries()).map(([k, v]) => [k, String(v)]))
          : new URLSearchParams(
              Object.entries(data || {}).map(([k, v]) => [k, String(v ?? "")])
            );
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        ...csrfHeaders()
      },
      body: params
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(text || `Request failed (${resp.status})`);
    }
    return parseResponseByType(resp);
  };

  root.postJson = async (url, data) => {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        ...csrfHeaders()
      },
      body: JSON.stringify(data || {})
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(text || `Request failed (${resp.status})`);
    }
    return parseResponseByType(resp);
  };

  root.setupAutosaveForm = (form, options = {}) => {
    if (!form || form.dataset.autosaveBound === "1") return null;
    form.dataset.autosaveBound = "1";
    const statusEl =
      options.statusEl ||
      (options.statusSelector ? form.querySelector(options.statusSelector) : null) ||
      form.querySelector("[data-autosave-status]");
    const debounceMs = Number(options.debounceMs ?? 250);
    const listenInput = options.listenInput !== false;
    let timer = null;

    const setStatus = (text) => {
      if (statusEl) statusEl.textContent = text;
    };

    const submit = async () => {
      const body = new URLSearchParams(new FormData(form));
      setStatus("Saving...");
      try {
        const resp = await fetch(form.action, {
          method: form.method || "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest"
          },
          body
        });
        if (!resp.ok) throw new Error("Save failed");
        setStatus("Saved");
        if (typeof options.onSuccess === "function") {
          await options.onSuccess(resp, form);
        }
        return true;
      } catch {
        setStatus("Save failed");
        if (typeof options.onError === "function") options.onError(form);
        return false;
      }
    };

    const schedule = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        submit();
      }, debounceMs);
    };

    form.addEventListener("change", (event) => {
      if (event.target && event.target.matches("input, select, textarea")) {
        schedule();
      }
    });
    if (listenInput) {
      form.addEventListener("input", (event) => {
        if (event.target && event.target.matches("input[type='text'], input[type='search'], textarea")) {
          schedule();
        }
      });
    }
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submit();
    });

    return { submit };
  };

  const initMessagesPopover = () => {
    const toggle = document.querySelector("[data-messages-popover-toggle]");
    const popover = document.querySelector("[data-messages-popover]");
    const bodyEl = document.querySelector("[data-messages-popover-body]");
    const readAllBtn = document.querySelector("[data-messages-read-all]");
    if (!toggle || !popover || !bodyEl) return;

    const ensureBadge = () => {
      let badge = toggle.querySelector("[data-messages-unread-badge]");
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "nav-bell-badge";
        badge.dataset.messagesUnreadBadge = "1";
        toggle.appendChild(badge);
      }
      return badge;
    };

    const updateBadge = (count) => {
      const value = Number(count || 0);
      const existing = toggle.querySelector("[data-messages-unread-badge]");
      if (value <= 0) {
        existing?.remove();
        return;
      }
      const badge = existing || ensureBadge();
      badge.textContent = value > 99 ? "99+" : String(value);
    };

    const formatTime = (iso) => {
      if (!iso) return "-";
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return "-";
      return date.toLocaleString();
    };

    const renderLoading = () => {
      bodyEl.innerHTML = "";
      const note = document.createElement("div");
      note.className = "small-note messages-popover-empty";
      note.textContent = "Loading...";
      bodyEl.appendChild(note);
    };

    const renderItems = (items) => {
      bodyEl.innerHTML = "";
      if (!Array.isArray(items) || items.length === 0) {
        const empty = document.createElement("div");
        empty.className = "small-note messages-popover-empty";
        empty.textContent = "No unread messages.";
        bodyEl.appendChild(empty);
        return;
      }
      items.forEach((item) => {
        const card = document.createElement("div");
        card.className = "messages-popover-item";

        const head = document.createElement("div");
        head.className = "messages-popover-item-head";
        const title = document.createElement("div");
        title.className = "messages-popover-item-title";
        title.textContent = String(item?.subject || "Message");
        const time = document.createElement("div");
        time.className = "small-note";
        time.textContent = formatTime(item?.message_created_at || item?.created_at);
        head.appendChild(title);
        head.appendChild(time);

        const body = document.createElement("div");
        body.className = "small-note";
        body.textContent = String(item?.body || "");

        const actions = document.createElement("div");
        actions.className = "messages-popover-item-actions";
        const openLink = document.createElement("a");
        openLink.className = "pure-button button-sm";
        openLink.href = `/messages/${Number(item?.id || 0)}/open`;
        openLink.textContent = "Open";
        const readBtn = document.createElement("button");
        readBtn.className = "pure-button button-sm pure-button-secondary";
        readBtn.type = "button";
        readBtn.textContent = "Read";
        readBtn.dataset.messageReadId = String(item?.id || "");
        actions.appendChild(openLink);
        actions.appendChild(readBtn);

        card.appendChild(head);
        if (item?.body) card.appendChild(body);
        card.appendChild(actions);
        bodyEl.appendChild(card);
      });
    };

    const loadUnread = async (showLoading = false) => {
      if (showLoading) renderLoading();
      try {
        const resp = await fetch("/messages/unread.json?limit=12", {
          headers: {
            "X-Requested-With": "XMLHttpRequest"
          }
        });
        if (!resp.ok) throw new Error(`Request failed (${resp.status})`);
        const data = await resp.json();
        renderItems(data?.items || []);
        updateBadge(Number(data?.unread_count || 0));
      } catch {
        bodyEl.innerHTML = "";
        const error = document.createElement("div");
        error.className = "small-note messages-popover-empty";
        error.textContent = "Failed to load messages.";
        bodyEl.appendChild(error);
      }
    };

    const setOpen = (next) => {
      if (next) {
        popover.hidden = false;
        toggle.setAttribute("aria-expanded", "true");
        loadUnread(true);
      } else {
        popover.hidden = true;
        toggle.setAttribute("aria-expanded", "false");
      }
    };

    toggle.addEventListener("click", (event) => {
      event.preventDefault();
      const isOpen = !popover.hidden;
      setOpen(!isOpen);
    });

    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (toggle.contains(target) || popover.contains(target)) return;
      if (!popover.hidden) setOpen(false);
    });

    bodyEl.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const button = target.closest("[data-message-read-id]");
      if (!button) return;
      const messageId = Number(button.getAttribute("data-message-read-id"));
      if (!Number.isFinite(messageId)) return;
      button.setAttribute("disabled", "disabled");
      try {
        const data = await root.postForm(`/messages/${messageId}/read.json`, {});
        updateBadge(Number(data?.unread_count || 0));
        loadUnread(false);
      } catch {
        button.removeAttribute("disabled");
      }
    });

    readAllBtn?.addEventListener("click", async (event) => {
      event.preventDefault();
      readAllBtn.setAttribute("disabled", "disabled");
      try {
        const data = await root.postForm("/messages/read-all.json", {});
        updateBadge(Number(data?.unread_count || 0));
        loadUnread(false);
      } catch {
        // Ignore; user can retry.
      } finally {
        readAllBtn.removeAttribute("disabled");
      }
    });

    window.addEventListener("focus", () => {
      if (!popover.hidden) loadUnread(false);
      else loadUnread(false);
    });
  };

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        if (node.matches && node.matches("[data-tag-select]")) {
          initTagSelect(node);
        }
        if (node.querySelectorAll) {
          node.querySelectorAll("[data-tag-select]").forEach((el) => initTagSelect(el));
        }
      });
    });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  initMessagesPopover();

  root.createCustomFieldManager = ({
    listEl,
    onChange,
    rowClass = "setup-field-row",
    ui = "legacy"
  }) => {
    if (!listEl) return null;
    const showMachineCode = listEl.dataset.showMachineCode === "1";
    const machineId = normalizeText(listEl.dataset.machineId);
    const makeMachineToken = (id) => {
      const fieldId = normalizeText(id);
      if (!machineId || !/^\d+$/.test(machineId)) return "";
      if (!fieldId || !/^\d+$/.test(fieldId)) return "";
      return `%${machineId}:${fieldId}%`;
    };

    const notifyChange = () => {
      if (typeof onChange === "function") onChange();
    };

    const buildRow = (data = {}) => {
      const row = document.createElement("div");
      row.dataset.customField = "1";
      row.dataset.fieldId = data.id || `custom_${Date.now()}`;
      const codeToken = showMachineCode ? makeMachineToken(data.id) : "";
      if (ui === "flowbite") {
        row.className = rowClass;
        row.innerHTML = `
          <div>
            <label class="mb-2.5 block text-xs font-medium text-heading">Label</label>
            <input class="block w-full rounded-base border border-default-medium bg-neutral-secondary-medium px-3 py-2.5 text-sm text-heading shadow-xs placeholder:text-body focus:border-brand focus:ring-brand" type="text" data-custom-label value="${escapeHtml(normalizeText(data.label))}" placeholder="Label">
          </div>
          <div>
            <label class="mb-2.5 block text-xs font-medium text-heading">Unit</label>
            <input class="block w-full rounded-base border border-default-medium bg-neutral-secondary-medium px-3 py-2.5 text-sm text-heading shadow-xs placeholder:text-body focus:border-brand focus:ring-brand" type="text" data-custom-unit value="${escapeHtml(normalizeText(data.unit))}" placeholder="Unit">
          </div>
          <div class="md:col-span-2 xl:col-span-1">
            <label class="mb-2.5 block text-xs font-medium text-heading">Value</label>
            <input class="block w-full rounded-base border border-default-medium bg-neutral-secondary-medium px-3 py-2.5 text-sm text-heading shadow-xs placeholder:text-body focus:border-brand focus:ring-brand" type="text" data-custom-value data-template-input value="${escapeHtml(normalizeText(data.value))}" placeholder="Value">
            <div class="mt-2 hidden rounded-base border border-default-medium bg-neutral-secondary px-3 py-2 text-xs text-body" data-template-preview data-template-preview-ui="flowbite"></div>
          </div>
          ${showMachineCode ? `<div><label class="mb-2.5 block text-xs font-medium text-heading">Token</label><input class="block w-full rounded-base border border-default-medium bg-neutral-secondary px-3 py-2.5 font-mono text-xs text-body shadow-xs" type="text" value="${codeToken}" readonly title="Token"></div>` : ""}
          <div class="flex items-end"><button class="inline-flex size-10 items-center justify-center rounded-base border border-default-medium bg-neutral-secondary text-danger shadow-xs hover:bg-danger-soft focus:outline-none focus:ring-4 focus:ring-danger-soft" type="button" data-remove-field aria-label="Remove field" title="Remove field"><span class="material-symbols-rounded" aria-hidden="true">delete</span></button></div>
          <input type="hidden" data-custom-code value="${escapeHtml(normalizeText(data.code))}">
        `;
        return row;
      }
      row.className = showMachineCode ? `${rowClass} has-code` : rowClass;
      row.innerHTML = `
        <input type="text" data-custom-label value="${escapeHtml(normalizeText(data.label))}" placeholder="Label">
        <input type="text" data-custom-unit value="${escapeHtml(normalizeText(data.unit))}" placeholder="Unit">
        <input type="text" data-custom-value data-template-input value="${escapeHtml(normalizeText(data.value))}" placeholder="Value">
        <div class="template-preview" data-template-preview></div>
        ${
          showMachineCode
            ? `<input class="machine-code-input" type="text" value="${codeToken}" readonly title="Token">`
            : ""
        }
        <button class="icon-button danger" type="button" data-remove-field title="Remove">
          <span class="material-symbols-rounded" aria-hidden="true">delete</span>
        </button>
        <input type="hidden" data-custom-code value="${escapeHtml(normalizeText(data.code))}">
      `;
      return row;
    };

    const addRow = (data = {}) => {
      const row = buildRow(data);
      listEl.appendChild(row);
      root.initTemplateInputs?.(row);
      notifyChange();
      return row;
    };

    const addFromLibrary = (option) => {
      if (!option) return;
      const code = normalizeText(option.dataset.code);
      const label = normalizeText(option.dataset.label || option.textContent);
      const unit = normalizeText(option.dataset.unit);
      if (!label) return;
      const existing = Array.from(listEl.querySelectorAll('[data-custom-code]')).some(
        (input) => normalizeText(input.value) === code && code
      );
      if (existing) return;
      addRow({ code, label, unit });
    };

    const collect = () => {
      const rows = Array.from(listEl.querySelectorAll("[data-custom-field]"));
      return rows
        .map((row) => ({
          id: row.dataset.fieldId || "",
          code: normalizeText(row.querySelector("[data-custom-code]")?.value),
          label: normalizeText(row.querySelector("[data-custom-label]")?.value),
          unit: normalizeText(row.querySelector("[data-custom-unit]")?.value),
          value: row.querySelector("[data-custom-value]")?.value ?? ""
        }))
        .filter((row) => row.id && row.label);
    };

    listEl.addEventListener("input", () => notifyChange());
    listEl.addEventListener("click", (event) => {
      const removeBtn = event.target.closest("[data-remove-field]");
      if (!removeBtn) return;
      removeBtn.closest("[data-custom-field]")?.remove();
      notifyChange();
    });

    return { addRow, addFromLibrary, collect };
  };

  // Admin sidebar sections switch in-place on /admin. On standalone admin
  // library pages they must still be usable and lead back to that section.
  if (!document.querySelector('[data-admin-panel]')) {
    document.querySelectorAll('[data-admin-section]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        const section = button.dataset.adminSection;
        if (section) window.location.assign(`/admin#${encodeURIComponent(section)}`);
      });
    });
  }

})();
