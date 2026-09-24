import { expect, test } from '@playwright/test';

/**
 * Playwright smoke — the walking skeleton end to end against the REAL daemon
 * with a scripted fake session (demo/harness.mjs):
 *   start fake session → events render → kill → tombstone
 * plus the approval round-trip: full diff on the card, deny stops the session.
 */

test('start fake session, watch events render, kill it, land on the tombstone', async ({
  page,
}) => {
  await page.goto('/');
  const start = page.getByTestId('start-session');
  await expect(start).toBeEnabled();
  await start.click();

  // The scripted prelude runs with gaps; the ribbon badge tracks the machine.
  await expect(page.getByTestId('session-chip')).toBeVisible();
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByText('Tracing the auth bug', { exact: false })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText('ready → working', { exact: false })).toBeVisible();
  await expect(page.locator('[data-testid^="state-badge-"][data-state="working"]')).toBeVisible();

  // Blocks on approval — the card shows the FULL diff (no summary-only approvals).
  const card = page.getByTestId('approval-card');
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card.getByText('src/auth.ts', { exact: false })).toBeVisible();
  await expect(
    page.locator('[data-testid^="state-badge-"][data-state="waiting-approval"]'),
  ).toBeVisible();

  // Kill from the ribbon.
  const stop = page.getByRole('button', { name: /Stop agent-/ });
  await expect(stop).toBeEnabled();
  await stop.click();

  await expect(page.locator('[data-testid^="state-badge-"][data-state="stopped"]')).toBeVisible();
  await expect(page.getByTestId('tombstone')).toBeVisible();
  await expect(page.getByText('Session stopped')).toBeVisible();
});

test('a deny decision resolves the approval and stops the session', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('start-session').click();

  const card = page.getByTestId('approval-card');
  await expect(card).toBeVisible({ timeout: 10_000 });

  await card.getByTestId('deny-btn').click();

  await expect(page.locator('[data-testid^="state-badge-"][data-state="stopped"]')).toBeVisible();
  await expect(page.getByTestId('tombstone')).toBeVisible();
  await expect(page.getByTestId('approval-card')).toHaveCount(0);
});
