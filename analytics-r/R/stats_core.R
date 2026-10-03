DOE_ANALYTICS_CONTRACT_VERSION <- "1.0"

analysis_error <- function(code, message, retryable = FALSE, details = list()) {
  condition <- structure(
    list(
      message = message,
      call = NULL,
      code = code,
      retryable = retryable,
      details = details
    ),
    class = c("doe_analysis_error", "error", "condition")
  )
  stop(condition)
}

engine_info <- function() {
  packages <- c(stats = as.character(packageVersion("stats")))
  installed <- rownames(installed.packages())
  for (package_name in c("plumber", "jsonlite", "rsm", "FrF2", "DoE.base", "emmeans", "broom")) {
    if (package_name %in% installed) {
      packages[[package_name]] <- as.character(packageVersion(package_name))
    }
  }
  list(
    name = "im-planner-r",
    version = "0.1.0",
    mode = "r",
    packages = as.list(packages)
  )
}

validate_analysis_request <- function(request) {
  issues <- character()
  if (!is.list(request)) issues <- c(issues, "Request body must be an object.")
  if (!identical(request$contractVersion, DOE_ANALYTICS_CONTRACT_VERSION)) {
    issues <- c(issues, "Unsupported analytics contract version.")
  }
  if (!is_scalar_string(request$requestId)) issues <- c(issues, "requestId is required.")
  if (!is.list(request$dataset)) issues <- c(issues, "dataset is required.")
  if (!is.list(request$specification)) issues <- c(issues, "specification is required.")
  if (length(issues)) {
    analysis_error("INVALID_ANALYSIS_REQUEST", paste(issues, collapse = " "), details = list(issues = issues))
  }

  dataset <- request$dataset
  specification <- request$specification
  if (!identical(dataset$contractVersion, DOE_ANALYTICS_CONTRACT_VERSION)) {
    issues <- c(issues, "Dataset contract version does not match the analytics contract.")
  }
  if (!is_scalar_string(dataset$datasetRevision)) {
    issues <- c(issues, "datasetRevision is required.")
  }
  columns <- dataset$columns
  if (!is.list(columns)) columns <- list()
  if (!is.list(dataset$rows)) issues <- c(issues, "dataset rows must be an array.")
  response <- find_column(columns, specification$responseKey)
  if (is.null(response) || !identical(response$role, "response") || !identical(response$dataType, "number")) {
    issues <- c(issues, "responseKey must identify a numeric response column.")
  }
  factor_keys <- unlist(specification$factorKeys, use.names = FALSE)
  if (!length(factor_keys)) {
    issues <- c(issues, "At least one factor key is required.")
  } else {
    for (key in factor_keys) {
      factor <- find_column(columns, key)
      if (is.null(factor) || !identical(factor$role, "factor") || !identical(factor$dataType, "number")) {
        issues <- c(issues, paste0("Unknown or non-numeric factor: ", key, "."))
      }
    }
  }
  families <- c("factorial", "response_surface", "regression")
  if (!(specification$modelFamily %in% families)) {
    issues <- c(issues, "Unsupported model family.")
  }
  model_terms <- selected_model_terms(specification, factor_keys)
  allowed_terms <- default_model_terms(specification$modelFamily, factor_keys)
  if (!length(model_terms)) {
    issues <- c(issues, "Select at least one model term.")
  }
  if (anyDuplicated(model_terms)) {
    issues <- c(issues, "Model terms must be unique.")
  }
  if (length(setdiff(model_terms, allowed_terms))) {
    issues <- c(issues, "One or more model terms are not supported by the selected model family.")
  }
  for (term in model_terms) {
    if (startsWith(term, "interaction:")) {
      components <- strsplit(sub("^interaction:", "", term), "|", fixed = TRUE)[[1]]
      if (length(components) != 2L || !all(paste0("main:", components) %in% model_terms)) {
        issues <- c(issues, paste0("Interaction ", term, " requires both corresponding main effects."))
      }
    }
    if (startsWith(term, "quadratic:")) {
      component <- sub("^quadratic:", "", term)
      if (!paste0("main:", component) %in% model_terms) {
        issues <- c(issues, paste0("Quadratic term ", term, " requires its main effect."))
      }
    }
  }
  confidence <- as.numeric(specification$confidenceLevel)
  if (length(confidence) != 1L || is.na(confidence) || confidence <= 0.5 || confidence >= 1) {
    issues <- c(issues, "confidenceLevel must be greater than 0.5 and less than 1.")
  }
  optimization <- specification$optimization
  if (!is.null(optimization)) {
    objective <- optimization$objective
    if (!(objective %in% c("minimize", "maximize", "target"))) {
      issues <- c(issues, "Optimization objective must be minimize, maximize, or target.")
    }
    if (identical(objective, "target") && !is.finite(as.numeric(optimization$target))) {
      issues <- c(issues, "A numeric target is required for target optimization.")
    }
  }
  if (length(issues)) {
    analysis_error("INVALID_ANALYSIS_REQUEST", paste(issues, collapse = " "), details = list(issues = issues))
  }
  invisible(TRUE)
}

analyze_request <- function(request) {
  validate_analysis_request(request)
  dataset <- request$dataset
  specification <- request$specification
  rows <- dataset$rows
  if (!is.list(rows)) rows <- list()

  included <- vapply(rows, function(row) {
    include_excluded <- isTRUE(specification$includeExcluded)
    include_incomplete <- isTRUE(specification$includeIncomplete)
    (include_excluded || !isTRUE(row$excluded)) && (include_incomplete || isTRUE(row$done))
  }, logical(1))
  available_rows <- rows[included]
  response_key <- specification$responseKey
  factor_keys <- unlist(specification$factorKeys, use.names = FALSE)
  model_terms <- selected_model_terms(specification, factor_keys)
  response_values <- vapply(available_rows, function(row) numeric_value(row$values[[response_key]]), numeric(1))
  rows_missing_response <- sum(is.na(response_values))

  model_data <- data.frame(
    run_id = vapply(available_rows, function(row) as.numeric(row$runId), numeric(1)),
    run_order = vapply(available_rows, function(row) as.numeric(row$runOrder), numeric(1)),
    y = response_values,
    check.names = FALSE
  )
  for (index in seq_along(factor_keys)) {
    key <- factor_keys[[index]]
    model_data[[paste0("x", index)]] <- vapply(available_rows, function(row) {
      source <- if (isTRUE(specification$useCodedFactors)) row$codedValues else row$values
      numeric_value(source[[key]])
    }, numeric(1))
    # Keep the physical setting alongside the model coordinate. Grouped means
    # should be readable in the units used to run the experiment, even when the
    # fitted model uses coded factors.
    model_data[[paste0("raw_x", index)]] <- vapply(available_rows, function(row) {
      numeric_value(row$values[[key]])
    }, numeric(1))
  }

  complete <- complete.cases(model_data)
  used_data <- model_data[complete, , drop = FALSE]
  omitted_factor_rows <- sum(!complete & !is.na(model_data$y))
  minimum_rows <- length(model_terms) + 2L
  if (nrow(used_data) < minimum_rows) {
    analysis_error(
      "INSUFFICIENT_DATA",
      paste0("The selected model requires at least ", minimum_rows, " complete rows; ", nrow(used_data), " are available."),
      details = list(requiredRows = minimum_rows, availableRows = nrow(used_data))
    )
  }

  formula <- build_model_formula(model_terms, factor_keys)
  fit <- lm(formula, data = used_data)
  if (df.residual(fit) <= 0) {
    analysis_error("INSUFFICIENT_DEGREES_OF_FREEDOM", "The model has no residual degrees of freedom.")
  }

  warnings <- list()
  if (fit$rank < length(coef(fit))) {
    warnings[[length(warnings) + 1L]] <- list(
      code = "RANK_DEFICIENT_MODEL",
      message = "The model matrix is rank deficient; one or more terms are aliased."
    )
  }
  if (omitted_factor_rows > 0) {
    warnings[[length(warnings) + 1L]] <- list(
      code = "MISSING_FACTOR_VALUES",
      message = paste0(omitted_factor_rows, " row(s) with a response were omitted because factor values are missing.")
    )
  }
  lack_of_fit <- build_lack_of_fit(fit, used_data)
  if (!lack_of_fit$hasReplicates) {
    warnings[[length(warnings) + 1L]] <- list(
      code = "LACK_OF_FIT_NOT_ESTIMABLE",
      message = "Lack of fit cannot be tested because there are no repeated factor settings with measured responses."
    )
  } else if (!lack_of_fit$estimable) {
    warnings[[length(warnings) + 1L]] <- list(
      code = "LACK_OF_FIT_NOT_ESTIMABLE",
      message = "Lack of fit cannot be separated from pure repeat-to-repeat error for this model."
    )
  }

  list(
    ok = TRUE,
    contractVersion = DOE_ANALYTICS_CONTRACT_VERSION,
    requestId = request$requestId,
    datasetRevision = dataset$datasetRevision,
    engine = engine_info(),
    specification = specification,
    summary = build_summary(fit, length(rows), length(available_rows), nrow(used_data), rows_missing_response),
    coefficients = build_coefficients(fit, factor_keys, as.numeric(specification$confidenceLevel)),
    anova = build_anova(fit, factor_keys, lack_of_fit),
    diagnostics = build_diagnostics(fit, used_data),
    optimizer = build_optimizer(fit, used_data, factor_keys, specification$optimization),
    plots = build_model_plots(fit, used_data, factor_keys, specification$modelFamily, as.numeric(specification$confidenceLevel)),
    warnings = warnings
  )
}

default_model_terms <- function(model_family, factor_keys) {
  main_effects <- paste0("main:", factor_keys)
  if (identical(model_family, "regression")) return(main_effects)
  interactions <- if (length(factor_keys) > 1) {
    apply(combn(factor_keys, 2), 2, function(pair) paste0("interaction:", pair[[1]], "|", pair[[2]]))
  } else character()
  if (identical(model_family, "factorial")) return(c(main_effects, interactions))
  c(main_effects, interactions, paste0("quadratic:", factor_keys))
}

selected_model_terms <- function(specification, factor_keys) {
  if (is.null(specification$modelTerms)) {
    return(default_model_terms(specification$modelFamily, factor_keys))
  }
  unlist(specification$modelTerms, use.names = FALSE)
}

build_model_formula <- function(model_terms, factor_keys) {
  variable_for <- function(factor_key) {
    index <- match(factor_key, factor_keys)
    if (is.na(index)) return(NA_character_)
    paste0("x", index)
  }
  terms <- vapply(model_terms, function(term) {
    if (startsWith(term, "main:")) {
      return(variable_for(sub("^main:", "", term)))
    }
    if (startsWith(term, "quadratic:")) {
      variable <- variable_for(sub("^quadratic:", "", term))
      return(paste0("I(", variable, "^2)"))
    }
    if (startsWith(term, "interaction:")) {
      components <- strsplit(sub("^interaction:", "", term), "|", fixed = TRUE)[[1]]
      return(paste(variable_for(components[[1]]), variable_for(components[[2]]), sep = ":"))
    }
    NA_character_
  }, character(1))
  reformulate(terms[!is.na(terms)], response = "y")
}

build_summary <- function(fit, rows_available, rows_after_scope, rows_used, missing_response) {
  summary_fit <- summary(fit)
  residuals <- residuals(fit)
  total_sum_of_squares <- sum((model.response(model.frame(fit)) - mean(model.response(model.frame(fit))))^2)
  leverage <- hatvalues(fit)
  press_residuals <- residuals / (1 - leverage)
  predicted_r_squared <- if (
    total_sum_of_squares > 0 &&
    all(is.finite(press_residuals))
  ) {
    1 - sum(press_residuals^2) / total_sum_of_squares
  } else {
    NA_real_
  }
  f_statistic <- summary_fit$fstatistic
  model_p_value <- if (!is.null(f_statistic) && length(f_statistic) == 3L) {
    pf(f_statistic[[1]], f_statistic[[2]], f_statistic[[3]], lower.tail = FALSE)
  } else {
    NA_real_
  }
  metrics <- list(
    metric("r_squared", "R-squared", unname(summary_fit$r.squared)),
    metric("adjusted_r_squared", "Adjusted R-squared", unname(summary_fit$adj.r.squared)),
    metric("predicted_r_squared", "Predicted R-squared", predicted_r_squared),
    metric("model_p_value", "Model p-value", model_p_value),
    metric("rmse", "RMSE", sqrt(mean(residuals^2))),
    metric("residual_degrees_of_freedom", "Residual degrees of freedom", df.residual(fit))
  )
  list(
    rowsAvailable = rows_after_scope,
    rowsUsed = rows_used,
    rowsExcluded = rows_available - rows_after_scope,
    rowsMissingResponse = missing_response,
    metrics = metrics
  )
}

metric <- function(key, label, value) {
  list(key = key, label = label, value = finite_or_na(value))
}

build_coefficients <- function(fit, factor_keys, confidence_level) {
  table <- summary(fit)$coefficients
  critical <- qt(1 - (1 - confidence_level) / 2, df.residual(fit))
  lapply(seq_len(nrow(table)), function(index) {
    estimate <- unname(table[index, 1])
    standard_error <- unname(table[index, 2])
    list(
      term = readable_term(rownames(table)[[index]], factor_keys),
      estimate = finite_or_na(estimate),
      standardError = finite_or_na(standard_error),
      statistic = finite_or_na(unname(table[index, 3])),
      pValue = finite_or_na(unname(table[index, 4])),
      confidenceLow = finite_or_na(estimate - critical * standard_error),
      confidenceHigh = finite_or_na(estimate + critical * standard_error)
    )
  })
}

build_anova <- function(fit, factor_keys, lack_of_fit) {
  table <- anova(fit)
  rows <- lapply(seq_len(max(0L, nrow(table) - 1L)), function(index) {
    list(
      term = readable_term(rownames(table)[[index]], factor_keys),
      degreesOfFreedom = finite_or_na(table[index, "Df"]),
      sumOfSquares = finite_or_na(table[index, "Sum Sq"]),
      meanSquare = finite_or_na(table[index, "Mean Sq"]),
      statistic = if ("F value" %in% colnames(table)) finite_or_na(table[index, "F value"]) else NA_real_,
      pValue = if ("Pr(>F)" %in% colnames(table)) finite_or_na(table[index, "Pr(>F)"]) else NA_real_
    )
  })
  if (lack_of_fit$estimable) {
    rows[[length(rows) + 1L]] <- anova_row(
      "Lack of fit",
      lack_of_fit$lackOfFitDegreesOfFreedom,
      lack_of_fit$lackOfFitSumOfSquares,
      lack_of_fit$lackOfFitMeanSquare,
      lack_of_fit$statistic,
      lack_of_fit$pValue
    )
    rows[[length(rows) + 1L]] <- anova_row(
      "Pure error",
      lack_of_fit$pureErrorDegreesOfFreedom,
      lack_of_fit$pureErrorSumOfSquares,
      lack_of_fit$pureErrorMeanSquare,
      NA_real_,
      NA_real_
    )
  }
  residual_index <- nrow(table)
  rows[[length(rows) + 1L]] <- anova_row(
    "Residual error (total)",
    table[residual_index, "Df"],
    table[residual_index, "Sum Sq"],
    table[residual_index, "Mean Sq"],
    NA_real_,
    NA_real_
  )
  rows
}

anova_row <- function(term, degrees_of_freedom, sum_of_squares, mean_square, statistic, p_value) {
  list(
    term = term,
    degreesOfFreedom = finite_or_na(degrees_of_freedom),
    sumOfSquares = finite_or_na(sum_of_squares),
    meanSquare = finite_or_na(mean_square),
    statistic = finite_or_na(statistic),
    pValue = finite_or_na(p_value)
  )
}

build_lack_of_fit <- function(fit, used_data) {
  factor_columns <- grep("^x[0-9]+$", names(used_data), value = TRUE)
  group_parts <- lapply(used_data[factor_columns], function(values) {
    format(values, digits = 15, trim = TRUE, scientific = FALSE)
  })
  groups <- do.call(interaction, c(group_parts, list(drop = TRUE, lex.order = TRUE)))
  group_count <- nlevels(groups)
  pure_error_degrees_of_freedom <- nrow(used_data) - group_count
  lack_of_fit_degrees_of_freedom <- df.residual(fit) - pure_error_degrees_of_freedom
  has_replicates <- pure_error_degrees_of_freedom > 0
  estimable <- has_replicates && lack_of_fit_degrees_of_freedom > 0
  group_means <- ave(used_data$y, groups, FUN = mean)
  pure_error_sum_of_squares <- sum((used_data$y - group_means)^2)
  residual_sum_of_squares <- sum(residuals(fit)^2)
  lack_of_fit_sum_of_squares <- max(0, residual_sum_of_squares - pure_error_sum_of_squares)
  pure_error_mean_square <- if (pure_error_degrees_of_freedom > 0) {
    pure_error_sum_of_squares / pure_error_degrees_of_freedom
  } else {
    NA_real_
  }
  lack_of_fit_mean_square <- if (lack_of_fit_degrees_of_freedom > 0) {
    lack_of_fit_sum_of_squares / lack_of_fit_degrees_of_freedom
  } else {
    NA_real_
  }
  statistic <- if (estimable && pure_error_mean_square > .Machine$double.eps) {
    lack_of_fit_mean_square / pure_error_mean_square
  } else {
    NA_real_
  }
  p_value <- if (is.finite(statistic)) {
    pf(statistic, lack_of_fit_degrees_of_freedom, pure_error_degrees_of_freedom, lower.tail = FALSE)
  } else if (estimable && lack_of_fit_mean_square > .Machine$double.eps) {
    0
  } else {
    NA_real_
  }
  list(
    hasReplicates = has_replicates,
    estimable = estimable,
    lackOfFitDegreesOfFreedom = lack_of_fit_degrees_of_freedom,
    lackOfFitSumOfSquares = lack_of_fit_sum_of_squares,
    lackOfFitMeanSquare = lack_of_fit_mean_square,
    pureErrorDegreesOfFreedom = pure_error_degrees_of_freedom,
    pureErrorSumOfSquares = pure_error_sum_of_squares,
    pureErrorMeanSquare = pure_error_mean_square,
    statistic = statistic,
    pValue = p_value
  )
}

build_diagnostics <- function(fit, used_data) {
  standardized <- rstandard(fit)
  leverage <- hatvalues(fit)
  cooks <- cooks.distance(fit)
  fitted_values <- fitted(fit)
  residual_values <- residuals(fit)
  lapply(seq_len(nrow(used_data)), function(index) {
    list(
      runId = unname(used_data$run_id[[index]]),
      fitted = finite_or_na(fitted_values[[index]]),
      residual = finite_or_na(residual_values[[index]]),
      standardizedResidual = finite_or_na(standardized[[index]]),
      leverage = finite_or_na(leverage[[index]]),
      cooksDistance = finite_or_na(cooks[[index]])
    )
  })
}

build_optimizer <- function(fit, used_data, factor_keys, optimization) {
  if (is.null(optimization)) return(NULL)
  objective <- optimization$objective
  target <- if (identical(objective, "target")) as.numeric(optimization$target) else NA_real_
  requested_bounds <- optimization$factorBounds
  if (is.null(requested_bounds)) requested_bounds <- list()
  variables <- paste0("x", seq_along(factor_keys))
  raw_variables <- paste0("raw_x", seq_along(factor_keys))
  ranges <- vector("list", length(factor_keys))
  names(ranges) <- factor_keys
  model_ranges <- vector("list", length(factor_keys))
  names(model_ranges) <- variables

  for (index in seq_along(factor_keys)) {
    key <- factor_keys[[index]]
    raw_values <- used_data[[raw_variables[[index]]]]
    model_values <- used_data[[variables[[index]]]]
    default_min <- min(raw_values)
    default_max <- max(raw_values)
    requested <- requested_bounds[[key]]
    lower <- if (!is.null(requested)) as.numeric(requested$min) else default_min
    upper <- if (!is.null(requested)) as.numeric(requested$max) else default_max
    if (!is.finite(lower) || !is.finite(upper) || lower >= upper) {
      analysis_error("INVALID_ANALYSIS_REQUEST", paste0("Optimization bounds for ", key, " must have min below max."))
    }
    ordered <- order(raw_values, model_values)
    raw_unique <- raw_values[ordered]
    model_unique <- model_values[ordered]
    keep <- !duplicated(raw_unique)
    raw_unique <- raw_unique[keep]
    model_unique <- model_unique[keep]
    if (length(raw_unique) < 2L) {
      analysis_error("INVALID_ANALYSIS_REQUEST", paste0("Optimization requires at least two settings for ", key, "."))
    }
    to_model <- function(value) approx(raw_unique, model_unique, xout = value, rule = 2)$y
    ranges[[key]] <- list(min = lower, max = upper)
    model_ranges[[variables[[index]]]] <- c(to_model(lower), to_model(upper))
  }

  # Grid search is deterministic and bounded. It intentionally recommends
  # only within explicitly declared factor limits, never extrapolating beyond
  # the selected physical range.
  per_factor <- max(5L, min(41L, floor(50000^(1 / length(variables)))))
  raw_grid <- do.call(expand.grid, c(lapply(ranges, function(bound) seq(bound$min, bound$max, length.out = per_factor)), list(KEEP.OUT.ATTRS = FALSE, stringsAsFactors = FALSE)))
  names(raw_grid) <- factor_keys
  model_grid <- as.data.frame(lapply(seq_along(variables), function(index) {
    range <- model_ranges[[variables[[index]]]]
    seq(range[[1]], range[[2]], length.out = per_factor)
  }), check.names = FALSE)
  names(model_grid) <- variables
  # expand.grid above establishes the same column-order cartesian product.
  model_grid <- do.call(expand.grid, c(unname(model_grid), list(KEEP.OUT.ATTRS = FALSE, stringsAsFactors = FALSE)))
  names(model_grid) <- variables
  predicted <- safe_predict(fit, model_grid)
  score <- if (identical(objective, "maximize")) predicted else if (identical(objective, "minimize")) -predicted else -abs(predicted - target)
  best <- which.max(score)
  if (!length(best) || !is.finite(predicted[[best]])) return(NULL)
  list(
    objective = objective,
    target = finite_or_na(target),
    predicted = finite_or_na(predicted[[best]]),
    factorValues = as.list(vapply(factor_keys, function(key) raw_grid[[key]][[best]], numeric(1))),
    modelFactorValues = as.list(vapply(variables, function(key) model_grid[[key]][[best]], numeric(1))),
    factorBounds = ranges,
    candidatesEvaluated = nrow(raw_grid)
  )
}

build_model_plots <- function(fit, used_data, factor_keys, model_family, confidence_level) {
  variables <- paste0("x", seq_along(factor_keys))
  reference <- vapply(variables, function(variable) mean(used_data[[variable]]), numeric(1))
  names(reference) <- variables

  main_effects <- lapply(seq_along(variables), function(index) {
    variable <- variables[[index]]
    values <- plot_levels(used_data[[variable]], 9)
    frame <- prediction_frame(reference, length(values))
    frame[[variable]] <- values
    predicted <- safe_predict(fit, frame)
    list(
      factorKey = factor_keys[[index]],
      points = lapply(seq_along(values), function(point_index) list(
        value = unname(values[[point_index]]),
        predicted = finite_or_na(predicted[[point_index]])
      ))
    )
  })

  mean_by_factor <- lapply(seq_along(variables), function(index) {
    raw_variable <- paste0("raw_x", index)
    values <- sort(unique(as.numeric(used_data[[raw_variable]])))
    list(
      factorKey = factor_keys[[index]],
      points = lapply(values, function(value) {
        responses <- used_data$y[used_data[[raw_variable]] == value]
        count <- length(responses)
        average <- mean(responses)
        standard_error <- if (count > 1) stats::sd(responses) / sqrt(count) else NA_real_
        critical <- if (count > 1) stats::qt(1 - (1 - confidence_level) / 2, count - 1) else NA_real_
        list(
          value = unname(value),
          mean = finite_or_na(average),
          confidenceLow = finite_or_na(average - critical * standard_error),
          confidenceHigh = finite_or_na(average + critical * standard_error),
          n = count
        )
      })
    )
  })

  pairs <- if (length(variables) > 1) combn(seq_along(variables), 2, simplify = FALSE) else list()
  interactions <- lapply(pairs, function(pair) {
    x_index <- pair[[1]]
    y_index <- pair[[2]]
    x_variable <- variables[[x_index]]
    y_variable <- variables[[y_index]]
    x_values <- plot_levels(used_data[[x_variable]], 9)
    y_values <- plot_levels(used_data[[y_variable]], 5)
    series <- lapply(y_values, function(y_value) {
      frame <- prediction_frame(reference, length(x_values))
      frame[[x_variable]] <- x_values
      frame[[y_variable]] <- y_value
      predicted <- safe_predict(fit, frame)
      list(
        factorYValue = unname(y_value),
        points = lapply(seq_along(x_values), function(point_index) list(
          factorXValue = unname(x_values[[point_index]]),
          predicted = finite_or_na(predicted[[point_index]])
        ))
      )
    })
    list(
      factorXKey = factor_keys[[x_index]],
      factorYKey = factor_keys[[y_index]],
      series = series
    )
  })

  standardized <- rstandard(fit)
  qq_order <- order(standardized, na.last = TRUE)
  theoretical <- qnorm(ppoints(length(standardized)))
  qq <- lapply(seq_along(qq_order), function(index) {
    source_index <- qq_order[[index]]
    list(
      runId = unname(used_data$run_id[[source_index]]),
      theoretical = unname(theoretical[[index]]),
      standardizedResidual = finite_or_na(standardized[[source_index]])
    )
  })

  residual_values <- residuals(fit)
  run_order_index <- order(used_data$run_order)
  residual_order <- lapply(run_order_index, function(index) list(
    runId = unname(used_data$run_id[[index]]),
    runOrder = unname(used_data$run_order[[index]]),
    residual = finite_or_na(residual_values[[index]])
  ))

  surfaces <- list()
  if (identical(model_family, "response_surface") && length(variables) >= 2) {
    # Keep the total grid payload bounded while making every factor pair selectable.
    # Typical BBD models retain the full 31 x 31 grid; very wide models use a
    # smaller grid rather than silently dropping factor pairs.
    grid_size <- max(11L, min(31L, floor(sqrt(30000 / max(1L, length(pairs))))))
    fitted_values <- fitted(fit)
    surfaces <- lapply(pairs, function(pair) {
      x_index <- pair[[1]]
      y_index <- pair[[2]]
      x_variable <- variables[[x_index]]
      y_variable <- variables[[y_index]]
      x_values <- seq(min(used_data[[x_variable]]), max(used_data[[x_variable]]), length.out = grid_size)
      y_values <- seq(min(used_data[[y_variable]]), max(used_data[[y_variable]]), length.out = grid_size)
      grid <- expand.grid(x = x_values, y = y_values)
      frame <- prediction_frame(reference, nrow(grid))
      frame[[x_variable]] <- grid$x
      frame[[y_variable]] <- grid$y
      predicted <- safe_predict(fit, frame)
      held_values <- as.list(reference)
      names(held_values) <- factor_keys
      held_values[[factor_keys[[x_index]]]] <- NULL
      held_values[[factor_keys[[y_index]]]] <- NULL
      list(
        factorXKey = factor_keys[[x_index]],
        factorYKey = factor_keys[[y_index]],
        heldValues = held_values,
        points = lapply(seq_len(nrow(grid)), function(index) list(
          x = unname(grid$x[[index]]),
          y = unname(grid$y[[index]]),
          predicted = finite_or_na(predicted[[index]])
        )),
        actualPoints = lapply(seq_len(nrow(used_data)), function(index) list(
          runId = unname(used_data$run_id[[index]]),
          x = unname(used_data[[x_variable]][[index]]),
          y = unname(used_data[[y_variable]][[index]]),
          response = finite_or_na(used_data$y[[index]]),
          predicted = finite_or_na(fitted_values[[index]])
        ))
      )
    })
  }

  list(
    mainEffects = main_effects,
    meanByFactor = mean_by_factor,
    interactions = interactions,
    qq = qq,
    residualOrder = residual_order,
    surface = if (length(surfaces)) surfaces[[1]] else NULL,
    surfaces = surfaces
  )
}

prediction_frame <- function(reference, row_count) {
  as.data.frame(lapply(reference, function(value) rep(value, row_count)), check.names = FALSE)
}

plot_levels <- function(values, maximum) {
  levels <- sort(unique(as.numeric(values)))
  if (length(levels) <= maximum) return(levels)
  seq(min(levels), max(levels), length.out = maximum)
}

safe_predict <- function(fit, new_data) {
  suppressWarnings(as.numeric(predict(fit, newdata = new_data)))
}

readable_term <- function(term, factor_keys) {
  if (identical(term, "(Intercept)")) return(term)
  result <- term
  for (index in rev(seq_along(factor_keys))) {
    result <- gsub(paste0("x", index), factor_keys[[index]], result, fixed = TRUE)
  }
  result
}

find_column <- function(columns, key) {
  matches <- Filter(function(column) identical(column$key, key), columns)
  if (length(matches)) matches[[1]] else NULL
}

numeric_value <- function(value) {
  if (is.null(value) || length(value) != 1L || !is.numeric(value) || !is.finite(value)) return(NA_real_)
  as.numeric(value)
}

finite_or_na <- function(value) {
  value <- as.numeric(value)
  if (length(value) != 1L || !is.finite(value)) NA_real_ else value
}

is_scalar_string <- function(value) {
  is.character(value) && length(value) == 1L && nzchar(value)
}
