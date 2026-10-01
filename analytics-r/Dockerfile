FROM rocker/r-ver:4.4.3

ENV RENV_CONFIG_PAK_ENABLED=FALSE
WORKDIR /opt/analytics

# Plumber dependencies such as curl, openssl, xml2 and sodium compile against
# these libraries in the rocker/r-ver base image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    libcurl4-openssl-dev \
    libssl-dev \
    libxml2-dev \
    libsodium-dev \
    pkg-config \
  && rm -rf /var/lib/apt/lists/*

RUN R -q -e "install.packages(c('plumber', 'jsonlite'), repos='https://cloud.r-project.org'); library(plumber); library(jsonlite)"

COPY R ./R
COPY plumber.R run.R ./

EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD Rscript -e "status <- tryCatch(readLines('http://127.0.0.1:8000/health', warn=FALSE), error=function(e) ''); quit(status=if(length(status)) 0 else 1)"

CMD ["Rscript", "run.R"]
