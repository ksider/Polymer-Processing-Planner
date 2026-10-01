library(plumber)
library(jsonlite)

source("R/stats_core.R")

#* Health and loaded engine metadata
#* @get /health
#* @serializer unboxedJSON
function() {
  list(
    status = "ok",
    contractVersion = DOE_ANALYTICS_CONTRACT_VERSION,
    engine = engine_info()
  )
}

#* Calculate a DOE model from the canonical Planner dataset
#* @post /v1/analyze
#* @serializer unboxedJSON
function(req, res) {
  request_id <- req$HTTP_X_REQUEST_ID
  tryCatch(
    {
      if (nchar(req$postBody, type = "bytes") > 5 * 1024 * 1024) {
        analysis_error("PAYLOAD_TOO_LARGE", "Analytics request exceeds the 5 MB service limit.")
      }
      request <- fromJSON(req$postBody, simplifyVector = FALSE)
      if (is_scalar_string(request_id) && !identical(request$requestId, request_id)) {
        analysis_error("REQUEST_ID_MISMATCH", "Request ID header and body do not match.")
      }
      analyze_request(request)
    },
    doe_analysis_error = function(error) {
      res$status <- 422L
      list(
        ok = FALSE,
        contractVersion = DOE_ANALYTICS_CONTRACT_VERSION,
        requestId = if (is_scalar_string(request_id)) request_id else "unknown",
        error = list(
          code = error$code,
          message = error$message,
          retryable = isTRUE(error$retryable),
          details = error$details
        )
      )
    },
    error = function(error) {
      res$status <- 500L
      list(
        ok = FALSE,
        contractVersion = DOE_ANALYTICS_CONTRACT_VERSION,
        requestId = if (is_scalar_string(request_id)) request_id else "unknown",
        error = list(
          code = "ANALYSIS_FAILED",
          message = "The statistical calculation failed unexpectedly.",
          retryable = FALSE
        )
      )
    }
  )
}
