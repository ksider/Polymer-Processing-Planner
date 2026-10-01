local_library <- file.path(getwd(), "library")
if (dir.exists(local_library)) .libPaths(c(local_library, .libPaths()))

suppressPackageStartupMessages(library(jsonlite))
source("R/stats_core.R")

args <- commandArgs(trailingOnly = TRUE)
mode <- if (length(args)) args[[1]] else "--analyze"

if (identical(mode, "--health")) {
  result <- list(
    status = "ok",
    contractVersion = DOE_ANALYTICS_CONTRACT_VERSION,
    engine = engine_info()
  )
} else {
  body <- paste(readLines(file("stdin"), warn = FALSE), collapse = "\n")
  request <- tryCatch(
    fromJSON(body, simplifyVector = FALSE),
    error = function(error) analysis_error("INVALID_JSON", "Request body is not valid JSON.")
  )
  result <- tryCatch(
    analyze_request(request),
    doe_analysis_error = function(error) list(
      ok = FALSE,
      contractVersion = DOE_ANALYTICS_CONTRACT_VERSION,
      requestId = if (is_scalar_string(request$requestId)) request$requestId else "unknown",
      error = list(
        code = error$code,
        message = error$message,
        retryable = isTRUE(error$retryable),
        details = error$details
      )
    ),
    error = function(error) list(
      ok = FALSE,
      contractVersion = DOE_ANALYTICS_CONTRACT_VERSION,
      requestId = if (is_scalar_string(request$requestId)) request$requestId else "unknown",
      error = list(
        code = "ANALYSIS_FAILED",
        message = "The statistical calculation failed unexpectedly.",
        retryable = FALSE
      )
    )
  )
}

cat(toJSON(result, auto_unbox = TRUE, null = "null", na = "null", digits = NA))
