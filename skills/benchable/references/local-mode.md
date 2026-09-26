# Local mode

Local mode is for when there's no account or no network. It uses the same parser and the same
statistics as the cloud, on the filesystem.

```
.benchable/
  config.json                          {"mode":"local"}, or {"url","project"} after login
  runs/20260923T101500Z-baseline.json  one run: the native payload the API accepts
  artifacts/20260923T101500Z-baseline/ files attached with --artifact
  sync.json                            which runs are already in which cloud project
```

- Run files are written once and never edited. Each carries an `idempotencyKey` that is fixed
  when it is recorded.
- **Verdict.** The baseline is the latest earlier run on the same branch (else any earlier run),
  or the one you name with `--baseline <stem-or-label>`. The band is ±5%. The tests are
  Mann–Whitney when both runs have raw samples (hyperfine's `times`, go `-count`, criterion) and
  Welch's t when they have mean, stddev and n. The cloud adds a noise band learned per metric
  and false-discovery control, which local mode does not.
- There is no local chart. For charts, run `benchable local sync`, or point the app's local
  watch at `.benchable/runs/`.
- Whether to commit `.benchable/` is the user's call. The files contain no secrets unless someone
  puts a `key` in `config.json`.

## Moving to the cloud

Moving to the cloud loses nothing and duplicates nothing:

1. `benchable login` (writes `url` and `project` to `config.json`, and drops `"mode": "local"`).
2. `benchable local sync` uploads runs oldest first, with their artifacts. Run it again and it
   uploads nothing.

As an alternative, you can point the runs page's **local watch** at `.benchable/runs/`. It imports
the same files under the same idempotency keys, so mixing it with `local sync` still yields one
run per file. Local watch does not upload artifacts, so `local sync` is the lossless path.
