import { expect, it } from 'vitest';
import { Budget, createScriptedProvider, type Turn } from '../src/providers.ts';

it('enforces total token and dollar reservations and accounts every model turn', () => {
  const budget = new Budget(0.001, { inPerM: 1, outPerM: 2 }, 100);
  expect(budget.canAfford(80, 20)).toBe(true);
  budget.add({ inputTokens: 40, outputTokens: 10 });
  expect(budget.canAfford(40, 10)).toBe(true);
  expect(budget.canAfford(41, 10)).toBe(false);
  expect(budget.calls).toBe(1);
  expect(budget.spentUsd).toBeCloseTo(0.00006);
  expect(new Budget(0.00001, { inPerM: 1, outPerM: 2 }).canAfford(10, 1)).toBe(false);
});

it('scripted providers have independent scripts, token accounting, and recorded tool feedback', async () => {
  const turns: Turn[] = [{ text: '', toolCalls: [{ id: 'one', name: 'game_briefing', args: {} }], usage: { inputTokens: 7, outputTokens: 2 } }];
  const first = createScriptedProvider(turns);
  const second = createScriptedProvider(turns);
  first.addUser('Begin');
  expect(first.estimateInputTokens()).toBe(7);
  expect(await first.turn()).toEqual(turns[0]);
  first.addToolResults([{ id: 'one', output: '{}', isError: false }]);
  expect(first.results).toHaveLength(1);
  expect(first.users).toEqual(['Begin']);
  expect((await first.turn()).toolCalls).toEqual([]);
  expect(await second.turn()).toEqual(turns[0]);
  const controller = new AbortController();
  controller.abort();
  await expect(second.turn(controller.signal)).rejects.toThrow();
});
