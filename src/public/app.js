(() => {
  const root = (window.IMPlanner = window.IMPlanner || {});

  const normalizeText = (value) => String(value ?? "").trim();

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
      const update = () => {
        const raw = input.value || "";
        if (!/%\d+:\d+%/.test(raw)) {
          preview.textContent = "";
          preview.classList.remove("is-visible", "is-missing");
          return;
        }
        // Inline preview (green when resolved, red when missing).
        const { resolved, missing } = resolveTemplate(raw);
        if (missing.length) {
          preview.textContent = `Missing: ${missing.join(", ")}`;
          preview.classList.add("is-visible", "is-missing");
          preview.classList.remove("is-resolved");
          return;
        }
        preview.textContent = `= ${resolved}`;
        preview.classList.add("is-visible", "is-resolved");
        preview.classList.remove("is-missing");
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
        placeholder.className = "tag-placeholder";
        placeholder.textContent = "Select...";
        selectedEl.appendChild(placeholder);
        return;
      }
      selectedTags.forEach((tag) => {
        const chip = document.createElement("span");
        chip.className = "tag-chip";
        chip.textContent = tag;
        selectedEl.appendChild(chip);
      });
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
        "X-Requested-With": "XMLHttpRequest"
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
        "X-Requested-With": "XMLHttpRequest"
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

  root.createCustomFieldManager = ({
    listEl,
    onChange,
    rowClass = "setup-field-row"
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
      row.className = showMachineCode ? `${rowClass} has-code` : rowClass;
      row.dataset.customField = "1";
      row.dataset.fieldId = data.id || `custom_${Date.now()}`;
      const codeToken = showMachineCode ? makeMachineToken(data.id) : "";
      row.innerHTML = `
        <input type="text" data-custom-label value="${normalizeText(data.label)}" placeholder="Label">
        <input type="text" data-custom-unit value="${normalizeText(data.unit)}" placeholder="Unit">
        <input type="text" data-custom-value data-template-input value="${normalizeText(data.value)}" placeholder="Value">
        <div class="template-preview" data-template-preview></div>
        ${
          showMachineCode
            ? `<input class="machine-code-input" type="text" value="${codeToken}" readonly title="Token">`
            : ""
        }
        <button class="icon-button danger" type="button" data-remove-field title="Remove">
          <span class="material-symbols-rounded" aria-hidden="true">delete</span>
        </button>
        <input type="hidden" data-custom-code value="${normalizeText(data.code)}">
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
})();
