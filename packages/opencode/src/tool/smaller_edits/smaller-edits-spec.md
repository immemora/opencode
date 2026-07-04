# Smaller Edits / Linehash-Aware Edit Toolset — Formal-ish Specification

## 0. Credits

This is a formal specification for a linehash-aware edit toolset, 
designed to enable efficient and robust file editing by language models.

The original idea comes from [@antirez](https://antirez.com), which 
[briefly](https://antirez.com/news/166) mentioned the 
[concept](https://www.youtube.com/watch?v=IoE3Hi2zpwk#t=22m10s).

I just expanded on his idea.

## 1. Introduction

Agent harnesses include some text mutation tool (edit, patch, apply_patch, and so on). 
**All of them.** 

They burden the LLM by requiring verbatim reproduction of large blocks of 
source lines. Smaller LLMs in particular struggle with escaping, 
whitespace fidelity, and long-line truncation. 

It's less than satisfactory.

What if instead, we only required the LLM to cite a short handle, in the format 
`{lineno},{veryShortHash}` in place of a whole diff block?
It's dramatically more affordable, and it reduces churn and context bloat.

The design goal of this approach is to waste 3-4 tokens, not more, 
on providing a reference for a patch call.

It's a good tradeoff. Let's try.

## 1.1 The whole idea, as briefly as possible

We want the LLM to quote a short identifier to target a line it wants to 
edit, not the full line content.

The naive idea would be to simply use line references that combine line 
numbers with short hashes derived from the line content.

That works.

... **except that** this gets shaky when the target sits inside a run of 
identical lines in the middle of a file. (Edits above may nudge 
line numbers around. And trust me they will).

To solve that, we have each line's hash depend on the previous line's 
hash, creating a chain. The good-old Merkle switcheroo. 

That way, even identical lines end up with different hashes.

That works too.

... **but now we have a new problem**: edits above a line also change 
the hashes of every line below it. 

That disrupts the LLM's natural top-to-bottom editing flow, because 
once the first patch lands, the rest start tripping over hash mismatches. 

To solve this additional problem, we keep only a small shared memory 
of the lines the tool actually showed the LLM, plus any signed 
line-count deltas created by successful edits.

After each successful edit, the tool returns a refreshed window of text 
with fresh line numbers and fresh hashes.

The LLM therefore keeps editing against the newest visible identities, 
while the shared state remains sparse and simple rather than growing 
into a hidden full-file snapshot plus replay log.

## 2. Concepts

### 2.1 Chain hash per line

Each line hash depends on both the canonicalized line content and the hash of the
preceding line:

```
h(n) = linehash( h(n-1) || canon(content(n)) )
       for n > 1
h(1) = linehash( canon(content(1)) )
```

Here, `linehash` is a digest function that produces a short, fixed-width
string from the concatenation of the previous line's hash string and the
current line's raw content. `||` denotes concatenation with no separator
byte. The chain root, line 1, has no predecessor; its hash is computed
from its own content alone.

The digest width, in characters, and the encoding vocabulary used to
represent the output are implementation parameters. Section 4 specifies
recommended ranges and a minimum acceptable configuration.

Properties:

- Identical consecutive lines produce different hashes because the
  predecessor is part of the input.
- Any edit to a preceding line changes the hashes of all subsequent lines.
- The hash chain uniquely identifies every line position within a given
  file snapshot.

### 2.2 Shared sparse state

The read tool and the edit tool share one simple per-file structure. It is
not a full snapshot and not a replayable edit log. It stores only the
lines that were explicitly shown to the LLM plus signed line-count
breakpoints created by successful edits.

```
shared_state = {
    fileName: sparse_fileatoms_seq
}

sparse_fileatoms_seq = [
    fileatom,
    ...
]

fileatom = (
    FileOffset(
        fileno,
        orig_fileno,
        delta
    )
    |
    FileLine(
        fileno,
        orig_fileno,
        chainHash,
        content
    )
)
```

The sequence is ordered by `.fileno`. If two atoms share the same
`.fileno`, `FileOffset` sorts before `FileLine`.

Note: the visible `lineno` presented to the LLM may be computed on the fly
by reading the ordered sequence and applying the cumulative
`FileOffset.delta` values. The stored atoms therefore carry stable
`orig_fileno` and current `fileno`, while `lineno` may be treated as a
derived presentation field.

Implementation note: for this shared state to stay usable at scale, the
implementation should maintain some kind of reverse index keyed by
`orig_fileno` and possibly by `fileno` as well. Otherwise even basic lookups
devolve into trudging through the whole sequence, which gets old fast.

Field notes:

- `FileLine.fileno` is the current file position for that remembered line.
- `FileLine.orig_fileno` is the original file position associated with that
  remembered line when it first entered shared state.
- `FileLine.chainHash` is the chained hash emitted with that line.
- `FileLine.content` is the raw line content, excluding the identity
  prefix.
- `FileOffset.fileno` is the current file position of the first line below a
  count-changing edit, or the live EOF boundary if the edit reaches EOF.
- `FileOffset.orig_fileno` is the corresponding original file position of that same
  boundary before the edit.
- `FileOffset.delta` is the signed line-count change, `newCount -
  oldCount`. Positive values move later lines down. Negative values move
  later lines up.

`FileOffset` exists so the tools can remember numbering changes across
gaps where no `FileLine` atoms are cached.

### 2.3 Shared-state invariants

The sparse state is intentionally small.

- Gaps between atoms mean "unknown". The tools do not pretend to know
  lines that were never shown to the LLM.
- `read()` inserts or refreshes `FileLine` atoms only for the emitted
  window.
- `edit()` inserts or refreshes `FileLine` atoms only for the returned
  post-edit window.
- `edit()` adds a `FileOffset` atom only when `newCount != oldCount`.
- After a successful `edit()`, the returned window becomes the
  authoritative source of line numbers and hashes for subsequent edits in
  that region.

## 3. Read Tool Output Format

When the LLM reads a file, the tool selects a live window of lines and
prefixes each returned line as follows:

```
{lineno},{chainHash}|
```

### Example

With a 4-character base64url-encoded digest:

```
1,NDcg|import os
2,Zm8x|
3,YmFy|def hello():
4,cXh6|    print("hello")
5,QUJD|
```

- Line numbers are 1-indexed integers.
- Chain hash is a short string of fixed width `W`. Four characters is the
  minimum recommendation.
- The separator between the prefix and content is a pipe, `|`.
- The prefix is not part of the content. The edit tool compares content
  excluding the prefix.

Read side effect:

1. `read()` stores one `FileLine` atom per emitted line in
   `shared_state[fileName]`.
2. Any older atoms whose `.fileno` falls inside the emitted window are
   removed and replaced by the fresh `FileLine` atoms.
3. The tool may internally scan earlier lines to compute chained hashes,
   but it does not store the rest of the file in shared state.

## 4. Hash Algorithm

The `linehash` function is defined by two implementation parameters:

- `W`, the digest width in characters of the output vocabulary.
- The encoding vocabulary, meaning the set of displayable characters used
  to represent the digest.

These are not fixed by the specification. The sections below provide
minimum requirements and recommendations.

### 4.1 Hash function requirements

Pick a hash with decent mixing. Tiny toy checksums are cute, but not here:
skip CRC-16, Adler-32, XOR soup, and other collision magnets.

Top of my mind candidated include:

- 64-bit FNV-1a, truncated to the required bit width.
- SipHash-2-4, truncated.
- Any cryptographic hash, such as SHA-256 or BLAKE3, truncated to the
  required bit width.

But really, any reasonable hash will do.

Before hashing, canonicalize the line text. At minimum, normalize away EOL
differences and trim surrounding spaces if the implementation chooses that
policy. Then hash the raw bytes of `prevHash + canonicalLineContent`,
encode the result into the chosen alphabet, and trim or pad it to `W`
characters.

### 4.2 Encoding vocabulary

We can't reliably do better than 6 bits per character. 
We could but, well, you know, encodings... 
Hex and base32 are a bit too roomy for the amount of signal they
carry, so they are out.

In practice this means a base64-ish alphabet. The recommended pick is RFC
4648 URL-safe base64: `A-Z`, `a-z`, `0-9`, `-`, `_`. It is dense, tidy,
and usually tokenizes nicely.

Minimum recommendation: 4 characters at 6 bits each, for 24 bits total.
That gives about 16.8 million buckets, which is plenty for normal files.

You can go higher and set W=6 or 8. Paranoia pays. 
(But diminishing returns don't).

### 4.2.1 But wait! Why don't also encode the lineno in the hash?

Compacting the line number into the hash is technically possible, would 
provide the LLM with an opaque handle to reference a text line, 
and it would work.

But this format, `{lineno},{chainHash}`, has two advantages:
- It keeps the line number visible to the LLM, which can only improve 
  navigation;
- ... and helps debugging and error reporting when things go wrong.

Yes, we risk having the LLM to depart on decisions like "But wait, I have 
patched the document adding 2 more lines, therefore let's increment the 
line number in the hash by 2". 

That may happen. 

At the time of writing this, the contingency plan is: the patch fails.

We can fit the edit tool with a fallback path which handles these 
events gracefully, if that happens a lot. That is why in 2.2 above
I went for this wording: "possibly by `fileno` as well".

### 4.3 Per-file chain computation

```
function compute_chained_hashes(lines: string[])
    -> string[]:
    hashes = []
    prev = empty
    for lineno, content in enumerate(lines, start=1):
        canon = canonicalize_line(content)
        if lineno == 1:
            digest = raw_hash(canon)
        else:
            digest = raw_hash(prev + canon)
        current = encode_vocabulary(
            digest,
            width=W
        )
        hashes.append(current)
        prev = current
    return hashes
```

Line 1 has no predecessor, so it hashes its canonicalized content
directly. Later lines hash `prev + canon(content)` with no separator. The
chain uses the encoded previous hash string, which keeps the internal
state and the LLM-visible state in sync and saves everyone from
serialization shenanigans.

## 5. Edit Tool

### 5.1 General contract

The edit tool receives operations referencing one or two
`{lineno},{chainHash}` identities. Those values refer to the current
`FileLine` atoms in shared state, meaning the most recent line identities
emitted by `read()` or by a prior successful `edit()` response for that
region.

The tool does not keep or replay a hidden full-file snapshot. If a target
line is absent from shared state, or if the LLM quotes an older identity
after numbering changed, the tool fails and the LLM must re-read the
relevant window or use the latest returned window.

The main editing primitive is contiguous block replacement. This is much
closer to how LLMs already think about patch hunks, and it keeps one-line
edits as a nice little special case instead of the whole model.

### 5.2 Operation: Replace range

```
REPLACE RANGE {start}..{end} WITH:
<new content lines>
```

Semantics: replace the inclusive live span from `start` through `end` with
the given content.

Procedure:

1. Resolve both endpoints by finding exact `FileLine(fileno,
   orig_fileno, chainHash, content)` atoms in shared state whose visible
   `lineno` values and hashes match the quoted `start` and `end` anchors.
2. Let the resolved visible line numbers be `startLineno` and `endLineno`.
3. Confirm that `startLineno <= endLineno` and that every line in the
   inclusive span is present as a remembered `FileLine` atom.
4. If the span crosses a gap in shared state, fail and require a `read()`
   of that window.
5. Confirm that the live file lines from `startLineno` through
   `endLineno` still match the remembered `FileLine.content` values for
   the full span.
6. Replace the live file span with `<new content lines>`.
7. Recompute a post-edit return window containing the changed region plus
   optional leading and trailing context.
8. Reconcile shared state as defined in Section 6, using:

   ```
   editStart = startLineno
   oldCount = endLineno - startLineno + 1
   newCount = len(newLines)
   ```

### 5.3 Operation: Insert after line

```
INSERT AFTER {start}:
<new content lines>
```

Semantics: insert new line or lines immediately after the current live line
identified by `start`.

Procedure:

1. Resolve the anchor by finding an exact `FileLine(fileno, orig_fileno,
   chainHash, content)` atom in shared state whose visible `lineno`
   and hash match the quoted `start` anchor.
2. Let the resolved visible line number be `lineno`.
3. Confirm that the live file line at `lineno` still matches
   `FileLine.content`.
4. Insert after `lineno`.
5. Recompute a post-edit return window containing the changed region plus
   optional leading and trailing context.
6. Reconcile shared state using:

```
editStart = lineno + 1
oldCount = 0
newCount = len(newLines)
```

### 5.4 Operation: Delete range

```
DELETE RANGE {start}..{end}
```

Semantics: delete the inclusive live span from `start` through `end`.

This is sugar for `REPLACE RANGE ... WITH:` an empty payload.

Procedure: steps 1-7 are the same as replace range, except the
replacement payload is empty. After resolving `startLineno` and
`endLineno`, reconcile shared state using:

```
editStart = startLineno
oldCount = endLineno - startLineno + 1
newCount = 0
```

### 5.5 Operation: Insert at start

```
INSERT AT START:
<new content lines>
```

Semantics: insert new line or lines before the first line of the file. No
`{lineno},{chainHash}` prefix is required because there is no existing
line to target.

Procedure:

1. No `FileLine` lookup is needed.
2. Insert `<new content lines>` before live line 1.
3. Recompute a post-edit return window containing the new beginning of the
   file plus optional trailing context.
4. Reconcile shared state using:

   ```
   editStart = 1
   oldCount = 0
   newCount = len(newLines)
   ```

### 5.6 Drift check detail

The content check for targeted operations compares the live file against
the remembered `FileLine.content` values for the full targeted span or
anchor. This guards against:

- External modifications between `read()` and `edit()`.
- File-system races.
- Misbehavior of another concurrent agent.

If the content check fails, the entire edit call fails. The LLM must
re-read the file.

### 5.7 Returned context

On success, the edit tool returns refreshed text from the updated live
file. The returned region must include the edited span and should also
include a small prequel and trailer when available. Every returned line is
prefixed with a freshly recomputed `{lineno},{chainHash}|` identity.

Those returned lines become the authoritative `FileLine` atoms for
subsequent edits in that region.

### 5.8 Why range replace is the default

Most non-trivial edits are block-shaped: import groups, function headers,
paragraphs, JSX chunks, and so on. Making range replace the default keeps
the contract close to diff hunks and lets single-line edits fall out as a
degenerate case.

## 6. Shared-State Reconciliation

### 6.1 Generic update rule

After a successful edit, update `shared_state[fileName]` using the generic
triplet:

```
editStart
oldCount
newCount
```

Define:

```
delta = newCount - oldCount
origBoundary = editStart + oldCount
liveBoundary = editStart + newCount
```

Reconciliation procedure:

1. Shift every remembered atom with `atom.fileno >= origBoundary` by
   `delta`.
2. Remove every remembered `FileLine` atom whose `.fileno` falls inside the
   returned post-edit window.
3. Insert one fresh `FileLine` atom per returned line of that window.
4. If `delta != 0`, insert or refresh one offset atom:

   ```
   FileOffset(
       fileno = liveBoundary,
       orig_fileno = origBoundary,
       delta = delta
   )
   ```

5. Re-sort the sequence by `.fileno` using the `FileOffset`-before-
   `FileLine` tie-break rule.

This records line-count changes without preserving a separate edit log.

### 6.2 Worked example: one line expands into three

State before the edit, after a read of lines 1 through 7:

```
[
    FileLine(1, 1, abc0, "package main"),
    FileLine(2, 2, def1, ""),
    FileLine(3, 3, ghi2, "import ("),
    FileLine(4, 4, jkl3, "    \"fmt\""),
    FileLine(5, 5, mno4, ")"),
    FileLine(6, 6, pqr5, ""),
    FileLine(7, 7, stu6, "func main() {")
]
```

Edit:

```
REPLACE RANGE 3,ghi2..3,ghi2 WITH:
    "fmt"
    "os"
    "strings"
```

For this edit:

```
editStart = 3
oldCount = 1
newCount = 3
delta = +2
origBoundary = 4
liveBoundary = 6
```

Effects:

- every remembered atom at `fileno >= 4` shifts down by 2
- `FileOffset(6, 4, +2)` is inserted
- the returned post-edit window replaces stale atoms in that region with
  fresh `FileLine` atoms carrying new hashes

### 6.3 Worked example: delete shrinks the file

Edit:

```
DELETE RANGE 2,def1..2,def1
```

For this edit:

```
editStart = 2
oldCount = 1
newCount = 0
delta = -1
origBoundary = 3
liveBoundary = 2
```

Effects:

- every remembered atom at `fileno >= 3` shifts up by 1
- `FileOffset(2, 3, -1)` is inserted
- the returned post-edit window refreshes the nearby `FileLine` atoms with
  their new line numbers and new hashes

## 7. Failure Modes

Failure modes:

- No matching `FileLine` atom in shared state.
  Cause: the LLM quoted a stale identity or never read that region.
  Action: assume the LLM is right and the tool is just out of sync. `read()` the relevant window to refresh shared state, then retry.  Fail if you must.
- Incomplete remembered span for range replace.
  Cause: the LLM targeted a block that crosses a gap in shared state.
  Action: `read()` the full window and retry. Fail if you must.
- Content mismatch at the live target span.
  Cause: the file was modified externally.
  Action: `read()` the full window and retry. Fail if you must.
- `CONFLICT: overlapping batch`.
  Cause: the LLM sent multiple operations that touch the same remembered
  span or require intra-batch renumbering.  
  (This happens a lot with agent swarms which trample on each other's work).
  Action (naive): Most affordable implementation is naive try with a clean fail. LLMs will reread and retry. Hopefully at some point they'll work that out.
  Action (optimal): split the work into separate edit calls. This requires some sort of out-of-process shared status. Not trivial.
- Line number out of bounds.
  Cause: the LLM hallucinated a line number, or we are out of sync.
  Action: re-read the file and retry. Fail if you must.

In all cases, the tool returns a concise error including the failing
location reference, endpoint pair, or anchor when applicable, plus the
reason. No partial edit is applied on failure. The operation is atomic per
edit call.

## 8. Edge Cases

### 8.1 Repeated identical lines

Three consecutive empty lines may still be emitted as:

```
3,NDcg|
4,Zm8x|
5,YmFy|
```

The LLM quotes `4,Zm8x` to target the middle empty line. Even though the
contents are identical, the chain hashes differ, so the target is
unambiguous.

### 8.2 Top-to-bottom edit order

The LLM may edit line 1, then line 3, then line 5. After each successful
edit it should use the fresh line numbers and fresh hashes returned by that
edit. No hidden snapshot replay should be required.

### 8.3 Sparse windows

If the LLM read line 10 and line 200 but never read lines 50 through 60,
that gap remains unknown in shared state. Editing line 55 therefore
requires a read of that window first.

If the LLM wants to replace lines 50 through 60 as one block, the whole
span must be present as remembered `FileLine` atoms. No cached span, no
range replace.

### 8.4 Multi-line replace with downstream remembered lines

A range replace that substitutes `oldCount` lines with `newCount` lines
contributes `delta = newCount - oldCount`. The tool shifts later
remembered atoms by that delta and records one `FileOffset` atom at the
boundary below the replaced span.

### 8.5 Empty file

A zero-line file produces no read output. `insert_after`, `replace_range`,
and `delete_range` therefore have no valid target line. Use
`insert_at_start` to populate the file. The successful edit response then
returns the new beginning of the file with fresh identities.

### 8.6 Overlapping reads

A later `read()` over a region simply replaces older `FileLine` atoms in
that region. This is the normal way to refresh stale identities.

## 9. Line-Count Tracking Specification

The canonical record of a count-changing edit is a `FileOffset` atom.
Every operation derives `oldCount`, `newCount`, and `delta = newCount -
oldCount` the same way. No special-case remapper is needed.

### 9.1 Count derivation per operation

Per operation:

- `replace_range`: `oldCount = inclusive span length`; `newCount = number
  of lines in payload`.
- `insert_after`: `oldCount = 0`; `newCount = number of lines in payload`.
- `delete_range`: `oldCount = inclusive span length`; `newCount = 0`.
- `insert_at_start`: `oldCount = 0`; `newCount = number of lines in
  payload`.

### 9.2 Atomicity and batching

Each call to the edit tool is atomic. Either the full batch succeeds,
updating the live file, the returned window, and `shared_state[fileName]`
together, or the call fails entirely with no side effects.

All operations in one batch are interpreted against the current live
numbering already represented by shared state before the call starts. If
one operation changes line count and a later operation is intended to use
the renumbered lines below it, issue a second `edit()` call after consuming
the first call's returned window.

Range replacement reduces the need for tightly coupled batches because a
whole contiguous block can usually be expressed as one operation.

## 10. Tool API Surface

### 10.1 Read tool (`read`)

```
Input:
    file_path (string)
    offset (int, optional)
    limit (int, optional)

Output:
    text with per-line
    {lineno},{chainHash}| prefix

State:
    upserts FileLine atoms for
    the emitted window in
    shared_state[file_path]
```

### 10.2 Edit tool (`edit`)

```
Input:
    file_path (string)
    operations (operation[])
    context_before (int, optional)
    context_after (int, optional)

Output:
    success {
        text,
        startLine,
        endLine
    }
    | error {
        type,
        start,
        end,
        reason
    }

State:
    updates shared_state[file_path]
    by replacing returned FileLine atoms
    and inserting FileOffset atoms
    when line count changes
```

Structured tool call shape:

```json
{
  "tool": "edit",
  "arguments": {
    "file_path": "targetFile.txt",
    "operations": [
      {
        "kind": "replace_range",
        "start": "3,b2e1",
        "end": "5,k9Lm",
        "content": "new line\nanother line"
      }
    ]
  }
}
```

Single-line replace example:

```json
{
  "tool": "edit",
  "arguments": {
    "file_path": "targetFile.txt",
    "operations": [
      {
        "kind": "replace_range",
        "start": "3,b2e1",
        "end": "3,b2e1",
        "content": "replacement"
      }
    ]
  }
}
```

Insert-after example:

```json
{
  "tool": "edit",
  "arguments": {
    "file_path": "targetFile.txt",
    "operations": [
      {
        "kind": "insert_after",
        "start": "8,Qz9_",
        "content": "inserted line"
      }
    ]
  }
}
```

Delete-range example:

```json
{
  "tool": "edit",
  "arguments": {
    "file_path": "targetFile.txt",
    "operations": [
      {
        "kind": "delete_range",
        "start": "12,aBcd",
        "end": "15,Qr9_"
      }
    ]
  }
}
```

Insert-at-start example:

```json
{
  "tool": "edit",
  "arguments": {
    "file_path": "targetFile.txt",
    "operations": [
      {
        "kind": "insert_at_start",
        "content": "first line"
      }
    ]
  }
}
```

Notes:

- The runtime should treat the tool call itself as structured metadata, not
  as ordinary assistant prose that happens to look tool-ish.
- `start` and `end` are anchor strings in the exact form
  `{lineno},{chainHash}`.
- `replace_range` requires `start`, `end`, and `content`.
- `delete_range` requires `start` and `end`.
- `insert_after` requires `start` and `content`.
- `insert_at_start` omits anchor fields.
- `end` is omitted when the operation has only one anchor.
- `content` is omitted for `delete_range`.
- A successful response should include a short prequel and trailer when
  available.

 
