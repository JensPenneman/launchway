// Container HEALTHCHECK entrypoint: exits 0 while the agent process keeps reporting in.
import { isAlive } from './liveness.js';

process.exit((await isAlive()) ? 0 : 1);
