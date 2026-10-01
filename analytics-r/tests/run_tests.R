source("R/stats_core.R")

assert_close <- function(actual, expected, tolerance = 1e-8, label = "value") {
  if (length(actual) != 1L || is.na(actual) || abs(actual - expected) > tolerance) {
    stop(label, ": expected ", expected, ", got ", actual)
  }
}

make_dataset <- function(points, response, design_type) {
  factor_keys <- paste0("factor:", seq_len(ncol(points)))
  columns <- lapply(seq_along(factor_keys), function(index) list(
    key = factor_keys[[index]],
    role = "factor",
    dataType = "number",
    active = TRUE
  ))
  columns[[length(columns) + 1L]] <- list(
    key = "response:1",
    role = "response",
    dataType = "number",
    active = TRUE
  )
  rows <- lapply(seq_len(nrow(points)), function(index) {
    factor_values <- as.list(as.numeric(points[index, ]))
    names(factor_values) <- factor_keys
    list(
      runId = index,
      runCode = paste0("R", index),
      runOrder = index,
      done = TRUE,
      excluded = FALSE,
      values = c(factor_values, list("response:1" = response[[index]])),
      codedValues = factor_values
    )
  })
  list(
    contractVersion = "1.0",
    datasetRevision = paste0("fixture-", tolower(design_type)),
    doe = list(designType = design_type),
    columns = columns,
    rows = rows
  )
}

make_request <- function(dataset, family) {
  list(
    contractVersion = "1.0",
    requestId = paste0("test-", family),
    dataset = dataset,
    specification = list(
      responseKey = "response:1",
      factorKeys = paste0("factor:", seq_len(3)),
      modelFamily = family,
      useCodedFactors = TRUE,
      includeExcluded = FALSE,
      includeIncomplete = FALSE,
      confidenceLevel = 0.95
    )
  )
}

factorial_points <- as.matrix(expand.grid(c(-1, 1), c(-1, 1), c(-1, 1)))
factorial_points <- rbind(factorial_points, factorial_points)
factorial_noise <- rep(c(-0.1, 0.1), each = 8)
factorial_response <- 10 +
  2 * factorial_points[, 1] -
  3 * factorial_points[, 2] +
  1.5 * factorial_points[, 3] +
  4 * factorial_points[, 1] * factorial_points[, 2] +
  factorial_noise
factorial_result <- analyze_request(make_request(
  make_dataset(factorial_points, factorial_response, "FFA"),
  "factorial"
))
stopifnot(isTRUE(factorial_result$ok), factorial_result$summary$rowsUsed == 16)
stopifnot(length(factorial_result$plots$mainEffects) == 3)
stopifnot(length(factorial_result$plots$meanByFactor) == 3)
stopifnot(length(factorial_result$plots$meanByFactor[[1]]$points) == 2)
stopifnot(factorial_result$plots$meanByFactor[[1]]$points[[1]]$n == 8)
stopifnot(is.finite(factorial_result$plots$meanByFactor[[1]]$points[[1]]$confidenceLow))
stopifnot(is.finite(factorial_result$plots$meanByFactor[[1]]$points[[1]]$confidenceHigh))
stopifnot(length(factorial_result$plots$interactions) == 3)
stopifnot(length(factorial_result$plots$qq) == 16)
stopifnot(length(factorial_result$plots$residualOrder) == 16)
stopifnot(is.null(factorial_result$plots$surface))
stopifnot(length(factorial_result$plots$surfaces) == 0)
factorial_metrics <- setNames(
  vapply(factorial_result$summary$metrics, function(row) row$value, numeric(1)),
  vapply(factorial_result$summary$metrics, function(row) row$key, character(1))
)
stopifnot(is.finite(factorial_metrics[["predicted_r_squared"]]))
stopifnot(is.finite(factorial_metrics[["model_p_value"]]))
factorial_anova_terms <- vapply(factorial_result$anova, function(row) row$term, character(1))
stopifnot("Lack of fit" %in% factorial_anova_terms)
stopifnot("Pure error" %in% factorial_anova_terms)
stopifnot("Residual error (total)" %in% factorial_anova_terms)
factorial_estimates <- setNames(
  vapply(factorial_result$coefficients, function(row) row$estimate, numeric(1)),
  vapply(factorial_result$coefficients, function(row) row$term, character(1))
)
assert_close(factorial_estimates[["(Intercept)"]], 10, label = "factorial intercept")
assert_close(factorial_estimates[["factor:1"]], 2, label = "factorial first effect")
assert_close(factorial_estimates[["factor:1:factor:2"]], 4, label = "factorial interaction")

bbd_points <- rbind(
  c(-1, -1, 0), c(1, -1, 0), c(-1, 1, 0), c(1, 1, 0),
  c(-1, 0, -1), c(1, 0, -1), c(-1, 0, 1), c(1, 0, 1),
  c(0, -1, -1), c(0, 1, -1), c(0, -1, 1), c(0, 1, 1),
  c(0, 0, 0), c(0, 0, 0), c(0, 0, 0)
)
bbd_response <- 50 +
  2 * bbd_points[, 1] - 3 * bbd_points[, 2] + bbd_points[, 3] +
  1.5 * bbd_points[, 1] * bbd_points[, 2] -
  2 * bbd_points[, 1]^2 + 0.5 * bbd_points[, 2]^2 + 0.25 * bbd_points[, 3]^2 +
  c(rep(0, 12), -0.1, 0, 0.1)
bbd_result <- analyze_request(make_request(make_dataset(bbd_points, bbd_response, "BBD"), "response_surface"))
stopifnot(isTRUE(bbd_result$ok), bbd_result$summary$rowsUsed == 15)
stopifnot(length(bbd_result$plots$surface$points) == 31 * 31)
stopifnot(length(bbd_result$plots$surfaces) == 3)
stopifnot(length(bbd_result$plots$surfaces[[1]]$actualPoints) == 15)
stopifnot(bbd_result$plots$surfaces[[1]]$actualPoints[[1]]$runId == 1)
bbd_anova_terms <- vapply(bbd_result$anova, function(row) row$term, character(1))
stopifnot("Lack of fit" %in% bbd_anova_terms)
stopifnot("Pure error" %in% bbd_anova_terms)
bbd_estimates <- setNames(
  vapply(bbd_result$coefficients, function(row) row$estimate, numeric(1)),
  vapply(bbd_result$coefficients, function(row) row$term, character(1))
)
assert_close(bbd_estimates[["(Intercept)"]], 50, tolerance = 1e-7, label = "BBD intercept")
assert_close(bbd_estimates[["I(factor:1^2)"]], -2, tolerance = 1e-7, label = "BBD quadratic")
assert_close(bbd_estimates[["factor:1:factor:2"]], 1.5, tolerance = 1e-7, label = "BBD interaction")

insufficient_request <- make_request(
  make_dataset(bbd_points[1:5, , drop = FALSE], bbd_response[1:5], "BBD"),
  "response_surface"
)
insufficient_error <- tryCatch(
  {
    analyze_request(insufficient_request)
    NULL
  },
  doe_analysis_error = function(error) error
)
stopifnot(inherits(insufficient_error, "doe_analysis_error"))
stopifnot(identical(insufficient_error$code, "INSUFFICIENT_DATA"))

cat("analytics-r statistical tests passed\n")
