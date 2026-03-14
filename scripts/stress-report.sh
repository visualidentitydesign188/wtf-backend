#!/usr/bin/env sh
# Runs stress test and generates HTML report. Pass -e deployed to test deployed server.
# Usage: ./scripts/stress-report.sh [ -e deployed ]
set -e
mkdir -p reports
artillery run scripts/artillery-stress.yml --output reports/stress-report.json "$@"
artillery report reports/stress-report.json --output reports/stress-report.html
