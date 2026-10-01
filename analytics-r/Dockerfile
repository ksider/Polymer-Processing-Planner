FROM rocker/r-ver:4.4.3

ENV RENV_CONFIG_PAK_ENABLED=FALSE
WORKDIR /opt/analytics

RUN R -q -e "install.packages(c('plumber', 'jsonlite'), repos='https://cloud.r-project.org')"

COPY R ./R
COPY plumber.R run.R ./

EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD Rscript -e "status <- tryCatch(readLines('http://127.0.0.1:8000/health', warn=FALSE), error=function(e) ''); quit(status=if(length(status)) 0 else 1)"

CMD ["Rscript", "run.R"]
