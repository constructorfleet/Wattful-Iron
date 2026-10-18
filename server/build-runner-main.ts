import { startBuildRunnerServer } from "./build-runner.js"

void startBuildRunnerServer().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
