import { expect, test } from '@playwright/test';

/**
 * Onboarding e2e — CLI detection through the REAL daemon gateway, with the
 * harness control route (POST /demo/detect-fixtures) swapping the detect
 * source between deterministic states: missing-CLI and missing-auth, without
 * touching a real CLI. The wizard must show status + guided commands and
 * never anything credential-shaped.
 */

const CONTROL = process.env.VITE_DEMO_CONTROL_URL ?? 'http://127.0.0.1:8788';

type DetectFixtureMode = 'off' | 'missing-cli' | 'missing-auth' | 'ready';

async function setDetectFixture(mode: DetectFixtureMode): Promise<void> {
  const response = await fetch(`${CONTROL}/demo/detect-fixtures`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  if (!response.ok) {
    throw new Error(`detect fixture ${mode} failed: HTTP ${response.status}`);
  }
}

// Leave the daemon with the real probes so the smoke spec stays honest.
test.afterEach(async () => {
  await setDetectFixture('off');
});

test('missing-CLI: the wizard guides installation for both connectors', async ({ page }) => {
  await setDetectFixture('missing-cli');
  await page.goto('/');

  await page.getByTestId('open-onboarding').click();
  const pane = page.getByTestId('onboarding-pane');
  await expect(pane).toBeVisible();

  const claude = page.getByTestId('onboarding-row-claude-code');
  await expect(claude).toContainText('not installed');
  await expect(claude).toContainText('npm install -g @anthropic-ai/claude-code');
  const codex = page.getByTestId('onboarding-row-codex');
  await expect(codex).toContainText('not installed');
  await expect(codex).toContainText('npm install -g @openai/codex');

  // Guided install, not a daemon-side install: no install happens from here.
  await expect(claude.getByTestId('copy-claude-code-install')).toBeVisible();
  await expect(page.getByTestId('onboarding-error')).toHaveCount(0);
});

test('missing-auth: the wizard guides login and shows no credentials', async ({ page }) => {
  await setDetectFixture('missing-auth');
  await page.goto('/');

  await page.getByTestId('open-onboarding').click();
  const pane = page.getByTestId('onboarding-pane');
  await expect(pane).toBeVisible();

  await expect(page.getByTestId('onboarding-auth-claude-code')).toContainText('Not logged in');
  await expect(page.getByTestId('onboarding-auth-codex')).toContainText('Not logged in');
  await expect(page.getByTestId('onboarding-row-claude-code')).toContainText('claude auth login');
  await expect(page.getByTestId('onboarding-row-codex')).toContainText('codex login');

  // Status only: nothing credential-shaped is ever rendered.
  const paneText = (await pane.innerText()).toLowerCase();
  expect(paneText).not.toContain('token');
  expect(paneText).not.toMatch(/sk-/);
});

test('re-check picks up a changed state after the fixture flips', async ({ page }) => {
  await setDetectFixture('missing-auth');
  await page.goto('/');
  await page.getByTestId('open-onboarding').click();
  await expect(page.getByTestId('onboarding-auth-codex')).toContainText('Not logged in');

  await setDetectFixture('ready');
  await page.getByTestId('onboarding-recheck').click();
  await expect(page.getByTestId('onboarding-auth-codex')).toContainText('Subscription');
  await expect(page.getByTestId('onboarding-auth-claude-code')).toContainText('Logged in');
  // Logged-in rows show no login step.
  await expect(page.getByTestId('copy-codex-login')).toHaveCount(0);
});
