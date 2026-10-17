import { createServer } from "node:http"
import { createApp } from "./app.js"

const port = Number(process.env.PORT ?? 3000)
const app = createApp()
const server = createServer(app)
server.listen(port, "0.0.0.0", () => console.log(`Circuits workbench listening on ${port}`))

const shutdown = () => {
  server.close(() => {
    const service = app.locals.projectService as { close: () => Promise<void> }
    void service.close().finally(() => process.exit(0))
  })
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
