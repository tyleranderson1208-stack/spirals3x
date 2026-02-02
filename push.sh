#!/usr/bin/env bash
set -e
git status -sb
git add -A
git commit -m "${1:-Update}" || true
git push origin HEAD
