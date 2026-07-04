Smaller-edits smoke scenarios live here.

Each `scenario_*` directory is a self-contained harness fixture:
- `prompt.txt` is the initial user request.
- `input/` is the starting workspace tree.
- `expected/` is the reference tree after a successful agent loop.

The scenarios are intentionally non-trivial. They spread edits across multiple files,
contain repeated text that benefits from identity-based anchoring, and include a mix
of replacements, insertions, and one file-creation case.
