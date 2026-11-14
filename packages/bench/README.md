# @playerthree/bench

Reproducible model benchmarks and deterministic bot and policy balance sweeps for
[PlayerThree](https://playerthree.gg) games.

```sh
npm i -D @playerthree/bench
npx playerthree-bench --config ./bench.config.ts --out ./bench-results
```

Node.js 24 or later. The config module default-exports a `BenchConfig` (or an array of them); each freezes an
explicit `SeriesSpec`. Outputs are `playerthree.results` JSON, table CSVs and authorized replay artifacts. Model
keys come from environment variables; failed series or guardrails exit non-zero.

| Import | |
|---|---|
| `@playerthree/bench` | `runBench`, `loadBenchConfig`, guardrails (`evaluateGuardrails`, `binomialTwoSided`), campaigns |
| `@playerthree/bench/series` | `createSeriesRunner`: scheduling across maps, seeds and side permutations, retries, standings |
| `@playerthree/bench/campaign` | fixed-reference benchmark campaigns: independent policy authoring per replicate, series evaluation, publication export |
| `@playerthree/bench/source-digest` | `benchmarkSourceDigest` |
| `@playerthree/bench/opencode` | `openCodeHarness`: OpenCode as a campaign's authoring harness, metered through a loopback proxy |
| `@playerthree/bench/model-catalog` | an allowlisted projection of the OpenRouter models list for configuration discovery |

The [CLI guide](https://playerthree.gg/guides/cli/) documents tracks, campaigns and every flag.

## License

Apache-2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
