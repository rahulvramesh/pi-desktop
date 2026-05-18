import { test, expect, _electron as electron } from '@playwright/test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

test.describe('Pi Desktop smoke (mock backend)', () => {
  test('chat renders, prompt streams response with tool cards, tweaks toggle theme', async () => {
    const projectRoot = join(__dirname, '../..');
    const app = await electron.launch({
      args: [join(projectRoot, 'out/main/index.js')],
      cwd: projectRoot,
      env: { ...process.env, PI_BACKEND: 'mock', NODE_ENV: 'production' },
      timeout: 30_000,
    });

    // Stream main + renderer logs into the test output for debugging.
    app.process().stdout?.on('data', (b) => process.stdout.write(`[main]  ${b.toString()}`));
    app.process().stderr?.on('data', (b) => process.stderr.write(`[main!] ${b.toString()}`));

    const win = await app.firstWindow({ timeout: 20_000 });
    win.on('console', (m) => process.stdout.write(`[rndr] ${m.type()}: ${m.text()}\n`));
    win.on('pageerror', (e) => process.stderr.write(`[rndr!] ${e.message}\n`));
    await win.waitForLoadState('domcontentloaded');

    // Seed a deterministic project/chat through the preload API. The app no
    // longer ships hardcoded sidebar data, so the smoke test owns its fixture.
    await win.evaluate(async (root) => {
      await window.pi.prefs.set({ hasSeenWelcome: true, turnEndNotifyEnabled: false });
      const project = await window.pi.projects.add(root, 'Level loader v2');
      const chats = await window.pi.chats.list(project.id);
      const existing = chats.find((c) => c.title === 'Level loader v2');
      if (!existing) await window.pi.chats.create(project.id, 'Level loader v2');
    }, projectRoot);
    await win.reload();
    await win.waitForLoadState('domcontentloaded');

    const chatRow = win.locator('[role="button"][title="Level loader v2"]').last();
    await expect(chatRow).toBeVisible({ timeout: 8_000 });
    await chatRow.click();

    // Composer textarea is visible and accepts input.
    const composer = win.locator('textarea[aria-label="Message Pi"]');
    await expect(composer).toBeVisible();
    await composer.fill('Look at the level loader and fix the bug.');
    await composer.press('Enter');

    // The user message we just sent is visible.
    await expect(
      win.locator('text=Look at the level loader and fix the bug.'),
    ).toBeVisible({ timeout: 6_000 });

    // The mock streams an assistant reply with two tool cards (read + edit).
    await expect(win.locator('text=Loader.ts').first()).toBeVisible({ timeout: 8_000 });

    // Tweaks panel opens; selecting "dark" flips data-theme.
    await win.locator('button[aria-label="Tweaks"]').click();
    await win.locator('button:has-text("dark")').first().click();
    await expect
      .poll(async () => win.evaluate(() => document.documentElement.dataset['theme']))
      .toBe('dark');

    await app.close();
  });

  test('keeps a background chat running when another chat is opened and prompted', async () => {
    const projectRoot = join(__dirname, '../..');
    const app = await electron.launch({
      args: [join(projectRoot, 'out/main/index.js')],
      cwd: projectRoot,
      env: {
        ...process.env,
        PI_BACKEND: 'mock',
        PI_MOCK_SPEED: '2',
        NODE_ENV: 'production',
      },
      timeout: 30_000,
    });

    app.process().stdout?.on('data', (b) => process.stdout.write(`[main]  ${b.toString()}`));
    app.process().stderr?.on('data', (b) => process.stderr.write(`[main!] ${b.toString()}`));

    const win = await app.firstWindow({ timeout: 20_000 });
    win.on('console', (m) => process.stdout.write(`[rndr] ${m.type()}: ${m.text()}\n`));
    win.on('pageerror', (e) => process.stderr.write(`[rndr!] ${e.message}\n`));
    await win.waitForLoadState('domcontentloaded');

    const suffix = Date.now().toString(36);
    const titleA = `Parallel A ${suffix}`;
    const titleB = `Parallel B ${suffix}`;
    const { chatA, chatB } = await win.evaluate(
      async ({ root, titleA: aTitle, titleB: bTitle }) => {
        await window.pi.prefs.set({ hasSeenWelcome: true, turnEndNotifyEnabled: false });
        const project = await window.pi.projects.add(root, 'Parallel sessions');
        const chatA = await window.pi.chats.create(project.id, aTitle);
        const chatB = await window.pi.chats.create(project.id, bTitle);
        return { chatA, chatB };
      },
      { root: projectRoot, titleA, titleB },
    );

    await win.reload();
    await win.waitForLoadState('domcontentloaded');

    const composer = win.locator('textarea[aria-label="Message Pi"]');
    const rowA = win.locator(`[role="button"][title="${titleA}"]`).first();
    const rowB = win.locator(`[role="button"][title="${titleB}"]`).first();
    const runningA = win.locator(`[role="button"][title="${titleA}"] [aria-label="running"]`).first();
    const runningB = win.locator(`[role="button"][title="${titleB}"] [aria-label="running"]`).first();

    await expect(rowA).toBeVisible({ timeout: 8_000 });
    await rowA.click();
    await expect(composer).toBeVisible();
    await composer.fill(`Run chat A ${suffix}; keep streaming while I switch away.`);
    await composer.press('Enter');
    await expect(runningA).toBeVisible({ timeout: 4_000 });

    await expect(rowB).toBeVisible({ timeout: 8_000 });
    await rowB.click();
    await expect(composer).toBeVisible();
    await composer.fill(`Run chat B ${suffix}; chat A must keep running.`);
    await composer.press('Enter');

    await expect(runningA).toBeVisible({ timeout: 2_000 });
    await expect(runningB).toBeVisible({ timeout: 4_000 });
    await expect
      .poll(async () =>
        win.evaluate(async ({ chatAId, chatBId }) => {
          const statuses = await window.pi.runtimes.list();
          const statusA = statuses.find((s) => s.chatId === chatAId);
          const statusB = statuses.find((s) => s.chatId === chatBId);
          return Boolean(statusA && statusB && statusA.runState !== 'idle' && statusB.runState !== 'idle');
        }, { chatAId: chatA.id, chatBId: chatB.id }),
      )
      .toBe(true);

    await rowA.click();
    await expect(win.locator(`text=Run chat A ${suffix}`)).toBeVisible({ timeout: 4_000 });
    await expect(win.locator('text=on-disk format spec').first()).toBeVisible({ timeout: 4_000 });

    await app.close();
  });

  test('can drive a chat through the Rust proxy backend', async () => {
    const projectRoot = join(__dirname, '../..');
    const proxyBin = join(projectRoot, 'runtime-proxy/target/debug/pi-runtime-proxy.exe');
    test.skip(!existsSync(proxyBin), 'runtime proxy binary is not built; run npm run proxy:build');

    const mockPi = join(projectRoot, 'tests/fixtures/mock-pi-rpc.mjs').replace(/\\/g, '/');
    const app = await electron.launch({
      args: [join(projectRoot, 'out/main/index.js')],
      cwd: projectRoot,
      env: {
        ...process.env,
        PI_BACKEND: 'proxy',
        PI_PROXY_BIN: proxyBin,
        PI_BIN: process.execPath,
        PI_BIN_ARGS: mockPi,
        NODE_ENV: 'production',
      },
      timeout: 30_000,
    });

    app.process().stdout?.on('data', (b) => process.stdout.write(`[main]  ${b.toString()}`));
    app.process().stderr?.on('data', (b) => process.stderr.write(`[main!] ${b.toString()}`));

    const win = await app.firstWindow({ timeout: 20_000 });
    win.on('console', (m) => process.stdout.write(`[rndr] ${m.type()}: ${m.text()}\n`));
    win.on('pageerror', (e) => process.stderr.write(`[rndr!] ${e.message}\n`));
    await win.waitForLoadState('domcontentloaded');

    const title = `Proxy backend ${Date.now().toString(36)}`;
    await win.evaluate(
      async ({ root, title }) => {
        await window.pi.prefs.set({ hasSeenWelcome: true, turnEndNotifyEnabled: false });
        const project = await window.pi.projects.add(root, 'Proxy backend');
        await window.pi.chats.create(project.id, title);
      },
      { root: projectRoot, title },
    );
    await win.reload();
    await win.waitForLoadState('domcontentloaded');

    await win.locator(`[role="button"][title="${title}"]`).first().click();
    await expect
      .poll(async () => win.evaluate(() => window.pi.getState().then((s) => s.modelProvider)))
      .toBe('mock-proxy');
    const composer = win.locator('textarea[aria-label="Message Pi"]');
    await expect(composer).toBeVisible();
    await composer.fill('Use the Rust proxy backend.');
    await composer.press('Enter');

    await expect(win.locator('text=Use the Rust proxy backend.')).toBeVisible({ timeout: 4_000 });
    await expect(win.locator('text=Proxy mode is streaming through Rust.')).toBeVisible({ timeout: 8_000 });

    await app.close();
  });
});
