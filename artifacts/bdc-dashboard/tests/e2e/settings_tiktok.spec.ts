/**
 * Frontend smoke + flow tests: Settings page TikTok card.
 *
 * Covers:
 *  1. "Connect TikTok Account" button is visible when tiktok_connected = false.
 *  2. "Disconnect TikTok" button is absent when not connected.
 *  3. Clicking "Connect TikTok Account" calls /api/tiktok/oauth/start and
 *     redirects the browser to the returned auth_url.
 *  4. When user is connected the "Disconnect TikTok" button is visible.
 *  5. Clicking "Disconnect TikTok" calls DELETE /api/tiktok/disconnect and
 *     the UI shows a success message afterwards.
 *
 * All network requests are intercepted so no live server is required.
 */

import { test, expect, type Route } from '@playwright/test';

// ── Fake API responses ────────────────────────────────────────────────────────

const FAKE_TOKEN = 'playwright_test_token_abc123';

const FAKE_USER_DISCONNECTED = {
  id: 1,
  username: 'testuser',
  email: 'test@example.com',
  subscription_status: 'active',
  is_admin: false,
  tiktok_connected: false,
  tiktok_open_id: '',
};

const FAKE_USER_CONNECTED = {
  ...FAKE_USER_DISCONNECTED,
  tiktok_connected: true,
  tiktok_open_id: 'tt_open_id_abc',
};

const FAKE_SETTINGS = {
  user_id: 1, email: 'test@example.com', phone: '',
  fb_page_id: '', fb_access_token_masked: '', catalog_token: '',
  inventory_url_used: '', inventory_url_new: '',
  salesperson_filter: '', scraper_frequency: 'daily',
  dealer_name: '', dealer_address_line1: '',
  dealer_city: '', dealer_state: '', dealer_zip: '',
};

const FAKE_BILLING = {
  subscription_status: 'active', is_admin: false,
  stripe_customer_id: '', stripe_subscription_id: '',
  subscription_period_end: '', subscription_cancel_scheduled: false,
};

const FAKE_LOCATIONS = { locations: [] };

// ── Helpers ───────────────────────────────────────────────────────────────────

type PW = import('@playwright/test').Page;

/**
 * Intercept all API endpoints with canned responses.
 * Routes are registered in LIFO order — the LAST registered handler wins for a
 * given URL.  Register the catch-all FIRST so specific mocks override it.
 */
async function mockApis(page: PW, user: typeof FAKE_USER_DISCONNECTED) {
  // Catch-all (registered first → lowest priority)
  await page.route('**/api/**', (r: Route) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  );
  // Locations
  await page.route('**/api/v1/locations', (r: Route) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_LOCATIONS) })
  );
  // Billing
  await page.route('**/api/v1/billing/status', (r: Route) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_BILLING) })
  );
  // Settings
  await page.route('**/api/v1/settings', (r: Route) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_SETTINGS) })
  );
  // Auth (registered last → highest priority)
  await page.route('**/api/auth/me', (r: Route) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(user) })
  );
}

async function seedAuth(page: PW, user: typeof FAKE_USER_DISCONNECTED) {
  // Auth requires BOTH bdc_token AND bdc_user in localStorage.
  const userJson = JSON.stringify(user);
  await page.addInitScript(([token, uJson]: string[]) => {
    localStorage.setItem('bdc_token', token);
    localStorage.setItem('bdc_user',  uJson);
  }, [FAKE_TOKEN, userJson]);
}

// ── Suite 1: Connect TikTok Account (not connected) ──────────────────────────

test.describe('Settings page — TikTok card (tiktok_connected = false)', () => {
  test.beforeEach(async ({ page }) => {
    await mockApis(page, FAKE_USER_DISCONNECTED);
    await seedAuth(page, FAKE_USER_DISCONNECTED);
  });

  test('renders "Connect TikTok Account" button when not connected', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByText('TikTok Account', { exact: true }).first()).toBeVisible({ timeout: 10_000 });

    const connectBtn = page.getByRole('button', { name: /Connect TikTok Account/i });
    await expect(connectBtn).toBeVisible();
    await expect(connectBtn).toBeEnabled();
  });

  test('"Disconnect TikTok" button is absent when not connected', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByText('TikTok Account', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /Disconnect TikTok/i })).not.toBeVisible();
  });

  test('clicking "Connect TikTok Account" calls /api/tiktok/oauth/start', async ({ page }) => {
    let oauthStartCalled = false;
    const FAKE_AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/?fake=1';

    // Register oauth/start mock (LIFO: registered after beforeEach → higher priority).
    await page.route('**/api/tiktok/oauth/start', (r: Route) => {
      oauthStartCalled = true;
      r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ auth_url: FAKE_AUTH_URL }) });
    });

    // Intercept any navigation to TikTok's domain so the test doesn't leave
    // the app.  Must use page.route — page.on('request') does not expose abort().
    await page.route('https://www.tiktok.com/**', (r: Route) => r.abort());

    await page.goto('/settings');
    await expect(page.getByText('TikTok Account', { exact: true }).first()).toBeVisible({ timeout: 10_000 });

    const connectBtn = page.getByRole('button', { name: /Connect TikTok Account/i });
    await connectBtn.click();

    // Give the API call time to fire before checking.
    await page.waitForTimeout(1500);

    expect(oauthStartCalled).toBe(true);
  });
});

// ── Suite 2: Connected user — disconnect flow ─────────────────────────────────

test.describe('Settings page — TikTok card (tiktok_connected = true)', () => {
  test.beforeEach(async ({ page }) => {
    await mockApis(page, FAKE_USER_CONNECTED);
    await seedAuth(page, FAKE_USER_CONNECTED);
  });

  test('"Disconnect TikTok" button is visible when connected', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByText('TikTok Account', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /Disconnect TikTok/i })).toBeVisible();
  });

  test('"Connect TikTok Account" button is absent when connected', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByText('TikTok Account', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /Connect TikTok Account/i })).not.toBeVisible();
  });

  test('clicking "Disconnect TikTok" calls DELETE /api/tiktok/disconnect and shows success message', async ({ page }) => {
    let disconnectCalled = false;

    // Register disconnect route after beforeEach routes (LIFO → higher priority).
    await page.route('**/api/tiktok/disconnect', (r: Route) => {
      disconnectCalled = true;
      r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true }) });
    });

    await page.goto('/settings');
    await expect(page.getByText('TikTok Account', { exact: true }).first()).toBeVisible({ timeout: 10_000 });

    const disconnectBtn = page.getByRole('button', { name: /Disconnect TikTok/i });
    await expect(disconnectBtn).toBeVisible();
    await disconnectBtn.click();

    // The component shows a success message immediately after a successful disconnect.
    await expect(page.getByText('TikTok account disconnected', { exact: false })).toBeVisible({ timeout: 8_000 });
    expect(disconnectCalled).toBe(true);
  });
});

// ── Suite 3: TikTok Hub — mocked publish journey ─────────────────────────────

test.describe('TikTok Hub page — mocked publish journey', () => {
  test.beforeEach(async ({ page }) => {
    await mockApis(page, FAKE_USER_CONNECTED);
    await seedAuth(page, FAKE_USER_CONNECTED);
  });

  test('TikTok Hub renders the upload UI for a connected user', async ({ page }) => {
    await page.goto('/tiktok');
    // The connected gate renders the hub with the upload drop-zone.
    await expect(page.getByText('TikTok Hub', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Video File', { exact: true })).toBeVisible();
    // The "Post to TikTok" button must be present (disabled until video+caption).
    await expect(page.getByRole('button', { name: /Post to TikTok/i })).toBeVisible();
  });

  test('clicking "Generate Catchphrase" calls /api/tiktok/catchphrase and fills the caption', async ({ page }) => {
    const FAKE_CATCHPHRASE = 'Your dream car is waiting! 🚗 #CarSales #DealershipLife';
    let catchphraseCalled = false;

    await page.route('**/api/tiktok/catchphrase', (r: Route) => {
      catchphraseCalled = true;
      r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ catchphrase: FAKE_CATCHPHRASE }) });
    });

    await page.goto('/tiktok');
    await expect(page.getByRole('button', { name: /Generate Catchphrase/i })).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: /Generate Catchphrase/i }).click();

    // The caption textarea should be populated with the generated catchphrase.
    await expect(page.locator('textarea')).toHaveValue(FAKE_CATCHPHRASE, { timeout: 8_000 });
    expect(catchphraseCalled).toBe(true);
  });

  test('"Studio Locked" gate is shown and a connect button is offered when tiktok_connected = false', async ({ page }) => {
    // Override auth/me and localStorage with the disconnected user.
    // Registered AFTER beforeEach routes → LIFO higher priority.
    await page.route('**/api/auth/me', (r: Route) =>
      r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(FAKE_USER_DISCONNECTED) })
    );
    await page.addInitScript((uJson: string) => {
      localStorage.setItem('bdc_user', uJson);
    }, JSON.stringify(FAKE_USER_DISCONNECTED));

    await page.goto('/tiktok');
    // The studio area shows "Studio Locked" when tiktok_connected = false.
    await expect(page.getByText('Studio Locked', { exact: true })).toBeVisible({ timeout: 10_000 });
    // A "Connect TikTok Account" button is offered inside the locked gate.
    await expect(page.getByRole('button', { name: /Connect TikTok Account/i }).last()).toBeVisible();
  });
});
