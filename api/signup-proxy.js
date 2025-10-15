// Vercel Serverless function: Puppeteer (chromium) two-step form filler
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

// Ensure Node serverless runtime (NOT edge)
module.exports.config = {
  runtime: 'nodejs20.x'
  // regions: ['iad1'] // optionally pin a region
};

chromium.setHeadlessMode = true;
chromium.setGraphicsMode = false;

async function typeByLabelOrPlaceholder(page, { labelText, placeholder, selector, value }) {
  if (selector) {
    await page.waitForSelector(selector, { visible: true, timeout: 20000 });
    await page.click(selector, { clickCount: 3 });
    await page.type(selector, value, { delay: 20 });
    return;
  }
  if (placeholder) {
    const found = await page.$(`input[placeholder*="${placeholder}"], textarea[placeholder*="${placeholder}"]`);
    if (found) {
      await found.click({ clickCount: 3 });
      await found.type(value, { delay: 20 });
      return;
    }
  }
  if (labelText) {
    const elHandle = await page.$x(`//label[contains(normalize-space(.), "${labelText}")]/following::input[1]`);
    if (elHandle[0]) {
      await elHandle[0].click({ clickCount: 3 });
      await elHandle[0].type(value, { delay: 20 });
      return;
    }
  }
  throw new Error(`Cannot find input for "${labelText || placeholder || selector}"`);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, password, firstName, lastName, messengerType, messenger } = req.body || {};
  if (!email || !password || !firstName || !lastName || !messengerType || !messenger) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  let browser;
  try {
    const exe = await chromium.executablePath();
    console.log('Chromium path:', exe);

    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 1280, height: 900 },
      executablePath: exe,
      headless: chromium.headless,
      ignoreHTTPSErrors: true
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(30000);

    // STEP 1: email + password
    await page.goto('https://affiliate.swipey.ai/signup', { waitUntil: 'networkidle2' });

    const emailSel = 'input[type="email"], input[name="email"]';
    await page.waitForSelector(emailSel, { visible: true });
    await page.click(emailSel, { clickCount: 3 });
    await page.type(emailSel, email, { delay: 20 });

    const passSel = await page.$('input[type="password"]');
    if (passSel) {
      await page.click('input[type="password"]', { clickCount: 3 });
      await page.type('input[type="password"]', password, { delay: 20 });
    } else {
      await typeByLabelOrPlaceholder(page, { placeholder: 'Password', value: password });
    }

    const submit1 =
      (await page.$x(`//button[.//text()[contains(., "Sign Up") or contains(., "Continue")]]`))[0] ||
      (await page.$('button[type="submit"]'));
    if (!submit1) throw new Error('Cannot find first submit button');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}),
      submit1.click(),
    ]);

    // STEP 2: profile
    await page.waitForSelector('input[placeholder*="First"], input[name*="first"], input[id*="first"]', { visible: true });

    await typeByLabelOrPlaceholder(page, { placeholder: 'First', labelText: 'First Name', value: firstName });
    await typeByLabelOrPlaceholder(page, { placeholder: 'Last', labelText: 'Last name', value: lastName });

    if (await page.$('select')) {
      const all = await page.$$eval('select option', opts => opts.map(o => ({ v: o.value, t: o.textContent.trim() })));
      let match = all.find(o => o.t.toLowerCase().includes(messengerType.toLowerCase())) || all.find(o => o.v.toLowerCase().includes(messengerType.toLowerCase()));
      await page.select('select', match ? match.v : messengerType);
    } else {
      const dd =
        (await page.$x(`//div[contains(@role,"listbox") or contains(@class,"select") or contains(@class,"dropdown")]`))[0] ||
        (await page.$x(`//button[contains(@aria-haspopup,"listbox") or contains(@class,"select")]`))[0];
      if (!dd) throw new Error('Messenger dropdown not found');
      await dd.click();
      const opt = (await page.$x(`//div[@role="option" or @role="menuitem" or self::li][contains(., "${messengerType}")]`))[0];
      if (!opt) throw new Error(`Messenger option "${messengerType}" not found`);
      await opt.click();
    }

    await typeByLabelOrPlaceholder(page, { placeholder: 'Skype/Telegram', labelText: 'Messenger', value: messenger });

    const finishBtn =
      (await page.$x(`//button[.//text()[contains(., "Complete") or contains(., "Sign Up") or contains(., "Finish")]]`))[0] ||
      (await page.$('button[type="submit"]'));
    if (!finishBtn) throw new Error('Cannot find second submit button');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}),
      finishBtn.click(),
    ]);

    const html = await page.content();
    const ok =
      /thank/i.test(html) ||
      /dashboard/i.test(html) ||
      /verify/i.test(html) ||
      /check your email/i.test(html);

    return res.status(200).json({ ok, note: ok ? 'Submitted' : 'Submitted (check target state)' });
  } catch (err) {
    console.error('signup-proxy error:', err);
    return res.status(500).json({ error: err.message || 'Automation failed' });
  } finally {
    if (browser) try { await browser.close(); } catch {}
  }
};
