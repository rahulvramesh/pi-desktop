import { test, expect, _electron as electron } from '@playwright/test';
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
      await window.pi.prefs.set({ hasSeenWelcome: true });
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
});
