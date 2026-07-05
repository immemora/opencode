#!/bin/sh

CURRENT_SCRIPT_DIR=$(dirname "$0")
PROJECT_ROOT_DIR=$(realpath "$CURRENT_SCRIPT_DIR/../../../../../..")
LLM_MODEL=${LLM_MODEL:-"bifrost/free/deepseek-v4-flash"}

echo ${PROJECT_ROOT_DIR}

scenario_dir=$1
if [ -z "$scenario_dir" ]; then
  echo "Usage: $0 <scenario_dir> [linehash]"
  echo "linehash: b64 | tokenice | tokenice-cl100k | tokenice-o200k"
  exit 1
fi

linehash_impl=${2:-${OPENCODE_SMALLER_EDITS_LINEHASH:-b64}}

if [ ! -d "$scenario_dir" ]; then
  echo "Error: Scenario directory '$scenario_dir' does not exist."
  exit 1
fi

if [ ! -d "$scenario_dir/input" ]; then
  echo "Error: Scenario directory '$scenario_dir/input' does not exist."
  exit 1
fi

if [ ! -f "$scenario_dir/prompt.txt" ]; then
  echo "Error: prompt.txt file not found in scenario directory '$scenario_dir'."
  exit 1
fi

_tmpdir=$(mktemp -d /tmp/smaller_edits_test_XXXXXX)

rsync -avt "$scenario_dir/" "$_tmpdir/"

cd ${PROJECT_ROOT_DIR}

echo "Hey OPENCODE, you can inspect the outcome of this test run in: $_tmpdir"
export OPENCODE_SMALLER_EDITS_ENABLED=${OPENCODE_SMALLER_EDITS_ENABLED:-1}
export OPENCODE_SMALLER_EDITS_TRACE=${OPENCODE_SMALLER_EDITS_TRACE:-"$_tmpdir/smaller-edits-trace.jsonl"}
export OPENCODE_SMALLER_EDITS_LINEHASH=${linehash_impl}

if [ "$OPENCODE_SMALLER_EDITS_ENABLED" != "1" ]; then
  echo "OPENCODE_SMALLER_EDITS_ENABLED is disabled. USING THE DEFAULT edit/read TOOLS."
else
  echo "OPENCODE_SMALLER_EDITS_ENABLED is enabled. USING THE smaller_edit/read TOOLs."
fi

echo "Smaller-edits trace will be written to: $OPENCODE_SMALLER_EDITS_TRACE"
echo "Smaller-edits linehash backend: $OPENCODE_SMALLER_EDITS_LINEHASH"

PROMPT_TEXT=$(cat "$_tmpdir/prompt.txt")

RUN_LOG="$_tmpdir/run.log"

bun dev run \
    "$PROMPT_TEXT" \
    --model ${LLM_MODEL} \
    --dir ${_tmpdir}/input \
    --thinking \
    --agent build >"$RUN_LOG" 2>&1

status=$?
cat "$RUN_LOG"
exit $status
