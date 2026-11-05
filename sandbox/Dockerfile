# Tachikoma's sandbox image (release 7 design, "The sandbox"; release 7 plan, choice 15).
# Node 24, as the host runs. The base and uv are pinned by the digests read on 2026-10-31
# (node v24.22.2 on Debian 12.15; uv 0.13.6).
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

COPY --from=ghcr.io/astral-sh/uv@sha256:af22a52f5eafef3d78e551599d405c02df61919d18028f0cea8eda93bc9986d0 /uv /uvx /usr/local/bin/

RUN apt-get update \
 && apt-get install -y --no-install-recommends git python3 python3-venv bash ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# The base image's own user `node` holds 1000:1000; the box's user is `tachi` with those ids
# (plan, choice 14).
RUN userdel -r node \
 && groupadd -g 1000 tachi \
 && useradd -u 1000 -g 1000 -m -s /bin/bash tachi

USER tachi
