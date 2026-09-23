# Reading and explaining a verdict

Every metric gets one of three verdicts:

- **improved**, or **regressed**: the change cleared the noise band and, where a test could run,
  was significant (p < 0.05).
- **neutral**: it moved less than the band, the test said it was not significant (the reason
  says so), or it is the first run.

How to explain it to the user:

1. Lead with the answer: "Parsing got 38% faster (14.6 ms → 9.0 ms). Mann–Whitney p < 0.001
   over 30 runs each."
2. Name every metric that moved, with its size and direction. Say what was unchanged in one
   clause.
3. Give the confidence honestly:
   - `mann-whitney p=…`: compared the raw samples. This is the strongest evidence.
   - `welch p=…`: compared mean, stddev and n.
   - `—` with "moved more than the ±5% noise band": no distribution was available, so this is a
     threshold call, not a test. Suggest more runs (`--runs 30`, `-count 10`).
   - `ns` / "not significant": the difference could be noise. Don't claim it.
4. Flag caveats that the output mentions: a baseline from another environment, or budget
   failures.
5. Link the run (`view:` URL) or `report.html`.

Never round a regression away, and never call a non-significant move an improvement. If the
numbers are noisy (a stddev near the effect size), say so and propose a quieter measurement:
`-N`, warmups, a pinned CPU, closed apps.
