import { createApp } from './app';

async function main() {
  process.env.LOOP_RUNNER ??= '1';
  const app = await createApp();
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, '127.0.0.1');
  console.log(`Loop API ready at http://127.0.0.1:${port}/api`);
}
void main();
