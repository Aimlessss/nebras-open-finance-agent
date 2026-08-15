#!/usr/bin/env bash

set -u
set -o pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
agent_root="$(cd "$script_dir/../.." && pwd)"
pages_root="$(cd "$agent_root/../community-standards/src/pages" && pwd)"
parsed_root="$agent_root/parsed-output"
chunk_root="$agent_root/chunk-output"

processed=0
failed=0

while IFS= read -r -d '' source_file; do
  relative_path="${source_file#"$pages_root"/}"
  relative_stem="${relative_path%.vue}"
  parsed_file="$parsed_root/$relative_stem.json"
  chunk_file="$chunk_root/$relative_stem.chunks.json"

  printf 'Processing %s\n' "$relative_path"

  if ! node "$script_dir/parser.js" "$source_file" "$parsed_file" >/dev/null; then
    printf 'Parser failed: %s\n' "$relative_path" >&2
    failed=$((failed + 1))
    continue
  fi

  if ! node "$script_dir/chunker.js" "$parsed_file" "$chunk_file" >/dev/null; then
    printf 'Chunker failed: %s\n' "$relative_path" >&2
    failed=$((failed + 1))
    continue
  fi

  processed=$((processed + 1))
done < <(find "$pages_root" -type f -name '*.vue' -print0 | sort -z)

printf 'Completed: %d files\n' "$processed"

if (( failed > 0 )); then
  printf 'Failed: %d files\n' "$failed" >&2
  exit 1
fi
