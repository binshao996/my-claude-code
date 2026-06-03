#!/usr/bin/env bun

import { PRODUCT_NAME, VERSION } from "../constants";

async function bootstrap(): Promise<void> {
  const args = process.argv.slice(2);

  if (
    args.length === 1 &&
    (args[0] === "--version" || args[0] === "-v" || args[0] === "-V")
  ) {
    console.log(`${VERSION} (${PRODUCT_NAME})`);
    return;
  }

  const { main } = await import("../main");
  await main();
}

await bootstrap();
