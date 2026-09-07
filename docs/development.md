# Development, Studio, and demo

## Build and test the package

From the repository root:

```bash
npm install
npm run build
npm test
```

`npm run build` writes compiled JavaScript and type declarations to `dist/`.
`npm test` builds first and then runs the compiled Node.js test files.

For continuous TypeScript compilation:

```bash
npm run watch
```

The package requires Node.js 18 or newer.

## Run Studio from this repository

Studio is a standalone browser CMS for authoring the same
`ProjectLibrary` / `Workflow` JSON that the engine compiles. It does not
change the engine or store API keys.

Start it with:

```bash
npm run studio
```

Then open [http://127.0.0.1:4174](http://127.0.0.1:4174).

Studio writes:

```text
.localminds/library.json
.localminds/workflows/<slug>.json
```

`library.json` contains instructions, agents, skills, and prompts. Each workflow
is saved separately under `workflows/`. Load the library and the selected
workflow together as a `ProjectLibrary` before passing them to
`compileWorkflow` or `GraphExecutor`.

Select a skill or workflow and click **Run** to preview it in Studio. The
server wraps a skill as a one-step workflow and drives `GraphExecutor`. If
Ollama is running at `127.0.0.1:11434`, Studio uses it; otherwise it uses a
mock host. Pass `--mock` (or `LOCALMINDS_STUDIO_MOCK=1`) to force the mock.
Studio never applies file operations or runs shell commands.

## Run Studio from another repository

Install the package in the target repository:

```bash
npm install @localminds/workflow
npx localminds-workflow --root .
```

Or run it without adding the package to the target repository:

```bash
npx --yes --package=@localminds/workflow localminds-workflow --root /path/to/repo
```

## Run the browser demo

The repository includes a mock host and browser UI that exercise the real
compiler and executor. It runs this sample graph:

```text
plan → parallel web + repo → join → review
```

Start it with:

```bash
npm run demo
```

Then open [http://127.0.0.1:4173](http://127.0.0.1:4173) and click **Run
graph**. Toggle **Offline** to skip the mock web-search tool.

The demo uses mock services only. It does not call a real model, modify files,
run terminal commands, or access the public web.
