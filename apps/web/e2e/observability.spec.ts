import { expect, test } from '@playwright/test';
import path from 'node:path';

/**
 * Observability e2e — the three deliverables against the REAL daemon with the
 * scripted demo session (demo/harness.mjs):
 *   1. the divergence pane renders (the harness carries no git worktrees, so
 *      the honest empty state is what a browser can show; populated rows are
 *      covered by the daemon's scripted-repo tests),
 *   2. the usage rollup pane stays empty until turns complete, then shows the
 *      session x UTC-day row after the resumption's usage event,
 *   3. attention states: the chip reads needs-approval while blocked, then
 *      flips to done once the turn completes.
 *
 * Screenshots land in OBSERVABILITY_EVIDENCE_DIR (outside the checkout) for QA
 * upload; the assertions are the durable checks.
 */

const EVIDENCE = process.env.OBSERVABILITY_EVIDENCE_DIR ?? '/home/user/work/evidence';

// Video for the approval interaction (saved by the attention test below).
// Top-level: video in a describe group forces a new worker.
test.use({ video: { mode: 'on', size: { width: 1440, height: 900 } } });

/** Starts a fresh demo session and waits for the scripted waiting-approval block. */
async function startBlockedSession(page: import('@playwright/test').Page): Promise<string> {
  await page.goto('/');
  await page.getByTestId('start-session').click();
  const badge = page.locator('[data-testid^="state-badge-"]');
  await expect(badge).toHaveAttribute('data-state', 'waiting-approval', { timeout: 10_000 });
  // The chip's badge testid carries the session id — extract it for row lookups.
  const badgeTestId = (await badge.getAttribute('data-testid')) ?? '';
  return badgeTestId.replace('state-badge-', '');
}

test('divergence pane renders with the harness empty state', async ({ page }) => {
  await page.goto('/');
  const pane = page.getByTestId('divergence-pane');
  await expect(pane).toBeVisible();
  // Demo sessions carry no git worktrees — the pane says so instead of faking rows.
  await expect(pane.getByText('No agent worktrees yet')).toBeVisible({ timeout: 10_000 });
  await pane.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(EVIDENCE, 'tc-1-divergence.png'), fullPage: true });
});

test('usage rollups: empty before turns complete, session x day row after', async ({ page }) => {
  const sessionId = await startBlockedSession(page);

  const pane = page.getByTestId('usage-pane');
  await expect(pane).toBeVisible();
  await expect(pane.getByText('No usage journaled yet')).toBeVisible();
  await pane.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(EVIDENCE, 'tc-2-before.png'), fullPage: true });

  // Approve — the resumption turn completes and journals one usage event
  // (1,234 in / 567 out). The pane reads the journal on refresh.
  await page.getByTestId('approval-card').getByTestId('approve-btn').click();
  await expect(page.locator('[data-testid^="state-badge-"]')).toHaveAttribute(
    'data-attention',
    'idle-done',
    { timeout: 10_000 },
  );
  await pane.getByRole('button', { name: 'Refresh' }).click();

  const row = pane.locator('tbody tr', { hasText: sessionId });
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row).toContainText('1,234');
  await expect(row).toContainText('567');
  await pane.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(EVIDENCE, 'tc-2-after.png'), fullPage: true });
});

test.describe('attention states on the ribbon chip', () => {
  test('chip rings needs-approval while blocked, then reads done', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('start-session').click();

    const chip = page.getByTestId('session-chip');
    const badge = page.locator('[data-testid^="state-badge-"]');

    // Working first (no attention), then blocked — needs-approval with the label.
    await expect(badge).toHaveAttribute('data-state', 'working', { timeout: 10_000 });
    await expect(badge).toHaveAttribute('data-attention', 'none');
    await expect(badge).toHaveAttribute('data-state', 'waiting-approval', { timeout: 10_000 });
    await expect(chip).toHaveAttribute('data-attention', 'needs-approval');
    await expect(badge).toHaveText('needs approval');
    await page.screenshot({ path: path.join(EVIDENCE, 'tc-3-before.png'), fullPage: false });

    await page.getByTestId('approval-card').getByTestId('approve-btn').click();

    await expect(badge).toHaveAttribute('data-state', 'ready', { timeout: 10_000 });
    await expect(chip).toHaveAttribute('data-attention', 'idle-done');
    await expect(badge).toHaveText('done');
    await page.screenshot({ path: path.join(EVIDENCE, 'tc-3-after.png'), fullPage: false });
    // The video is saved by Playwright's runner (test-results/**/video.webm) and
    // copied to the evidence dir after the run — saveAs mid-test deadlocks.
  });
});
