#!/bin/sh
# Consistent copy of the real-data database, safe while the server runs
# (SQLite's online backup API). Keeps the newest 30.
set -eu
src_dir="$HOME/.finance/local/v3/d1/miniflare-D1DatabaseObject"
dest="$HOME/.finance/backups"
mkdir -p "$dest" && chmod 700 "$dest"
db=$(ls "$src_dir"/*.sqlite | grep -v metadata | head -1)
out="$dest/finance-$(date +%Y%m%d-%H%M%S).sqlite"
sqlite3 "$db" ".backup '$out'"
chmod 600 "$out"
ls -1t "$dest"/finance-*.sqlite | tail -n +31 | xargs rm -f
echo "Backed up to $out ($(sqlite3 "$out" 'SELECT COUNT(*) FROM transactions') transactions, $(sqlite3 "$out" 'SELECT COUNT(*) FROM accounts') accounts)"
