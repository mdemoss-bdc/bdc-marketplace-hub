#!/bin/bash
set -e
# Install dependencies only. Schema migrations are handled automatically by the
# Python API server's init_db() on startup — do NOT run drizzle-kit push here,
# it does not know about the Python-managed schema and will try to drop tables.
pnpm install --frozen-lockfile
