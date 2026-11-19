// The stock worker: the core with no extensions. A private layer has its own src/index.ts: `export default createApp<MyEnv>({ extensions: [mine] })`.
import { createApp } from './core/app.ts';

export { sameKey } from './core/app.ts';
export default createApp();
