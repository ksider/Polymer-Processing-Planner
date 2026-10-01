library(plumber)

router <- plumb("plumber.R")
router$run(host = "0.0.0.0", port = as.integer(Sys.getenv("PORT", "8000")))
