# Closeout

AI coding raises the rate of change. Scanners raise the rate of findings. The scarce part is a fix that is verified, gated, and deployed.

Closeout is that gate for one small Python service. The demo UI is the terminal.

## What you run

`advisory/advisory.json` is a local scanner export. `ADV-2026-014` is a fixture id in that file. Treat the advisory as a scanner export, not an NVD CVE.

```bash
npm install
npm test
npm run demo
```

`npm run demo` reads the advisory and handles two findings.

`widget` is pinned at 1.2.0, and the fixed version is 1.4.0. Only `scripts/dev_check.py` imports it. Policy writes the pin into `requirements-dev.txt`. No model runs. When `oracle/test_pin.py` passes, Ansible copies the tree to `var/runtime/current`, starts the server, probes `http://127.0.0.1:8765/health`, and writes evidence to `artifacts/release/closeout-sample/pin-ADV-2026-014/evidence.json`. The log reader in that process is still the vulnerable one.

`src/logview.py` function `read_log` joins a caller-supplied name onto the log directory and opens it. `src/server.py` imports that function. The advisory names the file and the symbol, and it does not name a patch. Policy sends the file to a Cursor agent. With no `CURSOR_API_KEY`, the demo stops this finding at `triaged` and tells you how to run the agent.

Re-running `npm run demo` deletes `var/worktree` and starts again from the one commit that adds the vulnerable reader.

## The agent

Create a personal key at https://cursor.com/dashboard/integrations and export it. A company account may refuse `composer-2.5`. Set `CURSOR_MODEL` to a model that account can run. The gate tests do not need a key.

```bash
export CURSOR_API_KEY="cursor_..."
npm run demo
npm run follow-up -- "also reject absolute paths"
npm run release
```

`npm run demo` still applies the pin with policy. For the code defect it calls the local agent, then holds the result when `oracle/test_traversal.py` passes. That oracle checks `..` escapes only.

`npm run follow-up` resumes the saved agent with the sentence you pass. The default sentence is `also reject absolute paths`. `oracle/test_absolute.py` is outside the worktree and checks absolute paths. A pass stays at `held`.

`npm run release` deploys the held tree. Evidence records the local user as the releaser, plus the agent id, run id, oracle result, diff hash, and Ansible result.

`npm run rollback` runs `deploy/rollback.yml` and restores the previous tree. The first deploy has nothing to restore. Rollback applies after a later deploy replaces that tree.

## Where it starts

`src/agent.ts` is the only file that imports `@cursor/sdk`.

It uses the local runtime, model `composer-2.5` unless `CURSOR_MODEL` is set, and `settingSources: []`. It streams the run, waits for the result, saves the agent id, and calls `Agent.resume` for the follow-up. A thrown `CursorAgentError` means the run never started. A result status of `error` means the run started and failed.

The agent cwd is `var/worktree`, a git worktree of the sample service, not this repository. After the run, a change outside `src/logview.py` rejects the run. A new commit rejects the run. The prompt tells the agent not to commit and not to add dependencies. Oracles live in `oracle/` and load the worktree by path.

`src/run.ts` takes ports for the agent, the oracle, the store, and the deployer. Unit tests pass fakes. `npm test` covers the gate without a key.

## Tradeoffs

Policy calls the model only when the advisory cannot name the patch. A known pin is a text edit.

Hold is mandatory for a runtime code change. `npm run release` is the release.

`src/store.ts` writes `artifacts/release/<name>/<version>/` and `evidence.json` (finding ids, disposition, agent id, run id, oracle result, diff hash, who released, Ansible result). Set `ARTIFACTORY_URL` and the same client PUTs those files to that base URL. Use `ARTIFACTORY_TOKEN` when the server requires a bearer token. Leave Docker stopped. `compose.yaml` is there when you want Artifactory, and the setup wizard is a separate session from this demo.

The follow-up resumes one local agent. That is the conversation you can point at.

## Sample

`sample/` uses the Python standard library. `scripts/dev_check.py` prints the pinned version. The demo never calls `load_pinned_package()`, so the `widget` package stays uninstalled.

Phases are `ingested`, `triaged`, `patching`, `oracle`, `held`, `releasing`, `deployed`, and `rejected`. Dispositions are `apply-known-upgrade`, `send-to-agent`, and `refuse`.
