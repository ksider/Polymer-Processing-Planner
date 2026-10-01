let analysisColumnLabels = {};
let selectedAnalysisRunId = null;

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

  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") || "";
  const engineStatus = workspace.querySelector("[data-engine-status]");
  const form = workspace.querySelector("[data-analysis-form]");
  const status = workspace.querySelector("[data-calculation-status]");
  const button = workspace.querySelector("[data-calculate-button]");
  const saveButton = workspace.querySelector("[data-save-analysis]");
  const analysisName = workspace.querySelector("[name=analysisName]");
  const analysisSwitcher = workspace.querySelector("[data-analysis-nav-select]");
  const savedAnalysisId = Number(workspace.dataset.analysisId) || null;
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
  bindTableCopy(workspace);

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
      if (button) button.disabled = false;
      if (saveButton) saveButton.disabled = false;
      if (savedAnalysisId) {
        if (status) status.textContent = workspace.dataset.analysisState === "stale"
          ? "Source data changed. Recalculate to create a new revision."
          : "Saved analysis loaded. Change settings or recalculate when needed.";
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
    const specification = readSpecification(form);
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
      if (button) button.disabled = false;
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

function readSpecification(form) {
  const data = new FormData(form);
  return {
    responseKey: String(data.get("responseKey") || ""),
    factorKeys: data.getAll("factorKeys").map(String),
    modelFamily: String(data.get("modelFamily") || "regression"),
    useCodedFactors: data.has("useCodedFactors"),
    includeIncomplete: data.has("includeIncomplete"),
    includeExcluded: data.has("includeExcluded"),
    confidenceLevel: Number(data.get("confidenceLevel") || 0.95)
  };
}

function renderResult(workspace, result, scroll = true) {
  const panel = workspace.querySelector("[data-results-panel]");
  const empty = workspace.querySelector("[data-results-empty]");
  const content = workspace.querySelector("[data-results-content]");
  const meta = workspace.querySelector("[data-result-meta]");
  const metrics = workspace.querySelector("[data-result-metrics]");
  const warnings = workspace.querySelector("[data-result-warnings]");
  if (!panel) return;
  panel.hidden = false;
  if (empty) empty.hidden = true;
  if (content) content.hidden = false;
  if (meta) {
    meta.textContent = `${result.summary.rowsUsed} rows used · dataset ${result.datasetRevision.slice(0, 12)} · request ${result.requestId}`;
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
  renderCharts(workspace, result);
  if (scroll) panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderCharts(workspace, result) {
  if (!window.echarts) return;
  const effectHost = workspace.querySelector("[data-effects-chart]");
  const residualHost = workspace.querySelector("[data-residual-chart]");
  const effects = (result.coefficients || [])
    .filter((row) => row.term !== "(Intercept)" && typeof row.statistic === "number" && Number.isFinite(row.statistic))
    .map((row) => ({ term: displayTerm(row.term), value: Math.abs(row.statistic), signed: row.statistic }))
    .sort((left, right) => left.value - right.value);
  if (effectHost) {
    const chart = chartFor(effectHost);
    chart.setOption({
      animationDuration: 250,
      aria: { enabled: true },
      grid: { left: 12, right: 24, top: 12, bottom: 28, containLabel: true },
      tooltip: {
        trigger: "item",
        formatter: (item) => `${item.name}<br>Effect strength: ${formatNumber(item.value)}`
      },
      xAxis: { type: "value", name: "Effect strength", nameLocation: "middle", nameGap: 22, axisLabel: numericAxisLabels() },
      yAxis: { type: "category", data: effects.map((effect) => effect.term), axisLabel: { width: 150, overflow: "truncate" } },
      series: [{
        type: "bar",
        data: effects.map((effect) => ({
          name: effect.term,
          value: effect.value,
          itemStyle: { color: effect.signed >= 0 ? "#52745a" : "#a76d55" }
        })),
        barMaxWidth: 22
      }]
    }, true);
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
      grid: { left: 12, right: 18, top: 12, bottom: 38, containLabel: true },
      tooltip: {
        trigger: "item",
        formatter: (item) => `Run ${item.value[2]}<br>Predicted: ${formatNumber(item.value[0])}<br>Error: ${formatNumber(item.value[1])}<br>Standardized error: ${formatNumber(item.value[3])}`
      },
      xAxis: { type: "value", name: "Predicted response", nameLocation: "middle", nameGap: 26, axisLabel: numericAxisLabels() },
      yAxis: { type: "value", name: "Prediction error", axisLabel: numericAxisLabels() },
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
    grid: { left: 14, right: 18, top: 18, bottom: 42, containLabel: true },
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
    yAxis: { type: "value", name: "Mean response", axisLabel: numericAxisLabels(), ...responseRange },
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
    grid: { left: 14, right: 18, top: 42, bottom: 38, containLabel: true },
    tooltip: { trigger: "axis" },
    xAxis: { type: "value", name: "Coded factor level", nameLocation: "middle", nameGap: 26, axisLabel: numericAxisLabels() },
    yAxis: { type: "value", name: "Predicted response", axisLabel: numericAxisLabels(), ...axisRange(predicted) },
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
    grid: { left: 14, right: 18, top: 42, bottom: 38, containLabel: true },
    tooltip: { trigger: "axis" },
    xAxis: {
      type: "value",
      name: xLabel,
      nameLocation: "middle",
      nameGap: 26,
      axisLabel: numericAxisLabels(),
      ...axisRange(interaction.series.flatMap((series) => (series.points || []).map((point) => point.factorXValue)))
    },
    yAxis: { type: "value", name: "Predicted response", axisLabel: numericAxisLabels(), ...axisRange(predicted) },
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
    grid: { left: 14, right: 18, top: 14, bottom: 38, containLabel: true },
    tooltip: {
      trigger: "item",
      formatter: (item) => item.seriesType === "scatter"
        ? `Run ${item.value[2]}<br>Theoretical: ${formatNumber(item.value[0])}<br>Standardized error: ${formatNumber(item.value[1])}`
        : "Normal reference"
    },
    xAxis: { type: "value", name: "Theoretical normal quantile", nameLocation: "middle", nameGap: 26, axisLabel: numericAxisLabels() },
    yAxis: { type: "value", name: "Standardized error", axisLabel: numericAxisLabels() },
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
    grid: { left: 14, right: 18, top: 14, bottom: 38, containLabel: true },
    tooltip: { trigger: "item", formatter: (item) => `Run ${item.value[2]}<br>Order: ${item.value[0]}<br>Error: ${formatNumber(item.value[1])}` },
    xAxis: { type: "value", name: "Run order", nameLocation: "middle", nameGap: 26, minInterval: 1, axisLabel: numericAxisLabels() },
    yAxis: { type: "value", name: "Prediction error", axisLabel: numericAxisLabels() },
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
  const xLabel = analysisColumnLabels[surface.factorXKey] || surface.factorXKey;
  const yLabel = analysisColumnLabels[surface.factorYKey] || surface.factorYKey;
  const title = card.querySelector("[data-surface-title]");
  if (title) title.textContent = `Predicted response: ${xLabel} × ${yLabel}`;
  const held = card.querySelector("[data-surface-held]");
  const heldEntries = Object.entries(surface.heldValues || {});
  if (held) {
    held.textContent = heldEntries.length
      ? `Held constant: ${heldEntries.map(([key, value]) => `${analysisColumnLabels[key] || key} = ${formatNumber(value)}`).join(", ")}.`
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
    grid: { left: 14, right: 90, top: 16, bottom: 42, containLabel: true },
    tooltip: {
      formatter: (item) => item.seriesName === "Measured runs"
        ? `Run ${item.value[4]}<br>${xLabel}: ${formatNumber(item.value[0])}<br>${yLabel}: ${formatNumber(item.value[1])}<br>Measured response: ${formatNumber(item.value[2])}<br>Predicted response: ${formatNumber(item.value[3])}`
        : `${xLabel}: ${formatNumber(item.value[0])}<br>${yLabel}: ${formatNumber(item.value[1])}<br>Predicted response: ${formatNumber(item.value[2])}`
    },
    xAxis: { type: "value", name: xLabel, nameLocation: "middle", nameGap: 28, axisLabel: numericAxisLabels(), ...xRange },
    yAxis: { type: "value", name: yLabel, axisLabel: numericAxisLabels(), ...yRange },
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
        ? `Run ${item.value[4]}<br>${xLabel}: ${formatNumber(item.value[0])}<br>${yLabel}: ${formatNumber(item.value[1])}<br>Measured response: ${formatNumber(item.value[2])}<br>Predicted response: ${formatNumber(item.value[3])}`
        : `${xLabel}: ${formatNumber(item.value[0])}<br>${yLabel}: ${formatNumber(item.value[1])}<br>Predicted response: ${formatNumber(item.value[2])}`
    },
    xAxis3D: { type: "value", name: xLabel, axisLabel: numericAxisLabels(), ...xRange },
    yAxis3D: { type: "value", name: yLabel, axisLabel: numericAxisLabels(), ...yRange },
    zAxis3D: { type: "value", name: "Predicted response", axisLabel: numericAxisLabels(), ...zRange },
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
  const responseLabel = analysisColumnLabels[result.specification?.responseKey] || "response";
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
      const label = button.dataset.copyLabel || button.textContent.trim() || "Copy TSV";
      button.dataset.copyLabel = label;
      try {
        await copyTextAsTsv(tableToTsv(table));
        button.textContent = "Copied";
        button.setAttribute("aria-label", "Table copied as TSV");
      } catch {
        button.textContent = "Copy failed";
        button.setAttribute("aria-label", "Table could not be copied");
      }
      window.setTimeout(() => {
        button.textContent = label;
        button.removeAttribute("aria-label");
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

function displayTerm(value) {
  const term = String(value ?? "—");
  if (term === "(Intercept)") return "Intercept";
  const keys = term.match(/factor:\d+/g) || [];
  const labels = keys.map((key) => analysisColumnLabels[key] || key);
  if (labels.length > 1) return labels.join(" × ");
  if (labels.length === 1 && /^I\(.+\^2\)$/.test(term)) return `${labels[0]}²`;
  if (labels.length === 1) return labels[0];
  return term;
}

function formatNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value !== 0 && (Math.abs(value) < 0.001 || Math.abs(value) >= 10000)) return value.toExponential(3);
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(value);
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
