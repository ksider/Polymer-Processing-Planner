let analysisColumnLabels = {};
let analysisColumnUnits = {};
let analysisDataset = null;
let latestAnalyticsResult = null;
let selectedAnalysisRunId = null;
let selectedAnalysisTerm = null;
let analysisResponseLabel = "Response";
let analysisUsesCodedFactors = false;

(() => {
  const workspace = document.querySelector("[data-analysis-workspace]");
  if (!workspace) return;

  const columnLabelsNode = document.querySelector("#analysis-column-labels");
  if (columnLabelsNode?.textContent) {
    try {
      analysisColumnLabels = JSON.parse(columnLabelsNode.textContent) || {};
    } catch {
      analysisColumnLabels = {};
    }
  }
  const columnUnitsNode = document.querySelector("#analysis-column-units");
  if (columnUnitsNode?.textContent) {
    try {
      analysisColumnUnits = JSON.parse(columnUnitsNode.textContent) || {};
    } catch {
      analysisColumnUnits = {};
    }
  }
  const datasetNode = document.querySelector("#analysis-dataset");
  if (datasetNode?.textContent) {
    try { analysisDataset = JSON.parse(datasetNode.textContent); } catch { analysisDataset = null; }
  }

  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") || "";
  const engineStatus = workspace.querySelector("[data-engine-status]");
  const form = workspace.querySelector("[data-analysis-form]");
  const status = workspace.querySelector("[data-calculation-status]");
  const button = workspace.querySelector("[data-calculate-button]");
  const saveButton = workspace.querySelector("[data-save-analysis]");
  const analysisName = workspace.querySelector("[name=analysisName]");
  const analysisSwitcher = workspace.querySelector("[data-analysis-nav-select]");
  const savedAnalysisId = Number(workspace.dataset.analysisId) || null;
  const pendingCalculationJobId = Number(workspace.dataset.pendingJobId) || null;
  const archivedAnalysis = workspace.dataset.analysisState === "archived";
  const initialResultNode = document.querySelector("#analysis-initial-result");
  let hasVisibleResult = false;
  if (initialResultNode?.textContent) {
    try {
      const initialResult = JSON.parse(initialResultNode.textContent);
      if (initialResult?.ok === true) {
        renderResult(workspace, initialResult, false);
        hasVisibleResult = true;
      }
    } catch {
      showEmptyResult(workspace, "Saved result could not be displayed", "The stored result payload is invalid.");
    }
  }
  const engineController = new AbortController();
  const engineTimeout = window.setTimeout(() => engineController.abort(), 5_000);

  analysisSwitcher?.addEventListener("change", () => {
    const target = String(analysisSwitcher.value || "");
    if (target) window.location.assign(target);
  });
  bindRunSelection(workspace);
  bindTermSelection(workspace);
  bindTableCopy(workspace);
  bindAnalysisLifecycleActions(workspace, {
    csrfToken,
    savedAnalysisId,
    analysisName,
    status,
    button,
    saveButton
  });
  bindModelTermControls(form, archivedAnalysis);
  bindOptimizationControls(form, archivedAnalysis);
  bindResponseControls(form, archivedAnalysis);
  bindMultiOptimizer(workspace, csrfToken);
  bindSavedModelComparison(workspace);
  bindSavedGraphViews(workspace, csrfToken);
  bindModelTemplates(workspace, csrfToken, form);
  bindCustomGraph(workspace);
  if (savedAnalysisId && pendingCalculationJobId) {
    watchSavedCalculationJob(workspace, pendingCalculationJobId, {
      csrfToken,
      status,
      button,
      saveButton
    });
  }

  fetch(workspace.dataset.engineUrl, {
    headers: { accept: "application/json" },
    signal: engineController.signal
  })
    .then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || "Engine unavailable");
      if (engineStatus) {
        engineStatus.textContent = body.engine?.mode === "mock"
          ? "Contract mock · R is not connected"
          : `${body.engine?.name || "R engine"} · ${body.engine?.version || "unknown version"}`;
        engineStatus.classList.toggle("is-mock", body.engine?.mode === "mock");
      }
      const empty = workspace.querySelector("[data-results-empty]");
      if (body.engine?.mode === "mock") {
        if (status) status.textContent = "R is not connected. Mock mode does not calculate statistics.";
        if (empty) empty.querySelector("span:last-child").textContent = "Mock mode validates integration only and does not generate ANOVA or coefficients.";
        return;
      }
      if (!archivedAnalysis && !pendingCalculationJobId && button) button.disabled = false;
      if (!archivedAnalysis && !pendingCalculationJobId && saveButton) saveButton.disabled = false;
      if (savedAnalysisId) {
        if (status) {
          status.textContent = pendingCalculationJobId
            ? "Calculation is queued. This page will refresh when the result is ready."
            : archivedAnalysis
            ? "Archived analysis loaded. Restore it to edit or recalculate."
            : workspace.dataset.analysisState === "stale"
              ? "Source data changed. Recalculate to create a new revision."
              : "Saved analysis loaded. Change settings or recalculate when needed.";
        }
      } else {
        if (status) status.textContent = "R is connected. Calculating the default model…";
        form?.requestSubmit();
      }
    })
    .catch(() => {
      if (engineStatus) {
        engineStatus.textContent = "Analytics engine unavailable";
        engineStatus.classList.add("is-error");
      }
      if (status) status.textContent = "Analytics engine is unavailable.";
      if (!hasVisibleResult) {
        showEmptyResult(workspace, "Analytics engine unavailable", "The worksheet remains available, but a model cannot be calculated until R is connected.");
      }
    })
    .finally(() => window.clearTimeout(engineTimeout));

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (archivedAnalysis) return;
    const specification = readSpecification(form);
    let calculationQueued = false;
    if (button) button.disabled = true;
    if (status) status.textContent = "Calculating…";
    try {
      const calculationUrl = savedAnalysisId
        ? `${workspace.dataset.analysesUrl}/${savedAnalysisId}/calculate`
        : workspace.dataset.calculateUrl;
      const response = await fetch(calculationUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-csrf-token": csrfToken
        },
        body: JSON.stringify({ specification })
      });
      const payload = await response.json();
      if (savedAnalysisId && response.status === 202 && payload.job?.id) {
        calculationQueued = true;
        if (status) status.textContent = "Calculation queued…";
        watchSavedCalculationJob(workspace, Number(payload.job.id), {
          csrfToken,
          status,
          button,
          saveButton
        });
        return;
      }
      const result = payload.result ?? payload;
      if (!response.ok || result.ok !== true) {
        throw new Error(payload.message || result.message || result.error?.message || "Calculation failed");
      }
      renderResult(workspace, result);
      hasVisibleResult = true;
      if (status) status.textContent = result.engine?.mode === "mock"
        ? "Contract checked. Connect R to obtain statistical results."
        : `Calculated with ${result.engine.name} ${result.engine.version}.`;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Calculation failed.";
      if (status) status.textContent = message;
      if (!hasVisibleResult) showEmptyResult(workspace, "Model was not calculated", message);
    } finally {
      if (button && !calculationQueued) button.disabled = false;
    }
  });

  saveButton?.addEventListener("click", async () => {
    if (!form) return;
    const name = String(analysisName?.value || "").trim();
    if (!name) {
      if (status) status.textContent = "Enter an analysis name before saving.";
      analysisName?.focus();
      return;
    }
    saveButton.disabled = true;
    if (button) button.disabled = true;
    if (status) status.textContent = "Saving analysis…";
    try {
      const response = await fetch(workspace.dataset.analysesUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-csrf-token": csrfToken
        },
        body: JSON.stringify({ name, specification: readSpecification(form) })
      });
      const payload = await response.json();
      if (!response.ok || !payload.analysis?.id) {
        throw new Error(payload.message || payload.error || "Analysis could not be saved.");
      }
      if (status) status.textContent = "Analysis saved. Creating the first calculation revision…";
      try {
        await fetch(`${workspace.dataset.analysesUrl}/${payload.analysis.id}/calculate`, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-csrf-token": csrfToken
          },
          body: JSON.stringify({ specification: readSpecification(form) })
        });
      } finally {
        window.location.assign(`${window.location.pathname}?analysis_id=${payload.analysis.id}`);
      }
    } catch (error) {
      if (status) status.textContent = error instanceof Error ? error.message : "Analysis could not be saved.";
      saveButton.disabled = false;
      if (button) button.disabled = false;
    }
  });

  window.addEventListener("resize", () => {
    workspace.querySelectorAll(".doe-analysis-chart").forEach((element) => {
      window.echarts?.getInstanceByDom(element)?.resize();
    });
  });
})();

function bindAnalysisLifecycleActions(workspace, context) {
  const { csrfToken, savedAnalysisId, analysisName, status, button, saveButton } = context;
  if (!savedAnalysisId) return;
  const baseUrl = `${workspace.dataset.analysesUrl}/${savedAnalysisId}`;
  const actionButtons = workspace.querySelectorAll("[data-rename-analysis], [data-duplicate-analysis], [data-archive-analysis], [data-restore-analysis]");
  const runAction = async (sourceButton, url, options = {}) => {
    actionButtons.forEach((item) => { item.disabled = true; });
    if (button) button.disabled = true;
    if (saveButton) saveButton.disabled = true;
    try {
      const response = await fetch(url, {
        method: options.method || "POST",
        headers: {
          accept: "application/json",
          ...(options.body ? { "content-type": "application/json" } : {}),
          "x-csrf-token": csrfToken
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {})
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || payload.error || "Analysis could not be updated.");
      return payload;
    } catch (error) {
      if (status) status.textContent = error instanceof Error ? error.message : "Analysis could not be updated.";
      actionButtons.forEach((item) => { item.disabled = false; });
      throw error;
    }
  };

  workspace.querySelector("[data-rename-analysis]")?.addEventListener("click", async (event) => {
    const name = String(analysisName?.value || "").trim();
    if (!name) {
      if (status) status.textContent = "Enter an analysis name before renaming.";
      analysisName?.focus();
      return;
    }
    if (status) status.textContent = "Renaming analysis…";
    try {
      await runAction(event.currentTarget, baseUrl, { method: "PATCH", body: { name } });
      window.location.reload();
    } catch {
      // The request helper has already reported the error.
    }
  });

  workspace.querySelector("[data-duplicate-analysis]")?.addEventListener("click", async (event) => {
    const currentName = String(analysisName?.value || "Analysis").trim() || "Analysis";
    const name = window.prompt("Name for the duplicate analysis", `${currentName} copy`);
    if (name === null) return;
    if (!name.trim()) {
      if (status) status.textContent = "Enter a name for the duplicate analysis.";
      return;
    }
    if (status) status.textContent = "Duplicating analysis…";
    try {
      const payload = await runAction(event.currentTarget, `${baseUrl}/duplicate`, { body: { name } });
      window.location.assign(`${window.location.pathname}?analysis_id=${payload.analysis.id}`);
    } catch {
      // The request helper has already reported the error.
    }
  });

  workspace.querySelector("[data-archive-analysis]")?.addEventListener("click", async (event) => {
    if (!window.confirm("Archive this analysis? Its saved revisions will be kept and it can be restored later.")) return;
    if (status) status.textContent = "Archiving analysis…";
    try {
      await runAction(event.currentTarget, `${baseUrl}/archive`);
      window.location.assign(window.location.pathname);
    } catch {
      // The request helper has already reported the error.
    }
  });

  workspace.querySelector("[data-restore-analysis]")?.addEventListener("click", async (event) => {
    if (status) status.textContent = "Restoring analysis…";
    try {
      await runAction(event.currentTarget, `${baseUrl}/restore`);
      window.location.reload();
    } catch {
      // The request helper has already reported the error.
    }
  });
}

function watchSavedCalculationJob(workspace, jobId, context) {
  const analysisId = Number(workspace.dataset.analysisId);
  if (!analysisId || !jobId) return;
  const { status, button, saveButton } = context;
  if (button) button.disabled = true;
  if (saveButton) saveButton.disabled = true;
  const jobUrl = `${workspace.dataset.analysesUrl}/${analysisId}/jobs/${jobId}`;
  const poll = async () => {
    try {
      const response = await fetch(jobUrl, { headers: { accept: "application/json" } });
      const payload = await response.json();
      if (!response.ok || !payload.job) throw new Error(payload.message || payload.error || "Calculation status is unavailable.");
      const job = payload.job;
      if (job.status === "QUEUED" || job.status === "RUNNING") {
        if (status) status.textContent = job.status === "QUEUED" ? "Calculation queued…" : "Calculating model…";
        window.setTimeout(poll, 700);
        return;
      }
      if (job.status === "SUCCEEDED") {
        if (status) status.textContent = "Calculation completed. Refreshing saved revision…";
        window.location.reload();
        return;
      }
      const message = job.error?.message || "Calculation did not complete.";
      if (status) status.textContent = message;
      if (button) button.disabled = false;
      if (saveButton) saveButton.disabled = false;
    } catch (error) {
      if (status) status.textContent = error instanceof Error ? error.message : "Calculation status is unavailable.";
      if (button) button.disabled = false;
      if (saveButton) saveButton.disabled = false;
    }
  };
  void poll();
}

function readSpecification(form) {
  const data = new FormData(form);
  const factorKeys = data.getAll("factorKeys").map(String);
  const objective = String(data.get("optimizationObjective") || "");
  const derivedOperation = String(data.get("derivedOperation") || "");
  const derivedLeftKey = String(data.get("derivedLeftKey") || "");
  const derivedRightKey = String(data.get("derivedRightKey") || "");
  const tagResponseTag = String(data.get("tagResponseTag") || "");
  const factorBounds = Object.fromEntries(factorKeys.flatMap((key) => {
    const minRaw = String(data.get(`optimizationMin:${key}`) ?? "").trim();
    const maxRaw = String(data.get(`optimizationMax:${key}`) ?? "").trim();
    const min = Number(minRaw);
    const max = Number(maxRaw);
    return minRaw && maxRaw && Number.isFinite(min) && Number.isFinite(max) ? [[key, { min, max }]] : [];
  }));
  return {
    responseKey: derivedOperation ? derivedLeftKey : String(data.get("responseKey") || ""),
    factorKeys,
    blockKeys: data.getAll("blockKeys").map(String),
    modelFamily: String(data.get("modelFamily") || "regression"),
    modelTerms: data.getAll("modelTerms").map(String),
    useCodedFactors: data.has("useCodedFactors"),
    includeIncomplete: data.has("includeIncomplete"),
    includeExcluded: data.has("includeExcluded"),
    confidenceLevel: Number(data.get("confidenceLevel") || 0.95),
    responseTransform: String(data.get("responseTransform") || "none"),
    ...((derivedOperation === "difference" || derivedOperation === "sum" || derivedOperation === "ratio")
      ? { derivedResponse: { operation: derivedOperation, leftKey: derivedLeftKey, rightKey: derivedRightKey } }
      : {}),
    ...(tagResponseTag ? { tagResponse: { tag: tagResponseTag } } : {}),
    ...(objective === "minimize" || objective === "maximize" || objective === "target"
      ? {
        optimization: {
          objective,
          ...(objective === "target" ? { target: Number(data.get("optimizationTarget")) } : {}),
          factorBounds
        }
      }
      : {})
  };
}

function responseLabelForSpecification(specification, fallback) {
  const derived = specification?.derivedResponse;
  let label;
  if (specification?.tagResponse?.tag) {
    label = `${displayColumn(specification.responseKey, fallback)} contains ${specification.tagResponse.tag}`;
  } else if (derived?.leftKey && derived?.rightKey) {
    const operator = derived.operation === "difference" ? " − " : derived.operation === "sum" ? " + " : " ÷ ";
    label = `${displayColumn(derived.leftKey, derived.leftKey)}${operator}${displayColumn(derived.rightKey, derived.rightKey)}`;
  } else {
    label = displayColumn(specification?.responseKey, fallback);
  }
  label = specification?.responseModel === "binary" ? `P(${label} = Yes)` : label;
  return specification?.responseTransform && specification.responseTransform !== "none"
    ? `${specification.responseTransform}(${label})`
    : label;
}

function bindResponseControls(form, archivedAnalysis) {
  if (!form) return;
  const response = form.elements.namedItem("responseKey");
  const transform = form.elements.namedItem("responseTransform");
  if (!(response instanceof HTMLSelectElement) || !(transform instanceof HTMLSelectElement)) return;
  const responseType = () => analysisDataset?.columns?.find((column) => column.key === response.value)?.dataType;
  const tagControls = form.querySelector("[data-tag-response-controls]");
  const tagSelector = form.elements.namedItem("tagResponseTag");
  const derivedControls = form.querySelector("[data-derived-response-controls]");
  const derivedOperation = form.elements.namedItem("derivedOperation");
  const derivedLeft = form.elements.namedItem("derivedLeftKey");
  const derivedRight = form.elements.namedItem("derivedRightKey");
  const derivedOperands = form.querySelector("[data-derived-operands]");
  const derivedPreview = form.querySelector("[data-derived-preview]");
  const derivedLeftLabel = form.querySelector("[data-derived-left-label]");
  const derivedRightLabel = form.querySelector("[data-derived-right-label]");
  const refreshDerivedPreview = () => {
    if (!(derivedOperation instanceof HTMLSelectElement) || !(derivedLeft instanceof HTMLSelectElement) || !(derivedRight instanceof HTMLSelectElement)) return;
    const operation = derivedOperation.value;
    if (derivedOperands instanceof HTMLElement) derivedOperands.hidden = !operation;
    if (derivedPreview instanceof HTMLElement) {
      if (!operation) {
        derivedPreview.textContent = "The selected measured response is fitted directly.";
      } else {
        const leftLabel = derivedLeft.selectedOptions[0]?.textContent?.trim() || "A";
        const rightLabel = derivedRight.selectedOptions[0]?.textContent?.trim() || "B";
        const operator = operation === "difference" ? "−" : operation === "sum" ? "+" : "÷";
        derivedPreview.textContent = `Calculated response: ${leftLabel} ${operator} ${rightLabel}. This expression is saved with the analysis revision.`;
      }
    }
    if (derivedLeftLabel instanceof HTMLLabelElement && derivedRightLabel instanceof HTMLLabelElement) {
      if (operation === "difference") {
        derivedLeftLabel.textContent = "Starting measurement (A)";
        derivedRightLabel.textContent = "Subtract this measurement (B)";
      } else if (operation === "sum") {
        derivedLeftLabel.textContent = "Measurement to add (A)";
        derivedRightLabel.textContent = "Measurement to add (B)";
      } else if (operation === "ratio") {
        derivedLeftLabel.textContent = "Numerator (A)";
        derivedRightLabel.textContent = "Denominator (B)";
      } else {
        derivedLeftLabel.textContent = "Measurement A";
        derivedRightLabel.textContent = "Measurement B";
      }
    }
  };
  const sync = () => {
    const type = responseType();
    const binary = type === "boolean" || type === "tags";
    [...transform.options].forEach((option) => { option.disabled = binary && option.value !== "none"; });
    if (binary) transform.value = "none";
    transform.disabled = archivedAnalysis || binary;
    if (tagSelector instanceof HTMLSelectElement) {
      const tagResponse = type === "tags";
      if (tagControls instanceof HTMLElement) tagControls.hidden = !tagResponse;
      [...tagSelector.options].forEach((option) => {
        option.hidden = Boolean(option.dataset.responseKey && option.dataset.responseKey !== response.value);
      });
      if (tagResponse && tagSelector.selectedOptions[0]?.dataset.responseKey !== response.value) {
        const first = [...tagSelector.options].find((option) => option.dataset.responseKey === response.value);
        tagSelector.value = first?.value || "";
      }
      tagSelector.disabled = archivedAnalysis || !tagResponse;
    }
    if (derivedControls instanceof HTMLElement) {
      const numeric = type === "number";
      derivedControls.hidden = !numeric;
      derivedControls.querySelectorAll("select").forEach((control) => { control.disabled = archivedAnalysis || !numeric; });
      if (!numeric) {
        if (derivedOperation instanceof HTMLSelectElement) derivedOperation.value = "";
      }
      refreshDerivedPreview();
    }
  };
  response.addEventListener("change", sync);
  derivedOperation instanceof HTMLSelectElement && derivedOperation.addEventListener("change", refreshDerivedPreview);
  derivedLeft instanceof HTMLSelectElement && derivedLeft.addEventListener("change", refreshDerivedPreview);
  derivedRight instanceof HTMLSelectElement && derivedRight.addEventListener("change", refreshDerivedPreview);
  sync();
}

function bindOptimizationControls(form, archivedAnalysis) {
  if (!form) return;
  const objective = form.elements.namedItem("optimizationObjective");
  if (!(objective instanceof HTMLSelectElement)) return;
  const targetControls = [...form.querySelectorAll("[data-optimization-target]")];
  const factorControls = [...form.querySelectorAll('input[name="factorKeys"]')];
  const sync = () => {
    const active = objective.value !== "";
    targetControls.forEach((control) => { control.hidden = objective.value !== "target"; });
    form.querySelectorAll("[data-optimization-factor]").forEach((row) => {
      const enabled = active && factorControls.some((control) => control.checked && control.value === row.dataset.optimizationFactor);
      row.hidden = !enabled;
      row.querySelectorAll("input").forEach((input) => { input.disabled = archivedAnalysis || !enabled; });
    });
  };
  objective.addEventListener("change", sync);
  factorControls.forEach((control) => control.addEventListener("change", sync));
  sync();
}

async function bindMultiOptimizer(workspace, csrfToken) {
  const dialog = workspace.querySelector("[data-multi-optimize-dialog]");
  const open = workspace.querySelector("[data-open-multi-optimize]");
  const form = workspace.querySelector("[data-multi-optimize-form]");
  const goalsHost = workspace.querySelector("[data-multi-optimize-goals]");
  const status = workspace.querySelector("[data-multi-optimize-status]");
  const resultHost = workspace.querySelector("[data-multi-optimize-result]");
  if (!dialog || !open || !form || !goalsHost || !status || !resultHost) return;
  workspace.querySelector("[data-close-multi-optimize]")?.addEventListener("click", () => dialog.close());
  try {
    const response = await fetch(workspace.dataset.multiOptimizeUrl, { headers: { accept: "application/json" } });
    const payload = await response.json();
    const candidates = payload.candidates || [];
    if (candidates.length < 2) return;
    const groups = new Map();
    for (const candidate of candidates) {
      const key = JSON.stringify([candidate.datasetRevision, candidate.factorKeys || [], candidate.blockKeys || []]);
      groups.set(key, [...(groups.get(key) || []), candidate]);
    }
    const candidateGroups = [...groups.values()];
    const currentAnalysisId = Number(workspace.dataset.analysisId);
    const currentGroup = candidateGroups.find((group) => group.some((candidate) => candidate.analysisId === currentAnalysisId));
    const compatible = currentAnalysisId
      ? currentGroup || []
      : candidateGroups.sort((left, right) => right.length - left.length)[0] || [];
    open.hidden = false;
    open.addEventListener("click", () => dialog.showModal());
    if (compatible.length < 2) {
      form.hidden = true;
      const note = document.createElement("p");
      note.className = "doe-analysis-notice";
      note.textContent = currentAnalysisId
        ? "No other saved model matches this model’s dataset snapshot, factor set, and block adjustment. Recalculate or save a compatible response model to optimize them together."
        : "No compatible pair of saved models is available yet. Saved models must share a dataset snapshot, factor set, and block adjustment.";
      goalsHost.replaceChildren(note);
      return;
    }
    form.hidden = false;
    goalsHost.replaceChildren(...compatible.map((candidate) => {
      const row = document.createElement("fieldset");
      row.className = "doe-analysis-fieldset";
      row.innerHTML = `<label class="pure-checkbox"><input type="checkbox" name="multiAnalysis" value="${candidate.analysisId}"> <strong>${escapeHtml(candidate.name)}</strong> · ${escapeHtml(analysisColumnLabels[candidate.responseKey] || candidate.responseKey)}</label><label>Goal <select name="multiObjective:${candidate.analysisId}"><option value="maximize">Maximize</option><option value="minimize">Minimize</option><option value="target">Target</option></select></label><label>Target <input name="multiTarget:${candidate.analysisId}" type="number" step="any"></label><label>Importance (1–5) <input name="multiImportance:${candidate.analysisId}" type="number" min="1" max="5" value="1"></label>`;
      return row;
    }));
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const selected = data.getAll("multiAnalysis").map(Number).filter(Number.isFinite);
      if (selected.length < 2) { status.textContent = "Select at least two saved analyses."; return; }
      const goals = selected.map((analysisId) => {
        const targetRaw = String(data.get(`multiTarget:${analysisId}`) ?? "").trim();
        return { analysisId, objective: String(data.get(`multiObjective:${analysisId}`)), ...(targetRaw ? { target: Number(targetRaw) } : {}), importance: Number(data.get(`multiImportance:${analysisId}`) || 1) };
      });
      status.textContent = "Optimizing saved models…";
      const answer = await fetch(workspace.dataset.multiOptimizeUrl, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify({ goals }) });
      const body = await answer.json();
      if (!answer.ok) { status.textContent = body.error || "Optimization failed."; return; }
      status.textContent = `Evaluated ${formatNumber(body.result.candidatesEvaluated)} settings.`;
      resultHost.hidden = false;
      resultHost.replaceChildren(...Object.entries({ ...(body.result.factorValues || {}), ...(body.result.blockValues || {}) }).map(([key, value]) => { const item = document.createElement("div"); item.textContent = `${displayColumn(key, key)}: ${formatNumber(value)}`; return item; }), ...body.result.responses.map((row) => { const item = document.createElement("div"); item.textContent = `${displayColumn(row.responseKey, row.responseKey)}: ${formatNumber(row.predicted)} · desirability ${formatNumber(row.desirability)}`; return item; }));
    });
  } catch { status.textContent = "Saved multi-response analyses are unavailable."; }
}

function escapeHtml(value) { const node = document.createElement("span"); node.textContent = String(value); return node.innerHTML; }

async function bindSavedModelComparison(workspace) {
  const dialog = workspace.querySelector("[data-analysis-comparison-dialog]");
  const open = workspace.querySelector("[data-open-comparison]");
  const left = workspace.querySelector("[data-comparison-left]");
  const right = workspace.querySelector("[data-comparison-right]");
  const output = workspace.querySelector("[data-comparison-result]");
  if (!dialog || !open || !left || !right || !output || !workspace.dataset.comparisonUrl) return;
  workspace.querySelector("[data-close-comparison]")?.addEventListener("click", () => dialog.close());
  try {
    const response = await fetch(workspace.dataset.comparisonUrl, { headers: { accept: "application/json" } });
    const payload = await response.json(); const candidates = payload.candidates || [];
    if (!response.ok || candidates.length < 2) return;
    open.hidden = false;
    open.addEventListener("click", () => dialog.showModal());
    for (const select of [left, right]) select.replaceChildren(...candidates.map((item) => {
      const option = document.createElement("option"); option.value = String(item.revisionId); option.textContent = `${item.analysisName} · revision #${item.revisionId}`; return option;
    }));
    right.selectedIndex = 1;
    const render = () => {
      const first = candidates.find((item) => item.revisionId === Number(left.value)); const second = candidates.find((item) => item.revisionId === Number(right.value));
      if (!first || !second || first.revisionId === second.revisionId) { output.replaceChildren(); return; }
      const notice = document.createElement("p"); notice.className = first.datasetRevision === second.datasetRevision ? "small-note" : "doe-analysis-notice";
      notice.textContent = first.datasetRevision === second.datasetRevision ? "Both revisions use the same dataset snapshot." : "Different dataset snapshots: metric differences may reflect changed data as well as the model.";
      const metrics = (item) => new Map((item.summary.metrics || []).map((metric) => [metric.key, metric])); const a = metrics(first); const b = metrics(second);
      const table = document.createElement("table"); table.className = "pure-table pure-table-horizontal doe-analysis-table";
      table.innerHTML = `<thead><tr><th>Metric</th><th>${escapeHtml(first.analysisName)}</th><th>${escapeHtml(second.analysisName)}</th></tr></thead>`;
      const body = document.createElement("tbody"); for (const key of new Set([...a.keys(), ...b.keys()])) { const row = document.createElement("tr"); row.innerHTML = `<td>${escapeHtml(a.get(key)?.label || b.get(key)?.label || key)}</td><td>${formatNumber(a.get(key)?.value)}</td><td>${formatNumber(b.get(key)?.value)}</td>`; body.append(row); } table.append(body);
      output.replaceChildren(notice, table);
    };
    left.addEventListener("change", render); right.addEventListener("change", render); render();
  } catch { /* comparison is optional */ }
}

async function bindModelTemplates(workspace, csrfToken, analysisForm) {
  const dialog = workspace.querySelector("[data-templates-dialog]");
  const open = workspace.querySelector("[data-open-templates]");
  const list = workspace.querySelector("[data-templates-list]");
  const form = workspace.querySelector("[data-save-template-form]");
  const status = workspace.querySelector("[data-template-status]");
  const url = workspace.dataset.templatesUrl;
  if (!dialog || !open || !list || !form || !status || !analysisForm || !url) return;
  workspace.querySelector("[data-close-templates]")?.addEventListener("click", () => dialog.close());
  const load = async () => {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Model templates are unavailable.");
    const templates = Array.isArray(body.templates) ? body.templates : [];
    list.replaceChildren(...templates.map((template) => {
      const row = document.createElement("div"); row.className = "doe-analysis-revision-item";
      const title = document.createElement("strong"); title.textContent = template.name;
      const detail = document.createElement("small"); detail.textContent = `${template.specification?.modelFamily || "model"} · ${template.specification?.factorCodes?.length || 0} factors`;
      const apply = document.createElement("button"); apply.className = "pure-button button-small"; apply.type = "button"; apply.textContent = "Apply";
      apply.addEventListener("click", async () => {
        status.textContent = "Checking template against this DOE…";
        const response = await fetch(`${url}/${template.id}/apply`, { method: "POST", headers: { accept: "application/json", "x-csrf-token": csrfToken } });
        const body = await response.json();
        if (!response.ok) { status.textContent = body.error || "Template cannot be applied to this DOE."; return; }
        applySpecificationToForm(analysisForm, body.specification);
        status.textContent = `Applied “${template.name}”. Review the settings, then calculate or save the analysis.`;
        dialog.close();
      });
      const remove = document.createElement("button"); remove.className = "icon-button tiny"; remove.type = "button"; remove.title = "Delete template"; remove.setAttribute("aria-label", "Delete template"); remove.innerHTML = '<span class="material-symbols-rounded" aria-hidden="true">delete</span>';
      remove.addEventListener("click", async () => {
        if (!window.confirm(`Delete shared model template “${template.name}”?`)) return;
        const response = await fetch(`${url}/${template.id}`, { method: "DELETE", headers: { "x-csrf-token": csrfToken } });
        if (!response.ok) { status.textContent = "Template could not be deleted."; return; }
        await load();
      });
      row.append(title, detail, apply, remove); return row;
    }));
    if (!templates.length) list.textContent = "No shared templates for this process type yet.";
  };
  try { await load(); open.hidden = false; } catch { return; }
  open.addEventListener("click", () => dialog.showModal());
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = String(new FormData(form).get("name") || "").trim();
    if (!name) { status.textContent = "Enter a template name."; return; }
    status.textContent = "Saving template…";
    const response = await fetch(url, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify({ name, specification: readSpecification(analysisForm) }) });
    const body = await response.json();
    if (!response.ok) { status.textContent = body.message || body.error || "Template could not be saved."; return; }
    form.reset(); status.textContent = "Shared template saved."; await load();
  });
}

function applySpecificationToForm(form, specification) {
  const setValue = (name, value) => {
    const field = form.elements.namedItem(name);
    if (field instanceof HTMLSelectElement || field instanceof HTMLInputElement) field.value = String(value ?? "");
  };
  const setChecks = (name, values) => {
    const wanted = new Set(values || []);
    form.querySelectorAll(`[name="${name}"]`).forEach((field) => { if (field instanceof HTMLInputElement) field.checked = wanted.has(field.value); });
  };
  setValue("responseKey", specification.responseKey);
  form.elements.namedItem("responseKey")?.dispatchEvent(new Event("change"));
  setValue("modelFamily", specification.modelFamily);
  setChecks("factorKeys", specification.factorKeys);
  setChecks("blockKeys", specification.blockKeys || []);
  setChecks("modelTerms", specification.modelTerms);
  const coded = form.elements.namedItem("useCodedFactors"); if (coded instanceof HTMLInputElement) coded.checked = specification.useCodedFactors === true;
  const incomplete = form.elements.namedItem("includeIncomplete"); if (incomplete instanceof HTMLInputElement) incomplete.checked = specification.includeIncomplete === true;
  const excluded = form.elements.namedItem("includeExcluded"); if (excluded instanceof HTMLInputElement) excluded.checked = specification.includeExcluded === true;
  setValue("confidenceLevel", specification.confidenceLevel);
  setValue("responseTransform", specification.responseTransform);
  setValue("derivedOperation", specification.derivedResponse?.operation || "");
  setValue("derivedLeftKey", specification.derivedResponse?.leftKey || "");
  setValue("derivedRightKey", specification.derivedResponse?.rightKey || "");
  setValue("tagResponseTag", specification.tagResponse?.tag || "");
  setValue("optimizationObjective", specification.optimization?.objective || "");
  setValue("optimizationTarget", specification.optimization?.target ?? "");
  for (const [key, bounds] of Object.entries(specification.optimization?.factorBounds || {})) {
    setValue(`optimizationMin:${key}`, bounds.min);
    setValue(`optimizationMax:${key}`, bounds.max);
  }
  form.elements.namedItem("modelFamily")?.dispatchEvent(new Event("change"));
  form.elements.namedItem("optimizationObjective")?.dispatchEvent(new Event("change"));
  form.elements.namedItem("derivedOperation")?.dispatchEvent(new Event("change"));
}

async function bindSavedGraphViews(workspace, csrfToken) {
  const dialog = workspace.querySelector("[data-saved-views-dialog]");
  const open = workspace.querySelector("[data-open-saved-views]");
  const form = workspace.querySelector("[data-save-view-form]");
  const status = workspace.querySelector("[data-save-view-status]");
  const list = workspace.querySelector("[data-saved-views-list]");
  const revisionId = Number(workspace.dataset.analysisRevisionId);
  if (!dialog || !open || !form || !status || !list || !workspace.dataset.viewsUrl || !revisionId) return;
  workspace.querySelector("[data-close-saved-views]")?.addEventListener("click", () => dialog.close());
  const load = async () => {
    const response = await fetch(workspace.dataset.viewsUrl, { headers: { accept: "application/json" } });
    const payload = await response.json();
    const views = payload.views || [];
    list.replaceChildren(...views.map((view) => {
      const row = document.createElement("div"); row.className = "doe-analysis-revision-item";
      const title = document.createElement("strong"); title.textContent = view.name;
      const detail = document.createElement("small"); detail.textContent = `${view.chartType} · revision #${view.analysisRevisionId ?? "—"}`;
      const apply = document.createElement("button"); apply.className = "pure-button button-small"; apply.type = "button"; apply.textContent = "Open";
      apply.disabled = view.analysisRevisionId !== revisionId;
      apply.title = apply.disabled ? "Open the calculation revision that this graph was saved from." : "Open graph";
      apply.addEventListener("click", () => applySavedGraphView(workspace, view));
      const remove = document.createElement("button"); remove.className = "icon-button tiny"; remove.type = "button"; remove.title = "Delete saved graph"; remove.setAttribute("aria-label", "Delete saved graph"); remove.innerHTML = '<span class="material-symbols-rounded" aria-hidden="true">delete</span>';
      remove.addEventListener("click", async () => {
        if (!window.confirm(`Delete saved graph “${view.name}”?`)) return;
        const response = await fetch(`${workspace.dataset.viewsUrl}/${view.id}`, { method: "DELETE", headers: { "x-csrf-token": csrfToken } });
        if (!response.ok) { status.textContent = "Saved graph could not be deleted."; return; }
        status.textContent = "Saved graph deleted."; await load();
      });
      row.append(title, detail, apply, remove); return row;
    }));
    if (!views.length) list.textContent = "No graphs saved for this DOE yet.";
  };
  try { await load(); open.hidden = false; } catch { return; }
  open.addEventListener("click", () => dialog.showModal());
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const current = currentGraphView(workspace);
    if (!current) { status.textContent = "Choose an interaction or response-surface graph first."; return; }
    const name = String(new FormData(form).get("name") || "").trim();
    status.textContent = "Saving graph…";
    const response = await fetch(workspace.dataset.viewsUrl, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify({ name, chartType: current.chartType, config: current.config, analysisId: Number(workspace.dataset.analysisId) || null, analysisRevisionId: revisionId }) });
    const payload = await response.json();
    if (!response.ok) { status.textContent = payload.error || "Graph could not be saved."; return; }
    status.textContent = "Graph saved."; form.reset(); await load();
  });
}

function currentGraphView(workspace) {
  if (workspace.dataset.currentCustomGraph) {
    try { return { chartType: "scatter", config: JSON.parse(workspace.dataset.currentCustomGraph) }; } catch { /* no saved custom configuration */ }
  }
  const surfaceCard = workspace.querySelector("[data-surface-card]");
  const surfacePair = workspace.querySelector("[data-surface-pair]");
  const surfaceView = workspace.querySelector("[data-surface-view]");
  if (!surfaceCard?.hidden && surfacePair?.value && surfaceView?.value) return { chartType: "surface", config: { pair: surfacePair.value, view: surfaceView.value } };
  const interactionCard = workspace.querySelector("[data-interaction-card]");
  const interactionPair = workspace.querySelector("[data-interaction-pair]");
  if (!interactionCard?.hidden && interactionPair?.value) return { chartType: "interaction", config: { pair: interactionPair.value } };
  return null;
}

function applySavedGraphView(workspace, view) {
  const config = view.config || {};
  if (view.chartType === "surface") {
    const pair = workspace.querySelector("[data-surface-pair]"); const mode = workspace.querySelector("[data-surface-view]");
    if (pair && typeof config.pair === "string") pair.value = config.pair;
    if (mode && typeof config.view === "string") mode.value = config.view;
    pair?.dispatchEvent(new Event("change")); return;
  }
  if (view.chartType === "interaction") {
    const pair = workspace.querySelector("[data-interaction-pair]");
    if (pair && typeof config.pair === "string") pair.value = config.pair;
    pair?.dispatchEvent(new Event("change"));
  }
  if (view.chartType === "scatter") renderCustomGraph(workspace, view.config || {});
}

function bindCustomGraph(workspace) {
  const dialog = workspace.querySelector("[data-custom-graph-dialog]");
  const open = workspace.querySelector("[data-open-custom-graph]");
  const form = workspace.querySelector("[data-custom-graph-form]");
  const body = workspace.querySelector("[data-custom-graph-body]");
  const toggle = workspace.querySelector("[data-toggle-custom-graph]");
  if (!dialog || !open || !form || !body || !toggle || !analysisDataset) return;
  const initialConfig = () => {
    const initial = new FormData(form);
    return { xKey: String(initial.get("xKey") || ""), yKey: String(initial.get("yKey") || ""), groupKey: "", mode: "raw" };
  };
  const reveal = () => {
    body.hidden = false;
    toggle.textContent = "Hide graph";
    toggle.setAttribute("aria-expanded", "true");
    if (!workspace.dataset.currentCustomGraph) renderCustomGraph(workspace, initialConfig(), false);
  };
  const conceal = () => {
    body.hidden = true;
    toggle.textContent = "Show graph";
    toggle.setAttribute("aria-expanded", "false");
  };
  workspace.querySelector("[data-close-custom-graph]")?.addEventListener("click", () => dialog.close());
  open.addEventListener("click", () => dialog.showModal());
  toggle.addEventListener("click", () => body.hidden ? reveal() : conceal());
  workspace.querySelector("[data-reveal-custom-graph]")?.addEventListener("click", reveal);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    renderCustomGraph(workspace, { xKey: String(data.get("xKey") || ""), yKey: String(data.get("yKey") || ""), groupKey: String(data.get("groupKey") || ""), sizeKey: String(data.get("sizeKey") || ""), labelRuns: data.has("labelRuns"), modelOverlay: data.has("modelOverlay"), mode: String(data.get("mode") || "raw"), xMin: optionalNumber(data.get("xMin")), xMax: optionalNumber(data.get("xMax")), yMin: optionalNumber(data.get("yMin")), yMax: optionalNumber(data.get("yMax")) }, true);
    dialog.close();
  });
}

function renderCustomGraph(workspace, config, activate = true) {
  if (activate) {
    const body = workspace.querySelector("[data-custom-graph-body]");
    const toggle = workspace.querySelector("[data-toggle-custom-graph]");
    if (body instanceof HTMLElement) body.hidden = false;
    if (toggle instanceof HTMLButtonElement) {
      toggle.textContent = "Hide graph";
      toggle.setAttribute("aria-expanded", "true");
    }
  }
  const host = workspace.querySelector("[data-custom-graph-chart]");
  const note = workspace.querySelector("[data-custom-graph-note]");
  if (!host || !analysisDataset) return;
  const xKey = String(config.xKey || ""); const yKey = String(config.yKey || ""); const groupKey = String(config.groupKey || ""); const sizeKey = String(config.sizeKey || ""); const labelRuns = config.labelRuns === true; const modelOverlay = config.modelOverlay === true; const mode = config.mode === "mean_ci" ? "mean_ci" : "raw";
  const xBounds = axisBounds(config.xMin, config.xMax); const yBounds = axisBounds(config.yMin, config.yMax);
  const rows = (analysisDataset.rows || []).filter((row) => !row.excluded && Number.isFinite(row.values?.[xKey]) && Number.isFinite(row.values?.[yKey]));
  const groups = new Map();
  for (const row of rows) { const name = groupKey ? String(row.values?.[groupKey] ?? "Unspecified") : "Measurements"; groups.set(name, [...(groups.get(name) || []), row]); }
  const sizes = sizeKey ? rows.map((row) => row.values?.[sizeKey]).filter(Number.isFinite) : [];
  const minSize = sizes.length ? Math.min(...sizes) : 0; const maxSize = sizes.length ? Math.max(...sizes) : 0;
  const symbolSize = (row) => !sizeKey || !(maxSize > minSize) ? 9 : 7 + 13 * (row.values[sizeKey] - minSize) / (maxSize - minSize);
  const chart = chartFor(host);
  const xLabel = columnAxisLabel(xKey); const yLabel = columnAxisLabel(yKey);
  const option = { animationDuration: 250, aria: { enabled: true }, grid: { left: 58, right: 20, top: 42, bottom: 40, containLabel: true }, legend: { top: 0, type: "scroll" }, tooltip: { trigger: "item", formatter: (item) => mode === "raw" ? `${item.seriesName}<br>${xLabel}: ${formatNumber(item.value[0])}<br>${yLabel}: ${formatNumber(item.value[1])}<br>Run ${item.value[2]}` : `${item.seriesName}<br>${xLabel}: ${formatNumber(item.value[0])}<br>Mean: ${formatNumber(item.value[1])}<br>95% CI: ${formatNumber(item.value[2])} to ${formatNumber(item.value[3])}` }, xAxis: { type: "value", name: xLabel, nameLocation: "middle", nameGap: 28, axisLabel: numericAxisLabels(), ...axisRange(rows.map((row) => row.values[xKey])), ...xBounds }, yAxis: numericYAxis(yLabel, { ...axisRange(rows.map((row) => row.values[yKey])), ...yBounds }), series: [] };
  for (const [name, groupRows] of groups) {
    if (mode === "raw") option.series.push({ name, type: "scatter", data: groupRows.map((row) => ({ value: [row.values[xKey], row.values[yKey], row.runId], symbolSize: symbolSize(row), label: labelRuns ? { show: true, formatter: row.runCode, position: "top", fontSize: 10 } : undefined })), selectedMode: "single" });
    else {
      const byX = new Map(); for (const row of groupRows) byX.set(row.values[xKey], [...(byX.get(row.values[xKey]) || []), row.values[yKey]]);
      const points = [...byX.entries()].sort(([left], [right]) => left - right).map(([x, values]) => { const mean = values.reduce((sum, value) => sum + value, 0) / values.length; const sd = values.length > 1 ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)) : 0; const critical = values.length > 1 ? 2.0 : 0; return [x, mean, mean - critical * sd / Math.sqrt(values.length), mean + critical * sd / Math.sqrt(values.length)]; });
      option.series.push({ name, type: "line", data: points.map((point) => [point[0], point[1]]), showSymbol: true });
      option.series.push({ name: `${name} 95% CI`, type: "custom", silent: true, data: points, renderItem: (params, api) => { const low = api.coord([api.value(0), api.value(2)]); const high = api.coord([api.value(0), api.value(3)]); return { type: "line", shape: { x1: low[0], y1: low[1], x2: high[0], y2: high[1] }, style: api.style({ stroke: "#6c7c70", lineWidth: 1.5 }) }; } });
    }
  }
  const overlay = latestAnalyticsResult?.specification?.responseKey === yKey
    ? (latestAnalyticsResult.plots?.mainEffects || []).find((effect) => effect.factorKey === xKey)
    : null;
  if (modelOverlay && overlay?.points?.length) option.series.push({ name: "Current model prediction", type: "line", data: overlay.points.filter((point) => Number.isFinite(point.value) && Number.isFinite(point.predicted)).map((point) => [point.value, point.predicted]), showSymbol: false, lineStyle: { type: "dashed", width: 2, color: "#292929" }, z: 5 });
  chart.setOption(option, true); chart.off("click");
  if (mode === "raw") chart.on("click", (event) => { const runId = runIdFromChartEvent(event); if (runId !== null) selectRun(workspace, runId); });
  if (note) note.textContent = mode === "raw" ? `${rows.length} included measured run(s). Select a point to open its run.${sizeKey ? ` Point size represents ${columnAxisLabel(sizeKey)}.` : ""}${modelOverlay ? overlay?.points?.length ? " Dashed line is the current DOE model at its reference settings." : " Model overlay is unavailable because X/Y do not match the current model." : ""}` : "Mean lines use repeated measurements at each X setting; intervals are 95% t-interval approximations.";
  if (activate) workspace.dataset.currentCustomGraph = JSON.stringify({ xKey, yKey, groupKey, sizeKey, labelRuns, modelOverlay, mode, xMin: xBounds.min, xMax: xBounds.max, yMin: yBounds.min, yMax: yBounds.max });
}

function columnAxisLabel(key) { const label = displayColumn(key, key); const unit = analysisColumnUnits[key]; return unit ? `${label} (${unit})` : label; }
function optionalNumber(value) { const raw = String(value ?? "").trim(); const number = Number(raw); return raw && Number.isFinite(number) ? number : undefined; }
function axisBounds(min, max) { const bounds = {}; if (Number.isFinite(min)) bounds.min = min; if (Number.isFinite(max)) bounds.max = max; return bounds; }

function bindModelTermControls(form, archivedAnalysis) {
  if (!form) return;
  const familyControl = form.elements.namedItem("modelFamily");
  if (!(familyControl instanceof HTMLSelectElement)) return;
  const factorControls = [...form.querySelectorAll('input[name="factorKeys"]')];
  const termControls = [...form.querySelectorAll('input[name="modelTerms"]')];
  const feedback = form.querySelector("[data-model-term-feedback]");
  if (!termControls.length) return;

  const mainTerm = (factorKey) => `main:${factorKey}`;
  const selectedFactorKeys = () => new Set(
    factorControls.filter((control) => control.checked).map((control) => control.value)
  );
  const getParts = (control) => {
    const term = control.value;
    if (term.startsWith("interaction:")) return term.slice("interaction:".length).split("|");
    if (term.startsWith("quadratic:")) return [term.slice("quadratic:".length)];
    if (term.startsWith("main:")) return [term.slice("main:".length)];
    return [];
  };
  const sync = () => {
    const selectedFactors = selectedFactorKeys();
    for (const control of termControls) {
      const label = control.closest("[data-model-term-label]");
      const families = (control.dataset.modelFamilies || "").split(" ").filter(Boolean);
      const factorKeys = (control.dataset.modelFactorKeys || "").split("|").filter(Boolean);
      const supportsFamily = families.includes(familyControl.value);
      const supportsFactors = factorKeys.every((factorKey) => selectedFactors.has(factorKey));
      if (label) label.hidden = !supportsFamily;
      if (!supportsFamily || !supportsFactors) control.checked = false;
      control.disabled = archivedAnalysis || !supportsFamily || !supportsFactors;
    }
    if (feedback) {
      const termCount = termControls.filter((control) => control.checked).length;
      feedback.textContent = termCount
        ? `${termCount} model term${termCount === 1 ? "" : "s"} selected. At least ${termCount + 2} complete measured runs are required to fit it with residual error.`
        : "Select at least one model term.";
    }
  };
  const enforceHierarchy = (source) => {
    const parts = getParts(source);
    if (source.checked && (source.value.startsWith("interaction:") || source.value.startsWith("quadratic:"))) {
      for (const factorKey of parts) {
        const main = termControls.find((control) => control.value === mainTerm(factorKey));
        if (main) main.checked = true;
      }
    }
    if (!source.checked && source.value.startsWith("main:")) {
      const factorKey = parts[0];
      for (const control of termControls) {
        if (control === source) continue;
        if (getParts(control).includes(factorKey)) control.checked = false;
      }
    }
    sync();
  };

  for (const control of termControls) {
    control.addEventListener("change", () => enforceHierarchy(control));
  }
  familyControl.addEventListener("change", sync);
  for (const control of factorControls) control.addEventListener("change", sync);
  sync();
}

function renderResult(workspace, result, scroll = true) {
  const panel = workspace.querySelector("[data-results-panel]");
  const empty = workspace.querySelector("[data-results-empty]");
  const content = workspace.querySelector("[data-results-content]");
  const meta = workspace.querySelector("[data-result-meta]");
  const metrics = workspace.querySelector("[data-result-metrics]");
  const warnings = workspace.querySelector("[data-result-warnings]");
  if (!panel) return;
  latestAnalyticsResult = result;
  analysisResponseLabel = responseLabelForSpecification(result.specification, "Response");
  const binaryModel = result.specification?.responseModel === "binary";
  const qualityNote = workspace.querySelector(".doe-analysis-quality-note");
  if (qualityNote) qualityNote.textContent = binaryModel
    ? "This is a binomial logistic model. Predictions are probabilities of a Yes response; pseudo R-squared and Brier score assess fit on the probability scale."
    : "R-squared describes the fitted runs. Adjusted R-squared penalizes unnecessary terms. Predicted R-squared estimates performance on a run left out of fitting and may be negative when prediction is poor.";
  const anovaNote = workspace.querySelector("[data-anova-note]");
  if (anovaNote) anovaNote.textContent = binaryModel
    ? "For a binary response, each row tests the loss of fit when that term is removed. Deviance and likelihood-ratio statistics replace sum-of-squares and F tests."
    : "Lack of fit compares model mismatch with repeat-to-repeat variation. A small p-value indicates that the selected model form may be inadequate. Pure error is variation between runs at identical factor settings.";
  const anovaSumHeading = workspace.querySelector("[data-anova-sum-heading]");
  const anovaStatHeading = workspace.querySelector("[data-anova-stat-heading]");
  const coefficientStatHeading = workspace.querySelector("[data-coefficient-stat-heading]");
  if (anovaSumHeading) anovaSumHeading.textContent = binaryModel ? "Deviance" : "SS";
  if (anovaStatHeading) anovaStatHeading.textContent = binaryModel ? "LR χ²" : "F";
  if (coefficientStatHeading) coefficientStatHeading.textContent = binaryModel ? "Signal / uncertainty (z)" : "Signal / uncertainty (t)";
  const coefficientsNote = workspace.querySelector("[data-coefficients-note]");
  if (coefficientsNote) coefficientsNote.textContent = binaryModel
    ? "Estimate is the fitted change in log-odds while the other selected terms are held in the model. Standard uncertainty measures its precision; z and p test whether that contribution is distinguishable from zero."
    : "Estimate is the fitted contribution of a term while the other selected terms are held in the model. Standard uncertainty measures its precision; t and p test whether that contribution is distinguishable from zero. The sign indicates direction.";
  analysisUsesCodedFactors = result.specification?.useCodedFactors === true;
  panel.hidden = false;
  if (empty) empty.hidden = true;
  if (content) content.hidden = false;
  if (meta) {
    const coordinateSystem = analysisUsesCodedFactors ? "coded factor coordinates" : "physical factor values";
    meta.textContent = `${analysisResponseLabel} · ${modelFamilyLabel(result.specification?.modelFamily)} · ${coordinateSystem} · ${result.summary.rowsUsed} rows used · dataset ${result.datasetRevision.slice(0, 12)}`;
  }
  if (metrics) {
    metrics.replaceChildren(...result.summary.metrics.map((metric) => {
      const item = document.createElement("div");
      const label = document.createElement("span");
      const value = document.createElement("strong");
      label.textContent = metric.label;
      value.textContent = formatNumber(metric.value);
      const description = metricDescription(metric.key);
      if (description) {
        item.title = description;
        item.setAttribute("aria-label", `${metric.label}: ${formatNumber(metric.value)}. ${description}`);
      }
      item.append(label, value);
      return item;
    }));
  }
  if (warnings) {
    const items = result.warnings || [];
    warnings.hidden = items.length === 0;
    warnings.replaceChildren(...items.map((warning) => {
      const line = document.createElement("div");
      line.textContent = warning.message;
      return line;
    }));
  }
  renderOptimizer(workspace, result.optimizer);
  renderModelOpportunities(workspace, result.recommendations);
  fillTable(
    workspace.querySelector("[data-anova-body]"),
    result.anova,
    ["term", "degreesOfFreedom", "sumOfSquares", "meanSquare", "statistic", "pValue"]
  );
  fillTable(
    workspace.querySelector("[data-coefficients-body]"),
    result.coefficients,
    ["term", "estimate", "standardError", "statistic", "pValue"]
  );
  fillTable(
    workspace.querySelector("[data-diagnostics-body]"),
    result.diagnostics,
    ["runId", "fitted", "residual", "standardizedResidual", "leverage", "cooksDistance"]
  );
  applyTermSelection(workspace);
  renderCharts(workspace, result);
  if (scroll) panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderOptimizer(workspace, optimizer) {
  const card = workspace.querySelector("[data-optimizer-result]");
  const summary = workspace.querySelector("[data-optimizer-summary]");
  const values = workspace.querySelector("[data-optimizer-values]");
  if (!card || !summary || !values) return;
  if (!optimizer || !Number.isFinite(optimizer.predicted)) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const goal = optimizer.objective === "target"
    ? `Target ${formatNumber(optimizer.target)}`
    : optimizer.objective === "maximize" ? "Maximum predicted response" : "Minimum predicted response";
  summary.textContent = `${goal}: ${formatNumber(optimizer.predicted)} ${analysisResponseLabel}. Evaluated ${formatNumber(optimizer.candidatesEvaluated)} settings within the selected bounds; confirm this recommendation with a new run.`;
  const settings = { ...(optimizer.factorValues || {}), ...(optimizer.blockValues || {}) };
  values.replaceChildren(...Object.entries(settings).map(([key, value]) => {
    const item = document.createElement("div");
    const label = document.createElement("span");
    const setting = document.createElement("strong");
    label.textContent = displayColumn(key, key);
    setting.textContent = formatNumber(value);
    item.append(label, setting);
    return item;
  }));
}

function renderModelOpportunities(workspace, recommendations) {
  const card = workspace.querySelector("[data-model-opportunities]");
  const values = workspace.querySelector("[data-model-opportunity-values]");
  if (!card || !values || !recommendations?.minimum || !recommendations?.maximum) { if (card) card.hidden = true; return; }
  card.hidden = false;
  values.replaceChildren(...[["Lower predicted response", recommendations.minimum], ["Higher predicted response", recommendations.maximum]].map(([label, item]) => {
    const line = document.createElement("div");
    const settings = Object.entries({ ...(item.factorValues || {}), ...(item.blockValues || {}) }).map(([key, value]) => `${displayColumn(key, key)} ${formatNumber(value)}`).join(" · ");
    const text = document.createElement("span");
    text.textContent = `${label}: ${formatNumber(item.predicted)} ${analysisResponseLabel} — ${settings}`;
    const button = document.createElement("button");
    button.className = "pure-button button-small";
    button.type = "button";
    button.textContent = "Create confirmation run";
    button.addEventListener("click", async () => {
      if (!window.confirm("Create a new confirmation run with these settings?")) return;
      const response = await fetch(workspace.dataset.confirmationRunUrl, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "x-csrf-token": document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") || "" }, body: JSON.stringify({ factorValues: item.factorValues }) });
      const body = await response.json();
      if (!response.ok) { window.alert(body.error || "Confirmation run could not be created."); return; }
      window.location.assign(`${workspace.dataset.runBaseUrl}/${body.run.id}`);
    });
    line.append(text, button);
    return line;
  }));
}

function renderCharts(workspace, result) {
  if (!window.echarts) return;
  const effectHost = workspace.querySelector("[data-effects-chart]");
  const residualHost = workspace.querySelector("[data-residual-chart]");
  const observedPredictedHost = workspace.querySelector("[data-observed-predicted-chart]");
  const observedPredictedCard = workspace.querySelector("[data-observed-predicted-card]");
  const effects = (result.coefficients || [])
    .filter((row) => row.term !== "(Intercept)" && typeof row.statistic === "number" && Number.isFinite(row.statistic))
    .map((row) => ({ rawTerm: row.term, term: displayTerm(row.term), value: Math.abs(row.statistic), signed: row.statistic }))
    .sort((left, right) => left.value - right.value);
  if (effectHost) {
    const chart = chartFor(effectHost);
    chart.setOption({
      animationDuration: 250,
      aria: { enabled: true },
      grid: { left: 58, right: 24, top: 12, bottom: 34, containLabel: true },
      tooltip: {
        trigger: "item",
        formatter: (item) => `${item.name}<br>Effect strength: ${formatNumber(item.value)}<br>Select to link the statistical rows.`
      },
      xAxis: { type: "value", name: "Effect strength", nameLocation: "middle", nameGap: 22, axisLabel: numericAxisLabels() },
      yAxis: { type: "category", name: "Model term", nameLocation: "middle", nameGap: 42, data: effects.map((effect) => effect.term), axisLabel: { width: 150, overflow: "truncate" } },
      series: [{
        type: "bar",
        data: effects.map((effect) => ({
          name: effect.term,
          value: effect.value,
          analysisTerm: effect.rawTerm,
          itemStyle: { color: effect.signed >= 0 ? "#52745a" : "#a76d55" }
        })),
        barMaxWidth: 22
      }]
    }, true);
    chart.off("click");
    chart.on("click", (event) => {
      const term = typeof event.data?.analysisTerm === "string" ? event.data.analysisTerm : null;
      if (term) selectTerm(workspace, term);
    });
  }
  if (residualHost) {
    const chart = chartFor(residualHost);
    const points = (result.diagnostics || [])
      .filter((row) => typeof row.fitted === "number" && typeof row.residual === "number")
      .map((row) => ({
        value: [row.fitted, row.residual, row.runId, row.standardizedResidual],
        runId: row.runId
      }));
    chart.setOption({
      animationDuration: 250,
      aria: { enabled: true },
      grid: { left: 58, right: 18, top: 12, bottom: 38, containLabel: true },
      tooltip: {
        trigger: "item",
        formatter: (item) => `Run ${item.value[2]}<br>Predicted: ${formatNumber(item.value[0])}<br>Error: ${formatNumber(item.value[1])}<br>Standardized error: ${formatNumber(item.value[3])}`
      },
      xAxis: { type: "value", name: responseAxisLabel("Predicted"), nameLocation: "middle", nameGap: 26, axisLabel: numericAxisLabels() },
      yAxis: numericYAxis(responseAxisLabel("Prediction error")),
      series: [{
        type: "scatter",
        data: points,
        selectedMode: "single",
        symbolSize: 9,
        itemStyle: { color: "#52745a" },
        select: { itemStyle: { color: "#f2ad3b", borderColor: "#262622", borderWidth: 2 } },
        markLine: { silent: true, symbol: "none", lineStyle: { type: "dashed", color: "#999" }, data: [{ yAxis: 0 }] }
      }]
    }, true);
    chart.off("click");
    chart.on("click", (event) => {
      const runId = runIdFromChartEvent(event);
      if (runId !== null) selectRun(workspace, runId);
    });
  }
  if (observedPredictedHost && observedPredictedCard) {
    const points = (result.diagnostics || [])
      .filter((row) => Number.isFinite(row.fitted) && Number.isFinite(row.residual))
      .map((row) => ({
        value: [row.fitted, row.fitted + row.residual, row.runId],
        runId: row.runId
      }));
    observedPredictedCard.hidden = points.length === 0;
    if (points.length) {
      const range = axisRange(points.flatMap((point) => [point.value[0], point.value[1]]));
      const chart = chartFor(observedPredictedHost);
      chart.setOption({
        animationDuration: 250,
        aria: { enabled: true },
        grid: { left: 58, right: 18, top: 12, bottom: 38, containLabel: true },
        tooltip: {
          trigger: "item",
          formatter: (item) => `Run ${item.value[2]}<br>Predicted: ${formatNumber(item.value[0])}<br>Observed: ${formatNumber(item.value[1])}`
        },
        xAxis: { type: "value", name: responseAxisLabel("Predicted"), nameLocation: "middle", nameGap: 26, axisLabel: numericAxisLabels(), ...range },
        yAxis: numericYAxis(responseAxisLabel("Observed"), range),
        series: [{
          type: "scatter",
          data: points,
          selectedMode: "single",
          symbolSize: 9,
          itemStyle: { color: "#52745a" },
          select: { itemStyle: { color: "#f2ad3b", borderColor: "#262622", borderWidth: 2 } },
          markLine: { silent: true, symbol: "none", lineStyle: { type: "dashed", color: "#999" }, data: [[{ coord: [range.min, range.min] }, { coord: [range.max, range.max] }]] }
        }]
      }, true);
      chart.off("click");
      chart.on("click", (event) => {
        const runId = runIdFromChartEvent(event);
        if (runId !== null) selectRun(workspace, runId);
      });
    }
  }
  renderModelPlotCharts(workspace, result.plots || {});
  setupChartExports(workspace, result);
  applyRunSelection(workspace);
}

function renderModelPlotCharts(workspace, plots) {
  renderMainEffects(workspace, plots.mainEffects || []);
  renderMeanByFactor(workspace, plots.meanByFactor || []);
  renderInteractions(workspace, plots.interactions || []);
  renderQq(workspace, plots.qq || []);
  renderRunOrder(workspace, plots.residualOrder || []);
  const surfaces = Array.isArray(plots.surfaces) && plots.surfaces.length
    ? plots.surfaces
    : plots.surface
      ? [plots.surface]
      : [];
  renderSurfaces(workspace, surfaces);
}

function renderMeanByFactor(workspace, factors) {
  const card = workspace.querySelector("[data-mean-factor-card]");
  const selector = workspace.querySelector("[data-mean-factor-select]");
  if (!card || !selector || !factors.length) {
    if (card) card.hidden = true;
    return;
  }
  card.hidden = false;
  const previous = selector.value;
  selector.replaceChildren(...factors.map((factor) => {
    const option = document.createElement("option");
    option.value = factor.factorKey;
    option.textContent = analysisColumnLabels[factor.factorKey] || factor.factorKey;
    return option;
  }));
  selector.hidden = factors.length < 2;
  selector.value = factors.some((factor) => factor.factorKey === previous) ? previous : factors[0].factorKey;
  const renderSelected = () => {
    const factor = factors.find((item) => item.factorKey === selector.value) || factors[0];
    renderFactorMeans(workspace, factor);
  };
  selector.onchange = renderSelected;
  renderSelected();
}

function renderFactorMeans(workspace, factor) {
  const host = workspace.querySelector("[data-mean-factor-chart]");
  const card = workspace.querySelector("[data-mean-factor-card]");
  if (!host || !card || !factor?.points?.length) {
    if (card) card.hidden = true;
    return;
  }
  const factorLabel = analysisColumnLabels[factor.factorKey] || factor.factorKey;
  const title = card.querySelector("[data-mean-factor-title]");
  if (title) title.textContent = `Mean response by ${factorLabel}`;
  const points = factor.points.filter((point) => Number.isFinite(point.value) && Number.isFinite(point.mean));
  const intervals = points.filter((point) => Number.isFinite(point.confidenceLow) && Number.isFinite(point.confidenceHigh));
  const responseRange = axisRange(points.flatMap((point) => [point.mean, point.confidenceLow, point.confidenceHigh]));
  chartFor(host).setOption({
    animationDuration: 250,
    aria: { enabled: true },
    grid: { left: 58, right: 18, top: 18, bottom: 42, containLabel: true },
    tooltip: {
      trigger: "item",
      formatter: (item) => {
        const point = item.data;
        if (!point || !Number.isFinite(point.mean)) return "Confidence interval";
        const interval = Number.isFinite(point.confidenceLow) && Number.isFinite(point.confidenceHigh)
          ? `<br>Confidence interval: ${formatNumber(point.confidenceLow)} to ${formatNumber(point.confidenceHigh)}`
          : "<br>Confidence interval: unavailable (one measurement)";
        return `${factorLabel}: ${formatNumber(point.factorValue)}<br>Mean response: ${formatNumber(point.mean)}${interval}<br>Measurements: ${point.n}`;
      }
    },
    xAxis: { type: "value", name: factorLabel, nameLocation: "middle", nameGap: 28, axisLabel: numericAxisLabels(), ...axisRange(points.map((point) => point.value)) },
    yAxis: numericYAxis(responseAxisLabel("Mean"), responseRange),
    series: [
      {
        name: "Confidence interval",
        type: "custom",
        silent: true,
        data: intervals.map((point) => [point.value, point.confidenceLow, point.confidenceHigh]),
        renderItem: (params, api) => {
          const low = api.coord([api.value(0), api.value(1)]);
          const high = api.coord([api.value(0), api.value(2)]);
          const cap = 5;
          return {
            type: "group",
            children: [
              { type: "line", shape: { x1: low[0], y1: low[1], x2: high[0], y2: high[1] }, style: { stroke: "#52745a", lineWidth: 1.5 } },
              { type: "line", shape: { x1: low[0] - cap, y1: low[1], x2: low[0] + cap, y2: low[1] }, style: { stroke: "#52745a", lineWidth: 1.5 } },
              { type: "line", shape: { x1: high[0] - cap, y1: high[1], x2: high[0] + cap, y2: high[1] }, style: { stroke: "#52745a", lineWidth: 1.5 } }
            ]
          };
        }
      },
      {
        name: "Observed mean",
        type: "line",
        symbolSize: 8,
        data: points.map((point) => ({
          factorValue: point.value,
          mean: point.mean,
          confidenceLow: point.confidenceLow,
          confidenceHigh: point.confidenceHigh,
          n: point.n,
          value: [point.value, point.mean]
        })),
        itemStyle: { color: "#52745a" },
        lineStyle: { color: "#52745a" }
      }
    ]
  }, true);
}

function renderMainEffects(workspace, effects) {
  const host = workspace.querySelector("[data-main-effects-chart]");
  const card = workspace.querySelector("[data-main-effects-card]");
  if (!host || !card || !effects.length) {
    if (card) card.hidden = true;
    return;
  }
  card.hidden = false;
  const predicted = effects.flatMap((effect) => (effect.points || []).map((point) => point.predicted));
  chartFor(host).setOption({
    animationDuration: 250,
    aria: { enabled: true },
    legend: { type: "scroll", top: 0 },
    grid: { left: 58, right: 18, top: 42, bottom: 38, containLabel: true },
    tooltip: { trigger: "axis" },
    xAxis: { type: "value", name: analysisUsesCodedFactors ? "Coded factor level" : "Factor value", nameLocation: "middle", nameGap: 26, axisLabel: numericAxisLabels() },
    yAxis: numericYAxis(responseAxisLabel("Predicted"), axisRange(predicted)),
    series: effects.map((effect) => ({
      name: analysisColumnLabels[effect.factorKey] || effect.factorKey,
      type: "line",
      symbolSize: 7,
      data: (effect.points || []).map((point) => [point.value, point.predicted])
    }))
  }, true);
}

function renderInteractions(workspace, interactions) {
  const card = workspace.querySelector("[data-interaction-card]");
  const selector = workspace.querySelector("[data-interaction-pair]");
  if (!card || !selector || !interactions.length) {
    if (card) card.hidden = true;
    return;
  }
  card.hidden = false;
  const selectedKey = populatePairSelector(selector, interactions);
  const renderSelected = () => {
    const interaction = interactions.find((item) => pairKey(item) === selector.value) || interactions[0];
    renderInteraction(workspace, interaction);
  };
  selector.value = selectedKey;
  selector.onchange = renderSelected;
  renderSelected();
}

function renderInteraction(workspace, interaction) {
  const host = workspace.querySelector("[data-interaction-chart]");
  const card = workspace.querySelector("[data-interaction-card]");
  if (!host || !card || !interaction?.series?.length) {
    if (card) card.hidden = true;
    return;
  }
  card.hidden = false;
  const xLabel = analysisColumnLabels[interaction.factorXKey] || interaction.factorXKey;
  const yLabel = analysisColumnLabels[interaction.factorYKey] || interaction.factorYKey;
  const title = card.querySelector("[data-interaction-title]");
  if (title) title.textContent = `${xLabel} × ${yLabel}`;
  const predicted = interaction.series.flatMap((series) => (series.points || []).map((point) => point.predicted));
  chartFor(host).setOption({
    animationDuration: 250,
    aria: { enabled: true },
    legend: { type: "scroll", top: 0 },
    grid: { left: 58, right: 18, top: 42, bottom: 38, containLabel: true },
    tooltip: { trigger: "axis" },
    xAxis: {
      type: "value",
      name: factorAxisLabel(interaction.factorXKey),
      nameLocation: "middle",
      nameGap: 26,
      axisLabel: numericAxisLabels(),
      ...axisRange(interaction.series.flatMap((series) => (series.points || []).map((point) => point.factorXValue)))
    },
    yAxis: numericYAxis(responseAxisLabel("Predicted"), axisRange(predicted)),
    series: interaction.series.map((series) => ({
      name: `${yLabel} = ${formatNumber(series.factorYValue)}`,
      type: "line",
      symbolSize: 7,
      data: (series.points || []).map((point) => [point.factorXValue, point.predicted])
    }))
  }, true);
}

function renderQq(workspace, points) {
  const host = workspace.querySelector("[data-qq-chart]");
  const card = workspace.querySelector("[data-qq-card]");
  const usable = points.filter((point) => Number.isFinite(point.theoretical) && Number.isFinite(point.standardizedResidual));
  if (!host || !card || usable.length < 3) {
    if (card) card.hidden = true;
    return;
  }
  card.hidden = false;
  const values = usable.flatMap((point) => [point.theoretical, point.standardizedResidual]);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const chart = chartFor(host);
  chart.setOption({
    animationDuration: 250,
    aria: { enabled: true },
    grid: { left: 58, right: 18, top: 14, bottom: 38, containLabel: true },
    tooltip: {
      trigger: "item",
      formatter: (item) => item.seriesType === "scatter"
        ? `Run ${item.value[2]}<br>Theoretical: ${formatNumber(item.value[0])}<br>Standardized error: ${formatNumber(item.value[1])}`
        : "Normal reference"
    },
    xAxis: { type: "value", name: "Theoretical normal quantile", nameLocation: "middle", nameGap: 26, axisLabel: numericAxisLabels() },
    yAxis: numericYAxis("Standardized error"),
    series: [
      { type: "line", data: [[low, low], [high, high]], symbol: "none", silent: true, lineStyle: { type: "dashed", color: "#999" } },
      {
        type: "scatter",
        data: usable.map((point) => ({
          value: [point.theoretical, point.standardizedResidual, point.runId],
          runId: point.runId
        })),
        selectedMode: "single",
        symbolSize: 8,
        itemStyle: { color: "#52745a" },
        select: { itemStyle: { color: "#f2ad3b", borderColor: "#262622", borderWidth: 2 } }
      }
    ]
  }, true);
  chart.off("click");
  chart.on("click", (event) => {
    if (event.seriesType !== "scatter") return;
    const runId = runIdFromChartEvent(event);
    if (runId !== null) selectRun(workspace, runId);
  });
}

function renderRunOrder(workspace, points) {
  const host = workspace.querySelector("[data-run-order-chart]");
  const card = workspace.querySelector("[data-run-order-card]");
  const usable = points.filter((point) => Number.isFinite(point.runOrder) && Number.isFinite(point.residual));
  if (!host || !card || !usable.length) {
    if (card) card.hidden = true;
    return;
  }
  card.hidden = false;
  const chart = chartFor(host);
  chart.setOption({
    animationDuration: 250,
    aria: { enabled: true },
    grid: { left: 58, right: 18, top: 14, bottom: 38, containLabel: true },
    tooltip: { trigger: "item", formatter: (item) => `Run ${item.value[2]}<br>Order: ${item.value[0]}<br>Error: ${formatNumber(item.value[1])}` },
    xAxis: { type: "value", name: "Run order", nameLocation: "middle", nameGap: 26, minInterval: 1, axisLabel: numericAxisLabels() },
    yAxis: numericYAxis(responseAxisLabel("Prediction error")),
    series: [{
      type: "line",
      data: usable.map((point) => ({
        value: [point.runOrder, point.residual, point.runId],
        runId: point.runId
      })),
      selectedMode: "single",
      symbolSize: 7,
      itemStyle: { color: "#52745a" },
      select: { itemStyle: { color: "#f2ad3b", borderColor: "#262622", borderWidth: 2 } },
      lineStyle: { color: "#8aa08e" },
      markLine: { silent: true, symbol: "none", lineStyle: { type: "dashed", color: "#999" }, data: [{ yAxis: 0 }] }
    }]
  }, true);
  chart.off("click");
  chart.on("click", (event) => {
    const runId = runIdFromChartEvent(event);
    if (runId !== null) selectRun(workspace, runId);
  });
}

function renderSurfaces(workspace, surfaces) {
  const card = workspace.querySelector("[data-surface-card]");
  const selector = workspace.querySelector("[data-surface-pair]");
  const viewSelector = workspace.querySelector("[data-surface-view]");
  if (!card || !selector || !viewSelector || !surfaces.length) {
    if (card) card.hidden = true;
    return;
  }
  card.hidden = false;
  const selectedKey = populatePairSelector(selector, surfaces);
  const renderSelected = () => {
    const surface = surfaces.find((item) => pairKey(item) === selector.value) || surfaces[0];
    renderSurface(workspace, surface, viewSelector.value);
  };
  selector.value = selectedKey;
  selector.onchange = renderSelected;
  viewSelector.onchange = renderSelected;
  renderSelected();
}

function renderSurface(workspace, surface, viewMode = "contour") {
  const host = workspace.querySelector("[data-surface-chart]");
  const card = workspace.querySelector("[data-surface-card]");
  const renderStatus = workspace.querySelector("[data-surface-render-status]");
  const usable = (surface?.points || []).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.predicted));
  if (!host || !card || !surface || !usable.length) {
    if (card) card.hidden = true;
    return;
  }
  card.hidden = false;
  const xLabel = displayColumn(surface.factorXKey, surface.factorXKey);
  const yLabel = displayColumn(surface.factorYKey, surface.factorYKey);
  const title = card.querySelector("[data-surface-title]");
  if (title) title.textContent = `Predicted ${analysisResponseLabel}: ${xLabel} × ${yLabel}`;
  const held = card.querySelector("[data-surface-held]");
  const heldEntries = Object.entries(surface.heldValues || {});
  if (held) {
    held.textContent = heldEntries.length
      ? `Held constant: ${heldEntries.map(([key, value]) => `${displayColumn(key, key)} = ${formatNumber(value)}`).join(", ")}.`
      : "No other factors are held constant.";
  }
  const predicted = usable.map((point) => point.predicted);
  const actual = (surface.actualPoints || [])
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  const xRange = axisRange(usable.map((point) => point.x));
  const yRange = axisRange(usable.map((point) => point.y));
  // Actual measurements may sit above or below the fitted surface, so they also
  // define the visible height of the 3D plot.
  const zRange = axisRange([...predicted, ...actual.map((point) => point.response)]);
  let use3d = viewMode === "3d";
  if (renderStatus) {
    renderStatus.textContent = use3d ? "Rendering 3D surface…" : "";
    renderStatus.hidden = !use3d;
  }
  host.classList.toggle("is-3d", use3d);
  host.dataset.chart3d = use3d ? "true" : "false";
  updateChartExportAvailability(host);
  const chartMode = use3d ? "3d" : "2d";
  let chart = window.echarts.getInstanceByDom(host);
  if (chart && host.dataset.chartMode && host.dataset.chartMode !== chartMode) {
    chart.clear();
  }
  host.dataset.chartMode = chartMode;
  chart = chart || chartFor(host);
  chart.resize();
  const common = {
    animationDuration: 250,
    aria: { enabled: true },
    visualMap: { min: Math.min(...predicted), max: Math.max(...predicted), precision: 3, calculable: true, orient: "vertical", right: 0, top: "middle", seriesIndex: 0 }
  };
  const contourOption = {
    ...common,
    grid: { left: 58, right: 90, top: 16, bottom: 42, containLabel: true },
    tooltip: {
      formatter: (item) => item.seriesName === "Measured runs"
        ? `Run ${item.value[4]}<br>${xLabel}: ${formatNumber(item.value[0])}<br>${yLabel}: ${formatNumber(item.value[1])}<br>${responseAxisLabel("Measured")}: ${formatNumber(item.value[2])}<br>${responseAxisLabel("Predicted")}: ${formatNumber(item.value[3])}`
        : `${xLabel}: ${formatNumber(item.value[0])}<br>${yLabel}: ${formatNumber(item.value[1])}<br>${responseAxisLabel("Predicted")}: ${formatNumber(item.value[2])}`
    },
    xAxis: { type: "value", name: factorAxisLabel(surface.factorXKey), nameLocation: "middle", nameGap: 28, axisLabel: numericAxisLabels(), ...xRange },
    yAxis: numericYAxis(factorAxisLabel(surface.factorYKey), yRange),
    series: [
      { name: "Predicted surface", type: "heatmap", data: usable.map((point) => [point.x, point.y, point.predicted]), progressive: 1000 },
      {
        name: "Measured runs",
        type: "scatter",
        data: actual.map((point) => ({
          value: [point.x, point.y, point.response, point.predicted, point.runId],
          runId: point.runId
        })),
        selectedMode: "single",
        symbolSize: 10,
        itemStyle: { color: "#fff", borderColor: "#262622", borderWidth: 2 },
        select: { itemStyle: { color: "#f2ad3b", borderColor: "#262622", borderWidth: 3 } }
      }
    ]
  };
  const surfaceOption = {
    ...common,
    tooltip: {
      formatter: (item) => item.seriesName === "Measured runs"
        ? `Run ${item.value[4]}<br>${xLabel}: ${formatNumber(item.value[0])}<br>${yLabel}: ${formatNumber(item.value[1])}<br>${responseAxisLabel("Measured")}: ${formatNumber(item.value[2])}<br>${responseAxisLabel("Predicted")}: ${formatNumber(item.value[3])}`
        : `${xLabel}: ${formatNumber(item.value[0])}<br>${yLabel}: ${formatNumber(item.value[1])}<br>${responseAxisLabel("Predicted")}: ${formatNumber(item.value[2])}`
    },
    xAxis3D: { type: "value", name: factorAxisLabel(surface.factorXKey), axisLabel: numericAxisLabels(), ...xRange },
    yAxis3D: { type: "value", name: factorAxisLabel(surface.factorYKey), axisLabel: numericAxisLabels(), ...yRange },
    zAxis3D: { type: "value", name: responseAxisLabel("Predicted"), axisLabel: numericAxisLabels(), ...zRange },
    grid3D: {
      boxWidth: 110,
      boxDepth: 90,
      viewControl: { projection: "perspective", autoRotate: false },
      light: { main: { intensity: 1.1, shadow: true }, ambient: { intensity: 0.45 } }
    },
    series: [
      {
        name: "Predicted surface",
        type: "surface",
        shading: "lambert",
        wireframe: { show: false },
        data: usable.map((point) => [point.x, point.y, point.predicted])
      },
      {
        name: "Measured runs",
        type: "scatter3D",
        data: actual.map((point) => ({
          value: [point.x, point.y, point.response, point.predicted, point.runId],
          runId: point.runId
        })),
        selectedMode: "single",
        symbolSize: 9,
        itemStyle: { color: "#fff", borderColor: "#262622", borderWidth: 1 },
        select: { itemStyle: { color: "#f2ad3b", borderColor: "#262622", borderWidth: 2 } }
      }
    ]
  };
  try {
    if (use3d) {
      withSafeEchartsGlExpressions(() => chart.setOption(surfaceOption, true));
    } else {
      chart.setOption(contourOption, true);
    }
    if (use3d) {
      const renderedTypes = (chart.getOption().series || []).map((series) => series.type);
      if (!renderedTypes.includes("surface")) {
        throw new Error("the ECharts GL surface component was not registered");
      }
    }
    if (renderStatus) renderStatus.hidden = true;
  } catch (error) {
    if (!use3d) throw error;
    chart.clear();
    host.classList.remove("is-3d");
    host.dataset.chart3d = "false";
    host.dataset.chartMode = "2d";
    const viewSelector = workspace.querySelector("[data-surface-view]");
    if (viewSelector) viewSelector.value = "contour";
    chart.resize();
    chart.setOption(contourOption, true);
    if (renderStatus) {
      renderStatus.textContent = `3D rendering failed: ${error instanceof Error ? error.message : "unknown graphics error"}. The contour view is shown instead.`;
      renderStatus.hidden = false;
    }
  }
  chart.off("click");
  chart.on("click", (event) => {
    if (event.seriesName !== "Measured runs") return;
    const runId = runIdFromChartEvent(event);
    if (runId !== null) selectRun(workspace, runId);
  });
  applyRunSelection(workspace);
}

function bindRunSelection(workspace) {
  workspace.querySelectorAll("[data-run-row]").forEach((row) => {
    row.addEventListener("click", () => selectRun(workspace, Number(row.dataset.runId)));
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      selectRun(workspace, Number(row.dataset.runId));
    });
  });
  workspace.querySelector("[data-show-selected-run]")?.addEventListener("click", () => {
    if (selectedAnalysisRunId === null) return;
    const row = workspace.querySelector(`[data-run-row][data-run-id="${selectedAnalysisRunId}"]`);
    row?.scrollIntoView({ behavior: "smooth", block: "center" });
    row?.focus({ preventScroll: true });
  });
  workspace.querySelector("[data-clear-selected-run]")?.addEventListener("click", () => {
    selectRun(workspace, null);
  });
}

function selectRun(workspace, runId) {
  selectedAnalysisRunId = Number.isFinite(runId) ? Number(runId) : null;
  let selectedRow = null;
  workspace.querySelectorAll("[data-run-row]").forEach((row) => {
    const selected = Number(row.dataset.runId) === selectedAnalysisRunId;
    row.classList.toggle("is-selected", selected);
    row.setAttribute("aria-selected", selected ? "true" : "false");
    if (selected) selectedRow = row;
  });
  const selection = workspace.querySelector("[data-run-selection]");
  if (selection) {
    selection.hidden = selectedAnalysisRunId === null;
    const label = selection.querySelector("[data-selected-run-label]");
    const open = selection.querySelector("[data-open-selected-run]");
    const runCode = selectedRow?.dataset.runCode || `#${selectedAnalysisRunId}`;
    if (label) label.textContent = `${runCode} · run ${selectedAnalysisRunId}`;
    if (open && selectedAnalysisRunId !== null) {
      open.href = `${workspace.dataset.runBaseUrl}/${selectedAnalysisRunId}`;
    }
  }
  applyRunSelection(workspace);
}

function applyRunSelection(workspace) {
  if (!window.echarts) return;
  workspace.querySelectorAll(".doe-analysis-chart").forEach((host) => {
    const chart = window.echarts.getInstanceByDom(host);
    if (!chart) return;
    const series = chart.getOption()?.series || [];
    series.forEach((item, seriesIndex) => {
      (item.data || []).forEach((point, dataIndex) => {
        if (!point || typeof point !== "object" || !("runId" in point)) return;
        chart.dispatchAction({
          type: Number(point.runId) === selectedAnalysisRunId ? "select" : "unselect",
          seriesIndex,
          dataIndex
        });
      });
    });
  });
}

function runIdFromChartEvent(event) {
  const runId = Number(event.data?.runId);
  return Number.isFinite(runId) ? runId : null;
}

function pairKey(item) {
  return `${item.factorXKey}|${item.factorYKey}`;
}

function populatePairSelector(selector, items) {
  const previous = selector.value;
  selector.replaceChildren(...items.map((item) => {
    const option = document.createElement("option");
    option.value = pairKey(item);
    option.textContent = `${analysisColumnLabels[item.factorXKey] || item.factorXKey} × ${analysisColumnLabels[item.factorYKey] || item.factorYKey}`;
    return option;
  }));
  selector.hidden = items.length < 2;
  return items.some((item) => pairKey(item) === previous) ? previous : pairKey(items[0]);
}

function setupChartExports(workspace, result) {
  const responseLabel = responseLabelForSpecification(result.specification, "response");
  workspace.querySelectorAll(".doe-analysis-chart-card").forEach((card) => {
    const host = card.querySelector(".doe-analysis-chart");
    if (!host) return;
    let actions = card.querySelector("[data-chart-export-actions]");
    if (!actions) {
      actions = document.createElement("div");
      actions.className = "doe-analysis-chart-actions";
      actions.dataset.chartExportActions = "";
      for (const format of ["png", "svg"]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "pure-button button-small";
        button.textContent = format.toUpperCase();
        button.dataset.chartExport = format;
        button.setAttribute("aria-label", `Download chart as ${format.toUpperCase()}`);
        actions.append(button);
      }
      card.append(actions);
    }
    actions.querySelectorAll("[data-chart-export]").forEach((button) => {
      button.onclick = () => {
        const title = card.querySelector("h3")?.textContent || "chart";
        exportChart(host, `${responseLabel}-${title}`, button.dataset.chartExport || "png");
      };
    });
    updateChartExportAvailability(host);
  });
}

function updateChartExportAvailability(host) {
  const svgButton = host.closest(".doe-analysis-chart-card")?.querySelector('[data-chart-export="svg"]');
  if (!svgButton) return;
  const is3d = host.dataset.chart3d === "true";
  svgButton.disabled = is3d;
  svgButton.title = is3d ? "SVG export is unavailable for WebGL 3D charts; use PNG." : "";
}

function withSafeEchartsGlExpressions(callback) {
  const nativeFunction = window.Function;
  function SafeTextureFunction(...args) {
    const isTextureExpression = args.length === 4
      && args[0] === "width"
      && args[1] === "height"
      && args[2] === "dpr"
      && typeof args[3] === "string"
      && /^return\s+/.test(args[3]);
    if (!isTextureExpression) {
      return Reflect.construct(nativeFunction, args);
    }
    const expression = args[3].replace(/^return\s+/, "").replace(/;\s*$/, "").trim();
    return (width, height, dpr = 1) => evaluateTextureExpression(expression, { width, height, dpr });
  }
  Object.setPrototypeOf(SafeTextureFunction, nativeFunction);
  SafeTextureFunction.prototype = nativeFunction.prototype;
  window.Function = SafeTextureFunction;
  try {
    return callback();
  } finally {
    window.Function = nativeFunction;
  }
}

function evaluateTextureExpression(expression, variables) {
  let source = expression.replace(/\s+/g, "");
  while (source.startsWith("(") && source.endsWith(")")) {
    source = source.slice(1, -1);
  }
  if (source.startsWith("[") && source.endsWith("]")) {
    const values = source.slice(1, -1).split(",");
    if (!values.length || values.length > 2) throw new Error("Unsupported ECharts GL texture expression.");
    return values.map((value) => evaluateTextureScalar(value, variables));
  }
  return evaluateTextureScalar(source, variables);
}

function evaluateTextureScalar(expression, variables) {
  const tokens = expression.match(/width|height|dpr|\d+(?:\.\d+)?|[*/]/g) || [];
  if (tokens.join("") !== expression || tokens.length % 2 === 0) {
    throw new Error("Unsupported ECharts GL texture expression.");
  }
  const operand = (token) => Object.hasOwn(variables, token) ? Number(variables[token]) : Number(token);
  let value = operand(tokens[0]);
  if (!Number.isFinite(value)) throw new Error("Invalid ECharts GL texture operand.");
  for (let index = 1; index < tokens.length; index += 2) {
    const next = operand(tokens[index + 1]);
    if (!Number.isFinite(next) || (tokens[index] === "/" && next === 0)) {
      throw new Error("Invalid ECharts GL texture operand.");
    }
    value = tokens[index] === "*" ? value * next : value / next;
  }
  return value;
}

function exportChart(host, fileName, format) {
  const chart = window.echarts?.getInstanceByDom(host);
  if (!chart) return;
  let dataUrl;
  if (format === "svg") {
    const exportHost = document.createElement("div");
    exportHost.style.cssText = `position:fixed;left:-10000px;top:0;width:${Math.max(host.clientWidth, 640)}px;height:${Math.max(host.clientHeight, 300)}px`;
    document.body.append(exportHost);
    const exportChart = window.echarts.init(exportHost, null, { renderer: "svg" });
    exportChart.setOption(chart.getOption(), true);
    dataUrl = exportChart.getDataURL({ type: "svg", backgroundColor: "#fff", excludeComponents: ["toolbox"] });
    exportChart.dispose();
    exportHost.remove();
  } else {
    dataUrl = chart.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: "#fff", excludeComponents: ["toolbox"] });
  }
  const link = document.createElement("a");
  link.download = `${safeFileName(fileName)}.${format}`;
  link.href = dataUrl;
  link.click();
}

function safeFileName(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, "-")
    .replace(/^-+|-+$/g, "") || "doe-chart";
}

function chartFor(element) {
  return window.echarts.getInstanceByDom(element) || window.echarts.init(element);
}

function bindTableCopy(workspace) {
  workspace.querySelectorAll("[data-copy-table]").forEach((button) => {
    button.addEventListener("click", async () => {
      const table = workspace.querySelector(button.dataset.copyTable || "");
      if (!table) return;
      const icon = button.querySelector(".material-symbols-rounded");
      const label = button.dataset.copyLabel || button.textContent.trim() || "Copy TSV";
      const originalAria = button.dataset.copyAria ?? button.getAttribute("aria-label") ?? "";
      button.dataset.copyLabel = label;
      button.dataset.copyAria = originalAria;
      try {
        await copyTextAsTsv(tableToTsv(table));
        if (button.dataset.copyIcon && icon) icon.textContent = "check";
        else button.textContent = "Copied";
        button.setAttribute("aria-label", "Table copied as TSV");
      } catch {
        if (button.dataset.copyIcon && icon) icon.textContent = "error";
        else button.textContent = "Copy failed";
        button.setAttribute("aria-label", "Table could not be copied");
      }
      window.setTimeout(() => {
        if (button.dataset.copyIcon && icon) icon.textContent = "content_copy";
        else button.textContent = label;
        if (originalAria) button.setAttribute("aria-label", originalAria);
        else button.removeAttribute("aria-label");
      }, 1800);
    });
  });
}

function tableToTsv(table) {
  return [...table.querySelectorAll("tr")]
    .map((row) => [...row.querySelectorAll("th, td")]
      .map((cell) => tsvCell((cell.innerText || cell.textContent || "").replace(/\s+/g, " ").trim()))
      .join("\t"))
    .filter(Boolean)
    .join("\n");
}

function tsvCell(value) {
  return /[\t\n\r\"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

async function copyTextAsTsv(text) {
  if (!text) throw new Error("The table is empty.");
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const fallback = document.createElement("textarea");
  fallback.value = text;
  fallback.setAttribute("readonly", "");
  fallback.style.cssText = "position:fixed;left:-10000px;top:0";
  document.body.append(fallback);
  fallback.select();
  const copied = document.execCommand("copy");
  fallback.remove();
  if (!copied) throw new Error("Clipboard access was denied.");
}

function axisRange(values, padding = 0.04) {
  const numbers = values.filter((value) => Number.isFinite(value));
  if (!numbers.length) return { scale: true };
  const low = Math.min(...numbers);
  const high = Math.max(...numbers);
  const span = high - low;
  // A small margin avoids points touching the frame, without anchoring a
  // response plot at zero. A flat prediction still receives a visible range.
  const margin = span > 0
    ? span * padding
    : Math.max(Math.abs(low) * padding, 1);
  return { min: low - margin, max: high + margin, scale: true };
}

function numericAxisLabels() {
  return { formatter: (value) => formatNumber(Number(value)) };
}

function showEmptyResult(workspace, title, message) {
  const empty = workspace.querySelector("[data-results-empty]");
  const content = workspace.querySelector("[data-results-content]");
  if (!empty) return;
  empty.hidden = false;
  if (content) content.hidden = true;
  const heading = empty.querySelector("strong");
  const detail = empty.querySelector("span:last-child");
  if (heading) heading.textContent = title;
  if (detail) detail.textContent = message;
}

function fillTable(body, rows, keys) {
  if (!body) return;
  const source = Array.isArray(rows) ? rows : [];
  if (!source.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = keys.length;
    cell.textContent = "No statistical rows returned.";
    row.append(cell);
    body.replaceChildren(row);
    return;
  }
  body.replaceChildren(...source.map((sourceRow) => {
    const row = document.createElement("tr");
    if (typeof sourceRow.term === "string") {
      row.dataset.analysisTerm = sourceRow.term;
      row.classList.add("doe-analysis-term-row");
    }
    for (const key of keys) {
      const cell = document.createElement("td");
      cell.textContent = key === "term"
        ? displayTerm(sourceRow[key])
        : key === "runId"
          ? String(sourceRow[key] ?? "—")
        : formatNumber(sourceRow[key]);
      row.append(cell);
    }
    return row;
  }));
}

function bindTermSelection(workspace) {
  workspace.querySelector("[data-clear-selected-term]")?.addEventListener("click", () => selectTerm(workspace, null));
}

function selectTerm(workspace, term) {
  selectedAnalysisTerm = term;
  applyTermSelection(workspace);
}

function applyTermSelection(workspace) {
  const selection = workspace.querySelector("[data-term-selection]");
  const label = workspace.querySelector("[data-selected-term-label]");
  const selectedLabel = selectedAnalysisTerm ? displayTerm(selectedAnalysisTerm) : "";
  workspace.querySelectorAll("[data-analysis-term]").forEach((row) => {
    row.classList.toggle("is-selected-term", Boolean(selectedAnalysisTerm) && row.dataset.analysisTerm === selectedAnalysisTerm);
  });
  if (selection) selection.hidden = !selectedAnalysisTerm;
  if (label && selectedAnalysisTerm) {
    label.textContent = `${selectedLabel} selected. Matching ANOVA and coefficient rows are highlighted below.`;
  }
}

function displayColumn(key, fallback) {
  const label = analysisColumnLabels[key] || fallback;
  const unit = analysisColumnUnits[key];
  return unit ? `${label} (${unit})` : label;
}

function responseAxisLabel(prefix) {
  return `${prefix} ${analysisResponseLabel}`;
}

function numericYAxis(name, range = {}) {
  return {
    type: "value",
    name,
    nameLocation: "middle",
    nameGap: 44,
    axisLabel: numericAxisLabels(),
    ...range
  };
}

function factorAxisLabel(key) {
  const label = displayColumn(key, key);
  return analysisUsesCodedFactors ? `${label} (coded)` : label;
}

function modelFamilyLabel(value) {
  return {
    factorial: "factorial model",
    response_surface: "response-surface model",
    regression: "regression model"
  }[value] || "model";
}

function displayTerm(value) {
  const term = String(value ?? "—");
  if (term === "(Intercept)") return "Intercept";
  if (term.startsWith("Block: ")) {
    return term.replaceAll(/(?:recipe|block):[^ =]+/g, (key) => analysisColumnLabels[key] || key);
  }
  const keys = term.match(/factor:\d+/g) || [];
  const labels = keys.map((key) => analysisColumnLabels[key] || key);
  if (labels.length > 1) return labels.join(" × ");
  if (labels.length === 1 && /^I\(.+\^2\)$/.test(term)) return `${labels[0]}²`;
  if (labels.length === 1) return labels[0];
  return term;
}

function formatNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value !== 0 && (Math.abs(value) < 0.001 || Math.abs(value) >= 10000)) {
    const [mantissa, exponent] = value.toExponential(3).split("e");
    return `${mantissa} · 10${superscriptExponent(Number(exponent))}`;
  }
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(value);
}

function superscriptExponent(value) {
  const glyphs = { "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };
  return String(value).split("").map((character) => glyphs[character] || character).join("");
}

function metricDescription(key) {
  return {
    r_squared: "Share of variation described for the runs used to fit the model.",
    adjusted_r_squared: "R-squared adjusted for the number of model terms.",
    predicted_r_squared: "Leave-one-out estimate of predictive performance on new runs.",
    model_p_value: "Evidence that the fitted model explains response variation beyond a constant mean.",
    rmse: "Typical prediction error in response units for the fitted runs.",
    residual_degrees_of_freedom: "Independent information remaining for estimating model error."
  }[key] || "";
}
