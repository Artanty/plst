Personal knowledge library at /Users/artyomantoshkin/server/know — plain files, index + entries, no discovery layer (user's choices).

**Structure to create**

```
/Users/artyomantoshkin/server/know/
  README.md            # the main document: usage note + index of links to entries
  entries/
    _template.md       # copy-me template for every new entry
    deploy-slave.md    # first entry, skeleton with sections to fill
```

**Steps**

1. Per AGENTS.md rule 1 — append a PLAN entry to `plst/DECISIONS.md` describing this (matching the existing house style: Request / Approach).
2. Create `know/README.md`:
   - What it is: one file per knowledge case in `entries/`; this README is the index.
   - Usage from any project, with exact phrasings to copy: "read /Users/artyomantoshkin/server/know/entries/deploy-slave.md and …" or "look up <topic> in /Users/artyomantoshkin/server/know/README.md first".
   - How to add an entry: copy `entries/_template.md`, filename = slug (kebab-case), add one line to the index.
   - Index section: one line per entry — `[deploy-slave](entries/deploy-slave.md) — <one-line description>`.
3. Create `entries/_template.md`: `# Title`, `When to use:` line first (so any agent reading it immediately knows relevance), then Context / Steps·facts / Gotchas / Related links. Plain markdown, no frontmatter — stays portable across agent tools.
4. Create `entries/deploy-slave.md`: skeleton only — Goal, Prerequisites, Steps, Verification, Gotchas — with clearly marked `<fill in>` placeholders and no invented facts (the real content about deploying the slave comes from you).
5. Verify: `ls -R` the new folder, read the files back to confirm they render as intended.
6. Per AGENTS.md rule 2 — append the RESULT entry to `plst/DECISIONS.md`. Nothing committed (rule 5); `know/` is outside the plst repo and gets no git setup unless you ask later.

**Deliberately not done (documented as future upgrades, no restructuring needed):** a `know@slug` convention line in `~/.zcode/AGENTS.md`, a launcher skill, or per-entry skills — all can be layered on later if explicit path references get tiresome.