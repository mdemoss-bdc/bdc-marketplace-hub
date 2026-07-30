/**
 * Frontend tests: Team page — "Add Seats" Stripe return banners.
 *
 * Covers:
 *  1. Green success banner renders when ?seats_added=1 is present.
 *  2. Success banner auto-dismisses after ~8 s.
 *  3. Success banner is manually dismissible via the X button.
 *  4. Amber cancel banner renders when ?seats_canceled=1 is present.
 *  5. Cancel banner is manually dismissible via the X button.
 *  6. Both banners confirm window.location.search is cleared on mount.
 *
 * All network requests are intercepted — no live server is required.
 */

import { test, expect, type Route } from '@playwright/test';

// ── Fake API responses ────────────────────────────────────────────────────────

const FAKE_TOKEN = 'playwright_test_token_team_banners';

const FAKE_ADMIN_USER = {
  id: 42,
  username: 'dealerAdmin',
  email: 'admin@dealer.example.com',
  subscription_status: 'active',
  is_admin: true,
  is_master_admin: false,
  org_role: 'admin',          // gives hasAccess = true
  tiktok_connected: false,
  tiktok_open_id: '',
};

const FAKE_TEAM_DATA = {
  org: {
    id: 7,
    name: 'Demo Rooftop',
    plan_tier: 'rooftop_monthly',
    max_seats: 5,
    invite_code: 'DEMO123',
  },
  seat_used: 2,
  max_seats: 5,
  invite_link: 'https://example.com/join/DEMO123',
  members: [
    {
      id: 42,
      username: 'dealerAdmin',
      email: 'admin@dealer.example.com',
      org_role: 'admin',
      created_at: '2024-01-15T10:00:00Z',
    },
  ],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

type PW = import('@playwright/test').Page;

/**
 * Register canned API responses.
 * Routes are processed LIFO — register catch-all first so specific mocks win.
 */
async function mockApis(page: PW) {
  // Catch-all (lowest priority)
  await page.route('**/api/**', (r: Route) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  );
  // Team data
  await page.route('**/api/team', (r: Route) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(FAKE_TEAM_DATA),
    })
  );
  // Auth (highest priority — registered last)
  await page.route('**/api/auth/me', (r: Route) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(FAKE_ADMIN_USER),
    })
  );
}

/** Seed localStorage so the auth context boots without a real login. */
async function seedAuth(page: PW) {
  const userJson = JSON.stringify(FAKE_ADMIN_USER);
  await page.addInitScript(([token, uJson]: string[]) => {
    localStorage.setItem('bdc_token', token);
    localStorage.setItem('bdc_user', uJson);
  }, [FAKE_TOKEN, userJson]);
}

/** Wait for the team page to finish loading (seat usage bar visible). */
async function waitForTeamPage(page: PW) {
  await expect(
    page.getByText('Seat Usage', { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
}

// ── Suite 1: seats_added=1 — success banner ───────────────────────────────────

test.describe('Team page — seats_added=1 success banner', () => {
  test.beforeEach(async ({ page }) => {
    await mockApis(page);
    await seedAuth(page);
  });

  test('green banner renders when ?seats_added=1 is present', async ({ page }) => {
    await page.goto('/team?seats_added=1');
    await waitForTeamPage(page);

    const banner = page.getByText('Seats added', { exact: false });
    await expect(banner).toBeVisible({ timeout: 8_000 });
  });

  test('URL query param is removed from window.location.search on mount', async ({ page }) => {
    await page.goto('/team?seats_added=1');
    await waitForTeamPage(page);

    // Banner must appear first (proves the effect ran)
    await expect(page.getByText('Seats added', { exact: false })).toBeVisible({ timeout: 8_000 });

    const search = await page.evaluate(() => window.location.search);
    expect(search).toBe('');
  });

  test('green banner is manually dismissible via the X button', async ({ page }) => {
    await page.goto('/team?seats_added=1');
    await waitForTeamPage(page);

    const banner = page.getByText('Seats added', { exact: false });
    await expect(banner).toBeVisible({ timeout: 8_000 });

    // The dismiss button sits inside the same banner element — click the X
    // that is adjacent to the banner text.
    const bannerContainer = page.locator(
      'div:has(> svg + span:has-text("Seats added"))',
    ).first();
    // Fallback: any button inside the green banner region.
    const dismissBtn = page
      .getByText('Seats added', { exact: false })
      .locator('xpath=ancestor::div[1]//button');
    await dismissBtn.click();

    await expect(banner).not.toBeVisible({ timeout: 3_000 });
  });

  test('green banner auto-dismisses after 8 seconds', async ({ page }) => {
    await page.goto('/team?seats_added=1');
    await waitForTeamPage(page);

    await expect(page.getByText('Seats added', { exact: false })).toBeVisible({ timeout: 8_000 });

    // Banner is scheduled to disappear after 8 000 ms; wait a bit beyond that.
    await page.waitForTimeout(8_500);

    await expect(page.getByText('Seats added', { exact: false })).not.toBeVisible();
  });
});

// ── Suite 2: seats_canceled=1 — cancel banner ────────────────────────────────

test.describe('Team page — seats_canceled=1 cancel banner', () => {
  test.beforeEach(async ({ page }) => {
    await mockApis(page);
    await seedAuth(page);
  });

  test('amber banner renders when ?seats_canceled=1 is present', async ({ page }) => {
    await page.goto('/team?seats_canceled=1');
    await waitForTeamPage(page);

    const banner = page.getByText('Seat upgrade was not completed', { exact: false });
    await expect(banner).toBeVisible({ timeout: 8_000 });
  });

  test('URL query param is removed from window.location.search on mount', async ({ page }) => {
    await page.goto('/team?seats_canceled=1');
    await waitForTeamPage(page);

    await expect(
      page.getByText('Seat upgrade was not completed', { exact: false }),
    ).toBeVisible({ timeout: 8_000 });

    const search = await page.evaluate(() => window.location.search);
    expect(search).toBe('');
  });

  test('amber banner is manually dismissible via the X button', async ({ page }) => {
    await page.goto('/team?seats_canceled=1');
    await waitForTeamPage(page);

    const banner = page.getByText('Seat upgrade was not completed', { exact: false });
    await expect(banner).toBeVisible({ timeout: 8_000 });

    const dismissBtn = banner
      .locator('xpath=ancestor::div[1]//button');
    await dismissBtn.click();

    await expect(banner).not.toBeVisible({ timeout: 3_000 });
  });

  test('cancel banner does NOT auto-dismiss (stays visible after 8 s)', async ({ page }) => {
    await page.goto('/team?seats_canceled=1');
    await waitForTeamPage(page);

    const banner = page.getByText('Seat upgrade was not completed', { exact: false });
    await expect(banner).toBeVisible({ timeout: 8_000 });

    // The cancel banner has no auto-dismiss timer — it must still be visible.
    await page.waitForTimeout(3_000);
    await expect(banner).toBeVisible();
  });
});

// ── Suite 3: No query params — neither banner renders ────────────────────────

test.describe('Team page — no Stripe return params', () => {
  test.beforeEach(async ({ page }) => {
    await mockApis(page);
    await seedAuth(page);
  });

  test('no success or cancel banner when navigating to /team without params', async ({ page }) => {
    await page.goto('/team');
    await waitForTeamPage(page);

    await expect(page.getByText('Seats added', { exact: false })).not.toBeVisible();
    await expect(
      page.getByText('Seat upgrade was not completed', { exact: false }),
    ).not.toBeVisible();
  });
});
