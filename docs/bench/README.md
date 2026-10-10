# Benchmark runs

Each file is one `node demo/bench.mjs` run: its options, and for each strategy the totals, the final trunk and every task's outcome.

| File | Strategies | Notes |
| --- | --- | --- |
| `bench-48x16-seed1-1791634781483.json` | git (10 s redo), Spore | Spore here had one resolver fixing one record at a time: 10.9 min to settle |
| `bench-48x16-seed1-1791636700803.json` | Spore | Four resolvers, batched fixes per file: the Spore column of the README |
| `bench-48x16-seed1-1791637233390.json` | git (30 s redo) | |
