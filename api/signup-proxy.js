// api/signup-proxy.js
// Serverless function for Vercel: two-step autofill via Playwright on AWS Lambda

const chromium = require('playwright-aws-lambda');

module.exports.config = {
  runtime: 'nodejs18.x'  // стабильный рантайм для lambda-билдов
  // regions: ['iad1']    // можно закрепить регион
};

async function typeByLabelOrPlaceholder(page, { labelText, placeholder, selector, value }) {
  if (selector) {
    await page.locator(selector).waitFor({ state: 'visible', timeout: 20000 });
    await page.fill(selector, value);
    return;
  }
  if (placeholder) {
    const loc = page.locator(`input[placeholder*="${placeholder}"], textarea[placeholder*="${placeholder}"]`).first();
    if (await loc.count()) {
      await loc.fill(value);
      return;
    }
  }
  if (labelText) {
    const byLabel = page.getByLabel(labelText, { exact: false });
    if (await byLabel.count()) {
      await byLabel.fill(value);
      return;
    }
  }
  throw new Error(`Cannot find input for "${labelText || placeholder || selector}"`);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, password, firstName, lastName, messengerType, messenger } = req.body || {};
  if (!email || !password || !firstName || !lastName || !messengerType || !messenger) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  let browser;
  try {
    // playwright-aws-lambda отдаёт совместимый двоичный файл + нужные либы
   browser = await chromium.launchChromium({ headless: true });

    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    // STEP 1
    await page.goto('https://affiliate.swipey.ai/signup', { waitUntil: 'networkidle' });

    await page.locator('input[type="email"], input[name="email"]').first().fill(email);
    if (await page.locator('input[type="password"]').count()) {
      await page.locator('input[type="password"]').first().fill(password);
    } else {
      await typeByLabelOrPlaceholder(page, { placeholder: 'Password', value: password });
    }

    const submit1 = page.locator('button:has-text("Sign Up"), button:has-text("Continue")').first();
    await Promise.all([
      page.waitForLoadState('networkidle').catch(() => {}),
      submit1.click()
    ]);

    // STEP 2
    await page.locator('input[placeholder*="First"], input[name*="first"], input[id*="first"]').first().waitFor({ state: 'visible' });

    await typeByLabelOrPlaceholder(page, { placeholder: 'First', labelText: 'First Name', value: firstName });
    await typeByLabelOrPlaceholder(page, { placeholder: 'Last',  labelText: 'Last name',  value: lastName  });

    // Messenger type
    if (await page.locator('select').count()) {
      // выбрать по тексту опции
      const valueToSelect = await page.evaluate((want) => {
        const sel = document.querySelector('select');
        if (!sel) return null;
        const opts = [...sel.options].map(o => ({ v: o.value, t: (o.textContent || '').trim() }));
        const m = opts.find(o => o.t.toLowerCase().includes(want.toLowerCase())) || opts.find(o => o.v.toLowerCase().includes(want.toLowerCase()));
        return m ? m.v : null;
      }, messengerType);
      if (valueToSelect) await page.selectOption('select', valueToSelect);
      else await page.selectOption('select', messengerType);
    } else {
      // кастомный дропдаун
      const dd = page.locator('[role="listbox"], .select, .dropdown, [aria-haspopup="listbox"]').first();
      await dd.click().catch(() => {});
      const opt = page.locator('[role="option"], [role="menuitem"], li', { hasText: messengerType }).first();
      await opt.click();
    }

    await typeByLabelOrPlaceholder(page, { placeholder: 'Skype/Telegram', labelText: 'Messenger', value: messenger });

    const finishBtn = page.locator('button:has-text("Complete"), button:has-text("Sign Up"), button:has-text("Finish")').first();
    await Promise.all([
      page.waitForLoadState('networkidle').catch(() => {}),
      finishBtn.click()
    ]);

    const html = await page.content();
    const ok = /thank|dashboard|verify|check your email/i.test(html);

    return res.status(200).json({ ok, note: ok ? 'Submitted' : 'Submitted (check target state)' });
  } catch (err) {
    console.error('signup-proxy error:', err);
    return res.status(500).json({ error: err.message || 'Automation failed' });
  } finally {
    if (browser) try { await browser.close(); } catch {}
  }
};
