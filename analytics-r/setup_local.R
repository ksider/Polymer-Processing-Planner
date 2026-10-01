library_dir <- file.path(getwd(), "library")
dir.create(library_dir, recursive = TRUE, showWarnings = FALSE)
install.packages("jsonlite", lib = library_dir, repos = "https://cloud.r-project.org")
