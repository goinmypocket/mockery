import { expect, it } from "vitest";
import { listStrategies } from "../shared/botStrategies";
import { STRATEGIES } from "../server/bots/registry";

it("keeps the browser catalogue complete and in sync with executable strategies", () => {
  expect(listStrategies()).toEqual(Object.values(STRATEGIES).map((strategy) => ({
    id: strategy.id,
    displayName: strategy.displayName,
    description: strategy.description ?? null,
    tags: strategy.tags ?? [],
    category: strategy.category ?? null,
    paramsSchema: strategy.paramsSchema ?? null,
    defaultProfileDistributions: strategy.defaultProfileDistributions ?? null,
  })));
});
