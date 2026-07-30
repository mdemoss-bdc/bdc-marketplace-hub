import app from "./app";
import { logger } from "./lib/logger";

// 8080 is reserved for the Python BDC engine, so this Express service defaults
// to the standard Node port instead.
const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "0.0.0.0";

const rawPort = process.env["PORT"];
const port = rawPort ? Number(rawPort) : DEFAULT_PORT;

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const host = process.env["HOST"] || DEFAULT_HOST;

app.listen(port, host, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ host, port }, "Server listening");
});
